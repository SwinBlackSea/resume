'use strict';
/**
 * 模板模块（PRD §6.2、TECH §10.2）。
 *
 * 排版不作为用户需要管理的独立对象，只在中央简历工具栏中选择系统排版。
 * 更换排版属于草稿修改：保留正文、记录 change event、支持撤销，但不自动创建历史版本。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, problem } = require('../lib/util');
const audit = require('../lib/audit');
const { ensureSystemTemplates } = require('../lib/templates');
const { toTemplateView } = require('./workspace');
const ResumeDom = require('../../resume-dom');

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
               AND tv.version = (
                 SELECT MAX(latest.version) FROM template_versions latest
                 WHERE latest.template_id = tv.template_id
               )
             ORDER BY tv.version DESC`,
          )
          .map(toTemplateView),
      };
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
      if (!version) throw problem.notFound('排版不存在');
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
        if (!version) throw problem.notFound('排版版本不存在');
        const definition = db.get('SELECT * FROM template_definitions WHERE id = ?', [
          version.template_id,
        ]);
        if (definition.status !== 'ready') {
          throw problem.unprocessable('TEMPLATE_UNSUPPORTED', '排版仍在准备中，请稍后再试');
        }
        const previous = project.current_template_version_id;
        if (previous === version.id) {
          return {
            ...toTemplateView(version),
            draft_revision: db.get(
              'SELECT revision FROM resume_drafts WHERE project_id = ? AND owner_id = ?',
              [project.id, user.id],
            ).revision,
            has_unsnapshotted_changes: Boolean(
              db.get(
                'SELECT has_unsnapshotted_changes FROM resume_drafts WHERE project_id = ? AND owner_id = ?',
                [project.id, user.id],
              ).has_unsnapshotted_changes,
            ),
            version_created: false,
            unchanged: true,
          };
        }
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
        let changeId = null;
        if (draft && body.apply_to_draft !== false) {
          const previousVersion = previous
            ? db.get('SELECT * FROM template_versions WHERE id = ?', [previous])
            : null;
          const beforeResume = ResumeDom.createResumeAggregate(
            JSON.parse(draft.resume_json || '{}'),
            previousVersion ? toTemplateView(previousVersion) : null,
          );
          const resume = ResumeDom.applyTemplate(beforeResume, toTemplateView(version));
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
            changeId = uuidv7();
            db.run(
              `INSERT INTO resume_change_events (id, project_id, owner_id, draft_revision, change_type, scope_type, scope_id, before_json, after_json, actor_type, mutation_id, created_at)
               VALUES (?, ?, ?, ?, 'template', 'RESUME_DOCUMENT', ?, ?, ?, 'user', ?, ?)`,
              [
                changeId,
                project.id,
                user.id,
                revision,
                version.id,
                JSON.stringify({
                  resume_json: beforeResume,
                  template_version_id: previous,
                }),
                JSON.stringify({
                  resume_json: resume,
                  template_version_id: version.id,
                  label: `更换为${definition.name}排版`,
                }),
                mutationId,
                nowIso(),
              ],
            );
          } else {
            changeId = existing.id;
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
          change_id: changeId,
        };
      }),
  },
];

module.exports = { routes };
