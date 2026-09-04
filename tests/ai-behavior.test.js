'use strict';
const test = require('node:test');
const assert = require('node:assert');

const helpers = require('./helpers');
const db = require('../server/lib/db');
const ResumeDom = require('../resume-dom');
const resumeHarness = require('../server/lib/resume-harness');

let ctx;
let projectId;

const workspace = async () => (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
const send = (content, scope = {}, extra = {}) =>
  helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content,
      scope_type: scope.type || 'RESUME_DOCUMENT',
      scope_id: scope.id || null,
      ...extra,
    },
  });

test.before(async () => {
  ctx = await helpers.boot();
  projectId = await helpers.defaultProject(ctx);
});
test.after(() => helpers.close(ctx));

test('数据模型不包含内容来源、证据映射或废弃文档编辑器表', async () => {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
  assert.ok(!tables.includes('fact_candidates'));
  assert.ok(!tables.includes('resume_document_revisions'));
  assert.ok(!tables.includes('resume_editor_sessions'));
  const actionColumns = db.all('PRAGMA table_info(ai_action_requests)').map((row) => row.name);
  assert.ok(!actionColumns.includes('evidence_json'));
  assert.ok(!actionColumns.includes('confidence'));
  const messageColumns = db.all('PRAGMA table_info(ai_messages)').map((row) => row.name);
  assert.ok(messageColumns.includes('task_id'));
  const retiredColumns = [
    ['resume_drafts', ['document_format', 'document_object_key', 'document_sha256', 'document_revision', 'semantic_index_status']],
    ['resume_versions', ['document_object_key', 'document_sha256', 'document_revision']],
    ['generation_snapshots', ['document_object_key', 'document_sha256', 'document_revision']],
  ];
  retiredColumns.forEach(([table, forbidden]) => {
    const columns = db.all(`PRAGMA table_info(${table})`).map((row) => row.name);
    forbidden.forEach((column) => assert.ok(!columns.includes(column), `${table}.${column}`));
  });

  const ws = await workspace();
  assert.strictEqual(Object.hasOwn(ws, 'pending_facts'), false);
  assert.strictEqual(JSON.stringify(ws.draft.resume_json).includes('source_item_ids'), false);
  assert.strictEqual(JSON.stringify(ws.draft.resume_json).includes('evidence_map'), false);
});

test('用户在对话中明确提供的新数据可直接进入简历建议，资料不自动变化', async () => {
  const before = await workspace();
  const res = await send(
    '我带领 20 人团队，把它写进简历',
    { type: 'RESUME_BLOCK', id: 'target-bullet' },
  );
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const rewrite = res.body.actions.find((item) => item.action_type === 'RESUME_REWRITE_PROPOSAL');
  assert.ok(rewrite);
  assert.match(rewrite.payload.proposal.suggestion, /20\s*人/);
  assert.ok(!res.body.actions.some((item) => item.action_type === 'PROFILE_SAVE_PROPOSAL'));
  assert.deepStrictEqual((await workspace()).profile, before.profile);
});

test('“改成 2 个段落”由模型理解为结构改写，不触发资料动作', async () => {
  const res = await send(
    '我是说把当前一个段落改成 2 个段落',
    { type: 'RESUME_BLOCK', id: 'target-bullet' },
  );
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body.actions.map((item) => item.action_type), ['RESUME_REWRITE_PROPOSAL']);
  assert.match(res.body.actions[0].payload.proposal.suggestion, /\n/);
});

test('保存到资料需要明确的独立提案和用户确认', async () => {
  const before = await workspace();
  const res = await send('把所在城市改为杭州并保存到资料', { type: 'DATA_PROFILE' });
  const action = res.body.actions.find((item) => item.action_type === 'PROFILE_SAVE_PROPOSAL');
  assert.ok(action, JSON.stringify(res.body));
  assert.strictEqual((await workspace()).profile.basics.city, before.profile.basics.city);

  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: `profile-save-${action.id}`,
    body: { expected_revision: before.profile.revision },
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  assert.strictEqual((await workspace()).profile.basics.city, '杭州');
});

test('同一轮可同时提出资料保存和简历修改，但二者互不代替', async () => {
  const before = await workspace();
  const res = await send(
    '写得更专业，并把城市改为北京保存到资料',
    { type: 'RESUME_BLOCK', id: 'target-bullet' },
  );
  const types = res.body.actions.map((item) => item.action_type).sort();
  assert.deepStrictEqual(types, ['PROFILE_SAVE_PROPOSAL', 'RESUME_REWRITE_PROPOSAL']);
  assert.strictEqual((await workspace()).profile.basics.city, before.profile.basics.city);
  assert.strictEqual((await workspace()).draft.revision, before.draft.revision);

  const rewrite = res.body.actions.find((item) => item.action_type === 'RESUME_REWRITE_PROPOSAL');
  await helpers.call(ctx, 'POST', `/ai/actions/${rewrite.id}/apply`, {
    idemKey: `rewrite-only-${rewrite.id}`,
    body: { expected_revision: before.draft.revision },
  });
  const afterRewrite = await workspace();
  assert.ok(afterRewrite.draft.revision > before.draft.revision);
  assert.strictEqual(afterRewrite.profile.basics.city, before.profile.basics.city);
});

test('岗位变化是独立提案，确认前不切换当前岗位', async () => {
  const before = await workspace();
  const res = await send(
    '设为当前岗位，岗位内容：负责 AI 产品规划与商业化落地，要求 5 年产品经验。',
    { type: 'DATA_JOB' },
  );
  const action = res.body.actions.find((item) => item.action_type === 'JOB_SET_CURRENT_PROPOSAL');
  assert.ok(action, JSON.stringify(res.body));
  assert.strictEqual((await workspace()).job.id, before.job.id);

  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: `job-set-${action.id}`,
    body: { expected_revision: before.project.revision },
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  assert.notStrictEqual((await workspace()).job.id, before.job.id);
});

test('持久化动作中不出现被禁止的关系字段', () => {
  const rows = db.all('SELECT payload_json FROM ai_action_requests');
  rows.forEach((row) => {
    const payload = JSON.parse(row.payload_json || '{}');
    const text = JSON.stringify(payload);
    for (const key of ['evidence', 'source_item_id', 'source_item_ids', 'dependency_fact_ids']) {
      assert.strictEqual(text.includes(`"${key}"`), false, key);
    }
  });
});

test('无效结构动作会通用修复为可确认建议', async () => {
  let calls = 0;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'repair-structure-action',
    generate: async ({ input }) => {
      calls += 1;
      if (calls === 1) {
        return {
          output: {
            reply: '建议增加两个段落，确认后即可应用。',
            actions: [{
              type: 'RESUME_REWRITE_PROPOSAL',
              payload: { proposal: { operations: [{}] } },
            }],
            uncertainty: [],
          },
        };
      }
      const current = ResumeDom.toResumeDocument(input.workspace.resume.content);
      const anchor = current.root.children[0];
      return {
        output: {
          reply: '已生成可执行的段落结构建议，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                suggestion: '增加一个可继续填写的段落',
                change_constraints: {
                  content: 'preserve',
                  structure: 'modify',
                  style: 'preserve',
                  allowed_region_ids: [current.root.id],
                },
                operations: [{
                  op: 'insert_node',
                  parent_id: current.root.id,
                  after_node_id: anchor && anchor.id,
                  node: {
                    id: 'ai-empty-paragraph-repair-test',
                    type: 'element',
                    tag: 'p',
                    text: '',
                    editable: true,
                    label: '新增段落',
                  },
                }],
              },
            },
          }],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const res = await send('在当前简历中增加一个可以继续填写的段落');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls, 2);
    const action = res.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(action, JSON.stringify(res.body));
    assert.strictEqual(
      action.payload.proposal.operations[0].op,
      'insert_node',
    );
    const assistant = db.get('SELECT model_metadata_json FROM ai_messages WHERE id = ?', [
      res.body.reply.id,
    ]);
    assert.strictEqual(JSON.parse(assistant.model_metadata_json).repair_count, 1);
    await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/reject`, {
      idemKey: `reject-repaired-${action.id}`,
      body: { reason: '测试结束' },
    });
  } finally {
    restore();
  }
});

test('最终建议未通过领域校验时不伪造用户意图追问', async () => {
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'rejected-action-copy',
    generate: async ({ input }) => ({
      output: {
        reply: '建议改成突出提升99999%的表达，确认后即可应用。',
        actions: [{
          type: 'RESUME_REWRITE_PROPOSAL',
          payload: {
            proposal: {
              suggestion: `${input.currentText}，推动效率提升99999%。`,
            },
          },
        }],
        uncertainty: [],
      },
    }),
  });
  try {
    const res = await send(
      '帮我写得更专业',
      { type: 'RESUME_BLOCK', id: 'target-bullet' },
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.actions, []);
    assert.ok(res.body.rejected.length);
    assert.strictEqual(res.body.result_type, 'ERROR');
    assert.match(res.body.reply_text, /没有通过最终校验/);
    assert.deepStrictEqual(res.body.quick_replies, []);
    assert.doesNotMatch(res.body.reply_text, /确认后|即可应用/);
    assert.strictEqual(res.body.reply.content, res.body.reply_text);
  } finally {
    restore();
  }
});

test('连续两次不可执行的模型动作返回准确错误类型', async () => {
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'invalid-operation-twice',
    generate: async () => ({
      output: {
        reply: '确认后即可应用。',
        actions: [{
          type: 'RESUME_REWRITE_PROPOSAL',
          payload: {
            proposal: {
              operations: [{}],
              change_constraints: {
                content: 'preserve',
                structure: 'modify',
                style: 'preserve',
                allowed_region_ids: ['target-bullet'],
              },
            },
          },
        }],
        uncertainty: [],
      },
    }),
  });
  try {
    const res = await send(
      '把这段内容调整成更清晰的结构',
      { type: 'RESUME_BLOCK', id: 'target-bullet' },
    );
    assert.strictEqual(res.status, 422, JSON.stringify(res.body));
    assert.strictEqual(res.body.title, 'PROPOSAL_NOT_EXECUTABLE');
    assert.match(res.body.detail, /无法安全应用/);
    assert.doesNotMatch(res.body.detail, /没有返回可用结果/);
    assert.ok(res.body.persisted_message_id);
    const task = db.get('SELECT * FROM ai_tasks WHERE id = ?', [res.body.task_id]);
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(JSON.parse(task.state_json).last_error.code, 'PROPOSAL_NOT_EXECUTABLE');
    const failureMessage = db.get('SELECT * FROM ai_messages WHERE id = ?', [
      res.body.persisted_message_id,
    ]);
    assert.match(failureMessage.content, /这次请求没有成功/);
  } finally {
    restore();
  }
});

test('真实结果歧义先澄清，用户回答后在同一任务生成建议', async () => {
  let calls = 0;
  let resumedInput = null;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'clarification-resume-task',
    generate: async ({ input }) => {
      calls += 1;
      if (calls === 1) {
        return {
          output: {
            type: 'message',
            content: '你希望只保留一个整体段落，还是保留原文字并拆成多个段落？',
            awaiting_user: true,
            quick_replies: [
              { id: 'single', label: '合并成一个段落' },
              { id: 'split', label: '保留文字并拆段' },
            ],
          },
        };
      }
      resumedInput = input;
      const base = String(input.focus.editing_base || '');
      return {
        output: {
          result_type: 'PROPOSAL',
          reply: '已按你的选择准备文字调整，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                suggestion: base.includes('，')
                  ? base.replace('，', '；')
                  : `${base}。`,
              },
            },
          }],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const first = await send(
      '帮我调整一下这里的段落结构',
      { type: 'RESUME_BLOCK', id: 'target-bullet' },
    );
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(first.body.result_type, 'MESSAGE');
    assert.strictEqual(first.body.awaiting_user, true);
    assert.deepStrictEqual(first.body.actions, []);
    assert.strictEqual(
      db.get('SELECT status FROM ai_tasks WHERE id = ?', [first.body.task_id]).status,
      'clarifying',
    );

    const second = await send(
      '合并成一个段落',
      { type: 'RESUME_BLOCK', id: 'target-bullet' },
      { task_id: first.body.task_id },
    );
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(second.body.task_id, first.body.task_id);
    assert.strictEqual(second.body.result_type, 'PROPOSAL');
    assert.ok(second.body.actions.some((action) =>
      action.action_type === 'RESUME_REWRITE_PROPOSAL'));
    assert.strictEqual(
      resumedInput.request.task.state.answered_message.content,
      '你希望只保留一个整体段落，还是保留原文字并拆成多个段落？',
    );
    assert.strictEqual(
      db.get('SELECT status FROM ai_tasks WHERE id = ?', [first.body.task_id]).status,
      'waiting_apply',
    );
  } finally {
    restore();
  }
});

test('复杂请求先确认极简处理思路，确认后在同一任务直接生成建议', async () => {
  let calls = 0;
  let resumedInput = null;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'confirmed-plan-task',
    generate: async ({ input }) => {
      calls += 1;
      if (calls === 1) {
        return {
          output: {
            type: 'message',
            content: '我准备这样修改：\n1. 结合整份简历中的相关经历\n2. 强化管理经验并去除重复表达\n3. 最终整理为三个清晰段落\n本次先只修改当前内容。',
            awaiting_user: true,
            quick_replies: ['按这个思路修改', '调整要求'],
          },
        };
      }
      resumedInput = input;
      return {
        output: {
          result_type: 'PROPOSAL',
          reply: '已按确认的思路准备修改，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                suggestion: `${input.focus.current_text} 管理重点更加突出。`,
              },
            },
          }],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const first = await send(
      '合并重复内容，扩充成三段，更突出管理经验',
      { type: 'RESUME_BLOCK', id: 'target-bullet' },
    );
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(first.body.result_type, 'MESSAGE');
    assert.strictEqual(first.body.awaiting_user, true);
    assert.strictEqual(first.body.actions.length, 0);
    assert.strictEqual(first.body.quick_replies.length, 2);
    assert.strictEqual(
      db.get('SELECT status FROM ai_tasks WHERE id = ?', [first.body.task_id]).status,
      'clarifying',
    );

    const second = await send(
      '按这个思路修改',
      { type: 'RESUME_BLOCK', id: 'target-bullet' },
      { task_id: first.body.task_id },
    );
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(second.body.task_id, first.body.task_id);
    assert.strictEqual(second.body.result_type, 'PROPOSAL');
    assert.ok(second.body.actions.some((action) =>
      action.action_type === 'RESUME_REWRITE_PROPOSAL'));
    assert.strictEqual(
      resumedInput.request.task.state.answered_message.content,
      first.body.reply_text,
    );
  } finally {
    restore();
  }
});

test('同一会话中的多个修改任务分别保存上下文，不会互相串线', async () => {
  let continuedInput = null;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'task-isolated-conversation',
    generate: async ({ input }) => {
      if (input.request.text === '继续任务一') continuedInput = input;
      return {
        output: {
          type: 'message',
          content: input.request.text === '继续任务一'
            ? '任务一已经沟通完成。'
            : `正在处理：${input.request.text}`,
          awaiting_user: input.request.text !== '继续任务一',
        },
      };
    },
  });
  try {
    const conversationId = (await workspace()).conversation.id;
    const first = await send('任务一', {}, { conversation_id: conversationId });
    const second = await send('任务二', {}, { conversation_id: conversationId });
    assert.notStrictEqual(first.body.task_id, second.body.task_id);

    const continued = await send('继续任务一', {}, {
      conversation_id: conversationId,
      task_id: first.body.task_id,
    });
    assert.strictEqual(continued.status, 200, JSON.stringify(continued.body));
    assert.ok(continuedInput);
    const remembered = continuedInput.conversation.recent_messages.map((item) => item.content);
    assert.ok(remembered.includes('任务一'));
    assert.ok(remembered.includes('正在处理：任务一'));
    assert.ok(!remembered.includes('任务二'));
    assert.ok(!remembered.includes('继续任务一'), '当前消息应只在 request 中出现一次');

    const taskRows = db.all(
      'SELECT DISTINCT task_id FROM ai_messages WHERE conversation_id = ? AND task_id IS NOT NULL',
      [conversationId],
    );
    assert.ok(taskRows.some((row) => row.task_id === first.body.task_id));
    assert.ok(taskRows.some((row) => row.task_id === second.body.task_id));
  } finally {
    restore();
  }
});

test('完整目标文档可三方合并到最新草稿并支持撤销重做', async () => {
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'target-document-three-way-merge',
    generate: async ({ input }) => {
      const replacement = ResumeDom.toResumeDocument(input.workspace.resume.content);
      replacement.styles = {
        ...(replacement.styles || {}),
        '--replacement-test': 'enabled',
      };
      return {
        output: {
          reply: '已生成整份文档替换建议，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                suggestion: '更新整份简历样式',
                change_constraints: {
                  content: 'preserve',
                  structure: 'preserve',
                  style: 'modify',
                  allowed_region_ids: [replacement.root.id],
                },
                target_resume_document: replacement,
              },
            },
          }],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const before = await workspace();
    const proposed = await send('更新整份简历样式');
    const action = proposed.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(action, JSON.stringify(proposed.body));
    assert.deepStrictEqual(action.payload.proposal.operations, []);

    const target = ResumeDom.findNode(before.draft.resume_json, 'target-bullet');
    assert.ok(target);
    const changed = await helpers.call(
      ctx,
      'POST',
      `/projects/${projectId}/resume-draft/transactions`,
      {
        body: {
          expected_revision: before.draft.revision,
          mutation_id: `full-replacement-conflict-${Date.now()}`,
          operations: [{
            op: 'replace_text',
            node_id: 'target-bullet',
            text: `${ResumeDom.nodeText(target.node)} 用户并行修改`,
          }],
        },
      },
    );
    assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
    assert.strictEqual(
      db.get('SELECT status FROM ai_action_requests WHERE id = ?', [action.id]).status,
      'awaiting_confirmation',
    );
    const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
      idemKey: `target-document-rebase-${action.id}`,
      body: { expected_revision: action.expected_revision },
    });
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.strictEqual(applied.body.resume_json.styles['--replacement-test'], 'enabled');
    assert.match(
      ResumeDom.nodeText(
        ResumeDom.findNode(applied.body.resume_json, 'target-bullet').node,
      ),
      /用户并行修改/,
    );
    const persisted = JSON.parse(
      db.get('SELECT payload_json FROM ai_action_requests WHERE id = ?', [action.id]).payload_json,
    ).proposal;
    assert.strictEqual(persisted.merge_result.rebased, true);

    const undone = await helpers.call(
      ctx,
      'POST',
      `/projects/${projectId}/resume-draft/undo`,
      { idemKey: `target-document-undo-${action.id}` },
    );
    assert.strictEqual(undone.status, 200, JSON.stringify(undone.body));
    assert.strictEqual(undone.body.resume_json.styles['--replacement-test'], undefined);
    assert.match(
      ResumeDom.nodeText(
        ResumeDom.findNode(undone.body.resume_json, 'target-bullet').node,
      ),
      /用户并行修改/,
    );

    const redone = await helpers.call(
      ctx,
      'POST',
      `/projects/${projectId}/resume-draft/redo`,
      { idemKey: `target-document-redo-${action.id}` },
    );
    assert.strictEqual(redone.status, 200, JSON.stringify(redone.body));
    assert.strictEqual(redone.body.resume_json.styles['--replacement-test'], 'enabled');
  } finally {
    restore();
  }
});

test('目标节点已被另一项结构修改删除时只返回可重新生成的客观冲突', async () => {
  let originalAction = null;
  let deleteAction = null;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'target-document-objective-conflict',
    generate: async ({ input }) => {
      const current = ResumeDom.toResumeDocument(input.workspace.resume.content);
      const deleting = /删除/.test(input.request.text);
      const target = ResumeDom.applyDocumentOperations(
        current,
        deleting
          ? [{ op: 'remove_node', node_id: 'target-bullet' }]
          : [{ op: 'replace_text', node_id: 'target-bullet', text: 'AI 等待应用的改写' }],
        { allowStructure: true },
      );
      return {
        output: {
          reply: deleting
            ? '将删除这项内容，确认后即可应用。'
            : '已生成改写建议，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                suggestion: deleting ? '删除这项内容' : 'AI 等待应用的改写',
                change_constraints: {
                  content: 'modify',
                  structure: deleting ? 'modify' : 'preserve',
                  style: 'preserve',
                  allowed_region_ids: deleting ? [current.root.id] : ['target-bullet'],
                },
                target_resume_document: target,
              },
            },
          }],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const first = await send(
      '改写当前内容',
      { type: 'RESUME_BLOCK', id: 'target-bullet' },
    );
    originalAction = first.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(originalAction, JSON.stringify(first.body));

    const second = await send('删除 target-bullet 这项内容');
    deleteAction = second.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(deleteAction, JSON.stringify(second.body));
    const deleted = await helpers.call(ctx, 'POST', `/ai/actions/${deleteAction.id}/apply`, {
      idemKey: `delete-target-before-apply-${deleteAction.id}`,
      body: { expected_revision: deleteAction.expected_revision },
    });
    assert.strictEqual(deleted.status, 200, JSON.stringify(deleted.body));
    assert.strictEqual(ResumeDom.findNode(deleted.body.resume_json, 'target-bullet'), null);

    const conflicted = await helpers.call(ctx, 'POST', `/ai/actions/${originalAction.id}/apply`, {
      idemKey: `objective-merge-conflict-${originalAction.id}`,
      body: { expected_revision: originalAction.expected_revision },
    });
    assert.strictEqual(conflicted.status, 409, JSON.stringify(conflicted.body));
    assert.strictEqual(conflicted.body.title, 'PROPOSAL_REBASE_REQUIRED');
    assert.strictEqual(conflicted.body.merge_errors[0].code, 'CHANGED_NODE_MISSING');
    assert.match(conflicted.body.recovery_instruction, /最新简历重新生成/);
  } finally {
    restore();
    if (originalAction) {
      await helpers.call(ctx, 'POST', `/ai/actions/${originalAction.id}/reject`, {
        idemKey: `cleanup-objective-conflict-${originalAction.id}`,
        body: { reason: '测试清理' },
      });
    }
    if (deleteAction) {
      await helpers.call(
        ctx,
        'POST',
        `/projects/${projectId}/resume-draft/undo`,
        { idemKey: `cleanup-delete-target-${deleteAction.id}` },
      );
    }
  }
});

test('结构建议未提供说明文字时仍展示真实修改前后内容', async () => {
  const mergedId = 'summary-preview-without-model-suggestion';
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'structure-preview-without-suggestion',
    generate: async ({ input }) => {
      const original = ResumeDom.nodeText(
        ResumeDom.findNode(input.workspace.resume.content, 'summary').node,
      );
      return {
        output: {
          reply: '已把当前内容合并成一个段落，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                change_constraints: {
                  content: 'preserve',
                  structure: 'modify',
                  style: 'preserve',
                  allowed_region_ids: ['section-summary'],
                },
                operations: [
                  { op: 'remove_node', node_id: 'summary' },
                  {
                    op: 'insert_node',
                    parent_id: 'section-summary',
                    after_node_id: 'section-summary-title',
                    node: {
                      id: mergedId,
                      type: 'element',
                      tag: 'p',
                      text: original,
                      editable: true,
                    },
                  },
                ],
              },
            },
          }],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const before = await workspace();
    const original = ResumeDom.nodeText(
      ResumeDom.findNode(before.draft.resume_json, 'summary').node,
    );
    const result = await send(
      '把下面的内容合并到一个区域沟通',
      { type: 'RESUME_BLOCK', id: 'section-summary-title' },
    );
    const action = result.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(action, JSON.stringify(result.body));
    const proposal = action.payload.proposal;
    assert.strictEqual(proposal.change_preview.before.text, original);
    assert.strictEqual(
      proposal.change_preview.after.text,
      original,
    );
    assert.strictEqual(proposal.suggestion, original);
    assert.doesNotMatch(proposal.suggestion, /新增模块或内容|删除内容/);
    await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/reject`, {
      idemKey: `reject-preview-without-suggestion-${action.id}`,
      body: { reason: '仅验证预览' },
    });
  } finally {
    restore();
  }
});

test('只要求调整结构时，丢失原文的建议会修复后再进入确认', async () => {
  let calls = 0;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'structure-content-preservation',
    generate: async ({ input }) => {
      calls += 1;
      const original = ResumeDom.nodeText(
        ResumeDom.findNode(input.workspace.resume.content, 'summary').node,
      );
      const sentences = original.match(/[^。]+。?/g) || [original];
      const first = sentences[0];
      const second = sentences.slice(1).join('');
      const nodes = calls === 1
        ? [
            {
              id: 'summary-lossy-1',
              type: 'element',
              tag: 'p',
              text: first,
              editable: true,
            },
            {
              id: 'summary-lossy-2',
              type: 'element',
              tag: 'p',
              text: '',
              editable: true,
            },
          ]
        : [
            {
              id: 'summary-safe-1',
              type: 'element',
              tag: 'p',
              text: first,
              editable: true,
            },
            {
              id: 'summary-safe-2',
              type: 'element',
              tag: 'p',
              text: second,
              editable: true,
            },
          ];
      return {
        output: {
          reply: '已把原段落拆成两个独立段落，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                change_constraints: {
                  content: 'preserve',
                  structure: 'modify',
                  style: 'preserve',
                  allowed_region_ids: ['section-summary'],
                },
                operations: [
                  { op: 'remove_node', node_id: 'summary' },
                  {
                    op: 'insert_node',
                    parent_id: 'section-summary',
                    after_node_id: 'section-summary-title',
                    node: nodes[0],
                  },
                  {
                    op: 'insert_node',
                    parent_id: 'section-summary',
                    after_node_id: nodes[0].id,
                    node: nodes[1],
                  },
                ],
              },
            },
          }],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const before = await workspace();
    const original = ResumeDom.nodeText(
      ResumeDom.findNode(before.draft.resume_json, 'summary').node,
    );
    const result = await send(
      '只把职业概况拆成两个段落，原文字一字不要少',
      { type: 'RESUME_BLOCK', id: 'section-summary-title' },
    );
    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(calls, 2);
    const action = result.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(action, JSON.stringify(result.body));
    assert.strictEqual(
      action.payload.proposal.change_policy.format,
      'resume-change-authorization-v2-region-boundaries',
    );
    assert.strictEqual(action.payload.proposal.change_constraints.content, 'preserve');
    assert.strictEqual(
      action.payload.proposal.change_preview.after.text.replace(/\n/g, ''),
      original,
    );
    await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/reject`, {
      idemKey: `reject-structure-content-preservation-${action.id}`,
      body: { reason: '测试结束' },
    });
  } finally {
    restore();
  }
});

test('结构建议继续调整时读取建议态 B，并把 B→C 组合为可应用结果', async () => {
  let calls = 0;
  const combinedId = 'summary-combined-proposal';
  const itemOneId = 'summary-split-1';
  const itemTwoId = 'summary-split-2';
  let originalText = '';
  let itemOneText = '';
  let itemTwoText = '';
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'proposal-document-continuation',
    generate: async ({ input }) => {
      calls += 1;
      if (calls === 1) {
        assert.strictEqual(input.workspace.resume.proposal_content, undefined);
        originalText = ResumeDom.nodeText(
          ResumeDom.findNode(input.workspace.resume.content, 'summary').node,
        );
        const sentences = (originalText.match(/[^。]+。?/g) || []).filter(Boolean);
        itemOneText = sentences[0];
        itemTwoText = sentences.slice(1).join('');
        return {
          output: {
            reply: '已生成合并建议，确认后即可应用。',
            actions: [{
              type: 'RESUME_REWRITE_PROPOSAL',
              payload: {
                proposal: {
                  suggestion: '把当前模块内容合并为一个段落',
                  change_constraints: {
                    content: 'preserve',
                    structure: 'modify',
                    style: 'preserve',
                    allowed_region_ids: ['section-summary'],
                  },
                  operations: [
                    { op: 'remove_node', node_id: 'summary' },
                    {
                      op: 'insert_node',
                      parent_id: 'section-summary',
                      after_node_id: 'section-summary-title',
                      node: {
                        id: combinedId,
                        type: 'element',
                        tag: 'p',
                        text: originalText,
                        editable: true,
                      },
                    },
                  ],
                },
              },
            }],
            uncertainty: [],
          },
        };
      }

      const proposalDocument = input.workspace.resume.proposal_content;
      assert.ok(proposalDocument, '继续调整必须携带上一建议形成的完整文档 B');
      assert.deepStrictEqual(
        input.workspace.resume.previous_target_document,
        proposalDocument,
      );
      assert.ok(
        ResumeDom.findNode(input.workspace.resume.task_base_content, 'summary'),
        '继续调整必须保留首次建议依据的基准简历 A',
      );
      assert.ok(ResumeDom.findNode(proposalDocument, combinedId));
      assert.strictEqual(ResumeDom.findNode(proposalDocument, 'summary'), null);
      assert.ok(
        ResumeDom.findNode(input.workspace.resume.content, 'summary'),
        '当前最新草稿 C 必须与上一版目标 B 分开传递',
      );
      return {
        output: {
          reply: '已基于上一版建议拆成两个独立列表项，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                suggestion: '拆成两个独立列表项',
                change_constraints: {
                  content: 'preserve',
                  structure: 'modify',
                  style: 'preserve',
                  allowed_region_ids: ['section-summary'],
                },
                operations: [
                  { op: 'remove_node', node_id: combinedId },
                  {
                    op: 'insert_node',
                    parent_id: 'section-summary',
                    after_node_id: 'section-summary-title',
                    node: {
                      id: itemOneId,
                      type: 'element',
                      tag: 'p',
                      text: itemOneText,
                      editable: true,
                    },
                  },
                  {
                    op: 'insert_node',
                    parent_id: 'section-summary',
                    after_node_id: itemOneId,
                    node: {
                      id: itemTwoId,
                      type: 'element',
                      tag: 'p',
                      text: itemTwoText,
                      editable: true,
                    },
                  },
                ],
              },
            },
          }],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const before = await workspace();
    const first = await send(
      '把这个模块下面的内容合并成一个段落',
      { type: 'RESUME_BLOCK', id: 'section-summary-title' },
    );
    const proposalB = first.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(proposalB, JSON.stringify(first.body));
    assert.strictEqual(
      proposalB.payload.proposal.change_preview.before.text,
      ResumeDom.nodeText(ResumeDom.findNode(before.draft.resume_json, 'summary').node),
    );
    assert.strictEqual(
      proposalB.payload.proposal.change_preview.after.text,
      originalText,
    );
    assert.strictEqual(
      proposalB.payload.proposal.summary,
      '调整1项内容的组织方式，文字保持不变',
    );
    assert.doesNotMatch(
      proposalB.payload.proposal.change_preview.after.text,
      /新增模块或内容|删除内容/,
    );
    assert.ok(ResumeDom.findNode((await workspace()).draft.resume_json, 'summary'));

    const second = await send(
      '请继续调整：拆成两个列表',
      { type: 'RESUME_BLOCK', id: 'section-summary-title' },
      {
        task_id: first.body.task_id,
        parent_proposal_id: proposalB.id,
      },
    );
    const proposalC = second.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(proposalC, JSON.stringify(second.body));
    assert.strictEqual(calls, 2);
    assert.strictEqual(proposalC.payload.proposal.operations.length, 5);
    assert.strictEqual(
      proposalC.payload.proposal.editing_base,
      originalText,
    );
    assert.strictEqual(
      proposalC.payload.proposal.change_preview.after.text,
      `${itemOneText}\n${itemTwoText}`,
    );
    assert.strictEqual(
      db.get('SELECT status FROM ai_action_requests WHERE id = ?', [proposalB.id]).status,
      'superseded',
    );

    const applied = await helpers.call(ctx, 'POST', `/ai/actions/${proposalC.id}/apply`, {
      idemKey: `apply-continued-structure-${proposalC.id}`,
      body: { expected_revision: before.draft.revision },
    });
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.strictEqual(ResumeDom.findNode(applied.body.resume_json, 'summary'), null);
    assert.strictEqual(ResumeDom.findNode(applied.body.resume_json, combinedId), null);
    assert.ok(ResumeDom.findNode(applied.body.resume_json, itemOneId));
    assert.ok(ResumeDom.findNode(applied.body.resume_json, itemTwoId));

    const event = db.get('SELECT before_json, after_json FROM resume_change_events WHERE id = ?', [
      applied.body.change_event_id,
    ]);
    assert.strictEqual(JSON.parse(event.before_json).format, 'resume-structure-delta-v1');
    assert.strictEqual(JSON.parse(event.after_json).format, 'resume-structure-delta-v1');
  } finally {
    restore();
  }
});

test('继续调整进入沟通阶段后，上一版建议不可被并发应用', async () => {
  let calls = 0;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'proposal-refinement-lock',
    generate: async ({ input }) => {
      calls += 1;
      if (calls === 2) {
        return {
          output: {
            type: 'message',
            content: '你希望第二段只突出团队管理，还是同时保留项目推进？',
            awaiting_user: true,
            quick_replies: ['只突出团队管理', '两者都保留'],
          },
        };
      }
      const current = ResumeDom.toResumeDocument(input.workspace.resume.content);
      const before = ResumeDom.nodeText(ResumeDom.findNode(current, 'target-bullet').node);
      const target = ResumeDom.applyDocumentOperations(current, [{
        op: 'replace_text',
        node_id: 'target-bullet',
        text: `${before}，突出团队管理。`,
      }], { allowStructure: true });
      return {
        output: {
          type: 'proposal',
          content: '已准备强化团队管理表达。',
          proposal: {
            target_resume_document: target,
            change_constraints: {
              content: 'modify',
              content_order: 'preserve',
              structure: 'preserve',
              style: 'preserve',
              allowed_region_ids: ['target-bullet'],
            },
          },
        },
      };
    },
  });
  try {
    const first = await send(
      '突出团队管理',
      { type: 'RESUME_BLOCK', id: 'target-bullet' },
    );
    const proposal = first.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(proposal);

    const refinement = await send(
      '继续调整一下重点',
      { type: 'RESUME_BLOCK', id: 'target-bullet' },
      {
        conversation_id: first.body.conversation_id,
        task_id: first.body.task_id,
        parent_proposal_id: proposal.id,
      },
    );
    assert.strictEqual(refinement.body.result_type, 'MESSAGE');
    assert.strictEqual(refinement.body.awaiting_user, true);

    const blocked = await helpers.call(ctx, 'POST', `/ai/actions/${proposal.id}/apply`, {
      idemKey: `apply-refining-${proposal.id}`,
    });
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body.title, 'PROPOSAL_BEING_REFINED');
  } finally {
    restore();
  }
});

test('一个 AI 编辑节点可保留多段格式，并能无损拆成独立编辑节点', async () => {
  const groupId = `ai-scope-group-${Date.now()}`;
  const firstId = `${groupId}-1`;
  const secondId = `${groupId}-2`;
  let discussionInput = null;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'ai-scope-group',
    generate: async ({ input }) => {
      if (input.request.text.includes('新增一个能力分组')) {
        const root = input.workspace.resume.content.root;
        const lastNode = root.children[root.children.length - 1];
        return {
          output: {
            reply: '已准备新增一个包含两个独立要点的能力分组，可整体与AI沟通。',
            actions: [{
              type: 'RESUME_REWRITE_PROPOSAL',
              payload: {
                proposal: {
                  operations: [{
                    op: 'insert_node',
                    parent_id: root.id,
                    after_node_id: lastNode.id,
                    node: {
                      id: groupId,
                      type: 'element',
                      tag: 'div',
                      editable: true,
                      label: '协作能力',
                      children: [
                        {
                          id: firstId,
                          type: 'element',
                          tag: 'p',
                          text: '跨部门协作。',
                        },
                        {
                          id: secondId,
                          type: 'element',
                          tag: 'p',
                          text: '项目推进。',
                        },
                      ],
                    },
                  }],
                  change_constraints: {
                    content: 'modify',
                    structure: 'modify',
                    style: 'preserve',
                    allowed_region_ids: [root.id],
                  },
                },
              },
            }],
            uncertainty: [],
          },
        };
      }
      if (input.request.text.includes('分别使用AI')) {
        return {
          output: {
            result_type: 'PROPOSAL',
            reply: '已准备保留当前排版，并让两个要点分别使用 AI。确认后即可应用。',
            actions: [{
              type: 'RESUME_REWRITE_PROPOSAL',
              payload: {
                proposal: {
                  operations: [{
                    op: 'split_editable_node',
                    node_id: input.scope.id,
                  }],
                  change_constraints: {
                    content: 'preserve',
                    structure: 'modify',
                    style: 'preserve',
                    allowed_region_ids: [input.scope.id],
                  },
                },
              },
            }],
            uncertainty: [],
          },
        };
      }
      discussionInput = input;
      return {
        output: {
          reply: `这个区域包含${input.focus.scope_region.root_node_ids.length}个分组根节点。`,
          actions: [],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const proposed = await send('新增一个能力分组，包含“跨部门协作”和“项目推进”两个要点');
    const action = proposed.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(action, JSON.stringify(proposed.body));
    const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
      idemKey: `apply-ai-scope-group-${action.id}`,
      body: { expected_revision: action.expected_revision },
    });
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    const group = ResumeDom.findNode(applied.body.resume_json, groupId);
    assert.ok(group);
    assert.strictEqual(group.node.editable, true);
    assert.strictEqual(group.node.children.every((node) => !node.editable), true);

    const discussed = await send(
      '这个区域包含几个要点？',
      { type: 'RESUME_BLOCK', id: firstId },
    );
    assert.strictEqual(discussed.status, 200, JSON.stringify(discussed.body));
    assert.deepStrictEqual(discussed.body.actions, []);
    assert.match(discussed.body.reply_text, /这个区域包含/);
    assert.strictEqual(discussionInput.scope.id, groupId);
    assert.strictEqual(discussionInput.focus.scope_region.scope_id, groupId);
    assert.strictEqual(discussionInput.focus.scope_region.requested_scope_id, groupId);
    const storedMessage = db.get(
      "SELECT scope_id FROM ai_messages WHERE role = 'user' AND content = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      ['这个区域包含几个要点？'],
    );
    assert.strictEqual(storedMessage.scope_id, groupId);

    const independentProposal = await send(
      '保留当前排版，让两个要点分别使用AI',
      { type: 'RESUME_BLOCK', id: secondId },
    );
    assert.strictEqual(independentProposal.status, 200, JSON.stringify(independentProposal.body));
    const scopeAction = independentProposal.body.actions.find(
      (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
    );
    assert.ok(scopeAction, JSON.stringify(independentProposal.body));
    assert.strictEqual(
      scopeAction.payload.proposal.change_preview.summary,
      '将1个 AI 编辑节点拆分为2个，文字保持不变',
    );
    const scopeApplied = await helpers.call(ctx, 'POST', `/ai/actions/${scopeAction.id}/apply`, {
      idemKey: `apply-independent-ai-scope-${scopeAction.id}`,
      body: { expected_revision: scopeAction.expected_revision },
    });
    assert.strictEqual(scopeApplied.status, 200, JSON.stringify(scopeApplied.body));
    assert.strictEqual(
      ResumeDom.resolveAiScopeNode(scopeApplied.body.resume_json, firstId).node.id,
      firstId,
    );
    assert.strictEqual(
      ResumeDom.resolveAiScopeNode(scopeApplied.body.resume_json, secondId).node.id,
      secondId,
    );
    assert.ok(ResumeDom.findNode(scopeApplied.body.resume_json, groupId));
  } finally {
    restore();
  }
});
