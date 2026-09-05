'use strict';

/**
 * 局部 AI：只在当前简历文字旁生成轻量候选，不进入右侧对话。
 *
 * 生成阶段只保存待确认的文字结果；应用阶段以最新草稿为准：
 * - 整个节点：用户最后确认的 AI 结果覆盖该节点当前文字；
 * - 选中文字：只重放这一段文字的替换，保留同节点内其他后续修改；
 * - 只有节点消失、编辑身份变化或选区无法重新定位时才返回客观冲突。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, problem, hashJson } = require('../lib/util');
const audit = require('../lib/audit');
const resumeHarness = require('../lib/resume-harness');
const { createNodeDeltaPair } = require('../lib/resume-change');
const { refreshResumeProposalStaleness } = require('../lib/resume-proposals');
const { withIdempotency } = require('../lib/idempotency');
const ResumeDom = require('../../resume-dom');

const ACTION_TYPE = 'RESUME_INLINE_REWRITE_PROPOSAL';
const ACTION_FORMAT = 'resume-inline-rewrite-proposal-v1';

function parseJson(raw, fallback = {}) {
  try {
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch (_) {
    return fallback;
  }
}

function loadProjectContext(projectId, user) {
  const project = db.get(
    'SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?',
    [projectId, user.id],
  );
  if (!project) throw problem.notFound('项目不存在');
  const draft = db.get(
    'SELECT * FROM resume_drafts WHERE project_id = ? AND owner_id = ?',
    [project.id, user.id],
  );
  if (!draft) throw problem.notFound('草稿不存在');
  const profile = db.get(
    'SELECT * FROM profiles WHERE id = ? AND owner_id = ?',
    [project.current_profile_id, user.id],
  );
  const job = project.current_job_id
    ? db.get(
        'SELECT * FROM target_jobs WHERE id = ? AND project_id = ? AND owner_id = ?',
        [project.current_job_id, project.id, user.id],
      )
    : null;
  return { project, draft, profile, job };
}

function ownNodeText(node) {
  if (!node) return '';
  if (node.type === 'text') return String(node.value || '');
  return node.text === undefined ? '' : String(node.text || '');
}

function isDescendantOrSelf(found, ancestorId) {
  if (!found) return false;
  if (String(found.node.id) === String(ancestorId)) return true;
  return found.ancestors.some((ancestor) => String(ancestor.id) === String(ancestorId));
}

function normalizeSelection(body, document, target) {
  if (body.target_mode !== 'selection') return null;
  const raw = body.selection && typeof body.selection === 'object' ? body.selection : {};
  const segmentId = String(raw.segment_id || target.node.id);
  const segment = ResumeDom.findNode(document, segmentId);
  if (!segment || !isDescendantOrSelf(segment, target.node.id)) {
    throw problem.badRequest('所选文字已经不在当前编辑区域内，请重新选择');
  }
  const segmentText = ownNodeText(segment.node);
  if (!segmentText && ResumeDom.exportNodeText(segment.node)) {
    throw problem.badRequest('请一次选择同一段文字，不要跨段选择');
  }
  let start = Number(raw.start);
  let end = Number(raw.end);
  const selectedText = String(raw.text || '');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    throw problem.badRequest('没有识别到有效的文字选区，请重新选择');
  }
  if (end > segmentText.length || segmentText.slice(start, end) !== selectedText) {
    const occurrences = [];
    let cursor = segmentText.indexOf(selectedText);
    while (selectedText && cursor >= 0) {
      occurrences.push(cursor);
      cursor = segmentText.indexOf(selectedText, cursor + 1);
    }
    if (occurrences.length !== 1) {
      throw problem.badRequest('所选文字的位置已经变化，请重新选择');
    }
    start = occurrences[0];
    end = start + selectedText.length;
  }
  return {
    segment_id: segmentId,
    segment_type: segment.node.type,
    segment_tag: segment.node.tag || null,
    base_segment_text: segmentText,
    start,
    end,
    text: segmentText.slice(start, end),
  };
}

function buildModelInput(ctx, body, target, selection) {
  const document = ResumeDom.toResumeDocument(parseJson(ctx.draft.resume_json, {}));
  const experiences = db.all(
    `SELECT type, organization, title, start_date, end_date, is_current, description
     FROM experiences
     WHERE profile_id = ? AND owner_id = ? AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
    [ctx.profile.id, ctx.profile.owner_id],
  );
  const targetText = ResumeDom.exportNodeText(target.node);
  const sourceText = selection ? selection.text : targetText;
  return {
    request: {
      instruction: String(body.instruction || '').trim(),
    },
    workspace: {
      resume: {
        revision: ctx.draft.revision,
        content: document,
      },
      profile: {
        basics: parseJson(ctx.profile.basics_json, {}),
        summary: ctx.profile.summary || '',
        experiences,
      },
      target_job: ctx.job
        ? {
            title: ctx.job.title,
            company: ctx.job.company,
            confirmed_text: ctx.job.confirmed_text,
            analysis: parseJson(ctx.job.analysis_json, {}),
          }
        : null,
    },
    target: {
      mode: selection ? 'selection' : 'node',
      node_id: target.node.id,
      node_tag: target.node.tag || target.node.type,
      label: target.node.label || '',
      full_text: targetText,
      source_text: sourceText,
      paragraph_count: targetText.replace(/\r\n?/g, '\n').split('\n').length,
      selection,
    },
  };
}

function mapModelError(error) {
  const code = String(error && error.code || '');
  if (code === 'DEEPSEEK_OUTPUT_TRUNCATED') {
    return problem.unprocessable(
      'MODEL_OUTPUT_TRUNCATED',
      'AI 返回的局部结果过长且未完成，请缩小选中文字后重试',
    );
  }
  if (
    code === 'DEEPSEEK_INVALID_JSON'
    || code === 'MODEL_OUTPUT_SCHEMA_INVALID'
    || code === 'INLINE_OUTPUT_SCHEMA_INVALID'
  ) {
    return problem.unprocessable(
      'MODEL_RESPONSE_INVALID',
      'AI 没有返回完整可用的局部结果，请再试一次',
    );
  }
  if (
    code === 'DEEPSEEK_NOT_CONFIGURED'
    || code === 'DEEPSEEK_TIMEOUT'
    || code === 'DEEPSEEK_NETWORK_ERROR'
    || code === 'DEEPSEEK_HTTP_ERROR'
  ) {
    return problem.unprocessable(
      'MODEL_UNAVAILABLE',
      code.includes('TIMEOUT')
        ? 'AI 响应超时，请稍后再试'
        : 'AI 暂时不可用，请稍后再试',
    );
  }
  if (error && error.code === 'INLINE_REWRITE_INVALID') {
    return problem.unprocessable(
      'INLINE_REWRITE_INVALID',
      'AI 没有生成可靠的局部文字，请换一种说法再试',
      { validation_errors: error.validation_errors || [] },
    );
  }
  return problem.unprocessable(
    'INLINE_REWRITE_INVALID',
    'AI 返回的局部修改无法使用，请再试一次',
  );
}

function supersedeEarlierActions(projectId, ownerId, targetNodeId, excludeActionId = null) {
  const rows = db.all(
    `SELECT id, payload_json FROM ai_action_requests
     WHERE owner_id = ? AND action_type = ?
       AND target_id = ?
       AND status IN ('processing','awaiting_confirmation','proposed')`,
    [ownerId, ACTION_TYPE, targetNodeId],
  );
  rows.forEach((row) => {
    const payload = parseJson(row.payload_json, {});
    if (
      String(row.id) !== String(excludeActionId || '')
      &&
      String(payload.project_id || '') === String(projectId)
      && String(payload.target_node_id || '') === String(targetNodeId)
    ) {
      db.run(
        "UPDATE ai_action_requests SET status = 'superseded', rejected_at = ? WHERE id = ?",
        [nowIso(), row.id],
      );
    }
  });
}

function commonPrefixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (
    index < max
    && left[left.length - 1 - index] === right[right.length - 1 - index]
  ) index += 1;
  return index;
}

function occurrencesOf(text, needle) {
  if (!needle) return [];
  const result = [];
  let index = text.indexOf(needle);
  while (index >= 0) {
    result.push(index);
    index = text.indexOf(needle, index + 1);
  }
  return result;
}

function selectionMovedError(message = '选中的文字在当前内容中已经无法准确定位') {
  const error = new Error(message);
  error.code = 'INLINE_SELECTION_MOVED';
  return error;
}

function assertReasonableRebasedRange(selection, start, end) {
  const originalLength = Math.max(0, Number(selection.end) - Number(selection.start));
  const currentLength = Math.max(0, end - start);
  const maximumLength = Math.max(originalLength * 8, originalLength + 128);
  if (currentLength > maximumLength) {
    throw selectionMovedError('选区变化范围过大，无法确认仍是原来的文字');
  }
}

function bestExactSelection(base, current, selection) {
  const candidates = occurrencesOf(current, selection.text);
  if (!candidates.length) return null;
  const leftBase = base.slice(0, selection.start);
  const rightBase = base.slice(selection.end);
  const expected = base.length
    ? Math.round(selection.start * current.length / base.length)
    : selection.start;
  const ranked = candidates
    .map((start) => {
      const end = start + selection.text.length;
      const score = Math.min(48, commonSuffixLength(leftBase, current.slice(0, start)))
        + Math.min(48, commonPrefixLength(rightBase, current.slice(end)));
      return { start, end, score, distance: Math.abs(start - expected) };
    })
    .sort((left, right) => right.score - left.score || left.distance - right.distance);
  if (ranked.length === 1) return ranked[0];
  const [best, second] = ranked;
  if (best.score < 2 || best.score - second.score < 2) return null;
  return best;
}

function findUniqueLeftBoundary(current, prefix) {
  if (!prefix) return 0;
  const max = Math.min(48, prefix.length);
  for (let length = max; length >= 2; length -= 1) {
    const anchor = prefix.slice(-length);
    const candidates = occurrencesOf(current, anchor)
      .map((index) => index + anchor.length);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return null;
  }
  return null;
}

function findUniqueRightBoundary(current, suffix, minimum) {
  if (!suffix) return current.length;
  const max = Math.min(48, suffix.length);
  for (let length = max; length >= 2; length -= 1) {
    const anchor = suffix.slice(0, length);
    const candidates = occurrencesOf(current, anchor).filter((index) => index >= minimum);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return null;
  }
  return null;
}

function rebaseSelectionRange(base, current, selection) {
  if (current === base) return { start: selection.start, end: selection.end, rebased: false };
  const originalStart = Number(selection.start);
  const originalEnd = Number(selection.end);
  if (
    !Number.isInteger(originalStart)
    || !Number.isInteger(originalEnd)
    || originalStart < 0
    || originalEnd < originalStart
    || originalEnd > base.length
  ) {
    throw selectionMovedError('原选区无效，无法重新定位');
  }
  if (originalStart === 0 && originalEnd === base.length) {
    return { start: 0, end: current.length, rebased: true };
  }

  // 优先用原位置两侧的上下文定位。这样即使文档其他位置有相同文字，
  // 也不会因为“正文仍能搜到一次”而把建议应用到错误位置。
  const prefix = base.slice(0, originalStart);
  const suffix = base.slice(originalEnd);
  const start = findUniqueLeftBoundary(current, prefix);
  const end = start === null
    ? null
    : findUniqueRightBoundary(current, suffix, start);
  const hasRequiredContext = (
    (originalStart === 0 || start !== null)
    && (originalEnd === base.length || end !== null)
  );
  if (hasRequiredContext && start !== null && end !== null && end >= start) {
    assertReasonableRebasedRange(selection, start, end);
    return { start, end, rebased: true };
  }

  // 上下文被用户一并改写时，只在原选中文字仍有唯一且有区分度的位置时回退。
  const exact = bestExactSelection(base, current, selection);
  if (exact) {
    assertReasonableRebasedRange(selection, exact.start, exact.end);
    return { start: exact.start, end: exact.end, rebased: true };
  }
  throw selectionMovedError();
}

function loadInlineAction(actionId, user) {
  const action = db.get(
    'SELECT * FROM ai_action_requests WHERE id = ? AND owner_id = ?',
    [actionId, user.id],
  );
  if (!action || action.action_type !== ACTION_TYPE) {
    throw problem.notFound('局部修改建议不存在');
  }
  return action;
}

function applyInlineAction({ action, user, requestId, ipHash }) {
  return db.tx(() => {
    const payload = parseJson(action.payload_json, {});
    const ctx = loadProjectContext(payload.project_id, user);
    const currentResume = ResumeDom.toResumeDocument(parseJson(ctx.draft.resume_json, {}));
    const target = ResumeDom.findNode(currentResume, payload.target_node_id);
    if (
      !target
      || target.node.editable !== true
      || target.node.type !== payload.target_type
      || String(target.node.tag || '') !== String(payload.target_tag || '')
    ) {
      throw problem.conflict(
        'INLINE_TARGET_CHANGED',
        '这处内容的结构已经变化，请重新选择后修改',
      );
    }

    let operation;
    let rebased = false;
    if (payload.target_mode === 'selection') {
      const selection = payload.selection || {};
      const segment = ResumeDom.findNode(currentResume, selection.segment_id);
      if (
        !segment
        || !isDescendantOrSelf(segment, target.node.id)
        || segment.node.type !== selection.segment_type
        || String(segment.node.tag || '') !== String(selection.segment_tag || '')
      ) {
        throw problem.conflict(
          'INLINE_TARGET_CHANGED',
          '所选文字所在的位置已经变化，请重新选择',
        );
      }
      const currentText = ownNodeText(segment.node);
      let range;
      try {
        range = rebaseSelectionRange(
          String(selection.base_segment_text || ''),
          currentText,
          selection,
        );
      } catch (error) {
        throw problem.conflict(
          error.code || 'INLINE_SELECTION_MOVED',
          '所选文字已经发生较大变化，请重新选择后修改',
        );
      }
      rebased = range.rebased;
      operation = {
        op: 'replace_text',
        node_id: selection.segment_id,
        text: currentText.slice(0, range.start)
          + String(payload.suggestion || '')
          + currentText.slice(range.end),
      };
    } else {
      operation = {
        op: 'replace_text',
        node_id: payload.target_node_id,
        text: String(payload.suggestion || ''),
      };
      rebased = ctx.draft.revision !== payload.base_draft_revision;
    }

    let nextResume;
    try {
      nextResume = ResumeDom.applyDocumentOperations(currentResume, [operation], {
        allowStructure: false,
      });
    } catch (error) {
      throw problem.conflict(
        'INLINE_TARGET_CHANGED',
        '这处内容的段落结构已经变化，请重新选择后修改',
        { reason: error.message },
      );
    }

    if (hashJson(currentResume) === hashJson(nextResume)) {
      db.run(
        "UPDATE ai_action_requests SET status = 'applied', applied_at = ? WHERE id = ?",
        [nowIso(), action.id],
      );
      return {
        id: action.id,
        status: 'applied',
        revision: ctx.draft.revision,
        resume_json: currentResume,
        no_change: true,
        rebased,
        version_created: false,
      };
    }

    const changedAt = nowIso();
    const revision = ctx.draft.revision + 1;
    const changeId = uuidv7();
    const mutationId = uuidv7();
    const delta = createNodeDeltaPair(
      currentResume,
      nextResume,
      [payload.target_node_id],
      {
        label: String(payload.summary || 'AI 局部修改文字').slice(0, 120),
        input_type: 'inline_ai',
      },
    );
    db.run(
      `UPDATE resume_drafts
       SET resume_json = ?, revision = ?, has_unsnapshotted_changes = 1, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(nextResume), revision, changedAt, ctx.draft.id],
    );
    db.run(
      `INSERT INTO resume_change_events
       (id, project_id, owner_id, draft_revision, change_type, scope_type, scope_id,
        before_json, after_json, actor_type, mutation_id, created_at)
       VALUES (?, ?, ?, ?, 'inline_ai_text', 'RESUME_BLOCK', ?, ?, ?, 'ai', ?, ?)`,
      [
        changeId,
        ctx.project.id,
        user.id,
        revision,
        payload.target_node_id,
        JSON.stringify(delta.before),
        JSON.stringify(delta.after),
        mutationId,
        changedAt,
      ],
    );
    db.run(
      "UPDATE ai_action_requests SET status = 'applied', applied_at = ? WHERE id = ?",
      [changedAt, action.id],
    );
    refreshResumeProposalStaleness(db, ctx.project.id, user.id, {
      resume: nextResume,
      revision,
      excludeActionId: action.id,
    });
    audit.log({
      ownerId: user.id,
      action: 'resume_inline_ai_applied',
      resourceType: 'resume_draft',
      resourceId: ctx.draft.id,
      requestId,
      ipHash,
      metadata: {
        target_node_id: payload.target_node_id,
        target_mode: payload.target_mode,
        revision,
        rebased,
        change_event_id: changeId,
      },
    });
    return {
      id: action.id,
      status: 'applied',
      revision,
      resume_json: nextResume,
      change_id: changeId,
      mutation_id: mutationId,
      rebased,
      version_created: false,
    };
  });
}

const routes = [
  {
    method: 'POST',
    pattern: '/projects/:id/ai/inline-rewrites',
    handler: async ({ params, body, user, requestId, ipHash }) => {
      const instruction = String(body.instruction || '').trim();
      if (!instruction) throw problem.badRequest('请告诉 AI 你想怎么修改');
      if (instruction.length > 1000) throw problem.badRequest('修改要求不能超过 1000 个字符');
      if (!body.target_node_id) throw problem.badRequest('请选择要修改的简历文字');
      if (!['node', 'selection'].includes(body.target_mode || 'node')) {
        throw problem.badRequest('不支持的局部修改范围');
      }
      const ctx = loadProjectContext(params.id, user);
      const document = ResumeDom.toResumeDocument(parseJson(ctx.draft.resume_json, {}));
      const resolved = ResumeDom.resolveAiScopeNode(document, String(body.target_node_id));
      const target = resolved
        ? ResumeDom.findNode(document, resolved.node.id)
        : null;
      if (!target || target.node.editable !== true) {
        throw problem.badRequest('这处内容不能进行局部修改');
      }
      const selection = normalizeSelection(body, document, target);
      const input = buildModelInput(ctx, { ...body, instruction }, target, selection);
      const actionId = uuidv7();
      const initialPayload = {
        format: ACTION_FORMAT,
        project_id: ctx.project.id,
        target_mode: selection ? 'selection' : 'node',
        target_node_id: target.node.id,
        target_type: target.node.type,
        target_tag: target.node.tag || null,
        target_label: target.node.label || '',
        base_draft_revision: ctx.draft.revision,
        base_node_text: ResumeDom.exportNodeText(target.node),
        selection,
        instruction,
      };
      db.tx(() => {
        // 用户后发起的要求立即成为这一位置的最新意图。模型响应速度不能
        // 反向改变操作顺序，因此请求必须在调用模型前登记。
        supersedeEarlierActions(ctx.project.id, user.id, target.node.id);
        db.run(
          `INSERT INTO ai_action_requests
           (id, conversation_id, message_id, owner_id, action_type, target_type, target_id,
            payload_json, requires_user_action, status, expected_revision, policy_version, created_at)
           VALUES (?, NULL, NULL, ?, ?, 'RESUME_BLOCK', ?, ?, 0, 'processing', ?, ?, ?)`,
          [
            actionId,
            user.id,
            ACTION_TYPE,
            target.node.id,
            JSON.stringify(initialPayload),
            ctx.draft.revision,
            resumeHarness.INLINE_PROMPT_VERSION,
            nowIso(),
          ],
        );
      });

      let result;
      try {
        result = await resumeHarness.completeInlineRewrite(input);
      } catch (error) {
        db.run(
          `UPDATE ai_action_requests
           SET status = 'failed'
           WHERE id = ? AND status = 'processing'`,
          [actionId],
        );
        console.error('[inline-ai] failed', error.code || 'UNKNOWN', error.message);
        throw mapModelError(error);
      }
      if (result.response.type === 'message') {
        const payload = {
          ...initialPayload,
          response_content: result.response.content,
          handoff: true,
          model: {
            provider: result.provider,
            model: result.model,
            prompt_version: result.prompt_version,
            schema_version: result.schema_version,
            repair_count: result.repair_count || 0,
          },
        };
        db.run(
          `UPDATE ai_action_requests
           SET payload_json = ?, status = 'rejected', rejected_at = ?, policy_version = ?
           WHERE id = ? AND status = 'processing'`,
          [JSON.stringify(payload), nowIso(), result.prompt_version, actionId],
        );
        audit.log({
          ownerId: user.id,
          action: 'resume_inline_ai_handoff',
          resourceType: 'resume_draft',
          resourceId: ctx.draft.id,
          requestId,
          ipHash,
          metadata: {
            target_node_id: target.node.id,
            reason: result.response.content.slice(0, 240),
          },
        });
        return {
          type: 'message',
          result_type: 'MESSAGE',
          content: result.response.content,
          handoff: true,
          target_node_id: target.node.id,
          engine: { provider: result.provider, model: result.model },
        };
      }

      const payload = {
        ...initialPayload,
        suggestion: result.response.suggestion,
        summary: result.response.summary,
        response_content: result.response.content,
        model: {
          provider: result.provider,
          model: result.model,
          prompt_version: result.prompt_version,
          schema_version: result.schema_version,
          repair_count: result.repair_count || 0,
        },
      };
      db.run(
        `UPDATE ai_action_requests
         SET payload_json = ?, requires_user_action = 1,
             status = 'awaiting_confirmation', policy_version = ?
         WHERE id = ? AND status = 'processing'`,
        [JSON.stringify(payload), result.prompt_version, actionId],
      );
      const currentAction = loadInlineAction(actionId, user);
      audit.log({
        ownerId: user.id,
        action: 'resume_inline_ai_proposed',
        resourceType: 'ai_action_request',
        resourceId: actionId,
        requestId,
        ipHash,
        metadata: {
          project_id: ctx.project.id,
          target_node_id: target.node.id,
          target_mode: payload.target_mode,
          base_revision: ctx.draft.revision,
          repair_count: result.repair_count || 0,
          status: currentAction.status,
        },
      });
      return {
        type: 'proposal',
        result_type: 'PROPOSAL',
        content: result.response.content,
        action: {
          id: actionId,
          status: currentAction.status,
          action_type: ACTION_TYPE,
          target_id: target.node.id,
          expected_revision: ctx.draft.revision,
          payload,
        },
        engine: { provider: result.provider, model: result.model },
      };
    },
  },
  {
    method: 'POST',
    pattern: '/ai/inline-rewrites/:id/apply',
    handler: ({ params, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'inline_ai_apply', () => {
        const action = loadInlineAction(params.id, user);
        if (action.status === 'applied') {
          return { id: action.id, status: 'applied', idempotent_replay: true };
        }
        if (action.status !== 'awaiting_confirmation' && action.status !== 'proposed') {
          throw problem.conflict(
            'INLINE_PROPOSAL_UNAVAILABLE',
            action.status === 'superseded'
              ? '这处内容已有更新的局部建议'
              : '这条局部建议已经不能应用',
          );
        }
        return applyInlineAction({ action, user, requestId, ipHash });
      }),
  },
  {
    method: 'POST',
    pattern: '/ai/inline-rewrites/:id/reject',
    handler: ({ params, user, req, requestId, ipHash }) =>
      withIdempotency(user, req.headers['idempotency-key'], 'inline_ai_reject', () => {
        const action = loadInlineAction(params.id, user);
        if (
          ['rejected', 'applied', 'superseded', 'failed', 'stale', 'reverted']
            .includes(action.status)
        ) {
          return { id: action.id, status: action.status, idempotent_replay: true };
        }
        db.run(
          "UPDATE ai_action_requests SET status = 'rejected', rejected_at = ? WHERE id = ?",
          [nowIso(), action.id],
        );
        audit.log({
          ownerId: user.id,
          action: 'resume_inline_ai_rejected',
          resourceType: 'ai_action_request',
          resourceId: action.id,
          requestId,
          ipHash,
        });
        return { id: action.id, status: 'rejected', resume_unchanged: true };
      }),
  },
];

module.exports = {
  routes,
  ACTION_TYPE,
  ACTION_FORMAT,
  rebaseSelectionRange,
  normalizeSelection,
  applyInlineAction,
};
