'use strict';
/**
 * 简历草稿与变更事件（TECH §4.3、§9.6、PRD §6.5）。
 *
 * 直接编辑事务或已应用的 AI 修改写入同一份完整文档并追加可撤销 change event；
 * 不得因此自动创建历史版本。撤销应同时回滚草稿并标记对应事件 reverted。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, problem } = require('../lib/util');
const audit = require('../lib/audit');
const ResumeDom = require('../../resume-dom');

/** 定位并更新某条 bullet 的文本。 */
function applyBulletText(resume, bulletId, text) {
  const sections = ['experience', 'projects'];
  for (const section of sections) {
    const items = resume[section] || [];
    for (const item of items) {
      const bullets = item.bullets || [];
      const target = bullets.find((bullet) => bullet.id === bulletId);
      if (target) {
        target.text = text;
        return true;
      }
    }
  }
  return false;
}

function findBullet(resume, bulletId) {
  for (const section of ['experience', 'projects']) {
    for (const item of resume[section] || []) {
      const target = (item.bullets || []).find((bullet) => bullet.id === bulletId);
      if (target) return target;
    }
  }
  return null;
}

/** 把变更应用到草稿（正向与撤销共用）。 */
function applyChangePatch(resume, event, direction) {
  const payload = direction === 'forward' ? JSON.parse(event.after_json) : JSON.parse(event.before_json);
  switch (event.change_type) {
    case 'bullet_text':
      applyBulletText(resume, event.scope_id, payload.text);
      break;
    case 'summary':
      resume.summary = payload.text;
      break;
    case 'template':
      if (payload.resume_json) return JSON.parse(JSON.stringify(payload.resume_json));
      resume.layout_hints = { ...(resume.layout_hints || {}), ...(payload.layout_hints || {}) };
      break;
    case 'full_document':
      if (payload.resume_json) return JSON.parse(JSON.stringify(payload.resume_json));
      break;
    case 'dom_operations':
      if (payload.resume_json) return JSON.parse(JSON.stringify(payload.resume_json));
      break;
    case 'document_import':
      if (payload.resume_json) return JSON.parse(JSON.stringify(payload.resume_json));
      break;
    case 'document_transaction':
      if (payload.resume_json) return JSON.parse(JSON.stringify(payload.resume_json));
      break;
    default:
      break;
  }
  return resume;
}

function loadDraft(projectId, user) {
  const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?', [
    projectId,
    user.id,
  ]);
  if (!draft) throw problem.notFound('草稿不存在');
  return draft;
}

function markResumeActionsStale(projectId, userId) {
  db.run(
    `UPDATE ai_action_requests
     SET status = 'stale'
     WHERE owner_id = ?
       AND action_type = 'RESUME_REWRITE_PROPOSAL'
       AND status IN ('proposed','awaiting_confirmation')
       AND conversation_id IN (
         SELECT id FROM ai_conversations WHERE project_id = ? AND owner_id = ?
       )`,
    [userId, projectId, userId],
  );
}

const routes = [
  {
    method: 'GET',
    pattern: '/projects/:id/resume-draft',
    handler: ({ params, user }) => {
      const draft = loadDraft(params.id, user);
      return {
        id: draft.id,
        resume_json: ResumeDom.toResumeDocument(JSON.parse(draft.resume_json || '{}')),
        revision: draft.revision,
        base_version_id: draft.base_version_id,
        has_unsnapshotted_changes: Boolean(draft.has_unsnapshotted_changes),
      };
    },
  },
  {
    method: 'PATCH',
    pattern: '/projects/:id/resume-draft',
    handler: ({ params, body, user, requestId, ipHash }) =>
      db.tx(() => {
        const draft = loadDraft(params.id, user);
        if (body.expected_revision !== undefined && body.expected_revision !== draft.revision) {
          throw problem.conflict('REVISION_CONFLICT', '简历已被其他端修改，请刷新后重试', {
            expected: body.expected_revision,
            current: draft.revision,
          });
        }
        const resume = ResumeDom.toResumeDocument(
          body.resume_json ? body.resume_json : JSON.parse(draft.resume_json || '{}'),
        );
        const revision = draft.revision + 1;
        db.run(
          `UPDATE resume_drafts SET resume_json = ?, revision = ?, has_unsnapshotted_changes = 1, updated_at = ? WHERE id = ?`,
          [JSON.stringify(resume), revision, nowIso(), draft.id],
        );
        markResumeActionsStale(draft.project_id, user.id);

        let changeEvent = null;
        if (body.change) {
          const change = body.change;
          const mutationId = change.mutation_id || uuidv7();
          // mutation_id 唯一 → 重复提交（自动保存重放）不产生新事件
          const existing = db.get(
            'SELECT * FROM resume_change_events WHERE project_id = ? AND mutation_id = ?',
            [draft.project_id, mutationId],
          );
          if (existing) {
            changeEvent = existing;
          } else {
            const id = uuidv7();
            db.run(
              `INSERT INTO resume_change_events (id, project_id, owner_id, draft_revision, change_type, scope_type, scope_id, before_json, after_json, actor_type, mutation_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                id,
                draft.project_id,
                user.id,
                revision,
                change.change_type || 'bullet_text',
                change.scope_type || null,
                change.scope_id || null,
                JSON.stringify(change.before || {}),
                JSON.stringify(change.after || {}),
                change.actor_type || 'user',
                mutationId,
                nowIso(),
              ],
            );
            changeEvent = db.get('SELECT * FROM resume_change_events WHERE id = ?', [id]);
          }
        }
        audit.log({
          ownerId: user.id,
          action: body.change ? 'resume_draft_changed' : 'resume_draft_saved',
          resourceType: 'resume_draft',
          resourceId: draft.id,
          requestId,
          ipHash,
          metadata: {
            revision,
            change_type: body.change ? body.change.change_type : null,
            scope_id: body.change ? body.change.scope_id : null,
          },
        });
        return {
          id: draft.id,
          revision,
          has_unsnapshotted_changes: true,
          change: changeEvent
            ? { id: changeEvent.id, change_type: changeEvent.change_type, mutation_id: changeEvent.mutation_id }
            : null,
          version_created: false, // 应用修改只更新草稿，不自动新增历史版本
        };
      }),
  },
  {
    method: 'POST',
    pattern: '/projects/:id/resume-draft/transactions',
    handler: ({ params, body, user, requestId, ipHash }) =>
      db.tx(() => {
        const draft = loadDraft(params.id, user);
        const mutationId = String(body.mutation_id || uuidv7());
        const existing = db.get(
          'SELECT * FROM resume_change_events WHERE project_id = ? AND mutation_id = ?',
          [draft.project_id, mutationId],
        );
        if (existing) {
          return {
            id: draft.id,
            revision: draft.revision,
            resume_json: ResumeDom.toResumeDocument(JSON.parse(draft.resume_json || '{}')),
            change_id: existing.id,
            has_unsnapshotted_changes: Boolean(draft.has_unsnapshotted_changes),
            idempotent_replay: true,
            version_created: false,
          };
        }
        if (body.expected_revision !== undefined && body.expected_revision !== draft.revision) {
          throw problem.conflict('REVISION_CONFLICT', '简历已被其他操作修改，请刷新后重试', {
            expected: body.expected_revision,
            current: draft.revision,
          });
        }
        if (!Array.isArray(body.operations) || !body.operations.length) {
          throw problem.badRequest('文档事务至少需要一个操作');
        }
        const beforeResume = ResumeDom.toResumeDocument(JSON.parse(draft.resume_json || '{}'));
        let nextResume;
        try {
          nextResume = ResumeDom.applyDocumentOperations(beforeResume, body.operations, {
            allowStructure: true,
          });
        } catch (error) {
          throw problem.unprocessable('DOCUMENT_TRANSACTION_INVALID', error.message);
        }
        const revision = draft.revision + 1;
        const changedAt = nowIso();
        const changeId = uuidv7();
        db.run(
          `UPDATE resume_drafts
           SET resume_json = ?, revision = ?, has_unsnapshotted_changes = 1, updated_at = ?
           WHERE id = ?`,
          [JSON.stringify(nextResume), revision, changedAt, draft.id],
        );
        db.run(
          `INSERT INTO resume_change_events
           (id, project_id, owner_id, draft_revision, change_type, scope_type, scope_id,
            before_json, after_json, actor_type, mutation_id, created_at)
           VALUES (?, ?, ?, ?, 'document_transaction', 'RESUME_DOCUMENT', ?, ?, ?, 'user', ?, ?)`,
          [
            changeId,
            draft.project_id,
            user.id,
            revision,
            body.scope_id || null,
            JSON.stringify({ resume_json: beforeResume }),
            JSON.stringify({
              resume_json: nextResume,
              label: String(body.label || '直接编辑简历').slice(0, 120),
              input_type: String(body.input_type || 'direct_edit').slice(0, 40),
            }),
            mutationId,
            changedAt,
          ],
        );
        markResumeActionsStale(draft.project_id, user.id);
        audit.log({
          ownerId: user.id,
          action: 'resume_document_transaction_applied',
          resourceType: 'resume_draft',
          resourceId: draft.id,
          requestId,
          ipHash,
          metadata: {
            revision,
            operations: body.operations.length,
            input_type: body.input_type || 'direct_edit',
          },
        });
        return {
          id: draft.id,
          revision,
          resume_json: nextResume,
          change_id: changeId,
          has_unsnapshotted_changes: true,
          version_created: false,
        };
      }),
  },
  {
    method: 'GET',
    pattern: '/projects/:id/resume-draft/changes',
    handler: ({ params, user }) => {
      const draft = loadDraft(params.id, user);
      return {
        items: db
          .all(
            `SELECT * FROM resume_change_events
             WHERE project_id = ? AND owner_id = ? AND reverted_at IS NULL AND snapshot_version_id IS NULL
             ORDER BY created_at ASC`,
            [draft.project_id, user.id],
          )
          .map((row) => ({
            id: row.id,
            change_type: row.change_type,
            scope_type: row.scope_type,
            scope_id: row.scope_id,
            before: JSON.parse(row.before_json || '{}'),
            after: JSON.parse(row.after_json || '{}'),
            actor_type: row.actor_type,
            mutation_id: row.mutation_id,
            created_at: row.created_at,
          })),
        has_unsnapshotted_changes: Boolean(draft.has_unsnapshotted_changes),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/projects/:id/resume-draft/changes/:changeId/revert',
    handler: ({ params, user, requestId, ipHash }) =>
      db.tx(() => {
        const draft = loadDraft(params.id, user);
        const event = db.get(
          'SELECT * FROM resume_change_events WHERE id = ? AND project_id = ? AND owner_id = ?',
          [params.changeId, draft.project_id, user.id],
        );
        if (!event) throw problem.notFound('变更不存在');
        if (event.reverted_at) {
          return { id: event.id, status: 'already_reverted', idempotent_replay: true };
        }
        const resume = JSON.parse(draft.resume_json || '{}');
        const restored = ResumeDom.toResumeDocument(applyChangePatch(resume, event, 'backward'));
        const revision = draft.revision + 1;
        db.run('UPDATE resume_drafts SET resume_json = ?, revision = ?, updated_at = ? WHERE id = ?', [
          JSON.stringify(restored),
          revision,
          nowIso(),
          draft.id,
        ]);
        const revertedAt = nowIso();
        db.run('UPDATE resume_change_events SET reverted_at = ? WHERE id = ?', [revertedAt, event.id]);
        if (event.change_type === 'document_import' || event.change_type === 'template') {
          const before = JSON.parse(event.before_json || '{}');
          if (Object.hasOwn(before, 'template_version_id')) {
            db.run(
              'UPDATE resume_projects SET current_template_version_id = ?, updated_at = ? WHERE id = ?',
              [before.template_version_id || null, nowIso(), draft.project_id],
            );
            db.bumpRevision('resume_projects', draft.project_id);
          }
        }
        // 文件导入会立即形成历史版本。撤销这类已成版操作后，当前草稿重新
        // 与基准版本产生差异，所以追加一个可保存的反向操作。
        if (event.snapshot_version_id) {
          db.run(
            `INSERT INTO resume_change_events
             (id, project_id, owner_id, draft_revision, change_type, scope_type, scope_id,
              before_json, after_json, actor_type, mutation_id, created_at)
             VALUES (?, ?, ?, ?, 'full_document', 'RESUME_DOCUMENT', ?, ?, ?, 'user', ?, ?)`,
            [
              uuidv7(),
              draft.project_id,
              user.id,
              revision,
              event.scope_id,
              event.after_json,
              event.before_json,
              uuidv7(),
              revertedAt,
            ],
          );
        }
        // 同步回滚草稿后，如已无未成版修改则清除标记（PRD 发布验收 19）
        const remaining = db.get(
          `SELECT COUNT(*) AS total FROM resume_change_events
           WHERE project_id = ? AND owner_id = ? AND reverted_at IS NULL AND snapshot_version_id IS NULL`,
          [draft.project_id, user.id],
        ).total;
        db.run('UPDATE resume_drafts SET has_unsnapshotted_changes = ? WHERE id = ?', [
          remaining ? 1 : 0,
          draft.id,
        ]);
        audit.log({
          ownerId: user.id,
          action: 'resume_change_reverted',
          resourceType: 'resume_change_event',
          resourceId: event.id,
          requestId,
          ipHash,
          metadata: { change_type: event.change_type, scope_id: event.scope_id },
        });
        return {
          id: event.id,
          status: 'reverted',
          revision,
          has_unsnapshotted_changes: Boolean(remaining),
          resume_json: restored,
        };
      }),
  },
];

module.exports = { routes, applyChangePatch, findBullet };
