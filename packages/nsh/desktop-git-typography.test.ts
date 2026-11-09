import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
test('all Git diff surfaces use the same reactive point-based code typography without replacing sources or callbacks', () => {
  const filename = path.join(directory, 'desktop-git-diff.tsx');
  const live = new Set(['fontFamily', 'fontSize', 'lineHeight']);
  const lazy: ts.TransformerFactory<ts.SourceFile> = context => source => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && live.has(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node.initializer.expression)));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(source, visit) as ts.SourceFile;
  };
  let style = { fontFamily: 'monospace', fontSize: 12, lineHeight: 19.5 };
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, transformers: { before: [lazy] } }).outputText;
  type Node = { props: Record<string, unknown> };
  const exports: { DesktopGitDiff?: (props: Record<string, unknown>) => Node } = {};
  const modules: Record<string, unknown> = { nsh: { computed: (read: () => unknown) => read }, 'nsh/base': { DiffView: 'DiffView' }, './appearance': { nativeChatTextStyle: (role: string) => { expect(role).toBe('code'); return style; } } };
  vm.runInNewContext(source, { exports, require: (key: string) => { if (!(key in modules)) throw new Error('Unexpected dependency: ' + key); return modules[key]; }, jsx: (_type: unknown, props: Record<string, unknown>) => {
    for (const key of live) Object.defineProperty(props, key, { get: props[key] as () => unknown });
    return { props };
  } });
  const ref = () => {}, onLineSelectionChange = () => {}, patch = '@@ -1 +1 @@\n-a\n+b\n';
  const node = exports.DesktopGitDiff!({ patch, ref, onLineSelectionChange });
  expect(node.props).toMatchObject({ fontFamily: 'monospace', fontSize: 12, lineHeight: 19.5 });
  style = { fontFamily: 'JetBrains Mono', fontSize: 18, lineHeight: 29.25 };
  expect(node.props).toMatchObject(style); expect(node.props.patch).toBe(patch); expect(node.props.ref).toBe(ref); expect(node.props.onLineSelectionChange).toBe(onLineSelectionChange);
  for (const file of ['desktop-git.tsx', 'desktop-git-changes.tsx', 'desktop-git-extra.tsx']) {
    const content = readFileSync(path.join(directory, file), 'utf8');
    expect(content).not.toMatch(/<DiffView\b/); expect(content).toContain('<DesktopGitDiff');
  }
});

for (const platform of ['macos', 'windows']) test(`headless ${platform}: Git hunk/history/PR fonts resize rows and retain dirty drafts, selected hunk and native line range without extra reads`, () => {
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || process.env.TMPDIR || tmpdir(), 'nsh-git-typography-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Synthetic Git typography', id: 'example.yuri.git-typography', version: '0.1.0', build: 1, theme: path.join(directory, 'theme.json'), capabilities: { clipboard: true, host: ['runtime.request'] } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(directory, 'desktop-git-typography-fixture.tsx'))};`);
    const steps = [
      'const stats = () => JSON.parse(app.texts().find(text => text.startsWith("typography-stats:")).slice(17));',
      'const probe = () => JSON.parse(app.texts().find(text => text.startsWith("typography-probe:")).slice(17));',
      'await app.waitFor("text:typography-ready:true"); await app.waitFor("id:desktop-git-message");',
      'await app.type("id:desktop-git-message", "dirty commit draft"); await app.press("id:typography-select");',
      'expect(probe().range).toEqual({side:"new",start:0,end:1}); const original = probe(); expect(original.mounts).toBe(1);',
      'expect(app.spanStyle("id:typography-probe-diff >> text:PROBE_NEW_ONE").fontSize).toBe(12);',
      'await app.press("id:desktop-git-hunks-working-both.ts"); await app.waitFor("id:desktop-git-hunk-1"); await app.press("id:desktop-git-hunk-1"); await app.waitUntil(() => app.texts().includes("new tail"));',
      'const reads = stats().reads; await app.press("id:typography-scale-150"); await app.press("id:typography-family"); await app.press("id:typography-inspect");',
      'expect(app.spanStyle("id:typography-probe-diff >> text:PROBE_NEW_ONE").fontSize).toBe(18); expect(app.spanStyle("id:desktop-git-hunk-diff >> text:new tail").fontSize).toBe(18);',
      'expect(probe().range).toEqual(original.range); expect(probe().text).toBe(original.text); expect(probe().mounts).toBe(1); expect(probe().stats).toEqual(original.stats); expect(probe().before).toBe(original.before); expect(probe().after).toBe(original.after);',
      'expect(Math.abs(probe().bounds[0].bounds.size.height / original.bounds[0].bounds.size.height - 1.5) < 0.0001).toBe(true); expect(stats().reads).toBe(reads); expect(stats().writes).toBe(0);',
      'expect(app.value("id:desktop-git-message")).toBe("dirty commit draft");',
      'await app.press("id:typography-hide"); const hiddenReads = stats().reads; for (let i = 0; i < 25; i++) { await app.press("id:typography-scale-100"); await app.press("id:typography-scale-150"); } await app.wait(200); expect(stats().reads).toBe(hiddenReads);',
      'await app.press("id:typography-inspect"); expect(probe().range).toEqual(original.range); expect(probe().mounts).toBe(1); await app.press("id:typography-hide");',
      'await app.press("id:desktop-git-tab-history"); await app.waitFor("id:desktop-git-history-abcdef1234567"); await app.press("id:desktop-git-history-abcdef1234567"); await app.waitFor("id:desktop-git-history-file-history.ts"); await app.press("id:desktop-git-history-file-history.ts"); await app.waitFor("id:desktop-git-history-diff");',
      'expect(app.spanStyle("id:desktop-git-history-diff >> text:HISTORY_AFTER").fontSize).toBe(18); const historyReads = stats().reads; await app.press("id:typography-scale-100"); expect(app.spanStyle("id:desktop-git-history-diff >> text:HISTORY_AFTER").fontSize).toBe(12); expect(stats().reads).toBe(historyReads);',
      'await app.press("id:desktop-git-tab-pr"); await app.waitFor("id:desktop-git-pr-details"); await app.press("id:desktop-git-pr-details"); await app.waitFor("id:desktop-git-pr-file-pr-history.ts"); await app.press("id:desktop-git-pr-file-pr-history.ts"); await app.waitUntil(() => app.texts().includes("PR_HISTORY_AFTER"));',
      'await app.press("id:desktop-git-pr-edit"); await app.clear("id:desktop-git-pr-title"); await app.type("id:desktop-git-pr-title", "dirty PR title"); await app.type("id:desktop-git-pr-body", " dirty PR body"); const prBody = app.value("id:desktop-git-pr-body");',
      'const prReads = stats().reads; expect(app.spanStyle("id:desktop-git-pr-diff >> text:PR_HISTORY_AFTER").fontSize).toBe(12); await app.press("id:typography-scale-150"); expect(app.spanStyle("id:desktop-git-pr-diff >> text:PR_HISTORY_AFTER").fontSize).toBe(18); expect(stats().reads).toBe(prReads); expect(app.value("id:desktop-git-pr-title")).toBe("dirty PR title"); expect(app.value("id:desktop-git-pr-body")).toBe(prBody);',
      'await app.press("id:desktop-git-tab-changes"); expect(app.value("id:desktop-git-message")).toBe("dirty commit draft"); expect(stats().writes).toBe(0);',
    ].join('\n');
    writeFileSync(path.join(temporary, 'Typography.test.ts'), `import { expect, open, test } from 'nsh/test'; test('Git typography', async () => { const app = await open('./App.tsx', { platform: ${JSON.stringify(platform)}, width: 1400, height: 1000 }); ${steps} }, 60000);`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Typography.test.ts', '--web-host', path.join(directory, 'desktop-git-fixture-host.js')], { cwd: temporary, encoding: 'utf8', timeout: 75_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);
