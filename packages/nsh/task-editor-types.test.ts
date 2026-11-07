import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the complete Native type graph keeps Task autocomplete outside the Web client and React context', () => {
  const configFile = path.join(root, 'packages/nsh/tsconfig.json');
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile));
  expect(parsed.errors).toEqual([]);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const files = program.getSourceFiles().map(file => path.relative(root, file.fileName).replace(/\\/g, '/'));
  expect(files).toContain('packages/nsh/task-editor-prompt-core.ts');
  expect(files).toContain('packages/ui/src/components/chat/fileMentionAutocompleteState.ts');
  const forbidden = files.filter(file => /^packages\/ui\/src\/lib\/(?:opencode\/client\.ts|desktop\.ts|persistence\.ts|i18n\/context\.tsx)$/.test(file));
  expect(forbidden, 'Type-only imports must not pull Web runtime owners into the Native program').toEqual([]);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
}, 30_000);
