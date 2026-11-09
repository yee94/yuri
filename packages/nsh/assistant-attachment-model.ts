/** Metadata only. Bytes, authentication and upload receipts remain owned by the native Host. */
export type AssistantAttachmentDescriptor = Readonly<{
  type: 'file';
  assistantID: string;
  attachmentID: string;
  sha256: string;
  size: number;
  mime: string;
  filename?: string;
}>;

export type DesktopAttachmentTarget = Readonly<{ kind: 'session' } | { kind: 'assistant'; assistantID: string }>;
const opaqueID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const mimePattern = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function desktopAttachmentTarget(value: unknown = { kind: 'session' }): DesktopAttachmentTarget {
  if (!record(value)) throw new Error('attachment_invalid_target');
  if (value.kind === 'session' && Object.keys(value).length === 1) return Object.freeze({ kind: 'session' });
  if (value.kind !== 'assistant' || Object.keys(value).length !== 2 || typeof value.assistantID !== 'string' || !opaqueID.test(value.assistantID)) throw new Error('attachment_invalid_target');
  return Object.freeze({ kind: 'assistant', assistantID: value.assistantID });
}

export function assistantAttachmentURI(assistantID: string, attachmentID: string): string {
  if (!opaqueID.test(assistantID) || !opaqueID.test(attachmentID)) throw new Error('attachment_invalid_receipt');
  return `/api/yuri/assistants/${encodeURIComponent(assistantID)}/contact/attachments/${encodeURIComponent(attachmentID)}`;
}

/** Strict frozen descriptor for draft roundtrips and native readback; never a local file fallback. */
export function assistantAttachmentDescriptor(value: unknown, assistantID?: string): AssistantAttachmentDescriptor {
  if (!record(value) || Object.keys(value).some(key => !['type', 'assistantID', 'attachmentID', 'sha256', 'size', 'mime', 'filename'].includes(key))
    || value.type !== 'file' || typeof value.assistantID !== 'string' || !opaqueID.test(value.assistantID)
    || assistantID !== undefined && value.assistantID !== assistantID
    || typeof value.attachmentID !== 'string' || !opaqueID.test(value.attachmentID)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.size) || Number(value.size) <= 0 || Number(value.size) > 25 * 1024 * 1024
    || typeof value.mime !== 'string' || value.mime.length > 255 || !mimePattern.test(value.mime)
    || value.filename !== undefined && (typeof value.filename !== 'string' || !value.filename || value.filename.length > 512 || /[\x00-\x1f\x7f/\\]/.test(value.filename) || value.filename.includes('..'))) throw new Error('attachment_invalid_receipt');
  return Object.freeze({ type: 'file', assistantID: value.assistantID, attachmentID: value.attachmentID, sha256: value.sha256, size: Number(value.size), mime: value.mime, ...(typeof value.filename === 'string' ? { filename: value.filename } : {}) });
}

/** The message writer sends only the server-owned reference, never a GET URL or local bytes. */
export function assistantAttachmentFilePart(file: { uri: string; mime: string; contact?: AssistantAttachmentDescriptor }, assistantID: string) {
  const contact = assistantAttachmentDescriptor(file.contact, assistantID);
  if (file.uri !== assistantAttachmentURI(assistantID, contact.attachmentID) || file.mime !== contact.mime) throw new Error('attachment_invalid_receipt');
  const { assistantID: _owner, ...part } = contact;
  return part;
}
