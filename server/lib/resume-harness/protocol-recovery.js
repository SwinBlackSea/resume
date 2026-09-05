'use strict';

const RETRYABLE_PROTOCOL_CODES = new Set([
  'DEEPSEEK_OUTPUT_TRUNCATED',
  'DEEPSEEK_INVALID_JSON',
  'MODEL_OUTPUT_SCHEMA_INVALID',
  'INLINE_OUTPUT_SCHEMA_INVALID',
]);

function protocolError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isRetryableProtocolError(error) {
  return RETRYABLE_PROTOCOL_CODES.has(error && error.code);
}

module.exports = {
  RETRYABLE_PROTOCOL_CODES,
  protocolError,
  isRetryableProtocolError,
};
