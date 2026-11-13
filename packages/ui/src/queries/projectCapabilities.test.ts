import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';

const state = vi.hoisted(() => ({ generation: 0, fallback: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => state.generation,
  getRuntimeTransportIdentity: () => 'hub-transport',
  getRuntimeKey: () => 'hub',
  getRuntimeApiBaseUrl: () => '/api',
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fallback }));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => '/hub' } }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({ getActiveProject: () => null }) } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ currentDirectory: '/hub' }) } }));

import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { createProjectFilesAPI } from '@/lib/api/project-files';
import { createProjectGitAPI } from '@/lib/gitApiProject';
import { readRuntimeFile } from '@/lib/runtime-file-resource';
import { uploadPromptAttachmentBytes } from '@/lib/prompt-attachment-upload';
import { commandQueryOptions } from './commandQueries';
import { installedSkillsQueryOptions } from './installedSkillsQueries';
import { agentQueryOptions, providerQueryOptions } from './agentQueries';
import { mcpConfigsQueryOptions, mcpStatusQueryOptions } from './mcpQueries';
import { fileContentQueryOptions } from './fileQueries';
import { providerCatalogQueryOptions, rawAgentsQueryOptions } from './configCatalogQueries';
import { savedPermissionProjectQueryOptions, savedPermissionListQueryOptions, deleteSavedPermissionQuery } from './savedPermissionQueries';
import { pluginsListQueryOptions, pluginRuntimeQueryOptions } from './pluginQueries';

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const directory = '/remote/same project';
const makeRegistry = (hubId = 'hub-a') => {
  let current = true;
  const wire = {
    file: { find: vi.fn(async () => ({ data: [{ path: 'hello.ts', type: 'file' }] })) },
    agent: { list: vi.fn(async () => ({ data: [{ id: 'remote-build', name: 'Remote Build' }] })) },
    provider: { list: vi.fn(async () => ({ data: [{ id: 'remote-provider', name: 'Remote Provider' }] })) },
    model: { list: vi.fn(async () => ({ data: [{ id: 'remote-model', name: 'Remote Model', providerID: 'remote-provider' }] })) },
    config: { get: vi.fn(async () => []) },
    mcp: { list: vi.fn(async () => ({ data: [{ name: 'remote-mcp', status: { status: 'connected' } }] })) },
    plugin: { list: vi.fn(async () => ({ data: [{ source: { type: 'package', target: 'remote-plugin', version: '1.0.0' }, state: { status: 'active' } }] })) },
    location: { get: vi.fn(async () => ({ project: { id: 'remote-project' } })) },
    permission: { saved: {
      list: vi.fn(async () => ({ data: [{ id: 'rule', projectID: 'remote-project', action: 'allow', resource: 'file:*' }] })),
      remove: vi.fn(async () => undefined),
    } },
  };
  const sdk = wire as unknown as OpenCodeClient;
  const fetch = vi.fn(async (_path: string, _init?: RuntimeFetchOptions) => response({}));
  const registry = new HostRuntimeRegistry(hubId, { transportIdentity: 'hub-transport', isCurrent: () => current, sdk: () => sdk, fetch, service: () => { throw new Error('Unexpected service access'); } });
  return { registry, fetch, sdk, wire, retire: () => { current = false; }, entry: (hostId = 'host-a', path = directory) => registry.resolve({ hubId, hostId, directory: path }) };
};

describe('explicit project capability scope', () => {
  beforeEach(() => { state.generation = 0; state.fallback.mockReset(); });

  it('isolates every picker cache by Hub, host and raw directory', () => {
    const a = makeRegistry();
    const b = makeRegistry('hub-b');
    const factories = [agentQueryOptions, providerQueryOptions, commandQueryOptions, installedSkillsQueryOptions, mcpConfigsQueryOptions, mcpStatusQueryOptions];
    for (const factory of factories) {
      const keys = [a.entry(), a.entry('host-b'), a.entry('host-a', '/different'), b.entry()].map((entry) =>
        JSON.stringify(factory('/ignored-local-directory', 'hub-transport', entry).queryKey));
      expect(new Set(keys).size).toBe(4);
    }
    expect(a.fetch).not.toHaveBeenCalled();
    expect(state.fallback).not.toHaveBeenCalled();
  });

  it('routes file reads/writes/search to the captured host without replacing raw paths', async () => {
    const a = makeRegistry();
    a.fetch.mockImplementation(async () => response({ success: true, path: '/remote/same project/hello.ts' }));
    const files = createProjectFilesAPI(a.entry());
    await files.writeFile!('hello.ts', 'content');
    expect(a.fetch.mock.calls[0]).toEqual(['/api/hosts/host-a/api/fs/write', expect.objectContaining({
      headers: expect.objectContaining({ 'x-opencode-directory': directory }), body: JSON.stringify({ path: 'hello.ts', content: 'content' }),
    })]);
    expect(await files.search({ directory, query: 'hello' })).toEqual([{ path: `${directory}/hello.ts`, preview: ['hello.ts'] }]);
    expect(files.revealPath).toBeUndefined();
    const options = fileContentQueryOptions(files, { scopeDirectory: directory, path: 'hello.ts', scope: a.entry() });
    expect(JSON.stringify(options.queryKey)).toContain('host-a');
    expect(state.fallback).not.toHaveBeenCalled();
  });

  it('reads plugin configuration and runtime inventory from the same Host without Hub generation sharing', async () => {
    const a = makeRegistry();
    const entry = a.entry();
    const signal = new AbortController().signal;
    a.fetch.mockImplementation(async () => response({ entries: [{ id: 'remote-plugin', spec: 'remote-plugin' }], files: [] }));
    const list = pluginsListQueryOptions(directory, 'hub-transport', entry);
    expect(JSON.stringify(list.queryKey)).toContain('host-a');
    expect((await list.queryFn({ signal })).entries[0].id).toBe('remote-plugin');
    expect(a.fetch.mock.calls[0][0]).toContain('/api/hosts/host-a/api/config/plugins');
    const runtime = await pluginRuntimeQueryOptions(directory, 'hub-transport', entry).queryFn({ signal });
    expect(runtime).toEqual([{ source: { kind: 'package', target: 'remote-plugin', version: '1.0.0', outdated: false, updating: false }, state: { kind: 'active' } }]);
    expect(a.wire.plugin.list).toHaveBeenCalledWith({ location: { directory } }, { signal });
    expect(state.fallback).not.toHaveBeenCalled();
  });

  it('keeps SDK agent, model fallback and MCP reads on the selected Host with abort signal', async () => {
    const a = makeRegistry();
    const signal = new AbortController().signal;
    a.fetch.mockImplementation(async () => new Response('', { status: 404 }));
    const agents = await rawAgentsQueryOptions('/ignored', 'hub-transport', a.entry()).queryFn({ signal });
    expect(agents[0].name).toBe('remote-build');
    const catalog = await providerCatalogQueryOptions('/ignored', 'hub-transport', a.entry()).queryFn({ signal });
    expect(catalog.providers[0].models['remote-model'].name).toBe('Remote Model');
    expect(await mcpStatusQueryOptions('/ignored', 'hub-transport', a.entry()).queryFn({ signal })).toEqual({ 'remote-mcp': { status: 'connected' } });
    for (const read of [a.wire.agent.list, a.wire.provider.list, a.wire.model.list, a.wire.config.get, a.wire.mcp.list]) {
      expect(read).toHaveBeenCalledWith({ location: { directory } }, { signal: expect.any(AbortSignal) });
    }
    expect(state.fallback).not.toHaveBeenCalled();
  });

  it('routes git mutations without consulting the global bridge/cache', async () => {
    const a = makeRegistry();
    const git = createProjectGitAPI(a.entry());
    await git.stageGitFiles!(directory, ['hello.ts']);
    expect(a.fetch.mock.calls[0]).toEqual(['/api/hosts/host-a/api/git/stage', expect.objectContaining({ query: { directory }, body: JSON.stringify({ paths: ['hello.ts'] }) })]);
    expect(state.fallback).not.toHaveBeenCalled();
  });

  it('resolves and deletes permissions on the remote project without clearing a sibling cache', async () => {
    const a = makeRegistry();
    const runtime = { transport: 'hub-transport', generation: 0, directory, entry: a.entry() };
    const client = new QueryClient();
    const project = await client.fetchQuery(savedPermissionProjectQueryOptions(runtime));
    expect(project).toBe('remote-project');
    const scope = { ...runtime, projectID: project };
    const options = savedPermissionListQueryOptions(scope);
    const items = await client.fetchQuery(options);
    const sibling = savedPermissionListQueryOptions({ ...scope, entry: a.entry('host-b') });
    client.setQueryData(sibling.queryKey, items);
    await deleteSavedPermissionQuery(client, scope, 'rule');
    expect(a.wire.permission.saved.remove).toHaveBeenCalledWith({ id: 'rule' });
    expect(client.getQueryData(options.queryKey)).toEqual([]);
    expect(client.getQueryData(sibling.queryKey)).toEqual(items);
    client.clear();
  });

  it('does not commit an old catalog response and preserves the last complete snapshot on failure', async () => {
    const a = makeRegistry();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const options = commandQueryOptions(directory, 'hub-transport', a.entry());
    client.setQueryData(options.queryKey, [{ name: 'previous', isBuiltIn: false }]);
    let resolve!: (value: Response) => void;
    a.fetch.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = client.fetchQuery({ ...options, retry: false, staleTime: 0 });
    a.retire();
    resolve(response({ commands: [{ name: 'wrong-host', isBuiltIn: false }] }));
    await expect(pending).rejects.toThrow('Inactive Hub registry');
    expect(client.getQueryData(options.queryKey)).toEqual([{ name: 'previous', isBuiltIn: false }]);
    client.clear();
  });

  it('rejects a retired host generation while leaving a sibling host usable', async () => {
    const a = makeRegistry();
    const status = (state: string) => a.registry.ingest({ type: 'yuri:host-status', properties: {
      hubId: 'hub-a', hostId: 'host-a', host: { id: 'host-a', name: 'A', source: 'direct', state },
    } });
    status('connected');
    const old = commandQueryOptions(directory, 'hub-transport', a.entry());
    const sibling = createProjectGitAPI(a.entry('host-b'));
    status('offline');
    await expect(old.queryFn({ signal: new AbortController().signal })).rejects.toThrow('connection changed');
    expect(commandQueryOptions(directory, 'hub-transport', a.entry()).queryKey).not.toEqual(old.queryKey);
    await sibling.getGitBranches(directory);
    expect(a.fetch.mock.calls.at(-1)?.[0]).toBe('/api/hosts/host-b/api/git/branches');
  });

  it('fences body parsing and in-flight raw bytes after runtime changes', async () => {
    const a = makeRegistry();
    const options = commandQueryOptions(directory, 'hub-transport', a.entry());
    a.fetch.mockImplementation(async () => {
      const value = response({ commands: [] });
      value.json = async () => { state.generation++; return { commands: [] }; };
      return value;
    });
    await expect(options.queryFn({ signal: new AbortController().signal })).rejects.toThrow('superseded');
    state.generation = 0;
    a.fetch.mockImplementation(async () => new Response('remote bytes'));
    const raw = await readRuntimeFile({ path: 'image.png', scope: a.entry() });
    state.generation++;
    await expect(raw.text()).rejects.toThrow('superseded');
  });

  it('uploads bytes to remote temporary storage and returns its physical file URL', async () => {
    const a = makeRegistry();
    a.fetch.mockImplementation(async (_path, init) => response({ path: '/remote/tmp/asset.png', mime: 'image/png', size: 3,
      sha256: new Headers(init?.headers).get('X-Yuri-Sha256') }));
    const result = await uploadPromptAttachmentBytes({ body: new Blob(['png']), mime: 'image/png', scope: a.entry() });
    expect(result.url).toBe('file:///remote/tmp/asset.png');
    expect(a.fetch.mock.calls[0][0]).toMatch(/^\/api\/hosts\/host-a\/api\/fs\/prompt-attachments\/.+\?storage=temporary$/);
    expect(state.fallback).not.toHaveBeenCalled();
  });
});
