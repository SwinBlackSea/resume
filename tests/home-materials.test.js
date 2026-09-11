'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const { uuidv7, nowIso } = require('../server/lib/util');
const ResumeDom = require('../resume-dom');
const harness = require('../server/lib/resume-harness');
const home = require('../server/modules/home');
const validator = require('../server/lib/home-job-validation');
const { intakeView, loadIntake } = require('../server/lib/home-materials');
const storage = require('../server/lib/storage');
let ctx;
test.before(async () => { ctx = await helpers.boot(); });
test.after(() => { home.setLinkReaderForTests(null); validator.setClientForTests(null); helpers.close(ctx); });
const call = (method, url, body) => helpers.call(ctx, method, url, { body });
async function intake(body = {}, key) {
  const response = await helpers.call(ctx, 'POST', '/home/intakes', { body, idemKey: key });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
function doc(text = '虚构求职者王青，软件工程师，负责产品开发。') {
  return ResumeDom.toResumeDocument({ schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: { id: 'resume-root', type: 'element', tag: 'article', semantic: { kind: 'document' },
      children: [{ id: 'personal-text', type: 'element', tag: 'p', semantic: { kind: 'paragraph' },
        editable: true, text, children: [] }] } });
}
async function material(value, role, text) {
  const project = helpers.db.get('SELECT * FROM resume_projects WHERE id=?', [value.project_id]);
  const uploadId = uuidv7(), importId = uuidv7();
  const png = await require('sharp')({ create: { width: 20, height: 20, channels: 3, background: '#ddddee' } }).png().toBuffer();
  const key = storage.objectKey(project.owner_id, 'test', `${role}.png`);
  storage.putObject(key, png);
  helpers.db.run(`INSERT INTO uploads(id,owner_id,object_key,original_name,mime_type,size,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'ready',?,?)`, [uploadId, project.owner_id, key, `${role}.png`, 'image/png', png.length, nowIso(), nowIso()]);
  helpers.db.run(`INSERT INTO document_imports(id,project_id,upload_id,owner_id,status,content_candidate,quality_report,created_at,updated_at)
    VALUES(?,?,?,?,'ready',?,'{"safe_to_review":true}',?,?)`,
  [importId, value.project_id, uploadId, project.owner_id, JSON.stringify({ resume_json: doc(text) }), nowIso(), nowIso()]);
  const response = await call('PUT', `/home/intakes/${value.id}/materials/${role}`, { upload_id: uploadId });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
function generation(requests) {
  return { async generate(options) {
    requests.push(options);
    const target = doc('王青｜根据目标岗位制作的完整简历');
    return { output: { type: 'proposal', content: '简历已完成。',
      proposal: { target_resume_document: target, change_constraints: {
        content: 'modify', structure: 'modify', style: 'modify', content_order: 'reorder',
        allowed_region_ids: ['resume-root'] } } } };
  } };
}

test('三角色在服务端校验、角色独立、准备不生成、首份自动版本及重生成隔离', async (t) => {
  const requests = [];t.after(harness.setModelClientForTests(generation(requests)));
  let value = await intake({}, uuidv7());
  assert.equal(value.ready, false);
  assert.equal((await call('POST', `/home/intakes/${value.id}/prepare`, {})).status, 409);
  assert.equal((await call('POST', `/projects/${value.project_id}/ai/messages`,
    { home_intake_id: value.id, content: '制作简历', conversation_id: value.conversation_id })).status, 409);
  assert.equal(requests.length, 0);
  value = await material(value, 'personal', '个人事实：王青负责软件开发。');
  value = await material(value, 'job', '岗位要求：软件工程师，需要开发与沟通能力。');
  value = (await call('PUT', `/home/intakes/${value.id}/materials/layout`, { layout_id: 'editorial' })).body;
  assert.equal(value.ready, true);
  const prepared = await call('POST', `/home/intakes/${value.id}/prepare`, {});
  assert.equal(prepared.status, 200);
  assert.equal(requests.length, 0);
  const generated = await call('POST', `/projects/${value.project_id}/ai/messages`, prepared.body.request);
  assert.equal(generated.status, 200, JSON.stringify(generated.body));
  assert.ok(generated.body.initial_version_id);
  const workspace = (await call('GET', `/projects/${value.project_id}`)).body;
  assert.equal(workspace.versions.length, 1);
  assert.deepEqual(workspace.profile.basics, {});
  assert.equal(requests[0].input.workspace.materials.home_intake.roles.layout.kind, 'builtin');
  assert.deepEqual(requests[0].input.workspace.materials.documents.map((item) => item.material_role), ['personal', 'job']);
  assert.match(JSON.stringify(requests[0].input.workspace.materials.home_intake.role_rules), /他人/);
  const duplicate = await call('POST', `/projects/${value.project_id}/ai/messages`, prepared.body.request);
  assert.equal(duplicate.body.replayed, true);
  assert.equal(requests.length, 1);
  assert.equal((await call('PUT', `/home/intakes/${value.id}/materials/layout`, { layout_id: 'modern' })).status, 409);
  const copy = await intake({ copy_intake_id: value.id });
  assert.notEqual(copy.project_id, value.project_id);
  assert.equal(copy.ready, true);
  assert.notEqual(copy.materials.personal.document_import_id, value.materials.personal.document_import_id);
  assert.equal(copy.materials.personal.upload_id, value.materials.personal.upload_id);
  assert.deepEqual((await call('GET', `/projects/${value.project_id}`)).body.draft, workspace.draft);
  assert.equal(ResumeDom.plainText((await call('GET', `/projects/${copy.project_id}`)).body.draft.resume_json), '');
});

test('材料识别失败、跨项目和无权限不能绕过三栏门槛；静态样式无模板数据库写入', async () => {
  const value = await intake(), other = await intake();
  const tablesBefore = helpers.db.get('SELECT count(*) AS n FROM template_versions').n;
  assert.equal((await call('PUT', `/home/intakes/${value.id}/materials/personal`, { layout_id: 'quiet' })).status, 400);
  assert.equal((await call('PUT', `/home/intakes/${value.id}/materials/layout`, { layout_id: 'missing' })).status, 400);
  const valid = await material(value, 'personal', '虚构个人资料');
  helpers.db.run('UPDATE document_imports SET quality_report=? WHERE id=?',
    [JSON.stringify({ safe_to_review: false }), valid.materials.personal.document_import_id]);
  const current = (await call('GET', `/home/intakes/${value.id}`)).body;
  assert.equal(current.materials.personal.status, 'failed');
  assert.equal(current.ready, false);
  assert.equal((await call('POST', `/projects/${other.project_id}/ai/messages`, {
    home_intake_id: value.id, conversation_id: other.conversation_id, content: '制作简历' })).status, 400);
  assert.equal((await call('GET', '/home/intakes/not-owned')).status, 404);
  assert.equal(helpers.db.get('SELECT count(*) AS n FROM template_versions').n, tablesBefore);
});

test('真实岗位读取服务配合语义验证；失败替代方式、异步迟到不覆盖新选择', async () => {
  const value = await intake();
  let calls = 0, release;
  home.setLinkReaderForTests(async (url) => {
    if (url.endsWith('/slow')) await new Promise((resolve) => { release = resolve; });
    return { url, resolved_url: url, text: 'A real English vacancy. Build customer-facing software. You will join a small distributed team and own the implementation.' };
  });
  validator.setClientForTests({ async generate(request) {
    calls++; assert.equal(request.outputSchema.name, 'resume_home_job_validation_v1');
    return { output: { is_job: !JSON.stringify(request.messages).includes('/not-job'),
      title: 'Software Engineer', company: 'Example (fictional)' } };
  } });
  const good = await call('POST', `/home/intakes/${value.id}/job-link`, { url: 'https://jobs.example/job' });
  assert.equal(good.body.materials.job.status, 'ready');
  assert.equal(good.body.materials.job.title, 'Software Engineer');
  const bad = await call('POST', `/home/intakes/${value.id}/job-link`, { url: 'https://jobs.example/not-job' });
  assert.equal(bad.body.materials.job.status, 'failed');
  assert.match(bad.body.materials.job.error, /Word、PDF|截图/);
  const slow = call('POST', `/home/intakes/${value.id}/job-link`, { url: 'https://jobs.example/slow' });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  const fresh = await call('POST', `/home/intakes/${value.id}/job-link`, { url: 'https://jobs.example/fresh' });
  release();
  const late = await slow;
  assert.equal(late.body.superseded, true);
  assert.equal(fresh.body.materials.job.url, 'https://jobs.example/fresh');
  assert.equal((await call('GET', `/home/intakes/${value.id}`)).body.materials.job.url, fresh.body.materials.job.url);
  assert.ok(calls >= 3);
  const user = { id: helpers.db.get('SELECT owner_id FROM home_intakes WHERE id=?', [value.id]).owner_id };
  const stale = loadIntake(value.id, user);
  stale.state.job.status = 'checking'; stale.state.job.verification_started_at = '2020-01-01T00:00:00.000Z';
  assert.equal(intakeView(stale).materials.job.status, 'failed', '进程重启留下的验证中不能永久阻塞');
});

test('生成失败原请求重试保持角色冻结；改材料则创建独立任务材料组合', async (t) => {
  const requests = [];
  t.after(harness.setModelClientForTests({ async generate(options) {
    requests.push(options);
    if (requests.length === 1) throw Object.assign(new Error('测试模型暂时不可用'), { code: 'MODEL_TIMEOUT' });
    return generation([]).generate(options);
  } }));
  let value = await intake();
  value = await material(value, 'personal', '王青的个人事实');
  value = await material(value, 'job', '软件工程师岗位');
  value = (await call('PUT', `/home/intakes/${value.id}/materials/layout`, { layout_id: 'quiet' })).body;
  const prepared = (await call('POST', `/home/intakes/${value.id}/prepare`, {})).body;
  const failed = await call('POST', `/projects/${value.project_id}/ai/messages`, prepared.request);
  assert.ok(failed.status >= 400);
  const current = (await call('GET', `/home/intakes/${value.id}`)).body;
  assert.equal(current.attempted, true);
  assert.equal(current.generated, false);
  assert.equal((await call('PUT', `/home/intakes/${value.id}/materials/layout`, { layout_id: 'modern' })).status, 409);
  const copied = await intake({ copy_intake_id: value.id });
  assert.equal(copied.attempted, false);
  assert.equal(copied.ready, true);
  const history = (await call('GET', `/projects/${value.project_id}/ai/messages`)).body.items;
  const retried = await call('POST', `/projects/${value.project_id}/ai/messages`, {
    conversation_id: value.conversation_id, retry_message_id: history.at(-1).retry_message_id,
    home_intake_id: copied.id,
  });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.deepEqual(requests[1].input.workspace.materials.home_intake, requests[0].input.workspace.materials.home_intake);
  const count = helpers.db.get('SELECT count(*) AS n FROM ai_messages WHERE conversation_id=? AND role=?',
    [value.conversation_id, 'user']).n;
  assert.equal(count, 1);
});
