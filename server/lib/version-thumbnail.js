'use strict';
/**
 * 历史版本第一页缩略图。
 *
 * - 文件导入版本优先复用导入时的第一页预览，保持原页面效果；
 * - 其他版本优先把冻结版本的 PDF 第一页栅格化；
 * - Poppler 不可用时生成由真实正文密度和排版色彩驱动的安全降级图；
 * - 结果作为 version thumbnail artifact 持久化，旧版本按需补生成。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sharp = require('sharp');

const db = require('./db');
const { uuidv7, nowIso, sha256 } = require('./util');
const { getObject, putObject } = require('./storage');
const { renderPdf } = require('./render/pdf');
const ResumeDom = require('../../resume-dom');

const execFileAsync = promisify(execFile);
const WIDTH = 240;
const HEIGHT = 340;
const inFlight = new Map();

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch (_) {
    return fallback;
  }
}

function existingThumbnail(versionId, ownerId) {
  return db.get(
    `SELECT * FROM artifacts
     WHERE version_id = ? AND owner_id = ? AND type = 'thumbnail' AND status = 'ready'
     ORDER BY created_at DESC LIMIT 1`,
    [versionId, ownerId],
  );
}

function importedPreview(versionId, ownerId) {
  return db.get(
    `SELECT artifacts.*
     FROM document_imports
     JOIN artifacts ON artifacts.document_import_id = document_imports.id
     WHERE document_imports.applied_version_id = ?
       AND document_imports.owner_id = ?
       AND artifacts.owner_id = ?
       AND artifacts.type = 'import_preview_1'
       AND artifacts.status = 'ready'
     ORDER BY artifacts.created_at DESC LIMIT 1`,
    [versionId, ownerId, ownerId],
  );
}

async function normalizeImage(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({
      width: WIDTH,
      height: HEIGHT,
      fit: 'contain',
      background: '#ffffff',
      withoutEnlargement: false,
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function rasterizePdf(buffer) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-version-thumbnail-'));
  const inputPath = path.join(workDir, 'version.pdf');
  const outputPrefix = path.join(workDir, 'page');
  const outputPath = `${outputPrefix}.png`;
  try {
    fs.writeFileSync(inputPath, buffer, { mode: 0o600 });
    await execFileAsync(
      'pdftoppm',
      [
        '-f',
        '1',
        '-l',
        '1',
        '-singlefile',
        '-png',
        '-scale-to-x',
        String(WIDTH),
        '-scale-to-y',
        '-1',
        inputPath,
        outputPrefix,
      ],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
    );
    return normalizeImage(fs.readFileSync(outputPath));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function safeAccent(templatePayload) {
  const accent =
    templatePayload
    && templatePayload.schema
    && templatePayload.schema.typography
    && templatePayload.schema.typography.accent;
  return /^#[0-9a-f]{6}$/i.test(String(accent || '')) ? accent : '#3b6f91';
}

function fallbackSvg(resume, templatePayload) {
  const attached = ResumeDom.attachDocument(resume);
  const blocks = ResumeDom.toRenderBlocks(attached.dom_document);
  const accent = safeAccent(templatePayload);
  const layout = String(
    (templatePayload.schema && templatePayload.schema.layout)
    || (attached.layout_hints && attached.layout_hints.layout)
    || 'classic',
  );
  const twoColumn = /column|modern|sidebar/i.test(layout);
  const text = ResumeDom.plainText(attached.dom_document);
  const lengths = text
    .split(/\n+/)
    .map((line) => line.trim().length)
    .filter(Boolean)
    .slice(0, 24);
  const titleLength = String((blocks.header && blocks.header.title) || '').length;
  const lines = [];
  let y = 48;
  lines.push(`<rect x="24" y="25" width="${Math.min(92, 42 + titleLength * 4)}" height="9" rx="2" fill="#303237"/>`);
  lines.push(`<rect x="24" y="40" width="192" height="2" rx="1" fill="${accent}"/>`);
  lengths.forEach((length, index) => {
    if (y > 314) return;
    const section = index === 0 || index % 5 === 0;
    const columnWidth = twoColumn && index % 3 === 0 ? 62 : 174;
    const x = twoColumn && index % 3 === 0 ? 154 : 24;
    const maxWidth = twoColumn && x > 100 ? 62 : columnWidth;
    const width = Math.max(section ? 44 : 36, Math.min(maxWidth, 28 + length * 3.2));
    lines.push(
      `<rect x="${x}" y="${y}" width="${width}" height="${section ? 5 : 2.6}" rx="1.3" fill="${section ? accent : '#a9adb3'}" opacity="${section ? 0.9 : 0.72}"/>`,
    );
    y += section ? 14 : 9;
  });
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
      <rect width="${WIDTH}" height="${HEIGHT}" fill="#fff"/>
      ${twoColumn ? '<rect x="144" width="96" height="340" fill="#f4f6f8"/>' : ''}
      ${lines.join('')}
    </svg>`,
  );
}

async function createThumbnail(version) {
  const importPreview = importedPreview(version.id, version.owner_id);
  const importBuffer = importPreview && getObject(importPreview.object_key);
  if (importBuffer) {
    return { buffer: await normalizeImage(importBuffer), mimeType: 'image/png' };
  }

  const resume = parseJson(version.resume_payload);
  const templatePayload = parseJson(version.template_payload);
  const pdfArtifact = db.get(
    `SELECT * FROM artifacts
     WHERE version_id = ? AND owner_id = ? AND type = 'pdf' AND status = 'ready'
     ORDER BY created_at DESC LIMIT 1`,
    [version.id, version.owner_id],
  );
  try {
    const storedPdf = pdfArtifact && getObject(pdfArtifact.object_key);
    const pdf = storedPdf || renderPdf({
      resume,
      template: templatePayload.schema ? templatePayload : { schema: {} },
    }).buffer;
    return { buffer: await rasterizePdf(pdf), mimeType: 'image/png' };
  } catch (_) {
    const buffer = await sharp(fallbackSvg(resume, templatePayload))
      .png({ compressionLevel: 9 })
      .toBuffer();
    return { buffer, mimeType: 'image/png' };
  }
}

async function persistThumbnail(version) {
  const ready = existingThumbnail(version.id, version.owner_id);
  if (ready && getObject(ready.object_key)) return ready;

  const generated = await createThumbnail(version);
  const key = `${version.owner_id}/versions/${version.id}-thumbnail.png`;
  putObject(key, generated.buffer);
  if (ready) {
    db.run(
      `UPDATE artifacts
       SET object_key = ?, mime_type = ?, size = ?, sha256 = ?, status = 'ready', expires_at = NULL
       WHERE id = ?`,
      [
        key,
        generated.mimeType,
        generated.buffer.length,
        sha256(generated.buffer),
        ready.id,
      ],
    );
  } else {
    db.run(
      `INSERT OR IGNORE INTO artifacts
       (id, snapshot_id, version_id, document_import_id, owner_id, type, object_key,
        mime_type, size, sha256, status, expires_at, created_at)
       VALUES (?, NULL, ?, NULL, ?, 'thumbnail', ?, ?, ?, ?, 'ready', NULL, ?)`,
      [
        uuidv7(),
        version.id,
        version.owner_id,
        key,
        generated.mimeType,
        generated.buffer.length,
        sha256(generated.buffer),
        nowIso(),
      ],
    );
  }
  const artifact = existingThumbnail(version.id, version.owner_id);
  const refs = parseJson(version.artifact_refs_json);
  if (artifact && refs.thumbnail !== artifact.id) {
    db.run('UPDATE resume_versions SET artifact_refs_json = ? WHERE id = ?', [
      JSON.stringify({ ...refs, thumbnail: artifact.id }),
      version.id,
    ]);
  }
  return artifact;
}

function ensureVersionThumbnail(version) {
  const key = `${version.owner_id}:${version.id}`;
  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      persistThumbnail(version).finally(() => inFlight.delete(key)),
    );
  }
  return inFlight.get(key);
}

module.exports = {
  WIDTH,
  HEIGHT,
  ensureVersionThumbnail,
  fallbackSvg,
};
