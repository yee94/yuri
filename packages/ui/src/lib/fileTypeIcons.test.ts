import { describe, expect, test } from 'bun:test';

// The app root already exists when the sprite module mounts.
const appRoot = document.createElement('div');
appRoot.id = 'root';
document.body.append(appRoot);

const { getFileTypeIconHref } = await import('./fileTypeIcons');

describe('file type sprite mount', () => {
  test('stays ahead of body-level portals so overlay toggles do not restyle it', () => {
    const sprite = document.getElementById('yuri-file-type-icon-sprite-root');
    expect(sprite).not.toBeNull();
    // Appending as the last body child made it the previous sibling of every
    // portal, restyling ~6k sprite nodes on each overlay mount/unmount.
    expect(sprite).toBe(document.body.firstElementChild);
    expect(document.body.lastElementChild).toBe(appRoot);
  });
});

describe('getFileTypeIconHref', () => {
  test('uses the folder glyph for directory attachments', () => {
    expect(getFileTypeIconHref('opencode', { isDirectory: true })).toBe('#folder');
    expect(getFileTypeIconHref('opencode', { isDirectory: true, themeVariant: 'light' })).toBe('#folder_light');
  });

  test('keeps the document fallback for extensionless files', () => {
    expect(getFileTypeIconHref('opencode')).toBe('#document');
  });
});
