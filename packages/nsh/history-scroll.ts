type Offset = { offset: { x: number; y: number } };
type ScrollFrame = Offset & { size: { width: number; height: number }; contentSize: { width: number; height: number } };
type HistoryScrollSource = {
  current: () => boolean;
  loading: () => boolean;
  more: () => boolean;
  error: () => string;
  loadOlder: (automatic: boolean) => Promise<void>;
  loadLatest: () => Promise<void>;
};

/** Pagination intent only. NSH's inverted List remains the sole scroll writer. */
export function createNativeHistoryScroll(source: HistoryScrollSource) {
  let budget = false, upward = false, nearOlder = false, previousY = 0;
  function older() {
    if (!budget || !upward || !nearOlder || !source.current() || source.loading() || !source.more() || source.error()) return;
    budget = false;
    void source.loadOlder(true);
  }
  function reset() { budget = false; upward = false; nearOlder = false; }
  return {
    reset,
    onScrollDragStart(event: Offset) {
      reset(); previousY = event.offset.y;
      budget = source.current() && !source.loading() && source.more() && !source.error();
    },
    onScroll(event: ScrollFrame) {
      if (!source.current()) { reset(); return; }
      // Inversion lays rows bottom-up, but the physical content offset is top-down.
      if (event.offset.y !== previousY) upward = event.offset.y < previousY;
      previousY = event.offset.y;
      nearOlder = event.size.height > 0 && event.offset.y <= event.size.height * 0.5;
      older();
    },
    onScrollEnd: reset,
    onLoadMore() { older(); },
    // Installing this listener opts NSH into keyed reading anchors away from latest.
    onLoadMoreAtStart() { if (source.current() && !source.loading()) void source.loadLatest(); },
  };
}
