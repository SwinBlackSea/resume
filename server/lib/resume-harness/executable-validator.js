'use strict';
/**
 * 模型动作的可执行性预检。
 *
 * 这里验证的是通用动作协议，而不是某个简历模块或某种用户话术。
 * 最终写入仍由领域服务再次校验权限、revision、内容真实性与幂等。
 */
const ResumeDom = require('../../../resume-dom');
const { hashJson } = require('../util');
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

function validateResumeRewrite(action, input, index) {
  const errors = [];
  const proposal = proposalOf(action);
  const scopeType = input && input.scope && input.scope.type;
  if (!['RESUME_BLOCK', 'RESUME_DOCUMENT'].includes(scopeType)) {
    errors.push(`actions[${index}] 的简历修改不适用于当前 scope`);
    return errors;
  }

  let operations = Array.isArray(proposal.operations) ? proposal.operations : [];
  const targetDocument = proposal.target_resume_document
    || proposal.resume_dom
    || proposal.resume_json;
  const suggestion = String(proposal.suggestion || '').trim();
  if (
    (!targetDocument || typeof targetDocument !== 'object')
    && !operations.length
    && !(scopeType === 'RESUME_BLOCK' && suggestion)
  ) {
    errors.push(`actions[${index}] 的简历修改缺少目标 ResumeDocument`);
    return errors;
  }

  const currentResume = ResumeDom.toResumeDocument(
    input && input.workspace && input.workspace.resume
      ? input.workspace.resume.proposal_content || input.workspace.resume.content
      : {},
  );
  try {
    let nextResume;
    let simpleFocusedTextRewrite = false;
    if (targetDocument && typeof targetDocument === 'object') {
      nextResume = ResumeDom.toResumeDocument(targetDocument);
      if (operations.length) {
        const compiled = compileResumeOperations(currentResume, operations);
        if (hashJson(compiled.document) !== hashJson(nextResume)) {
          errors.push(`actions[${index}] 的目标文档与兼容操作结果不一致`);
          return errors;
        }
        operations = compiled.operations;
        proposal.operations = operations;
      }
    } else if (operations.length) {
      const compiled = compileResumeOperations(currentResume, operations);
      operations = compiled.operations;
      proposal.operations = operations;
      nextResume = compiled.document;
    } else {
      simpleFocusedTextRewrite = true;
      operations = [{
        op: 'replace_text',
        node_id: input.scope.id,
        text: suggestion,
      }];
      const compiled = compileResumeOperations(currentResume, operations);
      proposal.operations = compiled.operations;
      nextResume = compiled.document;
    }
    proposal.target_resume_document = nextResume;
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
  if (resultType === 'MESSAGE') {
    if (actions.length) errors.push('自然语言沟通不能同时提供可应用动作');
    return errors;
  }
  if (resultType === 'PROPOSAL' && !actions.length) {
    errors.push('修改建议缺少可执行动作');
    return errors;
  }
  if (!['MESSAGE', 'PROPOSAL'].includes(resultType)) {
    errors.push('模型结果类型必须是 message 或 proposal');
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
};
