'use strict';
/**
 * 根据用户资料和岗位信息重组简历。
 *
 * 资料、对话和当前简历是平级上下文。输出只保存最终内容与必要的校验提示，
 * 不建立资料到正文的绑定、来源引用或派生关系。
 */
const { validateContentSafety } = require('./resume-schema');
const ResumeDom = require('../../resume-dom');

function splitBullets(description) {
  if (Array.isArray(description)) return description.filter(Boolean);
  return String(description || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function relevanceScore(text, keywords = []) {
  if (!keywords.length) return 0;
  return keywords.reduce((score, keyword) => (String(text).includes(keyword) ? score + 1 : score), 0);
}

function composeResume({ profileBasics, profileSummary, experiences = [], job, template, currentResume }) {
  const keywords = job && job.analysis && Array.isArray(job.analysis.keywords) ? job.analysis.keywords : [];
  const maxBullets = (template &&
    template.schema &&
    template.schema.constraints &&
    template.schema.constraints.max_bullets_per_item) || 6;
  const pick = (type) => experiences.filter((item) => item.type === type && !item.deleted_at);
  const buildSection = (items, mapper) =>
    items.map((item) => {
      const bullets = splitBullets(item.description)
        .map((text) => ({ text, score: relevanceScore(text, keywords) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxBullets)
        .map((bullet, index) => ({
          id: `b-${String(item.id)}-${index}`,
          text: bullet.text,
          score: bullet.score,
        }));
      return { ...mapper(item), bullets };
    });

  const experience = buildSection(pick('work'), (item) => ({
    id: `w-${String(item.id)}`,
    organization: item.organization,
    title: item.title,
    start: item.start_date,
    end: item.is_current ? '' : item.end_date,
  }));
  const projects = buildSection(pick('project'), (item) => ({
    id: `p-${String(item.id)}`,
    name: item.organization,
    role: item.title,
    start: item.start_date,
    end: item.is_current ? '' : item.end_date,
  }));
  const education = pick('education').map((item) => ({
    id: `e-${String(item.id)}`,
    school: item.organization,
    major: item.title,
    degree: item.description,
    start: item.start_date,
    end: item.is_current ? '' : item.end_date,
  }));
  const skills = pick('skill').map((item) => ({
    id: `s-${String(item.id)}`,
    name: item.title,
  }));

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
    generation_notes: [],
    validation_issues: [],
    layout_hints: {
      max_pages: (template && template.schema && template.schema.page && template.schema.page.max_pages) || 2,
      layout: (template && template.schema && template.schema.layout) || 'classic',
    },
  };

  const userProvidedText = experiences
    .filter((item) => !item.deleted_at)
    .flatMap((item) => splitBullets(item.description))
    .concat([profileSummary || '', JSON.stringify(profileBasics || {})]);
  resume.validation_issues = validateContentSafety(resume, userProvidedText).violations;
  resume.generation_notes = buildGenerationNotes({ keywords, experience, projects });
  return ResumeDom.attachDocument(resume);
}

function buildGenerationNotes({ keywords, experience, projects }) {
  const notes = [];
  if (keywords.length) {
    notes.push(`已按岗位关键词（${keywords.slice(0, 4).join('、')}）调整内容优先级。`);
  }
  const totalBullets = [...experience, ...projects].reduce(
    (sum, item) => sum + ((item.bullets && item.bullets.length) || 0),
    0,
  );
  notes.push(`已整理 ${totalBullets} 条经历内容，未自动补写用户没有提供的业绩。`);
  return notes.map((text) => ({ text }));
}

module.exports = { composeResume, splitBullets, relevanceScore };
