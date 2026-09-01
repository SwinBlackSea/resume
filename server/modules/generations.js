'use strict';
/**
 * 生成模块（PRD §6.4、TECH §8）。
 *
 * 创建阶段在一个数据库事务中完成：锁定项目 → 校验 owner / revision / 模板 / 岗位 →
 * 预占额度 → 深拷贝三类输入 → 分配 generation_no → 写快照与任务 → 写 outbox 事件。
 * 生成快照是内部任务记录，不立即出现在历史列表；Worker 成功后才创建 kind=generated 的版本。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, problem, hashJson } = require('../lib/util');
const audit = require('../lib/audit');
const { withIdempotency } = require('../lib/idempotency');
const queue = require('../lib/queue');
const events = require('../lib/events');
const { computeReadiness } = require('../lib/resume-schema');
const { sseOpen, sseWrite } = require('../lib/util');

function loadProject(projectId, user) {
  const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
    projectId,
    user.id,
  ]);
  if (!project) throw problem.notFound('项目不存在');
  return project;
}

/** 组装快照输入（规范化深拷贝，冻结当时的三类输入）。 */
function collectInputs(project, user) {
  const profile = db.get('SELECT * FROM profiles WHERE id = ? AND owner_id = ?', [
    project.current_profile_id,
    user.id,
  ]);
  const experiences = db
    .all('SELECT * FROM experiences WHERE profile_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC', [
      profile.id,
    ])
    .map((row) => ({
      id: row.id,
      type: row.type,
      organization: row.organization,
      title: row.title,
      start_date: row.start_date,
      end_date: row.end_date,
      is_current: row.is_current,
      description: row.description,
      revision: row.revision,
    }));
  const job = project.current_job_id
    ? db.get('SELECT * FROM target_jobs WHERE id = ? AND owner_id = ?', [project.current_job_id, user.id])
    : null;
  const templateVersion = project.current_template_version_id
    ? db.get('SELECT * FROM template_versions WHERE id = ?', [project.current_template_version_id])
    : null;
  const templateDefinition = templateVersion
    ? db.get('SELECT * FROM template_definitions WHERE id = ?', [templateVersion.template_id])
    : null;
  return {
    profile,
    experiences,
    job,
    templateVersion,
    templateDefinition,
    profilePayload: {
      basics: JSON.parse(profile.basics_json || '{}'),
      summary: profile.summary,
      experiences,
      revision: profile.revision,
    },
    templatePayload: templateVersion
      ? {
          template_version_id: templateVersion.id,
          name: templateDefinition ? templateDefinition.name : '自定义模板',
          version: templateVersion.version,
          schema: JSON.parse(templateVersion.schema_json || '{}'),
        }
      : {},
    jobPayload: job
      ? {
          id: job.id,
          title: job.title,
          company: job.company,
          confirmed_text: job.confirmed_text,
          analysis: JSON.parse(job.analysis_json || '{}'),
          revision: job.revision,
          status: job.status,
        }
      : null,
  };
}

const routes = [
  {
    method: 'POST',
    pattern: '/projects/:id/generations',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'generation', () =>
        db.tx(() => {
          const project = loadProject(params.id, user);
          const inputs = collectInputs(project, user);

          if (
            body.project_revision !== undefined &&
            body.project_revision !== project.revision
          ) {
            throw problem.conflict('REVISION_CONFLICT', '项目已变化，请刷新后重试', {
              expected: body.project_revision,
              current: project.revision,
            });
          }
          if (body.profile_revision !== undefined && body.profile_revision !== inputs.profile.revision) {
            throw problem.conflict('REVISION_CONFLICT', '个人资料已变化，请刷新后重试', {
              expected: body.profile_revision,
              current: inputs.profile.revision,
            });
          }
          if (
            body.job_revision !== undefined &&
            inputs.job &&
            body.job_revision !== inputs.job.revision
          ) {
            throw problem.conflict('REVISION_CONFLICT', '岗位信息已变化，请刷新后重试', {
              expected: body.job_revision,
              current: inputs.job.revision,
            });
          }
          if (
            body.template_version_id &&
            inputs.templateVersion &&
            body.template_version_id !== inputs.templateVersion.id
          ) {
            throw problem.conflict('REVISION_CONFLICT', '模板已更换，请刷新后重试');
          }

          // 前置条件校验：缺少必需素材时准确定位问题（PRD 发布验收 2）
          const readiness = computeReadiness({
            profileBasics: inputs.profilePayload.basics,
            experiences: inputs.experiences,
            template: inputs.templateDefinition ? { status: inputs.templateDefinition.status } : null,
            job: inputs.job,
          });
          if (!readiness.complete) {
            throw problem.unprocessable('PROFILE_INCOMPLETE', '生成前还需要补充一些内容', {
              missing: readiness.missing,
            });
          }

          const generationNo = db.nextSequence('generation_snapshots', project.id, 'generation_no');
          const snapshotId = uuidv7();
          const jobId = uuidv7();
          const inputHash = hashJson({
            profile: inputs.profilePayload,
            template: inputs.templatePayload,
            job: inputs.jobPayload,
          });

          db.run(
            `INSERT INTO generation_snapshots (id, project_id, owner_id, generation_no, profile_payload, template_payload, job_payload, generation_config, input_hash, status, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'user', ?)`,
            [
              snapshotId,
              project.id,
              user.id,
              generationNo,
              JSON.stringify(inputs.profilePayload),
              JSON.stringify(inputs.templatePayload),
              JSON.stringify(inputs.jobPayload),
              JSON.stringify({
                client_request_id: body.client_request_id || null,
                policy_version: 'policy-v1',
                schema_version: 'resume-schema-v1',
                prompt_version: 'prompt-contract-v2',
              }),
              inputHash,
              nowIso(),
            ],
          );
          db.run(
            `INSERT INTO generation_jobs (id, snapshot_id, owner_id, status, current_step, progress, attempt_count, created_at, updated_at)
             VALUES (?, ?, ?, 'queued', 'queued', 0, 0, ?, ?)`,
            [jobId, snapshotId, user.id, nowIso(), nowIso()],
          );
          // 先提交数据库 outbox，再投递队列：避免「有快照无任务」
          queue.publish({
            aggregateType: 'generation_snapshot',
            aggregateId: snapshotId,
            eventType: 'generation.created',
            payload: { job_id: jobId },
          });
          db.run('UPDATE resume_projects SET updated_at = ? WHERE id = ?', [nowIso(), project.id]);

          audit.log({
            ownerId: user.id,
            action: 'generation_started',
            resourceType: 'generation_snapshot',
            resourceId: snapshotId,
            requestId,
            ipHash,
            metadata: { generation_no: generationNo, input_hash: inputHash },
          });

          return {
            snapshot_id: snapshotId,
            generation_id: jobId,
            generation_no: generationNo,
            status: 'queued',
            input_hash: inputHash,
            events_url: `/api/v1/generations/${jobId}/events`,
            status_url: `/api/v1/generations/${jobId}`,
          };
        }),
      ),
  },
  {
    method: 'GET',
    pattern: '/generations/:id',
    handler: ({ params, user }) => {
      const job = db.get('SELECT * FROM generation_jobs WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!job) throw problem.notFound('生成任务不存在');
      const snapshot = db.get('SELECT * FROM generation_snapshots WHERE id = ?', [job.snapshot_id]);
      const output = db.get('SELECT * FROM resume_outputs WHERE snapshot_id = ?', [job.snapshot_id]);
      const version = db.get('SELECT * FROM resume_versions WHERE generation_snapshot_id = ?', [
        job.snapshot_id,
      ]);
      return {
        id: job.id,
        snapshot_id: job.snapshot_id,
        status: job.status,
        current_step: job.current_step,
        progress: job.progress,
        attempt_count: job.attempt_count,
        error_code: job.error_code,
        error_message: job.error_message_safe,
        started_at: job.started_at,
        finished_at: job.finished_at,
        model: { provider: job.model_provider, name: job.model_name, prompt_version: job.prompt_version },
        snapshot_status: snapshot ? snapshot.status : null,
        generation_no: snapshot ? snapshot.generation_no : null,
        version: version
          ? { id: version.id, version_no: version.version_no, name: version.name, status: version.status }
          : null,
        output: output
          ? {
              resume_json: JSON.parse(output.resume_json || '{}'),
              explanation: JSON.parse(output.explanation_json || '{}'),
              validation: JSON.parse(output.validation_json || '{}'),
            }
          : null,
      };
    },
  },
  {
    method: 'GET',
    pattern: '/generations/:id/events',
    sse: true,
    handler: ({ params, user, res }) => {
      const job = db.get('SELECT * FROM generation_jobs WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!job) throw problem.notFound('生成任务不存在');
      sseOpen(res);
      // 先补发当前状态：任务可能在订阅前就已结束，必须避免前端收不到终态
      const versionRow = db.get('SELECT id FROM resume_versions WHERE generation_snapshot_id = ?', [
        job.snapshot_id,
      ]);
      sseWrite(res, 'progress', {
        id: job.id,
        status: job.status,
        step: job.current_step,
        progress: job.progress,
        error_code: job.error_code,
        error_message: job.error_message_safe,
        label: stepLabel(job.current_step),
        version_id: versionRow ? versionRow.id : null,
      });
      if (['succeeded', 'partial', 'failed', 'canceled'].includes(job.status)) {
        setTimeout(() => {
          if (!res.writableEnded) res.end();
        }, 50);
        return { __sse: true };
      }
      const unsubscribe = events.subscribe(job.id, (payload) => {
        sseWrite(res, 'progress', { ...payload, label: payload.label || stepLabel(payload.step) });
        if (['succeeded', 'partial', 'failed', 'canceled'].includes(payload.status)) {
          setTimeout(() => {
            unsubscribe();
            res.end();
          }, 50);
        }
      });
      req_keepalive(res);
      return { __sse: true };
    },
  },
  {
    method: 'POST',
    pattern: '/generations/:id/retry',
    handler: ({ params, user, requestId, ipHash }) => {
      const job = db.get('SELECT * FROM generation_jobs WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!job) throw problem.notFound('生成任务不存在');
      if (!['failed', 'partial'].includes(job.status)) {
        throw problem.conflict('GENERATION_NOT_RETRYABLE', '仅失败或部分成功的任务可重试');
      }
      db.tx(() => {
        db.run(
          `UPDATE generation_jobs SET status = 'queued', error_code = NULL, error_message_safe = NULL, progress = 0, current_step = 'queued', updated_at = ? WHERE id = ?`,
          [nowIso(), job.id],
        );
        db.run("UPDATE generation_snapshots SET status = 'pending' WHERE id = ?", [job.snapshot_id]);
        // 重试只重跑失败步骤，继续引用同一快照
        queue.publish({
          aggregateType: 'generation_snapshot',
          aggregateId: job.snapshot_id,
          eventType: 'generation.created',
          payload: { job_id: job.id, retry: true },
        });
      });
      audit.log({
        ownerId: user.id,
        action: 'generation_retried',
        resourceType: 'generation_job',
        resourceId: job.id,
        requestId,
        ipHash,
        metadata: { attempt: job.attempt_count + 1 },
      });
      return { id: job.id, status: 'queued', snapshot_id: job.snapshot_id };
    },
  },
  {
    method: 'POST',
    pattern: '/generations/:id/cancel',
    handler: ({ params, user, requestId, ipHash }) => {
      const job = db.get('SELECT * FROM generation_jobs WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!job) throw problem.notFound('生成任务不存在');
      if (['succeeded', 'failed', 'canceled'].includes(job.status)) {
        return { id: job.id, status: job.status, idempotent_replay: true };
      }
      db.run(
        "UPDATE generation_jobs SET status = 'canceled', finished_at = ?, updated_at = ? WHERE id = ?",
        [nowIso(), nowIso(), job.id],
      );
      audit.log({
        ownerId: user.id,
        action: 'generation_canceled',
        resourceType: 'generation_job',
        resourceId: job.id,
        requestId,
        ipHash,
      });
      return { id: job.id, status: 'canceled' };
    },
  },
  {
    method: 'GET',
    pattern: '/projects/:id/generations',
    handler: ({ params, user }) => {
      const project = loadProject(params.id, user);
      return {
        items: db
          .all(
            `SELECT gj.* FROM generation_jobs gj
             JOIN generation_snapshots gs ON gs.id = gj.snapshot_id
             WHERE gs.project_id = ? AND gj.owner_id = ?
             ORDER BY gj.created_at DESC LIMIT 20`,
            [project.id, user.id],
          )
          .map((row) => ({
            id: row.id,
            status: row.status,
            current_step: row.current_step,
            progress: row.progress,
            error_code: row.error_code,
            created_at: row.created_at,
          })),
      };
    },
  },
];

/** 步骤 → 界面文案（与前端运行日志一致）。 */
const STEP_LABELS = {
  queued: '正在校验资料与岗位',
  analyze_job: '正在校验资料与岗位',
  compose_resume: '正在重组简历内容',
  validate_facts: '正在检查内容是否真实',
  render_html: '正在排版简历',
  render_artifacts: '正在渲染 PDF 与 DOCX',
  validate_artifacts: '正在校验导出文件',
  finalize: '正在保存版本',
};
function stepLabel(step) {
  return STEP_LABELS[step] || '正在生成';
}

/** SSE 心跳，避免代理中断连接。 */
function req_keepalive(res) {
  const timer = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(timer);
      return;
    }
    res.write(': ping\n\n');
  }, 15000);
  if (timer.unref) timer.unref();
  res.on('close', () => clearInterval(timer));
}

module.exports = { routes };
