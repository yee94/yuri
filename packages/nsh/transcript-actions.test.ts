import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messageFrom, type Message, type Row } from './model';

const host = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('nsh', () => ({ host: { available: () => true, call: host.call } }));
import { createTranscriptActions, nativeEditFiles, nativeRevertFrom, type NativeRevert } from './transcript-actions-core';

const target = { kind: 'session' as const, id: 's/one', title: 'Neutral session', directory: '/workspace/space one' };
const root = '/api/session/s%2Fone/';
const raw = { id: 'message/one', type: 'user', content: [{ type: 'text', text: 'Authoritative input' }, { type: 'file', source: { type: 'uri', uri: 'file:///host/upload.txt' }, filename: 'upload.txt', mime: 'text/plain' }] };
let selected: Message | undefined, current: boolean, busy: boolean;
let generation = 0;
let handle: (path: string, method: string, body: unknown) => unknown;
const requests = () => host.call.mock.calls.map(([, input]) => input as { path: string; method: string; body?: Row });
function setup(extra: Partial<Parameters<typeof createTranscriptActions>[0]> = {}) {
  const onEditDraft = vi.fn(), onRevert = vi.fn(), onChanged = vi.fn(), onOpenChat = vi.fn();
  const send = async (path: string, method = 'GET', body?: unknown) => (await host.call('runtime.request', { path, method, ...(body === undefined ? {} : { body }) })).body;
  const actions = createTranscriptActions({ target, send, scope: { key: `fixture-host-generation-${generation}`, current: () => current, busy: () => busy, message: () => selected }, onEditDraft, onRevert, onChanged, onOpenChat, ...extra });
  return { actions, onEditDraft, onRevert, onChanged, onOpenChat };
}
beforeEach(() => {
  generation++;
  selected = messageFrom({ ...raw, content: [{ type: 'text', text: 'Stale visible input' }] })!;
  current = true; busy = false;
  handle = (path, method, body) => {
    if (path === '/api/session/active') return { data: {} };
    if (path.startsWith('/api/session/s%2Fone?')) return { id: target.id, directory: target.directory };
    if (path.startsWith(`${root}message/message%2Fone?`)) return { data: raw };
    if (path.startsWith(`${root}revert/stage?`)) return { data: { messageID: (body as Row).messageID, files: [] } };
    if (method === 'DELETE') return null;
    throw new Error('Unexpected fixture request: ' + path);
  };
  host.call.mockReset().mockImplementation(async (name, input) => {
    expect(name).toBe('runtime.request');
    return { status: 200, body: await handle(input.path, input.method, input.body) };
  });
});

describe('production transcript actions with fixture-only Host requests', () => {
  it('stages an edit using authoritative text/files, never stale rendered content', async () => {
    const { actions, onEditDraft, onRevert } = setup();
    await actions.edit();
    expect(onEditDraft).toHaveBeenCalledWith({ target, messageID: raw.id, text: 'Authoritative input', files: [{ uri: 'file:///host/upload.txt', name: 'upload.txt', mime: 'text/plain' }] });
    expect(onRevert).toHaveBeenCalledWith({ messageID: raw.id, files: [] });
    const stage = requests().find(input => input.method === 'POST');
    expect(stage).toEqual({ path: `${root}revert/stage?directory=%2Fworkspace%2Fspace%20one`, method: 'POST', body: { messageID: raw.id, files: false } });
    expect(requests().filter(input => input.path === '/api/session/active')).toHaveLength(2);
  });
  it('refuses editing before any request when a durable/queue recovery blocks transfer', async () => {
    const { actions, onEditDraft } = setup({ canEditDraft: () => false });
    await expect(actions.edit()).rejects.toThrow('草稿');
    expect(requests()).toEqual([]); expect(onEditDraft).not.toHaveBeenCalled();
  });
  it.each([
    [{ type: 'file', url: 'data:text/plain;base64,eA==' }],
    [{ type: 'file', uri: 'data:text/plain,hidden' }],
    [{ type: 'agent', name: 'build' }],
  ])('rejects an unsafe or unsupported historical attachment before staging: %j', async part => {
    const original = handle;
    handle = (path, method, body) => path.includes('/message/message') ? { ...raw, content: [...raw.content, part] } : original(path, method, body);
    const { actions, onEditDraft } = setup();
    await expect(actions.edit()).rejects.toThrow();
    expect(requests().some(input => input.method !== 'GET')).toBe(false);
    expect(onEditDraft).not.toHaveBeenCalled();
  });
  it('does not change draft/history on server rejection; releases the mutation lock for retry', async () => {
    const { actions, onEditDraft, onRevert } = setup();
    const original = handle;
    handle = (path, method, body) => { if (path.includes('/revert/stage?')) throw Object.assign(new Error('Neutral fixture busy'), { status: 409 }); return original(path, method, body); };
    await expect(actions.edit()).rejects.toThrow('fixture busy');
    expect(onEditDraft).not.toHaveBeenCalled(); expect(onRevert).not.toHaveBeenCalled(); expect(actions.pending()).toBe(false);
    handle = original; await actions.edit(); expect(onEditDraft).toHaveBeenCalledOnce();
  });
  it('reconciles an unknown stage result instead of claiming rollback or losing recovery authority', async () => {
    const original = handle;
    handle = (path, method, body) => path.includes('/revert/stage?') ? { messageID: raw.id, files: [{}] } : original(path, method, body);
    const onUncertain = vi.fn();
    const { actions, onChanged, onEditDraft, onRevert } = setup({ onUncertain });
    await expect(actions.edit()).rejects.toThrow('file diff');
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onUncertain).toHaveBeenCalledOnce();
    expect(onEditDraft).not.toHaveBeenCalled(); expect(onRevert).not.toHaveBeenCalled();
  });
  it('serializes history mutations across separately mounted action rows', async () => {
    let release!: (value: unknown) => void;
    const stage = new Promise(resolve => { release = resolve; });
    const original = handle;
    handle = (path, method, body) => path.includes('/revert/stage?') ? stage : original(path, method, body);
    const first = setup(), second = setup();
    const operation = first.actions.revert();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(second.actions.pending()).toBe(true);
    await expect(second.actions.redo()).rejects.toThrow('pending');
    release({ messageID: raw.id }); await operation;
    expect(second.actions.pending()).toBe(false);
  });
  it('refuses a changed selected message before any mutation', async () => {
    const original = handle;
    handle = (path, method, body) => {
      const result = original(path, method, body);
      if (path.includes('/message/message')) selected = { ...selected!, id: 'changed-row' };
      return result;
    };
    await expect(setup().actions.edit()).rejects.toThrow('unavailable');
    expect(requests().some(input => input.method === 'POST')).toBe(false);
  });
  it('keeps a redo boundary when local draft persistence fails after staging', async () => {
    const onEditDraft = vi.fn(async () => { throw new Error('Storage unavailable'); });
    const { actions, onRevert } = setup({ onEditDraft });
    await expect(actions.edit()).rejects.toThrow('Storage unavailable');
    expect(onRevert).toHaveBeenCalledWith({ messageID: raw.id, files: [] });
    selected = undefined;
    await actions.redo();
    expect(onRevert).toHaveBeenLastCalledWith(null);
  });
  it('finishes the page-owned edit transfer when the staged row is removed from the visible list', async () => {
    const onRevert = vi.fn(() => { selected = undefined; });
    const { actions, onEditDraft } = setup({ onRevert });
    await actions.edit();
    expect(onEditDraft).toHaveBeenCalledOnce();
    expect(onRevert).toHaveBeenCalledWith({ messageID: raw.id, files: [] });
  });
  it.each([true, false])('blocks local or authoritative live execution (local=%s)', async local => {
    busy = local;
    const original = handle;
    handle = (path, method, body) => path === '/api/session/active' ? { data: { [target.id]: { type: 'running' } } } : original(path, method, body);
    const { actions } = setup();
    await expect(actions.revert()).rejects.toThrow('running');
    await expect(actions.redo()).rejects.toThrow('running');
    expect(requests().some(input => input.method !== 'GET')).toBe(false);
  });
  it('never interprets malformed authority as an idle session', async () => {
    handle = () => ({ data: [] });
    await expect(setup().actions.revert()).rejects.toThrow('Invalid active membership');
  });
  it('fences Host/page changes after a successful request before touching local state', async () => {
    const original = handle;
    handle = (path, method, body) => { const value = original(path, method, body); if (path.includes('/revert/stage?')) current = false; return value; };
    const { actions, onEditDraft, onRevert } = setup();
    await expect(actions.edit()).rejects.toThrow('source changed');
    expect(onEditDraft).not.toHaveBeenCalled(); expect(onRevert).not.toHaveBeenCalled();
  });
  it('rechecks running authority immediately before stage', async () => {
    let reads = 0; const original = handle;
    handle = (path, method, body) => path === '/api/session/active' && ++reads === 2 ? { [target.id]: { type: 'running' } } : original(path, method, body);
    await expect(setup().actions.edit()).rejects.toThrow('running');
    expect(requests().some(input => input.method === 'POST')).toBe(false);
  });
  it('redo is session-scoped and remains usable without the reverted message row', async () => {
    const { actions, onRevert, onChanged } = setup();
    await actions.revert(false); selected = undefined; await actions.redo();
    expect(requests().find(input => input.method === 'POST')?.body).toEqual({ messageID: raw.id, files: false });
    expect(requests().find(input => input.method === 'DELETE')?.path).toBe(`${root}revert?directory=%2Fworkspace%2Fspace%20one`);
    expect(onRevert.mock.calls.map(([value]) => value)).toEqual([{ messageID: raw.id, files: [] }, null]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
  it('fork resolves exclusive boundaries from authoritative sequence, not message identity ordering', async () => {
    const original = handle;
    selected = messageFrom({ id: 'z-answer', type: 'assistant', text: 'Answer' })!;
    handle = (path, method, body) => {
      if (path.includes('/message/z-answer?')) return { id: 'z-answer', type: 'assistant' };
      if (path.includes('/message?')) return { data: [{ id: 'a-next', type: 'user' }, { id: 'z-answer', type: 'assistant', finish: 'stop' }, { id: 'prior', type: 'user' }], cursor: { next: null } };
      if (path.includes('/fork?')) { expect(body).toEqual({ before: 'a-next' }); return { data: { id: 'forked', title: 'Fork', directory: target.directory } }; }
      return original(path, method, body);
    };
    const { actions, onOpenChat } = setup(); await actions.fork();
    expect(onOpenChat).toHaveBeenCalledWith({ ...target, id: 'forked', title: 'Fork' });
  });
  it('refuses to fork an incomplete live turn', async () => {
    busy = true; selected = messageFrom({ id: 'answer', type: 'assistant' })!;
    handle = path => path.startsWith('/api/session/s%2Fone?') ? { id: target.id, directory: target.directory } : path.includes('/message/answer?') ? { id: 'answer', type: 'assistant' } : { data: [{ id: 'answer', type: 'assistant' }] };
    await expect(setup().actions.fork()).rejects.toThrow('still running');
    expect(requests().some(input => input.method === 'POST')).toBe(false);
  });
  it.each(['stage', 'fork', 'clear'] as const)('returns unknown for lost %s ACK and blocks every other history writer', async kind => {
    const original = handle;
    handle = (path, method, body) => {
      if (path.includes('/fork?') || method === 'DELETE' || path.includes('/revert/stage?')) throw new Error('Lost acknowledgement');
      return original(path, method, body);
    };
    const onPending = vi.fn(), onUncertain = vi.fn();
    const { actions } = setup({ onPending, onUncertain });
    const outcome = kind === 'stage' ? await actions.stage() : kind === 'fork' ? await actions.forkAt(null) : await actions.clear();
    expect(outcome.status).toBe('unknown'); expect(actions.unknown()).toBe(true);
    expect(onPending.mock.calls).toEqual([[true]]); expect(onUncertain).toHaveBeenCalledOnce();
    const writes = requests().filter(row => row.method !== 'GET').length;
    expect((await setup().actions.clear()).status).toBe('rejected');
    expect(requests().filter(row => row.method !== 'GET')).toHaveLength(writes);
  });
  it.each([400, 403, 404, 409, 422])('returns rejected for explicit HTTP %s without retaining unknown', async status => {
    const original = handle;
    handle = (path, method, body) => method === 'DELETE' ? Promise.reject(Object.assign(new Error('Rejected'), { status })) : original(path, method, body);
    const { actions } = setup();
    expect((await actions.clear()).status).toBe('rejected'); expect(actions.pending()).toBe(false);
  });
  it('rejects pre-dispatch failures and does not create a fork after failed exact authority', async () => {
    const { actions } = setup({ onDispatch: async () => { throw new Error('Storage unavailable'); } });
    expect((await actions.stage()).status).toBe('rejected');
    expect(requests().some(row => row.method !== 'GET')).toBe(false);
    const original = handle;
    handle = (path, method, body) => path.startsWith('/api/session/s%2Fone?') ? { id: target.id, directory: '/other' } : original(path, method, body);
    expect((await actions.forkAt(null)).status).toBe('rejected');
    expect(requests().some(row => row.method !== 'GET')).toBe(false);
  });
  it.each(['stage', 'clear'] as const)('never changes an acknowledged %s to retryable failure when refresh fails', async kind => {
    const { actions } = setup({ onChanged: async () => { throw new Error('Read failed after ACK'); } });
    expect((await (kind === 'stage' ? actions.stage() : actions.clear())).status).toBe('accepted');
    expect(actions.unknown()).toBe(false); expect(actions.pending()).toBe(false);
  });
  it('preserves an acknowledged fork even when the navigation callback fails', async () => {
    const original = handle;
    handle = (path, method, body) => path.includes('/fork?') ? { id: 'forked', directory: target.directory } : original(path, method, body);
    const { actions } = setup({ onOpenChat: () => { throw new Error('Navigation unavailable'); } });
    const outcome = await actions.forkAt(null);
    expect(outcome.status).toBe('accepted'); expect(outcome.target?.id).toBe('forked');
    expect(requests().filter(row => row.method === 'POST')).toHaveLength(1);
  });
  it('fork-current uses exact session authority and the existing Host fork endpoint', async () => {
    const original = handle;
    handle = (path, method, body) => path.includes('/fork?') ? { id: 'forked', directory: target.directory } : original(path, method, body);
    const { actions, onOpenChat } = setup();
    expect((await actions.forkAt(null)).status).toBe('accepted');
    expect(requests().filter(row => row.method === 'POST')).toEqual([{ path: `${root}fork?directory=%2Fworkspace%2Fspace%20one`, method: 'POST', body: {} }]);
    expect(requests().some(row => row.path.includes('/message'))).toBe(false); expect(onOpenChat).toHaveBeenCalledOnce();
  });
  it('does not dispatch after invocation retirement during preparation', async () => {
    let admitted = true;
    const { actions } = setup({ onDispatch: async () => { admitted = false; } });
    expect((await actions.stage(true, { current: () => admitted })).status).toBe('rejected');
    expect(requests().some(row => row.method !== 'GET')).toBe(false);
  });
});

it('validates revert file payloads and losslessly adapts durable file references', () => {
  const file = { file: '/workspace/a.txt', status: 'modified', additions: 1, deletions: 2, patch: '@@ neutral' };
  expect(nativeRevertFrom({ data: { messageID: 'm', files: [file] } })).toEqual({ messageID: 'm', files: [file] } satisfies NativeRevert);
  expect(() => nativeRevertFrom({ messageID: 'm', files: [{}] })).toThrow('file diff');
  expect(nativeEditFiles([{ uri: 'file:///host/a', name: 'a' }])).toEqual([{ uri: 'file:///host/a', name: 'a', mime: 'application/octet-stream' }]);
});
