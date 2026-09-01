'use strict';
/**
 * AI 对话与动作执行（TECH §9.5—9.7、SYSTEM_PROMPT、AI_BEHAVIOR_TESTS P0）。
 *
 * 不可破坏的约束：
 *  1. AI 模型不直接写数据库、不调用资料更新接口、不修改 DOM；
 *  2. AI 声称「已保存」不代表保存成功，界面只显示后端真实执行结果；
 *  3. 推测信息、生成文案和岗位原文不自动成为个人事实；
 *  4. 未点击「应用修改」时简历正文保持不变；未点击「设为当前岗位」时当前岗位不变；
 *  5. 非法 Schema、未知动作或策略冲突一律零写入（fail-closed）。
 */
const db = require('../lib/db');
const { createHash } = require('node:crypto');
const { uuidv7, nowIso, problem, deepClone } = require('../lib/util');
const audit = require('../lib/audit');
const policy = require('../lib/policy');
const resumeHarness = require('../lib/resume-harness');
const { getObject } = require('../lib/storage');
const { suggestPolish, diffWords } = require('../lib/polish');
const { splitBullets } = require('../lib/compose');
const { keyTokens } = require('../lib/resume-schema');
const { analyzeJobText } = require('../lib/job-analyzer');
const { withIdempotency } = require('../lib/idempotency');
const queue = require('../lib/queue');
const { SCOPE_LABEL } = require('../lib/policy');
const { toActionView, toMessageView, toFactView } = require('./workspace');

const POLICY_VERSION = policy.POLICY_VERSION;

function loadContext(projectId, user) {
  const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
    projectId,
    user.id,
  ]);
  if (!project) throw problem.notFound('项目不存在');
  const profile = db.get('SELECT * FROM profiles WHERE id = ? AND owner_id = ?', [
    project.current_profile_id,
    user.id,
  ]);
  const draft = db.get('SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?', [
    project.id,
    user.id,
  ]);
  const job = project.current_job_id
    ? db.get('SELECT * FROM target_jobs WHERE id = ? AND owner_id = ?', [project.current_job_id, user.id])
    : null;
  let conversation = db.get(
    "SELECT * FROM ai_conversations WHERE project_id = ? AND owner_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1",
    [project.id, user.id],
  );
  if (!conversation) {
    const id = uuidv7();
    db.run(
      `INSERT INTO ai_conversations (id, project_id, owner_id, active_scope_type, created_at, updated_at)
       VALUES (?, ?, ?, 'RESUME_DOCUMENT', ?, ?)`,
      [id, project.id, user.id, nowIso(), nowIso()],
    );
    conversation = db.get('SELECT * FROM ai_conversations WHERE id = ?', [id]);
  }
  return { project, profile, draft, job, conversation };
}

/**
 * 结束当前对话并创建空对话。旧消息和动作留作审计；待确认事实独立保留，
 * 但旧任务、未应用改写和未确认岗位不能跨越新的对话边界继续执行。
 */
function startNewConversation({ projectId, user, requestId, ipHash }) {
  return db.tx(() => {
    const ctx = loadContext(projectId, user);
    const previous = ctx.conversation;
    const messageCount = db.get(
      'SELECT COUNT(*) AS total FROM ai_messages WHERE conversation_id = ?',
      [previous.id],
    ).total;
    const pendingFacts = db.get(
      "SELECT COUNT(*) AS total FROM fact_candidates WHERE project_id = ? AND owner_id = ? AND status = 'pending'",
      [ctx.project.id, user.id],
    ).total;
    const discardedProposals = db.get(
      `SELECT COUNT(*) AS total FROM ai_action_requests
       WHERE conversation_id = ? AND owner_id = ? AND action_type = 'RESUME_REWRITE_PROPOSAL'
         AND status IN ('awaiting_confirmation','proposed')`,
      [previous.id, user.id],
    ).total;
    const discardedJobs = db.get(
      `SELECT COUNT(*) AS total FROM ai_action_requests
       WHERE conversation_id = ? AND owner_id = ? AND action_type = 'JOB_CANDIDATE'
         AND status IN ('awaiting_confirmation','proposed')`,
      [previous.id, user.id],
    ).total;

    db.run(
      `UPDATE ai_tasks SET status = 'canceled', active_proposal_id = NULL, updated_at = ?
       WHERE conversation_id = ? AND owner_id = ? AND status NOT IN ('completed','canceled')`,
      [nowIso(), previous.id, user.id],
    );
    db.run(
      `UPDATE ai_action_requests SET status = 'rejected'
       WHERE conversation_id = ? AND owner_id = ?
         AND action_type IN ('RESUME_REWRITE_PROPOSAL','JOB_CANDIDATE')
         AND status IN ('awaiting_confirmation','proposed')`,
      [previous.id, user.id],
    );
    db.all(
      `SELECT target_id FROM ai_action_requests
       WHERE conversation_id = ? AND owner_id = ? AND action_type = 'JOB_CANDIDATE' AND status = 'rejected'`,
      [previous.id, user.id],
    ).forEach((row) => {
      if (row.target_id) {
        db.run(
          "UPDATE target_jobs SET status = 'discarded', updated_at = ? WHERE id = ? AND owner_id = ? AND id != ?",
          [nowIso(), row.target_id, user.id, ctx.project.current_job_id || ''],
        );
      }
    });
    db.run(
      "UPDATE ai_conversations SET status = 'closed', updated_at = ? WHERE id = ? AND owner_id = ?",
      [nowIso(), previous.id, user.id],
    );

    const id = uuidv7();
    db.run(
      `INSERT INTO ai_conversations
       (id, project_id, owner_id, active_scope_type, active_scope_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'RESUME_DOCUMENT', NULL, 'active', ?, ?)`,
      [id, ctx.project.id, user.id, nowIso(), nowIso()],
    );
    audit.log({
      ownerId: user.id,
      action: 'ai_conversation_started',
      resourceType: 'ai_conversation',
      resourceId: id,
      requestId,
      ipHash,
      metadata: {
        previous_conversation_id: previous.id,
        message_count: messageCount,
        pending_facts_preserved: pendingFacts,
        proposals_discarded: discardedProposals,
        job_candidates_discarded: discardedJobs,
      },
    });
    return {
      id,
      previous_conversation_id: previous.id,
      messages_closed: messageCount,
      pending_facts_preserved: pendingFacts,
      proposals_discarded: discardedProposals,
      job_candidates_discarded: discardedJobs,
      profile_unchanged: true,
      resume_unchanged: true,
      versions_unchanged: true,
    };
  });
}

/** 找到草稿中的某条 bullet（跨经历与项目）。 */
function findBulletInDraft(resume, bulletId) {
  for (const section of ['experience', 'projects']) {
    for (const item of resume[section] || []) {
      const bullet = (item.bullets || []).find((entry) => entry.id === bulletId);
      if (bullet) return { section, item, bullet };
    }
  }
  return null;
}

function parseJson(raw, fallback = {}) {
  try {
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch (_) {
    return deepClone(fallback);
  }
}

function textHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function taskState(task) {
  return parseJson(task && task.state_json, {});
}

function saveTask(taskId, patch = {}) {
  const task = db.get('SELECT * FROM ai_tasks WHERE id = ?', [taskId]);
  if (!task) return null;
  const nextState = patch.state ? { ...taskState(task), ...patch.state } : taskState(task);
  db.run(
    `UPDATE ai_tasks
     SET goal = ?, state_json = ?, active_proposal_id = ?, status = ?, updated_at = ?
     WHERE id = ?`,
    [
      patch.goal === undefined ? task.goal : patch.goal,
      JSON.stringify(nextState),
      patch.active_proposal_id === undefined ? task.active_proposal_id : patch.active_proposal_id,
      patch.status || task.status,
      nowIso(),
      task.id,
    ],
  );
  return db.get('SELECT * FROM ai_tasks WHERE id = ?', [task.id]);
}

/** `@` 是动作边界：类型、对象和项目归属必须在调用模型前确定。 */
function validateLockedScope(ctx, scopeType, scopeId) {
  if (!policy.SCOPE_TYPES.has(scopeType)) throw problem.badRequest('未知的作用范围类型');
  if (scopeType === 'RESUME_BLOCK') {
    if (!scopeId) throw problem.badRequest('请选择具体的简历内容');
    const resume = parseJson(ctx.draft && ctx.draft.resume_json, {});
    const found = findBulletInDraft(resume, scopeId);
    if (!found) throw problem.badRequest('所选简历内容不存在，请重新选择');
    return { scopeId, currentText: String(found.bullet.text || '') };
  }
  if (scopeType === 'DATA_PROFILE' && scopeId) {
    const owned = db.get(
      `SELECT e.id FROM experiences e JOIN profiles p ON p.id = e.profile_id
       WHERE e.id = ? AND p.id = ? AND e.owner_id = ? AND e.deleted_at IS NULL`,
      [scopeId, ctx.profile.id, ctx.profile.owner_id],
    );
    if (!owned) throw problem.badRequest('所选个人资料不存在，请重新选择');
  }
  if (scopeType === 'DATA_JOB' && scopeId) {
    const owned = db.get(
      'SELECT id FROM target_jobs WHERE id = ? AND project_id = ? AND owner_id = ?',
      [scopeId, ctx.project.id, ctx.project.owner_id],
    );
    if (!owned) throw problem.badRequest('所选岗位资料不存在，请重新选择');
  }
  return { scopeId: scopeId || null, currentText: '' };
}

function resolveTask({ ctx, user, body, scopeType, scopeId, content }) {
  let task = null;
  if (body.task_id) {
    task = db.get(
      `SELECT * FROM ai_tasks
       WHERE id = ? AND conversation_id = ? AND project_id = ? AND owner_id = ?`,
      [body.task_id, ctx.conversation.id, ctx.project.id, user.id],
    );
    if (!task) throw problem.badRequest('当前 AI 任务不存在，请重新发起');
    if (task.scope_type !== scopeType || String(task.scope_id || '') !== String(scopeId || '')) {
      throw problem.conflict('SCOPE_CONFLICT', '当前对话目标已切换，请重新发送');
    }
    if (['completed', 'canceled'].includes(task.status) && !body.parent_proposal_id) task = null;
  }
  if (!task && body.parent_proposal_id) {
    const parent = db.get(
      `SELECT * FROM ai_action_requests
       WHERE id = ? AND conversation_id = ? AND owner_id = ? AND action_type = 'RESUME_REWRITE_PROPOSAL'`,
      [body.parent_proposal_id, ctx.conversation.id, user.id],
    );
    const parentPayload = parent ? parseJson(parent.payload_json, {}) : {};
    if (parentPayload.task_id) {
      task = db.get('SELECT * FROM ai_tasks WHERE id = ? AND owner_id = ?', [parentPayload.task_id, user.id]);
    }
  }
  if (!task && /^(是的|对|确认|可以|行|好的?|同意|嗯|没错|确定|yes|不用了?|不要|算了|取消|忽略|先不了?|暂时不)$/i.test(content)) {
    const candidates = db.all(
      `SELECT DISTINCT t.* FROM ai_tasks t
       JOIN ai_action_requests a ON json_extract(a.payload_json, '$.task_id') = t.id
       JOIN fact_candidates f ON json_extract(a.payload_json, '$.fact_id') = f.id
       WHERE t.conversation_id = ? AND t.owner_id = ?
         AND a.action_type = 'FACT_CANDIDATE' AND a.status = 'awaiting_confirmation'
         AND f.status = 'pending'`,
      [ctx.conversation.id, user.id],
    );
    if (candidates.length === 1) task = candidates[0];
  }
  if (!task) {
    const id = uuidv7();
    const initial = { latest_instruction: content, parent_proposal_id: null, fact_ids: [] };
    db.run(
      `INSERT INTO ai_tasks
       (id, conversation_id, project_id, owner_id, scope_type, scope_id, goal, state_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [id, ctx.conversation.id, ctx.project.id, user.id, scopeType, scopeId, content.slice(0, 180), JSON.stringify(initial), nowIso(), nowIso()],
    );
    task = db.get('SELECT * FROM ai_tasks WHERE id = ?', [id]);
  } else {
    const state = taskState(task);
    const answers = state.current_question
      ? [...(state.answers || []), { question: state.current_question, answer: content }].slice(-8)
      : state.answers || [];
    task = saveTask(task.id, {
      state: { latest_instruction: content, current_question: null, answers },
    });
  }
  return task;
}

function actionAllowedInScope(actionType, scopeType) {
  if (actionType === 'NO_OP' || actionType === 'TEMPORARY_CONTEXT') return true;
  if (actionType === 'RESUME_REWRITE_PROPOSAL') {
    return scopeType === 'RESUME_BLOCK' || scopeType === 'RESUME_DOCUMENT';
  }
  if (actionType === 'PROFILE_FIELD_UPDATE') return scopeType === 'DATA_PROFILE';
  if (actionType === 'JOB_CANDIDATE') return scopeType === 'DATA_JOB';
  if (actionType === 'FACT_CANDIDATE') {
    return scopeType === 'DATA_PROFILE' || scopeType === 'RESUME_BLOCK' || scopeType === 'RESUME_DOCUMENT';
  }
  return false;
}

/**
 * 改写方案的取舍：配置了大模型时**一律采用模型结果**，本地规则只在模型没给出改写时兜底。
 * 模型建议仍需与已确认事实 F 比对；未确认数字会由策略层阻止生成可应用建议。
 */
function adoptModelSuggestion(base, modelProposal, knownFactTexts = []) {
  const model = modelProposal || {};
  const candidate = String(model.suggestion || '').trim();
  if (!candidate) {
    // 仅离线测试模型允许省略建议正文；生产模型缺失 suggestion 会在调用方被拒绝。
    return { ...base, source: 'rule-fallback' };
  }
  const confirmedTokens = new Set();
  (knownFactTexts || []).forEach((value) => keyTokens(value).forEach((token) => confirmedTokens.add(token)));
  const added = Array.from(keyTokens(candidate)).filter((token) => !confirmedTokens.has(token));
  const note = added.length
    ? `注意：这段改写里出现了原文没有的数据（${added.join('、')}），确认前请先核对来源。`
    : (model.note || base.note || '');
  return {
    scope_type: base.scope_type,
    scope_id: base.scope_id,
    scope_label: base.scope_label,
    original: base.original,
    suggestion: candidate,
    diff: diffWords(base.original, candidate),
    note,
    pending_claims: added.map((token) => ({
      token,
      reason: `「${token}」在你的已确认资料里找不到来源，需要你确认`,
    })),
    source: 'model',
  };
}

/** 生成简历改写方案（只改变表达，不新增事实）。 */
function buildRewriteProposal({ draft, scopeId, intent, keywords, overrideText }) {
  const resume = JSON.parse(draft.resume_json || '{}');
  const found = scopeId ? findBulletInDraft(resume, scopeId) : null;
  // overrideText：「继续调整」时以上一轮建议为表达起点；否则取草稿当前文本
  const baseText = String(overrideText || '').trim();

  // 未选中具体段落：针对「个人优势」给出真实方案，并说明作用范围
  if (!found) {
    const original = baseText || resume.summary || '';
    const polished = suggestPolish({ text: original, intent: intent || '更专业', keywords });
    const unchanged = polished.suggestion === original;
    // 整份简历无法再优化时，指出最值得优先处理的一段，避免让用户空手而归
    let hint = unchanged
      ? '「个人优势」这段表达已经比较精炼，我没有发现需要调整的地方。'
      : '你没有选中具体内容，我先针对开头的「个人优势」给出方案；也可以选中简历中的具体段落，让我只改那一段。';
    if (unchanged) {
      const candidates = [...(resume.experience || []), ...(resume.projects || [])]
        .flatMap((item) => (item.bullets || []).map((bullet) => bullet.text || ''))
        .sort((a, b) => b.length - a.length);
      if (candidates[0]) {
        hint += `相比之下「${candidates[0].slice(0, 18)}…」这段更长，选中它我可以给出更具体的精简方案。`;
      } else {
        hint += '如果想优化具体经历，请先选中简历中的某一段内容。';
      }
    }
    return {
      scope_type: 'RESUME_SUMMARY',
      scope_id: 'summary',
      scope_label: '@简历 · 个人优势',
      original,
      suggestion: polished.suggestion,
      diff: polished.diff,
      note: hint,
      pending_claims: polished.pending_claims,
      affected_count: unchanged ? 0 : 1,
    };
  }

  const sourceText = baseText || found.bullet.text;
  const result = suggestPolish({ text: sourceText, intent: intent || '更专业', keywords });
  const unchanged = result.suggestion === sourceText;
  return {
    scope_type: 'RESUME_BLOCK',
    scope_id: found.bullet.id,
    scope_label: found.bullet.scope_name || `@简历 · ${found.item.organization || found.item.name}`,
    original: result.original,
    suggestion: result.suggestion,
    diff: result.diff,
    note: unchanged
      ? '这段表达已经比较精炼，按你的要求没有发现可优化点；可以换个方向（例如强调成果或更符合岗位）再试。'
      : result.note,
    pending_claims: result.pending_claims,
    affected_count: unchanged ? 0 : 1,
  };
}

/**
 * 模型文案与后端真实执行结果的一致性校正。
 * 模型常在 reply 里说「已更新/已保存」，但动作其实只是待确认——此时必须明确说明，
 * 否则界面会展示与数据不符的成功状态（PRD：AI 声称已保存不代表保存成功）。
 */
function reconcileReply(reply, executed) {
  const text = String(reply || '').trim();
  if (!text) return text;
  const hasApplied = (executed || []).some((item) => item.status === 'applied');
  // 宽松匹配：「已…更新」「已将…改为」这类中间夹杂宾语的表述也要识别
  const claimsDone = /已(?:经)?[^，。；]{0,10}(?:更新|保存|修改|替换|写入|添加|记录|设为|切换|改为|改好|完成)|已经帮你|已经为你/.test(
    text,
  );
  if (claimsDone && !hasApplied) {
    return `${text}（说明：这条还需要你确认后才会真正写入，我没有直接改动你的资料或简历。）`;
  }
  return text;
}

/**
 * 检查类请求的结论：全部基于已确认资料与岗位分析得出，不新增任何事实。
 * 这样「检查是否夸张」这类提问会得到真实、可执行的回答，而不是空泛追问。
 */
function buildReviewReply({ resume, job }) {
  const bullets = [...(resume.experience || []), ...(resume.projects || [])].flatMap((item) =>
    (item.bullets || []).map((bullet) => (typeof bullet === 'string' ? bullet : bullet.text)),
  );
  const resumeText = [resume.summary || '', ...bullets].join('\n');
  const total = bullets.length;
  if (!total) return '当前简历还没有经历内容，先补充资料后我再帮你检查。';

  const quantified = bullets.filter((text) => /\d/.test(text)).length;
  const EXAGGERATED = ['极大', '颠覆', '革命性', '前所未有', '绝对', '完美', '彻底', '遥遥领先', '史上', '最强', '第一'];
  const hits = [];
  bullets.forEach((text) => {
    EXAGGERATED.forEach((word) => {
      if (text.includes(word)) hits.push(word);
    });
  });

  const keywords = (job && job.analysis && job.analysis.keywords) || [];
  const covered = keywords.filter((keyword) => resumeText.includes(keyword));

  const notes = [];
  notes.push(
    `共 ${total} 条经历描述，其中 ${quantified} 条包含可量化结果（${Math.round((quantified / total) * 100)}%）`,
  );
  notes.push(
    hits.length
      ? `发现 ${hits.length} 处可能夸张的表述（${[...new Set(hits)].slice(0, 3).join('、')}），建议改成能被证据支撑的说法`
      : '没有发现明显的夸张表述，用词整体克制',
  );
  if (quantified / total < 0.5) notes.push('量化程度偏低，建议为关键成果补上可验证的数字');
  if (keywords.length) {
    notes.push(
      covered.length
        ? `岗位关键词覆盖 ${covered.length}/${keywords.length} 个（${covered.slice(0, 4).join('、')}）`
        : `岗位关键词（${keywords.slice(0, 3).join('、')}）在简历中还没有体现`,
    );
  }
  notes.push('以上判断都来自你已确认的资料，我没有新增任何事实');
  return `我检查了整份简历：${notes.join('；')}。`;
}

/** 把已确认事实写入左侧资料库（不触碰中间简历）。 */
function persistConfirmedFact({ user, project, profile, fact, actionId, requestId, ipHash }) {
  return db.tx(() => {
    const value = JSON.parse(fact.proposed_value_json || '{}');
    const text = `${value.label || fact.field_path}：${value.value || ''}`;
    let targetId = fact.target_id;
    let before = {};
    let after = {};

    if (fact.target_type === 'profile_summary' || fact.field_path === 'core_competence') {
      // 能力类事实沉淀为技能条目
      const count = db.get(
        'SELECT COUNT(*) AS total FROM experiences WHERE profile_id = ? AND deleted_at IS NULL',
        [profile.id],
      ).total;
      targetId = uuidv7();
      db.run(
        `INSERT INTO experiences (id, profile_id, owner_id, type, organization, title, start_date, end_date, is_current, description, meta_json, sort_order, revision, created_at, updated_at)
         VALUES (?, ?, ?, 'skill', '', ?, '', '', 0, '', '{}', ?, 1, ?, ?)`,
        [targetId, profile.id, user.id, String(value.value || ''), count, nowIso(), nowIso()],
      );
      before = { type: 'skill', title: null };
      after = { type: 'skill', title: value.value };
    } else if (targetId) {
      const experience = db.get('SELECT * FROM experiences WHERE id = ? AND owner_id = ?', [
        targetId,
        user.id,
      ]);
      if (experience) {
        const bullets = splitBullets(experience.description);
        before = { description: experience.description };
        bullets.push(text);
        const description = bullets.join('\n');
        db.run('UPDATE experiences SET description = ?, updated_at = ? WHERE id = ?', [
          description,
          nowIso(),
          experience.id,
        ]);
        db.bumpRevision('experiences', experience.id);
        after = { description };
      }
    } else {
      // 未指定归属时，按事实内容推断：涉及「项目」的挂项目经历，否则挂最近一段工作经历
      const factText = text || value.value || '';
      const mentionProject = /项目|宣讲|规模|覆盖|触达/.test(factText);
      const candidate =
        db.get(
          mentionProject
            ? `SELECT * FROM experiences WHERE profile_id = ? AND type = 'project' AND deleted_at IS NULL ORDER BY sort_order DESC LIMIT 1`
            : `SELECT * FROM experiences WHERE profile_id = ? AND type = 'work' AND deleted_at IS NULL ORDER BY sort_order DESC LIMIT 1`,
          [profile.id],
        ) ||
        db.get(
          "SELECT * FROM experiences WHERE profile_id = ? AND (type = 'work' OR type = 'project') AND deleted_at IS NULL ORDER BY type = 'project' DESC, sort_order ASC LIMIT 1",
          [profile.id],
        );
      if (candidate) {
        const bullets = splitBullets(candidate.description);
        before = { description: candidate.description };
        bullets.push(text);
        const description = bullets.join('\n');
        db.run('UPDATE experiences SET description = ?, updated_at = ? WHERE id = ?', [
          description,
          nowIso(),
          candidate.id,
        ]);
        db.bumpRevision('experiences', candidate.id);
        after = { description };
        targetId = candidate.id;
      }
    }

    const revision = db.bumpRevision('profiles', profile.id);
    const receiptId = uuidv7();
    db.run(
      `INSERT INTO change_receipts (id, action_request_id, owner_id, resource_type, resource_id, before_json, after_json, mutation_id, created_at)
       VALUES (?, ?, ?, 'experience', ?, ?, ?, ?, ?)`,
      [
        receiptId,
        actionId || null,
        user.id,
        targetId || '',
        JSON.stringify(before),
        JSON.stringify(after),
        uuidv7(),
        nowIso(),
      ],
    );
    audit.log({
      ownerId: user.id,
      action: 'fact_confirmed',
      resourceType: 'fact_candidate',
      resourceId: fact.id,
      requestId,
      ipHash,
      metadata: { field_path: fact.field_path, target_id: targetId, profile_revision: revision },
    });
    return { receipt_id: receiptId, target_id: targetId, profile_revision: revision, text };
  });
}

/** 应用改写方案：只更新草稿与 change event，不创建历史版本。 */
function applyRewriteProposal({ user, project, draft, action, requestId, ipHash }) {
  return db.tx(() => {
    const payload = JSON.parse(action.payload_json || '{}');
    const proposal = payload.proposal || {};
    const resume = JSON.parse(draft.resume_json || '{}');
    const found = findBulletInDraft(resume, proposal.scope_id);
    const isSummary = proposal.scope_id === 'summary' || proposal.scope_type === 'RESUME_SUMMARY';
    if (!found && !isSummary) throw problem.conflict('PROPOSAL_STALE', '对应的简历内容已不存在，请重新生成建议');
    const before = found
      ? { text: found.bullet.text, ai_note: found.bullet.ai_note || null }
      : { text: resume.summary || '' };
    if (found) {
      found.bullet.text = proposal.suggestion || before.text;
      // 方案被采纳后，对应的 AI 建议标记随之消失
      delete found.bullet.ai_note;
    } else if (isSummary) {
      resume.summary = proposal.suggestion || before.text;
    }
    const revision = draft.revision + 1;
    db.run(
      'UPDATE resume_drafts SET resume_json = ?, revision = ?, has_unsnapshotted_changes = 1, updated_at = ? WHERE id = ?',
      [JSON.stringify(resume), revision, nowIso(), draft.id],
    );
    const mutationId = uuidv7();
    const changeId = uuidv7();
    db.run(
      `INSERT INTO resume_change_events (id, project_id, owner_id, draft_revision, change_type, scope_type, scope_id, before_json, after_json, actor_type, mutation_id, created_at)
       VALUES (?, ?, ?, ?, 'bullet_text', 'RESUME_BLOCK', ?, ?, ?, 'ai', ?, ?)`,
      [
        changeId,
        project.id,
        user.id,
        revision,
        proposal.scope_id || null,
        JSON.stringify(before),
        JSON.stringify({ text: proposal.suggestion, label: `修改${(proposal.scope_label || '').replace('@简历 · ', '')}` }),
        mutationId,
        nowIso(),
      ],
    );
    db.run("UPDATE ai_action_requests SET status = 'applied', applied_at = ? WHERE id = ?", [
      nowIso(),
      action.id,
    ]);
    if (payload.task_id) {
      saveTask(payload.task_id, { active_proposal_id: null, status: 'completed' });
    }
    db.run(
      `UPDATE ai_action_requests SET status = 'stale'
       WHERE owner_id = ? AND id != ? AND action_type = 'RESUME_REWRITE_PROPOSAL'
         AND status = 'awaiting_confirmation'
         AND json_extract(payload_json, '$.proposal.scope_id') = ?`,
      [user.id, action.id, proposal.scope_id || null],
    );
    audit.log({
      ownerId: user.id,
      action: 'rewrite_proposal_applied',
      resourceType: 'ai_action_request',
      resourceId: action.id,
      requestId,
      ipHash,
      metadata: { scope_id: proposal.scope_id, draft_revision: revision },
    });
    return { change_id: changeId, draft_revision: revision, resume_json: resume, version_created: false };
  });
}

function validateRewriteProposal({ action, ctx, user }) {
  const payload = parseJson(action.payload_json, {});
  const proposal = payload.proposal || {};
  if (action.status !== 'awaiting_confirmation') {
    throw problem.conflict('PROPOSAL_NOT_ACTIVE', '这不是当前可应用的建议，请查看最新建议');
  }
  if (payload.task_id) {
    const task = db.get('SELECT * FROM ai_tasks WHERE id = ? AND owner_id = ?', [payload.task_id, user.id]);
    if (!task || task.active_proposal_id !== action.id) {
      db.run("UPDATE ai_action_requests SET status = 'superseded' WHERE id = ?", [action.id]);
      throw problem.conflict('PROPOSAL_NOT_ACTIVE', '这条建议已有新版，请使用当前建议');
    }
  }
  const resume = parseJson(ctx.draft.resume_json, {});
  const found = findBulletInDraft(resume, proposal.scope_id);
  const currentText = found
    ? String(found.bullet.text || '')
    : proposal.scope_id === 'summary'
      ? String(resume.summary || '')
      : null;
  const dependencies = Array.isArray(proposal.dependency_fact_ids) ? proposal.dependency_fact_ids : [];
  const invalidDependency = dependencies.some((factId) => {
    const fact = db.get('SELECT status FROM fact_candidates WHERE id = ? AND owner_id = ?', [factId, user.id]);
    return !fact || fact.status !== 'confirmed';
  });
  const jobChanged = proposal.job_id && (
    !ctx.job || ctx.job.id !== proposal.job_id || (proposal.job_revision && ctx.job.revision !== proposal.job_revision)
  );
  const profileChanged = proposal.profile_revision && ctx.profile.revision !== proposal.profile_revision;
  if (
    currentText === null
    || (proposal.base_target_hash && textHash(currentText) !== proposal.base_target_hash)
    || invalidDependency
    || profileChanged
    || jobChanged
    || (action.expected_revision !== null && action.expected_revision !== ctx.draft.revision)
  ) {
    db.run("UPDATE ai_action_requests SET status = 'stale' WHERE id = ?", [action.id]);
    if (payload.task_id) saveTask(payload.task_id, { active_proposal_id: null, status: 'active' });
    throw problem.conflict('PROPOSAL_STALE', '正文或相关资料已变化，请重新生成建议');
  }
  return { payload, proposal };
}

function markProposalStale(action, user) {
  const payload = parseJson(action.payload_json, {});
  db.run("UPDATE ai_action_requests SET status = 'stale' WHERE id = ?", [action.id]);
  if (payload.task_id) {
    const task = db.get('SELECT * FROM ai_tasks WHERE id = ? AND owner_id = ?', [payload.task_id, user.id]);
    if (task && task.active_proposal_id === action.id) {
      saveTask(task.id, { active_proposal_id: null, status: 'active' });
    }
  }
}

function confirmFactCandidate({ user, project, ctx, fact, actionId, expectedRevision, requestId, ipHash }) {
  if (expectedRevision !== undefined && expectedRevision !== ctx.profile.revision) {
    throw problem.conflict('REVISION_CONFLICT', '个人资料已变化，请重新确认', {
      expected: expectedRevision,
      current: ctx.profile.revision,
    });
  }
  const persisted = persistConfirmedFact({
    user,
    project,
    profile: ctx.profile,
    fact,
    actionId,
    requestId,
    ipHash,
  });
  db.run(
    "UPDATE fact_candidates SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?",
    [user.id, nowIso(), nowIso(), fact.id],
  );
  // 同步该事实绑定的动作状态：已确认 → applied（前端据此不再复现待确认卡片）
  db.run(
    `UPDATE ai_action_requests SET status = 'applied', applied_at = ?
     WHERE owner_id = ? AND action_type = 'FACT_CANDIDATE'
       AND status IN ('awaiting_confirmation','proposed')
       AND json_extract(payload_json, '$.fact_id') = ?`,
    [nowIso(), user.id, fact.id],
  );
  const factValue = parseJson(fact.proposed_value_json, {});
  const rawTask = factValue.task_id
    ? db.get('SELECT * FROM ai_tasks WHERE id = ? AND owner_id = ? AND project_id = ?', [factValue.task_id, user.id, project.id])
    : null;
  // 待确认资料可以跨对话保留，但旧对话的表达任务不能被确认动作重新唤醒。
  const task = rawTask
    && rawTask.conversation_id === ctx.conversation.id
    && !['completed', 'canceled'].includes(rawTask.status)
    ? rawTask
    : null;
  db.all(
    `SELECT * FROM ai_action_requests
     WHERE conversation_id = ? AND owner_id = ? AND action_type = 'RESUME_REWRITE_PROPOSAL'
       AND status = 'awaiting_confirmation'`,
    [ctx.conversation.id, user.id],
  ).forEach((row) => {
    if (task && row.id === task.active_proposal_id) return;
    const payload = parseJson(row.payload_json, {});
    const proposal = payload.proposal || {};
    if (proposal.profile_revision && proposal.profile_revision !== persisted.profile_revision) {
      markProposalStale(row, user);
    }
  });
  let proposalActionId = null;
  const remainingForTask = task
    ? db.get(
        `SELECT COUNT(*) AS total FROM fact_candidates
         WHERE project_id = ? AND owner_id = ? AND status = 'pending'
           AND json_extract(proposed_value_json, '$.task_id') = ?`,
        [project.id, user.id, task.id],
      ).total
    : 0;
  const parentAction = task && task.active_proposal_id
    ? db.get(
        `SELECT * FROM ai_action_requests
         WHERE id = ? AND owner_id = ? AND action_type = 'RESUME_REWRITE_PROPOSAL'`,
        [task.active_proposal_id, user.id],
      )
    : null;
  const parentPayload = parentAction ? parseJson(parentAction.payload_json, {}) : {};
  const canInheritParent = Boolean(
    task
      && task.scope_type === 'RESUME_BLOCK'
      && parentPayload.proposal
      && parentPayload.proposal.scope_id === task.scope_id,
  );
  const proposal = (rawTask && !task) || remainingForTask
    ? null
    : buildRewriteProposalForFact({
        draft: ctx.draft,
        fact,
        text: persisted.text,
        scopeId: task && task.scope_type === 'RESUME_BLOCK' ? task.scope_id : null,
        editingBase: canInheritParent ? parentPayload.proposal.suggestion : null,
        parentProposalId: canInheritParent ? parentAction.id : null,
        taskId: task ? task.id : null,
        profileRevision: persisted.profile_revision,
        job: ctx.job,
      });
  if (proposal) {
    proposalActionId = uuidv7();
    db.run(
      `INSERT INTO ai_action_requests (id, conversation_id, message_id, owner_id, action_type, target_type, target_id, payload_json, evidence_json, confidence, requires_confirmation, status, expected_revision, policy_version, created_at)
       VALUES (?, ?, ?, ?, 'RESUME_REWRITE_PROPOSAL', 'resume_block', ?, ?, ?, NULL, 1, 'awaiting_confirmation', ?, ?, ?)`,
      [
        proposalActionId,
        actionId ? db.get('SELECT conversation_id FROM ai_action_requests WHERE id = ?', [actionId]).conversation_id : (ctx.conversation && ctx.conversation.id),
        null,
        user.id,
        proposal.scope_id,
        JSON.stringify({ task_id: task ? task.id : null, proposal, intent: '补充已确认事实' }),
        JSON.stringify([fact.id]),
        proposal.base_draft_revision,
        POLICY_VERSION,
        nowIso(),
      ],
    );
    if (task) {
      if (task.active_proposal_id) {
        db.run(
          `UPDATE ai_action_requests SET status = 'superseded'
           WHERE id = ? AND owner_id = ? AND status = 'awaiting_confirmation'`,
          [task.active_proposal_id, user.id],
        );
      }
      saveTask(task.id, {
        active_proposal_id: proposalActionId,
        status: 'waiting_apply',
        state: { editing_base: proposal.suggestion, parent_proposal_id: proposal.parent_proposal_id || null },
      });
    }
  } else if (task) {
    saveTask(task.id, { status: remainingForTask ? 'waiting_fact' : 'active' });
  }
  audit.log({
    ownerId: user.id,
    action: 'fact_confirmed',
    resourceType: 'fact_candidate',
    resourceId: fact.id,
    requestId,
    ipHash,
    metadata: { field_path: fact.field_path, target_id: persisted.target_id },
  });
  return {
    fact: toFactView(db.get('SELECT * FROM fact_candidates WHERE id = ?', [fact.id])),
    receipt_id: persisted.receipt_id,
    profile_revision: persisted.profile_revision,
    proposal: proposalActionId
      ? toActionView(db.get('SELECT * FROM ai_action_requests WHERE id = ?', [proposalActionId]))
      : null,
    resume_unchanged: true,
  };
}

function rejectFactCandidate({ user, project, fact }) {
  db.run(
    "UPDATE fact_candidates SET status = 'rejected', rejected_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    [nowIso(), nowIso(), fact.id],
  );
  db.run(
    `UPDATE ai_action_requests SET status = 'rejected'
     WHERE owner_id = ? AND action_type = 'FACT_CANDIDATE'
       AND status IN ('awaiting_confirmation','proposed')
       AND json_extract(payload_json, '$.fact_id') = ?`,
    [user.id, fact.id],
  );
  const factPayload = parseJson(fact.proposed_value_json, {});
  const task = factPayload.task_id
    ? db.get('SELECT * FROM ai_tasks WHERE id = ? AND owner_id = ? AND project_id = ?', [factPayload.task_id, user.id, project.id])
    : null;
  if (!task || ['completed', 'canceled'].includes(task.status)) {
    return { task: task || null, stale_proposals: [] };
  }

  const stale = [];
  const proposals = db.all(
    `SELECT * FROM ai_action_requests
     WHERE conversation_id = ? AND owner_id = ? AND action_type = 'RESUME_REWRITE_PROPOSAL'
       AND status IN ('awaiting_confirmation','superseded')`,
    [task.conversation_id, user.id],
  );
  proposals.forEach((row) => {
    const payload = parseJson(row.payload_json, {});
    const dependencies = (payload.proposal && payload.proposal.dependency_fact_ids) || [];
    if (payload.task_id === task.id && dependencies.includes(fact.id)) {
      db.run("UPDATE ai_action_requests SET status = 'stale' WHERE id = ?", [row.id]);
      stale.push(row.id);
    }
  });
  const activeStale = stale.includes(task.active_proposal_id);
  const remaining = db.get(
    `SELECT COUNT(*) AS total FROM fact_candidates
     WHERE project_id = ? AND owner_id = ? AND status = 'pending'
       AND json_extract(proposed_value_json, '$.task_id') = ?`,
    [project.id, user.id, task.id],
  ).total;
  const nextActive = activeStale ? null : task.active_proposal_id;
  saveTask(task.id, {
    active_proposal_id: nextActive,
    status: remaining ? 'waiting_fact' : nextActive ? 'waiting_apply' : 'active',
  });
  return { task, stale_proposals: stale };
}

function attachFactOutcomeMessage({ ctx, user, fact, outcome }) {
  if (!outcome || !outcome.proposal) return null;
  const factPayload = parseJson(fact.proposed_value_json, {});
  const task = factPayload.task_id
    ? db.get('SELECT * FROM ai_tasks WHERE id = ? AND owner_id = ?', [factPayload.task_id, user.id])
    : null;
  const id = uuidv7();
  const value = factPayload.label ? `${factPayload.label}：${factPayload.value || ''}` : fact.field_path;
  const content = `已确认保存「${value}」。我沿用上一版表达生成了新的修改建议，正文尚未改变。`;
  const scopeType = task ? task.scope_type : 'RESUME_DOCUMENT';
  const scopeId = task ? task.scope_id : null;
  db.run(
    `INSERT INTO ai_messages
     (id, conversation_id, owner_id, role, content, scope_type, scope_id, scope_revision, model_metadata_json, created_at)
     VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ctx.conversation.id,
      user.id,
      content,
      scopeType,
      scopeId,
      ctx.draft.revision,
      JSON.stringify({ task_id: task ? task.id : null, provider: 'policy', model: 'fact-confirmation' }),
      nowIso(),
    ],
  );
  db.run('UPDATE ai_action_requests SET message_id = ? WHERE id = ?', [id, outcome.proposal.id]);
  return id;
}

/* =========================================================================
   消息处理管线（重构）：LLM + 会话记忆 + 上下文
   ① tryHandleConfirmation  短句「是的/确认/忽略」→ 确定性绑定待确认事实（不调模型）
   ② assembleInput          拼装模型上下文：最近 N 轮对话 + 当前段落 + 岗位 + 基础字段
   ③ runModel               单次 LLM 调用（失败即失败）；必需动作缺失时补齐一次
   ④ applyActions           保存助手消息，逐动作过策略矩阵并落库
   ⑤ 收尾在 handler 内完成：会话状态、审计、返回
   ========================================================================= */

/** ① 确定性确认/忽略：只有存在「刚刚等待确认的事实」时才处理，否则返回 null 交给带记忆的模型。 */
function tryHandleConfirmation({ conversation, params, body, user, requestId, ipHash, task }) {
  const content = String(body.content || '').trim();
  const ACK_WORDS = ['是的', '对', '确认', '可以', '行', '好的', '好', '同意', '嗯', '没错', '确定', 'yes'];
  const ackHit =
    content.length <= 8 &&
    ACK_WORDS.some(
      (w) => content === w || content.startsWith(w + '，') || content.startsWith(w + '。') || content.startsWith(w + '吧') || content.startsWith(w + '了'),
    );
  const rejectHit = content.length <= 8 && /^(不用了?|不要|算了|取消|忽略|先不了?|暂时不)/.test(content);
  if (!ackHit && !rejectHit) return null;

  const latestFactAction = db.get(
    `SELECT * FROM ai_action_requests
     WHERE conversation_id = ? AND owner_id = ? AND action_type = 'FACT_CANDIDATE'
       AND status = 'awaiting_confirmation'
       AND json_extract(payload_json, '$.task_id') = ?
     ORDER BY created_at DESC LIMIT 1`,
    [conversation.id, user.id, task.id],
  );
  const factId = latestFactAction ? (JSON.parse(latestFactAction.payload_json || '{}').fact_id || null) : null;
  const fact = factId
    ? db.get("SELECT * FROM fact_candidates WHERE id = ? AND owner_id = ? AND status = 'pending'", [factId, user.id])
    : null;
  if (!fact) {
    const pendingCount = db.get(
      `SELECT COUNT(*) AS total FROM ai_action_requests
       WHERE conversation_id = ? AND owner_id = ? AND action_type = 'FACT_CANDIDATE'
         AND status = 'awaiting_confirmation'`,
      [conversation.id, user.id],
    ).total;
    if (pendingCount <= 1) return null;
    const userMessageId = uuidv7();
    const assistantMessageId = uuidv7();
    const scopeType = task.scope_type;
    const scopeId = task.scope_id || null;
    const metadata = JSON.stringify({ task_id: task.id, provider: 'policy', model: 'scope-router' });
    db.run(
      `INSERT INTO ai_messages (id, conversation_id, owner_id, role, content, scope_type, scope_id, scope_revision, model_metadata_json, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, ?, NULL, ?, ?)`,
      [userMessageId, conversation.id, user.id, content, scopeType, scopeId, metadata, nowIso()],
    );
    const replyText = '现在有多项内容待确认，请在对应卡片上选择“确认保存”或“不是这样”。';
    db.run(
      `INSERT INTO ai_messages (id, conversation_id, owner_id, role, content, scope_type, scope_id, scope_revision, model_metadata_json, created_at)
       VALUES (?, ?, ?, 'assistant', ?, ?, ?, NULL, ?, ?)`,
      [assistantMessageId, conversation.id, user.id, replyText, scopeType, scopeId, metadata, nowIso()],
    );
    return {
      message: toMessageView(db.get('SELECT * FROM ai_messages WHERE id = ?', [userMessageId])),
      reply: toMessageView(db.get('SELECT * FROM ai_messages WHERE id = ?', [assistantMessageId])),
      reply_text: replyText,
      actions: [],
      saved: false,
      task_id: task.id,
      scope: { type: scopeType, id: scopeId, label: SCOPE_LABEL[scopeType] || '' },
    };
  }

  return db.tx(() => {
    const ackCtx = loadContext(params.id, user);
    const ackScopeType = policy.SCOPE_TYPES.has(String(body.scope_type || '')) ? body.scope_type : 'RESUME_DOCUMENT';
    const ackScopeId = body.scope_id || null;
    const ackScopeRevision = body.scope_revision !== undefined ? body.scope_revision : null;

    const ackUserMessageId = uuidv7();
    db.run(
      `INSERT INTO ai_messages (id, conversation_id, owner_id, role, content, scope_type, scope_id, scope_revision, model_metadata_json, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
      [ackUserMessageId, conversation.id, user.id, content, ackScopeType, ackScopeId, ackScopeRevision, JSON.stringify({ task_id: task.id }), nowIso()],
    );

    const assistantMessageId = uuidv7();
    let replyText;
    let proposalLinked = null;
    if (ackHit) {
      const outcome = confirmFactCandidate({
        user,
        project: ackCtx.project,
        ctx: ackCtx,
        fact,
        actionId: latestFactAction ? latestFactAction.id : null,
        expectedRevision: undefined,
        requestId,
        ipHash,
      });
      const value = (() => {
        try {
          const v = JSON.parse(fact.proposed_value_json || '{}');
          return `${v.label || fact.field_path}：${v.value || ''}`;
        } catch (_) {
          return fact.field_path;
        }
      })();
      replyText = `已确认保存：「${value}」。它已进入个人信息；要更新简历，请查看下方的新建议并选择“应用修改”。`;
      if (outcome.proposal) proposalLinked = outcome.proposal.id;
    } else {
      rejectFactCandidate({ user, project: ackCtx.project, fact });
      replyText = '已忽略，资料没有变化。';
    }

    db.run(
      `INSERT INTO ai_messages (id, conversation_id, owner_id, role, content, scope_type, scope_id, scope_revision, model_metadata_json, created_at)
       VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`,
      [assistantMessageId, conversation.id, user.id, replyText, ackScopeType, ackScopeId, ackScopeRevision, JSON.stringify({ task_id: task.id }), nowIso()],
    );
    if (proposalLinked) {
      db.run('UPDATE ai_action_requests SET message_id = ? WHERE id = ?', [assistantMessageId, proposalLinked]);
    }

    return {
      message: toMessageView(db.get('SELECT * FROM ai_messages WHERE id = ?', [ackUserMessageId])),
      reply: toMessageView(db.get('SELECT * FROM ai_messages WHERE id = ?', [assistantMessageId])),
      reply_text: replyText,
      actions: [],
      engine: { provider: 'user-confirm', model: '确定性确认' },
      saved: ackHit,
      task_id: task.id,
      scope: { type: ackScopeType, id: ackScopeId, label: SCOPE_LABEL[ackScopeType] || '' },
    };
  });
}

function loadVisionAttachments(attachmentIds, user) {
  const ids = [...new Set(Array.isArray(attachmentIds) ? attachmentIds.filter(Boolean) : [])];
  if (ids.length > 4) throw problem.badRequest('每条消息最多附带 4 张图片');
  let totalBytes = 0;
  return ids.map((id) => {
    const upload = db.get(
      "SELECT * FROM uploads WHERE id = ? AND owner_id = ? AND status = 'ready'",
      [id, user.id],
    );
    if (!upload) throw problem.badRequest('附件不存在或尚未处理完成');
    if (!String(upload.mime_type || '').startsWith('image/')) {
      throw problem.badRequest('AI 对话附件目前只支持图片');
    }
    const buffer = getObject(upload.object_key);
    if (!buffer) throw problem.unprocessable('FILE_MISSING', '未读取到附件内容');
    totalBytes += buffer.length;
    if (totalBytes > 20 * 1024 * 1024) {
      throw problem.unprocessable('ATTACHMENTS_TOO_LARGE', '本条消息的图片总大小不能超过 20 MB');
    }
    return {
      id: upload.id,
      name: upload.original_name,
      mime_type: upload.mime_type,
      content_base64: buffer.toString('base64'),
    };
  });
}

/** ② 拼装完整工作区、当前会话与锁定焦点；会话输入由 harness 按预算裁剪。 */
function assembleInput({ conversation, userMessageId, content, scopeType, scopeId, scopeRevision, job, profile, draft, project, user, task, parentProposalId, attachments = [] }) {
  const conversationMessages = db
    .all(
      `SELECT role, content, scope_type, scope_id FROM ai_messages
       WHERE conversation_id = ? AND id != ?
       ORDER BY created_at ASC LIMIT 100`,
      [conversation.id, userMessageId],
    );

  const profileBasics = JSON.parse(profile.basics_json || '{}');
  const resumeNow = JSON.parse(draft.resume_json || '{}');
  const foundTarget =
    scopeType === 'RESUME_BLOCK' && scopeId ? findBulletInDraft(resumeNow, scopeId) : null;
  const currentText = foundTarget ? String(foundTarget.bullet.text || '') : String(resumeNow.summary || '');

  // 表达起点只读取服务端保存的建议链，客户端不得用任意文本冒充上一版建议。
  const chosenParentId = parentProposalId || task.active_proposal_id || null;
  const parentAction = chosenParentId
    ? db.get(
        `SELECT * FROM ai_action_requests
         WHERE id = ? AND conversation_id = ? AND owner_id = ? AND action_type = 'RESUME_REWRITE_PROPOSAL'`,
        [chosenParentId, conversation.id, user.id],
      )
    : null;
  const parentPayload = parentAction ? parseJson(parentAction.payload_json, {}) : {};
  const parentBelongsToTask = parentPayload.task_id === task.id;
  const editingBase = parentBelongsToTask && parentPayload.proposal
    ? String(parentPayload.proposal.suggestion || currentText)
    : currentText;

  // 溯源该段背后的原始事实（资料库经历），作为改写的事实基准
  const sourceExperiences = db.all(
    'SELECT id, type, organization, description FROM experiences WHERE profile_id = ? AND deleted_at IS NULL',
    [profile.id],
  );
  let sourceKey = null;
  if (foundTarget) {
    // 来源可能在经历对象（seed 草稿）或 bullet（生成稿 / AI 改写稿）上
    sourceKey =
      (foundTarget.item && foundTarget.item.source_exp) ||
      foundTarget.bullet.source_exp ||
      (foundTarget.bullet.source_item_ids && foundTarget.bullet.source_item_ids[0]) ||
      null;
  }
  const sourceExp = sourceKey ? sourceExperiences.find((exp) => exp.id === sourceKey) : null;
  // 事实基准只能来自资料库或真实正文 A，绝不从上一版 AI 建议 B 回退。
  const sourceFacts = sourceExp
    ? splitBullets(sourceExp.description).slice(0, 20)
    : currentText
      ? [currentText]
      : [];

  // 待确认内容属于事实边界，但不作为已确认事实输入。
  const pendingRows = db.all(
    `SELECT id, target_type, target_id, field_path, proposed_value_json FROM fact_candidates
     WHERE project_id = ? AND owner_id = ? AND status = 'pending'
     ORDER BY created_at ASC`,
    [project.id, user.id],
  );
  const pendingFacts = pendingRows
    .map((row) => {
      try {
        const v = JSON.parse(row.proposed_value_json || '{}');
        return {
          id: row.id,
          target_type: row.target_type,
          target_id: row.target_id,
          field_path: row.field_path,
          label: v.label || '',
          value: v.value || '',
          raw_text: v.raw_text || '',
        };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
  const state = taskState(task);
  const itemBullets = foundTarget ? foundTarget.item.bullets || [] : [];
  const bulletIndex = foundTarget ? itemBullets.findIndex((entry) => entry.id === scopeId) : -1;
  const focus = {
    current_text: currentText,
    editing_base: editingBase,
    location: foundTarget
      ? {
          section: foundTarget.section,
          item_id: foundTarget.item.id || null,
          organization: foundTarget.item.organization || foundTarget.item.name || '',
          title: foundTarget.item.title || '',
          bullet_id: foundTarget.bullet.id,
          bullet_index: bulletIndex,
        }
      : { section: 'summary', item_id: null, bullet_id: null },
    neighboring_content: foundTarget
      ? itemBullets
          .map((bullet, index) => ({ id: bullet.id || null, index, text: String(bullet.text || '') }))
          .filter((entry) => Math.abs(entry.index - bulletIndex) <= 2 && entry.index !== bulletIndex)
      : [],
  };
  const confirmedFacts = sourceExperiences.map((experience) => ({
    id: experience.id,
    type: experience.type,
    organization: experience.organization || '',
    description: experience.description || '',
  }));
  const llmInput = resumeHarness.buildHarnessInput({
    text: content,
    messageId: userMessageId,
    scope: { type: scopeType, id: scopeId, revision: scopeRevision },
    task: {
      id: task.id,
      goal: task.goal || content,
      status: task.status,
      answers: state.answers || [],
    },
    profile: { id: profile.id, revision: profile.revision, basics: profileBasics },
    confirmedFacts,
    resume: { id: draft.id, revision: draft.revision, content: resumeNow },
    job: job
      ? {
          id: job.id,
          revision: job.revision,
          title: job.title || '',
          company: job.company || '',
          confirmed_text: job.confirmed_text || '',
          analysis: parseJson(job.analysis_json, {}),
        }
      : null,
    focus,
    pendingFacts,
    conversationMessages,
    conversationSummary: parseJson(conversation.summary_json, null),
    attachments,
  });
  return {
    currentText,
    editingBase,
    parentProposalId: parentBelongsToTask ? parentAction.id : null,
    sourceFacts,
    llmInput,
  };
}

/** ③ 单次模型调用。语义由模型理解；后端只做结构校验与权限/事实安全检查。 */
async function runModel({ llmInput, userMessageId, draft, job }) {
  let modelResult;
  try {
    modelResult = await resumeHarness.complete(llmInput);
  } catch (err) {
    console.error('[ai] 模型调用失败：', err && err.message);
    const timeout = /超时|abort|interrupt|长时间|idle|fetch failed/i.test(String((err && err.message) || ''));
    throw problem.unprocessable('MODEL_UNAVAILABLE', timeout ? '模型响应超时或中断，请稍后重试。' : '模型服务暂时不可用，请稍后重试。');
  }
  const { response, provider, model, prompt_version, schema_version } = modelResult;
  const validation = policy.validateModelResponse(response, { injectEvidence: userMessageId });
  if (response.needs_review_reply) {
    response.reply = buildReviewReply({ resume: JSON.parse(draft.resume_json || '{}'), job });
  }
  return { response, provider, model, prompt_version, schema_version, validation };
}

/** ④ 保存助手消息，逐动作过策略矩阵并落库（仅回复 / 待确认 / 白名单执行）。 */
function applyActions({ ctx, user, response, validation, provider, model, prompt_version, schema_version, content, scopeType, scopeId, scopeRevision, userMessageId, currentText, editingBase, parentProposalId, sourceFacts, task, requestId, ipHash }) {
  // 供兜底解析使用
  ctx.user_id = user.id;
  const { project, profile, draft, job, conversation } = ctx;
  const profileBasics = JSON.parse(profile.basics_json || '{}');
  const jobAnalysis = job ? JSON.parse(job.analysis_json || '{}') : {};
  const keywords = jobAnalysis.keywords || [];

  const executed = [];
  const rejected = [...validation.rejected];
  const hasBlockingFact = validation.actions.some((entry) => entry.type === 'FACT_CANDIDATE');
  const assistantMessageId = uuidv7();
  db.run(
    `INSERT INTO ai_messages (id, conversation_id, owner_id, role, content, scope_type, scope_id, scope_revision, model_metadata_json, created_at)
     VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`,
    [
      assistantMessageId,
      conversation.id,
      user.id,
      response.reply || '',
      scopeType,
      scopeId,
      scopeRevision,
      JSON.stringify({ provider, model, prompt_version, policy_version: POLICY_VERSION, schema_version: schema_version || resumeHarness.SCHEMA_VERSION, task_id: task.id }),
      nowIso(),
    ],
  );

  for (const action of validation.actions) {
    if (!actionAllowedInScope(action.type, scopeType)) {
      rejected.push({ action_type: action.type, reason: 'SCOPE_ACTION_CONFLICT' });
      continue;
    }
    if (action.type === 'RESUME_REWRITE_PROPOSAL' && hasBlockingFact) {
      rejected.push({ action_type: action.type, reason: 'FACT_CONFIRMATION_REQUIRED' });
      continue;
    }
    const decision = policy.decideAction(action, { profileRevision: profile.revision, profileBefore: profileBasics });

    if (decision.outcome === 'reject') {
      rejected.push({ action_type: action.type, reason: decision.reason, conflict: decision.conflict || null });
      audit.log({
        ownerId: user.id,
        action: 'ai_action_rejected_by_policy',
        resourceType: 'ai_action_request',
        resourceId: '',
        requestId,
        ipHash,
        metadata: { action_type: action.type, reason: decision.reason },
      });
      continue;
    }

    const actionId = uuidv7();
    const type = decision.convertTo || action.type;

    if (decision.outcome === 'reply_only') {
      db.run(
        `INSERT INTO ai_action_requests (id, conversation_id, message_id, owner_id, action_type, target_type, target_id, payload_json, evidence_json, confidence, requires_confirmation, status, expected_revision, policy_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'proposed', NULL, ?, ?)`,
        [
          actionId, conversation.id, assistantMessageId, user.id, type,
          action.target_type || null, action.target_id || null,
          JSON.stringify({ ...(action.payload || {}), task_id: task.id }), JSON.stringify(action.evidence_ids || []),
          POLICY_VERSION, nowIso(),
        ],
      );
      executed.push({ ...toActionView(db.get('SELECT * FROM ai_action_requests WHERE id = ?', [actionId])), outcome: 'reply_only' });
      continue;
    }

    if (decision.outcome === 'await_confirm') {
      let payload = action.payload || {};
      if (type === 'RESUME_REWRITE_PROPOSAL') {
        const modelProposal = action.payload && action.payload.proposal;
        if (provider !== 'test' && !String(modelProposal && modelProposal.suggestion || '').trim()) {
          rejected.push({ action_type: type, reason: 'INVALID_REWRITE_PROPOSAL' });
          continue;
        }
        const baseProposal = buildRewriteProposal({ draft, scopeId: scopeType === 'RESUME_BLOCK' ? scopeId : null, intent: content, keywords, overrideText: editingBase });
        baseProposal.original = currentText;
        const proposal = adoptModelSuggestion(
          baseProposal,
          modelProposal,
          [...(sourceFacts || []), currentText],
        );
        Object.assign(proposal, {
          original: currentText,
          current_text: currentText,
          editing_base: editingBase,
          parent_proposal_id: parentProposalId || null,
          base_target_hash: textHash(currentText),
          base_draft_revision: draft.revision,
          profile_revision: profile.revision,
          job_id: job ? job.id : null,
          job_revision: job ? job.revision : null,
        });
        if ((proposal.pending_claims || []).length) {
          rejected.push({
            action_type: type,
            reason: 'UNCONFIRMED_FACT_IN_PROPOSAL',
            tokens: proposal.pending_claims.map((claim) => claim.token),
          });
          response.reply = '这版建议出现了尚未确认的数据，我没有生成可应用方案。请先补充并确认该数据。';
          response.uncertainty = ['建议包含未确认数据'];
          continue;
        }
        payload = { ...payload, task_id: task.id, proposal };
      }
      if (type === 'JOB_CANDIDATE') {
        const jobId = uuidv7();
        const rawText = String((action.payload && action.payload.raw_text) || '');
        let title = '';
        if (rawText) {
          const analysis = analyzeJobText(rawText);
          title = analysis.title || '';
          db.run(
            `INSERT INTO target_jobs (id, project_id, owner_id, title, company, confirmed_text, ocr_text, analysis_json, revision, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'confirmed', ?, ?)`,
            [jobId, project.id, user.id, title, analysis.company || '', rawText, rawText, JSON.stringify(analysis), nowIso(), nowIso()],
          );
        } else {
          db.run(
            `INSERT INTO target_jobs (id, project_id, owner_id, title, company, confirmed_text, ocr_text, analysis_json, revision, status, created_at, updated_at)
             VALUES (?, ?, ?, '', '', '', '', '{}', 1, 'draft', ?, ?)`,
            [jobId, project.id, user.id, nowIso(), nowIso()],
          );
        }
        payload = { ...payload, task_id: task.id, job_id: jobId, title };
      }
      if (type === 'FACT_CANDIDATE') payload = { ...payload, task_id: task.id };
      db.run(
        `INSERT INTO ai_action_requests (id, conversation_id, message_id, owner_id, action_type, target_type, target_id, payload_json, evidence_json, confidence, requires_confirmation, status, expected_revision, policy_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'awaiting_confirmation', ?, ?, ?)`,
        [
          actionId, conversation.id, assistantMessageId, user.id, type,
          action.target_type || null,
          type === 'JOB_CANDIDATE' ? payload.job_id : action.target_id || null,
          JSON.stringify(payload), JSON.stringify(action.evidence_ids || []),
          action.confidence || null,
          type === 'RESUME_REWRITE_PROPOSAL' ? draft.revision : action.expected_revision || null,
          POLICY_VERSION, nowIso(),
        ],
      );
      if (type === 'FACT_CANDIDATE') {
        const rawText = (action.payload && (action.payload.raw_text || action.payload.value)) || content;
        const value = String((action.payload && (action.payload.value || action.payload.proposed_value)) || rawText).trim();
        const label = String((action.payload && action.payload.label) || '待确认内容').trim();
        const fieldPath = String(action.field_path || 'fact').trim();
        const factId = uuidv7();
        const factPayload = { ...(action.payload || {}), task_id: task.id, label, value, fact_id: factId };
        let factTargetId = scopeType === 'DATA_PROFILE' ? scopeId : null;
        if (scopeType === 'RESUME_BLOCK') {
          const resume = parseJson(draft.resume_json, {});
          const found = findBulletInDraft(resume, scopeId);
          factTargetId = found
            ? ((found.item && found.item.source_exp) || found.bullet.source_exp || ((found.bullet.source_item_ids || [])[0]) || null)
            : null;
        }
        db.run(
          `INSERT INTO fact_candidates (id, project_id, owner_id, target_type, target_id, field_path, proposed_value_json, source_type, source_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          [
            factId, project.id, user.id,
            action.target_type || 'profile_experience',
            factTargetId,
            fieldPath,
            JSON.stringify({ ...factPayload, evidence: action.evidence_ids || [] }),
            'message', userMessageId, nowIso(), nowIso(), // eslint-disable-line no-undef
          ],
        );
        db.run('UPDATE ai_action_requests SET payload_json = ?, target_id = ? WHERE id = ?', [
          JSON.stringify(factPayload),
          factId,
          actionId,
        ]);
        const state = taskState(task);
        saveTask(task.id, {
          status: 'waiting_fact',
          state: { fact_ids: [...new Set([...(state.fact_ids || []), factId])] },
        });
      }
      if (type === 'RESUME_REWRITE_PROPOSAL') {
        if (task.active_proposal_id && task.active_proposal_id !== actionId) {
          db.run(
            `UPDATE ai_action_requests SET status = 'superseded'
             WHERE id = ? AND owner_id = ? AND status = 'awaiting_confirmation'`,
            [task.active_proposal_id, user.id],
          );
        }
        saveTask(task.id, {
          active_proposal_id: actionId,
          status: 'waiting_apply',
          state: { editing_base: payload.proposal.suggestion, parent_proposal_id: parentProposalId || null },
        });
      }
      executed.push({ ...toActionView(db.get('SELECT * FROM ai_action_requests WHERE id = ?', [actionId])), outcome: 'await_confirm' });
      continue;
    }

    // decision.outcome === 'execute'：白名单字段，生成可撤销回执
    db.run(
      `INSERT INTO ai_action_requests (id, conversation_id, message_id, owner_id, action_type, target_type, target_id, payload_json, evidence_json, confidence, requires_confirmation, status, expected_revision, policy_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'proposed', ?, ?, ?)`,
      [
        actionId, conversation.id, assistantMessageId, user.id,
        'PROFILE_FIELD_UPDATE', 'profile_basics', profile.id,
        JSON.stringify({ field: decision.field, value: decision.value, explicit: true, task_id: task.id }),
        JSON.stringify(action.evidence_ids || []),
        action.expected_revision || null, POLICY_VERSION, nowIso(),
      ],
    );
    let receiptResult;
    try {
      receiptResult = policy.executeProfileFieldUpdate({
        user, project, profile, field: decision.field, value: decision.value,
        actionRequestId: actionId, requestId, ipHash,
      });
    } catch (err) {
      db.run("UPDATE ai_action_requests SET status = 'failed' WHERE id = ?", [actionId]);
      rejected.push({ action_type: 'PROFILE_FIELD_UPDATE', reason: err.message });
      continue;
    }
    executed.push({
      ...toActionView(db.get('SELECT * FROM ai_action_requests WHERE id = ?', [actionId])),
      status: receiptResult.changed ? 'applied' : 'proposed',
      outcome: 'execute',
      receipt: receiptResult,
      field_label: policy.FIELD_LABELS[decision.field] || decision.field,
    });
  }

  // 文案一致性：只有产生了真实执行的动作，才允许「已更新」表述
  const hasBusinessAction = executed.some((item) =>
    ['FACT_CANDIDATE', 'JOB_CANDIDATE', 'RESUME_REWRITE_PROPOSAL', 'PROFILE_FIELD_UPDATE'].includes(item.action_type),
  );
  if (!hasBusinessAction && Array.isArray(response.uncertainty) && response.uncertainty[0]) {
    saveTask(task.id, { status: 'active', state: { current_question: response.uncertainty[0] } });
  }
  const replyText = hasBlockingFact
    ? '我先把会影响这次修改的新事实放到待确认。处理后，我会沿用当前建议继续生成下一版。'
    : response.reply;
  const finalReply = reconcileReply(replyText, executed);
  db.run('UPDATE ai_messages SET content = ? WHERE id = ?', [finalReply, assistantMessageId]);
  return { assistantMessageId, executed, rejected, finalReply };
}
const routes = [
  {
    method: 'GET',
    pattern: '/projects/:id/ai/messages',
    handler: ({ params, user }) => {
      const { conversation } = loadContext(params.id, user);
      return {
        items: db
          .all('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC', [
            conversation.id,
          ])
          .map(toMessageView),
      };
    },
  },
  {
    method: 'GET',
    pattern: '/projects/:id/ai/actions',
    handler: ({ params, user, query }) => {
      const { conversation } = loadContext(params.id, user);
      const status = query.get('status') || 'pending';
      const map = { pending: ['awaiting_confirmation', 'proposed'], all: null };
      const statuses = map[status] || [status];
      const rows = statuses
        ? db.all(
            `SELECT * FROM ai_action_requests WHERE conversation_id = ? AND owner_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at ASC`,
            [conversation.id, user.id, ...statuses],
          )
        : db.all('SELECT * FROM ai_action_requests WHERE conversation_id = ? AND owner_id = ? ORDER BY created_at DESC', [conversation.id, user.id]);
      return { items: rows.map(toActionView) };
    },
  },
  {
    method: 'POST',
    pattern: '/projects/:id/ai/messages',
    handler: async ({ params, body, user, requestId, ipHash }) => {
      const ctx = loadContext(params.id, user);
      const { conversation } = ctx;
      const content = String(body.content || '').trim();
      if (!content) throw problem.badRequest('消息内容不能为空');
      // 作用范围在请求进入时冻结（P0-17：发送后切换范围不影响本请求）
      const scopeType = body.scope_type || 'RESUME_DOCUMENT';
      const locked = validateLockedScope(ctx, scopeType, body.scope_id || null);
      const scopeId = locked.scopeId;
      const scopeRevision =
        body.scope_revision !== undefined ? body.scope_revision : ctx.draft ? ctx.draft.revision : null;
      const task = resolveTask({ ctx, user, body, scopeType, scopeId, content });

      // ① 短句确认/忽略只能绑定当前任务，存在歧义时不猜测。
      const confirmed = tryHandleConfirmation({ conversation, params, body, user, requestId, ipHash, task });
      if (confirmed) return confirmed;

      const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
      const attachments = loadVisionAttachments(attachmentIds, user);

      // 用户消息入库（冻结范围）
      const userMessageId = uuidv7();
      db.run(
        `INSERT INTO ai_messages (id, conversation_id, owner_id, role, content, scope_type, scope_id, scope_revision, model_metadata_json, created_at)
         VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
        [userMessageId, conversation.id, user.id, content, scopeType, scopeId, scopeRevision, JSON.stringify({ task_id: task.id, attachment_ids: attachmentIds }), nowIso()],
      );
      db.run('UPDATE ai_conversations SET active_scope_type = ?, active_scope_id = ?, updated_at = ? WHERE id = ?', [
        scopeType,
        scopeId,
        nowIso(),
        conversation.id,
      ]);

      // ② 拼装模型上下文：完整工作区 + 当前会话记忆 + 锁定焦点 + 图片附件
      const { llmInput, currentText, editingBase, parentProposalId, sourceFacts } = assembleInput({
        conversation,
        userMessageId,
        content,
        scopeType,
        scopeId,
        scopeRevision,
        job: ctx.job,
        profile: ctx.profile,
        draft: ctx.draft,
        project: ctx.project,
        user,
        task,
        parentProposalId: body.parent_proposal_id || null,
        attachments,
      });

      // ③ 单次模型调用（失败即失败）
      const { response, provider, model, prompt_version, schema_version, validation } = await runModel({
        llmInput,
        userMessageId,
        draft: ctx.draft,
        job: ctx.job,
      });

      // 模型作答期间用户可能已经开始了新对话；旧请求不得在新边界后落下建议或动作。
      const liveConversation = db.get(
        "SELECT id FROM ai_conversations WHERE id = ? AND project_id = ? AND owner_id = ? AND status = 'active'",
        [conversation.id, ctx.project.id, user.id],
      );
      const liveTask = db.get('SELECT status FROM ai_tasks WHERE id = ? AND owner_id = ?', [task.id, user.id]);
      if (!liveConversation || !liveTask || liveTask.status === 'canceled') {
        throw problem.conflict('CONVERSATION_ENDED', '当前对话已结束，请在新对话中重新发送');
      }

      // ④ 策略执行：保存助手消息、逐动作落库
      const { assistantMessageId, executed, rejected, finalReply } = applyActions({
        ctx,
        user,
        response,
        validation,
        provider,
        model,
        prompt_version,
        schema_version,
        content,
        scopeType,
        scopeId,
        scopeRevision,
        userMessageId,
        currentText,
        editingBase,
        parentProposalId,
        sourceFacts,
        task,
        requestId,
        ipHash,
      });

      // ⑤ 审计与返回
      audit.log({
        ownerId: user.id,
        action: 'ai_message_processed',
        resourceType: 'ai_message',
        resourceId: assistantMessageId,
        requestId,
        ipHash,
        metadata: {
          scope_type: scopeType,
          executed: executed.map((item) => item.action_type),
          rejected: rejected.map((item) => item.reason),
        },
      });
      return {
        message: toMessageView(db.get('SELECT * FROM ai_messages WHERE id = ?', [userMessageId])),
        reply: toMessageView(db.get('SELECT * FROM ai_messages WHERE id = ?', [assistantMessageId])),
        reply_text: finalReply,
        actions: executed,
        rejected,
        scope: { type: scopeType, id: scopeId, label: SCOPE_LABEL[scopeType] || '', revision: scopeRevision },
        policy_version: POLICY_VERSION,
        prompt_version,
        engine: { provider, model },
        task_id: task.id,
        saved: executed.filter((item) => item.status === 'applied').length > 0,
      };
    },
  },

  /** 确认动作。幂等：相同 action_id / Idempotency-Key 不重复写入（P0-15）。 */
  {
    method: 'POST',
    pattern: '/ai/actions/:id/confirm',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'ai_action_confirm', () => {
        const action = db.get('SELECT * FROM ai_action_requests WHERE id = ? AND owner_id = ?', [
          params.id,
          user.id,
        ]);
        if (!action) throw problem.notFound('动作不存在');
        if (['applied', 'rejected', 'reverted'].includes(action.status)) {
          return { id: action.id, status: action.status, idempotent_replay: true };
        }
        if (action.requires_confirmation !== 1) {
          throw problem.conflict('ACTION_NOT_CONFIRMABLE', '该动作不需要确认');
        }
        const conversationRow = db.get('SELECT * FROM ai_conversations WHERE id = ?', [
          action.conversation_id,
        ]);
        const project = conversationRow
          ? db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
              conversationRow.project_id,
              user.id,
            ])
          : null;
        if (!project) throw problem.notFound('项目不存在');
        const ctx = loadContext(project.id, user);
        const payload = JSON.parse(action.payload_json || '{}');

        // 事实候选：先写入左侧资料，再生成简历修改方案（P0-19）
        if (action.action_type === 'FACT_CANDIDATE') {
          // 精确绑定：优先使用动作创建时对应的候选事实
          const fact = payload.fact_id
            ? db.get('SELECT * FROM fact_candidates WHERE id = ? AND owner_id = ?', [
                payload.fact_id,
                user.id,
              ])
            : db.get(
                "SELECT * FROM fact_candidates WHERE project_id = ? AND owner_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1",
                [project.id, user.id],
              );
          if (!fact) throw problem.notFound('待确认事实不存在');
          if (fact.status !== 'pending') {
            return { id: action.id, status: action.status, idempotent_replay: true };
          }
          const outcome = confirmFactCandidate({
            user,
            project,
            ctx,
            fact,
            actionId: action.id,
            expectedRevision: body.expected_revision,
            requestId,
            ipHash,
          });
          db.run("UPDATE ai_action_requests SET status = 'applied', applied_at = ? WHERE id = ?", [
            nowIso(),
            action.id,
          ]);
          attachFactOutcomeMessage({ ctx, user, fact, outcome });
          return { id: action.id, status: 'applied', ...outcome };
        }


        // 岗位候选：确认后替换当前岗位并重新分析，不重写简历（P0-20）
        if (action.action_type === 'JOB_CANDIDATE') {
          const jobId = payload.job_id || action.target_id;
          const job = db.get('SELECT * FROM target_jobs WHERE id = ? AND owner_id = ?', [jobId, user.id]);
          if (!job) throw problem.notFound('岗位候选不存在');
          if (job.status !== 'confirmed') {
            throw problem.unprocessable('JOB_NOT_CONFIRMED', '请先确认岗位文本，再设为当前岗位');
          }
          db.run('UPDATE resume_projects SET current_job_id = ?, updated_at = ? WHERE id = ?', [
            job.id,
            nowIso(),
            project.id,
          ]);
          db.bumpRevision('resume_projects', project.id);
          db.all(
            `SELECT * FROM ai_action_requests
             WHERE conversation_id = ? AND owner_id = ? AND action_type = 'RESUME_REWRITE_PROPOSAL'
               AND status = 'awaiting_confirmation'`,
            [action.conversation_id, user.id],
          ).forEach((proposalAction) => markProposalStale(proposalAction, user));
          db.run("UPDATE ai_action_requests SET status = 'applied', applied_at = ? WHERE id = ?", [
            nowIso(),
            action.id,
          ]);
          queue.publish({
            aggregateType: 'target_job',
            aggregateId: job.id,
            eventType: 'job.analyze.requested',
          });
          audit.log({
            ownerId: user.id,
            action: 'job_candidate_confirmed',
            resourceType: 'target_job',
            resourceId: job.id,
            requestId,
            ipHash,
          });
          return { id: action.id, status: 'applied', job_id: job.id, resume_unchanged: true };
        }

        // 改写方案：应用后只更新草稿，不创建历史版本（P0-11 / 发布验收 18）
        if (action.action_type === 'RESUME_REWRITE_PROPOSAL') {
          if (body.expected_revision !== undefined && body.expected_revision !== ctx.draft.revision) {
            throw problem.conflict('REVISION_CONFLICT', '简历已变化，请重新生成修改方案', {
              expected: body.expected_revision,
              current: ctx.draft.revision,
            });
          }
          validateRewriteProposal({ action, ctx, user });
          const result = applyRewriteProposal({
            user,
            project,
            draft: ctx.draft,
            action,
            requestId,
            ipHash,
          });
          return {
            id: action.id,
            status: 'applied',
            ...result,
            version_created: false,
          };
        }

        throw problem.conflict('ACTION_NOT_CONFIRMABLE', `动作 ${action.action_type} 不支持确认`);
      }),
  },

  {
    method: 'POST',
    pattern: '/ai/actions/:id/reject',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'ai_action_reject', () => {
        const action = db.get('SELECT * FROM ai_action_requests WHERE id = ? AND owner_id = ?', [
          params.id,
          user.id,
        ]);
        if (!action) throw problem.notFound('动作不存在');
        if (['rejected', 'applied', 'reverted'].includes(action.status)) {
          return { id: action.id, status: action.status, idempotent_replay: true };
        }
        db.tx(() => {
          const payload = JSON.parse(action.payload_json || '{}');
          const factId = payload.fact_id || action.target_id;
          if (action.action_type === 'FACT_CANDIDATE' && factId) {
            const fact = db.get('SELECT * FROM fact_candidates WHERE id = ? AND owner_id = ?', [factId, user.id]);
            const conversation = db.get('SELECT * FROM ai_conversations WHERE id = ?', [action.conversation_id]);
            const project = conversation
              ? db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [conversation.project_id, user.id])
              : null;
            if (fact && project) rejectFactCandidate({ user, project, fact });
            else db.run("UPDATE ai_action_requests SET status = 'rejected' WHERE id = ?", [action.id]);
          } else {
            db.run("UPDATE ai_action_requests SET status = 'rejected' WHERE id = ?", [action.id]);
            if (action.action_type === 'RESUME_REWRITE_PROPOSAL' && payload.task_id) {
              const task = db.get('SELECT * FROM ai_tasks WHERE id = ? AND owner_id = ?', [payload.task_id, user.id]);
              if (task && task.active_proposal_id === action.id) {
                saveTask(task.id, { active_proposal_id: null, status: 'active' });
              }
            }
          }
        });
        audit.log({
          ownerId: user.id,
          action: 'ai_action_rejected',
          resourceType: 'ai_action_request',
          resourceId: action.id,
          requestId,
          ipHash,
          metadata: { action_type: action.action_type, reason: body.reason || '' },
        });
        return { id: action.id, status: 'rejected', data_unchanged: true };
      }),
  },

  {
    method: 'POST',
    pattern: '/ai/actions/:id/revert',
    handler: ({ params, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'ai_action_revert', () =>
        policy.revertAction({ user, actionRequestId: params.id, requestId, ipHash }),
      ),
  },

  // 左侧待确认资料的直接确认 / 忽略入口（PRD §6.6）
  {
    method: 'POST',
    pattern: '/projects/:id/ai/facts/:factId/confirm',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'fact_confirm', () =>
        db.tx(() => {
          const ctx = loadContext(params.id, user);
          const fact = db.get('SELECT * FROM fact_candidates WHERE id = ? AND owner_id = ?', [
            params.factId,
            user.id,
          ]);
          if (!fact) throw problem.notFound('待确认资料不存在');
          if (fact.status !== 'pending') {
            return { id: fact.id, status: fact.status, idempotent_replay: true };
          }
          const outcome = confirmFactCandidate({
            user,
            project: ctx.project,
            ctx,
            fact,
            actionId: null,
            expectedRevision: body.expected_revision,
            requestId,
            ipHash,
          });
          attachFactOutcomeMessage({ ctx, user, fact, outcome });
          return { id: fact.id, status: 'confirmed', ...outcome };
        }),
      ),
  },
  {
    method: 'POST',
    pattern: '/projects/:id/ai/facts/:factId/reject',
    handler: ({ params, body, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'fact_reject', () => {
        const fact = db.get('SELECT * FROM fact_candidates WHERE id = ? AND owner_id = ?', [
          params.factId,
          user.id,
        ]);
        if (!fact) throw problem.notFound('待确认资料不存在');
        if (fact.status !== 'pending') {
          return { id: fact.id, status: fact.status, idempotent_replay: true };
        }
        const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [params.id, user.id]);
        if (!project) throw problem.notFound('项目不存在');
        rejectFactCandidate({ user, project, fact });
        audit.log({
          ownerId: user.id,
          action: 'fact_rejected',
          resourceType: 'fact_candidate',
          resourceId: fact.id,
          requestId,
          ipHash,
          metadata: { reason: body.reason || '' },
        });
        return { id: fact.id, status: 'rejected', data_unchanged: true };
      }),
  },
  /** 开始新对话：保留事实与简历，收口旧任务和未应用建议。 */
  {
    method: 'POST',
    pattern: '/projects/:id/ai/conversations',
    handler: ({ params, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'ai_conversation_start', () =>
        startNewConversation({ projectId: params.id, user, requestId, ipHash }),
      ),
  },
  /** 兼容旧客户端；不再物理删除消息，语义统一为开始新对话。 */
  {
    method: 'DELETE',
    pattern: '/projects/:id/ai/messages',
    handler: ({ params, user, requestId, ipHash }) =>
      startNewConversation({ projectId: params.id, user, requestId, ipHash }),
  },
  {
    method: 'GET',
    pattern: '/projects/:id/ai/facts',
    handler: ({ params, user }) => {
      const { project } = loadContext(params.id, user);
      return {
        items: db
          .all(
            'SELECT * FROM fact_candidates WHERE project_id = ? AND owner_id = ? ORDER BY created_at ASC',
            [project.id, user.id],
          )
          .map(toFactView),
      };
    },
  },
];

/** 针对已确认事实生成改写方案：把事实补进最相关的一段简历内容。 */
function buildRewriteProposalForFact({ draft, fact, text, scopeId, editingBase, parentProposalId, taskId, profileRevision, job }) {
  const resume = JSON.parse(draft.resume_json || '{}');
  const locked = scopeId ? findBulletInDraft(resume, scopeId) : null;
  // 优先使用任务锁定段落；旧候选事实没有任务时再选择最相关内容。
  const candidates = [
    ...(resume.projects || []).map((item) => ({ item, bullets: item.bullets || [] })),
    ...(resume.experience || []).map((item) => ({ item, bullets: item.bullets || [] })),
  ];
  const holder = locked
    ? { item: locked.item, bullets: [locked.bullet] }
    : candidates.find((entry) => entry.bullets.some((bullet) => bullet.id && bullet.id.includes('scale')))
      || candidates.find((entry) => entry.bullets.length)
      || null;
  if (!holder) return null;
  const bullet = locked
    ? locked.bullet
    : holder.bullets.find((entry) => entry.id && entry.id.includes('scale')) || holder.bullets[0];
  const currentText = String(bullet.text || '');
  const base = String(editingBase || currentText);
  const factValue = parseJson(fact.proposed_value_json, {});
  const value = String(factValue.value || text || '').trim();
  const suggestion = value && base.includes(value)
    ? base.replace(/（待确认）|\(待确认\)|【待确认】|，待确认/g, '').replace(/\s{2,}/g, ' ').trim()
    : `${base.replace(/。$/, '')}，${text}。`;
  return {
    scope_type: 'RESUME_BLOCK',
    scope_id: bullet.id,
    scope_label: bullet.scope_name || '@简历 · 具体内容',
    original: currentText,
    current_text: currentText,
    editing_base: base,
    suggestion,
    note: `已把你确认的「${text}」补进这段内容，其他表述未改动。`,
    affected_count: 1,
    fact_id: fact.id,
    task_id: taskId || null,
    parent_proposal_id: parentProposalId || null,
    dependency_fact_ids: [fact.id],
    base_target_hash: textHash(currentText),
    base_draft_revision: draft.revision,
    profile_revision: profileRevision || null,
    job_id: job ? job.id : null,
    job_revision: job ? job.revision : null,
  };
}

module.exports = { routes, buildRewriteProposal, buildRewriteProposalForFact, persistConfirmedFact };
