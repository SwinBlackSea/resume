'use strict';

const sharp = require('sharp');
const ResumeDom = require('../../../resume-dom');
const { problem } = require('../util');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_IMAGES = 100;

// Resolve only owned immutable resources or embedded raster data. Never let a
// renderer fetch arbitrary URLs, cookies, filesystem paths or another owner.
async function prepareDocumentImages(resume, ownerId) {
  const document = ResumeDom.toResumeDocument(resume);
  const images = new Map();
  const decoded = new Map();
  let bytes = 0, projectedBytes = 0;
  async function visit(node) {
    if (node.type !== 'element') return;
    if (node.attributes?.['data-editor-only'] === 'true') return;
    if (node.tag === 'img') {
      if (images.size >= MAX_IMAGES) throw problem.unprocessable('DOCUMENT_IMAGES_LIMIT', '简历图片过多，请减少后重试');
      const attr = node.attributes || {};
      const id = attr['data-document-asset-id'];
      const scene = attr['data-scene-background-artifact-id'];
      const key = id ? `asset:${id}` : scene ? `scene:${scene}` : String(attr.src || '');
      let value = decoded.get(key);
      if (!value) {
        let original;
        if (id) {
          if (!ownerId) throw problem.notFound('无权读取简历图片');
          original = require('../document-assets').readDocumentAsset(id, ownerId).buffer;
        } else if (scene) {
          if (!ownerId) throw problem.notFound('无权读取简历图片');
          const row = require('../db').get(
            "SELECT object_key FROM artifacts WHERE id=? AND owner_id=? AND status='ready'", [scene, ownerId]);
          original = row && require('../storage').getObject(row.object_key);
        } else {
          const match = /^data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(key);
          if (match && match[1].length <= Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024) {
            original = Buffer.from(match[1], 'base64');
          }
        }
        if (!original?.length || original.length > MAX_IMAGE_BYTES) {
          throw problem.unprocessable('DOCUMENT_IMAGE_UNAVAILABLE', '简历中的图片无法安全读取，请重新添加图片后再导出');
        }
        try {
          const result = await sharp(original, { limitInputPixels: 64 * 1024 * 1024, animated: false })
            .rotate().png().toBuffer({ resolveWithObject: true });
          bytes += result.data.length;
          if (bytes > MAX_TOTAL_BYTES) throw new Error('too large');
          value = { buffer: result.data, mime_type: 'image/png',
            width: result.info.width, height: result.info.height };
        } catch (_) {
          throw problem.unprocessable('DOCUMENT_IMAGE_INVALID', '简历图片无法读取或尺寸过大，请重新添加后再导出');
        }
        decoded.set(key, value);
      }
      // Reused resources share decoded bytes, but HTML embeds each occurrence.
      // Bound that expansion before allocating repeated base64 strings.
      projectedBytes += 4 * Math.ceil(value.buffer.length / 3);
      if (projectedBytes > MAX_TOTAL_BYTES) {
        throw problem.unprocessable('DOCUMENT_IMAGES_LIMIT', '简历中的图片总量过大，请减少图片或降低分辨率后导出');
      }
      images.set(node.id, value);
      node.attributes = { ...attr, src: `data:image/png;base64,${value.buffer.toString('base64')}` };
      if (scene) {
        node.attributes.class = [attr.class || '', 'scene-loaded'].join(' ');
      }
    }
    for (const child of node.children || []) await visit(child);
  }
  await visit(document.root);
  return { document, images };
}

module.exports = { prepareDocumentImages, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES };
