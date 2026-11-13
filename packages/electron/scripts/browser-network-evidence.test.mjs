import { test } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');

test.runIf(process.env.YURI_BROWSER_NETWORK_EVIDENCE === '1').each(['hmr', 'bundled'])(
  'real Electron Browser SOCKS and preload (%s)', { timeout: 60_000 }, async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-browser-evidence-'));
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    try {
      const env = { ...process.env, YURI_BROWSER_EVIDENCE_ROOT: root, YURI_BROWSER_EVIDENCE_MODE: mode };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron,
        ['--headless', '--disable-gpu', path.join(packageRoot, 'scripts/browser-network-evidence.mjs')], { env, stdio: 'inherit' });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Browser evidence timed out')); }, 50_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Browser evidence failed: ${code}`)); });
      });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
);
