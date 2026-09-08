'use strict';

/**
 * 默认只报告；--apply 时先备份，再事务清理，核对关键数据后提交并回收SQLite空页。
 * 运维应先停止写入服务。只处理明确指定的数据库，不遍历/删除上传目录或版本资源。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { gzipSync, gunzipSync } = require('node:zlib');
const { compactStorage } = require('../lib/ai-storage');

const args = process.argv.slice(2);
const dbArg = args.indexOf('--database');
if (dbArg < 0 || !args[dbArg + 1]) {
  console.error('用法：node server/scripts/compact-storage.js --database /absolute/resume.db [--apply]');
  process.exit(1);
}
const filename = path.resolve(args[dbArg + 1]);
const apply = args.includes('--apply');

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function protectedData(database) {
  const tables = ['resume_drafts', 'profiles', 'experiences', 'target_jobs', 'job_files',
    'resume_versions', 'generation_snapshots', 'resume_outputs', 'change_receipts',
    'uploads', 'artifacts'];
  const result = Object.fromEntries(tables.map((table) =>
    [table, hash(database.prepare(`SELECT * FROM ${table} ORDER BY id`).all())]));
  result.history_window = hash(database.prepare(
    `SELECT * FROM resume_change_events WHERE undo_expired_at IS NULL
     AND (reverted_at IS NULL OR redo_invalidated_at IS NULL)
     ORDER BY id`,
  ).all());
  result.active_messages = hash(database.prepare(
    `SELECT m.* FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
     WHERE c.status = 'active' ORDER BY m.id`,
  ).all());
  result.active_tasks = hash(database.prepare(
    `SELECT t.* FROM ai_tasks t JOIN ai_conversations c ON c.id = t.conversation_id
     WHERE c.status = 'active' ORDER BY t.id`,
  ).all());
  return result;
}
function report(database) {
  const tables = ['ai_conversations', 'ai_messages', 'ai_tasks', 'ai_action_requests',
    'idempotency_keys', 'resume_change_events', 'resume_versions', 'resume_drafts'];
  return {
    file_bytes: fs.statSync(filename).size,
    rows: Object.fromEntries(tables.map((table) =>
      [table, database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n])),
    payload_bytes: Object.fromEntries([
      ['ai_messages', 'content'], ['ai_tasks', 'state_json'],
      ['ai_action_requests', 'payload_json'], ['idempotency_keys', 'response_json'],
      ['resume_change_events', 'before_json || after_json'],
    ].map(([table, field]) =>
      [table, database.prepare(`SELECT COALESCE(SUM(length(CAST(${field} AS BLOB))),0) AS n FROM ${table}`).get().n])),
  };
}

async function main() {
  if (!fs.statSync(filename).isFile()) throw new Error('数据库目标不是文件');
  const database = new DatabaseSync(filename, { readOnly: !apply });
  try {
    const before = report(database);
    if (!apply) {
      console.log(JSON.stringify({ database: filename, mode: 'read_only', before }, null, 2));
      return;
    }
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const backupDir = fs.mkdtempSync('/home/ubuntu/resume-storage-backup-');
    fs.chmodSync(backupDir, 0o700);
    const backupFile = path.join(backupDir, 'before-cleanup.db');
    await backup(database, backupFile);
    fs.chmodSync(backupFile, 0o600);
    const bytes = fs.readFileSync(backupFile);
    const compressed = gzipSync(bytes);
    if (!gunzipSync(compressed).equals(bytes)) throw new Error('备份压缩校验失败');
    fs.writeFileSync(`${backupFile}.gz`, compressed, { mode: 0o600, flag: 'wx' });
    // 仅删除本次创建且已验证可无损解压的未压缩备份。
    fs.unlinkSync(backupFile);
    console.error(`已保存并校验恢复备份：${backupFile}.gz`);
    const expected = protectedData(database);
    let counts;
    database.exec('BEGIN IMMEDIATE');
    try {
      counts = compactStorage(database);
      const actual = protectedData(database);
      for (const key of Object.keys(expected)) {
        if (actual[key] !== expected[key]) throw new Error(`清理将影响必要数据：${key}`);
      }
      if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('外键检查未通过');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    database.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    const integrity = database.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error('数据库完整性检查未通过');
    console.log(JSON.stringify({
      database: filename, backup: `${backupFile}.gz`, backup_bytes: compressed.length,
      counts, before, after: report(database), integrity, protected_data_unchanged: true,
    }, null, 2));
  } finally {
    database.close();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
