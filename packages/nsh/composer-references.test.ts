import { afterEach, expect, test, vi } from 'vitest';
import { compileNativePrompt } from './composer';
import { compileNativeReferences, createReferenceSearch, editNativeReferences, hydrateNativeReferenceSessions, insertNativeReference, nativeReferenceTrigger, referenceCandidates, referenceRoute, type ReferenceCandidate, type ReferenceDocument, type ReferenceSearchState } from './composer-references';

const scope = { host: 'host-a', draft: 'session-a', directory: '/workspace' };
const candidate = (kind: ReferenceCandidate['kind'], value: string, label = value): ReferenceCandidate => ({ kind, value, label });
function document(...refs: ReferenceCandidate[]) {
  let result: ReferenceDocument = { text: 'Read ', references: [] };
  for (const ref of refs) result = insertNativeReference(result, ref);
  return { ...result, scope };
}
afterEach(() => vi.useRealTimers());

test('confirmed five-domain references compile SDK wire, never bare @ text', () => {
  const doc = document(candidate('file', 'src/a b.ts'), candidate('directory', 'src/'), candidate('agent', 'reviewer'), candidate('skill', '绘画', 'Paint'), { ...candidate('session', 'session-b', 'Prior work'), directory: '/another' });
  const result = compileNativeReferences(doc, scope);
  expect(result.files).toEqual([{ uri: 'file:///workspace/src/a%20b.ts', name: 'a b.ts' }, { uri: 'file:///workspace/src', name: 'src' }]);
  expect(result.agents).toEqual([{ name: 'reviewer' }]);
  expect(result.skills).toEqual([{ id: '绘画' }]);
  expect(result.text).toContain('[skill:绘画]');
  expect(result.text).toContain('"id":"session-b","title":"Prior work","directory":"/another","messages":[]');
  expect(result.text).toContain('session_message');
  expect(compileNativeReferences({ text: '@scope/pkg @src/a.ts @reviewer @Paint @Prior work', references: [], scope }, scope)).toEqual({ text: '@scope/pkg @src/a.ts @reviewer @Paint @Prior work' });
});

test('input edits rebase exact ranges, remove touched semantics, preserve suffixes', () => {
  const doc = document(candidate('skill', 'review'), candidate('file', 'a.ts'));
  const prefix = editNativeReferences(doc, `Please ${doc.text}`);
  expect(prefix.references.map(ref => ref.start)).toEqual(doc.references.map(ref => ref.start + 7));
  const inside = editNativeReferences(prefix, prefix.text.replace('@review', '@reviews'));
  expect(inside.references.map(ref => ref.kind)).toEqual(['file']);
  const changed = editNativeReferences(prefix, prefix.text.replace('@review', '@revXew'));
  expect(changed.references.map(ref => ref.kind)).toEqual(['file']);
  expect(changed.text).toContain('@revXew');
});

test('replacement removes overlapping references and npm-like text does not acquire semantics', () => {
  const doc = document(candidate('file', 'src/a.ts'));
  const ref = doc.references[0];
  const replaced = insertNativeReference(doc, candidate('agent', 'review'), ref.start, ref.end);
  expect(replaced.references.map(item => item.kind)).toEqual(['agent']);
  expect(nativeReferenceTrigger('mail@example.com')).toBeNull();
  expect(nativeReferenceTrigger('Read @src/a')).toEqual({ start: 5, end: 11, query: 'src/a' });
});

test('cross Host, draft, directory and stale snapshots fail closed before network', async () => {
  const doc = document(candidate('file', 'src/a.ts'));
  for (const next of [{ ...scope, host: 'host-b' }, { ...scope, draft: 'session-b' }, { ...scope, directory: '/other' }]) expect(() => compileNativeReferences(doc, next)).toThrow('scope-mismatch');
  const send = vi.fn();
  await expect(compileNativePrompt({ text: '/summary', files: [], references: doc, scope }, send)).rejects.toThrow('snapshot-mismatch');
  expect(send).not.toHaveBeenCalled();
});

test('deduplication, malformed overlaps and portable file URLs', () => {
  const doc = document(candidate('file', 'a.ts'), candidate('file', './a.ts'), candidate('file', 'C:\\code\\a b.ts'), candidate('directory', '\\\\server\\share\\dir'), candidate('skill', 'review'), candidate('skill', 'review'));
  const result = compileNativeReferences(doc, scope);
  expect(result.files?.map(file => file.uri)).toEqual(['file:///workspace/a.ts', 'file:///C:/code/a%20b.ts', 'file:////server/share/dir']);
  expect(result.skills).toEqual([{ id: 'review' }]);
  expect(() => compileNativeReferences({ ...doc, references: [...doc.references, doc.references[0]] }, scope)).toThrow('invalid');
  expect(() => document(candidate('skill', 'bad name'))).toThrow('invalid');
});

test('SDK routes and response envelopes preserve real IDs, hidden agents and bounded results', () => {
  expect(referenceRoute('file', '/a b', 'src/x')).toBe('/api/fs/find?location%5Bdirectory%5D=%2Fa%20b&query=src%2Fx&type=file&limit=12');
  expect(referenceRoute('directory', '/a', '')).toContain('type=directory');
  expect(referenceRoute('session', '/a', 'some work')).toBe('/api/session?search=some%20work&limit=12&order=desc&archived=false');
  expect(referenceCandidates('skill', { location: {}, data: [{ id: 'real-id', name: 'Display', path: '/skills/real-id' }] }, 'Display', '/a')[0]).toMatchObject({ value: 'real-id', label: 'Display' });
  expect(referenceCandidates('agent', { data: [{ name: 'hidden', hidden: true }, { name: 'visible' }] }, '', '/a')).toHaveLength(1);
  expect(referenceCandidates('session', { data: [{ id: 's', title: 'T', location: { directory: '/owner' } }], cursor: {} }, '', '/a')[0].directory).toBe('/owner');
  expect(referenceCandidates('file', { data: Array.from({ length: 300 }, (_, i) => ({ path: `src/${i}`, type: 'file' })) }, '', '/a')).toHaveLength(12);
  expect(() => referenceCandidates('file', { error: 'bad' }, '', '/a')).toThrow('catalog-invalid');
});

test('closed panel and 50 rapid input events enumerate/request zero; opened query is debounced', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async (_path: string) => ({ data: [] }));
  const search = createReferenceSearch(send, () => {});
  for (let i = 0; i < 50; i++) search.update(scope, 'file', `${i}`, false);
  await vi.runAllTimersAsync();
  expect(send).not.toHaveBeenCalled();
  for (let i = 0; i < 50; i++) search.update(scope, 'file', `${i}`, true);
  await vi.advanceTimersByTimeAsync(249);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toContain('query=49');
  search.close();
  for (let i = 0; i < 50; i++) search.update(scope, 'skill', `${i}`, false);
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(1);
});

test('stale completions on close, Host/draft switch and domain change cannot publish', async () => {
  vi.useFakeTimers();
  const resolve: Array<(value: unknown) => void> = [];
  const send = vi.fn(() => new Promise<unknown>(done => resolve.push(done)));
  const states: ReferenceSearchState[] = [];
  const search = createReferenceSearch(send, next => states.push(next));
  search.update(scope, 'file', '', true); await vi.advanceTimersByTimeAsync(250);
  search.update({ ...scope, host: 'host-b', draft: 'session-b' }, 'skill', '', true); await vi.advanceTimersByTimeAsync(250);
  resolve[0]({ data: [{ path: 'old', type: 'file' }] }); await Promise.resolve();
  expect(states.at(-1)?.rows).toEqual([]);
  resolve[1]({ data: [{ id: 'new', name: 'New' }] }); await Promise.resolve();
  expect(states.at(-1)?.rows[0].value).toBe('new');
  search.update(scope, 'file', '', true); await vi.advanceTimersByTimeAsync(250);
  search.close(); resolve[2]({ data: [{ path: 'late', type: 'file' }] }); await Promise.resolve();
  expect(states.at(-1)).toEqual({ rows: [], busy: false, failed: false });
});

test('agent/skill catalog is reused only inside same opened domain and failures remain failures', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async (_path: string) => ({ data: [{ id: 'review', name: 'Review' }] }));
  let state: ReferenceSearchState | undefined;
  const search = createReferenceSearch(send, next => { state = next; });
  search.update(scope, 'skill', '', true); await vi.advanceTimersByTimeAsync(250);
  search.update(scope, 'skill', 'rev', true); await vi.advanceTimersByTimeAsync(250);
  expect(send).toHaveBeenCalledTimes(1);
  search.close(); search.update(scope, 'skill', '', true); await vi.advanceTimersByTimeAsync(250);
  expect(send).toHaveBeenCalledTimes(2);
  send.mockRejectedValueOnce(new Error('offline'));
  search.update(scope, 'file', 'x', true); await vi.advanceTimersByTimeAsync(250);
  expect(state).toEqual({ rows: [], busy: false, failed: true });
});

test('compiler merges upload attachments, references and existing magic synthetic flatten contract', async () => {
  const doc = { ...document(candidate('skill', 'review'), candidate('session', 's', 'Prior')), text: '' };
  const initial = document(candidate('skill', 'review'), candidate('session', 's', 'Prior'));
  const shifted = editNativeReferences(initial, `/summary ${initial.text}`);
  Object.assign(doc, shifted);
  const result = await compileNativePrompt({ text: doc.text, files: [{ uri: 'file:///upload.png', mime: 'image/png', name: 'upload.png' }], references: doc, scope }, async path => path === '/api/magic-prompts' ? { version: 1, overrides: {} } : { data: [], cursor: {} });
  expect(result.files?.[0].uri).toBe('file:///upload.png');
  expect(result.skills).toEqual([{ id: 'review' }]);
  expect(result.text).toContain('The user referenced these OpenCode sessions');
  expect(result.text).not.toContain('yuriSyntheticParts');
});

test('selected sessions hydrate opaque cursor pages in chronological order and exclude synthetic reasoning/tools', async () => {
  const doc = document(candidate('session', 's', 'Previous'));
  const send = vi.fn(async (path: string) => path.includes('cursor=') ? { data: [{ id: 'm1', type: 'user', text: 'Earlier' }], cursor: {} } : {
    data: [{ id: 'm2', type: 'assistant', content: [{ type: 'text', text: 'Answer' }, { type: 'reasoning', text: 'Hidden' }, { type: 'text', text: 'Synthetic', synthetic: true }] }], cursor: { next: 'opaque/next+' },
  });
  const contexts = await hydrateNativeReferenceSessions(doc, scope, send);
  expect(contexts[0].messages).toEqual([{ role: 'user', text: 'Earlier' }, { role: 'assistant', text: 'Answer' }]);
  expect(send.mock.calls[1][0]).toBe('/api/session/s/message?limit=20&order=desc&cursor=opaque%2Fnext%2B');
  expect(compileNativeReferences(doc, scope, undefined, contexts).text).toContain('Earlier');
});

test('hydration failures retain draft semantics, stale scope stops and repeated cursors fail', async () => {
  const doc = document(candidate('session', 's'));
  await expect(hydrateNativeReferenceSessions(doc, scope, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  let valid = true;
  await expect(hydrateNativeReferenceSessions(doc, scope, async () => { valid = false; return { data: [], cursor: {} }; }, () => valid)).rejects.toThrow('scope-changed');
  const send = vi.fn(async () => ({ data: [], cursor: { next: 'loop' } }));
  await expect(hydrateNativeReferenceSessions(doc, scope, send)).rejects.toThrow('cursor-repeated');
  expect(send).toHaveBeenCalledTimes(2);
  expect(doc.references).toHaveLength(1);
});

test('session hydration has hard page and character bounds; delivered JSON is bounded', async () => {
  const doc = document(candidate('session', 's'));
  let page = 0;
  const contexts = await hydrateNativeReferenceSessions(doc, scope, async () => ({ data: [{ id: `m${page++}`, type: 'user', text: 'x'.repeat(100_000) }], cursor: { next: String(page) } }));
  expect(page).toBe(2);
  const result = compileNativeReferences(doc, scope, undefined, contexts);
  expect(result.text.length).toBeLessThan(36_100);
  page = 0;
  await hydrateNativeReferenceSessions(doc, scope, async () => ({ data: [], cursor: { next: String(page++) } }));
  expect(page).toBe(50);
});
