import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OPENCODE_CONFIG_SYNC_ALLOWLIST, OPENCODE_CONFIG_SYNC_TAR_EXCLUDES } from './constants.js';
import { extractTarGzBuffer } from './local-backup.js';
import { filterSyncedPluginConfig } from './plugins.js';

/**
 * Collect stdout from a local `tar …` into a Buffer.
 *
 * Callers buffer the entire archive in memory; TargetExecutor.putTar accepts
 * Buffer | Uint8Array only.
 *
 * @param {string[]} tarArgs
 * @param {{ windowsHide?: boolean }} [spawnOptions]
 * @returns {Promise<Buffer>}
 */
export const collectLocalTarBuffer = (tarArgs, spawnOptions = {}) => new Promise((resolve, reject) => {
  const child = spawn('tar', [...OPENCODE_CONFIG_SYNC_TAR_EXCLUDES, ...tarArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(spawnOptions.windowsHide ? { windowsHide: true } : {}),
  });
  /** @type {Buffer[]} */
  const chunks = [];
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0) {
      reject(new Error((stderr || 'Local tar failed').trim()));
      return;
    }
    resolve(Buffer.concat(chunks));
  });
});

/** Filter only a private archive copy; source and destination files stay untouched on failure. */
export const filterConfigSyncArchive = async (buffer) => {
  if (!buffer.length) return buffer;
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-config-sync-'));
  try {
    await extractTarGzBuffer(buffer, staging);
    let changed = false;
    for (const name of OPENCODE_CONFIG_SYNC_ALLOWLIST.fileGroups.flat()) {
      const file = path.join(staging, name);
      let content;
      try {
        if (!(await fs.lstat(file)).isFile()) throw new Error('Cannot sync plugins: configuration must be a regular file');
        content = await fs.readFile(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const filtered = filterSyncedPluginConfig(content);
      if (filtered === content) continue;
      await fs.writeFile(file, filtered);
      changed = true;
    }
    if (!changed) return buffer;
    const entries = await fs.readdir(staging);
    return await collectLocalTarBuffer(['-czf', '-', '-C', staging, ...entries], {
      windowsHide: process.platform === 'win32',
    });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
};

/** SSH collector for the engine's `-C root ...entries` contract; only config files are staged. */
export const collectSshConfigTarBuffer = async (tarArgs, options = {}) => {
  const rootIndex = tarArgs.indexOf('-C') + 1;
  const root = tarArgs[rootIndex];
  const entries = tarArgs.slice(rootIndex + 1);
  const configs = entries.filter((entry) => OPENCODE_CONFIG_SYNC_ALLOWLIST.fileGroups.flat().includes(entry));
  if (!configs.length) return collectLocalTarBuffer(tarArgs, options);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-config-sync-'));
  try {
    for (const name of configs) {
      const content = await fs.readFile(path.join(root, name), 'utf8');
      await fs.writeFile(path.join(staging, name), filterSyncedPluginConfig(content), { mode: 0o600 });
    }
    const remaining = entries.filter((entry) => !configs.includes(entry));
    return await collectLocalTarBuffer([
      ...tarArgs.slice(0, rootIndex - 1), '-C', staging, ...configs,
      ...(remaining.length ? ['-C', root, ...remaining] : []),
    ], options);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
};
