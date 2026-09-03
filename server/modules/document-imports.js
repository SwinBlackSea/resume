'use strict';
/**
 * 统一“从文件导入”后端接口。
 *
 * 识别任务只产生临时完整文档候选；用户确认前不修改当前简历或资料。
 * 应用时保存单一 ResumeDocument，并自动创建一个不可变历史版本。
 * 全程以草稿 revision、幂等键和 owner_id 重新校验。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, sha256, problem, sseOpen, sseWrite } = require('../lib/util');
const { withIdempotency } = require('../lib/idempotency');
const audit = require('../lib/audit');
const queue = require('../lib/queue');
const events = require('../lib/events');
const policy = require('../lib/policy');
const ResumeDom = require('../../resume-dom');
const { constants } = require('../lib/document-recognition');

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch (_) {
    return fallback;
  }
}

function loadProject(projectId, user) {
  const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
    projectId,
    user.id,
  ]);
  if (!project) throw problem.notFound('项目不存在');
  return project;
}

function loadImport(importId, user) {
  const item = db.get('SELECT * FROM document_imports WHERE id = ? AND owner_id = ?', [
    importId,
    user.id,
  ]);
  if (!item) throw problem.notFound('导入任务不存在');
  return item;
}

function toImportView(row) {
  const quality = parseJson(row.quality_report, {});
  const contentCandidate = parseJson(row.content_candidate, {});
  const documentCandidate = contentCandidate.resume_json
    ? {
        ...contentCandidate,
        resume_json: ResumeDom.toResumeDocument(contentCandidate.resume_json),
      }
    : contentCandidate;
  const upload = db.get(
    'SELECT original_name, mime_type, size FROM uploads WHERE id = ? AND owner_id = ?',
    [row.upload_id, row.owner_id],
  );
  return {
    id: row.id,
    project_id: row.project_id,
    upload_id: row.upload_id,
    file: upload
      ? {
          name: upload.original_name,
          mime_type: upload.mime_type,
          size: upload.size,
        }
      : null,
    entry_context: row.entry_context,
    status: row.status,
    detected_format: row.detected_format,
    page_count: row.page_count,
    parser_version: row.parser_version,
    model_version: row.model_version,
    document_candidate: documentCandidate,
    quality_report: quality,
    warning_codes: parseJson(row.warning_codes, []),
    preview_artifact_ids: parseJson(row.preview_artifact_ids, []),
    applied_mode: row.applied_mode,
    applied_version_id: row.applied_version_id,
    error_code: row.error_code,
    error_message: row.error_message_safe,
    can_review: row.status === 'needs_review',
    can_apply: row.status === 'ready' && quality.safe_to_review !== false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    events_url: `/api/v1/document-imports/${row.id}/events`,
  };
}

function createImportedVersion({
  user,
  project,
  draft,
  resume,
  upload,
  changeId,
}) {
  const profile = project.current_profile_id
    ? db.get('SELECT * FROM profiles WHERE id = ? AND owner_id = ?', [
        project.current_profile_id,
        user.id,
      ])
    : null;
  const experiences = profile
    ? db.all(
        'SELECT * FROM experiences WHERE profile_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC',
        [profile.id],
      ).map((row) => ({
        id: row.id,
        type: row.type,
        organization: row.organization,
        title: row.title,
        start_date: row.start_date,
        end_date: row.end_date,
        is_current: Boolean(row.is_current),
        description: row.description,
        meta: parseJson(row.meta_json, {}),
        revision: row.revision,
      }))
    : [];
  const job = project.current_job_id
    ? db.get('SELECT * FROM target_jobs WHERE id = ? AND owner_id = ?', [
        project.current_job_id,
        user.id,
      ])
    : null;
  const jobPayload = job
    ? {
        id: job.id,
        title: job.title,
        company: job.company,
        confirmed_text: job.confirmed_text,
        analysis: parseJson(job.analysis_json, {}),
        revision: job.revision,
        status: job.status,
        files_count: db.get('SELECT COUNT(*) AS total FROM job_files WHERE job_id = ?', [job.id])
          .total,
      }
    : {};
  const profileBasics = profile ? parseJson(profile.basics_json, {}) : {};
  const profilePayload = profile
    ? {
        basics: profileBasics,
        summary: profile.summary,
        experiences,
        revision: profile.revision,
      }
    : {};
  const versionId = uuidv7();
  const versionNo = db.nextSequence('resume_versions', project.id, 'version_no');
  const baseName = upload.original_name.replace(/\.[^.]+$/, '') || '导入简历';
  const createdAt = nowIso();
  db.run(
    `INSERT INTO resume_versions
     (id, project_id, owner_id, version_no, kind, name, base_version_id,
      profile_payload, template_payload, job_payload, resume_payload, change_summary_json,
      artifact_refs_json, generation_snapshot_id, status, created_by, created_at)
     VALUES (?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?, ?, ?, '{}', NULL, 'complete', 'user', ?)`,
    [
      versionId,
      project.id,
      user.id,
      versionNo,
      `导入的简历 · ${baseName}`.slice(0, 64),
      draft.base_version_id,
      JSON.stringify(profilePayload),
      JSON.stringify({}),
      JSON.stringify(jobPayload),
      JSON.stringify(resume),
      JSON.stringify({
        changes: ['从文件导入完整简历'],
        list_summary: '保留导入时的完整文档',
        profile_data: profile
          ? `${profileBasics.name || ''}｜${profileBasics.city || ''}；${experiences.length} 条资料记录`
          : '未使用个人资料',
        job_data: job ? `${job.title}｜${job.company || ''}｜当前岗位资料` : '未设置岗位',
        compare_note: '',
      }),
      createdAt,
    ],
  );
  // 完整导入会替换当前草稿；此前尚未保存的操作已被这次替换覆盖，不再继续占用待保存列表。
  db.run(
    `UPDATE resume_change_events SET reverted_at = ?
     WHERE project_id = ? AND owner_id = ? AND id <> ?
       AND reverted_at IS NULL AND snapshot_version_id IS NULL`,
    [createdAt, project.id, user.id, changeId],
  );
  db.run(
    'UPDATE resume_change_events SET snapshot_version_id = ? WHERE id = ?',
    [versionId, changeId],
  );
  db.run(
    `UPDATE resume_drafts
     SET base_version_id = ?, has_unsnapshotted_changes = 0, updated_at = ?
     WHERE id = ?`,
    [versionId, createdAt, draft.id],
  );
  return { id: versionId, version_no: versionNo };
}

function keepAlive(res) {
  const timer = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(timer);
      return;
    }
    res.write(': keepalive\n\n');
  }, 15000);
  if (timer.unref) timer.unref();
  res.on('close', () => clearInterval(timer));
}

const routes = [
  {
    method: 'GET',
    pattern: '/projects/:id/document-imports',
    handler: ({ params, user, query }) => {
      const project = loadProject(params.id, user);
      const requestedLimit = Number(query.get('limit') || 10);
      const limit = Math.max(1, Math.min(20, Number.isFinite(requestedLimit) ? requestedLimit : 10));
      const rows = db.all(
        `SELECT * FROM document_imports
         WHERE project_id = ? AND owner_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        [project.id, user.id, limit],
      );
      return { items: rows.map(toImportView) };
    },
  },
  {
    method: 'POST',
    pattern: '/projects/:id/document-imports',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'document_import', () =>
        db.tx(() => {
          const project = loadProject(params.id, user);
          const upload = db.get('SELECT * FROM uploads WHERE id = ? AND owner_id = ?', [
            body.upload_id,
            user.id,
          ]);
          if (!upload) throw problem.notFound('上传文件不存在');
          if (upload.status !== 'ready') {
            throw problem.unprocessable('FILE_UNSAFE', '文件还没有通过安全检查');
          }
          const entryContext = body.entry_context || 'workspace';
          if (!['workspace', 'template_picker'].includes(entryContext)) {
            throw problem.badRequest('entry_context 不合法');
          }
          const extension = (upload.original_name.split('.').pop() || '').toLowerCase();
          if (!constants.SUPPORTED_FORMATS.has(extension)) {
            throw problem.unprocessable(
              'DOCUMENT_FORMAT_UNSUPPORTED',
              '目前支持 PDF、DOCX、DOC、PNG、JPG 和 WEBP',
            );
          }
          const active = db.get(
            `SELECT * FROM document_imports
             WHERE project_id = ? AND upload_id = ? AND owner_id = ?
               AND status NOT IN ('failed','applied')
             ORDER BY created_at DESC LIMIT 1`,
            [project.id, upload.id, user.id],
          );
          if (active) return { ...toImportView(active), reused: true };

          const id = uuidv7();
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          db.run(
            `INSERT INTO document_imports
             (id, project_id, upload_id, owner_id, entry_context, status, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'uploaded', ?, ?, ?)`,
            [id, project.id, upload.id, user.id, entryContext, expiresAt, nowIso(), nowIso()],
          );
          queue.publish({
            aggregateType: 'document_import',
            aggregateId: id,
            eventType: 'document-import.recognition.requested',
          });
          audit.log({
            ownerId: user.id,
            action: 'document_import_started',
            resourceType: 'document_import',
            resourceId: id,
            requestId,
            ipHash,
            metadata: {
              format: extension,
              size: upload.size,
              entry_context: entryContext,
            },
          });
          return toImportView(db.get('SELECT * FROM document_imports WHERE id = ?', [id]));
        }),
      ),
  },
  {
    method: 'GET',
    pattern: '/document-imports/:id',
    handler: ({ params, user }) => toImportView(loadImport(params.id, user)),
  },
  {
    method: 'GET',
    pattern: '/document-imports/:id/events',
    sse: true,
    handler: ({ params, user, res }) => {
      const item = loadImport(params.id, user);
      sseOpen(res);
      sseWrite(res, 'progress', {
        id: item.id,
        status: item.status,
        error_code: item.error_code,
        error_message: item.error_message_safe,
        warning_codes: parseJson(item.warning_codes, []),
      });
      if (['needs_review', 'ready', 'applied', 'failed'].includes(item.status)) {
        setTimeout(() => {
          if (!res.writableEnded) res.end();
        }, 50);
        return { __sse: true };
      }
      const unsubscribe = events.subscribe(item.id, (payload) => {
        sseWrite(res, 'progress', payload);
        if (['needs_review', 'ready', 'applied', 'failed'].includes(payload.status)) {
          setTimeout(() => {
            unsubscribe();
            if (!res.writableEnded) res.end();
          }, 50);
        }
      });
      keepAlive(res);
      return { __sse: true };
    },
  },
  {
    method: 'POST',
    pattern: '/document-imports/:id/review',
    handler: ({ params, body, user, requestId, ipHash }) =>
      db.tx(() => {
        const item = loadImport(params.id, user);
        if (!['needs_review', 'ready'].includes(item.status)) {
          throw problem.conflict('DOCUMENT_IMPORT_NOT_REVIEWABLE', '识别结果还不能确认');
        }
        const quality = parseJson(item.quality_report, {});
        if (quality.safe_to_review === false) {
          throw problem.unprocessable(
            'DOCUMENT_QUALITY_BLOCKED',
            '当前文件没有得到可安全使用的识别结果，请重新识别或更换文件',
            { blocking_codes: quality.blocking_codes || [] },
          );
        }
        if (body.accepted !== true) throw problem.badRequest('请明确确认识别结果');

        let contentCandidate = parseJson(item.content_candidate, {});
        let corrected = false;
        if (body.resume_json) {
          const resume = ResumeDom.toResumeDocument(body.resume_json);
          contentCandidate = {
            ...contentCandidate,
            plain_text: ResumeDom.plainText(resume),
            resume_json: resume,
            reviewed_by_user: true,
          };
          corrected = true;
        }
        db.run(
          `UPDATE document_imports
           SET status = 'ready', content_candidate = ?, updated_at = ?
           WHERE id = ?`,
          [JSON.stringify(contentCandidate), nowIso(), item.id],
        );
        audit.log({
          ownerId: user.id,
          action: 'document_import_reviewed',
          resourceType: 'document_import',
          resourceId: item.id,
          requestId,
          ipHash,
          metadata: { corrected },
        });
        return {
          ...toImportView(db.get('SELECT * FROM document_imports WHERE id = ?', [item.id])),
          idempotent_replay: item.status === 'ready' && !corrected,
        };
      }),
  },
  {
    method: 'POST',
    pattern: '/document-imports/:id/apply',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'document_import_apply', () =>
        db.tx(() => {
          const item = loadImport(params.id, user);
          if (item.status === 'applied') {
            return {
              id: item.id,
              status: 'applied',
              applied_mode: item.applied_mode,
              version_id: item.applied_version_id,
              idempotent_replay: true,
            };
          }
          if (item.status !== 'ready') {
            throw problem.conflict('DOCUMENT_IMPORT_NOT_READY', '请先预览并确认识别结果');
          }
          const project = loadProject(item.project_id, user);
          const draft = db.get(
            'SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?',
            [project.id, user.id],
          );
          if (!draft) throw problem.notFound('当前简历不存在');
          if (
            body.expected_draft_revision !== undefined
            && body.expected_draft_revision !== draft.revision
          ) {
            throw problem.conflict('REVISION_CONFLICT', '简历已经发生变化，请重新确认后再应用', {
              expected: body.expected_draft_revision,
              current: draft.revision,
            });
          }
          const upload = db.get('SELECT * FROM uploads WHERE id = ?', [item.upload_id]);
          const contentCandidate = parseJson(item.content_candidate, {});
          const beforeResume = ResumeDom.toResumeDocument(parseJson(draft.resume_json, {}));
          if (!contentCandidate.resume_json) {
            throw problem.unprocessable('DOCUMENT_CONTENT_MISSING', '没有可应用的完整文档');
          }
          const nextResume = ResumeDom.toResumeDocument(contentCandidate.resume_json);

          const revision = draft.revision + 1;
          db.run(
            `UPDATE resume_drafts
             SET resume_json = ?, revision = ?, has_unsnapshotted_changes = 1, updated_at = ?
             WHERE id = ?`,
            [JSON.stringify(nextResume), revision, nowIso(), draft.id],
          );
          const changeId = uuidv7();
          db.run(
            `INSERT INTO resume_change_events
             (id, project_id, owner_id, draft_revision, change_type, scope_type, scope_id,
              before_json, after_json, actor_type, mutation_id, created_at)
             VALUES (?, ?, ?, ?, 'document_import', 'RESUME_DOCUMENT', ?, ?, ?, 'user', ?, ?)`,
            [
              changeId,
              project.id,
              user.id,
              revision,
              item.id,
              JSON.stringify({
                resume_json: beforeResume,
                base_version_id: draft.base_version_id,
              }),
              JSON.stringify({
                resume_json: nextResume,
                label: '应用文件导入结果',
              }),
              body.mutation_id || uuidv7(),
              nowIso(),
            ],
          );
          const importedVersion = createImportedVersion({
            user,
            project,
            draft,
            resume: nextResume,
            upload,
            changeId,
          });
          db.run(
            `UPDATE document_imports
             SET status = ?, applied_mode = ?, applied_template_version_id = NULL,
                 applied_version_id = ?, updated_at = ?
             WHERE id = ?`,
            [
              'applied',
              'imported_resume',
              importedVersion.id,
              nowIso(),
              item.id,
            ],
          );
          events.publish(item.id, {
            id: item.id,
            status: 'applied',
            applied_mode: 'imported_resume',
            version_id: importedVersion.id,
            at: nowIso(),
          });
          audit.log({
            ownerId: user.id,
            action: 'document_import_applied',
            resourceType: 'document_import',
            resourceId: item.id,
            requestId,
            ipHash,
            metadata: {
              draft_revision: revision,
              version_id: importedVersion.id,
            },
          });
          return {
            id: item.id,
            status: 'applied',
            applied_mode: 'imported_resume',
            draft_revision: revision,
            version_id: importedVersion.id,
            change_id: changeId,
            profile_unchanged: true,
            version_created: true,
          };
        }),
      ),
  },
  {
    method: 'POST',
    pattern: '/document-imports/:id/retry',
    handler: ({ params, user }) => {
      const item = loadImport(params.id, user);
      if (item.status !== 'failed') {
        throw problem.conflict('DOCUMENT_IMPORT_NOT_RETRYABLE', '只有失败的任务可以重试');
      }
      db.run(
        `UPDATE document_imports
         SET status = 'uploaded', error_code = NULL, error_message_safe = NULL, updated_at = ?
         WHERE id = ?`,
        [nowIso(), item.id],
      );
      queue.publish({
        aggregateType: 'document_import',
        aggregateId: item.id,
        eventType: 'document-import.recognition.requested',
      });
      return { id: item.id, status: 'uploaded' };
    },
  },
  {
    method: 'POST',
    pattern: '/document-imports/:id/profile-proposal',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'document_import_profile_proposal', () =>
        db.tx(() => {
          const item = loadImport(params.id, user);
          if (!['ready', 'applied'].includes(item.status)) {
            throw problem.conflict('DOCUMENT_IMPORT_NOT_READY', '请先确认识别结果');
          }
          const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
          const entries = Object.entries(fields).filter(([field]) =>
            policy.PROFILE_WHITELIST.has(field),
          );
          if (entries.length !== 1 || Object.keys(fields).length !== 1) {
            throw problem.badRequest('每次请选择一个明确的个人基础字段');
          }
          const project = loadProject(item.project_id, user);
          const profile = db.get(
            'SELECT * FROM profiles WHERE id = ? AND owner_id = ?',
            [project.current_profile_id, user.id],
          );
          if (!profile) throw problem.notFound('个人信息不存在');
          let conversation = db.get(
            `SELECT * FROM ai_conversations
             WHERE project_id = ? AND owner_id = ? AND status = 'active'
             ORDER BY created_at DESC LIMIT 1`,
            [project.id, user.id],
          );
          if (!conversation) {
            const conversationId = uuidv7();
            db.run(
              `INSERT INTO ai_conversations
               (id, project_id, owner_id, active_scope_type, active_scope_id, status, created_at, updated_at)
               VALUES (?, ?, ?, 'DATA_PROFILE', ?, 'active', ?, ?)`,
              [conversationId, project.id, user.id, profile.id, nowIso(), nowIso()],
            );
            conversation = db.get('SELECT * FROM ai_conversations WHERE id = ?', [conversationId]);
          }
          const actionId = uuidv7();
          db.run(
            `INSERT INTO ai_action_requests
             (id, conversation_id, message_id, owner_id, action_type, target_type, target_id,
              payload_json, requires_user_action, status, expected_revision, policy_version, created_at)
             VALUES (?, ?, NULL, ?, 'PROFILE_SAVE_PROPOSAL', 'profile_basics', ?, ?,
                     1, 'awaiting_confirmation', ?, ?, ?)`,
            [
              actionId,
              conversation.id,
              user.id,
              profile.id,
              JSON.stringify({
                operation: 'update_basics',
                values: Object.fromEntries(entries),
              }),
              profile.revision,
              policy.POLICY_VERSION,
              nowIso(),
            ],
          );
          audit.log({
            ownerId: user.id,
            action: 'document_import_profile_proposed',
            resourceType: 'ai_action_request',
            resourceId: actionId,
            requestId,
            ipHash,
            metadata: { field: entries[0][0] },
          });
          return {
            id: actionId,
            requires_user_action: true,
            action_type: 'PROFILE_SAVE_PROPOSAL',
            fields: Object.fromEntries(entries),
            expected_revision: profile.revision,
            apply_url: `/api/v1/ai/actions/${actionId}/apply`,
            resume_unchanged: true,
            message: '这些内容会在你再次确认后保存到个人信息，不会自动改变当前简历。',
          };
        }),
      ),
  },
];

module.exports = {
  routes,
  toImportView,
};
