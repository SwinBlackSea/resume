'use strict';

const { CAPABILITIES } = require('../model-client');

// 路由按接口能力，不按用户措辞猜意图；局部文字接口自行使用 TEXT。
function routeResumeRequest(input) {
  if ((Array.isArray(input && input.attachments) && input.attachments.length)
    || (input && input.image_history || []).some((message) => message.attachments.length)) {
    return { capability: CAPABILITIES.VISION, reason: 'request_has_images', score: 100 };
  }
  return { capability: CAPABILITIES.COMPLEX, reason: 'global_document_capability', score: 100 };
}

function repairCapability(initialCapability) {
  return initialCapability === CAPABILITIES.VISION
    ? CAPABILITIES.VISION
    : CAPABILITIES.COMPLEX;
}

module.exports = { routeResumeRequest, repairCapability };
