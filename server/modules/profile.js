'use strict';
/**
 * 个人信息模块（PRD §6.1、TECH §6）。
 *
 * 关键约束：资料变化除白名单一一对应字段外不得静默改写中央简历。
 * 本模块只更新个人信息与经历，绝不直接修改 resume_drafts。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, problem, deepClone } = require('../lib/util');
const audit = require('../lib/audit');
const { suggestPolish } = require('../lib/polish');
const { splitBullets } = require('../lib/compose');
const { toExperienceView } = require('./workspace');

const EDITABLE_BASICS = new Set([
  'name',
  'phone',
  'email',
  'city',
  'current_title',
  'years',
  'job_status',
]);

function loadProject(params, user) {
  const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
    params.id || params.projectId,
    user.id,
  ]);
  if (!project) throw problem.notFound('项目不存在');
  return project;
}

function loadProfile(project, user) {
  const profile = db.get('SELECT * FROM profiles WHERE id = ? AND owner_id = ?', [
    project.current_profile_id,
    user.id,
  ]);
  if (!profile) throw problem.notFound('个人信息不存在');
  return profile;
}

const routes = [
  {
    method: 'GET',
    pattern: '/projects/:id/profile',
    handler: ({ params, user }) => {
      const project = loadProject(params, user);
      const profile = loadProfile(project, user);
      const experiences = db
        .all(
          'SELECT * FROM experiences WHERE profile_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC',
          [profile.id],
        )
        .map(toExperienceView);
      return {
        id: profile.id,
        basics: JSON.parse(profile.basics_json || '{}'),
        summary: profile.summary,
        revision: profile.revision,
        experiences,
      };
    },
  },
  {
    method: 'PATCH',
    pattern: '/projects/:id/profile/fields/:field',
    handler: ({ params, body, user, requestId, ipHash }) => {
      const project = loadProject(params, user);
      const profile = loadProfile(project, user);
      const field = params.field;
      if (field !== 'summary' && !EDITABLE_BASICS.has(field)) {
        throw problem.badRequest(`字段 ${field} 不支持直接修改`);
      }
      if (body.expected_revision !== undefined && body.expected_revision !== profile.revision) {
        throw problem.conflict('REVISION_CONFLICT', '个人资料已被其他端修改，请刷新后重试', {
          expected: body.expected_revision,
          current: profile.revision,
        });
      }
      return db.tx(() => {
        const basics = JSON.parse(profile.basics_json || '{}');
        const before = field === 'summary' ? profile.summary : basics[field];
        if (field === 'summary') {
          db.run('UPDATE profiles SET summary = ?, updated_at = ? WHERE id = ?', [
            String(body.value || ''),
            nowIso(),
            profile.id,
          ]);
        } else {
          basics[field] = body.value;
          db.run('UPDATE profiles SET basics_json = ?, updated_at = ? WHERE id = ?', [
            JSON.stringify(basics),
            nowIso(),
            profile.id,
          ]);
        }
        const revision = db.bumpRevision('profiles', profile.id);
        audit.log({
          ownerId: user.id,
          action: 'profile_field_saved',
          resourceType: 'profile',
          resourceId: profile.id,
          requestId,
          ipHash,
          metadata: { field, before, after: body.value, revision },
        });
        return { field, value: body.value, revision, resume_unchanged: true };
      });
    },
  },
  {
    method: 'POST',
    pattern: '/projects/:id/profile/experiences',
    handler: ({ params, body, user, requestId, ipHash }) => {
      const project = loadProject(params, user);
      const profile = loadProfile(project, user);
      const type = body.type || 'work';
      if (!['work', 'project', 'education', 'skill'].includes(type)) {
        throw problem.badRequest('不支持的经历类型');
      }
      const id = uuidv7();
      const count = db.get(
        'SELECT COUNT(*) AS total FROM experiences WHERE profile_id = ? AND deleted_at IS NULL',
        [profile.id],
      ).total;
      db.run(
        `INSERT INTO experiences (id, profile_id, owner_id, type, organization, title, start_date, end_date, is_current, description, meta_json, sort_order, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          id,
          profile.id,
          user.id,
          type,
          body.organization || '',
          body.title || '',
          body.start_date || '',
          body.end_date || '',
          body.is_current ? 1 : 0,
          Array.isArray(body.bullets) ? body.bullets.join('\n') : body.description || '',
          JSON.stringify({ period_label: body.period_label || '' }),
          count,
          nowIso(),
          nowIso(),
        ],
      );
      db.bumpRevision('profiles', profile.id);
      audit.log({
        ownerId: user.id,
        action: 'experience_created',
        resourceType: 'experience',
        resourceId: id,
        requestId,
        ipHash,
        metadata: { type },
      });
      return toExperienceView(db.get('SELECT * FROM experiences WHERE id = ?', [id]));
    },
  },
  {
    method: 'PATCH',
    pattern: '/experiences/:id',
    handler: ({ params, body, user, requestId, ipHash }) => {
      const experience = db.get('SELECT * FROM experiences WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!experience) throw problem.notFound('经历不存在');
      if (body.expected_revision !== undefined && body.expected_revision !== experience.revision) {
        throw problem.conflict('REVISION_CONFLICT', '该经历已被其他端修改', {
          expected: body.expected_revision,
          current: experience.revision,
        });
      }
      const fields = {
        organization: body.organization,
        title: body.title,
        start_date: body.start_date,
        end_date: body.end_date,
        is_current: body.is_current === undefined ? undefined : body.is_current ? 1 : 0,
        description: body.bullets
          ? body.bullets.join('\n')
          : body.description,
        meta_json: body.period_label
          ? JSON.stringify({ period_label: body.period_label })
          : undefined,
      };
      const updates = Object.entries(fields).filter(([, value]) => value !== undefined);
      if (updates.length) {
        db.run(
          `UPDATE experiences SET ${updates.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
          [...updates.map(([, value]) => value), nowIso(), experience.id],
        );
      }
      const revision = db.bumpRevision('experiences', experience.id);
      audit.log({
        ownerId: user.id,
        action: 'experience_updated',
        resourceType: 'experience',
        resourceId: experience.id,
        requestId,
        ipHash,
        metadata: { fields: updates.map(([key]) => key) },
      });
      return { ...toExperienceView(db.get('SELECT * FROM experiences WHERE id = ?', [experience.id])), revision };
    },
  },
  {
    method: 'DELETE',
    pattern: '/experiences/:id',
    handler: ({ params, user, requestId, ipHash }) => {
      const experience = db.get('SELECT * FROM experiences WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!experience) throw problem.notFound('经历不存在');
      db.run('UPDATE experiences SET deleted_at = ?, updated_at = ? WHERE id = ?', [
        nowIso(),
        nowIso(),
        experience.id,
      ]);
      audit.log({
        ownerId: user.id,
        action: 'experience_deleted',
        resourceType: 'experience',
        resourceId: experience.id,
        requestId,
        ipHash,
        metadata: { organization: experience.organization },
      });
      return { id: experience.id, deleted: true, undo_url: `/api/v1/experiences/${experience.id}/restore` };
    },
  },
  {
    method: 'POST',
    pattern: '/experiences/:id/restore',
    handler: ({ params, user, requestId, ipHash }) => {
      const experience = db.get('SELECT * FROM experiences WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!experience) throw problem.notFound('经历不存在');
      db.run('UPDATE experiences SET deleted_at = NULL, updated_at = ? WHERE id = ?', [
        nowIso(),
        experience.id,
      ]);
      audit.log({
        ownerId: user.id,
        action: 'experience_restored',
        resourceType: 'experience',
        resourceId: experience.id,
        requestId,
        ipHash,
      });
      return toExperienceView(db.get('SELECT * FROM experiences WHERE id = ?', [experience.id]));
    },
  },
  /**
   * 导入旧简历 / 证书等资料：AI 提取结果先进入待确认，确认后才进入可靠事实库。
   * 任何情况下不直接改写简历正文（PRD §6.1、§6.6）。
   */
  {
    method: 'POST',
    pattern: '/projects/:id/profile/import',
    handler: ({ params, body, user, requestId, ipHash }) =>
      db.tx(() => {
        const project = loadProject(params, user);
        const uploadIds = Array.isArray(body.upload_ids) ? body.upload_ids : [];
        if (!uploadIds.length) throw problem.badRequest('缺少上传文件');
        const created = [];
        uploadIds.forEach((uploadId) => {
          const upload = db.get('SELECT * FROM uploads WHERE id = ? AND owner_id = ?', [
            uploadId,
            user.id,
          ]);
          if (!upload) throw problem.notFound('上传文件不存在');
          const id = uuidv7();
          db.run(
            `INSERT INTO fact_candidates (id, project_id, owner_id, target_type, target_id, field_path, proposed_value_json, source_type, source_id, status, created_at, updated_at)
             VALUES (?, ?, ?, 'profile_experience', NULL, 'imported_fact', ?, 'upload', ?, 'pending', ?, ?)`,
            [
              id,
              project.id,
              user.id,
              JSON.stringify({
                label: 'AI 从资料中识别的新信息',
                value: upload.original_name,
                source_label: upload.original_name,
              }),
              upload.id,
              nowIso(),
              nowIso(),
            ],
          );
          created.push(id);
        });
        audit.log({
          ownerId: user.id,
          action: 'profile_imported',
          resourceType: 'upload',
          resourceId: uploadIds.join(','),
          requestId,
          ipHash,
          metadata: { count: uploadIds.length },
        });
        return { created: created.length, status: 'pending', resume_unchanged: true };
      }),
  },
  // ---- 字段级 AI 润色：只返回方案，不覆盖原文 ----
  {
    method: 'POST',
    pattern: '/polish',
    handler: ({ body, user, params }) => {
      const text = String(body.text || '');
      if (!text.trim()) throw problem.badRequest('缺少待润色的原文');
      const project = db.get('SELECT * FROM resume_projects WHERE owner_id = ? LIMIT 1', [user.id]);
      const keywords = (body.keywords || []).length
        ? body.keywords
        : (() => {
            const job = project
              ? db.get('SELECT * FROM target_jobs WHERE project_id = ? AND status = ?', [
                  project.id,
                  'confirmed',
                ])
              : null;
            const analysis = job ? JSON.parse(job.analysis_json || '{}') : {};
            return analysis.keywords || [];
          })();
      const result = suggestPolish({ text, intent: body.intent || '更专业', keywords });
      const id = uuidv7();
      db.run(
        `INSERT INTO polish_suggestions (id, project_id, owner_id, scope_type, scope_id, field_path, intent, original, suggestion, diff_json, pending_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
        [
          id,
          project ? project.id : null,
          user.id,
          body.scope_type || 'PROFILE_FIELD',
          body.scope_id || null,
          body.field_path || '',
          body.intent || '更专业',
          result.original,
          result.suggestion,
          JSON.stringify(result.diff),
          JSON.stringify(result.pending_claims),
          nowIso(),
          nowIso(),
        ],
      );
      return {
        suggestion_id: id,
        original: result.original,
        suggestion: result.suggestion,
        diff: result.diff,
        note: result.note,
        pending_claims: result.pending_claims,
        requires_confirmation: true,
        resume_unchanged: true,
      };
    },
  },
  {
    method: 'POST',
    pattern: '/polish/:id/apply',
    handler: ({ params, body, user, requestId, ipHash }) => {
      const suggestion = db.get('SELECT * FROM polish_suggestions WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!suggestion) throw problem.notFound('润色建议不存在');
      if (suggestion.status === 'applied') {
        return { id: suggestion.id, status: 'applied', idempotent_replay: true };
      }
      const value = body.value !== undefined ? String(body.value) : suggestion.suggestion;
      db.run("UPDATE polish_suggestions SET status = 'applied', updated_at = ? WHERE id = ?", [
        nowIso(),
        suggestion.id,
      ]);
      audit.log({
        ownerId: user.id,
        action: 'polish_applied',
        resourceType: 'polish_suggestion',
        resourceId: suggestion.id,
        requestId,
        ipHash,
        metadata: { scope_type: suggestion.scope_type, field_path: suggestion.field_path },
      });
      // 应用润色只更新资料字段；是否同步简历由用户在画布中确认（PRD §6.1）
      return {
        id: suggestion.id,
        status: 'applied',
        applied_value: value,
        target: { scope_type: suggestion.scope_type, scope_id: suggestion.scope_id, field_path: suggestion.field_path },
        resume_unchanged: true,
      };
    },
  },
];

module.exports = { routes };
