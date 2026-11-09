import { desktopAttachmentResult, type DesktopAttachmentReceipt } from './desktop-attachments';
import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';
import { desktopAttachmentTarget, type DesktopAttachmentTarget } from './assistant-attachment-model';

type Recovery = Readonly<{ scope: RuntimeScope; receipt: DesktopAttachmentReceipt; target: DesktopAttachmentTarget }>;
const receipts = new Map<string, Recovery>();
const limit = 128;

/** Runtime-only handoff of receipt IDs when a page disappears. No bytes, credentials or
 * draft writer survive here. Reopening can inspect/release metadata using the ORIGINAL lease,
 * never adopt into a new authority. Native Book and this map both die on process restart;
 * there is no Host receipt GET or persistent native upload journal to prove crash recovery.
 */
export const desktopAttachmentRecovery = {
  get: (key: string) => receipts.get(key),
  available: (key: string) => !receipts.has(key) && receipts.size < limit,
  begin(key: string, scope: RuntimeScope, receipt: DesktopAttachmentReceipt, target?: DesktopAttachmentTarget): boolean {
    if (key.length > 16_384 || receipts.has(key) || receipts.size >= limit) return false;
    const captured = runtimeScopeFrom(scope);
    if (!captured) return false;
    receipts.set(key, Object.freeze({ scope: captured, receipt: Object.freeze({ ...receipt }), target: desktopAttachmentTarget(target) }));
    return true;
  },
  remember(key: string, scope: RuntimeScope, receipt: DesktopAttachmentReceipt): boolean {
    const previous = receipts.get(key);
    // Updates never create/resurrect an entry after explicit acknowledgement or a new pick.
    if (!previous || previous.receipt.requestID !== receipt.requestID) return false;
    const captured = runtimeScopeFrom(scope);
    if (!captured) return false;
    receipts.set(key, Object.freeze({ scope: captured, receipt: Object.freeze({ ...receipt }), target: previous.target }));
    return true;
  },
  forget(key: string, requestID: string) {
    if (receipts.get(key)?.receipt.requestID === requestID) receipts.delete(key);
  },
  async inspect(key: string, native: (name: string, body: Record<string, unknown>) => Promise<unknown>, cancel = false) {
    const captured = receipts.get(key);
    if (!captured) return null;
    const args = { requestID: captured.receipt.requestID, expectedHost: captured.scope, ...(captured.target.kind === 'assistant' ? { target: captured.target } : {}) };
    const result = desktopAttachmentResult(await native(cancel ? 'desktop.attachments.cancel' : 'desktop.attachments.status', args), args.requestID, captured.target);
    // This is a detached owner: even a newly confirmed file must not enter a different draft.
    const released = result.attachments.length ? desktopAttachmentResult(await native('desktop.attachments.release', args), args.requestID, captured.target) : result;
    if (released.attachments.length) throw new Error('attachment_invalid_cleanup_receipt');
    const orphaned = Math.min(64, Math.max(0, released.orphaned - captured.receipt.adopted));
    if (cancel && ['retired', 'cancelled'].includes(released.state)) {
      this.forget(key, args.requestID);
    }
    // Unknown remains unknown on an explicit read. A metadata release is NOT evidence that
    // a possibly committed Host file was deleted or that all selected bytes were uploaded.
    return { ...released, orphaned, attachments: [] };
  },
};
