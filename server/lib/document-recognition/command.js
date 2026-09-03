'use strict';

const { execFile } = require('node:child_process');
const { DocumentRecognitionError } = require('./errors');

function runCommand(command, args, {
  cwd,
  timeout = 120000,
  maxBuffer = 32 * 1024 * 1024,
  env,
  errorCode = 'DOCUMENT_TOOL_FAILED',
} = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout,
        maxBuffer,
        windowsHide: true,
        env: { ...process.env, ...(env || {}) },
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new DocumentRecognitionError(
              errorCode,
              error.killed
                ? '文档处理超时'
                : `文档处理工具执行失败${stderr ? `：${String(stderr).trim().slice(0, 240)}` : ''}`,
              { retryable: Boolean(error.killed), details: { command, exit_code: error.code } },
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

module.exports = { runCommand };
