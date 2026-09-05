'use strict';

const test = require('node:test');
const assert = require('node:assert');

const helpers = require('./helpers');
const db = helpers.db;
const resumeHarness = require('../server/lib/resume-harness');
const ResumeDom = require('../resume-dom');
const { rebaseSelectionRange } = require('../server/modules/inline-ai');

let ctx;
let projectId;

async function workspace() {
  return (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
}

async function propose(body) {
  return helpers.call(ctx, 'POST', `/projects/${projectId}/ai/inline-rewrites`, {
    body: {
      target_node_id: 'target-bullet',
      target_mode: 'node',
      instruction: '写得更专业，不增加新事实',
      ...body,
    },
  });
}

async function undo(label) {
  const result = await helpers.call(ctx, 'POST', `/projects/${projectId}/resume-draft/undo`, {
    idemKey: `inline-ai-undo-${label}-${Date.now()}`,
  });
  assert.strictEqual(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

test.before(async () => {
  ctx = await helpers.boot();
  projectId = await helpers.defaultProject(ctx);
});

test.after(() => helpers.close(ctx));

test('选区重定位优先使用原位置上下文，不会把第二处相同文字错改到第一处', () => {
  const base = '第一段目标；第二段目标';
  const start = base.lastIndexOf('目标');
  const current = '第一段目标；第二段已手改';
  const range = rebaseSelectionRange(base, current, {
    start,
    end: start + 2,
    text: '目标',
  });

  assert.strictEqual(current.slice(range.start, range.end), '已手改');
  assert.strictEqual(range.start, current.lastIndexOf('已手改'));
});

test('选区上下文歧义或异常膨胀时停止应用，不猜测用户原来选择的位置', () => {
  assert.throws(
    () => rebaseSelectionRange('AA目标ZZ', 'AA已改ZZ AA已改ZZ', {
      start: 2,
      end: 4,
      text: '目标',
    }),
    (error) => error.code === 'INLINE_SELECTION_MOVED',
  );

  const expanded = `左锚点${'扩'.repeat(412)}右锚点`;
  assert.throws(
    () => rebaseSelectionRange('左锚点目标文字右锚点', expanded, {
      start: 3,
      end: 7,
      text: '目标文字',
    }),
    (error) => error.code === 'INLINE_SELECTION_MOVED',
  );
});

test('局部 AI 读取完整简历上下文，但不写入右侧聊天', async () => {
  const before = await workspace();
  const messageCount = db.get('SELECT COUNT(*) AS total FROM ai_messages').total;
  let capturedInput = null;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'inline-context',
    generate: async ({ input }) => {
      capturedInput = input;
      return {
        output: {
          type: 'proposal',
          content: '已调整当前表达，其他内容保持不变。',
          suggestion: `${input.target.source_text}（表达更聚焦）`,
          summary: '优化当前文字表达',
        },
      };
    },
  });
  let result;
  try {
    result = await propose({});
  } finally {
    restore();
  }
  assert.strictEqual(result.status, 200, JSON.stringify(result.body));
  assert.strictEqual(result.body.type, 'proposal');
  assert.ok(capturedInput.workspace.resume.content.root);
  assert.strictEqual(capturedInput.workspace.resume.revision, before.draft.revision);
  assert.strictEqual(capturedInput.target.node_id, 'target-bullet');
  assert.strictEqual(capturedInput.target.mode, 'node');
  assert.strictEqual(db.get('SELECT COUNT(*) AS total FROM ai_messages').total, messageCount);
  const row = db.get('SELECT * FROM ai_action_requests WHERE id = ?', [result.body.action.id]);
  assert.strictEqual(row.conversation_id, null);
  assert.strictEqual(row.action_type, 'RESUME_INLINE_REWRITE_PROPOSAL');
  await helpers.call(ctx, 'POST', `/ai/inline-rewrites/${result.body.action.id}/reject`, {
    idemKey: `reject-inline-context-${result.body.action.id}`,
  });
});

test('标题经局部 AI 修改并落库后仍保留标题标签和编辑身份', async () => {
  const before = await workspace();
  const titleId = 'section-summary-title';
  const titleBefore = ResumeDom.findNode(before.draft.resume_json, titleId).node;
  assert.strictEqual(titleBefore.tag, 'h2');
  assert.strictEqual(titleBefore.editable, true);

  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'inline-heading-preservation',
    generate: async () => ({
      output: {
        type: 'proposal',
        content: '已准备新的模块标题。',
        suggestion: '职业概览',
        summary: '修改模块标题',
      },
    }),
  });
  let proposed;
  try {
    proposed = await propose({
      target_node_id: titleId,
      instruction: '把这个标题改为“职业概览”',
    });
  } finally {
    restore();
  }
  assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));

  const applied = await helpers.call(
    ctx,
    'POST',
    `/ai/inline-rewrites/${proposed.body.action.id}/apply`,
    { idemKey: `apply-inline-heading-${proposed.body.action.id}` },
  );
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  const titleAfter = ResumeDom.findNode(applied.body.resume_json, titleId).node;
  assert.strictEqual(titleAfter.tag, 'h2');
  assert.strictEqual(titleAfter.editable, true);
  assert.strictEqual(titleAfter.label, titleBefore.label);
  assert.strictEqual(ResumeDom.exportNodeText(titleAfter), '职业概览');
  assert.match(ResumeDom.renderToHtml(applied.body.resume_json), /<h2[^>]*>职业概览<\/h2>/);

  await undo('heading-ai');
});

test('局部节点建议确认时覆盖同节点的临时手改，并保留其他位置的新修改', async () => {
  const before = await workspace();
  const originalTarget = ResumeDom.exportNodeText(
    ResumeDom.findNode(before.draft.resume_json, 'target-bullet').node,
  );
  const contact = ResumeDom.exportNodeText(
    ResumeDom.findNode(before.draft.resume_json, 'resume-contact').node,
  );
  const suggestion = `${originalTarget}（AI 最终表达）`;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'inline-last-confirmation-wins',
    generate: async () => ({
      output: {
        type: 'proposal',
        content: '已准备当前节点的新表达。',
        suggestion,
        summary: '优化当前文字表达',
      },
    }),
  });
  let proposed;
  try {
    proposed = await propose({ instruction: '在结尾补充“AI 最终表达”' });
  } finally {
    restore();
  }
  assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));

  const changed = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/transactions`,
    {
      body: {
        expected_revision: before.draft.revision,
        mutation_id: `inline-concurrent-${Date.now()}`,
        operations: [
          {
            op: 'replace_text',
            node_id: 'target-bullet',
            text: `${originalTarget}（手工临时表达）`,
          },
          {
            op: 'replace_text',
            node_id: 'resume-contact',
            text: `${contact} · 手工更新`,
          },
        ],
        label: '并行手工修改',
      },
    },
  );
  assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));

  const applied = await helpers.call(
    ctx,
    'POST',
    `/ai/inline-rewrites/${proposed.body.action.id}/apply`,
    { idemKey: `apply-inline-last-wins-${proposed.body.action.id}` },
  );
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  assert.strictEqual(
    ResumeDom.exportNodeText(ResumeDom.findNode(applied.body.resume_json, 'target-bullet').node),
    suggestion,
  );
  assert.match(
    ResumeDom.exportNodeText(ResumeDom.findNode(applied.body.resume_json, 'resume-contact').node),
    /手工更新/,
  );
  assert.strictEqual(applied.body.rebased, true);

  await undo('node-ai');
  const afterAiUndo = await workspace();
  assert.match(
    ResumeDom.exportNodeText(
      ResumeDom.findNode(afterAiUndo.draft.resume_json, 'target-bullet').node,
    ),
    /手工临时表达/,
  );
  assert.match(
    ResumeDom.exportNodeText(
      ResumeDom.findNode(afterAiUndo.draft.resume_json, 'resume-contact').node,
    ),
    /手工更新/,
  );
  await undo('node-manual');
});

test('选中文字后来被手工改动，确认局部建议仍只覆盖原选区并保留周围文字', async () => {
  const before = await workspace();
  const source = ResumeDom.exportNodeText(
    ResumeDom.findNode(before.draft.resume_json, 'target-bullet').node,
  );
  const start = Math.max(1, Math.floor(source.length / 4));
  const end = Math.min(source.length - 1, start + Math.max(2, Math.floor(source.length / 8)));
  const selected = source.slice(start, end);
  const replacement = '更聚焦的表达';
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'inline-selection-rebase',
    generate: async ({ input }) => {
      assert.strictEqual(input.target.source_text, selected);
      return {
        output: {
          type: 'proposal',
          content: '只会替换选中的文字。',
          suggestion: replacement,
          summary: '改写选中文字',
        },
      };
    },
  });
  let proposed;
  try {
    proposed = await propose({
      target_mode: 'selection',
      selection: {
        segment_id: 'target-bullet',
        start,
        end,
        text: selected,
      },
      instruction: `把选中文字改成“${replacement}”`,
    });
  } finally {
    restore();
  }
  assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));

  const manualSelected = '手工临时内容';
  const currentText = source.slice(0, start) + manualSelected + source.slice(end) + '，保留这句';
  const changed = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/transactions`,
    {
      body: {
        expected_revision: before.draft.revision,
        mutation_id: `inline-selection-manual-${Date.now()}`,
        operations: [{ op: 'replace_text', node_id: 'target-bullet', text: currentText }],
        label: '手工调整选区和结尾',
      },
    },
  );
  assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));

  const applied = await helpers.call(
    ctx,
    'POST',
    `/ai/inline-rewrites/${proposed.body.action.id}/apply`,
    { idemKey: `apply-inline-selection-${proposed.body.action.id}` },
  );
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  const finalText = ResumeDom.exportNodeText(
    ResumeDom.findNode(applied.body.resume_json, 'target-bullet').node,
  );
  assert.strictEqual(
    finalText,
    source.slice(0, start) + replacement + source.slice(end) + '，保留这句',
  );
  assert.doesNotMatch(finalText, /手工临时内容/);
  await undo('selection-ai');
  await undo('selection-manual');
});

test('结构或跨区域要求会引导到右侧 AI，不生成可应用的局部动作', async () => {
  const beforeActions = db.get(
    "SELECT COUNT(*) AS total FROM ai_action_requests WHERE action_type = 'RESUME_INLINE_REWRITE_PROPOSAL'",
  ).total;
  const result = await propose({
    instruction: '在这里下面新增一个技能证书模块',
  });
  assert.strictEqual(result.status, 200, JSON.stringify(result.body));
  assert.strictEqual(result.body.type, 'message');
  assert.strictEqual(result.body.handoff, true);
  assert.match(result.body.content, /右侧 AI 对话/);
  const afterActions = db.get(
    "SELECT COUNT(*) AS total FROM ai_action_requests WHERE action_type = 'RESUME_INLINE_REWRITE_PROPOSAL'",
  ).total;
  assert.strictEqual(afterActions, beforeActions + 1);
  const recorded = db.get(
    `SELECT status, requires_user_action
     FROM ai_action_requests
     WHERE action_type = 'RESUME_INLINE_REWRITE_PROPOSAL'
     ORDER BY rowid DESC LIMIT 1`,
  );
  assert.strictEqual(recorded.status, 'rejected');
  assert.strictEqual(recorded.requires_user_action, 0);
  assert.strictEqual(Object.hasOwn(result.body, 'action'), false);
});

test('同一节点重新生成局部建议时，旧建议失效', async () => {
  const first = await propose({ instruction: '第一次改写' });
  const second = await propose({ instruction: '第二次改写' });
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));
  assert.strictEqual(second.status, 200, JSON.stringify(second.body));
  assert.strictEqual(
    db.get('SELECT status FROM ai_action_requests WHERE id = ?', [first.body.action.id]).status,
    'superseded',
  );
  const oldApply = await helpers.call(
    ctx,
    'POST',
    `/ai/inline-rewrites/${first.body.action.id}/apply`,
    { idemKey: `apply-superseded-inline-${first.body.action.id}` },
  );
  assert.strictEqual(oldApply.status, 409, JSON.stringify(oldApply.body));
  assert.strictEqual(oldApply.body.title, 'INLINE_PROPOSAL_UNAVAILABLE');
  await helpers.call(ctx, 'POST', `/ai/inline-rewrites/${second.body.action.id}/reject`, {
    idemKey: `reject-new-inline-${second.body.action.id}`,
  });
});

test('目标节点被结构删除后，局部建议只返回可理解的客观冲突', async () => {
  const before = await workspace();
  const proposed = await propose({ instruction: '优化当前表达' });
  assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));
  const deletedDocument = ResumeDom.applyDocumentOperations(
    before.draft.resume_json,
    [{ op: 'remove_node', node_id: 'target-bullet' }],
    { allowStructure: true },
  );
  const deleted = await helpers.call(ctx, 'PATCH', `/projects/${projectId}/resume-draft`, {
    body: {
      expected_revision: before.draft.revision,
      resume_json: deletedDocument,
    },
  });
  assert.strictEqual(deleted.status, 200, JSON.stringify(deleted.body));
  const applied = await helpers.call(
    ctx,
    'POST',
    `/ai/inline-rewrites/${proposed.body.action.id}/apply`,
    { idemKey: `apply-missing-inline-${proposed.body.action.id}` },
  );
  assert.strictEqual(applied.status, 409, JSON.stringify(applied.body));
  assert.strictEqual(applied.body.title, 'INLINE_TARGET_CHANGED');
  assert.match(applied.body.detail, /重新选择/);

  const restored = await helpers.call(ctx, 'PATCH', `/projects/${projectId}/resume-draft`, {
    body: {
      expected_revision: deleted.body.revision,
      resume_json: before.draft.resume_json,
    },
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.body));
  await helpers.call(ctx, 'POST', `/ai/inline-rewrites/${proposed.body.action.id}/reject`, {
    idemKey: `reject-missing-inline-${proposed.body.action.id}`,
  });
});

test('模型遗漏原文数字时自动修复一次，再给用户确认', async () => {
  const before = await workspace();
  const source = ResumeDom.exportNodeText(
    ResumeDom.findNode(before.draft.resume_json, 'target-bullet').node,
  );
  const number = (source.match(/\d+(?:\\.\\d+)?%?/) || [])[0];
  assert.ok(number, '演示节点应包含数字事实');
  let calls = 0;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'inline-fact-repair',
    generate: async () => {
      calls += 1;
      return {
        output: {
          type: 'proposal',
          content: '已精简当前表达。',
          suggestion: calls === 1
            ? source.replace(number, '')
            : `${source}（表达更紧凑）`,
          summary: '精简当前文字',
        },
      };
    },
  });
  let result;
  try {
    result = await propose({ instruction: '写得更精简，保留全部数字' });
  } finally {
    restore();
  }
  assert.strictEqual(result.status, 200, JSON.stringify(result.body));
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.body.action.payload.model.repair_count, 1);
  assert.match(result.body.action.payload.suggestion, new RegExp(number.replace('%', '\\%')));
  await helpers.call(ctx, 'POST', `/ai/inline-rewrites/${result.body.action.id}/reject`, {
    idemKey: `reject-inline-repair-${result.body.action.id}`,
  });
});

test('局部模型返回合法 JSON 但缺少字段时只修复一次，并恢复为可确认建议', async () => {
  const before = await workspace();
  const source = ResumeDom.exportNodeText(
    ResumeDom.findNode(before.draft.resume_json, 'target-bullet').node,
  );
  let calls = 0;
  const budgets = [];
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'inline-schema-recovery',
    generate: async ({ maxTokens }) => {
      calls += 1;
      budgets.push(maxTokens);
      if (calls === 1) {
        return {
          output: {
            type: 'proposal',
            content: '已完成。',
          },
        };
      }
      return {
        output: {
          type: 'proposal',
          content: '已生成完整的局部建议。',
          suggestion: `${source}（更清晰）`,
          summary: '优化当前表达',
        },
      };
    },
  });
  let result;
  try {
    result = await propose({ instruction: '写得更清晰' });
  } finally {
    restore();
  }
  assert.strictEqual(result.status, 200, JSON.stringify(result.body));
  assert.strictEqual(calls, 2);
  assert.ok(budgets[1] >= budgets[0]);
  assert.strictEqual(result.body.action.payload.model.repair_count, 1);
  await helpers.call(ctx, 'POST', `/ai/inline-rewrites/${result.body.action.id}/reject`, {
    idemKey: `reject-inline-schema-recovery-${result.body.action.id}`,
  });
});

test('局部模型连续截断时区分为结果过长，不误报服务不可用且最多调用两次', async () => {
  let calls = 0;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'inline-truncated-twice',
    generate: async () => {
      calls += 1;
      const error = new Error('模型输出达到长度上限');
      error.code = 'DEEPSEEK_OUTPUT_TRUNCATED';
      error.finish_reason = 'length';
      throw error;
    },
  });
  let result;
  try {
    result = await propose({ instruction: '润色当前文字' });
  } finally {
    restore();
  }
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.status, 422, JSON.stringify(result.body));
  assert.strictEqual(result.body.title, 'MODEL_OUTPUT_TRUNCATED');
  assert.match(result.body.detail, /结果过长/);
});
