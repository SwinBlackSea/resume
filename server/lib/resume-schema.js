'use strict';
/**
 * Resume Schema 校验、内容安全校验与完整度计算。
 * 不保存内容来源、证据映射或资料到正文的派生关系。
 */
const ResumeDom = require('../../resume-dom');

const RESUME_SCHEMA_VERSION = 'resume-schema-v3';

const RESUME_FIELDS = [
  'basics',
  'headline',
  'summary',
  'experience',
  'projects',
  'education',
  'skills',
  'generation_notes',
  'validation_issues',
  'layout_hints',
];

function validateResumeJson(resume) {
  const errors = [];
  if (!resume || typeof resume !== 'object') return { valid: false, errors: ['简历不是对象'] };
  const hasDynamicDocument = Boolean(resume.dom_document && resume.dom_document.root);
  if (!hasDynamicDocument) {
    for (const field of RESUME_FIELDS) {
      if (!(field in resume)) errors.push(`缺少字段 ${field}`);
    }
  }
  for (const field of ['experience', 'projects', 'education', 'skills', 'generation_notes', 'validation_issues']) {
    if (resume[field] !== undefined && !Array.isArray(resume[field])) errors.push(`${field} 必须是数组`);
  }
  try {
    ResumeDom.ensureDocument(resume);
  } catch (error) {
    errors.push(`DOM 文档无效：${error.message}`);
  }
  return { valid: errors.length === 0, errors };
}

function keyTokens(text) {
  const result = new Set();
  const numeric = String(text).match(
    /\d[\d,.]*\s*(?:[+＋]\s*)?(?:家|人|位|个|万|亿|%|％|倍|次|轮|条|款|台|套|场|篇|年|月)/g,
  );
  (numeric || []).forEach((token) => result.add(token.replace(/\s+/g, '').replace(/＋/g, '+')));
  return result;
}

function collectUserTokens(texts) {
  const tokens = new Set();
  (texts || []).forEach((text) => keyTokens(text).forEach((token) => tokens.add(token)));
  return tokens;
}

/**
 * 只检查结果是否出现用户没有提供的可核验数字，不追踪每句话来自哪里。
 */
function validateContentSafety(resumeJson, userProvidedTexts = []) {
  const known = collectUserTokens(userProvidedTexts);
  const violations = [];
  let text = '';
  try {
    text = ResumeDom.plainText(ResumeDom.ensureDocument(resumeJson));
  } catch (_) {
    text = JSON.stringify(resumeJson || {});
  }
  keyTokens(text).forEach((token) => {
    if (!known.has(token)) {
      violations.push({
        section: 'document',
        token,
        text,
        code: 'UNSUPPORTED_ASSERTION',
        message: `出现用户没有提供的数据：${token}`,
      });
    }
  });
  return { violations, ok: violations.length === 0 };
}

function computeReadiness({ profileBasics, experiences, template, job }) {
  const missing = [];
  if (!profileBasics || !profileBasics.name) missing.push('姓名');
  if (!profileBasics || !(profileBasics.phone || profileBasics.email)) missing.push('手机号或邮箱');
  if (!(experiences || []).some((item) => ['work', 'project'].includes(item.type) && !item.deleted_at))
    missing.push('至少一段工作或项目经历');
  if (!(experiences || []).some((item) => item.type === 'education' && !item.deleted_at))
    missing.push('一段教育经历');
  if (!template) missing.push('可用的简历模板');
  else if (template.status && template.status !== 'ready') missing.push('模板仍在解析中');
  if (!job) missing.push('目标岗位信息');
  else if (job.status !== 'confirmed') missing.push('岗位文本确认');
  const weights = { 姓名: 20, '手机号或邮箱': 15, '至少一段工作或项目经历': 25, '一段教育经历': 20, '可用的简历模板': 10, '目标岗位信息': 10 };
  const score = Math.min(100, Math.round(
    Object.entries(weights).reduce((sum, [key, value]) => sum + (missing.includes(key) ? 0 : value), 0),
  ));
  return { complete: missing.length === 0, missing, score };
}

function computeProfileCompleteness(profileBasics, experiences) {
  const checks = [
    { key: '基础信息', ok: Boolean(profileBasics && profileBasics.name && (profileBasics.phone || profileBasics.email)) },
    { key: '个人优势', ok: Boolean(profileBasics && profileBasics.summary) },
    { key: '工作经历', ok: (experiences || []).some((item) => item.type === 'work' && !item.deleted_at) },
    { key: '教育经历', ok: (experiences || []).some((item) => item.type === 'education' && !item.deleted_at) },
    { key: '技能证书', ok: (experiences || []).some((item) => item.type === 'skill' && !item.deleted_at) },
  ];
  return { score: Math.round((checks.filter((item) => item.ok).length / checks.length) * 100), checks };
}

module.exports = {
  RESUME_SCHEMA_VERSION,
  RESUME_FIELDS,
  validateResumeJson,
  validateContentSafety,
  computeReadiness,
  computeProfileCompleteness,
  keyTokens,
};
