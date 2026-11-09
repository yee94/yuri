import { desktopPanelFilePath, type DesktopPanelScope } from './desktop-panel-model';
import { assistantAttachmentDescriptor, type AssistantAttachmentDescriptor } from './assistant-attachment-model';
import type { RuntimeScope } from './runtime-scope';

type NativeCall = <T>(name: string, body: Record<string, unknown>) => Promise<T>;
type DownloadState = Readonly<{
  available: boolean; phase: 'idle' | 'choosing' | 'saving' | 'checking' | 'unknown' | 'saved' | 'error';
  detail: string; path: string; received: number; total: number | null; resumable: boolean;
}>;
type Clock = { after: (callback: () => void) => () => void };
const clock: Clock = { after(callback) { const timer = setTimeout(callback, 250); return () => clearTimeout(timer); } };
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
type DownloadSource = Readonly<{ kind: 'file'; directory: string } | { kind: 'assistantAttachment'; attachment: AssistantAttachmentDescriptor }>;

export function createDesktopFileDownload(scope: DesktopPanelScope, native: NativeCall, current: () => boolean, notify: () => void, scheduler: Clock = clock) {
  const download = createDownload(scope.host, { kind: 'file', directory: scope.directory }, native, current, notify, scheduler);
  return { ...download, save: (path: string) => download.save(path) };
}

export function createDesktopAssistantAttachmentDownload(host: RuntimeScope, attachment: AssistantAttachmentDescriptor, native: NativeCall, current: () => boolean, notify: () => void, scheduler: Clock = clock) {
  const download = createDownload(host, { kind: 'assistantAttachment', attachment: assistantAttachmentDescriptor(attachment) }, native, current, notify, scheduler);
  return { ...download, save: () => download.save() };
}

/** Native owns bytes, authentication, system destination and write receipts.
 * Unknown save is status-only; never another save or JS filesystem/fetch fallback.
 */
function createDownload(scope: RuntimeScope, source: DownloadSource, native: NativeCall, current: () => boolean, notify: () => void, scheduler: Clock) {
  const host = Object.freeze({ ...scope });
  const attachment = source.kind === 'assistantAttachment' ? source.attachment : undefined;
  const attachmentKeys = attachment ? Object.keys(attachment) as Array<keyof AssistantAttachmentDescriptor> : [];
  const receiptKeys = ['requestID', 'windowID', 'state', 'error', 'received', 'total', 'resumable', ...(attachment ? ['source', 'attachment'] : [])];
  let state: DownloadState = { available: false, phase: 'idle', detail: '', path: '', received: 0, total: null, resumable: false };
  let alive = true, probed = false, probing = false, serial = 0, epoch = 0, windowID = '', maxBytes = 0, requestID = '', flight = false;
  let timer: (() => void) | undefined;
  const ownerID = 'files_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
  const args = () => ({ ownerID, requestID, windowID, expectedHost: { ...host } });
  const update = (patch: Partial<DownloadState>) => {
    if (!alive || !current()) return;
    const next = { ...state, ...patch };
    if ((Object.keys(next) as Array<keyof DownloadState>).every(key => next[key] === state[key])) return;
    state = next; notify();
  };
  const unschedule = () => { timer?.(); timer = undefined; };
  const live = (generation: number, id: string) => alive && current() && generation === epoch && id === requestID;
  function schedule() {
    unschedule();
    if (alive && current() && ['saving', 'choosing', 'checking'].includes(state.phase)) timer = scheduler.after(() => { timer = undefined; void inspect(); });
  }
  function apply(value: unknown, generation: number, id: string) {
    if (!live(generation, id)) return false;
    const v = object(value);
    if (v.requestID !== id || v.windowID !== windowID || !['selecting', 'pending', 'verifying', 'saved', 'cancelled', 'error', 'unknown'].includes(String(v.state))
      || Object.keys(v).length !== receiptKeys.length || Object.keys(v).some(key => !receiptKeys.includes(key))
      || v.error !== null && typeof v.error !== 'string' || !integer(v.received) || v.received > maxBytes
      || v.total !== null && (!integer(v.total) || v.total > maxBytes || v.total < v.received)
      || typeof v.resumable !== 'boolean' || v.resumable && v.state !== 'error'
      || v.state === 'saved' && v.total !== null && v.received !== v.total
      || state.total !== null && v.total !== state.total || v.received < state.received) {
      throw new Error('desktop_download_invalid_receipt');
    }
    if (attachment) {
      const receivedAttachment = object(v.attachment);
      if (v.source !== 'assistantAttachment' || Object.keys(receivedAttachment).length !== attachmentKeys.length
        || attachmentKeys.some(key => !Object.prototype.hasOwnProperty.call(receivedAttachment, key) || receivedAttachment[key] !== attachment[key])
        || v.state === 'saved' && (v.received !== attachment.size || v.total !== attachment.size)) {
        throw new Error('desktop_download_invalid_receipt');
      }
    }
    update({ phase: v.state === 'verifying' ? 'checking' : v.state === 'selecting' ? 'choosing' : v.state === 'pending' ? 'saving' : v.state === 'cancelled' ? 'idle' : v.state as 'saved' | 'error' | 'unknown',
      detail: typeof v.error === 'string' ? v.error : '', received: v.received, total: v.total as number | null, resumable: v.resumable });
    return v.state === 'saved';
  }
  async function call(method: 'save' | 'status' | 'cancel' | 'resume', body: Record<string, unknown> = args()) {
    const id = requestID, generation = epoch;
    flight = true;
    try { return apply(await native('desktop.files.download.' + method, body), generation, id); }
    catch {
      if (live(generation, id)) update({ phase: 'unknown', resumable: false, detail: 'desktop_download_receipt_unconfirmed' });
      return false;
    } finally { if (generation === epoch) { flight = false; schedule(); } }
  }
  async function inspect() {
    if (!alive || !current() || flight || !requestID || !['unknown', 'saving', 'choosing', 'checking'].includes(state.phase)) return false;
    return call('status');
  }
  return {
    state: () => state,
    async probe() {
      if (!alive || !current()) return;
      if (probed) { if (['saving', 'choosing', 'checking'].includes(state.phase)) void inspect(); return; }
      if (probing) return;
      probing = true;
      try {
        const v = object(await native('desktop.files.download.capabilities', attachment ? { source: 'assistantAttachment' } : {}));
        const support = object(v.assistantAttachment);
        if (alive && current() && v.version === 2 && v.save === true && typeof v.windowID === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v.windowID) && integer(v.maxBytes) && v.maxBytes > 0
          && Object.keys(v).every(key => ['version', 'save', 'windowID', 'maxBytes', ...(attachment ? ['assistantAttachment'] : [])].includes(key))
          && (!attachment || v.maxBytes === 2 ** 40 && support.supported === true && support.maxBytes === 25 * 1024 * 1024 && support.integrity === 'sha256'
            && Object.keys(v).length === 5 && Object.keys(support).length === 3
            && Object.keys(support).every(key => ['supported', 'maxBytes', 'integrity'].includes(key)))) {
          windowID = v.windowID; maxBytes = attachment ? attachment.size : v.maxBytes; update({ available: true });
          probed = true;
        }
      } catch { /* Missing native capability is explicit unavailability, never a client-fs fallback. */ }
      finally { probing = false; }
    },
    async save(path?: string) {
      if (!alive || !current() || flight || !state.available || !['idle', 'saved'].includes(state.phase)) return false;
      const label = source.kind === 'file' ? desktopPanelFilePath(source.directory, path ?? '') : attachment?.filename ?? 'attachment';
      epoch++; requestID = ownerID + '_' + (++serial).toString(36);
      update({ phase: 'choosing', detail: '', path: label, received: 0, total: null, resumable: false });
      return call('save', { ...args(), ...(source.kind === 'file' ? { directory: source.directory, path: label } : { source: 'assistantAttachment', attachment }) });
    },
    inspect,
    async resume() {
      if (!alive || !current() || flight || state.phase !== 'error' || !state.resumable) return false;
      unschedule(); epoch++; update({ phase: 'saving', detail: '', resumable: false });
      return call('resume');
    },
    async cancel() {
      if (!alive || !requestID || !current()) return false;
      // Cancellation fences an older pending save/status ACK even if it arrives
      // after the cancel receipt. The native receipt remains the authority.
      unschedule(); epoch++; flight = false;
      return call('cancel');
    },
    dispose() {
      if (!alive) return;
      alive = false; epoch++; unschedule();
      if (requestID && state.phase !== 'saved' && state.phase !== 'idle') void native('desktop.files.download.cancel', args()).catch(() => {});
    },
  };
}
