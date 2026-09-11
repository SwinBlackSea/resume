'use strict';
const R = require('../../resume-dom');
const { element, paragraph } = require('./manual-structures');

function document(children, style = {}) {
  return R.toResumeDocument({ schema_version: R.RESUME_DOCUMENT_VERSION, root: element('flow-root', 'article', 'document', children, {
    style: { width: '680px', padding: '36px', 'box-sizing': 'border-box', ...style },
  }) });
}
function title(id = 'flow-title') {
  return element(id, 'h2', 'section_title', [], {
    text: '成果与能力', editable: true, style: { margin: '0 0 8px', 'font-size': '18px' },
  });
}
function cell(id, style = {}, children) {
  return children ? element(id, 'div', 'entry', children, { style })
    : { ...paragraph(id, `测试内容 ${id}`), style: { margin: '0', 'font-size': '14px', ...style } };
}
function grid(variant) {
  const heading = title();
  heading.style['grid-column'] = '1 / -1';
  const children = [heading];
  for (let column = 1; column <= 3; column++) {
    children.push(cell(`value-${column}`, { 'grid-row': '2', 'grid-column': String(column) }));
    children.push(cell(`caption-${column}`, { 'grid-row': '3', 'grid-column': String(column) }));
  }
  children.push(cell('footer', { 'grid-row': '4', 'grid-column': '1 / -1' }));
  const style = { display: 'grid', 'grid-template-columns': 'repeat(3, 1fr)', gap: '8px 12px' };
  const anchor = children.find(node => node.id === 'caption-3');
  if (variant === 'longhand') {
    anchor.style = { ...anchor.style, 'grid-row': 'auto', 'grid-row-start': '3',
      'grid-row-end': 'span 2', 'grid-column-start': '3', 'grid-column-end': '4' };
    children.find(node => node.id === 'footer').style['grid-row'] = '5';
  }
  if (variant === 'span') {
    children.find(node => node.id === 'value-1').style['grid-row'] = '2 / span 3';
    children.splice(children.findIndex(node => node.id === 'caption-1'), 1);
    children.find(node => node.id === 'footer').style['grid-row'] = '5';
  }
  if (variant === 'negative') {
    style['grid-template-rows'] = 'repeat(4, minmax(24px, auto))';
    anchor.style['grid-row'] = '-3 / -2';
    anchor.style['grid-column'] = '-2 / -1';
  }
  if (variant === 'named-lines') {
    style['grid-template-rows'] = '[heading] auto [values] auto [captions] auto [foot] auto [end]';
    anchor.style['grid-row'] = 'captions / foot';
    anchor.style['grid-column'] = '3';
  }
  if (variant === 'named-areas') {
    style['grid-template-areas'] = '"heading heading heading" "a b c" "d e f" "footer footer footer"';
    const areas = { 'flow-title': 'heading', 'value-1': 'a', 'value-2': 'b', 'value-3': 'c',
      'caption-1': 'd', 'caption-2': 'e', 'caption-3': 'f', footer: 'footer' };
    for (const node of children) {
      delete node.style['grid-row']; delete node.style['grid-column'];
      node.style['grid-area'] = areas[node.id];
    }
  }
  if (variant === 'area-shorthand') {
    delete anchor.style['grid-row']; delete anchor.style['grid-column'];
    anchor.style['grid-area'] = '3 / 3 / 4 / 4';
  }
  if (variant === 'auto') {
    for (const node of children) {
      delete node.style['grid-row'];
      if (node !== heading) delete node.style['grid-column'];
    }
  }
  if (variant === 'nested') {
    const index = children.findIndex(node => node.id === 'caption-3');
    children[index] = cell('nested-entry', anchor.style, [
      cell('caption-3'), element('nested-details', 'div', 'group', [
        cell('detail-1'), element('deeper', 'div', 'group', [cell('detail-2')]),
      ]),
    ]);
  }
  if (variant === 'overlap') {
    const duplicate = structuredClone(anchor);
    anchor.id = 'caption-3-original';
    children.splice(children.indexOf(anchor) + 1, 0, duplicate);
  }
  return document([element('flow-section', 'section', 'section', children, { style })]);
}

function layouts() {
  const results = ['numeric', 'longhand', 'span', 'negative', 'named-lines', 'named-areas',
    'area-shorthand', 'auto', 'nested', 'overlap'].map(name => ({
    name: `grid-${name}`, document: grid(name), anchor: 'caption-3', title: 'flow-title',
  }));
  for (const display of ['block', 'flex', 'grid']) {
    results.push({ name: `module-${display}`, title: 'flow-title', anchor: 'module-body',
      document: document([
        element('first-module', 'section', 'section', [title(), cell('module-body')], {
          style: display === 'grid' ? { 'grid-row': '1', 'grid-column': '1 / -1' } : { order: '2' },
        }),
        element('second-module', 'section', 'section', [title('other-title'), cell('other-body')], {
          style: display === 'grid' ? { 'grid-row': '2', 'grid-column': '1 / -1' } : { order: '3' },
        }),
      ], { display, 'flex-direction': 'column', gap: '18px', 'grid-template-columns': '1fr 1fr' }),
    });
  }
  results.push({ name: 'flex-contents', title: 'flow-title', anchor: 'module-body',
    document: document([
      element('first-module', 'section', 'section', [
        { ...title(), style: { order: '1', margin: '0' } },
        cell('module-body', { order: '2' }),
      ], { style: { display: 'contents' } }),
      element('second-module', 'section', 'section', [title('other-title'), cell('other-body')],
        { style: { order: '3' } }),
    ], { display: 'flex', 'flex-direction': 'column', gap: '12px' }),
  });
  return results;
}
module.exports = { layouts };
