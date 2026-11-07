import { expect, it, vi } from 'vitest';
import { createNativeHistoryFooter, type NativeHistoryFooterContext } from '../../history-footer';

const visible: NativeHistoryFooterContext = { scope: 'host/session/generation-1', active: true, enabled: true, visible: true, readError: false };
function setup(height = 36, y = 0) {
  const changed = vi.fn(), footer = createNativeHistoryFooter(changed);
  footer.update(visible); footer.onLayout(visible.scope!, height); footer.onScroll(y);
  return { footer, changed };
}

it('retains the actual 36pt footprint at the measured clamped edge before content is removed', () => {
  const { footer } = setup();
  footer.update({ ...visible, visible: false }, 'successful-history');
  expect(footer.snapshot()).toMatchObject({ measuredHeight: 36, minHeight: 36, holds: 1 });
  // This arithmetic models the recorded zero-offset loss, not UIKit execution.
  const contentBefore = 4116.3330078125;
  const contentAfter = contentBefore - 36 + footer.snapshot().minHeight;
  expect(Math.abs(contentAfter - contentBefore)).toBeLessThanOrEqual(1.1);
});

it.each([12.75, 35.99976, 61.5])('uses measured %s rather than a guessed 36/44/53pt constant', height => {
  const { footer } = setup(height, height / 2);
  footer.update({ ...visible, visible: false }, 'successful-history');
  expect(footer.snapshot().minHeight).toBe(height);
});

it('does not release under a drag or native layout callback; releases once only at a real gesture rest beyond the retained area', () => {
  const { footer } = setup();
  footer.update({ ...visible, visible: false }, 'successful-history');
  footer.onScrollEnd(100); // No matching user gesture: not release authority.
  expect(footer.snapshot().minHeight).toBe(36);
  footer.onScrollDragStart(0); footer.onScroll(80);
  expect(footer.snapshot().minHeight).toBe(36);
  footer.onScrollEnd(35.99);
  expect(footer.snapshot().minHeight).toBe(36);
  footer.onScrollDragStart(35.99); footer.onScroll(90); footer.onScrollEnd(90);
  expect(footer.snapshot()).toMatchObject({ minHeight: 0, releases: 1, offsetY: 90 });
  footer.onScrollEnd(100);
  expect(footer.snapshot().releases).toBe(1);
});

it('ignores hidden zero/layout echoes and stale-scope measurements; a visible zero invalidates a prior height', () => {
  const { footer } = setup();
  footer.update({ ...visible, visible: false }, 'successful-history'); footer.onLayout(visible.scope!, 0);
  expect(footer.snapshot().minHeight).toBe(36);
  footer.update({ ...visible, scope: 'other-generation', visible: true });
  footer.onLayout(visible.scope!, 90);
  expect(footer.snapshot()).toMatchObject({ measuredHeight: 0, minHeight: 0, offsetY: null });
  footer.onLayout('other-generation', 90); footer.onLayout('other-generation', 0); footer.onScroll(0);
  footer.update({ ...visible, scope: 'other-generation', visible: false }, 'successful-history');
  expect(footer.snapshot().minHeight).toBe(0);
});

it('has no fallback guess without a valid height/offset, and does not arm retroactively when enabled after disappearance', () => {
  const footer = createNativeHistoryFooter();
  footer.update(visible); footer.onScroll(0); footer.update({ ...visible, visible: false }, 'successful-history');
  expect(footer.snapshot().minHeight).toBe(0);
  const missingOffset = createNativeHistoryFooter();
  missingOffset.update(visible); missingOffset.onLayout(visible.scope!, 36); missingOffset.update({ ...visible, visible: false }, 'successful-history');
  expect(missingOffset.snapshot().minHeight).toBe(0);
  const { footer: disabled } = setup();
  disabled.update({ ...visible, enabled: false }); disabled.update({ ...visible, enabled: false, visible: false });
  disabled.update({ ...visible, enabled: true, visible: false });
  expect(disabled.snapshot().minHeight).toBe(0);
});

it('preserves an existing hold on read failure, restores actual visible content, and clears scope/hidden/latest lifetimes', () => {
  const { footer } = setup();
  footer.update({ ...visible, visible: false }, 'successful-history');
  footer.update({ ...visible, visible: false, readError: true });
  expect(footer.snapshot().minHeight).toBe(36);
  footer.onLatest();
  expect(footer.snapshot()).toMatchObject({ minHeight: 0, measuredHeight: 0, offsetY: null });
  footer.update(visible); footer.onLayout(visible.scope!, 52); footer.onScroll(0); footer.update({ ...visible, visible: false }, 'successful-history');
  footer.update({ ...visible, active: false, visible: false });
  expect(footer.snapshot()).toMatchObject({ minHeight: 0, measuredHeight: 0, offsetY: null });
  footer.update(visible); footer.onLayout(visible.scope!, 36); footer.onScroll(0); footer.update({ ...visible, visible: false }, 'successful-history');
  footer.update(visible);
  expect(footer.snapshot().minHeight).toBe(0);
  footer.reset(); expect(footer.snapshot().measuredHeight).toBe(0);
});

it('does not publish per-scroll snapshots on the input/event hot path', () => {
  const { footer, changed } = setup(); const calls = changed.mock.calls.length;
  for (let i = 0; i < 1000; i++) footer.onScroll(i);
  expect(changed).toHaveBeenCalledTimes(calls);
  expect(footer.snapshot().offsetY).toBe(999);
});

it('keeps no footprint on a non-clamped removal and does not mistake read failure for a new terminal boundary', () => {
  const { footer } = setup(36, 36);
  footer.update({ ...visible, visible: false }, 'successful-history'); expect(footer.snapshot().minHeight).toBe(0);
  const { footer: failed } = setup();
  failed.update({ ...visible, visible: false, readError: true });
  expect(failed.snapshot()).toMatchObject({ minHeight: 0, reason: 'read-error-no-terminal-authority' });
});

it('retains valid visible layout knowledge at latest, but rejects late layout/scroll after disposal', () => {
  const { footer } = setup();
  footer.onLatest(); expect(footer.snapshot()).toMatchObject({ measuredHeight: 36, offsetY: null, minHeight: 0 });
  footer.onScroll(0); footer.update({ ...visible, visible: false }, 'successful-history'); expect(footer.snapshot().minHeight).toBe(36);
  footer.reset(); footer.onLayout(visible.scope!, 90); footer.onScroll(10);
  expect(footer.snapshot()).toMatchObject({ active: false, scope: null, measuredHeight: 0, offsetY: null, minHeight: 0 });
});

it('does not clear a retained footprint under a real drag even if the native latest zone is reached', () => {
  const { footer } = setup(); footer.update({ ...visible, visible: false }, 'successful-history');
  footer.onScrollDragStart(0); footer.onScroll(1000); footer.onLatest();
  expect(footer.snapshot()).toMatchObject({ minHeight: 36, gesture: true, reason: 'latest-await-user-rest' });
  footer.onScrollEnd(1000);
  expect(footer.snapshot()).toMatchObject({ minHeight: 0, measuredHeight: 0, gesture: false, releases: 1, offsetY: 1000 });
});

it('accepts initial mounted visible layout before lifecycle becomes active, then enables without another layout callback', () => {
  const changed = vi.fn(), footer = createNativeHistoryFooter(changed);
  // Actual failed UIKit sequence: the sole natural layout arrived while lifecycle was not active.
  footer.update({ ...visible, active: false, enabled: false });
  footer.onLayout(visible.scope!, 36);
  expect(footer.snapshot()).toMatchObject({ active: false, enabled: false, measuredHeight: 36, minHeight: 0 });
  footer.update({ ...visible, active: false, enabled: false });
  expect(footer.snapshot().measuredHeight).toBe(36); // Repeated initial inactive notification is not a real hide.
  footer.update({ ...visible, enabled: false });
  footer.onScroll(2579);
  footer.update(visible); // Same scope + same footer: UIKit emits no new layout.
  expect(footer.snapshot()).toMatchObject({ measuredHeight: 36, minHeight: 0 });
  const publishedAtEnable = changed.mock.calls.at(-1)![0], count = changed.mock.calls.length;
  footer.onScroll(0);
  expect(changed).toHaveBeenCalledTimes(count);
  expect(publishedAtEnable.offsetY).toBe(2579);
  expect(footer.snapshot().offsetY).toBe(0); // Current event cache, not published UI state.
  footer.update({ ...visible, visible: false }, 'successful-history');
  expect(footer.snapshot()).toMatchObject({ measuredHeight: 36, offsetY: 0, minHeight: 36, holds: 1 });
});

it('records natural layout while active but disabled and retains it across repeated disabled/enable updates', () => {
  const footer = createNativeHistoryFooter();
  footer.update({ ...visible, enabled: false }); footer.onLayout(visible.scope!, 47.25);
  footer.update({ ...visible, enabled: false }); footer.update(visible);
  footer.onScroll(0); footer.update({ ...visible, visible: false }, 'successful-history');
  expect(footer.snapshot()).toMatchObject({ measuredHeight: 47.25, minHeight: 47.25 });
});

it('closes initial-layout admission after real deactivation and never primes a different scope from an old callback', () => {
  const footer = createNativeHistoryFooter();
  footer.update(visible); footer.onLayout(visible.scope!, 36);
  footer.update({ ...visible, active: false }); footer.onLayout(visible.scope!, 100);
  expect(footer.snapshot().measuredHeight).toBe(0);
  footer.update({ ...visible, scope: 'generation-2', active: false, enabled: false });
  footer.onLayout(visible.scope!, 100);
  expect(footer.snapshot().measuredHeight).toBe(0);
  footer.onLayout('generation-2', 21.75);
  footer.update({ ...visible, scope: 'generation-2' }); footer.onScroll(0);
  footer.update({ ...visible, scope: 'generation-2', visible: false }, 'successful-history');
  expect(footer.snapshot().minHeight).toBe(21.75);
});

it('never reuses a prior active presentation measurement on a real hidden-to-active return without fresh layout', () => {
  const { footer } = setup();
  footer.update({ ...visible, active: false });
  footer.update(visible); footer.onScroll(0); footer.update({ ...visible, visible: false }, 'successful-history');
  expect(footer.snapshot()).toMatchObject({ measuredHeight: 0, minHeight: 0, holds: 0 });
});
