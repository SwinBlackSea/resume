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

const FORBIDDEN_RELATION_KEYS = new Set([
  'evidence',
  'evidence_ids',
  'evidence_map',
  'source',
  'source_id',
  'source_type',
  'source_label',
  'source_exp',
  'source_item_id',
  'source_item_ids',
  'dependency_fact_ids',
  'fact_id',
  'fact_ids',
  'parent_proposal_id',
]);

function sanitizeRelations(value) {
  if (Array.isArray(value)) return value.map(sanitizeRelations);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_RELATION_KEYS.has(key)) continue;
    if (key === 'pending_claims') {
      if (!Object.hasOwn(value, 'validation_issues') && Array.isArray(entry) && entry.length) {
        clean.validation_issues = entry.map((item) => ({
          code: 'NEEDS_REVIEW',
          token: item && item.token ? item.token : undefined,
          message: '旧版本中的这项数据需要核对',
        }));
      }
      continue;
    }
    clean[key] = sanitizeRelations(entry);
  }
  return clean;
}

function sanitizeJsonColumn(database, table, column) {
  const rows = database.prepare(`SELECT id, ${column} AS payload FROM ${table}`).all();
  const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
  rows.forEach((row) => {
    try {
      const next = JSON.stringify(sanitizeRelations(JSON.parse(row.payload || '{}')));
      if (next !== row.payload) update.run(next, row.id);
    } catch (_) {
      // 非法历史 JSON 保持原状，由读取层按原有容错路径处理。
    }
  });
}

function migrateContentRelations(database) {
  database.exec('DROP TRIGGER IF EXISTS trg_versions_freeze');
  database.exec('DROP TRIGGER IF EXISTS trg_snapshots_freeze');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(
      `DELETE FROM change_receipts
       WHERE resource_type = 'fact_candidate'
          OR action_request_id IN (
            SELECT id FROM ai_action_requests
            WHERE action_type IN ('FACT_CANDIDATE','NO_OP','TEMPORARY_CONTEXT')
          )`,
    );
    database.exec(
      `UPDATE ai_tasks SET active_proposal_id = NULL, status = 'active'
       WHERE active_proposal_id IN (
         SELECT id FROM ai_action_requests
         WHERE action_type IN ('FACT_CANDIDATE','NO_OP','TEMPORARY_CONTEXT')
       ) OR status = 'waiting_fact'`,
    );
    database.exec(
      `DELETE FROM ai_action_requests
       WHERE action_type IN ('FACT_CANDIDATE','NO_OP','TEMPORARY_CONTEXT')`,
    );
    database.exec(
      "UPDATE ai_action_requests SET action_type = 'PROFILE_SAVE_PROPOSAL' WHERE action_type = 'PROFILE_FIELD_UPDATE'",
    );
    database.exec(
      "UPDATE ai_action_requests SET action_type = 'JOB_SET_CURRENT_PROPOSAL' WHERE action_type = 'JOB_CANDIDATE'",
    );
    database.exec("DELETE FROM audit_logs WHERE resource_type = 'fact_candidate'");

    [
      ['resume_drafts', 'resume_json'],
      ['resume_versions', 'resume_payload'],
      ['resume_versions', 'profile_payload'],
      ['resume_versions', 'template_payload'],
      ['resume_versions', 'job_payload'],
      ['generation_snapshots', 'profile_payload'],
      ['generation_snapshots', 'resume_input_payload'],
      ['generation_snapshots', 'template_payload'],
      ['generation_snapshots', 'job_payload'],
      ['generation_snapshots', 'generation_config'],
      ['resume_outputs', 'resume_json'],
      ['resume_outputs', 'explanation_json'],
      ['resume_outputs', 'validation_json'],
      ['resume_change_events', 'before_json'],
      ['resume_change_events', 'after_json'],
      ['ai_action_requests', 'payload_json'],
      ['ai_tasks', 'state_json'],
      ['target_jobs', 'analysis_json'],
      ['template_versions', 'schema_json'],
    ].forEach(([table, column]) => sanitizeJsonColumn(database, table, column));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_versions_freeze
      BEFORE UPDATE ON resume_versions
      FOR EACH ROW WHEN
        OLD.profile_payload  IS NOT NEW.profile_payload  OR
        OLD.template_payload IS NOT NEW.template_payload OR
        OLD.job_payload      IS NOT NEW.job_payload      OR
        OLD.resume_payload   IS NOT NEW.resume_payload   OR
        OLD.version_no       IS NOT NEW.version_no       OR
        OLD.project_id       IS NOT NEW.project_id
      BEGIN
        SELECT RAISE(ABORT, 'RESUME_VERSION_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_snapshots_freeze
      BEFORE UPDATE ON generation_snapshots
      FOR EACH ROW WHEN
        OLD.profile_payload   IS NOT NEW.profile_payload  OR
        OLD.resume_input_payload IS NOT NEW.resume_input_payload OR
        OLD.template_payload  IS NOT NEW.template_payload OR
        OLD.job_payload       IS NOT NEW.job_payload      OR
        OLD.generation_config IS NOT NEW.generation_config OR
        OLD.generation_no     IS NOT NEW.generation_no    OR
        OLD.project_id        IS NOT NEW.project_id
      BEGIN
        SELECT RAISE(ABORT, 'GENERATION_SNAPSHOT_IMMUTABLE');
      END;
    `);
  }
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
  const artifactColumns = db.prepare('PRAGMA table_info(artifacts)').all();
  if (!artifactColumns.some((column) => column.name === 'document_import_id')) {
    db.exec('ALTER TABLE artifacts ADD COLUMN document_import_id TEXT REFERENCES document_imports(id)');
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS ix_artifacts_document_import ON artifacts(document_import_id, type)',
  );
  const snapshotColumns = db.prepare('PRAGMA table_info(generation_snapshots)').all();
  if (!snapshotColumns.some((column) => column.name === 'resume_input_payload')) {
    db.exec(
      "ALTER TABLE generation_snapshots ADD COLUMN resume_input_payload TEXT NOT NULL DEFAULT '{}'",
    );
  }
  // v1.3：不再建立内容来源、证据映射或资料到正文派生关系。
  // 旧本地库只迁移结构，用户内容与必要的操作记录继续保留。
  let templateColumns = db.prepare('PRAGMA table_info(template_definitions)').all();
  if (
    templateColumns.some((item) => item.name === 'source_upload_id') &&
    !templateColumns.some((item) => item.name === 'template_upload_id')
  ) {
    db.exec('ALTER TABLE template_definitions RENAME COLUMN source_upload_id TO template_upload_id');
    templateColumns = db.prepare('PRAGMA table_info(template_definitions)').all();
  }
  const documentImportColumns = db.prepare('PRAGMA table_info(document_imports)').all();
  if (!documentImportColumns.some((item) => item.name === 'applied_template_version_id')) {
    db.exec(
      'ALTER TABLE document_imports ADD COLUMN applied_template_version_id TEXT REFERENCES template_versions(id)',
    );
  }
  if (!documentImportColumns.some((item) => item.name === 'applied_version_id')) {
    db.exec(
      'ALTER TABLE document_imports ADD COLUMN applied_version_id TEXT REFERENCES resume_versions(id)',
    );
  }
  db.exec(
    `UPDATE document_imports
     SET applied_template_version_id = (
       SELECT tv.id
       FROM template_versions tv
       JOIN template_definitions td ON td.id = tv.template_id
       WHERE td.owner_id = document_imports.owner_id
         AND td.template_upload_id = document_imports.upload_id
       ORDER BY tv.version DESC
       LIMIT 1
     )
     WHERE status = 'applied'
       AND applied_template_version_id IS NULL
       AND EXISTS (
         SELECT 1
         FROM template_versions tv
         JOIN template_definitions td ON td.id = tv.template_id
         WHERE td.owner_id = document_imports.owner_id
           AND td.template_upload_id = document_imports.upload_id
       )`,
  );
  const legacyJobFiles = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_sources'")
    .get();
  if (legacyJobFiles) {
    db.exec(
      `INSERT OR IGNORE INTO job_files
       (id, job_id, owner_id, upload_id, sort_order, ocr_raw_text, ocr_confidence, created_at)
       SELECT id, job_id, owner_id, upload_id, sort_order, ocr_raw_text, ocr_confidence, created_at
       FROM job_sources`,
    );
    db.exec('DROP INDEX IF EXISTS ix_job_sources_job');
    db.exec('DROP TABLE job_sources');
  }
  db.exec('DROP INDEX IF EXISTS ix_facts_project_status');
  db.exec('DROP TABLE IF EXISTS fact_candidates');
  let actionColumns = db.prepare('PRAGMA table_info(ai_action_requests)').all();
  if (
    actionColumns.some((item) => item.name === 'requires_confirmation') &&
    !actionColumns.some((item) => item.name === 'requires_user_action')
  ) {
    db.exec(
      'ALTER TABLE ai_action_requests RENAME COLUMN requires_confirmation TO requires_user_action',
    );
    actionColumns = db.prepare('PRAGMA table_info(ai_action_requests)').all();
  }
  if (!actionColumns.some((item) => item.name === 'rejected_at')) {
    db.exec('ALTER TABLE ai_action_requests ADD COLUMN rejected_at TEXT');
  }
  for (const column of ['evidence_json', 'confidence']) {
    if (actionColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE ai_action_requests DROP COLUMN ${column}`);
    }
  }
  migrateContentRelations(db);
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
