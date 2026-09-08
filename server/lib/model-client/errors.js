'use strict';

const MODEL_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'MODEL_NOT_CONFIGURED',
  INVALID_REQUEST: 'MODEL_INVALID_REQUEST',
  SCHEMA_REQUIRED: 'MODEL_SCHEMA_REQUIRED',
  HTTP_ERROR: 'MODEL_HTTP_ERROR',
  OUTPUT_TRUNCATED: 'MODEL_OUTPUT_TRUNCATED',
  INVALID_JSON: 'MODEL_INVALID_JSON',
  TIMEOUT: 'MODEL_TIMEOUT',
  NETWORK_ERROR: 'MODEL_NETWORK_ERROR',
  RESPONSE_FAILED: 'MODEL_RESPONSE_FAILED',
});

class ModelClientError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ModelClientError';
    this.code = details.code || MODEL_ERROR_CODES.RESPONSE_FAILED;
    this.provider = details.provider || null;
    this.model = details.model || null;
    this.status = details.status || null;
    this.cause = details.cause || null;
    Object.entries(details).forEach(([key, value]) => {
      if (!['code', 'provider', 'model', 'status', 'cause'].includes(key)) {
        this[key] = value;
      }
    });
  }
}

function isModelServiceError(error) {
  return Boolean(
    error
    && typeof error.code === 'string'
    && error.code.startsWith('MODEL_'),
  );
}

module.exports = {
  MODEL_ERROR_CODES,
  ModelClientError,
  isModelServiceError,
};
