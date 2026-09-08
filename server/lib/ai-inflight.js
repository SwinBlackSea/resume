'use strict';

// 生命周期取消仅是省掉无用请求；数据库状态仍是禁止迟到回写的最终边界。
const running = new Map();
function begin(key) {
  const controller = new AbortController();
  if (!running.has(key)) running.set(key, new Set());
  running.get(key).add(controller);
  return {
    signal: controller.signal,
    finish() {
      const group = running.get(key);
      if (!group) return;
      group.delete(controller);
      if (!group.size) running.delete(key);
    },
  };
}
function cancel(key) {
  const group = running.get(key);
  if (!group) return;
  running.delete(key);
  group.forEach((controller) => controller.abort());
}
module.exports = { begin, cancel };
