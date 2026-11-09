import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const directory = path.dirname(fileURLToPath(import.meta.url));
describe('native sidebar shared-core boundary, including type imports', () => {
  it('type-checks the actual navigation closure without React, SDK, browser stores or JSX modules', () => {
    const config = ts.readConfigFile(path.join(directory, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
    const program = ts.createProgram(['desktop-sidebar-navigation.ts', 'desktop-sidebar-tree.ts', 'projects-sidebar.ts', 'desktop-documents.ts'].map(file => path.join(directory, file)), {
      ...parsed.options, noEmit: true, skipLibCheck: false,
      // Strictly check declarations too: NSH declares Symbol.dispose and pathe
      // references node:path types. Neither changes the native JSX settings.
      lib: [...(parsed.options.lib ?? []), 'lib.esnext.disposable.d.ts'], types: ['node'],
    });
    const files = program.getSourceFiles().map(file => file.fileName.replaceAll('\\', '/'));
    expect(files.filter(file => /\/ui\/src\/.*\.tsx$|\/ui\/src\/stores\/|\/ui\/src\/sync\/session-navigation\.ts$|\/(?:react|react-dom|zustand|@opencode-ai|@types\/react)\//.test(file))).toEqual([]);
    expect(files).toContain(path.join(directory, '../ui/src/sync/session-navigation-core.ts'));
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n'))).toEqual([]);
  });
});
