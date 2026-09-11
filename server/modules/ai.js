'use strict';
/**
 * AI 对话与动作执行。
 *
 * 模型拥有完整工作区和当前会话上下文，但不能直接写业务数据。它只能提出三类动作：
 * 保存到资料、设置当前岗位、应用简历修改。三类动作互相独立，均需用户操作。
 */
const db = require('../lib/db');
const {
  uuidv7,
  nowIso,
  problem,
  deepClone,
  hashJson,
} = require('../lib/util');
const audit = require('../lib/audit');
const policy = require('../lib/policy');
const resumeHarness = require('../lib/resume-harness');
const {
  MODEL_ERROR_CODES,
  isModelServiceError,
} = require('../lib/model-client');
const { loadChatImages, releaseClosedChatImages } = require('../lib/chat-images');
const { loadDocumentMaterials, conversationMaterials } = require('../lib/input-materials');
const { readMessageLinks } = require('../lib/job-links');
const { diffWords } = require('../lib/polish');
const { withIdempotency } = require('../lib/idempotency');
const { createNodeDeltaPair, createStructureDeltaPair } = require('../lib/resume-change');
const { buildChangePreview } = require('../lib/resume-change-preview');
const {
  normalizeChangeConstraints,
  composeChangeConstraints,
  authorizeChange,
  validateAuthorizedChange,
} = require('../lib/resume-change-policy');
const { refreshResumeProposalStaleness } = require('../lib/resume-proposals');
const {
  buildOperationPreconditions,
  validateOperationPreconditions,
} = require('../lib/resume-operation-preconditions');
const { compileResumeOperations } = require('../lib/resume-operation-compiler');
const {
  mergeResumeDocuments,
  topLevelChangedNodeIds,
} = require('../lib/resume-three-way-merge');
const {
  resolveResumeScope,
} = require('../lib/resume-scope');
const {
  materializeTargetFragments,
} = require('../lib/resume-harness/target-fragments');
const queue = require('../lib/queue');
const { SCOPE_LABEL } = require('../lib/policy');
const { toActionView, toMessageView } = require('./workspace');
const ResumeDom = require('../../resume-dom');
const { purgeConversations, compactGlobalHistory } = require('../lib/ai-storage');
const inflight = require('../lib/ai-inflight');
const { readReapply } = require('../lib/proposal-reapply');
const { latestConversationTask, matchesTaskScope } = require('../lib/chat-continuation');

const POLICY_VERSION = policy.POLICY_VERSION;

function loadProposalPreview(id, user) {
  const action = db.get('SELECT * FROM ai_action_requests WHERE id = ? AND owner_id = ?', [id, user.id]);
  if (!action || action.action_type !== 'RESUME_REWRITE_PROPOSAL') throw problem.notFound('建议不存在');
  const stored = parseJson(action.payload_json, {});
  const pair = readReapply(stored.proposal || stored);
  if (!pair) throw problem.conflict('PROPOSAL_MATERIAL_EXPIRED', '这条旧建议的完整排版已清理，请根据当前简历重新生成');
  const conversation = db.get('SELECT * FROM ai_conversations WHERE id = ? AND owner_id = ?', [action.conversation_id, user.id]);
  if (!conversation || conversation.status === 'closed') throw problem.notFound('对话已结束');
  const ctx = loadContext(conversation.project_id, user, { conversationId: conversation.id });
  const current = ResumeDom.toResumeDocument(parseJson(ctx.draft.resume_json, {}));
  let target;
  try {
    target = mergeResumeDocuments({ base: pair.base, target: pair.target, current }).document;
  } catch (_) {
    throw problem.conflict('PROPOSAL_REBASE_REQUIRED', '当前简历结构已变化，需要根据最新内容重新生成这项建议');
  }
  return { ctx, current, target };
}

function parseJson(raw, fallback = {}) {
  try {
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch (_) {
    return deepClone(fallback);
  }
}

function loadContext(projectId, user, options = {}) {
  const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
    projectId,
    user.id,
  ]);
  if (!project) throw problem.notFound('项目不存在');
  const profile = db.get('SELECT * FROM profiles WHERE id = ? AND owner_id = ?', [
    project.current_profile_id,
    user.id,
  ]);
  const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?', [
    project.id,
    user.id,
  ]);
  const job = project.current_job_id
    ? db.get('SELECT * FROM target_jobs WHERE id = ? AND owner_id = ?', [project.current_job_id, user.id])
    : null;
  let conversation = null;
  if (options.conversationId) {
    conversation = db.get(
      `SELECT * FROM ai_conversations
       WHERE id = ? AND project_id = ? AND owner_id = ?`,
      [options.conversationId, project.id, user.id],
    );
    if (!conversation) throw problem.conflict('CONVERSATION_ENDED', '当前对话已经清空，请在新对话中继续');
    if (!options.allowClosedConversation && conversation.status !== 'active') {
      throw problem.conflict('CONVERSATION_ENDED', '当前对话已经结束，请开始新对话');
    }
  } else {
    conversation = db.get(
      "SELECT * FROM ai_conversations WHERE project_id = ? AND owner_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1",
      [project.id, user.id],
    );
  }
  if (!conversation && options.createConversation !== false) {
    const id = uuidv7();
    db.run(
      `INSERT INTO ai_conversations
       (id, project_id, owner_id, active_scope_type, status, created_at, updated_at)
       VALUES (?, ?, ?, 'RESUME_DOCUMENT', 'active', ?, ?)`,
      [id, project.id, user.id, nowIso(), nowIso()],
    );
    conversation = db.get('SELECT * FROM ai_conversations WHERE id = ?', [id]);
  }
  return { project, profile, draft, job, conversation };
}

function startNewConversation({
  projectId,
  user,
  requestId,
  ipHash,
  previousConversationId = null,
}) {
  const oldIds = [];
  const result = db.tx(() => {
    const ctx = loadContext(projectId, user, {
      conversationId: previousConversationId,
      allowClosedConversation: true,
    });
    const previous = ctx.conversation;
    const messageCount = db.get(
      'SELECT COUNT(*) AS total FROM ai_messages WHERE conversation_id = ?',
      [previous.id],
    ).total;
    const discarded = db.get(
      `SELECT COUNT(*) AS total FROM ai_action_requests
       WHERE conversation_id = ? AND owner_id = ? AND status IN ('awaiting_confirmation','proposed')`,
      [previous.id, user.id],
    ).total;
    db.run(
      `UPDATE ai_tasks SET status = 'canceled', active_proposal_id = NULL, updated_at = ?
       WHERE conversation_id = ? AND owner_id = ? AND status NOT IN ('completed','canceled')`,
      [nowIso(), previous.id, user.id],
    );
    db.run(
      `UPDATE ai_action_requests SET status = 'rejected', rejected_at = ?
       WHERE conversation_id = ? AND owner_id = ? AND status IN ('awaiting_confirmation','proposed')`,
      [nowIso(), previous.id, user.id],
    );
    db.run(
      "UPDATE ai_conversations SET status = 'closed', updated_at = ? WHERE id = ? AND owner_id = ?",
      [nowIso(), previous.id, user.id],
    );
    const id = uuidv7();
    db.run(
      `INSERT INTO ai_conversations
       (id, project_id, owner_id, active_scope_type, status, created_at, updated_at)
       VALUES (?, ?, ?, 'RESUME_DOCUMENT', 'active', ?, ?)`,
      [id, ctx.project.id, user.id, nowIso(), nowIso()],
    );
    oldIds.push(...db.all(
      'SELECT id FROM ai_conversations WHERE owner_id = ? AND project_id = ? AND id <> ?',
      [user.id, projectId, id],
    ).map((row) => row.id));
    const deleted = purgeConversations(db.getDb(), {
      ownerId: user.id, projectId, keepId: id,
    });
    audit.log({
      ownerId: user.id,
      action: 'ai_conversation_started',
      resourceType: 'ai_conversation',
      resourceId: id,
      requestId,
      ipHash,
      metadata: {
        previous_conversation_id: previous.id,
        message_count: messageCount,
        pending_actions_discarded: discarded,
      },
    });
    return {
      id,
      previous_conversation_id: previous.id,
      messages_closed: messageCount,
      pending_actions_discarded: discarded,
      profile_unchanged: true,
      resume_unchanged: true,
      versions_unchanged: true,
      deleted,
    };
  });
  oldIds.forEach((id) => inflight.cancel(`global:${user.id}:${id}`));
  releaseClosedChatImages(user.id);
  return result;
}

function findResumeNodeInDraft(resume, nodeId) {
  const document = ResumeDom.ensureDocument(resume);
  const found = ResumeDom.findNode(document, nodeId);
  if (!found) return null;
  const siblings = found.parent ? found.parent.children || [] : [];
  return {
    ...found,
    document,
    text: ResumeDom.nodeText(found.node),
    neighboringNodes: siblings
      .filter((node) => node.id !== found.node.id)
      .map((node) => ({ id: node.id, text: ResumeDom.nodeText(node) }))
      .filter((node) => node.text),
  };
}

function validateLockedScope(ctx, scopeType, scopeId) {
  if (!policy.SCOPE_TYPES.has(scopeType)) throw problem.badRequest('未知的作用范围类型');
  if (scopeType === 'RESUME_BLOCK') {
    if (!scopeId) throw problem.badRequest('请选择具体的简历内容');
    const resume = parseJson(ctx.draft && ctx.draft.resume_json, {});
    const resolved = ResumeDom.resolveAiScopeNode(resume, scopeId);
    const found = resolved
      ? findResumeNodeInDraft(resume, resolved.node.id)
      : null;
    if (!found) throw problem.badRequest('所选简历内容不存在，请重新选择');
    if (found.node.type !== 'text' && !found.node.editable) {
      throw problem.badRequest('所选简历节点不能作为 AI 修改范围');
    }
    return {
      scopeId: String(found.node.id),
      requestedScopeId: String(scopeId),
      currentText: found.text,
      found,
    };
  }
  if (scopeType === 'DATA_PROFILE' && scopeId) {
    const owned = db.get(
      `SELECT e.id FROM experiences e JOIN profiles p ON p.id = e.profile_id
       WHERE e.id = ? AND p.id = ? AND e.owner_id = ? AND e.deleted_at IS NULL`,
      [scopeId, ctx.profile.id, ctx.profile.owner_id],
    );
    if (!owned) throw problem.badRequest('所选资料不存在，请重新选择');
  }
  if (scopeType === 'DATA_JOB' && scopeId) {
    const owned = db.get(
      'SELECT id FROM target_jobs WHERE id = ? AND project_id = ? AND owner_id = ?',
      [scopeId, ctx.project.id, ctx.project.owner_id],
    );
    if (!owned) throw problem.badRequest('所选岗位不存在，请重新选择');
  }
  return { scopeId: scopeId || null, currentText: '', found: null };
}

function resolveTask({ ctx, user, body, scopeType, scopeId, content, retry = false }) {
  let task = null;
  let requestedTaskId = body.task_id;
  if (!requestedTaskId && body.context_mode !== 'fresh') {
    // A missing browser-local task ID is not a new conversation. Resume only
    // the latest conversation task when its scope matches; never search back
    // through unrelated scopes/projects or infer intent from user keywords.
    const latest = latestConversationTask({
      conversationId: ctx.conversation.id, projectId: ctx.project.id, ownerId: user.id,
    });
    if (matchesTaskScope(latest, scopeType, scopeId)) requestedTaskId = latest.id;
  }
  if (requestedTaskId) {
    task = db.get(
      `SELECT * FROM ai_tasks
       WHERE id = ? AND conversation_id = ? AND project_id = ? AND owner_id = ?`,
      [requestedTaskId, ctx.conversation.id, ctx.project.id, user.id],
    );
    if (!task) throw problem.badRequest('当前 AI 任务不存在，请重新发起');
    if (task.scope_type !== scopeType || String(task.scope_id || '') !== String(scopeId || '')) {
      throw problem.conflict('SCOPE_CONFLICT', '当前对话目标已切换，请重新发送');
    }
    const latestTask = task.status === 'completed' && db.get(
      `SELECT task_id FROM ai_messages WHERE conversation_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`, [ctx.conversation.id],
    );
    if (task.status === 'canceled' || (task.status === 'completed' && latestTask?.task_id !== task.id)) {
      throw problem.conflict('TASK_ENDED', '上一项 AI 任务已经结束，请重新发送本轮要求');
    }
    if (['planning', 'validated'].includes(task.status)) {
      throw problem.conflict('TASK_BUSY', 'AI 正在处理上一条消息，请稍候');
    }
  }
  if (!task) {
    const id = uuidv7();
    db.run(
      `INSERT INTO ai_tasks
       (id, conversation_id, project_id, owner_id, scope_type, scope_id, goal, state_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'understanding', ?, ?)`,
      [
        id,
        ctx.conversation.id,
        ctx.project.id,
        user.id,
        scopeType,
        scopeId,
        content,
        JSON.stringify({
          phase: 'understanding',
          latest_instruction: content,
          initial_resume_revision: ctx.draft.revision,
          initial_resume_hash: hashJson(
            ResumeDom.toResumeDocument(parseJson(ctx.draft.resume_json, {})),
          ),
          turns: [{ role: 'user', content: content.slice(0, 1000) }],
        }),
        nowIso(),
        nowIso(),
      ],
    );
    task = db.get('SELECT * FROM ai_tasks WHERE id = ?', [id]);
  } else {
    const state = parseJson(task.state_json, {});
    const turns = Array.isArray(state.turns) ? state.turns.slice(-11) : [];
    const pendingMessage = state.pending_message && typeof state.pending_message === 'object'
      ? state.pending_message
      : null;
    const pendingReplies = pendingMessage && Array.isArray(pendingMessage.quick_replies)
      ? pendingMessage.quick_replies
      : [];
    const firstReply = pendingReplies[0] || null;
    const confirmsPendingPlan = Boolean(
      pendingMessage
      && pendingMessage.message_kind === 'plan_confirmation'
      && firstReply
      && (
        String(body.quick_reply_id || '') === String(firstReply.id || '')
        || String(content) === String(firstReply.label || '')
      )
    );
    if (!retry) turns.push({ role: 'user', content: content.slice(0, 1000) });
    db.run('UPDATE ai_tasks SET state_json = ?, status = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({
        ...state,
        phase: 'understanding',
        latest_instruction: content,
        latest_user_message: content,
        turns,
        answered_message: pendingMessage || state.answered_message || null,
        answered_clarification: state.pending_clarification || state.answered_clarification || null,
        confirmed_plan: confirmsPendingPlan
          ? (state.pending_plan || {
              content: pendingMessage.content,
              confirmed_reply: String(content).slice(0, 160),
            })
          : (state.confirmed_plan || null),
        pending_message: null,
        pending_clarification: null,
        pending_plan: null,
        last_error: null,
      }),
      'understanding',
      nowIso(),
      task.id,
    ]);
    task = db.get('SELECT * FROM ai_tasks WHERE id = ?', [task.id]);
  }
  return task;
}

function actionAllowedInScope(type, scopeType) {
  if (type === 'RESUME_REWRITE_PROPOSAL') {
    return scopeType === 'RESUME_BLOCK' || scopeType === 'RESUME_DOCUMENT';
  }
  // 用户可以在修改简历时同时明确要求“也保存到资料”，所以这两类独立动作不被简历 scope 阻断。
  if (type === 'PROFILE_SAVE_PROPOSAL' || type === 'JOB_SET_CURRENT_PROPOSAL') return true;
  return false;
}

function taskConversationMessages(conversationId, taskId, excludeMessageId = null) {
  return db
    .all(
      `SELECT id, task_id, role, content, scope_type, scope_id, model_metadata_json
       FROM ai_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC, id ASC`,
      [conversationId],
    )
    .filter((row) => {
      if (excludeMessageId && row.id === excludeMessageId) return false;
      const metadata = parseJson(row.model_metadata_json, {});
      // Backend failure notices are diagnostics, not assistant conversation.
      if (metadata.result_type === 'ERROR') return false;
      if (row.task_id) return String(row.task_id) === String(taskId);
      return String(metadata.task_id || '') === String(taskId);
    })
    .map((row) => ({
      role: row.role,
      content: row.content,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      attachment_ids: parseJson(row.model_metadata_json, {}).attachment_ids || [],
    }));
}

function normalizeRewriteProposal({
  action,
  currentText,
  editingBase,
  scopeType,
  scopeId,
  draft,
  task,
  proposalBaseResume,
  parentProposal,
}) {
  const raw = (action.payload && action.payload.proposal) || action.payload || {};
  const currentResume = ResumeDom.toResumeDocument(parseJson(draft.resume_json, {}));
  const workingResume = proposalBaseResume
    ? ResumeDom.toResumeDocument(proposalBaseResume)
    : currentResume;
  const previous = parentProposal || null;
  const baseResume = previous && previous.base_resume_json
    ? ResumeDom.toResumeDocument(previous.base_resume_json)
    : currentResume;
  const previousOperations = previous && Array.isArray(previous.operations)
    ? deepClone(previous.operations)
    : [];
  let incrementalOperations = Array.isArray(raw.operations) ? deepClone(raw.operations) : [];
  let operations = [];
  let proposalResume = null;
  let incrementalResume = null;
  let suggestion = String(raw.suggestion || '').trim();
  let explicitTargetResume = raw.target_resume_document
    || raw.resume_dom
    || raw.resume_json;
  let targetResumeFragments = raw.target_resume_fragments
    ? deepClone(raw.target_resume_fragments)
    : null;
  if (targetResumeFragments) {
    try {
      const materialized = materializeTargetFragments(workingResume, targetResumeFragments);
      if (
        explicitTargetResume
        && typeof explicitTargetResume === 'object'
        && hashJson(ResumeDom.toResumeDocument(
          explicitTargetResume,
          { allowLegacyAiScope: false },
        ))
          !== hashJson(materialized.document)
      ) {
        throw new Error('目标子树与完整目标文档不一致');
      }
      explicitTargetResume = materialized.document;
    } catch (error) {
      throw problem.unprocessable('INVALID_MODEL_ACTION', error.message);
    }
  }

  if (
    scopeType === 'RESUME_BLOCK'
    && !incrementalOperations.length
    && (!explicitTargetResume || typeof explicitTargetResume !== 'object')
  ) {
    if (!suggestion) throw problem.unprocessable('INVALID_MODEL_ACTION', '模型没有返回可应用的修改内容');
    incrementalOperations = [{ op: 'replace_text', node_id: scopeId, text: suggestion }];
  }
  if (incrementalOperations.length) {
    try {
      const compiled = compileResumeOperations(workingResume, incrementalOperations);
      incrementalOperations = compiled.operations;
      incrementalResume = compiled.document;
    } catch (error) {
      throw problem.unprocessable('INVALID_MODEL_ACTION', error.message);
    }
  } else if (explicitTargetResume && typeof explicitTargetResume === 'object') {
    try {
      proposalResume = ResumeDom.toResumeDocument(
        explicitTargetResume,
        { allowLegacyAiScope: false },
      );
    } catch (error) {
      throw problem.unprocessable('INVALID_MODEL_ACTION', error.message);
    }
    incrementalResume = proposalResume;
    if (!suggestion) suggestion = '更新整份简历的内容与结构';
  } else {
    throw problem.unprocessable('INVALID_MODEL_ACTION', '模型没有返回目标 ResumeDocument');
  }

  const simpleFocusedTextRewrite = scopeType === 'RESUME_BLOCK'
    && incrementalOperations.length === 1
    && incrementalOperations[0].op === 'replace_text'
    && String(incrementalOperations[0].node_id || '') === String(scopeId || '');
  let latestConstraints;
  try {
    latestConstraints = normalizeChangeConstraints(
      raw.change_constraints,
      workingResume,
      {
        scopeType,
        scopeId,
        scopeRegion: scopeType === 'RESUME_BLOCK'
          ? resolveResumeScope(workingResume, scopeId)
          : null,
        allowImplicitTextRewrite: simpleFocusedTextRewrite,
      },
    );
    authorizeChange({
      before: workingResume,
      after: incrementalResume,
      constraints: latestConstraints,
      operations: incrementalOperations,
      replacementResume: incrementalOperations.length ? null : incrementalResume,
      revision: draft.revision,
    });
  } catch (error) {
    throw problem.unprocessable(
      'RESUME_CHANGE_POLICY_VIOLATION',
      error.message,
      { policy_errors: error.policy_errors || [] },
    );
  }

  if (incrementalOperations.length) {
    proposalResume = incrementalResume;
    operations = previousOperations.length
      ? previousOperations.concat(incrementalOperations)
      : incrementalOperations;
    if (previousOperations.length) {
      try {
        const composed = ResumeDom.applyDocumentOperations(
          baseResume,
          operations,
          { allowStructure: true },
        );
        if (hashJson(composed) !== hashJson(proposalResume)) {
          // 完整目标文档是权威结果。旧动作无法无损组合时不再保留动作序列。
          operations = [];
        }
      } catch (_) {
        operations = [];
      }
    }
  }
  if (!proposalResume) {
    throw problem.unprocessable('INVALID_MODEL_ACTION', '建议没有形成可应用的文档变化');
  }
  const previousConstraints = previous
    && previous.change_policy
    && previous.change_policy.constraints;
  const legacyParentConstraints = previous && !previousConstraints
    ? {
        format: 'resume-change-constraints-v1',
        content: 'modify',
        content_order: 'reorder',
        structure: 'modify',
        style: 'modify',
        allowed_region_ids: [currentResume.root.id],
        reason: '兼容升级前已生成的父建议',
      }
    : null;
  const combinedConstraints = composeChangeConstraints(
    previousConstraints || legacyParentConstraints,
    latestConstraints,
    baseResume,
    {
      scopeType,
      scopeId,
      scopeRegion: scopeType === 'RESUME_BLOCK'
        ? resolveResumeScope(baseResume, scopeId)
        : null,
    },
  );
  let changePolicy;
  try {
    changePolicy = authorizeChange({
      before: baseResume,
      after: proposalResume,
      constraints: combinedConstraints,
      operations,
      replacementResume: operations.length ? null : proposalResume,
      revision: previous && previous.base_draft_revision !== undefined
        ? previous.base_draft_revision
        : draft.revision,
    });
  } catch (error) {
    throw problem.unprocessable(
      'RESUME_CHANGE_POLICY_VIOLATION',
      error.message,
      { policy_errors: error.policy_errors || [] },
    );
  }
  let previewResume = proposalResume;
  try {
    previewResume = mergeResumeDocuments({
      base: baseResume,
      target: proposalResume,
      current: currentResume,
    }).document;
  } catch (_) {
    // 展示仍可使用模型目标；真正应用时会返回可恢复的结构冲突。
  }
  const changePreview = buildChangePreview(currentResume, previewResume, {
    revision: draft.revision,
    constraints: combinedConstraints,
  });
  if (!suggestion) {
    suggestion = changePreview.after.text || changePreview.summary;
  }

  return {
    task_id: task.id,
    scope_type: scopeType,
    scope_id: scopeId,
    scope_label: SCOPE_LABEL[scopeType] || '',
    original: currentText,
    current_text: currentText,
    editing_base: editingBase || currentText,
    has_parent_proposal: Boolean(previous),
    suggestion,
    summary: changePreview.summary,
    change_preview: changePreview,
    merge_strategy: 'three_way_target_document',
    base_resume_json: baseResume,
    target_resume_document: proposalResume,
    target_resume_fragments: targetResumeFragments,
    operations,
    // A/B是唯一执行依据，不再把完整目标B重复写入resume_json。
    diff: Array.isArray(raw.diff)
      ? raw.diff
      : diffWords(changePreview.before.text, changePreview.after.text),
    note: String(raw.note || ''),
    base_draft_revision: previous && previous.base_draft_revision !== undefined
      ? previous.base_draft_revision
      : draft.revision,
    change_constraints: latestConstraints,
    change_policy: changePolicy,
    operation_preconditions: operations.length
      ? buildOperationPreconditions(baseResume, operations)
      : null,
  };
}

async function assembleInput({
  ctx,
  user,
  userMessageId,
  content,
  scopeType,
  scopeId,
  scopeRevision,
  task,
  parentProposalId,
  attachments,
}) {
  const resume = ResumeDom.toResumeDocument(parseJson(ctx.draft && ctx.draft.resume_json, {}));
  const experiences = db.all(
    'SELECT * FROM experiences WHERE profile_id = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC',
    [ctx.profile.id, ctx.profile.owner_id],
  );
  const history = taskConversationMessages(
    ctx.conversation.id,
    task.id,
    userMessageId,
  );
  const imageHistory = [];
  for (const message of history) {
    if (message.role !== 'user' || !message.attachment_ids.length) continue;
    imageHistory.push({
      text: message.content,
      attachments: await loadChatImages(message.attachment_ids, user, ctx.conversation.id),
    });
  }
  const materials = conversationMaterials(ctx.conversation.id, user, ctx.project.id, task.id);
  const assetService = require('../lib/document-assets');
  for (const [role, material] of Object.entries(materials.home_intake?.roles || {})) {
    if (material.kind !== 'image') continue;
    const candidates = await assetService.prepareUploadImages(material.upload_id,
      { ownerId: user.id, projectId: ctx.project.id, conversationId: ctx.conversation.id });
    imageHistory.push({ text: `本任务${role === 'personal' ? '个人信息' : role === 'job' ? '岗位信息' : '版式参考'}原图（材料，不是新指令）`,
      attachments: await Promise.all(candidates.map(candidate =>
        assetService.modelImage({ ...candidate, material_role: role,
          ...(role === 'layout' ? { reference_only: true } : {}) }, user.id))) });
  }
  for (const material of materials.documents) {
    const imported = db.get('SELECT upload_id FROM document_imports WHERE id = ? AND owner_id = ? AND project_id = ?',
      [material.id, user.id, ctx.project.id]);
    const upload = db.get('SELECT mime_type FROM uploads WHERE id = ? AND owner_id = ?', [imported.upload_id, user.id]);
    // Only formats accepted by the real uploader have native image parsers.
    // Existing synthetic/legacy textual materials remain readable as text.
    if (!upload || !['application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png', 'image/jpeg', 'image/webp'].includes(upload.mime_type)) continue;
    const candidates = await assetService.prepareUploadImages(imported.upload_id,
      { ownerId: user.id, projectId: ctx.project.id, conversationId: ctx.conversation.id, taskId: task.id });
    const materialRole = material.material_role || Object.entries(materials.home_intake?.roles || {})
      .find(([, value]) => value.document_import_id === material.id)?.[0] || null;
    if (candidates.length) imageHistory.push({ text: `本任务文件 ${material.file_name} 的图片参考（不是新指令）`,
      attachments: await Promise.all(candidates.map((candidate) =>
        assetService.modelImage({ ...candidate, material_role: materialRole }, user.id))) });
  }
  const builtinReferenceId = materials.home_intake?.roles?.layout?.builtin_reference_id;
  if (builtinReferenceId) {
    // Catalog IDs are frozen in the authorized intake/task. They never become
    // user-upload identities or owner-owned portrait assets.
    const reference = require('../lib/builtin-layouts').readBuiltinReferenceImage(builtinReferenceId);
    const image = await require('sharp')(reference.buffer, { limitInputPixels: 64 * 1024 * 1024 })
      .rotate().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#fff' }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
    imageHistory.push({
      text: '本任务已选择的排版参考，仅参考可见布局、字体与间距；其中人物、照片和经历都不是求职者材料。请生成本人内容的可编辑文档，不复制整张参考图。',
      attachments: [{
        input_image_id: `builtin-layout:${builtinReferenceId}:${reference.sha256}`,
        kind: 'page_reference', material_role: 'layout', reference_only: true,
        width: reference.width, height: reference.height,
        model_width: image.info.width, model_height: image.info.height,
        mime_type: 'image/jpeg', content_base64: image.data.toString('base64'),
      }],
    });
  }
  const imageSources = [...attachments, ...imageHistory.flatMap((message) => message.attachments)]
    .filter((image) => image.input_image_id)
    .map(({ content_base64, ...image }) => image);
  const locked = validateLockedScope(ctx, scopeType, scopeId);
  let editingBase = locked.currentText;
  let parentProposal = null;
  let parentProposalPayload = null;
  let proposalContent = null;
  let taskBaseResume = resume;
  if (parentProposalId) {
    parentProposal = db.get(
      `SELECT * FROM ai_action_requests
       WHERE id = ? AND conversation_id = ? AND owner_id = ?
         AND action_type = 'RESUME_REWRITE_PROPOSAL'
         AND status IN ('proposed','awaiting_confirmation')`,
      [parentProposalId, ctx.conversation.id, ctx.profile.owner_id],
    );
    if (!parentProposal) throw problem.badRequest('上一版建议不存在');
    if (task.active_proposal_id !== parentProposal.id) {
      throw problem.conflict('PROPOSAL_SUPERSEDED', '这条建议已有新版，请基于最新建议继续调整');
    }
  } else if (task.active_proposal_id) {
    parentProposal = db.get(
      `SELECT * FROM ai_action_requests
       WHERE id = ? AND conversation_id = ? AND owner_id = ?
         AND action_type = 'RESUME_REWRITE_PROPOSAL'
         AND status IN ('proposed','awaiting_confirmation')`,
      [task.active_proposal_id, ctx.conversation.id, ctx.profile.owner_id],
    );
  }
  if (parentProposal) {
    const previousStored = parseJson(parentProposal.payload_json, {});
    parentProposalPayload = previousStored.proposal || previousStored;
    editingBase = String(
      parentProposalPayload.change_preview
        && parentProposalPayload.change_preview.after
        && parentProposalPayload.change_preview.after.text
      || parentProposalPayload.suggestion
      || locked.currentText,
    );
    if (
      parentProposalPayload.merge_strategy === 'three_way_target_document'
      && parentProposalPayload.base_resume_json
      && parentProposalPayload.target_resume_document
    ) {
      taskBaseResume = ResumeDom.toResumeDocument(parentProposalPayload.base_resume_json);
      proposalContent = ResumeDom.toResumeDocument(
        parentProposalPayload.target_resume_document,
      );
    } else if (Array.isArray(parentProposalPayload.operations) && parentProposalPayload.operations.length) {
      if (parentProposalPayload.operation_preconditions) {
        const validation = validateOperationPreconditions(
          resume,
          parentProposalPayload.operation_preconditions,
        );
        if (!validation.valid) {
          throw problem.conflict(
            'PROPOSAL_SUPERSEDED',
            '上一版建议依赖的文档结构已不存在，请重新生成建议',
          );
        }
      }
      try {
        proposalContent = ResumeDom.applyDocumentOperations(
          resume,
          parentProposalPayload.operations,
          { allowStructure: true },
        );
      } catch (error) {
        throw problem.conflict('PROPOSAL_SUPERSEDED', '上一版建议已无法基于当前草稿继续调整');
      }
    } else if (parentProposalPayload.resume_json) {
      if (parentProposalPayload.base_draft_revision !== ctx.draft.revision) {
        throw problem.conflict('PROPOSAL_SUPERSEDED', '当前草稿已经整体变化，请重新生成建议');
      }
      proposalContent = ResumeDom.toResumeDocument(parentProposalPayload.resume_json);
    }
  }
  const scopeRegion = scopeType === 'RESUME_BLOCK'
    ? resolveResumeScope(proposalContent || resume, scopeId)
    : null;
  const profileView = {
    id: ctx.profile.id,
    revision: ctx.profile.revision,
    basics: parseJson(ctx.profile.basics_json, {}),
    summary: ctx.profile.summary,
    experiences: experiences.map((item) => ({
      id: item.id,
      type: item.type,
      organization: item.organization,
      title: item.title,
      start_date: item.start_date,
      end_date: item.end_date,
      is_current: Boolean(item.is_current),
      description: item.description,
      revision: item.revision,
    })),
  };
  const llmInput = resumeHarness.buildHarnessInput({
    text: content,
    messageId: userMessageId,
    scope: { type: scopeType, id: scopeId, revision: scopeRevision },
    task: {
      id: task.id,
      goal: task.goal,
      status: task.status,
      state: parseJson(task.state_json, {}),
    },
    profile: profileView,
    resume: {
      revision: ctx.draft.revision,
      content: resume,
      content_hash: hashJson(resume),
      task_base_content: taskBaseResume,
      task_base_revision: parentProposalPayload
        ? parentProposalPayload.base_draft_revision
        : ctx.draft.revision,
      task_base_hash: hashJson(taskBaseResume),
      ...(proposalContent
        ? {
            proposal_content: proposalContent,
            previous_target_document: proposalContent,
            previous_target_hash: hashJson(proposalContent),
            previous_proposal_id: parentProposal.id,
          }
        : {}),
    },
    job: ctx.job
      ? {
          id: ctx.job.id,
          title: ctx.job.title,
          company: ctx.job.company,
          confirmed_text: ctx.job.confirmed_text,
          revision: ctx.job.revision,
        }
      : null,
    focus: {
      current_text: locked.currentText,
      editing_base: editingBase,
      scope_region: scopeRegion,
      location: locked.found
        ? {
            node_id: locked.found.node.id,
            node_tag: locked.found.node.tag || locked.found.node.type,
            ancestor_ids: locked.found.ancestors.map((node) => node.id),
          }
        : null,
      neighboring_content: locked.found
        ? locked.found.neighboringNodes
        : [],
    },
    conversationMessages: history,
    materials,
    attachments,
    imageHistory,
    imageSources,
    assetAuthorization: { ownerId: user.id, projectId: ctx.project.id,
      conversationId: ctx.conversation.id, taskId: task.id },
  });
  return {
    llmInput,
    currentText: locked.currentText,
    editingBase,
    proposalBaseResume: proposalContent,
    parentProposal: parentProposalPayload,
  };
}

async function runModel(llmInput, userMessageId, signal, runId) {
  try {
    const result = await resumeHarness.complete(llmInput, {
      signal,
      onMemory: (memory) => {
        const taskId = llmInput.request.task.id;
        const stored = db.get('SELECT state_json FROM ai_tasks WHERE id = ?', [taskId]);
        if (!stored || signal.aborted || parseJson(stored.state_json, {}).active_run_id !== runId) {
          throw problem.conflict('REQUEST_CANCELED', '本轮生成已停止');
        }
        db.run('UPDATE ai_tasks SET state_json = ?, updated_at = ? WHERE id = ?', [
          JSON.stringify({ ...parseJson(stored.state_json, {}), conversation_memory: memory }),
          nowIso(),
          taskId,
        ]);
      },
    });
    return {
      ...result,
      validation: policy.validateModelResponse(result.response, { userMessageId }),
    };
  } catch (error) {
    console.error(
      '[resume-harness] failed',
      error.code || 'UNKNOWN',
      error.message,
      JSON.stringify({
        finish_reason: error.finish_reason || null,
        content_length: error.content_length ?? null,
        reasoning_length: error.reasoning_length ?? null,
        max_tokens: error.max_tokens ?? null,
        timeout_phase: error.timeout_phase || null,
        duration_ms: error.duration_ms ?? null,
        diagnostics: error.validation_diagnostics || [],
      }),
    );
    if (error.code === 'MODEL_CONTEXT_COMPACTION_FAILED') {
      throw problem.unprocessable(error.code, error.message);
    }
    if (error.code === MODEL_ERROR_CODES.OUTPUT_TRUNCATED) {
      throw problem.unprocessable(
        'MODEL_OUTPUT_TRUNCATED',
        '模型生成的修改结果过长，系统已自动重试但仍未完整返回',
      );
    }
    if (error.code === MODEL_ERROR_CODES.INVALID_JSON) {
      throw problem.unprocessable(
        'MODEL_RESPONSE_INVALID',
        '模型没有返回完整可用的修改结果，请重新尝试',
      );
    }
    if (error.code === 'MODEL_OUTPUT_SCHEMA_INVALID') {
      throw problem.unprocessable(
        'MODEL_RESPONSE_INVALID',
        '模型返回的修改结果不完整，系统自动恢复后仍无法使用，请重新尝试',
      );
    }
    if (error.code === MODEL_ERROR_CODES.RESPONSE_FAILED) {
      throw problem.unprocessable(
        'MODEL_RESPONSE_INVALID',
        '模型没有完成可用的修改结果，请重新尝试',
      );
    }
    if (isModelServiceError(error)) {
      throw problem.unprocessable(
        'MODEL_UNAVAILABLE',
        String(error.code).includes('TIMEOUT')
          ? '模型等待超时，简历正文未变。本轮要求和附件已保留，可直接重试'
          : '模型服务暂时不可用，请稍后重试',
        { model_error_code: error.code, timeout_phase: error.timeout_phase || null,
          duration_ms: error.duration_ms ?? null },
      );
    }
    if (error.code === 'PROPOSAL_NOT_EXECUTABLE') {
      const validationErrors = Array.isArray(error.validation_errors)
        ? error.validation_errors
        : [];
      const actionErrors = (error.validation_diagnostics || []).filter((item) => item.code === 'ACTION_INVALID');
      const detail = actionErrors.some((item) => item.action_type === 'JOB_SET_CURRENT_PROPOSAL')
        ? 'AI 返回的岗位建议不完整，自动修复未成功。本轮修改未提交，原简历和要求已保留。'
        : actionErrors.some((item) => item.action_type === 'PROFILE_SAVE_PROPOSAL')
          ? 'AI 返回的资料建议不完整，自动修复未成功。本轮修改未提交，原简历和要求已保留。'
        : validationErrors.some((message) => message.includes('允许调整的简历区域'))
        ? 'AI 建议涉及了本轮未授权的简历区域，系统已阻止。请明确要一起调整的内容后重试'
        : validationErrors.some((message) => message.includes('保留全部原文字'))
          ? 'AI 建议没有完整保留原文字，系统已阻止。请重试或明确是否允许改写内容'
          : 'AI 返回的修改未通过检查，自动修复未成功。原简历未变，本轮要求已保留。';
      throw problem.unprocessable(
        'PROPOSAL_NOT_EXECUTABLE',
        detail,
        { validation_errors: validationErrors, validation_diagnostics: error.validation_diagnostics || [],
          repair_count: error.repair_count ?? null, finish_reason: error.finish_reason || null },
      );
    }
    throw problem.unprocessable(
      'MODEL_RESPONSE_INVALID',
      'AI 返回内容无法解析，请重试或换一种方式描述',
    );
  }
}

function insertAction({
  conversationId,
  messageId,
  user,
  type,
  targetType,
  targetId,
  payload,
  expectedRevision,
}) {
  const id = uuidv7();
  db.run(
    `INSERT INTO ai_action_requests
     (id, conversation_id, message_id, owner_id, action_type, target_type, target_id,
      payload_json, requires_user_action, status, expected_revision, policy_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'awaiting_confirmation', ?, ?, ?)`,
    [
      id,
      conversationId,
      messageId,
      user.id,
      type,
      targetType || null,
      targetId || null,
      JSON.stringify(payload || {}),
      expectedRevision === undefined ? null : expectedRevision,
      POLICY_VERSION,
      nowIso(),
    ],
  );
  return db.get('SELECT * FROM ai_action_requests WHERE id = ?', [id]);
}

function updateTaskState(task, patch, status) {
  const current = db.get('SELECT * FROM ai_tasks WHERE id = ?', [task.id]) || task;
  const state = parseJson(current.state_json, {});
  const turns = Array.isArray(state.turns) ? state.turns.slice(-11) : [];
  if (patch && patch.assistant_turn) {
    turns.push({
      role: 'assistant',
      content: String(patch.assistant_turn).slice(0, 1000),
    });
  }
  const nextState = {
    ...state,
    ...(patch || {}),
    turns,
  };
  delete nextState.assistant_turn;
  db.run(
    'UPDATE ai_tasks SET state_json = ?, status = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(nextState), status, nowIso(), task.id],
  );
}

function persistTaskFailure({
  ctx,
  user,
  task,
  scopeType,
  scopeId,
  scopeRevision,
  userMessageId,
  error,
  runId,
}) {
  const liveTask = db.get('SELECT * FROM ai_tasks WHERE id = ? AND owner_id = ?', [
    task.id,
    user.id,
  ]);
  if (!liveTask || !['understanding', 'planning', 'validated'].includes(liveTask.status)
    || (runId && parseJson(liveTask.state_json, {}).active_run_id !== runId)) return null;
  const detail = String(error && (error.detail || error.message) || 'AI 请求未完成');
  const content = `这次请求没有成功：${detail}`;
  const assistantMessageId = uuidv7();
  db.run(
    `INSERT INTO ai_messages
     (id, conversation_id, task_id, owner_id, role, content, scope_type, scope_id, scope_revision,
      model_metadata_json, created_at)
     VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`,
    [
      assistantMessageId,
      ctx.conversation.id,
      task.id,
      user.id,
      content,
      scopeType,
      scopeId,
      scopeRevision,
      JSON.stringify({
        task_id: task.id,
        request_message_id: userMessageId,
        result_type: 'ERROR',
        error_code: error && error.code || 'UNKNOWN',
        failure_diagnostics: {
          model_error_code: error?.extra?.model_error_code || null,
          timeout_phase: error?.extra?.timeout_phase || null,
          duration_ms: error?.extra?.duration_ms ?? null,
          repair_count: error?.extra?.repair_count ?? null,
          finish_reason: error?.extra?.finish_reason || null,
          issues: (error?.extra?.validation_diagnostics || []).map((item) => ({
            code: item.code, action_index: item.action_index ?? null,
            action_type: item.action_type || null,
          })),
        },
      }),
      nowIso(),
    ],
  );
  updateTaskState(task, {
    phase: 'failed',
    pending_clarification: null,
    last_error: {
      code: error && error.code || 'UNKNOWN',
      message: detail.slice(0, 500),
      at: nowIso(),
    },
  }, liveTask.active_proposal_id ? 'waiting_apply' : 'failed');
  return assistantMessageId;
}

function taskIdFromAction(action) {
  const payload = parseJson(action && action.payload_json, {});
  return payload.task_id || (payload.proposal && payload.proposal.task_id) || null;
}

function settleTaskAfterAction(action) {
  const taskId = taskIdFromAction(action);
  if (!taskId) return;
  const task = db.get('SELECT * FROM ai_tasks WHERE id = ? AND owner_id = ?', [
    taskId,
    action.owner_id,
  ]);
  if (!task) return;
  const pending = db
    .all(
      `SELECT payload_json FROM ai_action_requests
       WHERE conversation_id = ? AND owner_id = ?
         AND status IN ('awaiting_confirmation','proposed')`,
      [action.conversation_id, action.owner_id],
    )
    .some((row) => {
      const payload = parseJson(row.payload_json, {});
      return String(payload.task_id || (payload.proposal && payload.proposal.task_id) || '') === String(taskId);
    });
  updateTaskState(
    task,
    {
      phase: pending ? 'awaiting_confirmation' : 'completed',
      pending_clarification: null,
    },
    pending ? 'waiting_apply' : 'completed',
  );
  if (!pending) db.run('UPDATE ai_tasks SET active_proposal_id = NULL WHERE id = ?', [taskId]);
}

function applyActions({
  ctx,
  user,
  response,
  validation,
  provider,
  model,
  promptVersion,
  schemaVersion,
  repairCount,
  outputBudget,
  finishReason,
  modelRoute,
  routingReason,
  routingScore,
  gatewayMetrics,
  scopeType,
  scopeId,
  scopeRevision,
  currentText,
  editingBase,
  proposalBaseResume,
  parentProposal,
  task,
}) {
  const assistantMessageId = uuidv7();
  const metadata = {
    provider,
    model,
    prompt_version: promptVersion,
    schema_version: schemaVersion,
    policy_version: POLICY_VERSION,
    task_id: task.id,
    repair_count: repairCount || 0,
    output_budget: outputBudget || null,
    finish_reason: finishReason || null,
    model_route: modelRoute || null,
    routing_reason: routingReason || null,
    routing_score: Number.isFinite(routingScore) ? routingScore : null,
    gateway_metrics: gatewayMetrics || null,
    result_type: response.result_type,
    protocol_type: response.type,
    awaiting_user: Boolean(response.awaiting_user),
    quick_replies: response.quick_replies || [],
    clarification: response.clarification || null,
    plan: response.plan || null,
    message_kind: response.message_kind || null,
    flow_plan: response.flow_plan || null,
  };
  db.run(
    `INSERT INTO ai_messages
     (id, conversation_id, task_id, owner_id, role, content, scope_type, scope_id, scope_revision,
      model_metadata_json, created_at)
     VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`,
    [
      assistantMessageId,
      ctx.conversation.id,
      task.id,
      user.id,
      response.reply,
      scopeType,
      scopeId,
      scopeRevision,
      JSON.stringify(metadata),
      nowIso(),
    ],
  );

  const executed = [];
  const rejected = [...validation.rejected];
  validation.actions.forEach((action) => {
    if (!actionAllowedInScope(action.type, scopeType)) {
      rejected.push({ action_type: action.type, reason: '动作超出本轮可修改范围' });
      return;
    }
    try {
      let row;
      if (action.type === 'RESUME_REWRITE_PROPOSAL') {
        const payload = normalizeRewriteProposal({
          action,
          currentText,
          editingBase,
          scopeType,
          scopeId,
          draft: ctx.draft,
          task,
          proposalBaseResume,
          parentProposal,
        });
        row = insertAction({
          conversationId: ctx.conversation.id,
          messageId: assistantMessageId,
          user,
          type: action.type,
          targetType: scopeType,
          targetId: scopeId,
          payload: { task_id: task.id, proposal: payload },
          expectedRevision: ctx.draft.revision,
        });
        if (task.active_proposal_id && task.active_proposal_id !== row.id) {
          // 旧建议保留用于展示，但不能再应用。
          db.run("UPDATE ai_action_requests SET status = 'superseded' WHERE id = ? AND status = 'awaiting_confirmation'", [
            task.active_proposal_id,
          ]);
        }
        db.run(
          "UPDATE ai_tasks SET active_proposal_id = ?, status = 'waiting_apply', updated_at = ? WHERE id = ?",
          [row.id, nowIso(), task.id],
        );
      } else if (action.type === 'PROFILE_SAVE_PROPOSAL') {
        const raw = action.payload || {};
        const payload = {
          task_id: task.id,
          operation: raw.operation || 'update_basics',
          values: raw.values || {},
        };
        row = insertAction({
          conversationId: ctx.conversation.id,
          messageId: assistantMessageId,
          user,
          type: action.type,
          targetType: action.target_type || 'profile_basics',
          targetId: action.target_id || ctx.profile.id,
          payload,
          expectedRevision: ctx.profile.revision,
        });
      } else if (action.type === 'JOB_SET_CURRENT_PROPOSAL') {
        const raw = action.payload || {};
        if (!String(raw.confirmed_text || '').trim()) {
          throw problem.unprocessable('INVALID_MODEL_ACTION', '岗位建议缺少岗位文本');
        }
        row = insertAction({
          conversationId: ctx.conversation.id,
          messageId: assistantMessageId,
          user,
          type: action.type,
          targetType: 'target_job',
          targetId: null,
          payload: {
            task_id: task.id,
            title: String(raw.title || ''),
            company: String(raw.company || ''),
            confirmed_text: String(raw.confirmed_text || ''),
          },
          expectedRevision: ctx.project.revision,
        });
      }
      if (row) executed.push(toActionView(row));
    } catch (error) {
      // A proposal batch is atomic. Never publish only the fragments/actions
      // that happened to pass business assembly.
      throw problem.unprocessable('ACTIONS_REJECTED',
        '修改尚未完成，简历正文未变。已保留本轮要求，可直接重试',
        { rejected: [{ action_type: action.type, reason: error.detail || error.message }] });
    }
  });
  let finalReply = response.reply;
  if (!executed.length && rejected.length) {
    throw problem.unprocessable('ACTIONS_REJECTED',
      '修改尚未完成，简历正文未变。已保留本轮要求，可直接重试', { rejected });
  }
  if (response.result_type === 'MESSAGE' && response.awaiting_user) {
    updateTaskState(task, {
      phase: 'clarifying',
      pending_message: {
        content: finalReply,
        quick_replies: response.quick_replies || [],
        message_kind: response.message_kind || null,
      },
      pending_plan: response.flow_plan || response.plan || null,
      pending_clarification: null,
      last_error: null,
      assistant_turn: finalReply,
    }, 'clarifying');
  } else if (executed.length) {
    updateTaskState(task, {
      phase: 'awaiting_confirmation',
      pending_message: null,
      pending_plan: null,
      pending_clarification: null,
      last_error: null,
      assistant_turn: finalReply,
    }, 'waiting_apply');
  } else if (rejected.length) {
    updateTaskState(task, {
      phase: 'failed',
      pending_plan: null,
      pending_clarification: null,
      last_error: {
        code: 'ACTIONS_REJECTED',
        message: rejected.map((item) => item.reason).join('；').slice(0, 500),
        at: nowIso(),
      },
      assistant_turn: finalReply,
    }, 'failed');
  } else {
    // An ordinary answer is not an instruction to discard a pending proposal
    // or forget this conversation. Only apply/discard/new-chat ends that chain.
    updateTaskState(task, {
      phase: task.active_proposal_id ? 'awaiting_confirmation' : 'conversing',
      pending_message: null,
      pending_plan: null,
      pending_clarification: null,
      last_error: null,
      assistant_turn: finalReply,
    }, task.active_proposal_id ? 'waiting_apply' : 'conversing');
  }
  return { assistantMessageId, executed, rejected, finalReply };
}

function applyRewriteProposal({ user, project, draft, action, requestId, ipHash }) {
  return db.tx(() => {
    const stored = parseJson(action.payload_json, {});
    const payload = stored.proposal || stored;
    const resume = ResumeDom.toResumeDocument(parseJson(draft.resume_json, {}));
    let before;
    let after;
    let nextResume;
    const appliedOperations = Array.isArray(payload.operations) && payload.operations.length
      ? payload.operations
      : (
          payload.scope_type === 'RESUME_BLOCK'
            ? [{ op: 'replace_text', node_id: payload.scope_id, text: payload.suggestion }]
            : []
        );
    const usesTargetDocumentMerge = Boolean(
      payload.base_resume_json
      && payload.target_resume_document
      && payload.merge_strategy === 'three_way_target_document',
    );
    let mergeResult = null;
    if (usesTargetDocumentMerge) {
      try {
        mergeResult = mergeResumeDocuments({
          base: payload.base_resume_json,
          target: payload.target_resume_document,
          current: resume,
        });
        nextResume = mergeResult.document;
      } catch (error) {
        throw problem.conflict(
          'PROPOSAL_REBASE_REQUIRED',
          '当前简历结构已变化，需要根据最新内容重新生成这项建议',
          {
            merge_errors: [{
              code: error.code || 'RESUME_MERGE_FAILED',
              message: error.message,
              node_id: error.node_id || null,
              parent_id: error.parent_id || null,
            }],
            task_id: payload.task_id || stored.task_id || null,
            scope_type: payload.scope_type,
            scope_id: payload.scope_id,
            recovery_instruction: '请根据当前最新简历重新生成刚才的修改建议，保持原要求不变。',
          },
        );
      }
      const changedIds = mergeResult.changed_node_ids
        || topLevelChangedNodeIds(resume, nextResume);
      const metadataChanged = ['page_setup', 'styles', 'assets', 'annotations']
        .some((key) => hashJson(resume[key] || null) !== hashJson(nextResume[key] || null));
      let delta = null;
      if (
        !metadataChanged && changedIds.length === 1
        // A document root has no parent and cannot be restored by replacing a
        // child. Let the structure recorder select the full-document fallback.
        && ResumeDom.findNode(resume, changedIds[0])?.parent
        && ResumeDom.findNode(nextResume, changedIds[0])?.parent
      ) {
        delta = createNodeDeltaPair(resume, nextResume, changedIds, {
          label: String(payload.summary || payload.title || 'AI 修改简历').slice(0, 120),
        });
      } else if (!metadataChanged && changedIds.length) {
        delta = createStructureDeltaPair(
          resume,
          nextResume,
          changedIds.map((nodeId) => ({ op: 'set_style', node_id: nodeId })),
          {
            label: String(payload.summary || payload.title || 'AI 调整简历').slice(0, 120),
          },
        );
      }
      if (delta) {
        before = delta.before;
        after = delta.after;
      } else {
        before = { resume_json: deepClone(resume) };
        after = { resume_json: deepClone(nextResume) };
      }
    } else if (payload.scope_type === 'RESUME_BLOCK') {
      if (payload.operation_preconditions) {
        const validation = validateOperationPreconditions(resume, payload.operation_preconditions);
        if (!validation.valid) {
          throw problem.conflict('OPERATION_NOT_EXECUTABLE', '当前文档结构已无法执行这项修改', {
            conflicts: validation.errors,
          });
        }
      } else {
        try {
          payload.operation_preconditions = buildOperationPreconditions(resume, appliedOperations);
        } catch (error) {
          throw problem.conflict('OPERATION_NOT_EXECUTABLE', '当前文档结构已无法执行这项修改', {
            reason: error.message,
          });
        }
        db.run('UPDATE ai_action_requests SET payload_json = ? WHERE id = ?', [
          JSON.stringify(stored.proposal ? { ...stored, proposal: payload } : payload),
          action.id,
        ]);
      }
      try {
        nextResume = ResumeDom.applyDocumentOperations(
          resume,
          appliedOperations,
          { allowStructure: true },
        );
      } catch (error) {
        throw problem.conflict('OPERATION_NOT_EXECUTABLE', '当前文档结构已无法执行这项修改', {
          reason: error.message,
        });
      }
      const simpleText = appliedOperations.length === 1
        && appliedOperations[0].op === 'replace_text'
        && String(appliedOperations[0].node_id) === String(payload.scope_id);
      const delta = simpleText
        ? createNodeDeltaPair(resume, nextResume, [payload.scope_id], {
            label: String(payload.summary || payload.title || 'AI 修改简历内容').slice(0, 120),
          })
        : createStructureDeltaPair(resume, nextResume, appliedOperations, {
            label: String(payload.summary || payload.title || 'AI 调整局部结构').slice(0, 120),
          });
      if (delta) {
        before = delta.before;
        after = delta.after;
      } else {
        before = { resume_json: deepClone(resume) };
        after = { resume_json: deepClone(nextResume) };
      }
    } else {
      if (appliedOperations.length) {
        if (!payload.operation_preconditions) {
          try {
            payload.operation_preconditions = buildOperationPreconditions(resume, appliedOperations);
          } catch (error) {
            throw problem.conflict('OPERATION_NOT_EXECUTABLE', '当前文档结构已无法执行这项修改', {
              reason: error.message,
            });
          }
          db.run('UPDATE ai_action_requests SET payload_json = ? WHERE id = ?', [
            JSON.stringify(stored.proposal ? { ...stored, proposal: payload } : payload),
            action.id,
          ]);
        }
        const validation = validateOperationPreconditions(resume, payload.operation_preconditions);
        if (!validation.valid) {
          throw problem.conflict('OPERATION_NOT_EXECUTABLE', '当前文档结构已无法执行这项修改', {
            conflicts: validation.errors,
          });
        }
        try {
          nextResume = ResumeDom.applyDocumentOperations(resume, appliedOperations, {
            allowStructure: true,
          });
        } catch (error) {
          throw problem.conflict('OPERATION_NOT_EXECUTABLE', '当前文档结构已无法执行这项修改', {
            reason: error.message,
          });
        }
        const delta = createStructureDeltaPair(resume, nextResume, appliedOperations, {
          label: String(payload.summary || payload.title || 'AI 调整简历').slice(0, 120),
        });
        if (delta) {
          before = delta.before;
          after = delta.after;
        }
      } else if (payload.resume_json && typeof payload.resume_json === 'object') {
        nextResume = ResumeDom.toResumeDocument(payload.resume_json);
      } else {
        throw problem.unprocessable('INVALID_PROPOSAL', '整份简历建议缺少 DOM 操作');
      }
      if (!before || !after) {
        before = { resume_json: deepClone(resume) };
        after = { resume_json: deepClone(nextResume) };
      }
    }
    const policyValidation = validateAuthorizedChange({
      authorization: payload.change_policy,
      before: resume,
      after: nextResume,
      operations: usesTargetDocumentMerge ? [] : appliedOperations,
      replacementResume: usesTargetDocumentMerge
        ? null
        : (appliedOperations.length ? null : payload.resume_json),
      targetResume: usesTargetDocumentMerge ? payload.target_resume_document : null,
      revision: draft.revision,
      allowUserContentOverride: true,
    });
    if (!policyValidation.valid) {
      throw problem.conflict(
        'RESUME_CHANGE_POLICY_VIOLATION',
        '这项建议的实际修改超出了你本轮允许的范围，请重新生成',
        { policy_errors: policyValidation.errors },
      );
    }
    if (payload.change_policy && !policyValidation.legacy) {
      payload.change_policy.applied_on_revision = draft.revision;
      payload.change_policy.content_override = Boolean(policyValidation.content_override);
    }
    if (usesTargetDocumentMerge && mergeResult) {
      payload.merge_result = {
        format: mergeResult.format,
        rebased: mergeResult.rebased,
        ai_change_count: mergeResult.ai_change_count,
        current_change_count: mergeResult.current_change_count,
        applied_change_count: mergeResult.applied_change_count,
        overridden_field_count: mergeResult.overridden_paths.length,
      };
    }
    payload.change_preview = buildChangePreview(resume, nextResume, {
      revision: draft.revision,
      constraints: payload.change_policy && payload.change_policy.constraints
        || payload.change_constraints,
    });
    payload.summary = payload.change_preview.summary;
    const taskId = stored.task_id || payload.task_id;
    if (hashJson(resume) === hashJson(nextResume)) {
      payload.change_preview.already_satisfied = true;
      payload.change_preview.summary = '当前内容已符合建议';
      payload.summary = payload.change_preview.summary;
      db.run("UPDATE ai_action_requests SET payload_json = ?, status = 'applied', applied_at = ? WHERE id = ?", [
        JSON.stringify(stored.proposal ? { ...stored, proposal: payload } : payload),
        nowIso(),
        action.id,
      ]);
      if (taskId) {
        db.run(
          "UPDATE ai_tasks SET active_proposal_id = NULL, status = 'completed', updated_at = ? WHERE id = ?",
          [nowIso(), taskId],
        );
      }
      audit.log({
        ownerId: user.id,
        action: 'resume_rewrite_already_satisfied',
        resourceType: 'resume_draft',
        resourceId: draft.id,
        requestId,
        ipHash,
        metadata: {
          scope_type: payload.scope_type,
          scope_id: payload.scope_id,
          revision: draft.revision,
        },
      });
      return {
        revision: draft.revision,
        change_event_id: null,
        mutation_id: null,
        resume_json: resume,
        no_change: true,
        version_created: false,
      };
    }
    const changeType = usesTargetDocumentMerge
      ? 'resume_document_merge'
      : 'dom_operations';
    const revision = draft.revision + 1;
    db.run(
      `UPDATE resume_drafts
       SET resume_json = ?, revision = ?, has_unsnapshotted_changes = 1, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(nextResume), revision, nowIso(), draft.id],
    );
    const mutationId = uuidv7();
    const eventId = uuidv7();
    db.run(
      `INSERT INTO resume_change_events
       (id, project_id, owner_id, draft_revision, change_type, scope_type, scope_id,
        before_json, after_json, actor_type, mutation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?)`,
      [
        eventId,
        project.id,
        user.id,
        revision,
        changeType,
        payload.scope_type,
        payload.scope_id,
        JSON.stringify(before),
        JSON.stringify(after),
        mutationId,
        nowIso(),
      ],
    );
    db.run("UPDATE ai_action_requests SET payload_json = ?, status = 'applied', applied_at = ? WHERE id = ?", [
      JSON.stringify(stored.proposal ? { ...stored, proposal: payload } : payload),
      nowIso(),
      action.id,
    ]);
    refreshResumeProposalStaleness(
      db,
      project.id,
      user.id,
      {
        resume: nextResume,
        revision,
        excludeActionId: action.id,
      },
    );
    if (taskId) {
      db.run(
        "UPDATE ai_tasks SET active_proposal_id = NULL, status = 'completed', updated_at = ? WHERE id = ?",
        [nowIso(), taskId],
      );
    }
    audit.log({
      ownerId: user.id,
      action: 'resume_rewrite_applied',
      resourceType: 'resume_draft',
      resourceId: draft.id,
      requestId,
      ipHash,
      metadata: { scope_type: payload.scope_type, scope_id: payload.scope_id, revision, change_event_id: eventId },
    });
    return {
      revision,
      change_event_id: eventId,
      mutation_id: mutationId,
      resume_json: nextResume,
      version_created: false,
    };
  });
}

function applyRewriteAndSaveFirst({ ctx, user, action, requestId, ipHash }) {
  return db.tx(() => {
    const firstGeneration = !ResumeDom.plainText(
      ResumeDom.toResumeDocument(parseJson(ctx.draft.resume_json, {}))).trim()
      && !db.get('SELECT id FROM resume_versions WHERE project_id = ? LIMIT 1', [ctx.project.id]);
    const change = applyRewriteProposal({
      user, project: ctx.project, draft: ctx.draft, action, requestId, ipHash,
    });
    if (firstGeneration) {
      const version = require('./versions').saveDraftVersion({
        params: { id: ctx.project.id }, body: { name: '首次生成' },
        user, req: { headers: {} }, requestId, ipHash, versionKind: 'generated',
      });
      Object.assign(change, { version_id: version.id, draft_revision: version.draft_revision,
        revision: version.draft_revision, version_created: true });
    }
    return change;
  });
}

function applyProfileSave({ action, ctx, user, requestId, ipHash }) {
  const payload = parseJson(action.payload_json, {});
  if (payload.operation !== 'update_basics') {
    throw problem.unprocessable('UNSUPPORTED_PROFILE_OPERATION', '当前仅支持保存个人基础字段');
  }
  const entries = Object.entries(payload.values || {}).filter(([field]) =>
    policy.PROFILE_WHITELIST.has(field),
  );
  if (entries.length !== 1) {
    throw problem.unprocessable('INVALID_PROFILE_PROPOSAL', '每次资料保存建议需包含一个明确字段');
  }
  const [field, value] = entries[0];
  return policy.executeProfileFieldUpdate({
    user,
    project: ctx.project,
    profile: ctx.profile,
    field,
    value,
    actionRequestId: action.id,
    requestId,
    ipHash,
  });
}

function applyCurrentJob({ action, ctx, user, requestId, ipHash }) {
  return db.tx(() => {
    const payload = parseJson(action.payload_json, {});
    const id = uuidv7();
    db.run(
      `INSERT INTO target_jobs
       (id, project_id, owner_id, title, company, confirmed_text, ocr_text, analysis_json,
        revision, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1, 'confirmed', ?, ?)`,
      [
        id,
        ctx.project.id,
        user.id,
        payload.title || '',
        payload.company || '',
        payload.confirmed_text || '',
        payload.confirmed_text || '',
        nowIso(),
        nowIso(),
      ],
    );
    db.run('UPDATE resume_projects SET current_job_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [
      id,
      nowIso(),
      ctx.project.id,
    ]);
    db.run("UPDATE ai_action_requests SET target_id = ?, status = 'applied', applied_at = ? WHERE id = ?", [
      id,
      nowIso(),
      action.id,
    ]);
    queue.publish({ aggregateType: 'target_job', aggregateId: id, eventType: 'job.analyze.requested' });
    audit.log({
      ownerId: user.id,
      action: 'current_job_set_from_chat',
      resourceType: 'target_job',
      resourceId: id,
      requestId,
      ipHash,
    });
    return { job_id: id, resume_unchanged: true };
  });
}

const routes = [
  {
    method: 'GET',
    pattern: '/projects/:id/ai/status',
    handler: ({ params, user, query }) => {
      const ctx = loadContext(params.id, user, {
        conversationId: query.get('conversation_id') || null,
      });
      const task = db.get(
        `SELECT id, status, json_extract(state_json, '$.active_run_id') AS run_id
         FROM ai_tasks WHERE conversation_id = ? AND owner_id = ?
         AND status IN ('understanding','planning','validated') LIMIT 1`,
        [ctx.conversation.id, user.id],
      );
      const latest = db.get(
        `SELECT id FROM ai_messages WHERE conversation_id = ? AND owner_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [ctx.conversation.id, user.id],
      );
      const clientRequestId = query.get('client_request_id');
      const retryMessageId = query.get('retry_message_id');
      const failed = retryMessageId ? db.get(
        `SELECT model_metadata_json FROM ai_messages WHERE id = ?
         AND conversation_id = ? AND owner_id = ? AND role = 'assistant'
         AND json_extract(model_metadata_json, '$.result_type') = 'ERROR'`,
        [retryMessageId, ctx.conversation.id, user.id],
      ) : null;
      const requestMessageId = parseJson(failed?.model_metadata_json, {}).request_message_id;
      const request = clientRequestId || requestMessageId ? db.get(
        `SELECT id, task_id FROM ai_messages WHERE conversation_id = ? AND owner_id = ?
         AND role = 'user' AND ${requestMessageId ? 'id = ?'
          : "json_extract(model_metadata_json, '$.client_request_id') = ?"} LIMIT 1`,
        [ctx.conversation.id, user.id, requestMessageId || clientRequestId],
      ) : null;
      return { conversation_id: ctx.conversation.id, running_task: task || null,
        latest_message_id: latest?.id || null,
        request_message_id: request?.id || null };
    },
  },
  {
    method: 'POST',
    pattern: '/projects/:id/ai/cancel',
    handler: ({ params, user, body }) => {
      const ctx = loadContext(params.id, user, { conversationId: body.conversation_id || null });
      const task = db.get(
        `SELECT * FROM ai_tasks WHERE conversation_id = ? AND owner_id = ?
         AND status IN ('understanding','planning','validated') LIMIT 1`,
        [ctx.conversation.id, user.id],
      );
      if (!task) return { stopped: false };
      const state = parseJson(task.state_json, {});
      if (body.run_id !== state.active_run_id) {
        throw problem.conflict('REQUEST_SUPERSEDED', '生成状态已更新，请刷新后重试');
      }
      const request = db.get(
        `SELECT * FROM ai_messages WHERE task_id = ? AND role = 'user'
         ORDER BY created_at DESC, id DESC LIMIT 1`, [task.id],
      );
      const messageId = db.tx(() => persistTaskFailure({
        ctx, user, task, scopeType: task.scope_type, scopeId: task.scope_id,
        scopeRevision: ctx.draft.revision, userMessageId: request.id,
        runId: state.active_run_id,
        error: { code: 'REQUEST_CANCELED', message: '已停止生成，正文未变。本轮要求已保留，可重试或继续补充' },
      }));
      inflight.cancel(`global:${user.id}:${ctx.conversation.id}`);
      return { stopped: true, persisted_message_id: messageId };
    },
  },
  {
    method: 'GET',
    pattern: '/projects/:id/ai/messages',
    handler: ({ params, user, query }) => {
      const { conversation, draft } = loadContext(params.id, user, {
        conversationId: query.get('conversation_id') || null,
      });
      const resume = ResumeDom.toResumeDocument(parseJson(draft.resume_json, {}));
      return {
        conversation_id: conversation.id,
        items: db
          .all('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC', [
            conversation.id,
          ])
          .map((row) => toMessageView(row, {
            resume,
            draftRevision: draft.revision,
          })),
      };
    },
  },
  {
    method: 'GET',
    pattern: '/projects/:id/ai/actions',
    handler: ({ params, user, query }) => {
      const { conversation, draft } = loadContext(params.id, user, {
        conversationId: query.get('conversation_id') || null,
      });
      const resume = ResumeDom.toResumeDocument(parseJson(draft.resume_json, {}));
      const status = query.get('status') || 'pending';
      const statuses = status === 'pending' ? ['awaiting_confirmation', 'proposed'] : null;
      const rows = status === 'all'
        ? db.all(
            'SELECT * FROM ai_action_requests WHERE conversation_id = ? AND owner_id = ? ORDER BY created_at DESC',
            [conversation.id, user.id],
          )
        : db.all(
            `SELECT * FROM ai_action_requests
             WHERE conversation_id = ? AND owner_id = ? AND status IN (${(statuses || [status]).map(() => '?').join(',')})
             ORDER BY created_at ASC`,
            [conversation.id, user.id, ...(statuses || [status])],
          );
      return {
        items: rows.map((row) => toActionView(row, {
          resume,
          draftRevision: draft.revision,
        })),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/projects/:id/ai/messages',
    handler: async ({ params, body, user, requestId, ipHash }) => {
      const ctx = loadContext(params.id, user, {
        conversationId: body.conversation_id || null,
      });
      if (body.client_request_id) {
        if (typeof body.client_request_id !== 'string' || body.client_request_id.length > 128) {
          throw problem.badRequest('请求标识无效');
        }
      }
      const replayedSubmission = () => {
        if (!body.client_request_id) return null;
        const previous = db.get(`SELECT id, task_id FROM ai_messages
          WHERE conversation_id = ? AND owner_id = ? AND role = 'user'
          AND json_extract(model_metadata_json, '$.client_request_id') = ? LIMIT 1`,
        [ctx.conversation.id, user.id, body.client_request_id]);
        return previous ? { replayed: true, task_id: previous.task_id,
          conversation_id: ctx.conversation.id, actions: [], rejected: [] } : null;
      };
      const previousSubmission = replayedSubmission();
      if (previousSubmission) return previousSubmission;
      const busy = db.get(
        `SELECT id FROM ai_tasks WHERE conversation_id = ? AND owner_id = ?
         AND status IN ('understanding','planning','validated') LIMIT 1`,
        [ctx.conversation.id, user.id],
      );
      if (busy) throw problem.conflict('TASK_BUSY', 'AI 正在处理上一条消息，请稍候或停止生成');
      let retryRequest = null;
      if (body.retry_message_id) {
        // A retry is a reference to the latest failed turn, never client-built
        // history. Reuse its user row and attachments without duplicating text.
        const failure = db.get(
          `SELECT * FROM ai_messages WHERE id = ? AND conversation_id = ?
           AND owner_id = ? AND role = 'assistant'`,
          [body.retry_message_id, ctx.conversation.id, user.id],
        );
        const latest = db.get(
          `SELECT id FROM ai_messages WHERE conversation_id = ? AND owner_id = ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          [ctx.conversation.id, user.id],
        );
        const metadata = parseJson(failure && failure.model_metadata_json, {});
        const retryTask = failure && db.get(
          'SELECT * FROM ai_tasks WHERE id = ? AND conversation_id = ? AND owner_id = ?',
          [failure.task_id, ctx.conversation.id, user.id],
        );
        if (!failure || latest?.id !== failure.id || metadata.result_type !== 'ERROR'
          || !retryTask || !['failed', 'waiting_apply'].includes(retryTask.status)) {
          throw problem.conflict('RETRY_SUPERSEDED', '这条请求已处理或对话已更新，请继续当前对话');
        }
        retryRequest = db.get(
          `SELECT * FROM ai_messages WHERE id = ? AND task_id = ? AND conversation_id = ?
           AND owner_id = ? AND role = 'user'`,
          [metadata.request_message_id, retryTask.id, ctx.conversation.id, user.id],
        );
        if (!retryRequest) throw problem.conflict('RETRY_UNAVAILABLE', '本轮要求已不存在，请重新发送');
        const requestMetadata = parseJson(retryRequest.model_metadata_json, {});
        body = {
          conversation_id: ctx.conversation.id,
          task_id: retryTask.id,
          content: retryRequest.content,
          scope_type: retryRequest.scope_type,
          scope_id: retryRequest.scope_id,
          attachment_ids: requestMetadata.attachment_ids || [],
          document_import_ids: requestMetadata.document_import_ids || [],
          link_materials: requestMetadata.link_materials || null,
          initial_generation: requestMetadata.initial_generation === true,
          home_materials: requestMetadata.home_materials || null,
        };
      }
      let homeMaterials = retryRequest ? body.home_materials : null;
      if (!retryRequest && body.home_intake_id) {
        const intake = require('../lib/home-materials').authorizeGeneration({
          intakeId: body.home_intake_id, user, projectId: ctx.project.id, conversationId: ctx.conversation.id,
        });
        homeMaterials = intake.home_materials;
        body = { ...body, ...intake, initial_generation: true };
      }
      if (body.context_mode !== undefined && !['continue', 'fresh'].includes(body.context_mode)) {
        throw problem.badRequest('对话延续方式无效');
      }
      if (body.context_mode === 'fresh' && (body.task_id || body.parent_proposal_id || body.quick_reply_id)) {
        throw problem.badRequest('不延续当前对话时不能指定上一项任务或建议');
      }
      const content = String(body.content || '');
      if (!content.trim() && !(Array.isArray(body.attachment_ids) && body.attachment_ids.length)
        && !(Array.isArray(body.document_import_ids) && body.document_import_ids.length)) {
        throw problem.badRequest('请输入要求或添加文件');
      }
      const scopeType = body.scope_type || 'RESUME_DOCUMENT';
      const locked = validateLockedScope(ctx, scopeType, body.scope_id || null);
      const scopeId = locked.scopeId;
      const scopeRevision = body.scope_revision !== undefined
        ? body.scope_revision
        : ctx.draft
          ? ctx.draft.revision
          : null;
      const attachmentIds = body.attachment_ids === undefined ? [] : body.attachment_ids;
      const documentIds = body.document_import_ids || [];
      loadDocumentMaterials(documentIds, user, ctx.project.id, ctx.conversation.id);
      if (Array.isArray(attachmentIds) && attachmentIds.length + documentIds.length > 8) {
        throw problem.badRequest('每条消息最多附带 8 个文件');
      }
      let linkMaterials = retryRequest || homeMaterials ? body.link_materials : null;
      const attachments = await loadChatImages(attachmentIds, user, ctx.conversation.id);
      // Image decoding yields to the event loop. Recheck ownership/liveness
      // and the conversation lock before creating any task or user message.
      if (!db.get("SELECT id FROM ai_conversations WHERE id = ? AND owner_id = ? AND status = 'active'",
        [ctx.conversation.id, user.id])) throw problem.conflict('REQUEST_CANCELED', '对话已结束，请在新对话中重新发送');
      // A duplicate may have completed while image decoding yielded. The busy
      // check alone would then allow the same submission to create another task.
      const decodedReplay = replayedSubmission();
      if (decodedReplay) return decodedReplay;
      if (db.get(`SELECT id FROM ai_tasks WHERE conversation_id = ? AND owner_id = ?
        AND status IN ('understanding','planning','validated') LIMIT 1`, [ctx.conversation.id, user.id])) {
        throw problem.conflict('TASK_BUSY', 'AI 正在处理上一条消息，请稍候或停止生成');
      }
      // Home uploads acquire their conversation on first use. Recheck after
      // asynchronous decoding so concurrent projects cannot claim the same file.
      db.tx(() => {
        for (const id of attachmentIds) {
          const upload = db.get('SELECT chat_conversation_id FROM uploads WHERE id = ? AND owner_id = ?', [id, user.id]);
          if (!upload || (upload.chat_conversation_id && upload.chat_conversation_id !== ctx.conversation.id)) {
            throw problem.badRequest('图片属于另一段对话，请重新上传');
          }
          db.run('UPDATE uploads SET chat_conversation_id = ? WHERE id = ? AND owner_id = ?',
            [ctx.conversation.id, id, user.id]);
        }
      });
      const task = resolveTask({ ctx, user, body, scopeType, scopeId, content, retry: Boolean(retryRequest) });
      const userMessageId = retryRequest ? retryRequest.id : uuidv7();
      if (!retryRequest) db.run(
        `INSERT INTO ai_messages
         (id, conversation_id, task_id, owner_id, role, content, scope_type, scope_id, scope_revision,
          model_metadata_json, created_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
        [
          userMessageId,
          ctx.conversation.id,
          task.id,
          user.id,
          content,
          scopeType,
          scopeId,
          scopeRevision,
          JSON.stringify({ task_id: task.id, attachment_ids: attachmentIds,
            context_mode: body.context_mode || 'continue',
            document_import_ids: documentIds, link_materials: linkMaterials,
            ...(homeMaterials ? { home_materials: homeMaterials } : {}),
            client_request_id: body.client_request_id || null,
            initial_generation: body.initial_generation === true }),
          nowIso(),
        ],
      );
      db.run(
        'UPDATE ai_conversations SET active_scope_type = ?, active_scope_id = ?, updated_at = ? WHERE id = ?',
        [scopeType, scopeId, nowIso(), ctx.conversation.id],
      );
      let assembled;
      let result;
      let applied;
      const runId = uuidv7();
      const running = inflight.begin(`global:${user.id}:${ctx.conversation.id}`);
      try {
        updateTaskState(task, { phase: 'planning', active_run_id: runId }, 'planning');
        if (linkMaterials === null) {
          linkMaterials = await readMessageLinks(content, running.signal);
          running.signal.throwIfAborted();
          db.run(`UPDATE ai_messages SET model_metadata_json =
            json_set(model_metadata_json, '$.link_materials', json(?)) WHERE id = ? AND owner_id = ?`,
          [JSON.stringify(linkMaterials), userMessageId, user.id]);
        }
        assembled = await assembleInput({
          ctx,
          user,
          userMessageId,
          content,
          scopeType,
          scopeId,
          scopeRevision,
          task,
          parentProposalId: body.parent_proposal_id || null,
          attachments,
        });
        result = await runModel(assembled.llmInput, userMessageId, running.signal, runId);
        const liveTask = db.get('SELECT status, state_json FROM ai_tasks WHERE id = ?', [task.id]);
        if (running.signal.aborted || !liveTask || liveTask.status !== 'planning'
          || parseJson(liveTask.state_json, {}).active_run_id !== runId) {
          throw problem.conflict('REQUEST_CANCELED', '本轮生成已停止，迟到结果未保存');
        }
        updateTaskState(task, {
          phase: 'validated',
          last_model_resume_revision: ctx.draft.revision,
          last_model_resume_hash: assembled.llmInput.workspace.resume.content_hash,
          last_model_result_type: result.response.result_type,
        }, 'validated');
        applied = db.tx(() => {
          const proposals = applyActions({
          ctx, user, response: result.response, validation: result.validation,
          provider: result.provider, model: result.model,
          promptVersion: result.prompt_version, schemaVersion: result.schema_version,
          repairCount: result.repair_count, outputBudget: result.output_budget,
          finishReason: result.finish_reason, modelRoute: result.model_route,
          routingReason: result.routing_reason, routingScore: result.routing_score,
          gatewayMetrics: result.gateway_metrics,
          scopeType, scopeId, scopeRevision, currentText: assembled.currentText,
          editingBase: assembled.editingBase, proposalBaseResume: assembled.proposalBaseResume,
          parentProposal: assembled.parentProposal, task,
          });
          // The homepage authorizes creation of the first blank document only.
          // Reused/imported/current documents retain the explicit Apply boundary.
          const initial = db.get(`SELECT id FROM ai_messages WHERE conversation_id = ?
            AND owner_id = ? AND role = 'user'
            AND json_extract(model_metadata_json, '$.initial_generation') = 1 LIMIT 1`,
          [ctx.conversation.id, user.id]);
          const liveDraft = db.get('SELECT * FROM resume_drafts WHERE id = ? AND owner_id = ?', [ctx.draft.id, user.id]);
          const rewrite = proposals.executed.find((item) => item.action_type === 'RESUME_REWRITE_PROPOSAL');
          if (initial && rewrite && liveDraft.revision === ctx.draft.revision
            && !ResumeDom.plainText(ResumeDom.toResumeDocument(parseJson(liveDraft.resume_json, {}))).trim()
            && !db.get('SELECT id FROM resume_versions WHERE project_id = ? LIMIT 1', [ctx.project.id])) {
            const action = db.get('SELECT * FROM ai_action_requests WHERE id = ?', [rewrite.id]);
            const change = applyRewriteAndSaveFirst({ ctx: { ...ctx, draft: liveDraft }, user, action, requestId, ipHash });
            settleTaskAfterAction(action);
            rewrite.status = 'applied';
            proposals.initialVersionId = change.version_id;
          }
          return proposals;
        });
      } catch (error) {
        const failureMessageId = db.tx(() => persistTaskFailure({
          ctx,
          user,
          task,
          scopeType,
          scopeId,
          scopeRevision,
          userMessageId,
          error,
          runId,
        }));
        if (error && typeof error === 'object') {
          error.extra = {
            ...(error.extra || {}),
            task_id: task.id,
            persisted_message_id: failureMessageId,
          };
        }
        throw error;
      } finally {
        running.finish();
        // Failed/canceled crops have no persistent document reference. Successful
        // proposals and all undo/version/reapply payloads are protected by the
        // authoritative reference scan; never unlink assets during an active run.
        try { require('../lib/document-assets').collectUnusedAssets(user.id, { graceMs: 0 }); }
        catch (_) { /* retain objects and retry cleanup on the next safe turn */ }
      }
      const liveConversation = db.get(
        "SELECT id FROM ai_conversations WHERE id = ? AND owner_id = ? AND status = 'active'",
        [ctx.conversation.id, user.id],
      );
      if (!liveConversation) {
        throw problem.conflict('CONVERSATION_ENDED', '当前对话已结束，请在新对话中重新发送');
      }
      compactGlobalHistory(db.getDb(), user.id);
      audit.log({
        ownerId: user.id,
        action: 'ai_message_processed',
        resourceType: 'ai_message',
        resourceId: applied.assistantMessageId,
        requestId,
        ipHash,
        metadata: {
          scope_type: scopeType,
          proposed: applied.executed.map((item) => item.action_type),
          rejected: applied.rejected.map((item) => item.reason),
          repair_count: result.repair_count || 0,
          output_budget: result.output_budget,
          finish_reason: result.finish_reason || null,
          model_route: result.model_route || null,
          routing_reason: result.routing_reason || null,
        },
      });
      return {
        message: toMessageView(db.get('SELECT * FROM ai_messages WHERE id = ?', [userMessageId])),
        reply: toMessageView(db.get('SELECT * FROM ai_messages WHERE id = ?', [applied.assistantMessageId])),
        reply_text: applied.finalReply,
        actions: applied.executed,
        rejected: applied.rejected,
        scope: { type: scopeType, id: scopeId, label: SCOPE_LABEL[scopeType] || '', revision: scopeRevision },
        conversation_id: ctx.conversation.id,
        policy_version: POLICY_VERSION,
        prompt_version: result.prompt_version,
        engine: {
          provider: result.provider,
          model: result.model,
          route: result.model_route || null,
        },
        task_id: task.id,
        result_type: result.response.result_type,
        type: result.response.type,
        awaiting_user: Boolean(result.response.awaiting_user),
        quick_replies: result.response.quick_replies || [],
        clarification: result.response.clarification || null,
        plan: result.response.plan || null,
        saved: false,
        initial_version_id: applied.initialVersionId || null,
      };
    },
  },
  {
    method: 'GET',
    pattern: '/ai/actions/:id/preview',
    handler: ({ params, user }) => {
      const { ctx, current, target } = loadProposalPreview(params.id, user);
      return { current_resume_document: current, target_resume_document: target, preview_revision: ctx.draft.revision,
        change_preview: buildChangePreview(current, target) };
    },
  },
  {
    method: 'GET',
    pattern: '/ai/actions/:id/preview/download',
    raw: true,
    handler: async ({ params, query, user, res }) => {
      const { ctx, target } = loadProposalPreview(params.id, user);
      if (query.get('revision') === null || Number(query.get('revision')) !== ctx.draft.revision) {
        throw problem.conflict('PREVIEW_OUTDATED', '正文已变化，请重新预览后再导出');
      }
      const format = query.get('format');
      if (!['pdf', 'docx'].includes(format)) throw problem.badRequest('支持 PDF 和 Word 下载');
      const render = format === 'pdf' ? require('../lib/render/pdf').renderPdfAsync : require('../lib/render/docx').renderDocxAsync;
      const buffer = (await render({ resume: target, template: {}, ownerId: user.id })).buffer;
      if (loadProposalPreview(params.id, user).ctx.draft.revision !== ctx.draft.revision) {
        throw problem.conflict('PREVIEW_OUTDATED', '正文已变化，请重新预览后再导出');
      }
      const name = require('./artifacts').safeFileName(ctx.project.name + '-建议', format);
      res.writeHead(200, {
        'content-type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-length': buffer.length, 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      });
      res.end(buffer);
      return { __handled: true };
    },
  },
  {
    method: 'POST',
    pattern: '/ai/actions/:id/reapply',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'ai_action_confirm', () => db.tx(() => {
        const action = db.get('SELECT * FROM ai_action_requests WHERE id = ? AND owner_id = ?', [params.id, user.id]);
        if (!action || action.action_type !== 'RESUME_REWRITE_PROPOSAL') throw problem.notFound('建议不存在');
        if (!['applied', 'reverted'].includes(action.status)) throw problem.conflict('PROPOSAL_NOT_APPLIED', '请使用这条建议的应用修改入口');
        const conversation = db.get('SELECT * FROM ai_conversations WHERE id = ? AND owner_id = ?', [action.conversation_id, user.id]);
        if (!conversation || conversation.status === 'closed') throw problem.notFound('对话已结束');
        const running = db.get(`SELECT id FROM ai_tasks WHERE conversation_id = ?
          AND status IN ('understanding','planning','validated')`, [conversation.id]);
        if (running) throw problem.conflict('AI_REQUEST_RUNNING', '请等当前生成完成后再应用');
        const ctx = loadContext(conversation.project_id, user, { conversationId: conversation.id });
        if (body.preview_revision !== undefined && body.preview_revision !== ctx.draft.revision) {
          throw problem.conflict('PREVIEW_OUTDATED', '正文已变化，请重新预览后再应用');
        }
        if (body.expected_revision !== ctx.draft.revision) throw problem.conflict('REVISION_CONFLICT', '正文已变化，请刷新后再次应用');
        const stored = parseJson(action.payload_json, {});
        const original = stored.proposal || stored;
        const pair = readReapply(original);
        if (!pair) throw problem.conflict('PROPOSAL_MATERIAL_EXPIRED', '这条旧建议的完整排版已清理，请根据当前简历重新生成');
        // Reuse the same merge, policy, audit and five-step transaction path,
        // but do not settle/replace any ongoing conversation task.
        const replay = { ...original, base_resume_json: pair.base,
          target_resume_document: pair.target, merge_strategy: 'three_way_target_document', task_id: null };
        const result = applyRewriteProposal({ user, project: ctx.project, draft: ctx.draft,
          action: { ...action, payload_json: JSON.stringify({ proposal: replay }) }, requestId, ipHash });
        db.run('UPDATE ai_action_requests SET payload_json = ? WHERE id = ?', [action.payload_json, action.id]);
        return { id: action.id, status: 'applied', reapplied: true, ...result };
      })),
  },
  {
    method: 'POST',
    pattern: '/ai/actions/:id/apply',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'ai_action_confirm', () => {
        const action = db.get('SELECT * FROM ai_action_requests WHERE id = ? AND owner_id = ?', [
          params.id,
          user.id,
        ]);
        if (!action) throw problem.notFound('动作不存在');
        if (['applied', 'rejected', 'reverted'].includes(action.status)) {
          return { id: action.id, status: action.status, idempotent_replay: true };
        }
        if (['stale', 'superseded'].includes(action.status)) {
          throw problem.conflict(
            'PROPOSAL_SUPERSEDED',
            action.status === 'stale'
              ? '这项建议已无法基于当前草稿应用，请重新生成'
              : '这条建议已有新版，请应用最新建议',
          );
        }
        const conversation = db.get('SELECT * FROM ai_conversations WHERE id = ?', [action.conversation_id]);
        if (!conversation) throw problem.notFound('对话不存在');
        const ctx = loadContext(conversation.project_id, user, {
          conversationId: conversation.id,
        });
        if (body.preview_revision !== undefined && body.preview_revision !== ctx.draft.revision) {
          throw problem.conflict('PREVIEW_OUTDATED', '正文已变化，请重新预览后再应用');
        }
        const actionPayload = parseJson(action.payload_json, {});
        const rewriteProposal = actionPayload.proposal || actionPayload;
        const isBlockRewrite = action.action_type === 'RESUME_REWRITE_PROPOSAL'
          && rewriteProposal.scope_type === 'RESUME_BLOCK';
        const isDocumentOperationRewrite = action.action_type === 'RESUME_REWRITE_PROPOSAL'
          && rewriteProposal.scope_type === 'RESUME_DOCUMENT'
          && Array.isArray(rewriteProposal.operations)
          && rewriteProposal.operations.length > 0;
        const isTargetDocumentRewrite = action.action_type === 'RESUME_REWRITE_PROPOSAL'
          && rewriteProposal.merge_strategy === 'three_way_target_document'
          && rewriteProposal.base_resume_json
          && rewriteProposal.target_resume_document;
        if (
          !isBlockRewrite
          && !isDocumentOperationRewrite
          && !isTargetDocumentRewrite
          && action.expected_revision !== null
          && action.expected_revision !== undefined
        ) {
          const currentRevision = action.action_type === 'RESUME_REWRITE_PROPOSAL'
            ? ctx.draft.revision
            : action.action_type === 'PROFILE_SAVE_PROPOSAL'
              ? ctx.profile.revision
              : ctx.project.revision;
          if (action.expected_revision !== currentRevision) {
            throw problem.conflict('REVISION_CONFLICT', '内容已经变化，请重新确认', {
              expected: action.expected_revision,
              current: currentRevision,
            });
          }
        }
        let result;
        if (action.action_type === 'RESUME_REWRITE_PROPOSAL') {
          const payload = parseJson(action.payload_json, {});
          const taskId = payload.task_id || (payload.proposal && payload.proposal.task_id);
          const task = taskId
            ? db.get('SELECT * FROM ai_tasks WHERE id = ? AND owner_id = ?', [taskId, user.id])
            : null;
          if (!task || task.active_proposal_id !== action.id) {
            throw problem.conflict('PROPOSAL_SUPERSEDED', '这条建议已有新版，请应用最新建议');
          }
          if (task.status !== 'waiting_apply') {
            throw problem.conflict(
              'PROPOSAL_BEING_REFINED',
              '这条建议正在继续调整，请完成当前沟通后应用最新建议',
            );
          }
          result = applyRewriteAndSaveFirst({ ctx, user, action, requestId, ipHash });
        } else if (action.action_type === 'PROFILE_SAVE_PROPOSAL') {
          result = applyProfileSave({ action, ctx, user, requestId, ipHash });
        } else if (action.action_type === 'JOB_SET_CURRENT_PROPOSAL') {
          result = applyCurrentJob({ action, ctx, user, requestId, ipHash });
        } else {
          throw problem.conflict('ACTION_NOT_CONFIRMABLE', '该动作不支持确认');
        }
        settleTaskAfterAction(action);
        compactGlobalHistory(db.getDb(), user.id);
        return { id: action.id, status: 'applied', ...result };
      }),
  },
  {
    method: 'POST',
    pattern: '/ai/actions/:id/reject',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'ai_action_reject', () => {
        const action = db.get('SELECT * FROM ai_action_requests WHERE id = ? AND owner_id = ?', [
          params.id,
          user.id,
        ]);
        if (!action) throw problem.notFound('动作不存在');
        if (['rejected', 'applied', 'reverted'].includes(action.status)) {
          return { id: action.id, status: action.status, idempotent_replay: true };
        }
        db.run("UPDATE ai_action_requests SET status = 'rejected', rejected_at = ? WHERE id = ?", [
          nowIso(),
          action.id,
        ]);
        const payload = parseJson(action.payload_json, {});
        if (action.action_type === 'RESUME_REWRITE_PROPOSAL' && payload.task_id) {
          db.run(
            `UPDATE ai_tasks SET active_proposal_id = NULL, status = 'active', updated_at = ?
             WHERE id = ? AND active_proposal_id = ?`,
            [nowIso(), payload.task_id, action.id],
          );
        }
        settleTaskAfterAction(action);
        compactGlobalHistory(db.getDb(), user.id);
        audit.log({
          ownerId: user.id,
          action: 'ai_action_rejected',
          resourceType: 'ai_action_request',
          resourceId: action.id,
          requestId,
          ipHash,
          metadata: { action_type: action.action_type, reason: body.reason || '' },
        });
        return { id: action.id, status: 'rejected', data_unchanged: true };
      }),
  },
  {
    method: 'POST',
    pattern: '/ai/actions/:id/revert',
    handler: ({ params, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'ai_action_revert', () =>
        policy.revertAction({ user, actionRequestId: params.id, requestId, ipHash }),
      ),
  },
  {
    method: 'POST',
    pattern: '/projects/:id/ai/conversations',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'ai_conversation_start', () =>
        startNewConversation({
          projectId: params.id,
          user,
          requestId,
          ipHash,
          previousConversationId: body.conversation_id || null,
        }),
      ),
  },
  {
    method: 'DELETE',
    pattern: '/projects/:id/ai/messages',
    handler: ({ params, body, user, requestId, ipHash }) =>
      startNewConversation({
        projectId: params.id,
        user,
        requestId,
        ipHash,
        previousConversationId: body.conversation_id || null,
      }),
  },
];

// 兼容迁移前客户端；新代码统一使用 TECH v1.3 的 /apply。
routes.push({
  ...routes.find((route) => route.pattern === '/ai/actions/:id/apply'),
  pattern: '/ai/actions/:id/confirm',
});

module.exports = {
  routes,
  findResumeNodeInDraft,
  normalizeRewriteProposal,
  startNewConversation,
};
