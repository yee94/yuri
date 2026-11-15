import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
const entry = 'native-image-preview.fixture.tsx';

function run(steps: string[], options: { ios?: boolean } = {}) {
  const ios = options.ios === true;
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', entry, ...(ios ? ['--target', 'ios'] : [])], {
    cwd: directory,
    encoding: 'utf8',
    timeout: ios ? 300_000 : 90_000,
    input: steps.join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}

test('the fixed thumbnail opens the caller\u2019s slot, double tap toggles zoom at the tap and the gallery pages', () => {
  run([
    'await app.waitFor("id:fixture-thumb");',
    'await app.press("id:fixture-thumb");',
    'await app.waitFor("id:image-preview-image");',
    'expect(app.texts()).toContain("card:open");',
    'expect(app.texts()).toContain("1 / 2");',
    'expect(app.texts()).toContain("100%");',
    'expect(app.shows("id:fixture-full-first")).toBe(true);',
    // The lease identity (`resource:...`) is never handed to a real Image: only the slot draws.
    'expect(app.texts().join("\\n")).not.toContain("Could not load image.");',
    'expect(app.requests()).toEqual([]);',
    // A double press within the platform click window zooms around the tapped point.
    'await app.press("id:image-preview-image");',
    'await app.press("id:image-preview-image");',
    'expect(app.texts()).toContain("200%");',
    // A fresh double press, once the previous click chain is over, returns to the resting scale.
    'await app.wait(600);',
    'await app.press("id:image-preview-image");',
    'await app.press("id:image-preview-image");',
    'await app.wait(400);',
    'expect(app.texts()).toContain("100%");',
    'await app.press("id:image-preview-zoom-reset");',
    'await app.wait(300);',
    'expect(app.texts()).toContain("100%");',
    // The horizontal pager owns gallery swipes.
    'await app.drag("id:image-preview-pager", { x: -240, y: 0 });',
    'await app.wait(400);',
    'expect(app.texts()).toContain("2 / 2");',
    'await app.press("id:image-preview-close");',
    'await app.waitFor("id:image-preview-image", { state: "gone" });',
    'expect(app.texts()).toContain("card:closed");',
    'expect(app.shows("id:fixture-thumb")).toBe(true);',
  ]);
}, 120_000);

test('a single tap waits out the double-tap window, and every owner fence closes without a stale viewer', () => {
  run([
    'await app.waitFor("id:fixture-thumb");',
    'await app.press("id:fixture-thumb");',
    'await app.waitFor("id:image-preview-image");',
    // One tap closes only after the click window, so a second tap can still zoom.
    'await app.press("id:image-preview-image");',
    'await app.wait(700);',
    'expect(app.texts()).toContain("card:closed");',
    'expect(app.shows("id:image-preview-image")).toBe(false);',
    // `active` false (surface backgrounded) closes an open viewer immediately.
    'await app.press("id:fixture-open-fenced");',
    'await app.waitFor("id:image-preview-image");',
    'await app.wait(2200);',
    'expect(app.texts()).toContain("sheet:closed");',
    'expect(app.shows("id:image-preview-image")).toBe(false);',
    'await app.press("id:fixture-reset-active");',
    // An empty gallery reports closed instead of leaving a dead dialog.
    'await app.press("id:fixture-open-empty");',
    'await app.wait(300);',
    'expect(app.texts()).toContain("empty:closed");',
    'expect(app.shows("id:image-preview-image")).toBe(false);',
    // The source frame is gone (`measureSource` -> null): the close falls back to a fade.
    'await app.press("id:fixture-open-sheet");',
    'await app.waitFor("id:image-preview-image");',
    'await app.press("id:image-preview-close");',
    'await app.wait(700);',
    'expect(app.texts()).toContain("sheet:closed");',
    'expect(app.shows("id:image-preview-image")).toBe(false);',
    // The owning row unmounting takes its viewer with it.
    'await app.press("id:fixture-unmount-card");',
    'await app.wait(400);',
    'expect(app.shows("id:fixture-thumb")).toBe(false);',
  ]);
}, 120_000);

test('a message thumbnail keeps its fixed 160pt frame when metadata arrives late, and retirement resolves on the native dismissal', () => {
  run([
    'await app.waitFor("id:fixture-thumb");',
    'await app.wait(300);',
    // No metadata yet: the frame is the fixed message frame, not a guess from the image.
    'expect(app.texts()).toContain("card-height:160");',
    'await app.press("id:fixture-late-meta");',
    'await app.wait(400);',
    // 400x300 metadata changes the intrinsic aspect, never the row height.
    'expect(app.texts()).toContain("card-height:160");',
    // The owner retires while the viewer is open: `close()` settles only on the dismissal.
    'await app.press("id:fixture-retire-timer");',
    'await app.press("id:fixture-thumb");',
    'await app.waitFor("id:image-preview-image");',
    'await app.wait(3400);',
    'expect(app.texts()).toContain("retire:done");',
    'expect(app.texts()).toContain("card:closed");',
    'expect(app.texts()).toContain("card-closed:1");',
    'expect(app.shows("id:image-preview-image")).toBe(false);',
    'expect(app.shows("id:fixture-thumb")).toBe(true);',
  ]);
}, 120_000);

test('late metadata for the same source never closes the open viewer', () => {
  run([
    'await app.waitFor("id:fixture-solo");',
    // The 400x300 metadata lands while the viewer is presented.
    'await app.press("id:fixture-meta-timer");',
    'await app.press("id:fixture-solo");',
    'await app.waitFor("id:image-preview-image");',
    'await app.wait(1600);',
    'expect(app.shows("id:image-preview-image")).toBe(true);',
    'expect(app.texts()).toContain("solo:open");',
    'expect(app.texts()).toContain("solo-closed:0");',
    'expect(app.texts()).toContain("100%");',
  ]);
}, 120_000);

test('a replaced source closes the old viewer at once and never returns to the new one', () => {
  run([
    'await app.waitFor("id:fixture-solo");',
    // The owner's sequence: the old source drops to `''`, then the next lease arrives.
    'await app.press("id:fixture-swap-timer");',
    'await app.press("id:fixture-solo");',
    'await app.waitFor("id:image-preview-image");',
    'await app.wait(1800);',
    'expect(app.shows("id:image-preview-image")).toBe(false);',
    'expect(app.texts()).toContain("solo:closed");',
    'expect(app.texts()).toContain("solo-closed:1");',
    // `close()`/`onClosed` fire a frame after the identity change: no return animation ran.
    'const closed = /swap-close:(\\d+)/.exec(app.texts().join("\\n"));',
    'expect(closed).not.toBeNull();',
    'expect(Number(closed[1])).toBeLessThan(150);',
    // The card now draws the second lease, and no fullscreen page of the first is left.
    'expect(app.shows("id:fixture-thumb-solo-first")).toBe(false);',
    'expect(app.shows("id:fixture-thumb-solo-second")).toBe(true);',
    'expect(app.shows("id:fixture-full-solo-first")).toBe(false);',
  ]);
}, 120_000);

/**
 * UIKit-only: the overscroll pull that dismisses is a real scroll view behavior. Headless
 * `app.drag` does not produce `pullValue` at all (verified: a plain zoomable Scroll reports
 * pull 0), so this case runs only with an explicit simulator request.
 */
test.skipIf(process.env.NSH_IMAGE_PREVIEW_IOS !== '1')('UIKit: pull down on the image dismisses, paging and a tap still work', () => {
  run([
    'await app.waitFor("id:fixture-thumb");',
    'await app.press("id:fixture-thumb");',
    'await app.waitFor("id:image-preview-image");',
    // 260pt of finger travel is about 118pt of rubber-banded pull: past the 64pt threshold.
    'await app.drag("id:image-preview-image", { x: 0, y: 260 });',
    'await app.wait(700);',
    'expect(app.texts()).toContain("card:closed");',
    'expect(app.shows("id:image-preview-image")).toBe(false);',
    'await app.press("id:fixture-thumb");',
    'await app.waitFor("id:image-preview-image");',
    'await app.wait(400);',
    'await app.drag("id:image-preview-pager", { x: -260, y: 0 });',
    'await app.wait(500);',
    'expect(app.texts()).toContain("2 / 2");',
    'await app.press("id:image-preview-close");',
    'await app.waitFor("id:image-preview-image", { state: "gone" });',
    'expect(app.texts()).toContain("card:closed");',
    // A retirement while presented resolves on the real UIKit dismissal.
    'await app.press("id:fixture-retire-timer");',
    'await app.press("id:fixture-thumb");',
    'await app.waitFor("id:image-preview-image");',
    'await app.wait(4000);',
    'expect(app.texts()).toContain("retire:done");',
    'expect(app.texts()).toContain("card:closed");',
    'expect(app.shows("id:image-preview-image")).toBe(false);',
  ], { ios: true });
}, 320_000);
