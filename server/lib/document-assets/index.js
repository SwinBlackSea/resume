'use strict';

const crypto = require('node:crypto');
const sharp = require('sharp');
const db = require('../db');
const { getObject, putObject, removeObject } = require('../storage');
const { problem, uuidv7, nowIso } = require('../util');
const PARSER_VERSION = 'document-images-v1';
const MAX_PIXELS = 64 * 1024 * 1024;
const inFlight = new Map();
let activeNativeParsers = 0;
const nativeWaiters = [];
async function extractWithSlot(upload) {
  if (activeNativeParsers >= 2) {
    if (nativeWaiters.length >= 16) throw problem.conflict('IMAGE_PARSER_BUSY', '图片处理繁忙，请稍后重试');
    await new Promise(resolve => nativeWaiters.push(resolve));
  } else activeNativeParsers += 1;
  try { return await require('./native-extractor').extractNativeImages(upload); }
  finally {
    const next = nativeWaiters.shift();
    if (next) next(); else activeNativeParsers -= 1;
  }
}
function recognizedPageFallback(upload, ownerId) {
  const imported = db.get(`SELECT preview_artifact_ids FROM document_imports
    WHERE upload_id = ? AND owner_id = ? AND status IN ('ready','needs_review','applied','validating')
    ORDER BY updated_at DESC LIMIT 1`, [upload.id, ownerId]);
  if (!imported) return [];
  const ids = JSON.parse(imported.preview_artifact_ids || '[]');
  return ids.map((id, index) => {
    const row = db.get("SELECT * FROM artifacts WHERE id = ? AND owner_id = ? AND status = 'ready'", [id, ownerId]);
    const buffer = row && getObject(row.object_key);
    return buffer ? { buffer, kind: 'page_reference', page: index + 1,
      existingObjectKey: row.object_key, fallback_reason: 'native_images_unavailable' } : null;
  }).filter(Boolean);
}
const derivativeCache = new Map();
let derivativeBytes = 0;
const DERIVATIVE_CACHE_BYTES = 16 * 1024 * 1024;
function assetIdFromUrl(value) {
  if (typeof value !== 'string') return null;
  return value.match(/^\/api\/v1\/document-assets\/([a-zA-Z0-9-]+)\/content$/)?.[1] || null;
}

function descriptor(row) {
  return { id: row.id, mime_type: row.mime_type, width: row.width, height: row.height,
    url: `/api/v1/document-assets/${row.id}/content` };
}
function readDocumentAsset(id, ownerId) {
  const row = db.get('SELECT * FROM document_assets WHERE id = ? AND owner_id = ?', [id, ownerId]);
  if (!row) throw problem.notFound('简历图片不存在或无权读取');
  const buffer = getObject(row.object_key);
  if (!buffer) throw problem.notFound('简历图片文件暂不可用');
  if (crypto.createHash('sha256').update(buffer).digest('hex') !== row.sha256) {
    throw problem.conflict('DOCUMENT_IMAGE_CORRUPTED', '简历图片文件校验失败，请重新上传');
  }
  return { ...descriptor(row), buffer };
}
async function storeImage(buffer, ownerId, { existingObjectKey } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 20 * 1024 * 1024) {
    throw problem.badRequest('图片为空或超过 20 MB');
  }
  let metadata;
  try { metadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS, animated: false }).metadata(); }
  catch (_) { throw problem.badRequest('图片无法读取或分辨率过大'); }
  if (!['png', 'jpeg', 'webp'].includes(metadata.format)) throw problem.badRequest('不支持此图片格式');
  // Original bytes are immutable, EXIF orientation is retained and consistently
  // resolved by all crop/model paths. Direct photos can reuse the upload object.
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const previous = db.get('SELECT * FROM document_assets WHERE owner_id = ? AND sha256 = ?', [ownerId, digest]);
  if (previous) return descriptor(previous);
  const rotated = [5, 6, 7, 8].includes(metadata.orientation);
  const id = uuidv7();
  const key = existingObjectKey || `${ownerId}/document-assets/${digest}.${metadata.format}`;
  if (!existingObjectKey) putObject(key, buffer);
  db.run(`INSERT OR IGNORE INTO document_assets
    (id,owner_id,sha256,object_key,mime_type,width,height,byte_size,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  [id, ownerId, digest, key, `image/${metadata.format}`, rotated ? metadata.height : metadata.width,
    rotated ? metadata.width : metadata.height, buffer.length, nowIso()]);
  return descriptor(db.get('SELECT * FROM document_assets WHERE owner_id = ? AND sha256 = ?', [ownerId, digest]));
}
function authorizedUpload(id, { ownerId, projectId, conversationId }) {
  if (projectId && !db.get('SELECT id FROM resume_projects WHERE id = ? AND owner_id = ?', [projectId, ownerId])) {
    throw problem.notFound('简历不存在');
  }
  const upload = db.get('SELECT * FROM uploads WHERE id = ? AND owner_id = ?', [id, ownerId]);
  if (!upload || upload.status !== 'ready') throw problem.notFound('附件不可用，请重新上传');
  if (upload.chat_conversation_id && upload.chat_conversation_id !== conversationId) {
    throw problem.badRequest('图片属于另一段对话');
  }
  return upload;
}
async function prepareUploadImages(uploadId, options) {
  const upload = authorizedUpload(uploadId, options);
  const key = `${options.ownerId}:${uploadId}:${upload.sha256}:${PARSER_VERSION}`;
  const cached = db.get(`SELECT * FROM document_image_cache WHERE owner_id = ? AND upload_id = ?
    AND parser_version = ? AND input_sha256 = ?`, [options.ownerId, uploadId, PARSER_VERSION, upload.sha256]);
  if (cached) {
    const candidates = JSON.parse(cached.candidates_json);
    if (candidates.every((item) => db.get('SELECT id FROM document_assets WHERE id = ? AND owner_id = ?', [item.asset_id, options.ownerId]))) {
      db.run('UPDATE document_image_cache SET accessed_at = ? WHERE owner_id = ? AND upload_id = ? AND parser_version = ?',
        [nowIso(), options.ownerId, uploadId, PARSER_VERSION]);
      return candidates;
    }
  }
  if (inFlight.has(key)) return inFlight.get(key);
  if (inFlight.size >= 32) throw problem.conflict('IMAGE_PARSER_BUSY', '图片处理繁忙，请稍后重试');
  const pending = (async () => {
    const bytes = getObject(upload.object_key);
    if (!bytes) throw problem.notFound('附件文件已不存在');
    let extracted;
    if (upload.mime_type.startsWith('image/')) {
      extracted = [{ buffer: bytes, kind: 'uploaded_image', existingObjectKey: upload.object_key }];
    } else {
      try { extracted = await extractWithSlot(upload); }
      catch (error) {
        // A successfully recognized page already preserves unsupported Word
        // artwork. Reuse its bounded preview, not another OCR/model call.
        extracted = recognizedPageFallback(upload, options.ownerId);
        if (!extracted.length) throw error;
      }
    }
    if (extracted.length > 24) throw problem.badRequest('附件图片过多，请单独上传需要的照片');
    const candidates = [];
    let totalBytes = 0;
    for (const item of extracted) {
      totalBytes += item.buffer.length;
      if (totalBytes > 80 * 1024 * 1024) throw problem.badRequest('附件图片总量过大，请单独上传需要的照片');
      const asset = await storeImage(item.buffer, options.ownerId, item);
      candidates.push({ input_image_id: `${uploadId}:${candidates.length + 1}`, asset_id: asset.id,
        upload_id: uploadId, kind: item.kind, width: asset.width, height: asset.height,
        ...(item.page ? { page: item.page } : {}),
        ...(item.placement ? { placement: item.placement } : {}),
        ...(item.crop ? { displayed_crop: item.crop } : {}),
        ...(item.rotation ? { displayed_rotation: item.rotation } : {}) });
    }
    db.run(`INSERT INTO document_image_cache
      (owner_id,upload_id,input_sha256,parser_version,candidates_json,created_at,accessed_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner_id,upload_id,parser_version) DO UPDATE SET
      input_sha256=excluded.input_sha256,candidates_json=excluded.candidates_json,accessed_at=excluded.accessed_at`,
    [options.ownerId, uploadId, upload.sha256, PARSER_VERSION, JSON.stringify(candidates), nowIso(), nowIso()]);
    return candidates;
  })();
  inFlight.set(key, pending);
  try { return await pending; } finally { inFlight.delete(key); }
}
async function modelImage(candidate, ownerId) {
  const asset = readDocumentAsset(candidate.asset_id, ownerId);
  const key = `${ownerId}:${asset.id}`;
  let image = derivativeCache.get(key);
  if (image) { derivativeCache.delete(key); derivativeCache.set(key, image); }
  else {
    image = await sharp(asset.buffer, { limitInputPixels: MAX_PIXELS }).rotate()
      .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#fff' }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
    if (image.data.length <= DERIVATIVE_CACHE_BYTES) {
      if (derivativeCache.has(key)) {
        derivativeBytes -= derivativeCache.get(key).data.length; derivativeCache.delete(key);
      }
      while (derivativeBytes + image.data.length > DERIVATIVE_CACHE_BYTES && derivativeCache.size) {
        const oldest = derivativeCache.keys().next().value;
        derivativeBytes -= derivativeCache.get(oldest).data.length; derivativeCache.delete(oldest);
      }
      derivativeCache.set(key, image); derivativeBytes += image.data.length;
    }
  }
  return { id: candidate.upload_id, ...candidate, mime_type: 'image/jpeg',
    model_width: image.info.width, model_height: image.info.height,
    content_base64: image.data.toString('base64') };
}
async function cropImage(candidate, crop, ownerId) {
  const asset = readDocumentAsset(candidate.asset_id, ownerId);
  if (crop === null || crop === undefined) return descriptor(asset);
  if (!crop || Object.keys(crop).sort().join(',') !== 'height,width,x,y'
    || !Object.values(crop).every(Number.isFinite)
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > 1.000001 || crop.y + crop.height > 1.000001) {
    throw problem.badRequest('照片裁剪范围无效，请重新生成建议');
  }
  const left = Math.round(crop.x * asset.width);
  const top = Math.round(crop.y * asset.height);
  const width = Math.min(asset.width - left, Math.round(crop.width * asset.width));
  const height = Math.min(asset.height - top, Math.round(crop.height * asset.height));
  if (width < 16 || height < 16) throw problem.badRequest('照片裁剪区域过小，请提供清晰图片');
  const buffer = await sharp(asset.buffer, { limitInputPixels: MAX_PIXELS }).rotate()
    .extract({ left, top, width, height }).png().toBuffer();
  return storeImage(buffer, ownerId);
}
function referencedAssetIds(value, ids = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => referencedAssetIds(item, ids));
  else if (value && typeof value === 'object') {
    if (typeof value['data-document-asset-id'] === 'string') ids.add(value['data-document-asset-id']);
    if (typeof value.asset_id === 'string') ids.add(value.asset_id);
    for (const key of ['src', 'url']) {
      const id = assetIdFromUrl(value[key]);
      if (id) ids.add(id);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'assets' && Array.isArray(child)) child.forEach((asset) => { if (asset && asset.id) ids.add(asset.id); });
      else referencedAssetIds(child, ids);
    }
  }
  return ids;
}
function validateDocumentAssets(document, ownerId) {
  const checked = new Set();
  const check = (id) => { if (!checked.has(id)) { readDocumentAsset(id, ownerId); checked.add(id); } };
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    const explicit = value['data-document-asset-id'];
    if (explicit !== undefined) {
      if (typeof explicit !== 'string' || !explicit) throw problem.badRequest('简历图片引用无效');
      check(explicit);
      if (value.src && value.src !== `/api/v1/document-assets/${explicit}/content`) {
        throw problem.badRequest('简历图片地址与图片引用不一致');
      }
    }
    for (const key of ['src', 'url']) {
      if (typeof value[key] !== 'string') continue;
      const id = assetIdFromUrl(value[key]);
      if (id) check(id);
      else if (value[key].startsWith('/api/v1/document-assets/')) throw problem.badRequest('简历图片地址无效');
    }
    if (Array.isArray(value.assets)) {
      for (const asset of value.assets) {
        if (asset?.id && db.get('SELECT id FROM document_assets WHERE id = ?', [asset.id])) check(asset.id);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(document);
  return document;
}
function collectUnusedAssets(ownerId, { graceMs = 24 * 60 * 60 * 1000 } = {}) {
  // Reconcile authoritative persisted references instead of maintaining a
  // fragile second writable reference graph. Fail closed on unreadable JSON.
  const protectedIds = new Set();
  if ([...inFlight.keys()].some((key) => key.startsWith(`${ownerId}:`))
    || db.get(`SELECT id FROM ai_tasks WHERE owner_id = ?
      AND status IN ('understanding','planning','validated') LIMIT 1`, [ownerId])) {
    return { deleted: 0, deferred: true };
  }
  const columns = {
    resume_drafts: ['resume_json'], resume_versions: ['resume_payload'],
    resume_change_events: ['before_json', 'after_json'], change_receipts: ['before_json', 'after_json'],
    generation_snapshots: ['resume_input_payload'], document_imports: ['content_candidate', 'layout_candidate'],
    ai_tasks: ['state_json'], ai_action_requests: ['payload_json'], home_intakes: ['state_json'],
    ai_messages: ['model_metadata_json'],
  };
  try {
    for (const [table, names] of Object.entries(columns)) {
      for (const row of db.all(`SELECT ${names.join(',')} FROM ${table} WHERE owner_id = ?`, [ownerId])) {
        for (const name of names) {
          const payload = JSON.parse(row[name] || '{}');
          referencedAssetIds(payload, protectedIds);
          const proposal = payload.proposal || payload;
          if (proposal.reapply_material) {
            referencedAssetIds(require('../proposal-reapply').readReapply(proposal), protectedIds);
          }
        }
      }
    }
    for (const row of db.all('SELECT * FROM document_image_cache WHERE owner_id = ?', [ownerId])) {
      if (db.get('SELECT id FROM uploads WHERE id = ?', [row.upload_id])) {
        JSON.parse(row.candidates_json).forEach((candidate) => protectedIds.add(candidate.asset_id));
      } else db.run('DELETE FROM document_image_cache WHERE owner_id = ? AND upload_id = ? AND parser_version = ?',
        [ownerId, row.upload_id, row.parser_version]);
    }
  } catch (error) { return { deleted: 0, deferred: true, reason: error.code || 'REFERENCE_SCAN_FAILED' }; }
  let deleted = 0;
  const cutoff = new Date(Date.now() - graceMs).toISOString();
  // nowIso() stores second precision while cutoffs include milliseconds. ISO
  // strings with mixed precision do not sort chronologically within a second.
  for (const row of db.all(`SELECT * FROM document_assets WHERE owner_id = ?
    AND julianday(created_at) <= julianday(?)`, [ownerId, cutoff])) {
    if (protectedIds.has(row.id)) continue;
    if (!db.get('SELECT id FROM uploads WHERE object_key = ?', [row.object_key])
      && !db.get('SELECT id FROM artifacts WHERE object_key = ?', [row.object_key])) removeObject(row.object_key);
    db.run('DELETE FROM document_assets WHERE id = ? AND owner_id = ?', [row.id, ownerId]);
    deleted += 1;
  }
  return { deleted, deferred: false };
}
module.exports = { prepareUploadImages, modelImage, cropImage, readDocumentAsset,
  storeImage, descriptor, referencedAssetIds, validateDocumentAssets, collectUnusedAssets,
  assetIdFromUrl, PARSER_VERSION };
