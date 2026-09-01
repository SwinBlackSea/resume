'use strict';
/**
 * 测试脚手架：每个测试文件使用独立数据库与独立 HTTP 服务，互不干扰。
 */
const path = require('node:path');
const os = require('node:os');

process.env.RESUME_DB_PATH = path.join(
  os.tmpdir(),
  `resume-test-${process.pid}-${Date.now().toString(36)}.db`,
);
process.env.RESUME_DOWNLOAD_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
// AI 行为契约测试验证的是「动作 → 策略矩阵 → 执行/待确认」链路，
// 与真实模型的分类波动无关；因此通过 Harness 注入测试模型。
process.env.RESUME_LLM_PROVIDER = 'test';

const resumeHarness = require('../server/lib/resume-harness');
resumeHarness.setModelClientForTests(require('./fakes/resume-model-client'));

const db = require('../server/lib/db');
const { ensureSystemTemplates } = require('../server/lib/templates');
const { seedIfEmpty } = require('../server/lib/seed');
const { createServer } = require('../server/index');
const queue = require('../server/lib/queue');

/** 初始化数据并启动服务（随机端口）。 */
function boot({ seed = true } = {}) {
  ensureSystemTemplates();
  if (seed) seedIfEmpty();
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, base: `http://127.0.0.1:${port}/api/v1` });
    });
  });
}

function close(ctx) {
  if (!ctx) return;
  queue.stopWorker();
  try {
    ctx.server.close();
  } catch (_) {
    /* ignore */
  }
}

/** 发起 API 请求，返回 {status, body}。 */
async function call(ctx, method, url, { body, idemKey, user } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  if (user) headers['x-user-id'] = user;
  const res = await fetch(ctx.base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

/** 取得演示项目 ID。 */
async function defaultProject(ctx) {
  const res = await call(ctx, 'GET', '/projects');
  return res.body.items[0].id;
}

/** 驱动 outbox worker 直到没有待处理事件（或达到上限）。 */
async function drainWorker(rounds = 60) {
  for (let i = 0; i < rounds; i += 1) {
    const processed = await queue.processOnce(5);
    if (!processed) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

module.exports = { boot, close, call, defaultProject, drainWorker, db, queue };
