'use strict';

const test = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers');
const ResumeDom = require('../resume-dom');
const resumeHarness = require('../server/lib/resume-harness');

test('全局 AI 用最小目标子树删除模块，应用时保留其他位置的并行手工修改', async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  const before = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const summarySection = ResumeDom.findNode(before.draft.resume_json, 'section-summary');
  const parallelTarget = ResumeDom.findNode(before.draft.resume_json, 'target-bullet');
  assert.ok(summarySection);
  assert.ok(parallelTarget);

  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'target-fragments-integration',
    generate: async () => ({
      output: {
        type: 'proposal',
        content: '已准备删除职业概况模块，其他内容保持不变。',
        proposal: {
          target_resume_fragments: {
            format: 'resume-target-fragments-v1',
            changes: [{
              target_id: 'section-summary',
              replacement_subtree: null,
            }],
          },
          change_constraints: {
            content: 'modify',
            content_order: 'preserve',
            structure: 'modify',
            style: 'preserve',
            allowed_region_ids: ['section-summary'],
          },
        },
      },
      provider: 'test',
      model: 'target-fragments-integration',
      finish_reason: 'stop',
    }),
  });
  t.after(restore);

  const proposed = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/ai/messages`,
    {
      body: {
        content: '把职业概况整个模块删掉',
        scope_type: 'RESUME_DOCUMENT',
        scope_id: null,
      },
    },
  );
  assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));
  const action = proposed.body.actions.find(
    (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
  );
  assert.ok(action, JSON.stringify(proposed.body));
  assert.strictEqual(
    action.payload.proposal.target_resume_fragments.format,
    'resume-target-fragments-v1',
  );
  assert.strictEqual(
    ResumeDom.findNode(action.payload.proposal.target_resume_document, 'section-summary'),
    null,
  );

  const manualText = `${ResumeDom.nodeText(parallelTarget.node)} 用户等待期间补充`;
  const manual = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/transactions`,
    {
      body: {
        expected_revision: before.draft.revision,
        mutation_id: `fragment-parallel-${Date.now()}`,
        operations: [{
          op: 'replace_text',
          node_id: 'target-bullet',
          text: manualText,
        }],
        scope_id: 'target-bullet',
        label: '补充工作成果',
      },
    },
  );
  assert.strictEqual(manual.status, 200, JSON.stringify(manual.body));

  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: `apply-fragment-${action.id}`,
    body: { expected_revision: action.expected_revision },
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  const after = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  assert.strictEqual(ResumeDom.findNode(after.draft.resume_json, 'section-summary'), null);
  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(after.draft.resume_json, 'target-bullet').node),
    manualText,
  );
});

test('全局 AI 用紧凑新增声明插入平级模块，并保留等待期间的其他手工修改', async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  const before = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const parallelTarget = ResumeDom.findNode(before.draft.resume_json, 'target-bullet');
  assert.ok(parallelTarget);

  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'compact-insertion-integration',
    generate: async () => ({
      output: {
        type: 'proposal',
        content: '已准备在工作经历后新增职业发展规划模块，其他内容保持不变。',
        proposal: {
          target_resume_fragments: {
            format: 'resume-target-fragments-v2',
            changes: [],
            insertions: [{
              parent_id: 'resume-root',
              after_id: 'section-experience',
              new_subtrees: [{
                id: 'career-plan-section',
                type: 'element',
                tag: 'section',
                label: '职业发展规划',
                children: [
                  {
                    id: 'career-plan-title',
                    type: 'element',
                    tag: 'h2',
                    text: '职业发展规划',
                    editable: true,
                  },
                  {
                    id: 'career-plan-body',
                    type: 'element',
                    tag: 'p',
                    text: '持续深耕产品规划与跨部门协同。',
                    editable: true,
                  },
                ],
              }],
            }],
          },
          change_constraints: {
            content: 'modify',
            content_order: 'preserve',
            structure: 'modify',
            style: 'preserve',
            allowed_region_ids: ['resume-root'],
          },
        },
      },
      provider: 'test',
      model: 'compact-insertion-integration',
      finish_reason: 'stop',
    }),
  });
  t.after(restore);

  const proposed = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/ai/messages`,
    {
      body: {
        content: '在工作经历后新增职业发展规划模块，内容为：持续深耕产品规划与跨部门协同。',
        scope_type: 'RESUME_DOCUMENT',
        scope_id: null,
      },
    },
  );
  assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));
  const action = proposed.body.actions.find(
    (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
  );
  assert.ok(action, JSON.stringify(proposed.body));
  assert.strictEqual(
    action.payload.proposal.target_resume_fragments.format,
    'resume-target-fragments-v2',
  );
  assert.strictEqual(
    action.payload.proposal.target_resume_fragments.insertions.length,
    1,
  );

  const manualText = `${ResumeDom.nodeText(parallelTarget.node)} 用户等待期间补充`;
  const manual = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/transactions`,
    {
      body: {
        expected_revision: before.draft.revision,
        mutation_id: `compact-insertion-parallel-${Date.now()}`,
        operations: [{
          op: 'replace_text',
          node_id: 'target-bullet',
          text: manualText,
        }],
        scope_id: 'target-bullet',
        label: '补充工作成果',
      },
    },
  );
  assert.strictEqual(manual.status, 200, JSON.stringify(manual.body));

  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: `apply-compact-insertion-${action.id}`,
    body: { expected_revision: action.expected_revision },
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  const after = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  assert.ok(ResumeDom.findNode(after.draft.resume_json, 'career-plan-section'));
  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(after.draft.resume_json, 'target-bullet').node),
    manualText,
  );
});
