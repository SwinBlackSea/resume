'use strict';
/**
 * 数据库访问层。
 * MVP 使用内置 node:sqlite 承载 PostgreSQL 语义的 schema（TECH §7）。
 * 生产替换为 PostgreSQL 时，只需改写本文件的 query 语义，业务模块保持不变。
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('./util');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.RESUME_DB_PATH || path.join(DATA_DIR, 'resume.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');

let db = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getDb() {
  if (db) return db;
  ensureDir();
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  // 兼容升级前已存在的本地数据库；正式环境由同名迁移补齐该列。
  const conversationColumns = db.prepare('PRAGMA table_info(ai_conversations)').all();
  if (!conversationColumns.some((column) => column.name === 'status')) {
    db.exec("ALTER TABLE ai_conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  return db;
}

function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

function get(sql, params = []) {
  return getDb().prepare(sql).get(...params) || null;
}

function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

/**
 * 在事务中执行 fn。SQLite 不支持嵌套事务，使用计数器做可重入保护。
 * 事务内的写操作通过同一个 DatabaseSync 连接串行执行。
 */
let txDepth = 0;
function tx(fn) {
  const database = getDb();
  if (txDepth > 0) return fn(); // 已在事务中，直接执行
  txDepth += 1;
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch (_) {
      /* 事务可能已因错误自动回滚 */
    }
    throw err;
  } finally {
    txDepth -= 1;
  }
}

/** 读取并递增某个聚合的 revision（乐观锁）。返回新 revision。 */
function bumpRevision(table, id, column = 'revision') {
  const row = get(`SELECT ${column} AS rev FROM ${table} WHERE id = ?`, [id]);
  const next = (row ? row.rev : 0) + 1;
  run(`UPDATE ${table} SET ${column} = ?, updated_at = ? WHERE id = ?`, [next, nowIso(), id]);
  return next;
}

/** 为项目分配单调递增的版本号 / 生成序号。 */
function nextSequence(table, projectId, column) {
  const row = get(
    `SELECT COALESCE(MAX(${column}), 0) AS max_value FROM ${table} WHERE project_id = ?`,
    [projectId],
  );
  return (row ? row.max_value : 0) + 1;
}

function reset() {
  if (db) {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
    db = null;
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const file = DB_PATH + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

module.exports = {
  getDb,
  run,
  get,
  all,
  tx,
  nowIso,
  bumpRevision,
  nextSequence,
  reset,
  DB_PATH,
};
