'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const ResumeDom = require('../resume-dom');
const {
  createNodeDeltaPair,
  createStructureDeltaPair,
  restoreNodeDelta,
  restoreStructureDelta,
} = require('../server/lib/resume-change');
const { compactResumeChangeEvents } = require('../server/lib/db');

function resumeWith(summary, headline = '产品负责人') {
  return ResumeDom.attachDocument({
    basics: { name: '测试用户' },
    headline,
    summary,
    experience: [],
    projects: [],
    education: [],
    skills: [],
  });
}

test('节点差量撤销只恢复目标内容，并检测同一目标的后续修改', () => {
  const before = resumeWith('原个人优势');
  const afterSummary = ResumeDom.applyDocumentOperations(
    before,
    [{ op: 'replace_text', node_id: 'summary', text: 'AI 修改后的个人优势' }],
  );
  const editableNodes = [];
  (function collect(node) {
    if (node && node.editable === true) editableNodes.push(node.id);
    (node && node.children || []).forEach(collect);
  }(before.dom_document.root));
  const otherNodeId = editableNodes.find((nodeId) => nodeId !== 'summary');
  assert.ok(otherNodeId);
  const afterOtherEdit = ResumeDom.applyDocumentOperations(
    afterSummary,
    [{ op: 'replace_text', node_id: otherNodeId, text: '用户后来修改的其他区域' }],
  );
  const delta = createNodeDeltaPair(before, afterSummary, ['summary']);
  const restored = restoreNodeDelta(afterOtherEdit, delta.before, delta.after);
  assert.strictEqual(ResumeDom.nodeText(ResumeDom.findNode(restored, 'summary').node), '原个人优势');
  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(restored, otherNodeId).node),
    '用户后来修改的其他区域',
  );

  const sameTargetChangedAgain = ResumeDom.applyDocumentOperations(
    afterSummary,
    [{ op: 'replace_text', node_id: 'summary', text: '同一处的后续修改' }],
  );
  assert.throws(
    () => restoreNodeDelta(sameTargetChangedAgain, delta.before, delta.after),
    (error) => error.code === 'CHANGE_TARGET_MODIFIED',
  );
});

test('结构差量只撤销 AI 操作命中的节点，不覆盖其他区域的后续文字', () => {
  const before = resumeWith('原个人优势');
  const operation = {
    op: 'insert_node',
    parent_id: 'resume-root',
    index: 1,
    node: {
      id: 'section-certificates',
      type: 'element',
      tag: 'section',
      children: [{
        id: 'certificates-content',
        type: 'element',
        tag: 'p',
        editable: true,
        text: 'PMP',
        children: [],
      }],
    },
  };
  const afterStructure = ResumeDom.applyDocumentOperations(before, [operation]);
  const delta = createStructureDeltaPair(before, afterStructure, [operation], {
    label: '新增技能证书',
  });
  assert.ok(delta);
  assert.strictEqual(delta.before.format, 'resume-structure-delta-v1');
  const afterOtherEdit = ResumeDom.applyDocumentOperations(
    afterStructure,
    [{ op: 'replace_text', node_id: 'summary', text: '结构调整后手工修改的个人优势' }],
  );
  const restored = restoreStructureDelta(afterOtherEdit, delta.before, delta.after);
  assert.strictEqual(ResumeDom.findNode(restored, 'section-certificates'), null);
  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(restored, 'summary').node),
    '结构调整后手工修改的个人优势',
  );
});

test('旧局部完整快照会压缩为节点差量，较早的已成版 payload 会归档', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE resume_change_events (
      id TEXT PRIMARY KEY,
      change_type TEXT NOT NULL,
      scope_type TEXT,
      scope_id TEXT,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      snapshot_version_id TEXT,
      reverted_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  const before = resumeWith('压缩前');
  const after = ResumeDom.applyDocumentOperations(
    before,
    [{ op: 'replace_text', node_id: 'summary', text: '压缩后' }],
  );
  const insert = database.prepare(
    `INSERT INTO resume_change_events
     (id, change_type, scope_type, scope_id, before_json, after_json,
      snapshot_version_id, reverted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'recent-local',
    'document_transaction',
    'RESUME_DOCUMENT',
    'summary',
    JSON.stringify({ resume_json: before }),
    JSON.stringify({ resume_json: after, label: '修改个人优势' }),
    null,
    null,
    '2026-09-03T06:00:00Z',
  );
  insert.run(
    'old-versioned',
    'full_document',
    'RESUME_DOCUMENT',
    null,
    JSON.stringify({ resume_json: before }),
    JSON.stringify({ resume_json: after, label: '较早修改' }),
    'version-1',
    null,
    '2026-08-01T06:00:00Z',
  );

  const previous = process.env.RESUME_CHANGE_PAYLOAD_RETENTION_DAYS;
  process.env.RESUME_CHANGE_PAYLOAD_RETENTION_DAYS = '7';
  try {
    const result = compactResumeChangeEvents(database);
    assert.strictEqual(result.compacted, 1);
    assert.strictEqual(result.archived, 1);
    assert.ok(result.bytesSaved > 0);
  } finally {
    if (previous === undefined) delete process.env.RESUME_CHANGE_PAYLOAD_RETENTION_DAYS;
    else process.env.RESUME_CHANGE_PAYLOAD_RETENTION_DAYS = previous;
  }

  const recent = database.prepare(
    'SELECT before_json, after_json FROM resume_change_events WHERE id = ?',
  ).get('recent-local');
  assert.strictEqual(JSON.parse(recent.before_json).format, 'resume-node-delta-v1');
  assert.strictEqual(JSON.parse(recent.after_json).label, '修改个人优势');
  const archived = database.prepare(
    'SELECT before_json, after_json FROM resume_change_events WHERE id = ?',
  ).get('old-versioned');
  assert.strictEqual(JSON.parse(archived.before_json).format, 'archived-change-v1');
  assert.strictEqual(JSON.parse(archived.after_json).label, '较早修改');
  database.close();
});
