'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../server/lib/resume-harness');
const ResumeDom = require('../resume-dom');

const options = { skip: process.env.RESUME_LIVE_INTAKE_QA !== '1', timeout: 180000 };
const empty = ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: { id: 'resume-root', type: 'element', tag: 'article', semantic: { kind: 'document' }, children: [] },
});
function input(text, document = empty) {
  return harness.buildHarnessInput({
      text, messageId: 'live-intake', scope: { type: 'RESUME_DOCUMENT', id: null },
      task: { id: 'live-intake-task', goal: text, state: {} },
      profile: {}, job: null, resume: { content: document, revision: 1 }, conversationMessages: [],
  });
}
test('真实模型：无档案首次成稿', options, async () => {
  const first = await harness.complete(input(
    '请直接制作一份中文简历。我叫王青，2020年毕业于南京大学软件工程专业，本科学历。2020年至今在一家企业服务公司任产品经理，负责需求调研、产品设计与交付，擅长跨团队沟通。目标是企业服务产品经理。不必等待联系方式，先用这些信息成稿，不要编造公司名和数字。'),
  { signal: AbortSignal.timeout(150000) });
  const rewrite = first.response.actions.find((action) => action.type === 'RESUME_REWRITE_PROPOSAL');
  assert.ok(rewrite, JSON.stringify(first.response));
  const proposal = rewrite.payload.proposal || rewrite.payload;
  const document = proposal.target_resume_document || harness.materializeTargetFragments(empty, proposal.target_resume_fragments).document;
  assert.match(ResumeDom.plainText(document), /王青/);
  assert.match(ResumeDom.plainText(document), /产品经理/);
  console.log(JSON.stringify({ model: first.model, first_document_generated: true }));
});
test('真实模型：仅岗位信息时简短追问经历', options, async () => {
  const clarification = await harness.complete(input('我想申请产品经理，岗位要求：本科、擅长需求分析及跨团队沟通。请帮我做简历。'),
    { signal: AbortSignal.timeout(150000) });
  assert.ok(!clarification.response.actions.some((action) => action.type === 'RESUME_REWRITE_PROPOSAL'));
  assert.match(clarification.response.content, /经历|经验|教育|背景/);
});
test('真实模型：已有稿直接调整排版且保留全部文字', options, async () => {
  const document = ResumeDom.toResumeDocument({
    ...empty, root: { ...empty.root, children: [{
      id: 'intro', type: 'element', tag: 'section', style: { 'margin-bottom': '12pt' },
      children: [
        { id: 'name', type: 'element', tag: 'h1', text: '王青', editable: true, style: { 'font-size': '20pt' } },
        { id: 'goal', type: 'element', tag: 'p', text: '求职目标：企业服务产品经理', editable: true, style: { 'font-size': '11pt' } },
        { id: 'experience', type: 'element', tag: 'p', text: '负责需求调研、产品设计与交付，擅长跨团队沟通。', editable: true, style: { 'font-size': '11pt', 'line-height': '1.5' } },
      ],
    }] },
  });
  const style = await harness.complete(input('字号统一调大一点，段落间距放宽，保持所有文字不变，直接给我建议。', document),
    { signal: AbortSignal.timeout(150000) });
  const styleAction = style.response.actions.find((action) => action.type === 'RESUME_REWRITE_PROPOSAL');
  assert.ok(styleAction, JSON.stringify(style.response));
  const styleProposal = styleAction.payload.proposal || styleAction.payload;
  assert.equal(ResumeDom.plainText(styleProposal.target_resume_document), ResumeDom.plainText(document));
  assert.notDeepEqual(styleProposal.target_resume_document, document);
  console.log(JSON.stringify({ model: style.model, style_proposal: true, repair_count: style.repair_count }));
});
