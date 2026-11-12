import { beforeEach, expect, test, vi } from 'vitest';
import { HostRuntimeRegistry, type HostRuntimeEntry } from './remote-projects/registry';
import { getProjectActionsState, getWorktreeSetupConfig, saveWorktreeSetupCommands } from './yuriConfig';
import { detectDevServerCommand, readPackageJsonScripts } from './detectDevServer';

const { local, localFetch } = vi.hoisted(() => ({ local: vi.fn(), localFetch: vi.fn() }));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: local }));
vi.mock('@/lib/runtime-fetch', async (original) => ({ ...await original<typeof import('@/lib/runtime-fetch')>(), runtimeFetch: localFetch }));
let registry: HostRuntimeRegistry;
let entry: HostRuntimeEntry;
let files: Record<string, string>;
let requests: Array<{ path: string; file?: string }>;
let fail: boolean;
beforeEach(() => {
  vi.clearAllMocks(); fail = false; requests = [];
  local.mockReset();
  localFetch.mockResolvedValue(Response.json({ home: '/remote-home' }));
  files = { '/remote-home/.config/yuri/projects/path_L3JlcG8.json': JSON.stringify({ 'setup-worktree': ['bun install'], 'setup-worktree-wait': true,
    projectActions: [{ id: 'run', name: 'Run', command: 'bun run app', autoOpenUrl: true, openUrl: 'http://localhost:4000' }] }) };
  registry = new HostRuntimeRegistry('hub', { transportIdentity: 'test', isCurrent: () => true,
    sdk: () => ({} as ReturnType<HostRuntimeEntry['sdk']>),
    fetch: async (path, init) => {
      const query = init?.query;
      const file = query instanceof URLSearchParams ? query.get('path') : query?.path;
      requests.push({ path, ...(typeof file === 'string' ? { file } : {}) });
      if (fail) return Response.json({ error: 'offline' }, { status: 503 });
      if (path.endsWith('/fs/home')) return Response.json({ home: '/remote-home' });
      if (path.endsWith('/system/free-port')) return Response.json({ port: 43210 });
      const text = typeof file === 'string' ? files[file] : undefined;
      return new Response(text ?? '', { headers: { 'x-yuri-file-exists': text === undefined ? 'false' : 'true' } });
    },
  });
  entry = registry.resolve({ hubId: 'hub', hostId: 'b', directory: '/repo' });
});
const project = { id: 'hub-ref', path: '/repo', hostId: 'b', hubId: 'hub' };

test('worktree and project Run read the same Host native config without native Hub IO', async () => {
  expect(await getWorktreeSetupConfig(project, entry)).toEqual({ commands: ['bun install'], wait: true });
  expect((await getProjectActionsState(project, entry)).actions[0]).toMatchObject({ id: 'run', command: 'bun run app', openUrl: 'http://localhost:4000' });
  expect(requests.every((request) => request.path.startsWith('/api/hosts/b/api/'))).toBe(true);
  expect(requests.some((request) => request.file?.includes('hub-ref'))).toBe(false);
  expect(local).not.toHaveBeenCalled();
});

test('legacy read remains supported but does not migrate or write the remote machine', async () => {
  files = { '/repo/.yuri/yuri.json': JSON.stringify({ 'setup-worktree': ['legacy-command'] }) };
  expect(await getWorktreeSetupConfig(project, entry)).toEqual({ commands: ['legacy-command'], wait: false });
  expect(requests.map((request) => request.path)).toEqual(['/api/hosts/b/api/fs/home', '/api/hosts/b/api/fs/read', '/api/hosts/b/api/fs/read']);
  expect(local).not.toHaveBeenCalled();
});

test('missing explicit Host, mismatched Host and machine-config writes fail closed', async () => {
  await expect(getProjectActionsState(project)).rejects.toThrow('explicit Host scope');
  await expect(getProjectActionsState(project, registry.resolve({ hubId: 'hub', hostId: 'c', directory: '/repo' }))).rejects.toThrow('explicit Host scope');
  await expect(saveWorktreeSetupCommands(project, ['write'])).rejects.toThrow();
  expect(requests).toHaveLength(0);
  expect(local).not.toHaveBeenCalled();
});

test('failed Host config does not masquerade as empty successful actions', async () => {
  fail = true;
  await expect(getProjectActionsState(project, entry)).rejects.toThrow('offline');
  expect(local).not.toHaveBeenCalled();
});

test('preview package-manager detection only reads the selected Host files', async () => {
  files = { '/repo/package.json': JSON.stringify({ scripts: { dev: 'vite' }, packageManager: 'pnpm@10' }) };
  const scripts = await readPackageJsonScripts('/repo', entry);
  expect(await detectDevServerCommand('/repo', [], scripts, entry)).toMatchObject({ command: 'pnpm dev' });
  expect(requests.every((request) => request.path.startsWith('/api/hosts/b/api/'))).toBe(true);
  expect(local).not.toHaveBeenCalled();
});

test('static site preview allocates its free port on the Host, not Hub', async () => {
  files = { '/repo/index.html': '<h1>Remote static site</h1>' };
  expect(await detectDevServerCommand('/repo', [], null, entry)).toMatchObject({ command: 'python3 -m http.server 43210', previewUrlHint: 'http://127.0.0.1:43210/' });
  expect(requests.at(-1)?.path).toBe('/api/hosts/b/api/system/free-port');
  expect(local).not.toHaveBeenCalled();
});

test('preview detection failures never fall through to registered native FilesAPI', async () => {
  fail = true;
  await expect(readPackageJsonScripts('/repo', entry)).rejects.toThrow('Host preview file');
  await expect(detectDevServerCommand('/repo', [], null, entry)).rejects.toThrow('Host preview file');
  expect(local).not.toHaveBeenCalled();
});

test('legacy local signature retains native FilesAPI behavior without a Host prefix', async () => {
  const readFile = vi.fn(async (path: string) => ({ content: files[path] ?? '' }));
  local.mockReturnValue({ files: { readFile } });
  expect(await getWorktreeSetupConfig({ id: 'local', path: '/repo' })).toEqual({ commands: ['bun install'], wait: true });
  expect(readFile).toHaveBeenCalledWith('/remote-home/.config/yuri/projects/path_L3JlcG8.json');
  expect(requests).toHaveLength(0);
  expect(localFetch.mock.calls[0][0]).not.toContain('/hosts/');
});
