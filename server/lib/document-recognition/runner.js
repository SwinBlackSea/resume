'use strict';

const fs = require('node:fs');
const { recognizeDocument } = require('./service');
const { asRecognitionError } = require('./errors');

async function main() {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error('missing request path');
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  const result = await recognizeDocument(request);
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

main().catch((error) => {
  const safe = asRecognitionError(error);
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: {
        code: safe.code,
        message: safe.message,
        retryable: safe.retryable,
      },
    }),
  );
  process.exitCode = 1;
});
