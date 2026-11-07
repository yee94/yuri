import { expect, it, vi } from 'vitest';
import { createNativeHistoryScroll } from './history-scroll';

function fixture() {
  let loading = false, error = '', active = true, more = true;
  const older = vi.fn(async () => {}), latest = vi.fn(async () => {});
  const scroll = createNativeHistoryScroll({ current: () => active, loading: () => loading, more: () => more, error: () => error, loadOlder: older, loadLatest: latest });
  const frame = (y: number, height = 3000) => ({ offset: { x: 0, y }, contentSize: { width: 400, height }, size: { width: 400, height: 600 } });
  return { scroll, older, latest, frame, loading: (value: boolean) => { loading = value; }, error: (value: string) => { error = value; }, active: (value: boolean) => { active = value; }, more: (value: boolean) => { more = value; } };
}
it('requires older-directed drag intent, consumes one page per gesture, and never re-arms on layout/momentum', () => {
  const f = fixture(); f.scroll.onLoadMore(); f.scroll.onScroll(f.frame(0)); expect(f.older).not.toHaveBeenCalled();
  f.scroll.onScrollDragStart({ offset: { x: 0, y: 900 } });
  f.scroll.onScroll(f.frame(800)); expect(f.older).not.toHaveBeenCalled();
  f.scroll.onScroll(f.frame(250)); expect(f.older).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) { f.scroll.onLoadMore(); f.scroll.onScroll(f.frame(100 - i, 5000)); }
  expect(f.older).toHaveBeenCalledTimes(1);
  f.scroll.onScrollEnd(); f.scroll.onLoadMore(); expect(f.older).toHaveBeenCalledTimes(1);
  f.scroll.onScrollDragStart({ offset: { x: 0, y: 100 } }); f.scroll.onScroll(f.frame(90)); expect(f.older).toHaveBeenCalledTimes(2);
});
it('does not queue a gesture that starts during a flight, or load on downward direction', () => {
  const f = fixture(); f.loading(true); f.scroll.onScrollDragStart({ offset: { x: 0, y: 300 } }); f.loading(false);
  f.scroll.onScroll(f.frame(200)); expect(f.older).not.toHaveBeenCalled();
  f.scroll.onScrollDragStart({ offset: { x: 0, y: 100 } }); f.scroll.onScroll(f.frame(150)); f.scroll.onLoadMore(); expect(f.older).not.toHaveBeenCalled();
});
it('blocks automatic retry after failure, end-of-history and hidden-scope callbacks', () => {
  const f = fixture();
  for (const block of [() => f.error('offline'), () => { f.error(''); f.more(false); }, () => { f.more(true); f.active(false); }]) {
    block(); f.scroll.onScrollDragStart({ offset: { x: 0, y: 300 } }); f.scroll.onScroll(f.frame(200)); f.scroll.onLoadMore();
  }
  expect(f.older).not.toHaveBeenCalled(); f.scroll.onLoadMoreAtStart(); expect(f.latest).not.toHaveBeenCalled();
  f.active(true); f.scroll.onLoadMoreAtStart(); expect(f.latest).toHaveBeenCalledTimes(1);
});
