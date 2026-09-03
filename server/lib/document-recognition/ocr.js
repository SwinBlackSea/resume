'use strict';

const path = require('node:path');
const { runCommand } = require('./command');
const { DocumentRecognitionError } = require('./errors');

function pythonPath() {
  return (
    process.env.RESUME_DOCUMENT_OCR_PYTHON
    || path.join(
      __dirname,
      '..',
      '..',
      '..',
      '.runtime',
      'document-recognition',
      'venv',
      'bin',
      'python',
    )
  );
}

async function recognizeImage(imagePath, page = 1) {
  if (String(process.env.RESUME_DOCUMENT_OCR_ENABLED || 'true').toLowerCase() === 'false') {
    return { blocks: [], warning: 'OCR_DISABLED', model: 'disabled' };
  }
  try {
    const result = await runCommand(
      pythonPath(),
      [path.join(__dirname, 'ocr_runner.py'), imagePath],
      {
        timeout: Number(process.env.RESUME_DOCUMENT_OCR_TIMEOUT_MS || 180000),
        maxBuffer: 16 * 1024 * 1024,
        errorCode: 'OCR_FAILED',
        env: {
          PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
          FLAGS_allocator_strategy: 'auto_growth',
        },
      },
    );
    const payloadLine = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith('{') && line.endsWith('}'));
    const parsed = JSON.parse(payloadLine || '{}');
    const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
    return {
      blocks: blocks
        .map((block, index) => ({
          id: `block-${page}-${index + 1}`,
          page,
          order: index,
          kind: 'paragraph',
          text: String(block.text || '').trim(),
          confidence: Number(block.confidence || 0),
          bbox: block.bbox || null,
        }))
        .filter((block) => block.text),
      warning: null,
      model: 'PP-OCRv5-mobile',
    };
  } catch (error) {
    if (String(process.env.RESUME_DOCUMENT_OCR_REQUIRED || 'false').toLowerCase() === 'true') {
      throw new DocumentRecognitionError('OCR_FAILED', '图片文字识别失败，请稍后重试', {
        retryable: true,
      });
    }
    return { blocks: [], warning: error.code || 'OCR_FAILED', model: 'PP-OCRv5-mobile' };
  }
}

module.exports = { recognizeImage, pythonPath };
