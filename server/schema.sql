-- 简历星球 · 数据模型
-- 对应 TECH.md 第 7 节「数据模型」与第 7.3 节「关键约束」。
-- 所有业务表包含 id、owner_id、created_at、updated_at；软删除表另有 deleted_at。
-- 时间统一为 UTC ISO 8601，ID 使用 UUIDv7。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- 可编辑实体

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT,
  phone         TEXT,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_projects (
  id                          TEXT PRIMARY KEY,
  owner_id                    TEXT NOT NULL REFERENCES users(id),
  name                        TEXT NOT NULL,
  current_profile_id          TEXT REFERENCES profiles(id),
  current_template_version_id TEXT REFERENCES template_versions(id),
  current_job_id              TEXT REFERENCES target_jobs(id),
  revision                    INTEGER NOT NULL DEFAULT 1,
  status                      TEXT NOT NULL DEFAULT 'active',
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES resume_projects(id),
  owner_id     TEXT NOT NULL REFERENCES users(id),
  basics_json  TEXT NOT NULL DEFAULT '{}',
  summary      TEXT NOT NULL DEFAULT '',
  revision     INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiences (
  id           TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL REFERENCES profiles(id),
  owner_id     TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL,           -- work | project | education | skill
  organization TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  start_date   TEXT NOT NULL DEFAULT '',
  end_date     TEXT NOT NULL DEFAULT '',
  is_current   INTEGER NOT NULL DEFAULT 0,
  description  TEXT NOT NULL DEFAULT '',
  meta_json    TEXT NOT NULL DEFAULT '{}',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  revision     INTEGER NOT NULL DEFAULT 1,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_definitions (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT REFERENCES users(id),   -- 系统模板为 NULL
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL,               -- system | custom
  status           TEXT NOT NULL DEFAULT 'ready',
  template_upload_id TEXT REFERENCES uploads(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_versions (
  id                  TEXT PRIMARY KEY,
  template_id         TEXT NOT NULL REFERENCES template_definitions(id),
  owner_id            TEXT REFERENCES users(id),
  version             INTEGER NOT NULL DEFAULT 1,
  schema_json         TEXT NOT NULL DEFAULT '{}',
  preview_artifact_id TEXT REFERENCES artifacts(id),
  parser_version      TEXT NOT NULL DEFAULT 'parser-1',
  checksum            TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  UNIQUE (template_id, version)
);

CREATE TABLE IF NOT EXISTS target_jobs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES resume_projects(id),
  owner_id       TEXT NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL DEFAULT '',
  company        TEXT NOT NULL DEFAULT '',
  confirmed_text TEXT NOT NULL DEFAULT '',
  ocr_text       TEXT NOT NULL DEFAULT '',
  analysis_json  TEXT NOT NULL DEFAULT '{}',
  revision       INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'draft',  -- draft | confirmed | discarded
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_files (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES target_jobs(id),
  owner_id       TEXT NOT NULL REFERENCES users(id),
  upload_id      TEXT REFERENCES uploads(id),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  ocr_raw_text   TEXT NOT NULL DEFAULT '',
  ocr_confidence REAL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  object_key    TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  mime_type     TEXT NOT NULL DEFAULT '',
  size          INTEGER NOT NULL DEFAULT 0,
  sha256        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'uploading', -- uploading|quarantined|scanning|ready|failed
  expires_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_imports (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES resume_projects(id),
  upload_id            TEXT NOT NULL REFERENCES uploads(id),
  owner_id             TEXT NOT NULL REFERENCES users(id),
  entry_context        TEXT NOT NULL DEFAULT 'workspace', -- workspace | template_picker
  status               TEXT NOT NULL DEFAULT 'uploaded',
  detected_format      TEXT NOT NULL DEFAULT '',
  page_count           INTEGER,
  parser_version       TEXT NOT NULL DEFAULT '',
  model_version        TEXT NOT NULL DEFAULT '',
  content_candidate    TEXT NOT NULL DEFAULT '{}',
  layout_candidate     TEXT NOT NULL DEFAULT '{}',
  quality_report       TEXT NOT NULL DEFAULT '{}',
  warning_codes        TEXT NOT NULL DEFAULT '[]',
  preview_artifact_ids TEXT NOT NULL DEFAULT '[]',
  applied_mode         TEXT,
  applied_template_version_id TEXT REFERENCES template_versions(id),
  applied_version_id   TEXT REFERENCES resume_versions(id),
  error_code           TEXT,
  error_message_safe   TEXT,
  expires_at           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- ---------------------------------------------------------------- AI 对话层

CREATE TABLE IF NOT EXISTS ai_conversations (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES resume_projects(id),
  owner_id          TEXT NOT NULL REFERENCES users(id),
  active_scope_type TEXT,
  active_scope_id   TEXT,
  status            TEXT NOT NULL DEFAULT 'active', -- active|closed
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_tasks (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES ai_conversations(id),
  project_id         TEXT NOT NULL REFERENCES resume_projects(id),
  owner_id           TEXT NOT NULL REFERENCES users(id),
  scope_type         TEXT NOT NULL,
  scope_id           TEXT,
  goal               TEXT NOT NULL DEFAULT '',
  state_json         TEXT NOT NULL DEFAULT '{}',
  active_proposal_id TEXT,
  status             TEXT NOT NULL DEFAULT 'understanding', -- understanding|clarifying|planning|validated|waiting_apply|completed|failed|canceled
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES ai_conversations(id),
  task_id              TEXT REFERENCES ai_tasks(id),
  owner_id            TEXT NOT NULL REFERENCES users(id),
  role                TEXT NOT NULL,          -- user | assistant
  content             TEXT NOT NULL DEFAULT '',
  scope_type          TEXT,                   -- DATA_PROFILE|DATA_JOB|RESUME_BLOCK|RESUME_DOCUMENT
  scope_id            TEXT,
  scope_revision      INTEGER,
  model_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_action_requests (
  id                   TEXT PRIMARY KEY,
  conversation_id      TEXT REFERENCES ai_conversations(id),
  message_id           TEXT REFERENCES ai_messages(id),
  owner_id             TEXT NOT NULL REFERENCES users(id),
  action_type          TEXT NOT NULL,
  target_type          TEXT,
  target_id            TEXT,
  payload_json         TEXT NOT NULL DEFAULT '{}',
  requires_user_action INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'proposed', -- proposed|awaiting_confirmation|superseded|stale|applied|rejected|failed|reverted
  expected_revision    INTEGER,
  policy_version       TEXT NOT NULL DEFAULT 'policy-v2',
  applied_at           TEXT,
  rejected_at          TEXT,
  reverted_at          TEXT,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS change_receipts (
  id                TEXT PRIMARY KEY,
  action_request_id TEXT REFERENCES ai_action_requests(id),
  owner_id          TEXT NOT NULL REFERENCES users(id),
  resource_type     TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  before_json       TEXT NOT NULL DEFAULT '{}',
  after_json        TEXT NOT NULL DEFAULT '{}',
  mutation_id       TEXT NOT NULL,
  reverted_at       TEXT,
  created_at        TEXT NOT NULL
);

-- ---------------------------------------------------------------- 草稿与变更

CREATE TABLE IF NOT EXISTS resume_drafts (
  id                         TEXT PRIMARY KEY,
  project_id                 TEXT NOT NULL UNIQUE REFERENCES resume_projects(id),
  owner_id                   TEXT NOT NULL REFERENCES users(id),
  resume_json                TEXT NOT NULL DEFAULT '{}',
  base_version_id            TEXT REFERENCES resume_versions(id),
  revision                   INTEGER NOT NULL DEFAULT 1,
  has_unsnapshotted_changes  INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_change_events (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES resume_projects(id),
  owner_id       TEXT NOT NULL REFERENCES users(id),
  draft_revision INTEGER NOT NULL DEFAULT 1,
  change_type    TEXT NOT NULL,
  scope_type     TEXT,
  scope_id       TEXT,
  before_json    TEXT NOT NULL DEFAULT '{}',
  after_json     TEXT NOT NULL DEFAULT '{}',
  actor_type     TEXT NOT NULL DEFAULT 'user',  -- user | ai | system
  mutation_id    TEXT NOT NULL,
  snapshot_version_id TEXT REFERENCES resume_versions(id), -- 成版后回填，为空表示尚未成版
  reverted_at    TEXT,
  undo_expired_at TEXT, -- 超出最近 5 步后不再进入撤销栈，但仍保留审计记录
  redo_invalidated_at TEXT, -- 撤销后产生新修改时清空重做分支
  created_at     TEXT NOT NULL,
  UNIQUE (project_id, mutation_id)
);

-- ---------------------------------------------------------------- 版本、生成与快照

CREATE TABLE IF NOT EXISTS resume_versions (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES resume_projects(id),
  owner_id               TEXT NOT NULL REFERENCES users(id),
  version_no             INTEGER NOT NULL,
  kind                   TEXT NOT NULL,          -- manual | generated | imported
  name                   TEXT NOT NULL DEFAULT '',
  base_version_id        TEXT REFERENCES resume_versions(id),
  profile_payload        TEXT NOT NULL DEFAULT '{}',
  template_payload       TEXT NOT NULL DEFAULT '{}',
  job_payload            TEXT NOT NULL DEFAULT '{}',
  resume_payload         TEXT NOT NULL DEFAULT '{}',
  change_summary_json    TEXT NOT NULL DEFAULT '{}',
  artifact_refs_json     TEXT NOT NULL DEFAULT '{}',
  generation_snapshot_id TEXT REFERENCES generation_snapshots(id),
  status                 TEXT NOT NULL DEFAULT 'complete', -- complete | partial
  created_by             TEXT NOT NULL DEFAULT 'user',
  created_at             TEXT NOT NULL,
  UNIQUE (project_id, version_no)
);

CREATE TABLE IF NOT EXISTS generation_snapshots (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES resume_projects(id),
  owner_id          TEXT NOT NULL REFERENCES users(id),
  generation_no     INTEGER NOT NULL,
  profile_payload   TEXT NOT NULL DEFAULT '{}',
  resume_input_payload TEXT NOT NULL DEFAULT '{}',
  template_payload  TEXT NOT NULL DEFAULT '{}',
  job_payload       TEXT NOT NULL DEFAULT '{}',
  generation_config TEXT NOT NULL DEFAULT '{}',
  input_hash        TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|complete|failed
  created_by        TEXT NOT NULL DEFAULT 'user',
  created_at        TEXT NOT NULL,
  UNIQUE (project_id, generation_no)
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id                 TEXT PRIMARY KEY,
  snapshot_id        TEXT NOT NULL UNIQUE REFERENCES generation_snapshots(id),
  owner_id           TEXT NOT NULL REFERENCES users(id),
  status             TEXT NOT NULL DEFAULT 'queued', -- validating|queued|running|partial|succeeded|failed|canceled
  current_step       TEXT NOT NULL DEFAULT 'queued',
  progress           INTEGER NOT NULL DEFAULT 0,
  model_provider     TEXT NOT NULL DEFAULT 'local-rule-engine',
  model_name         TEXT NOT NULL DEFAULT 'resume-rule-v1',
  prompt_version     TEXT NOT NULL DEFAULT 'resume-harness-v16-message-proposal',
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  started_at         TEXT,
  finished_at        TEXT,
  error_code         TEXT,
  error_message_safe TEXT,
  token_usage_json   TEXT NOT NULL DEFAULT '{}',
  cost_amount        REAL NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_outputs (
  id              TEXT PRIMARY KEY,
  snapshot_id     TEXT NOT NULL UNIQUE REFERENCES generation_snapshots(id),
  owner_id        TEXT NOT NULL REFERENCES users(id),
  resume_json     TEXT NOT NULL DEFAULT '{}',
  explanation_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id                 TEXT PRIMARY KEY,
  snapshot_id        TEXT REFERENCES generation_snapshots(id),
  version_id         TEXT REFERENCES resume_versions(id),
  document_import_id TEXT REFERENCES document_imports(id),
  owner_id           TEXT NOT NULL REFERENCES users(id),
  type               TEXT NOT NULL,                    -- pdf | docx | html | thumbnail | import_preview
  object_key         TEXT NOT NULL,
  mime_type          TEXT NOT NULL DEFAULT '',
  size               INTEGER NOT NULL DEFAULT 0,
  sha256             TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'ready',
  expires_at         TEXT,
  created_at         TEXT NOT NULL
);
-- artifacts 至少关联 snapshot_id、version_id 或 document_import_id 之一
CREATE UNIQUE INDEX IF NOT EXISTS ux_artifacts_scope ON artifacts(snapshot_id, type, sha256);

-- ---------------------------------------------------------------- 基础设施

CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT REFERENCES users(id),
  actor_id      TEXT REFERENCES users(id),
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id   TEXT NOT NULL DEFAULT '',
  request_id    TEXT NOT NULL DEFAULT '',
  ip_hash       TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);

-- 幂等键：owner_id + key 唯一（TECH 8.4）
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  key           TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id   TEXT NOT NULL DEFAULT '',
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  UNIQUE (owner_id, key)
);

-- outbox：先提交数据库事件，再投递队列，避免「有快照无任务」（TECH 8.1 / 18.2）
CREATE TABLE IF NOT EXISTS outbox_events (
  id             TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
  attempts       INTEGER NOT NULL DEFAULT 0,
  available_at   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  processed_at   TEXT
);

-- 润色建议：AI 只产出方案，应用前不覆盖原文（PRD §6.1）
CREATE TABLE IF NOT EXISTS polish_suggestions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES resume_projects(id),
  owner_id      TEXT NOT NULL REFERENCES users(id),
  scope_type    TEXT NOT NULL,
  scope_id      TEXT,
  field_path    TEXT NOT NULL DEFAULT '',
  intent        TEXT NOT NULL DEFAULT '',
  original      TEXT NOT NULL DEFAULT '',
  suggestion    TEXT NOT NULL DEFAULT '',
  diff_json     TEXT NOT NULL DEFAULT '[]',
  pending_json  TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'proposed', -- proposed|applied|rejected
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------- 索引

CREATE INDEX IF NOT EXISTS ix_projects_owner ON resume_projects(owner_id);
CREATE INDEX IF NOT EXISTS ix_profiles_project ON profiles(project_id);
CREATE INDEX IF NOT EXISTS ix_experiences_profile ON experiences(profile_id, deleted_at);
CREATE INDEX IF NOT EXISTS ix_jobs_project ON target_jobs(project_id);
CREATE INDEX IF NOT EXISTS ix_job_files_job ON job_files(job_id);
CREATE INDEX IF NOT EXISTS ix_document_imports_project ON document_imports(project_id, created_at);
CREATE INDEX IF NOT EXISTS ix_document_imports_upload ON document_imports(upload_id, status);
CREATE INDEX IF NOT EXISTS ix_ai_conversations_owner_project
  ON ai_conversations(owner_id, project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS ai_messages_conv ON ai_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ai_tasks_scope ON ai_tasks(conversation_id, scope_type, scope_id, status, updated_at);
CREATE INDEX IF NOT EXISTS ix_ai_tasks_owner_conversation
  ON ai_tasks(owner_id, conversation_id, status, updated_at);
CREATE INDEX IF NOT EXISTS ix_actions_owner_status ON ai_action_requests(owner_id, status);
CREATE INDEX IF NOT EXISTS ix_change_events_project ON resume_change_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS ix_change_events_retention
  ON resume_change_events(snapshot_version_id, reverted_at, created_at);
CREATE INDEX IF NOT EXISTS ix_versions_project ON resume_versions(project_id, version_no);
CREATE INDEX IF NOT EXISTS ix_snapshots_project ON generation_snapshots(project_id, generation_no);
CREATE INDEX IF NOT EXISTS ix_artifacts_version ON artifacts(version_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS ux_version_thumbnail
  ON artifacts(version_id, type)
  WHERE version_id IS NOT NULL AND type = 'thumbnail';
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON outbox_events(status, available_at);

-- ---------------------------------------------------------------- 冻结约束
-- resume_versions 与 generation_snapshots 的冻结 payload 禁止 UPDATE（TECH 7.3）。
-- 状态变化通过受限服务使用独立的 *_status 字段或事件表完成。

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
