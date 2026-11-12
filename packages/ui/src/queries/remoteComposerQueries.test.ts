import { afterEach, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { HostRuntimeRegistry, type HostRuntimeDependencies } from '@/lib/remote-projects/registry';
import { ensureRemoteComposerSessions, remoteComposerFilesQueryOptions, remoteComposerSessionsQueryOptions } from './remoteComposerQueries';
import { remoteHostSummariesQueryOptions } from './remoteProjectQueries';
import { installedSkillsQueryOptions, readInstalledSkillsSnapshot, refreshInstalledSkillsQuery } from './installedSkillsQueries';
import { commandQueryOptions, readCommandsSnapshot, refreshCommandsQuery } from './commandQueries';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { compileChatComposerDelivery, legacyTextToAuthoredPlan } from '@/components/chat/chatComposerDelivery';

const localReads = vi.hoisted(() => ({ sessions: vi.fn(() => []), all: vi.fn(() => new Map()) }));
vi.mock('@/sync/sync-refs', async (original) => ({ ...await original<typeof import('@/sync/sync-refs')>(), getSyncSessions: localReads.sessions, getAllSyncSessionMap: localReads.all }));

function fixture() {
  const reads: string[] = [];
  let searchWait: Promise<void> | undefined;
  let summariesFail = false;
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'fixture', isCurrent: () => true,
    sdk: (location) => ({ file: { find: async (input: { location: { directory: string }; type: string }) => {
      reads.push(`${location.hostId}:${input.location.directory}:${input.type}`);
      await searchWait;
      return { data: [{ path: `${location.hostId}.ts`, type: 'file' }] };
    } } }) as unknown as ReturnType<HostRuntimeDependencies['sdk']>,
    fetch: async (path) => {
      reads.push(path);
      const hostId = path.includes('/a/') ? 'a' : 'b';
      if (path.endsWith('/summaries') && summariesFail) return Response.json({ code: 'unavailable' }, { status: 503 });
      if (path.endsWith('/summaries')) return Response.json({ hubId: 'hub', hostId, stale: false, directories: [{ directory: '/same', sessions: [{ id: 'same', title: hostId, time: { created: 1, updated: 2 } }] }] });
      if (path.includes('skills')) return Response.json({ skills: [{ name: hostId, path: `/skills/${hostId}`, description: hostId }] });
      return Response.json({ commands: [{ name: hostId, isBuiltIn: false }] });
    },
  });
  const hosts = ['a', 'b'].map((id) => ({ id, name: id, source: 'direct' as const, state: 'connected' as const, scopeGeneration: id }));
  registry.applyCatalog({ hubId: 'hub', supported: true, hosts, projects: [] });
  return { registry, hosts, reads, failSummaries: (fail: boolean) => { summariesFail = fail; }, holdSearch: (wait: Promise<void>) => { searchWait = wait; }, a: registry.resolve({ hubId: 'hub', hostId: 'a', directory: '/same' }), b: registry.resolve({ hubId: 'hub', hostId: 'b', directory: '/same' }) };
}
afterEach(() => { queryClient.clear(); vi.clearAllMocks(); });

test('sidebar, 50 picker opens and sibling directories share one summary request until invalidation', async () => {
  const { registry, a, reads } = fixture();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const sidebar = remoteHostSummariesQueryOptions(registry, 'a');
    await client.fetchQuery(sidebar);
    for (let i = 0; i < 50; i++) {
      const entry = registry.resolve({ ...a.location, directory: `/same/${i}` });
      await client.fetchQuery(remoteComposerSessionsQueryOptions(registry, entry));
    }
    expect(reads.filter((route) => route.endsWith('/summaries'))).toHaveLength(1);
    await client.invalidateQueries({ queryKey: sidebar.queryKey });
    await Promise.all([client.fetchQuery(sidebar), client.fetchQuery(remoteComposerSessionsQueryOptions(registry, a))]);
    expect(reads.filter((route) => route.endsWith('/summaries'))).toHaveLength(2);
  } finally { client.clear(); registry.dispose(); }
});

test('cached session catalogs still reject revoked scope and preserve data on failed authoritative refresh', async () => {
  const { registry, hosts, a, b, reads, failSummaries } = fixture();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const options = remoteHostSummariesQueryOptions(registry, 'a');
    const sessions = await ensureRemoteComposerSessions(client, registry, a);
    const snapshot = client.getQueryData(options.queryKey);
    await client.invalidateQueries({ queryKey: options.queryKey });
    failSummaries(true);
    await expect(ensureRemoteComposerSessions(client, registry, a)).rejects.toThrow();
    expect(client.getQueryData(options.queryKey)).toBe(snapshot);
    failSummaries(false);
    expect(await ensureRemoteComposerSessions(client, registry, a)).toEqual(sessions);
    expect((await ensureRemoteComposerSessions(client, registry, b))[0].title).toBe('b');
    registry.applyCatalog({ hubId: 'hub', supported: true, hosts: [{ ...hosts[0], scopeGeneration: 'replaced' }, hosts[1]], projects: [] });
    const count = reads.length;
    await expect(ensureRemoteComposerSessions(client, registry, a)).rejects.toThrow();
    expect(reads).toHaveLength(count);
  } finally { client.clear(); registry.dispose(); }
});

test('50 repeated file/directory searches share two requests; invalidation and other Hosts remain independent', async () => {
  const { registry, a, b, reads } = fixture();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const file = remoteComposerFilesQueryOptions(a, 'src', 80, { type: 'file' });
    const directory = remoteComposerFilesQueryOptions(a, 'src', 40, { type: 'directory' });
    await Promise.all(Array.from({ length: 50 }, () => Promise.all([client.fetchQuery(file), client.fetchQuery(directory)])));
    for (let i = 0; i < 50; i++) await Promise.all([client.fetchQuery(file), client.fetchQuery(directory)]);
    expect(reads).toEqual(['a:/same:file', 'a:/same:directory']);
    await client.fetchQuery(remoteComposerFilesQueryOptions(b, 'src', 80, { type: 'file' }));
    expect(reads).toHaveLength(3);
    await client.invalidateQueries({ queryKey: file.queryKey });
    await client.fetchQuery(file);
    expect(reads).toHaveLength(4);
  } finally { client.clear(); registry.dispose(); }
});

test('same cwd and session ID remain Host scoped through candidates, compiler and catalog snapshots', async () => {
  const { registry, a, b, reads } = fixture();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    for (const entry of [a, b]) {
      const files = await client.fetchQuery(remoteComposerFilesQueryOptions(entry, 'src', 80, { type: 'file' }));
      const sessions = await ensureRemoteComposerSessions(client, registry, entry);
      const skills = await refreshInstalledSkillsQuery(client, '/same', undefined, entry);
      await refreshCommandsQuery(queryClient, '/same', getRuntimeTransportIdentity(), entry);
      expect(readInstalledSkillsSnapshot(client, '/same', undefined, entry).map((skill) => skill.name)).toEqual([entry.location.hostId]);
      expect(readCommandsSnapshot('/same', getRuntimeTransportIdentity(), entry).map((command) => command.name)).toEqual([entry.location.hostId]);
      const compiled = compileChatComposerDelivery({ plan: legacyTextToAuthoredPlan(`@${entry.location.hostId} @session:same @src/a.ts`),
        agents: [], installedSkillNames: new Set(skills.map((skill) => skill.name)), sessions, directory: '/same', root: '/same' });
      expect(files[0].name).toBe(`${entry.location.hostId}.ts`);
      expect(compiled.text).toContain(`@${entry.location.hostId}`);
      expect(compiled.attachments.map((file) => file.serverPath)).toEqual(['/same/src/a.ts']);
      expect(compiled.semantics).toContainEqual({ type: 'session', sessionId: 'same' });
      expect(compiled.semantics).toContainEqual({ type: 'skill', skillName: entry.location.hostId });
    }
    expect(reads).toContain('a:/same:file'); expect(reads).toContain('b:/same:file');
    expect(localReads.sessions).not.toHaveBeenCalled(); expect(localReads.all).not.toHaveBeenCalled();
    expect(readInstalledSkillsSnapshot(client, '/same')).toEqual([]);
  } finally { client.clear(); registry.dispose(); }
});

test('revoked entry rejects before reads, retains its snapshots and never borrows the replacement catalog', async () => {
  const { registry, hosts, a, reads } = fixture();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const options = remoteComposerFilesQueryOptions(a, 'src', 80);
    const before = await client.fetchQuery(options);
    await client.fetchQuery(installedSkillsQueryOptions('/same', 'fixture', a));
    await client.fetchQuery(commandQueryOptions('/same', 'fixture', a));
    registry.applyCatalog({ hubId: 'hub', supported: true, hosts: [{ ...hosts[0], scopeGeneration: 'replacement' }, hosts[1]], projects: [] });
    const count = reads.length;
    await expect(options.queryFn({ signal: new AbortController().signal })).rejects.toThrow();
    await expect(ensureRemoteComposerSessions(client, registry, a)).rejects.toThrow();
    expect(() => readInstalledSkillsSnapshot(client, '/same', 'fixture', a)).toThrow();
    expect(() => readCommandsSnapshot('/same', 'fixture', a)).toThrow();
    expect(reads).toHaveLength(count);
    expect(client.getQueryData(options.queryKey)).toBe(before);
  } finally { client.clear(); registry.dispose(); }
});

test('explicit empty remote session catalog does zero Hub scans and does not infer pasted Hub titles', () => {
  const compiled = compileChatComposerDelivery({ plan: legacyTextToAuthoredPlan('@Hub title'), agents: [], installedSkillNames: new Set(), sessions: [], directory: '/same' });
  expect(compiled.semantics).toEqual([]);
  expect(localReads.sessions).not.toHaveBeenCalled(); expect(localReads.all).not.toHaveBeenCalled();
});

test('late search completion after Host retarget cannot replace the old successful snapshot', async () => {
  const { registry, hosts, a, holdSearch } = fixture();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const options = remoteComposerFilesQueryOptions(a, 'src', 80);
    const snapshot = await client.fetchQuery(options);
    let finish!: () => void;
    holdSearch(new Promise<void>((resolve) => { finish = resolve; }));
    const pending = client.fetchQuery({ ...options, staleTime: 0 });
    registry.applyCatalog({ hubId: 'hub', supported: true, hosts: [{ ...hosts[0], scopeGeneration: 'retarget' }, hosts[1]], projects: [] });
    finish();
    await expect(pending).rejects.toThrow();
    expect(client.getQueryData(options.queryKey)).toBe(snapshot);
  } finally { client.clear(); registry.dispose(); }
});
