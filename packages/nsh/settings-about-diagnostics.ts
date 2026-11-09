import { eventSessionID, type RuntimeEvent } from './model';

/** Stricter, content-free subset of Web client diagnostics. No user text or raw identifiers. */
export type AboutDiagnosticEvent = {
  at: number;
  feat: 'transcript';
  kind: 'sse-event';
  sessionID: string;
  source: 'sse';
  sseType: string;
  surfaceKind: RuntimeEvent['key'];
};
export const aboutDiagnosticTypes = [
  'reconnected', 'server.connected', 'global.disposed', 'session.status', 'session.idle', 'session.error', 'session.created', 'session.updated', 'session.deleted',
  'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
  'session.step.started', 'session.step.finished', 'session.tool.started', 'session.tool.finished',
  'session.step.failed', 'session.text.started', 'session.text.ended', 'session.reasoning.started', 'session.reasoning.ended',
  'session.tool.input.started', 'session.tool.input.ended', 'session.tool.called', 'session.tool.success', 'session.tool.failed',
  'session.retry.scheduled', 'session.inbox.delivered', 'session.inbox.cancelled', 'session.instructions.updated', 'session.metadata.updated', 'session.usage.updated',
  'session.revert.staged', 'session.revert.committed', 'session.revert.cleared',
  'message.updated', 'message.removed', 'message.part.updated', 'message.part.removed',
  'permission.asked', 'permission.replied', 'question.asked', 'question.replied', 'question.rejected', 'form.asked', 'form.replied', 'form.cancelled',
  'yuri:session-status', 'yuri:session-index-changed', 'yuri:assistants-changed', 'yuri:scheduled-tasks-changed',
  'yuri:contact-turn-start', 'yuri:contact-turn-end',
  'yuri:project-order-changed', 'yuri:worktree-topology-changed',
] as const;
const eligible = new Set<string>(aboutDiagnosticTypes);
type Scope = { hostID: string; generation: number };
type Call = (name: string, body?: Record<string, unknown>) => Promise<unknown>;
let owner: ReturnType<typeof createAboutDiagnosticsRoot> | undefined;
const equal = (a: Scope | null, b: Scope | null) => !!a && !!b && a.hostID === b.hostID && a.generation === b.generation;

/** Settings uses the same root lease; never mounts a second event subscription. */
export async function aboutDiagnosticsCall(call: Call, name: string, body?: Record<string, unknown>) {
  if (name === 'native.diagnostics.export') await owner?.flush();
  const root = owner, current = root?.capture();
  const result = await call(name, body);
  if (owner === root && current?.() && (name === 'native.diagnostics.setEnabled' || name === 'native.diagnostics.status')) root?.adopt(result);
  return result;
}

/** One root sink composed with the existing observeRuntime callback. No subscriptions, catalog reads or token serialization. */
export function createAboutDiagnosticsRoot(deps: { call: Call; scope: () => Scope | null; now?: () => number }) {
  if (owner) throw new Error('about_diagnostics_duplicate_owner');
  let scope: Scope | null = null, lease: string | null = null, enabled = false, alive = true, revision = 0;
  let flight: Promise<void> | undefined, dropped = 0;
  const queue: AboutDiagnosticEvent[] = [];
  // Anonymous ordinal relation only; once the bounded identity map fills, use
  // the shared unknown bucket rather than retain unbounded raw runtime IDs.
  const identities = new Map<string, string>();
  function clear() { lease = null; enabled = false; queue.length = 0; identities.clear(); dropped = 0; revision++; }
  function adopt(raw: unknown) {
    if (!alive || !equal(scope, deps.scope()) || !raw || typeof raw !== 'object') return;
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== 2 || value.mode !== 'event-recorder' || typeof value.enabled !== 'boolean') return;
    const nextLease = value.enabled && typeof value.recordingLease === 'string' && value.recordingLease.length <= 128 ? value.recordingLease : null;
    if (lease !== nextLease) { clear(); lease = nextLease; }
    enabled = value.enabled && !!lease;
  }
  async function flush() {
    if (flight) { await flight; if (queue.length) await flush(); return; }
    if (!alive || !enabled || !lease || !scope || !equal(scope, deps.scope()) || !queue.length) return;
    const captured = scope, capturedLease = lease, started = revision;
    const events = queue.splice(0, 32);
    const lost = dropped; dropped = 0;
    const task = (async () => {
      try {
        await deps.call('native.diagnostics.append', { hostID: captured.hostID, lease: capturedLease, events, dropped: lost });
      } catch {
        // Failure disables this lease. No raw error, automatic retry loop or
        // feedback event that recursively records itself. Refresh may recover.
        if (started === revision) clear();
      }
    })();
    flight = task;
    try { await task; } finally { if (flight === task) flight = undefined; }
    if (alive && queue.length) await flush();
  }
  const root = {
    adopt, flush,
    capture() { const started = revision, captured = scope; return () => alive && revision === started && equal(captured, deps.scope()); },
    async refresh() {
      const next = deps.scope();
      if (!equal(scope, next)) { clear(); scope = next; }
      if (!alive || !scope) return;
      const started = revision;
      try { const value = await deps.call('native.diagnostics.status'); if (started === revision) adopt(value); }
      catch { if (started === revision) clear(); }
    },
    onEvent(event: RuntimeEvent, captured: Scope) {
      if (!alive || !enabled || !lease || !equal(scope, captured) || !equal(scope, deps.scope()) || !eligible.has(event.type)) return;
      const rawID = eventSessionID(event);
      let sessionID = 'session-0';
      if (rawID && rawID.length <= 256) {
        sessionID = identities.get(rawID) ?? 'session-0';
        if (sessionID === 'session-0' && identities.size < 500) { sessionID = `session-${identities.size + 1}`; identities.set(rawID, sessionID); }
      }
      // Fixed property reads only. Never inspect text/parts/attachments or walk
      // a catalog, and skip all delta/token events before touching the body.
      const record: AboutDiagnosticEvent = { at: (deps.now ?? Date.now)(), feat: 'transcript', kind: 'sse-event', sessionID, source: 'sse', sseType: event.type, surfaceKind: event.key };
      if (queue.length >= 128) { queue.shift(); dropped = Math.min(dropped + 1, 1_000_000); }
      queue.push(record); void flush();
    },
    dispose() { if (!alive) return; alive = false; clear(); scope = null; if (owner === root) owner = undefined; },
  };
  owner = root;
  return root;
}
