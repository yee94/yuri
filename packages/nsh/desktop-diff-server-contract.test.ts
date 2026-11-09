import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourceFile = (name: string) => {
  const file = path.join(root, '../web/server/lib/git', name);
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
};

/** Evaluate the actual owning function with isolated I/O seams: no git, Host,
 * filesystem reads or network. This is a source contract, not an OS test. */
function service(options: { head?: string; index?: string; working?: string; headMissing?: boolean; indexMissing?: boolean; deleted?: boolean; fsBinary?: boolean } = {}) {
  const source = sourceFile('service.js'), node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getFileDiff');
  if (!node) throw new Error('Owning getFileDiff missing');
  const calls: string[] = [];
  const context = {
    createRepositoryGitContext: async () => ({ directoryPath: '/repo', directoryGit: {}, repoRoot: '/repo', git: { show: async (args: string[]) => {
      calls.push(args[0]);
      if (args[0].startsWith('HEAD:')) { if (options.headMissing) throw new Error('HEAD path missing'); return options.head ?? 'HEAD_TEXT'; }
      if (options.indexMissing) throw new Error('index path missing'); return options.index ?? 'INDEX_TEXT';
    } } }),
    resolveGitFileContext: async () => ({ absolutePath: '/repo/destination.ts', repoPath: 'destination.ts' }),
    isImageFile: () => false, looksBinaryBySniff: async () => options.fsBinary === true, isBinaryDiff: async () => false,
    fsp: { stat: async () => { calls.push('stat'); if (options.deleted) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { isFile: () => true }; }, readFile: async () => { calls.push('fs.readFile'); return options.working ?? 'WORKING_TEXT'; } },
    console: { error() {} },
  };
  const run = vm.runInNewContext(node.getText(source).replace(/^export\s+/, '') + '\ngetFileDiff', context) as (directory: string, options: { path: string; staged: boolean }) => Promise<{ original: string; modified: string; path: string; isBinary: boolean }>;
  return { calls, run: (staged: boolean) => run('/repo', { path: 'destination.ts', staged }) };
}

it('the actual file-diff route forwards path/staged and exposes original/modified/path/isBinary, not before/after or an inferred source', async () => {
  const source = sourceFile('routes.js'); let handler: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'app.get' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/api/git/file-diff') handler = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(source); if (!handler) throw new Error('Formal file-diff route missing');
  const calls: unknown[] = [], dto = { original: 'HEAD', modified: 'INDEX', path: 'destination.ts', isBinary: false };
  const run = vm.runInNewContext('(' + handler.getText(source) + ')', { getGitLibraries: async () => ({ getFileDiff: async (...args: unknown[]) => { calls.push(args); return dto; } }), console: { error() {} } }) as (request: unknown, response: unknown) => Promise<void>;
  let body: unknown, code = 200;
  const response = { json(value: unknown) { body = value; }, status(value: number) { code = value; return this; } };
  await run({ query: { directory: '/repo', path: 'destination.ts', staged: 'true' } }, response);
  expect(calls).toEqual([['/repo', { path: 'destination.ts', staged: true }]]); expect(body).toEqual(dto); expect(code).toBe(200);
  await run({ query: { directory: '/repo', path: 'destination.ts' } }, response);
  expect(calls[1]).toEqual(['/repo', { path: 'destination.ts', staged: false }]);
});

it('actual service compares HEAD->index for staged, but HEAD->filesystem for working: index is never substituted by the native adapter', async () => {
  const staged = service(); expect(await staged.run(true)).toEqual({ original: 'HEAD_TEXT', modified: 'INDEX_TEXT', path: 'destination.ts', isBinary: false }); expect(staged.calls).toEqual(['HEAD:destination.ts', ':destination.ts']);
  const working = service(); expect(await working.run(false)).toEqual({ original: 'HEAD_TEXT', modified: 'WORKING_TEXT', path: 'destination.ts', isBinary: false }); expect(working.calls).toEqual(['HEAD:destination.ts', 'stat', 'fs.readFile']);
});

it('formal service limitations remain observable: swallowed HEAD, missing staged deletion, rename destination and working-file binary sniff', async () => {
  const newOrRename = service({ headMissing: true }); expect((await newOrRename.run(false)).original).toBe(''); expect(newOrRename.calls).toEqual(['HEAD:destination.ts', 'stat', 'fs.readFile']);
  const deletion = service({ deleted: true }); expect((await deletion.run(false)).modified).toBe('');
  await expect(service({ indexMissing: true }).run(true)).rejects.toThrow('index path missing');
  const binary = service({ fsBinary: true }); expect(await binary.run(true)).toEqual({ original: '', modified: '', path: 'destination.ts', isBinary: true }); expect(binary.calls).toEqual([]);
});

it('formal service normalizes CRLF but does not truncate returned text; adapter must not promise byte-exact Git blobs', async () => {
  const text = 'source\r\n'.repeat(40_000) + 'END';
  const fixture = service({ head: text, index: text }); const result = await fixture.run(true);
  expect(result.original).toBe(text.replace(/\r\n/g, '\n')); expect(result.modified.endsWith('END')).toBe(true);
});
