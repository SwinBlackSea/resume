'use strict';
/**
 * 模型动作的可执行性预检。
 *
 * 这里验证的是通用动作协议，而不是某个简历模块或某种用户话术。
 * 最终写入仍由领域服务再次校验权限、revision、内容真实性与幂等。
 */
const ResumeDom = require('../../../resume-dom');
const { hashJson } = require('../util');
const { buildOperationPreconditions } = require('../resume-operation-preconditions');
const { compileResumeOperations } = require('../resume-operation-compiler');
const {
  normalizeChangeConstraints,
  evaluateChange,
} = require('../resume-change-policy');

const ACTION_TYPES = new Set([
  'PROFILE_SAVE_PROPOSAL',
  'JOB_SET_CURRENT_PROPOSAL',
  'RESUME_REWRITE_PROPOSAL',
]);

function proposalOf(action) {
  return (action && action.payload && action.payload.proposal)
    || (action && action.payload)
    || {};
}

function promisesConfirmation(reply) {
  const text = String(reply || '');
  return /确认后.{0,12}(?:应用|写入|修改)|确认相应操作|即可应用|点击.{0,12}(?:应用|确认)/.test(text);
}

function validateResumeRewrite(action, input, index) {
  const errors = [];
  const proposal = proposalOf(action);
  const scopeType = input && input.scope && input.scope.type;
  if (!['RESUME_BLOCK', 'RESUME_DOCUMENT'].includes(scopeType)) {
    errors.push(`actions[${index}] 的简历修改不适用于当前 scope`);
    return errors;
  }

  let operations = Array.isArray(proposal.operations) ? proposal.operations : [];
  const replacement = proposal.resume_dom || proposal.resume_json;
  if (scopeType === 'RESUME_BLOCK' && !operations.length) {
    if (!String(proposal.suggestion || '').trim()) {
      errors.push(`actions[${index}] 的具体内容改写缺少 suggestion`);
    }
    if (replacement) errors.push(`actions[${index}] 的具体内容范围不能替换整份文档`);
    if (errors.length) return errors;
    operations = [{
      op: 'replace_text',
      node_id: input.scope.id,
      text: String(proposal.suggestion || ''),
    }];
  }
  if (!operations.length && (!replacement || typeof replacement !== 'object')) {
    errors.push(`actions[${index}] 的整份简历修改缺少 DOM operations`);
    return errors;
  }

  const currentResume = ResumeDom.toResumeDocument(
    input && input.workspace && input.workspace.resume
      ? input.workspace.resume.proposal_content || input.workspace.resume.content
      : {},
  );
  try {
    let nextResume;
    const simpleFocusedTextRewrite = scopeType === 'RESUME_BLOCK'
      && operations.length === 1
      && operations[0].op === 'replace_text'
      && String(operations[0].node_id || '') === String(input.scope.id || '');
    if (operations.length) {
      const compiled = compileResumeOperations(currentResume, operations);
      operations = compiled.operations;
      proposal.operations = operations;
      buildOperationPreconditions(currentResume, operations);
      nextResume = compiled.document;
    } else {
      nextResume = ResumeDom.toResumeDocument(replacement);
    }
    if (hashJson(currentResume) === hashJson(nextResume)) {
      errors.push(`actions[${index}] 没有产生实际文档变化`);
    }
    const constraints = normalizeChangeConstraints(
      proposal.change_constraints,
      currentResume,
      {
        scopeType,
        scopeId: input.scope.id,
        scopeRegion: input.focus && input.focus.scope_region,
        allowImplicitTextRewrite: simpleFocusedTextRewrite,
      },
    );
    proposal.change_constraints = constraints;
    const policyResult = evaluateChange(currentResume, nextResume, constraints);
    policyResult.errors.forEach((entry) => {
      errors.push(`actions[${index}] 与用户修改意图不一致：${entry.message}`);
    });
  } catch (error) {
    errors.push(
      error.code && String(error.code).startsWith('CHANGE_CONSTRAINTS')
        ? `actions[${index}] 的修改约束无效：${error.message}`
        : `actions[${index}] 无法执行：${error.message}`,
    );
  }
  return errors;
}

function validateExecutableResponse(response, input) {
  const errors = [];
  const actions = Array.isArray(response && response.actions) ? response.actions : [];
  const resultType = String(response && response.result_type || '');
  if (resultType === 'CLARIFICATION_REQUIRED') {
    if (actions.length) errors.push('需要澄清时不能同时提供可应用动作');
    if (!String(response && response.clarification && response.clarification.question || '').trim()) {
      errors.push('需要澄清时必须提出一个明确问题');
    }
    if (promisesConfirmation(response && response.reply)) {
      errors.push('澄清回复不能声称已有修改等待应用');
    }
    return errors;
  }
  if (resultType === 'PLAN_CONFIRMATION_REQUIRED') {
    if (actions.length) errors.push('理解确认阶段不能同时提供可应用动作');
    if (!String(response && response.plan && response.plan.summary || '').trim()) {
      errors.push('理解确认必须包含简短的处理概述');
    }
    const steps = response && response.plan && response.plan.steps;
    if (!Array.isArray(steps) || steps.length < 2 || steps.length > 5) {
      errors.push('复杂请求的理解确认必须包含 2—5 个简短步骤');
    }
    if (promisesConfirmation(response && response.reply)) {
      errors.push('理解确认不能声称已经生成待应用修改');
    }
    return errors;
  }
  if (resultType === 'ANSWER' && actions.length) {
    errors.push('普通回答不能同时提供可应用动作');
    return errors;
  }
  if (resultType === 'PROPOSAL' && !actions.length) {
    errors.push('修改建议缺少可执行动作');
    return errors;
  }
  if (!actions.length && promisesConfirmation(response && response.reply)) {
    errors.push('回复要求用户确认，但没有提供任何可执行动作');
    return errors;
  }

  actions.forEach((action, index) => {
    if (!action || typeof action !== 'object') {
      errors.push(`actions[${index}] 不是动作对象`);
      return;
    }
    if (!ACTION_TYPES.has(action.type)) {
      errors.push(`actions[${index}] 使用了未知动作类型`);
      return;
    }
    if (action.type === 'RESUME_REWRITE_PROPOSAL') {
      errors.push(...validateResumeRewrite(action, input, index));
      return;
    }
    if (action.type === 'PROFILE_SAVE_PROPOSAL') {
      const payload = action.payload || {};
      if (
        !payload.operation
        || !payload.values
        || typeof payload.values !== 'object'
        || Array.isArray(payload.values)
        || !Object.keys(payload.values).length
      ) {
        errors.push(`actions[${index}] 的资料保存动作不完整`);
      }
      return;
    }
    if (action.type === 'JOB_SET_CURRENT_PROPOSAL') {
      const payload = action.payload || {};
      if (!String(payload.confirmed_text || '').trim()) {
        errors.push(`actions[${index}] 的岗位动作缺少 confirmed_text`);
      }
    }
  });
  return errors;
}

module.exports = {
  validateExecutableResponse,
  promisesConfirmation,
};
