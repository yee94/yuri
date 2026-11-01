import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('real Chromium capture page sends WebRTC video and bounded, acknowledged JPEG fallback', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remote-desktop-evidence-'));
  let child;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'remote-desktop-evidence.mjs');
    child = spawn(createRequire(import.meta.url)('electron'), [script, directory, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, stdio: 'pipe', windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Electron timed out: ${stdout}\n${stderr}`)); }, 25000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
    const line = stdout.split('\n').find(value => value.startsWith('REMOTE_DESKTOP_EVIDENCE '));
    expect(line, stderr).toBeDefined();
    const result = JSON.parse(line.slice('REMOTE_DESKTOP_EVIDENCE '.length));
    expect(result.error, stderr).toBeUndefined();
    expect(result.environment).toEqual({ secure: true, mediaDevices: true });
    expect(result.video).toEqual({ width: 640, height: 360 });
    expect(result.stats[0].framesDecoded).toBeGreaterThan(10);
    expect(result.framesWithoutAck).toBe(1);
    expect(result.frames).toBe(2);
    expect(result.bytes).toBeGreaterThan(1000);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
