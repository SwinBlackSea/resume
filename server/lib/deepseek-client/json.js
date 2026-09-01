'use strict';

/**
 * 从模型正文中提取 JSON。只解析 content，不读取 reasoning_content，
 * 避免把模型内部推理当作可执行结果。
 */
function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{')) return raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : null;
}

function parseJsonObject(text) {
  const extracted = extractJsonObject(text);
  if (!extracted) return null;
  try {
    const parsed = JSON.parse(extracted);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

module.exports = { extractJsonObject, parseJsonObject };
