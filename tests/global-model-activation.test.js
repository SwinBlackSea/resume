'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { saveQAKey } = require('../server/scripts/openai-qa-config');
const { activateGlobalOpenAI } = require('../server/scripts/activate-global-openai');
const { configuredRouting, createModelClient } = require('../server/lib/model-client');

test('激活 Astra 仅替换全局配置，保留局部及其他配置并保存私有备份', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-activation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, '.env');
  const configFile = path.join(dir, '.env.qa');
  const original = '# existing\nRESUME_LLM_PROVIDER=deepseek\nRESUME_MODEL_API_KEY=local-test-key\nRESUME_MODEL_TEXT_MODEL=deepseek-v4-flash\nPORT=8787\nRESUME_GLOBAL_MODEL_PROVIDER=deepseek\nRESUME_GLOBAL_MODEL_PROVIDER=deepseek\n';
  fs.writeFileSync(envFile, original);
  saveQAKey('candidate-test-key', configFile);
  const result = activateGlobalOpenAI({ envFile, configFile, backupDir: path.join(dir, 'backups') });
  const updated = fs.readFileSync(envFile, 'utf8');
  const env = parseEnv(updated);
  assert.equal(env.RESUME_GLOBAL_MODEL_PROVIDER, 'openai');
  assert.equal(env.RESUME_OPENAI_MODEL, 'gpt-6-astra');
  assert.equal(env.RESUME_OPENAI_MIN_REASONING_EFFORT, 'low');
  assert.equal(env.RESUME_OPENAI_API_KEY, 'candidate-test-key');
  for (const key of ['RESUME_LLM_PROVIDER', 'RESUME_MODEL_API_KEY', 'RESUME_MODEL_TEXT_MODEL', 'PORT']) {
    assert.equal(env[key], parseEnv(original)[key]);
  }
  assert.equal(updated.match(/RESUME_GLOBAL_MODEL_PROVIDER=/g).length, 1);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), original);
  for (const file of [envFile, result.backup]) assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.doesNotMatch(JSON.stringify(result), /candidate-test-key|local-test-key/);
  const localResult = activateGlobalOpenAI({ envFile, configFile, backupDir: path.join(dir, 'backups'), includeLocal: true });
  const withLocal = parseEnv(fs.readFileSync(envFile, 'utf8'));
  assert.equal(withLocal.RESUME_MODEL_PROVIDER, 'openai');
  assert.equal(localResult.local, 'openai');
  assert.equal(withLocal.RESUME_MODEL_API_KEY, 'local-test-key', '保留旧供应商凭据，不覆盖无关设置');
});

test('显式启用 Astra 局部路由时，text/complex/vision 使用同一型号与独立凭据', () => {
  const options = { provider: 'openai', globalProvider: 'openai',
    openai: { model: 'gpt-6-astra', apiKey: 'candidate-test-key' } };
  const client = createModelClient(options);
  assert.deepEqual(client.providers, { text: 'openai', complex: 'openai', vision: 'openai' });
  assert.deepEqual(client.models, { text: 'gpt-6-astra', complex: 'gpt-6-astra', vision: 'gpt-6-astra' });
});

test('启动日志路由与实际客户端一致：Astra 同时接管 complex/vision，不改变 text', () => {
  const options = { provider: 'deepseek', globalProvider: 'openai',
    textModel: 'deepseek-v4-flash', apiKey: 'local-test-key',
    openai: { model: 'gpt-6-astra', apiKey: 'candidate-test-key' } };
  const routing = configuredRouting(options);
  const client = createModelClient(options);
  assert.deepEqual(routing.models, {
    text: 'deepseek-v4-flash', complex: 'gpt-6-astra', vision: 'gpt-6-astra',
  });
  assert.deepEqual(routing.models, client.models);
  assert.deepEqual(routing.providers, { text: 'deepseek', complex: 'openai', vision: 'openai' });
});
