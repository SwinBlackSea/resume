'use strict';
/**
 * 幂等支持（TECH §5.2、§8.4）。
 * 所有写请求支持 Idempotency-Key：owner_id + key 唯一。
 * 相同 action_id / key 重试不得重复写入，返回首次执行结果。
 */
const db = require('./db');
const { uuidv7, nowIso } = require('./util');

/**
 * 在幂等保护下执行 fn。
 * @param {object} user 当前用户
 * @param {string} key 客户端 Idempotency-Key
 * @param {string} resourceType 资源类型
 * @param {Function} fn 首次执行逻辑，返回可序列化的响应
 */
function withIdempotency(user, key, resourceType, fn) {
  if (!key) return fn();
  const existing = db.get(
    'SELECT * FROM idempotency_keys WHERE owner_id = ? AND key = ?',
    [user.id, key],
  );
  if (existing) {
    return { ...JSON.parse(existing.response_json), idempotent_replay: true };
  }
  const result = fn();
  try {
    db.run(
      `INSERT INTO idempotency_keys (id, owner_id, key, resource_type, resource_id, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        user.id,
        key,
        resourceType,
        (result && result.id) || '',
        JSON.stringify(result || {}),
        nowIso(),
      ],
    );
  } catch (_) {
    // 并发写入同一 key：以数据库为准返回首次结果
    const row = db.get('SELECT * FROM idempotency_keys WHERE owner_id = ? AND key = ?', [
      user.id,
      key,
    ]);
    if (row) return { ...JSON.parse(row.response_json), idempotent_replay: true };
  }
  return result;
}

module.exports = { withIdempotency };
