'use strict';

const ResumeDom = require('../../../resume-dom');
const { evaluateChange } = require('../resume-change-policy');

const FLOW_CONFIRMATION_REQUIRED = 'FLOW_CONFIRMATION_REQUIRED';

function taskState(input) {
  return input
    && input.request
    && input.request.task
    && input.request.task.state
    && typeof input.request.task.state === 'object'
    ? input.request.task.state
    : {};
}

function hasHandledPlanConfirmation(input) {
  const state = taskState(input);
  if (state.confirmed_plan) return true;
  const answered = state.answered_message;
  return Boolean(
    answered
    && (
      answered.message_kind === 'plan_confirmation'
      || answered.kind === 'plan_confirmation'
    )
  );
}

function proposalOf(action) {
  return (action && action.payload && action.payload.proposal)
    || (action && action.payload)
    || {};
}

function isMixedContentStructureChange(result) {
  if (
    !result
    || result.dimensions.content !== 'modified'
    || result.dimensions.structure !== 'modified'
  ) return false;
  const counts = result.comparison && result.comparison.counts || {};
  const pureDeletion = (
    Number(counts.removed || 0) > 0
    && Number(counts.added || 0) === 0
    && Number(counts.text || 0) === 0
    && Number(counts.moved || 0) === 0
    && Number(counts.structure || 0) === 0
  );
  const pureInsertion = (
    Number(counts.added || 0) > 0
    && Number(counts.removed || 0) === 0
    && Number(counts.text || 0) === 0
    && Number(counts.moved || 0) === 0
    && Number(counts.structure || 0) === 0
  );
  if (pureDeletion || pureInsertion) return false;
  return (
    Number(counts.text || 0) > 0
    || Number(counts.structure || 0) > 0
    || (
      Number(counts.added || 0) > 0
      && Number(counts.removed || 0) > 0
    )
  );
}

function flowConfirmationErrors(response, input) {
  if (
    !response
    || response.result_type !== 'PROPOSAL'
    || hasHandledPlanConfirmation(input)
  ) return [];
  const resume = input && input.workspace && input.workspace.resume || {};
  const before = ResumeDom.toResumeDocument(
    resume.proposal_content || resume.content || {},
  );
  const errors = [];
  (response.actions || []).forEach((action, index) => {
    if (!action || action.type !== 'RESUME_REWRITE_PROPOSAL') return;
    const proposal = proposalOf(action);
    if (!proposal.target_resume_document || !proposal.change_constraints) return;
    const result = evaluateChange(
      before,
      proposal.target_resume_document,
      proposal.change_constraints,
    );
    if (isMixedContentStructureChange(result)) {
      errors.push(
        `${FLOW_CONFIRMATION_REQUIRED}: actions[${index}] 同时改写文字和调整结构，必须先用自然语言简要确认处理思路`,
      );
    }
  });
  return errors;
}

function isFlowConfirmationError(message) {
  return String(message || '').startsWith(`${FLOW_CONFIRMATION_REQUIRED}:`);
}

function onlyFlowConfirmationErrors(errors) {
  return Boolean(
    Array.isArray(errors)
    && errors.length
    && errors.every(isFlowConfirmationError)
  );
}

function fallbackPlanMessage(response, input) {
  const scoped = input && input.scope && input.scope.type === 'RESUME_DOCUMENT'
    ? '整份简历中的相关内容'
    : '当前选中的内容';
  const result = {
    ...response,
    type: 'message',
    result_type: 'MESSAGE',
    content: [
      '我准备这样修改：',
      `1. 结合整份简历核对${scoped}的上下文`,
      '2. 同时调整文字表达和段落结构',
      '3. 保留未涉及的信息与样式',
      '确认后我会生成一版可应用的完整结果。',
    ].join('\n'),
    awaiting_user: true,
    quick_replies: [
      { id: 'confirm-plan', label: '按这个思路修改' },
      { id: 'adjust-plan', label: '调整要求' },
    ],
    actions: [],
    message_kind: 'plan_confirmation',
    flow_plan: {
      content: 'modify',
      structure: 'modify',
      scope_type: input && input.scope && input.scope.type || null,
      scope_id: input && input.scope && input.scope.id || null,
    },
  };
  result.reply = result.content;
  delete result.proposal;
  return result;
}

module.exports = {
  FLOW_CONFIRMATION_REQUIRED,
  flowConfirmationErrors,
  hasHandledPlanConfirmation,
  isFlowConfirmationError,
  onlyFlowConfirmationErrors,
  fallbackPlanMessage,
};
