import { expect, open, test } from 'nsh/test';

test('AppKit shifted physical key reaches keymap and menu replacement retains callbacks', async () => {
  const app = await open('../../desktop-shortcuts-menu-fixture.tsx', { platform: 'macos', width: 900, height: 650 });
  await app.waitFor('text:ready');
  await app.press('id:physical-menu-mode');
  await app.press('id:native-override');
  await app.keyboard.press('mod+shift+k');
  await app.waitFor('text:calls:1');
  expect(app.texts()).toContain('source:keyboard');
  await app.press('id:claim');
  await app.press('id:unassign');
  await app.press('id:restore');
  await app.keyboard.press('mod+p');
  await app.waitFor('text:calls:2');
  expect(app.texts()).toContain('source:menu');
  await app.wait(120);
  expect(app.texts()).toContain('calls:2');
});

test('AppKit unassign, focused-field edit remap and settings revoke application accelerators', async () => {
  const app = await open('../../desktop-shortcuts-menu-fixture.tsx', { platform: 'macos', width: 900, height: 650 });
  await app.waitFor('text:ready');
  await app.press('id:physical-menu-mode');
  await app.press('id:claim');
  await app.keyboard.press('mod+p');
  await app.waitFor('text:calls:1');
  await app.press('id:native-override');
  await app.press('id:unassign');
  await app.keyboard.press('mod+p');
  await app.keyboard.press('mod+shift+k');
  await app.wait(120);
  expect(app.texts()).toContain('calls:1');
  await app.press('id:editing-override');
  expect(app.texts()).toContain('owned:["cmd+,"]');
  await app.type('id:menu-editor', 'preserved input');
  await app.keyboard.press('mod+a');
  await app.keyboard.press('mod+c');
  await app.wait(120);
  expect(app.texts()).toContain('calls:1');
  expect(app.value('id:menu-editor')).toBe('preserved input');
  await app.press('id:restore');
  await app.keyboard.press('mod+p');
  await app.waitFor('text:calls:2');
  expect(app.texts()).toContain('source:menu');
  await app.press('id:settings');
  await app.keyboard.press('mod+p');
  await app.wait(120);
  expect(app.texts()).toContain('calls:2');
});

// Explicitly run with --target macos. Headless cannot satisfy the menu-source
// assertions below: it does not dispatch application-menu accelerators.
test('AppKit physical keymap/menu precedence, remap, unassign and edit admission', async () => {
  const app = await open('../../desktop-shortcuts-menu-fixture.tsx', { platform: 'macos', width: 900, height: 650 });
  await app.waitFor('text:ready');
  // The deliberate overlap demonstrates the NSH monitor consumes before NSMenu.
  await app.keyboard.press('mod+p');
  await app.waitFor('text:calls:1');
  expect(app.texts()).toContain('source:keyboard');
  await app.wait(120);
  expect(app.texts()).toContain('calls:1');

  // The headless fixture's fallback observer must not itself preempt NSMenu.
  await app.press('id:physical-menu-mode');
  await app.press('id:claim');
  await app.keyboard.press('mod+p');
  await app.waitFor('text:calls:2');
  expect(app.texts()).toContain('source:menu');
  await app.wait(120);
  expect(app.texts()).toContain('calls:2');

  await app.press('id:native-override');
  await app.keyboard.press('mod+p');
  expect(app.texts()).toContain('calls:2');
  await app.keyboard.press('mod+shift+k');
  await app.waitFor('text:calls:3');
  expect(app.texts()).toContain('source:menu');

  await app.press('id:unassign');
  await app.keyboard.press('mod+p');
  await app.keyboard.press('mod+shift+k');
  await app.wait(120);
  expect(app.texts()).toContain('calls:3');

  await app.press('id:editing-override');
  expect(app.texts()).toContain('owned:["cmd+,"]');
  await app.type('id:menu-editor', 'preserved input');
  await app.keyboard.press('mod+a');
  await app.keyboard.press('mod+c');
  await app.wait(120);
  expect(app.texts()).toContain('calls:3');
  expect(app.value('id:menu-editor')).toBe('preserved input');

  await app.press('id:restore');
  await app.keyboard.press('mod+p');
  await app.waitFor('text:calls:4');
  expect(app.texts()).toContain('source:menu');
  await app.press('id:settings');
  await app.keyboard.press('mod+p');
  await app.wait(120);
  expect(app.texts()).toContain('calls:4');
});
