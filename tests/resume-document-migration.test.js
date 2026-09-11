'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { migrateCurrentResumeDocuments } = require('../server/lib/db');

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE resume_drafts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      resume_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE ai_conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      owner_id TEXT NOT NULL
    );
    CREATE TABLE ai_action_requests (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  return database;
}

test('当前草稿迁移只处理旧版双重编辑范围，不误改普通文档 revision', () => {
  const database = createDatabase();
  const ordinary = {
    schema_version: 'resume-document-v3',
    root: {
      id: 'ordinary-root',
      type: 'element',
      tag: 'article',
      attributes: {},
      style: {},
      children: [{
        id: 'ordinary-text',
        type: 'element',
        tag: 'p',
        attributes: {},
        style: {},
        children: [],
        text: '普通草稿',
        editable: true,
      }],
    },
  };
  const legacy = {
    schema_version: 'resume-document-v3',
    root: {
      id: 'legacy-root',
      type: 'element',
      tag: 'article',
      attributes: {},
      style: {},
      children: [{
        id: 'legacy-group',
        type: 'element',
        tag: 'div',
        attributes: { 'data-ai-scope': 'true' },
        style: {},
        children: [
          {
            id: 'legacy-paragraph-1',
            type: 'element',
            tag: 'p',
            attributes: {},
            style: {},
            children: [],
            text: '第一段',
            editable: true,
          },
          {
            id: 'legacy-paragraph-2',
            type: 'element',
            tag: 'p',
            attributes: {},
            style: {},
            children: [],
            text: '第二段',
            editable: true,
          },
        ],
      }],
    },
  };
  const insertDraft = database.prepare(
    `INSERT INTO resume_drafts
     (id, project_id, owner_id, resume_json, revision, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertDraft.run('ordinary', 'project-1', 'owner-1', JSON.stringify(ordinary, null, 2), 7, 'before');
  insertDraft.run('legacy', 'project-1', 'owner-1', JSON.stringify(legacy), 11, 'before');
  database.prepare(
    'INSERT INTO ai_conversations (id, project_id, owner_id) VALUES (?, ?, ?)',
  ).run('conversation-1', 'project-1', 'owner-1');
  database.prepare(
    `INSERT INTO ai_action_requests (id, conversation_id, action_type, status)
     VALUES (?, ?, ?, ?)`,
  ).run('proposal-1', 'conversation-1', 'RESUME_REWRITE_PROPOSAL', 'proposed');

  const result = migrateCurrentResumeDocuments(database);
  const ordinaryRow = database.prepare(
    'SELECT resume_json, revision, updated_at FROM resume_drafts WHERE id = ?',
  ).get('ordinary');
  const legacyRow = database.prepare(
    'SELECT resume_json, revision FROM resume_drafts WHERE id = ?',
  ).get('legacy');
  const proposal = database.prepare(
    'SELECT status FROM ai_action_requests WHERE id = ?',
  ).get('proposal-1');
  const migrated = JSON.parse(legacyRow.resume_json);
  const group = migrated.root.children[0];

  assert.deepStrictEqual(result, { migrated: 1 });
  assert.strictEqual(ordinaryRow.resume_json, JSON.stringify(ordinary, null, 2));
  assert.strictEqual(ordinaryRow.revision, 7);
  assert.strictEqual(ordinaryRow.updated_at, 'before');
  assert.strictEqual(legacyRow.revision, 12);
  assert.strictEqual(group.attributes['data-ai-scope'], undefined);
  assert.strictEqual(group.editable, true);
  assert.strictEqual(group.children[0].editable, undefined);
  assert.strictEqual(group.children[1].editable, undefined);
  assert.strictEqual(proposal.status, 'stale');

  database.close();
});
