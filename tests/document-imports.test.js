'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  boot,
  close,
  call,
  defaultProject,
  drainWorker,
  db,
} = require('./helpers');
const documentRecognition = require('../server/lib/document-recognition');
const ResumeDom = require('../resume-dom');

let ctx;
const OTHER_USER_ID = 'document-import-other-user';

function fakeRecognitionResult() {
  const resume = ResumeDom.attachDocument({
    basics: { name: '导入用户' },
    headline: '产品负责人',
    summary: '这是从文件识别出的正文。',
    experience: [],
    projects: [],
    education: [],
    skills: [],
  });
  return {
    detected_format: 'docx',
    page_count: 1,
    parser_version: 'document-recognition-v1',
    model_version: 'test-layout-model',
    content_candidate: {
      format: 'docx',
      plain_text: ResumeDom.plainText(resume.dom_document),
      blocks: [],
      resume_json: resume,
    },
    layout_candidate: {
      format: 'docx',
      schema: {
        document: {
          engine: 'resume-dom-v1',
          structure: 'dynamic',
          root_node_id: 'resume-root',
          allowed_content: 'safe-dom',
        },
        page: {
          size: 'A4',
          margin: { top: 54, right: 58, bottom: 58, left: 58 },
          max_pages: 1,
          unit: 'pt',
        },
        regions: [{ id: 'main', columns: 1, flow: 'vertical' }],
        typography: {
          font: 'Noto Sans SC',
          base_size: 9.5,
          line_height: 1.7,
          color: '#414448',
        },
        section_rules: { order: [], titles: {}, title_style: {} },
        constraints: {},
        assets: {},
        layout: 'imported-single-column',
        imported: true,
      },
      pages: [{ number: 1, width: 595.28, height: 841.89, block_count: 3 }],
    },
    quality_report: {
      safe_to_review: true,
      requires_user_review: true,
      text_coverage: 1,
      warning_codes: [],
      blocking_codes: [],
    },
    warning_codes: [],
    previews: [],
  };
}

async function uploadDocx() {
  const created = await call(ctx, 'POST', '/uploads', {
    body: {
      original_name: 'existing-resume.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 8,
    },
  });
  assert.strictEqual(created.status, 200);
  const content = Buffer.from('504b030414000000', 'hex');
  const response = await fetch(`${ctx.base}/uploads/${created.body.id}/content`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: content,
  });
  assert.strictEqual(response.status, 200);
  const completed = await call(ctx, 'POST', `/uploads/${created.body.id}/complete`, {
    body: {},
  });
  assert.strictEqual(completed.status, 200);
  return created.body.id;
}

test.before(async () => {
  documentRecognition.setClientForTests(async () => fakeRecognitionResult());
  ctx = await boot();
  db.run(
    `INSERT OR IGNORE INTO users
     (id, email, phone, display_name, status, created_at, updated_at)
     VALUES (?, ?, '', '其他用户', 'active', ?, ?)`,
    [OTHER_USER_ID, 'document-import-other@example.com', db.nowIso(), db.nowIso()],
  );
});

test.after(() => {
  documentRecognition.setClientForTests(null);
  close(ctx);
});

test('文件识别先预览确认，应用后保存完整简历版本且不改变资料', async () => {
  const projectId = await defaultProject(ctx);
  const uploadId = await uploadDocx();
  const beforeWorkspace = await call(ctx, 'GET', `/projects/${projectId}`);
  const beforeDraft = beforeWorkspace.body.draft;
  const beforeProfile = JSON.stringify(beforeWorkspace.body.profile);
  const versionCount = db.get(
    'SELECT COUNT(*) AS total FROM resume_versions WHERE project_id = ?',
    [projectId],
  ).total;

  const created = await call(ctx, 'POST', `/projects/${projectId}/document-imports`, {
    idemKey: 'document-import-create-1',
    body: { upload_id: uploadId, entry_context: 'workspace' },
  });
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.body.status, 'uploaded');
  assert.strictEqual((await call(ctx, 'GET', `/projects/${projectId}`)).body.draft.revision, beforeDraft.revision);

  await drainWorker();
  const recognized = await call(ctx, 'GET', `/document-imports/${created.body.id}`);
  assert.strictEqual(recognized.body.status, 'needs_review');
  assert.strictEqual(recognized.body.can_apply, false);
  assert.strictEqual(recognized.body.file.name, 'existing-resume.docx');
  const listed = await call(ctx, 'GET', `/projects/${projectId}/document-imports?limit=5`);
  assert.strictEqual(listed.status, 200);
  assert.strictEqual(listed.body.items[0].id, created.body.id);
  assert.strictEqual(listed.body.items[0].file.name, 'existing-resume.docx');

  const premature = await call(ctx, 'POST', `/document-imports/${created.body.id}/apply`, {
    body: {
      expected_draft_revision: beforeDraft.revision,
    },
  });
  assert.strictEqual(premature.status, 409);

  const reviewed = await call(ctx, 'POST', `/document-imports/${created.body.id}/review`, {
    body: { accepted: true },
  });
  assert.strictEqual(reviewed.status, 200);
  assert.strictEqual(reviewed.body.status, 'ready');
  assert.strictEqual(reviewed.body.can_apply, true);

  const correctedResume = reviewed.body.document_candidate.resume_json;
  const correctedDocument = ResumeDom.applyDocumentOperations(
    correctedResume,
    [{ op: 'replace_text', node_id: 'summary', text: '这是用户在预览中修正后的正文。' }],
  );
  const corrected = await call(ctx, 'POST', `/document-imports/${created.body.id}/review`, {
    body: { accepted: true, resume_json: correctedDocument },
  });
  assert.strictEqual(corrected.status, 200);
  assert.strictEqual(corrected.body.document_candidate.reviewed_by_user, true);

  const applied = await call(ctx, 'POST', `/document-imports/${created.body.id}/apply`, {
    idemKey: 'document-import-apply-1',
    body: {
      expected_draft_revision: beforeDraft.revision,
      mutation_id: 'document-import-change-1',
    },
  });
  assert.strictEqual(applied.status, 200);
  assert.strictEqual(applied.body.status, 'applied');
  assert.strictEqual(applied.body.profile_unchanged, true);
  assert.strictEqual(applied.body.version_created, true);
  assert.ok(applied.body.version_id);

  const afterWorkspace = await call(ctx, 'GET', `/projects/${projectId}`);
  assert.match(ResumeDom.plainText(afterWorkspace.body.draft.resume_json), /预览中修正后的正文/);
  assert.strictEqual(Object.hasOwn(afterWorkspace.body, 'template'), false);
  assert.strictEqual(Object.hasOwn(afterWorkspace.body, 'templates'), false);
  assert.strictEqual(JSON.stringify(afterWorkspace.body.profile), beforeProfile);
  assert.strictEqual(
    db.get('SELECT COUNT(*) AS total FROM resume_versions WHERE project_id = ?', [projectId]).total,
    versionCount + 1,
  );
  assert.strictEqual(afterWorkspace.body.draft.base_version_id, applied.body.version_id);
  assert.strictEqual(afterWorkspace.body.draft.has_unsnapshotted_changes, false);
  const importedVersion = db.get('SELECT * FROM resume_versions WHERE id = ?', [
    applied.body.version_id,
  ]);
  assert.strictEqual(importedVersion.kind, 'imported');
  const importedResume = JSON.parse(importedVersion.resume_payload);
  assert.strictEqual(importedResume.schema_version, ResumeDom.RESUME_DOCUMENT_VERSION);
  assert.ok(importedResume.root);
  assert.strictEqual(Object.hasOwn(importedResume, 'content_document'), false);
  assert.deepStrictEqual(JSON.parse(importedVersion.template_payload), {});

  const proposal = await call(ctx, 'POST', `/document-imports/${created.body.id}/profile-proposal`, {
    idemKey: 'document-import-profile-proposal-1',
    body: { fields: { city: '杭州' } },
  });
  assert.strictEqual(proposal.status, 200);
  assert.strictEqual(proposal.body.requires_user_action, true);
  const beforeConfirm = await call(ctx, 'GET', `/projects/${projectId}`);
  assert.notStrictEqual(beforeConfirm.body.profile.basics.city, '杭州');

  const confirmed = await call(ctx, 'POST', `/ai/actions/${proposal.body.id}/apply`, {
    idemKey: 'document-import-profile-apply-1',
    body: { expected_revision: proposal.body.expected_revision },
  });
  assert.strictEqual(confirmed.status, 200);
  const afterConfirm = await call(ctx, 'GET', `/projects/${projectId}`);
  assert.strictEqual(afterConfirm.body.profile.basics.city, '杭州');
  assert.match(
    ResumeDom.plainText(afterConfirm.body.draft.resume_json),
    /预览中修正后的正文/,
  );
});

test('导入任务按用户隔离，且重复 Idempotency-Key 不重复应用', async () => {
  const projectId = await defaultProject(ctx);
  const item = db.get(
    'SELECT * FROM document_imports WHERE project_id = ? ORDER BY created_at DESC LIMIT 1',
    [projectId],
  );
  const hidden = await call(ctx, 'GET', `/document-imports/${item.id}`, {
    user: OTHER_USER_ID,
  });
  assert.strictEqual(hidden.status, 404);

  const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ?', [projectId]);
  const replay = await call(ctx, 'POST', `/document-imports/${item.id}/apply`, {
    idemKey: 'document-import-apply-1',
    body: {
      expected_draft_revision: draft.revision,
    },
  });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.body.idempotent_replay, true);
  assert.strictEqual(replay.body.version_id, item.applied_version_id);
});

test('直接编辑写入文档事务、使旧 AI 建议失效，并可整笔撤销', async () => {
  const projectId = await defaultProject(ctx);
  const before = await call(ctx, 'GET', `/projects/${projectId}`);
  const versionsBefore = before.body.versions.length;
  const proposed = await call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content: '把个人优势写得更精炼',
      scope_type: 'RESUME_BLOCK',
      scope_id: 'summary',
    },
  });
  const action = proposed.body.actions.find(
    (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
  );
  assert.ok(action, JSON.stringify(proposed.body));

  const changed = await call(ctx, 'POST', `/projects/${projectId}/resume-draft/transactions`, {
    body: {
      expected_revision: before.body.draft.revision,
      mutation_id: 'direct-edit-imported-resume',
      scope_id: 'summary',
      label: '直接修改个人优势',
      input_type: 'typing',
      operations: [{
        op: 'replace_text',
        node_id: 'summary',
        text: '这是用户直接修改并自动保存的个人优势。',
        replace_children: true,
      }],
    },
  });
  assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
  assert.strictEqual(changed.body.version_created, false);
  assert.match(ResumeDom.plainText(changed.body.resume_json), /直接修改并自动保存/);
  const replayed = await call(ctx, 'POST', `/projects/${projectId}/resume-draft/transactions`, {
    body: {
      expected_revision: before.body.draft.revision,
      mutation_id: 'direct-edit-imported-resume',
      operations: [{
        op: 'replace_text',
        node_id: 'summary',
        text: '这次重复提交不得再次执行。',
      }],
    },
  });
  assert.strictEqual(replayed.status, 200, JSON.stringify(replayed.body));
  assert.strictEqual(replayed.body.idempotent_replay, true);
  assert.strictEqual(replayed.body.revision, changed.body.revision);
  assert.match(ResumeDom.plainText(replayed.body.resume_json), /直接修改并自动保存/);
  assert.strictEqual(
    db.get('SELECT status FROM ai_action_requests WHERE id = ?', [action.id]).status,
    'stale',
  );
  const afterChange = await call(ctx, 'GET', `/projects/${projectId}`);
  assert.strictEqual(afterChange.body.versions.length, versionsBefore);
  assert.ok(afterChange.body.draft.pending_changes.some(
    (item) => item.change_type === 'document_transaction',
  ));

  const reverted = await call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/changes/${changed.body.change_id}/revert`,
    { idemKey: 'undo-direct-edit-imported-resume' },
  );
  assert.strictEqual(reverted.status, 200, JSON.stringify(reverted.body));
  const afterUndo = await call(ctx, 'GET', `/projects/${projectId}`);
  assert.doesNotMatch(
    ResumeDom.plainText(afterUndo.body.draft.resume_json),
    /直接修改并自动保存/,
  );
  assert.strictEqual(afterUndo.body.versions.length, versionsBefore);
});
