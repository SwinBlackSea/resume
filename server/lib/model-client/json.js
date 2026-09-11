'use strict';

function balancedObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          json: text.slice(start, index + 1),
          end: index,
        };
      }
      if (depth < 0) return null;
    }
  }
  return null;
}

function jsonObjectCandidates(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const candidates = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf('{', cursor);
    if (start < 0) break;
    const balanced = balancedObjectAt(raw, start);
    if (!balanced) break;
    candidates.push(balanced.json);
    cursor = balanced.end + 1;
  }
  return candidates;
}

function extractJsonObject(text) {
  const candidates = jsonObjectCandidates(text);
  const valid = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        valid.push(candidate);
      }
    } catch (_) {
      // 继续检查正文中下一个闭合对象。
    }
  }
  return valid.length === 1 ? valid[0] : null;
}

function parseJsonObject(text) {
  const extracted = extractJsonObject(text);
  return extracted ? JSON.parse(extracted) : null;
}

module.exports = {
  balancedObjectAt,
  extractJsonObject,
  parseJsonObject,
};
