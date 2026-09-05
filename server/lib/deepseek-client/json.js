'use strict';

/**
 * 从模型正文中提取 JSON。只解析 content，不读取 reasoning_content，
 * 避免把模型内部推理当作可执行结果。
 */
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

  // 只扫描同级、互不嵌套的对象。若遇到未闭合的第一个对象立即停止：
  // 它很可能是被截断的顶层响应，绝不能继续把其中某个完整内层对象当作结果。
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
  // 协议只允许一个顶层对象。调试对象、示例对象和最终对象同时出现时，
  // 选择第一个或最后一个都可能执行错误内容，因此统一交给上层重试。
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
