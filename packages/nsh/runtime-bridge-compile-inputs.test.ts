import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.name.startsWith('.') || entry.name === 'node_modules' ? []
    : entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.(?:ts|mjs|js)$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
}

it('every actual literal RuntimeBridge compile-input list includes the real AttachmentUploadPolicy source exactly once, without invoking Swift', () => {
  const discovered = new Set<string>();
  for (const filename of files(root)) {
    if (filename === fileURLToPath(import.meta.url)) continue;
    const text = readFileSync(filename, 'utf8');
    if (!text.includes('RuntimeBridge.swift')) continue;
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
    expect((source as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics, path.relative(root, filename)).toEqual([]);
    const inspect = (node: ts.Node) => {
      if (ts.isArrayLiteralExpression(node)) {
        const literals: string[] = [];
        const collect = (child: ts.Node) => { if (ts.isStringLiteral(child)) literals.push(child.text); ts.forEachChild(child, collect); };
        collect(node);
        if (literals.some(value => path.basename(value) === 'RuntimeBridge.swift')) {
          const relative = path.relative(root, filename); discovered.add(relative);
          const policies = literals.filter(value => path.basename(value) === 'AttachmentUploadPolicy.swift');
          expect(policies, `${relative}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`).toHaveLength(1);
          expect(['AttachmentUploadPolicy.swift', 'ios/AttachmentUploadPolicy.swift']).toContain(policies[0]);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  for (const file of ['terminal-runtime-fixture.mjs', 'gui-plugin-runtime-fixture.mjs',
    'settings-voice-recognition-sdk.test.ts', 'settings-voice-recognition-transport.test.ts', 'settings-voice-recognition-relay.test.ts',
    'remote-desktop-transport-native.test.ts', 'scripts/check-native-bridge.mjs', 'scripts/check-passkey.mjs']) expect(discovered.has(file), file).toBe(true);
  expect(existsSync(path.join(root, 'ios/AttachmentUploadPolicy.swift'))).toBe(true);
});

it('the resource SDK delegate compiles every production Swift source, including AttachmentUploadPolicy exactly once', () => {
  const delegate = readFileSync(path.join(root, 'resource-web-preview-swift.test.ts'), 'utf8');
  expect(delegate).toContain("spawnSync(process.execPath, [path.join(root, 'scripts/check-resource-html-sdk.mjs')]");
  expect(delegate).toContain('typechecked: true, changedAfterSnapshot: []');
  const builder = readFileSync(path.join(root, 'scripts/check-resource-html-sdk.mjs'), 'utf8');
  expect(builder).toContain("const sources = (await readdir(path.join(root, 'ios'))).filter(value => value.endsWith('.swift')).sort().map(value => 'packages/nsh/ios/' + value)");
  expect(builder).toContain("sources.push('packages/mobile/ios/App/App/YuriViewExportRenderer.swift')");
  expect(builder).toContain("run(['swiftc', ...flags, '-typecheck', ...sources], output)");
  const sources = readdirSync(path.join(root, 'ios')).filter(value => value.endsWith('.swift'));
  for (const file of ['RuntimeBridge.swift', 'AttachmentUploadPolicy.swift', 'ResourceBridge.swift', 'ResourceWebPreviewBridge.swift',
    'ResourceWebPreviewView.swift', 'ResourceHTMLComponents.swift', 'ResourceSVGImageComponent.swift', 'NativeInputMetadataOwner.swift']) {
    expect(sources.filter(value => value === file), file).toHaveLength(1);
  }
});
