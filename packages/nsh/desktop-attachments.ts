import type { Attachment } from './model';
import { assistantAttachmentDescriptor, assistantAttachmentURI, desktopAttachmentTarget, type AssistantAttachmentDescriptor, type DesktopAttachmentTarget } from './assistant-attachment-model';
import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

export type DesktopAttachment = Attachment & { uri: string; contact?: AssistantAttachmentDescriptor };
export type DesktopAttachmentResult = {
  requestID: string;
  state: 'ready' | 'cancelled' | 'failed' | 'unknown' | 'retired' | 'pending';
  attachments: DesktopAttachment[];
  error?: string;
  /** Successful temporary Host files have no scoped delete API. Never delete arbitrary Host paths. */
  orphaned: number;
};
type Native = (name: string, body: Record<string, unknown>) => Promise<unknown>;
type DraftOwner = { current(): boolean; read(): Attachment[]; write(files: Attachment[]): void | boolean };
const states = new Set(['ready', 'cancelled', 'failed', 'unknown', 'retired', 'pending']);
const wireLimit = 64 * 1024;
const identity = (file: DesktopAttachment) => file.uri;
const signature = (file: DesktopAttachment) => JSON.stringify([file.name, file.mime, file.contact]);
const terminal = (state: DesktopAttachmentResult['state']) => state === 'ready' || state === 'cancelled' || state === 'retired';
function boundedMetadata(files: Attachment[]) {
  if (files.length > 64 || new TextEncoder().encode(JSON.stringify(files)).length > wireLimit) throw new Error('attachment_receipt_limit');
}
export type DesktopAttachmentReceipt = { requestID: string; state: DesktopAttachmentResult['state']; unresolved: boolean; uncertain: boolean; cancelled: boolean; adopted: number; orphaned: number };

export function desktopAttachmentResult(value: unknown, requestID: string, expectedTarget?: DesktopAttachmentTarget): DesktopAttachmentResult {
  const target = desktopAttachmentTarget(expectedTarget);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('attachment_invalid_receipt');
  const result = value as Record<string, unknown>;
  if (result.requestID !== requestID || typeof result.state !== 'string' || !states.has(result.state)
    || !Array.isArray(result.attachments) || result.attachments.length > 64
    || !Number.isSafeInteger(result.orphaned) || Number(result.orphaned) < 0 || Number(result.orphaned) > 64
    || result.error !== undefined && (typeof result.error !== 'string' || !/^[a-z_]{1,100}$/.test(result.error))) throw new Error('attachment_invalid_receipt');
  if (target.kind === 'assistant') {
    const receivedTarget = desktopAttachmentTarget(result.target);
    if (receivedTarget.kind !== 'assistant' || receivedTarget.assistantID !== target.assistantID) throw new Error('attachment_invalid_target');
  } else if (result.target !== undefined && desktopAttachmentTarget(result.target).kind !== 'session') throw new Error('attachment_invalid_target');
  const attachments = result.attachments.map((value: unknown): DesktopAttachment => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('attachment_invalid_receipt');
    const file = value as Record<string, unknown>;
    if (typeof file.uri !== 'string' || file.uri.length > 16_384
      || typeof file.name !== 'string' || !file.name || file.name.length > 1024 || /[\x00-\x1f\x7f/\\]/.test(file.name)
      || typeof file.mime !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/.test(file.mime)) throw new Error('attachment_invalid_receipt');
    if (target.kind === 'assistant') {
      const contact = assistantAttachmentDescriptor(file.contact, target.assistantID);
      if (file.uri !== assistantAttachmentURI(contact.assistantID, contact.attachmentID) || file.mime !== contact.mime) throw new Error('attachment_invalid_receipt');
      return { uri: file.uri, name: file.name, mime: file.mime, contact };
    }
    if (!file.uri.startsWith('file:///') || file.contact !== undefined) throw new Error('attachment_invalid_receipt');
    return { uri: file.uri, name: file.name, mime: file.mime };
  });
  boundedMetadata(attachments);
  if (new Set(attachments.map(identity)).size + Number(result.orphaned) > 64) throw new Error('attachment_invalid_receipt');
  if (['cancelled', 'retired', 'pending'].includes(result.state) && attachments.length) throw new Error('attachment_invalid_receipt');
  return { requestID, state: result.state as DesktopAttachmentResult['state'], attachments, orphaned: Number(result.orphaned), ...(typeof result.error === 'string' ? { error: result.error } : {}) };
}

/**
 * Only metadata crosses HostChannel. No File.arrayBuffer/base64/JS arrays or local paths.
 * One retained receipt, <=64 identities / 64 KiB. Unknown/failed receipts block new picks
 * until authoritative completion or explicit confirmed cancellation. A 401/transport error
 * never clears the receipt. This is process/page-owner memory, NOT crash durability.
 * Native currently publishes one final snapshot: stage() returns on the first unknown and
 * install() stores it once; status never resumes a PUT. Still accept later readback snapshots
 * monotonically by identity, so partial adoption never implies the remainder is complete.
 */
export function createDesktopAttachments(options: { scope: RuntimeScope; native: Native; id(): string; target?: DesktopAttachmentTarget }) {
  const expectedHost = runtimeScopeFrom(options.scope);
  if (!expectedHost) throw new Error('scope_required');
  const target = desktopAttachmentTarget(options.target);
  const targetInput = target.kind === 'assistant' ? { target } : {};
  type Operation = {
    requestID: string; owner: DraftOwner; cancelled: boolean; closed: boolean; uncertain: boolean;
    state: DesktopAttachmentResult['state']; seen: Map<string, DesktopAttachment>;
    adopted: Set<string>; orphaned: Set<string>; nativeOrphaned: number;
    cleanup?: Promise<void>;
  };
  let active: Operation | undefined, retained: Operation | undefined;
  let readFlight: Promise<DesktopAttachmentResult | null> | undefined;
  const unsettled = (operation: Operation) => !operation.closed || !!operation.cleanup || !operation.cancelled && operation.seen.size !== operation.adopted.size;
  const orphanCount = (operation: Operation) => Math.min(64, Math.max(operation.orphaned.size, operation.nativeOrphaned - operation.adopted.size));
  function observe(result: DesktopAttachmentResult, operation: Operation) {
    const next = new Map(operation.seen);
    for (const file of result.attachments) {
      const previous = next.get(identity(file));
      if (previous && signature(previous) !== signature(file)) throw new Error('attachment_identity_conflict');
      next.set(identity(file), file);
    }
    boundedMetadata([...next.values()]);
    operation.seen = next;
    operation.nativeOrphaned = Math.max(operation.nativeOrphaned, result.orphaned);
    if (result.state === 'unknown') operation.uncertain = true;
    else if (!operation.cancelled && ['ready', 'failed'].includes(result.state)) operation.uncertain = false;
    // A delayed pending response cannot reopen a receipt already confirmed terminal.
    if (!operation.closed || result.state !== 'pending') {
      operation.state = result.state;
      operation.closed = terminal(result.state);
    }
  }
  async function cleanup(operation: Operation, method: 'cancel' | 'release') {
    if (operation.cleanup) return await operation.cleanup;
    const flight = (async () => {
      const reply = desktopAttachmentResult(await options.native(`desktop.attachments.${method}`, { requestID: operation.requestID, expectedHost, ...targetInput }), operation.requestID, target);
      if (reply.attachments.length || !['pending', 'retired', 'cancelled'].includes(reply.state)) throw new Error('attachment_invalid_cleanup_receipt');
      observe(reply, operation);
      for (const file of operation.seen.values()) if (!operation.adopted.has(identity(file))) operation.orphaned.add(identity(file));
    })();
    operation.cleanup = flight;
    try { await flight; } finally { if (operation.cleanup === flight) operation.cleanup = undefined; }
  }
  async function adopt(value: unknown, operation: Operation) {
    const result = desktopAttachmentResult(value, operation.requestID, target);
    observe(result, operation);
    if (!operation.cancelled && operation.owner.current()) {
      const additions = [...operation.seen.values()].filter(file => !operation.adopted.has(identity(file)));
      if (additions.length) {
        const files = [...operation.owner.read(), ...additions];
        if (target.kind === 'assistant') {
          let total = 0;
          if (files.length > 64) throw new Error('attachment_count_limit');
          for (const file of files) {
            const contact = assistantAttachmentDescriptor((file as DesktopAttachment).contact, target.assistantID);
            if (file.uri !== assistantAttachmentURI(contact.assistantID, contact.attachmentID) || file.mime !== contact.mime) throw new Error('attachment_invalid_receipt');
            total += contact.size;
          }
          if (total > 50 * 1024 * 1024) throw new Error('attachment_size_limit');
        }
        if (!operation.owner.current() || operation.owner.write(files) === false) throw new Error('attachment_owner_unavailable');
        additions.forEach(file => operation.adopted.add(identity(file)));
      }
      return { ...result, state: operation.state, attachments: additions, orphaned: orphanCount(operation) };
    }
    operation.cancelled = true;
    operation.closed = false;
    for (const file of operation.seen.values()) if (!operation.adopted.has(identity(file))) operation.orphaned.add(identity(file));
    // Metadata-only release, including empty unknown receipts. No server-path delete exists.
    await cleanup(operation, 'release');
    return { ...result, state: operation.state, orphaned: orphanCount(operation), attachments: [] };
  }
  return {
    blocked: () => !!active || !!readFlight || !!retained && unsettled(retained),
    receipt: (): DesktopAttachmentReceipt | null => retained ? { requestID: retained.requestID, state: retained.state, unresolved: unsettled(retained), uncertain: retained.uncertain, cancelled: retained.cancelled, adopted: retained.adopted.size, orphaned: orphanCount(retained) } : null,
    async pick(kind: 'files' | 'images', owner: DraftOwner): Promise<DesktopAttachmentResult> {
      if (active || readFlight || !owner.current()) throw new Error('attachment_owner_unavailable');
      if (retained && unsettled(retained)) throw new Error('attachment_receipt_unresolved');
      const operation: Operation = { requestID: options.id(), owner, cancelled: false, closed: false, uncertain: true, state: 'unknown', seen: new Map(), adopted: new Set(), orphaned: new Set(), nativeOrphaned: 0 };
      active = retained = operation;
      try {
        return await adopt(await options.native('desktop.attachments.pick', { requestID: operation.requestID, kind, expectedHost, ...targetInput }), operation);
      } finally { if (active === operation) active = undefined; }
    },
    /** An interrupted call is read back by receipt, never by selecting/uploading again. */
    reconcile(): Promise<DesktopAttachmentResult | null> {
      if (readFlight) return readFlight;
      const operation = retained;
      if (!operation) return Promise.resolve(null);
      const flight = (async () => await adopt(await options.native('desktop.attachments.status', { requestID: operation.requestID, expectedHost, ...targetInput }), operation))();
      readFlight = flight;
      void flight.finally(() => { if (readFlight === flight) readFlight = undefined; }).catch(() => {});
      return flight;
    },
    async cancel(): Promise<void> {
      const operation = active ?? retained;
      if (!operation || operation.closed && !active && operation.state === 'ready' && operation.seen.size === operation.adopted.size) return;
      operation.cancelled = true;
      operation.closed = false;
      await cleanup(operation, 'cancel');
    },
  };
}
