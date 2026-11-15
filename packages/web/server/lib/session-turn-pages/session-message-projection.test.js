import { describe, expect, it } from 'vitest';
import { projectSessionMessage } from './session-message-projection.js';

const user = (files) => ({ id: 'msg_1', sessionID: 'ses_1', type: 'user', time: { created: 1 }, text: 'look', files });
const fileParts = (files) => projectSessionMessage(user(files)).parts.filter((part) => part.type === 'file');

describe('native file projection', () => {
  it('addresses an inline attachment by its bytes, not by its temporary source', () => {
    const [part] = fileParts([{
      name: 'IMG_2599.png',
      mime: 'image/jpeg',
      data: '/9j/4AAQSkZJRg==',
      source: { type: 'uri', uri: 'file:///tmp/yuri-prompt-x/IMG_2599.png' },
    }]);
    expect(part).toMatchObject({ type: 'file', mime: 'image/jpeg', filename: 'IMG_2599.png', url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' });
  });

  it('falls back to the source reference when no bytes are inline', () => {
    const [part] = fileParts([{ name: 'a.png', mime: 'image/png', source: { type: 'uri', uri: 'file:///work/a.png' } }]);
    expect(part.url).toBe('file:///work/a.png');
  });

  it('keeps the legacy top-level uri/url shapes', () => {
    expect(fileParts([{ name: 'a.png', mime: 'image/png', uri: 'file:///work/a.png' }])[0].url).toBe('file:///work/a.png');
    expect(fileParts([{ name: 'a.png', mime: 'image/png', url: 'https://host.example/a.png' }])[0].url).toBe('https://host.example/a.png');
  });

  it('leaves the url undefined only when the entry carries no address at all', () => {
    expect(fileParts([{ name: 'a.png', mime: 'image/png' }])[0].url).toBeUndefined();
    expect(fileParts([{ name: 'a.png', mime: 'image/png', source: { type: 'other' } }])[0].url).toBeUndefined();
  });
});
