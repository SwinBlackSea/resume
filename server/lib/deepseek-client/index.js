'use strict';

const { createDeepSeekClient, DeepSeekClientError } = require('./client');
const { extractJsonObject, parseJsonObject } = require('./json');
const { consumeChatStream, parseEventLine } = require('./sse');

module.exports = {
  createDeepSeekClient,
  DeepSeekClientError,
  extractJsonObject,
  parseJsonObject,
  consumeChatStream,
  parseEventLine,
};
