'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 从真实入口读取一次，不另建CSS副本，不把界面按钮样式送给模型。
const entry = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
const stylesheets = Array.from(entry.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
  .map((match) => match[1].replace(/\/\*[\s\S]*?\*\//g, ''));

function documentRenderCss(documents) {
  const classes = new Set(['resume']);
  const ids = new Set(['resume', 'resume-document']);
  function visit(node) {
    if (!node) return;
    String(node.attributes && node.attributes.class || '').split(/\s+/)
      .filter(Boolean).forEach((name) => classes.add(name));
    if (node.attributes && node.attributes.id) ids.add(String(node.attributes.id));
    (node.children || []).forEach(visit);
  }
  documents.filter(Boolean).forEach((document) => visit(document.root));
  function relevant(selector) {
    if (/:(?:hover|focus|active|selection)|data-(?:editor|manual|empty|resume-editable)/.test(selector)) {
      return false;
    }
    if ([':root', '*', 'html', 'body'].includes(selector)) return true;
    const namedClasses = Array.from(selector.matchAll(/\.([a-zA-Z_][\w-]*)/g), (m) => m[1]);
    const namedIds = Array.from(selector.matchAll(/#([a-zA-Z_][\w-]*)/g), (m) => m[1]);
    return (namedClasses.length || namedIds.length)
      && namedClasses.every((name) => classes.has(name))
      && namedIds.every((name) => ids.has(name));
  }
  function filterRules(css) {
    const output = [];
    let start = 0;
    let open = -1;
    let depth = 0;
    let quote = '';
    for (let index = 0; index < css.length; index += 1) {
      const char = css[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '{') {
        if (depth === 0) open = index;
        depth += 1;
      } else if (char === '}' && depth > 0) {
        depth -= 1;
        if (depth !== 0) continue;
        const selector = css.slice(start, open).trim();
        const body = css.slice(open + 1, index);
        if (/^@(?:media|supports|layer)\b/.test(selector)) {
          const nested = filterRules(body);
          if (nested) output.push(`${selector}{${nested}}`);
        } else if (!selector.startsWith('@')) {
          const selected = selector.split(',').map((part) => part.trim()).filter(relevant);
          if (selected.length) output.push(`${selected.join(',')}{${body}}`);
        }
        start = index + 1;
      }
    }
    return output.join('\n');
  }
  return stylesheets.map(filterRules).filter(Boolean).join('\n');
}

module.exports = { documentRenderCss };
