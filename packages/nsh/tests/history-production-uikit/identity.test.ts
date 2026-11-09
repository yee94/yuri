import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { stageHistoryProduction, verifyStage } from './build.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

it('collects only the exact read-only identity sequence and preserves invalid receipts', () => {
  const run = spawnSync('python3', [path.join(root, 'v4/identity_probe_test.py')], { encoding: 'utf8', timeout: 20000 });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stderr).toContain('Ran 4 tests');
});

it('bounds the explicit native baseline without changing the 250ms/5ms admission or allocating a periodic link', () => {
  const observer = readFileSync(path.join(root, 'Observer.swift'), 'utf8');
  const policy = observer.slice(observer.indexOf('enum HistoryIdentityProbePolicy {'), observer.indexOf('/// UIKit diagnostic sampler;'));
  const sibling = observer.slice(observer.indexOf('    static func siblingCoverage('), observer.indexOf('enum HistoryIdentityProbePolicy {'))
    .replace(', observedCoverage: HistoryCoverageTraversal.Result? = nil', '')
    .replace('let coverage = observedCoverage ?? siblingCoverage(', 'let coverage = siblingCoverage(');
  expect(createHash('sha256').update(sibling).digest('hex')).toBe('7ad1f4603295649d823646c3e79f669d357862edb286fb93d8eaf79537d18eec');
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-identity-policy-'));
  try {
    const source = path.join(temporary, 'Policy.swift'), binary = path.join(temporary, 'policy');
    writeFileSync(source, `import Foundation\n${policy}\n
precondition(HistoryIdentityProbePolicy.maximumFrames == 24)
precondition(HistoryIdentityProbePolicy.needsFrame(count: 0, elapsedMs: 0))
precondition(!HistoryIdentityProbePolicy.needsFrame(count: 24, elapsedMs: 0))
precondition(!HistoryIdentityProbePolicy.needsFrame(count: 2, elapsedMs: 275))
precondition(!HistoryIdentityProbePolicy.needsFrame(count: 2, elapsedMs: .nan))
precondition(!HistoryIdentityProbePolicy.deadlineAllowsRead(elapsedMs: 600.001))
precondition(!HistoryIdentityProbePolicy.deadlineAllowsRead(elapsedMs: -.infinity))
print("bounded identity baseline policy passed")
`);
    const compiled = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '6', source, '-o', binary], { encoding: 'utf8', timeout: 110000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    expect(run.status, run.stderr).toBe(0);
    expect(observer).toContain('if !identityOnly {\n            let link = CADisplayLink');
    expect(observer).toContain('identity_prepare_once_no_retry');
    expect(observer).toContain('identity_only_no_mark_or_pan');
    expect(observer).toContain('$0 <= 5');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 120000);

it('stages a separate OFF v4 identity artifact with an executable read-only recipe and frozen unchanged typed modules', async () => {
  const output = mkdtempSync(path.join(tmpdir(), 'history-identity-stage-'));
  try {
    const staged = await stageHistoryProduction({ output, scenario: 'normal', observerVersion: 'v4', observerProfile: 'identity-only' });
    await verifyStage(output, staged.manifest);
    expect(staged.manifest.periodicSampling).toBe(false);
    expect(staged.manifest.historyDriverAdmission).toBe(false);
    expect(staged.manifest.experimentOn).toBe(false);
    expect(staged.manifest.identityBaseline.originalStableBaselineMs).toBe(250);
    expect(staged.manifest.identityBaseline.readBudgetMs).toBe(5);
    expect(existsSync(path.join(output, 'tools/identity-probe.py'))).toBe(true);
    for (const [name, expected] of Object.entries({
      'SnapshotValue.swift': '3784bcb2d0ddd68e98134309638d2b946a1425bbdc0c47ce5616417e24bf9f4a',
      'SegmentWriter.swift': 'b473233b9b213d2d0760aa8395f9b4029e4c876e8e1ace5a7567d0799eadc7fd',
      'CapturePipeline.swift': 'f89acc71d70eb1b7b51e6e8c9effe552ba6027787d77fb3e829948f2e94658c5',
    })) expect(createHash('sha256').update(readFileSync(path.join(root, 'v4', name))).digest('hex')).toBe(expected);
    const geometry = readFileSync(path.join(root, 'v4/TypedGeometry.swift'), 'utf8');
    const original = geometry.replace(/    static func insets\(_ value: UIEdgeInsets\) -> \[String: Double\] \{\n[^\n]*\n    \}\n/, '');
    expect(createHash('sha256').update(original).digest('hex')).toBe('eb274b6e4ccfa672bcfea429dded4684ac45d6acd1d46cd51f552e23dfdeed7c');
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 120000);
