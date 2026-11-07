import { expect, it } from 'vitest';
import { sessionTerminalNotification } from './notification-session-live';
import type { RuntimeEvent } from './model';

const input = { source: 'live' as const, scope: { hostID: 'host-a', generation: 5 }, target: { id: 'session-a', directory: '/workspace/project' }, subtask: false };
const event: RuntimeEvent = { key: 'chat', type: 'session.execution.succeeded', id: 'event-a', directory: input.target.directory, body: { sessionID: 'session-a', error: { message: 'private' }, token: 'excluded' } };
it('only projects real succeeded/failed live authority, never historical busy/idle or step completion', () => {
  expect(sessionTerminalNotification({ ...input, event })).toEqual({ origin: 'live', scope: input.scope, eventID: 'event-a', kind: 'completion', target: { kind: 'session', id: 'session-a' } });
  expect(sessionTerminalNotification({ ...input, subtask: true, event })?.kind).toBe('subtask');
  expect(sessionTerminalNotification({ ...input, event: { ...event, type: 'session.execution.failed' } })?.kind).toBe('error');
  for (const type of ['session.status', 'session.idle', 'session.step.completed', 'session.text.ended', 'session.execution.interrupted', 'session.execution.started', 'reconnected']) {
    expect(sessionTerminalNotification({ ...input, event: { ...event, type, body: { ...event.body, status: 'idle', completed: 123 } } })).toBeNull();
  }
  expect(sessionTerminalNotification({ ...input, source: 'history' as 'live', event })).toBeNull();
});
it('requires a real event ID and the actual scoped session, without forwarding private event data', () => {
  for (const changed of [{ ...event, id: undefined }, { ...event, id: 'https://outside.invalid' }, { ...event, directory: '/other/worktree' }, { ...event, body: { sessionID: 'session-b' } }]) expect(sessionTerminalNotification({ ...input, event: changed })).toBeNull();
  const result = sessionTerminalNotification({ ...input, event });
  expect(JSON.stringify(result)).not.toMatch(/private|excluded|workspace|token|error/);
});
