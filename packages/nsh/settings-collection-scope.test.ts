import { expect, test, vi } from 'vitest';
import { createNativeAgentScopeMove } from './settings-collection-scope';
import { parseCollectionJSONC } from './settings-collection-jsonc';
import { collectionAgentMarkdown } from './settings-collection-source';

function fixture(options: { loseWrite?: boolean; failReadAfterAck?: boolean; loseDelete?: boolean } = {}) {
  const original = '---\ndescription: original\ncustom:\n  keep: true\nnullable: null\nhidden: false\n---\n\nComplete prompt\n';
  const files = new Map([['/global/agent.md', original]]);
  let readFailed = false, writeLost = false, deleteLost = false;
  const send = vi.fn(async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (path.startsWith('/api/fs/read')) {
      const file = new URL(path, 'https://fixture.invalid').searchParams.get('path')!;
      if (options.failReadAfterAck && files.has('/captured/.opencode/agents/agent.md') && !readFailed) { readFailed = true; throw new Error('read offline'); }
      if (!files.has(file)) throw Object.assign(new Error('missing'), { status: 404 });
      return files.get(file);
    }
    if (path.startsWith('/api/fs/write')) {
      const input = body as { path: string; content: string }; files.set(input.path, input.content);
      if (options.loseWrite && !writeLost) { writeLost = true; throw new Error('write unknown'); }
      return { success: true };
    }
    if (method === 'DELETE') {
      expect(body).toEqual({ scope: 'user' }); files.delete('/global/agent.md');
      if (options.loseDelete && !deleteLost) { deleteLost = true; throw new Error('delete unknown'); }
      return { success: true };
    }
    return { name: 'agent', scope: files.has('/captured/.opencode/agents/agent.md') ? 'project' : 'user', sources: {
      md: { exists: true, scope: 'user', path: '/global/agent.md' }, json: { exists: false, fields: [] },
      userMd: { exists: files.has('/global/agent.md'), path: '/global/agent.md' }, projectMd: { exists: files.has('/captured/.opencode/agents/agent.md'), path: '/captured/.opencode/agents/agent.md' },
    } };
  });
  const move = createNativeAgentScopeMove({ name: 'agent', from: 'user', to: 'project', directory: '/captured', patch: {} }, send, () => true);
  return { original, files, send, move };
}
test('scope move keeps every field and body byte, and deletes only the captured old scope', async () => {
  const f = fixture(); expect(f.send).not.toHaveBeenCalled(); await f.move.advance();
  expect(f.move.phase()).toBe('done');
  expect(f.files.get('/captured/.opencode/agents/agent.md')).toBe(f.original);
  expect(f.files.has('/global/agent.md')).toBe(false);
  expect(f.send.mock.calls.filter(call => call[1] === 'DELETE')).toHaveLength(1);
  expect(f.send.mock.calls.every(call => call[0].includes('directory=%2Fcaptured'))).toBe(true);
});
test.each([{ loseWrite: true }, { failReadAfterAck: true }])('unknown/ACK followed by read failure never repeats target creation (%o)', async options => {
  const f = fixture(options); await expect(f.move.advance()).rejects.toThrow();
  expect(f.files.has('/global/agent.md')).toBe(true);
  const writes = f.send.mock.calls.filter(call => call[1] === 'POST').length;
  await f.move.advance();
  expect(f.send.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(writes);
  if (f.move.phase() !== 'done') await f.move.advance();
  expect(f.move.phase()).toBe('done');
});
test('lost deletion response only reads on recovery and never rolls back the confirmed target', async () => {
  const f = fixture({ loseDelete: true }); await expect(f.move.advance()).rejects.toThrow('delete unknown');
  const before = f.send.mock.calls.length; await f.move.advance();
  expect(f.send.mock.calls.slice(before).every(call => !call[1] || call[1] === 'GET')).toBe(true);
  expect(f.move.phase()).toBe('done'); expect(f.files.get('/captured/.opencode/agents/agent.md')).toBe(f.original);
});

test('an occupied target is rejected before any write', async () => {
  const f = fixture(); f.files.set('/captured/.opencode/agents/agent.md', 'other definition');
  await expect(f.move.advance()).rejects.toThrow('already contains');
  expect(f.send.mock.calls.every(call => !call[1] || call[1] === 'GET')).toBe(true);
  expect(f.files.get('/global/agent.md')).toBe(f.original);
});
test('a changed original after target ACK is retained along with the copied target', async () => {
  const f = fixture(), delegate = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (path, method, body) => { const result = await delegate(path, method, body); if (method === 'POST') f.files.set('/global/agent.md', 'changed by another editor'); return result; });
  await expect(f.move.advance()).rejects.toThrow('Original Agent changed');
  expect(f.send.mock.calls.filter(call => call[1] === 'DELETE')).toHaveLength(0);
  expect(f.files.get('/global/agent.md')).toBe('changed by another editor');
});
test('a modified target after ACK cannot authorize deletion of the original', async () => {
  const f = fixture(), delegate = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (path, method, body) => { const result = await delegate(path, method, body); if (method === 'POST') f.files.set('/captured/.opencode/agents/agent.md', 'changed target'); return result; });
  await expect(f.move.advance()).rejects.toThrow('Scope target differs');
  expect(f.send.mock.calls.filter(call => call[1] === 'DELETE')).toHaveLength(0);
  expect(f.move.phase()).toBe('copied');
});
test('failed GET after acknowledged deletion retries reads without a second DELETE', async () => {
  const f = fixture(), delegate = f.send.getMockImplementation()!;
  let fail = false;
  f.send.mockImplementation(async (path, method, body) => {
    if (fail && path.startsWith('/api/fs/read') && path.includes('%2Fglobal')) { fail = false; throw new Error('cleanup read offline'); }
    const result = await delegate(path, method, body); if (method === 'DELETE') fail = true; return result;
  });
  await expect(f.move.advance()).rejects.toThrow('cleanup read offline');
  expect(f.move.phase()).toBe('cleanup'); await f.move.advance();
  expect(f.move.phase()).toBe('done');
  expect(f.send.mock.calls.filter(call => call[1] === 'DELETE')).toHaveLength(1);
});
test('edits during migration preserve untouched null, false and nested extension values', async () => {
  const f = fixture();
  const move = createNativeAgentScopeMove({ name: 'agent', from: 'user', to: 'project', directory: '/captured', patch: { description: 'edited', system: 'new body' } }, f.send, () => true);
  await move.advance();
  const raw = f.files.get('/captured/.opencode/agents/agent.md')!;
  expect(raw).toContain('nullable: null'); expect(raw).toContain('hidden: false'); expect(raw).toContain('keep: true');
  expect(raw).toContain('description: edited'); expect(raw.endsWith('new body')).toBe(true);
});
test.each([
  { name: 'agent', from: 'user' as const, to: 'project' as const, patch: {} },
  { name: 'agent', from: 'user' as const, to: 'user' as const, directory: '/captured', patch: {} },
])('invalid or uncaptured scope cannot issue any request (%o)', async plan => {
  const send = vi.fn(); const move = createNativeAgentScopeMove(plan, send, () => true);
  await expect(move.advance()).rejects.toThrow('scope'); expect(send).not.toHaveBeenCalled();
});
test('a retired lane admits no request and can only resume captured work after an explicit same-Host replacement', async () => {
  const f = fixture(); let active = false;
  const move = createNativeAgentScopeMove({ name: 'agent', from: 'user', to: 'project', directory: '/captured', patch: {} }, f.send, () => active);
  await expect(move.advance()).rejects.toThrow('Runtime changed'); expect(f.send).not.toHaveBeenCalled();
  active = true; move.replaceLane({ request: f.send, current: () => active }); await move.advance(); expect(move.phase()).toBe('done');
});
test('a second submit cannot overlap the target write', async () => {
  const f = fixture(), delegate = f.send.getMockImplementation()!;
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const dispatched = new Promise<void>(resolve => { started = resolve; });
  f.send.mockImplementation(async (path, method, body) => { const result = await delegate(path, method, body); if (method === 'POST') { started(); await wait; } return result; });
  const first = f.move.advance(); await dispatched; await expect(f.move.advance()).rejects.toThrow('pending'); release(); await first;
  expect(f.send.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
});
test('a new lower definition exposed by cleanup is not silently deleted or reported as migrated', async () => {
  const f = fixture(), delegate = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (path, method, body) => {
    const result = await delegate(path, method, body);
    if (path.startsWith('/api/config/agents') && method !== 'DELETE' && !f.files.has('/global/agent.md')) return { ...(result as object), sources: { ...(result as { sources: object }).sources, json: { exists: true, scope: 'user', path: '/global/other.jsonc' } } };
    return result;
  });
  await expect(f.move.advance()).rejects.toThrow('additional old-scope');
  expect(f.move.phase()).toBe('cleanup'); expect(f.send.mock.calls.filter(call => call[1] === 'DELETE')).toHaveLength(1);
});

test('project to global uses the global raw-config route, keeps null/false/extensions and never writes outside the workspace with fs.write', async () => {
  const source = '/captured/.opencode/agents/agent.md';
  const markdown = '---\ncustom:\n  retained: true\nnullable: null\nhidden: false\n---\n\nComplete prompt\n';
  let present = true, global = '{\n// global comment\n"unrelated": {"keep": true},\n}\n';
  const send = vi.fn(async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (path === '/api/config/global/opencode') { if (method === 'PUT') { global = (body as { content: string }).content; return { application: 'watch' }; } return { content: global }; }
    if (path.startsWith('/api/fs/read')) { if (!present) throw Object.assign(new Error('missing'), { status: 404 }); return markdown; }
    if (method === 'DELETE') { expect(body).toEqual({ scope: 'project' }); present = false; return { success: true }; }
    return { sources: { md: { exists: present, scope: 'project', path: source }, json: { exists: global.includes('"agent"'), scope: 'user', path: '/global/opencode.jsonc' }, projectMd: { exists: present, path: source }, userMd: { exists: false, path: '/global/agents/agent.md' } } };
  });
  const move = createNativeAgentScopeMove({ name: 'agent', from: 'project', to: 'user', directory: '/captured', patch: {} }, send, () => true);
  await move.advance(); expect(move.phase()).toBe('done');
  expect(global).toContain('// global comment');
  expect(parseCollectionJSONC(global)).toEqual({ unrelated: { keep: true }, agent: { agent: { custom: { retained: true }, nullable: null, hidden: false, system: 'Complete prompt' } } });
  expect(send.mock.calls.some(call => call[0].startsWith('/api/fs/write'))).toBe(false);
  expect(present).toBe(false);
});

test('explicit native clears and numeric edits apply without clearing untouched null extension fields', async () => {
  const f = fixture();
  f.files.set('/global/agent.md', '---\nmodel: provider/model\nvariant: high\ndescription: old\nnullable: null\ncustom:\n  keep: true\n---\n\nold prompt');
  const move = createNativeAgentScopeMove({ name: 'agent', from: 'user', to: 'project', directory: '/captured', patch: { model: null, description: null, system: null, steps: '9' } }, f.send, () => true);
  await move.advance();
  expect(collectionAgentMarkdown(f.files.get('/captured/.opencode/agents/agent.md')!)).toEqual({ frontmatter: { nullable: null, custom: { keep: true }, steps: 9 }, body: '' });
});

test('a JSONC-only native Agent moves its canonical system to Markdown body and preserves unknown values', async () => {
  let original = '{"agent":{"agent":{"system":"canonical body","nullable":null,"hidden":false,"custom":{"keep":true}}},"other":true}';
  let target: string | null = null;
  const send = vi.fn(async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (path.startsWith('/api/fs/read')) {
      if (path.includes('%2Fglobal%2Fopencode.jsonc')) return original;
      if (target === null) throw Object.assign(new Error('missing'), { status: 404 }); return target;
    }
    if (path.startsWith('/api/fs/write')) { target = (body as { content: string }).content; return { success: true }; }
    if (method === 'DELETE') { expect(body).toEqual({ scope: 'user' }); original = '{"other":true}'; return { success: true }; }
    return { sources: { md: { exists: target !== null, scope: 'project', path: '/captured/.opencode/agents/agent.md' }, json: { exists: original.includes('"agent"'), scope: 'user', path: '/global/opencode.jsonc' }, userMd: { exists: false, path: '/global/agents/agent.md' }, projectMd: { exists: target !== null, path: '/captured/.opencode/agents/agent.md' } } };
  });
  const move = createNativeAgentScopeMove({ name: 'agent', from: 'user', to: 'project', directory: '/captured', patch: {} }, send, () => true);
  await move.advance(); expect(move.phase()).toBe('done');
  expect(collectionAgentMarkdown(target!)).toEqual({ frontmatter: { nullable: null, hidden: false, custom: { keep: true } }, body: 'canonical body' });
});

test('a definitive target write rejection leaves the original intact and the editor correctable', async () => {
  const f = fixture(), delegate = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (path, method, body) => { if (method === 'POST') throw Object.assign(new Error('denied'), { status: 403 }); return delegate(path, method, body); });
  await expect(f.move.advance()).rejects.toThrow('denied'); expect(f.move.phase()).toBe('draft');
  expect(f.files.get('/global/agent.md')).toBe(f.original); expect(f.files.has('/captured/.opencode/agents/agent.md')).toBe(false);
  expect(f.send.mock.calls.filter(call => call[1] === 'DELETE')).toHaveLength(0);
});

test.each(['user', 'project'] as const)('JSON cleanup never deletes an uncaptured legacy Markdown exposed after the first %s Markdown removal', async from => {
  const to = from === 'user' ? 'project' : 'user';
  const root = from === 'user' ? '/global' : '/captured/.opencode';
  const plural = `${root}/agents/agent.md`, legacy = `${root}/agent/agent.md`, json = `${root}/opencode.jsonc`;
  const destination = from === 'user' ? '/captured/.opencode/agents/agent.md' : '/global/agents/agent.md';
  const originalJSON = '{"agent":{"agent":{"jsonField":"retain"}},"other":true}';
  const files = new Map([[plural, '---\ndescription: selected\n---\n\nSelected prompt'], [legacy, '---\ndescription: uncaptured\n---\n\nUncaptured prompt'], [json, originalJSON]]);
  let global = '{}';
  const oldMarkdown = () => files.has(plural) ? plural : files.has(legacy) ? legacy : plural;
  const send = vi.fn(async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (path === '/api/config/global/opencode') { if (method === 'PUT') { global = (body as { content: string }).content; return { application: 'watch' }; } return { content: global }; }
    if (path.startsWith('/api/fs/read')) {
      const file = new URL(path, 'https://fixture.invalid').searchParams.get('path')!;
      if (!files.has(file)) throw Object.assign(new Error('missing'), { status: 404 }); return files.get(file);
    }
    if (path.startsWith('/api/fs/write')) { const input = body as { path: string; content: string }; files.set(input.path, input.content); return { success: true }; }
    if (method === 'DELETE') {
      expect(body).toEqual({ scope: from });
      const selected = oldMarkdown();
      if (files.has(selected)) files.delete(selected);
      else files.set(json, '{"other":true}');
      return { success: true };
    }
    const old = { path: oldMarkdown(), exists: files.has(oldMarkdown()) };
    const next = { path: destination, exists: files.has(destination) };
    const projectMd = from === 'project' ? old : next, userMd = from === 'user' ? old : next;
    const active = projectMd.exists ? { ...projectMd, scope: 'project' } : { ...userMd, scope: 'user' };
    return { sources: { md: active, projectMd, userMd, json: { path: json, scope: from, exists: true } } };
  });
  const move = createNativeAgentScopeMove({ name: 'agent', from, to, directory: '/captured', patch: {} }, send, () => true);
  await expect(move.advance()).rejects.toThrow();
  expect(send.mock.calls.filter(call => call[1] === 'DELETE')).toHaveLength(1);
  expect(files.has(legacy)).toBe(true); expect(files.get(json)).toBe(originalJSON);
  expect(from === 'user' ? files.has(destination) : Object.hasOwn((parseCollectionJSONC(global).agent as Record<string, unknown>), 'agent')).toBe(true);
  await expect(move.advance()).rejects.toThrow('identity changed');
  expect(send.mock.calls.filter(call => call[1] === 'DELETE')).toHaveLength(1);
  expect(move.phase()).toBe('cleanup');
});
