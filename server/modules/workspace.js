'use strict';
/**
 * 工作区聚合：一次请求返回三栏所需的全部服务端状态（TECH §4.2）。
 * 个人信息、岗位信息、模板、历史版本与生成进度都在工作区内完成，不通过页面跳转打断上下文。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, problem } = require('../lib/util');
const { computeReadiness, computeProfileCompleteness } = require('../lib/resume-schema');
const { splitBullets } = require('../lib/compose');
const { SCOPE_LABEL } = require('../lib/policy');
const { DEMO_EMAIL } = require('../lib/auth');
const ResumeDom = require('../../resume-dom');

function toExperienceView(row) {
  const meta = JSON.parse(row.meta_json || '{}');
  return {
    id: row.id,
    type: row.type,
    organization: row.organization,
    title: row.title,
    start_date: row.start_date,
    end_date: row.end_date,
    is_current: Boolean(row.is_current),
    period_label: meta.period_label || '',
    description: row.description, // 学历、角色等补充信息（用于资料分类展示）
    bullets: splitBullets(row.description),
    revision: row.revision,
  };
}

function toJobView(job) {
  if (!job) return null;
  const analysis = JSON.parse(job.analysis_json || '{}');
  const files = db.all(
    `SELECT js.id, js.sort_order, js.ocr_confidence, u.original_name AS file_name
     FROM job_files js LEFT JOIN uploads u ON u.id = js.upload_id
     WHERE js.job_id = ? ORDER BY js.sort_order ASC`,
    [job.id],
  );
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    status: job.status,
    revision: job.revision,
    confirmed_text: job.confirmed_text,
    ocr_text: job.ocr_text,
    files,
    analysis: {
      title: analysis.title || job.title,
      company: analysis.company || job.company,
      location: analysis.location || '',
      experience: analysis.experience || '',
      education: analysis.education || '',
      keywords: analysis.keywords || [],
      disclaimer: analysis.disclaimer || '',
      responsibilities: analysis.responsibilities || [],
      must_have: analysis.must_have || [],
      nice_to_have: analysis.nice_to_have || [],
      coverage: analysis.coverage || null,
    },
  };
}

function toTemplateView(version) {
  if (!version) return null;
  const definition = db.get('SELECT * FROM template_definitions WHERE id = ?', [version.template_id]);
  const schema = JSON.parse(version.schema_json || '{}');
  return {
    template_version_id: version.id,
    template_id: version.template_id,
    key: schema.key || 'custom',
    name: definition ? definition.name : schema.name || '自定义模板',
    description: schema.description || '',
    version: version.version,
    kind: definition ? definition.kind : 'custom',
    status: definition ? definition.status : 'ready',
    schema,
  };
}

function toVersionView(row, currentVersionId) {
  const summary = JSON.parse(row.change_summary_json || '{}');
  const templatePayload = JSON.parse(row.template_payload || '{}');
  const jobPayload = JSON.parse(row.job_payload || '{}');
  return {
    id: row.id,
    version_no: row.version_no,
    kind: row.kind,
    name: row.name,
    status: row.status,
    created_at: row.created_at,
    time_label: summary.time_label || '',
    template: templatePayload.name || '',
    job: jobPayload.job || `${jobPayload.title || ''}${jobPayload.company ? ` · ${jobPayload.company}` : ''}`,
    changes: summary.changes || [],
    list_summary: summary.list_summary || '',
    is_current: row.id === currentVersionId,
  };
}

function toMessageView(row) {
  let modelMetadata = {};
  try {
    modelMetadata = JSON.parse(row.model_metadata_json || '{}');
  } catch (_) {
    modelMetadata = {};
  }
  const actions = db.all(
    'SELECT * FROM ai_action_requests WHERE message_id = ? ORDER BY created_at ASC',
    [row.id],
  ).map(toActionView);
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    scope_type: row.scope_type,
    scope_label: row.scope_type ? SCOPE_LABEL[row.scope_type] || row.scope_type : '',
    scope_id: row.scope_id,
    task_id: modelMetadata.task_id || null,
    created_at: row.created_at,
    // 展示当前回答来自哪个引擎/模型，便于确认配置是否生效
    model: {
      provider: modelMetadata.provider || process.env.RESUME_LLM_PROVIDER || 'unconfigured',
      model: modelMetadata.model || process.env.RESUME_LLM_MODEL || '',
      prompt_version: modelMetadata.prompt_version || '',
      policy_version: modelMetadata.policy_version || '',
    },
    actions,
  };
}

function toActionView(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload_json || '{}');
  } catch (_) {
    payload = {};
  }
  const receipt = db.get(
    'SELECT * FROM change_receipts WHERE action_request_id = ? ORDER BY created_at DESC LIMIT 1',
    [row.id],
  );
  const taskId = payload.task_id || null;
  const task = taskId ? db.get('SELECT active_proposal_id, status FROM ai_tasks WHERE id = ?', [taskId]) : null;
  return {
    id: row.id,
    task_id: taskId,
    is_active_proposal: Boolean(task && task.active_proposal_id === row.id),
    task_status: task ? task.status : null,
    action_type: row.action_type,
    target_type: row.target_type,
    target_id: row.target_id,
    status: row.status,
    requires_user_action: Boolean(row.requires_user_action),
    payload,
    expected_revision: row.expected_revision,
    policy_version: row.policy_version,
    created_at: row.created_at,
    receipt: receipt
      ? {
          id: receipt.id,
          before: JSON.parse(receipt.before_json || '{}'),
          after: JSON.parse(receipt.after_json || '{}'),
          reverted_at: receipt.reverted_at,
        }
      : null,
  };
}

/** 构建工作区聚合视图。 */
function buildWorkspace(projectId, user) {
  const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
    projectId,
    user.id,
  ]);
  if (!project) throw problem.notFound('项目不存在');

  const profile = db.get('SELECT * FROM profiles WHERE id = ? AND owner_id = ?', [
    project.current_profile_id,
    user.id,
  ]);
  const experienceRows = db.all(
    'SELECT * FROM experiences WHERE profile_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC',
    [profile.id],
  );
  const experiences = experienceRows.map(toExperienceView);
  const basics = JSON.parse(profile.basics_json || '{}');

  const jobRow = project.current_job_id
    ? db.get('SELECT * FROM target_jobs WHERE id = ? AND owner_id = ?', [project.current_job_id, user.id])
    : null;

  const currentTemplate = project.current_template_version_id
    ? toTemplateView(
        db.get('SELECT * FROM template_versions WHERE id = ?', [project.current_template_version_id]),
      )
    : null;

  const availableTemplates = db
    .all(
      `SELECT tv.* FROM template_versions tv
       JOIN template_definitions td ON td.id = tv.template_id
       WHERE (td.kind = 'system' AND td.owner_id IS NULL) OR td.owner_id = ?
       ORDER BY td.kind DESC, td.name ASC`,
      [user.id],
    )
    .map(toTemplateView);

  const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?', [
    projectId,
    user.id,
  ]);
  const pendingChanges = db
    .all(
      `SELECT * FROM resume_change_events
       WHERE project_id = ? AND owner_id = ? AND reverted_at IS NULL AND snapshot_version_id IS NULL
       ORDER BY created_at ASC`,
      [projectId, user.id],
    )
    .map((row) => ({
      id: row.id,
      change_type: row.change_type,
      scope_type: row.scope_type,
      scope_label: row.scope_type ? SCOPE_LABEL[row.scope_type] || row.scope_type : '',
      scope_id: row.scope_id,
      before: JSON.parse(row.before_json || '{}'),
      after: JSON.parse(row.after_json || '{}'),
      actor_type: row.actor_type,
      mutation_id: row.mutation_id,
      created_at: row.created_at,
    }));

  const versionRows = db.all(
    'SELECT * FROM resume_versions WHERE project_id = ? AND owner_id = ? ORDER BY version_no DESC',
    [projectId, user.id],
  );
  const versions = versionRows.map((row) => toVersionView(row, draft ? draft.base_version_id : null));

  const conversation =
    db.get("SELECT * FROM ai_conversations WHERE project_id = ? AND owner_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1", [
      projectId,
      user.id,
    ]) || null;
  const messages = conversation
    ? db
        .all('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC', [
          conversation.id,
        ])
        .map(toMessageView)
    : [];

  const tasks = conversation
    ? db
        .all('SELECT * FROM ai_tasks WHERE conversation_id = ? ORDER BY created_at ASC', [conversation.id])
        .map((row) => ({
          id: row.id,
          scope_type: row.scope_type,
          scope_id: row.scope_id,
          goal: row.goal,
          status: row.status,
          active_proposal_id: row.active_proposal_id,
          state: JSON.parse(row.state_json || '{}'),
        }))
    : [];

  const pendingActionsCount = conversation
    ? db.get(
        `SELECT COUNT(*) AS total FROM ai_action_requests
         WHERE conversation_id = ? AND owner_id = ? AND status IN ('awaiting_confirmation','proposed') AND requires_user_action = 1`,
        [conversation.id, user.id],
      ).total
    : 0;

  const readiness = computeReadiness({
    profileBasics: basics,
    experiences: experienceRows,
    template: currentTemplate,
    job: jobRow,
  });

  return {
    user: { id: user.id, display_name: user.display_name, email: user.email },
    project: {
      id: project.id,
      name: project.name,
      revision: project.revision,
      status: project.status,
    },
    profile: {
      id: profile.id,
      basics,
      summary: profile.summary,
      revision: profile.revision,
      completeness: computeProfileCompleteness(basics, experienceRows),
      experiences,
    },
    job: toJobView(jobRow),
    template: currentTemplate,
    templates: availableTemplates,
    draft: {
      id: draft ? draft.id : null,
      resume_json: ResumeDom.attachDocument(draft ? JSON.parse(draft.resume_json || '{}') : {}),
      revision: draft ? draft.revision : 1,
      base_version_id: draft ? draft.base_version_id : null,
      has_unsnapshotted_changes: draft ? Boolean(draft.has_unsnapshotted_changes) : false,
      pending_changes: pendingChanges,
    },
    versions,
    conversation: conversation ? { id: conversation.id, messages, tasks } : null,
    pending_actions_count: pendingActionsCount,
    readiness,
  };
}

const routes = [
  {
    method: 'GET',
    pattern: '/projects',
    handler: ({ user }) => ({
      items: db
        .all('SELECT * FROM resume_projects WHERE owner_id = ? ORDER BY created_at ASC', [user.id])
        .map((row) => ({ id: row.id, name: row.name, revision: row.revision, status: row.status })),
    }),
  },
  {
    method: 'GET',
    pattern: '/projects/:id',
    handler: ({ params, user }) => buildWorkspace(params.id, user),
  },
  {
    method: 'PATCH',
    pattern: '/projects/:id',
    handler: ({ params, body, user }) => {
      const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!project) throw problem.notFound('项目不存在');
      if (!body.name) throw problem.badRequest('项目名称不能为空');
      db.run('UPDATE resume_projects SET name = ?, updated_at = ? WHERE id = ?', [
        body.name,
        nowIso(),
        project.id,
      ]);
      return { id: project.id, name: body.name };
    },
  },
  {
    method: 'POST',
    pattern: '/projects',
    handler: ({ body, user }) =>
      db.tx(() => {
        const projectId = uuidv7();
        db.run(
          `INSERT INTO resume_projects (id, owner_id, name, revision, status, created_at, updated_at)
           VALUES (?, ?, ?, 1, 'active', ?, ?)`,
          [projectId, user.id, body.name || '未命名简历项目', nowIso(), nowIso()],
        );
        const profileId = uuidv7();
        db.run(
          `INSERT INTO profiles (id, project_id, owner_id, basics_json, summary, revision, created_at, updated_at)
           VALUES (?, ?, ?, '{}', '', 1, ?, ?)`,
          [profileId, projectId, user.id, nowIso(), nowIso()],
        );
        const draftId = uuidv7();
        db.run(
          `INSERT INTO resume_drafts (id, project_id, owner_id, resume_json, revision, has_unsnapshotted_changes, created_at, updated_at)
           VALUES (?, ?, ?, '{}', 1, 0, ?, ?)`,
          [draftId, projectId, user.id, nowIso(), nowIso()],
        );
        const conversationId = uuidv7();
        db.run(
          `INSERT INTO ai_conversations (id, project_id, owner_id, active_scope_type, created_at, updated_at)
           VALUES (?, ?, ?, 'RESUME_DOCUMENT', ?, ?)`,
          [conversationId, projectId, user.id, nowIso(), nowIso()],
        );
        db.run('UPDATE resume_projects SET current_profile_id = ? WHERE id = ?', [profileId, projectId]);
        return { id: projectId, name: body.name || '未命名简历项目' };
      }),
  },
  {
    method: 'GET',
    pattern: '/me',
    handler: ({ user }) => ({
      id: user.id,
      display_name: user.display_name,
      email: user.email,
      demo: user.email === DEMO_EMAIL,
    }),
  },
];

module.exports = {
  routes,
  buildWorkspace,
  toExperienceView,
  toJobView,
  toTemplateView,
  toVersionView,
  toMessageView,
  toActionView,
};
