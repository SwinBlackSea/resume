'use strict';
/**
 * 对象存储抽象（TECH §3、§12）。
 * MVP 使用本地目录模拟私有桶；生产替换为 S3 兼容对象存储时保持同一接口。
 * 对象键包含 owner_id 的不可猜测前缀，但授权仍以数据库为准。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OBJECTS_DIR = path.join(__dirname, '..', '..', 'data', 'objects');

function ensureDir() {
  if (!fs.existsSync(OBJECTS_DIR)) fs.mkdirSync(OBJECTS_DIR, { recursive: true });
}

function objectKey(ownerId, kind, name) {
  const stamp = Date.now().toString(36);
  const random = crypto.randomBytes(6).toString('hex');
  return `${ownerId}/${kind}/${stamp}-${random}-${name}`;
}

function putObject(key, buffer) {
  ensureDir();
  const target = path.join(OBJECTS_DIR, key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return { key, size: buffer.length };
}

function getObject(key) {
  const target = path.join(OBJECTS_DIR, key);
  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target);
}

function objectPath(key) {
  return path.join(OBJECTS_DIR, key);
}

module.exports = { objectKey, putObject, getObject, objectPath, OBJECTS_DIR };
