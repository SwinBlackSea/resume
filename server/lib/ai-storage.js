'use strict';

// 此模块只接收现成数据库连接，不初始化服务或修改草稿/版本。
const { archivedPayload } = require('./resume-change');
const INLINE = 'RESUME_INLINE_REWRITE_PROPOSAL';
const RECEIPT = 'ai-action-receipt-v1';

function parse(value) {
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

function atomic(database, fn) {
  database.exec('SAVEPOINT ai_storage_cleanup');
  try {
    const result = fn();
    database.exec('RELEASE ai_storage_cleanup');
    return result;
  } catch (error) {
    database.exec('ROLLBACK TO ai_storage_cleanup');
    database.exec('RELEASE ai_storage_cleanup');
    throw error;
  }
}

// 首次响应照常返回正文；重复提交只需成功回执，客户端随后刷新当前草稿。
function compactReplay(result, resourceType) {
  if (!['ai_action_confirm', 'inline_ai_apply', 'resume_version_clone',
    'document_import_apply'].includes(resourceType)) return result;
  const compact = { ...result };
  delete compact.resume_json;
  return compact;
}

function compactIdempotency(database) {
  let changed = 0;
  for (const row of database.prepare('SELECT * FROM idempotency_keys').all()) {
    const next = JSON.stringify(compactReplay(parse(row.response_json), row.resource_type));
    if (next === row.response_json) continue;
    database.prepare('UPDATE idempotency_keys SET response_json = ? WHERE id = ?').run(next, row.id);
    changed += 1;
  }
  return changed;
}

function purgeConversations(database, { ownerId, projectId, keepId = null, closedOnly = false }) {
  return atomic(database, () => {
    const rows = database.prepare(
      `SELECT id FROM ai_conversations WHERE owner_id = ? AND project_id = ?
       AND (? IS NULL OR id <> ?) ${closedOnly ? "AND status = 'closed'" : ''}`,
    ).all(ownerId, projectId, keepId, keepId);
    const counts = { conversations: 0, messages: 0, tasks: 0, actions: 0 };
    for (const { id } of rows) {
      // 保存资料的撤销回执独立于聊天；保留最小动作身份，断开会话关联。
      const actions = database.prepare(
        'SELECT id FROM ai_action_requests WHERE conversation_id = ? AND owner_id = ?',
      ).all(id, ownerId);
      for (const action of actions) {
        const receipt = database.prepare(
          'SELECT id FROM change_receipts WHERE action_request_id = ? LIMIT 1',
        ).get(action.id);
        if (receipt) {
          database.prepare(
            'UPDATE ai_action_requests SET conversation_id = NULL, message_id = NULL, payload_json = ? WHERE id = ?',
          ).run(JSON.stringify({ format: RECEIPT }), action.id);
        } else {
          database.prepare('DELETE FROM ai_action_requests WHERE id = ?').run(action.id);
        }
        counts.actions += 1;
      }
      counts.messages += Number(database.prepare(
        'DELETE FROM ai_messages WHERE conversation_id = ?',
      ).run(id).changes);
      counts.tasks += Number(database.prepare(
        'DELETE FROM ai_tasks WHERE conversation_id = ?',
      ).run(id).changes);
      database.prepare('DELETE FROM ai_conversations WHERE id = ?').run(id);
      counts.conversations += 1;
    }
    return counts;
  });
}

function compactInlineHistory(database, { ownerId = null, projectId = null, finishedActionId = null } = {}) {
  return atomic(database, () => {
    const rows = database.prepare(
      `SELECT * FROM ai_action_requests WHERE action_type = ?
       AND (? IS NULL OR owner_id = ?)`,
    ).all(INLINE, ownerId, ownerId).map((row) => ({ ...row, payload: parse(row.payload_json) }))
      .filter((row) => !projectId || row.payload.project_id === projectId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    function session(row) {
      if (row.payload.session_id) return row.payload.session_id;
      const seen = new Set();
      while (row.payload.previous_action_id && !seen.has(row.id)) {
        seen.add(row.id);
        const parent = byId.get(row.payload.previous_action_id);
        if (!parent || parent.owner_id !== row.owner_id
          || parent.payload.project_id !== row.payload.project_id) break;
        row = parent;
      }
      return row.id;
    }
    const finished = byId.get(finishedActionId);
    const closed = new Set(rows.filter((row) =>
      row.payload.session_closed || row.status === 'applied'
      || (row.status === 'rejected' && !row.payload.handoff)).map(session));
    if (finished) closed.add(session(finished));
    // 未完成任务及其完整祖先链必须保留，避免清理旧建议破坏继续调整。
    const protectedIds = new Set();
    for (let row of rows) {
      const active = ['processing', 'awaiting_confirmation', 'proposed'].includes(row.status);
      const retryable = row.status === 'failed' && !closed.has(session(row));
      if (!active && !retryable) continue;
      while (row && !protectedIds.has(row.id)) {
        protectedIds.add(row.id);
        const parent = byId.get(row.payload.previous_action_id);
        row = parent && parent.owner_id === row.owner_id
          && parent.payload.project_id === row.payload.project_id ? parent : null;
      }
    }
    let changed = 0;
    for (const row of rows) {
      if (protectedIds.has(row.id) || row.payload.format === RECEIPT) continue;
      const sessionId = session(row);
      const next = {
        format: RECEIPT, project_id: row.payload.project_id,
        session_id: sessionId, session_closed: closed.has(sessionId),
        client_request_id: row.payload.client_request_id,
      };
      database.prepare('UPDATE ai_action_requests SET payload_json = ? WHERE id = ?')
        .run(JSON.stringify(next), row.id);
      changed += 1;
    }
    return changed;
  });
}

function compactExpiredChanges(database) {
  let changed = 0;
  const rows = database.prepare(
    `SELECT id, before_json, after_json FROM resume_change_events
     WHERE undo_expired_at IS NOT NULL OR redo_invalidated_at IS NOT NULL`,
  ).all();
  for (const row of rows) {
    const before = parse(row.before_json);
    const after = parse(row.after_json);
    const nextBefore = JSON.stringify(archivedPayload(before.label));
    const nextAfter = JSON.stringify(archivedPayload(after.label || before.label));
    if (nextBefore === row.before_json && nextAfter === row.after_json) continue;
    database.prepare('UPDATE resume_change_events SET before_json = ?, after_json = ? WHERE id = ?')
      .run(nextBefore, nextAfter, row.id);
    changed += 1;
  }
  return changed;
}

function compactDuplicateProposals(database) {
  let changed = 0;
  for (const row of database.prepare(
    "SELECT id, payload_json FROM ai_action_requests WHERE action_type = 'RESUME_REWRITE_PROPOSAL'",
  ).all()) {
    const value = parse(row.payload_json);
    const proposal = value.proposal || value;
    if (proposal.merge_strategy !== 'three_way_target_document' || !proposal.target_resume_document
      || JSON.stringify(proposal.resume_json) !== JSON.stringify(proposal.target_resume_document)) continue;
    delete proposal.resume_json;
    database.prepare('UPDATE ai_action_requests SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(value), row.id);
    changed += 1;
  }
  return changed;
}

function compactGlobalHistory(database, ownerId = null) {
  let changed = 0;
  const rows = database.prepare(
    `SELECT id, payload_json FROM ai_action_requests
     WHERE action_type = 'RESUME_REWRITE_PROPOSAL'
       AND (? IS NULL OR owner_id = ?)
       AND status IN ('applied','rejected','reverted','superseded','stale')
       AND id NOT IN (SELECT active_proposal_id FROM ai_tasks WHERE active_proposal_id IS NOT NULL)`,
  ).all(ownerId, ownerId);
  for (const row of rows) {
    const value = parse(row.payload_json);
    const proposal = value.proposal || value;
    // 旧卡片仍可显示结果；不能再应用的执行材料不随聊天无限重复保存。
    for (const key of ['base_resume_json', 'target_resume_document', 'resume_json',
      'target_resume_fragments', 'operations', 'operation_preconditions']) delete proposal[key];
    const next = JSON.stringify(value);
    if (next === row.payload_json) continue;
    database.prepare('UPDATE ai_action_requests SET payload_json = ? WHERE id = ?').run(next, row.id);
    changed += 1;
  }
  return changed;
}

function compactStorage(database) {
  return atomic(database, () => {
    const counts = { conversations: 0, messages: 0, tasks: 0, actions: 0 };
    for (const project of database.prepare('SELECT id, owner_id FROM resume_projects').all()) {
      const deleted = purgeConversations(database, {
        ownerId: project.owner_id, projectId: project.id, closedOnly: true,
      });
      for (const key of Object.keys(counts)) counts[key] += deleted[key];
    }
    return {
      ...counts,
      inline_histories: compactInlineHistory(database),
      replay_payloads: compactIdempotency(database),
      expired_changes: compactExpiredChanges(database),
      duplicate_proposals: compactDuplicateProposals(database),
      terminal_proposals: compactGlobalHistory(database),
    };
  });
}

module.exports = {
  compactReplay, compactIdempotency, purgeConversations, compactInlineHistory,
  compactExpiredChanges, compactDuplicateProposals, compactStorage, RECEIPT,
  compactGlobalHistory,
};
