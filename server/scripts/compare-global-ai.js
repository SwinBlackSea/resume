'use strict';

// Opt-in evaluation. Never import the business server, db, storage, or Codex auth.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createModelGateway } = require('../lib/model-gateway');
const harness = require('../lib/resume-harness');
const { hashJson } = require('../lib/util');
const { loadQAConfig, BASE_URL, MODEL } = require('./openai-qa-config');
const { CASES, fictionalDocument, fixtureImage, caseInput, evaluateCase } = require('./global-ai-cases');

function parseArgs(args) {
  const known = new Set(['--live', '--dry-run', '--rounds']);
  for (let index = 0; index < args.length; index++) {
    if (!known.has(args[index])) throw new Error(`未知参数：${args[index]}`);
    if (args[index] === '--rounds') index++;
  }
  const index = args.indexOf('--rounds');
  const rounds = index === -1 ? 5 : Number(args[index + 1]);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('轮数必须在 1—10 之间');
  if (args.includes('--live') && args.includes('--dry-run')) throw new Error('不能同时使用 --live 和 --dry-run');
  return { rounds, live: args.includes('--live') };
}

function summarize(entries) {
  return [...new Set(entries.map((item) => item.contender))].map((contender) => {
    const rows = entries.filter((item) => item.contender === contender && !item.skipped);
    const sorted = rows.map((item) => item.duration_ms).sort((a, b) => a - b);
    const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
    return { contender, attempted: rows.length,
      passed: rows.filter((item) => item.ok).length,
      first_pass: rows.filter((item) => item.ok && item.calls === 1).length,
      recovered: rows.filter((item) => item.ok && item.calls > 1).length,
      failed: rows.filter((item) => !item.ok).length,
      skipped: entries.filter((item) => item.contender === contender && item.skipped).length,
      p50_ms: percentile(0.5), p95_ms: percentile(0.95),
      input_tokens: rows.reduce((sum, item) => sum + item.input_tokens, 0),
      output_tokens: rows.reduce((sum, item) => sum + item.output_tokens, 0),
    };
  });
}

async function runComparison({ rounds, contenders, onReport = () => {}, signal, timeoutMs = 180000 }) {
  const document = fictionalDocument();
  const originalHash = hashJson(document);
  const image = await fixtureImage();
  const entries = [];
  for (let run = 1; run <= rounds; run++) {
    // Alternate provider order to reduce order/time bias.
    const ordered = run % 2 ? contenders : contenders.slice().reverse();
    const previous = new Map();
    for (const scenario of CASES) {
      for (const contender of ordered) {
        signal?.throwIfAborted();
        const input = caseInput(scenario, {
          document, image, previous: scenario.follows ? previous.get(contender.name) : null, run,
        });
        const start = Date.now();
        const entry = { contender: contender.name, run, case: scenario.id,
          ok: false, calls: 0, input_tokens: 0, output_tokens: 0 };
        if (scenario.follows && !previous.has(contender.name)) {
          entries.push({ ...entry, skipped: true, code: 'PREVIOUS_SUGGESTION_UNAVAILABLE', duration_ms: 0 });
          onReport(entries);
          continue;
        }
        const requestHashes = [];
        const client = { async generate(request) {
          entry.calls++;
          requestHashes.push(hashJson({ messages: request.messages, schema: request.outputSchema,
            capability: request.capability, reasoning_effort: request.reasoningEffort }));
          try {
            const result = await contender.client.generate(request);
            entry.model = result.model;
            entry.route = result.capability;
            entry.input_tokens += Number(result.usage?.input_tokens || result.usage?.prompt_tokens || 0);
            entry.output_tokens += Number(result.usage?.output_tokens || result.usage?.completion_tokens || 0);
            return result;
          } catch (error) {
            entry.input_tokens += Number(error.usage?.input_tokens || error.usage?.prompt_tokens || 0);
            entry.output_tokens += Number(error.usage?.output_tokens || error.usage?.completion_tokens || 0);
            throw error;
          }
        } };
        let fatal;
        try {
          const timeout = AbortSignal.timeout(timeoutMs);
          const result = await harness.complete(input, { modelClient: client,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
          const next = evaluateCase(scenario, result.response, document,
            scenario.follows ? previous.get(contender.name) : null);
          if (scenario.id === 'shorten') previous.set(contender.name, next);
          entry.ok = true;
          entry.repair_count = result.repair_count;
        } catch (error) {
          entry.code = error.code || 'EVALUATION_FAILED';
          entry.http_status = error.status || null;
          // Do not record raw provider output or AssertionError actual/expected.
          entry.issues = (error.validation_diagnostics || []).map(({ code, action_type }) => ({ code, action_type }));
          if (['MODEL_NOT_CONFIGURED', 'MODEL_INVALID_REQUEST'].includes(error.code)
            || [400, 401, 403, 404, 429].includes(error.status)) fatal = error;
        }
        entry.duration_ms = Date.now() - start;
        entry.request_hashes = requestHashes;
        entries.push(entry);
        if (hashJson(document) !== originalHash) throw new Error('测试修改了输入基线，停止比较');
        onReport(entries);
        if (fatal) {
          const error = new Error(`对照测试已停止：${entry.code}${entry.http_status ? ` HTTP ${entry.http_status}` : ''}。请检查配置或网关兼容性，不继续消耗请求。`);
          error.code = 'COMPARISON_STOPPED';
          throw error;
        }
      }
    }
  }
  return { entries, summary: summarize(entries) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify({ mode: options.live ? 'live' : 'dry-run',
    candidate: { model: MODEL, base_url: BASE_URL }, rounds: options.rounds,
    cases: CASES.map((item) => item.id), scenarios: options.rounds * CASES.length * 2,
    max_generation_calls: options.rounds * CASES.length * 2 * 2,
    data: '虚构简历与测试图片，不读取生产数据库',
    note: '同一基线、原始指令、Schema 和 low 推理；连续追问使用各自上一轮结果。无定价假设，只记录用量。',
  }));
  if (!options.live) return;
  // Preflight both credentials before spending any requests.
  const openai = loadQAConfig();
  require('../lib/dotenv').loadEnv();
  if (!(process.env.RESUME_MODEL_API_KEY || process.env.RESUME_LLM_API_KEY)) {
    throw new Error('DeepSeek 基线 Key 未配置，未发起对照请求');
  }
  const effort = process.env.RESUME_GLOBAL_AI_REASONING_EFFORT;
  if (effort && effort !== 'low') throw new Error('对照测试要求统一使用 low 推理强度；当前配置不同，未发起请求');
  const contenders = [
    { name: 'deepseek-baseline', client: createModelGateway({ provider: 'deepseek', globalProvider: 'deepseek' }) },
    { name: 'openai-candidate', client: createModelGateway({ provider: 'deepseek', globalProvider: 'openai', openai }) },
  ];
  const directory = path.resolve(__dirname, '../../.runtime/ai-comparison');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let lastCount = 0;
  console.log(`测试报告：${file}`);
  try {
    const result = await runComparison({ ...options, contenders, signal: controller.signal,
      onReport(entries) {
        fs.writeFileSync(file, JSON.stringify({
          created_at: new Date().toISOString(), rounds: options.rounds,
          configuration: { candidate_model: openai.model, candidate_endpoint: new URL(openai.baseUrl).origin,
            baseline_models: contenders[0].client.models, effort: 'low' },
          entries, summary: summarize(entries),
          limitation: '有限虚构样例；自动断言不等于全面人工质量评估，token 用量不等于实际费用。',
        }, null, 2), { mode: 0o600 });
        if (entries.length !== lastCount) console.log(JSON.stringify(entries.at(-1)));
        lastCount = entries.length;
      },
    });
    console.log(JSON.stringify({ summary: result.summary, report: file }));
    if (result.entries.some((entry) => !entry.ok)) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.code === 'MODEL_INVALID_REQUEST' ? '模型配置无效，未开始对照测试' : error.message);
  process.exitCode = 1;
});

module.exports = { parseArgs, summarize, runComparison };
