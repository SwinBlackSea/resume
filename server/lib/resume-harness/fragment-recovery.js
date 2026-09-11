'use strict';

const ResumeDom = require('../../../resume-dom');
const { deepClone, hashJson } = require('../util');

function proposalOf(action) {
  return action && action.payload && (action.payload.proposal || action.payload);
}

// This is protocol repair, not intent inference. Independent units from the
// original proposal are immutable during recovery; the model resolves conflicts.
function buildFragmentRecovery(response, input, diagnostics) {
  if (!diagnostics.length || diagnostics.some((item) => item.code !== 'TARGET_FRAGMENT_OVERLAP')) {
    return null;
  }
  const actions = response.actions || [];
  if (actions.length !== 1 || actions[0].type !== 'RESUME_REWRITE_PROPOSAL') return null;
  const proposal = proposalOf(actions[0]);
  const fragments = proposal && proposal.target_resume_fragments;
  if (!fragments || fragments.format !== 'resume-target-fragments-v2'
    || !Array.isArray(fragments.changes)) return null;
  const base = ResumeDom.toResumeDocument(
    input.workspace.resume.proposal_content || input.workspace.resume.content,
  );
  const paths = new Map();
  function visit(node, ancestors) {
    paths.set(node.id, ancestors);
    (node.children || []).forEach((child) => visit(child, [...ancestors, node.id]));
  }
  visit(base.root, []);
  const contains = (ancestor, descendant) => ancestor === descendant
    || (paths.get(descendant) || []).includes(ancestor);
  const related = (a, b) => contains(a, b) || contains(b, a);
  const conflicts = [];
  const conflictIds = new Set();
  for (const change of fragments.changes) {
    for (const other of fragments.changes) {
      if (change !== other && contains(change.target_id, other.target_id)) {
        conflicts.push({
          ancestor_target_id: change.target_id,
          descendant_target_id: other.target_id,
          ancestor_operation: change.replacement_subtree === null ? 'delete' : 'replace',
          descendant_operation: other.replacement_subtree === null ? 'delete' : 'replace',
        });
        conflictIds.add(change.target_id);
        conflictIds.add(other.target_id);
      }
    }
  }
  // Insertion conflicts have their own semantics; do not guess a new anchor.
  if (!conflicts.length) return null;
  const protectedChanges = fragments.changes.filter((change) =>
    ![...conflictIds].some((id) => related(id, change.target_id)));
  const protectedInsertions = (fragments.insertions || []).filter((insertion) =>
    ![...conflictIds].some((id) => related(id, insertion.parent_id)
      || (insertion.after_id && related(id, insertion.after_id))));
  return {
    conflicts,
    protectedChanges: deepClone(protectedChanges),
    protectedInsertions: deepClone(protectedInsertions),
    actionType: actions[0].type,
  };
}

function recoveryContext(recovery) {
  if (!recovery) return '';
  return [
    '本次使用局部协议恢复：只解决冲突，不重做已经互不冲突的修改。',
    '下列冲突关系由真实文档计算。删除祖先与修改后代不能并存；根据原始用户要求和已确认思路决定最终保留区域，不得把内部编排问题抛给用户。',
    JSON.stringify({
      conflicts: recovery.conflicts,
      preserved_target_ids: recovery.protectedChanges.map((change) => change.target_id),
      preserved_insertions: recovery.protectedInsertions.map(({ parent_id, after_id }) => ({
        parent_id, after_id,
      })),
    }),
    '仍返回一个proposal，用当前严格Schema的resume_proposal.changes/insertions表达修正部分（内部转换为resume-target-fragments-v2）。上述preserved修改由服务端原样合并，无须重复，不得覆盖或撤销。',
    'change_constraints 和用户可见说明必须涵盖合并后的全部修改；不得仅为通过校验缩小已确认的任务。',
  ].join('\n');
}

function restoreIndependentFragments(response, recovery) {
  if (!recovery) return [];
  const actions = response.actions || [];
  const proposal = actions.length === 1 && proposalOf(actions[0]);
  const fragments = proposal && proposal.target_resume_fragments;
  if (response.result_type !== 'PROPOSAL' || actions[0]?.type !== recovery.actionType
    || !fragments || fragments.format !== 'resume-target-fragments-v2'
    || !Array.isArray(fragments.changes) || proposal.target_resume_document) {
    return ['局部协议恢复必须返回目标片段，不得丢弃原建议中互不冲突的修改'];
  }
  const protectedById = new Map(recovery.protectedChanges.map((change) => [change.target_id, change]));
  for (const change of fragments.changes) {
    const previous = protectedById.get(change.target_id);
    if (previous && hashJson(previous) !== hashJson(change)) {
      return [`局部协议恢复不能改写已保留的修改：${change.target_id}`];
    }
  }
  const key = (insertion) => JSON.stringify([insertion.parent_id, insertion.after_id]);
  const protectedInsertions = new Map(recovery.protectedInsertions.map((item) => [key(item), item]));
  for (const insertion of fragments.insertions || []) {
    const previous = protectedInsertions.get(key(insertion));
    if (previous && hashJson(previous) !== hashJson(insertion)) {
      return ['局部协议恢复不能改写已保留的新增内容'];
    }
  }
  fragments.changes = [
    ...deepClone(recovery.protectedChanges),
    ...fragments.changes.filter((change) => !protectedById.has(change.target_id)),
  ];
  fragments.insertions = [
    ...deepClone(recovery.protectedInsertions),
    ...(fragments.insertions || []).filter((item) => !protectedInsertions.has(key(item))),
  ];
  return [];
}

module.exports = { buildFragmentRecovery, recoveryContext, restoreIndependentFragments };
