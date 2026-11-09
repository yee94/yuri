import { expect, test, vi } from 'vitest';
import { collectionJSONCEntry, collectionJSONCInsert, createCollectionJSONCCopy, parseCollectionJSONC } from './settings-collection-jsonc';

const raw = '\uFEFF{\r\n // root comment\r\n "command": {\r\n   // source note\r\n   "old": {"template": "echo // keep", /* private field note */ "custom": {"x": [1, 2,],}, "description": "old",},\r\n },\r\n "unrelated": true,\r\n}\r\n';
test('JSONC copy parses real comments, trailing commas and BOM without deleting unknown fields or comments', () => {
  const source = collectionJSONCEntry(raw, 'command', 'old');
  expect(source.value).toEqual({ template: 'echo // keep', custom: { x: [1, 2] }, description: 'old' });
  const next = collectionJSONCInsert(raw, 'command', 'new', source.raw, { description: 'changed' });
  expect(next).toContain('/* private field note */');
  expect(next.match(/\/\* private field note \*\//g)).toHaveLength(2);
  expect(next.startsWith('\uFEFF')).toBe(true);
  const parsed = parseCollectionJSONC(next);
  expect(parsed.unrelated).toBe(true);
  expect(parsed.command).toEqual({ old: source.value, new: { ...source.value, description: 'changed' } });
  expect(raw).toContain('"description": "old"');
});
test('opening a copy draft has zero writes; a lost save response admits GET verification only', async () => {
  let stored = raw;
  const send = vi.fn(async (_path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (_path.startsWith('/api/config/commands')) return { sources: { md: { exists: false }, json: { exists: false } } };
    if (method === 'POST') { stored = (body as { content: string }).content; throw new Error('lost response'); }
    return stored;
  });
  const copy = createCollectionJSONCCopy({ path: '/captured/opencode.jsonc', directory: '/captured', scope: 'project', section: 'command', name: 'old', raw }, send, () => true);
  expect(send).not.toHaveBeenCalled();
  await expect(copy.save('new', {})).rejects.toThrow('lost response');
  expect(copy.phase()).toBe('unknown');
  await copy.save('new', {});
  expect(copy.phase()).toBe('done');
  expect(send.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
  expect(send.mock.calls.every(call => call[0].includes('directory=%2Fcaptured'))).toBe(true);
});
test('ACK remains confirmed when verification reads fail; retry cannot replay save', async () => {
  let failed = false;
  const send = vi.fn(async (_path: string, method = 'GET'): Promise<unknown> => { if (_path.startsWith('/api/config/commands')) return { sources: { md: { exists: false }, json: { exists: false } } }; if (method === 'POST') { failed = true; return { success: true }; } if (failed) throw new Error('read offline'); return raw; });
  const copy = createCollectionJSONCCopy({ path: '/captured/opencode.jsonc', directory: '/captured', scope: 'project', section: 'command', name: 'old', raw }, send, () => true);
  await expect(copy.save('new', {})).rejects.toThrow('read offline');
  expect(copy.phase()).toBe('confirmed');
  await expect(copy.save('new', {})).rejects.toThrow('read offline');
  expect(send.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
});

test('global copies use the global configuration protocol and preserve both source comments and unrelated target comments', async () => {
  let target = '{\n// existing global note\n"other": true,\n}\n';
  const send = vi.fn(async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (path.startsWith('/api/config/commands/')) return { sources: { md: { exists: false }, json: { exists: false } } };
    expect(path).toBe('/api/config/global/opencode');
    if (method === 'PUT') { target = (body as { content: string }).content; return { application: 'watch' }; }
    return { content: target };
  });
  const copy = createCollectionJSONCCopy({ path: '/global/custom.jsonc', directory: '/captured', scope: 'user', section: 'command', name: 'old', raw, destination: { global: true, path: '' } }, send, () => true);
  await copy.save('new', {});
  expect(copy.phase()).toBe('done'); expect(target).toContain('// existing global note'); expect(target).toContain('// source note'); expect(target).toContain('/* private field note */');
  expect(parseCollectionJSONC(target)).toMatchObject({ other: true, command: { new: { custom: { x: [1, 2] } } } });
  expect(send.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
});

test('a stale proposed name colliding with a Markdown source cannot write a hidden JSONC duplicate', async () => {
  const send = vi.fn(async () => ({ sources: { md: { exists: true }, json: { exists: false } } }));
  const copy = createCollectionJSONCCopy({ path: '/captured/opencode.jsonc', directory: '/captured', scope: 'project', section: 'command', name: 'old', raw }, send, () => true);
  await expect(copy.save('occupied', {})).rejects.toThrow('already exists');
  expect(copy.phase()).toBe('draft'); expect(send.mock.calls).toHaveLength(1);
});

test.each(['', '\uFEFF', '// comment-only configuration', '/* block note */\r\n'])('empty JSONC destinations match the Host allowEmptyContent contract without dropping comments (%s)', destination => {
  const source = collectionJSONCEntry(raw, 'command', 'old');
  expect(parseCollectionJSONC(destination)).toEqual({});
  const next = collectionJSONCInsert(destination, 'command', 'new', source.raw);
  expect(next.startsWith(destination)).toBe(true);
  expect(parseCollectionJSONC(next)).toEqual({ command: { new: source.value } });
});

test('a definitive pre-write authorization rejection keeps a correctable draft rather than an unknown receipt', async () => {
  const send = vi.fn(async (path: string, method = 'GET'): Promise<unknown> => {
    if (path.startsWith('/api/config/commands')) return { sources: { md: { exists: false }, json: { exists: false } } };
    if (method === 'POST') throw Object.assign(new Error('denied'), { status: 403 });
    return raw;
  });
  const copy = createCollectionJSONCCopy({ path: '/captured/config.jsonc', directory: '/captured', scope: 'project', section: 'command', name: 'old', raw }, send, () => true);
  await expect(copy.save('new', {})).rejects.toThrow('denied'); expect(copy.phase()).toBe('draft');
});
