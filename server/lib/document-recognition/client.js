'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { uuidv7 } = require('../util');
const { recognizeDocument } = require('./service');
const { DocumentRecognitionError } = require('./errors');
const { DEFAULT_TIMEOUT_MS, RUNTIME_ROOT } = require('./constants');

let testClient = null;
let chain = Promise.resolve();

function runChild(requestPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'runner.js'), requestPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new DocumentRecognitionError('DOCUMENT_RECOGNITION_TIMEOUT', '文档识别超时，请稍后重试', {
          retryable: true,
        }),
      );
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new DocumentRecognitionError('DOCUMENT_SERVICE_UNAVAILABLE', '文档识别服务无法启动', {
          retryable: true,
          details: error.message,
        }),
      );
    });
    child.on('close', () => {
      clearTimeout(timer);
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(stdout).toString('utf8'));
      } catch (_) {
        reject(
          new DocumentRecognitionError(
            'DOCUMENT_SERVICE_INVALID_RESPONSE',
            `文档识别服务返回异常${stderr.length ? `：${Buffer.concat(stderr).toString('utf8').slice(0, 160)}` : ''}`,
            { retryable: true },
          ),
        );
        return;
      }
      if (!payload.ok) {
        reject(
          new DocumentRecognitionError(
            payload.error && payload.error.code,
            (payload.error && payload.error.message) || '文档识别失败',
            { retryable: Boolean(payload.error && payload.error.retryable) },
          ),
        );
        return;
      }
      resolve(payload.result);
    });
  });
}

async function recognize(request) {
  if (testClient) return testClient(request);
  const jobDir = path.join(RUNTIME_ROOT, uuidv7());
  fs.mkdirSync(jobDir, { recursive: true });
  const requestPath = path.join(jobDir, 'request.json');
  const payload = { ...request, workDir: jobDir };
  fs.writeFileSync(requestPath, JSON.stringify(payload), { mode: 0o600 });
  try {
    if (String(process.env.RESUME_DOCUMENT_RECOGNITION_INLINE || '').toLowerCase() === 'true') {
      const result = await recognizeDocument(payload);
      return { ...result, runtime_dir: jobDir };
    }
    const result = await runChild(
      requestPath,
      Number(process.env.RESUME_DOCUMENT_RECOGNITION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    );
    return { ...result, runtime_dir: jobDir };
  } catch (error) {
    cleanup(jobDir);
    throw error;
  }
}

function recognizeSerial(request) {
  const next = chain.then(() => recognize(request));
  chain = next.catch(() => undefined);
  return next;
}

function setClientForTests(client) {
  testClient = client || null;
}

function cleanup(runtimeDir) {
  if (!runtimeDir) return;
  const resolvedRoot = path.resolve(RUNTIME_ROOT);
  const resolvedTarget = path.resolve(runtimeDir);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) return;
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

module.exports = { recognize: recognizeSerial, setClientForTests, runChild, cleanup };
