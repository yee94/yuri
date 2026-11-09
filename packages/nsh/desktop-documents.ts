import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

export const DESKTOP_MARKDOWN_LIMIT = 8 * 1024 * 1024;
export type DesktopMarkdown = Readonly<{ filename: string; content: string }>;
export type DesktopDocumentReceipt = { requestID: string; state: 'pending' | 'saved' | 'cancelled' | 'error'; error?: string };
export type DesktopDocumentState = { phase: 'idle' | 'saving' | 'pending' | 'saved' | 'cancelled' | 'error' | 'unknown'; error?: string };
type Native = (method: string, payload: Record<string, unknown>) => Promise<unknown>;

/** Counts bounded UTF-8 without allocating a second copy of the Markdown. */
export function desktopDocumentBytes(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('documents_invalid_utf8');
      count += 4;
    } else {
      if (code >= 0xdc00 && code <= 0xdfff || code === 0) throw new Error('documents_invalid_utf8');
      count += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    if (count > DESKTOP_MARKDOWN_LIMIT) throw new Error('documents_content_limit');
  }
  return count;
}
export function desktopDocumentReceipt(value: unknown, requestID: string): DesktopDocumentReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('documents_invalid_receipt');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['requestID', 'state', 'error'].includes(key)) || row.requestID !== requestID
    || !['pending', 'saved', 'cancelled', 'error'].includes(String(row.state))
    || row.state === 'error' && (typeof row.error !== 'string' || !/^documents_[a-z_]{1,80}$/.test(row.error))
    || row.state !== 'error' && row.error !== undefined) throw new Error('documents_invalid_receipt');
  return { requestID, state: row.state as DesktopDocumentReceipt['state'], ...(typeof row.error === 'string' ? { error: row.error } : {}) };
}

/** One verified export/one owning scope. Unknown ACK only reads its exact receipt;
 * never resubmits content or asks the OS to select a different target. No path crosses JS. */
export function createDesktopDocuments(options: {
  scope: RuntimeScope; document: DesktopMarkdown; native: Native; id: () => string;
  current: () => boolean; changed: (state: DesktopDocumentState) => void;
}) {
  const expectedHost = runtimeScopeFrom(options.scope);
  if (!expectedHost) throw new Error('scope_required');
  const ownerID = options.id();
  const document = { ...options.document };
  let alive = true, running = false;
  let operation: { requestID: string; unresolved: boolean } | undefined;
  let state: DesktopDocumentState = { phase: 'idle' };
  const current = () => alive && options.current();
  const update = (next: DesktopDocumentState) => { state = next; if (current()) options.changed(next); };
  const control = () => ({ requestID: operation!.requestID, ownerID, expectedHost });
  function adopt(value: unknown) {
    const result = desktopDocumentReceipt(value, operation!.requestID);
    if (!current()) return;
    operation!.unresolved = result.state === 'pending' || result.error === 'documents_write_unknown';
    update({ phase: result.error === 'documents_write_unknown' ? 'unknown' : result.state, ...(result.error ? { error: result.error } : {}) });
    return result;
  }
  async function status() {
    if (!current() || !operation?.unresolved || running) return;
    running = true;
    try { return adopt(await options.native('desktop.documents.status', control())); }
    catch { if (current()) update({ phase: 'unknown', error: 'documents_status_unavailable' }); }
    finally { running = false; }
  }
  return {
    snapshot: () => state,
    async save() {
      if (!current() || running || state.phase === 'saved') return;
      if (operation?.unresolved) return status();
      try {
        if (!document.filename || desktopDocumentBytes(document.filename) > 240 || !document.filename.endsWith('.md') || document.filename.startsWith('.') || /[\x00-\x1f\x7f/\\:*?"<>|]/.test(document.filename)) throw new Error('documents_invalid_metadata');
        if (!desktopDocumentBytes(document.content)) throw new Error('documents_content_limit');
      } catch { update({ phase: 'error', error: 'documents_invalid_export' }); return; }
      running = true; operation = { requestID: options.id(), unresolved: true }; update({ phase: 'saving' });
      try {
        return adopt(await options.native('desktop.documents.save', { ...control(), filename: document.filename, content: document.content, format: 'markdown' }));
      } catch { if (current()) update({ phase: 'unknown', error: 'documents_result_unconfirmed' }); }
      finally { running = false; }
    },
    status,
    dispose() {
      if (!alive) return;
      alive = false;
      if (operation?.unresolved) void options.native('desktop.documents.cancel', control()).catch(() => {});
    },
  };
}
