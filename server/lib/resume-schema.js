'use strict';
/**
 * Resume Schema 校验、事实校验与完整度计算。
 * 对应 TECH §9.2（事实约束）、§9.3（结构化输出）、§11.3（验证）。
 */
const RESUME_SCHEMA_VERSION = 'resume-schema-v1';

/** Resume Schema 主要字段（TECH §9.3）。 */
const RESUME_FIELDS = [
  'basics',
  'headline',
  'summary',
  'experience',
  'projects',
  'education',
  'skills',
  'evidence_map',
  'pending_claims',
  'generation_notes',
  'layout_hints',
];

function validateResumeJson(resume) {
  const errors = [];
  if (!resume || typeof resume !== 'object') return { valid: false, errors: ['简历不是对象'] };
  for (const field of RESUME_FIELDS) {
    if (!(field in resume)) errors.push(`缺少字段 ${field}`);
  }
  if (resume.experience !== undefined && !Array.isArray(resume.experience))
    errors.push('experience 必须是数组');
  if (resume.projects !== undefined && !Array.isArray(resume.projects))
    errors.push('projects 必须是数组');
  if (resume.education !== undefined && !Array.isArray(resume.education))
    errors.push('education 必须是数组');
  if (resume.evidence_map !== undefined && !Array.isArray(resume.evidence_map))
    errors.push('evidence_map 必须是数组');
  return { valid: errors.length === 0, errors };
}

/** 从文本中提取数字与组织名等可用于事实比对的关键 token。 */
function keyTokens(text) {
  const result = new Set();
  const numeric = String(text).match(
    /\d[\d,.]*\s*(?:[+＋]\s*)?(?:家|人|位|个|万|亿|%|％|倍|次|轮|条|款|台|套|场|篇|年|月)/g,
  );
  (numeric || []).forEach((token) => result.add(token.replace(/\s+/g, '').replace(/＋/g, '+')));
  return result;
}

function collectFactTokens(profileFacts) {
  const tokens = new Set();
  (profileFacts || []).forEach((fact) => keyTokens(fact).forEach((token) => tokens.add(token)));
  return tokens;
}

/**
 * 事实校验：生成的每条 bullet 必须返回 source_item_ids；
 * 新出现的实体或数字触发 fact_violation（TECH §9.2）。
 */
function validateFacts(resumeJson, profileFacts = []) {
  const known = collectFactTokens(profileFacts);
  const violations = [];
  const pendingClaims = [];

  const checkBullets = (items, section) => {
    (items || []).forEach((item, index) => {
      const bullets = item.bullets || [];
      bullets.forEach((bullet, bulletIndex) => {
        const text = typeof bullet === 'string' ? bullet : bullet.text;
        if (!text) return;
        const sourceIds = typeof bullet === 'object' ? bullet.source_item_ids : item.source_item_ids;
        if (!sourceIds || !sourceIds.length) {
          violations.push({
            section,
            index,
            bulletIndex,
            text,
            code: 'MISSING_SOURCE',
            message: '内容缺少事实来源',
          });
        }
        const tokens = keyTokens(text);
        tokens.forEach((token) => {
          if (!known.has(token)) {
            violations.push({
              section,
              index,
              bulletIndex,
              token,
              text,
              code: 'NEW_ENTITY_OR_NUMBER',
              message: `出现来源中不存在的数字或实体：${token}`,
            });
          }
        });
      });
    });
  };

  checkBullets(resumeJson.experience, 'experience');
  checkBullets(resumeJson.projects, 'projects');

  // 无法验证的改写进入 pending_claims，不进入最终简历
  (resumeJson.pending_claims || []).forEach((claim) => pendingClaims.push(claim));
  return { violations, pending_claims: pendingClaims, ok: violations.length === 0 };
}

/**
 * 生成前置条件（PRD §6.4）：
 * 姓名、联系方式、至少一段工作/项目经历和一段教育经历；模板可用；岗位已确认。
 */
function computeReadiness({ profileBasics, experiences, template, job }) {
  const missing = [];
  if (!profileBasics || !profileBasics.name) missing.push('姓名');
  const hasContact = Boolean(profileBasics && (profileBasics.phone || profileBasics.email));
  if (!hasContact) missing.push('手机号或邮箱');
  const hasWorkOrProject = (experiences || []).some(
    (exp) => (exp.type === 'work' || exp.type === 'project') && !exp.deleted_at,
  );
  if (!hasWorkOrProject) missing.push('至少一段工作或项目经历');
  const hasEducation = (experiences || []).some((exp) => exp.type === 'education' && !exp.deleted_at);
  if (!hasEducation) missing.push('一段教育经历');
  if (!template) missing.push('可用的简历模板');
  else if (template.status && template.status !== 'ready') missing.push('模板仍在解析中');
  if (!job) missing.push('目标岗位信息');
  else if (job.status !== 'confirmed') missing.push('岗位文本确认');

  const weights = { 姓名: 20, '手机号或邮箱': 15, '至少一段工作或项目经历': 25, '一段教育经历': 20, '可用的简历模板': 10, '目标岗位信息': 10 };
  const score = Math.min(
    100,
    Math.round(
      Object.entries(weights).reduce((sum, [key, value]) => sum + (missing.includes(key) ? 0 : value), 0),
    ),
  );
  return { complete: missing.length === 0, missing, score };
}

/** 资料完整度（左栏健康度展示，PRD §6.1 验收：完整度实时计算）。 */
function computeProfileCompleteness(profileBasics, experiences) {
  const checks = [
    { key: '基础信息', ok: Boolean(profileBasics && profileBasics.name && (profileBasics.phone || profileBasics.email)) },
    { key: '个人优势', ok: Boolean(profileBasics && profileBasics.summary) },
    { key: '工作经历', ok: (experiences || []).some((e) => e.type === 'work' && !e.deleted_at) },
    { key: '教育经历', ok: (experiences || []).some((e) => e.type === 'education' && !e.deleted_at) },
    { key: '技能证书', ok: (experiences || []).some((e) => e.type === 'skill' && !e.deleted_at) },
  ];
  const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
  return { score, checks };
}

module.exports = {
  RESUME_SCHEMA_VERSION,
  RESUME_FIELDS,
  validateResumeJson,
  validateFacts,
  computeReadiness,
  computeProfileCompleteness,
  keyTokens,
};
