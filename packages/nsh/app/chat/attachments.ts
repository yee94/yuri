import { signal, type Signal } from 'nsh';
import { t } from '../core/i18n';
import { currentScope, native, record, textOf } from '../core/host';
import type { Conversation } from './store';

/** One uploaded picker result waiting in the composer (`uri` is the Host's `file://` path). */
export type DraftAttachment = { requestId: string; uri: string; name: string; mime: string; size?: number };

export type AttachmentState = {
  items: Signal<DraftAttachment[]>;
  busy: Signal<boolean>;
  error: Signal<string>;
};

const states = new Map<Conversation, AttachmentState>();

export function attachmentsFor(conversation: Conversation): AttachmentState {
  const existing = states.get(conversation);
  if (existing) return existing;
  const created: AttachmentState = { items: signal<DraftAttachment[]>([]), busy: signal(false), error: signal('') };
  states.set(conversation, created);
  return created;
}

let sequence = 0;
const nextRequestID = () => `attachment_${Date.now().toString(36)}_${(sequence += 1)}`;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function descriptorOf(value: unknown): Omit<DraftAttachment, 'requestId'> | null {
  const row = record(value);
  const uri = textOf(row.uri);
  if (!uri) return null;
  const name = textOf(row.name) || uri.split('/').pop() || 'file';
  return {
    uri,
    name,
    mime: textOf(row.mime) || 'application/octet-stream',
    ...(typeof row.size === 'number' && Number.isFinite(row.size) ? { size: row.size } : {}),
  };
}

/** The Host's picker (`runtime.pickAttachment`); a cancelled pick adds nothing. */
export async function pickAttachment(conversation: Conversation, kind: 'images' | 'files' = 'files'): Promise<void> {
  const state = attachmentsFor(conversation);
  if (state.busy()) return;
  const expectedHost = currentScope();
  if (!expectedHost) {
    state.error.set(t('common.unavailable'));
    return;
  }
  state.busy.set(true);
  state.error.set('');
  const requestId = nextRequestID();
  try {
    const raw = await native<unknown>('runtime.pickAttachment', { kind, requestId, expectedHost });
    if (raw === null || raw === undefined) return;
    const descriptor = descriptorOf(raw);
    if (!descriptor) throw new Error(t('chat.fileAttachment.toast.attachFailed'));
    state.items.set([...state.items(), { requestId, ...descriptor }]);
  } catch (error) {
    void native('runtime.cancelAttachment', { requestId, expectedHost }).catch(() => undefined);
    state.error.set(errorText(error));
  } finally {
    state.busy.set(false);
  }
}

/** Removes one chip; a Host-side cleanup failure keeps it for another try. */
export async function removeAttachment(conversation: Conversation, requestId: string): Promise<void> {
  const state = attachmentsFor(conversation);
  const item = state.items().find((entry) => entry.requestId === requestId);
  if (!item) return;
  const expectedHost = currentScope();
  try {
    if (expectedHost) await native('runtime.cancelAttachment', { requestId, expectedHost });
    state.items.set(state.items().filter((entry) => entry.requestId !== requestId));
    state.error.set('');
  } catch (error) {
    state.error.set(errorText(error));
  }
}

/** Startup reconcile: a pick that was interrupted by a relaunch becomes a chip again. */
export async function reconcileAttachments(conversation: Conversation): Promise<void> {
  const state = attachmentsFor(conversation);
  const expectedHost = currentScope();
  if (!expectedHost || state.busy()) return;
  try {
    const pending = await native<unknown>('runtime.pendingAttachments', { expectedHost });
    if (!Array.isArray(pending) || pending.length === 0) return;
    for (const entry of pending) {
      const requestId = textOf(record(entry).requestId);
      if (!requestId || state.items().some((item) => item.requestId === requestId)) continue;
      const raw = await native<unknown>('runtime.reconcileAttachment', { requestId, expectedHost });
      const descriptor = raw === null || raw === undefined ? null : descriptorOf(raw);
      if (!descriptor) {
        void native('runtime.cancelAttachment', { requestId, expectedHost }).catch(() => undefined);
        continue;
      }
      state.items.set([...state.items(), { requestId, ...descriptor }]);
    }
  } catch {
    // Unresolved receipts stay pending Host-side; the next attach retries them.
  }
}

/** After a successful send the Host may drop the temporary upload. */
export async function acknowledgeAttachments(conversation: Conversation): Promise<void> {
  const state = attachmentsFor(conversation);
  const expectedHost = currentScope();
  const items = state.items();
  if (items.length === 0) return;
  state.items.set([]);
  if (!expectedHost) return;
  for (const item of items) {
    await native('runtime.acknowledgeAttachment', {
      requestId: item.requestId,
      expectedHost,
      descriptor: { uri: item.uri, name: item.name, mime: item.mime },
    }).catch(() => undefined);
  }
}

export function clearAttachments(conversation: Conversation): void {
  const state = attachmentsFor(conversation);
  state.items.set([]);
  state.error.set('');
}

/** The prompt `files` of the picked attachments. */
export function attachmentFiles(conversation: Conversation): { uri: string; name: string }[] {
  return attachmentsFor(conversation).items().map((item) => ({ uri: item.uri, name: item.name }));
}
