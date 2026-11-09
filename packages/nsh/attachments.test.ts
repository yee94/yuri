import { expect, it } from 'vitest';
import { attachmentFrom, contactSendParts, pickedAttachmentFrom, sameAttachmentValue, sessionFiles } from './attachments';

const owner = { hostID: 'host', target: { kind: 'assistant' as const, id: 'bot' } };
const descriptor = { type: 'file', attachmentID: 'att_one', sha256: 'a'.repeat(64), size: 2, mime: 'image/png', filename: 'a.png', generation: 3 };
it('keeps exact contact owner and frozen wire while session files remain backward compatible', () => {
  const file = pickedAttachmentFrom(descriptor, owner);
  expect(contactSendParts([file], owner)).toEqual([descriptor]);
  expect(file).not.toHaveProperty('uri');
  expect(() => attachmentFrom(file, { ...owner, hostID: 'other' })).toThrow('owner_mismatch');
  expect(() => attachmentFrom(file, { ...owner, target: { ...owner.target, id: 'other' } })).toThrow('owner_mismatch');
  expect(() => sessionFiles([file])).toThrow('invalid_session_attachment');
  const session = { uri: 'file:///host/a', name: 'a', mime: 'text/plain' };
  expect(attachmentFrom(session, { ...owner, target: { kind: 'session', id: 's' } })).toEqual(session);
  expect(sessionFiles([session])).toEqual([{ uri: session.uri, name: session.name }]);
  expect(() => contactSendParts([session], owner)).toThrow();
  expect(sameAttachmentValue(file, { ...file, sha256: 'b'.repeat(64) })).toBe(false);
  expect(contactSendParts([file], { ...owner, contactGeneration: 3 })).toEqual([descriptor]);
  expect(() => contactSendParts([file], { ...owner, contactGeneration: 4 })).toThrow('generation_conflict');
  expect(sameAttachmentValue(file, { ...file, generation: 4 })).toBe(false);
});
it('fails closed on malformed/new hybrid descriptors and enforces the contact turn byte budget', () => {
  for (const extra of [{ type: 'image' }, { size: true }, { size: 0 }, { sha256: 'no' }, { filename: '../a' }, { mime: 'image/png\r\nHeader: x' }, { uri: 'file:///host/private' }, ...[undefined, true, null, [], '3', -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(generation => ({ generation }))]) {
    expect(() => pickedAttachmentFrom({ ...descriptor, ...extra }, owner)).toThrow();
  }
  const large = pickedAttachmentFrom({ ...descriptor, size: 25 * 1024 * 1024 }, owner);
  expect(() => contactSendParts([large, large, large], owner)).toThrow('budget_exceeded');
  expect(() => attachmentFrom({ uri: 'file:///host/a', name: 'a', mime: 'text/plain', attachmentID: 'att_one' }, { ...owner, target: { kind: 'session', id: 's' } })).toThrow();
});
