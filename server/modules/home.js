'use strict';

const db = require('../lib/db');
const { uuidv7, nowIso, problem } = require('../lib/util');
const { withIdempotency } = require('../lib/idempotency');
const { fetchPage } = require('../lib/job-links');
const { ROLES, LAYOUTS, findLayout, loadIntake, intakeView } = require('../lib/home-materials');
const { readBuiltinReferenceImage } = require('../lib/builtin-layouts');
const ResumeDom = require('../../resume-dom');
const workspace = require('./workspace');
const imports = require('./document-imports');
const { validateJobPage } = require('../lib/home-job-validation');

const createProject = workspace.routes.find((route) => route.method === 'POST' && route.pattern === '/projects').handler;
const createImport = imports.routes.find((route) => route.method === 'POST'
  && route.pattern === '/projects/:id/document-imports').handler;
let linkReader = fetchPage;
const linkRuns = new Map();
const materialRuns = new Map();

function save(intake) {
  db.run('UPDATE home_intakes SET state_json = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
    [JSON.stringify(intake.state), nowIso(), intake.id, intake.owner_id]);
}
function assertMutable(intake, { preparing = false } = {}) {
  const view = intakeView(intake);
  const busy = db.get(`SELECT id FROM ai_tasks WHERE conversation_id = ?
    AND status IN ('understanding','planning','validated') LIMIT 1`, [view.conversation_id]);
  if (busy) throw problem.conflict('TASK_BUSY', '请先停止生成，再调整材料');
  if (view.generated) throw problem.conflict('HOME_ALREADY_GENERATED', '已有简历已保存，请创建新的材料组合');
  if (view.attempted && !preparing) throw problem.conflict('HOME_ALREADY_SUBMITTED', '这轮材料已用于生成，请创建新的材料组合');
}
function ensureRole(role) {
  if (!ROLES.includes(role)) throw problem.badRequest('材料类型不正确');
}

function cloneImport(originalId, ownerId, projectId) {
  const row = db.get('SELECT * FROM document_imports WHERE id = ? AND owner_id = ?', [originalId, ownerId]);
  if (!row || !['ready', 'needs_review', 'applied'].includes(row.status)) {
    throw problem.conflict('MATERIAL_NOT_READY', '待复用材料还没有识别完成');
  }
  const copied = { ...row, id: uuidv7(), project_id: projectId, status: row.status === 'applied' ? 'ready' : row.status,
    applied_mode: null, applied_version_id: null, entry_context: 'workspace',
    created_at: nowIso(), updated_at: nowIso() };
  const keys = Object.keys(copied);
  db.run(`INSERT INTO document_imports (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    keys.map((key) => copied[key]));
  return copied.id;
}

const routes = [
  { method: 'GET', pattern: '/home/layouts', handler: () => ({ items: LAYOUTS }) },
  { method: 'GET', pattern: '/home/layouts/:id/image', raw: true, handler: ({ params, query, res }) => {
    const image = readBuiltinReferenceImage(params.id, { preview: query.get('size') === 'preview' });
    res.writeHead(200, { 'content-type': image.mime_type, 'content-length': image.buffer.length,
      'cache-control': 'private, max-age=86400', etag: `"${image.sha256}"`,
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
    res.end(image.buffer);
    return { __handled: true };
  } },
  { method: 'POST', pattern: '/home/intakes', handler: (ctx) =>
    withIdempotency(ctx.user, ctx.req.headers['idempotency-key'], 'home_intake', () => db.tx(() => {
      const project = createProject({ ...ctx, body: { name: '新的简历' }, req: { headers: {} } });
      const id = uuidv7(), state = {};
      if (ctx.body.copy_intake_id) {
        const old = loadIntake(ctx.body.copy_intake_id, ctx.user);
        for (const role of ROLES) {
          const material = old.state[role];
          if (!material || intakeView(old).materials[role].status !== 'ready') continue;
          state[role] = { ...material };
          if (material.document_import_id) state[role].document_import_id =
            cloneImport(material.document_import_id, ctx.user.id, project.id);
        }
      }
      db.run(`INSERT INTO home_intakes (id,owner_id,project_id,state_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?)`, [id, ctx.user.id, project.id, JSON.stringify(state), nowIso(), nowIso()]);
      return intakeView(loadIntake(id, ctx.user));
    })) },
  { method: 'GET', pattern: '/home/intakes/:id', handler: ({ params, user }) =>
    intakeView(loadIntake(params.id, user)) },
  { method: 'PUT', pattern: '/home/intakes/:id/materials/:role', handler: async (ctx) => {
    const intake = loadIntake(ctx.params.id, ctx.user), role = ctx.params.role;
    ensureRole(role); assertMutable(intake);
    const key = `${ctx.user.id}:${intake.id}:${role}`, run = {};
    materialRuns.set(key, run);
    try {
    if (role === 'job') linkRuns.get(`${ctx.user.id}:${intake.id}`)?.abort();
    let material;
    if (ctx.body.layout_id) {
      if (role !== 'layout' || !findLayout(ctx.body.layout_id)) {
        throw problem.badRequest('简历样式不正确');
      }
      material = { kind: 'builtin', layout_id: ctx.body.layout_id,
        name: findLayout(ctx.body.layout_id).name };
    } else if (ctx.body.image_material === true) {
      const upload = db.get('SELECT * FROM uploads WHERE id=? AND owner_id=?', [ctx.body.upload_id, ctx.user.id]);
      if (!upload || upload.status !== 'ready' || upload.chat_conversation_id
        || !['image/png','image/jpeg','image/webp'].includes(upload.mime_type)) {
        throw problem.badRequest('请选择本次上传并校验完成的图片');
      }
      // Home screenshots are visual materials, not an editable document import.
      // Reuse the private original and existing visual generation/crop pipeline.
      const candidates = await require('../lib/document-assets').prepareUploadImages(upload.id,
        { ownerId: ctx.user.id, projectId: intake.project_id });
      material = { kind: 'image', upload_id: upload.id, asset_id: candidates[0].asset_id };
    } else {
      const imported = createImport({ ...ctx, params: { id: intake.project_id },
        req: { headers: {} }, body: { upload_id: ctx.body.upload_id, entry_context: 'workspace' } });
      material = { kind: 'document', upload_id: ctx.body.upload_id, document_import_id: imported.id };
    }
    const current = loadIntake(intake.id, ctx.user);
    if (materialRuns.get(key) !== run) return { ...intakeView(current), superseded: true };
    assertMutable(current);
    current.state[role] = material;
    save(current); return intakeView(current);
    } finally { if (materialRuns.get(key) === run) materialRuns.delete(key); }
  } },
  { method: 'DELETE', pattern: '/home/intakes/:id/materials/:role', handler: ({ params, user }) => {
    const intake = loadIntake(params.id, user); ensureRole(params.role); assertMutable(intake);
    materialRuns.delete(`${user.id}:${intake.id}:${params.role}`);
    if (params.role === 'job') linkRuns.get(`${user.id}:${intake.id}`)?.abort();
    delete intake.state[params.role]; save(intake);
    // Only detach this selection. Existing versions, tasks and shared immutable
    // upload bytes have independent lifetimes; never delete a file here.
    return intakeView(intake);
  } },
  { method: 'POST', pattern: '/home/intakes/:id/job-link', handler: async ({ params, body, user }) => {
    const intake = loadIntake(params.id, user); assertMutable(intake);
    materialRuns.delete(`${user.id}:${intake.id}:job`);
    const url = String(body.url || '').trim();
    try { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(); }
    catch (_) { throw problem.badRequest('请输入完整的岗位链接'); }
    if (intake.state.job?.kind === 'link' && intake.state.job.url === url
      && intake.state.job.status === 'ready'
      && Date.now() - Date.parse(intake.state.job.checked_at || 0) < 5 * 60 * 1000) {
      return { ...intakeView(intake), reused: true };
    }
    const token = uuidv7();
    const runKey = `${user.id}:${intake.id}`;
    linkRuns.get(runKey)?.abort();
    const controller = new AbortController();
    linkRuns.set(runKey, controller);
    const timer = setTimeout(() => controller.abort(), 45000);
    timer.unref();
    intake.state.job = { kind: 'link', url, status: 'checking', token, verification_started_at: nowIso() };
    save(intake);
    try {
      const page = await linkReader(url, { signal: controller.signal });
      const recognized = await validateJobPage(page, controller.signal);
      controller.signal.throwIfAborted();
      const text = page.text;
      const current = loadIntake(intake.id, user);
      if (current.state.job?.token !== token) return { ...intakeView(current), superseded: true };
      current.state.job = { kind: 'link', url, resolved_url: page.resolved_url,
        text, title: recognized.title, company: recognized.company,
        status: 'ready', checked_at: nowIso(), token };
      save(current); return intakeView(current);
    } catch (error) {
      const current = loadIntake(intake.id, user);
      if (current.state.job?.token !== token) return { ...intakeView(current), superseded: true };
      current.state.job = { kind: 'link', url, token, status: 'failed',
        error: '无法读取岗位信息，请上传 Word、PDF 或岗位截图。' };
      save(current);
      return intakeView(current);
    } finally {
      clearTimeout(timer);
      if (linkRuns.get(runKey) === controller) linkRuns.delete(runKey);
    }
  } },
  { method: 'POST', pattern: '/home/intakes/:id/prepare', handler: ({ params, user, body }) => {
    const intake = loadIntake(params.id, user), view = intakeView(intake);
    assertMutable(intake, { preparing: true });
    if (!view.ready) throw problem.conflict('HOME_MATERIALS_NOT_READY', '请先准备好三份材料');
    const last = db.get(`SELECT id, role, model_metadata_json FROM ai_messages WHERE conversation_id=?
      ORDER BY created_at DESC,id DESC LIMIT 1`, [view.conversation_id]);
    const afterAnswer = last?.role === 'assistant' && JSON.parse(last.model_metadata_json || '{}').result_type !== 'ERROR';
    if (body.instruction !== undefined && (typeof body.instruction !== 'string' || body.instruction.length > 12000)) {
      throw problem.badRequest('补充回答格式不正确或过长');
    }
    return { ...view, request: { home_intake_id: intake.id, initial_generation: true,
      conversation_id: view.conversation_id, scope_type: 'RESUME_DOCUMENT', scope_id: null,
      content: body.instruction?.trim() ? body.instruction
        : '请根据个人信息材料和目标岗位，按照我选择或上传的简历样式，制作一份完整简历。样式材料只用于排版，不采用其中他人的信息或照片。',
      client_request_id: `home-generation-${intake.id}${afterAnswer ? '-'+last.id : ''}` } };
  } },
];

module.exports = { routes, setLinkReaderForTests(value) {
  if (process.env.NODE_ENV !== 'test') throw new Error('仅测试允许替换岗位链接读取器');
  linkReader = value || fetchPage;
} };
