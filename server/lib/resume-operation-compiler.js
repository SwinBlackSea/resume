'use strict';

/**
 * 把模型输出的简历操作规范为领域层可执行协议。
 *
 * 模型可以表达语义操作，但不能决定数据库事务、并发条件或执行顺序校验。
 * 编辑节点只有一种身份：editable=true。格式子树不能同时成为独立编辑节点，
 * 也不能通过 data-ai-scope 建立覆盖关系。
 */
const ResumeDom = require('../../resume-dom');
const { deepClone } = require('./util');

const OPERATION_TYPES = new Set([
  'replace_text',
  'insert_node',
  'remove_node',
  'move_node',
  'set_attributes',
  'set_style',
  'wrap_nodes',
  'unwrap_node',
  'merge_editable_nodes',
  'split_editable_node',
]);

function compilerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function containsRetiredAiScope(value) {
  if (Array.isArray(value)) return value.some(containsRetiredAiScope);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => (
    key === 'data-ai-scope' || containsRetiredAiScope(entry)
  ));
}

function normalizeOperation(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw compilerError('OPERATION_INVALID', `第 ${index + 1} 个操作不是对象`);
  }
  const operation = deepClone(raw);
  if (containsRetiredAiScope(operation)) {
    throw compilerError(
      'AI_SCOPE_ATTRIBUTE_FORBIDDEN',
      'data-ai-scope 已停用；一个编辑节点必须对应一个真实内容节点',
      { operation_index: index },
    );
  }
  const op = String(operation.op || '');
  if (!OPERATION_TYPES.has(op)) {
    throw compilerError('OPERATION_UNSUPPORTED', `不支持的 DOM 操作：${op || '空操作'}`, {
      operation_index: index,
      operation_type: op,
    });
  }
  operation.op = op;
  if (['unwrap_node', 'split_editable_node'].includes(op)) {
    operation.node_id = String(operation.node_id || '');
  }
  if (['wrap_nodes', 'merge_editable_nodes'].includes(op)) {
    operation.parent_id = String(operation.parent_id || '');
    operation.node_ids = Array.isArray(operation.node_ids)
      ? operation.node_ids.map(String)
      : [];
  }
  return operation;
}

function compileResumeOperations(resumeValue, rawOperations) {
  if (!Array.isArray(rawOperations)) {
    throw compilerError('OPERATIONS_INVALID', 'DOM operations 必须是数组');
  }
  let working = ResumeDom.toResumeDocument(resumeValue);
  const operations = rawOperations.map(normalizeOperation);
  operations.forEach((operation, index) => {
    try {
      working = ResumeDom.applyDocumentOperations(working, [operation], {
        allowStructure: true,
      });
    } catch (error) {
      throw compilerError(
        error.code || 'OPERATION_NOT_EXECUTABLE',
        `第 ${index + 1} 个操作无法执行：${error.message}`,
        {
          operation_index: index,
          operation_type: operation.op,
          cause_code: error.code || null,
        },
      );
    }
  });
  return { operations, document: working };
}

module.exports = {
  OPERATION_TYPES,
  compileResumeOperations,
  containsRetiredAiScope,
  normalizeOperation,
};
