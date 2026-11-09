import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
const input = path.resolve('.scratch/nsh/identity-f37195ff-sequence/native-before.json');

it.skipIf(!existsSync(input))('freezes the complete real ten-binding control, keeps all 425 audits and bits, but converts only 87 unique audits', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-control-value-'));
  try {
    const binary = path.join(temporary, 'probe'), wire = path.join(temporary, 'control.tlv');
    const compiled = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '6', '-parse-as-library',
      ...['SnapshotValue.swift', 'NativeSnapshotValue.swift', 'ControlValueSnapshot.swift', 'ControlValueProbe.swift'].map(name => path.join(root, 'v4', name)), '-o', binary], { encoding: 'utf8', timeout: 110000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const run = spawnSync(binary, [input, wire], { encoding: 'utf8', timeout: 30000 });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report.bindings).toBe(10);
    expect(report.typedAuditReads).toBe(87);
    expect(report.typedAuditHits).toBe(338);
    expect(report.emittedAuditRecords).toBe(425);
    expect(readFileSync(wire).length).toBe(report.wireBytes);
    console.log('REAL_CONTROL_VALUE ' + run.stdout.trim());
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 150000);
