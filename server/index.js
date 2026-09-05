'use strict';
/**
 * 简历星球 · API + Web 服务入口。
 *
 * - /api/v1/* 走 REST 路由（TECH §5.2：路径版本为 /api/v1）
 * - / 与静态资源返回 index.html（前端统一维护在单一 HTML，见 AGENTS.md）
 * - 启动时初始化兼容数据与演示数据，并启动 outbox Worker
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 最先加载 .env：保证后续模块（如 db.js 读取 RESUME_DB_PATH）能拿到配置
const envLoaded = require('./lib/dotenv').loadEnv();

const { uuidv7, sendJson, sendProblem, readJsonBody, problem } = require('./lib/util');
const db = require('./lib/db');
const { resolveUser, ipHash } = require('./lib/auth');
const { seedIfEmpty } = require('./lib/seed');
const queue = require('./lib/queue');

const MODULES = [
  './modules/workspace',
  './modules/profile',
  './modules/jobs',
  './modules/uploads',
  './modules/document-imports',
  './modules/draft',
  './modules/ai',
  './modules/inline-ai',
  './modules/versions',
  './modules/generations',
  './modules/artifacts',
];

/** 把 /projects/:id 形式的 pattern 编译为正则。 */
function compilePattern(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

function buildRouter() {
  const table = [];
  MODULES.forEach((modulePath) => {
    // eslint-disable-next-line global-require
    const mod = require(modulePath);
    (mod.routes || []).forEach((route) => {
      const { regex, keys } = compilePattern(route.pattern);
      table.push({ ...route, regex, keys });
    });
  });
  return table;
}

const STATIC_ROOT = path.join(__dirname, '..');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(STATIC_ROOT, relative);
  // 防目录穿越
  if (!target.startsWith(STATIC_ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('未找到资源');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

function createServer() {
  const router = buildRouter();

  const server = http.createServer(async (req, res) => {
    const requestId = uuidv7();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ip = ipHash(req);

    // CORS（本地开发用；生产由网关控制）
    res.setHeader('access-control-allow-origin', req.headers.origin || '*');
    res.setHeader('access-control-allow-headers', 'content-type, idempotency-key, x-user-id');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      serveStatic(req, res, url.pathname);
      return;
    }

    const routePath = url.pathname.replace(/^\/api\/v1/, '');
    const route = router.find(
      (entry) => entry.method === req.method && entry.regex.test(routePath),
    );

    if (!route) {
      sendProblem(res, problem.notFound('接口不存在'), requestId);
      return;
    }

    try {
      const matched = route.regex.exec(routePath);
      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(matched[index + 1]);
      });
      const user = resolveUser(req);
      let body = {};
      if (!route.raw && ['POST', 'PATCH', 'PUT'].includes(req.method)) {
        body = await readJsonBody(req);
      }
      const result = await route.handler({
        req,
        res,
        params,
        body,
        query: url.searchParams,
        user,
        requestId,
        ipHash: ip,
      });
      if (result && (result.__sse || result.__handled)) return; // 响应已由 handler 接管
      sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (err) {
      sendProblem(res, err, requestId);
    }
  });
  return server;
}

function bootstrap({ port = 8787 } = {}) {
  const seeded = seedIfEmpty();
  queue.startWorker();
  const server = createServer();
  server.listen(port, () => {
    const project = db.get('SELECT * FROM resume_projects ORDER BY created_at ASC LIMIT 1');
    console.log(`简历星球服务已启动： http://localhost:${port}`);
    if (envLoaded.loaded) console.log(`已加载配置文件： ${envLoaded.file}（${envLoaded.count} 项）`);
    console.log(`AI 引擎： Resume Harness / ${process.env.RESUME_LLM_PROVIDER || '未配置'} / ${process.env.RESUME_LLM_MODEL || '未配置模型'}`);
    console.log(`工作区接口：       http://localhost:${port}/api/v1/projects/${project ? project.id : ':id'}`);
    if (seeded && seeded.seeded) console.log('已初始化演示数据（陈知行 · 高级产品经理岗位）');
  });
  return server;
}

if (require.main === module) {
  if (process.argv.includes('--reset')) {
    db.reset();
    console.log('数据库已重置');
  }
  const port = Number(process.env.PORT || 8787);
  bootstrap({ port });
}

module.exports = { createServer, bootstrap, buildRouter };
