'use strict';

const { deepClone, hashJson } = require('../util');
const { GLOBAL_RESPONSE_SCHEMA } = require('./output-json-schema');

// Data changes and resume proposals have independent application boundaries.
// Repair only invalid actions; never guess missing content or discard an action.
function buildActionRecovery(response, diagnostics) {
  const actions = response.actions || [];
  if (actions.length < 2 || !diagnostics.length
    || diagnostics.some((item) => !Number.isInteger(item.action_index)
      || item.action_index < 0 || item.action_index >= actions.length)) return null;
  const invalid = new Set(diagnostics.map((item) => item.action_index));
  if (invalid.size === actions.length) return null;
  const pending = actions.map((action, index) => ({ index, action }))
    .filter((item) => invalid.has(item.index));
  // The public protocol has one resume proposal plus independent data actions.
  if (actions.filter((action) => action.type === 'RESUME_REWRITE_PROPOSAL').length > 1
    || actions.some((action) => !['RESUME_REWRITE_PROPOSAL', 'PROFILE_SAVE_PROPOSAL',
      'JOB_SET_CURRENT_PROPOSAL'].includes(action.type))) return null;
  const schema = deepClone(GLOBAL_RESPONSE_SCHEMA);
  schema.name = 'resume_assistant_action_repair_v1';
  const props = schema.schema.properties;
  props.type.enum = ['proposal'];
  props.awaiting_user.enum = [false];
  props.message_kind = { type: 'null' };
  props.quick_replies.maxItems = 0;
  const data = pending.filter(({ action }) => action.type !== 'RESUME_REWRITE_PROPOSAL');
  props.data_actions.minItems = props.data_actions.maxItems = data.length;
  if (data.length) {
    const types = new Set(data.map(({ action }) => action.type));
    props.data_actions.items.anyOf = props.data_actions.items.anyOf
      .filter((item) => types.has(item.properties.type.enum[0]));
  }
  props.resume_proposal = pending.some(({ action }) => action.type === 'RESUME_REWRITE_PROPOSAL')
    ? props.resume_proposal.anyOf[0] : { type: 'null' };
  return { actions: deepClone(actions), pending: deepClone(pending), schema };
}

function actionRecoveryInstruction(recovery, diagnostics) {
  return [
    '本轮只修复动作协议，不重新生成已通过校验的其他动作。最后一条user仍是用户原始要求。',
    '严格使用本次修复Schema：只返回下面失败的动作，保持动作类型及同类动作先后顺序；不得遗漏、撤销或增加动作。',
    '其他动作由系统原样保留，不需要重复输出。content只简短说明整轮建议已准备好，不声称已应用正文或岗位。',
    '岗位动作payload是对象，包含title、company、confirmed_text（非空的完整岗位描述），不是JSON字符串；资料动作payload是{field,value}。',
    '根据原有材料与对话补全失败动作，不编造缺失字段，不改变本轮用户要求。涉及真实缺失而无法修复时不能伪造成功。',
    `失败动作：${JSON.stringify(recovery.pending)}`,
    `诊断：${JSON.stringify(diagnostics)}`,
    `已经保留、不应重做的动作：${JSON.stringify(recovery.actions
      .map((action, index) => ({ index, type: action.type }))
      .filter(({ index }) => !recovery.pending.some((item) => item.index === index)))}`,
  ].join('\n');
}

function restoreIndependentActions(response, recovery) {
  if (!recovery) return [];
  if (response.result_type !== 'PROPOSAL') return ['动作恢复不能丢弃尚未完成的修改要求'];
  const repaired = response.actions || [];
  // Compatibility with clients that repeat the complete batch: accept only
  // byte-equivalent protected units, never silently ignore changed content.
  if (repaired.length === recovery.actions.length) {
    const pendingIds = new Set(recovery.pending.map((item) => item.index));
    for (let index = 0; index < repaired.length; index++) {
      if (repaired[index].type !== recovery.actions[index].type
        || (!pendingIds.has(index) && hashJson(repaired[index]) !== hashJson(recovery.actions[index]))) {
        return ['动作恢复改写了已保留的独立修改'];
      }
    }
    return [];
  }
  if (repaired.length !== recovery.pending.length) return ['动作恢复不能遗漏或增加失败动作'];
  const unused = repaired.slice();
  const result = deepClone(recovery.actions);
  for (const { index, action } of recovery.pending) {
    const position = unused.findIndex((item) => item.type === action.type);
    if (position < 0) return ['动作恢复必须保留原动作类型'];
    result[index] = unused.splice(position, 1)[0];
  }
  response.actions = result;
  return [];
}

module.exports = { buildActionRecovery, actionRecoveryInstruction, restoreIndependentActions };
