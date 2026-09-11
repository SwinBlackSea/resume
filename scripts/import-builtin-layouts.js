#!/usr/bin/env node
'use strict';
// Explicit, reviewable network import. Never run during application startup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const destination = path.resolve(__dirname, '../assets/builtin-layouts');
const reactive = 'amruthpillai/reactive-resume';
const resumake = 'saadq/resumake.io';
const current = '730f795073126e850cab348038f9557da6f810fd';
const v4 = '91c8624d8043fdb78424d4a1641b2fc3efdbd016';
const v3 = 'a293d209de5dbafeba2c587cb85b5fca2e225cdb';
const remake = '078e8a1f660a57ced716c3d38888f1b164d188ac';
const definitions = [
  ['azurill', '清雅双栏', '柔和分区，左侧重点', '双栏'],
  ['bronzor', '经典边栏', '侧栏信息与主体经历', '双栏'],
  ['chikorita', '清晰纵向', '干净层次与完整经历', '单栏'],
  ['ditgar', '沉稳分区', '宽窄分栏，明确分组', '双栏'],
  ['ditto', '留白叙事', '轻盈留白，突出经历', '单栏'],
  ['gengar', '重点侧栏', '信息索引与经历正文', '双栏'],
  ['glalie', '利落模块', '清楚标题与分区', '单栏'],
  ['kakuna', '理性排版', '规整内容与紧凑层次', '单栏'],
  ['lapras', '现代履历', '标题与信息层次鲜明', '双栏'],
  ['leafish', '轻盈双栏', '主要经历与辅助信息', '双栏'],
  ['meowth', '简练布局', '整洁区块与紧凑信息', '单栏'],
  ['onyx', '极简正文', '专注文字与经历', '单栏'],
  ['pikachu', '鲜明抬头', '个人抬头与内容分区', '双栏'],
  ['rhyhorn', '专业分栏', '分区清楚，信息丰富', '双栏'],
  ['scizor', '细致层次', '条理清晰的经历组织', '单栏'],
].map(([slug, name, detail, category]) => ({
  id: `rr-${slug}`, name, detail, category, upstream_name: slug,
  repository: reactive, commit: current,
  // Use native PDF exports: web jpgs are often only 510px, and even docs
  // images include low-resolution copies. Rasterizing vectors adds real detail.
  source_path: `apps/web/public/templates/pdf/${slug}.pdf`, license_file: 'reactive-resume-2026-MIT.txt',
}));
definitions.push(
  { id: 'rr-castform', name: '经典时间线', detail: '纵向经历与独立信息区', category: '双栏',
    upstream_name: 'castform', repository: reactive, commit: v3,
    source_path: 'client/public/images/templates/castform.jpg', license_file: 'reactive-resume-2022-MIT.txt' },
  { id: 'rr-nosepass', name: '紧凑信息栏', detail: '主次区域与紧凑内容', category: '双栏',
    upstream_name: 'nosepass', repository: reactive, commit: v4,
    source_path: 'apps/client/public/templates/jpg/nosepass.jpg', license_file: 'reactive-resume-2023-MIT.txt' },
  ...[
    [1, '学术经典', '居中抬头与横线章节'],
    [3, '专业简报', '左右抬头与清晰经历'],
    [9, '简洁履历', '紧凑章节与对齐信息'],
  ].map(([number, name, detail]) => ({
    id: `resumake-${number}`, name, detail, category: '单栏', upstream_name: `Template ${number}`,
    repository: resumake, commit: remake, source_path: `app/client/src/features/form/assets/img/${number}.png`,
    license_file: 'resumake-2017-MIT.txt',
  })),
);
const licenses = [
  [reactive, current, 'LICENSE', 'reactive-resume-2026-MIT.txt'],
  [reactive, v3, 'LICENSE', 'reactive-resume-2022-MIT.txt'],
  [reactive, v4, 'LICENSE.md', 'reactive-resume-2023-MIT.txt'],
  [resumake, remake, 'app/client/license', 'resumake-2017-MIT.txt'],
];
async function download(repository, commit, sourcePath) {
  const url = `https://raw.githubusercontent.com/${repository}/${commit}/${sourcePath}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 20 * 1024 * 1024) throw new Error(`Oversized input: ${url}`);
  return { buffer, url };
}
async function main() {
  fs.mkdirSync(path.join(destination, 'licenses'), { recursive: true });
  for (const [repository, commit, sourcePath, filename] of licenses) {
    const { buffer } = await download(repository, commit, sourcePath);
    if (!buffer.toString('utf8').includes('Permission is hereby granted')) throw new Error('Unexpected license');
    fs.writeFileSync(path.join(destination, 'licenses', filename), buffer);
  }
  const items = [];
  for (const item of definitions) {
    const downloaded = await download(item.repository, item.commit, item.source_path);
    const url = downloaded.url;
    let buffer = downloaded.buffer, sourceMetadata = {};
    if (item.source_path.endsWith('.pdf')) {
      if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('Expected source PDF');
      const sourceFilename = `${item.id}.source.pdf`;
      fs.writeFileSync(path.join(destination, sourceFilename), buffer);
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-layout-raster-'));
      try {
        const pdfPath = path.join(destination, sourceFilename);
        const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8', timeout: 15000 });
        const pageCount = Number(info.match(/^Pages:\s+(\d+)/m)?.[1] || 0);
        if (!pageCount) throw new Error('Cannot determine source PDF pages');
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '200', '-png',
          pdfPath, path.join(temporary, 'first-page')], { timeout: 30000, maxBuffer: 1024 * 1024 });
        sourceMetadata = { source_filename: sourceFilename,
          source_sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
          source_page_count: pageCount, image_transformation: 'Native PDF first page rendered by Poppler pdftoppm at 200 DPI; no raster upscaling.' };
        buffer = fs.readFileSync(path.join(temporary, 'first-page.png'));
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }
    const metadata = await sharp(buffer, { limitInputPixels: 64000000 }).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error(`Unexpected image: ${item.id}`);
    const filename = `${item.id}${metadata.format === 'jpeg' ? '.jpg' : metadata.format === 'webp' ? '.source.webp' : '.png'}`;
    fs.writeFileSync(path.join(destination, filename), buffer);
    const thumbnail = await sharp(buffer).resize({ width: 440, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    fs.writeFileSync(path.join(destination, `${item.id}.webp`), thumbnail);
    items.push({ ...item, ...sourceMetadata, license: 'MIT', source_url: url, filename,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      width: metadata.width, height: metadata.height,
      mime_type: metadata.format === 'jpeg' ? 'image/jpeg' : metadata.format === 'webp' ? 'image/webp' : 'image/png',
      preview_filename: `${item.id}.webp`,
      preview_sha256: crypto.createHash('sha256').update(thumbnail).digest('hex'),
      preview_transformation: 'Display image resized to maximum 440px width, WebP quality 82.',
    });
    console.log(`${item.id}: ${metadata.width} × ${metadata.height}`);
  }
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({
    version: 1, downloaded_at: '2026-09-10', purpose: 'Layout references only; example identities, facts and portraits are not applicant materials.',
    items,
  }, null, 2) + '\n');
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
