import { cleanup, signal } from 'nsh';
import { AlertDialog } from 'nsh/base';
import { createPageOperations, type PageOperation } from './page-operations';
import { refresh } from './state';
import { record } from './model';
import { t } from './i18n';

export type TaskEditorLeave = (afterLeave?: () => void) => Promise<void>;
export type TaskEditorWindowGuard = { requestClose: () => Promise<boolean>; canClose: () => boolean };
export type TaskEditorWrite = { path: string; method: string; body?: unknown };

/** One retained desktop editor. Modal admission is independent of its Host lane. */
export function createTaskEditorOwner(active: () => boolean, interactive: () => boolean, onDone: () => void) {
  const operations = createPageOperations(active);
  const busy = signal(false), error = signal(''), notice = signal(''), committed = signal(false), unknown = signal(false);
  const receipt = signal<TaskEditorWrite | null>(null);
  let alive = true;
  let performing: PageOperation | null = null;
  let editRevision = 0;
  const invalidateCloseGrant = () => { editRevision++; };
  cleanup(() => { alive = false; });
  const current = () => alive && operations.current() && (!performing || performing.current());
  const admitted = () => current() && interactive();
  function assertCurrent() { if (!current()) throw new Error(t('mobile.notifications.identity')); }
  const request = async (path: string, method = 'GET', body?: unknown) => {
    assertCurrent();
    const lane = performing ?? operations.capture(), write = method !== 'GET';
    if (write) {
      if (!admitted() || receipt()) throw new Error(t('common.unavailable'));
      receipt.set({ path, method, body });
    }
    try {
      const result = await lane.request(path, method, body);
      if (!alive || !lane.current()) throw new Error('page_operation_stale');
      if (write && (record(result).ok === false || record(result).failed === true)) receipt.set(null);
      return result;
    } catch (failure) {
      // A definite refusal may be retried. Transport/5xx/malformed ACKs remain
      // unknown; an ordinary read never authorizes repeating the mutation.
      const status = record(failure).status;
      if (alive && write && typeof status === 'number' && status >= 400 && status < 500 && status !== 408) receipt.set(null);
      throw failure;
    }
  };
  function acknowledge() { assertCurrent(); receipt.set(null); unknown.set(false); }
  async function perform(work: () => Promise<void>, allowCommitted = false) {
    if (!admitted() || busy() || !allowCommitted && (committed() || unknown())) return;
    invalidateCloseGrant();
    busy.set(true); error.set('');
    const lane = operations.capture();
    performing = lane;
    try { await work(); }
    catch (failure) { if (alive && lane.current()) error.set(failure instanceof Error ? failure.message : String(failure)); }
    finally { performing = null; if (alive) { if (receipt()) unknown.set(true); busy.set(false); } }
  }
  async function finish() {
    assertCurrent();
    if (!committed() || unknown()) return;
    const lane = operations.capture();
    await refresh();
    if (alive && lane.current()) onDone();
  }
  function navigation(snapshot: () => unknown, onClose: () => void) {
    let pristine = JSON.stringify(snapshot());
    const confirming = signal(false);
    const dirty = () => !committed() && JSON.stringify(snapshot()) !== pristine;
    const blocked = () => busy() || unknown() || confirming() || dirty();
    const askDiscard = () => AlertDialog.show({ title: t('filesView.unsaved.title'), description: t('sessions.scheduledTasks.workspace.confirm.discardChanges'), actions: [
      { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
      { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' },
    ] });
    let closeGrant: { snapshot: string; revision: number; lane: PageOperation } | null = null;
    const canClose = () => current() && !busy() && !unknown() && !confirming() && (!dirty() || !!closeGrant && closeGrant.lane.current() && closeGrant.revision === editRevision && closeGrant.snapshot === JSON.stringify(snapshot()));
    async function requestClose() {
      if (!current() || busy() || unknown() || confirming()) return false;
      if (canClose()) return true;
      const lane = operations.capture(), captured = JSON.stringify(snapshot()), revision = editRevision;
      confirming.set(true);
      try {
        const answer = await askDiscard();
        if (!alive || !lane.current() || busy() || unknown() || answer.action !== 'discard' || revision !== editRevision || captured !== JSON.stringify(snapshot())) return false;
        closeGrant = { snapshot: captured, revision, lane }; return true;
      } finally { if (alive) confirming.set(false); }
    }
    const cancel: TaskEditorLeave = async (afterLeave = onClose) => {
      if (!admitted() || busy() || unknown() || confirming()) return;
      if (!dirty()) { afterLeave(); return; }
      const lane = operations.capture(), captured = JSON.stringify(snapshot()), revision = editRevision; confirming.set(true);
      try {
        const result = await askDiscard();
        if (alive && lane.current() && interactive() && !busy() && !unknown() && revision === editRevision && captured === JSON.stringify(snapshot()) && result.action === 'discard') afterLeave();
      } finally { if (alive) confirming.set(false); }
    };
    return { dirty, blocked, cancel, back: () => { void cancel(); }, pristine: () => { pristine = JSON.stringify(snapshot()); }, windowGuard: { requestClose, canClose } satisfies TaskEditorWindowGuard };
  }
  return { request, busy, error, notice, committed, unknown, receipt, current, admitted, assertCurrent, perform, finish, acknowledge, navigation, invalidateCloseGrant };
}
