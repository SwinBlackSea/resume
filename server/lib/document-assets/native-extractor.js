'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yauzl = require('yauzl');
const sharp = require('sharp');
const { XMLParser } = require('fast-xml-parser');
const { objectPath } = require('../storage');
const { problem } = require('../util');
const { runCommand } = require('../document-recognition/command');
const { pythonPath } = require('../document-recognition/ocr');
const { convertDoc } = require('../document-recognition/docx');

function readImageEntries(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(problem.badRequest('Word 图片无法读取'));
    const entries = new Map();
    let expanded = 0;
    let failed = false;
    const fail = (err) => { if (!failed) { failed = true; zip.close(); reject(err); } };
    zip.on('error', fail);
    zip.on('end', () => { if (!failed) resolve(entries); });
    zip.on('entry', (entry) => {
      expanded += entry.uncompressedSize;
      if (expanded > 100 * 1024 * 1024 || entry.generalPurposeBitFlag & 1
        || path.posix.normalize(entry.fileName).startsWith('../')) {
        return fail(problem.badRequest('Word 图片结构不安全或文件过大'));
      }
      if (!/^word\/(?:media\/[^/]+|(?:document|header\d+|footer\d+)\.xml|_rels\/(?:document|header\d+|footer\d+)\.xml\.rels)$/.test(entry.fileName)) {
        return zip.readEntry();
      }
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError) return fail(streamError);
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', fail);
        stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.readEntry();
  }));
}
function allNodes(value, key, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (Object.hasOwn(value, key)) result.push(...(Array.isArray(value[key]) ? value[key] : [value[key]]));
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => allNodes(item, key, result));
    else if (typeof child === 'object') allNodes(child, key, result);
  }
  return result;
}
async function applyDisplayedCrop(buffer, { l, t, r, b }) {
  if ([l, t, r, b].some(v => !Number.isFinite(v) || Math.abs(v) > 4) || l + r >= 1 || t + b >= 1) {
    throw problem.badRequest('Word 照片裁剪参数无效');
  }
  if (!(l || t || r || b)) return buffer;
  const metadata = await sharp(buffer).metadata();
  const left = Math.round(l * metadata.width), top = Math.round(t * metadata.height);
  const right = Math.round((1 - r) * metadata.width), bottom = Math.round((1 - b) * metadata.height);
  const width = right - left, height = bottom - top;
  if (width < 1 || height < 1 || width * height > 64 * 1024 * 1024) {
    throw problem.badRequest('Word 照片裁剪尺寸无效或过大');
  }
  const padding = { left: Math.max(0, -left), top: Math.max(0, -top),
    right: Math.max(0, right - metadata.width), bottom: Math.max(0, bottom - metadata.height) };
  // OOXML permits negative crop percentages (canvas extension), and supports
  // both integer thousandth-percent and lexical "12.5%" representations.
  let pipeline = sharp(buffer);
  if (Object.values(padding).some(Boolean)) pipeline = pipeline.extend({ ...padding, background: '#ffffff00' });
  return pipeline.extract({ left: left + padding.left, top: top + padding.top, width, height }).png().toBuffer();
}
async function docxImages(file) {
  const entries = await readImageEntries(file);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', processEntities: false });
  const images = [];
  for (const [name, bytes] of entries) {
    if (!/^word\/(?:document|header\d+|footer\d+)\.xml$/.test(name)) continue;
    const relationships = entries.get(`word/_rels/${path.posix.basename(name)}.rels`);
    if (!relationships) continue;
    const rels = new Map(allNodes(parser.parse(relationships.toString()), 'Relationship')
      .filter((rel) => rel.TargetMode !== 'External')
      .map((rel) => [rel.Id, path.posix.normalize(path.posix.join('word', rel.Target || ''))]));
    const document = parser.parse(bytes.toString());
    const drawings = allNodes(document, 'w:drawing');
    for (const drawing of drawings) {
      const blip = allNodes(drawing, 'a:blip')[0];
      const target = blip && rels.get(blip['r:embed']);
      if (!target || !target.startsWith('word/media/') || !entries.has(target)) continue;
      if (images.length >= 24) throw problem.badRequest('Word 图片过多，请单独上传需要的照片');
      let buffer;
      try { buffer = await sharp(entries.get(target), { limitInputPixels: 64 * 1024 * 1024 }).rotate().png().toBuffer(); }
      catch (_) { throw problem.badRequest('Word 包含无法提取的图片格式，请另行上传照片'); }
      const rect = allNodes(drawing, 'a:srcRect')[0];
      const transform = allNodes(drawing, 'a:xfrm')[0] || {};
      const rotation = Number(transform.rot || 0) / 60000;
      if (rect) {
        const percent = (value) => String(value || '').endsWith('%')
          ? Number(String(value).slice(0, -1)) / 100 : Number(value || 0) / 100000;
        buffer = await applyDisplayedCrop(buffer, {
          l: percent(rect.l), t: percent(rect.t), r: percent(rect.r), b: percent(rect.b),
        });
      }
      if (['1', 'true'].includes(String(transform.flipH))) buffer = await sharp(buffer).flop().png().toBuffer();
      if (['1', 'true'].includes(String(transform.flipV))) buffer = await sharp(buffer).flip().png().toBuffer();
      if (rotation) buffer = await sharp(buffer).rotate(rotation, { background: '#ffffff00' }).png().toBuffer();
      const extent = allNodes(drawing, 'wp:extent')[0];
      images.push({ buffer, kind: 'embedded_image', placement: {
        container: path.posix.basename(name), order: images.length,
        ...(extent ? { width_emu: Number(extent.cx), height_emu: Number(extent.cy) } : {}),
      } });
    }
    // Legacy VML images appear in otherwise modern DOCX and converted DOC.
    for (const image of allNodes(document, 'v:imagedata')) {
      const target = rels.get(image['r:id']);
      if (!target || !entries.has(target)) continue;
      if (images.length >= 24) throw problem.badRequest('Word 图片过多，请单独上传需要的照片');
      let buffer = await sharp(entries.get(target), { limitInputPixels: 64 * 1024 * 1024 }).rotate().png().toBuffer();
      const fraction = (value) => String(value || '').endsWith('f')
        ? Number(String(value).slice(0, -1)) / 65536 : Number(value || 0);
      const l = fraction(image.cropleft), t = fraction(image.croptop);
      const r = fraction(image.cropright), b = fraction(image.cropbottom);
      buffer = await applyDisplayedCrop(buffer, { l, t, r, b });
      images.push({ buffer, kind: 'embedded_image', placement: { container: path.posix.basename(name), order: images.length } });
    }
  }
  return images;
}
async function extractNativeImages(upload) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-images-'));
  try {
    const inputPath = objectPath(upload.object_key);
    if (upload.mime_type === 'application/pdf') {
      const { stdout } = await runCommand(pythonPath(),
        [path.join(__dirname, 'pdf_images.py'), inputPath, workDir],
        { cwd: workDir, timeout: 90000, maxBuffer: 1024 * 1024, errorCode: 'DOCUMENT_IMAGES_FAILED' });
      const result = JSON.parse(stdout.trim());
      return result.images.map((image) => ({
        buffer: fs.readFileSync(path.join(workDir, image.file)), kind: image.kind,
        page: image.page, placement: image.placement,
      }));
    }
    let file = inputPath;
    if (upload.mime_type === 'application/msword') file = await convertDoc(inputPath, workDir);
    return await docxImages(file);
  } finally {
    // Exact freshly-created, local temporary directory; never user uploads.
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
module.exports = { extractNativeImages, docxImages, readImageEntries };
