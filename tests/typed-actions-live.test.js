'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const harness = require('../server/lib/resume-harness');
const ResumeDom = require('../resume-dom');
const { createModelGateway } = require('../server/lib/model-gateway');

test('真实模型：结构化岗位建议及带历史图片的中文改写重复验证', {
  skip: process.env.RESUME_LIVE_TYPED_ACTIONS_QA !== '1', timeout: 420000,
}, async () => {
  const document = ResumeDom.toResumeDocument({
    schema_version: 'resume-document-v3',
    root: { id: 'root', type: 'element', tag: 'article', children: [
      { id: 'name', type: 'element', tag: 'h1', text: '王青', editable: true },
      { id: 'role', type: 'element', tag: 'p', text: 'Product Manager', editable: true },
      { id: 'heading', type: 'element', tag: 'h2', text: 'Work Experience', editable: true },
      { id: 'experience', type: 'element', tag: 'p', text: '负责需求调研、Product planning and team collaboration。', editable: true },
    ] },
  });
  const image = await sharp(Buffer.from('<svg width="360" height="180"><rect width="360" height="180" fill="white"/><rect width="95" height="180" fill="#17365d"/><path d="M115 35H320M115 65H290M115 95H310" stroke="#ddd" stroke-width="9"/></svg>')).png().toBuffer();
  const makeInput = (text, vision = false) => harness.buildHarnessInput({
    text, messageId: 'typed-live', scope: { type: 'RESUME_DOCUMENT', id: null },
    task: { id: 'typed-live-task', goal: '根据岗位和截图优化简历', state: {} },
    profile: {}, job: { id: 'current-job', title: '产品经理', company: '测试公司',
      confirmed_text: '负责产品规划、需求调研和团队协作。' },
    resume: { content: document, revision: 1 },
    conversationMessages: vision ? [
      { role: 'user', content: '以截图作为排版参考，针对当前岗位优化简历。' },
      { role: 'assistant', content: '简历排版建议已应用，继续使用当前产品经理岗位。' },
    ] : [],
    imageHistory: vision ? [{ text: '排版参考截图', attachments: [
      { mime_type: 'image/png', content_base64: image.toString('base64') },
    ] }] : [],
  });
  const jobResult = await harness.complete(makeInput(
    '提供一个新岗位：测试企业的高级产品经理，负责企业服务需求调研、产品规划及跨团队交付。请给出设为当前岗位的建议，不修改简历。'),
  { signal: AbortSignal.timeout(150000) });
  const jobAction = jobResult.response.actions.find((action) => action.type === 'JOB_SET_CURRENT_PROPOSAL');
  assert.ok(jobAction);
  assert.ok(jobAction.payload.confirmed_text.trim());
  assert.equal(jobResult.response.actions.filter((action) => action.type === 'RESUME_REWRITE_PROPOSAL').length, 0);
  console.log(JSON.stringify({ scenario: 'new-job', model: jobResult.model, repair_count: jobResult.repair_count }));
  for (let run = 1; run <= 3; run++) {
    const result = await harness.complete(makeInput('中英混杂？全部改成中文', true),
      { signal: AbortSignal.timeout(150000) });
    assert.equal(result.model_route, 'vision');
    const rewrite = result.response.actions.find((action) => action.type === 'RESUME_REWRITE_PROPOSAL');
    assert.ok(rewrite);
    assert.equal(result.response.actions.filter((action) => action.type !== 'RESUME_REWRITE_PROPOSAL').length, 0,
      '沿用既有岗位时不应重复设置岗位或保存资料');
    const text = ResumeDom.plainText(rewrite.payload.proposal.target_resume_document);
    assert.match(text, /产品/);
    assert.match(text, /协作|合作/);
    assert.ok(!/[a-z]{3,}/i.test(text), '当前简历可见内容应改成中文');
    console.log(JSON.stringify({ scenario: 'translate-with-image-history', run,
      model: result.model, repair_count: result.repair_count, chinese: true, repeated_job_action: false }));
  }
  // Deliberately violate the initial data payload, then use the real provider
  // for the narrow repair. This checks its schema support, not just fake clients.
  const gateway = createModelGateway();
  let calls = 0;
  const preserved = '负责产品规划与团队协作，保留本轮已生成的中文结果。';
  const repaired = await harness.complete(makeInput('中英混杂？全部改成中文', true), {
    signal: AbortSignal.timeout(150000),
    modelClient: { async generate(options) {
      if (++calls > 1) return gateway.generate(options);
      return { strict_schema: true, output: {
        type: 'proposal', content: '中文版建议已准备好。', awaiting_user: false,
        message_kind: null, quick_replies: [],
        data_actions: [{ type: 'JOB_SET_CURRENT_PROPOSAL', target_id: null,
          payload: { title: '产品经理', company: '测试公司' } }],
        resume_proposal: {
          changes: [{ target_id: 'role', replacement_json: JSON.stringify({ id: 'role', text: '产品经理' }) },
            { target_id: 'heading', replacement_json: JSON.stringify({ id: 'heading', text: '工作经历' }) },
            { target_id: 'experience', replacement_json: JSON.stringify({ id: 'experience', text: preserved }) }],
          insertions: [], target_document_json: null,
          change_constraints: { content: 'modify', structure: 'preserve', style: 'preserve',
            content_order: 'preserve', allowed_region_ids: ['root'] },
        },
      } };
    } },
  });
  assert.equal(calls, 2);
  assert.equal(repaired.repair_count, 1);
  const fixedJob = repaired.response.actions.find((action) => action.type === 'JOB_SET_CURRENT_PROPOSAL');
  assert.ok(fixedJob.payload.confirmed_text.trim());
  const kept = repaired.response.actions.find((action) => action.type === 'RESUME_REWRITE_PROPOSAL');
  assert.equal(ResumeDom.nodeText(ResumeDom.findNode(kept.payload.proposal.target_resume_document, 'experience').node), preserved);
  console.log(JSON.stringify({ scenario: 'injected-invalid-job-real-repair', model: repaired.model,
    repair_count: repaired.repair_count, original_resume_preserved: true }));
});
