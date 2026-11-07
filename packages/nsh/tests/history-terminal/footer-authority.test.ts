import { expect, it } from 'vitest';
import { createNativeHistoryFooter, type NativeHistoryFooterContext } from '../../history-footer';

const shown: NativeHistoryFooterContext = { scope: 'host/chat/history-1', active: true, enabled: true, visible: true, readError: false, contentKey: 'button+error' };
function setup() {
  const footer = createNativeHistoryFooter();
  footer.update(shown); footer.onLayout(shown.scope!, 53, shown.contentKey); footer.onScroll(0);
  return footer;
}
it('does not infer exhausted history from clearing the last error or any presentation-only hide', () => {
  const footer = setup();
  footer.update({ ...shown, visible: false });
  expect(footer.snapshot()).toMatchObject({ minHeight: 0, holds: 0, reason: 'no-successful-history-authority' });
  footer.update({ ...shown, visible: false }, 'successful-history');
  expect(footer.snapshot().minHeight).toBe(0); // No retroactive visible->hidden transition.
});
it('only the explicit successful authority transition may retain the natural measured area', () => {
  const footer = setup();
  footer.update({ ...shown, visible: false }, 'successful-history');
  expect(footer.snapshot()).toMatchObject({ minHeight: 53, holds: 1 });
  footer.update({ ...shown, visible: false, readError: true });
  expect(footer.snapshot().minHeight).toBe(53);
});
it('invalidates a previous natural area when visible content changes, without claiming partial shrink compensation', () => {
  const footer = setup();
  footer.update({ ...shown, contentKey: 'button' }, 'successful-history');
  expect(footer.snapshot()).toMatchObject({ minHeight: 0, measuredHeight: 0, holds: 0 });
  expect(footer.onLayout(shown.scope!, 53, 'button+error')).toBe(false);
  footer.update({ ...shown, contentKey: 'button', visible: false }, 'successful-history');
  expect(footer.snapshot().minHeight).toBe(0); // No stale 53pt guess.
});
it('can remeasure the remaining real content before a later complete successful hide', () => {
  const footer = setup();
  footer.update({ ...shown, contentKey: 'button' });
  footer.onLayout(shown.scope!, 31.25, 'button');
  footer.update({ ...shown, contentKey: 'empty', visible: false }, 'successful-history');
  expect(footer.snapshot().minHeight).toBe(31.25);
});
