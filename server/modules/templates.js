'use strict';
/**
 * 模板模块（PRD §6.2、TECH §10.2）。
 *
 * 模板不进入左侧资料库，在中央简历工具栏中选择或上传。
 * 更换模板属于草稿修改：记录 change event、点亮「保存为版本」，但不自动创建历史版本。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, problem } = require('../lib/util');
const audit = require('../lib/audit');
const { ensureSystemTemplates, createCustomTemplate } = require('../lib/templates');
const { toTemplateView } = require('./workspace');

const routes = [
  {
    method: 'GET',
    pattern: '/templates/system',
    handler: ({ user }) => {
      ensureSystemTemplates();
      return {
        items: db
          .all(
            `SELECT tv.* FROM template_versions tv
             JOIN template_definitions td ON td.id = tv.template_id
             WHERE td.kind = 'system' AND td.owner_id IS NULL
             ORDER BY tv.version DESC`,
          )
          .map(toTemplateView),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/templates/custom',
    handler: ({ body, user, requestId, ipHash }) => {
      const upload = db.get('SELECT * FROM uploads WHERE id = ? AND owner_id = ?', [
        body.upload_id,
        user.id,
      ]);
      if (!upload) throw problem.notFound('上传文件不存在');
      if (upload.status !== 'ready') {
        throw problem.unprocessable('TEMPLATE_UNSUPPORTED', '文件未通过安全校验，请重新上传');
      }
      const template = createCustomTemplate({
        user,
        originalName: upload.original_name,
        size: upload.size,
        uploadId: upload.id,
      });
      audit.log({
        ownerId: user.id,
        action: 'template_uploaded',
        resourceType: 'template_version',
        resourceId: template.version_id,
        requestId,
        ipHash,
        metadata: { file_name: upload.original_name, size: upload.size },
      });
      return toTemplateView(db.get('SELECT * FROM template_versions WHERE id = ?', [template.version_id]));
    },
  },
  {
    method: 'GET',
    pattern: '/templates/:id/status',
    handler: ({ params, user }) => {
      const version = db.get('SELECT tv.* FROM template_versions tv JOIN template_definitions td ON td.id = tv.template_id WHERE tv.id = ? AND (td.owner_id IS NULL OR td.owner_id = ?)', [
        params.id,
        user.id,
      ]);
      if (!version) throw problem.notFound('模板不存在');
      return toTemplateView(version);
    },
  },
  {
    method: 'PUT',
    pattern: '/projects/:id/template',
    handler: ({ params, body, user, requestId, ipHash }) =>
      db.tx(() => {
        const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
          params.id,
          user.id,
        ]);
        if (!project) throw problem.notFound('项目不存在');
        const version = db.get(
          `SELECT tv.* FROM template_versions tv JOIN template_definitions td ON td.id = tv.template_id
           WHERE tv.id = ? AND (td.owner_id IS NULL OR td.owner_id = ?)`,
          [body.template_version_id, user.id],
        );
        if (!version) throw problem.notFound('模板版本不存在');
        const definition = db.get('SELECT * FROM template_definitions WHERE id = ?', [
          version.template_id,
        ]);
        if (definition.status !== 'ready') {
          throw problem.unprocessable('TEMPLATE_UNSUPPORTED', '模板仍在解析中，请稍后再试');
        }
        const previous = project.current_template_version_id;
        db.run(
          'UPDATE resume_projects SET current_template_version_id = ?, updated_at = ? WHERE id = ?',
          [version.id, nowIso(), project.id],
        );
        db.bumpRevision('resume_projects', project.id);

        // 更换模板：更新草稿并追加可撤销 change event（不自动创建版本）
        const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?', [
          project.id,
          user.id,
        ]);
        let revision = draft ? draft.revision : 1;
        if (draft && body.apply_to_draft !== false) {
          const resume = JSON.parse(draft.resume_json || '{}');
          const schema = JSON.parse(version.schema_json || '{}');
          const before = { layout_hints: resume.layout_hints || {} };
          resume.layout_hints = { ...(resume.layout_hints || {}), layout: schema.layout || 'classic', max_pages: (schema.page && schema.page.max_pages) || 2 };
          revision = draft.revision + 1;
          db.run(
            `UPDATE resume_drafts SET resume_json = ?, revision = ?, has_unsnapshotted_changes = 1, updated_at = ? WHERE id = ?`,
            [JSON.stringify(resume), revision, nowIso(), draft.id],
          );
          const mutationId = body.mutation_id || uuidv7();
          const existing = db.get(
            'SELECT * FROM resume_change_events WHERE project_id = ? AND mutation_id = ?',
            [project.id, mutationId],
          );
          if (!existing) {
            db.run(
              `INSERT INTO resume_change_events (id, project_id, owner_id, draft_revision, change_type, scope_type, scope_id, before_json, after_json, actor_type, mutation_id, created_at)
               VALUES (?, ?, ?, ?, 'template', 'RESUME_DOCUMENT', ?, ?, ?, 'user', ?, ?)`,
              [
                uuidv7(),
                project.id,
                user.id,
                revision,
                version.id,
                JSON.stringify(before),
                JSON.stringify({
                  layout_hints: resume.layout_hints,
                  label: `更换为${definition.name}模板`,
                }),
                mutationId,
                nowIso(),
              ],
            );
          }
        }
        audit.log({
          ownerId: user.id,
          action: 'template_selected',
          resourceType: 'template_version',
          resourceId: version.id,
          requestId,
          ipHash,
          metadata: { previous_template_version_id: previous, name: definition.name },
        });
        return {
          ...toTemplateView(version),
          draft_revision: revision,
          has_unsnapshotted_changes: true,
          version_created: false,
        };
      }),
  },
];

module.exports = { routes };
