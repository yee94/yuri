import { describe, expect, it, vi } from 'vitest';
import { admitAssistantMutation, assistantContacts, assistantPreview, assistantRequest, assistantScheduledFallback, assistantScheduledTasks, clearAssistantHistory, markAssistantCatalogRead, mutateAssistant, readAssistantSnapshot, type AssistantFence } from './assistants-core';
import { record, type Row } from './model';

const bot = { id: 'bot/a', revision: 7, name: 'Research', pinnedAt: null };
const capability = { supported: true, enabled: true };
function setup(responses: unknown[]) {
  let current = true;
  const request = vi.fn(async () => {
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value;
  });
  const fence: AssistantFence = { current: () => current, request };
  return { fence, request, stale: () => { current = false; } };
}
describe('native assistant contracts', () => {
  it('keeps newest single Host pin, returns legacy extra pins to recency order, does not mutate source', () => {
    const source = [
      { id: 'old', pinnedAt: 2, latestMessagePreview: { createdAt: 8 } },
      { id: 'winner', pinnedAt: 4, latestMessagePreview: { createdAt: 1 } },
      { id: 'recent', pinnedAt: null, latestMessagePreview: { createdAt: 9 } },
    ];
    expect(assistantContacts(source)).toEqual({ pinned: source[1], others: [source[2], source[0]] });
    expect(source.map(item => item.id)).toEqual(['old', 'winner', 'recent']);
  });
  it('uses source order to break equal pin timestamps and equal message time', () => {
    const source = [{ id: 'a', pinnedAt: 4 }, { id: 'b', pinnedAt: 4 }, { id: 'c', pinnedAt: null }];
    expect(assistantContacts(source).pinned?.id).toBe('a');
    expect(assistantContacts(source).others.map(item => item.id)).toEqual(['b', 'c']);
  });
  it('searches name and preview, never personality prompt or credentials', () => {
    const source = [{ id: 'a', name: 'Research', defaultPrompt: 'hidden prompt', latestMessagePreview: { text: 'Latest Answer' } }];
    expect(assistantContacts(source, 'answer').others).toHaveLength(1);
    expect(assistantContacts(source, 'RESEARCH').others).toHaveLength(1);
    expect(assistantContacts(source, 'hidden').others).toHaveLength(0);
  });
  it('normalizes visible message text, never falls back to model or prompt', () => {
    expect(assistantPreview({ latestMessagePreview: { text: '  Ready\n\n now ' } }, key => key)).toBe('Ready now');
    expect(assistantPreview({ modelID: 'model', defaultPrompt: 'secret' }, key => key)).toBe('assistants.contact.empty');
  });
  it.each(['image', 'file', 'session', 'assistant', 'schedule'])('formats %s preview with an existing locale key', kind => {
    expect(assistantPreview({ latestMessagePreview: { text: '', fallbackKind: kind } }, key => key)).not.toBe('assistants.contact.empty');
  });
  it('sends only revision-fenced pin payload, encoded contact id', async () => {
    const s = setup([capability, { ...bot, revision: 8, pinnedAt: 5 }]);
    await mutateAssistant(s.fence, bot, { pinned: true });
    expect(s.request.mock.calls[1]).toEqual(['/api/yuri/assistants/bot%2Fa', 'PATCH', { expectedRevision: 7, pinned: true }]);
  });
  it('revision conflicts retain supplied snapshot and never blindly retry', async () => {
    const s = setup([capability, new Error('revision_conflict')]);
    await expect(mutateAssistant(s.fence, bot, { pinned: true })).rejects.toThrow('revision_conflict');
    expect(s.request).toHaveBeenCalledTimes(2);
    expect(bot.revision).toBe(7);
    expect(bot.pinnedAt).toBeNull();
  });
  it('rejects missing revision before any write', async () => {
    const s = setup([]);
    await expect(mutateAssistant(s.fence, { id: 'a' }, {})).rejects.toThrow('revision_conflict');
    expect(s.request).not.toHaveBeenCalled();
  });
  it.each([{ supported: false, enabled: true }, { supported: true, enabled: false }, {}])('core denies unavailable capability %j', async value => {
    const s = setup([value]);
    await expect(mutateAssistant(s.fence, bot, { pinned: true })).rejects.toThrow('assistant_disabled');
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it('denied admission never sends a mutation', async () => {
    const s = setup([new Error('HTTP 403')]);
    await expect(admitAssistantMutation(s.fence)).rejects.toThrow('403');
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it('checks alive/epoch before a request', async () => {
    const s = setup([]); s.stale();
    await expect(assistantRequest(s.fence, '/read')).rejects.toThrow('runtime_stale');
    expect(s.request).not.toHaveBeenCalled();
  });
  it('checks alive/epoch after capability await before writing', async () => {
    const s = setup([]);
    s.request.mockImplementation(async () => { s.stale(); return capability; });
    await expect(mutateAssistant(s.fence, bot, { pinned: true })).rejects.toThrow('runtime_stale');
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it('checks alive/epoch after mutation await before returning a success', async () => {
    let calls = 0, current = true;
    const request = vi.fn(async () => { if (++calls === 1) return capability; current = false; return { ...bot, revision: 8 }; });
    await expect(mutateAssistant({ current: () => current, request }, bot, { pinned: true })).rejects.toThrow('runtime_stale');
  });
  it('deletes through exact archived-history contract', async () => {
    const s = setup([capability, { assistantID: bot.id, tombstoneAt: 33 }]);
    await mutateAssistant(s.fence, bot, null);
    expect(s.request.mock.calls[1]).toEqual(['/api/yuri/assistants/bot%2Fa', 'DELETE', { expectedRevision: 7 }]);
  });
  it.each([{ assistants: [] }, { revision: 1, enabled: true, assistants: [], partial: true }, { revision: 1, enabled: true, assistants: null }])('rejects incomplete snapshot %j instead of authoritative empty', async value => {
    const s = setup([value]);
    await expect(readAssistantSnapshot(s.fence)).rejects.toThrow();
  });
  it.each([[{ id: 'a' }], [{ id: '', revision: 1 }], [{ id: 'a', revision: 1 }, { id: 'a', revision: 2 }]])('rejects malformed or duplicate assistant identities %j', async assistants => {
    const s = setup([{ revision: 1, enabled: true, assistants }]);
    await expect(readAssistantSnapshot(s.fence)).rejects.toThrow('invalid_response');
  });
  it('clears only the explicit contact transcript endpoint and validates the new generation', async () => {
    const result = { assistantID: bot.id, reset: true, historyCleared: true, generation: 3 };
    const s = setup([capability, result]);
    expect(await clearAssistantHistory(s.fence, bot)).toEqual(result);
    expect(s.request.mock.calls).toEqual([
      ['/api/yuri/assistants/capability', 'GET', undefined],
      ['/api/yuri/assistants/bot%2Fa/contact/reset', 'POST', undefined],
    ]);
  });
  it.each([
    { assistantID: bot.id, reset: true, historyCleared: false, generation: 3 },
    { assistantID: 'wrong', reset: true, historyCleared: true, generation: 3 },
    { assistantID: bot.id, reset: true, historyCleared: true, generation: -1 },
  ])('does not present a malformed wipe acknowledgement as success %j', async result => {
    const s = setup([capability, result]);
    await expect(clearAssistantHistory(s.fence, bot)).rejects.toThrow('invalid_response');
    expect(s.request).toHaveBeenCalledTimes(2);
  });
  it('never blindly retries an uncertain destructive history wipe', async () => {
    const s = setup([capability, new Error('offline')]);
    await expect(clearAssistantHistory(s.fence, bot)).rejects.toThrow('offline');
    expect(s.request).toHaveBeenCalledTimes(2);
  });
  it('maps linked task project identities and applies the same enabled/name order as Web', () => {
    const task = (id: string, name: string, enabled: boolean) => ({ projectID: 'p /', task: { id, name, enabled, schedule: { kind: 'daily' }, execution: { prompt: '', providerID: 'p', modelID: 'm' } } });
    const result = assistantScheduledTasks({ tasks: [task('paused', 'A', false), task('z', 'Z', true), task('a', 'A', true)] });
    expect(result.incomplete).toBe(false);
    expect(result.tasks.map(entry => [entry.projectId, record(entry.task).id])).toEqual([['p /', 'a'], ['p /', 'z'], ['p /', 'paused']]);
  });
  it('keeps previous linked tasks during unresolved partial results, but successful empty clears them', () => {
    const previous = [{ projectId: 'p', task: { id: 'old', name: 'Old', enabled: true } }];
    expect(assistantScheduledTasks({ tasks: [{ projectID: 'p', taskID: 'old', task: null }] }, previous)).toEqual({ tasks: previous, incomplete: true });
    expect(assistantScheduledTasks({ tasks: [] }, previous)).toEqual({ tasks: [], incomplete: false });
    expect(() => assistantScheduledTasks({ tasks: null }, previous)).toThrow('invalid_response');
  });
  it('recovers old-Host linked schedules from real contact cards without confusing identical ids across projects', () => {
    const contact = { messages: [{ id: 'm', type: 'assistant', content: [{ type: 'card', cardType: 'schedule', projectID: 'p', taskID: 'same' }] }] };
    const task = { id: 'same', name: 'Linked', enabled: true, schedule: { kind: 'daily' }, execution: { prompt: '', providerID: 'p', modelID: 'm' } };
    const fallback = assistantScheduledFallback(contact, { tasks: [{ projectId: 'other', task }, { projectId: 'p', task }], failedProjectIds: [] });
    expect(fallback.incomplete).toBe(false); expect(fallback.tasks.map(entry => entry.projectId)).toEqual(['p']);
  });
  it('keeps prior linked schedules if their referenced project fails during fallback, never treating malformed pages as empty', () => {
    const previous = [{ projectId: 'p', task: { id: 'same', name: 'Old', enabled: true } }];
    const contact = { messages: [{ id: 'm', type: 'assistant', content: [{ type: 'card', cardType: 'schedule', projectID: 'p', taskID: 'same' }] }] };
    expect(assistantScheduledFallback(contact, { tasks: [], failedProjectIds: ['p'] }, previous)).toEqual({ tasks: previous, incomplete: true });
    expect(() => assistantScheduledFallback({ messages: null }, { tasks: [] }, previous)).toThrow();
    expect(() => assistantScheduledFallback(contact, { tasks: [{}] }, previous)).toThrow();
  });
  it('preserves per-contact failures and sends click-time watermark, not guessed latest id', async () => {
    const a: Row = { id: 'a', unreadCount: 1, readTip: { generation: 2, ordinal: 8, messageID: 'exact-a' } };
    const b: Row = { id: 'b', unreadCount: 1, readTip: { generation: 3, ordinal: 9, messageID: 'exact-b' } };
    const s = setup([capability, new Error('HTTP 403'), { assistantID: 'b' }]);
    expect(await markAssistantCatalogRead(s.fence, [a, b])).toBe(1);
    expect(s.request.mock.calls[1]).toEqual(['/api/yuri/assistants/a/contact/read', 'POST', a.readTip]);
    expect(s.request.mock.calls[2]).toEqual(['/api/yuri/assistants/b/contact/read', 'POST', b.readTip]);
    expect(a.unreadCount).toBe(1);
  });
});
