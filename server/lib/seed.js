'use strict';
/**
 * 初始化演示数据（对应原型初始状态与 AI_BEHAVIOR_TESTS.md 测试夹具）。
 * 仅在数据库为空时执行一次。
 */
const db = require('./db');
const { uuidv7, nowIso, sha256, deepClone } = require('./util');
const { putObject, objectKey } = require('./storage');
const fixtures = require('./fixtures');
const { DEMO_EMAIL } = require('./auth');
const ResumeDom = require('../../resume-dom');

/** 按「今天 -offset 天 + 指定时刻」生成 ISO 时间（本地时区构造，保证界面显示与设定一致）。 */
function atTime(dayOffset, time) {
  const [hour, minute] = time.split(':').map(Number);
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function timeLabel(dayOffset, time) {
  if (dayOffset === 0) return `今天 ${time}`;
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`;
}

function seedIfEmpty() {
  const existing = db.get('SELECT * FROM users WHERE email = ?', [DEMO_EMAIL]);
  if (existing) return { seeded: false };

  return db.tx(() => {
    // ---- 用户 ----
    const userId = uuidv7();
    db.run(
      `INSERT INTO users (id, email, phone, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [userId, DEMO_EMAIL, fixtures.PROFILE_BASICS.phone, '陈', nowIso(), nowIso()],
    );

    // ---- 项目（先建，再回填 profile / job / template 引用） ----
    const projectId = uuidv7();
    db.run(
      `INSERT INTO resume_projects (id, owner_id, name, revision, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'active', ?, ?)`,
      [projectId, userId, '高级产品经理 · 企业服务', nowIso(), nowIso()],
    );

    // ---- 个人信息 ----
    const profileId = uuidv7();
    db.run(
      `INSERT INTO profiles (id, project_id, owner_id, basics_json, summary, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        profileId,
        projectId,
        userId,
        JSON.stringify(fixtures.PROFILE_BASICS),
        fixtures.PROFILE_BASICS.summary,
        nowIso(),
        nowIso(),
      ],
    );

    // ---- 经历（工作 / 项目 / 教育 / 技能） ----
    const experienceIds = {};
    fixtures.EXPERIENCES.forEach((exp, index) => {
      const id = uuidv7();
      experienceIds[exp.key] = id;
      db.run(
        `INSERT INTO experiences (id, profile_id, owner_id, type, organization, title, start_date, end_date, is_current, description, meta_json, sort_order, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          id,
          profileId,
          userId,
          exp.type,
          exp.organization,
          exp.title,
          exp.start_date,
          exp.end_date,
          exp.is_current,
          exp.description,
          JSON.stringify({ period_label: exp.period_label }),
          index,
          nowIso(),
          nowIso(),
        ],
      );
    });
    fixtures.CERTIFICATES.forEach((cert, index) => {
      db.run(
        `INSERT INTO experiences (id, profile_id, owner_id, type, organization, title, start_date, end_date, is_current, description, meta_json, sort_order, revision, created_at, updated_at)
         VALUES (?, ?, ?, 'certificate', ?, ?, ?, ?, 0, '', ?, ?, 1, ?, ?)`,
        [
          uuidv7(),
          profileId,
          userId,
          cert.organization,
          cert.title,
          cert.start_date,
          cert.end_date,
          JSON.stringify({ period_label: cert.period_label }),
          fixtures.EXPERIENCES.length + index,
          nowIso(),
          nowIso(),
        ],
      );
    });
    fixtures.SKILLS.forEach((skill, index) => {
      // 技能排在经历与证书之后，避免 sort_order 冲突
      const skillOrder = fixtures.EXPERIENCES.length + fixtures.CERTIFICATES.length + index;
      db.run(
        `INSERT INTO experiences (id, profile_id, owner_id, type, organization, title, start_date, end_date, is_current, description, meta_json, sort_order, revision, created_at, updated_at)
         VALUES (?, ?, ?, 'skill', '', ?, '', '', 0, '', '{}', ?, 1, ?, ?)`,
        [uuidv7(), profileId, userId, skill, skillOrder, nowIso(), nowIso()],
      );
    });

    // ---- 上传文件与岗位 ----
    const jobId = uuidv7();
    db.run(
      `INSERT INTO target_jobs (id, project_id, owner_id, title, company, confirmed_text, ocr_text, analysis_json, revision, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'confirmed', ?, ?)`,
      [
        jobId,
        projectId,
        userId,
        '高级产品经理',
        '企业服务',
        fixtures.JOB_TEXT,
        fixtures.JOB_TEXT,
        JSON.stringify(fixtures.JOB_ANALYSIS),
        nowIso(),
        nowIso(),
      ],
    );

    // 3 张岗位截图：OCR 文本按段分配，模拟跨图拼接
    const jobParagraphs = fixtures.JOB_TEXT.split('\n\n');
    fixtures.JOB_INPUT_FILES.forEach((file, index) => {
      const uploadId = uuidv7();
      const key = objectKey(userId, 'job-file', file.name);
      putObject(key, Buffer.from(`占位内容：${file.name}`, 'utf8'));
      db.run(
        `INSERT INTO uploads (id, owner_id, object_key, original_name, mime_type, size, sha256, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
        [
          uploadId,
          userId,
          key,
          file.name,
          file.mime,
          file.size,
          sha256(file.name),
          nowIso(),
          nowIso(),
        ],
      );
      const chunk = jobParagraphs.slice(index, index + 2).join('\n\n');
      db.run(
        `INSERT INTO job_files (id, job_id, owner_id, upload_id, sort_order, ocr_raw_text, ocr_confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv7(), jobId, userId, uploadId, index, chunk, 0.91, nowIso()],
      );
    });

    // 演示用旧简历上传文件
    fixtures.PROFILE_UPLOAD_FILES.forEach((file) => {
      const uploadId = uuidv7();
      const key = objectKey(userId, 'profile-file', file.name);
      putObject(key, Buffer.from(`占位内容：${file.name}`, 'utf8'));
      db.run(
        `INSERT INTO uploads (id, owner_id, object_key, original_name, mime_type, size, sha256, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
        [
          uploadId,
          userId,
          key,
          file.name,
          file.mime,
          file.size,
          sha256(file.name),
          nowIso(),
          nowIso(),
        ],
      );
    });

    // ---- 当前简历草稿 ----
    const draftResume = ResumeDom.toResumeDocument(deepClone(fixtures.RESUME_DRAFT));
    const draftId = uuidv7();
    db.run(
      `INSERT INTO resume_drafts (id, project_id, owner_id, resume_json, base_version_id, revision, has_unsnapshotted_changes, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 1, 0, ?, ?)`,
      [draftId, projectId, userId, JSON.stringify(draftResume), nowIso(), nowIso()],
    );

    // ---- 历史版本（冻结三类输入与简历结果） ----
    const versionIds = {};
    fixtures.VERSION_FIXTURES.forEach((fixture) => {
      const id = uuidv7();
      versionIds[fixture.key] = id;
      const createdAt = fixture.fixed_date
        ? (() => {
            const d = new Date();
            d.setFullYear(d.getFullYear() + (fixture.fixed_date.year_offset || 0));
            d.setMonth(fixture.fixed_date.month - 1, fixture.fixed_date.day);
            const [hh, mm] = fixture.fixed_date.time.split(':').map(Number);
            d.setHours(hh, mm, 0, 0);
            return d.toISOString();
          })()
        : atTime(fixture.day_offset, fixture.time);
      // 版本保存完整简历内容，仅覆盖版本详情展示的主要经历文本
      const legacyResume = deepClone(fixtures.RESUME_DRAFT);
      legacyResume.summary = fixture.advantage;
      const mainWork = ((legacyResume.experience || [])[0] || {}).bullets || [];
      const workBullet = mainWork.find((b) => b.id === 'target-bullet') || mainWork[0];
      if (workBullet) workBullet.text = fixture.work;
      const mainProject = ((legacyResume.projects || [])[0] || {}).bullets || [];
      const projectBullet = mainProject.find((b) => b.id === 'scale-bullet') || mainProject[0];
      if (projectBullet) projectBullet.text = fixture.project;
      const resumePayload = ResumeDom.toResumeDocument(legacyResume);
      db.run(
        `INSERT INTO resume_versions (id, project_id, owner_id, version_no, kind, name, base_version_id,
           profile_payload, template_payload, job_payload, resume_payload, change_summary_json,
           artifact_refs_json, generation_snapshot_id, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, '{}', NULL, 'complete', ?, ?)`,
        [
          id,
          projectId,
          userId,
          fixture.version_no,
          fixture.kind,
          fixture.name,
          JSON.stringify({
            basics: fixtures.PROFILE_BASICS,
            summary: fixtures.PROFILE_BASICS.summary,
            experiences: fixtures.EXPERIENCES.map((exp) => ({
              id: experienceIds[exp.key],
              type: exp.type,
              organization: exp.organization,
              title: exp.title,
              start_date: exp.start_date,
              end_date: exp.end_date,
              is_current: exp.is_current,
              description: exp.description,
            })),
            revision: 1,
          }),
          JSON.stringify({}),
          JSON.stringify({
            id: jobId,
            title: fixture.job.split(' · ')[0],
            company: '企业服务',
            confirmed_text: fixtures.JOB_TEXT,
            analysis: fixtures.JOB_ANALYSIS,
            revision: 1,
            status: 'confirmed',
          }),
          JSON.stringify(resumePayload),
          JSON.stringify({
            changes: fixture.changes,
            list_summary: fixture.list_summary,
            profile_data: fixture.profile_data,
            job_data: fixture.job_data,
            compare_note: fixture.compare_note,
            time_label: fixture.fixed_date
              ? `${fixture.fixed_date.month} 月 ${fixture.fixed_date.day} 日 ${fixture.fixed_date.time}`
              : timeLabel(fixture.day_offset, fixture.time),
          }),
          fixture.kind === 'generated' ? 'ai' : 'user',
          createdAt,
        ],
      );
    });

    // 当前草稿基于 v3
    db.run('UPDATE resume_drafts SET base_version_id = ? WHERE id = ?', [versionIds.v3, draftId]);

    // ---- 回填项目引用 ----
    db.run(
      'UPDATE resume_projects SET current_profile_id = ?, current_job_id = ?, current_template_version_id = NULL, updated_at = ? WHERE id = ?',
      [profileId, jobId, nowIso(), projectId],
    );

    // ---- AI 会话与欢迎语 ----
    const conversationId = uuidv7();
    db.run(
      `INSERT INTO ai_conversations (id, project_id, owner_id, active_scope_type, active_scope_id, created_at, updated_at)
       VALUES (?, ?, ?, 'RESUME_DOCUMENT', NULL, ?, ?)`,
      [conversationId, projectId, userId, nowIso(), nowIso()],
    );
    db.run(
      `INSERT INTO ai_messages (id, conversation_id, owner_id, role, content, scope_type, scope_id, scope_revision, model_metadata_json, created_at)
       VALUES (?, ?, ?, 'assistant', ?, 'RESUME_DOCUMENT', NULL, 1, '{}', ?)`,
      [uuidv7(), conversationId, userId, fixtures.WELCOME_MESSAGE, nowIso()],
    );

    return { seeded: true, projectId, userId, versionIds, experienceIds, jobId, conversationId };
  });
}

module.exports = { seedIfEmpty };
