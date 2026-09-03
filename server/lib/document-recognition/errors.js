'use strict';

class DocumentRecognitionError extends Error {
  constructor(code, message, { retryable = false, details = null } = {}) {
    super(message);
    this.name = 'DocumentRecognitionError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function asRecognitionError(error) {
  if (error instanceof DocumentRecognitionError) return error;
  return new DocumentRecognitionError(
    error && error.code ? error.code : 'DOCUMENT_RECOGNITION_FAILED',
    error && error.message ? error.message : '文档识别失败',
    { retryable: Boolean(error && error.retryable) },
  );
}

module.exports = { DocumentRecognitionError, asRecognitionError };
