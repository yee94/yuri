import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { runSwiftBuildStage } from './build-process.mjs';

it('reports the failing stage and kills only its exact timed-out process tree, including a TERM-resistant child', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-build-stage-'));
  const pidFile = path.join(temporary, 'child.json'), events: Array<Record<string, unknown>> = [];
  try {
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
fs.writeFileSync(process.argv[1],JSON.stringify({driver:process.pid,child:child.pid}));
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    await expect(runSwiftBuildStage(process.execPath, ['-e', script, pidFile], temporary,
      { stage: 'test-exact-timeout', timeoutMs: 2500, report: event => events.push(event) })).rejects.toMatchObject({ code: 'ETIMEDOUT', stage: 'test-exact-timeout' });
    expect(existsSync(pidFile)).toBe(true);
    const ids = JSON.parse(readFileSync(pidFile, 'utf8'));
    const last = events.at(-1)!;
    expect(last.errorStage).toBe('test-exact-timeout');
    expect(last.ownedPIDs).toEqual(expect.arrayContaining([ids.driver, ids.child]));
    const rows = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' }).split('\n');
    for (const pid of [ids.driver, ids.child]) {
      const row = rows.find(value => Number(value.trim().split(/\s+/)[0]) === pid);
      expect(!row || row.includes('Z')).toBe(true);
    }
    expect(last.ownedPIDs).not.toContain(process.pid);
    expect(events[0].timeoutMs).toBe(2500);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 20000);

it('keeps the optimized link at 600000ms and all other command limits at 240000ms', () => {
  const builder = readFileSync(new URL('./build.mjs', import.meta.url), 'utf8');
  expect(builder).toContain("stage: 'swift-optimized-link', timeoutMs: 600000");
  expect(builder).toContain("stage: 'swift-typecheck'");
  expect(builder).toContain('timeout: 240000');
  expect(builder).toContain("'-O', '-framework', 'NativeShell'");
});
