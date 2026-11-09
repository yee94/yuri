import { pickedAttachmentFrom } from './attachments';
import { record, type Attachment, type ChatTarget } from './model';
import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

type Operation = Readonly<{ scope: RuntimeScope | null; current: () => boolean }>;
type Call = (name: string, body: Record<string, unknown>) => Promise<unknown>;
type Adoption = Readonly<{ adopt: (raw: unknown) => boolean; retire: () => void; current?: () => boolean; prepare?: () => Promise<Record<string, unknown>>; recover?: (raw: unknown, revision: number) => boolean; commit?: () => Promise<void> }>;
type Cleanup = { requestId: string; expectedHost: RuntimeScope; assistantID?: string; call: Call; flight?: Promise<boolean>; adopted?: boolean; raw?: unknown; commit?: () => Promise<void>; failure?: unknown };
type AttachmentRetirementFailure = Readonly<{ scope: RuntimeScope; current: () => boolean; retry: () => Promise<void> }>;
const pendingCleanup = new Map<string, Cleanup>();
const requestPrefix = `attachment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
let sequence = 0;

async function cancelExact(cleanup: Cleanup): Promise<boolean> {
  if (cleanup.flight) return cleanup.flight;
  const flight = (async () => {
    try {
      const acceptedContact = cleanup.adopted && !!cleanup.assistantID;
      if (acceptedContact) await cleanup.commit?.();
      await cleanup.call(acceptedContact ? 'runtime.acknowledgeAttachment' : 'runtime.cancelAttachment', { requestId: cleanup.requestId, expectedHost: cleanup.expectedHost,
        ...(cleanup.assistantID ? { assistantID: cleanup.assistantID } : {}), ...(acceptedContact ? { descriptor: cleanup.raw } : {}) });
      if (pendingCleanup.get(cleanup.requestId) === cleanup) pendingCleanup.delete(cleanup.requestId);
      return true;
    } catch (failure) { cleanup.failure = failure; return false; }
  })();
  cleanup.flight = flight;
  try { return await flight; } finally { if (cleanup.flight === flight) cleanup.flight = undefined; }
}

/** Own only native selection/cancellation; descriptor validation belongs to attachments.ts. */
export function createAttachmentPick(input: {
  target: Pick<ChatTarget, 'kind' | 'id'>;
  current: () => boolean;
  call: Call;
  busy: (value: boolean) => void;
  receive?: (attachment: Attachment) => void;
  failed: (phase: 'pick' | 'cancel', failure?: unknown, retirement?: AttachmentRetirementFailure) => void;
}) {
  type Pick = Cleanup & { operation: Operation; started: boolean; retired: boolean; adoption?: Adoption; unknown?: boolean; restoringRevision?: number };
  let active: Pick | undefined, disposed = false;
  const target = Object.freeze({ ...input.target });
  function cancelFailed(cleanup: Cleanup) {
    let completed = false;
    const recovery: AttachmentRetirementFailure = Object.freeze({ scope: Object.freeze({ ...cleanup.expectedHost }),
      current: () => completed || pendingCleanup.get(cleanup.requestId) === cleanup,
      retry: async () => {
        if (pendingCleanup.get(cleanup.requestId) !== cleanup) throw new Error('attachment_retirement_stale');
        if (!await cancelExact(cleanup)) throw cleanup.failure;
        completed = true;
      } });
    input.failed('cancel', cleanup.failure, recovery);
  }
  const current = (pick: Pick) => !disposed && active === pick && !pick.retired && input.current() && pick.operation.current() && (pick.adopted || (pick.adoption?.current?.() ?? true));
  async function cancel() {
    const pick = active;
    if (!pick) return true;
    pick.retired = true; pick.adoption?.retire(); active = undefined; input.busy(false);
    if (!pick.started) return true;
    pendingCleanup.set(pick.requestId, pick);
    const complete = await cancelExact(pick);
    if (!complete) cancelFailed(pick);
    return complete;
  }
  function sync() { if (active && !current(active)) void cancel(); }
  async function finish(token: Pick, raw: unknown): Promise<boolean> {
    if (!current(token)) { if (active === token) await cancel(); return false; }
    if (raw === null) { input.failed('pick', new Error('attachment_upload_unknown')); return false; }
    if (!token.adopted) {
      const attachment = token.adoption ? undefined : pickedAttachmentFrom(raw, { hostID: token.expectedHost.hostID, target });
      if (!current(token)) return false;
      if (token.adoption ? !(token.restoringRevision === undefined ? token.adoption.adopt(raw) : token.adoption.recover?.(raw, token.restoringRevision)) : !input.receive) { await cancel(); return false; }
      if (!token.adoption) input.receive!(attachment!);
      token.adopted = true; token.raw = raw;
    }
    await token.commit?.();
    if (target.kind === 'assistant') await input.call('runtime.acknowledgeAttachment', { requestId: token.requestId, expectedHost: token.expectedHost, descriptor: token.raw });
    token.adoption?.retire();
    if (active === token) { active = undefined; input.busy(false); }
    return true;
  }
  async function reconcile() {
    const token = active;
    if (!token || !token.unknown) return false;
    if (!current(token)) { if (active === token) await cancel(); return false; }
    input.busy(true);
    try {
      const raw = token.adopted ? token.raw : await input.call('runtime.reconcileAttachment', { requestId: token.requestId, expectedHost: token.expectedHost });
      return await finish(token, raw);
    } catch (failure) {
      if (current(token)) input.failed('pick', failure);
      if (active === token && (!current(token) || /attachment_upload_retired|attachment_contact_generation_conflict/.test(String(failure)))) await cancel();
      return false;
    }
    finally { if (active === token) input.busy(false); }
  }
  async function pick(operation: Operation, choose: 'files' | 'images' | (() => Promise<'files' | 'images' | null>), selection?: Adoption) {
    let retired = false;
    const retireSelection = selection?.retire.bind(selection);
    const adoption = selection && Object.freeze({ adopt: selection.adopt.bind(selection), current: selection.current?.bind(selection), prepare: selection.prepare?.bind(selection), recover: selection.recover?.bind(selection), commit: selection.commit?.bind(selection), retire: () => { if (!retired) { retired = true; retireSelection!(); } } });
    if (active?.unknown) { adoption?.retire(); return reconcile(); }
    if (disposed || active || !input.current() || !operation.current()) { adoption?.retire(); return false; }
    const expectedHost = runtimeScopeFrom(operation.scope);
    if (!expectedHost || target.kind === 'assistant' && !target.id || sequence === Number.MAX_SAFE_INTEGER) {
      adoption?.retire();
      input.failed('pick');
      return false;
    }
    const token: Pick = { requestId: `${requestPrefix}_${++sequence}`, expectedHost, operation, call: input.call, started: false, retired: false, adoption, commit: adoption?.commit,
      ...(target.kind === 'assistant' ? { assistantID: target.id } : {}) };
    active = token; input.busy(true);
    try {
      for (const cleanup of [...pendingCleanup.values()]) {
        if (!await cancelExact(cleanup)) {
          cancelFailed(cleanup);
          if (cleanup.expectedHost.hostID === expectedHost.hostID && cleanup.assistantID === token.assistantID) return false;
        }
        if (!current(token)) return false;
      }
      const context = target.kind === 'assistant' && adoption?.prepare ? await adoption.prepare() : {};
      if (!current(token)) { if (input.current() && operation.current()) input.failed('pick', new Error('attachment_capture_stale')); return false; }
      if (target.kind === 'assistant' && adoption?.prepare) {
        const pending = await input.call('runtime.pendingAttachments', { expectedHost, assistantID: target.id, ...context });
        if (!Array.isArray(pending) || pending.length > 64) throw new Error('attachment_receipt_storage_failed');
        if (!current(token)) return false;
        if (pending.length) {
          const saved = record(pending[0]);
          if (typeof saved.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(saved.requestId) || saved.assistantID !== target.id || !Number.isSafeInteger(saved.generation) || Number(saved.generation) < 0 || !Number.isSafeInteger(saved.draftRevision) || Number(saved.draftRevision) < 0 || !['prepared', 'unknown', 'retiring', 'retired'].includes(String(saved.phase))) throw new Error('attachment_receipt_storage_failed');
          token.requestId = saved.requestId; token.started = true; token.unknown = true; token.restoringRevision = Number(saved.draftRevision);
          if (saved.cleanupHost !== undefined) {
            const cleanupHost = runtimeScopeFrom(saved.cleanupHost);
            if (!cleanupHost || cleanupHost.hostID !== expectedHost.hostID || saved.phase !== 'retiring') throw new Error('attachment_receipt_storage_failed');
            token.expectedHost = cleanupHost;
          }
          if (saved.generation !== context.contactGeneration || saved.phase === 'retiring' || saved.phase === 'retired') { await cancel(); return false; }
          return await finish(token, await input.call('runtime.reconcileAttachment', { requestId: token.requestId, expectedHost }));
        }
      }
      if (pendingCleanup.size >= 64) throw new Error('attachment_upload_pending_capacity');
      const kind = typeof choose === 'function' ? await choose() : choose;
      if (!kind || !current(token)) return false;
      token.started = true;
      const raw = await input.call('runtime.pickAttachment', { kind, requestId: token.requestId, expectedHost,
        ...(target.kind === 'assistant' ? { assistantID: target.id, ...context } : {}) });
      if (!current(token)) {
        pendingCleanup.set(token.requestId, token);
        if (!await cancelExact(token)) cancelFailed(token);
        return false;
      }
      if (raw === null) return false;
      return await finish(token, raw);
    } catch (failure) {
      if (current(token)) {
        token.unknown = target.kind === 'assistant' && token.started;
        input.failed('pick', failure);
        if (String(failure).includes('attachment_capture_not_dispatched')) { token.started = false; token.unknown = false; }
        if (/attachment_upload_retired|attachment_contact_generation_conflict/.test(String(failure))) { token.unknown = false; if (active === token) await cancel(); }
        if (String(failure).includes('attachment_upload_not_dispatched')) {
          token.unknown = false;
          // Native persisted prepared metadata may exist, but this selection
          // provably sent no PUT. Exact cleanup remains explicit and retryable.
          if (active === token) await cancel();
        }
      } else if (active === token && token.started) await cancel();
      return false;
    } finally {
      if (active === token) input.busy(false);
      if (!token.unknown) { adoption?.retire(); if (active === token) active = undefined; }
    }
  }
  function dispose() { disposed = true; void cancel(); }
  return { pick, cancel, sync, dispose, reconcile, pending: () => !!active?.unknown };
}
