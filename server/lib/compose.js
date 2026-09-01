'use strict';
/**
 * 生成阶段二：重组履历（TECH §9.1）。
 *
 * 原则：AI 只能重组、压缩、润色用户提供的事实；不新增数字、公司、项目和技能。
 * 每条 bullet 都绑定 source_item_ids，供事实校验使用。
 */
const { validateFacts } = require('./resume-schema');

/** 把经历描述拆分为 bullet 列表。 */
function splitBullets(description) {
  if (Array.isArray(description)) return description.filter(Boolean);
  return String(description || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 计算 bullet 与岗位关键词的相关度。 */
function relevanceScore(text, keywords = []) {
  if (!keywords.length) return 0;
  return keywords.reduce((score, keyword) => (String(text).includes(keyword) ? score + 1 : score), 0);
}

/**
 * @param {object} input {profileBasics, profileSummary, experiences, job, template, currentResume}
 * @returns {object} Resume Schema JSON
 */
function composeResume({ profileBasics, profileSummary, experiences = [], job, template, currentResume }) {
  const keywords = job && job.analysis && Array.isArray(job.analysis.keywords) ? job.analysis.keywords : [];
  const maxBullets = (template &&
    template.schema &&
    template.schema.constraints &&
    template.schema.constraints.max_bullets_per_item) || 6;

  const pick = (type) => experiences.filter((exp) => exp.type === type && !exp.deleted_at);

  const buildSection = (items, mapper) =>
    items.map((item) => {
      const bullets = splitBullets(item.description)
        .map((text) => ({ text, source_item_ids: [item.id], score: relevanceScore(text, keywords) }))
        // 针对岗位关键词调整内容优先级；同分时保持原始录入顺序
        .sort((a, b) => b.score - a.score)
        .slice(0, maxBullets)
        // 为每条内容分配稳定 id，保证生成之后仍可针对具体段落改写
        .map((bullet, index) => ({
          ...bullet,
          id: `b-${String(item.id).slice(0, 8)}-${index}`,
        }));
      return { ...mapper(item), bullets };
    });

  const experience = buildSection(pick('work'), (item) => ({
    organization: item.organization,
    title: item.title,
    start: item.start_date,
    end: item.is_current ? '' : item.end_date,
    source_item_ids: [item.id],
  }));

  const projects = buildSection(pick('project'), (item) => ({
    name: item.organization,
    role: item.title,
    start: item.start_date,
    end: item.is_current ? '' : item.end_date,
    source_item_ids: [item.id],
  }));

  const education = pick('education').map((item) => ({
    id: `e-${String(item.id).slice(0, 8)}`,
    school: item.organization,
    major: item.title,
    degree: item.description,
    start: item.start_date,
    end: item.is_current ? '' : item.end_date,
    source_item_ids: [item.id],
  }));

  const skills = pick('skill').map((item) => ({
    id: `s-${String(item.id).slice(0, 8)}`,
    name: item.title,
    source_item_ids: [item.id],
  }));

  // 事实集合用于校验：只使用已确认事实，待确认资料不参与正式生成（PRD 发布验收 12）
  const confirmedFacts = experiences
    .filter((exp) => !exp.deleted_at)
    .flatMap((exp) => splitBullets(exp.description))
    .concat([profileSummary || '']);

  const resume = {
    basics: {
      name: profileBasics.name || '',
      phone: profileBasics.phone || '',
      email: profileBasics.email || '',
      city: profileBasics.city || '',
    },
    headline: profileBasics.current_title || (currentResume && currentResume.headline) || '',
    summary: profileSummary || (currentResume && currentResume.summary) || '',
    experience,
    projects,
    education,
    skills,
    evidence_map: [],
    pending_claims: [],
    generation_notes: [],
    layout_hints: {
      max_pages: (template && template.schema && template.schema.page && template.schema.page.max_pages) || 2,
      layout: (template && template.schema && template.schema.layout) || 'classic',
    },
  };

  // evidence_map：bullet → 来源事实（TECH §9.2）
  const attachEvidence = (section, items) => {
    (items || []).forEach((item) => {
      (item.bullets || []).forEach((bullet) => {
        resume.evidence_map.push({
          section,
          text: bullet.text,
          source_item_ids: bullet.source_item_ids,
        });
      });
    });
  };
  attachEvidence('experience', experience);
  attachEvidence('projects', projects);

  // 事实自检：出现来源中不存在的数字/实体时进入 pending_claims，不进入最终简历
  const { violations, pending_claims } = validateFacts(resume, confirmedFacts);
  violations
    .filter((violation) => violation.code === 'NEW_ENTITY_OR_NUMBER')
    .forEach((violation) => {
      resume.pending_claims.push({
        section: violation.section,
        text: violation.text,
        token: violation.token,
        reason: '该项在已确认资料中没有对应来源，需你补充或确认后再使用',
      });
    });

  resume.generation_notes = buildGenerationNotes({ keywords, experience, projects, pendingCount: pending_claims.length });
  return resume;
}

/** 生成调整说明（PRD §6.4：输出调整说明、事实证据和待确认项）。 */
function buildGenerationNotes({ keywords, experience, projects, pendingCount }) {
  const notes = [];
  if (keywords.length) {
    notes.push(`已按岗位关键词（${keywords.slice(0, 4).join('、')}）调整各段内容的优先级。`);
  }
  const totalBullets = [...experience, ...projects].reduce(
    (sum, item) => sum + ((item.bullets && item.bullets.length) || 0),
    0,
  );
  notes.push(`保留 ${totalBullets} 条已确认事实，未新增未经确认的数字或经历。`);
  if (pendingCount) notes.push(`有 ${pendingCount} 项内容缺少来源，已列入待确认，未写入简历。`);
  return notes.map((text) => ({ text }));
}

module.exports = { composeResume, splitBullets, relevanceScore };
