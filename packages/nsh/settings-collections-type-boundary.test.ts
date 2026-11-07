import { expect, test } from 'vitest';
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('native settings pure adapters do not type-traverse stores, React or browser transports', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const config = ts.readConfigFile(path.join(directory, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
  const program = ts.createProgram([
    path.join(directory, '.nsh/types/nsh/globals.d.ts'),
    path.join(directory, 'settings-collections-core.ts'),
    path.join(directory, 'settings-plugin-runtime-core.ts'),
    path.join(directory, 'settings-saved-permissions-core.ts'),
  ], parsed.options);
  const dependencies = program.getSourceFiles().map(file => file.fileName).filter(file =>
    /\/ui\/src\/(?:stores\/|contexts\/|queries\/|lib\/(?:runtime-|relay\/|desktop|opencode\/(?:plugins|client)\.ts)|sync\/sync-context)/.test(file)
    || /\/node_modules\/(?:@types\/)?(?:react(?:-dom)?|zustand)\//.test(file));
  expect(dependencies).toEqual([]);
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  for (const file of ['../ui/src/lib/mcp-config-types.ts', '../ui/src/lib/opencode/plugin-runtime-types.ts']) {
    const source = program.getSourceFile(path.resolve(directory, file));
    expect(source).toBeDefined();
    expect(source!.statements.every(statement => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))).toBe(true);
  }
});
