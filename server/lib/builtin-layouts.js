'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { problem } = require('./util');
const directory = path.resolve(__dirname, '../../assets/builtin-layouts');
const manifest = require('../../assets/builtin-layouts/manifest.json');
const byId = new Map(manifest.items.map((item) => [item.id, Object.freeze(item)]));
const verified = new Map();
function getBuiltinLayout(id) { return byId.get(id) || null; }
function listBuiltinLayouts() {
  return manifest.items.map((item) => ({
    id: item.id, name: item.name, detail: item.detail, category: item.category,
    upstream_name: item.upstream_name,
    preview_url: `/api/v1/home/layouts/${item.id}/image?size=preview&v=${item.preview_sha256.slice(0, 16)}`,
    image_url: `/api/v1/home/layouts/${item.id}/image?v=${item.sha256.slice(0, 16)}`,
    width: item.width, height: item.height,
    attribution: item.repository === 'saadq/resumake.io' ? 'Resumake · MIT' : 'Reactive Resume · MIT',
  }));
}
function readBuiltinReferenceImage(id, { preview = false } = {}) {
  const item = getBuiltinLayout(id);
  if (!item) throw problem.notFound('简历样式不存在');
  const filename = preview ? item.preview_filename : item.filename;
  const expectedHash = preview ? item.preview_sha256 : item.sha256;
  const cacheKey = `${id}:${preview}`;
  if (!verified.has(cacheKey)) {
    let buffer;
    try { buffer = fs.readFileSync(path.join(directory, filename)); } catch (_) {
      throw problem.conflict('LAYOUT_REFERENCE_UNAVAILABLE', '该样式暂时无法读取，请选择其他样式');
    }
    if (crypto.createHash('sha256').update(buffer).digest('hex') !== expectedHash) {
      throw problem.conflict('LAYOUT_REFERENCE_INVALID', '该样式文件校验失败，请选择其他样式');
    }
    verified.set(cacheKey, buffer);
  }
  return { buffer: verified.get(cacheKey), mime_type: preview ? 'image/webp' : item.mime_type,
    width: item.width, height: item.height, sha256: expectedHash };
}
module.exports = { getBuiltinLayout, listBuiltinLayouts, readBuiltinReferenceImage };
