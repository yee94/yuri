import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLlmBridgeDirectory, generateCleanCompletion, prepareLlmBridgeDirectory, stopLlmBridgeDirectory } from './bridge-client.js';
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

  it('passes the current client to the injected directory preparation', async () => {
    const client = { plugin: { list: async () => [] }, rpc: () => ({ ready: async () => ({ version: LLM_BRIDGE_VERSION }), generate: async () => ({ text: '', toolCalls: [] }) }) };
    const ensureBridgeDirectory = vi.fn(async () => '/isolated');
    await generateCleanCompletion({ clientFactory: () => client, ensureBridgeDirectory });
    expect(ensureBridgeDirectory).toHaveBeenCalledWith({ client });
  });

  it('reloads only the isolated Location when a recreated plugin is absent from the loaded runtime', async () => {
    vi.useFakeTimers();
    try {
      let loaded = false;
      const ready = vi.fn(async () => {
        if (!loaded) throw { type: 'rpc.unavailable' };
        return { version: LLM_BRIDGE_VERSION };
      });
      const generate = vi.fn(async () => ({ text: 'recovered', toolCalls: [] }));
      const evict = vi.fn(async () => { loaded = true; });
      const client = {
        plugin: { list: vi.fn(async () => ({ data: [] })) },
        debug: { location: { evict } },
        rpc: () => ({ ready, generate }),
      };
      const ensureBridgeDirectory = vi.fn(async () => '/isolated/bridge');
      const result = generateCleanCompletion({ clientFactory: () => client, ensureBridgeDirectory }).catch(error => error);
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ text: 'recovered' });
      expect(evict).toHaveBeenCalledExactlyOnceWith({ location: { directory: '/isolated/bridge' } });
      expect(ensureBridgeDirectory).toHaveBeenCalledTimes(2);
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('bounds readiness recovery and never generates while RPC remains unavailable', async () => {
    vi.useFakeTimers();
    try {
      const ready = vi.fn(async () => { throw { type: 'rpc.unavailable' }; });
      const generate = vi.fn();
      const evict = vi.fn(async () => {});
      const client = { plugin: { list: async () => [] }, debug: { location: { evict } }, rpc: () => ({ ready, generate }) };
      const result = generateCleanCompletion({ clientFactory: () => client, ensureBridgeDirectory: async () => '/isolated' }).catch(error => error);
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ type: 'rpc.unavailable' });
      expect(ready).toHaveBeenCalledTimes(42);
      expect(evict).toHaveBeenCalledTimes(1);
      expect(generate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('shares recovery without letting a cancelled caller abort its peer or generate late', async () => {
    vi.useFakeTimers();
    try {
      let loaded = false;
      let release;
      const ready = vi.fn(async () => {
        if (!loaded) throw { type: 'rpc.unavailable' };
        return { version: LLM_BRIDGE_VERSION };
      });
      const generate = vi.fn(async () => ({ text: 'recovered' }));
      const evict = vi.fn(() => new Promise(resolve => { release = () => { loaded = true; resolve(); }; }));
      const client = { plugin: { list: async () => [] }, debug: { location: { evict } }, rpc: () => ({ ready, generate }) };
      const controller = new AbortController();
      const input = { clientFactory: () => client, ensureBridgeDirectory: async () => '/isolated' };
      const first = generateCleanCompletion({ ...input, signal: controller.signal }).catch(error => error);
      const second = generateCleanCompletion(input);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(evict).toHaveBeenCalledTimes(1);
      const reason = new Error('user cancelled');
      controller.abort(reason);
      expect(await first).toBe(reason);
      release();
      expect(await second).toMatchObject({ text: 'recovered' });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['authentication_required', 'transport'])('does not reload a Location for %s readiness errors', async (type) => {
    const error = { type };
    const evict = vi.fn();
    const generate = vi.fn();
    const client = { plugin: { list: async () => [] }, debug: { location: { evict } }, rpc: () => ({ ready: async () => { throw error; }, generate }) };
    await expect(generateCleanCompletion({ clientFactory: () => client, ensureBridgeDirectory: async () => '/isolated' })).rejects.toBe(error);
    expect(evict).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('never replays generation even when it returns rpc.unavailable after readiness', async () => {
    const error = { type: 'rpc.unavailable' };
    const evict = vi.fn();
    const generate = vi.fn(async () => { throw error; });
    const client = { plugin: { list: async () => [] }, debug: { location: { evict } }, rpc: () => ({ ready: async () => ({ version: LLM_BRIDGE_VERSION }), generate }) };
    await expect(generateCleanCompletion({ clientFactory: () => client, ensureBridgeDirectory: async () => '/isolated' })).rejects.toBe(error);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(evict).not.toHaveBeenCalled();
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
    await stopLlmBridgeDirectory();
    vi.restoreAllMocks();
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

  it('never deletes another upstream service\'s bridge directory', async () => {
    const root = await makeRoot();
    vi.spyOn(os, 'tmpdir').mockReturnValue(root);
    const peer = path.join(root, 'yuri-inference-other-service');
    await fs.mkdir(peer);
    const list = vi.fn(async () => []);
    await ensureLlmBridgeDirectory({ client: { debug: { location: { list } } } });
    expect(list).not.toHaveBeenCalled();
    expect(await fs.stat(peer)).toBeDefined();
  });

  it('restages a deleted plugin instead of trusting a cached directory path', async () => {
    const root = await makeRoot();
    vi.spyOn(os, 'tmpdir').mockReturnValue(root);
    const directory = await ensureLlmBridgeDirectory();
    const target = path.join(directory, '.opencode', 'plugins', 'yuri-llm.js');
    const code = await fs.readFile(target);
    await fs.rm(directory, { recursive: true });
    expect(await ensureLlmBridgeDirectory()).toBe(directory);
    expect(await fs.readFile(target)).toEqual(code);
  });

  it('checks warm staged assets without rereading the bundle or rewriting files', async () => {
    const root = await makeRoot();
    vi.spyOn(os, 'tmpdir').mockReturnValue(root);
    const directory = await ensureLlmBridgeDirectory();
    const read = vi.spyOn(fs, 'readFile');
    const write = vi.spyOn(fs, 'writeFile');
    const access = vi.spyOn(fs, 'access');
    for (let index = 0; index < 50; index++) expect(await ensureLlmBridgeDirectory()).toBe(directory);
    expect(access).toHaveBeenCalledTimes(50);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
