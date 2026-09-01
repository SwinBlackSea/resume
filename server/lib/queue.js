'use strict';
/**
 * 任务队列与 Worker（TECH §3、§8）。
 *
 * - 业务事务提交时把事件写入 outbox_events；独立 publisher 投递到队列，
 *   保证「数据库提交成功但队列暂时不可用」时任务不丢失（TECH §8.1、§18.2）。
 * - Worker 按 DAG 执行生成任务：
 *   analyze_job → compose_resume → validate_facts → render_html →
 *   （render_pdf ∥ render_docx）→ validate_artifacts → finalize
 * - 每一步有独立超时与错误码；PDF 与 DOCX 中一个成功时整体为 partial（TECH §8.3）。
 */
const db = require('./db');
const events = require('./events');
const { uuidv7, nowIso, sha256, problem } = require('./util');
const { composeResume, splitBullets } = require('./compose');
const { analyzeJobText, matchJobWithProfile } = require('./job-analyzer');
const { validateResumeJson, validateFacts } = require('./resume-schema');
const { recognizeJobSources } = require('./ocr');
const { putObject } = require('./storage');
const { renderPdf } = require('./render/pdf');
const { renderDocx } = require('./render/docx');
const { renderHtml } = require('./render/html');

const STEPS = [
  { key: 'analyze_job', label: '正在校验资料与岗位', progress: 15 },
  { key: 'compose_resume', label: '正在重组简历内容', progress: 35 },
  { key: 'validate_facts', label: '正在检查内容是否真实', progress: 50 },
  { key: 'render_html', label: '正在排版简历', progress: 62 },
  { key: 'render_artifacts', label: '正在渲染 PDF 与 DOCX', progress: 80 },
  { key: 'validate_artifacts', label: '正在校验导出文件', progress: 92 },
  { key: 'finalize', label: '正在保存版本', progress: 100 },
];

/** 写入 outbox 事件（通常在业务事务内调用）。 */
function publish({ aggregateType, aggregateId, eventType, payload = {} }) {
  db.run(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload_json, status, attempts, available_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [uuidv7(), aggregateType, aggregateId, eventType, JSON.stringify(payload), nowIso(), nowIso()],
  );
}

// ---------------------------------------------------------------- 生成任务

function updateJob(generationId, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const assignments = fields.map((field) => `${field} = ?`).join(', ');
  db.run(`UPDATE generation_jobs SET ${assignments}, updated_at = ? WHERE id = ?`, [
    ...fields.map((field) => patch[field]),
    nowIso(),
    generationId,
  ]);
}

function emitGeneration(snapshotId, state) {
  const job = db.get('SELECT * FROM generation_jobs WHERE snapshot_id = ?', [snapshotId]);
  if (job) events.publish(job.id, { ...state, snapshot_id: snapshotId, at: nowIso() });
}

function stepOf(key) {
  return STEPS.find((step) => step.key === key);
}

/** 保存产物并登记 artifacts（先写对象，再在 finalize 事务中登记，保证原子性）。 */
function writeArtifactFile(ownerId, snapshotId, type, buffer, mimeType) {
  const key = `${ownerId}/artifacts/${snapshotId}-${type}`;
  putObject(key, buffer);
  return { key, size: buffer.length, sha256: sha256(buffer), mimeType };
}

function registerArtifact({ ownerId, snapshotId, versionId, type, file, status = 'ready' }) {
  const id = uuidv7();
  db.run(
    `INSERT INTO artifacts (id, snapshot_id, version_id, owner_id, type, object_key, mime_type, size, sha256, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      snapshotId || null,
      versionId || null,
      ownerId,
      type,
      file.key,
      file.mimeType,
      file.size,
      file.sha256,
      status,
      nowIso(),
    ],
  );
  return id;
}

/**
 * 执行生成任务。
 * @param {string} snapshotId
 */
async function runGeneration(snapshotId) {
  const snapshot = db.get('SELECT * FROM generation_snapshots WHERE id = ?', [snapshotId]);
  if (!snapshot) return;
  const job = db.get('SELECT * FROM generation_jobs WHERE snapshot_id = ?', [snapshotId]);
  if (!job || job.status === 'canceled') return;

  const owner = { id: snapshot.owner_id };
  const projectId = snapshot.project_id;
  const profilePayload = JSON.parse(snapshot.profile_payload || '{}');
  const templatePayload = JSON.parse(snapshot.template_payload || '{}');
  const jobPayload = JSON.parse(snapshot.job_payload || '{}');

  const attempt = job.attempt_count + 1;
  updateJob(job.id, {
    status: 'running',
    current_step: 'analyze_job',
    progress: 5,
    attempt_count: attempt,
    started_at: job.started_at || nowIso(),
    error_code: null,
    error_message_safe: null,
  });
  emitGeneration(snapshotId, { status: 'running', step: 'analyze_job', progress: 5, label: '正在校验资料与岗位' });

  const advance = (key) => {
    const step = stepOf(key);
    updateJob(job.id, { current_step: key, progress: step.progress });
    emitGeneration(snapshotId, { status: 'running', step: key, progress: step.progress, label: step.label });
  };

  try {
    // ---- analyze_job ----
    advance('analyze_job');
    let analysis = jobPayload.analysis;
    if (!analysis || !Object.keys(analysis).length) {
      analysis = analyzeJobText(jobPayload.confirmed_text || '');
    }
    const facts = (profilePayload.experiences || [])
      .filter((exp) => !exp.deleted_at)
      .flatMap((exp) => splitBullets(exp.description))
      .concat([profilePayload.summary || '']);
    const match = matchJobWithProfile(analysis, facts);
    const jobView = { ...jobPayload, analysis: { ...analysis, match } };

    // ---- compose_resume ----
    advance('compose_resume');
    const resume = composeResume({
      profileBasics: profilePayload.basics || {},
      profileSummary: profilePayload.summary || '',
      experiences: profilePayload.experiences || [],
      job: jobView,
      template: templatePayload,
    });

    // ---- validate_facts ----
    advance('validate_facts');
    const schemaCheck = validateResumeJson(resume);
    if (!schemaCheck.valid) {
      throw Object.assign(new Error('结构化简历未通过 Schema 校验'), {
        code: 'FACT_VALIDATION_FAILED',
        safe: schemaCheck.errors.join('；'),
      });
    }
    const factCheck = validateFacts(resume, facts);
    const blocking = factCheck.violations.filter((v) => v.code === 'MISSING_SOURCE');
    if (blocking.length) {
      throw Object.assign(new Error('存在缺少事实来源的内容'), {
        code: 'FACT_VALIDATION_FAILED',
        safe: '部分内容缺少已确认的事实来源，已停止生成',
      });
    }

    // ---- render_html ----
    advance('render_html');
    const htmlString = renderHtml({ resume, template: templatePayload });
    const htmlFile = writeArtifactFile(owner.id, snapshotId, 'html', Buffer.from(htmlString, 'utf8'), 'text/html; charset=utf-8');

    // ---- render_pdf ∥ render_docx（并行，允许部分成功） ----
    advance('render_artifacts');
    const [pdfResult, docxResult] = await Promise.allSettled([
      Promise.resolve().then(() => renderPdf({ resume, template: templatePayload })),
      Promise.resolve().then(() => renderDocx({ resume, template: templatePayload })),
    ]);

    const pdfFile = pdfResult.status === 'fulfilled'
      ? writeArtifactFile(owner.id, snapshotId, 'pdf', pdfResult.value.buffer, 'application/pdf')
      : null;
    const docxFile = docxResult.status === 'fulfilled'
      ? writeArtifactFile(
          owner.id,
          snapshotId,
          'docx',
          docxResult.value.buffer,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        )
      : null;

    if (!pdfFile && !docxFile) {
      const reason = pdfResult.reason || docxResult.reason;
      throw Object.assign(new Error('导出文件渲染失败'), {
        code: 'RENDER_FAILED',
        safe: reason && reason.code === 'RENDER_FONT_MISSING'
          ? '缺少中文字体，无法生成 PDF'
          : 'PDF 与 DOCX 均生成失败，请稍后重试',
      });
    }

    // ---- validate_artifacts ----
    advance('validate_artifacts');
    const maxPages = (templatePayload.schema && templatePayload.schema.page && templatePayload.schema.page.max_pages) || 2;
    const validation = {
      schema_valid: schemaCheck.valid,
      fact_violations: factCheck.violations,
      pending_claims: resume.pending_claims || [],
      pdf_pages: pdfResult.status === 'fulfilled' ? pdfResult.value.pages : null,
      page_limit: maxPages,
      page_overflow: pdfResult.status === 'fulfilled' ? pdfResult.value.pages > maxPages : false,
      artifacts: {
        pdf: pdfFile ? { size: pdfFile.size, sha256: pdfFile.sha256 } : null,
        docx: docxFile ? { size: docxFile.size, sha256: docxFile.sha256 } : null,
        html: { size: htmlFile.size, sha256: htmlFile.sha256 },
      },
      errors: [
        pdfResult.status === 'rejected' ? `PDF：${pdfResult.reason.message}` : null,
        docxResult.status === 'rejected' ? `DOCX：${docxResult.reason.message}` : null,
      ].filter(Boolean),
    };

    // 输出落库（先写 resume_outputs，finalize 事务内登记版本）
    db.run(
      `INSERT INTO resume_outputs (id, snapshot_id, owner_id, resume_json, explanation_json, validation_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)
       ON CONFLICT(snapshot_id) DO UPDATE SET resume_json = excluded.resume_json,
         explanation_json = excluded.explanation_json, validation_json = excluded.validation_json,
         status = excluded.status, updated_at = excluded.updated_at`,
      [
        uuidv7(),
        snapshotId,
        owner.id,
        JSON.stringify(resume),
        JSON.stringify({
          generation_notes: resume.generation_notes,
          pending_claims: resume.pending_claims,
          match,
        }),
        JSON.stringify(validation),
        nowIso(),
        nowIso(),
      ],
    );

    // ---- finalize（单事务：创建不可变版本 + 更新草稿） ----
    advance('finalize');
    const partial = Boolean((pdfFile && !docxFile) || (!pdfFile && docxFile));
    const versionId = db.tx(() => {
      const versionNo = db.nextSequence('resume_versions', projectId, 'version_no');
      const id = uuidv7();
      db.run(
        `INSERT INTO resume_versions (id, project_id, owner_id, version_no, kind, name, base_version_id,
           profile_payload, template_payload, job_payload, resume_payload, change_summary_json,
           artifact_refs_json, generation_snapshot_id, status, created_by, created_at)
         VALUES (?, ?, ?, ?, 'generated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?)`,
        [
          id,
          projectId,
          owner.id,
          versionNo,
          `AI 生成版本 · ${jobView.title || '当前岗位'}`,
          null, // 生成版本以快照为输入，base 留空
          JSON.stringify(profilePayload),
          JSON.stringify(templatePayload),
          JSON.stringify(jobView),
          JSON.stringify(resume),
          JSON.stringify({
            changes: (resume.generation_notes || []).map((note) => note.text),
            pending_claims: resume.pending_claims || [],
            match,
          }),
          JSON.stringify({}),
          snapshotId,
          partial ? 'partial' : 'complete',
          nowIso(),
        ],
      );
      registerArtifact({ ownerId: owner.id, snapshotId, versionId: id, type: 'html', file: htmlFile });
      if (pdfFile) registerArtifact({ ownerId: owner.id, snapshotId, versionId: id, type: 'pdf', file: pdfFile });
      if (docxFile) registerArtifact({ ownerId: owner.id, snapshotId, versionId: id, type: 'docx', file: docxFile });
      db.run(
        'UPDATE resume_versions SET artifact_refs_json = ? WHERE id = ?',
        [
          JSON.stringify({
            pdf: pdfFile ? pdfFile.key : null,
            docx: docxFile ? docxFile.key : null,
            html: htmlFile.key,
          }),
          id,
        ],
      );
      // 采用生成结果：草稿更新为生成内容，并清空「未成版修改」标记
      const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ?', [projectId]);
      if (draft) {
        db.run(
          `UPDATE resume_drafts SET resume_json = ?, base_version_id = ?, has_unsnapshotted_changes = 0, revision = ?, updated_at = ?
           WHERE id = ?`,
          [
            JSON.stringify(resume),
            id,
            db.nextSequence('resume_drafts', projectId, 'revision') || draft.revision + 1,
            nowIso(),
            draft.id,
          ],
        );
        db.run('UPDATE resume_drafts SET revision = revision + 1 WHERE id = ?', [draft.id]);
      }
      db.run('UPDATE resume_projects SET current_job_id = COALESCE(?, current_job_id), updated_at = ? WHERE id = ?', [
        jobPayload.id || null,
        nowIso(),
        projectId,
      ]);
      return id;
    });

    // 快照与任务状态（冻结 payload 不可 UPDATE，只更新状态字段）
    db.run("UPDATE generation_snapshots SET status = 'complete' WHERE id = ?", [snapshotId]);
    updateJob(job.id, {
      status: partial ? 'partial' : 'succeeded',
      current_step: 'finalize',
      progress: 100,
      finished_at: nowIso(),
    });
    emitGeneration(snapshotId, {
      status: partial ? 'partial' : 'succeeded',
      step: 'finalize',
      progress: 100,
      version_id: versionId,
      label: partial ? '已生成（部分格式失败）' : '新简历已生成',
    });
    return { versionId, status: partial ? 'partial' : 'succeeded' };
  } catch (err) {
    const code = err.code || 'GENERATION_FAILED';
    const safe = err.safe || '生成失败，可稍后重试（不消耗额度）';
    db.run("UPDATE generation_snapshots SET status = 'failed' WHERE id = ?", [snapshotId]);
    updateJob(job.id, {
      status: 'failed',
      current_step: job.current_step,
      error_code: code,
      error_message_safe: safe,
      finished_at: nowIso(),
    });
    emitGeneration(snapshotId, {
      status: 'failed',
      step: job.current_step,
      error_code: code,
      error_message: safe,
      label: '生成失败',
    });
    console.error('[generation] failed', snapshotId, code, err.message);
    return { status: 'failed', error_code: code };
  }
}

// ---------------------------------------------------------------- 岗位与模板任务

/** OCR 任务：写入 job_sources 的 OCR 文本与置信度。 */
async function runJobOcr(jobId) {
  const job = db.get('SELECT * FROM target_jobs WHERE id = ?', [jobId]);
  if (!job) return;
  const sources = db.all(
    `SELECT js.*, u.object_key, u.original_name, u.mime_type, u.id AS upload_id, u.size
     FROM job_sources js LEFT JOIN uploads u ON u.id = js.upload_id
     WHERE js.job_id = ? ORDER BY js.sort_order ASC`,
    [jobId],
  ).map((row) => ({ id: row.id, upload: row }));

  try {
    const result = await recognizeJobSources(sources);
    db.tx(() => {
      result.sources.forEach((item) => {
        db.run('UPDATE job_sources SET ocr_raw_text = ?, ocr_confidence = ? WHERE id = ?', [
          item.text,
          item.confidence,
          item.source_id,
        ]);
      });
      db.run('UPDATE target_jobs SET ocr_text = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [
        result.text,
        nowIso(),
        jobId,
      ]);
    });
    // 若已有确认文本则保持；否则将 OCR 结果作为待确认文本
    if (!job.confirmed_text && result.text) {
      db.run('UPDATE target_jobs SET confirmed_text = ?, status = ?, updated_at = ? WHERE id = ?', [
        result.text,
        'confirmed',
        nowIso(),
        jobId,
      ]);
    }
    return { ok: true, lowConfidence: result.lowConfidence };
  } catch (err) {
    console.error('[ocr] failed', jobId, err.message);
    return { ok: false, error_code: err.code || 'OCR_FAILED' };
  }
}

/** 岗位分析任务。 */
function runJobAnalyze(jobId) {
  const job = db.get('SELECT * FROM target_jobs WHERE id = ?', [jobId]);
  if (!job) return;
  const project = db.get('SELECT * FROM resume_projects WHERE id = ?', [job.project_id]);
  const profile = db.get('SELECT * FROM profiles WHERE id = ?', [project.current_profile_id]);
  const experiences = db.all(
    'SELECT * FROM experiences WHERE profile_id = ? AND deleted_at IS NULL',
    [profile.id],
  );
  const analysis = analyzeJobText(job.confirmed_text || job.ocr_text || '');
  const facts = experiences
    .flatMap((exp) => splitBullets(exp.description))
    .concat([profile.summary || '']);
  const match = matchJobWithProfile(analysis, facts);
  db.tx(() => {
    db.run('UPDATE target_jobs SET analysis_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [
      JSON.stringify({ ...analysis, match }),
      nowIso(),
      jobId,
    ]);
  });
  return { ok: true };
}

/** 模板解析任务（MVP：系统模板直出 ready；自定义模板校验格式与安全）。 */
function runTemplateParse({ templateVersionId }) {
  const version = db.get('SELECT * FROM template_versions WHERE id = ?', [templateVersionId]);
  if (!version) return;
  const definition = db.get('SELECT * FROM template_definitions WHERE id = ?', [version.template_id]);
  if (!definition) return;
  db.run("UPDATE template_definitions SET status = 'ready', updated_at = ? WHERE id = ?", [
    nowIso(),
    definition.id,
  ]);
  return { ok: true };
}

// ---------------------------------------------------------------- Worker 循环

const HANDLERS = {
  'generation.created': ({ aggregateId }) => runGeneration(aggregateId),
  'job.ocr.requested': ({ aggregateId }) => runJobOcr(aggregateId),
  'job.analyze.requested': ({ aggregateId }) => runJobAnalyze(aggregateId),
  'template.parse.requested': ({ payload }) => runTemplateParse(payload),
};

let timer = null;
let running = false;

/** 处理一批 outbox 事件（测试与手动触发入口）。 */
async function processOnce(limit = 10) {
  if (running) return 0;
  running = true;
  const rows = db
    .all(
      `SELECT * FROM outbox_events WHERE status = 'pending' AND available_at <= ? ORDER BY created_at ASC LIMIT ?`,
      [nowIso(), limit],
    );
  for (const row of rows) {
    db.run("UPDATE outbox_events SET status = 'processing', attempts = attempts + 1 WHERE id = ?", [row.id]);
    const handler = HANDLERS[row.event_type];
    try {
      if (handler) await handler({ aggregateId: row.aggregate_id, payload: JSON.parse(row.payload_json) });
      db.run("UPDATE outbox_events SET status = 'done', processed_at = ? WHERE id = ?", [nowIso(), row.id]);
    } catch (err) {
      const attempts = row.attempts + 1;
      const retryable = err && err.code === 'PROVIDER_TEMPORARY';
      if (retryable && attempts < 3) {
        // 可重试错误使用指数退避加随机抖动（TECH §8.4）
        const delay = Math.round(Math.min(30000, 500 * 2 ** attempts) + Math.random() * 300);
        db.run('UPDATE outbox_events SET status = ?, available_at = ? WHERE id = ?', [
          'pending',
          new Date(Date.now() + delay).toISOString(),
          row.id,
        ]);
      } else {
        db.run("UPDATE outbox_events SET status = 'failed', processed_at = ? WHERE id = ?", [
          nowIso(),
          row.id,
        ]);
        console.error('[outbox] failed', row.event_type, err && err.message);
      }
    }
  }
  running = false;
  return rows.length;
}

function startWorker(intervalMs = 700) {
  if (timer) return;
  timer = setInterval(() => {
    processOnce().catch((err) => console.error('[worker]', err));
  }, intervalMs);
  if (timer.unref) timer.unref();
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  publish,
  processOnce,
  startWorker,
  stopWorker,
  runGeneration,
  runJobOcr,
  runJobAnalyze,
  runTemplateParse,
  STEPS,
};
