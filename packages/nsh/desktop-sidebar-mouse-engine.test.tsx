import { expect, open, test } from 'nsh/test';

// Run explicitly with --target macos. Headless touch drag intentionally cannot
// satisfy mouse-moves: the production feedback requires pressedButton === left.
test('AppKit mouse down/drag/up drives the production sidebar adapter', async () => {
  const app = await open('./desktop-sidebar-mouse-fixture.tsx', { platform: 'macos', width: 600, height: 400 });
  await app.waitFor('id:desktop-drag-session-z');
  await app.drag('id:desktop-drag-session-z', { x: 0, y: 35 });
  await app.waitFor('text:order:a,z,b');
  expect(app.texts().some(text => text.startsWith('mouse-moves:') && Number(text.slice('mouse-moves:'.length)) > 0)).toBe(true);
});
