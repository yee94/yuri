import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// The parent session alone schedules NSH engines. Pure runs never start one.
const run = process.env.NSH_PROJECTS_ATTENTION_ENGINE === '1' ? test : test.skip;
run('production Projects shows question > permission > running and preserves a viewed block through read failure', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-projects-attention-'));
  try {
    const host = path.join(directory, 'host.js');
    const build = spawnSync('bun', ['build', 'projects-attention-host.js', '--target=browser', '--format=esm', '--outfile', host], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    expect(build.error).toBeUndefined(); expect(build.status, build.stdout + build.stderr).toBe(0);
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Projects attention fixture', id: 'example.yuri.attention', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['runtime.request', 'projects.attention.fixture'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'projects-attention.fixture.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx', '--web-host', host], { cwd: directory, encoding: 'utf8', timeout: 60_000, input: [
      'await app.waitFor("text:Attention catalog ready");',
      'await app.waitFor("id:projects-indicator-root-question");',
      'await app.press("id:project-session-root >> nth=0");',
      'await app.waitFor("id:projects-indicator-root-question");',
      'await app.press("id:attention-fixture-question");',
      'await app.waitFor("id:projects-indicator-root-permission");',
      'await app.press("id:attention-fixture-permission");',
      'await app.waitFor("id:projects-indicator-root-running");',
      'await app.press("id:attention-fixture-fail");',
      'await app.waitFor("id:projects-indicator-root-question");',
      'await app.press("id:attention-fixture-audit");',
      'await app.waitUntil(() => app.texts().some(text => text.startsWith("{\\"attentionAudit\\":")));',
      'const audit = JSON.parse(app.texts().find(text => text.startsWith("{\\"attentionAudit\\":"))); expect(audit.rejectedRequests).toBe(0); expect(audit.reads.filter(path => path.startsWith("/api/form?")).length).toBeGreaterThanOrEqual(2);',
      'await app.press("id:attention-fixture-recover");',
      'await app.waitFor("id:projects-indicator-root-running");',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 90_000);
