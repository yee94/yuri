import type { createNativeHistoryFooter } from '../../history-footer';

/** Same-stack release. cachePre only tags existing native samples; it must not measure or wait. */
export function releaseFooterSynchronously(footer: ReturnType<typeof createNativeHistoryFooter>, offsetY: number,
  cachePre: (before: ReturnType<typeof footer.snapshot>, eventAt: number) => void, now = () => performance.now()) {
  const eventAt = now(), before = footer.snapshot();
  cachePre(before, eventAt);
  const releaseStart = now();
  footer.onScrollEnd(offsetY);
  const releaseReturned = now(), after = footer.snapshot();
  return { eventAt, releaseStart, releaseReturned, offsetY, before, after, released: after.releases === before.releases + 1 };
}
