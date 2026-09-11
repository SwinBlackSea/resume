'use strict';
// Opt-in real-provider evaluation: isolated SQLite/object directory, synthetic
// resumes and vector-drawn test portraits only. Never reads Codex credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.RESUME_OBJECTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-portrait-live-'));
const helpers = require('./helpers');
const sharp = require('sharp');
const { createModelGateway } = require('../server/lib/model-gateway');
const { loadQAConfig } = require('../server/scripts/openai-qa-config');
const harness = require('../server/lib/resume-harness');
const assets = require('../server/lib/document-assets');
const R = require('../resume-dom');

function fictionalResume() {
  return R.toResumeDocument({ schema_version: 'resume-document-v3', root: {
    id: 'resume', type: 'element', tag: 'article', semantic: { kind: 'document' },
    style: { padding: '36px', 'font-family': 'Arial', color: '#222' }, children: [
      { id: 'header', type: 'element', tag: 'header', semantic: { kind: 'section' }, children: [
        { id: 'name', type: 'element', tag: 'h1', editable: true, text: '测试求职者林晓', children: [] },
        { id: 'contact', type: 'element', tag: 'p', editable: true, text: 'lin@example.test · 上海', children: [] },
      ] },
      { id: 'experience', type: 'element', tag: 'p', editable: true,
        text: '2022—2025年在虚构教育机构从事学生事务管理。', children: [] },
    ],
  } });
}
function screenshot(rect) {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100">
    <rect width="800" height="1100" fill="white"/>
    <text x="65" y="90" font-family="sans-serif" font-size="34" fill="#222">TEST RESUME</text>
    <text x="65" y="140" font-family="sans-serif" font-size="22" fill="#555">Lin Xiao</text>
    <rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="#85b9df"/>
    <ellipse cx="${rect.x + rect.width / 2}" cy="${rect.y + rect.height * .45}"
      rx="${rect.width * .24}" ry="${rect.height * .25}" fill="#efc4a5"/>
    <path d="M${rect.x + rect.width * .12},${rect.y + rect.height}
      Q${rect.x + rect.width * .5},${rect.y + rect.height * .43} ${rect.x + rect.width * .88},${rect.y + rect.height}Z" fill="#243a62"/>
    <text x="65" y="310" font-family="sans-serif" font-size="25" fill="#222">WORK EXPERIENCE</text>
    <rect x="65" y="337" width="670" height="2" fill="#444"/>
    <text x="65" y="375" font-family="sans-serif" font-size="18" fill="#444">Student affairs at a fictional education institute</text>
    </svg>`)).png().toBuffer();
}
function iou(a, b) {
  const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlap / (a.width * a.height + b.width * b.height - overlap);
}

test('real Astra locates synthetic screenshot portraits and inserts original pixels into sparse resume proposals', {
  skip: process.env.RESUME_LIVE_PORTRAIT_QA !== '1', timeout: 540000,
}, async t => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  const ws = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const gateway = createModelGateway({ provider: 'openai', globalProvider: 'openai', openai: loadQAConfig() });
  const cases = [
    { name: 'right-upper', rect: { x: 610, y: 55, width: 130, height: 175 } },
    { name: 'center-upper', rect: { x: 440, y: 70, width: 120, height: 170 } },
  ];
  for (const [index, scenario] of cases.entries()) {
    const buffer = await screenshot(scenario.rect);
    const image = await assets.storeImage(buffer, ws.user.id);
    const candidate = { input_image_id: `synthetic-${index}`, asset_id: image.id,
      width: image.width, height: image.height, kind: 'uploaded_image', material_role: 'personal' };
    const attachment = await assets.modelImage(candidate, ws.user.id);
    const outputs = [];
    const recoveryDiagnostics = [];
    const modelClient = { ...gateway, async generate(request) {
      if (request.routingReason?.includes('repair') || request.routingReason?.includes('recovery')) {
        const diagnostic = String(request.messages.at(-2)?.content || '');
        recoveryDiagnostics.push(diagnostic.match(/校验问题：[^\n]+/)?.[0]
          || diagnostic.match(/上一次输出[^\n]+/)?.[0] || request.routingReason);
      }
      const result = await gateway.generate(request);
      outputs.push(JSON.parse(JSON.stringify(result.output)));
      return result;
    } };
    const input = harness.buildHarnessInput({
      text: '把这份旧简历截图中的求职者照片放到当前简历姓名右侧，保留完整照片，不要只截脸；其余文字保持不变。',
      messageId: `portrait-eval-${index}`, scope: { type: 'RESUME_DOCUMENT', id: null },
      task: { id: `portrait-eval-${index}`, goal: '保留旧简历照片', state: {} },
      profile: {}, resume: { content: fictionalResume(), revision: 1 }, conversationMessages: [],
      attachments: [attachment], imageSources: [candidate],
      assetAuthorization: { ownerId: ws.user.id, projectId },
    });
    const result = await harness.complete(input, { modelClient, signal: AbortSignal.timeout(180000) });
    assert.equal(result.model_route, 'vision');
    const proposal = result.response.actions.find(action => action.type === 'RESUME_REWRITE_PROPOSAL')?.payload.proposal;
    assert.ok(proposal, 'must produce an executable proposal, not claim photo insertion is unavailable');
    const output = outputs.at(-1);
    const request = output.resume_proposal?.asset_requests?.[0] || output.proposal?.asset_requests?.[0];
    assert.ok(request?.crop, 'screenshot must provide a photo rectangle');
    const pixels = { x: request.crop.x * 800, y: request.crop.y * 1100,
      width: request.crop.width * 800, height: request.crop.height * 1100 };
    const accuracy = iou(pixels, scenario.rect);
    assert.ok(accuracy >= .88, `${scenario.name} crop IoU ${accuracy} < .88`);
    assert.equal(R.plainText(proposal.target_resume_document), R.plainText(fictionalResume()));
    assert.ok(proposal.target_resume_document.assets.some(asset => assets.readDocumentAsset(asset.id, ws.user.id).buffer));
    console.log(JSON.stringify({ portrait_case: scenario.name, model: result.model,
      crop_iou: Number(accuracy.toFixed(4)), calls: outputs.length, repair_count: result.repair_count,
      recovery_diagnostics: recoveryDiagnostics, original_pixels_embedded: true }));
  }
});
