import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('native remote desktop shared helpers', () => {
  it('type-checks gestures without the browser connection or React dependency tree', () => {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const config = ts.readConfigFile(path.join(directory, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
    const program = ts.createProgram([
      path.join(directory, '.nsh/types/nsh/globals.d.ts'),
      path.join(directory, '../ui/src/lib/remote-desktop/gestures.ts'),
    ], parsed.options);
    const browserDependencies = program.getSourceFiles().map(file => file.fileName).filter(file =>
      /\/lib\/(?:remote-desktop\/connection|relay\/|runtime-)/.test(file)
      || /\/node_modules\/(?:@types\/)?react(?:-dom)?\//.test(file));
    expect(browserDependencies).toEqual([]);
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });
});
