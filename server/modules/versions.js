'use strict';
/**
 * 版本模块（PRD §6.5、TECH §8.2、§6）。
 *
 * 主动保存版本：在单个事务中锁定项目与草稿，校验 revision 与 change_ids，
 * 分配下一个项目版本号，深拷贝三类输入及 Resume JSON，写入 kind=manual 的版本，
 * 再更新草稿的 base_version_id 并清除 has_unsnapshotted_changes。
 * 重复 Idempotency-Key 不得新增版本。版本快照创建后不可修改（由数据库触发器保证）。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, problem, hashJson } = require('../lib/util');
const audit = require('../lib/audit');
const { withIdempotency } = require('../lib/idempotency');
const { putObject } = require('../lib/storage');
const { renderPdf } = require('../lib/render/pdf');
const { renderDocx } = require('../lib/render/docx');
const { renderHtml } = require('../lib/render/html');
const { toVersionView } = require('./workspace');
const ResumeDom = require('../../resume-dom');

function loadProject(projectId, user) {
  const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
    projectId,
    user.id,
  ]);
  if (!project) throw problem.notFound('项目不存在');
  return project;
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch (_) {
    return fallback;
  }
}

function changeLabel(change) {
  const after = parseJson(change.after_json);
  if (after.label) return String(after.label).trim();
  if (change.change_type === 'template') return '调整简历模板';
  const beforeResume = parseJson(change.before_json).resume_json;
  const afterResume = after.resume_json;
  if (beforeResume && afterResume) {
    const diff = ResumeDom.compareDocuments(
      ResumeDom.ensureDocument(beforeResume),
      ResumeDom.ensureDocument(afterResume),
    );
    const first = diff.changes.find((item) =>
      ['added', 'removed', 'text', 'moved', 'structure'].includes(item.type));
    if (first) {
      const action = {
        added: '新增',
        removed: '删除',
        text: '修改',
        moved: '调整位置',
        structure: '调整结构',
      }[first.type];
      return `${action}${first.label}`;
    }
  }
  return '修改简历内容';
}

function contextLabel(payload, type) {
  if (!payload || !Object.keys(payload).length) return type === 'job' ? '未设置岗位' : '未选择模板';
  if (type === 'job') {
    return [payload.title, payload.company].filter(Boolean).join(' · ') || '未设置岗位';
  }
  return [payload.name, payload.version ? `第 ${payload.version} 版` : ''].filter(Boolean).join(' · ')
    || '未选择模板';
}

function currentTemplatePayload(project) {
  if (!project.current_template_version_id) return {};
  const version = db.get('SELECT * FROM template_versions WHERE id = ?', [
    project.current_template_version_id,
  ]);
  if (!version) return {};
  const definition = db.get('SELECT * FROM template_definitions WHERE id = ?', [version.template_id]);
  return {
    template_version_id: version.id,
    name: definition ? definition.name : '',
    version: version.version,
    schema: parseJson(version.schema_json),
  };
}

function currentJobPayload(project, user) {
  if (!project.current_job_id) return {};
  const job = db.get(
    'SELECT * FROM target_jobs WHERE id = ? AND project_id = ? AND owner_id = ?',
    [project.current_job_id, project.id, user.id],
  );
  if (!job) return {};
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    confirmed_text: job.confirmed_text,
    analysis: parseJson(job.analysis_json),
    revision: job.revision,
    status: job.status,
  };
}

function compareContexts(oldTemplate, oldJob, currentTemplate, currentJob) {
  const templateSignature = (payload) => ({
    template_version_id: payload && payload.template_version_id || null,
    name: payload && payload.name || '',
    version: payload && payload.version || null,
    schema: payload && payload.schema || {},
  });
  const jobSignature = (payload) => ({
    id: payload && payload.id || null,
    title: payload && payload.title || '',
    company: payload && payload.company || '',
    confirmed_text: payload && payload.confirmed_text || '',
    analysis: payload && payload.analysis || {},
    revision: payload && payload.revision || null,
    status: payload && payload.status || '',
  });
  return [
    {
      type: 'template',
      label: '简历模板',
      before: contextLabel(oldTemplate, 'template'),
      after: contextLabel(currentTemplate, 'template'),
      changed: hashJson(templateSignature(oldTemplate)) !== hashJson(templateSignature(currentTemplate)),
    },
    {
      type: 'job',
      label: '目标岗位',
      before: contextLabel(oldJob, 'job'),
      after: contextLabel(currentJob, 'job'),
      changed: hashJson(jobSignature(oldJob)) !== hashJson(jobSignature(currentJob)),
    },
  ];
}

/** 生成导出产物（PDF / DOCX / HTML），并登记到 artifacts。 */
function renderVersionArtifacts({ user, version, force = false }) {
  const resume = JSON.parse(version.resume_payload || '{}');
  const templatePayload = JSON.parse(version.template_payload || '{}');
  const template = templatePayload.schema ? templatePayload : { schema: {} };
  const existing = db.all('SELECT * FROM artifacts WHERE version_id = ?', [version.id]);
  if (existing.length && !force) {
    return existing.map((row) => ({ id: row.id, type: row.type, size: row.size }));
  }
  const created = [];
  const save = (type, buffer, mimeType) => {
    const key = `${user.id}/versions/${version.id}-${type}`;
    putObject(key, buffer);
    const id = uuidv7();
    const sha = require('../lib/util').sha256(buffer);
    db.run(
      `INSERT INTO artifacts (id, snapshot_id, version_id, owner_id, type, object_key, mime_type, size, sha256, status, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
      [id, version.id, user.id, type, key, mimeType, buffer.length, sha, nowIso()],
    );
    created.push({ id, type, size: buffer.length });
  };
  save('html', Buffer.from(renderHtml({ resume, template }), 'utf8'), 'text/html; charset=utf-8');
  const pdf = renderPdf({ resume, template });
  save('pdf', pdf.buffer, 'application/pdf');
  save(
    'docx',
    renderDocx({ resume, template }).buffer,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  db.run('UPDATE resume_versions SET artifact_refs_json = ? WHERE id = ?', [
    JSON.stringify(Object.fromEntries(created.map((item) => [item.type, item.id]))),
    version.id,
  ]);
  return created;
}

const routes = [
  {
    method: 'GET',
    pattern: '/projects/:id/versions',
    handler: ({ params, user }) => {
      const project = loadProject(params.id, user);
      const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?', [
        project.id,
        user.id,
      ]);
      return {
        items: db
          .all(
            'SELECT * FROM resume_versions WHERE project_id = ? AND owner_id = ? ORDER BY version_no DESC',
            [project.id, user.id],
          )
          .map((row) => toVersionView(row, draft ? draft.base_version_id : null)),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/projects/:id/versions',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'resume_version', () =>
        db.tx(() => {
          const project = loadProject(params.id, user);
          const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?', [
            project.id,
            user.id,
          ]);
          if (!draft) throw problem.notFound('草稿不存在');
          const profile = db.get('SELECT * FROM profiles WHERE id = ? AND owner_id = ?', [
            project.current_profile_id,
            user.id,
          ]);
          const job = project.current_job_id
            ? db.get('SELECT * FROM target_jobs WHERE id = ? AND owner_id = ?', [
                project.current_job_id,
                user.id,
              ])
            : null;
          const templateVersion = project.current_template_version_id
            ? db.get('SELECT * FROM template_versions WHERE id = ?', [
                project.current_template_version_id,
              ])
            : null;

          // revision 校验：避免用户看到的内容与快照不一致（TECH §8.2）
          if (body.draft_revision !== undefined && body.draft_revision !== draft.revision) {
            throw problem.conflict('REVISION_CONFLICT', '简历已变化，请刷新后重试', {
              expected: body.draft_revision,
              current: draft.revision,
            });
          }
          if (body.profile_revision !== undefined && body.profile_revision !== profile.revision) {
            throw problem.conflict('REVISION_CONFLICT', '个人资料已变化，请刷新后重试', {
              expected: body.profile_revision,
              current: profile.revision,
            });
          }
          if (body.job_revision !== undefined && job && body.job_revision !== job.revision) {
            throw problem.conflict('REVISION_CONFLICT', '岗位信息已变化，请刷新后重试', {
              expected: body.job_revision,
              current: job.revision,
            });
          }
          if (
            body.template_version_id &&
            templateVersion &&
            body.template_version_id !== templateVersion.id
          ) {
            throw problem.conflict('REVISION_CONFLICT', '模板已更换，请刷新后重试');
          }

          const versionNo = db.nextSequence('resume_versions', project.id, 'version_no');
          const name = (body.name || '').trim() || `手动保存版本 ${versionNo}`;
          const id = uuidv7();

          const experiences = db
            .all(
              'SELECT * FROM experiences WHERE profile_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC',
              [profile.id],
            )
            .map((row) => ({
              id: row.id,
              type: row.type,
              organization: row.organization,
              title: row.title,
              start_date: row.start_date,
              end_date: row.end_date,
              is_current: row.is_current,
              description: row.description,
              meta: JSON.parse(row.meta_json || '{}'),
              revision: row.revision,
            }));
          const templatePayload = templateVersion
            ? {
                template_version_id: templateVersion.id,
                name: db.get('SELECT name FROM template_definitions WHERE id = ?', [
                  templateVersion.template_id,
                ]).name,
                version: templateVersion.version,
                schema: JSON.parse(templateVersion.schema_json || '{}'),
              }
            : {};
          const jobPayload = job
            ? {
                id: job.id,
                title: job.title,
                company: job.company,
                confirmed_text: job.confirmed_text,
                analysis: JSON.parse(job.analysis_json || '{}'),
                revision: job.revision,
                status: job.status,
                files_count: db.get('SELECT COUNT(*) AS total FROM job_files WHERE job_id = ?', [job.id])
                  .total,
              }
            : null;

          // 未显式传 change_ids 时，把当前全部未成版修改纳入本次版本
          const changeIds = Array.isArray(body.change_ids) && body.change_ids.length
            ? body.change_ids
            : db
                .all(
                  `SELECT id FROM resume_change_events
                   WHERE project_id = ? AND owner_id = ? AND reverted_at IS NULL AND snapshot_version_id IS NULL`,
                  [project.id, user.id],
                )
                .map((row) => row.id);
          const changeLabels = changeIds.length
            ? db
                .all(
                  `SELECT id, change_type, before_json, after_json FROM resume_change_events
                   WHERE project_id = ? AND owner_id = ? AND id IN (${changeIds.map(() => '?').join(',')})`,
                  [project.id, user.id, ...changeIds],
                )
                .map(changeLabel)
                .filter(Boolean)
            : [];

          const now = nowIso();
          db.run(
            `INSERT INTO resume_versions (id, project_id, owner_id, version_no, kind, name, base_version_id,
               profile_payload, template_payload, job_payload, resume_payload, change_summary_json,
               artifact_refs_json, generation_snapshot_id, status, created_by, created_at)
             VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, '{}', NULL, 'complete', 'user', ?)`,
            [
              id,
              project.id,
              user.id,
              versionNo,
              name,
              draft.base_version_id,
              JSON.stringify({
                basics: JSON.parse(profile.basics_json || '{}'),
                summary: profile.summary,
                experiences,
                revision: profile.revision,
              }),
              JSON.stringify(templatePayload),
              JSON.stringify(jobPayload || {}),
              draft.resume_json,
              JSON.stringify({
                changes: changeLabels,
                list_summary: changeLabels.length ? changeLabels.join('、') : '手动保存当前草稿',
                profile_data: `${(JSON.parse(profile.basics_json || '{}').name) || ''}｜${
                  (JSON.parse(profile.basics_json || '{}').city) || ''
                }；${experiences.filter((exp) => exp.type === 'work').length} 段工作经历、${
                  experiences.filter((exp) => exp.type === 'project').length
                } 个项目`,
                job_data: jobPayload
                  ? `${jobPayload.title}｜${jobPayload.company || ''}｜当前岗位资料`
                  : '未设置岗位',
                template_data: `${templatePayload.name || '系统模板'}｜当前排版`,
                compare_note: '',
              }),
              now,
            ],
          );

          // 成版：回填 change events，清空未成版标记（PRD 发布验收 19）
          if (changeIds.length) {
            db.run(
              `UPDATE resume_change_events SET snapshot_version_id = ?
               WHERE project_id = ? AND owner_id = ? AND id IN (${changeIds.map(() => '?').join(',')})`,
              [id, project.id, user.id, ...changeIds],
            );
          }
          db.run(
            'UPDATE resume_drafts SET base_version_id = ?, has_unsnapshotted_changes = 0, revision = ?, updated_at = ? WHERE id = ?',
            [id, draft.revision + 1, nowIso(), draft.id],
          );

          audit.log({
            ownerId: user.id,
            action: 'version_saved',
            resourceType: 'resume_version',
            resourceId: id,
            requestId,
            ipHash,
            metadata: { version_no: versionNo, name, changes: changeLabels.length },
          });

          const version = db.get('SELECT * FROM resume_versions WHERE id = ?', [id]);
          return {
            ...toVersionView(version, id),
            draft_revision: draft.revision + 1,
            has_unsnapshotted_changes: false,
            version_created: true,
          };
        }),
      ),
  },
  {
    method: 'GET',
    pattern: '/versions/:id',
    handler: ({ params, user }) => {
      const version = db.get('SELECT * FROM resume_versions WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!version) throw problem.notFound('版本不存在');
      const summary = JSON.parse(version.change_summary_json || '{}');
      const resume = ResumeDom.attachDocument(JSON.parse(version.resume_payload || '{}'));
      const jobPayload = JSON.parse(version.job_payload || '{}');
      const templatePayload = JSON.parse(version.template_payload || '{}');
      const profilePayload = JSON.parse(version.profile_payload || '{}');
      const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?', [
        version.project_id,
        user.id,
      ]);
      const draftResume = parseJson(draft && draft.resume_json);
      const versionDocument = ResumeDom.ensureDocument(resume);
      const draftDocument = ResumeDom.ensureDocument(draftResume);
      return {
        ...toVersionView(version, draft ? draft.base_version_id : null),
        resume,
        matches_current_draft: hashJson(versionDocument) === hashJson(draftDocument),
        draft_has_unsnapshotted_changes: Boolean(draft && draft.has_unsnapshotted_changes),
        profile_payload: profilePayload,
        template_payload: templatePayload,
        job_payload: jobPayload,
        summary: {
          changes: summary.changes || [],
          profile_data: summary.profile_data || '',
          job_data: summary.job_data || '',
          template_data: summary.template_data || '',
          compare_note: summary.compare_note || '',
        },
        artifacts: db
          .all('SELECT id, type, size, mime_type FROM artifacts WHERE version_id = ?', [version.id])
          .map((row) => ({ id: row.id, type: row.type, size: row.size, mime_type: row.mime_type })),
      };
    },
  },
  {
    method: 'GET',
    pattern: '/versions/:id/compare',
    handler: ({ params, user, query }) => {
      const version = db.get('SELECT * FROM resume_versions WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!version) throw problem.notFound('版本不存在');
      const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?', [
        version.project_id,
        user.id,
      ]);
      if (!draft) throw problem.notFound('草稿不存在');
      const project = loadProject(version.project_id, user);
      const targetId = query.get('target');
      const current = targetId
        ? db.get(
            'SELECT * FROM resume_versions WHERE id = ? AND project_id = ? AND owner_id = ?',
            [targetId, version.project_id, user.id],
          )
        : null;
      if (targetId && !current) throw problem.notFound('要比较的版本不存在');
      const oldResume = ResumeDom.attachDocument(parseJson(version.resume_payload));
      const currentResume = current
        ? ResumeDom.attachDocument(parseJson(current.resume_payload))
        : ResumeDom.attachDocument(parseJson(draft.resume_json));
      const oldTemplate = parseJson(version.template_payload);
      const oldJob = parseJson(version.job_payload);
      const currentTemplate = current
        ? parseJson(current.template_payload)
        : currentTemplatePayload(project);
      const currentJob = current
        ? parseJson(current.job_payload)
        : currentJobPayload(project, user);
      const diff = ResumeDom.compareDocuments(
        ResumeDom.ensureDocument(oldResume),
        ResumeDom.ensureDocument(currentResume),
      );
      const contextChanges = compareContexts(oldTemplate, oldJob, currentTemplate, currentJob);
      return {
        old: {
          id: version.id,
          title: version.name,
          created_at: version.created_at,
          resume: oldResume,
        },
        current: {
          id: current ? current.id : null,
          title: current ? current.name : '当前草稿',
          created_at: current ? current.created_at : draft.updated_at,
          resume: currentResume,
          has_unsnapshotted_changes: current ? false : Boolean(draft.has_unsnapshotted_changes),
        },
        diff,
        context_changes: contextChanges,
        note: diff.equal && !contextChanges.some((item) => item.changed)
          ? '这两份简历当前没有差异。'
          : `已比较完整简历，共发现 ${diff.changes.length} 处内容或结构变化。`,
      };
    },
  },
  {
    method: 'POST',
    pattern: '/versions/:id/clone',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'resume_version_clone', () =>
        db.tx(() => {
        const version = db.get('SELECT * FROM resume_versions WHERE id = ? AND owner_id = ?', [
          params.id,
          user.id,
        ]);
        if (!version) throw problem.notFound('版本不存在');
        const project = loadProject(version.project_id, user);
        const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?', [
          version.project_id,
          user.id,
        ]);
        if (!draft) throw problem.notFound('草稿不存在');
        if (body.draft_revision !== undefined && body.draft_revision !== draft.revision) {
          throw problem.conflict('REVISION_CONFLICT', '简历已变化，请刷新后重试', {
            expected: body.draft_revision,
            current: draft.revision,
          });
        }
        const pending = db.get(
          `SELECT COUNT(*) AS total FROM resume_change_events
           WHERE project_id = ? AND owner_id = ? AND reverted_at IS NULL AND snapshot_version_id IS NULL`,
          [project.id, user.id],
        ).total;
        if ((draft.has_unsnapshotted_changes || pending) && !body.discard_unsaved) {
          throw problem.conflict(
            'UNSAVED_DRAFT_CHANGES',
            '当前草稿还有未保存的修改，请先保存或确认放弃后再继续',
            { pending_changes: pending },
          );
        }
        const now = nowIso();
        if (body.discard_unsaved && pending) {
          db.run(
            `UPDATE resume_change_events SET reverted_at = ?
             WHERE project_id = ? AND owner_id = ? AND reverted_at IS NULL AND snapshot_version_id IS NULL`,
            [now, project.id, user.id],
          );
        }

        const restored = { template: false, job: false, unavailable: [] };
        if (body.restore_context) {
          const templatePayload = parseJson(version.template_payload);
          const historicalTemplateId = templatePayload.template_version_id || null;
          let templateId = null;
          if (historicalTemplateId) {
            const template = db.get(
              `SELECT tv.id FROM template_versions tv
               LEFT JOIN template_definitions td ON td.id = tv.template_id
               WHERE tv.id = ? AND (tv.owner_id IS NULL OR tv.owner_id = ? OR td.owner_id = ?)`,
              [historicalTemplateId, user.id, user.id],
            );
            if (template) {
              templateId = template.id;
              restored.template = true;
            } else {
              restored.unavailable.push('简历模板');
            }
          } else {
            restored.template = true;
          }

          const jobPayload = parseJson(version.job_payload);
          const historicalJobId = jobPayload.id || null;
          let jobId = null;
          if (historicalJobId) {
            const job = db.get(
              'SELECT id FROM target_jobs WHERE id = ? AND project_id = ? AND owner_id = ?',
              [historicalJobId, project.id, user.id],
            );
            if (job) {
              jobId = job.id;
              restored.job = true;
            } else {
              restored.unavailable.push('目标岗位');
            }
          } else {
            restored.job = true;
          }
          db.run(
            `UPDATE resume_projects
             SET current_template_version_id = ?, current_job_id = ?, revision = revision + 1, updated_at = ?
             WHERE id = ?`,
            [
              restored.template ? templateId : project.current_template_version_id,
              restored.job ? jobId : project.current_job_id,
              now,
              project.id,
            ],
          );
        }
        // 复制旧版本创建新草稿，不覆盖原版本（PRD 发布验收 20）
        const revision = draft.revision + 1;
        db.run(
          'UPDATE resume_drafts SET resume_json = ?, base_version_id = ?, revision = ?, has_unsnapshotted_changes = 0, updated_at = ? WHERE id = ?',
          [version.resume_payload, version.id, revision, now, draft.id],
        );
        audit.log({
          ownerId: user.id,
          action: 'version_cloned',
          resourceType: 'resume_version',
          resourceId: version.id,
          requestId,
          ipHash,
          metadata: {
            draft_revision: revision,
            discarded_changes: body.discard_unsaved ? pending : 0,
            restored_context: Boolean(body.restore_context),
            profile_unchanged: true,
          },
        });
        return {
          version_id: version.id,
          draft_revision: revision,
          resume_json: JSON.parse(version.resume_payload || '{}'),
          base_version_id: version.id,
          original_version_intact: true,
          profile_unchanged: true,
          restored_context: restored,
        };
        }),
      ),
  },
  {
    method: 'POST',
    pattern: '/versions/:id/export',
    handler: ({ params, body, user, requestId, ipHash }) => {
      const version = db.get('SELECT * FROM resume_versions WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!version) throw problem.notFound('版本不存在');
      const artifacts = renderVersionArtifacts({
        user,
        version,
        force: Boolean(body.force),
      });
      audit.log({
        ownerId: user.id,
        action: 'version_exported',
        resourceType: 'resume_version',
        resourceId: version.id,
        requestId,
        ipHash,
        metadata: { types: artifacts.map((item) => item.type) },
      });
      return {
        version_id: version.id,
        artifacts: artifacts.map((item) => ({
          ...item,
          download_url: `/api/v1/artifacts/${item.id}/download-url`,
        })),
      };
    },
  },
];

module.exports = { routes, renderVersionArtifacts };
