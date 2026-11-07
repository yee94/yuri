import { expect, it } from 'vitest';
import { runtimeEventFrom, type RuntimeEvent, type Row } from './model';
import { notificationGlobalAuthority } from './notification-global-live';

const parsed = (type: string, data: Row, id?: string) => runtimeEventFrom({ key: 'global', data: JSON.stringify({ payload: { type, data, ...(id ? { id } : {}), location: { directory: '/project' } } }) })!;
const goal = { id: 'goal-a', objective: 'private objective', status: 'complete', reason: 'private reason', rounds: 1, maxRounds: 50, boot: 'boot-a', updatedAt: 10 };

it('uses actual parsed legacy/v2 question and independent permission request identities, without requiring an SSE ID', () => {
  const legacy = notificationGlobalAuthority(parsed('question.asked', { sessionID: 'session-a', id: 'request-a', questions: [{ header: 'Private', question: 'Private' }] }));
  expect(legacy).toMatchObject({ domain: 'session', kind: 'question', id: 'session-a', directory: '/project' });
  const form = notificationGlobalAuthority(parsed('form.created', { form: { sessionID: 'session-a', id: 'request-a', fields: [{ key: 'answer', type: 'string' }] } }));
  expect(form).toEqual(legacy);
  const permission = notificationGlobalAuthority(parsed('permission.asked', { sessionID: 'session-a', id: 'request-a', action: 'edit', message: 'Private' }));
  expect(permission).toMatchObject({ domain: 'session', kind: 'permission', id: 'session-a' });
  expect(permission?.eventID).not.toBe(legacy?.eventID);
  expect(JSON.stringify([legacy, form, permission])).not.toMatch(/Private|fields|questions|action|message/);
  expect(notificationGlobalAuthority(parsed('question.asked', { sessionID: 'session-a', questions: [{}] }, 'stable-event'))).not.toBeNull();
});

it('rejects conflicting identities and malformed/missing authority rather than using any first field or a timestamp', () => {
  for (const body of [
    { id: 'q', sessionID: 'a', sessionId: 'b', questions: [{}] },
    { id: 'q', requestID: 'other', sessionID: 'a', questions: [{}] },
    { id: 'https://invalid', sessionID: 'a', questions: [{}] },
    { sessionID: 'a', questions: [{}] },
    { id: 'q', sessionID: 'a', questions: [] },
  ]) expect(notificationGlobalAuthority(parsed('question.asked', body))).toBeNull();
  expect(notificationGlobalAuthority(parsed('form.created', { sessionID: 'a', form: { sessionID: 'b', id: 'q', fields: [{}] } }))).toBeNull();
  expect(notificationGlobalAuthority(parsed('permission.asked', { sessionID: 'a', requestID: 'https://invalid' }, 'otherwise-valid'))).toBeNull();
  for (const type of ['form.replied', 'form.cancelled', 'permission.replied', 'question.replied', 'session.idle', 'session.status']) {
    expect(notificationGlobalAuthority(parsed(type, { id: 'q', sessionID: 'a', status: 'complete', questions: [{}] }, 'event'))).toBeNull();
  }
});

it('only admits native complete Goal.State and deduplicates the same Goal despite later read timestamps/event IDs', () => {
  const first = notificationGlobalAuthority(parsed('rpc.opencode.goal.changed', { sessionID: 'session-a', goal }));
  expect(first).toMatchObject({ domain: 'session', kind: 'goal', id: 'session-a' });
  const reread = notificationGlobalAuthority(parsed('rpc.opencode.goal.changed', { sessionID: 'session-a', goal: { ...goal, updatedAt: 20 } }, 'another-event'));
  expect(reread).toEqual(first);
  expect(JSON.stringify(first)).not.toMatch(/private|reason|objective|boot|rounds/);
  for (const value of [null, {}, { ...goal, status: 'paused' }, { ...goal, status: 'active' }, { ...goal, rounds: '1' }, { ...goal, boot: null }]) {
    expect(notificationGlobalAuthority(parsed('rpc.opencode.goal.changed', { sessionID: 'session-a', goal: value }))).toBeNull();
  }
  expect(notificationGlobalAuthority(parsed('yuri:goal-changed', { sessionID: 'session-a', goal }))).toBeNull();
});

it('recognizes public bubble completion and explicit contact end while ignoring tokens/start/revision/history', () => {
  const base = { assistantID: 'bot-a', turnID: 'turn-a', occurredAt: 10 };
  const spoken = notificationGlobalAuthority(parsed('yuri:contact-bubble-delta', { ...base, bubbleIndex: 0, delta: 'Private', done: true }));
  const end = notificationGlobalAuthority(parsed('yuri:contact-turn-end', { ...base, status: 'complete' }));
  expect(spoken).toMatchObject({ domain: 'assistant', signal: 'spoken', id: 'bot-a' });
  expect(end).toMatchObject({ domain: 'assistant', signal: 'complete', eventID: spoken?.eventID });
  for (const delta of [{ done: false, delta: 'token' }, { done: true, delta: '' }, { done: true, delta: 'text', bubbleIndex: -1 }]) {
    expect(notificationGlobalAuthority(parsed('yuri:contact-bubble-delta', { ...base, bubbleIndex: 0, ...delta }))).toBeNull();
  }
  expect(notificationGlobalAuthority(parsed('yuri:contact-turn-end', { ...base, status: 'cancelled' }))).toMatchObject({ signal: 'cancelled' });
  expect(notificationGlobalAuthority(parsed('yuri:contact-turn-end', { ...base, status: 'error', error: 'Private' }))).toMatchObject({ signal: 'error' });
  expect(notificationGlobalAuthority(parsed('yuri:contact-turn-end', { ...base, status: 'complete', occurredAt: '10' }))).toBeNull();
  for (const type of ['yuri:contact-turn-start', 'yuri:assistants-changed']) expect(notificationGlobalAuthority(parsed(type, base))).toBeNull();
  const durable = runtimeEventFrom({ key: 'global', data: JSON.stringify({ type: 'rpc.opencode.goal.changed', data: { sessionID: 'session-a', goal }, durable: { source: 'sync' } }) });
  expect(durable).toBeNull();
  expect(notificationGlobalAuthority({ ...parsed('rpc.opencode.goal.changed', { sessionID: 'session-a', goal }), key: 'chat' })).toBeNull();
  const token = parsed('yuri:contact-bubble-delta', {});
  token.body = new Proxy({ done: false }, { get(target, key) { if (key !== 'done') throw new Error('Token must not read identity or text'); return target.done; } });
  for (let n = 0; n < 500; n++) expect(notificationGlobalAuthority(token)).toBeNull();
});

it('uses injective bounded safe IDs and does not adapt run tips or notification tags lacking unique run/turn authority', () => {
  const first = notificationGlobalAuthority(parsed('permission.asked', { sessionID: 'a_b', id: 'c' }));
  const second = notificationGlobalAuthority(parsed('permission.asked', { sessionID: 'a', id: 'b_c' }));
  expect(first?.eventID).not.toBe(second?.eventID);
  const maximum = notificationGlobalAuthority(parsed('permission.asked', { sessionID: 'a'.repeat(128), id: 'b'.repeat(128) }));
  expect(maximum?.eventID.length).toBeGreaterThan(128); expect(maximum?.eventID.length).toBeLessThanOrEqual(384);
  expect(notificationGlobalAuthority(parsed('permission.asked', { sessionID: 'a'.repeat(129), id: 'b' }))).toBeNull();
  const terminal: RuntimeEvent = parsed('session.execution.succeeded', { sessionID: 'session-a' }, 'event-a');
  expect(notificationGlobalAuthority(terminal)).toMatchObject({ kind: 'completion' });
  expect(notificationGlobalAuthority({ ...terminal, id: undefined })).toBeNull();
  for (const status of ['running', 'success', 'error']) {
    expect(notificationGlobalAuthority(parsed('yuri:scheduled-task-ran', { projectId: 'project-a', taskId: 'task-a', ranAt: 123, status }))).toBeNull();
  }
  expect(notificationGlobalAuthority(parsed('yuri:notification', { kind: 'contact', assistantID: 'bot-a', tag: 'contact-bot-a' }))).toBeNull();
});
