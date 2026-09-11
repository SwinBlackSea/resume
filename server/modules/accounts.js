'use strict';

const { problem } = require('../lib/util');
const { randomToken, csrfToken } = require('../lib/accounts/crypto');
const { readCookie, sessionCookie, clearSessionCookie, loginCookie, clearLoginCookie,
  assertCsrf, setPrivateHeaders } = require('../lib/accounts/http');

function view(result) {
  return { authenticated: true, user: result.user, session: result.session, csrf_token: result.csrf_token };
}
function requireRuntime(ctx) {
  if (!ctx.accountRuntime) throw problem.unauthorized('账号尚未开放');
  return ctx.accountRuntime;
}
function activeToken(ctx) {
  const runtime = requireRuntime(ctx);
  return readCookie(ctx.req, runtime.config.cookieName);
}
function loginResponse(ctx, runtime, result) {
  ctx.res.setHeader('set-cookie', [
    sessionCookie(runtime.config, result.token), clearLoginCookie(runtime.config),
  ]);
  setPrivateHeaders(ctx.res);
  return view(result);
}
function assertAnonymousCsrf(ctx, runtime) {
  const token = readCookie(ctx.req, runtime.config.bindingCookieName);
  assertCsrf(ctx.req, runtime.config, token);
}

const routes = [
  { method: 'GET', pattern: '/auth/admin/accounts', handler: (ctx) => {
    const runtime = requireRuntime(ctx);
    return runtime.management.list(activeToken(ctx), {
      query: ctx.query.get('q') || '', offset: Number(ctx.query.get('offset') || 0),
    });
  } },
  { method: 'PATCH', pattern: '/auth/admin/accounts/:id', maxBodyBytes: 1024, handler: (ctx) => {
    return requireRuntime(ctx).management.setStatus(activeToken(ctx), ctx.params.id, ctx.body.status);
  } },
  { method: 'POST', pattern: '/auth/admin/accounts/:id/revoke-sessions', maxBodyBytes: 1024, handler: (ctx) => {
    return requireRuntime(ctx).management.revokeSessions(activeToken(ctx), ctx.params.id);
  } },
  { method: 'GET', pattern: '/auth/session', auth: 'public', handler: (ctx) => {
    setPrivateHeaders(ctx.res);
    if (ctx.testAuth && ctx.user) {
      return { authenticated: true, user: { id: ctx.user.id,
        username: 'test-user', display_name: ctx.user.display_name }, csrf_token: 'test-csrf-only' };
    }
    const runtime = requireRuntime(ctx);
    let token;
    try {
      token = readCookie(ctx.req, runtime.config.cookieName);
      if (token) return view(runtime.resolve(token, { touch: ctx.query.get('touch') !== '0' }));
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    let binding;
    try { binding = readCookie(ctx.req, runtime.config.bindingCookieName); } catch (_) { /* renew ambiguous cookie */ }
    binding = binding || randomToken();
    // A delayed read carrying an old cookie must never clear a newer login or
    // password-rotation cookie that another response has just installed.
    ctx.res.setHeader('set-cookie', loginCookie(runtime.config, binding));
    return { authenticated: false, csrf_token: csrfToken(binding) };
  } },
  { method: 'POST', pattern: '/auth/login', auth: 'public', maxBodyBytes: 8192, handler: async (ctx) => {
    const runtime = requireRuntime(ctx);
    assertAnonymousCsrf(ctx, runtime);
    const result = await runtime.login(ctx.body, runtime.buckets(ctx.req, ctx.body.username));
    return loginResponse(ctx, runtime, result);
  } },
  { method: 'POST', pattern: '/auth/register', auth: 'public', maxBodyBytes: 8192, handler: async (ctx) => {
    const runtime = requireRuntime(ctx);
    assertAnonymousCsrf(ctx, runtime);
    const result = await runtime.register(ctx.body, runtime.buckets(ctx.req, ctx.body.username));
    return loginResponse(ctx, runtime, result);
  } },
  { method: 'POST', pattern: '/auth/logout', maxBodyBytes: 1024, handler: (ctx) => {
    const runtime = requireRuntime(ctx), token = activeToken(ctx);
    const current = runtime.resolve(token);
    runtime.sessions.revokeSession(token, current.session.id);
    ctx.res.setHeader('set-cookie', [clearSessionCookie(runtime.config), clearLoginCookie(runtime.config)]);
    return { ok: true };
  } },
  { method: 'POST', pattern: '/auth/password', maxBodyBytes: 8192, handler: async (ctx) => {
    const runtime = requireRuntime(ctx);
    const result = await runtime.changePassword(activeToken(ctx), ctx.body, {
      rateBucket: runtime.buckets(ctx.req).passwordBucket,
    });
    return loginResponse(ctx, runtime, result);
  } },
  { method: 'GET', pattern: '/auth/sessions', handler: (ctx) => {
    const runtime = requireRuntime(ctx);
    return { items: runtime.sessions.listSessions(activeToken(ctx)) };
  } },
  { method: 'DELETE', pattern: '/auth/sessions/:id', handler: (ctx) => {
    const runtime = requireRuntime(ctx);
    const result = runtime.sessions.revokeSession(activeToken(ctx), ctx.params.id);
    if (result.current) ctx.res.setHeader('set-cookie', clearSessionCookie(runtime.config));
    return result;
  } },
  { method: 'POST', pattern: '/auth/logout-all', maxBodyBytes: 8192, handler: async (ctx) => {
    const runtime = requireRuntime(ctx);
    const result = await runtime.logoutAll(activeToken(ctx), ctx.body.password, runtime.buckets(ctx.req).passwordBucket);
    ctx.res.setHeader('set-cookie', [clearSessionCookie(runtime.config), clearLoginCookie(runtime.config)]);
    return result;
  } },
];

module.exports = { routes };
