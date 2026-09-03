'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runCommand } = require('./command');
const { pythonPath } = require('./ocr');

function resultPayload(stdout) {
  const line = String(stdout || '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .reverse()
    .find((value) => value.startsWith('{') && value.endsWith('}'));
  return JSON.parse(line || '{}');
}

async function extractPageScene(pdfPath, workDir) {
  const result = await runCommand(
    pythonPath(),
    [path.join(__dirname, 'page_scene_runner.py'), pdfPath, workDir],
    {
      cwd: workDir,
      timeout: Number(process.env.RESUME_DOCUMENT_PAGE_SCENE_TIMEOUT_MS || 180000),
      maxBuffer: 32 * 1024 * 1024,
      errorCode: 'PAGE_SCENE_EXTRACTION_FAILED',
    },
  );
  const scene = resultPayload(result.stdout);
  if (
    scene.version !== 'page-scene-v1'
    || !Array.isArray(scene.pages)
    || !Array.isArray(scene.backgrounds)
  ) {
    const error = new Error('页面场景结果不完整');
    error.code = 'PAGE_SCENE_INVALID';
    throw error;
  }
  return scene;
}

async function extractRasterPageScene({ pages, previews, workDir }) {
  const byPage = new Map((previews || []).map((preview) => [Number(preview.page), preview]));
  const request = {
    pages: (pages || []).map((page, pageIndex) => {
      const number = Number(page.number || pageIndex + 1);
      const preview = byPage.get(number);
      return preview
        ? {
            number,
            image_path: preview.path,
            output_path: path.join(workDir, `scene-background-${number}.png`),
            width: Number(page.width || preview.width),
            height: Number(page.height || preview.height),
            blocks: page.blocks || [],
          }
        : null;
    }).filter(Boolean),
  };
  const requestPath = path.join(workDir, 'raster-scene-request.json');
  fs.writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
  const result = await runCommand(
    pythonPath(),
    [path.join(__dirname, 'raster_scene_runner.py'), requestPath],
    {
      cwd: workDir,
      timeout: Number(process.env.RESUME_DOCUMENT_PAGE_SCENE_TIMEOUT_MS || 180000),
      maxBuffer: 32 * 1024 * 1024,
      errorCode: 'PAGE_SCENE_EXTRACTION_FAILED',
    },
  );
  const scene = resultPayload(result.stdout);
  if (
    scene.version !== 'page-scene-v1'
    || !Array.isArray(scene.pages)
    || !Array.isArray(scene.backgrounds)
  ) {
    const error = new Error('图片页面场景结果不完整');
    error.code = 'PAGE_SCENE_INVALID';
    throw error;
  }
  return scene;
}

module.exports = { extractPageScene, extractRasterPageScene, resultPayload };
