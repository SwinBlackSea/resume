'use strict';
/**
 * 任务进度事件总线（TECH §4.2：任务进度优先 SSE，断线后用任务详情接口补状态）。
 */
const { EventEmitter } = require('node:events');

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** 订阅某个生成任务的进度。 */
function subscribe(generationId, listener) {
  emitter.on(`generation:${generationId}`, listener);
  return () => emitter.off(`generation:${generationId}`, listener);
}

/** 推送进度。 */
function publish(generationId, payload) {
  emitter.emit(`generation:${generationId}`, payload);
}

module.exports = { subscribe, publish };
