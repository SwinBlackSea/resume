'use strict';

const ResumeDom = require('../../../resume-dom');
const { buildConversationMemory } = require('./memory-manager');
const { SYSTEM_PROMPT } = require('./prompt');
const { documentRenderCss } = require('./render-style-context');
const {
  MODEL_CONVERSATION_PROTOCOL,
  buildConversationMessages,
} = require('./conversation-protocol');

function cleanObject(value) {
  if (Array.isArray(value)) return value.map(cleanObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, cleanObject(entry)]),
  );
}

function buildHarnessInput(options) {
  const {
    text,
    messageId,
    scope,
    task,
    profile,
    resume,
    job,
    focus,
    conversationMessages,
    conversationSummary,
    attachments,
    memoryOptions,
  } = options;

  const memory = buildConversationMemory({
    messages: conversationMessages || [],
    summary: conversationSummary,
    cache: task && task.state && task.state.conversation_memory,
    options: memoryOptions,
  });
  const lockedFocus = {
    scope,
    current_text: String((focus && focus.current_text) || ''),
    editing_base: String((focus && focus.editing_base) || ''),
    scope_region: (focus && focus.scope_region) || null,
    location: (focus && focus.location) || null,
    neighboring_content: (focus && focus.neighboring_content) || [],
  };

  const structured = cleanObject({
    request: {
      text: String(text || ''),
      message_id: messageId || null,
      task: task || null,
    },
    workspace: {
      profile: profile || {},
      target_job: job || null,
      resume: resume || {},
      ...(options.materials ? { materials: options.materials } : {}),
    },
    focus: lockedFocus,
    conversation: memory,
  });

  return {
    ...structured,
    attachments: attachments || [],
    image_history: options.imageHistory || [],
    // 兼容动作执行层读取，语义判断只使用上面的结构化对象。
    text: structured.request.text,
    messageId: structured.request.message_id,
    scope,
    currentText: lockedFocus.current_text,
    editingBase: lockedFocus.editing_base,
    targetText: lockedFocus.editing_base,
    userProvidedTexts: [
      JSON.stringify(structured.workspace.profile || {}),
      JSON.stringify(structured.workspace.resume || {}),
      structured.request.text,
      ...(memory.recent_messages || [])
        .filter((item) => item.role === 'user')
        .map((item) => item.content),
    ],
    resumeText: JSON.stringify(structured.workspace.resume),
    jobText: structured.workspace.target_job
      ? String(structured.workspace.target_job.confirmed_text || '')
      : '',
    profileBasics: structured.workspace.profile.basics || {},
    profileRevision: structured.workspace.profile.revision,
    history: memory.recent_messages,
    taskSummary: task && task.goal ? task.goal : structured.request.text,
  };
}

function compactResumeForModel(resumeValue) {
  const resume = resumeValue && typeof resumeValue === 'object' ? resumeValue : {};
  const result = {
    revision: resume.revision,
  };
  const previousTarget = resume.previous_target_document || resume.proposal_content;
  const project = (document) => document && typeof document === 'object'
    ? ResumeDom.toAiContextDocument(document, { includePresentation: true }) : document;
  if (previousTarget) result.current_draft_reference = project(resume.content);
  const taskBaseMatchesCurrent = Boolean(
    resume.task_base_hash
    && resume.content_hash
    && resume.task_base_hash === resume.content_hash
  );
  if (resume.task_base_content && typeof resume.task_base_content === 'object') {
    if (taskBaseMatchesCurrent) result.task_baseline_equals_current_draft = true;
    else result.task_baseline_reference = project(resume.task_base_content);
  }
  result.editing_document_role = previousTarget ? 'previous_target_document' : 'current_draft';
  // References precede the unique operative document; A/C are not patch targets.
  result.editing_document = project(previousTarget || resume.content);
  return result;
}

function compactTaskForModel(task) {
  if (!task || typeof task !== 'object') return null;
  const state = task.state && typeof task.state === 'object' ? task.state : {};
  // Dialogue already contains tentative plans and answers. Avoid duplicating
  // assistant suggestions or internal process flags in system-level context.
  const compactState = state.confirmed_plan ? { confirmed_plan: state.confirmed_plan } : {};
  return cleanObject({
    id: task.id,
    goal: task.goal,
    status: task.status,
    state: compactState,
  });
}

function buildMessages(input) {
  const modelWorkspace = {
    ...input.workspace,
    resume: compactResumeForModel(input.workspace && input.workspace.resume),
  };
  const readonlyContext = {
    protocol: MODEL_CONVERSATION_PROTOCOL,
    scope: input.scope,
    workspace: modelWorkspace,
    render_defaults_css: documentRenderCss([
      modelWorkspace.resume.editing_document,
      modelWorkspace.resume.current_draft_reference,
      modelWorkspace.resume.task_baseline_reference,
    ]),
    task: compactTaskForModel(input.request && input.request.task),
    focus: input.focus,
    conversation_summary: input.conversation.summary,
    resume_document_contract: {
      context_format: ResumeDom.AI_PRESENTATION_CONTEXT_VERSION,
      parent_child_relation: 'children',
      presentation_fields_omitted: false,
      binary_resources_omitted: true,
      existing_fragment_fields_omitted: 'inherit_from_base_document',
      response_scope: 'minimum_changed_subtrees_only',
    },
  };
  return buildConversationMessages({
    systemPrompt: SYSTEM_PROMPT,
    mode: 'global_tree',
    context: readonlyContext,
    history: input.conversation.recent_messages,
    userText: input.request && input.request.text,
    attachments: input.attachments,
    imageHistory: input.image_history,
  });
}

module.exports = {
  buildHarnessInput,
  buildMessages,
  compactResumeForModel,
  compactTaskForModel,
};
