import { expect, it } from 'vitest';
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

it('shared Native turn/activity/header derivation has no React, transport, browser store or Node runtime dependencies', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const config = ts.readConfigFile(path.join(directory, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
  const program = ts.createProgram([
    path.join(directory, '.nsh/types/nsh/globals.d.ts'),
    path.join(directory, 'transcript-body-model.ts'),
    path.join(directory, 'transcript-tools-turn-model.ts'),
  ], parsed.options);
  const dependencies = program.getSourceFiles().map(file => file.fileName).filter(file =>
    /\/ui\/src\/(?:stores\/|contexts\/|queries\/|lib\/(?:runtime-|relay\/|desktop)|sync\/(?:session-projection-api|sync-context|transcript-repository-runtime))/.test(file)
    || /\/node_modules\/(?:@types\/)?(?:react(?:-dom)?|cron-parser)\//.test(file));
  expect(dependencies).toEqual([]);
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
});
