'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');

test('全局长对话通过真实API保存记忆并复用，用户原话不裁剪、不更改草稿', async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  const before = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  let compactions = 0;
  const messages = [];
  const restore = harness.setModelClientForTests({
    provider: 'test',
    generate: async (request) => {
      if (request.routingReason === 'conversation_memory_compaction') {
        compactions += 1;
        return { output: {
          requirements: ['保留174名学生，学校名称不变'],
          confirmed_decisions: [],
          rejected_directions: ['不删除职业概况'],
          user_facts: ['174名学生'],
          unresolved_questions: [],
          superseded_requirements: [],
          discussion_summary: '用户继续讨论精简和样式，尚未应用修改。',
        } };
      }
      messages.push(request.messages);
      return { output: {
        type: 'message', content: '收到，请继续补充要求。',
        awaiting_user: true,
      } };
    },
  });
  t.after(restore);
  let taskId;
  for (let turn = 0; turn < 24; turn += 1) {
    const content = turn === 0
      ? '  保留174名学生，学校名称不变。\n' + '这段详细说明完整保留。'.repeat(110)
      : `第${turn}轮：不删除职业概况，继续讨论。 `;
    const result = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
      body: {
        content, scope_type: 'RESUME_DOCUMENT',
        ...(taskId ? { task_id: taskId } : {}),
      },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    taskId = helpers.db.get(
      'SELECT id FROM ai_tasks WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [projectId],
    ).id;
    assert.equal(messages.at(-1).at(-1).content, content);
  }
  assert.equal(compactions, 1, '摘要后不应每一轮都重新压缩');
  assert.match(messages.at(-1)[1].content, /conversation_summary.*174名学生/);
  const task = helpers.db.get('SELECT * FROM ai_tasks WHERE id = ?', [taskId]);
  assert.ok(JSON.parse(task.state_json).conversation_memory.covered_messages > 0);
  assert.ok(task.goal.length > 1000, '原始目标不可按180字裁剪');
  const stored = helpers.db.all(
    'SELECT content FROM ai_messages WHERE task_id = ? AND role = ? ORDER BY created_at, id',
    [taskId, 'user'],
  );
  assert.equal(stored.length, 24);
  assert.ok(stored[0].content.length > 1000);
  const after = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  assert.deepEqual(after.draft.resume_json, before.draft.resume_json);
});

test('局部超过1000字的原始指令完整透传，普通任务只有一次模型调用', async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  const before = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const instruction = '  请参考以下要求修改这句话：\n' + '保留数字和学校名称。'.repeat(110) + '  ';
  let calls = 0;
  const restore = harness.setModelClientForTests({
    provider: 'test',
    generate: async (request) => {
      calls += 1;
      assert.equal(JSON.parse(request.messages.at(-1).content).instruction, instruction);
      assert.equal(request.capability, 'text');
      assert.doesNotMatch(request.messages[1].content, /"children"|"style"/);
      return { output: {
        type: 'proposal', content: '建议已准备好',
        suggestion: '负责产品规划与协作，推动项目按期交付。', summary: '优化文字',
      } };
    },
  });
  t.after(restore);
  const response = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/inline-rewrites`, {
    body: {
      target_node_id: 'summary', target_mode: 'node',
      instruction, expected_revision: before.draft.revision,
    },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(calls, 1);
});
