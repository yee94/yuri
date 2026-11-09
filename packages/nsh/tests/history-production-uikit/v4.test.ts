import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { stageHistoryProduction, verifyStage } from './build.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const v4 = path.join(root, 'v4');
const sample = path.resolve('.scratch/nsh/uikit-989dfdee-identity-first/native-before.json');

it('rejects malformed v4 refs and preserves IEEE bit patterns in the independent reader', () => {
  const run = spawnSync('python3', [path.join(v4, 'stream_reader_test.py')], { encoding: 'utf8', timeout: 20000 });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stderr).toContain('Ran 5 tests');
});

it('stages an explicit independent v4 contract and stream reader without changing the v3 default', async () => {
  for (const version of ['v3', 'v4']) {
    const output = mkdtempSync(path.join(tmpdir(), 'history-v4-stage-'));
    try {
      const stage = await stageHistoryProduction({ output, scenario: 'normal', ...(version === 'v4' ? { observerVersion: 'v4' } : {}) });
      await verifyStage(output, stage.manifest);
      expect(stage.manifest.observerVersion).toBe(version);
      expect(stage.manifest.observerContract.startsWith(version === 'v4' ? 'history-native-segments-v4;' : 'instrumented-v3;')).toBe(true);
      expect(existsSync(path.join(output, 'tools/stream_reader_v4.py'))).toBe(version === 'v4');
      expect(stage.manifest.engineStarted).toBe(false);
      expect(stage.manifest.deviceAccessed).toBe(false);
    } finally { rmSync(output, { recursive: true, force: true }); }
  }
}, 120000);

it.skipIf(!existsSync(sample))('runs the real nine-binding payload through bounded queues, durable fences and fault paths', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-v4-focused-'));
  try {
    const binary = path.join(temporary, 'profile');
    const compile = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '6', '-parse-as-library',
      ...['SnapshotValue.swift', 'SegmentWriter.swift', 'CapturePipeline.swift', 'Profile.swift'].map(name => path.join(v4, name)), '-o', binary], { encoding: 'utf8', timeout: 110000 });
    expect(compile.status, compile.stderr).toBe(0);
    let baselineHash: string | undefined;
    for (const [mode, count] of [['normal', 128], ['native', 128], ['typed', 128], ['backpressure', 64], ['cancel', 3], ['ack-gate', 3], ['cancel-waiter', 3], ['event-stop-during-read', 1], ['io-failure', 1], ['manifest-failure', 1], ['timeout', 1]] as const) {
      const output = path.join(temporary, mode);
      const run = spawnSync(binary, [sample, output, String(count), '16', mode], { encoding: 'utf8', timeout: 110000 });
      expect(run.status, mode + ': ' + run.stderr).toBe(0);
      const report = JSON.parse(run.stdout);
      if (mode === 'normal') baselineHash = report.sampledExpandedSHA256;
      if (mode === 'native' || mode === 'typed') expect(report.sampledExpandedSHA256).toBe(baselineHash);
      if (report.manifest) {
        const reportFile = path.join(temporary, mode + '.json'); writeFileSync(reportFile, run.stdout);
        const checked = spawnSync('python3', [path.join(v4, 'stream_reader_test.py'), path.join(output, report.manifest), reportFile], { encoding: 'utf8', timeout: 110000 });
        expect(checked.status, mode + ': ' + checked.stderr).toBe(0);
        const fields = spawnSync('python3', [path.join(v4, 'source_oracle.py'), path.join(output, report.manifest), sample], { encoding: 'utf8', timeout: 110000 });
        expect(fields.status, mode + ': ' + fields.stderr).toBe(0);
      } else {
        expect(['io-failure', 'manifest-failure', 'timeout']).toContain(mode);
      }
      expect(report.peakBatchFrames).toBeLessThanOrEqual(16);
      expect(report.maxRSSBytes).toBeLessThan(512 * 1024 * 1024);
    }
    for (const name of ['SnapshotValue.swift', 'SegmentWriter.swift', 'CapturePipeline.swift']) {
      const source = readFileSync(path.join(v4, name), 'utf8');
      expect(source).not.toContain('unchecked Sendable');
      expect(source).not.toContain('import UIKit');
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240000);
