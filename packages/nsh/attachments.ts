import { record, type Attachment, type ChatTarget, type CompiledFile, type ContactAttachment, type ContactAttachmentDescriptor } from './model';

export type AttachmentOwner = Readonly<{ hostID: string; target: Pick<ChatTarget, 'kind' | 'id'>; contactGeneration?: number }>;
const mimePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const validName = (name: unknown): name is string => typeof name === 'string' && !!name && name.trim() === name && name.length <= 512 && !/[\x00-\x1f\x7f/\\]|\.\./.test(name);
export function contactDescriptorFrom(value: unknown): ContactAttachmentDescriptor {
  const row = record(value);
  if (row.generation !== undefined && (typeof row.generation !== 'number' || !Number.isSafeInteger(row.generation) || row.generation < 0)) throw new Error('invalid_contact_attachment_generation');
  if (row.type !== 'file' || typeof row.attachmentID !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(row.attachmentID) || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || Number(row.size) <= 0 || Number(row.size) > 25 * 1024 * 1024 || typeof row.mime !== 'string' || !mimePattern.test(row.mime) || row.filename !== undefined && !validName(row.filename) || row.uri !== undefined || row.url !== undefined || row.path !== undefined) throw new Error('invalid_contact_attachment');
  return { type: 'file', attachmentID: row.attachmentID, sha256: row.sha256, size: Number(row.size), mime: row.mime, ...(row.filename === undefined ? {} : { filename: row.filename }), ...(row.generation === undefined ? {} : { generation: row.generation }) };
}
export function contactDescriptor(file: ContactAttachment): ContactAttachmentDescriptor { return contactDescriptorFrom(file); }
export function attachmentFrom(value: unknown, owner: AttachmentOwner): Attachment {
  const row = record(value);
  if (row.kind === 'contact') {
    if (owner.target.kind !== 'assistant' || row.hostID !== owner.hostID || row.assistantID !== owner.target.id || typeof row.name !== 'string') throw new Error('contact_attachment_owner_mismatch');
    const descriptor = contactDescriptorFrom(row);
    if (owner.contactGeneration !== undefined && descriptor.generation !== owner.contactGeneration) throw new Error('contact_attachment_generation_conflict');
    if (row.name !== (descriptor.filename ?? descriptor.attachmentID)) throw new Error('invalid_contact_attachment_name');
    return { ...descriptor, kind: 'contact', hostID: owner.hostID, assistantID: owner.target.id, name: row.name };
  }
  // Reject hybrid or malformed new records rather than treating them as legacy URI drafts.
  if (owner.target.kind !== 'session' || row.kind !== undefined && row.kind !== 'session' || ['attachmentID', 'sha256', 'size', 'assistantID', 'hostID', 'type'].some(key => Object.hasOwn(row, key)) || typeof row.uri !== 'string' || !row.uri || /^data:/i.test(row.uri) || typeof row.name !== 'string' || typeof row.mime !== 'string') throw new Error('invalid_session_attachment');
  return { ...(row.kind === 'session' ? { kind: 'session' as const } : {}), uri: row.uri, name: row.name, mime: row.mime };
}
export function pickedAttachmentFrom(value: unknown, owner: AttachmentOwner): Attachment {
  if (owner.target.kind === 'session') return attachmentFrom(value, owner);
  const descriptor = contactDescriptorFrom(value);
  if (descriptor.generation === undefined) throw new Error('contact_attachment_generation_required');
  if (owner.contactGeneration !== undefined && descriptor.generation !== owner.contactGeneration) throw new Error('contact_attachment_generation_conflict');
  return { ...descriptor, kind: 'contact', hostID: owner.hostID, assistantID: owner.target.id, name: descriptor.filename ?? descriptor.attachmentID };
}
export function sessionFiles(files: readonly CompiledFile[]): Array<{ uri: string; name?: string }> {
  return files.map(file => {
    if (file.kind === 'contact' || typeof file.uri !== 'string' || !file.uri || /^data:/i.test(file.uri)) throw new Error('invalid_session_attachment');
    return { uri: file.uri, ...(file.name === undefined ? {} : { name: file.name }) };
  });
}
export function sameAttachmentValue(left: Attachment, right: Attachment): boolean {
  if (left.kind === 'contact' || right.kind === 'contact') return left.kind === 'contact' && right.kind === 'contact' && left.hostID === right.hostID && left.assistantID === right.assistantID && left.attachmentID === right.attachmentID && left.sha256 === right.sha256 && left.size === right.size && left.filename === right.filename && left.mime === right.mime && left.name === right.name && left.generation === right.generation;
   return left.uri === right.uri && left.name === right.name && left.mime === right.mime;
}
export function contactSendParts(files: readonly CompiledFile[], owner: AttachmentOwner): ContactAttachmentDescriptor[] {
  let total = 0;
  return files.map(file => {
    const verified = attachmentFrom(file, owner);
    if (verified.kind !== 'contact') throw new Error('invalid_contact_attachment');
    total += verified.size;
    if (total > 50 * 1024 * 1024) throw new Error('contact_attachment_budget_exceeded');
    return contactDescriptor(verified);
  });
}
