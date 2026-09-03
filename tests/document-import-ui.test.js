'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const helpers = require('./helpers');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function waitFor(predicate, timeout = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待文件导入界面更新超时');
}

let ctx;
let projectId;
let workspace;

test.before(async () => {
  ctx = await helpers.boot();
  projectId = await helpers.defaultProject(ctx);
  workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
});

test.after(() => helpers.close(ctx));

function fakeImport(id, entryContext) {
  return {
    id,
    project_id: projectId,
    upload_id: `upload-${id}`,
    entry_context: entryContext,
    status: 'needs_review',
    detected_format: 'pdf',
    page_count: 2,
    document_candidate: {
      resume_json: workspace.draft.resume_json,
      plain_text: '识别后的简历正文',
    },
    quality_report: {
      safe_to_review: true,
      text_coverage: 0.99,
      warning_codes: [],
    },
    warning_codes: [],
    preview_artifact_ids: [],
    can_review: true,
    can_apply: false,
    file: { name: `${entryContext}.pdf`, size: 204800, mime_type: 'application/pdf' },
    created_at: new Date().toISOString(),
  };
}

function loadApp() {
  const origin = ctx.base.replace('/api/v1', '');
  const imports = [fakeImport('import-workspace', 'workspace')];
  const calls = { review: null, apply: null, transaction: null };
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `${origin}/`,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, options = {}) => {
        const parsed = new URL(url, origin);
        const method = options.method || 'GET';
        if (
          method === 'GET'
          && parsed.pathname === `/api/v1/projects/${projectId}/document-imports`
        ) {
          return Promise.resolve(jsonResponse({ items: imports }));
        }
        if (
          method === 'POST'
          && parsed.pathname === '/api/v1/document-imports/import-workspace/review'
        ) {
          calls.review = JSON.parse(options.body);
          return Promise.resolve(jsonResponse({
            ...imports[0],
            status: 'ready',
            can_review: false,
            can_apply: true,
            document_candidate: {
              ...imports[0].document_candidate,
              resume_json: calls.review.resume_json,
            },
          }));
        }
        if (
          method === 'POST'
          && parsed.pathname === '/api/v1/document-imports/import-workspace/apply'
        ) {
          calls.apply = JSON.parse(options.body);
          return Promise.resolve(jsonResponse({
            id: 'import-workspace',
            status: 'applied',
            applied_mode: 'imported_resume',
            version_id: 'imported-version',
            draft_revision: workspace.draft.revision + 1,
            change_id: 'change-document-import-ui',
            profile_unchanged: true,
            version_created: true,
          }));
        }
        if (
          method === 'POST'
          && parsed.pathname === `/api/v1/projects/${projectId}/resume-draft/transactions`
        ) {
          calls.transaction = JSON.parse(options.body);
          return Promise.resolve(jsonResponse({
            resume_json: workspace.draft.resume_json,
            draft_revision: workspace.draft.revision + 1,
            revision: workspace.draft.revision + 1,
            change_id: 'change-direct-edit-ui',
            version_created: false,
          }));
        }
        return fetch(parsed, options);
      };
      window.EventSource = class {
        addEventListener() {}
        close() {}
      };
      window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    },
  });
  return { dom, calls };
}

test('Web 与移动端共用文件导入入口和响应式预览结构', async () => {
  const { dom } = loadApp();
  const document = dom.window.document;
  await waitFor(() => dom.window.WS);

  const trigger = document.querySelector('#document-import-button');
  assert.ok(trigger);
  assert.match(trigger.textContent, /从文件导入/);
  assert.match(
    HTML,
    /@media\(max-width:760px\)[\s\S]*?\.document-import-review\{grid-template-columns:1fr\}/,
  );
  assert.match(
    HTML,
    /@media\(max-width:760px\)[\s\S]*?\.document-import-modal\{width:100%;height:100%/,
  );
  assert.match(HTML, /function fitImportedPages\(container\)/);
  assert.match(HTML, /function hydrateImportedScene\(container\)/);
  assert.match(HTML, /data-scene-background-artifact-id/);
  assert.match(HTML, /\.resume \.imported-page-shell\{position:relative;width:100%;overflow:hidden\}/);
  assert.match(
    HTML,
    /\.document-import-result \.resume:has\(\.imported-document-page\)[\s\S]*?zoom:1!important/,
  );

  trigger.click();
  assert.ok(document.querySelector('#document-import-modal').classList.contains('show'));
  await waitFor(() => document.querySelector('#document-import-review-stage').classList.contains('active'));
  assert.strictEqual(document.querySelector('#document-import-modes'), null);
  assert.strictEqual(document.querySelector('#template-upload-button'), null);
  assert.ok(document.querySelector('#document-import-resume [contenteditable="true"]'));
  assert.match(document.querySelector('#document-import-source-meta').textContent, /2 页/);
  dom.window.close();
});

test('预览文字修正后，单次确认应用完整可编辑简历', async () => {
  const { dom, calls } = loadApp();
  const document = dom.window.document;
  await waitFor(() => dom.window.WS);

  document.querySelector('#document-import-button').click();
  await waitFor(() => document.querySelector('#document-import-review-stage').classList.contains('active'));

  const editable = document.querySelector('#document-import-resume [contenteditable="true"]');
  editable.textContent = '用户修正后的识别文字';
  document.querySelector('#document-import-apply').click();

  await waitFor(() => calls.apply);
  assert.strictEqual(calls.review.accepted, true);
  assert.match(JSON.stringify(calls.review.resume_json), /用户修正后的识别文字/);
  assert.strictEqual(calls.apply.mode, undefined);
  assert.strictEqual(calls.apply.expected_draft_revision, workspace.draft.revision);
  await waitFor(() => !document.querySelector('#document-import-modal').classList.contains('show'));
  dom.window.close();
});

test('直接编辑自动提交文档事务，切换回 AI 时不再次识别文档', async () => {
  const { dom, calls } = loadApp();
  const document = dom.window.document;
  await waitFor(() => dom.window.WS);

  assert.strictEqual(document.querySelector('#template-button'), null);
  assert.strictEqual(document.querySelector('#template-modal'), null);
  document.querySelector('#edit-document-button').click();
  const target = document.querySelector('#resume-document [contenteditable="true"]');
  assert.ok(target);
  target.textContent = '用户直接修改后的文字';
  target.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  await waitFor(() => calls.transaction, 5000);
  await waitFor(() => document.querySelector('#undo-bar').classList.contains('show'));
  assert.strictEqual(calls.transaction.expected_revision, workspace.draft.revision);
  assert.strictEqual(calls.transaction.operations[0].op, 'replace_text');
  assert.strictEqual(calls.transaction.operations[0].text, '用户直接修改后的文字');
  assert.strictEqual(calls.transaction.input_type, 'typing');
  assert.ok(document.querySelector('#undo-bar').classList.contains('show'));
  assert.strictEqual(
    document.querySelector('#document-import-review-stage').classList.contains('active'),
    false,
  );
  dom.window.close();
});
