import { cleanup, effect, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { createDesktopAttachments, type DesktopAttachmentReceipt } from './desktop-attachments';
import { desktopAttachmentRecovery } from './desktop-attachments-recovery';
import { t } from './i18n';
import { id, type Attachment } from './model';
import type { PageOperation } from './page-operations';
import { native } from './runtime';
import type { DesktopAttachmentTarget } from './assistant-attachment-model';

export type DesktopChatAttachmentOptions = {
  /** Stable public authorization + session + directory identity, not a draft text or lease. */
  key: string;
  target?: DesktopAttachmentTarget;
  captureOperation(): PageOperation;
  operation(): PageOperation | null;
  /** Display/lifecycle/readiness/!sending only. Must NOT read composer text/catalogs. */
  current(): boolean;
  read(): Attachment[];
  write(files: Attachment[]): void | boolean;
  native?: (name: string, body: Record<string, unknown>) => Promise<unknown>;
  id?: () => string;
  onError?: (localizedSummary: string) => void;
};

/** Chat owns the draft writer; this adapter owns only the selection operation and its receipt.
 * Instantiate once in that Chat's NSH owner, not per press. System close REQUESTS must not
 * run component cleanup: a rejected/failed native close keeps this owner usable. Actual
 * cleanup fences callbacks and cancels only the exact captured request. Recovery is bounded
 * process-memory metadata, not a new queue, session creator or durable upload journal.
 */
export function createDesktopChatAttachments(options: DesktopChatAttachmentOptions) {
  const call = options.native ?? native;
  const blocked = signal(!!desktopAttachmentRecovery.get(options.key));
  const receipt = signal<DesktopAttachmentReceipt | null>(desktopAttachmentRecovery.get(options.key)?.receipt ?? null);
  const failure = signal(false), checking = signal(false);
  type Entry = { authority: PageOperation; captured: PageOperation; controller: ReturnType<typeof createDesktopAttachments>; retired: boolean; cancelRequested: boolean };
  let entry: Entry | undefined, alive = true, revision = 0, picking = false;
  const current = () => alive && options.current();
  const owns = (captured: Entry) => current() && entry === captured && !captured.retired && options.operation() === captured.authority && captured.captured.current();
  function remember(captured: Entry) {
    const snapshot = captured.controller.receipt();
    if (!snapshot || !captured.captured.scope) return;
    if (!captured.retired && !captured.controller.blocked() && (snapshot.state === 'ready' || captured.cancelRequested && !snapshot.unresolved)) desktopAttachmentRecovery.forget(options.key, snapshot.requestID);
    else desktopAttachmentRecovery.remember(options.key, captured.captured.scope, snapshot);
  }
  function report() {
    if (!current()) return;
    failure.set(true);
    options.onError?.(receipt()?.uncertain ? t('chat.questionDelegate.uncertain') : t('common.unavailable'));
  }
  function present(captured: Entry) {
    remember(captured);
    if (!owns(captured)) return;
    const snapshot = captured.controller.receipt();
    receipt.set(snapshot); blocked.set(captured.controller.blocked());
    failure.set(snapshot?.state === 'unknown' || snapshot?.state === 'failed' || !!snapshot?.orphaned);
  }
  function retire() {
    revision++; picking = false;
    const captured = entry;
    if (captured && !captured.retired) {
      captured.retired = true;
      remember(captured);
      // No async signal writes: this continuation may outlive its NSH owner or a new lease.
      void captured.controller.cancel().finally(() => remember(captured)).catch(() => {});
    }
    if (alive) {
      checking.set(false);
      receipt.set(desktopAttachmentRecovery.get(options.key)?.receipt ?? null);
      blocked.set(!!desktopAttachmentRecovery.get(options.key));
    }
  }
  // Only authority/current are reactive inputs; draft read/write are event-time callbacks.
  effect(() => {
    const authority = options.operation(), available = current();
    untracked(() => { if (entry && !entry.retired && (!available || authority !== entry.authority || !entry.captured.current())) retire(); });
  });
  cleanup(() => { alive = false; retire(); });

  async function attach(kind: 'files' | 'images', operation?: PageOperation): Promise<void> {
    if (!current()) return;
    if (blocked() || picking || checking()) { report(); return; }
    let captured: Entry | undefined;
    const ticket = revision;
    try {
      const authority = options.operation(), lane = operation ?? options.captureOperation();
      if (!authority || !lane.scope || !lane.current() || !current() || options.operation() !== authority) throw new Error('attachment_owner_unavailable');
      if (!entry || entry.retired || entry.authority !== authority) entry = { authority, captured: lane, controller: createDesktopAttachments({ scope: lane.scope, native: call, id: options.id ?? id, target: options.target }), retired: false, cancelRequested: false };
      captured = entry;
      if (!owns(captured) || !desktopAttachmentRecovery.available(options.key)) throw new Error('attachment_receipt_unresolved');
      picking = true; blocked.set(true); failure.set(false);
      const flight = captured.controller.pick(kind, { current: () => !!captured && owns(captured), read: options.read, write: files => !!captured && owns(captured) && options.write(files) });
      const snapshot = captured.controller.receipt();
      if (snapshot) desktopAttachmentRecovery.begin(options.key, lane.scope, snapshot, options.target);
      remember(captured);
      await flight;
      present(captured);
    } catch {
      if (captured) remember(captured);
      if (ticket === revision && (!captured || owns(captured))) report();
    } finally {
      if (captured && ticket === revision && owns(captured)) {
        picking = false;
        receipt.set(captured.controller.receipt());
        blocked.set(captured.controller.blocked() || !!desktopAttachmentRecovery.get(options.key));
      }
    }
  }
  async function readback(cancel = false): Promise<void> {
    if (!current() || checking()) return;
    const authority = options.operation(), ticket = revision;
    const valid = () => current() && options.operation() === authority && revision === ticket && authority?.current() === true;
    if (!valid()) return;
    const captured = entry;
    checking.set(true);
    try {
      if (captured && owns(captured)) {
        if (cancel) { captured.cancelRequested = true; await captured.controller.cancel(); }
        else await captured.controller.reconcile();
        present(captured);
      } else {
        const result = await desktopAttachmentRecovery.inspect(options.key, call, cancel);
        if (!valid()) return;
        const saved = desktopAttachmentRecovery.get(options.key)?.receipt;
        receipt.set(saved ? { ...saved, ...(result ? { state: result.state, orphaned: result.orphaned } : {}) } : null);
        blocked.set(!!saved); failure.set(!!saved);
      }
    } catch { if (valid()) report(); }
    finally { if (valid()) checking.set(false); if (captured) remember(captured); }
  }
  function Recovery() {
    return <If when={blocked() || failure()}><View testID="desktop-chat-attachment-recovery" class="gap-2 py-2">
      <Text class="text-xs text-muted-foreground">{t('chat.chatInput.actions.addAttachment')}</Text>
      <Text role={failure() ? 'alert' : undefined} class={failure() ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>{receipt()?.state === 'unknown' || receipt()?.state === 'retired' && receipt()?.uncertain || receipt()?.orphaned ? t('chat.questionDelegate.uncertain') : failure() ? t('common.unavailable') : t('common.loading')}</Text>
      <View class="flex-row gap-2">
        <Button testID="desktop-chat-attachment-readback" class="min-h-9 px-3 rounded-lg bg-secondary active:bg-accent disabled:opacity-40" disabled={!current() || checking()} onPress={() => { void readback(); }}><Text class="text-foreground">{t('chat.questionDelegate.refreshStatus')}</Text></Button>
        <Button testID="desktop-chat-attachment-cancel" class="min-h-9 px-3 rounded-lg bg-secondary active:bg-accent disabled:opacity-40" disabled={!current() || checking()} onPress={() => { void readback(true); }}><Text class="text-foreground">{t('chat.chatInput.actions.attachCancel')}</Text></Button>
      </View>
    </View></If>;
  }
  return { attach, blocked, Recovery, cancel: () => readback(true), retire, reconcile: () => readback(), receipt };
}
