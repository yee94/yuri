import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeOpenCodeV2Client } from '../../packages/web/server/lib/opencode/v2-client.js';
import { createChatCompletion } from '../../packages/web/server/lib/llm/completions.js';
import { loadConnectedCatalog } from '../../packages/web/server/lib/llm/catalog.js';
import { stopLlmBridgeDirectory } from '../../packages/web/server/lib/llm/bridge-client.js';
import { createAssistantsService } from '../../packages/web/server/lib/assistants/service.js';
import { runContactTurn } from '../../packages/web/server/lib/assistants/harness.js';

// Real inference and production contact orchestration; resource operations stay
// in disposable SQLite/in-memory fixtures and never reach the user's resources.
const registration = JSON.parse(await fs.readFile(path.join(os.homedir(), '.local/state/opencode/service.json'), 'utf8'));
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` };
const sdk = makeOpenCodeV2Client({ baseUrl: registration.url, authHeaders: headers });
const inferenceClient = { ...sdk, session: new Proxy({}, { get() { throw new Error('Real Session APIs are forbidden in card regression'); } }) };
const dependencies = { buildOpenCodeUrl: () => registration.url, getOpenCodeAuthHeaders: () => headers, clientFactory: () => inferenceClient };
const catalog = await loadConnectedCatalog(inferenceClient);
const requested = (process.env.CARD_TEST_MODELS || 'openai/gpt-6.1-sol,magpie-astra/deepseek-v4.1-flash').split(',');
const models = requested.map((ref) => {
  const model = catalog.models.find((item) => `${item.providerID}/${item.modelID}` === ref);
  assert.ok(model, `Requested model is not connected: ${ref}`);
  return model;
});
const cases = [
  { id: 'create-session', text: '在 Regression 项目新建一个编码会话，让它帮我检查发布配置。', operation: 'assign_session', type: 'session' },
  { id: 'continue-session', text: '继续 Regression 项目的 @session:ses_existing 会话，让它把发布检查补完整。', operation: 'assign_session', type: 'session', reused: true },
  { id: 'watch-session', text: '帮我监听 @session:ses_existing 的执行结果，不要给它发新任务。', operation: 'watch_session', type: 'session' },
  { id: 'create-bot', text: '新建一个助理，叫发布助手，模型沿用你的。', operation: 'create_assistant', type: 'assistant' },
  { id: 'create-daily-task', text: '在 Regression 项目创建一个定时任务，叫笔记检查，每天09:00（Asia/Shanghai）检查笔记，把结果告诉我。模型沿用你的。', operation: 'schedule_task', type: 'schedule' },
  { id: 'create-weekly-task', text: '在 Regression 项目安排一个定时任务，叫周报，每周一09:00（Asia/Shanghai）汇总项目进展并告诉我，模型沿用你的。', operation: 'schedule_task', type: 'schedule' },
  { id: 'create-cron-task', text: '在 Regression 项目创建定时任务月报，cron 为 0 9 1 * *，时区 Asia/Shanghai，每月汇总进展并告诉我，模型沿用你的。', operation: 'schedule_task', type: 'schedule' },
  { id: 'update-task', text: '把 Regression 项目的每日检查定时任务改为每天18:00，时区不变，不要重新创建任务。', operation: 'update_scheduled_task', type: 'schedule' },
  { id: 'pause-task', text: '暂停 Regression 项目的每日检查定时任务，不要删除。', operation: 'update_scheduled_task', type: 'schedule' },
  { id: 'lookup-session', text: '帮我找一下 Regression 项目负责发布检查的会话，看看它是做什么的。', operation: 'read_session', type: 'session' },
  { id: 'list-tasks', text: '帮我看一下 Regression 项目的定时任务并列出来。', operation: 'list_scheduled_tasks', type: 'schedule', count: 2 },
  { id: 'no-card', text: '在 Regression 项目新建一个编码会话，让它检查发布配置。这次不用发卡片，只简短回复即可。', operation: 'assign_session', type: 'session', count: 0 },
  { id: 'failed-assignment', text: '在 Regression 项目新建一个编码会话，让它检查发布配置。', operation: 'assign_session', type: 'session', count: 0, failure: true },
];
const selectedCases = process.env.CARD_TEST_CASES?.split(',');
const repetitions = Number(process.env.CARD_TEST_REPEATS || 1);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5);
const results = [];

async function scenario(model, test, repetition) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(process.env.YURI_TEST_TMPDIR || os.tmpdir(), 'yuri-card-regression-')));
  const { providerID, modelID } = model;
  const sessions = new Map([['ses_existing', { id: 'ses_existing', directory, title: '发布配置检查', status: { type: 'busy' }, model: { providerID, id: modelID } }]]);
  const tasks = new Map([
    ['task_daily', { id: 'task_daily', name: '每日检查', enabled: true, schedule: { kind: 'daily', time: '09:00', times: ['09:00'], timezone: 'Asia/Shanghai' }, execution: { prompt: '检查笔记，汇报发现。', providerID, modelID } }],
    ['task_weekly', { id: 'task_weekly', name: '每周汇总', enabled: true, schedule: { kind: 'weekly', time: '09:00', times: ['09:00'], weekdays: [1], timezone: 'Asia/Shanghai' }, execution: { prompt: '汇总发布检查结果。', providerID, modelID } }],
  ]);
  const counts = { creates: 0, prompts: 0, taskCreates: 0, taskUpdates: 0 };
  const proposed = [];
  const executed = [];
  const errors = [];
  let settlement = null;
  let inferenceFailure = null;
  let rounds = 0;
  let service;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  const observeTools = (tools) => tools.map((tool) => ({ ...tool, execute: async (...args) => {
    executed.push(tool.name);
    const result = await tool.execute(...args);
    if (result?.isError || result?.details?.error) errors.push({
      tool: tool.name, code: result.details?.error || 'tool_failed',
      ...(tool.name === 'reference_resource' ? { argumentKeys: Object.keys(args[1] || {}), nullKeys: Object.keys(args[1] || {}).filter((key) => args[1][key] === null), cardType: args[1]?.cardType } : {}),
    });
    return result;
  } }));
  try {
    const domainClient = {
      provider: sdk.provider, model: sdk.model,
      session: {
        create: async (input) => {
          counts.creates++;
          if (test.failure) throw new Error('Fixture worker creation unavailable');
          const session = { id: `ses_created_${counts.creates}`, directory, title: input.title || '发布检查', status: { type: 'busy' }, model: { providerID, id: modelID } };
          sessions.set(session.id, session);
          return session;
        },
        prompt: async ({ sessionID }) => { assert.ok(sessions.has(sessionID)); counts.prompts++; return { id: 'inbox_fixture', type: 'user' }; },
        get: async ({ sessionID }) => { assert.ok(sessions.has(sessionID), 'Unknown fixture session'); return sessions.get(sessionID); },
        active: async () => Object.fromEntries([...sessions.keys()].map((id) => [id, { id, directory }])),
        switchModel: async () => {}, switchAgent: async () => {},
      },
      message: { list: async ({ sessionID }) => ({ data: [{ info: { id: 'msg_fixture', sessionID, role: 'assistant' }, parts: [{ type: 'text', text: '正在核对发布配置、签名设置与更新渠道，尚未完成。' }] }], cursor: {} }) },
    };
    service = createAssistantsService({
      dataDir: directory, dbPath: path.join(directory, 'assistants.sqlite'),
      buildOpenCodeUrl: () => 'http://fixture.invalid', getOpenCodeAuthHeaders: () => ({}), clientFactory: () => domainClient,
      getAllowedRoots: () => [directory], listProjects: async () => [{ id: 'project', path: directory, label: 'Regression' }],
      sessionIndexService: { snapshot: () => ({ directories: [{ directory, sessions: [...sessions.values()] }] }) },
      listScheduledTasks: async () => [...tasks.values()],
      upsertScheduledTask: async (_projectID, input) => { counts.taskCreates++; const task = { ...input, id: `task_created_${counts.taskCreates}` }; tasks.set(task.id, task); return { task }; },
      patchScheduledTask: async (_projectID, id, patch) => {
        assert.ok(tasks.has(id), 'Unknown fixture task');
        counts.taskUpdates++;
        const prior = tasks.get(id);
        const task = { ...prior, ...patch, schedule: { ...prior.schedule, ...patch.schedule }, execution: { ...prior.execution, ...patch.execution } };
        tasks.set(id, task); return { task };
      },
      syncScheduledTaskProject: async () => {},
      readModelPreferences: async () => ({ favoriteModels: [], recentModels: [] }),
      runContactTurn: (input) => runContactTurn({ ...input, signal: AbortSignal.any([input.signal, controller.signal]), skillHomeDir: directory, tools: observeTools(input.tools) }),
      createChatCompletion: async (input) => {
        rounds++;
        assert.ok(rounds <= 18, 'Regression model-round limit exceeded');
        let result;
        try {
          result = await createChatCompletion({ ...input, ...dependencies, timeoutMs: 90_000 });
        } catch (error) {
          inferenceFailure = { code: error.code || 'unknown', ...(error.providerFailure ? { providerFailure: error.providerFailure } : {}) };
          throw error;
        }
        for (const call of result.completion.choices[0].message.tool_calls || []) proposed.push(call.function.name);
        return result;
      },
    });
    const host = service.createAssistant({ name: 'Regression Bot', providerID, modelID, workspacePath: directory });
    const admitted = await service.send(host.id, { messageID: `regression_${randomUUID()}`, text: test.text, language: 'zh-CN' });
    settlement = await service.whenContactTurnSettled(admitted.messageID);
    assert.equal(settlement.status, 'complete', `Contact ended with ${settlement.status}`);
    const page = service.contactMessages(host.id, { limit: 50 });
    const published = page.messages.flatMap((message) => message.cards);
    const expectedCount = test.count ?? 1;
    assert.ok(executed.includes(test.operation), `Expected ${test.operation} was not executed`);
    assert.equal(published.length, expectedCount, 'Expected resource card count');
    assert.ok(published.every((card) => card.cardType === test.type), 'Unexpected card type');
    assert.equal(executed.filter((name) => name === 'reference_resource').length, expectedCount, 'Cards must be explicit and not duplicated');
    assert.ok(counts.creates <= 1 && counts.prompts <= 1 && counts.taskCreates <= 1 && counts.taskUpdates <= 1, 'Duplicate side effect');
    if (test.reused) assert.equal(counts.creates, 0, 'Continuation must reuse its worker');
    if (test.operation === 'watch_session' || test.operation === 'read_session' || test.operation === 'list_scheduled_tasks') assert.equal(counts.prompts, 0, 'Lookup/watch must not prompt workers');
    if (test.operation === 'list_scheduled_tasks') assert.equal(counts.taskCreates + counts.taskUpdates, 0, 'Lookup must not mutate tasks');
    if (test.id === 'pause-task') assert.equal(tasks.get('task_daily').enabled, false);
    if (test.id === 'update-task') assert.ok(tasks.get('task_daily').schedule.time === '18:00' || tasks.get('task_daily').schedule.times?.includes('18:00'));
    if (!test.failure) assert.deepEqual(errors, [], 'Unexpected tool failure');
    const result = { scenario: test.id, repetition, providerID, modelID, passed: true, rounds, proposed, executed, cards: published.map((card) => card.cardType), ...counts, elapsedMs: Date.now() - start };
    results.push(result); console.log(JSON.stringify(result));
  } catch (error) {
    const result = { scenario: test.id, repetition, providerID, modelID, passed: false, reason: error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : error.code || error.name, settlementCode: settlement?.code || null, inferenceFailure, rounds, proposed, executed, errors, ...counts, elapsedMs: Date.now() - start };
    results.push(result); console.log(JSON.stringify(result));
    process.exitCode = 1;
  } finally {
    clearTimeout(timer); controller.abort(); service?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

try {
  // Independent models run concurrently; each model's scenarios remain sequential.
  await Promise.all(models.map(async (model) => {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const test of cases.filter((test) => !selectedCases || selectedCases.includes(test.id))) await scenario(model, test, repetition);
    }
  }));
  const report = { passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length, results };
  if (process.env.CARD_TEST_REPORT) await fs.writeFile(process.env.CARD_TEST_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ summary: true, passed: report.passed, failed: report.failed, realInference: true, isolatedResources: true }));
} finally { await stopLlmBridgeDirectory(); }
