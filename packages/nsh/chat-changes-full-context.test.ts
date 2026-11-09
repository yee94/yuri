import { describe, expect, it } from 'vitest';
import { createChangesReader, type ChangesSource } from './chat-changes-model';

const patch = '@@ -100,3 +100,3 @@\n SAME\n-BEFORE\n+AFTER\n TAIL\n';
const before = 'prefix\n'.repeat(99) + 'SAME\nBEFORE\nTAIL\n' + 'kept context\n'.repeat(9000) + 'OLD_END';
const after = 'prefix\n'.repeat(99) + 'SAME\nAFTER\nTAIL\n' + 'kept context\n'.repeat(9000) + 'OLD_END';
const full = { path: 'a.ts', original: before, modified: after, isBinary: false };
const status = (index = ' ', working_dir = 'M', path = 'a.ts') => ({ isClean: false, files: [{ path, index, working_dir }] });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('single Changes reader explicit workspace full context', () => {
  it('keeps the mobile/default patch request contract; only explicit demand uses the exact GET DTO and never clips text', async () => {
    const calls: string[] = [];
    const reader = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => {
      calls.push(route); if (route.startsWith('/api/git/file-diff?')) return full;
      return route.startsWith('/api/git/status?') ? status() : { diff: patch };
    });
    await reader.select('a.ts'); const snapshot = reader.state().diff;
    for (let i = 0; i < 50; i++) reader.state();
    expect(calls).toEqual(['/api/git/diff?directory=%2Frepo&path=a.ts&staged=false']);
    await reader.loadFullContext();
    expect(calls.slice(1)).toEqual(['/api/git/status?directory=%2Frepo&mode=light', '/api/git/file-diff?directory=%2Frepo&path=a.ts', '/api/git/status?directory=%2Frepo&mode=light']);
    expect(reader.state().diff).toBe(snapshot);
    expect(reader.state().fullContext).toEqual({ path: 'a.ts', before, after, isBinary: false });
    expect(reader.state().fullContextLoading).toBe(false); expect(reader.state().fullContextError).toBe('');
  });
  it('staged demand carries true and maps actual original/modified, never requests filesystem resources', async () => {
    const calls: string[] = [], path = 'C:\\repo\\a.ts';
    const reader = createChangesReader({ kind: 'workspace', directory: 'C:\\repo' }, async route => {
      calls.push(route); return route.startsWith('/api/git/file-diff?') ? { ...full, path } : route.startsWith('/api/git/status?') ? status('M', 'M') : { diff: patch };
    });
    await reader.select(path, true); await reader.loadFullContext();
    expect(calls[2]).toBe('/api/git/file-diff?directory=C%3A%5Crepo&path=C%3A%5Crepo%5Ca.ts&staged=true');
    expect(reader.state().fullContext?.after).toBe(after);
  });
  it('blocks HEAD-versus-index mismatch, rename/copy/conflict/unknown status and images without inventing a source', async () => {
    for (const [snapshot, error] of [
      [status('M', 'M'), 'full_context_index_baseline_unsupported'],
      [status('A', 'M'), 'full_context_index_baseline_unsupported'],
      [status('R', ' '), 'full_context_rename_unsupported'],
      [status('C', ' '), 'full_context_rename_unsupported'],
      [status('U', 'U'), 'full_context_status_unknown'],
      [{ isClean: true, files: [] }, 'full_context_status_unknown'],
      [{ ...status(), complete: false }, 'full_context_status_incomplete'],
    ] as const) {
      const calls: string[] = [];
      const reader = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => { calls.push(route); return route.startsWith('/api/git/status?') ? snapshot : { diff: patch }; });
      await reader.select('a.ts'); const previous = reader.state().diff; await reader.loadFullContext();
      expect(reader.state().diff).toBe(previous); expect(reader.state().fullContext).toBeNull(); expect(reader.state().fullContextError).toBe(error);
      expect(calls.some(route => route.startsWith('/api/git/file-diff?'))).toBe(false);
    }
    const calls: string[] = [], image = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => { calls.push(route); return { diff: patch }; });
    await image.select('a.png'); await image.loadFullContext(); expect(image.state().fullContextError).toBe('full_context_image_unsupported'); expect(calls).toHaveLength(1);
  });
  it('does not equate a malformed, wrong-path, binary-flipped or swallowed-original response with successful empty context', async () => {
    for (const response of [{ ...full, path: 'other.ts' }, { ...full, modified: undefined }, { ...full, original: '' }, { ...full, modified: '' }, { ...full, isBinary: true }, { ...full, isBinary: undefined }]) {
      const reader = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => route.startsWith('/api/git/file-diff?') ? response : route.startsWith('/api/git/status?') ? status() : { diff: patch });
      await reader.select('a.ts'); const previous = reader.state().diff; await reader.loadFullContext();
      expect(reader.state().fullContext).toBeNull(); expect(reader.state().fullContextError).not.toBe(''); expect(reader.state().diff).toBe(previous);
    }
    const reader = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => route.startsWith('/api/git/file-diff?') ? { path: 'a.ts', original: '', modified: 'unknown former body', isBinary: false } : route.startsWith('/api/git/status?') ? status() : { diff: 'old mode 100644\nnew mode 100755\n' });
    await reader.select('a.ts'); await reader.loadFullContext(); expect(reader.state().fullContextError).toBe('full_context_empty_original_unproven');
  });
  it('retains patch/full snapshots on failure, retries only GET and does not automatically retry unknown reads', async () => {
    let fail = false; const calls: string[] = [];
    const reader = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => {
      calls.push(route); if (route.startsWith('/api/git/file-diff?')) { if (fail) throw new Error('read response unknown'); return full; }
      return route.startsWith('/api/git/status?') ? status() : { diff: patch };
    });
    await reader.select('a.ts'); await reader.loadFullContext(); const previous = reader.state().fullContext, original = reader.state().diff;
    fail = true; await reader.loadFullContext(); expect(reader.state().fullContext).toBe(previous); expect(reader.state().diff).toBe(original); expect(reader.state().fullContextError).toBe('read response unknown');
    const count = calls.length; for (let i = 0; i < 50; i++) reader.state(); expect(calls).toHaveLength(count);
    fail = false; await reader.loadFullContext(); expect(reader.state().fullContextError).toBe(''); expect(reader.state().fullContext?.after).toBe(after);
  });
  it('only permits explicit double-empty, new and working-deleted representations justified by patch and status', async () => {
    for (const fixture of [
      { patch: '', snapshot: status('A', ' '), staged: true, original: '', modified: '' },
      { patch: '@@ -0,0 +1 @@\n+NEW\n', snapshot: status('?', '?'), staged: false, original: '', modified: 'NEW\n' },
      { patch: '@@ -1 +0,0 @@\n-OLD\n', snapshot: status(' ', 'D'), staged: false, original: 'OLD\n', modified: '' },
      { patch: '@@ -0,0 +1 @@\n+NEW\n', snapshot: status('A', ' '), staged: true, original: '', modified: 'NEW\n' },
      { patch: '@@ -0,0 +1 @@\n+NEW\n', snapshot: status('M', ' '), staged: true, original: '', modified: 'NEW\n' },
    ]) {
      const reader = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => route.startsWith('/api/git/status?') ? fixture.snapshot : route.startsWith('/api/git/file-diff?') ? { path: 'a.ts', original: fixture.original, modified: fixture.modified, isBinary: false } : { diff: fixture.patch });
      await reader.select('a.ts', fixture.staged); await reader.loadFullContext();
      expect(reader.state().fullContextError).toBe(''); expect(reader.state().fullContext).toEqual({ path: 'a.ts', before: fixture.original, after: fixture.modified, isBinary: false });
    }
  });
  it('a staged deletion that the formal server cannot read remains a patch error, not a fabricated empty pair', async () => {
    const reader = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => {
      if (route.startsWith('/api/git/file-diff?')) throw new Error('HTTP 500: index path missing');
      return route.startsWith('/api/git/status?') ? status('D', ' ') : { diff: '@@ -1 +0,0 @@\n-OLD\n' };
    });
    await reader.select('a.ts', true); await reader.loadFullContext(); expect(reader.state().fullContext).toBeNull(); expect(reader.state().diff?.patch).toContain('-OLD'); expect(reader.state().fullContextError).toContain('index path missing');
  });
  it('rechecks only the selected file status, and refuses a baseline change during the formal GET', async () => {
    let changed = false;
    const reader = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => {
      if (route.startsWith('/api/git/file-diff?')) { changed = true; return full; }
      return route.startsWith('/api/git/status?') ? status(changed ? 'M' : ' ', 'M') : { diff: patch };
    });
    await reader.select('a.ts'); await reader.loadFullContext(); expect(reader.state().fullContext).toBeNull(); expect(reader.state().fullContextError).toBe('full_context_index_baseline_unsupported');
    let statuses = 0;
    const other = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => route.startsWith('/api/git/file-diff?') ? full : route.startsWith('/api/git/status?') ? { ...status(), files: [...status().files, { path: 'other.ts', index: ++statuses === 1 ? 'M' : 'A', working_dir: ' ' }] } : { diff: patch });
    await other.select('a.ts'); await other.loadFullContext(); expect(other.state().fullContext?.after).toBe(after); expect(other.state().fullContextError).toBe('');
  });
  it('binary stays binary and unrelated unresolvable status paths do not erase the complete selected file', async () => {
    const binary = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => route.startsWith('/api/git/file-diff?') ? { path: 'a.ts', original: '', modified: '', isBinary: true } : route.startsWith('/api/git/status?') ? { ...status(), files: [...status().files, { path: '/elsewhere/file', index: ' ', working_dir: 'M' }] } : { diff: 'Binary files a/a.ts and b/a.ts differ' });
    await binary.select('a.ts'); await binary.loadFullContext(); expect(binary.state().fullContext?.isBinary).toBe(true); expect(binary.state().fullContextError).toBe('');
  });
});

describe('full-context captured operation retirement', () => {
  it('history, inactive, and absent selection never start workspace requests', async () => {
    const calls: string[] = [], read = async (route: string) => { calls.push(route); return { diff: patch }; };
    const history = createChangesReader({ kind: 'turn', directory: '/repo', sessionID: 's', messageID: 'm', files: [{ path: 'a.ts', patch }] }, read);
    await history.select('a.ts'); await history.loadFullContext(); expect(calls).toEqual([]);
    let active = false; const reader = createChangesReader({ kind: 'workspace', directory: '/repo' }, read, () => active);
    await reader.select('a.ts'); await reader.loadFullContext(); expect(calls).toEqual([]);
    active = true; await reader.loadFullContext(); expect(calls).toEqual([]);
  });
  it.each(['path', 'staged', 'cancel', 'hide', 'host', 'directory'] as const)('rejects a delayed different body after %s changes and never issues a follow-up read', async action => {
    const wait = deferred<unknown>(), calls: string[] = [];
    const source: ChangesSource = { kind: 'workspace', directory: '/repo' }; let active = true;
    const reader = createChangesReader(source, async route => {
      calls.push(route); return route.startsWith('/api/git/file-diff?') ? wait.promise : route.startsWith('/api/git/status?') ? status() : { diff: patch };
    }, () => active);
    await reader.select('a.ts'); const pending = reader.loadFullContext(); await Promise.resolve(); await Promise.resolve();
    expect(calls.some(route => route.startsWith('/api/git/file-diff?'))).toBe(true);
    if (action === 'path') await reader.select('b.ts');
    if (action === 'staged') await reader.select('a.ts', true);
    if (action === 'cancel') reader.cancelFullContext();
    if (action === 'hide' || action === 'host') { active = false; reader.cancel(); }
    if (action === 'directory') source.directory = '/different';
    const count = calls.length; wait.resolve({ ...full, modified: 'LATE_RETIRED_OTHER_BODY' }); await pending;
    expect(calls).toHaveLength(count); expect(reader.state().fullContext).toBeNull(); expect(reader.state().fullContextError).toBe('');
  });
  it('coalesces duplicate demands and cancellation fences each await boundary', async () => {
    const wait = deferred<unknown>(), calls: string[] = [];
    const reader = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => { calls.push(route); return route.startsWith('/api/git/status?') ? wait.promise : { diff: patch }; });
    await reader.select('a.ts'); const pending = reader.loadFullContext(); await reader.loadFullContext(); expect(calls).toHaveLength(2);
    reader.cancelFullContext(); wait.resolve(status()); await pending; expect(calls).toHaveLength(2); expect(reader.state().fullContextLoading).toBe(false);
  });
  it('rejects a late post-status receipt after a newer selected path has already completed', async () => {
    const wait = deferred<unknown>(); let statuses = 0;
    const reader = createChangesReader({ kind: 'workspace', directory: '/repo' }, async route => route.startsWith('/api/git/file-diff?') ? full : route.startsWith('/api/git/status?') ? ++statuses === 1 ? status() : wait.promise : { diff: patch });
    await reader.select('a.ts'); const pending = reader.loadFullContext();
    for (let i = 0; i < 8 && statuses < 2; i++) await Promise.resolve(); expect(statuses).toBe(2);
    await reader.select('b.ts'); const current = reader.state().diff; wait.resolve(status()); await pending;
    expect(reader.state().path).toBe('b.ts'); expect(reader.state().diff).toBe(current); expect(reader.state().fullContext).toBeNull(); expect(reader.state().fullContextLoading).toBe(false);
  });
});
