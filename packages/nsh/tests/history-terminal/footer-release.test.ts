import { expect, it } from 'vitest';
import { createNativeHistoryFooter } from '../../history-footer';
import { releaseFooterSynchronously } from './footer-release';

it('releases in the same call stack even when diagnostics never resolve', () => {
  const footer = createNativeHistoryFooter(), shown = { scope: 'fixture', active: true, enabled: true, visible: true, readError: false };
  footer.update(shown); footer.onLayout('fixture', 36); footer.onScroll(0);
  footer.update({ ...shown, visible: false }, 'successful-history'); footer.onScrollDragStart(0);
  const order: string[] = []; let clock = 100;
  const result = releaseFooterSynchronously(footer, 42, () => { order.push('cache-existing-pre'); expect(footer.snapshot().minHeight).toBe(36); return new Promise<void>(() => {}); }, () => clock++);
  order.push('returned');
  expect(result).toMatchObject({ eventAt: 100, releaseStart: 101, releaseReturned: 102, released: true, after: { minHeight: 0, releases: 1 } });
  expect(order).toEqual(['cache-existing-pre', 'returned']);
});
