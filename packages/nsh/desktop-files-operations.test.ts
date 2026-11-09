import { expect, test } from 'vitest';
import { createDesktopFileOperations, desktopFileChild, type DesktopFileCommand } from './desktop-files-operations';
import type { DesktopEditorOperation } from './desktop-files-editor-model';
import type { DesktopPanelScope } from './desktop-panel-model';

const scope: DesktopPanelScope = { host: { hostID: 'synthetic', lease: 'lease' }, authorityKey: 'authority', sessionID: 'a', directory: '/workspace' };
function fixture() {
  let current = true, guard = true, final = true, unknown = false, status = 0;
  const requests: Array<{ path: string; method: string; body: unknown }> = [], confirmed: string[] = [];
  const paths = new Set(['/workspace/source.ts', '/workspace/dir']);
  const owner = createDesktopFileOperations(scope, { guard: async () => guard ? () => final : null, confirmed: path => confirmed.push(path) });
  const operation: DesktopEditorOperation = { scope, current: () => current, request: async (route, method = 'GET', body) => {
    requests.push({ path: route, method, body });
    const path = new URL('https://synthetic.invalid' + route).searchParams.get('path')!;
    if (method === 'GET') {
      if (status) throw Object.assign(new Error('stat_rejected'), { status });
      if (!paths.has(path)) throw Object.assign(new Error('missing'), { status: 404 });
      return { path, isFile: !path.endsWith('/dir'), isDirectory: path.endsWith('/dir') };
    }
    if (unknown) throw new Error('transport_unknown');
    const value = body as { path: string; newPath: string };
    return { success: true, path: value.newPath || value.path };
  } };
  return { owner, operation, requests, confirmed, paths, current(value: boolean) { current = value; }, guard(value: boolean) { guard = value; }, final(value: boolean) { final = value; }, unknown(value: boolean) { unknown = value; }, status(value: number) { status = value; } };
}

test('CRUD and Reveal use only verified Host HTTP bodies, not fabricated CAS fields or local-native APIs', async () => {
  const cases: Array<[DesktopFileCommand, string, unknown]> = [
    [{ kind: 'file', parent: '/workspace', name: 'new.ts' }, 'write', { path: '/workspace/new.ts', content: '' }],
    [{ kind: 'directory', parent: '/workspace', name: 'new' }, 'mkdir', { path: '/workspace/new' }],
    [{ kind: 'rename', path: '/workspace/source.ts', name: 'renamed.ts' }, 'rename', { oldPath: '/workspace/source.ts', newPath: '/workspace/renamed.ts' }],
    [{ kind: 'delete', path: '/workspace/dir' }, 'delete', { path: '/workspace/dir' }],
    [{ kind: 'reveal', path: '/workspace' }, 'reveal', { path: '/workspace' }],
  ];
  for (const [command, route, body] of cases) {
    const f = fixture(); expect(await f.owner.run(command, f.operation)).toBe(true);
    expect(f.requests.filter(item => item.method === 'POST')).toEqual([{ path: '/api/fs/' + route + '?directory=%2Fworkspace', method: 'POST', body }]);
    expect(f.confirmed).toEqual(command.kind === 'rename' ? ['/workspace/source.ts', '/workspace/renamed.ts'] : command.kind === 'delete' ? ['/workspace/dir'] : []);
  }
});
test('cancelled dirty protection and final re-edit checks block destructive POSTs', async () => {
  for (const fail of ['guard', 'final']) {
    const f = fixture(); if (fail === 'guard') f.guard(false); else f.final(false);
    expect(await f.owner.run({ kind: 'delete', path: '/workspace/dir' }, f.operation)).toBe(false);
    expect(f.requests.some(item => item.method === 'POST')).toBe(false); expect(f.confirmed).toEqual([]);
  }
});
test('existing destinations and non-404 preflight failures are never treated as safe creation', async () => {
  const existing = fixture(); expect(await existing.owner.run({ kind: 'file', parent: '/workspace', name: 'source.ts' }, existing.operation)).toBe(false);
  expect(existing.owner.state().detail).toBe('desktop_file_target_exists');
  for (const status of [401, 403, 500]) {
    const f = fixture(); f.status(status); expect(await f.owner.run({ kind: 'file', parent: '/workspace', name: 'new.ts' }, f.operation)).toBe(false);
    expect(f.requests.some(item => item.method === 'POST')).toBe(false);
  }
});
test('unknown mutations remain pinned across explicit inspect and can never be replayed by retry/new actions', async () => {
  const f = fixture(); f.unknown(true);
  expect(await f.owner.run({ kind: 'delete', path: '/workspace/source.ts' }, f.operation)).toBe(false);
  expect(f.owner.state().phase).toBe('unknown'); expect(f.owner.protected()).toBe(true);
  for (const status of [401, 404, 0]) {
    f.status(status); await f.owner.inspect(f.operation);
    expect(await f.owner.run({ kind: 'delete', path: '/workspace/source.ts' }, f.operation)).toBe(false);
  }
  expect(f.requests.filter(item => item.method === 'POST')).toHaveLength(1); expect(f.confirmed).toEqual([]);
});
test('Host retirement and same-ID authority change fail admission; a same-authority lease renewal can inspect', async () => {
  const f = fixture(); f.current(false);
  expect(await f.owner.run({ kind: 'delete', path: '/workspace/source.ts' }, f.operation)).toBe(false); expect(f.requests).toHaveLength(0);
  f.current(true);
  expect(await f.owner.run({ kind: 'delete', path: '/workspace/source.ts' }, { ...f.operation, scope: { ...scope, authorityKey: 'other' } })).toBe(false);
  expect(f.requests).toHaveLength(0);
  expect(await f.owner.run({ kind: 'reveal', path: '/workspace/source.ts' }, { ...f.operation, scope: { ...scope, host: { ...scope.host, lease: 'renewed' } } })).toBe(true);
});
test('names cannot escape the workspace or create implicit subpaths, and root rename/delete are forbidden', async () => {
  expect(desktopFileChild('/', '/', 'new.ts')).toBe('/new.ts');
  expect(desktopFileChild('C:/', 'C:/', 'new.ts')).toBe('C:/new.ts');
  for (const name of ['', '..', '../outside', 'a/b', 'a\\b', ' bad ', 'bad\0']) expect(() => desktopFileChild('/workspace', '/workspace', name)).toThrow();
  for (const root of ['C:/workspace', '//host/share']) for (const name of ['a:b', 'a*', 'a.']) expect(() => desktopFileChild(root, root, name)).toThrow();
  const f = fixture(); expect(await f.owner.run({ kind: 'delete', path: '/workspace' }, f.operation)).toBe(false);
  expect(f.requests).toHaveLength(0);
});
