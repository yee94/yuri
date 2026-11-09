import { expect, test } from 'vitest';
import { createChangesReader } from './chat-changes-model';
import { createChangesDraft, createChangesGeneration } from './chat-changes-generation';

const snapshot = { isClean: false, files: [{ path: 'a.ts', index: 'M', working_dir: 'M' }] };
test('explicit generation uses Host prompts, staged paths and structured subject/highlights; insert consumes highlights once', async () => {
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await reader.refresh();
  const calls: Array<[string, string | undefined, unknown]> = [];
  const generation = createChangesGeneration(reader, async (path, method, body) => {
    calls.push([path, method, body]);
    if (path === '/api/magic-prompts') return { version: 1, overrides: { 'git.commit.generate.visible': 'custom system' } };
    if (path.includes('/diff?')) return { diff: '+material' };
    return { text: '```json\n{"subject":" fix: exact ","highlights":[" one ","",4,"two"]}\n```' };
  });
  expect(calls).toEqual([]);
  expect(await generation.generate()).toBe(true);
  expect(generation.state()).toMatchObject({ message: 'fix: exact', highlights: ['one', 'two'], pending: false });
  const request = calls.find(([path]) => path === '/api/small-model/generate');
  expect(request?.[1]).toBe('POST');
  expect(request?.[2]).toMatchObject({ purpose: 'commit', directory: '/fixture', system: 'custom system' });
  expect(String((request?.[2] as { prompt: string }).prompt)).toContain('Diff budget: included 1 of 1');
  generation.insertHighlights(); expect(generation.state().message).toBe('fix: exact\n\none\ntwo');
  generation.insertHighlights(); expect(generation.state().message).toBe('fix: exact\n\none\ntwo');
});

test('late generation cannot replace an edited draft, closed owner or changed staged selection', async () => {
  let resolve!: (value: unknown) => void;
  let files = snapshot.files, active = true;
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => ({ ...snapshot, files }), () => active); await reader.refresh();
  const generation = createChangesGeneration(reader, async path => path === '/api/magic-prompts' ? { version: 1, overrides: {} } : path.includes('/diff?') ? { diff: '+x' } : new Promise(done => { resolve = done; }));
  const pending = generation.generate();
  await new Promise(done => setImmediate(done));
  generation.edit('new draft'); resolve({ text: '{"subject":"old"}' }); await pending;
  expect(generation.state().message).toBe('new draft');
  const second = generation.generate(); await new Promise(done => setImmediate(done));
  files = []; await reader.refresh(); resolve({ text: '{"subject":"stale"}' }); await second;
  expect(generation.state().message).toBe('new draft');
  const third = generation.generate(); expect(await third).toBe(false);
  active = false; expect(await generation.generate()).toBe(false);
});

test('history refuses generation and read/config failure never dispatches paid POST', async () => {
  let posts = 0;
  const history = createChangesReader({ kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'm', files: [] }, async () => snapshot);
  const generation = createChangesGeneration(history, async () => { posts++; });
  expect(await generation.generate()).toBe(false); expect(posts).toBe(0);
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await reader.refresh();
  const failed = createChangesGeneration(reader, async () => { throw new Error('offline'); });
  failed.edit('keep'); expect(await failed.generate()).toBe(false); expect(failed.state().message).toBe('keep'); expect(failed.state().error).toBe('offline');
});

test('only a small-model 404 falls back to the captured session.generate contract; other failures never send chat', async () => {
  const reader = createChangesReader({ kind: 'workspace', directory: '/worktrees/non-default & review' }, async () => snapshot); await reader.refresh();
  const posts: Array<[string, unknown]> = [];
  let status = 404;
  const generation = createChangesGeneration(reader, async (path, method, body) => {
    if (path === '/api/magic-prompts') return { version: 1, overrides: {} };
    if (path.includes('/diff?')) return { diff: '+material' };
    if (method === 'POST') posts.push([path, body]);
    if (path === '/api/small-model/generate') throw Object.assign(new Error('unavailable'), { status });
    return { text: '{"subject":"fix: fallback","highlights":[]}' };
  }, reader.current, () => {}, () => ({ sessionID: 'session/fixture', preferredProviderID: 'provider', preferredModelID: 'model' }));
  expect(await generation.generate()).toBe(true);
  expect(posts.map(([path]) => path)).toEqual(['/api/small-model/generate', '/api/session/session%2Ffixture/generate?directory=%2Fworktrees%2Fnon-default%20%26%20review']);
  expect(posts[0][1]).toMatchObject({ preferredProviderID: 'provider', preferredModelID: 'model' });
  expect(Object.keys(posts[1][1] as object)).toEqual(['prompt']);
  status = 503; posts.length = 0;
  expect(await generation.generate()).toBe(false); expect(posts.map(([path]) => path)).toEqual(['/api/small-model/generate']);
  expect(generation.state().message).toBe('fix: fallback');
});

test('material preparation bounds HTTP concurrency and labels omitted/truncated coverage', async () => {
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => ({ isClean: false, files: Array.from({ length: 32 }, (_, i) => ({ path: `file-${i}.ts`, index: 'M', working_dir: ' ' })) })); await reader.refresh();
  let active = 0, max = 0, reads = 0, material = '';
  const generation = createChangesGeneration(reader, async (path, _, body) => {
    if (path === '/api/magic-prompts') return { version: 1, overrides: {} };
    if (path.includes('/diff?')) {
      reads++; active++; max = Math.max(max, active); await Promise.resolve(); active--;
      return { diff: '+fixture' };
    }
    material = (body as { prompt: string }).prompt; return { text: '{"subject":"fix: bounded"}' };
  });
  expect(await generation.generate()).toBe(true); expect(reads).toBe(60); expect(max).toBe(2);
  expect(material).toContain('included 30 of 32'); expect(material).toContain('omittedFiles=2'); expect(material).toContain('Materials are partial');
});

test('directory changes during a 404 response never retarget the captured aside request', async () => {
  const source = { kind: 'workspace' as const, directory: '/original-worktree' };
  const reader = createChangesReader(source, async () => snapshot); await reader.refresh();
  const posts: string[] = [];
  const generation = createChangesGeneration(reader, async (path, method) => {
    if (path === '/api/magic-prompts') return { version: 1, overrides: {} };
    if (path.includes('/diff?')) return { diff: '+material' };
    if (method === 'POST') posts.push(path);
    source.directory = '/other-worktree'; throw Object.assign(new Error('unavailable'), { status: 404 });
  }, reader.current, () => {}, () => ({ sessionID: 'original-session' }));
  generation.edit('keep draft');
  expect(await generation.generate()).toBe(false); expect(posts).toEqual(['/api/small-model/generate']);
  expect(generation.state().message).toBe('keep draft');
});

test('edit revision belongs to shared draft: another binding edit rejects a generated result even with permissive current', async () => {
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await reader.refresh();
  const draft = createChangesDraft();
  let resolve!: (value: unknown) => void;
  const call = async (path: string) => path === '/api/magic-prompts' ? { version: 1, overrides: {} } : path.includes('/diff?') ? { diff: '+material' } : new Promise(done => { resolve = done; });
  const first = createChangesGeneration(reader, call, () => true, () => {}, () => ({}), draft);
  const second = createChangesGeneration(reader, call, () => true, () => {}, () => ({}), draft);
  first.edit('initial'); const revision = draft.revision();
  const flight = first.generate(); await new Promise(done => setImmediate(done));
  second.edit('edited through replacement binding');
  expect(draft.revision()).toBeGreaterThan(revision);
  resolve({ text: '{"subject":"STALE","highlights":["STALE"]}' });
  expect(await flight).toBe(false);
  expect(second.state()).toMatchObject({ message: 'edited through replacement binding', highlights: [], pending: false });
  first.cancel(); first.edit('retired'); first.clear();
  expect(second.state().message).toBe('edited through replacement binding');
});
