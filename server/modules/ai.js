'use strict';
/**
 * AI 对话与动作执行。
 *
 * 模型拥有完整工作区和当前会话上下文，但不能直接写业务数据。它只能提出三类动作：
 * 保存到资料、设置当前岗位、应用简历修改。三类动作互相独立，均需用户操作。
 */
const { createHash } = require('node:crypto');
const db = require('../lib/db');
const { uuidv7, nowIso, problem, deepClone } = require('../lib/util');
const audit = require('../lib/audit');
const policy = require('../lib/policy');
const resumeHarness = require('../lib/resume-harness');
const { getObject } = require('../lib/storage');
const { diffWords } = require('../lib/polish');
const { keyTokens } = require('../lib/resume-schema');
const { withIdempotency } = require('../lib/idempotency');
const queue = require('../lib/queue');
const { SCOPE_LABEL } = require('../lib/policy');
const { toActionView, toMessageView } = require('./workspace');
const ResumeDom = require('../../resume-dom');

const POLICY_VERSION = policy.POLICY_VERSION;

function parseJson(raw, fallback = {}) {
  try {
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch (_) {
    return deepClone(fallback);
  }
}

function textHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function loadContext(projectId, user) {
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
  let conversation = db.get(
    "SELECT * FROM ai_conversations WHERE project_id = ? AND owner_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1",
    [project.id, user.id],
  );
  if (!conversation) {
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

function startNewConversation({ projectId, user, requestId, ipHash }) {
  return db.tx(() => {
    const ctx = loadContext(projectId, user);
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
    };
  });
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
    const found = findResumeNodeInDraft(
      parseJson(ctx.draft && ctx.draft.resume_json, {}),
      scopeId,
    );
    if (!found) throw problem.badRequest('所选简历内容不存在，请重新选择');
    if (found.node.type !== 'text' && !found.node.editable) {
      throw problem.badRequest('所选简历节点不可直接修改');
    }
    return { scopeId, currentText: found.text, found };
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

function resolveTask({ ctx, user, body, scopeType, scopeId, content }) {
  let task = null;
  if (body.task_id) {
    task = db.get(
      `SELECT * FROM ai_tasks
       WHERE id = ? AND conversation_id = ? AND project_id = ? AND owner_id = ?`,
      [body.task_id, ctx.conversation.id, ctx.project.id, user.id],
    );
    if (!task) throw problem.badRequest('当前 AI 任务不存在，请重新发起');
    if (task.scope_type !== scopeType || String(task.scope_id || '') !== String(scopeId || '')) {
      throw problem.conflict('SCOPE_CONFLICT', '当前对话目标已切换，请重新发送');
    }
  }
  if (!task) {
    const id = uuidv7();
    db.run(
      `INSERT INTO ai_tasks
       (id, conversation_id, project_id, owner_id, scope_type, scope_id, goal, state_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        id,
        ctx.conversation.id,
        ctx.project.id,
        user.id,
        scopeType,
        scopeId,
        content.slice(0, 180),
        JSON.stringify({ latest_instruction: content }),
        nowIso(),
        nowIso(),
      ],
    );
    task = db.get('SELECT * FROM ai_tasks WHERE id = ?', [id]);
  } else {
    const state = parseJson(task.state_json, {});
    db.run('UPDATE ai_tasks SET state_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({ ...state, latest_instruction: content }),
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

function collectWorkspaceText({ profile, experiences, resume, job, messages, content }) {
  return [
    JSON.stringify(parseJson(profile && profile.basics_json, {})),
    String((profile && profile.summary) || ''),
    ...(experiences || []).flatMap((item) => [
      item.organization,
      item.title,
      item.description,
    ]),
    JSON.stringify(resume || {}),
    String((job && job.confirmed_text) || ''),
    ...(messages || []).filter((item) => item.role === 'user').map((item) => item.content),
    content,
  ].filter(Boolean);
}

function unsupportedTokens(text, userProvidedTexts) {
  const known = new Set();
  userProvidedTexts.forEach((value) => keyTokens(value).forEach((token) => known.add(token)));
  return Array.from(keyTokens(text)).filter((token) => !known.has(token));
}

function summarizeOperations(operations) {
  const labels = {
    replace_text: '修改内容',
    insert_node: '新增模块或内容',
    remove_node: '删除内容',
    move_node: '调整内容位置',
    set_attributes: '调整节点属性',
    set_style: '调整节点样式',
  };
  return operations.map((operation) => labels[operation.op] || '调整简历结构').join('、');
}

function normalizeRewriteProposal({ action, currentText, editingBase, scopeType, scopeId, draft, task, userTexts }) {
  const raw = (action.payload && action.payload.proposal) || action.payload || {};
  const currentResume = ResumeDom.toResumeDocument(parseJson(draft.resume_json, {}));
  let operations = Array.isArray(raw.operations) ? deepClone(raw.operations) : [];
  let replacementResume = null;
  let suggestion = String(raw.suggestion || '').trim();

  if (scopeType === 'RESUME_BLOCK') {
    if (!suggestion) throw problem.unprocessable('INVALID_MODEL_ACTION', '模型没有返回可应用的修改内容');
    operations = [{ op: 'replace_text', node_id: scopeId, text: suggestion }];
    try {
      ResumeDom.applyOperations(currentResume, operations, {
        lockedNodeId: scopeId,
        allowStructure: false,
      });
    } catch (error) {
      throw problem.unprocessable('INVALID_MODEL_ACTION', error.message);
    }
  } else if (operations.length) {
    try {
      ResumeDom.applyOperations(currentResume, operations, { allowStructure: true });
    } catch (error) {
      throw problem.unprocessable('INVALID_MODEL_ACTION', error.message);
    }
    if (!suggestion) suggestion = summarizeOperations(operations);
  } else if (raw.resume_dom && typeof raw.resume_dom === 'object') {
    try {
      replacementResume = ResumeDom.toResumeDocument(raw.resume_dom);
    } catch (error) {
      throw problem.unprocessable('INVALID_MODEL_ACTION', error.message);
    }
    if (!suggestion) suggestion = '更新整份简历的内容与结构';
  } else if (raw.resume_json && typeof raw.resume_json === 'object') {
    replacementResume = ResumeDom.toResumeDocument(raw.resume_json);
    if (!suggestion) suggestion = '更新整份简历的内容与结构';
  } else {
    throw problem.unprocessable('INVALID_MODEL_ACTION', '模型没有返回 DOM 操作或结构化简历');
  }

  const added = unsupportedTokens(
    [suggestion, JSON.stringify(operations), JSON.stringify(replacementResume || {})].join('\n'),
    userTexts,
  );
  if (added.length) {
    throw problem.unprocessable(
      'UNSUPPORTED_ASSERTION',
      `建议中出现了你没有提供的数据：${added.join('、')}`,
    );
  }
  return {
    task_id: task.id,
    scope_type: scopeType,
    scope_id: scopeId,
    scope_label: SCOPE_LABEL[scopeType] || '',
    original: currentText,
    current_text: currentText,
    editing_base: editingBase || currentText,
    suggestion,
    operations,
    resume_json: replacementResume,
    diff: Array.isArray(raw.diff) ? raw.diff : diffWords(currentText, suggestion),
    note: String(raw.note || ''),
    base_target_hash: textHash(currentText),
    base_draft_revision: draft.revision,
  };
}

function loadVisionAttachments(attachmentIds, user) {
  return (attachmentIds || []).map((id) => {
    const upload = db.get('SELECT * FROM uploads WHERE id = ? AND owner_id = ?', [id, user.id]);
    if (!upload) throw problem.notFound('附件不存在');
    if (!String(upload.mime_type || '').startsWith('image/')) {
      throw problem.badRequest('AI 对话附件目前只支持图片');
    }
    return {
      id: upload.id,
      mime_type: upload.mime_type,
      file_name: upload.original_name,
      content_base64: getObject(upload.object_key).toString('base64'),
    };
  });
}

function assembleInput({
  ctx,
  userMessageId,
  content,
  scopeType,
  scopeId,
  scopeRevision,
  task,
  parentProposalId,
  attachments,
}) {
  const resume = ResumeDom.attachDocument(parseJson(ctx.draft && ctx.draft.resume_json, {}));
  const experiences = db.all(
    'SELECT * FROM experiences WHERE profile_id = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC',
    [ctx.profile.id, ctx.profile.owner_id],
  );
  const history = db.all(
    'SELECT role, content, scope_type, scope_id FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC',
    [ctx.conversation.id],
  );
  const locked = validateLockedScope(ctx, scopeType, scopeId);
  let editingBase = locked.currentText;
  let parentProposal = null;
  if (parentProposalId) {
    parentProposal = db.get(
      `SELECT * FROM ai_action_requests
       WHERE id = ? AND conversation_id = ? AND owner_id = ? AND action_type = 'RESUME_REWRITE_PROPOSAL'`,
      [parentProposalId, ctx.conversation.id, ctx.profile.owner_id],
    );
    if (!parentProposal) throw problem.badRequest('上一版建议不存在');
    {
      const previous = parseJson(parentProposal.payload_json, {});
      editingBase = String(((previous.proposal || previous).suggestion) || locked.currentText);
    }
  } else if (task.active_proposal_id) {
    parentProposal = db.get(
      "SELECT * FROM ai_action_requests WHERE id = ? AND owner_id = ? AND action_type = 'RESUME_REWRITE_PROPOSAL'",
      [task.active_proposal_id, user.id],
    );
    if (parentProposal) {
      const previous = parseJson(parentProposal.payload_json, {});
      editingBase = String(((previous.proposal || previous).suggestion) || locked.currentText);
    }
  }
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
    task: { id: task.id, goal: task.goal },
    profile: profileView,
    resume: { revision: ctx.draft.revision, content: resume },
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
    attachments,
  });
  return {
    llmInput,
    currentText: locked.currentText,
    editingBase,
    userTexts: collectWorkspaceText({
      profile: ctx.profile,
      experiences,
      resume,
      job: ctx.job,
      messages: history,
      content,
    }),
  };
}

async function runModel(llmInput, userMessageId) {
  try {
    const result = await resumeHarness.complete(llmInput);
    return {
      ...result,
      validation: policy.validateModelResponse(result.response, { userMessageId }),
    };
  } catch (error) {
    console.error('[resume-harness] failed', error.message);
    throw problem.unprocessable('MODEL_RESPONSE_INVALID', 'AI 本次没有返回可用结果，请重试');
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

function applyActions({
  ctx,
  user,
  response,
  validation,
  provider,
  model,
  promptVersion,
  schemaVersion,
  scopeType,
  scopeId,
  scopeRevision,
  currentText,
  editingBase,
  userTexts,
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
  };
  db.run(
    `INSERT INTO ai_messages
     (id, conversation_id, owner_id, role, content, scope_type, scope_id, scope_revision, model_metadata_json, created_at)
     VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`,
    [
      assistantMessageId,
      ctx.conversation.id,
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
          userTexts,
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
      rejected.push({ action_type: action.type, reason: error.detail || error.message });
    }
  });
  return { assistantMessageId, executed, rejected, finalReply: response.reply };
}

function applyRewriteProposal({ user, project, draft, action, requestId, ipHash }) {
  return db.tx(() => {
    const stored = parseJson(action.payload_json, {});
    const payload = stored.proposal || stored;
    const resume = ResumeDom.toResumeDocument(parseJson(draft.resume_json, {}));
    const before = { resume_json: deepClone(resume) };
    let nextResume;
    if (payload.scope_type === 'RESUME_BLOCK') {
      const found = findResumeNodeInDraft(resume, payload.scope_id);
      if (!found) throw problem.conflict('TARGET_MISSING', '原内容已不存在，请重新生成建议');
      if (textHash(found.text) !== payload.base_target_hash) {
        throw problem.conflict('REVISION_CONFLICT', '这段内容已经变化，请重新生成建议');
      }
      nextResume = ResumeDom.applyDocumentOperations(
        resume,
        payload.operations && payload.operations.length
          ? payload.operations
          : [{ op: 'replace_text', node_id: payload.scope_id, text: payload.suggestion }],
        { lockedNodeId: payload.scope_id, allowStructure: false },
      );
    } else {
      if (payload.operations && payload.operations.length) {
        nextResume = ResumeDom.applyDocumentOperations(resume, payload.operations, {
          allowStructure: true,
        });
      } else if (payload.resume_json && typeof payload.resume_json === 'object') {
        nextResume = ResumeDom.toResumeDocument(payload.resume_json);
      } else {
        throw problem.unprocessable('INVALID_PROPOSAL', '整份简历建议缺少 DOM 操作');
      }
    }
    const after = { resume_json: deepClone(nextResume) };
    const changeType = 'dom_operations';
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
    db.run("UPDATE ai_action_requests SET status = 'applied', applied_at = ? WHERE id = ?", [
      nowIso(),
      action.id,
    ]);
    const taskId = stored.task_id || payload.task_id;
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
    pattern: '/projects/:id/ai/messages',
    handler: ({ params, user }) => {
      const { conversation } = loadContext(params.id, user);
      return {
        conversation_id: conversation.id,
        items: db
          .all('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC', [
            conversation.id,
          ])
          .map(toMessageView),
      };
    },
  },
  {
    method: 'GET',
    pattern: '/projects/:id/ai/actions',
    handler: ({ params, user, query }) => {
      const { conversation } = loadContext(params.id, user);
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
      return { items: rows.map(toActionView) };
    },
  },
  {
    method: 'POST',
    pattern: '/projects/:id/ai/messages',
    handler: async ({ params, body, user, requestId, ipHash }) => {
      const ctx = loadContext(params.id, user);
      const content = String(body.content || '').trim();
      if (!content) throw problem.badRequest('消息内容不能为空');
      const scopeType = body.scope_type || 'RESUME_DOCUMENT';
      const locked = validateLockedScope(ctx, scopeType, body.scope_id || null);
      const scopeId = locked.scopeId;
      const scopeRevision = body.scope_revision !== undefined
        ? body.scope_revision
        : ctx.draft
          ? ctx.draft.revision
          : null;
      const task = resolveTask({ ctx, user, body, scopeType, scopeId, content });
      const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
      const attachments = loadVisionAttachments(attachmentIds, user);
      const userMessageId = uuidv7();
      db.run(
        `INSERT INTO ai_messages
         (id, conversation_id, owner_id, role, content, scope_type, scope_id, scope_revision,
          model_metadata_json, created_at)
         VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
        [
          userMessageId,
          ctx.conversation.id,
          user.id,
          content,
          scopeType,
          scopeId,
          scopeRevision,
          JSON.stringify({ task_id: task.id, attachment_ids: attachmentIds }),
          nowIso(),
        ],
      );
      db.run(
        'UPDATE ai_conversations SET active_scope_type = ?, active_scope_id = ?, updated_at = ? WHERE id = ?',
        [scopeType, scopeId, nowIso(), ctx.conversation.id],
      );
      const assembled = assembleInput({
        ctx,
        userMessageId,
        content,
        scopeType,
        scopeId,
        scopeRevision,
        task,
        parentProposalId: body.parent_proposal_id || null,
        attachments,
      });
      const result = await runModel(assembled.llmInput, userMessageId);
      const liveConversation = db.get(
        "SELECT id FROM ai_conversations WHERE id = ? AND owner_id = ? AND status = 'active'",
        [ctx.conversation.id, user.id],
      );
      if (!liveConversation) {
        throw problem.conflict('CONVERSATION_ENDED', '当前对话已结束，请在新对话中重新发送');
      }
      const applied = applyActions({
        ctx,
        user,
        response: result.response,
        validation: result.validation,
        provider: result.provider,
        model: result.model,
        promptVersion: result.prompt_version,
        schemaVersion: result.schema_version,
        scopeType,
        scopeId,
        scopeRevision,
        currentText: assembled.currentText,
        editingBase: assembled.editingBase,
        userTexts: assembled.userTexts,
        task,
      });
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
        },
      });
      return {
        message: toMessageView(db.get('SELECT * FROM ai_messages WHERE id = ?', [userMessageId])),
        reply: toMessageView(db.get('SELECT * FROM ai_messages WHERE id = ?', [applied.assistantMessageId])),
        reply_text: applied.finalReply,
        actions: applied.executed,
        rejected: applied.rejected,
        scope: { type: scopeType, id: scopeId, label: SCOPE_LABEL[scopeType] || '', revision: scopeRevision },
        policy_version: POLICY_VERSION,
        prompt_version: result.prompt_version,
        engine: { provider: result.provider, model: result.model },
        task_id: task.id,
        saved: false,
      };
    },
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
        const conversation = db.get('SELECT * FROM ai_conversations WHERE id = ?', [action.conversation_id]);
        if (!conversation) throw problem.notFound('对话不存在');
        const ctx = loadContext(conversation.project_id, user);
        if (action.expected_revision !== null && action.expected_revision !== undefined) {
          const currentRevision = action.action_type === 'RESUME_REWRITE_PROPOSAL'
            ? ctx.draft.revision
            : action.action_type === 'PROFILE_SAVE_PROPOSAL'
              ? ctx.profile.revision
              : ctx.project.revision;
          if (body.expected_revision !== undefined && body.expected_revision !== currentRevision) {
            throw problem.conflict('REVISION_CONFLICT', '内容已经变化，请重新确认', {
              expected: body.expected_revision,
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
          result = applyRewriteProposal({
            user,
            project: ctx.project,
            draft: ctx.draft,
            action,
            requestId,
            ipHash,
          });
        } else if (action.action_type === 'PROFILE_SAVE_PROPOSAL') {
          result = applyProfileSave({ action, ctx, user, requestId, ipHash });
        } else if (action.action_type === 'JOB_SET_CURRENT_PROPOSAL') {
          result = applyCurrentJob({ action, ctx, user, requestId, ipHash });
        } else {
          throw problem.conflict('ACTION_NOT_CONFIRMABLE', '该动作不支持确认');
        }
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
    handler: ({ params, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'ai_conversation_start', () =>
        startNewConversation({ projectId: params.id, user, requestId, ipHash }),
      ),
  },
  {
    method: 'DELETE',
    pattern: '/projects/:id/ai/messages',
    handler: ({ params, user, requestId, ipHash }) =>
      startNewConversation({ projectId: params.id, user, requestId, ipHash }),
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
