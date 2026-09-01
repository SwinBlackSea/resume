'use strict';
/**
 * 岗位模块（PRD §6.3、TECH §6、§10.1）。
 *
 * 导入方式：选择文件、拖拽、文件夹、移动端拍照、粘贴文本兜底。
 * OCR 与分析异步执行；分析始终读取 confirmed_text；
 * 新岗位必须用户点击「设为当前岗位」后才生效（PRD 发布验收 14）。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, problem } = require('../lib/util');
const audit = require('../lib/audit');
const queue = require('../lib/queue');
const { analyzeJobText, matchJobWithProfile } = require('../lib/job-analyzer');
const { splitBullets } = require('../lib/compose');
const { toJobView } = require('./workspace');

function loadJob(params, user, { allowMissing = false } = {}) {
  const job = db.get('SELECT * FROM target_jobs WHERE id = ? AND owner_id = ?', [params.id, user.id]);
  if (!job && !allowMissing) throw problem.notFound('岗位不存在');
  return job;
}

function loadProject(params, user) {
  const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
    params.id,
    user.id,
  ]);
  if (!project) throw problem.notFound('项目不存在');
  return project;
}

/** 读取项目已确认事实，用于匹配分析。 */
function projectFacts(project) {
  const profile = db.get('SELECT * FROM profiles WHERE id = ?', [project.current_profile_id]);
  if (!profile) return [];
  return db
    .all('SELECT * FROM experiences WHERE profile_id = ? AND deleted_at IS NULL', [profile.id])
    .flatMap((exp) => splitBullets(exp.description))
    .concat([profile.summary || '']);
}

const routes = [
  {
    method: 'GET',
    pattern: '/jobs/:id',
    handler: ({ params, user }) => toJobView(loadJob(params, user)),
  },
  {
    method: 'POST',
    pattern: '/projects/:id/jobs',
    handler: ({ params, body, user, requestId, ipHash }) =>
      db.tx(() => {
        const project = loadProject(params, user);
        const id = uuidv7();
        db.run(
          `INSERT INTO target_jobs (id, project_id, owner_id, title, company, confirmed_text, ocr_text, analysis_json, revision, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1, 'draft', ?, ?)`,
          [
            id,
            project.id,
            user.id,
            body.title || '',
            body.company || '',
            body.text || '',
            body.text || '',
            nowIso(),
            nowIso(),
          ],
        );
        // 直接粘贴文本时立即分析（粘贴是最可靠的兜底方式）
        if (body.text) {
          queue.publish({
            aggregateType: 'target_job',
            aggregateId: id,
            eventType: 'job.analyze.requested',
          });
        }
        audit.log({
          ownerId: user.id,
          action: 'job_created',
          resourceType: 'target_job',
          resourceId: id,
          requestId,
          ipHash,
          metadata: { mode: body.mode || 'manual' },
        });
        return toJobView(db.get('SELECT * FROM target_jobs WHERE id = ?', [id]));
      }),
  },
  {
    method: 'POST',
    pattern: '/jobs/:id/sources',
    handler: ({ params, body, user, requestId, ipHash }) =>
      db.tx(() => {
        const job = loadJob(params, user);
        const uploadIds = Array.isArray(body.upload_ids) ? body.upload_ids : [];
        if (!uploadIds.length) throw problem.badRequest('缺少上传文件');
        const currentCount = db.get('SELECT COUNT(*) AS total FROM job_sources WHERE job_id = ?', [
          job.id,
        ]).total;
        uploadIds.forEach((uploadId, index) => {
          const upload = db.get('SELECT * FROM uploads WHERE id = ? AND owner_id = ?', [
            uploadId,
            user.id,
          ]);
          if (!upload) throw problem.notFound('上传文件不存在');
          db.run(
            `INSERT INTO job_sources (id, job_id, owner_id, upload_id, sort_order, ocr_raw_text, ocr_confidence, created_at)
             VALUES (?, ?, ?, ?, ?, '', NULL, ?)`,
            [uuidv7(), job.id, user.id, upload.id, currentCount + index, nowIso()],
          );
        });
        queue.publish({
          aggregateType: 'target_job',
          aggregateId: job.id,
          eventType: 'job.ocr.requested',
        });
        audit.log({
          ownerId: user.id,
          action: 'job_sources_added',
          resourceType: 'target_job',
          resourceId: job.id,
          requestId,
          ipHash,
          metadata: { count: uploadIds.length },
        });
        return { job_id: job.id, added: uploadIds.length, ocr: 'requested' };
      }),
  },
  {
    method: 'POST',
    pattern: '/jobs/:id/ocr',
    handler: ({ params, user }) => {
      const job = loadJob(params, user);
      queue.publish({
        aggregateType: 'target_job',
        aggregateId: job.id,
        eventType: 'job.ocr.requested',
      });
      return { job_id: job.id, ocr: 'requested' };
    },
  },
  {
    method: 'PATCH',
    pattern: '/jobs/:id/text',
    handler: ({ params, body, user, requestId, ipHash }) =>
      db.tx(() => {
        const job = loadJob(params, user);
        if (body.expected_revision !== undefined && body.expected_revision !== job.revision) {
          throw problem.conflict('REVISION_CONFLICT', '岗位信息已被其他端修改', {
            expected: body.expected_revision,
            current: job.revision,
          });
        }
        const text = String(body.confirmed_text || body.text || '');
        db.run('UPDATE target_jobs SET confirmed_text = ?, updated_at = ? WHERE id = ?', [
          text,
          nowIso(),
          job.id,
        ]);
        const revision = db.bumpRevision('target_jobs', job.id);
        if (body.confirm) {
          db.run("UPDATE target_jobs SET status = 'confirmed', updated_at = ? WHERE id = ?", [
            nowIso(),
            job.id,
          ]);
          queue.publish({
            aggregateType: 'target_job',
            aggregateId: job.id,
            eventType: 'job.analyze.requested',
          });
        }
        audit.log({
          ownerId: user.id,
          action: body.confirm ? 'job_text_confirmed' : 'job_text_saved',
          resourceType: 'target_job',
          resourceId: job.id,
          requestId,
          ipHash,
          metadata: { length: text.length, confirmed: Boolean(body.confirm) },
        });
        return { id: job.id, revision, status: body.confirm ? 'confirmed' : job.status };
      }),
  },
  {
    method: 'POST',
    pattern: '/jobs/:id/analyze',
    handler: ({ params, user, requestId, ipHash }) => {
      const job = loadJob(params, user);
      const project = db.get('SELECT * FROM resume_projects WHERE id = ?', [job.project_id]);
      if (!job.confirmed_text) throw problem.unprocessable('JOB_NOT_CONFIRMED', '请先确认岗位文本');
      const analysis = analyzeJobText(job.confirmed_text);
      const match = matchJobWithProfile(analysis, projectFacts(project));
      db.tx(() => {
        db.run('UPDATE target_jobs SET analysis_json = ?, updated_at = ? WHERE id = ?', [
          JSON.stringify({ ...analysis, match }),
          nowIso(),
          job.id,
        ]);
        db.bumpRevision('target_jobs', job.id);
      });
      audit.log({
        ownerId: user.id,
        action: 'job_analyzed',
        resourceType: 'target_job',
        resourceId: job.id,
        requestId,
        ipHash,
        metadata: { covered: match.covered, total: match.total },
      });
      return toJobView(db.get('SELECT * FROM target_jobs WHERE id = ?', [job.id]));
    },
  },
  {
    method: 'GET',
    pattern: '/jobs/:id/events',
    handler: ({ params, user }) => {
      const job = loadJob(params, user);
      const sources = db.all(
        'SELECT * FROM job_sources WHERE job_id = ? ORDER BY sort_order ASC',
        [job.id],
      );
      const pending = db.get(
        `SELECT COUNT(*) AS total FROM outbox_events
         WHERE aggregate_id = ? AND status IN ('pending','processing')`,
        [job.id],
      ).total;
      const analysis = JSON.parse(job.analysis_json || '{}');
      return {
        job_id: job.id,
        status: job.status,
        revision: job.revision,
        ocr: {
          pending: pending > 0,
          low_confidence: sources.some((source) => (source.ocr_confidence || 0) < 0.6),
          needs_manual: !job.confirmed_text,
          sources: sources.map((source) => ({
            id: source.id,
            sort_order: source.sort_order,
            ocr_confidence: source.ocr_confidence,
            has_text: Boolean(source.ocr_raw_text),
          })),
        },
        analysis_ready: Object.keys(analysis).length > 0,
      };
    },
  },
  {
    // 新岗位候选确认后才替换当前岗位（P0-07 / P0-20）
    method: 'POST',
    pattern: '/jobs/:id/set-current',
    handler: ({ params, user, requestId, ipHash }) =>
      db.tx(() => {
        const job = loadJob(params, user);
        if (job.status !== 'confirmed') {
          throw problem.unprocessable('JOB_NOT_CONFIRMED', '请先确认岗位文本再设为当前岗位');
        }
        const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
          job.project_id,
          user.id,
        ]);
        const previousJobId = project.current_job_id;
        db.run('UPDATE resume_projects SET current_job_id = ?, updated_at = ? WHERE id = ?', [
          job.id,
          nowIso(),
          project.id,
        ]);
        const revision = db.bumpRevision('resume_projects', project.id);
        audit.log({
          ownerId: user.id,
          action: 'job_set_current',
          resourceType: 'target_job',
          resourceId: job.id,
          requestId,
          ipHash,
          metadata: { previous_job_id: previousJobId },
        });
        // 岗位切换后重新分析匹配关系，只生成调整方案，不自动重写整份简历
        queue.publish({
          aggregateType: 'target_job',
          aggregateId: job.id,
          eventType: 'job.analyze.requested',
        });
        return { id: job.id, current: true, project_revision: revision, resume_unchanged: true };
      }),
  },
  {
    method: 'POST',
    pattern: '/jobs/:id/discard',
    handler: ({ params, user, requestId, ipHash }) => {
      const job = loadJob(params, user);
      db.run("UPDATE target_jobs SET status = 'discarded', updated_at = ? WHERE id = ?", [
        nowIso(),
        job.id,
      ]);
      audit.log({
        ownerId: user.id,
        action: 'job_candidate_discarded',
        resourceType: 'target_job',
        resourceId: job.id,
        requestId,
        ipHash,
      });
      return { id: job.id, status: 'discarded' };
    },
  },
];

module.exports = { routes };
