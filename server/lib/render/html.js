'use strict';
/**
 * HTML 渲染产物：Resume JSON + Template → 打印用 HTML 字符串。
 * 仅作为生成产物（artifact）存入对象存储供预览与缩略图使用，
 * 不是产品页面（产品页面统一维护在 index.html）。
 */
const escape = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function periodText(item) {
  const start = item.start || item.start_date || '';
  const end = item.end || item.end_date || '';
  if (!start && !end) return '';
  return `${start} — ${end || '至今'}`;
}

function bulletsHtml(bullets = []) {
  if (!bullets.length) return '';
  return `<ul>${bullets
    .map((bullet) => `<li>${escape(typeof bullet === 'string' ? bullet : bullet.text)}</li>`)
    .join('')}</ul>`;
}

function renderHtml({ resume, template }) {
  const schema = template.schema || template;
  const titles = (schema.section_rules && schema.section_rules.titles) || {};
  const order = (schema.section_rules && schema.section_rules.order) || [];
  const accent = (schema.typography && schema.typography.accent) || '#1d1d1f';

  const blocks = [];
  order.forEach((key) => {
    if (key === 'summary' && resume.summary) {
      blocks.push(`<h2>${escape(titles.summary || '个人优势')}</h2><p>${escape(resume.summary)}</p>`);
    }
    if (key === 'experience' && (resume.experience || []).length) {
      blocks.push(`<h2>${escape(titles.experience || '工作经历')}</h2>`);
      resume.experience.forEach((item) => {
        blocks.push(
          `<div class="row"><strong>${escape(item.organization)}</strong><span>${escape(item.title || '')}</span><time>${escape(periodText(item))}</time></div>${bulletsHtml(item.bullets)}`,
        );
      });
    }
    if (key === 'projects' && (resume.projects || []).length) {
      blocks.push(`<h2>${escape(titles.projects || '项目经历')}</h2>`);
      resume.projects.forEach((item) => {
        blocks.push(
          `<div class="row"><strong>${escape(item.name || item.organization)}</strong><span>${escape(item.role || item.title || '')}</span><time>${escape(periodText(item))}</time></div>${bulletsHtml(item.bullets)}`,
        );
      });
    }
    if (key === 'education' && (resume.education || []).length) {
      blocks.push(`<h2>${escape(titles.education || '教育经历')}</h2>`);
      resume.education.forEach((item) => {
        blocks.push(
          `<div class="row"><strong>${escape(item.school || item.organization)}</strong><span>${escape([item.major, item.degree].filter(Boolean).join(' · '))}</span><time>${escape(periodText(item))}</time></div>`,
        );
      });
    }
    if (key === 'skills') {
      const skills = (resume.skills || []).map((skill) => (typeof skill === 'string' ? skill : skill.name));
      if (skills.length) {
        blocks.push(`<h2>${escape(titles.skills || '专业技能')}</h2><p>${escape(skills.join('　'))}</p>`);
      }
    }
  });

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(resume.basics.name)} · 简历</title>
<style>@page{size:A4;margin:18mm}body{font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;color:#414448;font-size:10.5pt;line-height:1.75}h1{font-size:22pt;letter-spacing:2px;margin:0}h2{font-size:12pt;color:${accent};border-bottom:1px solid #d1d1d6;padding-bottom:4pt;margin:18pt 0 8pt}.contact{color:#5f6265;font-size:9pt;margin:6pt 0 14pt;border-bottom:1px solid ${accent};padding-bottom:10pt}.row{margin-top:10pt;font-weight:700;font-size:10pt}.row span{margin-left:10pt;font-weight:400;color:#4d5155}.row time{float:right;font-weight:400;color:#73767a;font-size:9pt}ul{margin:6pt 0;padding-left:16px}li{white-space:pre-line}</style>
</head><body><h1>${escape(resume.basics.name)}</h1><div class="contact">${escape(
    [resume.headline, resume.basics.city, resume.basics.phone, resume.basics.email].filter(Boolean).join('　|　'),
  )}</div>${blocks.join('')}</body></html>`;
}

module.exports = { renderHtml };
