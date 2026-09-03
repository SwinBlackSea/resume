'use strict';

const client = require('./client');
const service = require('./service');
const candidates = require('./candidates');
const constants = require('./constants');

module.exports = {
  recognize: client.recognize,
  cleanup: client.cleanup,
  setClientForTests: client.setClientForTests,
  recognizeDocument: service.recognizeDocument,
  validateInput: service.validateInput,
  blankResume: candidates.blankResume,
  constants,
};
