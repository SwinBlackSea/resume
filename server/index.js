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
const { runtimeFromEnvironment, testAuthEnabled } = require('./lib/accounts/runtime');
const { assertCsrf, setPrivateHeaders } = require('./lib/accounts/http');
const { seedIfEmpty } = require('./lib/seed');
const queue = require('./lib/queue');
const {
  configuredRouting,
} = require('./lib/model-client');

const MODULES = [
  './modules/accounts',
  './modules/workspace',
  './modules/home',
  './modules/profile',
  './modules/jobs',
  './modules/uploads',
  './modules/document-assets',
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
// 仓库不是 public 目录：配置、数据库、源码、原型和测试不得通过静态路由下载。
const PUBLIC_FILES = new Set(['index.html', 'login.html', 'account-client.js', 'account-workspace.js', 'resume-dom.js', 'resume-review.js', 'resume-image-edit.js', 'home-controller.js', 'home-image-preview.js']);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname, { accountsEnabled = false } = {}) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!PUBLIC_FILES.has(relative)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('未找到资源');
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }
  const target = path.join(STATIC_ROOT, relative);
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('未找到资源');
      return;
    }
    if (relative === 'index.html' && accountsEnabled) {
      data = Buffer.from(data.toString('utf8').replace('<head>',
        '<head><script>window.__RESUME_ACCOUNTS_ENABLED__=true;document.documentElement.dataset.accountReady="false";</script>'));
    }
    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function createServer({ accountRuntime: suppliedRuntime = null } = {}) {
  const testAuth = !suppliedRuntime && testAuthEnabled();
  const accountRuntime = suppliedRuntime || (testAuth ? null : runtimeFromEnvironment(db.getDb()));
  if (accountRuntime) accountRuntime.assertReleaseReady();
  const router = buildRouter();

  const server = http.createServer(async (req, res) => {
    const requestId = uuidv7();
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch (_) { sendProblem(res, problem.badRequest('请求地址不合法'), requestId); return; }
    const ip = ipHash(req);

    // Same-origin only. Development impersonation is never a production path.
    const origin = req.headers.origin;
    if (!testAuth && origin && origin !== accountRuntime.config.publicOrigin) {
      sendProblem(res, problem.forbidden('请在当前站点重新操作'), requestId);
      return;
    }
    if (origin && (testAuth || origin === accountRuntime.config.publicOrigin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    }
    res.setHeader('access-control-allow-headers', 'content-type, idempotency-key, x-csrf-token, x-account-id');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      serveStatic(req, res, url.pathname, { accountsEnabled: Boolean(accountRuntime) });
      return;
    }

    if (accountRuntime) {
      setPrivateHeaders(res);
      // Raw images/SSE/download handlers cannot accidentally turn private user
      // data into a reusable browser/shared-cache response after logout.
      const originalWriteHead = res.writeHead;
      res.writeHead = function(status, ...args) {
        const index = typeof args[0] === 'string' ? 1 : 0;
        if (args[index] && !Array.isArray(args[index])) {
          const headers = { ...args[index] };
          for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'cache-control') delete headers[key];
          }
          headers['cache-control'] = 'private, no-store';
          args[index] = headers;
        }
        res.setHeader('cache-control', 'private, no-store');
        return originalWriteHead.call(this, status, ...args);
      };
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
      const user = route.auth === 'public' && !testAuth ? null
        : resolveUser(req, { accountRuntime, testAuth });
      if (user && accountRuntime) {
        res.setHeader('x-account-id', user.id);
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
          assertCsrf(req, accountRuntime.config, req.accountSession.token);
        }
      }
      let body = {};
      if (!route.raw && ['POST', 'PATCH', 'PUT'].includes(req.method)) {
        body = await readJsonBody(req, route.maxBodyBytes);
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
        accountRuntime,
        testAuth,
      });
      if (result && result.__sse && accountRuntime && req.accountSession && !res.writableEnded) {
        const token = req.accountSession.token;
        const timer = setInterval(() => {
          try { accountRuntime.resolve(token, { touch: false }); }
          catch (_) { clearInterval(timer); res.end(); }
        }, 30_000);
        timer.unref?.();
        res.once('close', () => clearInterval(timer));
      }
      if (result && (result.__sse || result.__handled)) return;
      sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (err) {
      sendProblem(res, err, requestId);
    }
  });
  if (accountRuntime) {
    let cleanupTimer;
    const cleanup = () => {
      try { accountRuntime.sessions.cleanup(); }
      catch (_) { console.warn('[accounts] bounded retention cleanup failed'); }
    };
    server.once('listening', () => {
      cleanup();
      cleanupTimer = setInterval(cleanup, 5 * 60_000);
      cleanupTimer.unref?.();
    });
    server.once('close', () => clearInterval(cleanupTimer));
  }
  return server;
}

function bootstrap({ port = 8787 } = {}) {
  const testAuth = testAuthEnabled();
  if (!testAuth && (!process.env.RESUME_DOWNLOAD_SECRET
    || process.env.RESUME_DOWNLOAD_SECRET === 'resume-planet-local-secret'
    || Buffer.byteLength(process.env.RESUME_DOWNLOAD_SECRET) < 32)) {
    throw new Error('生产下载签名必须配置至少 32 字节的独立密钥');
  }
  const seeded = testAuth ? seedIfEmpty() : null;
  const server = createServer();
  queue.startWorker();
  server.listen(port, () => {
    const project = db.get('SELECT * FROM resume_projects ORDER BY created_at ASC LIMIT 1');
    const { models, providers } = configuredRouting();
    console.log(`简历星球服务已启动： http://localhost:${port}`);
    if (envLoaded.loaded) console.log(`已加载配置文件： ${envLoaded.file}（${envLoaded.count} 项）`);
    console.log(`AI 引擎： Resume Harness / 文本 ${providers.text || '未配置'}:${models.text} / 复杂结构 ${providers.complex || '未配置'}:${models.complex} / 视觉 ${providers.vision || '未配置'}:${models.vision}`);
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
