import type { ContextUsageEntry, ContextUsageSnapshot } from './context-usage-core';

export const contextUsageFixtureScope = { hostID: 'context-usage-fixture', generation: 1, sessionID: 'ses_context', directory: '/workspace/actual' };
export function contextUsageFixtureSnapshot(): ContextUsageSnapshot {
  const entry = (id: string, role: 'user' | 'assistant', created: number, extra: Record<string, unknown>, parts: Record<string, unknown>[]): ContextUsageEntry => ({
    info: { id, role, sessionID: contextUsageFixtureScope.sessionID, time: { created }, ...extra } as ContextUsageEntry['info'],
    parts: parts.map((part, index) => ({ id: `${id}:${index}`, messageID: id, sessionID: contextUsageFixtureScope.sessionID, ...part })) as ContextUsageEntry['parts'],
  });
  return { scope: { ...contextUsageFixtureScope }, session: { id: 'ses_context', title: 'Context overview production fixture', time: { created: 1700000000000 } }, providers: [
    { id: 'decoy', name: 'Wrong first provider', models: [{ id: 'first', name: 'Wrong first model', limit: { context: 1000 } }] },
    { id: 'actual', name: 'Actual provider', models: [{ id: 'model', name: 'Actual model', limit: { context: 400000 } }] },
  ], messages: [
    entry('user', 'user', 1700000000100, { system: 'System context' }, [{ type: 'text', text: 'Inspect the complete context overview.' }]),
    entry('step', 'assistant', 1700000001000, { providerID: 'actual', modelID: 'model', time: { created: 1700000001000, streamed: 1700000002000, completed: 1700000002100 }, finish: 'tool-calls', tokens: { input: 12000, output: 400, reasoning: 100, cache: { read: 8000, write: 1000 } }, cost: .002 }, [{ type: 'tool', tool: 'read', callID: 'call', state: { status: 'completed', input: { path: '/workspace/actual/a.ts' }, output: 'Synthetic file text', time: { start: 1700000002000, end: 1700000002100 } } }]),
    entry('final', 'assistant', 1700000003000, { providerID: 'actual', modelID: 'model', time: { created: 1700000003000, streamed: 1700000005000, completed: 1700000005100 }, finish: 'stop', tokens: { input: 18000, output: 900, reasoning: 100, cache: { read: 8000, write: 1900 } }, cost: .003 }, [{ type: 'text', text: 'All overview fields remain visible. Literal JSON contains ``` and <b>not markup</b>.' }]),
  ] };
}
