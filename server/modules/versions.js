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
const { uuidv7, nowIso, problem, deepClone } = require('../lib/util');
const audit = require('../lib/audit');
const { withIdempotency } = require('../lib/idempotency');
const { putObject } = require('../lib/storage');
const { renderPdf } = require('../lib/render/pdf');
const { renderDocx } = require('../lib/render/docx');
const { renderHtml } = require('../lib/render/html');
const { toVersionView } = require('./workspace');

function loadProject(projectId, user) {
  const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
    projectId,
    user.id,
  ]);
  if (!project) throw problem.notFound('项目不存在');
  return project;
}

function resumeMainWork(resume) {
  const experience = (resume.experience || [])[0];
  if (experience && (experience.bullets || []).length) {
    const bullet = experience.bullets.find((item) => item.id === 'target-bullet') || experience.bullets[0];
    return bullet.text || '';
  }
  return resume.summary || '';
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
                sources_count: db.get('SELECT COUNT(*) AS total FROM job_sources WHERE job_id = ?', [job.id])
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
                  `SELECT id, after_json FROM resume_change_events
                   WHERE project_id = ? AND owner_id = ? AND id IN (${changeIds.map(() => '?').join(',')})`,
                  [project.id, user.id, ...changeIds],
                )
                .map((row) => (JSON.parse(row.after_json || '{}').label || '').trim())
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
                time_label: `今天 ${new Date().getHours()}:${String(new Date().getMinutes()).padStart(2, '0')}`,
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
      const resume = JSON.parse(version.resume_payload || '{}');
      const jobPayload = JSON.parse(version.job_payload || '{}');
      const templatePayload = JSON.parse(version.template_payload || '{}');
      const profilePayload = JSON.parse(version.profile_payload || '{}');
      const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?', [
        version.project_id,
        user.id,
      ]);
      return {
        ...toVersionView(version, draft ? draft.base_version_id : null),
        resume,
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
      const targetId = query.get('target') || (draft ? draft.base_version_id : null);
      const current = targetId
        ? db.get('SELECT * FROM resume_versions WHERE id = ? AND owner_id = ?', [targetId, user.id])
        : null;
      const summary = JSON.parse(version.change_summary_json || '{}');
      const currentSummary = current ? JSON.parse(current.change_summary_json || '{}') : {};
      const oldResume = JSON.parse(version.resume_payload || '{}');
      const currentResume = current
        ? JSON.parse(current.resume_payload || '{}')
        : JSON.parse((draft && draft.resume_json) || '{}');
      return {
        old: {
          id: version.id,
          title: version.name,
          time_label: summary.time_label || '',
          copy: resumeMainWork(oldResume),
        },
        current: {
          id: current ? current.id : null,
          title: current ? current.name : '当前草稿',
          time_label: current ? currentSummary.time_label || '' : '当前草稿',
          copy: resumeMainWork(currentResume),
        },
        note:
          summary.compare_note ||
          '两个版本之间的差异已按主要经历内容展示；未变化的部分已省略。',
      };
    },
  },
  {
    method: 'POST',
    pattern: '/versions/:id/clone',
    handler: ({ params, user, requestId, ipHash }) =>
      db.tx(() => {
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
        // 复制旧版本创建新草稿，不覆盖原版本（PRD 发布验收 20）
        const revision = draft.revision + 1;
        db.run(
          'UPDATE resume_drafts SET resume_json = ?, base_version_id = ?, revision = ?, has_unsnapshotted_changes = 0, updated_at = ? WHERE id = ?',
          [version.resume_payload, version.id, revision, nowIso(), draft.id],
        );
        audit.log({
          ownerId: user.id,
          action: 'version_cloned',
          resourceType: 'resume_version',
          resourceId: version.id,
          requestId,
          ipHash,
          metadata: { draft_revision: revision },
        });
        return {
          version_id: version.id,
          draft_revision: revision,
          resume_json: JSON.parse(version.resume_payload || '{}'),
          base_version_id: version.id,
          original_version_intact: true,
        };
      }),
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

module.exports = { routes, renderVersionArtifacts, resumeMainWork };
