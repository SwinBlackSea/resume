'use strict';

// Fictional evaluation data only. Intent checks here are test assertions,
// never production keyword routing or transformations of user instructions.
const assert = require('node:assert/strict');
const sharp = require('sharp');
const ResumeDom = require('../../resume-dom');
const harness = require('../lib/resume-harness');
const { hashJson } = require('../lib/util');
const { evaluateChange } = require('../lib/resume-change-policy');

function fictionalDocument() {
  const paragraph = (id, text, tag = 'p') => ({
    id, type: 'element', tag, text, editable: true,
    semantic: { kind: /^h/.test(tag) ? 'section_title' : 'paragraph' },
    style: { color: '#222222', 'font-size': tag === 'h2' ? '16px' : '12px' },
  });
  const section = (id, title, text) => ({
    id, type: 'element', tag: 'section', semantic: { kind: 'section' },
    children: [paragraph(`${id}-title`, title, 'h2'), paragraph(`${id}-body`, text)],
  });
  return ResumeDom.toResumeDocument({
    schema_version: 'resume-document-v3',
    root: { id: 'qa-root', type: 'element', tag: 'article', children: [
      paragraph('qa-name', '林舟', 'h1'),
      paragraph('qa-role', 'Product Manager'),
      section('summary', '职业概况',
        '负责产品需求研究、方案设计以及跨团队沟通协调工作。在实际工作中，持续开展需求调研和方案设计，积极推进项目执行落地，负责3个项目，协调12人团队，将办理时长降低25%。'),
      section('work', 'Work Experience',
        '2022—2025年，任职于虚构远山科技，负责Product planning和客户需求分析，协调12人团队，交付3个项目，将办理时长降低25%。'),
      section('projects', '项目经历',
        '2024年负责在线办理平台的流程优化，通过需求调研、流程梳理、方案设计和跨团队推进，使办理时长降低25%。'),
      section('education', '教育经历', '2018—2022年，就读于虚构江原大学，信息管理专业，本科学历。'),
    ] },
  });
}

const CASES = [
  { id: 'translate', text: '中英混杂？全部改成中文。只翻译文字，保留结构、样式、数字和经历事实。' },
  { id: 'translate-image-history', imageHistory: true,
    text: '中英混杂？全部改成中文。沿用现有岗位，只翻译文字，不修改排版和经历事实。' },
  { id: 'shorten', text: '职业概况太长了，精简这部分，保留3个项目、12人团队、降低25%的成果，不改其他模块。' },
  { id: 'followup', follows: 'shorten', text: '还是太多了，继续精简职业概况，刚才要求保留的数字和成果仍然保留。' },
  { id: 'style', text: '将所有模块标题的文字颜色改成#17365D、字号18px，正文文字和结构不变。' },
  { id: 'image-style', image: true,
    text: '参考截图的深蓝色标题效果，把模块标题颜色设为#17365D、字号18px。只调整这两项，不改正文内容和结构。' },
  { id: 'reorder', text: '将项目经历放到工作经历之前，其他模块相对顺序不变。保留所有文字和样式。' },
  { id: 'new-job', text: '提供一个新岗位：虚构星河公司的高级产品经理，负责企业服务需求调研、产品规划及跨团队交付。请给出设为当前岗位的建议，不修改简历。' },
  { id: 'discussion', text: '只分析这份简历有哪些可以改进的地方，暂时不要生成修改建议。' },
];

async function fixtureImage() {
  return (await sharp(Buffer.from(
    '<svg width="480" height="240"><rect width="480" height="240" fill="white"/>'
    + '<path d="M25 35H220M25 125H230" stroke="#17365d" stroke-width="18"/>'
    + '<path d="M25 68H440M25 88H405M25 158H430M25 178H420" stroke="#666" stroke-width="6"/></svg>',
  )).png().toBuffer()).toString('base64');
}

function caseInput(scenario, { document, image, previous, run = 1 }) {
  const resume = { content: document, task_base_content: document, revision: 1,
    ...(previous ? { proposal_content: previous.document, previous_proposal_id: 'qa-previous' } : {}) };
  return harness.buildHarnessInput({
    text: scenario.text,
    messageId: `qa-${run}-${scenario.id}`,
    scope: { type: 'RESUME_DOCUMENT', id: null },
    task: { id: `qa-${run}-${scenario.follows || scenario.id}`,
      goal: scenario.follows ? CASES.find((item) => item.id === scenario.follows).text : scenario.text,
      state: {} },
    resume, profile: {},
    job: { id: 'qa-job', title: '产品经理', company: '虚构远山科技',
      confirmed_text: '负责需求调研、产品规划和团队协作。' },
    conversationMessages: previous ? [
      { role: 'user', content: CASES.find((item) => item.id === scenario.follows).text },
      { role: 'assistant', content: previous.message },
    ] : scenario.imageHistory ? [
      { role: 'user', content: '这张截图作为后续排版参考，目前沿用现有岗位。' },
      { role: 'assistant', content: '可以继续告诉我简历的修改要求。' },
    ] : [],
    attachments: scenario.image ? [{ mime_type: 'image/png', content_base64: image }] : [],
    imageHistory: scenario.imageHistory ? [{ text: '排版参考截图',
      attachments: [{ mime_type: 'image/png', content_base64: image }] }] : [],
  });
}

function evaluateCase(scenario, response, document, previous) {
  if (scenario.id === 'discussion') {
    assert.equal(response.result_type, 'MESSAGE', '讨论不应生成修改建议');
    assert.equal(response.actions.length, 0);
    assert.ok(response.content.trim());
    return null;
  }
  assert.equal(response.result_type, 'PROPOSAL', '明确修改请求应直接提供建议');
  if (scenario.id === 'new-job') {
    assert.equal(response.actions.length, 1, '提供岗位不应顺带修改简历或资料');
    const action = response.actions[0];
    assert.equal(action.type, 'JOB_SET_CURRENT_PROPOSAL');
    assert.match(action.payload.title, /产品经理/);
    assert.match(action.payload.company, /星河/);
    assert.match(action.payload.confirmed_text, /需求|调研/);
    return null;
  }
  assert.equal(response.actions.length, 1, '修改简历不应重复生成岗位或资料动作');
  const action = response.actions[0];
  assert.equal(action.type, 'RESUME_REWRITE_PROPOSAL');
  const target = action.payload.proposal.target_resume_document;
  assert.ok(target, '应形成可执行完整目标');
  const base = previous?.document || document;
  const text = ResumeDom.plainText(target);
  const styleOnly = ['style', 'image-style'].includes(scenario.id);
  const reorderOnly = scenario.id === 'reorder';
  const expected = { content: styleOnly || reorderOnly ? 'preserve' : 'modify',
    structure: reorderOnly ? 'modify' : 'preserve', style: styleOnly ? 'modify' : 'preserve',
    content_order: reorderOnly ? 'reorder' : 'preserve', allowed_region_ids: ['qa-root'] };
  assert.equal(evaluateChange(base, target, expected).errors.length, 0,
    '结果改动超出了测试指令范围（独立于模型自己声明的约束）');
  if (scenario.id.startsWith('translate')) {
    assert.doesNotMatch(text, /[a-z]{3,}/i, '仍存在应翻译的英文');
    for (const fact of ['林舟', '2022', '2025', '12', '3', '25%']) assert.ok(text.includes(fact), `遗漏事实：${fact}`);
  } else if (['shorten', 'followup'].includes(scenario.id)) {
    const before = ResumeDom.findNode(base, 'summary');
    const after = ResumeDom.findNode(target, 'summary');
    assert.ok(after && before, '职业概况模块应保留');
    const summary = ResumeDom.nodeText(after.node);
    assert.ok(summary.length < ResumeDom.nodeText(before.node).length, '继续精简未减少长度');
    for (const fact of ['3', '12', '25%']) assert.ok(summary.includes(fact), `精简遗漏：${fact}`);
    for (const id of ['work', 'projects', 'education', 'qa-name', 'qa-role']) {
      assert.equal(hashJson(ResumeDom.findNode(target, id)?.node),
        hashJson(ResumeDom.findNode(base, id)?.node), '只精简职业概况时修改了其他内容');
    }
  } else if (scenario.id === 'reorder') {
    assert.equal(ResumeDom.plainText(target).length, ResumeDom.plainText(base).length);
    const ids = target.root.children.map((node) => node.id);
    assert.ok(ids.indexOf('projects') < ids.indexOf('work'), '项目经历未移到工作经历之前');
    assert.deepEqual(ids.filter((id) => id !== 'projects'), base.root.children.map((node) => node.id).filter((id) => id !== 'projects'));
    for (const id of ids) assert.equal(hashJson(ResumeDom.findNode(target, id)?.node),
      hashJson(ResumeDom.findNode(base, id)?.node), '移动时改变了内容或样式');
  } else {
    assert.equal(text, ResumeDom.plainText(base), '样式请求不能改变正文');
    // Use the real document renderer without importing storage or the server.
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(ResumeDom.renderToHtml(target, { includeRoot: true }));
    try {
      const titles = [...dom.window.document.querySelectorAll('h2')];
      assert.equal(titles.length, 4, '模块标题数量改变');
      for (const title of titles) {
        const computed = dom.window.getComputedStyle(title);
        assert.equal(computed.color, 'rgb(23, 54, 93)', '标题颜色未按要求修改');
        assert.equal(computed.fontSize, '18px', '标题字号未按要求修改');
      }
    } finally { dom.window.close(); }
  }
  return { document: target, message: response.content };
}

module.exports = { CASES, fictionalDocument, fixtureImage, caseInput, evaluateCase };
