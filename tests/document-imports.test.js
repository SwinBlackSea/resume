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
const resumeHarness = require('../server/lib/resume-harness');
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

test('同一处文字直改后仍可明确应用 AI 建议，并可撤销回手改内容', async () => {
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
  const suggestion = action.payload.proposal.suggestion;
  const manuallyEditedText = '这是用户直接修改并自动保存的个人优势。';

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
        text: manuallyEditedText,
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
    'awaiting_confirmation',
  );
  const afterChange = await call(ctx, 'GET', `/projects/${projectId}`);
  assert.strictEqual(afterChange.body.versions.length, versionsBefore);
  assert.ok(afterChange.body.draft.pending_changes.some(
    (item) => item.change_type === 'document_transaction',
  ));

  const applied = await call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: 'apply-ai-after-same-target-direct-edit',
    body: { expected_revision: action.expected_revision },
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(applied.body.resume_json, 'summary').node),
    suggestion,
  );
  const aiEvent = db.get('SELECT before_json, after_json FROM resume_change_events WHERE id = ?', [
    applied.body.change_event_id,
  ]);
  assert.strictEqual(
    ResumeDom.nodeText(JSON.parse(aiEvent.before_json).nodes[0].node),
    manuallyEditedText,
  );

  const revertedAi = await call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/changes/${applied.body.change_event_id}/revert`,
    { idemKey: 'undo-ai-after-same-target-direct-edit' },
  );
  assert.strictEqual(revertedAi.status, 200, JSON.stringify(revertedAi.body));
  const afterUndo = await call(ctx, 'GET', `/projects/${projectId}`);
  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(afterUndo.body.draft.resume_json, 'summary').node),
    manuallyEditedText,
  );
  assert.strictEqual(afterUndo.body.versions.length, versionsBefore);
});

test('AI 生成期间手改同一节点，返回后的建议仍可由用户明确应用', async () => {
  const projectId = await defaultProject(ctx);
  const before = await call(ctx, 'GET', `/projects/${projectId}`);
  const manuallyEditedText = '用户在等待 AI 期间完成的手工版本。';
  let modelStarted;
  let releaseModel;
  const started = new Promise((resolve) => {
    modelStarted = resolve;
  });
  const release = new Promise((resolve) => {
    releaseModel = resolve;
  });
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'same-target-concurrency-test',
    generate: async ({ input }) => {
      modelStarted();
      await release;
      return {
        output: {
          reply: '已生成精炼建议，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                suggestion: `${input.currentText}。`,
              },
            },
          }],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const proposalRequest = call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
      body: {
        content: '把个人优势写得更精炼',
        scope_type: 'RESUME_BLOCK',
        scope_id: 'summary',
      },
    });
    await started;
    const direct = await call(ctx, 'POST', `/projects/${projectId}/resume-draft/transactions`, {
      body: {
        expected_revision: before.body.draft.revision,
        mutation_id: 'same-target-edit-while-ai-running',
        scope_id: 'summary',
        operations: [{
          op: 'replace_text',
          node_id: 'summary',
          text: manuallyEditedText,
          replace_children: true,
        }],
      },
    });
    assert.strictEqual(direct.status, 200, JSON.stringify(direct.body));
    releaseModel();

    const proposed = await proposalRequest;
    const action = proposed.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(action, JSON.stringify(proposed.body));
    assert.strictEqual(
      db.get('SELECT status FROM ai_action_requests WHERE id = ?', [action.id]).status,
      'awaiting_confirmation',
    );
    const refreshed = await call(ctx, 'GET', `/projects/${projectId}`);
    const refreshedAction = refreshed.body.conversation.messages
      .flatMap((message) => message.actions || [])
      .find((item) => item.id === action.id);
    assert.ok(refreshedAction, JSON.stringify(refreshed.body));
    assert.strictEqual(
      refreshedAction.payload.proposal.change_preview.before.text,
      manuallyEditedText,
    );
    assert.notStrictEqual(
      refreshedAction.payload.proposal.change_preview.after.text,
      manuallyEditedText,
    );

    const applied = await call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
      idemKey: 'apply-ai-after-inflight-same-target-edit',
      body: { expected_revision: action.expected_revision },
    });
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.notStrictEqual(
      ResumeDom.nodeText(ResumeDom.findNode(applied.body.resume_json, 'summary').node),
      manuallyEditedText,
    );
    const event = db.get('SELECT before_json FROM resume_change_events WHERE id = ?', [
      applied.body.change_event_id,
    ]);
    assert.strictEqual(
      ResumeDom.nodeText(JSON.parse(event.before_json).nodes[0].node),
      manuallyEditedText,
    );
  } finally {
    releaseModel();
    restore();
  }
});

test('其他区域的文字直改不阻断 AI 应用，局部变更只保存节点差量', async () => {
  const projectId = await defaultProject(ctx);
  const before = await call(ctx, 'GET', `/projects/${projectId}`);
  const editableNodes = [];
  (function collect(node) {
    if (node && node.editable === true) editableNodes.push(node.id);
    (node && node.children || []).forEach(collect);
  }(before.body.draft.resume_json.root));
  const otherNodeId = editableNodes.find((nodeId) => nodeId !== 'summary');
  assert.ok(otherNodeId, '测试简历应至少有两个可编辑节点');
  const summaryBefore = ResumeDom.nodeText(
    ResumeDom.findNode(before.body.draft.resume_json, 'summary').node,
  );
  const proposed = await call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content: '把个人优势改得更有说服力',
      scope_type: 'RESUME_BLOCK',
      scope_id: 'summary',
    },
  });
  const action = proposed.body.actions.find(
    (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
  );
  assert.ok(action, JSON.stringify(proposed.body));

  const direct = await call(ctx, 'POST', `/projects/${projectId}/resume-draft/transactions`, {
    body: {
      expected_revision: before.body.draft.revision,
      mutation_id: 'direct-edit-other-node-while-ai-running',
      scope_id: otherNodeId,
      label: '直接修改其他区域',
      input_type: 'typing',
      operations: [{
        op: 'replace_text',
        node_id: otherNodeId,
        text: '用户同步修改的其他区域',
        replace_children: true,
      }],
    },
  });
  assert.strictEqual(direct.status, 200, JSON.stringify(direct.body));
  assert.strictEqual(
    db.get('SELECT status FROM ai_action_requests WHERE id = ?', [action.id]).status,
    'awaiting_confirmation',
  );

  // 客户端仍携带建议生成时的旧 revision；DOM 操作只要仍可执行就应允许应用。
  const applied = await call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: 'apply-ai-after-unrelated-direct-edit',
    body: { expected_revision: action.expected_revision },
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  const afterApply = await call(ctx, 'GET', `/projects/${projectId}`);
  assert.match(ResumeDom.plainText(afterApply.body.draft.resume_json), /用户同步修改的其他区域/);
  assert.notStrictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(afterApply.body.draft.resume_json, 'summary').node),
    summaryBefore,
  );

  const directEvent = db.get('SELECT * FROM resume_change_events WHERE id = ?', [
    direct.body.change_id,
  ]);
  const aiEvent = db.get('SELECT * FROM resume_change_events WHERE id = ?', [
    applied.body.change_event_id,
  ]);
  [directEvent, aiEvent].forEach((event) => {
    const beforePayload = JSON.parse(event.before_json);
    const afterPayload = JSON.parse(event.after_json);
    assert.strictEqual(beforePayload.format, 'resume-node-delta-v1');
    assert.strictEqual(afterPayload.format, 'resume-node-delta-v1');
    assert.strictEqual(Object.hasOwn(beforePayload, 'resume_json'), false);
    assert.strictEqual(Object.hasOwn(afterPayload, 'resume_json'), false);
  });

  // 撤销较早发生的 headline 修改，只恢复 headline，不覆盖后来应用的 summary 修改。
  const reverted = await call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/changes/${direct.body.change_id}/revert`,
    { idemKey: 'undo-unrelated-direct-edit-after-ai-apply' },
  );
  assert.strictEqual(reverted.status, 200, JSON.stringify(reverted.body));
  const afterUndo = await call(ctx, 'GET', `/projects/${projectId}`);
  assert.doesNotMatch(ResumeDom.plainText(afterUndo.body.draft.resume_json), /用户同步修改的其他区域/);
  assert.notStrictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(afterUndo.body.draft.resume_json, 'summary').node),
    summaryBefore,
  );
});

test('草稿已经达到 AI 建议结果时应用不产生空 revision 或空变更事件', async () => {
  const projectId = await defaultProject(ctx);
  const desiredText = '用户已经手工完成了与 AI 建议相同的内容。';
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'already-satisfied-proposal',
    generate: async () => ({
      output: {
        reply: '已准备修改建议，确认后即可应用。',
        actions: [{
          type: 'RESUME_REWRITE_PROPOSAL',
          payload: { proposal: { suggestion: desiredText } },
        }],
        uncertainty: [],
      },
    }),
  });
  try {
    const before = await call(ctx, 'GET', `/projects/${projectId}`);
    const proposed = await call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
      body: {
        content: '修改个人优势',
        scope_type: 'RESUME_BLOCK',
        scope_id: 'summary',
      },
    });
    const action = proposed.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(action, JSON.stringify(proposed.body));

    const direct = await call(ctx, 'POST', `/projects/${projectId}/resume-draft/transactions`, {
      body: {
        expected_revision: before.body.draft.revision,
        mutation_id: 'manual-edit-matches-ai-proposal',
        scope_id: 'summary',
        operations: [{
          op: 'replace_text',
          node_id: 'summary',
          text: desiredText,
          replace_children: true,
        }],
      },
    });
    assert.strictEqual(direct.status, 200, JSON.stringify(direct.body));
    const eventCount = db.get('SELECT COUNT(*) AS total FROM resume_change_events').total;

    const refreshed = await call(ctx, 'GET', `/projects/${projectId}`);
    const refreshedAction = refreshed.body.conversation.messages
      .flatMap((message) => message.actions || [])
      .find((item) => item.id === action.id);
    assert.strictEqual(
      refreshedAction.payload.proposal.change_preview.already_satisfied,
      true,
    );

    const applied = await call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
      idemKey: `apply-already-satisfied-${action.id}`,
      body: { expected_revision: action.expected_revision },
    });
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.strictEqual(applied.body.no_change, true);
    assert.strictEqual(applied.body.revision, direct.body.revision);
    assert.strictEqual(
      db.get('SELECT COUNT(*) AS total FROM resume_change_events').total,
      eventCount,
    );
  } finally {
    restore();
  }
});

test('整份简历中的 DOM 操作允许无关正文并行变化后继续应用', async () => {
  const projectId = await defaultProject(ctx);
  const before = await call(ctx, 'GET', `/projects/${projectId}`);
  const editableNodes = [];
  (function collect(node) {
    if (node && node.editable === true) editableNodes.push(node.id);
    (node && node.children || []).forEach(collect);
  }(before.body.draft.resume_json.root));
  const targetNodeId = editableNodes[0];
  const anchorNodeId = editableNodes[1];
  assert.ok(targetNodeId && anchorNodeId);
  const anchor = ResumeDom.findNode(before.body.draft.resume_json, anchorNodeId);
  assert.ok(anchor && anchor.parent);
  const insertedNodeId = 'parallel-safe-insert';
  let modelStarted;
  let releaseModel;
  const started = new Promise((resolve) => {
    modelStarted = resolve;
  });
  const release = new Promise((resolve) => {
    releaseModel = resolve;
  });
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'operation-concurrency-test',
    generate: async () => {
      modelStarted();
      await release;
      return {
        output: {
          reply: '已生成新增段落建议，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                suggestion: '新增一个独立段落',
                change_constraints: {
                  content: 'preserve',
                  structure: 'modify',
                  style: 'preserve',
                  allowed_region_ids: [anchor.parent.id],
                },
                operations: [{
                  op: 'insert_node',
                  parent_id: anchor.parent.id,
                  after_node_id: anchorNodeId,
                  node: {
                    id: insertedNodeId,
                    type: 'element',
                    tag: 'p',
                    text: '',
                    editable: true,
                    label: '新增段落',
                  },
                }],
              },
            },
          }],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const proposalRequest = call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
      body: {
        content: '在指定位置增加一个段落',
        scope_type: 'RESUME_DOCUMENT',
        scope_id: null,
      },
    });
    await started;
    const changed = await call(ctx, 'POST', `/projects/${projectId}/resume-draft/transactions`, {
      body: {
        expected_revision: before.body.draft.revision,
        mutation_id: 'direct-edit-before-document-proposal',
        scope_id: targetNodeId,
        operations: [{
          op: 'replace_text',
          node_id: targetNodeId,
          text: '整份建议生成后发生的无关修改',
          replace_children: true,
        }],
      },
    });
    assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
    releaseModel();
    const proposed = await proposalRequest;
    const action = proposed.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(action, JSON.stringify(proposed.body));
    assert.strictEqual(action.expected_revision, before.body.draft.revision);
    assert.strictEqual(
      db.get('SELECT status FROM ai_action_requests WHERE id = ?', [action.id]).status,
      'awaiting_confirmation',
    );
    const applied = await call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
      idemKey: 'apply-rebased-document-operation',
      body: { expected_revision: action.expected_revision },
    });
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.ok(ResumeDom.findNode(applied.body.resume_json, insertedNodeId));
    assert.match(ResumeDom.nodeText(
      ResumeDom.findNode(applied.body.resume_json, targetNodeId).node,
    ), /无关修改/);
  } finally {
    releaseModel();
    restore();
  }
});

test('画布事务拒绝结构与样式操作，复杂调整只能由 AI 提案', async () => {
  const projectId = await defaultProject(ctx);
  const before = await call(ctx, 'GET', `/projects/${projectId}`);
  const rejected = await call(ctx, 'POST', `/projects/${projectId}/resume-draft/transactions`, {
    body: {
      expected_revision: before.body.draft.revision,
      mutation_id: 'reject-manual-structure-edit',
      operations: [{
        op: 'insert_node',
        parent_id: 'resume-root',
        node: {
          id: 'manual-section',
          type: 'element',
          tag: 'section',
          children: [],
        },
      }],
    },
  });
  assert.strictEqual(rejected.status, 422, JSON.stringify(rejected.body));
  assert.strictEqual(rejected.body.title, 'DIRECT_EDIT_TEXT_ONLY');
  const after = await call(ctx, 'GET', `/projects/${projectId}`);
  assert.strictEqual(after.body.draft.revision, before.body.draft.revision);
  assert.strictEqual(after.body.versions.length, before.body.versions.length);
});
