'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('旧数据库先补 ai_messages.task_id，再创建任务消息索引', () => {
  const dbPath = path.join(
    os.tmpdir(),
    `resume-ai-schema-migration-${process.pid}-${Date.now().toString(36)}.db`,
  );
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE ai_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      scope_type TEXT,
      scope_id TEXT,
      scope_revision INTEGER,
      model_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  legacy.close();

  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        [
          "const db = require('./server/lib/db');",
          "db.get('SELECT 1 AS ok');",
        ].join(''),
      ],
      {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          RESUME_DB_PATH: dbPath,
        },
        stdio: 'pipe',
      },
    );

    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    const columns = migrated.prepare('PRAGMA table_info(ai_messages)').all();
    const indexes = migrated.prepare("PRAGMA index_list('ai_messages')").all();
    migrated.close();
    assert.ok(columns.some((column) => column.name === 'task_id'));
    assert.ok(indexes.some((index) => index.name === 'ix_ai_messages_task'));
  } finally {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
  }
});
