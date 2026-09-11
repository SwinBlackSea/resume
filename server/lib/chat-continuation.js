'use strict';

const db = require('./db');

// Conversation identity belongs to the server, not to a tab's temporary UI
// selection. This is shared by request resolution and the workspace display.
function latestConversationTask({ conversationId, projectId, ownerId }) {
  return db.get(
    `SELECT t.* FROM ai_messages m JOIN ai_tasks t
       ON t.id = COALESCE(m.task_id, CASE WHEN json_valid(m.model_metadata_json)
         THEN json_extract(m.model_metadata_json, '$.task_id') END)
     WHERE m.conversation_id = ? AND m.owner_id = ?
       AND t.conversation_id = ? AND t.project_id = ? AND t.owner_id = ?
     ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    [conversationId, ownerId, conversationId, projectId, ownerId],
  );
}

function matchesTaskScope(task, scopeType, scopeId) {
  return Boolean(task && task.status !== 'canceled' && task.scope_type === scopeType
    && String(task.scope_id || '') === String(scopeId || ''));
}

function continuationView(task) {
  if (!task || task.status === 'canceled') return null;
  return {
    task_id: task.id, scope_type: task.scope_type, scope_id: task.scope_id || null,
    status: task.status, proposal_id: task.active_proposal_id || null,
    editing_base: task.active_proposal_id ? 'pending_proposal' : 'current_draft',
  };
}

module.exports = { latestConversationTask, matchesTaskScope, continuationView };
