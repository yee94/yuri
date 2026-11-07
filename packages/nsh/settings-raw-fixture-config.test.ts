import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { prepareGitHubFixture } from './tests/settings-github-config.mjs';
import { prepareAboutFixture } from './tests/settings-about-fixture-config.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
for (const [kind, prepare] of [['github', prepareGitHubFixture], ['about', prepareAboutFixture]] as const) {
  it(`${kind}: generated engine config grants only strict synthetic ports and script remains syntactically executable`, () => {
    const directory = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'nsh-raw-config-'));
    try {
      const fixture = prepare(root, directory);
      const config = JSON.parse(readFileSync(path.join(directory, 'nsh.json'), 'utf8'));
      expect(config.capabilities.host).toContain('connection.list'); expect(config.capabilities.host).toContain('runtime.request');
      expect(Object.keys(config.capabilities)).toEqual(['host']);
      for (const forbidden of ['connection.connect', 'connection.select', 'fetch', 'system.open']) expect(config.capabilities.host).not.toContain(forbidden);
      expect(fixture.host).toBe(path.join(directory, 'host.js'));
      const hostSource = ts.createSourceFile('host.js', readFileSync(fixture.host, 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
      expect(hostSource.statements.some(statement => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) && !!statement.moduleSpecifier)).toBe(false);
      expect(hostSource.statements.some(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'createHost')).toBe(true);
      expect(readFileSync(path.join(directory, 'App.tsx'), 'utf8')).toContain(`settings-${kind}-fixture.tsx`);
      const source = ts.createSourceFile('engine.ts', readFileSync(path.join(root, `settings-${kind}-engine.test.ts`), 'utf8'), ts.ScriptTarget.ES2023, true);
      let script = '';
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'input' && ts.isCallExpression(node.initializer) && ts.isPropertyAccessExpression(node.initializer.expression) && ts.isArrayLiteralExpression(node.initializer.expression.expression)) {
          script = node.initializer.expression.expression.elements.map(item => { if (!ts.isStringLiteral(item)) throw new Error('Unexpected engine script step'); return item.text; }).join('\n');
        }
        ts.forEachChild(node, visit);
      };
      visit(source); expect(script).toContain(`id:${kind}-fixture-ready`);
      expect(() => new vm.Script(`(async () => { ${script}\n })`)).not.toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
