'use strict';

const R = require('../../resume-dom');
function element(id, tag, kind, children = [], extra = {}) {
  return { id, type: 'element', tag, semantic: { kind }, children, ...extra };
}
function paragraph(id, text = id) {
  return element(id, 'p', 'paragraph', [], { editable: true, text });
}
function row(id, values) {
  return element(id, 'tr', 'table_row', values.map((value, index) =>
    element(`${id}-cell-${index}`, 'td', 'table_cell', [paragraph(`${id}-p-${index}`, value)], {
      style: { 'background-color': '#f3f6f8', padding: '8px' },
    })));
}
function fixture() {
  return R.toResumeDocument({
    schema_version: R.RESUME_DOCUMENT_VERSION,
    root: element('manual-root', 'article', 'document', [
      element('overview', 'section', 'section', [
        element('overview-title', 'h2', 'section_title', [], { editable: true, text: '职业概况' }),
        paragraph('overview-p', '负责项目管理，推动团队协作。'),
        element('grid-table', 'table', 'table', [
          element('grid-body', 'tbody', 'group', [
            row('grid-row-1', ['姓名：示例', '手机：请补充', '邮箱：请补充']),
            row('grid-row-2', ['政治面貌：请补充', '年龄：请补充', '户籍：上海']),
          ]),
        ], { style: { width: '100%', 'table-layout': 'fixed' } }),
      ]),
      element('experience', 'section', 'section', [
        element('experience-title', 'h2', 'section_title', [], { editable: true, text: '工作经历' }),
        element('entry-1', 'div', 'entry', [
          paragraph('entry-name', '示例企业 · 产品经理'),
          element('list-1', 'ul', 'list', [
            element('item-1', 'li', 'list_item', [
              paragraph('item-text', '负责多个项目'),
              element('nested-list', 'ol', 'list', [
                element('nested-item', 'li', 'list_item', [
                  paragraph('nested-text', '推动团队交付'),
                  element('deep-group', 'div', 'group', [
                    paragraph('deep-text', '四层之后仍完整复制'),
                  ]),
                ]),
              ]),
            ]),
            element('item-2', 'li', 'list_item', [paragraph('item-2-text', '组织客户交流')]),
          ]),
        ]),
      ]),
      element('merged-section', 'section', 'section', [
        element('merged-title', 'h2', 'section_title', [], { editable: true, text: '项目经历' }),
        element('merged-table', 'table', 'table', [
          element('merged-body', 'tbody', 'group', [
            element('merged-row-1', 'tr', 'table_row', [
              element('merged-cell', 'td', 'table_cell', [paragraph('merged-label', '项目A')], {
                attributes: { rowspan: '2' },
              }),
              element('merged-detail-1', 'td', 'table_cell', [paragraph('merged-text-1', '项目职责')]),
            ]),
            element('merged-row-2', 'tr', 'table_row', [
              element('merged-detail-2', 'td', 'table_cell', [paragraph('merged-text-2', '项目成果')]),
            ]),
            row('merged-row-3', ['项目B', '独立项目']),
          ]),
        ], { style: { width: '100%' } }),
      ]),
    ]),
  });
}

module.exports = { fixture, element, paragraph, row };
