import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OpenCode } from '@opencode/client';
import { LlmBridge, LLM_BRIDGE_VERSION } from './bridge-contract.js';

const BRIDGE_PLUGIN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge-plugin.bundle.js');

// Every directory activates one upstream Location that the shared service keeps
// alive. The directory is keyed by plugin content, so restarts and concurrent
// hosts running the same bundle reuse one Location instead of adding one each.
export async function prepareLlmBridgeDirectory({ pluginPath = BRIDGE_PLUGIN_PATH, root = os.tmpdir(), fsLike = fs } = {}) {
  const code = await fsLike.readFile(pluginPath);
  const digest = createHash('sha256').update(code).digest('hex').slice(0, 16);
  const directory = path.join(root, `yuri-inference-${digest}`);
  const plugins = path.join(directory, '.opencode', 'plugins');
  const target = path.join(plugins, 'yuri-llm.js');
  const current = await fsLike.readFile(target).catch(() => null);
  if (current && current.equals(code)) return directory;
  await fsLike.mkdir(plugins, { recursive: true });
  // Another host may be loading the same file; replace it atomically.
  const staging = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsLike.writeFile(staging, code);
    await fsLike.rename(staging, target);
  } catch (error) {
    await fsLike.rm(staging, { force: true });
    throw error;
  }
  return directory;
}

let directoryPromise;
export async function ensureLlmBridgeDirectory() {
  if (!directoryPromise) directoryPromise = prepareLlmBridgeDirectory()
    .catch(error => { directoryPromise = undefined; throw error; });
  const pending = directoryPromise;
  const directory = await pending;
  try {
    await fs.access(path.join(directory, '.opencode', 'plugins', 'yuri-llm.js'));
    return directory;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (directoryPromise === pending) {
      directoryPromise = prepareLlmBridgeDirectory()
        .catch(error => { directoryPromise = undefined; throw error; });
    }
    return directoryPromise;
  }
}

// The content-addressed directory may be shared with other hosts, so shutdown
// only forgets it and never deletes it.
export async function stopLlmBridgeDirectory() {
  directoryPromise = undefined;
}

// A Location inventory describes one OpenCode service, not every service using
// this temporary root. Never delete peer directories based on that inventory.
const bridgeReloads = new Map();
const reloadBridgeLocation = ({ key, client, directory, ensureBridgeDirectory }) => {
  const current = bridgeReloads.get(key);
  if (current?.directory === directory) return current.promise;
  const entry = { directory, promise: null };
  entry.promise = Promise.resolve().then(async () => {
    await ensureBridgeDirectory({ client });
    await client.debug.location.evict({ location: { directory } });
    await client.plugin.list({ location: { directory } });
  }).finally(() => {
    if (bridgeReloads.get(key) === entry) bridgeReloads.delete(key);
  });
  // A caller may cancel before subscribing; a shared repair can still finish.
  void entry.promise.catch(() => undefined);
  bridgeReloads.set(key, entry);
  return entry.promise;
};

const awaitBridgeReload = async (promise, signal) => {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
};

export async function generateCleanCompletion({ buildOpenCodeUrl, getOpenCodeAuthHeaders, clientFactory,
  providerID, modelID, variant, messages, tools, cacheKey = randomUUID(), maxOutputTokens, signal,
  ensureBridgeDirectory = ensureLlmBridgeDirectory,
}) {
  signal?.throwIfAborted();
  const providedClient = clientFactory?.();
  const baseUrl = providedClient ? null : buildOpenCodeUrl('/', '').replace(/\/$/, '');
  const client = providedClient ?? OpenCode.make({ baseUrl, headers: getOpenCodeAuthHeaders() });
  const directory = await ensureBridgeDirectory({ client });
  const options = { location: { directory }, signal };
  const rpc = client.rpc(LlmBridge);
  // Loading this isolated Location activates only its own plugin file, without global config writes.
  await client.plugin.list({ location: { directory } }, { signal });
  let ready;
  let reloaded = false;
  for (let attempt = 0; ; attempt++) {
    try { ready = await rpc.ready({}, options); break; }
    catch (error) {
      if (signal?.aborted || error?.type !== 'rpc.unavailable') throw error;
      if (attempt >= 20) {
        if (reloaded || typeof client.debug?.location?.evict !== 'function') throw error;
        reloaded = true;
        await awaitBridgeReload(reloadBridgeLocation({ key: baseUrl ?? client, client, directory, ensureBridgeDirectory }), signal);
        attempt = -1;
        continue;
      }
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 250);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  signal?.throwIfAborted();
  if (ready.version !== LLM_BRIDGE_VERSION) throw new Error('Incompatible Yuri LLM bridge');
  const result = await rpc.generate({ providerID, modelID, ...(variant ? { variant } : {}), messages,
    ...(tools ? { tools } : {}), cacheKey, ...(maxOutputTokens ? { maxOutputTokens } : {}),
  }, options);
  signal?.throwIfAborted();
  return { ...result, source: 'opencode.llm.bridge' };
}
