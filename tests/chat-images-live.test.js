'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const harness = require('../server/lib/resume-harness');
const { fixture } = require('./fixtures/manual-structures');

test('真实视觉模型经全局 harness 识别图片而非仅接收附件ID', {
  skip: process.env.RESUME_LIVE_IMAGE_QA !== '1', timeout: 180000,
}, async () => {
  const image = await sharp(Buffer.from(
    '<svg width="600" height="180"><rect width="600" height="180" fill="white"/><text x="40" y="110" font-size="64" fill="black">RESUME 4827</text></svg>',
  )).png().toBuffer();
  const input = harness.buildHarnessInput({
    text: '请读取图片中的英文和编号，只告诉我图片上写了什么，不修改简历。',
    messageId: 'live-image-message', scope: { type: 'RESUME_DOCUMENT', id: null },
    task: { id: 'live-image-task', goal: '查看图片', state: {} },
    profile: {}, resume: { content: fixture(), revision: 1 }, conversationMessages: [],
    attachments: [{ mime_type: 'image/png', content_base64: image.toString('base64') }],
  });
  const result = await harness.complete(input, { signal: AbortSignal.timeout(165000) });
  assert.match(JSON.stringify(result.response), /4827/);
  assert.equal(result.model_route, 'vision');
  const continued = harness.buildHarnessInput({
    text: '把职业概况的正文替换为刚才图片中的英文和编号，其他内容不变，直接给出修改建议。',
    messageId: 'live-image-followup', scope: { type: 'RESUME_DOCUMENT', id: null },
    task: { id: 'live-image-task', goal: '查看图片并修改简历', state: {} },
    profile: {}, resume: { content: fixture(), revision: 1 },
    conversationMessages: [{ role: 'user', content: input.request.text },
      { role: 'assistant', content: '图片中写着 RESUME 4827。' }],
    imageHistory: [{ text: input.request.text, attachments: input.attachments }],
  });
  const proposal = await harness.complete(continued, { signal: AbortSignal.timeout(165000) });
  assert.equal(proposal.model_route, 'vision');
  assert.ok(proposal.response.actions.some((action) => action.type === 'RESUME_REWRITE_PROPOSAL'));
  assert.match(JSON.stringify(proposal.response.actions), /4827/);
  console.log(JSON.stringify({ live_image_model: result.model, image_text_recognized: true }));
});
