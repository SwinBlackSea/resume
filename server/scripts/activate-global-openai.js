'use strict';

// Explicit deployment only. Local AI changes only with includeLocal / --include-local.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadQAConfig, CONFIG_FILE } = require('./openai-qa-config');
const { openAIEndpoint } = require('../lib/model-client/openai');

function activateGlobalOpenAI({
  configFile = CONFIG_FILE,
  envFile = path.resolve(__dirname, '../../.env'),
  backupDir = path.resolve(__dirname, '../../.runtime/config-backups'),
  includeLocal = false,
} = {}) {
  const config = loadQAConfig(configFile);
  openAIEndpoint(config.baseUrl);
  if (config.model !== 'gpt-6-astra') throw new Error('测试配置型号不是已确认的 gpt-6-astra，未切换');
  if (!fs.lstatSync(envFile).isFile()) throw new Error('线上配置必须是普通文件');
  const original = fs.readFileSync(envFile, 'utf8');
  const updates = {
    ...(includeLocal ? { RESUME_MODEL_PROVIDER: 'openai' } : {}),
    RESUME_GLOBAL_MODEL_PROVIDER: 'openai',
    RESUME_OPENAI_BASE_URL: config.baseUrl,
    RESUME_OPENAI_MODEL: config.model,
    RESUME_OPENAI_MIN_REASONING_EFFORT: 'low',
    RESUME_OPENAI_API_KEY: config.apiKey,
  };
  for (const value of Object.values(updates)) {
    if (/[\r\n"'#]/.test(value)) throw new Error('配置包含不支持的字符，未切换');
  }
  const seen = new Set();
  const lines = original.split(/\r?\n/).flatMap((line) => {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (!Object.hasOwn(updates, key)) return [line];
    if (seen.has(key)) return [];
    seen.add(key);
    return [`${key}=${updates[key]}`];
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = path.join(backupDir, `env-before-astra-${randomUUID()}`);
  fs.writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
  const temporary = `${envFile}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${lines.join('\n').trimEnd()}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, envFile);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { model: config.model, globalProvider: 'openai', local: includeLocal ? 'openai' : 'unchanged', backup };
}

if (require.main === module) {
  if (!process.argv.includes('--apply')) {
    console.log('显式切换：npm run ai:activate-astra -- --apply；追加 --include-local 同时切换局部 AI。读取已配置测试 Key，备份并更新 .env，不自动重启。');
  } else {
    try { console.log(JSON.stringify(activateGlobalOpenAI({ includeLocal: process.argv.includes('--include-local') }))); }
    catch (_) { console.error('全局模型配置未完成，请检查私有测试配置与配置文件权限。'); process.exitCode = 1; }
  }
}

module.exports = { activateGlobalOpenAI };
