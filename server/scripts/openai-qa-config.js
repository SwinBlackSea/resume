'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseEnv } = require('node:util');
const { Writable } = require('node:stream');
const readline = require('node:readline');

const CONFIG_FILE = path.resolve(__dirname, '../../.env.openai-qa');
const BASE_URL = 'https://api.info52.top/v1';
const MODEL = 'gpt-6-astra';

function saveQAKey(key, file = CONFIG_FILE) {
  if (!/^[A-Za-z0-9._-]{8,}$/.test(key)) throw new Error('Key 为空或包含无效字符，未保存');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, [
      '# 仅供手动全局 AI 对照测试；线上服务不会自动加载此文件。',
      `RESUME_OPENAI_BASE_URL=${BASE_URL}`,
      `RESUME_OPENAI_MODEL=${MODEL}`,
      `RESUME_OPENAI_API_KEY=${key}`,
      '',
    ].join('\n'), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function loadQAConfig(file = CONFIG_FILE) {
  if (!fs.existsSync(file)) throw new Error('尚未配置测试 Key，请先运行 npm run ai:configure-openai');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077)) {
    throw new Error('测试配置必须是仅当前用户可读写的普通文件（权限 600）');
  }
  const env = parseEnv(fs.readFileSync(file, 'utf8'));
  if (!env.RESUME_OPENAI_API_KEY?.trim()) throw new Error('测试 Key 未配置');
  return {
    apiKey: env.RESUME_OPENAI_API_KEY,
    baseUrl: env.RESUME_OPENAI_BASE_URL || BASE_URL,
    model: env.RESUME_OPENAI_MODEL || MODEL,
  };
}

async function configure() {
  if (!process.stdin.isTTY) throw new Error('请在交互式终端运行，禁止把 Key 放入命令行参数');
  console.log(`仅配置测试网关 ${BASE_URL}，模型 ${MODEL}；不修改线上 .env 或 Codex 配置。`);
  console.log('网关为第三方服务；后续测试会将虚构简历和图片发送给该网关。');
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write('粘贴 API Key 后回车（不显示输入）：');
  try {
    const key = await new Promise((resolve, reject) => {
      rl.once('SIGINT', () => reject(new Error('已取消，未保存')));
      rl.once('close', () => reject(new Error('输入已关闭，未保存')));
      rl.question('', resolve);
    });
    saveQAKey(key.trim());
    console.log('\n测试 Key 已保存（权限 600、Git 忽略），未发起模型请求，线上配置不变。');
  } finally { rl.close(); }
}

if (require.main === module) configure().catch((error) => {
  console.error(`\n${error.message}`); process.exitCode = 1;
});

module.exports = { CONFIG_FILE, BASE_URL, MODEL, saveQAKey, loadQAConfig };
