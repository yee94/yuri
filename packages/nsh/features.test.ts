import { describe, expect, it, vi } from 'vitest';
import { bot, featureFixture, item, settle } from './tests/features-fixture';
import { record } from './model';
import * as nativeCron from './features-cron';
import * as webCron from '../ui/src/lib/cron';
import { createHost } from './tests/features-host.js';
import { foundationCronPreview } from './features-schedule-date';
import { systemSheetContentStyle } from './sheet-presentation';

describe('features production callback/DTO contracts (no NSH engine)', () => {
  it('external fixture host proves exact directory through its response and rejects writes/unknown Agent scopes', () => {
    const host = createHost();
    const provider = (path: string) => record(record(host.call('runtime.request', { method: 'GET', path })).body).providers;
    expect(provider('/api/config/catalog/providers?directory=%2Fmanaged')).toMatchObject([{ name: 'Managed directory verified' }]);
    expect(provider('/api/config/catalog/providers?directory=%2Ffirst-project')).toMatchObject([{ name: 'Task directory verified' }]);
    expect(() => provider('/api/config/catalog/providers?directory=%2Fwrong')).toThrow('Unexpected features');
    expect(() => host.call('runtime.request', { method: 'GET', path: '/api/agent?location%5Bdirectory%5D=%2Fmanaged' })).toThrow('Unexpected features');
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(() => host.call('runtime.request', { method, path: '/api/yuri/assistants/bot' })).toThrow('must not write');
    }
  });
  it('pure parser entry preserves the full Web dialect, timezone/DST calculations and examples', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-07T15:00:00Z'));
      expect(nativeCron.CRON_EXAMPLES).toEqual(webCron.CRON_EXAMPLES);
      for (const expression of ['0 9 * * MON-FRI', '*/15 8-17 * JAN,MAR MON', '@hourly', '0 0 L * *', '0 0 1 * *', 'bad cron']) {
        expect(nativeCron.isValidCronExpression(expression).valid).toBe(webCron.isValidCronExpression(expression).valid);
        for (const timezone of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
          if (webCron.isValidCronExpression(expression).valid)
            expect(nativeCron.getNextRuns(expression, timezone).map(date => date.toISOString())).toEqual(webCron.getNextRuns(expression, timezone).map(date => date.toISOString()));
          else expect(() => nativeCron.getNextRuns(expression, timezone)).toThrow();
        }
      }
    } finally { vi.useRealTimers(); }
  });
  it('preview reports full parse/Intl failures instead of an empty successful list', () => {
    const badZone = nativeCron.cronPreview('0 9 * * MON-FRI', 'Invalid/Zone', 'en-US', new Date('2026-03-07T15:00:00Z'));
    expect(badZone.ok).toBe(false);
    if (!badZone.ok) {
      expect(badZone.error.stage).toBe('intl-zone'); expect(badZone.error.message.length).toBeGreaterThan(0); expect(badZone.error.stack.length).toBeGreaterThan(0); expect(badZone.error.previous?.stage).toBe('parse');
    }
    const formatter = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { throw new RangeError('fixture IANA capability failure'); });
    try {
      const result = nativeCron.cronPreview('0 9 * * MON-FRI', 'UTC', 'en-US', new Date('2026-03-07T15:00:00Z'));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.stage).toBe('format'); expect(nativeCron.cronFailureText(result.error)).toContain('RangeError: fixture IANA capability failure');
      }
    } finally { formatter.mockRestore(); }
  });

  it('Foundation offset adapter keeps the real parser dialect/DST and needs no IANA-capable Intl', async () => {
    // DTO seam fixture, not a claim that Foundation/QuickJS has run. Each date is
    // checked against the real Web parser and formatter below.
    const previous = { stage: 'parse', name: 'RangeError', message: 'IANA unavailable', stack: 'fixture original stack' };
    const transition = Date.parse('2026-03-08T07:00:00Z');
    const original = Intl.DateTimeFormat;
    const formatter = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      if (args[1]?.timeZone === 'America/New_York') throw new RangeError('fixture IANA unavailable');
      return new original(...args);
    });
    const read = async (request: { hostID: string; timeZone: string; startMs: number; endMs: number }) => {
      const initial = request.startMs < transition ? -18000 : -14400;
      const parts = new Date(request.startMs + initial * 1000);
      return { schemaVersion: 1, ...request,
        transitions: [{ atMs: request.startMs, offsetSeconds: initial }, ...(request.startMs < transition && transition < request.endMs ? [{ atMs: transition, offsetSeconds: -14400 }] : [])],
        anchor: { timestampMs: request.startMs, era: 1, year: parts.getUTCFullYear(), month: parts.getUTCMonth() + 1,
          day: parts.getUTCDate(), hour: parts.getUTCHours(), minute: parts.getUTCMinutes(), second: parts.getUTCSeconds(), weekday: parts.getUTCDay() + 1, offsetSeconds: initial },
      };
    };
    let result: Awaited<ReturnType<typeof foundationCronPreview>>;
    try {
      result = await foundationCronPreview({ expression: '0 9 * * MON-FRI', timeZone: 'America/New_York', locale: 'en-US', hostID: 'fixture', currentDate: new Date('2026-03-06T12:00:00Z'), previous, read });
    } finally { formatter.mockRestore(); }
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      const web = webCron.getNextRuns;
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-03-06T12:00:00Z'));
        expect(result.dates.map(date => date.toISOString())).toEqual(web('0 9 * * MON-FRI', 'America/New_York').map(date => date.toISOString()));
        const format = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        expect(result.formatted).toEqual(result.dates.map(date => format.format(date)));
      } finally { vi.useRealTimers(); }
    }
  });

  it('native date context failure retains the original full parser exception', async () => {
    const result = await foundationCronPreview({ expression: '0 9 * * MON-FRI', timeZone: 'America/New_York', locale: 'en-US', hostID: 'fixture', currentDate: new Date('2026-03-07T15:00:00Z'),
      previous: { stage: 'parse', name: 'Error', message: 'original CronDate failure', stack: 'original stack' },
      read: async () => { throw new Error('schedule.dateContext not registered'); },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe('native-context');
      expect(nativeCron.cronFailureText(result.error)).toContain('schedule.dateContext not registered');
      expect(nativeCron.cronFailureText(result.error)).toContain('original CronDate failure');
      expect(nativeCron.cronFailureText(result.error)).toContain('original stack');
    }
  });

  it('coverage expansion re-reads authority and replays the same real parser input for distant leap dates', async () => {
    const reads: number[] = [];
    const result = await foundationCronPreview({ expression: '0 0 29 2 *', timeZone: 'Etc/UTC', locale: 'en-US', hostID: 'fixture', currentDate: new Date('2026-03-07T15:00:00Z'),
      previous: { stage: 'parse', name: 'Error', message: 'fixture unsupported zone', stack: '' },
      read: async request => {
        reads.push(request.endMs); const parts = new Date(request.startMs);
        return { schemaVersion: 1, ...request, transitions: [{ atMs: request.startMs, offsetSeconds: 0 }],
          anchor: { timestampMs: request.startMs, era: 1, year: parts.getUTCFullYear(), month: parts.getUTCMonth() + 1,
            day: parts.getUTCDate(), hour: parts.getUTCHours(), minute: parts.getUTCMinutes(), second: parts.getUTCSeconds(), weekday: parts.getUTCDay() + 1, offsetSeconds: 0 } };
      },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true); expect(reads.length).toBeGreaterThan(1);
    if (result.ok) expect(result.dates.map(date => date.toISOString())).toEqual(['2028-02-29T00:00:00.000Z', '2032-02-29T00:00:00.000Z', '2036-02-29T00:00:00.000Z', '2040-02-29T00:00:00.000Z']);
  });

  it('a malformed native date context is a full failure, never valid empty preview', async () => {
    const result = await foundationCronPreview({ expression: '* * * * *', timeZone: 'UTC', locale: 'en-US', hostID: 'fixture', currentDate: new Date('2026-03-07T15:00:00Z'),
      previous: { stage: 'format', name: 'RangeError', message: 'original formatter failed', stack: 'original formatter stack' }, read: async () => ({ schemaVersion: 1, transitions: [] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(nativeCron.cronFailureText(result.error)).toContain('native-context: Error: schedule_date_invalid_context');
  });
  it('Bot PATCH omits agent/mode and loads the managed rather than first/effective workspace', async () => {
    const f = featureFixture({ bot }); const root = f.element('bot'); await settle();
    expect(f.calls[0].path).toBe('/api/config/catalog/providers?directory=%2Fmanaged');
    expect(f.calls.some(call => call.path.startsWith('/api/agent'))).toBe(false);
    expect(f.find(root, node => typeof node.type === 'function' && node.type.name === 'CatalogFields').props.includeAgent).toBe(false);
    (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    const patch = f.calls.find(call => call.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ expectedRevision: 1, workspacePath: null, variant: 'high' });
    expect(patch.body).not.toHaveProperty('agent'); expect(patch.body).not.toHaveProperty('mode');
    expect(f.done()).toBe(1);
  });

  it.each([null, '/explicit'])('Bot directory preserves null/explicit scope: %s', async directory => {
    const f = featureFixture({ bot: { ...bot, workspacePath: directory, managedWorkspacePath: null } }); f.element('bot'); await settle();
    expect(f.calls[0].path).toBe(`/api/config/catalog/providers${directory ? '?directory=%2Fexplicit' : ''}`);
  });

  it('failed and malformed catalog refreshes retain the previous providers, agents and partial state', async () => {
    let failed = false;
    const providers = [{ id: 'old', models: {} }], agents = [{ id: 'build', name: 'build' }];
    const f = featureFixture({ item, request: async call => {
      if (failed) { if (call.path.startsWith('/api/agent')) throw new Error('agents offline'); return { schemaVersion: 99, providers: [] }; }
      return call.path.startsWith('/api/agent') ? agents : { schemaVersion: 1, providers, partial: true };
    } }); const root = f.element('task'); await settle(); const c = f.catalog(root), previousProviders = c.providers(), previousAgents = c.agents();
    failed = true; const flight = c.load('/first-project');
    expect(c.providers()).toBe(previousProviders); await flight;
    expect(c.providers()).toBe(previousProviders); expect(c.agents()).toBe(previousAgents); expect(c.partial()).toBe(true);
    expect(c.error()).not.toBe(''); expect(c.loading()).toBe(false);
  });

  it('newer catalog requests win and successful empty catalogs really clear the snapshot', async () => {
    let finish: ((value: unknown) => void) | undefined;
    const f = featureFixture({ bot, request: async call => {
      if (call.path.includes('older')) return new Promise(resolve => { finish = resolve; });
      return { schemaVersion: 1, providers: call.path.includes('empty') ? [] : [{ id: 'new', models: {} }] };
    } }); const root = f.element('bot'); await settle(); const c = f.catalog(root);
    const old = c.load('/older'); await c.load('/newer'); finish?.({ schemaVersion: 1, providers: [{ id: 'stale' }] }); await old;
    expect(c.providers()[0].id).toBe('new'); await c.load('/empty'); expect(c.providers()).toEqual([]);
  });

  it('Goal can be disabled and is saved false, with write invalidation before refresh', async () => {
    const f = featureFixture({ item }); const root = f.element('task'); await settle();
    const goal = f.find(root, node => node.props.testID === 'features-goal');
    expect(goal.props.checked).toBe(true);
    (goal.props.onChange as (event: { checked: boolean }) => void)({ checked: false });
    (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(record(record(f.calls.find(call => call.method === 'PATCH')?.body).task).execution).toMatchObject({ goalEnabled: false });
    expect(f.order.indexOf('invalidate')).toBeLessThan(f.order.indexOf('refresh')); expect(f.done()).toBe(1);
  });

  it('task time initialization follows Web normalization rather than rejecting legacy bad/duplicate values', async () => {
    const f = featureFixture({ item: { ...item, task: { ...item.task, schedule: { kind: 'daily', times: ['12:00', 'bad', '09:00', '12:00'], timezone: 'UTC' } } } });
    const root = f.element('task'); await settle();
    (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(record(record(record(f.calls.find(call => call.method === 'PATCH')?.body).task).schedule).times).toEqual(['09:00', '12:00']);
  });

  it('adding a task time uses noon and removing the last time restores the Web morning default', async () => {
    const f = featureFixture({ item }); const root = f.element('task'); await settle();
    (f.find(root, node => node.props.testID === 'features-time-add').props.onPress as () => void)();
    (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(record(record(record(f.calls.find(call => call.method === 'PATCH')?.body).task).schedule).times).toEqual(['09:00', '12:00']);
    const other = featureFixture({ item }); const page = other.element('task'); await settle();
    const each = other.find(page, node => node.type === 'Each' && Array.isArray(node.props.of) && node.props.of.length === 1 && node.props.of[0] === 0);
    const row = (each.children[0] as (index: () => number) => typeof page)(() => 0);
    (other.find(row, node => node.props.testID === 'features-time-remove').props.onPress as () => void)();
    (page.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(record(record(record(other.calls.find(call => call.method === 'PATCH')?.body).task).schedule).times).toEqual(['09:00']);
  });

  it('task clears an invalid saved variant only when the chosen model is authoritative', async () => {
    const f = featureFixture({ item: { ...item, task: { ...item.task, execution: { ...item.task.execution, variant: 'removed' } } } });
    const root = f.element('task'); await settle();
    (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(record(record(record(f.calls.find(call => call.method === 'PATCH')?.body).task).execution).variant).toBe('');
  });

  it.each(['bot', 'task'] as const)('ACK then failed catalog refresh locks %s writes and Done only rereads', async kind => {
    let readsFail = true;
    const f = featureFixture({ bot, item, refresh: async () => { if (readsFail) throw new Error('catalog offline'); } });
    const root = f.element(kind); await settle();
    const save = (root.props.headerRight as { props: { onPress: () => void } }).props.onPress;
    save(); await settle(); expect(f.state(root).committed()).toBe(true); expect(f.done()).toBe(0);
    save(); await settle(); expect(f.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    readsFail = false; await f.state(root).perform(f.state(root).finish, true);
    expect(f.done()).toBe(1); expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });

  it('lost task ACK allows read-only reconciliation, never a second write or delete', async () => {
    let stored: unknown;
    let offline = true;
    const f = featureFixture({ item, request: async call => {
      if (call.method === 'PATCH') { stored = record(call.body).task; throw new Error('ACK lost'); }
      if (call.path.endsWith('/scheduled-tasks')) { if (offline) throw Object.assign(new Error('read denied'), { status: 403 }); return { tasks: [stored] }; }
      return call.path.startsWith('/api/agent') ? [] : { schemaVersion: 1, providers: [] };
    } });
    const root = f.element('task'); await settle();
    const save = (root.props.headerRight as { props: { onPress: () => void } }).props.onPress;
    save(); await settle(); save(); await settle();
    expect(f.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    const feedback = f.find(root, node => typeof node.type === 'function' && node.type.name === 'Feedback');
    const state = feedback.props.state as { recover: () => Promise<void>; perform: (work: () => Promise<void>, allow?: boolean) => Promise<void> };
    await state.perform(state.recover, true); expect(f.done()).toBe(0);
    offline = false; await state.perform(state.recover, true);
    expect(f.state(root).committed()).toBe(true); expect(f.done()).toBe(1);
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });

  it('Bot update ACK must match the edited Bot identity', async () => {
    const f = featureFixture({ bot, request: async call => call.method === 'PATCH' ? { id: 'another-bot', revision: 2 } : { schemaVersion: 1, providers: [] } });
    const root = f.element('bot'); await settle();
    (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(f.state(root).committed()).toBe(false); expect(f.done()).toBe(0);
  });

  it('authoritative 409 leaves a task draft editable for explicit resubmission', async () => {
    let reject = true;
    const f = featureFixture({ item, request: async call => {
      if (call.method === 'PATCH') { if (reject) throw Object.assign(new Error('conflict'), { status: 409 }); return { task: record(call.body).task }; }
      return call.path.startsWith('/api/agent') ? [] : { schemaVersion: 1, providers: [] };
    } });
    const root = f.element('task'); await settle(); const save = (root.props.headerRight as { props: { onPress: () => void } }).props.onPress;
    save(); await settle(); reject = false; save(); await settle();
    expect(f.calls.filter(call => call.method === 'PATCH')).toHaveLength(2); expect(f.done()).toBe(1);
  });

  it('lost delete ACK rejects malformed/partial snapshots and confirms absence with GET only', async () => {
    let snapshot: unknown = { tasks: [], partial: true };
    const f = featureFixture({ item, request: async call => {
      if (call.method === 'DELETE') throw new Error('lost delete ACK');
      if (call.path.endsWith('/scheduled-tasks')) return snapshot;
      return call.path.startsWith('/api/agent') ? [] : { schemaVersion: 1, providers: [] };
    } });
    const root = f.element('task'); await settle();
    const remove = f.find(root, node => node.type === 'Button' && node.children.some(child => child && typeof child === 'object' && 'children' in child && (child as { children: unknown[] }).children.includes('settings.common.actions.delete')));
    f.setAnswer('delete'); (remove.props.onPress as () => void)(); await settle();
    const save = (root.props.headerRight as { props: { onPress: () => void } }).props.onPress;
    save(); await settle(); expect(f.state(root).committed()).toBe(false);
    snapshot = { tasks: [null] }; save(); await settle(); expect(f.state(root).committed()).toBe(false);
    snapshot = { tasks: [] }; save(); await settle();
    expect(f.state(root).committed()).toBe(true); expect(f.done()).toBe(1);
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });

  it('lost Bot update ACK reads exact identity/revision without replaying PATCH', async () => {
    let stored: unknown;
    const f = featureFixture({ bot, request: async call => {
      if (call.method === 'PATCH') { stored = { ...bot, ...record(call.body), revision: 2 }; throw new Error('lost ACK'); }
      if (call.path.endsWith('/snapshot')) return { assistants: [stored] };
      return { schemaVersion: 1, providers: [] };
    } });
    const root = f.element('bot'); await settle(); const save = (root.props.headerRight as { props: { onPress: () => void } }).props.onPress;
    save(); await settle(); save(); await settle();
    expect(f.calls.filter(call => call.method === 'PATCH')).toHaveLength(1); expect(f.done()).toBe(1);
  });

  it('Bot creation with no acknowledged ID stays unknown rather than matching a same-name record', async () => {
    let created = false;
    const f = featureFixture({ request: async call => {
      if (call.method === 'POST') { created = true; throw new Error('create ACK lost'); }
      if (call.path === '/api/config/settings/bootstrap') return { schemaVersion: 1, defaultModel: 'provider/model' };
      if (call.path === '/api/config') return [];
      if (call.path.endsWith('/snapshot')) return { assistants: created ? [{ ...bot, id: 'another', name: 'Yuri' }] : [] };
      return { schemaVersion: 1, providers: [] };
    } });
    const root = f.element('bot'); await settle(); const save = (root.props.headerRight as { props: { onPress: () => void } }).props.onPress;
    save(); await settle(); save(); await settle();
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1); expect(f.done()).toBe(0); expect(f.state(root).committed()).toBe(false);
    (root.props.onBackPress as () => void)(); await settle(); expect(f.dialogs).toHaveLength(1); expect(f.done()).toBe(0);
  });

  it('task readback accepts Host omission of disabled Goal and empty optional selections', async () => {
    let stored: unknown;
    const f = featureFixture({ item, request: async call => {
      if (call.method === 'PATCH') {
        const task = record(record(call.body).task), execution = record(task.execution);
        stored = { ...task, execution: { prompt: execution.prompt, providerID: execution.providerID, modelID: execution.modelID, agent: execution.agent } };
        throw new Error('lost ACK');
      }
      if (call.path.endsWith('/scheduled-tasks')) return { tasks: [stored] };
      return call.path.startsWith('/api/agent') ? [] : { schemaVersion: 1, providers: [] };
    } });
    const root = f.element('task'); await settle();
    (f.find(root, node => node.props.testID === 'features-goal').props.onChange as (event: { checked: boolean }) => void)({ checked: false });
    const save = (root.props.headerRight as { props: { onPress: () => void } }).props.onPress;
    save(); await settle(); save(); await settle();
    expect(f.done()).toBe(1); expect(f.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('task overflow runs the saved task once, preserves the unsaved prompt and supports live toggle', async () => {
    let live = { ...item.task, state: { lastStatus: 'idle' } };
    const f = featureFixture({ item, request: async call => {
      if (call.path.startsWith('/api/config/catalog/providers')) return { schemaVersion: 1, providers: [] };
      if (call.path.startsWith('/api/agent')) return [];
      if (call.path === '/api/config/settings') return {};
      if (call.method === 'GET') return { tasks: [live] };
      if (call.method === 'POST') return { ok: true, task: live, sessionId: 'run-session' };
      live = { ...live, ...record(record(call.body).task) }; return { task: live, tasks: [live], schedulerSynced: true };
    } });
    const root = f.element('task'); await settle();
    (f.find(root, node => node.type === 'TaskEditorPrompt').props.onChange as (value: string) => void)('Unsaved prompt');
    f.setAnswer('run'); (f.header(root, 'features-task-more').props.onPress as () => void)(); await settle();
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1); expect(f.state(root).committed()).toBe(false); expect(f.done()).toBe(0);
    f.setAnswer('toggle'); (f.header(root, 'features-task-more').props.onPress as () => void)(); await settle();
    expect(f.calls.find(call => call.method === 'PATCH')?.body).toEqual({ task: { id: 'task', enabled: false } });
    (f.header(root, 'features-task-save').props.onPress as () => void)(); await settle();
    expect(record(record(f.calls.filter(call => call.method === 'PATCH').at(-1)?.body).task).execution).toMatchObject({ prompt: 'Unsaved prompt' });
  });
  it('Run notice precedes refresh completion; History is admitted only after the action settles', async () => {
    let release: (() => void) | undefined;
    const refresh = new Promise<void>(resolve => { release = resolve; });
    const opened: unknown[] = [];
    const f = featureFixture({ item, onOpenHistory: identity => opened.push(identity), refresh: () => refresh, request: async call => {
      if (call.path.startsWith('/api/config/catalog/providers')) return { schemaVersion: 1, providers: [] };
      if (call.path.startsWith('/api/agent')) return [];
      if (call.path === '/api/config/settings') return {};
      if (call.method === 'POST') return { ok: true, task: { ...item.task, state: { lastStatus: 'success' } }, sessionId: 'run-session' };
      return { tasks: [item.task] };
    } });
    const root = f.element('task'); await settle();
    f.setAnswer('run'); (f.header(root, 'features-task-more').props.onPress as () => void)(); await settle();
    expect(f.state(root).notice()).toContain('sessions.scheduledTasks.dialog.toast.started');
    expect(f.state(root).busy()).toBe(true); expect(f.state(root).committed()).toBe(true);
    const dialogs = f.dialogs.length;
    f.setAnswer('history'); (f.header(root, 'features-task-more').props.onPress as () => void)(); await settle();
    expect(f.dialogs).toHaveLength(dialogs); expect(opened).toEqual([]);
    release?.(); await settle();
    expect(f.state(root).busy()).toBe(false); expect(f.state(root).committed()).toBe(false);
    (f.header(root, 'features-task-more').props.onPress as () => void)(); await settle();
    expect(f.dialogs).toHaveLength(dialogs + 1);
    expect(opened).toEqual([{ projectId: 'project', taskId: 'task' }]);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(f.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it.each([
    [568, 0, 0], [844, 59, 34], [430, 0, 21], [1024, 24, 20],
  ])('history panel is bounded at viewport %s and safe-area %s/%s', async (height, top, bottom) => {
    const f = featureFixture({ item, windowHeight: height, safeArea: { top, bottom } });
    const root = f.element('task'); await settle();
    const sheet = f.find(root, node => node.type === 'NativeSheet');
    const panelHeight = record(sheet.props.popupStyle).height;
    expect(panelHeight).toBe((height - top - bottom) * .72 + bottom);
    expect(sheet.props.popupClass).toBe('h-full bg-background');
    expect(Number(panelHeight)).toBeGreaterThan(0);
    expect(Number(panelHeight)).toBeLessThanOrEqual(height - top);
    expect(sheet.props.detents).toEqual([.72, .98]);
    expect(systemSheetContentStyle({ height: Number(panelHeight) })).toEqual({});
    expect(sheet.children).not.toHaveLength(0);
  });

  it('acknowledged toggle restores its authoritative enabled baseline and sync warning after exit', async () => {
    const receipts = new Map<string, string>(); let live = { ...item.task };
    const request = async (call: { path: string; method: string; body?: unknown }) => {
      if (call.path.endsWith('/scheduled-tasks') && call.method === 'GET') return { tasks: [live] };
      if (call.method === 'PATCH') { live = { ...live, ...record(record(call.body).task) }; return { task: live, tasks: [live], schedulerSynced: false }; }
      return call.path.startsWith('/api/agent') ? [] : call.path.includes('/catalog/') ? { schemaVersion: 1, providers: [] } : {};
    };
    const first = featureFixture({ item, receipts, request, refresh: async () => { throw new Error('refresh offline'); } }); const page = first.element('task'); await settle();
    first.setAnswer('toggle'); (first.header(page, 'features-task-more').props.onPress as () => void)(); await settle();
    expect(first.state(page).committed()).toBe(true); first.unmount(); await settle();
    const next = featureFixture({ item, receipts, request }); const reopened = next.element('task'); await settle();
    expect(next.state(reopened).notice()).toContain('SYNC_PENDING');
    await next.state(reopened).perform(next.state(reopened).finish, true);
    expect(next.calls.every(call => call.method === 'GET')).toBe(true); expect(next.state(reopened).committed()).toBe(false);
    (next.header(reopened, 'features-task-save').props.onPress as () => void)(); await settle();
    expect(record(record(next.calls.find(call => call.method === 'PATCH')?.body).task).enabled).toBe(false);
  });
  it.each([
    ['run', true], ['run', undefined], ['toggle', true], ['toggle', undefined],
  ] as const)('ordinary %s ACK (schedulerSynced=%s) restores known state and Done unlocks a new save without replay', async (action, schedulerSynced) => {
    const receipts = new Map<string, string>();
    let live: Record<string, unknown> = { ...item.task, state: { lastStatus: 'idle', lastRunAt: 1, lastSessionId: 'old' } };
    const request = async (call: { path: string; method: string; body?: unknown }) => {
      if (call.path.endsWith('/scheduled-tasks') && call.method === 'GET') return { tasks: [live] };
      if (call.method === 'POST') { live = { ...live, state: { lastStatus: 'success', lastRunAt: 2, lastSessionId: 'run' } }; return { ok: true, task: live, sessionId: 'run', ...(schedulerSynced === undefined ? {} : { schedulerSynced }) }; }
      if (call.method === 'PATCH') { live = { ...live, ...record(record(call.body).task) }; return { task: live, tasks: [live], ...(schedulerSynced === undefined ? {} : { schedulerSynced }) }; }
      return call.path.startsWith('/api/agent') ? [] : call.path.includes('/catalog/') ? { schemaVersion: 1, providers: [] } : {};
    };
    const first = featureFixture({ item, receipts, request, refresh: async () => { throw new Error('refresh offline'); } });
    const page = first.element('task'); await settle(); first.setAnswer(action);
    (first.header(page, 'features-task-more').props.onPress as () => void)(); await settle();
    expect(first.state(page).committed()).toBe(true); first.unmount(); await settle();
    const next = featureFixture({ item, receipts, request }); const reopened = next.element('task'); await settle();
    expect(next.state(reopened).committed()).toBe(true);
    expect.soft(next.state(reopened).uncertain()).toBe(false);
    expect(next.state(reopened).notice()).not.toContain('SYNC_PENDING');
    await next.state(reopened).perform(next.state(reopened).finish, true);
    expect(next.calls.every(call => call.method === 'GET')).toBe(true);
    expect.soft(next.state(reopened).uncertain()).toBe(false);
    expect(next.state(reopened).committed()).toBe(false);
    next.setAnswer('confirm');
    (next.header(reopened, 'features-task-save').props.onPress as () => void)(); await settle();
    expect.soft(next.state(reopened).error()).not.toContain('feature-receipt-missing');
    const saves = next.calls.filter(call => call.method === 'PATCH');
    expect(saves).toHaveLength(1); expect(record(record(saves[0].body).task).execution).toMatchObject({ prompt: item.task.execution.prompt });
    expect(next.calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('unknown task create survives remount and first-render Save never bypasses restoration', async () => {
    const receipts = new Map<string, string>(); let stored: unknown;
    const first = featureFixture({ receipts, creationContext: { projectID: 'project', directory: '/first-project', selection: { providerID: 'provider', modelID: 'model' } }, request: async call => {
      if (call.method === 'PUT') { stored = record(call.body).task; throw new Error('lost ACK'); }
      return call.path.startsWith('/api/agent') ? [] : call.path.includes('/catalog/') ? { schemaVersion: 1, providers: [] } : {};
    } });
    const page = first.element('task'); await settle();
    (first.find(page, node => node.props.testID === 'features-task-name').props.onChange as (event: { value: string }) => void)({ value: 'Durable task' });
    (first.find(page, node => node.type === 'TaskEditorPrompt').props.onChange as (value: string) => void)('Durable prompt');
    (first.header(page, 'features-task-save').props.onPress as () => void)(); await settle(); first.unmount(); await settle();
    const next = featureFixture({ receipts, request: async call => call.path.endsWith('/scheduled-tasks') ? { tasks: [stored] } : call.path.startsWith('/api/agent') ? [] : call.path.includes('/catalog/') ? { schemaVersion: 1, providers: [] } : {} });
    const reopened = next.element('task'); (next.header(reopened, 'features-task-save').props.onPress as () => void)(); await settle();
    expect(next.calls.every(call => call.method === 'GET')).toBe(true);
    (next.header(reopened, 'features-task-save').props.onPress as () => void)(); await settle();
    expect(next.done()).toBe(1); expect(next.calls.filter(call => call.path.endsWith('/scheduled-tasks'))).toHaveLength(1);
  });
  it('Bot create receipt survives remount and binds only an explicitly selected, re-read Bot ID', async () => {
    const receipts = new Map<string, string>(); let stored: unknown;
    let rejectCreate: ((reason: Error) => void) | undefined;
    const request = async (call: { path: string; method: string; body?: unknown }) => {
      if (call.method === 'POST') { stored = { ...record(call.body), id: 'created', revision: 1 }; return new Promise((_resolve, reject) => { rejectCreate = reject; }); }
      if (call.path === '/api/config/settings/bootstrap') return { schemaVersion: 1, defaultModel: 'provider/model' };
      if (call.path === '/api/config') return [];
      if (call.path.endsWith('/snapshot')) return { assistants: stored ? [stored] : [] };
      return { schemaVersion: 1, providers: [] };
    };
    const first = featureFixture({ receipts, request, retireUISignals: true }); const page = first.element('bot'); await settle();
    (first.header(page, 'features-bot-save').props.onPress as () => void)(); await settle(); first.unmount(); await settle();
    expect(first.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    let release: (() => void) | undefined;
    const receiptReady = new Promise<void>(resolve => { release = resolve; });
    const next = featureFixture({ receipts, request, receiptReady }); const reopened = next.element('bot'); await settle();
    (next.header(reopened, 'features-bot-save').props.onPress as () => void)(); await settle();
    expect(next.calls).toHaveLength(0);
    release?.(); await settle();
    expect(next.state(reopened).error()).toBe('');
    expect(next.state(reopened).uncertain()).toBe(true);
    rejectCreate?.(new Error('create ACK lost after original editor retired')); await settle();
    expect(first.retiredAccesses()).toBe(0);
    next.setAnswer('created'); (next.header(reopened, 'features-bot-save').props.onPress as () => void)(); await settle();
    expect(next.done()).toBe(1); expect(next.calls.every(call => call.method === 'GET')).toBe(true);
    expect(next.calls.filter(call => call.path.endsWith('/snapshot'))).toHaveLength(2);
    expect(next.dialogs).toHaveLength(1);
  });

  it('a delayed journal ready callback from a retired editor cannot touch its UI signals or the next editor', async () => {
    let release: (() => void) | undefined;
    const receiptReady = new Promise<void>(resolve => { release = resolve; });
    const old = featureFixture({ bot, receiptReady, retireUISignals: true }); old.element('bot');
    old.unmount();
    const next = featureFixture({ bot }); const reopened = next.element('bot'); await settle();
    release?.(); await settle();
    expect(old.retiredAccesses()).toBe(0); expect(old.calls).toHaveLength(0); expect(old.done()).toBe(0);
    expect(next.state(reopened).error()).toBe(''); expect(next.state(reopened).uncertain()).toBe(false);
    expect(next.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('task TimeFields consume NativeAppearance 12h and explicit Monday order without an extra preference fetch', async () => {
    const f = featureFixture({ item, appearance: { timeFormatPreference: '12h', weekStartPreference: 'monday' } }); const root = f.element('task'); await settle();
    const once = f.find(root, node => node.props.testID === 'features-once-time'); expect(once.props.hourCycle).toBe('h12');
    const weekdays = f.find(root, node => node.type === 'Each' && Array.isArray(node.props.of) && node.props.of.length === 7);
    expect(record((weekdays.props.of as unknown[])[0]).day).toBe(1);
    expect(f.calls.some(call => call.path === '/api/config/settings')).toBe(false);
  });

  it('confirmed deletion invalidates before refresh and cancellation sends no DELETE', async () => {
    const f = featureFixture({ item }); const root = f.element('task'); await settle();
    const remove = f.find(root, node => node.type === 'Button' && node.children.some(child => child && typeof child === 'object' && 'children' in child && (child as { children: unknown[] }).children.includes('settings.common.actions.delete')));
    (remove.props.onPress as () => void)(); await settle(); expect(f.calls.some(call => call.method === 'DELETE')).toBe(false);
    f.setAnswer('delete'); (remove.props.onPress as () => void)(); await settle();
    expect(f.order).toContain('DELETE'); expect(f.order.indexOf('invalidate')).toBeLessThan(f.order.indexOf('refresh')); expect(f.done()).toBe(1);
  });

  it('dirty native Back and Cancel preserve the draft until explicit discard', async () => {
    const f = featureFixture({ bot }); const root = f.element('bot'); await settle();
    expect(root.props.headerBackTitle).toBe(''); expect(root.props.popOnBack).toBe(true);
    (f.find(root, node => node.props.testID === 'features-bot-name').props.onChange as (event: { value: string }) => void)({ value: 'Unsaved' });
    (root.props.onBackPress as () => void)(); await settle(); expect(f.done()).toBe(0); expect(f.dialogs).toHaveLength(1);
    (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(f.calls.find(call => call.method === 'PATCH')?.body).toMatchObject({ name: 'Unsaved' });
    const other = featureFixture({ item }); const task = other.element('task'); await settle();
    (other.find(task, node => node.props.testID === 'features-task-name').props.onChange as (event: { value: string }) => void)({ value: 'Draft' });
    other.setAnswer('discard'); (other.find(task, node => node.props.testID === 'features-task-cancel').props.onPress as () => void)(); await settle();
    expect(other.done()).toBe(1); expect(other.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('committed-but-unsynced save is not replayed; Done retries only refresh', async () => {
    const f = featureFixture({ item, request: async call => {
      if (call.method === 'PATCH') return { task: record(call.body).task, schedulerSynced: false };
      return call.path.startsWith('/api/agent') ? [] : { schemaVersion: 1, providers: [] };
    } }); const root = f.element('task'); await settle(); const save = (root.props.headerRight as { props: { onPress: () => void } }).props.onPress;
    save(); await settle(); expect(f.state(root).committed()).toBe(true); expect(f.state(root).notice()).toContain('SYNC_PENDING'); expect(f.done()).toBe(0);
    save(); await settle(); expect(f.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    await f.state(root).perform(f.state(root).finish, true); expect(f.done()).toBe(1);
  });

  it('failed save retains editability and draft; stale Host cannot accept a completion', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    const f = featureFixture({ item, request: async call => {
      if (call.method === 'PATCH') return new Promise(done => { resolve = done; });
      return call.path.startsWith('/api/agent') ? [] : { schemaVersion: 1, providers: [] };
    } }); const root = f.element('task'); await settle(); (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    f.changeHost(); resolve?.({ task: item.task }); await settle();
    expect(f.state(root).committed()).toBe(false); expect(f.order).not.toContain('invalidate'); expect(f.done()).toBe(0);
  });

  it('cron uses the real Web parser validation before any write and offers its real examples', async () => {
    const f = featureFixture({ item: { ...item, task: { ...item.task, schedule: { kind: 'cron', cron: 'not cron', timezone: 'UTC' } } } });
    const root = f.element('task'); await settle(); (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(f.state(root).error()).toContain('sessions.scheduledTasks.editor.validation.cronInvalid');
    expect(f.calls.some(call => call.method === 'PATCH')).toBe(false);
    const examples = f.find(root, node => node.type === 'Each' && Array.isArray(node.props.of) && record(node.props.of[0]).expression === '*/5 * * * *');
    expect(examples.props.of).toHaveLength(5);
  });
});
