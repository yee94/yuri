import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { record, text } from './model';

const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
const directory = path.dirname(fileURLToPath(import.meta.url));
function fixture() {
  const source = ts.createSourceFile('new-session-page.tsx', readFileSync(path.join(directory, 'new-session-page.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'NewSessionBranchSelector')!;
  const statements = declaration.body!.statements.filter(node => !ts.isReturnStatement(node)).map(node => node.getText(source)).join('\n');
  const code = ts.transpileModule(`function component(props) { ${statements}; return { load, branch, options, repository, busy, error }; }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  let active = true, valid = true;
  const responses = new Map<string, unknown>([
    ['/api/git/check?directory=%2Frepo', { isGitRepository: true }],
    ['/api/git/branches?directory=%2Frepo', { current: 'main', all: ['main', 'topic'] }],
    ['/api/git/worktrees?directory=%2Frepo', [{ path: '/repo', branch: 'main' }, { path: '/tree', branch: 'topic' }]],
    ['/api/git/branches?directory=%2Ftree', { current: 'topic', all: ['topic'] }],
  ]);
  const request = vi.fn(async (resource: string) => { const response = responses.get(resource); if (response instanceof Error) throw response; return response; });
  const ports = { signal, record, text, effect: () => {}, cleanup: () => {}, t: (key: string) => key };
  const component = new Function(...Object.keys(ports), `${code}; return component;`)(...Object.values(ports));
  const api = component({ owner: { project: { path: '/repo' }, directory: '/tree', current: () => valid, captureOperation: () => ({ current: () => valid, request }) }, enabled: () => active });
  return { api, request, responses, deactivate: () => { active = false; }, retire: () => { valid = false; } };
}

describe('desktop new-session branch presentation reads (production closures, not AppKit)', () => {
  it('reads true branch names and existing worktree directories without mutating Git or sessions', async () => {
    const page = fixture(); await page.api.load();
    expect(page.api.branch()).toBe('topic');
    expect(page.api.options()).toEqual([{ path: '/repo', label: 'main' }, { path: '/tree', label: 'topic' }]);
    expect(page.request.mock.calls.every(call => call.length === 1 && call[0].startsWith('/api/git/'))).toBe(true);
  });
  it('preserves a valid worktree snapshot on independent list refresh failure', async () => {
    const page = fixture(); await page.api.load();
    page.responses.set('/api/git/worktrees?directory=%2Frepo', new Error('offline'));
    page.responses.set('/api/git/branches?directory=%2Frepo', { current: 'renamed', all: ['renamed'] });
    await page.api.load();
    expect(page.api.options()).toEqual([{ path: '/repo', label: 'renamed' }, { path: '/tree', label: 'topic' }]);
    expect(page.api.error()).toBeTruthy(); expect(page.api.branch()).toBe('topic');
  });
  it('distinguishes unavailable repository checks from authoritative non-Git', async () => {
    const page = fixture(); page.responses.set('/api/git/check?directory=%2Frepo', new Error('offline')); await page.api.load();
    expect(page.api.repository()).toBeUndefined(); expect(page.api.error()).toBeTruthy();
    page.responses.set('/api/git/check?directory=%2Frepo', { isGitRepository: false }); await page.api.load();
    expect(page.api.repository()).toBe(false); expect(page.api.error()).toBe(''); expect(page.api.options()).toEqual([]);
  });
  it('does not publish late results after the page/Host loses admission', async () => {
    const page = fixture(); let resolve!: (value: unknown) => void;
    page.responses.set('/api/git/check?directory=%2Frepo', new Promise(done => { resolve = done; }));
    const loading = page.api.load(); page.retire(); resolve({ isGitRepository: true }); await loading;
    expect(page.api.repository()).toBeUndefined(); expect(page.request).toHaveBeenCalledTimes(1);
    page.deactivate(); await page.api.load(); expect(page.request).toHaveBeenCalledTimes(1);
  });
});
