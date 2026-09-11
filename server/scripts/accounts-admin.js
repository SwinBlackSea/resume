#!/usr/bin/env node
'use strict';

// No .env loader, application db import, HTTP access, passwords in argv or
// business migrations. Local filesystem authority is the administrative gate.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');
const { inspectLegacyOwner, bootstrapLegacyAdmin, resetPassword } = require('../lib/accounts/admin');
const { normalizeUsername } = require('../lib/accounts/passwords');
const { migrateAccounts } = require('../lib/accounts/schema');

function hiddenPrompt(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('密码设置必须在本机交互终端运行；不接受命令行参数或管道中的明文密码');
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    let input = '';
    const wasRaw = process.stdin.isRaw;
    process.stdin.setEncoding('utf8');
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    function finish(error) {
      process.stdin.removeListener('keypress', read);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(input);
    }
    function read(text, key = {}) {
      if (key.ctrl && key.name === 'c') return finish(new Error('已取消'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { input = Array.from(input).slice(0, -1).join(''); return; }
      if (key.ctrl || key.meta || key.name === 'escape' || !text || /[\u0000-\u001f\u007f-\u009f]/.test(text)) return;
      if (Buffer.byteLength(input + text) <= 1024) input += text;
    }
    process.stdin.on('keypress', read);
  });
}

async function main(argv) {
  const command = argv.shift();
  const options = {};
  while (argv.length) {
    const key = argv.shift();
    if (key === '--apply') options.apply = true;
    else if (['--database', '--owner-id', '--username'].includes(key)) options[key.slice(2)] = argv.shift();
    else throw new Error('仅支持 status/bootstrap/migrate/set-password --database 绝对路径 [--owner-id ID] [--username 用户名] [--apply]');
  }
  if (!['status', 'bootstrap', 'migrate', 'set-password'].includes(command)
    || !options.database || !path.isAbsolute(options.database) || !fs.existsSync(options.database)) {
    throw new Error('必须指定已存在的数据库绝对路径；默认仅预检，加 --apply 才执行');
  }
  const database = new DatabaseSync(options.database, { readOnly: !options.apply });
  try {
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (command === 'migrate') {
      const exists = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_schema_versions'").get();
      const version = exists ? database.prepare('SELECT MAX(version) AS version FROM account_schema_versions').get().version : 0;
      if (version > 2) throw new Error('账号数据库版本高于当前代码，拒绝降级运行');
      if (options.apply) migrateAccounts(database);
      console.log(JSON.stringify({ previous_version: version, target_version: 2, applied: Boolean(options.apply) }));
    } else if (command === 'status') {
      console.log(JSON.stringify(inspectLegacyOwner(database, options['owner-id']), null, 2));
    } else if (command === 'bootstrap') {
      const result = await bootstrapLegacyAdmin(database, { ownerId: options['owner-id'], apply: options.apply === true });
      console.log(JSON.stringify(result, null, 2));
      if (result.must_change_password) {
        console.log('admin/admin 为受限初始化状态，禁止网页登录。请本机执行 set-password 设置强密码后再开放服务。');
      }
    } else {
      if (!options.username) throw new Error('设置密码必须指定 --username');
      options.username = normalizeUsername(options.username);
      if (!database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_password_credentials'").get()
        || !database.prepare('SELECT user_id FROM account_password_credentials WHERE username=?').get(options.username)) {
        throw new Error('账号不存在或尚未初始化；未修改任何资料');
      }
      if (!options.apply) {
        console.log('预检完成；实际重置需加 --apply，并在本机终端输入新密码。');
        return;
      }
      const password = await hiddenPrompt('新密码（至少 15 个字符，输入不回显）：');
      const repeated = await hiddenPrompt('再次输入新密码：');
      if (password !== repeated) throw new Error('两次密码不一致，未修改');
      const result = await resetPassword(database, { username: options.username, password, apply: true });
      console.log(JSON.stringify(result, null, 2));
    }
  } finally { database.close(); }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { main };
