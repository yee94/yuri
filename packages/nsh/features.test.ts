import { describe, expect, it, vi } from 'vitest';
import { bot, featureFixture, item, settle } from './tests/features-fixture';
import { record } from './model';
import * as nativeCron from './features-cron';
import * as webCron from '../ui/src/lib/cron';
import { createHost } from './tests/features-host.js';
import { foundationCronPreview } from './features-schedule-date';

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
