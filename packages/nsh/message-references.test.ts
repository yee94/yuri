import { describe, expect, it } from 'vitest';
import { decorateNativeMessageDocument, nativeMessageReferenceContext } from './message-references';
import { messageFrom, messagesFrom } from './model';
import { nativeBodyPlan, nativeBodyRows } from './transcript-body-model';

describe('native message references', () => {
  it('shares durable skill/command/citation rules while retaining Markdown and literal code/link sources', () => {
    const context = nativeMessageReferenceContext([{ id: 'f', sessionID: 's', messageID: 'm', type: 'file', filename: 'image-1.png', mime: 'image/png', url: 'file:///work/hash.png' }], '[/work/hash.png]');
    const doc = decorateNativeMessageDocument({ blocks: [{ type: 'paragraph', content: [
      { type: 'text', text: '使用 [skill:review] [command:/commands/build.md] [/work/hash.png]' },
      { type: 'code', code: '[skill:literal]' },
      { type: 'link', url: 'https://example.com/[skill:literal]', content: [{ type: 'text', text: '[skill:literal]' }] },
      { type: 'strong', content: [{ type: 'text', text: '[skill:strong]' }] },
    ] }] }, context);
    const serialized = JSON.stringify(doc);
    expect(serialized).toContain('"skillName":"review"');
    expect(serialized).toContain('"label":"/build"');
    expect(serialized).toContain('"label":"image-1.png"');
    expect(serialized).toContain('"code":"[skill:literal]"');
    expect(serialized).toContain('"text":"[skill:literal]"');
    expect(serialized).toContain('"skillName":"strong"');
  });
  it('propagates authoritative contact generation to preview descriptors without mutating the wire', () => {
    const part = { type: 'file', attachmentID: 'opaque', sha256: 'a'.repeat(64), size: 12, mime: 'image/png', filename: 'a.png' };
    const page = messagesFrom({ generation: 9, messages: [{ id: 'm', role: 'user', ordinal: 1, parts: [part] }] }, true);
    expect(page.messages[0].files[0].generation).toBe(9);
    expect(part).not.toHaveProperty('generation');
    expect(nativeBodyPlan(nativeBodyRows(page.messages)[0]).inline).toMatchObject([{ kind: 'part', part: { source: { attachmentID: 'opaque', generation: 9 } } }]);
  });
  it('keeps canonical skill prose and image parts while hiding synthetic instructions', () => {
    const msg = messageFrom({ id: 'u', type: 'user', parts: [{ id: 'txt', type: 'text', text: '[skill:review] 看看 [photo.png]' },
      { id: 'hidden', type: 'text', synthetic: true, text: 'private skill instructions' }, { id: 'img', type: 'file', filename: 'photo.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' }] })!;
    const plan = nativeBodyPlan(nativeBodyRows([msg])[0]);
    expect(plan.inline.map(node => node.kind === 'part' && node.part.source.type)).toEqual(['text', 'file']);
    expect(JSON.stringify(plan.inline)).not.toContain('private skill instructions');
  });
});
