'use strict';
/**
 * 极简 .env 加载器（零依赖）。
 *
 * 为什么不依赖启动参数：服务由 PM2 / nohup / systemd 等不同方式拉起，
 * 只有让应用自己读取 .env，才能保证「改完 .env 重启即生效」与启动方式无关。
 * 规则：已存在的环境变量优先（命令行与系统配置不被覆盖）。
 */
const fs = require('node:fs');
const path = require('node:path');

function loadEnv(envPath) {
  const file = envPath || path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(file)) return { loaded: false, file };
  let count = 0;
  const content = fs.readFileSync(file, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (!key || process.env[key] !== undefined) return; // 已有环境变量优先
    process.env[key] = value;
    count += 1;
  });
  return { loaded: true, file, count };
}

module.exports = { loadEnv };
