'use strict';
const R = require('../../resume-dom');

const FACTS = ['林舟', '13900004827', 'linzhou@example.com', '远山科技', '2022', '2025',
  '12', '3', '25%', '江原大学', '信息管理', '本科', '青禾软件', '2020', '2022', '18%'];
function document(layout = 'sidebar', reference = false) {
  const p = (id, text, tag = 'p') => ({ id, type: 'element', tag, editable: true, text,
    semantic: { kind: tag === 'h1' ? 'document_title' : tag === 'h2' ? 'section_title' : 'paragraph' },
    style: { margin: '0 0 10px', 'font-size': tag === 'h1' ? '28px' : tag === 'h2' ? '18px' : '14px',
      'line-height': '1.6', ...(tag === 'h2' ? { background: '#17365D', color: '#FFFFFF', padding: '4px 10px' } : {}) } });
  const section = (id, title, children) => ({ id, type: 'element', tag: 'section',
    semantic: { kind: 'section' }, style: { 'margin-bottom': '18px', 'min-width': '0' },
    children: [p(`${id}-title`, title, 'h2'), ...children] });
  const entry = (id, title, text) => ({ id, type: 'element', tag: 'section',
    semantic: { kind: 'section' }, children: [p(`${id}-name`, title), p(`${id}-body`, text)] });
  const name = p('name', reference ? '顾明（参考图示例，非本人）' : '林舟', 'h1');
  const contact = p('contact', reference ? '参考图电话：18812345678' : '13900004827 · linzhou@example.com');
  const role = p('role', '求职目标：企业服务产品经理');
  const education = section('education', '教育背景', [
    p('education-body', reference ? '示例北岭大学 · 数学博士 · 2012—2018' : '2016—2020 · 江原大学 · 信息管理 · 本科')]);
  const skills = section('skills', '专业技能', [
    p('skills-body', '需求访谈、流程设计、SQL 数据分析、跨团队协作、产品路线图')]);
  const overview = section('overview', '职业概况', [
    p('overview-body', '有企业服务产品规划与交付经历，负责需求研究、方案设计及团队协调；推进3个项目、协调12人团队，将办理时长降低25%。')]);
  const work = section('work', '工作经历', [
    entry('work-1', '2022—2025 · 远山科技 · 产品经理',
      '负责企业服务平台需求研究、产品规划、版本交付和客户访谈。协调12人研发与运营团队，交付3个项目，将办理时长降低25%。'),
    entry('work-2', '2020—2022 · 青禾软件 · 产品助理',
      '整理客户反馈，参与需求评审和验收，优化新用户操作指引，将首次使用流失率降低18%。')]);
  const projects = section('projects', '项目经历', [
    entry('project-1', '2024 · 在线办理平台',
      '通过客户访谈发现重复填报问题，完成流程梳理、原型设计及跨团队交付，将办理时长降低25%。'),
    entry('project-2', '2021 · 新用户引导改版',
      '整理用户反馈与使用数据，协助设计分步引导并推进验收，将首次使用流失率降低18%。')]);
  const children = layout === 'single'
    ? [name, contact, role, education, work, projects, skills, overview]
    : [{ id: 'sidebar', type: 'element', tag: 'aside', semantic: { kind: 'section' },
      style: { width: '238px', 'flex-shrink': '0', padding: '28px 18px', background: '#edf2f7',
        'box-sizing': 'border-box' }, children: [name, contact, role, education, skills] },
    { id: 'main', type: 'element', tag: 'main', semantic: { kind: 'section' },
      style: { flex: '1', 'min-width': '0', padding: '28px 26px' }, children: [overview, projects, work] }];
  return R.toResumeDocument({ schema_version: R.RESUME_DOCUMENT_VERSION, root: {
    id: 'resume-root', type: 'element', tag: 'article', semantic: { kind: 'document' },
    style: { width: '794px', 'min-height': '1123px', 'box-sizing': 'border-box', margin: '0',
      background: '#FFFFFF', color: '#18212B', 'font-family': 'Arial, "Noto Sans CJK SC", sans-serif',
      'font-size': '14px', display: layout === 'single' ? 'block' : 'flex',
      padding: layout === 'single' ? '36px 42px' : '0' }, children,
  } });
}

// Executed inside Chromium against the real renderer, both preview and canvas.
// Diagnostics, not intent rules: do not change the generated result to pass.
function geometry(selector) {
  const root = document.querySelector(selector);
  const bounds = root.getBoundingClientRect();
  const nodes = [...root.querySelectorAll('[data-node-id]')].filter(e =>
    !e.closest('[data-editor-only]'));
  const editable = nodes.filter(e => e.dataset.resumeEditable === 'true');
  // Read-only previews have no editor markers. Inspect visible text carriers,
  // including div + text-run output, instead of mistaking markers for content.
  const textBlocks = nodes.filter(e => e.textContent.trim() && [...e.children].every(child =>
    ['SPAN', 'B', 'STRONG', 'EM', 'I', 'U', 'BR', 'A', 'SMALL', 'TIME'].includes(child.tagName))
    && !e.parentElement.closest('[data-node-id]')?.matches('span,b,strong,em,i,u,a,small,time'));
  const rect = e => { const r = e.getBoundingClientRect(); return {
    id: e.dataset.nodeId, text: e.textContent, x: r.left - bounds.left,
    y: r.top - bounds.top, width: r.width, height: r.height,
    color: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor,
  }; };
  const overlaps = [];
  textBlocks.forEach((a, i) => textBlocks.slice(i + 1).forEach(b => {
    if (a.contains(b) || b.contains(a)) return;
    const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
    if (Math.min(x.right, y.right) - Math.max(x.left, y.left) > 2
      && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 2) {
      overlaps.push([a.dataset.nodeId, b.dataset.nodeId]);
    }
  }));
  return { width: bounds.width, height: bounds.height, editable: editable.map(rect),
    overlaps,
    text_blocks: textBlocks.map(rect),
    headings: textBlocks.filter(e => /^H[1-6]$/.test(e.tagName)
      || /^(教育背景|工作经历|项目经历|专业技能|职业概况)$/.test(e.textContent.trim())).map(rect),
    uneditable: textBlocks.filter(e => !e.closest('[data-resume-editable=true]')).map(rect),
    narrow: textBlocks.filter(e => e.textContent.length > 45 && e.getBoundingClientRect().width < 110).map(rect),
    overflow: textBlocks.filter(e => {
      const r = e.getBoundingClientRect();
      return r.left < bounds.left - 2 || r.right > bounds.right + 2
        || (e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 3)
        || (e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 3);
    }).map(rect),
    nested_editable: editable.filter(e => e.querySelector('[data-resume-editable=true]')).map(rect),
  };
}
module.exports = { document, FACTS, geometry };
