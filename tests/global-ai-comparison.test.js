'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createModelGateway } = require('../server/lib/model-gateway');
const { parseArgs, summarize, runComparison } = require('../server/scripts/compare-global-ai');
const { CASES, fictionalDocument, caseInput, evaluateCase } = require('../server/scripts/global-ai-cases');
const ResumeDom = require('../resume-dom');
const harness = require('../server/lib/resume-harness');

function outputFor(scenario) {
  const wire = { type: 'proposal', content: '建议已准备好，请预览后应用。',
    awaiting_user: false, message_kind: null, quick_replies: [],
    resume_proposal: null, data_actions: [] };
  if (scenario.id === 'discussion') return { ...wire, type: 'message',
    content: '可以压缩重复表述，并优先展示与岗位相关的项目。' };
  if (scenario.id === 'new-job') return { ...wire, data_actions: [
    { type: 'JOB_SET_CURRENT_PROPOSAL', target_id: null,
      payload: { title: '高级产品经理', company: '虚构星河公司', confirmed_text: '负责企业服务需求调研、产品规划及跨团队交付。' } },
  ] };
  const target = fictionalDocument();
  // findNode intentionally normalizes/clones; mutate this test fixture itself.
  const node = (id, current = target.root) => current.id === id ? current
    : (current.children || []).map((child) => node(id, child)).find(Boolean);
  const constraints = { content: 'modify', structure: 'preserve', style: 'preserve',
    content_order: 'preserve', allowed_region_ids: ['qa-root'] };
  if (scenario.id.startsWith('translate')) {
    node('qa-role').text = '产品经理';
    node('work-title').text = '工作经历';
    node('work-body').text = node('work-body').text.replace('Product planning', '产品规划');
  } else if (scenario.id === 'shorten' || scenario.id === 'followup') {
    node('summary-body').text = scenario.id === 'shorten'
      ? '负责3个项目，协调12人团队，实现办理时长降低25%。' : '3个项目，12人团队，办理时长降25%。';
  } else if (scenario.id === 'reorder') {
    const [projects] = target.root.children.splice(4, 1);
    target.root.children.splice(3, 0, projects);
    constraints.content = 'preserve';
    constraints.structure = 'modify';
    constraints.content_order = 'reorder';
  } else {
    for (const id of ['summary', 'work', 'projects', 'education']) {
      node(`${id}-title`).style = { color: '#17365D', 'font-size': '18px' };
    }
    constraints.content = 'preserve';
    constraints.style = 'modify';
  }
  return { ...wire, resume_proposal: { changes: [], insertions: [],
    target_document_json: JSON.stringify(target), change_constraints: constraints } };
}

function fakeWire(captured) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    captured.push({ url, body });
    const last = body.input.at(-1).content;
    const text = typeof last === 'string' ? last : last.filter((part) => part.type === 'input_text').map((part) => part.text).join('\n');
    const scenario = CASES.find((item) => text === item.text);
    assert.ok(scenario, '本轮用户要求必须原样透传');
    const output = outputFor(scenario);
    return { ok: true, body: new ReadableStream({ start(controller) {
      const event = { type: 'response.completed', response: { status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
        usage: { input_tokens: 20, output_tokens: 10 } } };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    } }) };
  };
}

test('对照脚本默认只预览、不联网，不读配置；轮数有界且不接受隐藏参数', () => {
  assert.deepEqual(parseArgs([]), { rounds: 5, live: false });
  assert.deepEqual(parseArgs(['--live', '--rounds', '3']), { rounds: 3, live: true });
  for (const args of [['--rounds'], ['--rounds', '0'], ['--rounds', '11'], ['--rounds', '1.5'],
    ['--live', '--dry-run'], ['--api-key', 'secret']]) assert.throws(() => parseArgs(args));
  const result = spawnSync(process.execPath, ['server/scripts/compare-global-ai.js', '--dry-run'], {
    cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout.trim());
  assert.equal(plan.scenarios, 90);
  assert.equal(plan.max_generation_calls, 180);
  assert.equal(plan.candidate.model, 'gpt-6-astra');
});

test('离线双供应商完整链路：9场景各2轮，保持用户原话、Schema、路由、历史和基线一致', async () => {
  const captured = [];
  const fetchImpl = fakeWire(captured);
  const contenders = [
    { name: 'baseline', client: createModelGateway({ provider: 'deepseek', globalProvider: 'deepseek',
      apiKey: 'baseline-test', endpoint: 'https://baseline.example/responses', fetchImpl }) },
    { name: 'candidate', client: createModelGateway({ provider: 'deepseek', globalProvider: 'openai',
      apiKey: 'baseline-test', endpoint: 'https://baseline.example/responses', fetchImpl,
      openai: { apiKey: 'candidate-test', baseUrl: 'https://candidate.example/v1', model: 'gpt-5.5' } }) },
  ];
  const result = await runComparison({ rounds: 2, contenders });
  assert.equal(result.entries.length, 36);
  assert.ok(result.entries.every((entry) => entry.ok), JSON.stringify(result.entries.filter((entry) => !entry.ok)));
  for (const row of result.summary) {
    assert.equal(row.attempted, 18);
    assert.equal(row.first_pass, 18);
    assert.equal(row.input_tokens, 360);
    assert.equal(row.output_tokens, 180);
  }
  for (let index = 0; index < result.entries.length; index += 2) {
    assert.equal(result.entries[index].request_hashes[0], result.entries[index + 1].request_hashes[0],
      '相同输入与候选输出时，两供应商应收到相同上下文与 Schema');
  }
  assert.equal(result.entries[18].contender, 'candidate', '下一轮交换先后顺序');
  for (const record of captured.filter((item) => item.url.includes('candidate'))) {
    assert.equal(record.body.model, 'gpt-5.5');
    assert.equal(record.body.store, false);
    assert.equal(record.body.temperature, undefined);
  }
  for (const id of ['translate-image-history', 'image-style']) {
    assert.ok(result.entries.filter((entry) => entry.case === id).every((entry) => entry.route === 'vision'));
  }
  assert.ok(!Object.keys(require.cache).some((file) => /server\/lib\/(?:db|storage)\.js$/.test(file)),
    '对照测试不得加载生产数据库或存储模块');
});

test('脚本遇到无效 Key 立即停，保留无正文诊断，不运行后续场景或隐式降级', async () => {
  let calls = 0;
  const reports = [];
  await assert.rejects(runComparison({ rounds: 5, contenders: [{ name: 'candidate', client: {
    async generate() {
      calls++;
      throw Object.assign(new Error('不能打印的供应商正文'), { code: 'MODEL_HTTP_ERROR', status: 401 });
    },
  } }], onReport(entries) { reports.push(structuredClone(entries)); } }), { code: 'COMPARISON_STOPPED' });
  assert.equal(calls, 1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0][0].http_status, 401);
  assert.doesNotMatch(JSON.stringify(reports), /供应商正文|林舟/);
});

test('语义断言不是只检查 JSON：漏翻、未缩短、未改样式都判失败', async () => {
  const document = fictionalDocument();
  for (const id of ['translate', 'shorten', 'style']) {
    const scenario = CASES.find((item) => item.id === id);
    const response = { result_type: 'PROPOSAL', actions: [
      { type: 'RESUME_REWRITE_PROPOSAL', payload: { proposal: { target_resume_document: document } } },
    ] };
    assert.throws(() => evaluateCase(scenario, response, document));
  }
  const followup = CASES.find((item) => item.id === 'followup');
  const input = caseInput(followup, { document, image: '', previous: { document, message: '上一版建议' } });
  const messages = harness.buildMessages(input);
  assert.equal(messages.at(-1).content, followup.text);
  assert.ok(messages.some((item) => item.role === 'assistant' && item.content === '上一版建议'));
  const summary = summarize([{ contender: 'a', ok: false, skipped: true },
    { contender: 'a', ok: false, duration_ms: 100, calls: 2, input_tokens: 5, output_tokens: 2 }]);
  assert.equal(summary[0].failed, 1);
  assert.equal(summary[0].skipped, 1);
  assert.equal(summary[0].first_pass, 0);
});

test('OpenAI 适配器贯通失败动作定向恢复：两次请求、原话最后、保留正确简历', async () => {
  const scenario = CASES[0];
  const correct = outputFor(scenario);
  const malformed = structuredClone(correct);
  malformed.data_actions = [{ type: 'JOB_SET_CURRENT_PROPOSAL', target_id: null,
    payload: { title: '产品经理', company: '虚构远山科技' } }];
  const repaired = { ...correct, resume_proposal: null, data_actions: [
    { type: 'JOB_SET_CURRENT_PROPOSAL', target_id: null, payload: {
      title: '产品经理', company: '虚构远山科技', confirmed_text: '负责需求调研、产品规划和团队协作。',
    } },
  ] };
  const seen = [];
  const gateway = createModelGateway({ provider: 'deepseek', globalProvider: 'openai',
    openai: { apiKey: 'candidate-test-key', baseUrl: 'https://candidate.example/v1', model: 'gpt-5.5' },
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body));
      const output = seen.length === 1 ? malformed : repaired;
      return { ok: true, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          type: 'response.completed', response: { status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] },
        })}\n\n`));
        controller.close();
      } }) };
    },
  });
  const result = await harness.complete(caseInput(scenario, { document: fictionalDocument(), image: '' }), {
    modelClient: gateway,
  });
  assert.equal(seen.length, 2);
  assert.equal(result.repair_count, 1);
  assert.equal(result.provider, 'openai');
  assert.equal(seen[1].text.format.name, 'resume_assistant_action_repair_v1');
  assert.deepEqual(seen[1].text.format.schema.properties.resume_proposal, { type: 'null' });
  for (const body of seen) {
    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.store, false);
    assert.equal(body.input.at(-1).content, scenario.text);
  }
  const target = result.response.actions.find((item) => item.type === 'RESUME_REWRITE_PROPOSAL').payload.proposal.target_resume_document;
  assert.equal(ResumeDom.plainText(target),
    ResumeDom.plainText(JSON.parse(correct.resume_proposal.target_document_json)));
});
