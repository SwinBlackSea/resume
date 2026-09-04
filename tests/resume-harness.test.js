'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ResumeDom = require('../resume-dom');
const {
  buildHarnessInput,
  buildMessages,
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
