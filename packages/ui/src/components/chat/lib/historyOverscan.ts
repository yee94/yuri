import { defaultRangeExtractor, type Range, type VirtualItem } from '@tanstack/react-virtual';

const INITIAL_HISTORY_OVERSCAN = 2;
const HISTORY_OVERSCAN_STEP = 2;
const HISTORY_OVERSCAN_VIEWPORTS = 2;

export const getInitialHistoryOverscan = (target: number): number => (
    Math.min(Math.max(0, target), INITIAL_HISTORY_OVERSCAN)
);

export const getNextHistoryOverscan = (current: number, target: number): number => (
    Math.min(Math.max(0, target), Math.max(0, current) + HISTORY_OVERSCAN_STEP)
);

export const getHistoryRenderRange = (
    range: Range,
    measurements: readonly VirtualItem[],
    scrollOffset: number | null,
    viewportHeight: number | undefined,
): number[] => {
    const indexes = defaultRangeExtractor(range);
    if (scrollOffset === null || !Number.isFinite(scrollOffset) || !viewportHeight || viewportHeight <= 0) return indexes;

    const buffer = viewportHeight * HISTORY_OVERSCAN_VIEWPORTS;
    const first = scrollOffset - buffer;
    const last = scrollOffset + viewportHeight + buffer;
    return indexes.filter((index) => {
        // Core may keep the same visible range throughout a very tall turn.
        // Its neighbours must already exist before scrolling crosses that edge.
        if (index >= range.startIndex - 1 && index <= range.endIndex + 1) return true;
        const item = measurements[index];
        return !item || (item.end >= first && item.start <= last);
    });
};
