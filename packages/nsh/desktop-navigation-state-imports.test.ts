import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import ts from 'typescript';

it('type-checks the navigation core/NSH adapter and fixture without loading a draft store, transport or application root', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const config = ts.readConfigFile(path.join(directory, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
  const files = ['desktop-navigation-state-core.ts', 'desktop-navigation-state.ts', 'desktop-navigation-state-fixture.tsx', 'desktop-navigation-state-core.test.ts',
    '.nsh/types/nsh/globals.d.ts', '.nsh/types/nsh/assets.d.ts', '.nsh/types/nsh/tokens.d.ts'];
  const program = ts.createProgram(files.map(file => path.join(directory, file)), {
    ...parsed.options, noEmit: true, skipLibCheck: true,
    lib: [...(parsed.options.lib ?? []), 'lib.esnext.disposable.d.ts'], types: ['node'],
  });
  const source = program.getSourceFiles().map(file => file.fileName.replaceAll('\\', '/'));
  expect(source.filter(file => /\/nsh\/(?:application|state|drafts|new-session|runtime)\.tsx?$|\/(?:react|react-dom|zustand|@opencode-ai)\//.test(file))).toEqual([]);
  expect(ts.getPreEmitDiagnostics(program).map(item => `${item.file?.fileName}: ${ts.flattenDiagnosticMessageText(item.messageText, '\n')}`)).toEqual([]);
});
