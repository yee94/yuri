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

/**
 * Removes bridge directories left by earlier builds or by the former per-process
 * temporary layout. A directory whose Location is still loaded upstream may be
 * in use by another host, so it stays until the upstream idle sweep unloads it.
 * Only failure to read the live inventory skips the whole pass.
 */
export async function pruneStaleLlmBridgeDirectories({ client, keep, root = os.tmpdir(), fsLike = fs, signal }) {
  const entries = await Promise.resolve().then(() => client.debug.location.list(signal ? { signal } : undefined)).catch(() => null);
  if (!Array.isArray(entries)) return [];
  const live = new Set(entries.map((entry) => entry?.directory && path.resolve(entry.directory)).filter(Boolean));
  const names = await fsLike.readdir(root).catch(() => []);
  const removed = [];
  for (const name of names) {
    if (!name.startsWith('yuri-inference-')) continue;
    const directory = path.join(root, name);
    if (directory === keep || live.has(directory)) continue;
    const resolved = await fsLike.realpath(directory).catch(() => directory);
    if (live.has(resolved)) continue;
    await fsLike.rm(directory, { recursive: true, force: true }).then(() => removed.push(directory), () => undefined);
  }
  return removed;
}

let directoryPromise;
let pruneStarted = false;
export async function ensureLlmBridgeDirectory({ client } = {}) {
  if (!directoryPromise) directoryPromise = prepareLlmBridgeDirectory()
    .catch(error => { directoryPromise = undefined; throw error; });
  const directory = await directoryPromise;
  if (client && !pruneStarted) {
    pruneStarted = true;
    // Cleanup is best effort and never delays inference.
    void pruneStaleLlmBridgeDirectories({ client, keep: directory }).catch(() => undefined);
  }
  return directory;
}

// The content-addressed directory may be shared with other hosts, so shutdown
// only forgets it and never deletes it.
export async function stopLlmBridgeDirectory() {
  directoryPromise = undefined;
  pruneStarted = false;
}

export async function generateCleanCompletion({ buildOpenCodeUrl, getOpenCodeAuthHeaders, clientFactory,
  providerID, modelID, variant, messages, tools, cacheKey = randomUUID(), maxOutputTokens, signal,
  ensureBridgeDirectory = ensureLlmBridgeDirectory,
}) {
  signal?.throwIfAborted();
  const client = clientFactory?.() ?? OpenCode.make({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers: getOpenCodeAuthHeaders() });
  const directory = await ensureBridgeDirectory({ client });
  const options = { location: { directory }, signal };
  const rpc = client.rpc(LlmBridge);
  // Loading this isolated Location activates only its own plugin file, without global config writes.
  await client.plugin.list({ location: { directory } }, { signal });
  let ready;
  for (let attempt = 0; ; attempt++) {
    try { ready = await rpc.ready({}, options); break; }
    catch (error) {
      if (signal?.aborted || error?.type !== 'rpc.unavailable' || attempt >= 20) throw error;
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 250);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  if (ready.version !== LLM_BRIDGE_VERSION) throw new Error('Incompatible Yuri LLM bridge');
  const result = await rpc.generate({ providerID, modelID, ...(variant ? { variant } : {}), messages,
    ...(tools ? { tools } : {}), cacheKey, ...(maxOutputTokens ? { maxOutputTokens } : {}),
  }, options);
  signal?.throwIfAborted();
  return { ...result, source: 'opencode.llm.bridge' };
}
