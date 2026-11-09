import { record, text, type Row } from './model';
import { query, sessionPath, type request } from './runtime';
import { inNativeSessionActionStorageLane } from './transcript-actions-storage';

export type NativeCompactReceipt = { status: 'pending' | 'unknown' | 'acknowledged'; inboxID?: string };
type CompactAuthority = { items: readonly Row[]; running: boolean; idle: boolean };

/** Native SDK gap: same official POST/inbox wire as session-compaction-api. No runner or replay loop. */
export function createNativeCompactAction(input: {
  sessionID: string; directory: string;
  capture: () => { current: () => boolean; send: typeof request };
  changed: (receipt: NativeCompactReceipt | null, barrier: boolean) => void;
  admitted: (item: Row) => void;
  journal?: { key?: string; read: () => Promise<NativeCompactReceipt | null>; write: (receipt: NativeCompactReceipt | null) => Promise<void> };
}) {
  let receipt: NativeCompactReceipt | null = null, barrier = false, revision = 0;
  // This admission gate is independent of the old intent's non-replayable receipt.
  let admissionBlocked = false;
  let flight: Promise<boolean> | undefined;
  let journalTail: Promise<void> = Promise.resolve();
  const persist = (value: NativeCompactReceipt | null) => {
    if (input.journal?.key) return inNativeSessionActionStorageLane(input.journal.key, () => input.journal!.write(value));
    const work = journalTail.catch(() => {}).then(() => input.journal?.write(value));
    journalTail = work; return work;
  };
  const restored = input.journal?.read() ?? Promise.resolve(null);
  void restored.catch(() => {});
  const publish = () => input.changed(receipt, barrier);
  let restoreConsumed = false;
  function consumeRestore(prior: NativeCompactReceipt | null) {
    if (restoreConsumed) return false;
    restoreConsumed = true;
    if (!prior) return false;
    receipt = prior; barrier = true; admissionBlocked = prior.status !== 'acknowledged'; return true;
  }
  const restorationLane = input.capture();
  void restored.then(prior => {
    if (!flight && restorationLane.current() && consumeRestore(prior)) publish();
  }).catch(() => {
    if (!flight && restorationLane.current()) { receipt = { status: 'unknown' }; barrier = true; admissionBlocked = true; publish(); }
  });
  return {
    receipt: () => receipt,
    barrier: () => barrier,
    revision: () => revision,
    /** Only a fresh Host delivery + inbox + active snapshot may settle a receipt. */
    async confirmAuthority(value: CompactAuthority, expectedRevision: number) {
      const lane = input.capture();
      if (!lane.current() || revision !== expectedRevision || flight || receipt?.status === 'pending') return false;
      if (value.items.some(item => item.type !== 'compaction' || !text(item.id) || item.sessionID !== input.sessionID)) throw new Error('Invalid compaction inbox authority');
      const adoptedRevision = ++revision;
      barrier = value.running || value.items.length > 0;
      const settled = value.idle && !barrier;
      if (receipt?.status === 'unknown') admissionBlocked = !settled;
      else admissionBlocked = false;
      publish();
      const expectedReceipt = receipt;
      if (settled && expectedReceipt?.status === 'acknowledged') {
        // Keep the acknowledged receipt until durable clearing succeeds. No new
        // compact can race a delayed/failed clear and have its journal erased.
        try {
          await persist(null);
          if (receipt === expectedReceipt) receipt = null;
        } catch (failure) {
          if (receipt === expectedReceipt) receipt = { ...expectedReceipt, status: 'unknown' };
          if (lane.current()) publish();
          throw failure;
        }
        if (lane.current()) publish();
      }
      return lane.current() && revision === adoptedRevision;
    },
    /** Wait only for admission. An unknown old intent may not seal new inputs forever. */
    async waitForAdmission(recover?: () => Promise<void>) {
      if (flight) { try { await flight; } catch { /* Recovery below is read-only; it never replays compact. */ } }
      try { const prior = await restored; if (consumeRestore(prior)) publish(); }
      catch { receipt ??= { status: 'unknown' }; admissionBlocked = true; }
      if (admissionBlocked && recover) await recover();
      return !admissionBlocked;
    },
    observe(type: string, body: Row = {}) {
      const compactionEvent = type === 'session.compaction.started' || type === 'session.compaction.ended' || type === 'session.compaction.failed';
      const inboxEvent = type === 'session.inbox.enqueued' && record(body.item).type === 'compaction'
        || (type === 'session.inbox.delivered' || type === 'session.inbox.cancelled') && !!text(body.inboxID);
      if (!compactionEvent && !inboxEvent) return false;
      revision++;
      if (type === 'session.compaction.started' || type === 'session.inbox.enqueued') barrier = true;
      // Terminal events have no stable compaction inbox identity. A's terminal
      // cannot acknowledge or finish queued B; request authority instead.
      publish(); return true;
    },
    async compact(delivery: 'queue' | 'steer', prepare?: () => Promise<void>): Promise<boolean> {
      if (flight || receipt) return false;
      const lane = input.capture();
      if (!lane.current()) return false;
      const priorBarrier = barrier;
      revision++;
      receipt = { status: 'pending' }; barrier = true; admissionBlocked = true; publish();
      let dispatched = false, journalStarted = false, restoring = true;
      const work = (async () => {
        try {
          const prior = await restored;
          restoring = false;
          if (consumeRestore(prior)) { if (lane.current()) publish(); return false; }
          await prepare?.();
          if (!lane.current()) throw new Error('Compaction source changed');
          journalStarted = true;
          await persist({ status: 'unknown' });
          if (!lane.current()) throw new Error('Compaction source changed');
          dispatched = true;
          const response = record(await lane.send(`${sessionPath(input.sessionID, 'compact')}?${query(input.directory)}`, 'POST', { delivery }));
          const item = record(response.data ?? response);
          if (!text(item.id) || item.sessionID !== input.sessionID || item.type !== undefined && item.type !== 'compaction') throw new Error('Invalid compaction inbox acknowledgement');
          if (!lane.current()) { receipt = { status: 'unknown' }; return false; }
          // Even when A ended during POST B, B's ACK remains B's receipt.
          receipt = { status: 'acknowledged', inboxID: text(item.id) }; barrier = true;
          await persist(receipt);
          if (!lane.current()) { receipt = { status: 'unknown' }; return false; }
          admissionBlocked = false;
          input.admitted({ ...item, type: 'compaction' });
          publish(); return true;
        } catch (failure) {
          receipt = restoring || dispatched || journalStarted ? { status: 'unknown' } : null;
          admissionBlocked = !!receipt;
          if (!receipt) barrier = priorBarrier;
          if (lane.current()) publish();
          throw failure;
        }
      })();
      flight = work;
      try { return await work; } finally { if (flight === work) flight = undefined; }
    },
  };
}
