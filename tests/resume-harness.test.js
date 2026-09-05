'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ResumeDom = require('../resume-dom');
const {
  buildHarnessInput,
  buildMessages,
  calculateOutputBudget,
  complete,
  setModelClientForTests,
} = require('../server/lib/resume-harness');

process.env.NODE_ENV = 'test';

function input(overrides = {}) {
  return buildHarnessInput({
    text: '把当前内容拆成两个段落',
    messageId: 'message-current',
    scope: { type: 'RESUME_BLOCK', id: 'bullet-1', revision: 7 },
    task: { id: 'task-1', goal: '优化工作经历' },
    profile: { revision: 3, basics: { name: '陈知行', city: '上海' } },
    resume: {
      revision: 7,
      content: {
        summary: '产品经理',
        experience: [{ id: 'work-1', bullets: [{ id: 'bullet-1', text: '完整正文尾部标记' }] }],
      },
    },
    job: { id: 'job-1', confirmed_text: '高级产品经理岗位完整描述' },
    focus: {
      current_text: '负责增长实验，激活率提升 26%',
      editing_base: '主导增长实验，推动激活率提升 26%',
      location: { section: 'experience', item_id: 'work-1', bullet_id: 'bullet-1' },
      neighboring_content: [{ id: 'bullet-2', text: '负责商业化策略' }],
    },
    conversationMessages: [
      { role: 'user', content: '先写得更专业' },
      { role: 'assistant', content: '这是上一版建议' },
    ],
    attachments: [{ id: 'upload-1', mime_type: 'image/png', content_base64: 'aW1hZ2U=' }],
    ...overrides,
  });
}

test('Harness 每轮携带完整工作区、会话和锁定焦点', () => {
  const built = input();
  assert.strictEqual(built.workspace.resume.content.experience[0].bullets[0].text, '完整正文尾部标记');
  assert.strictEqual(built.workspace.target_job.confirmed_text, '高级产品经理岗位完整描述');
  assert.strictEqual(Object.hasOwn(built.workspace, 'confirmed_facts'), false);
  assert.strictEqual(Object.hasOwn(built, 'pending_facts'), false);
  assert.strictEqual(built.focus.editing_base, '主导增长实验，推动激活率提升 26%');
  assert.deepStrictEqual(built.conversation.recent_messages.map((item) => item.content), [
    '先写得更专业',
    '这是上一版建议',
  ]);
});

test('Harness 继续调整时把完整建议态文档一并交给模型', () => {
  const proposalContent = {
    version: 'resume-dom-v1',
    root: {
      id: 'resume-root',
      type: 'element',
      tag: 'article',
      children: [{
        id: 'proposal-paragraph',
        type: 'element',
        tag: 'p',
        text: '上一轮建议形成的完整内容',
        editable: true,
      }],
    },
  };
  const built = input({
    resume: {
      revision: 7,
      content: input().workspace.resume.content,
      proposal_content: proposalContent,
      proposal_id: 'proposal-previous',
    },
    focus: {
      current_text: '原始内容',
      editing_base: '上一轮建议',
      scope_region: {
        scope_id: 'bullet-1',
        kind: 'node',
        node_ids: ['bullet-1'],
        text: '上一轮建议',
      },
    },
  });
  assert.strictEqual(
    built.workspace.resume.proposal_content.root.children[0].text,
    '上一轮建议形成的完整内容',
  );
  assert.strictEqual(built.workspace.resume.proposal_id, 'proposal-previous');
  assert.strictEqual(built.focus.scope_region.kind, 'node');

  const messages = buildMessages(built);
  assert.match(
    String(messages[1].content),
    /上一轮建议形成的完整内容/,
  );
});

test('Harness 给模型发送语义树而不是页面样式、坐标和资源', () => {
  const document = ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: 'resume-root',
      type: 'element',
      tag: 'article',
      semantic: { kind: 'document' },
      children: [{
        id: 'page-1',
        type: 'element',
        tag: 'section',
        semantic: { kind: 'page' },
        style: { width: '595.28pt', height: '841.89pt' },
        children: [{
          id: 'summary-section',
          type: 'element',
          tag: 'section',
          semantic: { kind: 'section', group_id: 'summary' },
          children: [{
            id: 'summary-title',
            type: 'element',
            tag: 'h2',
            text: '职业概况',
            editable: true,
            semantic: { kind: 'section_title' },
            style: { color: '#164D7A', position: 'absolute', left: '52.5pt' },
          }, {
            id: 'summary-body',
            type: 'element',
            tag: 'p',
            text: '完整语义正文标记',
            editable: true,
            semantic: { kind: 'paragraph' },
          }],
        }],
      }],
    },
    page_setup: { size: 'A4' },
    styles: { injected_css: '.resume{color:red}'.repeat(200) },
    assets: [{ id: 'background-1', data: 'x'.repeat(4000) }],
    annotations: [],
  });
  const built = input({
    resume: { revision: 7, content: document },
    attachments: [],
  });
  const messages = buildMessages(built);
  const modelContext = String(messages[1].content);

  assert.match(modelContext, /resume-ai-context-v1/);
  assert.match(modelContext, /完整语义正文标记/);
  assert.match(modelContext, /summary-section/);
  assert.match(modelContext, /section_title/);
  assert.doesNotMatch(modelContext, /595\.28pt/);
  assert.doesNotMatch(modelContext, /52\.5pt/);
  assert.doesNotMatch(modelContext, /background-1/);
  assert.doesNotMatch(modelContext, /injected_css/);
  assert.ok(modelContext.length < JSON.stringify(document).length);
});

test('Harness 将图片与本轮锁定焦点一起发送给视觉模型', () => {
  const messages = buildMessages(input());
  const last = messages[messages.length - 1];
  assert.strictEqual(last.role, 'user');
  assert.ok(Array.isArray(last.content));
  assert.match(last.content[0].text, /bullet-1/);
  assert.strictEqual(last.content[1].image_url.url, 'data:image/png;base64,aW1hZ2U=');
});

test('Harness 会话记忆按预算保留完整的最近消息', () => {
  const conversationMessages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `完整消息-${index}`,
  }));
  const built = input({ conversationMessages, memoryOptions: { maxMessages: 3, maxChars: 1000 } });
  assert.deepStrictEqual(built.conversation.recent_messages.map((item) => item.content), [
    '完整消息-5',
    '完整消息-6',
    '完整消息-7',
  ]);
});

test('全局输出预算随简历复杂度增长，并始终受部署上下限保护', () => {
  const small = calculateOutputBudget(input(), {
    minimum: 3000,
    maximum: 9000,
  });
  const large = calculateOutputBudget(input({
    resume: {
      revision: 7,
      content: {
        summary: '复杂履历'.repeat(12000),
        experience: [],
      },
    },
    scope: { type: 'RESUME_DOCUMENT', id: null, revision: 7 },
  }), {
    minimum: 3000,
    maximum: 9000,
  });

  assert.strictEqual(small.initial >= 3000, true);
  assert.strictEqual(small.retry <= 9000, true);
  assert.strictEqual(large.initial > small.initial, true);
  assert.strictEqual(large.retry, 9000);
});

test('动态预算配置冲突时硬上限优先，绝不被更高下限突破', () => {
  const budget = calculateOutputBudget(input(), {
    minimum: 20000,
    maximum: 10000,
  });

  assert.strictEqual(budget.minimum, 10000);
  assert.strictEqual(budget.maximum, 10000);
  assert.strictEqual(budget.initial, 10000);
  assert.strictEqual(budget.retry, 10000);
  assert.strictEqual(budget.configuration_adjusted, true);
});

test('旧 RESUME_LLM_MAX_TOKENS 不会提升动态预算的默认 32768 硬上限', () => {
  const previousLegacy = process.env.RESUME_LLM_MAX_TOKENS;
  const previousLimit = process.env.RESUME_LLM_MAX_TOKENS_LIMIT;
  const previousInitialLimit = process.env.RESUME_LLM_INITIAL_MAX_TOKENS;
  process.env.RESUME_LLM_MAX_TOKENS = '50000';
  delete process.env.RESUME_LLM_MAX_TOKENS_LIMIT;
  delete process.env.RESUME_LLM_INITIAL_MAX_TOKENS;
  try {
    const budget = calculateOutputBudget(input({
      resume: {
        revision: 7,
        content: { summary: '长简历'.repeat(50000) },
      },
    }));
    assert.strictEqual(budget.initial_maximum, 16384);
    assert.strictEqual(budget.maximum, 32768);
    assert.ok(budget.initial <= 16384);
    assert.ok(budget.initial >= budget.minimum);
    assert.strictEqual(budget.retry, 32768);
  } finally {
    if (previousLegacy === undefined) delete process.env.RESUME_LLM_MAX_TOKENS;
    else process.env.RESUME_LLM_MAX_TOKENS = previousLegacy;
    if (previousLimit === undefined) delete process.env.RESUME_LLM_MAX_TOKENS_LIMIT;
    else process.env.RESUME_LLM_MAX_TOKENS_LIMIT = previousLimit;
    if (previousInitialLimit === undefined) delete process.env.RESUME_LLM_INITIAL_MAX_TOKENS;
    else process.env.RESUME_LLM_INITIAL_MAX_TOKENS = previousInitialLimit;
  }
});

test('Harness 不接受模型改写 scope', async () => {
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'scope-spoof',
    generate: async () => ({
      output: {
        reply: '已生成建议。',
        scope: { type: 'DATA_PROFILE', id: 'other' },
        actions: [],
        uncertainty: [],
      },
    }),
  });
  try {
    const result = await complete(input());
    assert.deepStrictEqual(result.response.scope, {
      type: 'RESUME_BLOCK',
      id: 'bullet-1',
      revision: 7,
    });
  } finally {
    restore();
  }
});

test('Harness 拒绝模型返回来源、证据或依赖关系字段', async () => {
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'forbidden-relations',
    generate: async () => ({
      output: {
        reply: '建议如下。',
        scope: { type: 'RESUME_BLOCK', id: 'bullet-1' },
        actions: [{
          type: 'RESUME_REWRITE_PROPOSAL',
          payload: {
            proposal: {
              original: 'A',
              suggestion: 'B',
              source_item_ids: ['exp-1'],
            },
          },
        }],
        uncertainty: [],
      },
    }),
  });
  try {
    await assert.rejects(() => complete(input()), /不允许的内容关系字段/);
  } finally {
    restore();
  }
});

test('Harness 对不可执行的通用 DOM 动作自动修复一次', async () => {
  let calls = 0;
  let repairPrompt = '';
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'action-repair',
    generate: async ({ input: modelInput, messages }) => {
      calls += 1;
      if (calls === 1) {
        return {
          output: {
            reply: '建议新增两个段落，确认后即可应用。',
            actions: [{
              type: 'RESUME_REWRITE_PROPOSAL',
              payload: { proposal: { operations: [{ node: {} }] } },
            }],
            uncertainty: [],
          },
        };
      }
      repairPrompt = String(messages[messages.length - 1].content || '');
      return {
        output: {
          reply: '已生成可执行的结构建议，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                suggestion: '新增两个段落',
                change_constraints: {
                  content: 'modify',
                  structure: 'modify',
                  style: 'preserve',
                  allowed_region_ids: ['resume-root'],
                },
                target_resume_document: (() => {
                  const target = ResumeDom.toResumeDocument(
                    modelInput.workspace.resume.content,
                  );
                  target.root.children.push({
                    id: 'new-paragraph-1',
                    type: 'element',
                    tag: 'p',
                    text: '新增段落',
                    editable: true,
                  });
                  return ResumeDom.toResumeDocument(target);
                })(),
              },
            },
          }],
          uncertainty: [],
        },
      };
    },
  });
  try {
    const result = await complete(input({
      scope: { type: 'RESUME_DOCUMENT', id: null, revision: 7 },
    }));
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.repair_count, 1);
    assert.ok(result.response.actions[0].payload.proposal.target_resume_document);
    assert.match(repairPrompt, /无法形成合法的目标简历/);
    assert.match(repairPrompt, /空操作/);
  } finally {
    restore();
  }
});

test('Harness 对只改结构却丢失原文的建议自动修复一次', async () => {
  let calls = 0;
  let repairPrompt = '';
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'content-preservation-repair',
    generate: async ({ input: modelInput, messages }) => {
      calls += 1;
      const current = ResumeDom.toResumeDocument(modelInput.workspace.resume.content);
      const found = ResumeDom.findNode(current, 'bullet-1');
      const original = ResumeDom.nodeText(found.node);
      if (calls === 1) {
        return {
          output: {
            reply: '已拆成两个段落，确认后即可应用。',
            actions: [{
              type: 'RESUME_REWRITE_PROPOSAL',
              payload: {
                proposal: {
                  change_constraints: {
                    content: 'preserve',
                    structure: 'modify',
                    style: 'preserve',
                    allowed_region_ids: [found.parent.id],
                  },
                  operations: [
                    { op: 'remove_node', node_id: 'bullet-1' },
                    {
                      op: 'insert_node',
                      parent_id: found.parent.id,
                      index: found.index,
                      node: {
                        id: 'split-loss-1',
                        type: 'element',
                        tag: 'p',
                        text: '完整正文',
                        editable: true,
                      },
                    },
                    {
                      op: 'insert_node',
                      parent_id: found.parent.id,
                      after_node_id: 'split-loss-1',
                      node: {
                        id: 'split-loss-2',
                        type: 'element',
                        tag: 'p',
                        text: '',
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
      repairPrompt = String(messages[messages.length - 1].content || '');
      return {
        output: {
          reply: '已完整保留原文并拆成两个段落，确认后即可应用。',
          actions: [{
            type: 'RESUME_REWRITE_PROPOSAL',
            payload: {
              proposal: {
                change_constraints: {
                  content: 'preserve',
                  structure: 'modify',
                  style: 'preserve',
                  allowed_region_ids: [found.parent.id],
                },
                operations: [
                  { op: 'remove_node', node_id: 'bullet-1' },
                  {
                    op: 'insert_node',
                    parent_id: found.parent.id,
                    index: found.index,
                    node: {
                      id: 'split-safe-1',
                      type: 'element',
                      tag: 'p',
                      text: original.slice(0, 4),
                      editable: true,
                    },
                  },
                  {
                    op: 'insert_node',
                    parent_id: found.parent.id,
                    after_node_id: 'split-safe-1',
                    node: {
                      id: 'split-safe-2',
                      type: 'element',
                      tag: 'p',
                      text: original.slice(4),
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
    const result = await complete(input());
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.repair_count, 1);
    assert.match(repairPrompt, /必须完整保留原文字/);
    assert.strictEqual(
      result.response.actions[0].payload.proposal.change_constraints.content,
      'preserve',
    );
  } finally {
    restore();
  }
});

test('Harness 将生成最终结果前的自然语言沟通直接透传', async () => {
  let calls = 0;
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'message-passthrough',
    generate: async () => {
      calls += 1;
      return {
        output: {
          type: 'message',
          content: '我准备保留全部文字，只调整为一个整体编辑区域。按这个理解继续吗？',
          awaiting_user: true,
          quick_replies: ['按这个理解继续', '我再补充一下'],
        },
      };
    },
  });
  try {
    const result = await complete(input({
      scope: { type: 'RESUME_DOCUMENT', id: null, revision: 7 },
    }));
    assert.strictEqual(calls, 1);
    assert.strictEqual(result.repair_count, 0);
    assert.strictEqual(result.response.result_type, 'MESSAGE');
    assert.strictEqual(result.response.awaiting_user, true);
    assert.deepStrictEqual(result.response.actions, []);
    assert.match(result.response.content, /只调整为一个整体编辑区域/);
    assert.deepStrictEqual(
      result.response.quick_replies.map((item) => item.label),
      ['按这个理解继续', '我再补充一下'],
    );
  } finally {
    restore();
  }
});

test('Harness 将真实结果歧义作为自然语言消息返回', async () => {
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'structured-clarification',
    generate: async () => ({
      output: {
        type: 'message',
        content: '你希望保留当前排版，只让三个段落分别使用 AI，还是把它们移出当前内容组？',
        awaiting_user: true,
        quick_replies: [
          { id: 'keep-layout', label: '保留排版，分别编辑' },
          { id: 'physical-ungroup', label: '拆成三个独立区域' },
        ],
      },
    }),
  });
  try {
    const result = await complete(input());
    assert.strictEqual(result.response.result_type, 'MESSAGE');
    assert.strictEqual(result.response.actions.length, 0);
    assert.deepStrictEqual(
      result.response.quick_replies.map((option) => option.id),
      ['keep-layout', 'physical-ungroup'],
    );
  } finally {
    restore();
  }
});

test('Harness 将简洁 proposal 协议转换为内部待确认动作', async () => {
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'direct-proposal-envelope',
    generate: async ({ input: modelInput }) => {
      const current = ResumeDom.toResumeDocument(modelInput.workspace.resume.content);
      const found = ResumeDom.findNode(current, 'bullet-1');
      const target = ResumeDom.applyDocumentOperations(current, [{
        op: 'replace_text',
        node_id: 'bullet-1',
        text: `${ResumeDom.nodeText(found.node)} 更突出项目推动能力。`,
      }], { allowStructure: true });
      return {
        output: {
          type: 'proposal',
          content: '已强化项目推动能力，其他内容保持不变。',
          proposal: {
            target_resume_document: target,
            change_constraints: {
              content: 'modify',
              content_order: 'preserve',
              structure: 'preserve',
              style: 'preserve',
              allowed_region_ids: ['bullet-1'],
            },
          },
        },
      };
    },
  });
  try {
    const result = await complete(input());
    assert.strictEqual(result.response.result_type, 'PROPOSAL');
    assert.strictEqual(result.response.type, 'proposal');
    assert.strictEqual(result.response.actions.length, 1);
    assert.strictEqual(result.response.actions[0].type, 'RESUME_REWRITE_PROPOSAL');
    assert.ok(result.response.actions[0].payload.proposal.target_resume_document);
  } finally {
    restore();
  }
});

test('Harness 将最小目标子树组装为完整目标文档', async () => {
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'target-fragment-delete',
    generate: async () => ({
      output: {
        type: 'proposal',
        content: '已准备删除当前内容，其他区域保持不变。',
        proposal: {
          target_resume_fragments: {
            format: 'resume-target-fragments-v1',
            changes: [{
              target_id: 'bullet-1',
              replacement_subtree: null,
            }],
          },
          change_constraints: {
            content: 'modify',
            content_order: 'preserve',
            structure: 'modify',
            style: 'preserve',
            allowed_region_ids: ['bullet-1'],
          },
        },
      },
    }),
  });
  try {
    const result = await complete(input());
    const proposal = result.response.actions[0].payload.proposal;
    assert.strictEqual(
      proposal.target_resume_fragments.format,
      'resume-target-fragments-v1',
    );
    assert.strictEqual(
      ResumeDom.findNode(proposal.target_resume_document, 'bullet-1'),
      null,
    );
    assert.ok(ResumeDom.findNode(proposal.target_resume_document, 'resume-root'));
  } finally {
    restore();
  }
});

test('Harness 用紧凑新增声明插入平级模块，不要求模型重复返回父节点', async () => {
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'compact-sibling-insertion',
    generate: async () => ({
      output: {
        type: 'proposal',
        content: '已准备在职业概况后新增职业发展规划模块，其他内容保持不变。',
        proposal: {
          target_resume_fragments: {
            format: 'resume-target-fragments-v2',
            changes: [],
            insertions: [{
              parent_id: 'resume-root',
              after_id: 'section-summary',
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
                    text: '持续深耕产品规划与团队协作。',
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
    }),
  });
  try {
    const result = await complete(input({
      text: '在职业概况后新增职业发展规划模块',
      scope: { type: 'RESUME_DOCUMENT', id: null, revision: 7 },
    }));
    const proposal = result.response.actions[0].payload.proposal;
    assert.strictEqual(
      proposal.target_resume_fragments.format,
      'resume-target-fragments-v2',
    );
    assert.strictEqual(proposal.target_resume_fragments.changes.length, 0);
    assert.strictEqual(proposal.target_resume_fragments.insertions.length, 1);
    assert.ok(ResumeDom.findNode(
      proposal.target_resume_document,
      'career-plan-section',
    ));
    assert.deepStrictEqual(
      proposal.target_resume_document.root.children.map((child) => child.id),
      [
        'resume-header',
        'section-summary',
        'career-plan-section',
        'section-experience',
      ],
    );
  } finally {
    restore();
  }
});

test('删除含文字节点时会修正错误的 content=preserve 约束', async () => {
  let calls = 0;
  let repairPrompt = '';
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'delete-content-constraint-repair',
    generate: async ({ messages }) => {
      calls += 1;
      if (calls === 2) repairPrompt = String(messages[messages.length - 1].content || '');
      return {
        output: {
          type: 'proposal',
          content: '已准备删除当前内容。',
          proposal: {
            target_resume_fragments: {
              format: 'resume-target-fragments-v1',
              changes: [{
                target_id: 'bullet-1',
                replacement_subtree: null,
              }],
            },
            change_constraints: {
              content: calls === 1 ? 'preserve' : 'modify',
              content_order: 'preserve',
              structure: 'modify',
              style: 'preserve',
              allowed_region_ids: ['bullet-1'],
            },
          },
        },
      };
    },
  });
  try {
    const result = await complete(input({ text: '删除当前这项内容' }));
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.repair_count, 1);
    assert.match(repairPrompt, /删除任何包含文字的节点、段落或模块/);
    assert.strictEqual(
      result.response.actions[0].payload.proposal.change_constraints.content,
      'modify',
    );
  } finally {
    restore();
  }
});

test('Harness 拒绝相互矛盾的目标子树和完整目标文档，并只保留唯一目标事实', async () => {
  let calls = 0;
  let repairPrompt = '';
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'target-fragment-document-mismatch',
    generate: async ({ input: modelInput, messages }) => {
      calls += 1;
      const fragments = {
        format: 'resume-target-fragments-v1',
        changes: [{
          target_id: 'bullet-1',
          replacement_subtree: null,
        }],
      };
      if (calls === 1) {
        const inconsistent = ResumeDom.toResumeDocument(modelInput.workspace.resume.content);
        ResumeDom.findNode(inconsistent, 'bullet-1').node.text = '另一份不一致的目标';
        return {
          output: {
            type: 'proposal',
            content: '已准备删除当前内容。',
            proposal: {
              target_resume_fragments: fragments,
              target_resume_document: inconsistent,
              change_constraints: {
                content: 'modify',
                content_order: 'preserve',
                structure: 'modify',
                style: 'preserve',
                allowed_region_ids: ['bullet-1'],
              },
            },
          },
        };
      }
      repairPrompt = String(messages[messages.length - 1].content || '');
      return {
        output: {
          type: 'proposal',
          content: '已准备删除当前内容。',
          proposal: {
            target_resume_fragments: fragments,
            change_constraints: {
              content: 'modify',
              content_order: 'preserve',
              structure: 'modify',
              style: 'preserve',
              allowed_region_ids: ['bullet-1'],
            },
          },
        },
      };
    },
  });
  try {
    const result = await complete(input());
    const proposal = result.response.actions[0].payload.proposal;
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.repair_count, 1);
    assert.match(repairPrompt, /目标子树与完整目标文档不一致/);
    assert.strictEqual(
      ResumeDom.findNode(proposal.target_resume_document, 'bullet-1'),
      null,
    );
  } finally {
    restore();
  }
});

test('完整目标文档包含已停用 AI 范围属性时拒绝迁移，并自动修复为合法节点结构', async () => {
  let calls = 0;
  let repairPrompt = '';
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'retired-ai-scope-repair',
    generate: async ({ input: modelInput, messages }) => {
      calls += 1;
      const current = ResumeDom.toResumeDocument(modelInput.workspace.resume.content);
      if (calls === 1) {
        const target = JSON.parse(JSON.stringify(current));
        const findRaw = (node) => {
          if (!node) return null;
          if (node.id === 'bullet-1') return node;
          for (const child of node.children || []) {
            const found = findRaw(child);
            if (found) return found;
          }
          return null;
        };
        findRaw(target.root).attributes = { 'data-ai-scope': 'true' };
        return {
          output: {
            type: 'proposal',
            content: '已准备修改。',
            proposal: {
              target_resume_document: target,
              change_constraints: {
                content: 'preserve',
                content_order: 'preserve',
                structure: 'modify',
                style: 'modify',
                allowed_region_ids: ['bullet-1'],
              },
            },
          },
        };
      }
      repairPrompt = String(messages[messages.length - 1].content || '');
      const target = ResumeDom.applyDocumentOperations(current, [{
        op: 'replace_text',
        node_id: 'bullet-1',
        text: '合法的新表达。',
      }], { allowStructure: false });
      return {
        output: {
          type: 'proposal',
          content: '已生成合法的新表达。',
          proposal: {
            target_resume_document: target,
            change_constraints: {
              content: 'modify',
              content_order: 'preserve',
              structure: 'preserve',
              style: 'preserve',
              allowed_region_ids: ['bullet-1'],
            },
          },
        },
      };
    },
  });
  try {
    const result = await complete(input({ text: '优化当前表达' }));
    assert.strictEqual(calls, 2);
    assert.match(repairPrompt, /data-ai-scope 已停用/);
    assert.strictEqual(result.response.result_type, 'PROPOSAL');
    assert.strictEqual(
      ResumeDom.findNode(
        result.response.actions[0].payload.proposal.target_resume_document,
        'bullet-1',
      ).node.attributes['data-ai-scope'],
      undefined,
    );
  } finally {
    restore();
  }
});

test('Harness 在模型输出截断后提高动态预算，并要求改用最小目标子树', async () => {
  let calls = 0;
  const budgets = [];
  let retryPrompt = '';
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'target-fragment-protocol-retry',
    generate: async ({ messages, maxTokens }) => {
      calls += 1;
      budgets.push(maxTokens);
      if (calls === 1) {
        const error = new Error('输出达到长度上限');
        error.code = 'DEEPSEEK_OUTPUT_TRUNCATED';
        error.finish_reason = 'length';
        throw error;
      }
      retryPrompt = String(messages[messages.length - 1].content || '');
      return {
        output: {
          type: 'proposal',
          content: '已准备删除当前内容。',
          proposal: {
            target_resume_fragments: {
              format: 'resume-target-fragments-v1',
              changes: [{
                target_id: 'bullet-1',
                replacement_subtree: null,
              }],
            },
            change_constraints: {
              content: 'modify',
              content_order: 'preserve',
              structure: 'modify',
              style: 'preserve',
              allowed_region_ids: ['bullet-1'],
            },
          },
        },
      };
    },
  });
  try {
    const result = await complete(input());
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.repair_count, 1);
    assert.ok(budgets[1] > budgets[0]);
    assert.match(retryPrompt, /target_resume_fragments/);
    assert.match(retryPrompt, /replacement_subtree:null/);
    assert.match(retryPrompt, /insertions/);
  } finally {
    restore();
  }
});

test('Harness 对合法 JSON 但缺少协议字段的结果自动恢复一次', async () => {
  let calls = 0;
  const budgets = [];
  let retryPrompt = '';
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'schema-shape-retry',
    generate: async ({ messages, maxTokens }) => {
      calls += 1;
      budgets.push(maxTokens);
      if (calls === 1) {
        return {
          output: {
            type: 'proposal',
            proposal: {
              target_resume_fragments: {
                format: 'resume-target-fragments-v2',
                changes: [],
                insertions: [],
              },
            },
          },
          finish_reason: 'stop',
          max_tokens: maxTokens,
        };
      }
      retryPrompt = String(messages[messages.length - 1].content || '');
      return {
        output: {
          type: 'proposal',
          content: '已准备删除当前内容。',
          proposal: {
            target_resume_fragments: {
              format: 'resume-target-fragments-v2',
              changes: [{
                target_id: 'bullet-1',
                replacement_subtree: null,
              }],
              insertions: [],
            },
            change_constraints: {
              content: 'modify',
              content_order: 'preserve',
              structure: 'modify',
              style: 'preserve',
              allowed_region_ids: ['bullet-1'],
            },
          },
        },
        finish_reason: 'stop',
        max_tokens: maxTokens,
      };
    },
  });
  try {
    const result = await complete(input({ text: '删除当前内容' }));
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.repair_count, 1);
    assert.ok(budgets[1] > budgets[0]);
    assert.match(retryPrompt, /缺少 content/);
    assert.match(retryPrompt, /resume-target-fragments-v2/);
  } finally {
    restore();
  }
});

test('Harness 整个请求最多调用模型两次，协议恢复后不再叠加执行修复', async () => {
  let calls = 0;
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'bounded-total-retry',
    generate: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('输出达到长度上限');
        error.code = 'DEEPSEEK_OUTPUT_TRUNCATED';
        throw error;
      }
      return {
        output: {
          type: 'proposal',
          content: '已准备修改。',
          proposal: {
            target_resume_fragments: {
              format: 'resume-target-fragments-v1',
              changes: [{
                target_id: 'missing-node',
                replacement_subtree: null,
              }],
            },
            change_constraints: {
              content: 'modify',
              content_order: 'preserve',
              structure: 'modify',
              style: 'preserve',
              allowed_region_ids: ['bullet-1'],
            },
          },
        },
      };
    },
  });
  try {
    await assert.rejects(
      () => complete(input()),
      (error) => error.code === 'PROPOSAL_NOT_EXECUTABLE',
    );
    assert.strictEqual(calls, 2);
  } finally {
    restore();
  }
});

test('Harness 对复杂请求以自然语言说明处理思路，不提前生成动作', async () => {
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'plan-confirmation',
    generate: async () => ({
      output: {
        type: 'message',
        content: '我准备这样修改：\n1. 结合整份简历中的工作和项目经历\n2. 合并当前内容中的重复表达\n3. 强化管理经验并整理为三个段落\n本次先只修改职业概况。',
        awaiting_user: true,
        quick_replies: ['按这个思路修改', '调整要求'],
      },
    }),
  });
  try {
    const result = await complete(input());
    assert.strictEqual(result.response.result_type, 'MESSAGE');
    assert.deepStrictEqual(result.response.actions, []);
    assert.match(result.response.content, /结合整份简历/);
    assert.deepStrictEqual(
      result.response.quick_replies.map((item) => item.label),
      ['按这个思路修改', '调整要求'],
    );
  } finally {
    restore();
  }
});

test('模型直接返回文字与结构混合修改时，Harness 强制先用自然语言确认处理思路', async () => {
  let calls = 0;
  let repairPrompt = '';
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'deterministic-plan-gate',
    generate: async ({ input: modelInput, messages }) => {
      calls += 1;
      if (calls === 2) {
        repairPrompt = String(messages[messages.length - 1].content || '');
        return {
          output: {
            type: 'message',
            content: '我会结合整份简历核对上下文，重写当前表达并拆成两个段落，其他区域和样式保持不变。',
            awaiting_user: true,
            message_kind: 'plan_confirmation',
            quick_replies: ['按这个思路修改', '调整要求'],
          },
        };
      }
      const current = ResumeDom.toResumeDocument(modelInput.workspace.resume.content);
      const found = ResumeDom.findNode(current, 'bullet-1');
      const target = ResumeDom.applyDocumentOperations(current, [
        { op: 'remove_node', node_id: 'bullet-1' },
        {
          op: 'insert_node',
          parent_id: found.parent.id,
          index: found.index,
          node: {
            id: 'mixed-paragraph-1',
            type: 'element',
            tag: 'p',
            text: '第一段重写后的内容。',
            editable: true,
          },
        },
        {
          op: 'insert_node',
          parent_id: found.parent.id,
          after_node_id: 'mixed-paragraph-1',
          node: {
            id: 'mixed-paragraph-2',
            type: 'element',
            tag: 'p',
            text: '第二段补充管理经验。',
            editable: true,
          },
        },
      ], { allowStructure: true });
      return {
        output: {
          type: 'proposal',
          content: '已重写并拆成两个段落。',
          proposal: {
            target_resume_document: target,
            change_constraints: {
              content: 'modify',
              content_order: 'preserve',
              structure: 'modify',
              style: 'preserve',
              allowed_region_ids: [found.parent.id],
            },
          },
        },
      };
    },
  });
  try {
    const result = await complete(input({
      text: '拆成两个段落并润色',
    }));
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.repair_count, 1);
    assert.strictEqual(result.response.result_type, 'MESSAGE');
    assert.strictEqual(result.response.actions.length, 0);
    assert.strictEqual(result.response.message_kind, 'plan_confirmation');
    assert.match(repairPrompt, /必须先确认处理思路/);
    assert.match(result.response.content, /结合整份简历/);
  } finally {
    restore();
  }
});

test('用户已经回应处理思路后，同一类复杂修改直接生成可应用建议', async () => {
  let calls = 0;
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'confirmed-plan-proposal',
    generate: async ({ input: modelInput }) => {
      calls += 1;
      const current = ResumeDom.toResumeDocument(modelInput.workspace.resume.content);
      const found = ResumeDom.findNode(current, 'bullet-1');
      const target = ResumeDom.applyDocumentOperations(current, [
        { op: 'remove_node', node_id: 'bullet-1' },
        {
          op: 'insert_node',
          parent_id: found.parent.id,
          index: found.index,
          node: {
            id: 'confirmed-paragraph-1',
            type: 'element',
            tag: 'p',
            text: '第一段重写后的内容。',
            editable: true,
          },
        },
        {
          op: 'insert_node',
          parent_id: found.parent.id,
          after_node_id: 'confirmed-paragraph-1',
          node: {
            id: 'confirmed-paragraph-2',
            type: 'element',
            tag: 'p',
            text: '第二段补充管理经验。',
            editable: true,
          },
        },
      ], { allowStructure: true });
      return {
        output: {
          type: 'proposal',
          content: '已按确认的思路完成。',
          proposal: {
            target_resume_document: target,
            change_constraints: {
              content: 'modify',
              content_order: 'preserve',
              structure: 'modify',
              style: 'preserve',
              allowed_region_ids: [found.parent.id],
            },
          },
        },
      };
    },
  });
  try {
    const result = await complete(input({
      text: '按这个思路修改',
      task: {
        id: 'task-1',
        goal: '优化工作经历',
        state: {
          confirmed_plan: {
            content: 'modify',
            structure: 'modify',
          },
        },
      },
    }));
    assert.strictEqual(calls, 1);
    assert.strictEqual(result.response.result_type, 'PROPOSAL');
    assert.strictEqual(result.response.actions.length, 1);
  } finally {
    restore();
  }
});

test('普通澄清的快捷回复不会被误认为已经确认复杂修改思路', async () => {
  let calls = 0;
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'clarification-is-not-plan-confirmation',
    generate: async ({ input: modelInput }) => {
      calls += 1;
      if (calls === 2) {
        return {
          output: {
            type: 'message',
            content: '我会结合整份简历核对上下文，同时调整当前文字和段落结构，其他内容保持不变。',
            awaiting_user: true,
            message_kind: 'plan_confirmation',
            quick_replies: ['按这个思路修改', '调整要求'],
          },
        };
      }
      const current = ResumeDom.toResumeDocument(modelInput.workspace.resume.content);
      const found = ResumeDom.findNode(current, 'bullet-1');
      const target = ResumeDom.applyDocumentOperations(current, [
        { op: 'remove_node', node_id: 'bullet-1' },
        {
          op: 'insert_node',
          parent_id: found.parent.id,
          index: found.index,
          node: {
            id: 'clarified-mixed-paragraph-1',
            type: 'element',
            tag: 'p',
            text: '第一段重写后的内容。',
            editable: true,
          },
        },
        {
          op: 'insert_node',
          parent_id: found.parent.id,
          after_node_id: 'clarified-mixed-paragraph-1',
          node: {
            id: 'clarified-mixed-paragraph-2',
            type: 'element',
            tag: 'p',
            text: '第二段补充管理经验。',
            editable: true,
          },
        },
      ], { allowStructure: true });
      return {
        output: {
          type: 'proposal',
          content: '已改写并拆成两个段落。',
          proposal: {
            target_resume_document: target,
            change_constraints: {
              content: 'modify',
              content_order: 'preserve',
              structure: 'modify',
              style: 'preserve',
              allowed_region_ids: [found.parent.id],
            },
          },
        },
      };
    },
  });
  try {
    const result = await complete(input({
      text: '按刚才补充的信息继续修改',
      task: {
        id: 'task-1',
        goal: '优化工作经历',
        state: {
          answered_message: {
            content: '你希望突出管理还是执行？',
            quick_replies: [
              { id: 'management', label: '突出管理' },
              { id: 'execution', label: '突出执行' },
            ],
          },
        },
      },
    }));
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.response.result_type, 'MESSAGE');
    assert.strictEqual(result.response.message_kind, 'plan_confirmation');
    assert.deepStrictEqual(result.response.actions, []);
  } finally {
    restore();
  }
});

test('Harness 不允许 message 同时携带待应用动作', async () => {
  let calls = 0;
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'invalid-clarification-with-action',
    generate: async () => {
      calls += 1;
      return calls === 1
        ? {
            output: {
              type: 'message',
              content: '请确认。',
              awaiting_user: true,
              actions: [{
                type: 'RESUME_REWRITE_PROPOSAL',
                payload: { proposal: { suggestion: '修改后内容' } },
              }],
              uncertainty: [],
            },
          }
        : {
            output: {
              type: 'message',
              content: '请补充你希望得到的最终效果。',
              awaiting_user: true,
            },
          };
    },
  });
  try {
    const result = await complete(input());
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.response.result_type, 'MESSAGE');
    assert.strictEqual(result.response.actions.length, 0);
  } finally {
    restore();
  }
});

test('Harness 连续两次无法形成可执行动作时明确失败', async () => {
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'invalid-action-twice',
    generate: async () => ({
      output: {
        reply: '确认后即可应用。',
        actions: [{
          type: 'RESUME_REWRITE_PROPOSAL',
          payload: { proposal: { operations: [{}] } },
        }],
        uncertainty: [],
      },
    }),
  });
  try {
    await assert.rejects(
      () => complete(input({
        scope: { type: 'RESUME_DOCUMENT', id: null, revision: 7 },
      })),
      /模型没有生成可执行动作/,
    );
  } finally {
    restore();
  }
});
