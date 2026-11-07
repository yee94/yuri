import { describe, expect, it } from 'vitest';
import { createHistoryImport, type HistoryImportClock } from './history-import-core';
import { createHistoryImportTestHost, historyImportTestScope, syntheticImportJob, syntheticImportScan } from './history-import-test-host';
import { historyPreviewLimit, historySources, importRoute, NativeHistoryImportError, parseNativeImportJob, parseNativeImportJobs, parseNativeImportScan, parseNativeImportStates } from './history-import-protocol';
import type { SettingsRequest } from './settings-protocol';

function clock() {
  let serial = 0, now = 0;
  const work = new Map<number, { run: () => void; ms: number }>();
  const timer: HistoryImportClock = { schedule(run, ms) { const id = ++serial; work.set(id, { run, ms }); return id; }, cancel(id) { if (typeof id === 'number') work.delete(id); } };
  return { timer, work, now: () => now, advance(ms: number) { now += ms; }, tick() { const item = work.entries().next().value; if (!item) throw new Error('No pending clock'); work.delete(item[0]); item[1].run(); } };
}
async function drain(owner: ReturnType<typeof createHistoryImport>) { for (let index = 0; index < 100; index++) await Promise.resolve(); }
function fixture(options: Parameters<typeof createHistoryImportTestHost>[0] = {}) {
  const host = createHistoryImportTestHost({ allow: ['scan', 'imported', 'start', 'resume', 'dismiss', 'cancel'], ...options });
  let live = true, complete = 0;
  const ended: string[][] = [];
  const send: SettingsRequest = async (path, method = 'GET', body) => {
    const response = host.raw('runtime.request', { path, method, expectedHost: historyImportTestScope, ...(body === undefined ? {} : { body }) }) as { status: number; body: unknown };
    if (response.status >= 300) throw new NativeHistoryImportError((response.body as { code: string }).code, response.status);
    return response.body;
  };
  const time = clock();
  const owner = createHistoryImport({ send, current: () => live, directory: '/fixture/history', clock: time.timer, now: time.now, onComplete: () => { complete++; }, onJobsSettled: ids => ended.push([...ids]) });
  return { owner, host, send, time, ended, completed: () => complete, retire: () => { live = false; } };
}
async function opened(options: Parameters<typeof createHistoryImportTestHost>[0] = {}) { const f = fixture(options); f.owner.demand('background', true, 'tasks'); await drain(f.owner); f.owner.demand('tour', true); await drain(f.owner); return f; }
async function scanned(options: Parameters<typeof createHistoryImportTestHost>[0] = {}) { return opened(options); }

describe('native history import read/selection/preview contracts', () => {
  it('background entry polls only jobs; entering and leaving import changes only the demanded read lane', async () => {
    const f = fixture(); f.owner.demand('root', true, 'tasks'); await drain(f.owner);
    f.time.tick(); await drain(f.owner);
    expect(f.host.audit().requests.map(request => request.path)).toEqual([importRoute('jobs'), importRoute('jobs')]);
    const before = f.host.audit().requests.length;
    f.owner.demand('step', true); await drain(f.owner);
    expect(f.host.audit().requests.slice(before).map(request => request.path)).toEqual([importRoute('job'), importRoute('scan'), importRoute('imported')]);
    const scan = f.owner.snapshot().scan;
    f.owner.demand('step', false); const hidden = f.host.audit().requests.length; f.time.tick(); await drain(f.owner);
    expect(f.host.audit().requests.slice(hidden).map(request => request.path)).toEqual([importRoute('jobs')]);
    expect(f.owner.snapshot().scan).toBe(scan); expect(f.time.work.size).toBe(1); expect(f.host.audit().mutations).toEqual([]);
  });
  it('a pending jobs read admits exactly one later job read when import becomes visible', async () => {
    const f = fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const owner = createHistoryImport({ current: () => true, directory: '/fixture/history', send: async (...args) => { const result = await f.send(...args); if (args[0] === importRoute('jobs')) await wait; return result; } });
    owner.demand('root', true, 'tasks'); owner.demand('step', true);
    expect(f.host.audit().requests.map(request => request.path)).toEqual([importRoute('jobs')]);
    release(); await drain(owner);
    expect(f.host.audit().requests.map(request => request.path)).toEqual([importRoute('jobs'), importRoute('job'), importRoute('scan'), importRoute('imported')]);
  });
  it('background read failure stays unknown and never reads latest or scans to manufacture success', async () => {
    const f = fixture(); f.host.script('jobs', { status: 503 }); f.owner.demand('root', true, 'tasks'); await drain(f.owner);
    expect(f.owner.snapshot()).toMatchObject({ jobs: null, jobsReady: false, jobReady: false, scan: null, errors: { jobs: 'import_failed' } });
    expect(f.host.audit().requests).toEqual([{ path: importRoute('jobs'), method: 'GET' }]);
    await f.owner.retry(); expect(f.owner.snapshot()).toMatchObject({ jobs: [], jobsReady: true, jobReady: false });
    expect(f.host.audit().requests.every(request => request.path === importRoute('jobs'))).toBe(true);
  });
  it('background-only replacement reconciles a known ACK via exact id without reading latest or replaying start', async () => {
    const f = await scanned(); f.owner.select('claude', true); f.host.script('job?id=synthetic-start-1', { status: 503 }); await f.owner.proceed();
    expect(f.owner.snapshot().pending).toMatchObject({ id: 'synthetic-start-1', acknowledged: true });
    f.owner.demand('tour', false); const paths: string[] = [];
    await f.owner.replaceLane({ current: () => true, send: async (path, method, body) => { paths.push(path); return f.send(path, method, body); } });
    expect(paths).toEqual([importRoute('jobs'), importRoute('job?id=synthetic-start-1')]);
    expect(f.owner.snapshot().pending).toBeNull(); expect(f.host.audit().mutations).toEqual(['start']);
  });
  it('Tour entry automatically scans on successful non-running job, independent of background catalog failure', async () => {
    const f = fixture(); f.host.script('jobs', { status: 503 }); f.owner.demand('real-tour', true); await drain(f.owner);
    expect(f.owner.snapshot().scan?.sessions).toHaveLength(25);
    expect(f.host.audit().requests.filter(request => request.path.endsWith('/scan'))).toHaveLength(1);
    expect(f.owner.primary().disabled).toBe(false); expect(f.host.audit().mutations).toEqual([]);
  });
  it('running jobs suppress automatic scan, and the running-to-completed edge admits discovery while removing the header/list row', async () => {
    const f = fixture({ jobs: [syntheticImportJob('running')] }); f.owner.demand('real-tour', true); await drain(f.owner);
    expect(f.host.audit().requests.filter(request => request.path.endsWith('/scan'))).toHaveLength(0); expect(f.owner.headerJob()?.id).toBe('running');
    f.host.replace(syntheticImportJob('running', 'completed')); await f.owner.refresh();
    expect(f.host.audit().requests.filter(request => request.path.endsWith('/scan'))).toHaveLength(1); expect(f.owner.headerJob()).toBeNull(); expect(f.owner.tasks()).toEqual([]);
  });
  it('reopening within 60 seconds uses cached samples; stale reopen rescans without a cache timer', async () => {
    const f = fixture(); f.owner.demand('real-tour', true); await drain(f.owner); f.owner.select('claude', true);
    const prior = f.owner.snapshot().scan; f.owner.demand('real-tour', false); f.time.advance(59_999); f.owner.demand('real-tour', true); await drain(f.owner);
    expect(f.owner.snapshot().scan).toBe(prior); expect(f.host.audit().requests.filter(request => request.path.endsWith('/scan'))).toHaveLength(1);
    f.owner.demand('real-tour', false); f.time.advance(1); f.owner.demand('real-tour', true); await drain(f.owner);
    expect(f.host.audit().requests.filter(request => request.path.endsWith('/scan'))).toHaveLength(2); expect(f.owner.snapshot().selected).toEqual(['claude']); expect(f.time.work.size).toBe(0);
  });
  it('five-minute unobserved cache GC is lazy and drops samples/badges without discarding selection or journaling a write', async () => {
    const f = fixture(); f.owner.demand('real-tour', true); await drain(f.owner); f.owner.select('codex', true); f.owner.demand('real-tour', false); f.time.advance(300_000);
    f.host.script('scan', { status: 503 }); f.owner.demand('real-tour', true); await drain(f.owner);
    expect(f.owner.snapshot()).toMatchObject({ scan: null, badges: null, selected: ['codex'], errors: { scan: 'import_failed' } }); expect(f.time.work.size).toBe(0); expect(f.host.audit().mutations).toEqual([]);
  });
  it('failed automatic discovery has no implicit retry/focus refetch; the actual Retry explicitly refetches scan', async () => {
    const f = fixture(); f.host.script('scan', { status: 503 }); f.owner.demand('real-tour', true); await drain(f.owner);
    for (let index = 0; index < 10; index++) await f.owner.refresh(); f.owner.demand('real-tour', false); f.owner.demand('real-tour', true); await drain(f.owner);
    expect(f.host.audit().requests.filter(request => request.path.endsWith('/scan'))).toHaveLength(1);
    await f.owner.retry(); expect(f.host.audit().requests.filter(request => request.path.endsWith('/scan'))).toHaveLength(2); expect(f.owner.snapshot().errors.scan).toBeUndefined();
  });
  it('a hidden Tour does not admit discovery when the shared tasks GET completes, and hidden scans cannot publish new previews', async () => {
    const f = fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const owner = createHistoryImport({ current: () => true, directory: '/fixture/history', send: async (...args) => { const value = await f.send(...args); if (args[0].endsWith('/job')) await wait; return value; } });
    owner.demand('background', true, 'tasks'); owner.demand('real-tour', true); owner.demand('real-tour', false); release(); await drain(owner);
    expect(f.host.audit().requests.every(request => request.method === 'GET')).toBe(true); expect(owner.snapshot().scan).toBeNull();
    owner.demand('real-tour', true); await drain(owner); expect(owner.snapshot().scan?.sessions).toHaveLength(25);
  });
  it('does no work at construction; background catalog open/restore reads only jobs', async () => {
    const f = fixture(); expect(f.host.audit().requests).toEqual([]);
    f.owner.demand('tour', true, 'tasks'); await drain(f.owner);
    expect(f.host.audit().requests).toEqual([{ path: importRoute('jobs'), method: 'GET' }]);
    expect(f.owner.snapshot()).toMatchObject({ scan: null, selected: [], jobReady: false, jobsReady: true });
    f.owner.demand('tour', false); f.owner.demand('tour', true, 'tasks'); await drain(f.owner);
    expect(f.host.audit().requests.every(request => request.method === 'GET')).toBe(true); expect(f.time.work.size).toBe(1);
  });
  it('requires authoritative initial GETs before scan/start; unknown is never empty success', async () => {
    const f = fixture(); f.host.script('job', { status: 503 }); f.owner.demand('tour', true); await drain(f.owner);
    await f.owner.scan(); await f.owner.proceed(); expect(f.owner.snapshot().scan).toBeNull(); expect(f.owner.primary().disabled).toBe(true);
    expect(f.host.audit().requests).toHaveLength(1); await f.owner.retry(); await f.owner.scan(); expect(f.owner.snapshot().scan?.sessions).toHaveLength(25);
  });
  it('scans the actual five sources with five previews/counts and requests badges using the returned scan identity', async () => {
    const f = await scanned();
    expect(f.host.audit().requests.filter(request => request.method === 'POST')).toEqual([
      { path: importRoute('scan'), method: 'POST', body: { sources: historySources.map(source => source.id), limitPerSource: historyPreviewLimit, includeCounts: true } },
      { path: importRoute('imported'), method: 'POST', body: { scanID: 'synthetic-scan', directory: '/fixture/history' } },
    ]);
    expect(f.owner.snapshot().badges?.states['claude-0']).toBe('imported'); expect(f.owner.snapshot().badges?.states['claude-1']).toBe('unknown');
    expect(f.owner.snapshot().scan?.installations).toMatchObject({ claude: true, codex: false, cursor: null });
    expect(f.owner.snapshot().scan?.counts?.cursor?.value).toBeNull(); expect(f.host.audit().mutations).toEqual([]);
  });
  it('failed rescan keeps every prior source/preview/count/selection without pretending it is current', async () => {
    const f = await scanned(); const prior = f.owner.snapshot().scan;
    f.owner.select('cursor', true); f.host.script('scan', { status: 500 }); await f.owner.scan();
    expect(f.owner.snapshot()).toMatchObject({ scan: prior, selected: ['cursor'], errors: { scan: 'import_failed' } }); expect(f.owner.snapshot().scan).toBe(prior); expect(f.owner.primary().disabled).toBe(true);
    await f.owner.scan(); expect(f.owner.snapshot().errors.scan).toBeUndefined(); expect(f.owner.snapshot().selected).toEqual(['cursor']);
  });
  it('badge failure preserves previews, suppresses authoritative badges, and can retry the same scan', async () => {
    const f = await opened(); f.host.script('imported', { status: 500 }); await f.owner.scan();
    expect(f.owner.snapshot().scan?.sessions).toHaveLength(25); expect(f.owner.snapshot().badges).toBeNull(); expect(f.owner.snapshot().errors.badges).toBe('import_failed');
    await f.owner.refreshBadges(); expect(f.owner.snapshot().badges?.states['claude-0']).toBe('imported'); expect(f.owner.snapshot().errors.badges).toBeUndefined();
  });
  it('empty/no-selected next is local completion, never an all-sources import', async () => {
    const f = await scanned(); await f.owner.proceed(); expect(f.completed()).toBe(1); expect(f.host.audit().mutations).toEqual([]);
    f.owner.select('claude', true); f.owner.select('claude', true); f.owner.select('codex', true); f.owner.select('claude', false);
    expect(f.owner.snapshot().selected).toEqual(['codex']);
  });
});

describe('real source-job write-once and exact full-receipt recovery', () => {
  it('start sends only selected source intent, accepts ID, exact-GET verifies it and continues in background without replay', async () => {
    const f = await scanned(); f.owner.select('dsh', true); f.owner.select('opencode', true); await f.owner.proceed();
    expect(f.owner.snapshot()).toMatchObject({ acceptedID: 'synthetic-start-1', pending: null, job: { id: 'synthetic-start-1', state: 'running' } });
    expect(f.host.audit().requests.filter(request => request.path.endsWith('/start'))).toEqual([{ path: importRoute('start'), method: 'POST', body: { sources: ['dsh', 'opencode'], directory: '/fixture/history', confirm: true } }]);
    expect(f.host.audit().requests.at(-1)?.path).toBe(importRoute('job?id=synthetic-start-1'));
    await f.owner.proceed(); expect(f.completed()).toBe(1); expect(f.host.audit().mutations).toEqual(['start']);
    f.owner.select('claude', true); expect(f.owner.snapshot().selected).toEqual(['dsh', 'opencode']);
  });
  it('ACK+failed GET keeps exact ID/journal/prior draft; Retry only GETs', async () => {
    const f = await scanned(); f.owner.select('claude', true); f.host.script('job?id=synthetic-start-1', { status: 503 }); await f.owner.proceed();
    expect(f.owner.snapshot()).toMatchObject({ acceptedID: 'synthetic-start-1', pending: { action: 'start', id: 'synthetic-start-1', acknowledged: true }, selected: ['claude'] });
    const count = f.host.audit().requests.length; await f.owner.retry(); expect(f.owner.snapshot().pending).toBeNull();
    expect(f.host.audit().requests.slice(count).every(request => request.method === 'GET')).toBe(true); expect(f.host.audit().mutations).toEqual(['start']);
  });
  it('lost start reply never guesses ownership from newest job or replays it, even after page restore', async () => {
    const f = await scanned(); f.owner.select('codex', true); f.host.script('start', { lost: true }); await f.owner.proceed();
    expect(f.owner.snapshot().pending).toMatchObject({ action: 'start', id: null, acknowledged: false, sources: ['codex'] });
    await f.owner.retry(); expect(f.owner.snapshot().job?.id).toBe('synthetic-start-1'); expect(f.owner.snapshot().acceptedID).toBeNull(); expect(f.owner.snapshot().pending).not.toBeNull();
    f.owner.demand('tour', false); f.owner.demand('tour', true); await drain(f.owner); await f.owner.proceed();
    expect(f.host.audit().mutations).toEqual(['start']); expect(f.owner.snapshot().errors.mutation).toBe('import_result_unknown');
  });
  it('a success-shaped placeholder is not a full receipt or permission to retry', async () => {
    const f = await scanned(); f.owner.select('claude', true); f.host.script('start', { malformed: true }); await f.owner.proceed(); await f.owner.retry();
    expect(f.owner.snapshot().pending?.acknowledged).toBe(false); expect(f.owner.snapshot().acceptedID).toBeNull(); expect(f.host.audit().mutations).toEqual(['start']);
  });
  it('explicit 4xx rejection preserves draft and permits only another explicit start', async () => {
    const f = await scanned(); f.owner.select('cursor', true); f.host.script('start', { status: 409, code: 'import_busy' }); await f.owner.proceed();
    expect(f.owner.snapshot()).toMatchObject({ pending: null, selected: ['cursor'], errors: { mutation: 'import_busy' } });
    await f.owner.retry(); expect(f.host.audit().mutations).toEqual([]); await f.owner.proceed(); expect(f.host.audit().mutations).toEqual(['start']);
  });
  it('a wrong-ID exact receipt is rejected without replacing valid prior progress', async () => {
    const job = syntheticImportJob('stable'); let bad = false;
    const f = fixture({ jobs: [job] });
    const owner = createHistoryImport({ current: () => true, directory: '/fixture/history', send: (...args) => bad && args[0].includes('job?id=stable') ? Promise.resolve(syntheticImportJob('wrong')) : f.send(...args) });
    owner.demand('tour', true); await drain(owner); const prior = owner.snapshot().job; bad = true; await owner.inspect('stable');
    expect(owner.snapshot().job).toBe(prior); expect(owner.snapshot().errors.receipt).toBe('invalid_import_response');
  });
  it('cooperative cancel is sent once while running even if ACK readback initially fails', async () => {
    const f = await opened({ jobs: [syntheticImportJob('active')] });
    f.host.script('job?id=active', { status: 503 }); await f.owner.cancel('active'); expect(f.owner.snapshot().pending?.action).toBe('cancel');
    await f.owner.cancel('active'); expect(f.owner.snapshot().cancelRequested).toEqual(['active']); await f.owner.cancel('active');
    expect(f.host.audit().mutations).toEqual(['cancel']); f.host.replace(syntheticImportJob('active', 'cancelled')); await f.owner.refresh(); expect(f.owner.snapshot().cancelRequested).toEqual([]);
  });
  it('resume uses only original stored id/confirm, exact verifies ACK and never changes source intent', async () => {
    const f = await opened({ jobs: [syntheticImportJob('old', 'interrupted')] }); await f.owner.resume('old');
    expect(f.host.audit().requests.find(request => request.path.endsWith('/resume'))?.body).toEqual({ id: 'old', confirm: true }); expect(f.owner.snapshot().job?.state).toBe('running');
    expect(f.host.audit().mutations).toEqual(['resume']);
  });
  it('resume_request_missing switches only that failed row to Remove; dismissal verifies its actual id', async () => {
    const old = { ...syntheticImportJob('legacy', 'interrupted'), resumable: false }, other = syntheticImportJob('other', 'cancelled');
    const f = await opened({ jobs: [old, other] }); await f.owner.resume('legacy');
    expect(f.owner.snapshot().removeActions).toEqual(['legacy']); expect(f.owner.snapshot().errors.mutation).toBe('resume_request_missing'); expect(f.owner.tasks().find(task => task.job.id === 'other')?.removeAction).toBe(false);
    await f.owner.dismiss('legacy'); expect(f.owner.snapshot().jobs?.map(job => job.id)).toEqual(['other']); expect(f.owner.snapshot().pending).toBeNull(); expect(f.host.audit().mutations).toEqual(['dismiss']);
  });
  it('dismiss ACK+failed GET retains its journal and never removes unrelated jobs or repeats POST', async () => {
    const f = await opened({ jobs: [syntheticImportJob('old', 'cancelled'), syntheticImportJob('other', 'interrupted')] });
    f.host.script('job?id=old', { status: 503 }); await f.owner.dismiss('old'); expect(f.owner.snapshot().pending).toMatchObject({ action: 'dismiss', acknowledged: true });
    await f.owner.retry(); expect(f.owner.snapshot().pending).toBeNull(); expect(f.owner.snapshot().jobs?.map(job => job.id)).toEqual(['other']); expect(f.host.audit().mutations).toEqual(['dismiss']);
  });
  it('unknown resume/cancel reconcile only through exact public states, not stale receipts or summary counts', async () => {
    const f = await opened({ jobs: [syntheticImportJob('old', 'interrupted')] }); f.host.script('resume', { lost: true }); await f.owner.resume('old');
    expect(f.owner.snapshot().pending?.acknowledged).toBe(false); await f.owner.retry(); expect(f.owner.snapshot().pending).toBeNull(); expect(f.owner.snapshot().job?.state).toBe('running');
    f.host.script('cancel', { lost: true }); await f.owner.cancel('old'); await f.owner.retry(); expect(f.owner.snapshot().pending?.action).toBe('cancel');
    f.host.replace(syntheticImportJob('old', 'cancelled')); await f.owner.retry(); expect(f.owner.snapshot().pending).toBeNull(); expect(f.host.audit().mutations).toEqual(['resume', 'cancel']);
  });
});

describe('single timer, partial resources and lifecycle fences', () => {
  it('header/list terminal rules exactly distinguish accepted cancelled/interrupted jobs from historical or finished jobs', async () => {
    for (const state of ['completed', 'partial', 'cancelled', 'interrupted'] as const) {
      const f = await opened({ jobs: [syntheticImportJob('old', state)] }); expect(f.owner.headerJob()).toBeNull();
      expect(f.owner.tasks().length).toBe(['completed', 'partial'].includes(state) ? 0 : 1);
    }
    const f = await scanned(); f.owner.select('claude', true); await f.owner.proceed(); f.host.replace(syntheticImportJob('synthetic-start-1', 'interrupted')); await f.owner.refresh(); expect(f.owner.headerJob()?.state).toBe('interrupted');
    f.host.replace(syntheticImportJob('synthetic-start-1', 'partial')); await f.owner.refresh(); expect(f.owner.headerJob()).toBeNull(); expect(f.owner.primary().disabled).toBe(false);
  });
  it('same-Host operation replacement keeps drafts/preview and unknown start; replacement itself reads only job/jobs', async () => {
    const f = await scanned(); f.owner.select('claude', true); f.host.script('start', { lost: true }); await f.owner.proceed(); const prior = f.owner.snapshot().scan;
    const paths: string[] = []; await f.owner.replaceLane({ current: () => true, send: async (path, method, body) => { paths.push(`${method ?? 'GET'} ${path}`); return f.send(path, method, body); } });
    expect(f.owner.snapshot()).toMatchObject({ scan: prior, selected: ['claude'], pending: { action: 'start', id: null, acknowledged: false } }); expect(paths.every(value => value.startsWith('GET '))).toBe(true); expect(f.host.audit().mutations).toEqual(['start']);
  });
  it('late old-lane ACK cannot mutate the retained unknown journal or clear new-lane gates', async () => {
    const f = fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const owner = createHistoryImport({ current: () => true, directory: '/fixture/history', send: async (...args) => { const result = await f.send(...args); if (args[0].endsWith('/start')) await wait; return result; } });
    owner.demand('tour', true); await drain(owner); owner.select('claude', true); const pending = owner.proceed();
    for (let index = 0; index < 20 && !f.host.audit().mutations.length; index++) await Promise.resolve();
    await owner.replaceLane({ current: () => true, send: f.send }); release(); await pending;
    expect(owner.snapshot().pending).toMatchObject({ action: 'start', acknowledged: false, id: null }); expect(owner.snapshot().writing).toBe(false); expect(f.host.audit().mutations).toEqual(['start']);
  });
  it('two visible surfaces share one GET flight/timer; poll never rescans or posts and stops when all hidden', async () => {
    const f = fixture({ jobs: [syntheticImportJob('active')] }); f.owner.demand('tour', true); f.owner.demand('tasks', true, 'tasks'); await drain(f.owner);
    expect(f.host.audit().requests).toHaveLength(2); expect(f.time.work.size).toBe(1); expect([...f.time.work.values()][0].ms).toBe(1000);
    const scheduled = [...f.time.work.keys()];
    for (let index = 0; index < 50; index++) { f.owner.select('claude', true); f.owner.demand('tasks', true, 'tasks'); }
    expect(f.host.audit().requests).toHaveLength(2); expect(f.time.work.size).toBe(1);
    expect([...f.time.work.keys()]).toEqual(scheduled);
    f.time.tick(); await drain(f.owner); expect(f.host.audit().requests).toHaveLength(4); expect(f.host.audit().requests.every(request => request.method === 'GET')).toBe(true);
    f.owner.demand('tour', false); expect(f.time.work.size).toBe(1); f.owner.demand('tasks', false, 'tasks'); expect(f.time.work.size).toBe(0);
  });
  it('idle task catalog polls at Web 15s but an idle Tour never polls', async () => {
    const f = fixture(); f.owner.demand('tour', true); await drain(f.owner); expect(f.time.work.size).toBe(0); f.owner.demand('root', true, 'tasks'); await drain(f.owner); expect([...f.time.work.values()][0].ms).toBe(15_000);
    f.owner.demand('root', false, 'tasks'); expect(f.time.work.size).toBe(0); f.owner.dispose(); expect(f.time.work.size).toBe(0);
  });
  it('refresh failure keeps failed task rows and counts, isolates a valid exact receipt from the failed catalog', async () => {
    const f = await opened({ jobs: [syntheticImportJob('one', 'interrupted'), syntheticImportJob('two', 'cancelled')] }); const previous = f.owner.snapshot().jobs;
    f.host.script('jobs', { status: 503 }); await f.owner.refresh(); expect(f.owner.snapshot().jobs).toEqual(previous); expect(f.owner.tasks().map(task => task.stale)).toEqual([true, true]); expect(f.owner.snapshot().job?.id).toBe('two');
    await f.owner.refresh(); expect(f.owner.snapshot().errors.jobs).toBeUndefined();
  });
  it('unsupported GET stops polling without inventing empty source/task success', async () => {
    const f = fixture(); f.host.script('job', { status: 501 }); f.host.script('jobs', { status: 501 }); f.owner.demand('root', true, 'tasks'); await drain(f.owner);
    expect(f.owner.snapshot()).toMatchObject({ jobReady: false, jobsReady: false, scan: null, jobs: null, errors: { jobs: 'history_import_unsupported' } }); expect(f.owner.snapshot().errors.job).toBeUndefined(); expect(f.time.work.size).toBe(0);
  });
  it('completion removes only finished jobs and signals the existing project refresh port once per observed transition', async () => {
    const f = await opened({ jobs: [syntheticImportJob('one'), syntheticImportJob('two', 'cancelled')] });
    f.host.replace(syntheticImportJob('one', 'partial')); await f.owner.refresh(); await f.owner.refresh();
    expect(f.owner.snapshot().jobs?.map(job => job.id)).toEqual(['two']); expect(f.ended).toEqual([['one']]);
  });
  it('full partial receipts retain independent project/index failures and never resume finished work', async () => {
    const job = { ...syntheticImportJob('partial', 'partial'), results: [{ key: 'one', phase: 'session' as const, status: 'imported' as const, project: 'failed', index: 'failed', code: 'index_failed' }] };
    const f = await opened({ jobs: [job] }); await f.owner.inspect('partial'); expect(f.owner.snapshot().receipts.partial.results).toEqual(job.results); expect(f.owner.tasks()).toEqual([]);
    await f.owner.resume('partial'); expect(f.host.audit().mutations).toEqual([]);
  });
  it('retired owner cannot perform reads or writes or complete on a new Host', async () => {
    const f = await scanned(); const count = f.host.audit().requests.length; f.retire();
    f.owner.select('claude', true); await f.owner.scan(); await f.owner.refresh(); await f.owner.proceed(); await f.owner.resume('x');
    expect(f.host.audit().requests).toHaveLength(count); expect(f.completed()).toBe(0);
  });
  it('delayed old read cannot replace current state after hide; idle Tour restore admits automatic discovery', async () => {
    const f = fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const owner = createHistoryImport({ current: () => true, send: async (...args) => { const value = await f.send(...args); await wait; return value; } });
    owner.demand('tour', true); owner.demand('tour', false); release(); await drain(owner);
    expect(owner.snapshot().jobReady).toBe(false); expect(f.host.audit().requests.every(request => request.method === 'GET')).toBe(true); owner.demand('tour', true); await drain(owner); expect(owner.snapshot().jobReady).toBe(true); expect(f.host.audit().requests.filter(request => request.path.endsWith('/scan'))).toHaveLength(1);
  });
  it('double explicit submit starts exactly one job, even while its receipt is delayed', async () => {
    const f = await scanned(); f.owner.select('claude', true); await Promise.all([f.owner.proceed(), f.owner.proceed()]); expect(f.host.audit().mutations).toEqual(['start']);
  });

  it('a hidden in-flight start remembers its valid ACK; same-owner restore only reads its exact ID', async () => {
    const f = fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const owner = createHistoryImport({ current: () => true, directory: '/fixture/history', send: async (...args) => { const value = await f.send(...args); if (args[0] === importRoute('start')) await wait; return value; } });
    owner.demand('tour', true); await drain(owner); await owner.scan(); owner.select('claude', true); const flight = owner.proceed();
    for (let index = 0; index < 30 && !f.host.audit().mutations.length; index++) await Promise.resolve();
    owner.demand('tour', false); release(); await flight;
    expect(owner.snapshot().pending).toMatchObject({ id: 'synthetic-start-1', acknowledged: true });
    const before = f.host.audit().requests.length; owner.demand('tour', true); await drain(owner);
    expect(owner.snapshot().pending).toBeNull(); expect(f.host.audit().requests.slice(before).every(request => request.method === 'GET')).toBe(true); expect(f.host.audit().mutations).toEqual(['start']);
  });

  it('controller retains its construction sender/directory rather than borrowing changed input on retries', async () => {
    const f = fixture(); const options = { current: () => true, directory: '/fixture/history', send: f.send };
    const owner = createHistoryImport(options); owner.demand('tour', true); await drain(owner);
    options.send = async () => { throw new Error('borrowed_sender'); }; options.directory = '/wrong';
    await owner.scan(); owner.select('claude', true); await owner.proceed(); expect(f.host.audit().mutations).toEqual(['start']); expect(owner.directory).toBe('/fixture/history'); expect(owner.snapshot().errors).toEqual({});
  });

  it('inspecting another task retains its full receipt without changing Tour current-job authority', async () => {
    const first = syntheticImportJob('first', 'cancelled'), second = syntheticImportJob('second', 'interrupted');
    const f = await opened({ jobs: [first, second], latestID: 'second' }); const prior = f.owner.snapshot().job;
    await f.owner.inspect('first'); expect(f.owner.snapshot().job).toBe(prior); expect(f.owner.snapshot().receipts.first.id).toBe('first');
  });

  it('on known terminal transition badges revalidate once, not every poll, and failing badges keep their explicit retry lane', async () => {
    const f = await scanned(); f.owner.select('claude', true); await f.owner.proceed();
    f.host.replace(syntheticImportJob('synthetic-start-1', 'completed')); const before = f.host.audit().requests.filter(request => request.path.endsWith('/imported')).length;
    f.host.script('imported', { status: 503 }); await f.owner.refresh(); await f.owner.refresh();
    expect(f.host.audit().requests.filter(request => request.path.endsWith('/imported'))).toHaveLength(before + 1); expect(f.owner.snapshot().errors.badges).toBe('import_failed');
    await f.owner.refreshBadges(); expect(f.owner.snapshot().errors.badges).toBeUndefined();
  });

  it('completion subscriptions detach when a Tour is disposed without disposing the retained Host history owner', async () => {
    const f = await scanned(); let old = 0, reopened = 0;
    const stop = f.owner.observeCompletion(() => { old++; }); stop(); f.owner.observeCompletion(() => { reopened++; }); await f.owner.proceed();
    expect(old).toBe(0); expect(reopened).toBe(1); expect(f.owner.current()).toBe(true); expect(f.host.audit().mutations).toEqual([]);
  });

  it('unknown source-start remains blocked while another explicitly chosen task may be cancelled or dismissed', async () => {
    const f = await scanned({ jobs: [syntheticImportJob('old', 'cancelled')] }); f.owner.select('claude', true); f.host.script('start', { lost: true }); await f.owner.proceed();
    await f.owner.retry(); const unknown = f.owner.snapshot().pending;
    expect(unknown?.action).toBe('start'); expect(f.owner.tasks().find(task => task.job.id === 'old')?.busy).toBe(false);
    await f.owner.cancel('synthetic-start-1'); expect(f.owner.snapshot().pending?.action).toBe('start');
    await f.owner.dismiss('old'); expect(f.owner.snapshot().pending?.action).toBe('start'); expect(f.owner.snapshot().selected).toEqual(['claude']);
    expect(f.host.audit().mutations).toEqual(['start', 'cancel', 'dismiss']); await f.owner.proceed(); expect(f.host.audit().mutations).toEqual(['start', 'cancel', 'dismiss']);
  });

  it('an unknown cancel journal is isolated to that actual job while an unrelated failed task can be removed', async () => {
    const f = await opened({ jobs: [syntheticImportJob('running'), syntheticImportJob('failed', 'interrupted')], latestID: 'running' });
    f.host.script('cancel', { lost: true }); await f.owner.cancel('running');
    expect(f.owner.tasks().find(task => task.job.id === 'running')?.busy).toBe(true); expect(f.owner.tasks().find(task => task.job.id === 'failed')?.busy).toBe(false);
    await f.owner.dismiss('failed'); expect(f.owner.snapshot().pending).toMatchObject({ action: 'cancel', id: 'running', acknowledged: false });
    expect(f.host.audit().mutations).toEqual(['cancel', 'dismiss']); f.host.replace(syntheticImportJob('running', 'cancelled')); await f.owner.retry(); expect(f.owner.snapshot().pending).toBeNull();
  });

  it('public event methods do not rely on callers retaining a JavaScript this binding', async () => {
    const f = await scanned(), { proceed } = f.owner; await proceed(); expect(f.completed()).toBe(1);
  });

  it('receipt inspection never clears a failed canonical job read; a known running job still allows Web background continuation', async () => {
    const f = await opened({ jobs: [syntheticImportJob('active')] }); f.host.script('job', { status: 503 }); await f.owner.refresh();
    expect(f.owner.snapshot().errors.job).toBe('import_failed'); await f.owner.inspect('active');
    expect(f.owner.snapshot().errors.job).toBe('import_failed'); expect(f.owner.primary().disabled).toBe(false);
  });

  it('project refresh callback failure preserves authoritative task success and retries only that existing port explicitly', async () => {
    const f = fixture({ jobs: [syntheticImportJob('one')] }); let fail = true, attempts = 0;
    const owner = createHistoryImport({ current: () => true, send: f.send, onJobsSettled: async () => { attempts++; if (fail) throw new Error('project_refresh_failed'); } });
    owner.demand('root', true, 'tasks'); await drain(owner); f.host.replace(syntheticImportJob('one', 'completed')); await owner.refresh();
    expect(owner.snapshot().jobs).toEqual([]); expect(owner.snapshot().errors.jobs).toBeUndefined(); expect(owner.snapshot().errors.projects).toBe('project_refresh_failed');
    await owner.refresh(); expect(attempts).toBe(1); fail = false; await owner.retry(); expect(attempts).toBe(2); expect(owner.snapshot().errors.projects).toBeUndefined();
    expect(f.host.audit().mutations).toEqual([]);
  });
});

describe('real public types are validated at the native boundary', () => {
  it('round-trips full receipts, five-source samples and unknown imported badges without truncating received data', () => {
    const scan = syntheticImportScan(), job = syntheticImportJob('full', 'partial'); job.results = Array.from({ length: 80 }, (_, index) => ({ key: `${index}`, phase: 'session', status: index % 2 ? 'failed' : 'imported', code: 'synthetic_code' }));
    expect(parseNativeImportJob(job)).toEqual(job); expect(parseNativeImportScan(scan)).toEqual(scan); expect(parseNativeImportStates({ states: { 'claude-0': 'unknown' } }, scan)).toEqual({ states: { 'claude-0': 'unknown' } });
  });
  it('rejects malformed identities, counters, states, duplicate jobs and unrecognized scan/badge fields', () => {
    for (const value of [{}, true, { ...syntheticImportJob(), state: 'unknown' }, { ...syntheticImportJob(), completed: -1 }, { ...syntheticImportJob(), results: null }, { ...syntheticImportJob(), progress: { phase: 'downloading', completed: 0, total: 0 } }]) expect(() => parseNativeImportJob(value)).toThrow();
    expect(() => parseNativeImportJobs([syntheticImportJob(), syntheticImportJob()])).toThrow();
    expect(() => parseNativeImportScan({ ...syntheticImportScan(), counts: { claude: { value: -1, approximate: true } } })).toThrow();
    expect(() => parseNativeImportScan({ ...syntheticImportScan(), installations: { madeup: true } })).toThrow();
    expect(() => parseNativeImportStates({ states: { foreign: 'imported' } }, syntheticImportScan())).toThrow();
  });
});
