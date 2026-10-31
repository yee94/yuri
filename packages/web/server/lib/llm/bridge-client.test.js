import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateCleanCompletion, prepareLlmBridgeDirectory, pruneStaleLlmBridgeDirectories } from './bridge-client.js';
import { LLM_BRIDGE_VERSION } from './bridge-contract.js';

describe('external OpenCode inference bridge', () => {
  it('uses only isolated plugin discovery and authenticated RPC, never Session APIs or config writes', async () => {
    const ready = vi.fn(async () => ({ version: LLM_BRIDGE_VERSION }));
    const generate = vi.fn(async () => ({ text: 'summary', toolCalls: [], finishReason: 'stop' }));
    const client = { plugin: { list: vi.fn(async () => []) }, rpc: vi.fn(() => ({ ready, generate })), session: new Proxy({}, { get() { throw new Error('Session API is forbidden'); } }) };
    const signal = new AbortController().signal;
    await expect(generateCleanCompletion({ providerID: 'p', modelID: 'm', messages: [{ role: 'user', content: 'summarize' }], cacheKey: 'conversation-a', clientFactory: () => client, ensureBridgeDirectory: async () => '/isolated/bridge', signal })).resolves.toMatchObject({ text: 'summary', source: 'opencode.llm.bridge' });
    expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cacheKey: 'conversation-a' }), { location: { directory: '/isolated/bridge' }, signal });
    expect(client.plugin.list).toHaveBeenCalledWith({ location: { directory: '/isolated/bridge' } }, { signal });
  });

  it('fails closed on incompatible bridge protocol', async () => {
    const generate = vi.fn();
    await expect(generateCleanCompletion({ clientFactory: () => ({ plugin: { list: async () => [] }, rpc: () => ({ ready: async () => ({ version: -1 }), generate }) }), ensureBridgeDirectory: async () => '/isolated' })).rejects.toThrow('Incompatible');
    expect(generate).not.toHaveBeenCalled();
  });

  it('retries plugin readiness but never repeats an ambiguous generation failure', async () => {
    vi.useFakeTimers();
    try {
      const ready = vi.fn().mockRejectedValueOnce({ type: 'rpc.unavailable' }).mockResolvedValue({ version: LLM_BRIDGE_VERSION });
      const generate = vi.fn().mockRejectedValue(new Error('connection lost'));
      const result = generateCleanCompletion({ clientFactory: () => ({ plugin: { list: async () => [] }, rpc: () => ({ ready, generate }) }), ensureBridgeDirectory: async () => '/isolated' }).catch(error => error);
      await vi.advanceTimersByTimeAsync(250);
      expect(await result).toMatchObject({ message: 'connection lost' });
      expect(ready).toHaveBeenCalledTimes(2);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('passes the client to directory preparation so stale bridge cleanup can consult upstream', async () => {
    const client = { plugin: { list: async () => [] }, rpc: () => ({ ready: async () => ({ version: LLM_BRIDGE_VERSION }), generate: async () => ({ text: '', toolCalls: [] }) }) };
    const ensureBridgeDirectory = vi.fn(async () => '/isolated');
    await generateCleanCompletion({ clientFactory: () => client, ensureBridgeDirectory });
    expect(ensureBridgeDirectory).toHaveBeenCalledWith({ client });
  });
});

describe('bridge directory lifecycle', () => {
  const roots = [];
  const makeRoot = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-root-'));
    roots.push(root);
    return root;
  };
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('reuses one content-addressed directory across restarts and rewrites only changed plugins', async () => {
    const root = await makeRoot();
    const pluginPath = path.join(root, 'bundle.js');
    await fs.writeFile(pluginPath, 'v1');
    const first = await prepareLlmBridgeDirectory({ pluginPath, root });
    const target = path.join(first, '.opencode', 'plugins', 'yuri-llm.js');
    const { mtimeMs } = await fs.stat(target);
    expect(await prepareLlmBridgeDirectory({ pluginPath, root })).toBe(first);
    expect((await fs.stat(target)).mtimeMs).toBe(mtimeMs);
    expect(await fs.readFile(target, 'utf8')).toBe('v1');

    await fs.writeFile(pluginPath, 'v2');
    const second = await prepareLlmBridgeDirectory({ pluginPath, root });
    expect(second).not.toBe(first);
    expect(path.basename(second)).toMatch(/^yuri-inference-[0-9a-f]{16}$/);
    expect(await fs.readFile(path.join(second, '.opencode', 'plugins', 'yuri-llm.js'), 'utf8')).toBe('v2');
    expect((await fs.readdir(path.join(second, '.opencode', 'plugins')))).toEqual(['yuri-llm.js']);
  });

  it('prunes stale bridge directories except the current and upstream-loaded ones', async () => {
    const root = await makeRoot();
    const make = async (name) => { const dir = path.join(root, name); await fs.mkdir(dir); return dir; };
    const keep = await make('yuri-inference-current');
    const loaded = await make('yuri-inference-loaded');
    const stale = await make('yuri-inference-AbC123');
    const unrelated = await make('other-dir');
    const client = { debug: { location: { list: vi.fn(async () => [{ directory: loaded }]) } } };
    expect(await pruneStaleLlmBridgeDirectories({ client, keep, root })).toEqual([stale]);
    expect((await fs.readdir(root)).sort()).toEqual([path.basename(unrelated), path.basename(keep), path.basename(loaded)].sort());
  });

  it('skips pruning when the upstream inventory cannot be read', async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, 'yuri-inference-stale'));
    const client = { debug: { location: { list: vi.fn(async () => { throw new Error('503'); }) } } };
    expect(await pruneStaleLlmBridgeDirectories({ client, keep: '/none', root })).toEqual([]);
    expect(await fs.readdir(root)).toEqual(['yuri-inference-stale']);
  });
});
