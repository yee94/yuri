import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHistoryImportService } from './service.js';
import { digest } from './events.js';
import { createImportStore } from './store.js';
import { createProjectRegistry } from '../projects/registry.js';
import { discoverSources, readSource } from './sources.js';

let directory; let service; let runtime; let records; let client; let read; let registered;
const actor = 'client:one';
const record = (id, parentID) => ({ id, source: 'claude', namespace: 'installation', title: id, directory,
  parentID, hash: digest(id), events: [{ kind: 'user', text: id, time: 1 }], warnings: [] });
const scanAndPreview = async (options = {}) => {
  const scan = await service.scan({}, actor);
  return service.preview({ scanID: scan.id, sessions: [...records.keys()].map((key) => ({ key, directory })), settings: false, ...options }, actor);
};
const wait = async (id) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = service.status(id, actor);
    if (result.state !== 'running') return result;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('fixture job did not settle');
};
const makeService = (overrides = {}) => createHistoryImportService({ dataDir: directory, createClient: () => client, getRuntimeIdentity: () => runtime,
  registerProject: registered, read, detect: async () => ({ claude: true, codex: false, cursor: null, dsh: false }),
  discover: async () => ({ counts: { claude: { value: 87, approximate: true } }, sessions: [...records].map(([key, record]) => ({ ...record, key })), errors: [], descriptors: new Map([...records].map(([key, revision]) => [key, { key, revision }])) }),
  ...overrides,
});
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-import-service-'))); runtime = 'runtime-one';
  records = new Map([['one', record('one')]]); const saved = new Map();
  read = vi.fn(async ({ key }) => structuredClone(records.get(key))); registered = vi.fn(async () => ({}));
  client = { session: {
    list: vi.fn(async () => ({ data: [], cursor: {} })),
    get: vi.fn(async ({ sessionID }) => { if (!saved.has(sessionID)) throw { _tag: 'SessionNotFoundError' }; return saved.get(sessionID); }),
    import: vi.fn(async (input) => { saved.set(input.info.id, input.info); return input.info; }),
    prompt: vi.fn(),
  } };
  service = makeService();
});
afterEach(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });

test('scan returns independent installation evidence without filtering readable history', async () => {
  records.set('codex', { ...record('codex'), source: 'codex' });
  const scan = await service.scan({ includeCounts: true }, actor);
  expect(scan.installations).toEqual({ claude: true, codex: false, cursor: null, dsh: false, opencode: true });
  expect(scan.counts.claude).toEqual({ value: 87, approximate: true });
  expect(scan.sessions.some((session) => session.source === 'codex')).toBe(true);
  expect(client.session.import).not.toHaveBeenCalled();
});

test('a sampled scan cannot be turned into an import plan; full discovery remains required', async () => {
  const sample = await service.scan({ limitPerSource: 5 }, actor);
  expect(sample.sampled).toBe(true);
  await expect(service.preview({ scanID: sample.id, sessions: [{ key: 'one', directory }], settings: false }, actor)).rejects.toThrow('incomplete_scan');
  const full = await service.scan({}, actor);
  expect(full.sampled).toBe(false);
  expect((await service.preview({ scanID: full.id, sessions: [{ key: 'one', directory }], settings: false }, actor)).sessions).toHaveLength(1);
  expect(client.session.import).not.toHaveBeenCalled();
});

test('preview is read-only, apply requires confirmation and never executes historical prompts', async () => {
  const preview = await scanAndPreview();
  expect(client.session.import).not.toHaveBeenCalled(); expect(registered).not.toHaveBeenCalled();
  await expect(service.start({ planID: preview.id }, actor)).rejects.toThrow('confirmation_required');
  const job = await service.start({ planID: preview.id, confirm: true }, actor);
  expect((await wait(job.id)).state).toBe('completed');
  expect(client.session.import).toHaveBeenCalledOnce(); expect(client.session.prompt).not.toHaveBeenCalled();
  expect(registered).toHaveBeenCalledOnce();
});
test('deterministic IDs skip exact reimports even after a service restart and import source changes as new revisions', async () => {
  let preview = await scanAndPreview(); let job = await service.start({ planID: preview.id, confirm: true }, actor); await wait(job.id);
  await service.close(); service = makeService();
  preview = await scanAndPreview(); job = await service.start({ planID: preview.id, confirm: true }, actor);
  const retry = await wait(job.id);
  expect(retry.results[0].status).toBe('skipped'); expect(client.session.import).toHaveBeenCalledOnce();
  records.get('one').hash = digest('revision two'); records.get('one').events.push({ kind: 'user', text: 'next', time: 2 });
  preview = await scanAndPreview(); job = await service.start({ planID: preview.id, confirm: true }, actor); await wait(job.id);
  expect(client.session.import).toHaveBeenCalledTimes(2);
  expect(client.session.import.mock.calls[0][0].info.id).not.toBe(client.session.import.mock.calls[1][0].info.id);
});
test('a conflict with unrelated provenance cannot be mistaken for a successful import', async () => {
  client.session.get.mockResolvedValue({ metadata: { historyImport: { version: 0 } }, location: { directory } });
  const preview = await scanAndPreview(); const job = await service.start({ planID: preview.id, confirm: true }, actor);
  expect((await wait(job.id)).results[0]).toMatchObject({ status: 'failed', code: 'session_conflict' });
  expect(client.session.import).not.toHaveBeenCalled();
});
test('an ambiguous lost response recovers only by exact authoritative metadata', async () => {
  const persist = client.session.import.getMockImplementation();
  client.session.import.mockImplementation(async (...args) => { await persist(...args); throw new Error('connection reset after commit'); });
  const preview = await scanAndPreview(); const job = await service.start({ planID: preview.id, confirm: true }, actor);
  expect((await wait(job.id)).state).toBe('completed');
  expect(client.session.import).toHaveBeenCalledOnce();
});
test('source changes invalidate a preview without blocking an unrelated session', async () => {
  records.set('two', record('two')); const preview = await scanAndPreview(); records.get('one').hash = 'changed';
  const job = await service.start({ planID: preview.id, confirm: true }, actor); const result = await wait(job.id);
  expect(result.state).toBe('partial');
  expect(result.results.map((item) => item.status)).toEqual(['failed', 'imported']);
  expect(result.results[0].code).toBe('source_changed');
});
test('imports parents before children; parent failure blocks only that subtree', async () => {
  records = new Map([['child', record('child', 'parent')], ['parent', record('parent')], ['independent', record('independent')]]);
  const preview = await scanAndPreview(); records.get('parent').hash = 'changed';
  const job = await service.start({ planID: preview.id, confirm: true }, actor); const result = await wait(job.id);
  expect(result.results.map((item) => item.code ?? item.status)).toEqual(['source_changed', 'parent_failed', 'imported']);
});

test('Codex parent cycles after 79 failed entries do not interrupt unrelated conversations', async () => {
  records = new Map([
    ['cyclic', { ...record('cyclic', 'cyclic'), source: 'codex' }],
    ['independent', { ...record('independent'), source: 'codex' }],
  ]);
  await service.close();
  service = makeService({ discover: async () => ({ sessions: [...records].map(([key, record]) => ({ ...record, key })),
    descriptors: new Map([...records.keys()].map((key) => [key, { key }])),
    errors: Array.from({ length: 79 }, () => ({ source: 'codex', code: 'empty_transcript' })),
  }) });
  const job = await service.start({ sources: ['codex'], confirm: true }, actor);
  const result = await wait(job.id);
  expect(result.state).toBe('partial');
  expect(result.completed).toBe(81);
  expect(result.results).toContainEqual(expect.objectContaining({ key: 'independent', status: 'imported' }));
  expect(result.results).toContainEqual(expect.objectContaining({ key: 'cyclic', status: 'failed', code: 'invalid_parent_graph' }));
});

test('a two-session parent cycle fails only that subtree, not an independent conversation', async () => {
  records = new Map([
    ['one', record('one', 'two')], ['two', record('two', 'one')],
    ['child', record('child', 'one')], ['independent', record('independent')],
  ]);
  const plan = await scanAndPreview(); const job = await service.start({ planID: plan.id, confirm: true }, actor);
  const result = await wait(job.id);
  expect(result.state).toBe('partial'); expect(result.completed).toBe(4);
  expect(result.results).toContainEqual(expect.objectContaining({ key: 'independent', status: 'imported' }));
  expect(result.results.filter((item) => item.code === 'invalid_parent_graph')).toHaveLength(2);
  expect(result.results).toContainEqual(expect.objectContaining({ key: 'child', code: 'parent_failed' }));
});

test('explicit merges flatten transcripts without requiring a valid source parent graph', async () => {
  records = new Map([['one', record('one', 'two')], ['two', record('two', 'one')]]);
  const plan = await scanAndPreview({ merge: true }); const job = await service.start({ planID: plan.id, confirm: true }, actor);
  expect((await wait(job.id)).state).toBe('completed');
  expect(client.session.import).toHaveBeenCalledOnce();
  expect(client.session.import.mock.calls[0][0].info.parentID).toBeUndefined();
});

test('Codex project settings are not inspected, so unsafe skills paths cannot affect conversation-only import', async () => {
  const outside = path.join(directory, 'external-skills'); await fs.mkdir(outside);
  await fs.mkdir(path.join(directory, '.agents')); await fs.symlink(outside, path.join(directory, '.agents', 'skills'));
  records = new Map([['one', { ...record('one'), source: 'codex' }], ['two', { ...record('two'), source: 'codex' }]]);
  const job = await service.start({ sources: ['codex'], confirm: true }, actor); const result = await wait(job.id);
  expect(result.state).toBe('completed');
  expect(result.results.filter((item) => item.phase === 'session' && item.status === 'imported')).toHaveLength(2);
  expect(result.results.filter((item) => item.phase === 'settings')).toHaveLength(0);
  expect(client.session.import).toHaveBeenCalledTimes(2);
  expect(await fs.readdir(outside)).toEqual([]);
});

test('real Codex self-parent JSONL passes discovery, planning, native import and safe retry', async () => {
  const source = path.join(directory, 'fixture', 'sessions'); await fs.mkdir(source, { recursive: true });
  for (let index = 0; index < 6; index++) {
    const id = `thread-${index}`;
    await fs.writeFile(path.join(source, `${id}.jsonl`), [
      { type: 'session_meta', payload: { id, cwd: directory, source: { subagent: { thread_spawn: { parent_thread_id: id } } } } },
      { type: 'event_msg', payload: { type: 'user_message', message: `Synthetic history ${index}` } },
    ].map(JSON.stringify).join('\n') + '\n');
  }
  await service.close(); service = makeService({ discover: discoverSources, read: readSource, defaults: [{ source: 'codex', path: source }] });
  for (let attempt = 0; attempt < 2; attempt++) {
    const job = await service.start({ sources: ['codex'], confirm: true }, actor); const result = await wait(job.id);
    expect(result.state).toBe('completed'); expect(result.completed).toBe(6);
    expect(result.results.every((item) => item.status === (attempt ? 'skipped' : 'imported'))).toBe(true);
  }
  expect(client.session.import).toHaveBeenCalledTimes(6);
  for (const [transfer] of client.session.import.mock.calls) {
    expect(transfer.info.parentID).toBeUndefined();
    expect(transfer.messages).toHaveLength(1);
  }
});
test('an unchanged child imported with a revised parent follows the new parent revision', async () => {
  records = new Map([['child', record('child', 'parent')], ['parent', record('parent')]]);
  const firstPlan = await scanAndPreview();
  const firstJob = await service.start({ planID: firstPlan.id, confirm: true }, actor);
  const first = await wait(firstJob.id);
  const firstTransfers = client.session.import.mock.calls.map(([transfer]) => transfer);
  expect(firstTransfers[1].info.parentID).toBe(firstTransfers[0].info.id);
  records.get('parent').hash = digest('parent revision two');
  const nextPlan = await scanAndPreview();
  const nextJob = await service.start({ planID: nextPlan.id, confirm: true }, actor);
  const next = await wait(nextJob.id);
  expect(first.state).toBe('completed'); expect(next.state).toBe('completed');
  const nextTransfers = client.session.import.mock.calls.slice(2).map(([transfer]) => transfer);
  expect(nextTransfers).toHaveLength(2);
  expect(nextTransfers[1].info.id).not.toBe(firstTransfers[1].info.id);
  expect(nextTransfers[1].info.parentID).toBe(nextTransfers[0].info.id);
});
test('combined history creates a new session and does not touch any existing source or target', async () => {
  records.set('two', record('two')); const preview = await scanAndPreview({ merge: true });
  const job = await service.start({ planID: preview.id, confirm: true }, actor); const result = await wait(job.id);
  expect(result.total).toBe(1); expect(result.state).toBe('completed');
  const transfer = client.session.import.mock.calls[0][0];
  expect(transfer.info.metadata.historyImport.mode).toBe('merge');
  expect(transfer.messages.filter((message) => message.type === 'user').map((message) => message.text)).toEqual(['one', 'two']);
});
test('device and runtime changes fence plans and job access', async () => {
  const preview = await scanAndPreview();
  await expect(service.start({ planID: preview.id, confirm: true }, 'client:two')).rejects.toThrow('plan_expired');
  runtime = 'runtime-two';
  await expect(service.start({ planID: preview.id, confirm: true }, actor)).rejects.toThrow('plan_expired');
  expect(client.session.import).not.toHaveBeenCalled();
});
test('cancel stops between items, keeps the current committed result, and a repeated start is idempotent', async () => {
  records.set('two', record('two')); let release;
  const persist = client.session.import.getMockImplementation();
  client.session.import.mockImplementation(async (...args) => { await new Promise((resolve) => { release = resolve; }); return persist(...args); });
  const preview = await scanAndPreview(); const job = await service.start({ planID: preview.id, confirm: true }, actor);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  expect((await service.start({ planID: preview.id, confirm: true }, actor)).id).toBe(job.id);
  service.cancel(job.id, actor); release();
  const result = await wait(job.id);
  expect(result.state).toBe('cancelled'); expect(result.completed).toBe(1);
  expect(client.session.import).toHaveBeenCalledOnce();
});
test('restart marks unfinished jobs interrupted and status payloads stay bounded at scale', () => {
  const file = path.join(directory, 'isolated.sqlite'); const store = createImportStore(file);
  store.create('job', actor, 'runtime', 2000);
  for (let index = 0; index < 2000; index++) store.append('job', index, { key: `${index}`, status: index < 100 ? 'failed' : 'imported' });
  store.close(); const restored = createImportStore(file);
  const status = restored.get('job', actor, 'runtime');
  expect(status.state).toBe('interrupted'); expect(status.completed).toBe(2000);
  expect(status.results.length).toBeLessThanOrEqual(80);
  expect(restored.get('job', 'client:other', 'runtime')).toBeNull();
  restored.close();
});

test('missing directories are planned read-only, then created and registered before verified import', async () => {
  const target = path.join(directory, 'restored', 'project');
  let settings = { projects: [], theme: 'keep' };
  const registry = createProjectRegistry({
    validateDirectoryPath: async (value) => ({ ok: true, directory: await fs.realpath(value) }),
    persistSettings: async (update) => { settings = { ...settings, ...update(settings) }; return settings; },
  });
  await service.close(); service = makeService({ registerProject: registry.register });
  const scan = await service.scan({}, actor);
  const plan = await service.preview({ scanID: scan.id, sessions: [{ key: 'one', directory: target }], settings: true }, actor);
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  const persist = client.session.import.getMockImplementation();
  client.session.import.mockImplementation(async (transfer) => {
    expect(settings.projects.map((project) => project.path)).toContain(target);
    return persist(transfer);
  });
  const job = await service.start({ planID: plan.id, confirm: true }, actor);
  expect((await wait(job.id)).state).toBe('completed');
  expect((await fs.stat(target)).isDirectory()).toBe(true);
  expect(settings.theme).toBe('keep'); expect(settings.projects).toHaveLength(1);
  expect(client.session.get).toHaveBeenCalledTimes(2);
});

test('an acknowledged import without a saved session is not reported as success', async () => {
  client.session.import.mockImplementation(async (transfer) => transfer.info);
  const onImported = vi.fn(); await service.close(); service = makeService({ onImported });
  const plan = await scanAndPreview();
  const job = await service.start({ planID: plan.id, confirm: true }, actor);
  const result = await wait(job.id);
  expect(result.state).toBe('partial'); expect(result.results[0].status).toBe('failed');
  expect(onImported).not.toHaveBeenCalled();
});

test('source jobs return while scanning and continue independently of the caller', async () => {
  let release;
  await service.close(); service = makeService({ discover: () => new Promise((resolve) => { release = resolve; }) });
  const job = await service.start({ sources: ['claude'], directory, confirm: true }, actor);
  expect(job).toMatchObject({ state: 'running', progress: { phase: 'scanning', completed: 0, total: 0 } });
  expect(() => service.dismiss({ id: job.id }, actor)).toThrow('import_busy');
  expect(client.session.import).not.toHaveBeenCalled();
  release({ sessions: [...records].map(([key, record]) => ({ ...record, key })), errors: [], descriptors: new Map([['one', { key: 'one' }]]) });
  const result = await wait(job.id);
  expect(result).toMatchObject({ state: 'completed', completed: 1, total: 1, progress: { phase: 'importing', completed: 1, total: 1 } });
});

test.each(['claude', 'codex', 'cursor', 'dsh'])('source jobs import only conversations, never %s project rules or skills', async (source) => {
  records.set('one', { ...record('one'), source });
  const skillDirectories = { claude: '.claude/skills/example', codex: '.codex/skills/example', cursor: '.cursor/skills/example', dsh: '.dsh/skills/example' };
  const rules = { claude: '.claude/rules/rule.md', codex: 'AGENTS.md', cursor: '.cursorrules', dsh: 'AGENTS.md' };
  const skill = path.join(directory, skillDirectories[source], 'SKILL.md');
  const rule = path.join(directory, rules[source]);
  await fs.mkdir(path.dirname(skill), { recursive: true }); await fs.mkdir(path.dirname(rule), { recursive: true });
  await fs.writeFile(skill, '# Source skill'); await fs.writeFile(rule, '# Source rule');
  const result = await wait((await service.start({ sources: [source], directory, settings: true, confirm: true }, actor)).id);
  expect(result).toMatchObject({ state: 'completed', total: 1, completed: 1 });
  expect(result.results.every((item) => item.phase === 'session')).toBe(true);
  expect(client.session.import).toHaveBeenCalledOnce();
  await expect(fs.stat(path.join(directory, '.opencode'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(skill, 'utf8')).toBe('# Source skill');
  expect(await fs.readFile(rule, 'utf8')).toBe('# Source rule');
});

test('resume treats partial as finished without discarding receipts or starting another attempt', async () => {
  const store = createImportStore(path.join(directory, 'partial-finished.sqlite'));
  store.create('partial', actor, digest(runtime), 1, { sources: ['claude'], directory });
  store.append('partial', 0, { key: 'failed', status: 'failed', code: 'empty_transcript' }); store.finish('partial', 'partial');
  await service.close(); service = makeService({ store });
  expect((await service.resume({ id: 'partial', confirm: true }, actor))).toMatchObject({ state: 'partial', completed: 1, results: [{ code: 'empty_transcript' }] });
  expect(service.jobs(actor)).toEqual([]);
  expect(client.session.import).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

test('dismiss removes only the owned inactive task record from lists, not receipts or imported content', async () => {
  const store = createImportStore(path.join(directory, 'dismiss.sqlite'));
  store.create('failed', actor, digest(runtime), 357);
  store.append('failed', 0, { key: 'saved', status: 'imported', sessionID: 'existing' }); store.finish('failed', 'interrupted');
  await service.close(); service = makeService({ store });
  expect(() => service.dismiss({ id: 'failed' }, 'client:other')).toThrow('job_missing');
  runtime = 'another-runtime'; expect(() => service.dismiss({ id: 'failed' }, actor)).toThrow('job_missing'); runtime = 'runtime-one';
  expect(service.dismiss({ id: 'failed' }, actor)).toEqual({ id: 'failed' });
  expect(service.dismiss({ id: 'failed' }, actor)).toEqual({ id: 'failed' });
  expect(service.jobs(actor)).toEqual([]);
  expect(service.status('failed', actor)).toMatchObject({ dismissed: true, completed: 1, results: [{ sessionID: 'existing' }] });
  await expect(service.resume({ id: 'failed', confirm: true }, actor)).rejects.toThrow('job_dismissed');
  expect(client.session.import).not.toHaveBeenCalled();
});

test('a cancelled source job resumes after restart with its original selection and skips committed sessions', async () => {
  records.set('two', record('two'));
  let release;
  const persist = client.session.import.getMockImplementation();
  client.session.import.mockImplementation(async (transfer) => {
    if (transfer.info.title === 'two') { await new Promise((resolve) => { release = resolve; }); throw new Error('temporarily offline'); }
    return persist(transfer);
  });
  const job = await service.start({ sources: ['claude'], directory, confirm: true }, actor);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  service.cancel(job.id, actor); release();
  expect((await wait(job.id)).state).toBe('cancelled');
  await service.close(); service = makeService();
  expect(service.jobs(actor).map((item) => item.id)).toContain(job.id);
  expect(service.status(job.id, actor).resumable).toBe(true);
  await expect(service.resume({ id: job.id }, actor)).rejects.toThrow('confirmation_required');
  await expect(service.resume({ id: job.id, confirm: true }, 'client:other')).rejects.toThrow('job_missing');
  client.session.import.mockImplementation(persist);
  const resumed = await service.resume({ id: job.id, confirm: true }, actor);
  expect(resumed.id).toBe(job.id);
  expect((await service.resume({ id: job.id, confirm: true }, actor)).id).toBe(job.id);
  const done = await wait(job.id);
  expect(done.state).toBe('completed');
  expect(done.results.map((item) => item.status)).toEqual(['skipped', 'imported']);
  expect(client.session.import).toHaveBeenCalledTimes(3);
  expect(service.jobs(actor)).toEqual([]);
});

test('legacy interrupted jobs never replace a missing original selection with new sources or defaults', async () => {
  const store = createImportStore(path.join(directory, 'legacy.sqlite'));
  store.create('legacy', actor, digest(runtime), 357);
  store.append('legacy', 0, { key: 'one', status: 'imported' }); store.finish('legacy', 'interrupted');
  await service.close(); service = makeService({ store });
  await expect(service.resume({ id: 'legacy', confirm: true }, actor)).rejects.toThrow('resume_request_missing');
  expect(service.status('legacy', actor)).toMatchObject({ state: 'interrupted', completed: 1 });
  expect(client.session.import).not.toHaveBeenCalled();
  await expect(service.resume({ id: 'legacy', confirm: true, sources: ['claude'], directory }, actor)).rejects.toThrow('resume_request_missing');
  expect(service.status('legacy', actor)).toMatchObject({ state: 'interrupted', completed: 1 });
  expect(client.session.import).not.toHaveBeenCalled();
});

test('resume uses only the original saved sources even if a caller supplies a different selection', async () => {
  const store = createImportStore(path.join(directory, 'original-selection.sqlite'));
  store.create('interrupted', actor, digest(runtime), 0, { sources: ['claude'], directory }); store.finish('interrupted', 'interrupted');
  const discover = vi.fn(async () => { throw new Error('offline'); });
  await service.close(); service = makeService({ store, discover });
  await service.resume({ id: 'interrupted', confirm: true, sources: ['codex'], directory: '/other-project' }, actor);
  expect((await wait('interrupted')).state).toBe('partial');
  expect(discover.mock.calls.map(([input]) => input.sources)).toEqual([['claude']]);
});

test('validation and unreadable-source failures retain independent successful imports', async () => {
  const blocked = path.join(directory, 'not-a-directory'); await fs.writeFile(blocked, 'keep');
  records.set('bad', { ...record('bad'), directory: blocked });
  await service.close(); service = makeService({ discover: async () => ({ sessions: [...records].map(([key, record]) => ({ ...record, key })),
    errors: [{ source: 'codex', code: 'invalid_source' }], descriptors: new Map([...records.keys()].map((key) => [key, { key }])) }) });
  const job = await service.start({ sources: ['claude', 'codex'], directory, confirm: true }, actor);
  const result = await wait(job.id);
  expect(result).toMatchObject({ state: 'partial', completed: 3, total: 3 });
  expect(result.results).toEqual(expect.arrayContaining([
    expect.objectContaining({ phase: 'validation', status: 'failed' }),
    expect.objectContaining({ phase: 'scan', code: 'invalid_source' }),
    expect.objectContaining({ phase: 'session', status: 'imported' }),
  ]));
  expect(client.session.import).toHaveBeenCalledOnce();
});

test('cancel during scanning prevents subsequent project creation and imports', async () => {
  let release;
  await service.close(); service = makeService({ discover: () => new Promise((resolve) => { release = resolve; }) });
  const job = await service.start({ sources: ['claude'], directory, confirm: true }, actor);
  service.cancel(job.id, actor);
  release({ sessions: [], errors: [], descriptors: new Map() });
  expect((await wait(job.id)).state).toBe('cancelled');
  expect(registered).not.toHaveBeenCalled(); expect(client.session.import).not.toHaveBeenCalled();
});

test('project registration failure blocks writes to that project, never unrelated projects', async () => {
  const other = path.join(directory, 'other'); await fs.mkdir(other);
  await fs.writeFile(path.join(directory, '.cursorrules'), 'test rules');
  records.set('one', { ...record('one'), source: 'cursor' });
  records.set('other', { ...record('other'), directory: other });
  registered.mockImplementation(async ({ path: value }) => { if (value === directory) throw new Error('cannot persist project'); });
  const job = await service.start({ sources: ['claude', 'cursor'], confirm: true }, actor);
  const result = await wait(job.id);
  expect(result.state).toBe('partial');
  expect(client.session.import).toHaveBeenCalledOnce();
  expect(client.session.import.mock.calls[0][0].location.directory).toBe(other);
  await expect(fs.stat(path.join(directory, '.opencode'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('background validation exposes its own denominator before writes and runtime changes fence it', async () => {
  let release;
  const store = createImportStore(path.join(directory, 'phases.sqlite')); const finish = vi.spyOn(store, 'finish');
  await service.close(); service = makeService({ store });
  read.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const job = await service.start({ sources: ['claude'], confirm: true }, actor);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(service.status(job.id, actor).progress).toEqual({ phase: 'validating', completed: 0, total: 1 });
  runtime = 'runtime-two'; release(record('one'));
  await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(job.id, 'interrupted'));
  runtime = 'runtime-one';
  expect(service.status(job.id, actor).state).toBe('interrupted');
  expect(registered).not.toHaveBeenCalled(); expect(client.session.import).not.toHaveBeenCalled();
});

test('repeated background jobs release temporary scan and plan slots', async () => {
  for (let index = 0; index < 10; index++) {
    const job = await service.start({ sources: ['claude'], confirm: true }, actor);
    expect((await wait(job.id)).state).toBe('completed');
  }
  expect(client.session.import).toHaveBeenCalledOnce();
});

test('sample import badges verify current revision, destination and authority without rereading source bodies', async () => {
  const plan = await scanAndPreview(); const job = await service.start({ planID: plan.id, confirm: true }, actor); await wait(job.id);
  let scan = await service.scan({ sources: ['claude'], limitPerSource: 5 }, actor);
  read.mockClear();
  expect((await service.imported({ scanID: scan.id, directory }, actor)).states.one).toBe('imported');
  expect(read).not.toHaveBeenCalled();
  records.get('one').hash = digest('updated');
  scan = await service.scan({ sources: ['claude'], limitPerSource: 5 }, actor);
  expect((await service.imported({ scanID: scan.id, directory }, actor)).states.one).toBe('available');
  client.session.get.mockRejectedValue(new Error('offline'));
  expect((await service.imported({ scanID: scan.id, directory }, actor)).states.one).toBe('unknown');
  await expect(service.imported({ scanID: scan.id }, 'client:other')).rejects.toThrow('plan_expired');
  runtime = 'another-runtime';
  await expect(service.imported({ scanID: scan.id }, actor)).rejects.toThrow('plan_expired');
});

test('Claude, Codex, Cursor and DeepSeek Harness all receive verified imported states', async () => {
  const sources = ['claude', 'codex', 'cursor', 'dsh'];
  records = new Map(sources.map((source) => [source, { ...record(source), source }]));
  const plan = await scanAndPreview(); const job = await service.start({ planID: plan.id, confirm: true }, actor); await wait(job.id);
  const scan = await service.scan({ sources, limitPerSource: 5 }, actor);
  read.mockClear();
  const result = await service.imported({ scanID: scan.id }, actor);
  expect(result.states).toEqual({ claude: 'imported', codex: 'imported', cursor: 'imported', dsh: 'imported' });
  expect(read).not.toHaveBeenCalled();
});

test('deleted targets and unrelated provenance never retain an imported badge', async () => {
  const plan = await scanAndPreview(); const job = await service.start({ planID: plan.id, confirm: true }, actor); await wait(job.id);
  const scan = await service.scan({ sources: ['claude'], limitPerSource: 5 }, actor);
  const get = client.session.get.getMockImplementation();
  client.session.get.mockImplementation(async (...args) => ({ ...await get(...args), metadata: {} }));
  expect((await service.imported({ scanID: scan.id }, actor)).states.one).toBe('unknown');
  client.session.get.mockRejectedValue({ status: 404 });
  expect((await service.imported({ scanID: scan.id }, actor)).states.one).toBe('available');
});

test('parent revision badges are conservative when ancestors are outside the bounded sample', async () => {
  records = new Map([['child', record('child', 'parent')], ['parent', record('parent')]]);
  const plan = await scanAndPreview(); const job = await service.start({ planID: plan.id, confirm: true }, actor); await wait(job.id);
  let scan = await service.scan({ sources: ['claude'], limitPerSource: 5 }, actor);
  expect((await service.imported({ scanID: scan.id }, actor)).states.child).toBe('imported');
  records.get('parent').hash = digest('new parent');
  scan = await service.scan({ sources: ['claude'], limitPerSource: 5 }, actor);
  expect((await service.imported({ scanID: scan.id }, actor)).states.child).toBe('available');
  records.delete('parent');
  scan = await service.scan({ sources: ['claude'], limitPerSource: 5 }, actor);
  client.session.get.mockClear();
  expect((await service.imported({ scanID: scan.id }, actor)).states.child).toBe('unknown');
  expect(client.session.get).not.toHaveBeenCalled();
});

test('OpenCode histories register original projects and index existing sessions without importing copies', async () => {
  const native = { id: 'ses_native', title: 'Native history', location: { directory }, time: { updated: 12 } };
  client.session.list.mockResolvedValue({ data: [native], cursor: {} });
  client.session.get.mockResolvedValue(native);
  client.message = { list: vi.fn(async () => ({ data: [{ type: 'user', text: 'Native question' }], cursor: {} })) };
  const onImported = vi.fn(); await service.close(); service = makeService({ onImported });
  const scan = await service.scan({ sources: ['opencode'], limitPerSource: 5, includeCounts: true }, actor);
  expect(scan.sessions[0]).toMatchObject({ source: 'opencode', excerpt: 'Native question' });
  expect(scan.counts.opencode).toEqual({ value: 1, approximate: false });
  expect(Object.values((await service.imported({ scanID: scan.id }, actor)).states)).toEqual(['imported']);
  expect(registered).not.toHaveBeenCalled();
  client.message.list.mockClear();
  for (let index = 0; index < 2; index++) {
    const job = await service.start({ sources: ['opencode'], confirm: true }, actor);
    expect((await wait(job.id))).toMatchObject({ state: 'completed', results: [expect.objectContaining({ sessionID: native.id, status: 'skipped' })] });
  }
  expect(client.message.list).not.toHaveBeenCalled();
  expect(client.session.import).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  expect(onImported).toHaveBeenCalledWith(native); expect(registered).toHaveBeenCalledWith({ path: directory });
});

test('badge checks use at most four concurrent authority reads and fence a runtime switch', async () => {
  records = new Map(Array.from({ length: 25 }, (_, index) => [String(index), record(String(index))]));
  const scan = await service.scan({ sources: ['claude'], limitPerSource: 5 }, actor);
  let concurrent = 0; let max = 0;
  client.session.get.mockImplementation(async () => {
    max = Math.max(max, ++concurrent);
    await new Promise((resolve) => setTimeout(resolve, 1)); concurrent--;
    throw { status: 404 };
  });
  const result = await service.imported({ scanID: scan.id }, actor);
  expect(Object.keys(result.states)).toHaveLength(25); expect(max).toBeLessThanOrEqual(4);
  expect(read).not.toHaveBeenCalled(); expect(registered).not.toHaveBeenCalled();
  client.session.get.mockImplementation(async () => { runtime = 'switched'; throw { status: 404 }; });
  await expect(service.imported({ scanID: scan.id }, actor)).rejects.toThrow('runtime_changed');
});

test('combined native and external catalogs keep the shared bound and report overflow independently', async () => {
  records = new Map(Array.from({ length: 5000 }, (_, index) => [String(index), record(String(index))]));
  client.session.list.mockResolvedValue({ data: [{ id: 'ses_native', location: { directory } }], cursor: {} });
  const scan = await service.scan({ sources: ['claude', 'opencode'] }, actor);
  expect(scan.sessions).toHaveLength(5000);
  expect(scan.sessions.every((session) => session.source === 'claude')).toBe(true);
  expect(scan.errors).toContainEqual({ source: 'opencode', code: 'too_many_sessions' });
  expect(registered).not.toHaveBeenCalled();
});
