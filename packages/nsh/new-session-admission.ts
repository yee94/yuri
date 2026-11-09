import { sendNewSessionHandoff, type NativeNewSessionPageHandoff } from './new-session';
import type { PageOperation } from './page-operations';
import { effect, untracked } from 'nsh';

type Chat = Parameters<typeof sendNewSessionHandoff>[0];
export type NewSessionAdmissionState = 'idle' | 'sending' | 'unconfirmed' | 'error' | 'complete';

/** A navigation owner admits once; source cleanup can be retried without replaying admission. */
export function createNewSessionAdmission(input: {
  chat: Chat;
  handoff: NativeNewSessionPageHandoff;
  current: () => boolean;
  changed: (state: NewSessionAdmissionState) => void;
  send?: typeof sendNewSessionHandoff;
  operation?: () => PageOperation | null;
}) {
  const source = input.handoff.owner;
  let assigned = input.operation ? input.operation() : source.operation();
  let flight: { operation: PageOperation; promise: Promise<void> } | undefined, closeFlight: Promise<void> | undefined;
  let admitted = false, sourceCleared = false, completed = false, disposed = false, replaced = false;
  let hasAssigned = !!assigned;
  function replaceOperation(next: PageOperation | null) {
    if (disposed || completed) return false;
    if (next === assigned) return next?.current() === true;
    assigned = null;
    source.replaceOperation(null);
    replaced ||= hasAssigned;
    if (!next || !source.replaceOperation(next)) { input.changed('unconfirmed'); return false; }
    assigned = next;
    hasAssigned = true;
    input.changed('unconfirmed');
    return true;
  }
  source.replaceOperation(assigned);
  if (input.operation) effect(() => { const next = input.operation!(); untracked(() => replaceOperation(next)); });
  function run(reconcileOnly = false, captured = assigned): Promise<void> {
    if (flight) return flight.promise;
    if (disposed || completed || !input.current() || !captured?.current() || captured !== assigned) return Promise.resolve();
    const current = () => !completed && input.current() && captured === assigned && captured.current()
      && (!input.operation || input.operation() === captured) && source.ownedScope();
    const operation = source.captureOperation(false);
    input.changed('sending');
    const work = (async () => {
      try {
        await source.ready;
        await input.chat.draftReady;
        if (!current()) return;
        admitted ||= source.admission() === 'acknowledged';
        if (!admitted) {
          const pending = input.chat.pendingSend(), phase = source.admission();
          // Only the exact destination's durable not-dispatched journal can
          // resume preparation. A source receipt alone never proves no dispatch.
          const preparation = phase === 'preparing' && pending?.id === input.handoff.receipt.inputID
            && pending.uncertain === false && input.chat.draftStatus() === 'ready';
          const readOnly = reconcileOnly || pending?.uncertain === true || input.chat.draftStatus() !== 'ready'
            || (replaced || phase !== undefined) && !preparation;
          if (!readOnly) await source.noteAdmission(input.handoff.receipt, 'preparing', operation);
          if (!current()) { if (!disposed && captured === assigned && source.ownedScope()) input.changed('unconfirmed'); return; }
          const result = await (input.send ?? sendNewSessionHandoff)(input.chat, input.handoff.receipt, {}, operation.request,
            { operation, source, reconcileOnly: readOnly });
          if (!current()) { if (!disposed && captured === assigned && source.ownedScope()) input.changed('unconfirmed'); return; }
          if (!result) {
            if (input.chat.pendingSend()?.uncertain && source.admission() === 'preparing') await source.noteAdmission(input.handoff.receipt, 'unknown', operation);
            if (!disposed) input.changed('unconfirmed'); return;
          }
          await source.noteAdmission(input.handoff.receipt, 'acknowledged', operation);
          if (!current()) return;
          admitted = true;
        }
        if (!sourceCleared) {
          await source.complete(input.handoff.receipt);
          sourceCleared = true;
          if (!current()) return;
        }
        await input.handoff.release();
        completed = true;
        if (!disposed && captured === assigned) input.changed('complete');
      } catch {
        if (!disposed && current()) input.changed('error');
      }
    })();
    const token = { operation: captured, promise: work };
    flight = token;
    void work.finally(() => { if (flight === token) flight = undefined; });
    return work;
  }
  async function reconcile() {
    const captured = assigned, pending = flight;
    if (pending) await pending.promise;
    if (captured !== assigned || !captured?.current()) return;
    await run(true, captured);
  }
  function close() {
    disposed = true;
    closeFlight ??= (flight?.promise ?? Promise.resolve()).then(() => input.handoff.release());
    return closeFlight;
  }
  return { run: () => run(), reconcile, replaceOperation, close };
}
