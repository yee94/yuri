import { describe, expect, it } from 'vitest';
import { assistantAttachmentDescriptor, assistantAttachmentFilePart, assistantAttachmentURI, desktopAttachmentTarget } from './assistant-attachment-model';

const contact = { type: 'file' as const, assistantID: 'asst_a', attachmentID: 'att_1', sha256: 'a'.repeat(64), size: 5, mime: 'text/plain', filename: 'note.txt' };
const file = { uri: assistantAttachmentURI(contact.assistantID, contact.attachmentID), name: 'note.txt', mime: contact.mime, contact };
describe('native assistant attachment metadata', () => {
  it('freezes a complete descriptor and compiles only the exact server-owned file reference', () => {
    const parsed = assistantAttachmentDescriptor(contact, 'asst_a');
    expect(parsed).toEqual(contact); expect(parsed).not.toBe(contact); expect(Object.isFrozen(parsed)).toBe(true);
    const { assistantID: _, ...part } = contact;
    expect(assistantAttachmentFilePart(file, 'asst_a')).toEqual(part);
    expect(assistantAttachmentURI('asst_a', 'att_1')).toBe('/api/yuri/assistants/asst_a/contact/attachments/att_1');
  });
  it.each([
    null, {}, { ...contact, type: 'text' }, { ...contact, assistantID: 'asst_b' },
    { ...contact, attachmentID: '../att' }, { ...contact, attachmentID: 'att%2F1' },
    { ...contact, sha256: 'A'.repeat(64) }, { ...contact, sha256: 'a'.repeat(63) },
    { ...contact, size: 0 }, { ...contact, size: -1 }, { ...contact, size: 1.5 }, { ...contact, size: 25 * 1024 * 1024 + 1 },
    { ...contact, size: '5' }, { ...contact, mime: 'text/plain; charset=utf8' },
    { ...contact, filename: '../note' }, { ...contact, filename: 'note\n.txt' }, { ...contact, filename: null },
    { ...contact, url: 'file:///secret' }, { ...contact, path: '/host/secret' },
  ])('rejects malformed/foreign descriptors without local fallbacks (%#)', value => {
    expect(() => assistantAttachmentDescriptor(value, 'asst_a')).toThrow('attachment_invalid_receipt');
  });
  it.each([
    { ...file, uri: 'file:///note.txt' }, { ...file, uri: 'https://host.invalid' + file.uri },
    { ...file, mime: 'image/png' }, { ...file, contact: undefined },
  ])('refuses forged canonical URLs and missing metadata (%#)', value => {
    expect(() => assistantAttachmentFilePart(value, 'asst_a')).toThrow('attachment_invalid_receipt');
  });
  it('never rebinds a descriptor to a new assistant', () => {
    expect(() => assistantAttachmentFilePart(file, 'asst_b')).toThrow('attachment_invalid_receipt');
    expect(assistantAttachmentDescriptor({ ...contact, size: 25 * 1024 * 1024 })).toMatchObject({ size: 25 * 1024 * 1024 });
  });
  it.each([null, {}, { kind: 'assistant' }, { kind: 'assistant', assistantID: '../a' }, { kind: 'assistant', assistantID: 'a%2Fb' }, { kind: 'assistant', assistantID: 'a', writer: true }, { kind: 'session', assistantID: 'a' }])('rejects unbounded or inferred targets (%#)', value => {
    expect(() => desktopAttachmentTarget(value)).toThrow('attachment_invalid_target');
  });
  it('copies/fences target identity and retains session defaults', () => {
    const source = { kind: 'assistant' as const, assistantID: 'asst_a' }; const target = desktopAttachmentTarget(source);
    source.assistantID = 'asst_b'; expect(target).toEqual({ kind: 'assistant', assistantID: 'asst_a' }); expect(Object.isFrozen(target)).toBe(true);
    expect(desktopAttachmentTarget()).toEqual({ kind: 'session' });
  });
});
