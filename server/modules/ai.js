'use strict';
/**
 * AI 对话与动作执行。
 *
 * 模型拥有完整工作区和当前会话上下文，但不能直接写业务数据。它只能提出三类动作：
 * 保存到资料、设置当前岗位、应用简历修改。三类动作互相独立，均需用户操作。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, problem, deepClone } = require('../lib/util');
const audit = require('../lib/audit');
const policy = require('../lib/policy');
const resumeHarness = require('../lib/resume-harness');
const { getObject } = require('../lib/storage');
const { diffWords } = require('../lib/polish');
const { keyTokens } = require('../lib/resume-schema');
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
  resolveResumeScope,
} = require('../lib/resume-scope');
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
    if (['completed', 'failed', 'canceled'].includes(task.status)) {
      throw problem.conflict('TASK_ENDED', '上一项 AI 任务已经结束，请重新发送本轮要求');
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
        content.slice(0, 180),
        JSON.stringify({
          phase: 'understanding',
          latest_instruction: content,
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
    turns.push({ role: 'user', content: content.slice(0, 1000) });
    db.run('UPDATE ai_tasks SET state_json = ?, status = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({
        ...state,
        phase: 'understanding',
        latest_instruction: content,
        turns,
        answered_clarification: state.pending_clarification || state.answered_clarification || null,
        confirmed_plan: state.pending_plan || state.confirmed_plan || null,
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

function normalizeRewriteProposal({
  action,
  currentText,
  editingBase,
  scopeType,
  scopeId,
  draft,
  task,
  userTexts,
  proposalBaseResume,
  parentProposal,
}) {
  const raw = (action.payload && action.payload.proposal) || action.payload || {};
  const currentResume = ResumeDom.toResumeDocument(parseJson(draft.resume_json, {}));
  const workingResume = proposalBaseResume
    ? ResumeDom.toResumeDocument(proposalBaseResume)
    : currentResume;
  const previous = parentProposal || null;
  const previousOperations = previous && Array.isArray(previous.operations)
    ? deepClone(previous.operations)
    : [];
  let incrementalOperations = Array.isArray(raw.operations) ? deepClone(raw.operations) : [];
  let operations = [];
  let replacementResume = null;
  let proposalResume = null;
  let incrementalResume = null;
  let suggestion = String(raw.suggestion || '').trim();

  if (scopeType === 'RESUME_BLOCK' && !incrementalOperations.length) {
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
  } else if (raw.resume_dom && typeof raw.resume_dom === 'object') {
    try {
      replacementResume = ResumeDom.toResumeDocument(raw.resume_dom);
    } catch (error) {
      throw problem.unprocessable('INVALID_MODEL_ACTION', error.message);
    }
    incrementalResume = replacementResume;
    if (!suggestion) suggestion = '更新整份简历的内容与结构';
  } else if (raw.resume_json && typeof raw.resume_json === 'object') {
    replacementResume = ResumeDom.toResumeDocument(raw.resume_json);
    incrementalResume = replacementResume;
    if (!suggestion) suggestion = '更新整份简历的内容与结构';
  } else {
    throw problem.unprocessable('INVALID_MODEL_ACTION', '模型没有返回 DOM 操作或结构化简历');
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
      replacementResume: incrementalOperations.length ? null : replacementResume,
      revision: draft.revision,
    });
  } catch (error) {
    throw problem.unprocessable(
      'RESUME_CHANGE_POLICY_VIOLATION',
      error.message,
      { policy_errors: error.policy_errors || [] },
    );
  }

  if (previous) {
    if (previousOperations.length && incrementalOperations.length) {
      operations = previousOperations.concat(incrementalOperations);
    } else if (previous.resume_json && incrementalOperations.length) {
      replacementResume = ResumeDom.applyDocumentOperations(
        ResumeDom.toResumeDocument(previous.resume_json),
        incrementalOperations,
        { allowStructure: true },
      );
    }
  } else {
    operations = incrementalOperations;
  }

  try {
    if (operations.length) {
      proposalResume = ResumeDom.applyDocumentOperations(
        currentResume,
        operations,
        { allowStructure: true },
      );
    } else if (!replacementResume) {
      throw new Error('建议没有形成可应用的文档变化');
    } else {
      proposalResume = replacementResume;
    }
  } catch (error) {
    throw problem.unprocessable('INVALID_MODEL_ACTION', error.message);
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
    currentResume,
    {
      scopeType,
      scopeId,
      scopeRegion: scopeType === 'RESUME_BLOCK'
        ? resolveResumeScope(currentResume, scopeId)
        : null,
    },
  );
  let changePolicy;
  try {
    changePolicy = authorizeChange({
      before: currentResume,
      after: proposalResume,
      constraints: combinedConstraints,
      operations,
      replacementResume,
      revision: draft.revision,
    });
  } catch (error) {
    throw problem.unprocessable(
      'RESUME_CHANGE_POLICY_VIOLATION',
      error.message,
      { policy_errors: error.policy_errors || [] },
    );
  }
  const changePreview = buildChangePreview(currentResume, proposalResume, {
    revision: draft.revision,
    constraints: combinedConstraints,
  });
  if (!suggestion) {
    suggestion = changePreview.after.text || changePreview.summary;
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
    has_parent_proposal: Boolean(previous),
    suggestion,
    summary: changePreview.summary,
    change_preview: changePreview,
    operations,
    resume_json: replacementResume,
    diff: Array.isArray(raw.diff)
      ? raw.diff
      : diffWords(changePreview.before.text, changePreview.after.text),
    note: String(raw.note || ''),
    base_draft_revision: draft.revision,
    change_constraints: latestConstraints,
    change_policy: changePolicy,
    operation_preconditions: operations.length
      ? buildOperationPreconditions(currentResume, operations)
      : null,
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
  const resume = ResumeDom.toResumeDocument(parseJson(ctx.draft && ctx.draft.resume_json, {}));
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
  let parentProposalPayload = null;
  let proposalContent = null;
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
       WHERE id = ? AND owner_id = ? AND action_type = 'RESUME_REWRITE_PROPOSAL'
         AND status IN ('proposed','awaiting_confirmation')`,
      [task.active_proposal_id, user.id],
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
    if (Array.isArray(parentProposalPayload.operations) && parentProposalPayload.operations.length) {
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
      ...(proposalContent
        ? { proposal_content: proposalContent, proposal_id: parentProposal.id }
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
    attachments,
  });
  return {
    llmInput,
    currentText: locked.currentText,
    editingBase,
    proposalBaseResume: proposalContent,
    parentProposal: parentProposalPayload,
    userTexts: collectWorkspaceText({
      profile: ctx.profile,
      experiences,
      resume,
      job: ctx.job,
      messages: history,
      content,
    }).concat(proposalContent ? [JSON.stringify(proposalContent)] : []),
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
    console.error('[resume-harness] failed', error.code || 'UNKNOWN', error.message);
    if (String(error.code || '').startsWith('DEEPSEEK_')) {
      throw problem.unprocessable(
        'MODEL_UNAVAILABLE',
        String(error.code).includes('TIMEOUT')
          ? '模型响应超时，请稍后重试'
          : '模型服务暂时不可用，请稍后重试',
      );
    }
    if (error.code === 'PROPOSAL_NOT_EXECUTABLE') {
      const validationErrors = Array.isArray(error.validation_errors)
        ? error.validation_errors
        : [];
      const detail = validationErrors.some((message) => message.includes('允许调整的简历区域'))
        ? 'AI 建议涉及了本轮未授权的简历区域，系统已阻止。请明确要一起调整的内容后重试'
        : validationErrors.some((message) => message.includes('保留全部原文字'))
          ? 'AI 建议没有完整保留原文字，系统已阻止。请重试或明确是否允许改写内容'
          : 'AI 返回的修改无法安全应用，请重试或换一种方式描述';
      throw problem.unprocessable(
        'PROPOSAL_NOT_EXECUTABLE',
        detail,
        { validation_errors: validationErrors },
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
}) {
  const liveTask = db.get('SELECT * FROM ai_tasks WHERE id = ? AND owner_id = ?', [
    task.id,
    user.id,
  ]);
  if (!liveTask || liveTask.status === 'canceled') return null;
  const detail = String(error && (error.detail || error.message) || 'AI 请求未完成');
  const content = `这次请求没有成功：${detail}`;
  const assistantMessageId = uuidv7();
  db.run(
    `INSERT INTO ai_messages
     (id, conversation_id, owner_id, role, content, scope_type, scope_id, scope_revision,
      model_metadata_json, created_at)
     VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`,
    [
      assistantMessageId,
      ctx.conversation.id,
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
    assistant_turn: content,
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
}

function buildRecoveryClarification(rejected) {
  const reasons = rejected.map((item) => String(item.reason || '')).join('；');
  const needsFacts = /事实|数字|经历|资料|unsupported|未提供|缺少内容/i.test(reasons);
  if (needsFacts) {
    return {
      question: '这次修改涉及尚未明确的信息。你希望我怎样继续？',
      options: [
        {
          id: 'existing_only',
          label: '只用现有内容',
          description: '不新增事实，只重新组织和表达当前简历已有信息。',
        },
        {
          id: 'provide_details',
          label: '我来补充信息',
          description: '你补充具体经历、数字或结果后，我再完成修改。',
        },
      ],
    };
  }
  return {
    question: '为了准确完成这次修改，请确认你更希望保留什么、改变什么：',
    options: [
      {
        id: 'content_only',
        label: '只改文字，保留结构',
        description: '保留现有模块和段落数量，只调整表达。',
      },
      {
        id: 'structure_only',
        label: '只改结构，保留原文',
        description: '调整合并、拆分或顺序，不删减原有文字。',
      },
      {
        id: 'content_and_structure',
        label: '文字和结构一起调整',
        description: '按你的目标同时重写内容并重新组织结构。',
      },
    ],
  };
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
  scopeType,
  scopeId,
  scopeRevision,
  currentText,
  editingBase,
  proposalBaseResume,
  parentProposal,
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
    repair_count: repairCount || 0,
    result_type: response.result_type,
    clarification: response.clarification || null,
    plan: response.plan || null,
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
      rejected.push({ action_type: action.type, reason: error.detail || error.message });
    }
  });
  let finalReply = response.reply;
  if (!executed.length && rejected.length) {
    const clarification = buildRecoveryClarification(rejected);
    response.result_type = 'CLARIFICATION_REQUIRED';
    response.clarification = clarification;
    response.plan = null;
    metadata.result_type = response.result_type;
    metadata.clarification = clarification;
    metadata.plan = null;
    finalReply = clarification.question;
    db.run(
      'UPDATE ai_messages SET content = ?, model_metadata_json = ? WHERE id = ?',
      [finalReply, JSON.stringify(metadata), assistantMessageId],
    );
  }
  if (response.result_type === 'CLARIFICATION_REQUIRED') {
    updateTaskState(task, {
      phase: 'clarifying',
      pending_clarification: response.clarification,
      last_error: null,
      assistant_turn: finalReply,
    }, 'clarifying');
  } else if (response.result_type === 'PLAN_CONFIRMATION_REQUIRED') {
    updateTaskState(task, {
      phase: 'confirming_plan',
      pending_plan: response.plan,
      pending_clarification: null,
      last_error: null,
      assistant_turn: finalReply,
    }, 'confirming_plan');
  } else if (executed.length) {
    updateTaskState(task, {
      phase: 'awaiting_confirmation',
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
    updateTaskState(task, {
      phase: 'completed',
      pending_plan: null,
      pending_clarification: null,
      last_error: null,
      assistant_turn: finalReply,
    }, 'completed');
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
    if (payload.scope_type === 'RESUME_BLOCK') {
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
      operations: appliedOperations,
      replacementResume: appliedOperations.length ? null : payload.resume_json,
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
    payload.change_preview = buildChangePreview(resume, nextResume, {
      revision: draft.revision,
      constraints: payload.change_policy && payload.change_policy.constraints
        || payload.change_constraints,
    });
    payload.summary = payload.change_preview.summary;
    const taskId = stored.task_id || payload.task_id;
    if (!payload.change_preview.changes.length) {
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
      const { conversation, draft } = loadContext(params.id, user);
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
      const { conversation, draft } = loadContext(params.id, user);
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
      let assembled;
      let result;
      try {
        assembled = assembleInput({
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
        updateTaskState(task, { phase: 'planning' }, 'planning');
        result = await runModel(assembled.llmInput, userMessageId);
        updateTaskState(task, { phase: 'validated' }, 'validated');
      } catch (error) {
        const failureMessageId = persistTaskFailure({
          ctx,
          user,
          task,
          scopeType,
          scopeId,
          scopeRevision,
          userMessageId,
          error,
        });
        if (error && typeof error === 'object') {
          error.extra = {
            ...(error.extra || {}),
            task_id: task.id,
            persisted_message_id: failureMessageId,
          };
        }
        throw error;
      }
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
        repairCount: result.repair_count,
        scopeType,
        scopeId,
        scopeRevision,
        currentText: assembled.currentText,
        editingBase: assembled.editingBase,
        proposalBaseResume: assembled.proposalBaseResume,
        parentProposal: assembled.parentProposal,
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
          repair_count: result.repair_count || 0,
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
        result_type: result.response.result_type,
        clarification: result.response.clarification || null,
        plan: result.response.plan || null,
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
        const ctx = loadContext(conversation.project_id, user);
        const actionPayload = parseJson(action.payload_json, {});
        const rewriteProposal = actionPayload.proposal || actionPayload;
        const isBlockRewrite = action.action_type === 'RESUME_REWRITE_PROPOSAL'
          && rewriteProposal.scope_type === 'RESUME_BLOCK';
        const isDocumentOperationRewrite = action.action_type === 'RESUME_REWRITE_PROPOSAL'
          && rewriteProposal.scope_type === 'RESUME_DOCUMENT'
          && Array.isArray(rewriteProposal.operations)
          && rewriteProposal.operations.length > 0;
        if (
          !isBlockRewrite
          && !isDocumentOperationRewrite
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
        settleTaskAfterAction(action);
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
