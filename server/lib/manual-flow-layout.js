'use strict';

// Manual duplication must preserve content, not reuse its occupied grid cell.
// This module operates on layout rules/IDs, never resume words or model output.
const R = require('../../resume-dom');

function boxChildren(node) {
  return (node.children || []).flatMap((child) => {
    if (child.type !== 'element' || child.attributes?.['data-editor-only'] === 'true') return [];
    return child.style?.display === 'contents' ? boxChildren(child) : [child];
  });
}

function layoutParent(document, node) {
  let parent = R.findNode(document, node.id)?.parent;
  while (parent?.style?.display === 'contents') parent = R.findNode(document, parent.id)?.parent;
  return parent;
}

// Tokenize track lists without splitting minmax()/repeat() or named line sets.
function tracks(value) {
  const tokens = [];
  let buffer = '', parentheses = 0, brackets = 0;
  for (const char of String(value || '')) {
    if (char === '(') parentheses++;
    if (char === ')') parentheses--;
    if (char === '[') brackets++;
    if (char === ']') brackets--;
    if (/\s/.test(char) && !parentheses && !brackets) {
      if (buffer) tokens.push(buffer);
      buffer = '';
    } else buffer += char;
  }
  if (buffer) tokens.push(buffer);
  return tokens.flatMap((token) => {
    const repeat = /^repeat\(\s*(\d+)\s*,([\s\S]*)\)$/.exec(token);
    if (!repeat) return [token];
    return Array.from({ length: Math.min(Number(repeat[1]), 1000) }, () => tracks(repeat[2])).flat();
  });
}

function axisLines(parent, axis) {
  const names = new Map();
  let line = 1;
  for (const token of tracks(parent.style?.[`grid-template-${axis === 'row' ? 'rows' : 'columns'}`])) {
    if (token.startsWith('[')) {
      for (const name of token.slice(1, -1).trim().split(/\s+/)) {
        names.set(name, [...(names.get(name) || []), line]);
      }
    } else if (!['none', 'subgrid'].includes(token)) line++;
  }
  const areas = [...String(parent.style?.['grid-template-areas'] || '').matchAll(/["']([^"']+)["']/g)]
    .map((match) => match[1].trim().split(/\s+/));
  const count = Math.max(line - 1, axis === 'row' ? areas.length : Math.max(0, ...areas.map(row => row.length)));
  function resolve(value) {
    if (/^-?\d+$/.test(value)) {
      const number = Number(value);
      return number > 0 ? number : number < 0 && count ? count + 2 + number : null;
    }
    const match = /^([\w-]+)(?:\s+(\d+))?$/.exec(value);
    return match ? names.get(match[1])?.[Number(match[2] || 1) - 1] || null : null;
  }
  return { resolve, areas };
}

function placement(parent, node) {
  // Respect the same declaration order as renderNodeToHtml/styleText.
  const fields = { row: ['auto', 'auto'], column: ['auto', 'auto'] };
  let areaName = null;
  for (const [key, raw] of Object.entries(node.style || {})) {
    const values = String(raw).split('/').map(s => s.trim());
    if (key === 'grid-area') {
      areaName = values.length === 1 && /^[A-Za-z_][\w-]*$/.test(values[0]) && values[0] !== 'auto'
        ? values[0] : null;
      fields.row = [values[0], values[2] || 'auto'];
      fields.column = [values[1] || 'auto', values[3] || 'auto'];
    }
    for (const axis of ['row', 'column']) {
      if (key === `grid-${axis}`) fields[axis] = [values[0], values[1] || 'auto'];
      if (key === `grid-${axis}-start`) fields[axis][0] = values[0];
      if (key === `grid-${axis}-end`) fields[axis][1] = values[0];
    }
  }
  const result = {};
  for (const axis of ['row', 'column']) {
    const lines = axisLines(parent, axis);
    let [startValue, endValue] = fields[axis];
    let start = lines.resolve(startValue);
    let end = lines.resolve(endValue);
    if (areaName && node.style?.['grid-area'] === areaName) {
      const cells = lines.areas.flatMap((row, r) => row.flatMap((name, c) =>
        name === areaName ? [axis === 'row' ? r + 1 : c + 1] : []));
      if (cells.length) {
        // Explicit axis overrides still take precedence over the area.
        const axisOverridden = Object.keys(node.style).slice(Object.keys(node.style).indexOf('grid-area') + 1)
          .some(key => key === `grid-${axis}` || key.startsWith(`grid-${axis}-`));
        if (!axisOverridden) { start = Math.min(...cells); end = Math.max(...cells) + 1; }
      }
    }
    const spanStart = /^span\s+(\d+)$/.exec(startValue);
    const spanEnd = /^span\s+(\d+)$/.exec(endValue);
    if (start && !end) end = start + Number(spanEnd?.[1] || 1);
    if (end && !start) start = end - Number(spanStart?.[1] || 1);
    result[axis] = start > 0 && end > start ? { start, end } : null;
    result[`${axis}Raw`] = fields[axis].join(' / ');
  }
  return result;
}

function placedStyle(position, rowStart) {
  const rowSpan = position.row ? position.row.end - position.row.start : 1;
  return {
    'grid-area': null,
    'grid-row-start': null, 'grid-row-end': null,
    'grid-column-start': null, 'grid-column-end': null,
    'grid-row': `${rowStart} / ${rowStart + rowSpan}`,
    'grid-column': position.column
      ? `${position.column.start} / ${position.column.end}` : position.columnRaw,
  };
}

function patchClone(node, style) {
  node.style = { ...node.style, ...style };
  for (const key of Object.keys(node.style)) if (node.style[key] === null) delete node.style[key];
}

function duplicateSignature(node) {
  if (Array.isArray(node)) return node.map(duplicateSignature);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.keys(node).sort()
    .filter(key => !['id', 'group_id', 'binding'].includes(key) && !/^data-(?:.*-)?id$/i.test(key))
    .map(key => [key, duplicateSignature(node[key])]));
}

function insertionLayout(document, originals, copies) {
  const parent = layoutParent(document, originals[0]);
  const display = parent?.style?.display || '';
  if (!['grid', 'inline-grid', 'flex', 'inline-flex'].includes(display)) return [];
  const sourceBoxes = originals.flatMap(node => node.style?.display === 'contents' ? boxChildren(node) : [node]);
  const copyBoxes = copies.flatMap(node => node.style?.display === 'contents' ? boxChildren(node) : [node]);
  const items = boxChildren(parent);
  if (display.includes('flex')) {
    // A display:contents subtree can have several differently ordered boxes.
    // Insert its complete copy after the last source box, not interleaved.
    if (sourceBoxes.length < 2) return [];
    const visual = items.map((node, index) => ({ node, index, order: Number(node.style?.order || 0) }))
      .sort((a, b) => a.order - b.order || a.index - b.index).map(item => item.node);
    const selected = new Set(sourceBoxes.map(node => node.id));
    const last = Math.max(...visual.map((node, index) => selected.has(node.id) ? index : -1));
    visual.splice(last + 1, 0, ...copyBoxes);
    const newIds = new Set(copyBoxes.map(node => node.id));
    return visual.flatMap((node, order) => {
      if (newIds.has(node.id)) { patchClone(node, { order: String(order) }); return []; }
      return String(node.style?.order || '0') === String(order) ? []
        : [{ op: 'set_style', node_id: node.id, style: { order: String(order) } }];
    });
  }
  const positions = items.map(node => ({ node, position: placement(parent, node) }));
  // Older versions may have already saved identical copies on the same cell.
  // Keep every copy, but allocate each a visible row in this same undoable
  // transaction. Do not move intentional layers with different content.
  const signatures = new Set();
  let freeRow = Math.max(1, ...positions.map(item => item.position.row?.end || 1));
  for (const item of positions) {
    if (!item.position.row || !item.position.column) continue;
    const signature = JSON.stringify([item.position.row, item.position.column, duplicateSignature(item.node)]);
    if (signatures.has(signature)) {
      const span = item.position.row.end - item.position.row.start;
      item.position.row = { start: freeRow, end: freeRow + span };
      item.relocated = true;
      freeRow += span;
    } else signatures.add(signature);
  }
  const selected = sourceBoxes.map(node => positions.find(item => item.node.id === node.id)?.position
    || placement(parent, node));
  // Auto-placed grid items already receive their own free cells from CSS.
  if (!selected.some(position => position.row)) return [];
  const start = Math.min(...selected.filter(p => p.row).map(p => p.row.start));
  let boundary = Math.max(...selected.filter(p => p.row).map(p => p.row.end));
  // Do not split a neighboring spanning cell: insert below its closed row band.
  for (;;) {
    const next = Math.max(boundary, ...positions.filter(p => p.position.row
      && p.position.row.start < boundary).map(p => p.position.row.end));
    if (next === boundary) break;
    boundary = next;
  }
  const height = Math.max(...selected.map(p => p.row ? p.row.end - start : 1));
  const operations = positions.filter(p => p.relocated || p.position.row?.start >= boundary)
    .map(({ node, position }) => ({
      op: 'set_style', node_id: node.id,
      style: placedStyle(position, position.row.start + (position.row.start >= boundary ? height : 0)),
    }));
  copyBoxes.forEach((node, index) => {
    const position = selected[index];
    patchClone(node, placedStyle(position, boundary + (position.row ? position.row.start - start : 0)));
  });
  return operations;
}

function removalLayout(document, removed) {
  const parent = layoutParent(document, removed[0]);
  if (!['grid', 'inline-grid'].includes(parent?.style?.display)) return [];
  const boxes = removed.flatMap(node => node.style?.display === 'contents' ? boxChildren(node) : [node]);
  const ids = new Set(boxes.map(node => node.id));
  const deleted = boxes.map(node => placement(parent, node).row).filter(Boolean);
  if (!deleted.length) return [];
  const remaining = boxChildren(parent).filter(node => !ids.has(node.id))
    .map(node => ({ node, position: placement(parent, node) }));
  // Only close rows whose last occupying box was removed. Shared rows stay put.
  const empty = [...new Set(deleted.flatMap(row =>
    Array.from({ length: Math.min(row.end - row.start, 1000) }, (_, i) => row.start + i)))]
    .filter(row => !remaining.some(item => item.position.row
      && item.position.row.start <= row && item.position.row.end > row));
  return remaining.flatMap(({ node, position }) => {
    if (!position.row) return [];
    const offset = empty.filter(row => row < position.row.start).length;
    return offset ? [{ op: 'set_style', node_id: node.id,
      style: placedStyle(position, position.row.start - offset) }] : [];
  });
}

module.exports = { insertionLayout, removalLayout };
