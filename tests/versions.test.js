'use strict';
/**
 * 草稿、版本与生成闭环测试（PRD §6.5、TECH §8、发布验收 3/9/18/19/20）。
 */
const test = require('node:test');
const assert = require('node:assert');

const helpers = require('./helpers');
const db = require('../server/lib/db');
const { uuidv7, nowIso } = require('../server/lib/util');
const ResumeDom = require('../resume-dom');

let ctx;
let projectId;
let otherUser;

const workspace = async () => (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;

test.before(async () => {
  ctx = await helpers.boot();
  projectId = await helpers.defaultProject(ctx);
  // 第二个用户：用于验证跨用户隔离
  otherUser = uuidv7();
  db.run(
    `INSERT INTO users (id, email, phone, display_name, status, created_at, updated_at)
     VALUES (?, ?, NULL, '他人', 'active', ?, ?)`,
    [otherUser, `other-${Date.now()}@example.com`, nowIso(), nowIso()],
  );
});
test.after(() => helpers.close(ctx));

/** 通过一次真实改写方案产生「已应用但未成版」的修改。 */
async function applyOneChange(label) {
  const res = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content: `帮我${label}`,
      scope_type: 'RESUME_BLOCK',
      scope_id: 'target-bullet',
    },
  });
  const action = res.body.actions.find((a) => a.action_type === 'RESUME_REWRITE_PROPOSAL');
  assert.ok(action, '应生成改写方案');
  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: `apply-${action.id}`,
    body: {},
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  return applied.body;
}

test('应用 AI 修改只更新草稿，不自动新增历史版本（发布验收 18）', async () => {
  const before = await workspace();
  const applied = await applyOneChange('写得更精炼');
  assert.strictEqual(applied.version_created, false);

  const after = await workspace();
  assert.strictEqual(after.versions.length, before.versions.length, '历史版本数量不得变化');
  assert.strictEqual(after.draft.has_unsnapshotted_changes, true);
  assert.ok(after.draft.revision > before.draft.revision, '草稿 revision 应递增');
  assert.ok(after.draft.pending_changes.length >= 1, '应存在待成版修改');
});

test('保存为版本：只新增一个版本并清空待成版标记（发布验收 19）', async () => {
  const before = await workspace();
  const draft = before.draft;
  const res = await helpers.call(ctx, 'POST', `/projects/${projectId}/versions`, {
    idemKey: `save-${Date.now()}`,
    body: {
      name: '测试版本',
      draft_revision: draft.revision,
      profile_revision: before.profile.revision,
      job_revision: before.job.revision,
      template_version_id: before.template.template_version_id,
    },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.version_no, before.versions[0].version_no + 1);
  assert.strictEqual(res.body.version_created, true);

  const after = await workspace();
  assert.strictEqual(after.versions.length, before.versions.length + 1, '只应新增一个版本');
  assert.strictEqual(after.draft.has_unsnapshotted_changes, false);
  assert.strictEqual(after.draft.pending_changes.length, 0, '待成版修改应清空');
  assert.strictEqual(after.draft.base_version_id, res.body.id);
});

test('重复 Idempotency-Key 保存版本：不新增版本', async () => {
  const before = await workspace();
  const key = `dup-${Date.now()}`;
  const payload = {
    name: '重复提交测试',
    draft_revision: before.draft.revision,
    profile_revision: before.profile.revision,
    job_revision: before.job.revision,
    template_version_id: before.template.template_version_id,
  };
  const first = await helpers.call(ctx, 'POST', `/projects/${projectId}/versions`, { idemKey: key, body: payload });
  const second = await helpers.call(ctx, 'POST', `/projects/${projectId}/versions`, { idemKey: key, body: payload });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.body.idempotent_replay, true);
  const after = await workspace();
  assert.strictEqual(after.versions.length, before.versions.length + 1);
});

test('撤销修改：同步回滚草稿并移除待成版修改', async () => {
  await applyOneChange('写得更专业');
  const before = await workspace();
  const change = before.draft.pending_changes[before.draft.pending_changes.length - 1];
  assert.ok(change);

  const res = await helpers.call(ctx, 'POST', `/projects/${projectId}/resume-draft/changes/${change.id}/revert`, {
    idemKey: `revert-${change.id}`,
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.status, 'reverted');

  const after = await workspace();
  assert.ok(!after.draft.pending_changes.some((c) => c.id === change.id), '撤销后不得保留该修改');
  const reverted = db.get('SELECT * FROM resume_change_events WHERE id = ?', [change.id]);
  assert.ok(reverted.reverted_at, '变更事件必须标记 reverted');
});

test('历史比较默认覆盖动态简历全文与当前实时草稿', async () => {
  const before = await workspace();
  const baseVersionId = before.draft.base_version_id;
  const proposed = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content: '新增一个海外经历模块，内容：参与跨国团队协作',
      scope_type: 'RESUME_DOCUMENT',
      scope_id: null,
    },
  });
  const action = proposed.body.actions.find((item) => item.action_type === 'RESUME_REWRITE_PROPOSAL');
  assert.ok(action, JSON.stringify(proposed.body));
  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: `apply-history-diff-${action.id}`,
    body: { expected_revision: before.draft.revision },
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));

  const compared = await helpers.call(ctx, 'GET', `/versions/${baseVersionId}/compare`);
  assert.strictEqual(compared.status, 200, JSON.stringify(compared.body));
  assert.strictEqual(compared.body.current.id, null, '默认比较目标必须是实时草稿，而非 base version');
  assert.strictEqual(compared.body.current.has_unsnapshotted_changes, true);
  assert.ok(compared.body.diff.changes.some(
    (change) => change.type === 'added' && change.node_id === 'section-overseas',
  ));
  assert.ok(ResumeDom.findNode(
    ResumeDom.ensureDocument(compared.body.current.resume),
    'overseas-content-1',
  ));

  const detail = await helpers.call(ctx, 'GET', `/versions/${baseVersionId}`);
  assert.strictEqual(detail.body.matches_current_draft, false);
  assert.ok(detail.body.resume, '版本详情必须返回可完整渲染的历史简历');
});

test('从旧版本继续：先保护未保存修改，可选择恢复岗位和模板且不改个人信息', async () => {
  const before = await workspace();
  const oldVersion = before.versions[before.versions.length - 1]; // 最早的版本
  const historical = await helpers.call(ctx, 'GET', `/versions/${oldVersion.id}`);
  const blocked = await helpers.call(ctx, 'POST', `/versions/${oldVersion.id}/clone`, {
    idemKey: `clone-blocked-${oldVersion.id}`,
    body: { draft_revision: before.draft.revision, restore_context: true },
  });
  assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
  assert.strictEqual(blocked.body.title, 'UNSAVED_DRAFT_CHANGES');

  const cloneKey = `clone-${oldVersion.id}-${Date.now()}`;
  const cloneBody = {
    draft_revision: before.draft.revision,
    discard_unsaved: true,
    restore_context: true,
  };
  const res = await helpers.call(ctx, 'POST', `/versions/${oldVersion.id}/clone`, {
    idemKey: cloneKey,
    body: cloneBody,
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.original_version_intact, true);
  assert.strictEqual(res.body.profile_unchanged, true);
  const replay = await helpers.call(ctx, 'POST', `/versions/${oldVersion.id}/clone`, {
    idemKey: cloneKey,
    body: cloneBody,
  });
  assert.strictEqual(replay.body.idempotent_replay, true, '重复恢复请求不得再次增加草稿 revision');

  const after = await workspace();
  assert.strictEqual(after.versions.length, before.versions.length, '版本数量不得变化');
  assert.strictEqual(after.draft.base_version_id, oldVersion.id);
  assert.strictEqual(after.draft.revision, res.body.draft_revision);
  assert.strictEqual(after.draft.has_unsnapshotted_changes, false);
  assert.strictEqual(after.draft.pending_changes.length, 0, '明确放弃后旧待保存修改必须清理');
  assert.deepStrictEqual(after.profile, before.profile, '恢复历史上下文不得覆盖个人信息');
  if (historical.body.template_payload.template_version_id) {
    assert.strictEqual(
      after.template.template_version_id,
      historical.body.template_payload.template_version_id,
    );
  }
  if (historical.body.job_payload.id) {
    assert.strictEqual(after.job.id, historical.body.job_payload.id);
  }
  const stillThere = db.get('SELECT * FROM resume_versions WHERE id = ?', [oldVersion.id]);
  assert.strictEqual(stillThere.version_no, oldVersion.version_no, '原版本不得被覆盖');
});

test('一键生成：创建快照与 generated 版本，并产出 PDF/DOCX（发布验收 3）', async () => {
  const before = await workspace();
  const res = await helpers.call(ctx, 'POST', `/projects/${projectId}/generations`, {
    idemKey: `gen-${Date.now()}`,
    body: {
      client_request_id: 'unit-test',
      project_revision: before.project.revision,
      profile_revision: before.profile.revision,
      job_revision: before.job.revision,
      template_version_id: before.template.template_version_id,
    },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const generationId = res.body.generation_id;

  await helpers.drainWorker();
  const status = await helpers.call(ctx, 'GET', `/generations/${generationId}`);
  assert.strictEqual(status.body.status, 'succeeded', JSON.stringify(status.body));
  assert.ok(status.body.version, '生成成功必须创建版本');
  assert.strictEqual(status.body.version.status, 'complete');

  const output = status.body.output;
  assert.ok(output.validation.artifacts.pdf, '必须产出 PDF');
  assert.ok(output.validation.artifacts.docx, '必须产出 DOCX');
  assert.ok(output.resume_json.experience.length > 0);

  const after = await workspace();
  assert.strictEqual(after.versions.length, before.versions.length + 1, '只应新增一个版本');
  const created = after.versions[0];
  assert.strictEqual(created.kind, 'generated');

  // 快照与任务一一对应
  const snapshots = db.all(
    'SELECT * FROM generation_snapshots WHERE project_id = ? AND generation_no = ?',
    [projectId, res.body.generation_no],
  );
  assert.strictEqual(snapshots.length, 1, '同一 generation_no 只能有一个快照');
});

test('重复提交同一生成请求：只产生一个快照与一个版本', async () => {
  const before = await workspace();
  const key = `gen-dup-${Date.now()}`;
  const payload = {
    client_request_id: 'dup-test',
    project_revision: before.project.revision,
    profile_revision: before.profile.revision,
    job_revision: before.job.revision,
    template_version_id: before.template.template_version_id,
  };
  const first = await helpers.call(ctx, 'POST', `/projects/${projectId}/generations`, { idemKey: key, body: payload });
  const second = await helpers.call(ctx, 'POST', `/projects/${projectId}/generations`, { idemKey: key, body: payload });
  assert.strictEqual(second.body.idempotent_replay, true);
  assert.strictEqual(first.body.snapshot_id, second.body.snapshot_id);

  await helpers.drainWorker();
  const after = await workspace();
  assert.strictEqual(after.versions.length, before.versions.length + 1, '重复点击不得产生多个版本');
});

test('版本快照不可修改：冻结 payload 禁止 UPDATE', async () => {
  const versions = (await workspace()).versions;
  const version = versions[0];
  assert.throws(
    () => db.run('UPDATE resume_versions SET profile_payload = ? WHERE id = ?', ['{}', version.id]),
    /RESUME_VERSION_IMMUTABLE/,
    '版本冻结 payload 必须不可修改',
  );

  const snapshot = db.get('SELECT * FROM generation_snapshots WHERE project_id = ?', [projectId]);
  assert.throws(
    () => db.run('UPDATE generation_snapshots SET job_payload = ? WHERE id = ?', ['{}', snapshot.id]),
    /GENERATION_SNAPSHOT_IMMUTABLE/,
  );
});

test('跨用户访问返回 404（发布验收 9）', async () => {
  const res = await helpers.call(ctx, 'GET', `/projects/${projectId}`, { user: otherUser });
  assert.strictEqual(res.status, 404, '他人不得访问该项目');

  const versions = (await workspace()).versions;
  const versionRes = await helpers.call(ctx, 'GET', `/versions/${versions[0].id}`, { user: otherUser });
  assert.strictEqual(versionRes.status, 404, '他人不得访问该版本');
});

test('导出产物可下载且 DOCX 与 PDF 来自同一份结构化简历', async () => {
  const versions = (await workspace()).versions;
  const generated = versions.find((v) => v.kind === 'generated');
  assert.ok(generated, '需要存在生成版本');

  const exported = await helpers.call(ctx, 'POST', `/versions/${generated.id}/export`, { body: {} });
  assert.strictEqual(exported.status, 200, JSON.stringify(exported.body));
  const types = exported.body.artifacts.map((a) => a.type).sort();
  assert.deepStrictEqual(types, ['docx', 'html', 'pdf']);

  const pdf = exported.body.artifacts.find((a) => a.type === 'pdf');
  const url = await helpers.call(ctx, 'POST', `/artifacts/${pdf.id}/download-url`);
  assert.strictEqual(url.status, 200);
  const download = await fetch(ctx.base + url.body.url.replace('/api/v1', ''));
  assert.strictEqual(download.status, 200);
  const buffer = Buffer.from(await download.arrayBuffer());
  assert.strictEqual(buffer.slice(0, 5).toString(), '%PDF-', '下载内容必须是 PDF');

  // 下载链接必须带有时效令牌
  const noToken = await fetch(ctx.base + `/artifacts/${pdf.id}/download`, { headers: {} });
  assert.strictEqual(noToken.status, 403, '缺少有效下载令牌不得下载');
});
