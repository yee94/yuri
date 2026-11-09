import { cleanup, effect, lifecycle, signal, untracked } from 'nsh';
import { app, captureHostOperation, epoch } from './state';
import { bindRequest } from './runtime';
import type { VerifiedDesktopWriterGrant } from './desktop-writer-core';

export type PageOperation = ReturnType<typeof captureHostOperation>;

/** Display identity survives suspension. Only explicit operation objects may resume. */
export function createPageOperations(active: () => boolean = () => true, writer?: () => VerifiedDesktopWriterGrant | null) {
  const connection = app.connection();
  const identity = connection && { id: connection.id, url: connection.url, authorizationID: connection.authorizationID };
  const operation = signal<PageOperation | null>(null);
  const listeners = new Set<(previous: PageOperation | null) => void>();
  let alive = true, retired = false;
  function displayCurrent() {
    const next = app.connection();
    if (next?.id !== identity?.id || next?.url !== identity?.url || next?.authorizationID !== identity?.authorizationID) retired = true;
    return alive && !retired;
  }
  function retire() {
    const previous = operation();
    if (!previous) return;
    // Revoke callbacks before notifying owners; late finally cannot release a new gate.
    operation.set(null);
    listeners.forEach(listener => listener(previous));
  }
  effect(() => {
    app.connection(); app.runtimeScope(); epoch(); lifecycle();
    const displayed = displayCurrent();
    const visible = active();
    // current() tracks the root's confirmed-readiness signal, including verified
    // legacy snapshots whose null runtimeScope itself does not change on resume.
    const candidate = captureHostOperation();
    const admitted = candidate.current();
    untracked(() => {
      if (!displayed || !visible || lifecycle() !== 'active' || !admitted) { retire(); return; }
      const previous = operation();
      if (previous?.current()) return;
      retire();
      const captured = candidate;
      const request = writer ? bindRequest(captured.scope, writer) : captured.request;
      const current = () => displayCurrent() && operation() === assigned && captured.current() && active();
      const assigned: PageOperation = Object.freeze({ ...captured, current, request: async (path, method, body) => {
        if (!current()) throw new Error('page_operation_stale');
        const result = await request(path, method, body);
        if (!current()) throw new Error('page_operation_stale');
        return result;
      } });
      operation.set(assigned);
    });
  });
  cleanup(() => { alive = false; retire(); listeners.clear(); });
  return { displayCurrent, operation,
    current: () => operation()?.current() === true,
    capture() { const captured = operation(); if (!captured?.current()) throw new Error('page_operation_stale'); return captured; },
    onRetire(listener: (previous: PageOperation | null) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
