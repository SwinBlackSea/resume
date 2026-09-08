'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const ResumeDom = require('../resume-dom');
const {
  materializeTargetDocument, materializeTargetFragments,
} = require('../server/lib/resume-harness/target-fragments');
const { buildInlineMessages } = require('../server/lib/resume-harness/inline-rewrite');
const { documentRenderCss } = require('../server/lib/resume-harness/render-style-context');
const { buildRetryMessages } = require('../server/lib/resume-harness/conversation-protocol');

function document() {
  return ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: 'root', type: 'element', tag: 'article',
      style: { color: '#333', 'font-size': '14px' },
      children: [
        {
          id: 'heading', type: 'element', tag: 'h2', text: '职业概况', editable: true,
          style: { color: '#123456', 'font-size': '18px', 'margin-top': '12px' },
        },
        {
          id: 'body', type: 'element', tag: 'p', editable: true,
          children: [
            { id: 'run-one', type: 'element', tag: 'span', text: '负责',
              style: { 'font-weight': '400' } },
            { id: 'run-two', type: 'element', tag: 'strong', text: '174名学生',
              style: { 'font-weight': '700' } },
          ],
        },
        {
          id: 'table', type: 'element', tag: 'table', children: [
            { id: 'row', type: 'element', tag: 'tr', children: [
              { id: 'cell', type: 'element', tag: 'td',
                attributes: { colspan: '2', rowspan: '3' }, text: '完整表格内容' },
            ] },
          ],
        },
        {
          id: 'avatar', type: 'element', tag: 'img',
          attributes: { src: 'data:image/png;base64,AAAA', alt: '个人头像' },
          style: { width: '80px', height: '100px', left: '20px', position: 'absolute' },
        },
      ],
    },
    page_setup: {
      size: 'A4', orientation: 'portrait', max_pages: null,
      margins: { left: '20mm', right: '20mm' },
    },
    styles: { accent: '#123456' },
    assets: [{ id: 'image-1', type: 'image', data: 'BINARY-UNCHANGED', width: 80 }],
    annotations: [{ id: 'note-1', description: '保留文档标记' }],
  });
}

test('全局投影保留富文本子节点、原生CSS、表格合并关系、页面边距和资源描述', () => {
  const before = document();
  const projected = ResumeDom.toAiContextDocument(before, { includePresentation: true });
  const serialized = JSON.stringify(projected);
  assert.equal(projected.schema_version, 'resume-ai-context-v3');
  assert.match(serialized, /run-two/);
  assert.match(serialized, /"font-weight":"700"/);
  assert.match(serialized, /"colspan":"2","rowspan":"3"/);
  assert.match(serialized, /"left":"20mm"/);
  assert.match(serialized, /"left":"20px"/);
  assert.match(serialized, /个人头像/);
  assert.match(serialized, /image-1/);
  assert.doesNotMatch(serialized, /base64|BINARY-UNCHANGED/);
  assert.deepEqual(before, document(), '生成模型投影不能修改原始文档');
});

test('全局投影原样回传只改style，不会因推导语义产生额外结构变化', () => {
  const before = document();
  const projected = ResumeDom.toAiContextDocument(before, { includePresentation: true });
  const heading = projected.root.children.find((node) => node.id === 'heading');
  assert.equal(Object.hasOwn(heading, 'kind'), false);
  assert.equal(Object.hasOwn(heading, 'level'), false);
  assert.deepEqual(heading.semantic, ResumeDom.findNode(before, 'heading').node.semantic);
  const changed = materializeTargetFragments(before, {
    format: 'resume-target-fragments-v2',
    changes: [{ target_id: 'heading', replacement_subtree: {
      ...heading, style: { ...heading.style, color: '#ff0000' },
    } }],
  }).document;
  const comparison = ResumeDom.compareDocuments(before, changed);
  assert.equal(comparison.counts.style, 1);
  assert.equal(comparison.counts.structure, 0);
  assert.equal(comparison.counts.text, 0);
});

test('局部仍为纯文本，没有CSS、节点ID或表格结构', () => {
  const messages = buildInlineMessages({
    request: { instruction: '还是太多了' },
    target: { label: '职业概况', mode: 'node', paragraph_count: 1, source_text: '负责174名学生' },
    workspace: { resume: { content: document() } },
  });
  const context = messages[1].content;
  assert.doesNotMatch(context, /run-two|font-weight|page_setup|colspan|style/);
  assert.match(context, /174名学生/);
  const turn = JSON.parse(messages.at(-1).content);
  assert.equal(turn.instruction, '还是太多了');
  assert.equal(turn.editing_text, '负责174名学生');
});

test('完整目标调整页面时保留省略的图片字节、样式、正文和注释', () => {
  const before = document();
  const result = materializeTargetDocument(before, {
    root: { id: 'root' },
    page_setup: { margins: { left: '15mm' }, max_pages: null },
    assets: [{ id: 'image-1', width: 100 }],
  });
  assert.deepEqual(result.root, before.root);
  assert.deepEqual(result.styles, before.styles);
  assert.deepEqual(result.annotations, before.annotations);
  assert.equal(result.page_setup.margins.left, '15mm');
  assert.equal(result.page_setup.margins.right, '20mm');
  assert.equal(result.page_setup.max_pages, null);
  assert.equal(result.assets[0].data, 'BINARY-UNCHANGED');
  assert.equal(result.assets[0].width, 100);
});

test('已经完整的目标经继承组装不能产生额外样式变化', () => {
  const before = document();
  const target = ResumeDom.applyDocumentOperations(before, [{
    op: 'replace_text', node_id: 'heading', text: '职业发展',
  }]);
  assert.deepEqual(materializeTargetDocument(before, target), target);
});

test('最小片段可只调整行内样式，未返回样式和其他内容原样保留', () => {
  const before = document();
  const result = materializeTargetFragments(before, {
    format: 'resume-target-fragments-v2',
    changes: [{
      target_id: 'run-one',
      replacement_subtree: { id: 'run-one', style: { color: '#123456' } },
    }],
  }).document;
  const run = ResumeDom.findNode(result, 'run-one').node;
  assert.equal(run.style.color, '#123456');
  assert.equal(run.style['font-weight'], '400');
  assert.equal(ResumeDom.exportNodeText(result.root), ResumeDom.exportNodeText(before.root));
  assert.deepEqual(result.assets, before.assets);
});

test('默认样式取自真实入口，保留相关CSS而不混入聊天和工具栏', () => {
  const doc = document();
  doc.root.attributes.class = 'resume-section';
  const css = documentRenderCss([doc]);
  assert.match(css, /\.resume-section h2\{/);
  assert.match(css, /font-size:12px/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.doesNotMatch(css, /\.composer|\.doc-toolbar|\.local-ai|:hover|:focus/);
});

test('恢复协议时原始用户消息仍在最后，含图片的消息也不得被替换', () => {
  const last = { role: 'user', content: [
    { type: 'text', text: '  按这个样式调整  ' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ] };
  const original = [{ role: 'system', content: 'rules' }, last];
  const retry = buildRetryMessages(original, '模型缺少必要字段');
  assert.equal(retry.at(-1), last);
  assert.equal(retry.at(-2).role, 'system');
  assert.equal(retry.filter((message) => message.role === 'user').length, 1);
  assert.equal(original.length, 2);
});

test('全局根节点样式真实渲染，恢复旧文档时清掉新样式而保留界面容器', () => {
  const dom = new JSDOM('<div id="resume-document" class="resume"></div>');
  const element = dom.window.document.getElementById('resume-document');
  const renderer = new ResumeDom.Renderer(element);
  const before = document();
  renderer.render(before);
  assert.equal(element.style.fontSize, '14px');
  const changed = structuredClone(before);
  changed.root.style['font-size'] = '18px';
  changed.root.style['padding-left'] = '20px';
  changed.root.attributes.class = 'custom-document';
  renderer.render(changed);
  assert.equal(element.style.fontSize, '18px');
  assert.equal(element.style.paddingLeft, '20px');
  assert.ok(element.classList.contains('resume'));
  assert.ok(element.classList.contains('custom-document'));
  renderer.render(before);
  assert.equal(element.style.fontSize, '14px');
  assert.ok(Math.abs(parseFloat(element.style.paddingLeft) - 20 * 72 / 25.4) < 0.001);
  assert.ok(!element.classList.contains('custom-document'));
  assert.equal(element.id, 'resume-document');
  dom.window.close();
});
