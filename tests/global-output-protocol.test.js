'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ResumeDom = require('../resume-dom');
const { decodeGlobalStructuredOutput } = require('../server/lib/resume-harness/structured-envelope');
const { normalizeModelOutput } = require('../server/lib/resume-harness/output-schema');
const { validateExecutableResponse } = require('../server/lib/resume-harness/executable-validator');
const { buildHarnessInput, buildMessages, materializeTargetFragments } = require('../server/lib/resume-harness');
const { configuredModels } = require('../server/lib/model-client');

const constraints = {
  content: 'modify', structure: 'modify', style: 'preserve',
  content_order: 'preserve', allowed_region_ids: ['root'],
};
function envelope(resume = null, data = []) {
  return {
    type: resume || data.length ? 'proposal' : 'message',
    content: '建议已准备好。', awaiting_user: false, message_kind: null,
    quick_replies: [], resume_proposal: resume, data_actions: data,
  };
}
function document() {
  return ResumeDom.toResumeDocument({ schema_version: 'resume-document-v3',
    root: { id: 'root', type: 'element', tag: 'article', children: [
      { id: 'paragraph', type: 'element', tag: 'p', editable: true, children: [
        { id: 'run-1', type: 'element', tag: 'strong', text: '保留格式：' },
        { id: 'run-2', type: 'element', tag: 'span', text: '冗长内容' },
      ] },
      { id: 'junk', type: 'element', tag: 'p', editable: true, text: '无效内容' },
    ] },
  });
}
function resumeProposal() {
  return {
    changes: [{ target_id: 'paragraph', replacement_json: JSON.stringify({ id: 'paragraph', text: '精简建议' }) }],
    insertions: [], target_document_json: null, change_constraints: constraints,
  };
}

test('全局输出直接结构化修改列表和约束，不再整体双重序列化', () => {
  const raw = envelope(resumeProposal());
  const decoded = decodeGlobalStructuredOutput(raw, { requireEnvelope: true });
  assert.deepEqual(decoded.proposal.target_resume_fragments.changes, [{
    target_id: 'paragraph', replacement_subtree: { id: 'paragraph', text: '精简建议' },
  }]);
  assert.equal(Object.hasOwn(raw, 'payload_json'), false);
  assert.equal(decodeGlobalStructuredOutput(envelope()).type, 'message');
});

test('结构化输出兼容删除、任意层级新增和独立资料动作', () => {
  const resume = resumeProposal();
  resume.changes.push({ target_id: 'junk', replacement_json: null });
  resume.insertions.push({ parent_id: 'root', after_id: 'paragraph', new_nodes_json: [
    JSON.stringify({ id: 'new-section', type: 'element', tag: 'section', children: [
      { id: 'new-paragraph', type: 'element', tag: 'p', editable: true, text: '新增内容' },
    ] }),
  ] });
  const decoded = decodeGlobalStructuredOutput(envelope(resume, [{
    type: 'PROFILE_SAVE_PROPOSAL', target_type: 'profile_basics', target_id: null,
    payload_json: JSON.stringify({ operation: 'update_basics', values: { city: '上海' } }),
  }]));
  const input = buildHarnessInput({
    text: '修改简历并单独保存资料', scope: { type: 'RESUME_DOCUMENT', id: null },
    resume: { content: document() }, task: { id: 'unit' },
  });
  const response = normalizeModelOutput(decoded, input.scope);
  assert.deepEqual(validateExecutableResponse(response, input), []);
  const target = response.actions[1].payload.proposal.target_resume_document;
  assert.equal(ResumeDom.findNode(target, 'junk'), null);
  assert.ok(ResumeDom.findNode(target, 'new-paragraph'));
  assert.equal(response.actions[0].payload.values.city, '上海');
});

test('整份文档元数据修改仍受支持，不能与片段双写', () => {
  const resume = resumeProposal();
  resume.changes = [];
  resume.target_document_json = JSON.stringify(document());
  const decoded = decodeGlobalStructuredOutput(envelope(resume));
  assert.equal(decoded.proposal.target_resume_document.root.id, 'root');
  resume.changes = resumeProposal().changes;
  assert.throws(() => decodeGlobalStructuredOutput(envelope(resume)), /不能与片段同时返回/);
});

test('严格结构化输出拒绝损坏节点、未知字段、非法约束和 message 夹带动作', () => {
  const broken = resumeProposal();
  broken.changes[0].replacement_json = '{"id":"paragraph","text":"截断';
  assert.throws(() => decodeGlobalStructuredOutput(envelope(broken)), /完整 JSON/);
  const unknown = envelope(resumeProposal());
  unknown.extra = '多余字段';
  assert.throws(() => decodeGlobalStructuredOutput(unknown), /严格协议/);
  const wrong = resumeProposal();
  wrong.change_constraints = { ...constraints, structure: 'ignore' };
  assert.throws(() => decodeGlobalStructuredOutput(envelope(wrong)), /修改约束值无效/);
  const message = envelope(resumeProposal());
  message.type = 'message';
  assert.throws(() => decodeGlobalStructuredOutput(message), /不能携带修改动作/);
});

test('节点JSON字符串中的null仅归一化为明确删除，不接受其他基本类型或损坏节点', () => {
  const resume = resumeProposal();
  resume.changes = [{ target_id: 'junk', replacement_json: ' null ' }];
  assert.equal(decodeGlobalStructuredOutput(envelope(resume))
    .proposal.target_resume_fragments.changes[0].replacement_subtree, null);
  for (const value of ['false', '0', '""', '[]', 'null,', '{"id":"junk"']) {
    resume.changes[0].replacement_json = value;
    assert.throws(() => decodeGlobalStructuredOutput(envelope(resume)), /完整 JSON/);
  }
});

test('真实 editable 富文本段落是最小编辑单元，不强迫模型操作内部格式节点', () => {
  const before = document();
  const paragraph = structuredClone(ResumeDom.findNode(before, 'paragraph').node);
  paragraph.children[1].text = '更短';
  const result = materializeTargetFragments(before, {
    format: 'resume-target-fragments-v2',
    changes: [{ target_id: paragraph.id, replacement_subtree: paragraph }],
  });
  assert.equal(ResumeDom.findNode(result.document, 'run-1').node.tag, 'strong');
  assert.match(ResumeDom.nodeText(result.document.root), /保留格式：更短/);
  paragraph.children[1].editable = true;
  assert.throws(() => materializeTargetFragments(before, {
    format: 'resume-target-fragments-v2',
    changes: [{ target_id: paragraph.id, replacement_subtree: paragraph }],
  }), /editable|编辑/);
});

test('继续调整的唯一操作文档是 B，A/C 仅作为只读参考，重复删除已不存在的已知节点可幂等归一化', () => {
  const base = document();
  const target = materializeTargetFragments(base, {
    changes: [{ target_id: 'junk', replacement_subtree: null }],
  }).document;
  const input = buildHarnessInput({
    text: '继续精简', scope: { type: 'RESUME_DOCUMENT', id: null },
    resume: { content: base, proposal_content: target, task_base_content: base },
    task: { id: 'unit', state: { pending_plan: { structure: 'preserve' }, active_run_id: 'internal-run' } },
  });
  const contextText = buildMessages(input)[1].content;
  const context = JSON.parse(contextText.slice(contextText.indexOf('{"protocol"')));
  assert.equal(context.scope.type, 'RESUME_DOCUMENT');
  assert.equal(context.workspace.resume.editing_document_role, 'previous_target_document');
  assert.equal(ResumeDom.findNode(context.workspace.resume.editing_document, 'junk'), null);
  assert.ok(ResumeDom.findNode(context.workspace.resume.current_draft_reference, 'junk'));
  assert.doesNotMatch(contextText, /pending_plan|active_run_id/);
  const resume = resumeProposal();
  resume.changes.push({ target_id: 'junk', replacement_json: null });
  const response = normalizeModelOutput(decodeGlobalStructuredOutput(envelope(resume)), input.scope);
  assert.deepEqual(validateExecutableResponse(response, input), []);
  assert.equal(response.actions[0].payload.proposal.target_resume_fragments.changes.length, 1);
  const unknown = resumeProposal();
  unknown.changes.push({ target_id: 'never-existed', replacement_json: null });
  assert.ok(validateExecutableResponse(
    normalizeModelOutput(decodeGlobalStructuredOutput(envelope(unknown)), input.scope), input,
  ).length);
});

test('默认局部 Flash、全局 Pro，complex 能力仍可通过配置切换型号', () => {
  const previous = { text: process.env.RESUME_MODEL_TEXT_MODEL, complex: process.env.RESUME_MODEL_COMPLEX_MODEL };
  delete process.env.RESUME_MODEL_TEXT_MODEL;
  delete process.env.RESUME_MODEL_COMPLEX_MODEL;
  try {
    assert.equal(configuredModels().text, 'deepseek-v4-flash');
    assert.equal(configuredModels().complex, 'deepseek-v4-pro');
    assert.equal(configuredModels({ complexModel: 'deepseek-v4-flash' }).complex, 'deepseek-v4-flash');
  } finally {
    for (const [key, value] of Object.entries({
      RESUME_MODEL_TEXT_MODEL: previous.text, RESUME_MODEL_COMPLEX_MODEL: previous.complex,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
