import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { discoverCliRelease, discoverPortableRelease } from './releases.js';

const workerFile = fileURLToPath(new URL('./cli-worker.js', import.meta.url));

function startWorker(message, detached = false) {
  const child = fork(workerFile, [], { detached, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Update helper timed out')); }, 30000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Update helper exited before handoff')); });
    child.once('message', (result) => {
      clearTimeout(timer);
      if (result.error) reject(new Error(result.error));
      else resolve(result);
    });
  });
  child.send(message);
  return { child, ready };
}

export function createCliUpdateAdapter({ packageRoot, dataDir, getPort, shutdown, currentVersion, env = process.env }) {
  const portable = existsSync(path.join(packageRoot, '..', 'portable.json'));
  // Only the installer's versions/<release> layout has a stable `current` entry to switch.
  const portableManaged = portable && path.basename(path.resolve(packageRoot, '../..')) === 'versions' && process.platform === 'linux';
  const serviceManaged = env.INVOCATION_ID || env.PM2_HOME;
  const unsupported = portable ? !portableManaged || serviceManaged
    : process.platform === 'win32' || !packageRoot.replaceAll('\\', '/').includes('/node_modules/') || serviceManaged;
  const configuration = () => ({ packageRoot, dataDir, port: getPort(), pid: process.pid, installation: portable ? 'portable' : 'npm' });
  let checkedAt = 0;
  const adapter = {
    host: 'cli', external: true, supported: !unsupported,
    reason: portable && !portableManaged ? 'portable_installation_requires_release' : unsupported ? 'managed_or_development_installation' : null,
    inspect: (channel) => portable ? discoverPortableRelease(channel, currentVersion) : discoverCliRelease(channel, currentVersion),
    async refreshSupport() {
      if (unsupported || Date.now() - checkedAt < 60_000) return;
      try { await adapter.assertReady(); adapter.supported = true; adapter.reason = null; }
      catch { adapter.supported = false; adapter.reason = 'registered_writable_daemon_required'; }
      checkedAt = Date.now();
    },
    async assertReady() {
      if (unsupported) throw new Error('This installation must be updated through its installer or service manager');
      const { child, ready } = startWorker({ mode: 'probe', ...configuration() });
      try { await ready; } finally { if (child.connected) child.disconnect(); child.unref(); }
    },
    async execute({ release, stateFile, state, report }) {
      const { child, ready } = startWorker({ mode: 'update', ...configuration(), release, stateFile, state }, true);
      let prepared = false;
      let handedOff = false;
      try {
        await ready;
        prepared = true;
        await report({ status: 'installing' });
        child.send({ mode: 'drain' });
        handedOff = true;
      } finally {
        if (prepared && !handedOff && child.connected) child.send({ mode: 'cancel' });
        if (child.connected) child.disconnect();
        child.unref();
      }
      await shutdown();
    },
  };
  return adapter;
}
