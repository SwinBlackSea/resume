'use strict';

const path = require('node:path');

const PARSER_VERSION = 'document-recognition-v3';
const SUPPORTED_FORMATS = new Set(['pdf', 'docx', 'doc', 'png', 'jpg', 'jpeg', 'webp']);
const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_PAGES = 20;
const RECOMMENDED_MAX_PAGES = 5;
const MAX_UNCOMPRESSED_DOCX_SIZE = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180000;
const RUNTIME_ROOT =
  process.env.RESUME_DOCUMENT_RUNTIME_DIR
  || path.join(__dirname, '..', '..', '..', '.runtime', 'document-recognition', 'jobs');

module.exports = {
  PARSER_VERSION,
  SUPPORTED_FORMATS,
  IMAGE_FORMATS,
  MAX_FILE_SIZE,
  MAX_PAGES,
  RECOMMENDED_MAX_PAGES,
  MAX_UNCOMPRESSED_DOCX_SIZE,
  DEFAULT_TIMEOUT_MS,
  RUNTIME_ROOT,
};
