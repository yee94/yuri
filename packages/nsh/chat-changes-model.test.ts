import { describe, expect, test } from 'vitest';
import { changeGroups, changesSnapshot, createChangesReader, nativeChangeLocation, nativeSourceHunks, patchLines } from './chat-changes-model';
import { buildChangesTree, flattenChangesTree } from './chat-changes-tree.js';

describe('native Changes authority', () => {
  test('native hunk navigation converts one-based source lines and supports insertion/deletion and nearest changes', () => {
    const hunks = [{ index: 0, oldStart: 4, oldLines: 0, newStart: 4, newLines: 2 }, { index: 1, oldStart: 19, oldLines: 2, newStart: 21, newLines: 0 }];
    expect(nativeChangeLocation([])).toBeUndefined();
    expect(nativeChangeLocation(hunks)).toEqual({ index: 0, line: 5 });
    expect(nativeChangeLocation(hunks, 6)).toEqual({ index: 0, line: 5 });
    expect(nativeChangeLocation(hunks, 20)).toEqual({ index: 1, line: 20 });
    expect(nativeChangeLocation(hunks, 200)).toEqual({ index: 1, line: 20 });
  });
  test('patch ref text offsets map back to source lines across sparse hunk headers', () => {
    const patch = '@@ -8,2 +8,2 @@\n same\n-old\n+new\n@@ -120 +120 @@\n-old target\n+new target';
    const result = nativeSourceHunks([{ index: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }, { index: 1, oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }], patch);
    expect(nativeChangeLocation(result)).toEqual({ index: 0, line: 9 });
    expect(nativeChangeLocation(result, 120)).toEqual({ index: 1, line: 120 });
  });
  test('an explicit empty historical text pair is a clean diff, not missing authority or a Git fallback', async () => {
    const reader = createChangesReader({ kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'm', files: [{ path: 'empty', before: '', after: '' }] }, async () => { throw new Error('Must not fetch'); });
    await reader.select('empty');
    expect(reader.state().diff).toEqual({ path: 'empty', before: '', after: '' });
    expect(reader.state().diffError).toBe('');
  });
  test('native type boundary reuses Web tree collapse and directory batch membership', () => {
    const tree = buildChangesTree([{ path: 'folder/sub/a.ts', index: ' ', working_dir: 'M' }, { path: 'folder/b.ts', index: '?', working_dir: '?' }]);
    expect(tree.children.get('folder')?.files.map(file => file.path)).toEqual(['folder/sub/a.ts', 'folder/b.ts']);
    expect(flattenChangesTree(tree, new Set()).map(row => row.key)).toEqual(['dir:folder']);
    expect(flattenChangesTree(tree, new Set(['folder', 'folder/sub'])).map(row => row.key)).toEqual(['dir:folder', 'dir:folder/sub', 'file:folder/sub/a.ts', 'file:folder/b.ts']);
  });
  test('groups staged and working independently, deduplicates and sorts paths', () => {
    const groups = changeGroups(changesSnapshot({ isClean: false, files: [
      { path: 'z.ts', index: 'M', working_dir: 'M' },
      { path: 'a.ts', index: '?', working_dir: '?' },
      { path: 'z.ts', index: 'M', working_dir: 'M' },
    ] }));
    expect(groups.map(group => [group.staged, group.files.map(file => file.path)])).toEqual([[true, ['z.ts']], [false, ['a.ts', 'z.ts']]]);
    expect(() => changesSnapshot({ isClean: false, files: [{ path: 'x' }] })).toThrow();
  });

  test('patch line numbers and first change do not mistake headers for changed content', () => {
    const lines = patchLines('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -8,2 +8,2 @@\n same\n-old\n+new\n\\ No newline at end of file');
    expect(lines.filter(line => line.kind === 'added' || line.kind === 'removed').map(line => [line.kind, line.oldLine, line.newLine])).toEqual([['removed', 9, null], ['added', null, 9]]);
    expect(lines[2].kind).toBe('meta');
  });

  test('failed status refresh preserves authority and successful empty clears it', async () => {
    let mode = 0;
    const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => {
      if (mode === 1) throw new Error('offline');
      return { isClean: mode === 2, files: mode === 2 ? [] : [{ path: 'a', index: ' ', working_dir: 'M' }] };
    });
    await reader.refresh(); const previous = reader.state().snapshot;
    mode = 1; await reader.refresh();
    expect(reader.state().snapshot).toBe(previous); expect(reader.state().error).toBe('offline');
    mode = 2; await reader.refresh(); expect(reader.state().snapshot?.files).toEqual([]);
  });

  test('history never reads workspace, unknown bodies fail rather than rendering empty success', async () => {
    const calls: string[] = [];
    const reader = createChangesReader({ kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'm', files: [{ path: 'old.ts', patch: '@@ -1 +1 @@\n-old\n+history' }, { path: 'thin.ts' }] }, async path => { calls.push(path); return { diff: '+CURRENT' }; });
    await reader.refresh(); await reader.select('old.ts');
    expect(reader.state().diff?.patch).toContain('+history');
    expect(calls).toEqual([]);
    await reader.select('thin.ts'); expect(reader.state().diff).toBeNull(); expect(reader.state().diffError).not.toBe('');
    expect(calls).toEqual(['/api/yuri/sessions/s/changes?directory=%2Ffixture&messageID=m&file=thin.ts', '/api/session/s/diff?directory=%2Ffixture&messageID=m']);
  });

  test('close, newer selection and Host fences reject late reads', async () => {
    const pending: Array<(value: unknown) => void> = [];
    let host = 1;
    const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, () => new Promise(resolve => pending.push(resolve)), () => host === 1);
    const first = reader.select('a', true), second = reader.select('b', false);
    pending[1]({ diff: '+b' }); await second; pending[0]({ diff: '+a' }); await first;
    expect(reader.state().path).toBe('b'); expect(reader.state().diff?.patch).toBe('+b');
    const third = reader.select('c'); reader.cancel(); pending[2]({ diff: '+c' }); await third;
    expect(reader.state().diff).toBeNull();
    const fourth = reader.select('d'); host = 2; pending[3]({ diff: '+d' }); await fourth;
    expect(reader.state().diff).toBeNull();
  });

  test('failed diff refresh retains exact file body, switching staged scope never reuses it', async () => {
    let fail = false; const paths: string[] = [];
    const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async path => { paths.push(path); if (fail) throw new Error('diff offline'); return { diff: '+authority' }; });
    await reader.select('a.ts', true); fail = true; await reader.retryDiff();
    expect(reader.state().diff?.patch).toBe('+authority'); expect(reader.state().diffError).toBe('diff offline');
    await reader.select('a.ts', false); expect(reader.state().diff).toBeNull(); expect(paths[2]).toContain('staged=false');
  });

  test('thin historical body uses exact turn/file route, failure does not fall back to Git', async () => {
    const paths: string[] = [];
    const reader = createChangesReader({ kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'user-2', files: [{ path: 'a.ts' }] }, async path => { paths.push(path); return { diff: { file: 'a.ts', patch: '@@ -1 +1 @@\n-old\n+turn-two' } }; });
    await reader.select('a.ts');
    expect(reader.state().diff?.patch).toContain('+turn-two');
    expect(paths).toEqual(['/api/yuri/sessions/s/changes?directory=%2Ffixture&messageID=user-2&file=a.ts']);
  });
});
