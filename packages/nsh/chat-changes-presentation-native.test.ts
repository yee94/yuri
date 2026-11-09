import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('retained Changes presenter uses one guarded owner across native platform models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'changes-presentation-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Changes presentation', id: 'example.changes.presentation', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request', 'changes.presentation.preview'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'chat-changes-presentation-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Presentation.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/chat-changes-presentation/Presentation.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Presentation.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 150_000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 160_000);

test('nullable-source presenter retains unknown lock and commit draft after late native ACK', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'changes-presentation-late-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Changes late receipt', id: 'example.changes.late', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request', 'changes.fixture.control'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'chat-changes-presentation-fixture.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx', '--web-host', path.join(root, 'chat-changes-actions-fixture-host.js')], {
      cwd: directory, encoding: 'utf8', timeout: 65_000, input: [
        'await app.waitFor("text:PRESENTATION_READY");',
        'const audit = () => JSON.parse(app.texts().find(value => value.startsWith("changes-audit:")).slice(14));',
        'await app.press("id:changes-fixture-seed-staged"); await app.press("id:changes-fixture-workspace");',
        'await app.waitUntil(() => app.enabled("id:changes-commit-message"));',
        'await app.type("id:changes-commit-message", "Exact fixture commit");',
        'await app.press("id:changes-fixture-hold-commit"); await app.press("id:changes-commit");',
        'await app.waitUntil(() => audit().commitCalls === 1);',
        'await app.press("id:changes-close"); await app.waitFor("id:native-changes-sheet", { state: "gone" });',
        'const closed = audit().getReads; await app.wait(60); expect(audit().getReads).toBe(closed);',
        'await app.press("id:changes-fixture-workspace"); await app.waitFor("id:changes-write-unknown");',
        'expect(app.value("id:changes-commit-message")).toBe("Exact fixture commit");',
        'await app.type("id:changes-commit-message", " new draft"); const reopened = audit().getReads;',
        'await app.press("id:changes-fixture-release"); await app.waitUntil(() => audit().commitAcks === 1); await app.wait(60);',
        'expect(audit().getReads).toBe(reopened); expect(audit().posts).toBe(1);',
        'expect(app.value("id:changes-commit-message")).toBe("Exact fixture commit new draft");',
        'expect(app.enabled("id:changes-commit")).toBe(false); expect(app.shows("id:changes-write-unknown")).toBe(true);',
      ].join('\n'),
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 75_000);
