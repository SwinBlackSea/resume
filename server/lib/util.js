'use strict';
/**
 * 通用工具：ID、哈希、HTTP 响应、错误处理（RFC 7807）、SSE。
 */
const crypto = require('node:crypto');

/** UUIDv7（时间有序）。TECH §5.2 要求 ID 使用 UUIDv7。 */
function uuidv7() {
  const bytes = crypto.randomBytes(16);
  const ms = Date.now();
  bytes[0] = (ms / 0x10000000000) & 0xff;
  bytes[1] = (ms / 0x100000000) & 0xff;
  bytes[2] = (ms / 0x1000000) & 0xff;
  bytes[3] = (ms / 0x10000) & 0xff;
  bytes[4] = (ms / 0x100) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 以 UTC ISO 8601 输出当前时间（TECH §5.2：时间统一为 UTC ISO 8601）。 */
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 稳定序列化：键按字典序排列，保证同一内容得到同一 hash。 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function hashJson(value) {
  return sha256(canonicalJson(value));
}

function deepClone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** RFC 7807 Problem Details。客户端不展示供应商原始错误与堆栈（TECH §14）。 */
class Problem extends Error {
  constructor(status, code, detail, extra = {}) {
    super(detail || code);
    this.status = status;
    this.code = code;
    this.detail = detail || code;
    this.extra = extra;
  }
}

const problem = {
  badRequest: (detail, extra) => new Problem(400, 'BAD_REQUEST', detail, extra),
  unauthorized: (detail = '需要登录') => new Problem(401, 'UNAUTHORIZED', detail),
  forbidden: (detail = '没有访问权限') => new Problem(403, 'FORBIDDEN', detail),
  notFound: (detail = '资源不存在') => new Problem(404, 'NOT_FOUND', detail),
  conflict: (code, detail, extra) => new Problem(409, code || 'REVISION_CONFLICT', detail, extra),
  unprocessable: (code, detail, extra) =>
    new Problem(422, code || 'UNPROCESSABLE', detail, extra),
  tooMany: (detail) => new Problem(429, 'QUOTA_EXCEEDED', detail),
  serverError: (detail = '服务暂时不可用') => new Problem(500, 'INTERNAL', detail),
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendProblem(res, err, requestId) {
  const status = err instanceof Problem ? err.status : 500;
  const code = err instanceof Problem ? err.code : 'INTERNAL';
  // 详细错误仅写日志，响应只返回安全信息
  if (!(err instanceof Problem)) {
    console.error('[unhandled]', requestId, err);
  }
  sendJson(res, status, {
    type: `https://errors.resume-planet.local/${code}`,
    title: code,
    status,
    detail: err instanceof Problem ? err.detail : '服务暂时不可用',
    request_id: requestId,
    ...(err instanceof Problem ? err.extra : {}),
  });
}

/** 读取 JSON 请求体，带 1MB 限制。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(problem.badRequest('请求体过大'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (_) {
        reject(problem.badRequest('请求体不是合法 JSON'));
      }
    });
    req.on('error', () => reject(problem.badRequest('请求体读取失败')));
  });
}

/** SSE 推送（任务进度优先 SSE，断线后用任务详情接口补状态）。 */
function sseWrite(res, event, data) {
  if (res.writableEnded) return;
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseOpen(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
}

module.exports = {
  uuidv7,
  nowIso,
  sha256,
  canonicalJson,
  hashJson,
  deepClone,
  Problem,
  problem,
  sendJson,
  sendProblem,
  readJsonBody,
  sseOpen,
  sseWrite,
};
