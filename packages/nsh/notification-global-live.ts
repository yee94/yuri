import { decodeNativeGoal } from './chat-goal-model';
import { eventSessionID, record, type RuntimeEvent } from './model';
import { notificationEventIdentifier, notificationIdentifier } from './notification-core';

export type NotificationGlobalAuthority =
  | { domain: 'session'; kind: 'completion' | 'error' | 'question' | 'permission' | 'goal'; id: string; directory: string; eventID: string }
  | { domain: 'assistant'; signal: 'spoken' | 'complete' | 'error' | 'cancelled'; id: string; eventID: string };

/** Length-delimited, injective namespace; never truncate/hash distinct domain identities into one ID. */
function identity(namespace: string, ...parts: string[]): string | null {
  if (!parts.every(notificationIdentifier)) return null;
  const key = ['n', namespace, ...parts.map(part => `${part.length}_${part}`)].join('_');
  return notificationEventIdentifier(key) ? key : null;
}
function uniqueIdentifier(...values: unknown[]): string | null {
  const present = values.filter(value => value !== undefined);
  if (!present.length || !present.every(notificationIdentifier) || !present.every(value => value === present[0])) return null;
  return present[0] as string;
}
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Parsed live global contracts only. No GET/history/status projection, text retention or transport. */
export function notificationGlobalAuthority(event: RuntimeEvent): NotificationGlobalAuthority | null {
  if (event.key !== 'global') return null;
  const body = event.body;
  switch (event.type) {
    case 'session.execution.succeeded':
    case 'session.execution.failed': {
      const id = eventSessionID(event), kind = event.type === 'session.execution.succeeded' ? 'completion' : 'error';
      if (!notificationIdentifier(event.id)) return null;
      const eventID = identity(kind, id, event.id);
      return eventID ? { domain: 'session', kind, id, directory: event.directory, eventID } : null;
    }
    case 'question.asked':
    case 'form.created':
    case 'permission.asked': {
      // Host runtime.js readNotificationEventFields accepts legacy questions and v2 data.form.
      const form = event.type === 'form.created' ? record(body.form ?? body) : {};
      if (event.type === 'form.created' && (!Array.isArray(form.fields) || !form.fields.length)) return null;
      if (event.type === 'question.asked' && (!Array.isArray(body.questions) || !body.questions.length)) return null;
      const id = uniqueIdentifier(body.sessionID, body.sessionId, form.sessionID);
      const requestFields = [body.id, body.requestID, body.requestId, form.id];
      const hasRequest = requestFields.some(value => value !== undefined);
      const requestID = hasRequest ? uniqueIdentifier(...requestFields) : uniqueIdentifier(event.id);
      const kind = event.type === 'permission.asked' ? 'permission' : 'question';
      const eventID = id && requestID ? identity(kind, id, requestID) : null;
      return eventID && id ? { domain: 'session', kind, id, directory: event.directory, eventID } : null;
    }
    case 'rpc.opencode.goal.changed': {
      // Reuse the production Goal.State decoder; updatedAt or an SSE replay is not a new Goal.
      try {
        const goal = decodeNativeGoal(body.goal), id = uniqueIdentifier(body.sessionID);
        const eventID = goal?.status === 'complete' && id ? identity('goal', id, goal.id) : null;
        return eventID && id ? { domain: 'session', kind: 'goal', id, directory: event.directory, eventID } : null;
      } catch { return null; }
    }
    case 'yuri:contact-bubble-delta':
    case 'yuri:contact-turn-end': {
      if (event.type === 'yuri:contact-bubble-delta' && body.done !== true) return null;
      const id = uniqueIdentifier(body.assistantID), turnID = uniqueIdentifier(body.turnID);
      const eventID = id && turnID ? identity('assistant', id, turnID) : null;
      if (!id || !eventID || !timestamp(body.occurredAt)) return null;
      if (event.type === 'yuri:contact-bubble-delta') {
        // The current harness publishes a complete public bubble in delta with done:true.
        // Streaming tokens and empty markers cannot establish a spoken result.
        if (body.done !== true || typeof body.delta !== 'string' || !body.delta.trim()
          || typeof body.bubbleIndex !== 'number' || !Number.isSafeInteger(body.bubbleIndex) || body.bubbleIndex < 0) return null;
        return { domain: 'assistant', signal: 'spoken', id, eventID };
      }
      const status = body.status;
      return status === 'complete' || status === 'error' || status === 'cancelled'
        ? { domain: 'assistant', signal: status, id, eventID } : null;
    }
    // scheduled-task-ran lacks runID, manual reason and the Assistant result-review decision.
    // yuri:notification also drops turn/run identity. Neither is a safe automatic adapter.
    default: return null;
  }
}
