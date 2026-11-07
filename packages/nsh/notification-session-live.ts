import { eventSessionID, record, unwrap, type RuntimeEvent, type Session } from './model';
import { notificationIdentifier, type NotificationLiveEvent, type NotificationScope } from './notification-core';
import type { NotificationAdmission } from '../web/server/lib/notifications/admission-event.js';
import type { NotificationTarget } from './notification-core';

/** Call only inside state’s already-fenced live event handler, after its directory/session relevance check. */
export function sessionTerminalNotification(input: {
  source: 'live'; scope: NotificationScope; event: RuntimeEvent;
  target: { id: string; directory: string }; subtask: boolean;
}): NotificationLiveEvent | null {
  const { event, target } = input;
  if (input.source !== 'live' || !['session.execution.succeeded', 'session.execution.failed'].includes(event.type)
    || !notificationIdentifier(event.id) || !notificationIdentifier(target.id) || eventSessionID(event) !== target.id
    || (event.directory && event.directory !== target.directory)) return null;
  return {
    origin: 'live', scope: { ...input.scope }, eventID: event.id,
    kind: event.type === 'session.execution.failed' ? 'error' : input.subtask ? 'subtask' : 'completion',
    target: { kind: 'session', id: target.id },
  };
}

/** Exact owning API lookup, injected through the authenticated native request boundary. No transcript reads. */
export function notificationSessionLookup(request: (path: string) => Promise<unknown>) {
  return async (id: string, directory: string | null, current: () => boolean): Promise<readonly Session[]> => {
    if (!notificationIdentifier(id) || directory !== null && !directory.trim() || !current()) throw new Error('notification_stale');
    const value = record(unwrap(await request(`/api/session/${encodeURIComponent(id)}${directory === null ? '' : `?directory=${encodeURIComponent(directory)}`}`)));
    if (!current()) throw new Error('notification_stale');
    const actual = typeof value.directory === 'string' ? value.directory : record(value.location).directory;
    if (value.id !== id || typeof actual !== 'string' || !actual.trim() || directory !== null && actual !== directory || value.parentID !== undefined && value.parentID !== null && !notificationIdentifier(value.parentID)) throw new Error('notification_invalid_session');
    return [{ id, directory: actual, title: typeof value.title === 'string' ? value.title : id, updated: 0, ...(typeof value.parentID === 'string' ? { parentID: value.parentID } : {}) }];
  };
}

export type NotificationCatalogIdentity = { kind: 'session'; session: Session } | { kind: 'assistant' | 'schedule'; id: string; projectID?: string };
export type NotificationCatalogEntry = { target: NotificationTarget; projectID?: string };
export type NotificationIdentityInput = {
  sessions: () => readonly Session[];
  lookup: (id: string, directory: string, current: () => boolean) => Promise<readonly Session[]>;
  catalog: (target: NotificationTarget, current: () => boolean) => readonly NotificationCatalogEntry[] | Promise<readonly NotificationCatalogEntry[]>;
};

/** Catalog refs stay indexed; a missing child uses one authoritative identity lookup, never a stream or history. */
export function createNotificationIdentityResolver(input: NotificationIdentityInput) {
  let source: readonly Session[] | null = null, index = new Map<string, Session | null>();
  return async (admission: NotificationAdmission, current: () => boolean): Promise<NotificationCatalogIdentity | null> => {
    if (!current()) return null;
    const target = admission.target;
    if (target.kind !== 'session') {
      const catalog = await input.catalog(target, current);
      const matches = catalog.filter(entry => entry.target.kind === target.kind && entry.target.id === target.id);
      if (!current() || matches.length !== 1) return null;
      if (admission.source.type === 'schedule' && matches[0].projectID !== admission.source.projectID) return null;
      return { kind: target.kind, id: target.id, ...(matches[0].projectID ? { projectID: matches[0].projectID } : {}) };
    }
    if (admission.source.type !== 'session') return null;
    const next = input.sessions();
    if (source !== next) {
      source = next; index = new Map();
      for (const session of next) index.set(session.id, index.has(session.id) ? null : session);
    }
    const { directory, parentID } = admission.source;
    const cached = index.get(target.id);
    const matches = index.has(target.id) ? cached ? [cached] : [] : await input.lookup(target.id, directory, current);
    if (!current() || matches.length !== 1) return null;
    const actual = matches[0];
    if (actual.id !== target.id || actual.directory !== directory || (actual.parentID ?? null) !== parentID) return null;
    return { kind: 'session', session: actual };
  };
}

export function createNotificationAdmissionResolver(input: NotificationIdentityInput) {
  const resolve = createNotificationIdentityResolver(input);
  return async (admission: NotificationAdmission, current: () => boolean): Promise<readonly NotificationTarget[]> =>
    await resolve(admission, current) ? [{ ...admission.target }] : [];
}
