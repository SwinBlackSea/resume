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
const {
  archivedPayload,
  compactLegacyEvent,
  isArchivedPayload,
  parsePayload,
} = require('./resume-change');
const ResumeDom = require('../../resume-dom');

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

/**
 * v2.2 移除已废弃的 Word/ONLYOFFICE 编辑链路。
 *
 * 当前简历继续由 resume_drafts.resume_json 承载；正式历史版本和生成快照
 * 仍保留完整 JSON。这里只清理编辑器会话、临时 DOCX 修订及其冗余列。
 */
function removeRetiredDocumentEditorSchema(database) {
  const hasTable = (name) =>
    Boolean(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name),
    );
  const columns = (table) =>
    hasTable(table) ? database.prepare(`PRAGMA table_info(${table})`).all() : [];

  database.exec('DROP TRIGGER IF EXISTS trg_versions_freeze');
  database.exec('DROP TRIGGER IF EXISTS trg_snapshots_freeze');
  database.exec('DROP INDEX IF EXISTS ix_document_revisions_draft');
  database.exec('DROP INDEX IF EXISTS ix_editor_sessions_draft');
  database.exec('DROP TABLE IF EXISTS resume_editor_sessions');
  database.exec('DROP TABLE IF EXISTS resume_document_revisions');

  const retiredColumns = {
    resume_drafts: [
      'document_format',
      'document_object_key',
      'document_sha256',
      'document_revision',
      'semantic_index_status',
    ],
    resume_versions: ['document_object_key', 'document_sha256', 'document_revision'],
    generation_snapshots: ['document_object_key', 'document_sha256', 'document_revision'],
  };
  Object.entries(retiredColumns).forEach(([table, names]) => {
    let existing = columns(table).map((item) => item.name);
    names.forEach((name) => {
      if (!existing.includes(name)) return;
      database.exec(`ALTER TABLE ${table} DROP COLUMN ${name}`);
      existing = existing.filter((item) => item !== name);
    });
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

/**
 * 变更记录存储治理：
 * 1. 旧的局部文字变更从“双份完整简历”压缩为节点前后差量；
 * 2. 已成版或已撤销且超过保留期的 payload 只保留操作摘要。
 *
 * 行本身不删除，仍可用于安全审计和数量统计；完整历史正文由不可变版本承载。
 */
function compactResumeChangeEvents(database) {
  const rows = database
    .prepare(
      `SELECT id, change_type, scope_type, scope_id, before_json, after_json,
              snapshot_version_id, reverted_at, created_at
       FROM resume_change_events`,
    )
    .all();
  const update = database.prepare(
    'UPDATE resume_change_events SET before_json = ?, after_json = ? WHERE id = ?',
  );
  const configuredDays = Number.parseInt(
    process.env.RESUME_CHANGE_PAYLOAD_RETENTION_DAYS || '7',
    10,
  );
  const retentionDays = Number.isFinite(configuredDays) && configuredDays >= 1
    ? configuredDays
    : 7;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let compacted = 0;
  let archived = 0;
  let bytesSaved = 0;

  database.exec('BEGIN IMMEDIATE');
  try {
    rows.forEach((row) => {
      const originalBytes = Buffer.byteLength(row.before_json || '')
        + Buffer.byteLength(row.after_json || '');
      const beforePayload = parsePayload(row.before_json);
      const afterPayload = parsePayload(row.after_json);
      if (isArchivedPayload(beforePayload) || isArchivedPayload(afterPayload)) return;

      const createdAt = Date.parse(row.created_at || '');
      const canArchive = Boolean(row.snapshot_version_id || row.reverted_at)
        && Number.isFinite(createdAt)
        && createdAt < cutoff;
      if (canArchive) {
        const beforeJson = JSON.stringify(archivedPayload());
        const afterJson = JSON.stringify(archivedPayload(afterPayload.label));
        update.run(beforeJson, afterJson, row.id);
        archived += 1;
        bytesSaved += Math.max(
          0,
          originalBytes - Buffer.byteLength(beforeJson) - Buffer.byteLength(afterJson),
        );
        return;
      }

      const compact = compactLegacyEvent(row);
      if (!compact) return;
      update.run(compact.before_json, compact.after_json, row.id);
      compacted += 1;
      bytesSaved += Math.max(
        0,
        originalBytes
          - Buffer.byteLength(compact.before_json)
          - Buffer.byteLength(compact.after_json),
      );
    });
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  if (compacted || archived) {
    console.info(
      `[resume-change] compacted=${compacted} archived=${archived} saved_bytes=${bytesSaved}`,
    );
  }
  return { compacted, archived, bytesSaved, retentionDays };
}

function reconcileAiTaskLifecycle(database) {
  const tasks = database
    .prepare(
      `SELECT * FROM ai_tasks
       WHERE status IN ('active','understanding','planning','validated','waiting_fact')`,
    )
    .all();
  const update = database.prepare(
    'UPDATE ai_tasks SET state_json = ?, status = ?, updated_at = ? WHERE id = ?',
  );
  tasks.forEach((task) => {
    if (task.active_proposal_id) {
      update.run(task.state_json || '{}', 'waiting_apply', nowIso(), task.id);
      return;
    }
    const messages = database
      .prepare(
        `SELECT role, model_metadata_json
         FROM ai_messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(task.conversation_id)
      .filter((message) => {
        try {
          return JSON.parse(message.model_metadata_json || '{}').task_id === task.id;
        } catch (_) {
          return false;
        }
      });
    const last = messages[messages.length - 1];
    let state = {};
    try {
      state = JSON.parse(task.state_json || '{}');
    } catch (_) {
      state = {};
    }
    if (last && last.role === 'assistant') {
      let metadata = {};
      try {
        metadata = JSON.parse(last.model_metadata_json || '{}');
      } catch (_) {
        metadata = {};
      }
      const clarifying = metadata.result_type === 'CLARIFICATION_REQUIRED';
      const confirmingPlan = metadata.result_type === 'PLAN_CONFIRMATION_REQUIRED';
      const recoveredStatus = clarifying
        ? 'clarifying'
        : confirmingPlan
          ? 'confirming_plan'
          : 'completed';
      update.run(
        JSON.stringify({
          ...state,
          phase: recoveredStatus,
        }),
        recoveredStatus,
        nowIso(),
        task.id,
      );
      return;
    }
    update.run(
      JSON.stringify({
        ...state,
        phase: 'failed',
        last_error: {
          code: 'REQUEST_INTERRUPTED',
          message: '服务重启前的请求未完成',
          at: nowIso(),
        },
      }),
      'failed',
      nowIso(),
      task.id,
    );
  });
}

function ensureResumeChangeHistorySchema(database) {
  const columns = database.prepare('PRAGMA table_info(resume_change_events)').all();
  if (!columns.some((column) => column.name === 'undo_expired_at')) {
    database.exec('ALTER TABLE resume_change_events ADD COLUMN undo_expired_at TEXT');
  }
  if (!columns.some((column) => column.name === 'redo_invalidated_at')) {
    database.exec('ALTER TABLE resume_change_events ADD COLUMN redo_invalidated_at TEXT');
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS ix_change_events_undo
      ON resume_change_events(
        project_id, owner_id, snapshot_version_id, reverted_at,
        undo_expired_at, redo_invalidated_at, created_at
      );
    DROP TRIGGER IF EXISTS trg_resume_change_history_window;
    CREATE TRIGGER trg_resume_change_history_window
    AFTER INSERT ON resume_change_events
    BEGIN
      UPDATE resume_change_events
      SET redo_invalidated_at = NEW.created_at
      WHERE project_id = NEW.project_id
        AND owner_id = NEW.owner_id
        AND id <> NEW.id
        AND reverted_at IS NOT NULL
        AND redo_invalidated_at IS NULL;

      UPDATE resume_change_events
      SET undo_expired_at = NEW.created_at
      WHERE id IN (
        SELECT id
        FROM resume_change_events
        WHERE project_id = NEW.project_id
          AND owner_id = NEW.owner_id
          AND snapshot_version_id IS NULL
          AND reverted_at IS NULL
          AND undo_expired_at IS NULL
        ORDER BY draft_revision DESC, id DESC
        LIMIT -1 OFFSET 5
      );
    END;
  `);
  database.exec(`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY project_id, owner_id
               ORDER BY draft_revision DESC, id DESC
             ) AS position
      FROM resume_change_events
      WHERE snapshot_version_id IS NULL
        AND reverted_at IS NULL
        AND undo_expired_at IS NULL
    )
    UPDATE resume_change_events
    SET undo_expired_at = COALESCE(undo_expired_at, created_at)
    WHERE id IN (SELECT id FROM ranked WHERE position > 5);
  `);
}

function migrateCurrentResumeDocuments(database) {
  const containsLegacyAiScope = (value) => {
    if (!value || typeof value !== 'object') return false;
    if (
      !Array.isArray(value)
      && value.attributes
      && String(value.attributes['data-ai-scope'] || '') === 'true'
    ) {
      return true;
    }
    return Object.values(value).some(containsLegacyAiScope);
  };
  const rows = database
    .prepare('SELECT id, project_id, owner_id, resume_json, revision FROM resume_drafts')
    .all();
  const update = database.prepare(
    'UPDATE resume_drafts SET resume_json = ?, revision = ?, updated_at = ? WHERE id = ?',
  );
  let migrated = 0;
  rows.forEach((row) => {
    try {
      const current = JSON.parse(row.resume_json || '{}');
      // 只迁移明确带有旧版整体 AI 范围标记的当前草稿。普通文档即使
      // 序列化格式或字段顺序不同，也不能因此产生一次无意义的新修订。
      if (!containsLegacyAiScope(current)) return;
      const normalized = ResumeDom.toResumeDocument(current);
      const serialized = JSON.stringify(normalized);
      update.run(serialized, row.revision + 1, nowIso(), row.id);
      database.prepare(
        `UPDATE ai_action_requests
         SET status = 'stale'
         WHERE action_type = 'RESUME_REWRITE_PROPOSAL'
           AND status IN ('proposed','awaiting_confirmation')
           AND conversation_id IN (
             SELECT id FROM ai_conversations
             WHERE project_id = ? AND owner_id = ?
           )`,
      ).run(row.project_id, row.owner_id);
      migrated += 1;
    } catch (error) {
      console.error(
        `[resume-document] migration skipped draft=${row.id} code=${error.code || 'INVALID_DOCUMENT'}`,
      );
    }
  });
  if (migrated) {
    console.info(`[resume-document] migrated_current_drafts=${migrated}`);
  }
  return { migrated };
}

function getDb() {
  if (db) return db;
  ensureDir();
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  ensureResumeChangeHistorySchema(db);
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
  removeRetiredDocumentEditorSchema(db);
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
  migrateCurrentResumeDocuments(db);
  reconcileAiTaskLifecycle(db);
  compactResumeChangeEvents(db);
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
  compactResumeChangeEvents,
  migrateCurrentResumeDocuments,
  reset,
  DB_PATH,
};
