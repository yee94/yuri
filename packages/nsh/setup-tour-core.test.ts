import { describe, expect, it } from 'vitest';
import { createSetupTour, setupTourHasPlugin, setupTourPlugins, setupTourSteps } from './setup-tour-core';
import { createSetupTourDoubao } from './setup-tour-voice';
import { createSetupTourTestHost, setupTourTestScope } from './setup-tour-test-host';
import type { SettingsRequest } from './settings-protocol';

function fixture(options: Parameters<typeof createSetupTourTestHost>[0] = {}) {
  const host = createSetupTourTestHost(options);
  const send: SettingsRequest = async (path, method = 'GET', body) => {
    const result = host.call('runtime.request', { path, method, expectedHost: setupTourTestScope, ...(body === undefined ? {} : { body }) }) as { status: number; body: unknown };
    if (result.status >= 300) throw Object.assign(new Error('scripted-http-failure'), { status: result.status });
    return result.body;
  };
  let current = true;
  const moves: string[] = [], closes: string[] = [];
  const tour = createSetupTour({ send, directory: options.directory ?? '/fixture/tour', current: () => current, onMove: step => moves.push(step), onClose: () => closes.push('closed') });
  tour.activate(true);
  return { host, send, tour, moves, closes, retire: () => { current = false; } };
}

describe('native Tour production controller (in-memory dependencies only)', () => {
  it('operation-only replacement preserves step/provider/plugin selection and reconciles an ACK without a new write', async () => {
    const f = fixture({ allowedPlugins: [setupTourPlugins[0]], failListAfterWrite: 1 }); f.tour.togglePlugin(setupTourPlugins[1]); await f.tour.proceed();
    const selection = f.tour.snapshot().selected, calls: string[] = [];
    await f.tour.replaceLane({ current: () => true, send: async (path, method, body) => { calls.push(method ?? 'GET'); return f.send(path, method, body); } });
    expect(f.tour.snapshot().selected).toBe(selection); expect(f.tour.snapshot().step).toBe('models'); expect(calls.every(method => method === 'GET')).toBe(true);
    await f.tour.proceed(); expect(f.host.audit().writes).toEqual([setupTourPlugins[0]]); expect(f.tour.snapshot().step).toBe('plugins');
    f.tour.close(); expect(f.tour.reopen()).toBe(true); expect(f.tour.snapshot().selected).toBe(selection);
  });

  it('late old plugin ACK cannot advance a recovered Tour or release its new operation', async () => {
    const f = fixture({ allowedPlugins: [setupTourPlugins[0]] }); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const tour = createSetupTour({ current: () => true, directory: '/fixture/tour', send: async (...args) => { const value = await f.send(...args); if (args[1] === 'POST') await wait; return value; } }); tour.activate(true);
    const writing = tour.proceed(); for (let index = 0; index < 30 && !f.host.audit().writes.length; index++) await Promise.resolve();
    await tour.replaceLane({ send: f.send, current: () => true }); release(); await writing;
    expect(tour.snapshot()).toMatchObject({ step: 'models', busy: false }); await tour.proceed(); expect(f.host.audit().writes).toEqual([setupTourPlugins[0]]);
  });
  it('keeps the current four-step Web order and every later action read-only', async () => {
    const { tour, host, moves, closes } = fixture();
    expect(setupTourSteps).toEqual(['models', 'plugins', 'import', 'voice']);
    await tour.refresh();
    expect(host.audit().requests).toEqual([{ path: '/api/config/plugins?directory=%2Ffixture%2Ftour', method: 'GET' }]);
    for (let index = 0; index < 4; index++) tour.later();
    expect(moves).toEqual(['plugins', 'import', 'voice']); expect(closes).toEqual(['closed']);
    expect(host.audit().writes).toEqual([]);
  });

  it('writes Magpie once directly and never includes it in tools selections', async () => {
    const { tour, host } = fixture({ allowedPlugins: setupTourPlugins });
    await tour.refresh(); await tour.proceed();
    expect(tour.snapshot().step).toBe('plugins');
    expect(tour.snapshot().selected).toEqual(setupTourPlugins.slice(1));
    tour.togglePlugin(setupTourPlugins[0]); expect(tour.snapshot().selected).toEqual(setupTourPlugins.slice(1));
    await tour.refresh(); await tour.proceed();
    expect(host.audit().writes).toEqual([...setupTourPlugins]);
    expect(host.audit().config).toEqual({ $schema: 'https://opencode.ai/config.json', lsp: true, plugins: [...setupTourPlugins] });
    expect(host.audit().requests.filter(item => item.method === 'POST').map(item => item.body)).toEqual(setupTourPlugins.map(spec => ({ spec, scope: 'user' })));
    expect(host.audit().rejected).toEqual([]);
  });

  it('leaves explicit schema/lsp and unrelated config to the existing Host writer', async () => {
    const config = { $schema: 'https://example.invalid/explicit-schema', lsp: false, provider: { custom: { name: 'Existing' } } };
    const { tour, host } = fixture({ config, allowedPlugins: [setupTourPlugins[0]] });
    await tour.proceed();
    expect(host.audit().config).toEqual({ ...config, plugins: [setupTourPlugins[0]] });
  });

  it('reads package metadata and README directly without replacing author text', async () => {
    const { tour, host } = fixture(); tour.move('plugins'); await tour.refresh();
    expect(tour.snapshot().metadata[setupTourPlugins[1]]).toEqual({ spec: setupTourPlugins[1], name: 'Author package 0', description: 'Author description 0', icon: 'data:image/svg+xml,%3Csvg/%3E', readme: '# Author README 0', latestVersion: '3.2.1' });
    expect(host.audit().requests.at(-1)?.path).toContain('details=true'); expect(host.audit().writes).toEqual([]);
  });

  it('deduplicates versioned npm specs but never treats local files as installed packages', () => {
    expect(setupTourHasPlugin([{ parsedKind: 'npm', spec: '@eficy/opencode2-plugin@2.0.0' }], setupTourPlugins[1])).toBe(true);
    expect(setupTourHasPlugin([{ parsedKind: 'file', spec: setupTourPlugins[1] }, { file: true, parsedKind: 'npm', spec: setupTourPlugins[1] }], setupTourPlugins[1])).toBe(false);
  });

  it('GET after ACK fails: keeps selections, reconciles on explicit continue, never repeats POST', async () => {
    const { tour, host } = fixture({ allowedPlugins: [setupTourPlugins[0]], failListAfterWrite: 1 });
    await tour.refresh(); const selected = tour.snapshot().selected;
    await tour.proceed(); expect(tour.snapshot()).toMatchObject({ step: 'models', error: 'tour.saveFailed', failedNames: [setupTourPlugins[0]], selected });
    await tour.proceed(); expect(tour.snapshot().step).toBe('plugins');
    expect(host.audit().writes).toEqual([setupTourPlugins[0]]);
    expect(host.audit().requests.filter(item => item.method !== 'GET')).toHaveLength(1);
  });

  it('missing authoritative row after ACK does not authorize replay', async () => {
    const { tour, host } = fixture({ allowedPlugins: [setupTourPlugins[0]], missingAfterAck: true });
    await tour.proceed(); await tour.refresh(); await tour.proceed();
    expect(host.audit().writes).toEqual([setupTourPlugins[0]]); expect(tour.snapshot().step).toBe('models'); expect(tour.snapshot().error).toBe('tour.saveFailed');
  });

  it('lost mutation response reconciles through GET rather than guessing failure', async () => {
    const { tour, host } = fixture({ allowedPlugins: [setupTourPlugins[0]], uncertainWrites: [setupTourPlugins[0]] });
    await tour.proceed(); expect(tour.snapshot().error).toBe('tour.saveFailed'); await tour.proceed();
    expect(tour.snapshot().step).toBe('plugins'); expect(host.audit().writes).toEqual([setupTourPlugins[0]]);
  });

  it('a failed plugin does not block an unrelated successful plugin; retries retain successful writes', async () => {
    const { tour, host } = fixture({ allowedPlugins: setupTourPlugins, failWrites: [setupTourPlugins[1]] }); tour.move('plugins');
    await tour.proceed(); expect(host.audit().writes).toEqual([setupTourPlugins[2]]);
    expect(tour.snapshot()).toMatchObject({ step: 'plugins', failedNames: [setupTourPlugins[1]], selected: setupTourPlugins.slice(1) });
    await tour.proceed(); expect(host.audit().writes).toEqual([setupTourPlugins[2]]);
  });

  it('an explicit 4xx rejection permits a later user retry without replaying successful siblings', async () => {
    const reject = [setupTourPlugins[1]];
    const { tour, host } = fixture({ allowedPlugins: setupTourPlugins, failWrites: reject }); tour.move('plugins');
    await tour.proceed(); reject.length = 0; await tour.proceed();
    expect(tour.snapshot().step).toBe('import'); expect(host.audit().writes).toEqual([setupTourPlugins[2], setupTourPlugins[1]]);
  });

  it('preserves last good snapshots on a later list failure', async () => {
    const f = fixture(); let broken = false;
    const tour = createSetupTour({ directory: '/fixture/tour', current: () => true, send: (path, ...rest) => broken ? Promise.reject(new Error('failed')) : f.send(path, ...rest) });
    tour.activate(true); await tour.refresh(); const entries = tour.snapshot().entries; broken = true; await tour.refresh();
    expect(tour.snapshot().entries).toBe(entries); expect(tour.snapshot().error).toBe('tour.operationFailed');
  });

  it('other-provider verification refuses partial catalog despite models being present', async () => {
    const { tour, host } = fixture({ partialProviders: true }); tour.selectProvider('other'); await tour.proceed();
    expect(tour.snapshot()).toMatchObject({ step: 'models', error: 'tour.noModels' }); expect(host.audit().writes).toEqual([]);
    const good = fixture(); good.tour.selectProvider('other'); await good.tour.proceed(); expect(good.tour.snapshot().step).toBe('plugins'); expect(good.host.audit().writes).toEqual([]);
  });

  it('import proceed cannot invent completion or start/import/scan jobs', async () => {
    const { tour, host } = fixture(); tour.move('import'); await tour.refresh(); await tour.proceed();
    expect(tour.snapshot().step).toBe('import'); expect(host.audit().requests).toEqual([]); tour.later(); expect(tour.snapshot().step).toBe('voice');
  });

  it('only explicit covered detail callbacks advance import/close voice, fenced to their original Host', () => {
    const { tour, host, closes } = fixture(); tour.move('import'); tour.activate(false);
    tour.completeVoice(); expect(closes).toEqual([]); tour.completeImport(); expect(tour.snapshot().step).toBe('voice');
    tour.completeVoice(); tour.completeVoice(); expect(closes).toEqual(['closed']); expect(host.audit().requests).toEqual([]);
    const retired = fixture(); retired.tour.move('import'); retired.tour.activate(false); retired.retire(); retired.tour.completeImport(); expect(retired.tour.snapshot().step).toBe('import');
  });

  it('inactive and retired controllers cannot write or navigate', async () => {
    const { tour, host, retire, moves } = fixture({ allowedPlugins: setupTourPlugins }); tour.activate(false);
    await tour.proceed(); tour.later(); tour.togglePlugin(setupTourPlugins[1]); expect(moves).toEqual([]);
    tour.activate(true); retire(); await tour.refresh(); await tour.proceed(); tour.move('voice'); expect(host.audit().requests).toEqual([]);
  });

  it('later/close remain available during a pending initial GET; old reads cannot change the next step', async () => {
    let release!: (value: unknown) => void;
    const response = new Promise<unknown>(resolve => { release = resolve; });
    const tour = createSetupTour({ current: () => true, send: () => response }); tour.activate(true);
    const read = tour.refresh(); expect(tour.snapshot()).toMatchObject({ loading: true, busy: false });
    tour.later(); expect(tour.snapshot().step).toBe('plugins');
    release({ entries: [{ parsedKind: 'npm', spec: 'old' }], files: [] }); await read;
    expect(tour.snapshot().entries).toBeNull(); expect(tour.snapshot().loading).toBe(false);
    tour.close(); expect(tour.snapshot().closed).toBe(true);
  });

  it('coalesces the same visible read without preventing a fresh read on a new step', async () => {
    const f = fixture(); let release!: () => void, calls = 0;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const tour = createSetupTour({ current: () => true, directory: '/fixture/tour', send: async (...args) => { calls++; await wait; return f.send(...args); } }); tour.activate(true);
    const first = tour.refresh(), duplicate = tour.refresh(); expect(first).toBe(duplicate); expect(calls).toBe(1);
    tour.move('voice'); const voice = tour.refresh(); expect(calls).toBe(2); release(); await Promise.all([first, voice]);
    expect(tour.snapshot().entries).toBeNull(); expect(tour.snapshot().speech?.voiceProvider).toBe('browser');
  });

  it('pressing the current step does not invalidate its only in-flight initial read', async () => {
    let release!: (value: unknown) => void;
    const tour = createSetupTour({ current: () => true, send: () => new Promise(resolve => { release = resolve; }) }); tour.activate(true);
    const read = tour.refresh(); tour.move('models');
    release({ entries: [], files: [] }); await read;
    expect(tour.snapshot()).toMatchObject({ step: 'models', entries: [], loading: false, error: null });
  });

  it('Host fence drops delayed metadata and prevents remaining writes', async () => {
    const f = fixture({ allowedPlugins: setupTourPlugins }); let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }); let live = true;
    const tour = createSetupTour({ directory: '/fixture/tour', current: () => live, send: async (path, method, body) => { const result = await f.send(path, method, body); if (method === 'POST') await wait; return result; } });
    tour.activate(true); tour.move('plugins'); const running = tour.proceed();
    for (let turn = 0; turn < 20 && !f.host.audit().writes.length; turn++) await Promise.resolve();
    live = false; release(); await running;
    expect(f.host.audit().writes).toEqual([setupTourPlugins[1]]); expect(tour.snapshot().step).toBe('plugins');
  });

  it('page cover retains an in-flight ACK journal and resume performs reads only', async () => {
    const f = fixture({ allowedPlugins: [setupTourPlugins[0]], missingAfterAck: true }); let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const tour = createSetupTour({ directory: '/fixture/tour', current: () => true, send: async (path, method, body) => { const result = await f.send(path, method, body); if (method === 'POST') await wait; return result; } });
    tour.activate(true); const running = tour.proceed();
    for (let turn = 0; turn < 20 && !f.host.audit().writes.length; turn++) await Promise.resolve();
    tour.activate(false); release(); await running; tour.activate(true); await tour.proceed();
    expect(f.host.audit().writes).toEqual([setupTourPlugins[0]]); expect(tour.snapshot().error).toBe('tour.saveFailed');
  });

  it('double submit is single-flight, does not skip the next step', async () => {
    const { tour, host } = fixture({ allowedPlugins: setupTourPlugins }); await Promise.all([tour.proceed(), tour.proceed()]);
    expect(tour.snapshot().step).toBe('plugins'); expect(host.audit().writes).toEqual([setupTourPlugins[0]]);
  });
});

describe('Doubao drafts reuse the production Voice confirmation owner', () => {
  it('a configured Host can save recommendation defaults without replacing or resubmitting its secret', async () => {
    const { send, host } = fixture({ allowedVoice: true, voiceConfigured: true });
    const voice = createSetupTourDoubao({ send, current: () => true, active: () => true, changed: () => {} }); voice.activate(true); await voice.load();
    expect(voice.configured()).toBe(true); expect((await voice.save())?.settings.configured).toBe(true);
    const writes = host.audit().requests.filter(request => request.method === 'PUT'); expect(writes).toHaveLength(1); expect(writes[0].body).not.toHaveProperty('apiKey');
  });
  it('prepares only local defaults on first open and refuses saving an unconfigured empty key', async () => {
    const { send, host } = fixture({ allowedVoice: true });
    const voice = createSetupTourDoubao({ send, current: () => true, active: () => true, changed: () => {} }); voice.activate(true); await voice.load();
    expect(voice.snapshot().changes).toEqual({ voiceProvider: 'volcengine', sttProvider: 'volcengine', dictationEnabled: true, showMessageTTSButtons: true });
    await expect(voice.save()).rejects.toThrow('setup-tour-api-key-required'); expect(host.audit().writes).toEqual([]);
  });

  it('ACK then GET failure retains secret draft and never replays the credential PUT', async () => {
    const { send, host } = fixture({ allowedVoice: true, voiceReadFailureAfterWrite: 1 });
    const voice = createSetupTourDoubao({ send, current: () => true, active: () => true, changed: () => {} }); voice.activate(true); await voice.load();
    voice.update('apiKey', 'synthetic-tour-key'); voice.update('asrContext', 'User context'); await expect(voice.save()).rejects.toThrow();
    expect(voice.snapshot().changes.apiKey).toBe('synthetic-tour-key'); const receipt = await voice.save();
    expect(receipt?.settings.configured).toBe(true); expect(host.audit().writes).toEqual(['voice']); expect(voice.snapshot().changes).toEqual({}); expect(voice.snapshot().data.apiKey).toBe('');
    voice.dispose(); expect(voice.snapshot().data).toEqual({});
  });
});
