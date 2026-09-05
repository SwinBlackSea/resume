'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const helpers = require('./helpers');
const ResumeDom = require('../resume-dom');
const resumeHarness = require('../server/lib/resume-harness');

let ctx;
let sequence = 0;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function documentFixture(suffix = 'base') {
  return ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: `resume-root-${suffix}`,
      type: 'element',
      tag: 'article',
      attributes: { class: 'resume' },
      children: [
        {
          id: `summary-section-${suffix}`,
          type: 'element',
          tag: 'section',
          label: '职业概况',
          children: [
            {
              id: `summary-${suffix}`,
              type: 'element',
              tag: 'p',
              text: '负责产品规划与项目推进，服务120家客户。',
              editable: true,
              label: '职业概况内容',
            },
          ],
        },
        {
          id: `experience-section-${suffix}`,
          type: 'element',
          tag: 'section',
          label: '工作经历',
          children: [
            {
              id: `experience-${suffix}`,
              type: 'element',
              tag: 'p',
              text: '负责跨部门协作，按期完成重点项目。',
              editable: true,
              label: '工作经历内容',
            },
          ],
        },
      ],
    },
  });
}

function nodeText(document, nodeId) {
  const found = ResumeDom.findNode(document, nodeId);
  return found ? ResumeDom.nodeText(found.node) : null;
}

async function createProject(label, transformDocument) {
  sequence += 1;
  const suffix = `${label}-${sequence}`;
  const created = await helpers.call(ctx, 'POST', '/projects', {
    body: { name: `局部 AI QA ${suffix}` },
  });
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  const projectId = created.body.id;
  let document = documentFixture(suffix);
  if (transformDocument) {
    document = ResumeDom.toResumeDocument(transformDocument(document, {
      suffix,
      summaryId: `summary-${suffix}`,
      experienceId: `experience-${suffix}`,
      rootId: `resume-root-${suffix}`,
    }));
  }
  const initialized = await helpers.call(ctx, 'PATCH', `/projects/${projectId}/resume-draft`, {
    body: {
      expected_revision: 1,
      resume_json: document,
    },
  });
  assert.strictEqual(initialized.status, 200, JSON.stringify(initialized.body));
  const workspace = await helpers.call(ctx, 'GET', `/projects/${projectId}`);
  assert.strictEqual(workspace.status, 200, JSON.stringify(workspace.body));
  return {
    projectId,
    suffix,
    summaryId: `summary-${suffix}`,
    experienceId: `experience-${suffix}`,
    rootId: `resume-root-${suffix}`,
    workspace: workspace.body,
  };
}

function inlineProposalClient(transform, observe) {
  return {
    provider: 'test',
    model: 'local-ai-qa-inline',
    generate: async ({ input }) => {
      assert.ok(input.target, '局部 AI 请求必须锁定一个文字目标');
      if (observe) observe(input);
      const suggestion = await transform(input);
      if (suggestion && suggestion.type === 'message') {
        return {
          output: {
            type: 'message',
            content: suggestion.content,
            handoff: true,
          },
        };
      }
      return {
        output: {
          type: 'proposal',
          content: '已准备好这处文字的修改，确认后生效。',
          suggestion,
          summary: '优化当前文字表达',
        },
      };
    },
  };
}

function combinedClient({ inline, global }) {
  return {
    provider: 'test',
    model: 'local-ai-qa-combined',
    generate: async ({ input }) => {
      if (input.target) {
        return {
          output: {
            type: 'proposal',
            content: '局部修改已经准备好，确认后生效。',
            suggestion: inline(input),
            summary: '局部调整当前文字',
          },
        };
      }
      const current = ResumeDom.toResumeDocument(input.workspace.resume.content);
      const transformed = global(current, input);
      const target = transformed && transformed.document
        ? transformed.document
        : transformed;
      const structure = transformed && transformed.structure
        ? transformed.structure
        : 'preserve';
      return {
        output: {
          type: 'proposal',
          content: '整体建议已经准备好，确认后生效。',
          proposal: {
            suggestion: '按要求调整简历',
            change_constraints: {
              content: 'modify',
              structure,
              style: 'preserve',
              allowed_region_ids: [input.scope.id || current.root.id],
            },
            target_resume_document: target,
          },
        },
      };
    },
  };
}

async function proposeInline(project, {
  instruction = '写得更清晰，保留原意和全部数字',
  targetId = project.summaryId,
  targetMode = 'node',
  selection,
  expectedRevision,
} = {}) {
  const workspace = await helpers.call(ctx, 'GET', `/projects/${project.projectId}`);
  const response = await helpers.call(
    ctx,
    'POST',
    `/projects/${project.projectId}/ai/inline-rewrites`,
    {
      body: {
        instruction,
        target_node_id: targetId,
        target_mode: targetMode,
        ...(selection ? { selection } : {}),
        expected_revision: expectedRevision ?? workspace.body.draft.revision,
        conversation_id: workspace.body.conversation && workspace.body.conversation.id,
      },
    },
  );
  return response;
}

async function applyInline(action) {
  return helpers.call(ctx, 'POST', `/ai/inline-rewrites/${action.id}/apply`, {
    idemKey: `local-ai-qa-apply-${action.id}`,
  });
}

async function directEdit(project, nodeId, text, label = '手工修改其他内容') {
  const workspace = await helpers.call(ctx, 'GET', `/projects/${project.projectId}`);
  return helpers.call(ctx, 'POST', `/projects/${project.projectId}/resume-draft/transactions`, {
    body: {
      expected_revision: workspace.body.draft.revision,
      mutation_id: `local-ai-qa-direct-${sequence}-${Date.now()}-${Math.random()}`,
      scope_id: nodeId,
      label,
      input_type: 'typing',
      operations: [{
        op: 'replace_text',
        node_id: nodeId,
        text,
        replace_children: true,
      }],
    },
  });
}

async function proposeGlobal(project, instruction, scopeId = project.summaryId) {
  return helpers.call(ctx, 'POST', `/projects/${project.projectId}/ai/messages`, {
    body: {
      content: instruction,
      scope_type: scopeId ? 'RESUME_BLOCK' : 'RESUME_DOCUMENT',
      scope_id: scopeId || null,
    },
  });
}

function globalAction(response) {
  return response.body.actions.find(
    (action) => action.action_type === 'RESUME_REWRITE_PROPOSAL',
  );
}

async function applyGlobal(action) {
  return helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: `local-ai-qa-global-${action.id}`,
    body: { expected_revision: action.expected_revision },
  });
}

test.before(async () => {
  ctx = await helpers.boot();
});

test.after(() => helpers.close(ctx));

test('节点局部改写读取整份简历，但只修改用户确认的当前节点且不写入右侧聊天', async () => {
  const project = await createProject('node');
  let observedInput;
  const restore = resumeHarness.setModelClientForTests(
    inlineProposalClient(
      (input) => `${input.target.source_text}表达更清晰。`,
      (input) => { observedInput = input; },
    ),
  );
  try {
    const beforeMessages = project.workspace.conversation.messages.length;
    const proposed = await proposeInline(project);
    assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));
    assert.strictEqual(proposed.body.type, 'proposal');
    assert.strictEqual(proposed.body.action.payload.target_node_id, project.summaryId);
    assert.match(
      ResumeDom.plainText(observedInput.workspace.resume.content),
      /负责跨部门协作/,
      '模型应获得整份简历语境，而非只有当前一句',
    );

    const applied = await applyInline(proposed.body.action);
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.match(nodeText(applied.body.resume_json, project.summaryId), /表达更清晰/);
    assert.strictEqual(
      nodeText(applied.body.resume_json, project.experienceId),
      '负责跨部门协作，按期完成重点项目。',
    );

    const after = await helpers.call(ctx, 'GET', `/projects/${project.projectId}`);
    assert.strictEqual(after.body.conversation.messages.length, beforeMessages);
    assert.strictEqual(after.body.draft.undo_stack[0].change_type, 'inline_ai_text');
  } finally {
    restore();
  }
});

test('选中文字改写只替换所选范围，并保留同一节点中的前后文字', async () => {
  const project = await createProject('selection');
  const original = nodeText(project.workspace.draft.resume_json, project.summaryId);
  const selected = '产品规划';
  const start = original.indexOf(selected);
  const restore = resumeHarness.setModelClientForTests(
    inlineProposalClient(() => '平台产品规划'),
  );
  try {
    const proposed = await proposeInline(project, {
      instruction: '把“产品规划”改成“平台产品规划”',
      targetMode: 'selection',
      selection: {
        segment_id: project.summaryId,
        start,
        end: start + selected.length,
        text: selected,
      },
    });
    assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));
    const applied = await applyInline(proposed.body.action);
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.strictEqual(
      nodeText(applied.body.resume_json, project.summaryId),
      original.replace(selected, '平台产品规划'),
    );
  } finally {
    restore();
  }
});

test('选中文字生成后同一段前缀或所选词发生变化，确认 AI 时仍只替换原语义位置', async () => {
  const project = await createProject('selection-rebase');
  const original = nodeText(project.workspace.draft.resume_json, project.summaryId);
  const selected = '产品规划';
  const start = original.indexOf(selected);
  const restore = resumeHarness.setModelClientForTests(
    inlineProposalClient(() => '平台产品规划'),
  );
  try {
    const proposed = await proposeInline(project, {
      instruction: '把“产品规划”改成“平台产品规划”',
      targetMode: 'selection',
      selection: {
        segment_id: project.summaryId,
        start,
        end: start + selected.length,
        text: selected,
      },
    });
    assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));
    const manualText = original
      .replace('负责', '目前负责')
      .replace('产品规划', '产品策略');
    const changed = await directEdit(project, project.summaryId, manualText);
    assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));

    const applied = await applyInline(proposed.body.action);
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.strictEqual(
      nodeText(applied.body.resume_json, project.summaryId),
      manualText.replace('产品策略', '平台产品规划'),
    );
    assert.strictEqual(applied.body.rebased, true);
  } finally {
    restore();
  }
});

test('空内容和包含多个段落的单一编辑节点，都能保持原编辑边界完成局部改写', async () => {
  const emptyProject = await createProject('empty', (document, ids) => {
    const found = ResumeDom.findNode(document, ids.summaryId);
    found.node.text = '';
    return { ...document, root: found.document.root };
  });
  const compoundProject = await createProject('compound', (document, ids) => {
    const found = ResumeDom.findNode(document, ids.summaryId);
    found.parent.children[found.index] = {
      id: ids.summaryId,
      type: 'element',
      tag: 'div',
      editable: true,
      label: '两段职业概况',
      children: [
        {
          id: `${ids.summaryId}-line-1`,
          type: 'element',
          tag: 'p',
          text: '第一段保留120家客户。',
        },
        {
          id: `${ids.summaryId}-line-2`,
          type: 'element',
          tag: 'p',
          text: '第二段强调项目推进。',
        },
      ],
    };
    return { ...document, root: found.document.root };
  });
  const restore = resumeHarness.setModelClientForTests(
    inlineProposalClient((input) => (
      input.target.node_id.includes('empty')
        ? '补充职业概况'
        : '第一段表达更清晰，保留120家客户。\n第二段更突出项目推进。'
    )),
  );
  try {
    const emptyProposal = await proposeInline(emptyProject, {
      instruction: '在空白处补充职业概况',
    });
    assert.strictEqual(emptyProposal.status, 200, JSON.stringify(emptyProposal.body));
    const emptyApplied = await applyInline(emptyProposal.body.action);
    assert.strictEqual(emptyApplied.status, 200, JSON.stringify(emptyApplied.body));
    assert.strictEqual(
      nodeText(emptyApplied.body.resume_json, emptyProject.summaryId),
      '补充职业概况',
    );

    const compoundProposal = await proposeInline(compoundProject, {
      instruction: '两段都表达得更清晰，保留120家客户和项目推进',
    });
    assert.strictEqual(compoundProposal.status, 200, JSON.stringify(compoundProposal.body));
    const compoundApplied = await applyInline(compoundProposal.body.action);
    assert.strictEqual(compoundApplied.status, 200, JSON.stringify(compoundApplied.body));
    const compound = ResumeDom.findNode(
      compoundApplied.body.resume_json,
      compoundProject.summaryId,
    ).node;
    assert.strictEqual(compound.editable, true);
    assert.strictEqual(compound.children.length, 2);
    assert.strictEqual(compound.children.every((child) => child.editable !== true), true);
    assert.strictEqual(
      ResumeDom.nodeText(compound),
      '第一段表达更清晰，保留120家客户。\n第二段更突出项目推进。',
    );
  } finally {
    restore();
  }
});

test('局部 AI 生成期间手工修改其他位置，应用后两处修改都保留', async () => {
  const project = await createProject('inflight');
  let releaseModel;
  let modelStarted;
  const started = new Promise((resolve) => { modelStarted = resolve; });
  const pending = new Promise((resolve) => { releaseModel = resolve; });
  const restore = resumeHarness.setModelClientForTests(
    inlineProposalClient(async (input) => {
      modelStarted();
      await pending;
      return `${input.target.source_text}重点更明确。`;
    }),
  );
  try {
    const request = proposeInline(project);
    await modelStarted;
    const direct = await directEdit(
      project,
      project.experienceId,
      '用户在等待期间手工修改了工作经历。',
    );
    assert.strictEqual(direct.status, 200, JSON.stringify(direct.body));
    releaseModel();

    const proposed = await request;
    assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));
    const applied = await applyInline(proposed.body.action);
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.match(nodeText(applied.body.resume_json, project.summaryId), /重点更明确/);
    assert.strictEqual(
      nodeText(applied.body.resume_json, project.experienceId),
      '用户在等待期间手工修改了工作经历。',
    );
  } finally {
    releaseModel();
    restore();
  }
});

test('生成后同一节点又被手工修改，最后点击局部 AI 应用时以 AI 建议为准', async () => {
  const project = await createProject('same-node');
  const aiText = 'AI 最终确认采用的职业概况，服务120家客户。';
  const restore = resumeHarness.setModelClientForTests(
    inlineProposalClient(() => aiText),
  );
  try {
    const proposed = await proposeInline(project, {
      instruction: '替换为 AI 最终确认采用的职业概况，保留120家客户',
    });
    assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));
    const direct = await directEdit(
      project,
      project.summaryId,
      '用户生成建议后临时手工修改的文字。',
    );
    assert.strictEqual(direct.status, 200, JSON.stringify(direct.body));

    const applied = await applyInline(proposed.body.action);
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.strictEqual(nodeText(applied.body.resume_json, project.summaryId), aiText);
    assert.strictEqual(applied.body.rebased, true);
  } finally {
    restore();
  }
});

test('全局和局部建议同时存在时，针对同一节点最后确认的建议获胜', async () => {
  const firstProject = await createProject('order-local-global');
  const secondProject = await createProject('order-global-local');
  const localText = '局部 AI 确认版，服务120家客户。';
  const globalText = '全局 AI 确认版，服务120家客户。';
  const restore = resumeHarness.setModelClientForTests(combinedClient({
    inline: () => localText,
    global: (current, input) => ResumeDom.applyDocumentOperations(current, [{
      op: 'replace_text',
      node_id: input.scope.id,
      text: globalText,
    }]),
  }));
  try {
    const localFirst = await proposeInline(firstProject, {
      instruction: '替换为局部 AI 确认版，保留120家客户',
    });
    const globalSecond = await proposeGlobal(
      firstProject,
      '替换为全局 AI 确认版，保留120家客户',
    );
    assert.ok(globalAction(globalSecond), JSON.stringify(globalSecond.body));
    assert.strictEqual((await applyInline(localFirst.body.action)).status, 200);
    const globalAppliedLast = await applyGlobal(globalAction(globalSecond));
    assert.strictEqual(globalAppliedLast.status, 200, JSON.stringify(globalAppliedLast.body));
    assert.strictEqual(
      nodeText(globalAppliedLast.body.resume_json, firstProject.summaryId),
      globalText,
    );

    const globalFirst = await proposeGlobal(
      secondProject,
      '替换为全局 AI 确认版，保留120家客户',
    );
    const localSecond = await proposeInline(secondProject, {
      instruction: '替换为局部 AI 确认版，保留120家客户',
    });
    assert.strictEqual((await applyGlobal(globalAction(globalFirst))).status, 200);
    const localAppliedLast = await applyInline(localSecond.body.action);
    assert.strictEqual(localAppliedLast.status, 200, JSON.stringify(localAppliedLast.body));
    assert.strictEqual(
      nodeText(localAppliedLast.body.resume_json, secondProject.summaryId),
      localText,
    );
  } finally {
    restore();
  }
});

test('局部建议生成后目标节点被全局 AI 删除，只报告客观不可执行且不破坏草稿', async () => {
  const project = await createProject('deleted-target');
  const restore = resumeHarness.setModelClientForTests(combinedClient({
    inline: () => '等待应用的局部版本，服务120家客户。',
    global: (current, input) => ({
      document: ResumeDom.applyDocumentOperations(current, [{
        op: 'remove_node',
        node_id: input.scope.id,
      }], { allowStructure: true }),
      structure: 'modify',
    }),
  }));
  try {
    const local = await proposeInline(project, {
      instruction: '替换为等待应用的局部版本，保留120家客户',
    });
    const deletion = await proposeGlobal(project, '删除这段内容');
    const deleted = await applyGlobal(globalAction(deletion));
    assert.strictEqual(deleted.status, 200, JSON.stringify(deleted.body));
    assert.strictEqual(ResumeDom.findNode(deleted.body.resume_json, project.summaryId), null);

    const unavailable = await applyInline(local.body.action);
    assert.strictEqual(unavailable.status, 409, JSON.stringify(unavailable.body));
    assert.strictEqual(unavailable.body.title, 'INLINE_TARGET_CHANGED');
    assert.match(unavailable.body.detail, /结构已经变化|不存在/);
    const after = await helpers.call(ctx, 'GET', `/projects/${project.projectId}`);
    assert.strictEqual(ResumeDom.findNode(after.body.draft.resume_json, project.summaryId), null);
  } finally {
    restore();
  }
});

test('继续调整只保留同一位置的最新局部建议，旧建议不能再误应用', async () => {
  const project = await createProject('adjust');
  let calls = 0;
  const restore = resumeHarness.setModelClientForTests(
    inlineProposalClient(() => {
      calls += 1;
      return calls === 1
        ? '第一版局部建议，服务120家客户。'
        : '第二版局部建议，服务120家客户。';
    }),
  );
  try {
    const first = await proposeInline(project, {
      instruction: '先生成第一版，保留120家客户',
    });
    const second = await proposeInline(project, {
      instruction: '继续调整为第二版，保留120家客户',
    });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));

    const oldResult = await applyInline(first.body.action);
    assert.strictEqual(oldResult.status, 409, JSON.stringify(oldResult.body));
    assert.strictEqual(oldResult.body.title, 'INLINE_PROPOSAL_UNAVAILABLE');
    assert.match(oldResult.body.detail, /更新的局部建议/);

    const latest = await applyInline(second.body.action);
    assert.strictEqual(latest.status, 200, JSON.stringify(latest.body));
    assert.strictEqual(
      nodeText(latest.body.resume_json, project.summaryId),
      '第二版局部建议，服务120家客户。',
    );
  } finally {
    restore();
  }
});

test('同一位置并发生成时，后发起的局部请求不应被较晚返回的旧请求反向覆盖', async () => {
  const project = await createProject('out-of-order');
  let releaseFirst;
  let firstStarted;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const restore = resumeHarness.setModelClientForTests(
    inlineProposalClient(async (input) => {
      if (input.request.instruction.includes('第一版')) {
        firstStarted();
        await firstPending;
        return `${input.target.source_text}第一版。`;
      }
      return `${input.target.source_text}第二版。`;
    }),
  );
  try {
    const firstRequest = proposeInline(project, {
      instruction: '生成第一版，保留原意和全部数字',
    });
    await started;
    const second = await proposeInline(project, {
      instruction: '生成第二版，保留原意和全部数字',
    });
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    releaseFirst();
    const first = await firstRequest;
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));

    const oldResult = await applyInline(first.body.action);
    assert.strictEqual(oldResult.status, 409, JSON.stringify(oldResult.body));
    assert.strictEqual(oldResult.body.title, 'INLINE_PROPOSAL_UNAVAILABLE');

    const newestResult = await applyInline(second.body.action);
    assert.strictEqual(newestResult.status, 200, JSON.stringify(newestResult.body));
    assert.match(nodeText(newestResult.body.resume_json, project.summaryId), /第二版/);
  } finally {
    releaseFirst();
    restore();
  }
});

test('局部请求超出文字修改边界时返回自然说明，且不会创建可误应用的建议', async () => {
  const project = await createProject('handoff');
  const restore = resumeHarness.setModelClientForTests(
    inlineProposalClient(() => ({
      type: 'message',
      content: '这需要新增简历模块，请到右侧 AI 对话中继续处理。',
    })),
  );
  try {
    const beforeMessages = project.workspace.conversation.messages.length;
    const response = await proposeInline(project, {
      instruction: '在这里新增一个技能证书模块',
    });
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.strictEqual(response.body.type, 'message');
    assert.strictEqual(response.body.handoff, true);
    assert.strictEqual(Object.hasOwn(response.body, 'action'), false);
    assert.match(response.body.content, /右侧 AI 对话/);

    const after = await helpers.call(ctx, 'GET', `/projects/${project.projectId}`);
    assert.strictEqual(after.body.conversation.messages.length, beforeMessages);
    assert.strictEqual(
      nodeText(after.body.draft.resume_json, project.summaryId),
      nodeText(project.workspace.draft.resume_json, project.summaryId),
    );
  } finally {
    restore();
  }
});

test('模型暂时失败后可原地重试，失败请求不会留下可确认动作或阻断下一次结果', async () => {
  const project = await createProject('retry');
  let calls = 0;
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'local-ai-qa-retry',
    generate: async ({ input }) => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('模拟模型超时');
        error.code = 'DEEPSEEK_TIMEOUT';
        throw error;
      }
      return {
        output: {
          type: 'proposal',
          content: '重试成功，建议已经准备好。',
          suggestion: `${input.target.source_text}重试后更清晰。`,
          summary: '重试后优化表达',
        },
      };
    },
  });
  try {
    const failed = await proposeInline(project);
    assert.strictEqual(failed.status, 422, JSON.stringify(failed.body));
    assert.strictEqual(failed.body.title, 'MODEL_UNAVAILABLE');
    assert.match(failed.body.detail, /超时|稍后再试/);

    const retried = await proposeInline(project);
    assert.strictEqual(retried.status, 200, JSON.stringify(retried.body));
    assert.strictEqual(retried.body.action.status, 'awaiting_confirmation');
    const applied = await applyInline(retried.body.action);
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.match(nodeText(applied.body.resume_json, project.summaryId), /重试后更清晰/);
  } finally {
    restore();
  }
});

test('取消局部建议不改变正文、不进入右侧聊天，并可安全重复取消', async () => {
  const project = await createProject('cancel');
  const restore = resumeHarness.setModelClientForTests(
    inlineProposalClient((input) => `${input.target.source_text}不会被应用。`),
  );
  try {
    const beforeText = nodeText(project.workspace.draft.resume_json, project.summaryId);
    const beforeMessages = project.workspace.conversation.messages.length;
    const proposed = await proposeInline(project);
    const firstReject = await helpers.call(
      ctx,
      'POST',
      `/ai/inline-rewrites/${proposed.body.action.id}/reject`,
      { idemKey: `local-ai-qa-reject-${proposed.body.action.id}` },
    );
    assert.strictEqual(firstReject.status, 200, JSON.stringify(firstReject.body));
    assert.strictEqual(firstReject.body.status, 'rejected');
    const replay = await helpers.call(
      ctx,
      'POST',
      `/ai/inline-rewrites/${proposed.body.action.id}/reject`,
      { idemKey: `local-ai-qa-reject-${proposed.body.action.id}` },
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));

    const after = await helpers.call(ctx, 'GET', `/projects/${project.projectId}`);
    assert.strictEqual(nodeText(after.body.draft.resume_json, project.summaryId), beforeText);
    assert.strictEqual(after.body.conversation.messages.length, beforeMessages);
  } finally {
    restore();
  }
});

test('生成中切换到另一处时只展示新位置结果，迟到结果会被自动回收', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  const pending = [];
  const rejected = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `${origin}/`,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.sessionStorage.setItem('resumeGuideSeen', '1');
      window.fetch = (url, options = {}) => {
        const parsed = new URL(url, origin);
        const method = String(options.method || 'GET').toUpperCase();
        if (parsed.pathname.endsWith('/ai/inline-rewrites') && method === 'POST') {
          const body = JSON.parse(options.body || '{}');
          return new Promise((resolve) => {
            pending.push({ body, resolve });
          });
        }
        const rejectedMatch = parsed.pathname.match(/\/ai\/inline-rewrites\/([^/]+)\/reject$/);
        if (rejectedMatch && method === 'POST') {
          rejected.push(rejectedMatch[1]);
          return Promise.resolve(new Response(JSON.stringify({
            id: rejectedMatch[1],
            status: 'rejected',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return fetch(parsed, options);
      };
      window.EventSource = class {
        addEventListener() {}
        close() {}
      };
      window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    },
  });
  try {
    await wait(1200);
    const document = dom.window.document;
    const targets = [...document.querySelectorAll('#resume-document [data-resume-editable=true]')];
    const firstTarget = document.querySelector('#target-bullet') || targets[0];
    const secondTarget = targets.find(
      (target) => target.dataset.nodeId !== firstTarget.dataset.nodeId,
    );
    assert.ok(firstTarget && secondTarget);

    firstTarget.click();
    document.querySelector('.rewrite-action').click();
    document.querySelector('#local-ai-input').value = '第一处写得更简洁';
    document.querySelector('#local-ai-generate').click();
    await wait(20);
    assert.strictEqual(pending.length, 1);

    secondTarget.click();
    document.querySelector('.rewrite-action').click();
    document.querySelector('#local-ai-input').value = '第二处写得更专业';
    document.querySelector('#local-ai-generate').click();
    await wait(20);
    assert.strictEqual(pending.length, 2);
    assert.notStrictEqual(
      pending[0].body.target_node_id,
      pending[1].body.target_node_id,
    );

    pending[1].resolve(new Response(JSON.stringify({
      type: 'proposal',
      result_type: 'PROPOSAL',
      content: '第二处建议已准备好。',
      action: {
        id: 'new-position-action',
        status: 'awaiting_confirmation',
        payload: {
          target_mode: 'node',
          target_node_id: pending[1].body.target_node_id,
          base_node_text: '第二处原文',
          suggestion: '第二处最新结果',
          summary: '优化第二处',
        },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await wait(30);
    assert.strictEqual(document.querySelector('#local-ai-after').textContent, '第二处最新结果');

    pending[0].resolve(new Response(JSON.stringify({
      type: 'proposal',
      result_type: 'PROPOSAL',
      content: '第一处迟到建议。',
      action: {
        id: 'old-position-action',
        status: 'awaiting_confirmation',
        payload: {
          target_mode: 'node',
          target_node_id: pending[0].body.target_node_id,
          base_node_text: '第一处原文',
          suggestion: '第一处迟到结果',
          summary: '优化第一处',
        },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await wait(40);
    assert.strictEqual(document.querySelector('#local-ai-after').textContent, '第二处最新结果');
    assert.deepStrictEqual(rejected, ['old-position-action']);
    await wait(280);
  } finally {
    dom.window.close();
  }
});

test('生成中关闭浮层后迟到建议不会重新弹出，并会被自动取消', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  let resolveRequest;
  const rejected = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `${origin}/`,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.sessionStorage.setItem('resumeGuideSeen', '1');
      window.fetch = (url, options = {}) => {
        const parsed = new URL(url, origin);
        const method = String(options.method || 'GET').toUpperCase();
        if (parsed.pathname.endsWith('/ai/inline-rewrites') && method === 'POST') {
          return new Promise((resolve) => { resolveRequest = resolve; });
        }
        const rejectedMatch = parsed.pathname.match(/\/ai\/inline-rewrites\/([^/]+)\/reject$/);
        if (rejectedMatch && method === 'POST') {
          rejected.push(rejectedMatch[1]);
          return Promise.resolve(new Response(JSON.stringify({
            id: rejectedMatch[1],
            status: 'rejected',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return fetch(parsed, options);
      };
      window.EventSource = class {
        addEventListener() {}
        close() {}
      };
      window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    },
  });
  try {
    await wait(1200);
    const document = dom.window.document;
    document.querySelector('#target-bullet').click();
    document.querySelector('.rewrite-action').click();
    document.querySelector('#local-ai-input').value = '写得更简洁';
    document.querySelector('#local-ai-generate').click();
    await wait(20);
    assert.strictEqual(typeof resolveRequest, 'function');
    document.querySelector('#local-ai-close').click();
    assert.strictEqual(document.querySelector('#local-ai-popover').classList.contains('show'), false);

    resolveRequest(new Response(JSON.stringify({
      type: 'proposal',
      result_type: 'PROPOSAL',
      content: '迟到建议已经准备好。',
      action: {
        id: 'closed-late-action',
        status: 'awaiting_confirmation',
        payload: {
          target_mode: 'node',
          target_node_id: 'target-bullet',
          base_node_text: '原文',
          suggestion: '迟到结果',
          summary: '优化表达',
        },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await wait(50);
    assert.strictEqual(document.querySelector('#local-ai-popover').classList.contains('show'), false);
    assert.deepStrictEqual(rejected, ['closed-late-action']);
    await wait(280);
  } finally {
    dom.window.close();
  }
});

test('就地改写界面对小白用户保持轻量：键盘可生成和关闭，转到对话时只预填不自动发送', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  let inlineCalls = 0;
  let rejectCalls = 0;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `${origin}/`,
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
      window.sessionStorage.setItem('resumeGuideSeen', '1');
      window.fetch = (url, options = {}) => {
        const parsed = new URL(url, origin);
        const method = String(options.method || 'GET').toUpperCase();
        if (parsed.pathname.endsWith('/ai/inline-rewrites') && method === 'POST') {
          inlineCalls += 1;
          return Promise.resolve(new Response(JSON.stringify({
            type: 'message',
            result_type: 'MESSAGE',
            content: '这项调整涉及其他位置，请在 AI 对话中处理。',
            handoff: true,
            target_node_id: 'target-bullet',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }));
        }
        if (/\/ai\/inline-rewrites\/[^/]+\/reject$/.test(parsed.pathname) && method === 'POST') {
          rejectCalls += 1;
          return Promise.resolve(new Response(JSON.stringify({
            status: 'rejected',
            resume_unchanged: true,
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return fetch(parsed, options);
      };
      window.EventSource = class {
        addEventListener() {}
        close() {}
      };
      window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    },
  });
  try {
    await wait(1200);
    const document = dom.window.document;
    const target = document.querySelector('#target-bullet');
    assert.ok(target, '演示简历应提供可发现的正文节点');
    target.click();
    assert.strictEqual(document.querySelector('#selection-tools').classList.contains('show'), true);
    assert.match(document.querySelector('.rewrite-action').textContent, /就地改写/);
    document.querySelector('.rewrite-action').click();

    const popover = document.querySelector('#local-ai-popover');
    const input = document.querySelector('#local-ai-input');
    assert.strictEqual(popover.classList.contains('show'), true);
    assert.strictEqual(popover.getAttribute('role'), 'dialog');
    assert.strictEqual(document.querySelector('#local-ai-status').getAttribute('role'), 'status');
    assert.strictEqual(
      document.querySelector('#local-ai-status').getAttribute('aria-live'),
      'polite',
    );
    assert.match(document.querySelector('#local-ai-scope').textContent, /只修改当前这处文字/);
    assert.strictEqual(document.querySelector('#assistant-panel').classList.contains('open'), false);

    input.value = '新增一个技能证书模块';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    assert.strictEqual(inlineCalls, 0, 'Shift+Enter 应保留换行，不应发送');
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    await wait(80);
    assert.strictEqual(inlineCalls, 1);
    assert.match(document.querySelector('#local-ai-status').textContent, /AI 对话中处理/);
    assert.notStrictEqual(document.querySelector('#local-ai-handoff').style.display, 'none');

    const chatCount = document.querySelectorAll('#chat-messages .bubble').length;
    document.querySelector('#local-ai-handoff').click();
    assert.strictEqual(popover.classList.contains('show'), false);
    assert.strictEqual(document.querySelector('#assistant-panel').classList.contains('open'), true);
    assert.strictEqual(document.querySelector('#prompt').value, '新增一个技能证书模块');
    assert.strictEqual(
      document.querySelectorAll('#chat-messages .bubble').length,
      chatCount,
      '转到对话只应预填要求，不应替用户自动发送',
    );

    target.click();
    document.querySelector('.rewrite-action').click();
    assert.strictEqual(popover.classList.contains('show'), true);
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }));
    assert.strictEqual(popover.classList.contains('show'), false);
    assert.strictEqual(
      document.activeElement,
      target,
      '键盘关闭浮层后应回到刚才编辑的正文位置',
    );
    assert.strictEqual(rejectCalls, 0, '尚未生成建议时关闭不需要拒绝接口');

    assert.match(
      html,
      /@media\(max-width:760px\)[\s\S]*?\.local-ai-popover\{left:10px!important;right:10px;width:auto\}/,
      '移动端浮层应限制在屏幕左右边界内',
    );
    await wait(320);
  } finally {
    dom.window.close();
  }
});
