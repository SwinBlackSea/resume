'use strict';
/**
 * OCR Provider Adapter（TECH §2、§10.1）。
 *
 * 首选云 OCR；未配置时退化为本地文本提取：
 *  - 纯文本类附件（txt / md）直接读取；
 *  - 图片与 PDF 在无 OCR 服务时返回低置信度结果并标记 needs_manual，
 *    由用户修订或粘贴文本（PRD §5.2：OCR 失败保留原图，可重新识别或直接粘贴）。
 * 任何情况下都不臆造岗位原文。
 */
const fs = require('node:fs');
const { getObject, objectPath } = require('./storage');

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'text']);

function extensionOf(name) {
  return (String(name).split('.').pop() || '').toLowerCase();
}

/** 单图 OCR。返回 {text, confidence, needs_manual}。 */
async function recognizeOne({ upload, buffer }) {
  const ext = extensionOf(upload.original_name);

  if (TEXT_EXTENSIONS.has(ext) || (upload.mime_type || '').startsWith('text/')) {
    const content = buffer ? buffer.toString('utf8') : '';
    return {
      text: content.trim(),
      confidence: content ? 0.99 : 0,
      needs_manual: !content,
    };
  }

  // 配置了云 OCR 时走远程（与真实实现保持同一接口）
  const endpoint = process.env.RESUME_OCR_ENDPOINT;
  const apiKey = process.env.RESUME_OCR_API_KEY;
  if (endpoint && apiKey) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          file_name: upload.original_name,
          mime_type: upload.mime_type,
          content_base64: buffer ? buffer.toString('base64') : null,
        }),
      });
      if (!res.ok) throw new Error(`OCR 服务返回 ${res.status}`);
      const body = await res.json();
      return {
        text: String(body.text || '').trim(),
        confidence: typeof body.confidence === 'number' ? body.confidence : 0.8,
        needs_manual: !body.text,
      };
    } catch (err) {
      // 外部服务暂时不可用：返回可重试错误，由 Worker 记录诊断
      const error = new Error(`OCR 服务不可用：${err.message}`);
      error.code = 'PROVIDER_TEMPORARY';
      throw error;
    }
  }

  // 本地兜底：不臆造文本，标记需要人工修订
  return {
    text: '',
    confidence: 0,
    needs_manual: true,
    note: '未配置 OCR 服务，请直接粘贴岗位文字或稍后重新识别',
  };
}

/**
 * 多图 OCR：按文件名自然排序，拼接并去重（TECH §10.1 步骤 3—5）。
 * @returns {{text:string, confidence:number, files:Array, lowConfidence:boolean}}
 */
async function recognizeJobFiles(files) {
  const ordered = [...files].sort((a, b) =>
    String(a.original_name).localeCompare(String(b.original_name), 'zh-CN', { numeric: true }),
  );
  const results = [];
  let totalConfidence = 0;
  let recognized = 0;

  for (const file of ordered) {
    const upload = file.upload;
    let buffer = null;
    try {
      buffer = getObject(upload.object_key);
      if (!buffer && fs.existsSync(objectPath(upload.object_key))) {
        buffer = fs.readFileSync(objectPath(upload.object_key));
      }
    } catch (_) {
      buffer = null;
    }
    const outcome = await recognizeOne({ upload, buffer });
    totalConfidence += outcome.confidence;
    if (outcome.text) recognized += 1;
    results.push({
      file_id: file.id,
      upload_id: upload.id,
      file_name: upload.original_name,
      text: outcome.text,
      confidence: outcome.confidence,
      needs_manual: outcome.needs_manual,
    });
  }

  // 去重：按句子级别去除重复段落
  const seen = new Set();
  const merged = [];
  results.forEach((item) => {
    String(item.text)
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        if (!seen.has(line)) {
          seen.add(line);
          merged.push(line);
        }
      });
  });

  const confidence = ordered.length ? Number((totalConfidence / ordered.length).toFixed(2)) : 0;
  return {
    text: merged.join('\n'),
    confidence,
    files: results,
    lowConfidence: confidence < 0.6 || recognized < ordered.length,
  };
}

module.exports = { recognizeJobFiles, recognizeOne };
