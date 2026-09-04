'use strict';
/**
 * 根据建议在最新文档上是否仍可执行刷新过期状态。
 */
const ResumeDom = require('../../resume-dom');
const { validateOperationPreconditions } = require('./resume-operation-preconditions');

function parseJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch (_) {
    return {};
  }
}

function proposalIsStillValid(row, resume, revision) {
  const stored = parseJson(row.payload_json);
  const proposal = stored.proposal || stored;
  if (
    proposal.merge_strategy === 'three_way_target_document'
    && proposal.base_resume_json
    && proposal.target_resume_document
  ) {
    // 新协议在用户点击应用时基于 A/B/C 做三方合并。普通文字或无关区域变化
    // 不应提前把建议标成 stale；真正无法合并时由应用阶段给出重新生成入口。
    return true;
  }
  if (Array.isArray(proposal.operations) && proposal.operations.length) {
    if (proposal.operation_preconditions) {
      return validateOperationPreconditions(resume, proposal.operation_preconditions).valid;
    }
    try {
      ResumeDom.applyDocumentOperations(resume, proposal.operations, { allowStructure: true });
      return true;
    } catch (_) {
      return false;
    }
  }
  if (proposal.scope_type === 'RESUME_BLOCK') {
    return Boolean(ResumeDom.findNode(resume, proposal.scope_id));
  }
  return proposal.base_draft_revision === revision;
}

function refreshResumeProposalStaleness(
  database,
  projectId,
  userId,
  { resume, revision, excludeActionId = null, forceAll = false } = {},
) {
  const document = ResumeDom.toResumeDocument(resume || {});
  const rows = database.all(
    `SELECT action.*
     FROM ai_action_requests action
     JOIN ai_conversations conversation ON conversation.id = action.conversation_id
     WHERE action.owner_id = ?
       AND conversation.project_id = ?
       AND conversation.owner_id = ?
       AND action.action_type = 'RESUME_REWRITE_PROPOSAL'
       AND action.status IN ('proposed','awaiting_confirmation')`,
    [userId, projectId, userId],
  );
  rows.forEach((row) => {
    if (excludeActionId && row.id === excludeActionId) return;
    if (forceAll || !proposalIsStillValid(row, document, revision)) {
      database.run("UPDATE ai_action_requests SET status = 'stale' WHERE id = ?", [row.id]);
    }
  });
}

module.exports = { proposalIsStillValid, refreshResumeProposalStaleness };
