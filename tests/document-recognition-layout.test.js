'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ResumeDom = require('../resume-dom');
const {
  parseDocumentXml,
  parseStylesXml,
} = require('../server/lib/document-recognition/docx');
const {
  buildContentCandidate,
  buildLayoutCandidate,
} = require('../server/lib/document-recognition/candidates');
const { normalizeSemantic } = require('../server/lib/document-recognition/semantic-analyzer');
const { renderHtml } = require('../server/lib/render/html');
const { buildDocumentXml } = require('../server/lib/render/docx');

function findNode(root, predicate) {
  if (!root) return null;
  if (predicate(root)) return root;
  for (const child of root.children || []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Noto Sans SC" w:eastAsia="Noto Sans SC"/>
      <w:sz w:val="20"/><w:color w:val="18212B"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
</w:styles>`;

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="40"/></w:pPr>
      <w:r><w:rPr><w:sz w:val="48"/><w:b/><w:color w:val="164D7A"/></w:rPr><w:t>个人简历</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tblPr><w:tblCellSpacing w:w="30" w:type="dxa"/></w:tblPr>
      <w:tblGrid><w:gridCol w:w="3100"/><w:gridCol w:w="3100"/><w:gridCol w:w="3100"/></w:tblGrid>
      <w:tr>
        <w:tc><w:tcPr><w:tcW w:w="3100" w:type="dxa"/><w:shd w:fill="F3F6F8"/><w:tcMar><w:top w:w="100"/><w:right w:w="100"/><w:bottom w:w="100"/><w:left w:w="100"/></w:tcMar></w:tcPr><w:p><w:r><w:t>姓名：请补充</w:t></w:r></w:p></w:tc>
        <w:tc><w:tcPr><w:tcW w:w="3100" w:type="dxa"/><w:shd w:fill="F3F6F8"/></w:tcPr><w:p><w:r><w:t>手机：请补充</w:t></w:r></w:p></w:tc>
        <w:tc><w:tcPr><w:tcW w:w="3100" w:type="dxa"/><w:shd w:fill="F3F6F8"/></w:tcPr><w:p><w:r><w:t>邮箱：请补充</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="7" w:color="2F78A7"/></w:pBdr></w:pPr>
      <w:r><w:rPr><w:sz w:val="28"/><w:b/></w:rPr><w:t>工作经历</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:rPr><w:sz w:val="23"/><w:b/></w:rPr><w:t>示例大学</w:t></w:r>
      <w:r><w:rPr><w:sz w:val="20"/><w:b/><w:color w:val="164D7A"/></w:rPr><w:t>    辅导员</w:t></w:r>
      <w:r><w:rPr><w:sz w:val="18"/><w:color w:val="68727D"/></w:rPr><w:t>    2023.04—至今</w:t></w:r>
    </w:p>
    <w:p><w:r><w:br w:type="page"/></w:r></w:p>
    <w:p><w:r><w:t>第二页正文</w:t></w:r></w:p>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="850" w:right="1050" w:bottom="850" w:left="1050"/>
    </w:sectPr>
  </w:body>
</w:document>`;

function buildFixture() {
  const parsed = parseDocumentXml(
    Buffer.from(DOCUMENT),
    parseStylesXml(Buffer.from(STYLES)),
  );
  const pages = parsed.document.pages.map((page) => ({
    number: page.number,
    width: 595.3,
    height: 841.9,
    blocks: parsed.blocks.filter((block) => block.page === page.number),
  }));
  const semantic = normalizeSemantic({}, parsed.blocks);
  const geometryPages = [{
    number: 1,
    width: 595.3,
    height: 841.9,
    blocks: [{
      text: '个人简历',
      bbox: { x: 249.75, y: 42.51, width: 96, height: 34.752 },
    }],
  }];
  const content = buildContentCandidate({
    blocks: parsed.blocks,
    pages,
    semantic,
    format: 'docx',
    nativeDocument: parsed.document,
    geometryPages,
  });
  const layout = buildLayoutCandidate({
    pages,
    semantic,
    format: 'docx',
    nativeDocument: parsed.document,
  });
  return { parsed, pages, semantic, content, layout };
}

test('DOCX 识别保留分页、表格、单元格和直接文字样式', () => {
  const { parsed, content, layout } = buildFixture();
  assert.strictEqual(parsed.document.pages.length, 2);
  assert.strictEqual(parsed.document.pages[0].children[1].type, 'table');
  assert.strictEqual(parsed.document.pages[0].children[1].rows[0].cells.length, 3);
  assert.strictEqual(parsed.document.pages[0].children[0].runs[0].style.font_size, 24);
  assert.strictEqual(parsed.document.pages[0].children[0].runs[0].style.color, '#164D7A');
  assert.deepStrictEqual(layout.schema.page.margin, {
    top: 42.5,
    right: 52.5,
    bottom: 42.5,
    left: 52.5,
  });
  assert.strictEqual(layout.schema.layout, 'imported-native');
  assert.strictEqual(layout.schema.fidelity, 'native-structure');

  const document = ResumeDom.ensureDocument(content.resume_json);
  assert.strictEqual(document.root.children.length, 2);
  const firstPage = document.root.children[0];
  assert.strictEqual(firstPage.attributes['data-layout-unit'], 'pt');
  assert.strictEqual(firstPage.attributes['data-font-metric-scale'], '1.448');
  assert.strictEqual(firstPage.style.width, '595.3pt');
  assert.strictEqual(firstPage.style['min-height'], '841.9pt');
  assert.strictEqual(firstPage.style.padding, '42.5pt 52.5pt 42.5pt 52.5pt');
  assert.strictEqual(firstPage.semantic.kind, 'page');
  const title = findNode(firstPage, (node) => node.semantic && node.semantic.kind === 'document_title');
  assert.strictEqual(title.style['font-size'], '24pt');
  assert.strictEqual(title.style['line-height'], '46.34pt');
  assert.match(title.style.margin, /2pt$/);
  const titleLocation = ResumeDom.findNode(document, title.id);
  assert.strictEqual(titleLocation.parent.semantic.kind, 'section');
  const workTitle = findNode(
    firstPage,
    (node) => node.semantic
      && node.semantic.kind === 'section_title'
      && ResumeDom.exportNodeText(node) === '工作经历',
  );
  const workTitleLocation = ResumeDom.findNode(document, workTitle.id);
  const continuedSection = document.root.children[1].children.find(
    (node) => node.semantic && node.semantic.kind === 'section',
  );
  assert.ok(continuedSection);
  assert.strictEqual(continuedSection.semantic.continuation, true);
  assert.strictEqual(
    continuedSection.semantic.group_id,
    workTitleLocation.parent.semantic.group_id,
  );
  const table = findNode(firstPage, (node) => node.tag === 'table');
  assert.ok(table);
  assert.strictEqual(table.style.width, '465pt');
  assert.strictEqual(table.children[0].children[0].children.length, 3);
  assert.strictEqual(table.children[0].children[0].children[0].style['background-color'], '#F3F6F8');
  assert.strictEqual(table.children[0].children[0].children[0].style.padding, '5pt 5pt 5pt 5pt');
  const timeline = findNode(firstPage,
    (node) => node.attributes && node.attributes['data-rich-layout'] === 'timeline',
  );
  assert.ok(timeline);
  assert.strictEqual(timeline.style['grid-template-columns'], 'auto minmax(0,1fr) auto');
  assert.strictEqual(timeline.style['column-gap'], '10pt');
});

test('旧版 DOCX 导入草稿读取时自动升级为固定 pt 页面', () => {
  const { content } = buildFixture();
  const oldDocument = JSON.parse(JSON.stringify(content.resume_json.dom_document));
  const page = oldDocument.root.children[0];
  delete page.attributes['data-layout-unit'];
  delete page.attributes['data-page-width-pt'];
  delete page.attributes['data-page-height-pt'];
  delete page.attributes['data-font-metric-scale'];
  page.style.width = '100%';
  page.style['min-height'] = '900px';
  page.style['aspect-ratio'] = '11906 / 16838';
  page.style.padding = '5.048% 8.819% 5.048% 8.819%';
  page.style['font-size'] = '10px';
  const oldTitle = findNode(page, (node) => node.semantic && node.semantic.kind === 'document_title');
  oldTitle.style['font-size'] = '24px';
  oldTitle.style['line-height'] = '2.083';
  oldTitle.style.margin = '0px 0 2px';

  const upgraded = ResumeDom.ensureDocument({ dom_document: oldDocument });
  const upgradedPage = upgraded.root.children[0];
  assert.strictEqual(upgradedPage.attributes['data-layout-unit'], 'pt');
  assert.strictEqual(upgradedPage.style.width, '595.3pt');
  assert.strictEqual(upgradedPage.style['min-height'], '841.9pt');
  assert.strictEqual(upgradedPage.style.padding, '42.5pt 52.5pt 42.5pt 52.5pt');
  assert.strictEqual(upgradedPage.style['font-size'], '10pt');
  assert.strictEqual(upgradedPage.attributes['data-font-metric-scale'], '1.448');
  const upgradedTitle = findNode(
    upgradedPage,
    (node) => node.semantic && node.semantic.kind === 'document_title',
  );
  assert.strictEqual(upgradedTitle.style['font-size'], '24pt');
  assert.strictEqual(upgradedTitle.style['line-height'], '72.39pt');
  assert.strictEqual(upgradedTitle.style.margin, '0pt 0 2pt');
});

test('未编辑时保留混合样式，编辑后只替换目标文字且不会重复旧 run', () => {
  const { content } = buildFixture();
  const document = ResumeDom.ensureDocument(content.resume_json);
  const timeline = findNode(document.root.children[0],
    (node) => node.attributes && node.attributes['data-rich-layout'] === 'timeline',
  );
  assert.strictEqual(timeline.children.length, 3);
  const updated = ResumeDom.applyOperations(document, [{
    op: 'replace_text',
    node_id: timeline.id,
    text: '示例大学　学生工作负责人　2023.04—至今',
  }]);
  const changed = ResumeDom.findNode(updated, timeline.id).node;
  assert.strictEqual(changed.children.length, 3);
  assert.strictEqual(changed.text, undefined);
  assert.strictEqual(changed.style.display, 'grid');
  assert.strictEqual(changed.style['grid-template-columns'], 'auto minmax(0,1fr) auto');
  assert.deepStrictEqual(
    changed.children.map((child) => child.id),
    timeline.children.map((child) => child.id),
  );
  assert.strictEqual(
    ResumeDom.exportNodeText(changed),
    '示例大学　学生工作负责人　2023.04—至今',
  );
});

test('HTML 保留完整 DOM，DOCX 导出至少保留表格行列结构', () => {
  const { content, layout } = buildFixture();
  const html = renderHtml({ resume: content.resume_json, template: layout });
  const wordXml = buildDocumentXml(content.resume_json, layout);
  assert.match(html, /<table/);
  assert.match(html, /background-color:#F3F6F8/);
  assert.strictEqual((wordXml.match(/<w:tbl>/g) || []).length, 1);
  assert.strictEqual((wordXml.match(/<w:tc>/g) || []).length, 3);
  assert.match(wordXml, /姓名：请补充/);
});

test('Page Scene 将视觉背景和精确文字层组合为通用可编辑页面', () => {
  const pageScene = {
    version: 'page-scene-v1',
    has_text_layer: true,
    render_dpi: 120,
    text_node_count: 1,
    pages: [{
      number: 1,
      width: 595.28,
      height: 841.89,
      background_contains_text: false,
      text_nodes: [{
        text: '工作经历',
        bbox: { x: 52.5, y: 120, width: 60, height: 16 },
        direction: { x: 1, y: 0 },
        spans: [{
          text: '工作经历',
          relative_bbox: { x: 0, y: 0, width: 60, height: 16 },
          font_family: 'Noto Sans SC',
          font_size: 12,
          color: '#164D7A',
          bold: true,
          italic: false,
        }],
      }],
    }],
  };
  const semantic = normalizeSemantic({}, [{
    id: 'block-1-1',
    page: 1,
    kind: 'heading',
    text: '工作经历',
  }]);
  const content = buildContentCandidate({
    blocks: [{
      id: 'block-1-1',
      page: 1,
      kind: 'heading',
      text: '工作经历',
    }],
    pages: [{ number: 1, width: 595.28, height: 841.89, blocks: [] }],
    semantic,
    format: 'pdf',
    pageScene,
  });
  const layout = buildLayoutCandidate({
    pages: [{ number: 1, width: 595.28, height: 841.89, blocks: [] }],
    semantic,
    format: 'pdf',
    pageScene,
  });
  const document = ResumeDom.ensureDocument(content.resume_json);
  const page = document.root.children[0];
  const background = page.children[0];
  const section = page.children[1];
  const block = section.children[0];
  const visualLine = block.children[0];
  const span = visualLine.children[0];

  assert.strictEqual(layout.schema.layout, 'imported-scene');
  assert.strictEqual(layout.schema.fidelity, 'rendered-page-scene');
  assert.strictEqual(page.style.width, '595.28pt');
  assert.strictEqual(page.style.height, '841.89pt');
  assert.strictEqual(background.tag, 'img');
  assert.strictEqual(background.semantic.kind, 'decoration');
  assert.strictEqual(background.attributes['data-scene-background-page'], '1');
  assert.strictEqual(section.semantic.kind, 'section');
  assert.strictEqual(block.semantic.kind, 'section_title');
  assert.strictEqual(block.editable, true);
  assert.strictEqual(block.style.left, '52.5pt');
  assert.strictEqual(block.style.top, '120pt');
  assert.strictEqual(visualLine.semantic.kind, 'layout_line');
  assert.strictEqual(span.style['font-size'], '12pt');
  assert.strictEqual(span.attributes['data-scene-text-width-pt'], '60');

  const updated = ResumeDom.applyOperations(document, [{
    op: 'replace_text',
    node_id: block.id,
    replace_children: true,
    text: '项目经历',
  }]);
  const changed = ResumeDom.findNode(updated, block.id).node;
  assert.strictEqual(changed.children.length, 1);
  assert.strictEqual(changed.text, undefined);
  assert.strictEqual(ResumeDom.exportNodeText(changed), '项目经历');
  assert.strictEqual(changed.children[0].id, visualLine.id);
  assert.strictEqual(changed.children[0].children[0].id, span.id);
  assert.strictEqual(changed.children[0].children[0].style['font-size'], '12pt');
  assert.strictEqual(changed.children[0].children[0].style.color, '#164D7A');
});

test('Page Scene 将同一文字块的多行归为一个可编辑语义节点', () => {
  const blocks = [{
    id: 'block-title',
    page: 1,
    order: 0,
    kind: 'heading',
    text: '职业概况',
  }, {
    id: 'block-body',
    page: 1,
    order: 1,
    kind: 'paragraph',
    text: '第一行内容第二行内容',
  }];
  const pageScene = {
    version: 'page-scene-v1',
    has_text_layer: true,
    render_dpi: 120,
    text_node_count: 3,
    pages: [{
      number: 1,
      width: 595.28,
      height: 841.89,
      background_contains_text: false,
      text_nodes: [
        {
          text: '职业概况',
          bbox: { x: 52.5, y: 80, width: 60, height: 16 },
          spans: [{ text: '职业概况', font_size: 12, bold: true }],
        },
        {
          text: '第一行内容',
          bbox: { x: 52.5, y: 110, width: 80, height: 14 },
          spans: [{ text: '第一行内容', font_size: 10 }],
        },
        {
          text: '第二行内容',
          bbox: { x: 52.5, y: 128, width: 80, height: 14 },
          spans: [{ text: '第二行内容', font_size: 10 }],
        },
      ],
    }],
  };
  const semantic = normalizeSemantic({}, blocks);
  const content = buildContentCandidate({
    blocks,
    pages: [{ number: 1, width: 595.28, height: 841.89, blocks }],
    semantic,
    format: 'pdf',
    pageScene,
  });
  const document = ResumeDom.ensureDocument(content.resume_json);
  const section = findNode(
    document.root,
    (node) => node.semantic && node.semantic.kind === 'section',
  );
  const title = section.children.find(
    (node) => node.semantic && node.semantic.kind === 'section_title',
  );
  const paragraph = section.children.find(
    (node) => node.semantic && node.semantic.kind === 'paragraph',
  );

  assert.ok(title);
  assert.ok(paragraph);
  assert.strictEqual(paragraph.editable, true);
  assert.strictEqual(paragraph.children.length, 2);
  assert.deepStrictEqual(
    paragraph.children.map((node) => node.semantic.kind),
    ['layout_line', 'layout_line'],
  );
  assert.strictEqual(ResumeDom.exportNodeText(paragraph), '第一行内容第二行内容');
  assert.strictEqual(
    ResumeDom.buildSemanticIndex(document).entries.get(paragraph.id).parent_id,
    section.id,
  );
});
