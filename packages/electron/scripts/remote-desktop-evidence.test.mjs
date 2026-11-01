import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('real Chromium capture page adapts the encoder and skips static JPEGs without losing changed/dropped frames', { timeout: 55000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remote-desktop-evidence-'));
  let child;
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const assets = pkg.build.files.filter(file => file.startsWith('remote-desktop'));
    expect(assets).toEqual(expect.arrayContaining(['remote-desktop.html', 'remote-desktop-preload.cjs', 'remote-desktop-capture.mjs', 'remote-desktop-quality.mjs']));
    const staged = path.join(directory, 'packaged-capture');
    await mkdir(staged);
    for (const file of assets) await copyFile(path.join(root, file), path.join(staged, file));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'remote-desktop-evidence.mjs');
    child = spawn(createRequire(import.meta.url)('electron'), [script, directory, staged, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, stdio: 'pipe', windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Electron timed out: ${stdout}\n${stderr}`)); }, 50000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
    const line = stdout.split('\n').find(value => value.startsWith('REMOTE_DESKTOP_EVIDENCE '));
    expect(line, stderr).toBeDefined();
    const result = JSON.parse(line.slice('REMOTE_DESKTOP_EVIDENCE '.length));
    expect(result.error, stderr).toBeUndefined();
    expect(result.environment).toEqual({ secure: true, mediaDevices: true });
    expect(result.video).toEqual({ width: 1280, height: 720 });
    expect(result.stats[0].framesDecoded).toBeGreaterThan(10);
    expect(result.framesWithoutAck).toBe(1);
    expect(result.idleFrames).toBe(0);
    expect(result.retriedDroppedFrame).toBe(true);
    expect(result.frames).toBe(5);
    expect(result.encoding.initial).toMatchObject({ maxBitrate: 1500000, maxFramerate: 20, scaleResolutionDownBy: 2 });
    expect(result.encoding.reduced).toMatchObject({ maxBitrate: 750000, maxFramerate: 12 });
    expect(result.encoding.reduced.scaleResolutionDownBy).toBeCloseTo(8 / 3);
    expect(result.encoding.recovered).toMatchObject({ maxBitrate: 1500000, maxFramerate: 20, scaleResolutionDownBy: 2 });
    expect(result.zoomEncoding).toMatchObject({ width: 2560, height: 1440, parameters: {
      maxBitrate: 1500000, maxFramerate: 10, scaleResolutionDownBy: 1, degradationPreference: 'maintain-resolution',
    } });
    expect(result.fitEncoding).toMatchObject({ maxBitrate: 1500000, maxFramerate: 20, scaleResolutionDownBy: 2, degradationPreference: 'balanced' });
    expect(result.zoomJpegSize).toEqual({ width: 2560, height: 1440 });
    expect(result.fitJpegSize).toEqual({ width: 1440, height: 810 });
    expect(result.duplicateComparison).toMatchObject({ samples: 300, bytes: 512 * 1024, duplicateSends: 0 });
    console.log('Synthetic capture evidence:', JSON.stringify({ video: result.video, encoding: result.encoding,
      idleFrames: result.idleFrames, zoomEncoding: result.zoomEncoding, zoomJpegSize: result.zoomJpegSize, duplicateComparison: result.duplicateComparison }));
    expect(result.bytes).toBeGreaterThan(1000);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
