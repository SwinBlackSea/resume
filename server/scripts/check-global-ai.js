'use strict';

// Opt-in live, read-only smoke test. No server/db import, writes, actions,
// persistent model payloads, or production conversation mutations.
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../lib/dotenv').loadEnv();
const ResumeDom = require('../../resume-dom');
const harness = require('../lib/resume-harness');
const { createModelGateway } = require('../lib/model-gateway');
const { evaluateChange } = require('../lib/resume-change-policy');
const { hashJson } = require('../lib/util');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--effort')) {
    process.env.RESUME_GLOBAL_AI_REASONING_EFFORT = args[args.indexOf('--effort') + 1];
  }
  const taskId = args[args.indexOf('--task') + 1];
  if (!args.includes('--live') || !args.includes('--task') || !taskId) {
    throw new Error('显式启用真实模型调用：node server/scripts/check-global-ai.js --live --task <已有任务ID>');
  }
  const database = new DatabaseSync(
    process.env.RESUME_DB_PATH || path.resolve(__dirname, '../../data/resume.db'),
    { readOnly: true },
  );
  const task = database.prepare('SELECT * FROM ai_tasks WHERE id = ?').get(taskId);
  if (!task || task.scope_type !== 'RESUME_DOCUMENT') throw new Error('需要现有的全局简历任务');
  const project = database.prepare('SELECT * FROM resume_projects WHERE id = ?').get(task.project_id);
  const draft = database.prepare('SELECT * FROM resume_drafts WHERE project_id = ?').get(task.project_id);
  const profile = database.prepare('SELECT * FROM profiles WHERE id = ?').get(project.current_profile_id);
  const job = project.current_job_id
    ? database.prepare('SELECT * FROM target_jobs WHERE id = ?').get(project.current_job_id) : null;
  const experiences = database.prepare(
    'SELECT * FROM experiences WHERE profile_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at',
  ).all(profile.id).map((item) => ({
    id: item.id, type: item.type, organization: item.organization, title: item.title,
    start_date: item.start_date, end_date: item.end_date, is_current: Boolean(item.is_current),
    description: item.description, revision: item.revision,
  }));
  const history = database.prepare(
    'SELECT * FROM ai_messages WHERE task_id = ? ORDER BY created_at, id',
  ).all(task.id).filter((row) => JSON.parse(row.model_metadata_json || '{}').result_type !== 'ERROR');
  const lastUser = history.findLast((row) => row.role === 'user');
  if (!lastUser) throw new Error('任务没有原始用户要求');
  const original = ResumeDom.toResumeDocument(JSON.parse(draft.resume_json));
  const beforeHash = hashJson(original);
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;
  const gateway = createModelGateway({
    complexModel: model,
    ...(args.includes('--wire-trace') ? { fetchImpl: async (...request) => {
      const response = await fetch(...request);
      if (response.ok && args.includes('--wire-trace')) {
        const { consumeResponsesStream } = require('../lib/model-client');
        const copy = response.clone();
        consumeResponsesStream(copy.body, { idleMs: 30000 }).then((stream) => {
          try { JSON.parse(stream.content); } catch (error) {
            console.log(JSON.stringify({ wire_json_error: error.message.replace(/"[^"]*"/g, '"…"'),
              length: stream.content.length,
              starts_json: stream.content.trim().startsWith('{'),
              ends_json: stream.content.trim().endsWith('}'),
              // Structural diagnostic only; no raw resume or model output log.
              punctuation: stream.content.slice(0, 120).replace(/[^{}\[\]"\\,:]/g, '.'),
            }));
          }
        }).catch((error) => console.log(JSON.stringify({ wire_error: error.code || error.name })));
      }
      return response;
    } } : {}),
  });
  const results = [];
  let direct = null;
  let previousMessage = null;
  let previousInstruction = null;
  const cases = [
    { name: 'replay', text: lastUser.content, history: history.filter((row) => row.id !== lastUser.id),
      state: JSON.parse(task.state_json || '{}'), goal: task.goal },
    { name: 'direct', text: task.goal, history: [], state: {}, goal: task.goal },
    { name: 'dedupe', text: '查看是否有重复项，有的话去重优化精简。',
      history: [], state: {}, goal: '去重优化整份简历' },
    { name: 'followup', text: '还是太多了，继续精简。',
      history: [], state: {}, goal: task.goal },
    { name: 'style', text: '把整份简历的模块标题改成深蓝色 #17365D，并增大到18px，正文文字和内容结构保持不变。',
      history: [], state: {}, goal: '统一模块标题样式' },
  ];
  for (const scenario of cases) {
    const selectedCase = args.includes('--case') ? args[args.indexOf('--case') + 1] : null;
    if (selectedCase && selectedCase !== scenario.name) continue;
    const started = Date.now();
    let calls = 0;
    const client = {
      generate: async (request) => {
        calls += 1;
        let result;
        try { result = await gateway.generate(request); } catch (error) {
          if (args.includes('--trace')) console.log(JSON.stringify({
            case: scenario.name, attempt: calls, code: error.code,
            finish_reason: error.finish_reason, content_length: error.content_length,
            max_tokens: request.maxTokens,
          }));
          throw error;
        }
        if (args.includes('--trace')) {
          try {
            const { decodeGlobalStructuredOutput } = require('../lib/resume-harness/structured-envelope');
            const { normalizeModelOutput } = require('../lib/resume-harness/output-schema');
            const { validateExecutableResponse } = require('../lib/resume-harness/executable-validator');
            const response = normalizeModelOutput(
              decodeGlobalStructuredOutput(structuredClone(result.output)), request.input.scope,
            );
            const errors = validateExecutableResponse(response, request.input);
            const base = request.input.workspace.resume.proposal_content || request.input.workspace.resume.content;
            const target = response.actions[0]?.payload?.proposal?.target_resume_document;
            const structure = target ? ResumeDom.compareDocuments(base, target).changes
              .filter((change) => ['structure', 'added', 'removed', 'moved'].includes(change.type))
              .map((change) => ({ type: change.type, id: change.node_id,
                before_semantic: ResumeDom.findNode(base, change.node_id)?.node.semantic,
                after_semantic: ResumeDom.findNode(target, change.node_id)?.node.semantic })) : [];
            console.log(JSON.stringify({ case: scenario.name, attempt: calls, type: response.result_type,
              errors, structure, constraints: response.actions.map((action) => action.payload?.proposal?.change_constraints) }));
          } catch (error) {
            console.log(JSON.stringify({ case: scenario.name, attempt: calls, decode_error: error.message,
              envelope_keys: Object.keys(result.output || {}),
              replacement_types: result.output?.resume_proposal?.changes?.map((change) => ({
                id: change.target_id, type: typeof change.replacement_json,
                is_null_string: typeof change.replacement_json === 'string'
                  && change.replacement_json.trim() === 'null',
              })),
            }));
          }
        }
        return result;
      },
    };
    const previous = scenario.name === 'followup' ? direct : null;
    const input = harness.buildHarnessInput({
      text: scenario.text,
      messageId: `smoke-${scenario.name}`,
      scope: { type: 'RESUME_DOCUMENT', id: null, revision: draft.revision },
      task: { id: `smoke-${scenario.name}`, goal: scenario.goal, state: scenario.state },
      resume: {
        revision: draft.revision, content: original, content_hash: beforeHash,
        task_base_content: original, task_base_hash: beforeHash,
        ...(previous ? { proposal_content: previous, previous_proposal_id: 'smoke-direct' } : {}),
      },
      profile: { id: profile.id, basics: JSON.parse(profile.basics_json), revision: profile.revision,
        summary: profile.summary, experiences },
      job: job ? { id: job.id, title: job.title, company: job.company,
        confirmed_text: job.confirmed_text, revision: job.revision } : null,
      conversationMessages: previous ? [
        { role: 'user', content: previousInstruction },
        { role: 'assistant', content: previousMessage },
      ] : scenario.history,
    });
    try {
      if (scenario.name === 'followup' && !previous) throw new Error('上一项未形成建议，无法验证继续调整');
      const result = await harness.complete(input, { modelClient: client });
      const action = result.response.actions.find((item) => item.type === 'RESUME_REWRITE_PROPOSAL');
      if (!action) throw new Error(`未直接形成建议：${JSON.stringify({
        type: result.response.result_type, message_kind: result.response.message_kind,
        content: result.response.content, quick_replies: result.response.quick_replies,
      })}`);
      const proposal = action.payload.proposal;
      const comparison = evaluateChange(previous || original,
        proposal.target_resume_document, proposal.change_constraints);
      if (scenario.name === 'direct' || (scenario.name === 'dedupe' && !direct)) {
        direct = proposal.target_resume_document;
        previousMessage = result.response.content;
        previousInstruction = scenario.text;
      }
      const entry = {
        case: scenario.name, ok: true, calls, duration_ms: Date.now() - started,
        model: result.model, repair_count: result.repair_count,
        counts: comparison.comparison.counts,
        before_text_characters: ResumeDom.nodeText((previous || original).root).length,
        after_text_characters: ResumeDom.nodeText(proposal.target_resume_document.root).length,
      };
      // Intent-specific assertions belong in this test, never in server routing
      // or user prompt rewriting. Executable JSON alone is not semantic success.
      if (scenario.name === 'followup'
        && entry.after_text_characters >= entry.before_text_characters) {
        throw new Error('继续精简未减少正文长度（测试期望，不是服务端需求规则）');
      }
      results.push(entry);
      console.log(JSON.stringify(entry));
    } catch (error) {
      const entry = { case: scenario.name, ok: false, calls, duration_ms: Date.now() - started,
        code: error.code || 'SMOKE_FAILED', diagnostics: error.validation_diagnostics || [],
        errors: error.validation_errors || [error.message] };
      results.push(entry);
      console.log(JSON.stringify(entry));
    }
  }
  const current = database.prepare('SELECT resume_json FROM resume_drafts WHERE project_id = ?').get(task.project_id);
  database.close();
  console.log(JSON.stringify({
    passed: results.filter((result) => result.ok).length,
    total: results.length, draft_unchanged: hashJson(ResumeDom.toResumeDocument(JSON.parse(current.resume_json))) === beforeHash,
  }));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
