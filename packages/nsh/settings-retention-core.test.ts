import { expect, test } from 'vitest';
import { createRetentionRecheck, retentionCandidates, scanRetentionCatalog } from './settings-retention-core';
import { createRetentionController } from './settings-retention-controller';

const now = 200 * 86_400_000;
const row = (id: string, days = 60, extra: Record<string, unknown> = {}) => ({ id, title: id, location: { directory: '/fixture/project' }, time: { created: now - days * 86_400_000 }, ...extra });

test('full cursor authority walks filtered-empty pages and preserves the Web most-recent-five policy', async () => {
  const paths: string[] = [];
  const catalog = await scanRetentionCatalog(async path => {
    paths.push(path);
    return paths.length === 1
      ? { data: [row('system', 1, { metadata: { yuri: { assistant: { assistantID: 'bot' } } } })], cursor: { next: 'opaque/+==' } }
      : { data: [...Array.from({ length: 5 }, (_, index) => row(`keep-${index}`, index + 1)), row('expired'), row('boundary', 30), row('shared', 60, { share: {} }), row('child', 60, { parentID: 'expired' })], cursor: {} };
  });
  expect(paths).toEqual(['/api/session?limit=500', '/api/session?limit=500&cursor=opaque%2F%2B%3D%3D']);
  expect(retentionCandidates(catalog, { days: 30, now, action: 'archive', protectedIDs: new Set(), activeIDs: new Set() }).map(item => item.id)).toEqual(['expired']);
});

test.each([[], { data: [], partial: true, cursor: {} }, { data: [] }, { data: [], cursor: { next: 3 } }, { data: [row('bad', 60, { time: { updated: '1' } })], cursor: {} }])('incomplete catalog is unknown, never an authoritative empty success: %j', async value => {
  await expect(scanRetentionCatalog(async () => value)).rejects.toThrow();
});

test('repeating cursors and changing duplicate identities invalidate authority', async () => {
  await expect(scanRetentionCatalog(async () => ({ data: [], cursor: { next: 'loop' } }))).rejects.toThrow('repeating-cursor');
  await expect(scanRetentionCatalog(async () => ({ data: [row('same')], cursor: { next: 'page' } }))).rejects.toThrow();
});

test('live child protects ancestors and delete never cascades into any child; all Web system exclusions survive', async () => {
  const catalog = await scanRetentionCatalog(async () => ({ cursor: {}, data: [
    ...Array.from({ length: 5 }, (_, index) => row(`keep-${index}`, 1)), row('root'), row('running-child', 1, { parentID: 'root' }),
    row('ordinary'), row('current'), row('assistant', 60, { metadata: { yuri: { assistant: { assistantID: 'bot' } } } }),
    row('task', 60, { metadata: { yuri: { scheduledTask: { taskID: 'task' } } } }), row('small', 60, { metadata: { yuri: { smallModel: { purpose: 'title' } } } }),
    row('llm', 60, { metadata: { yuri: { llm: { purpose: 'title' } } } }), row('[Assistant] hidden'), row('smartfetch-secondary'),
    row('contact', 60, { metadata: { yuri: { assistant: { assistantID: 'bot' }, assigned: { from: 'contact' } } } }), row('archived', 60, { time: { updated: 1, archived: 10 } }),
  ] }));
  const options = { days: 30, now, action: 'archive' as const, protectedIDs: new Set(['current']), activeIDs: new Set(['running-child']) };
  expect(retentionCandidates(catalog, options).map(item => item.id)).toEqual(['ordinary', 'contact']);
  expect(retentionCandidates(catalog, { ...options, activeIDs: new Set(), action: 'delete' }).map(item => item.id)).toEqual(['ordinary', 'contact']);
});

test('restored delete ACK survives failed reads and is verified without replay, even after remount', async () => {
  const journalKey = 'yuri.session-retention.journal:fixture-host';
  const memory = new Map<string, string>([[journalKey, JSON.stringify([{ id: 'expired', directory: '/fixture/project', action: 'delete', status: 'ack' }])]]);
  const storage = { getItem: async (key: string) => memory.get(key) ?? null, setItem: async (key: string, value: string) => { memory.set(key, value); } };
  let deletes = 0, failCatalog = true, missing = false;
  const send = async (path: string, method = 'GET') => {
    if (path === '/api/config/settings') return { autoDeleteEnabled: false, autoDeleteAfterDays: 30, sessionRetentionAction: 'delete' };
    if (path === '/api/session/active') return { data: {} };
    if (path.startsWith('/api/session?')) {
      if (failCatalog) throw new Error('refresh-failed');
      return { data: [...Array.from({ length: 5 }, (_, index) => row(`keep-${index}`, 1)), ...(deletes ? [] : [row('expired')])], cursor: {} };
    }
    if (path === '/api/session/expired' && method === 'DELETE') { deletes++; throw new Error('forbidden'); }
    if (path === '/api/session/expired') {
      if (missing) throw Object.assign(new Error('not-found'), { status: 404 });
      throw new Error('detail-unavailable');
    }
    throw new Error('unexpected ' + path);
  };
  const options = { send, storage, scope: 'fixture-host', current: () => true, protectedIDs: () => new Set<string>(), now: () => now };
  const controller = createRetentionController(options);
  await controller.load();
  await controller.scan(); await controller.retry('expired');
  expect(controller.snapshot().results).toMatchObject([{ id: 'expired', status: 'ack', action: 'delete' }]);
  expect(controller.snapshot().count).toBeNull();
  const restored = createRetentionController(options);
  await restored.load();
  missing = true;
  await restored.retry('expired');
  expect(restored.snapshot().results).toMatchObject([{ status: 'completed' }]);
  expect(JSON.parse(memory.get(journalKey)!)).toMatchObject([{ status: 'completed' }]);
  failCatalog = false;
  await restored.scan();
  expect(deletes).toBe(0);
});

test('root and section share one cold preference read and both wait for its completion', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const controller = createRetentionController({ scope: 'fixture', current: () => true, protectedIDs: () => new Set(),
    storage: { getItem: async () => { await gate; return null; }, setItem: async () => {} },
    send: async () => { reads++; return {}; },
  });
  const root = controller.load();
  const section = controller.load();
  let sectionFinished = false;
  void section.then(() => { sectionFinished = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sectionFinished).toBe(false);
  release(); await Promise.all([root, section]);
  expect(reads).toBe(1);
  expect(controller.snapshot().ready).toBe(true);
});

test('per-item revalidation does not rescan or sort a 10000-session catalog', async () => {
  const catalog = await scanRetentionCatalog(async () => ({ data: Array.from({ length: 10000 }, (_, index) => row(`scale-${index}`, index < 5 ? 1 : 60)), cursor: {} }));
  let historicalReads = 0;
  for (const session of catalog) Object.defineProperty(session.time, 'updated', { get: () => { historicalReads++; return undefined; } });
  const recheck = createRetentionRecheck(catalog, { action: 'archive', days: 30, now });
  historicalReads = 0;
  for (let index = 5; index < 105; index++) expect(recheck(catalog[index], { activeIDs: new Set(), protectedIDs: new Set(), now })).toBe(true);
  expect(historicalReads).toBeLessThanOrEqual(100);
  expect(recheck(catalog[5], { activeIDs: new Set(['scale-5']), protectedIDs: new Set(), now })).toBe(false);
});

test('blocked admission writes no intent or cooldown, even when journal storage is unavailable', async () => {
  let diskFailed = true, writes = 0;
  const storage = new Map<string, string>();
  const rows = [...Array.from({ length: 5 }, (_, index) => row(`keep-${index}`, 1)), row('expired')];
  const controller = createRetentionController({ scope: 'disk', current: () => true, protectedIDs: () => new Set(), now: () => now,
    storage: { getItem: async key => storage.get(key) ?? null, setItem: async (key, value) => { if (diskFailed && key.includes('.journal:')) throw new Error('disk'); storage.set(key, value); } },
    send: async (path, method = 'GET') => {
      if (path === '/api/config/settings') return {};
      if (path === '/api/session/active') return { data: {} };
      if (path.startsWith('/api/session?')) return { data: rows, cursor: {} };
      if (method === 'PUT') { writes++; return { session: row('expired', 60, { time: { created: 1, archived: now } }) }; }
      return row('expired');
    },
  });
  await controller.load(); const plan = await controller.prepare(); await controller.confirm(plan!);
  expect(writes).toBe(0);
  expect(controller.snapshot()).toMatchObject({ error: 'admission', count: 1, results: [], lastRunAt: null });
  expect(storage.has('yuri.session-retention.journal:disk')).toBe(false);
  diskFailed = false; await controller.retry('expired');
  expect(writes).toBe(0);
});
