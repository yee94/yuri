import { describe, expect, test } from 'vitest';

import {
    HEADER_COLLAPSE_RANGE_PX,
    HEADER_COLLAPSE_RETURN_ZONE_PX,
    applyHeaderCollapseCommit,
    applyHeaderCollapseForce,
    applyHeaderCollapseScroll,
    applyHeaderCollapseSnapDone,
    createHeaderCollapseState,
    type HeaderCollapseState,
} from './mobileHeaderCollapse';

const collapsed: HeaderCollapseState = { phase: 'rest', rest: 'collapsed', progress: 1 };

describe('mobileHeaderCollapse', () => {
    test('travel away from the bottom follows the finger and collapses at the range', () => {
        const half = applyHeaderCollapseScroll(createHeaderCollapseState(), 400 + HEADER_COLLAPSE_RANGE_PX / 2, {
            previousDistance: 400,
        });
        expect(half).toMatchObject({ phase: 'tracking', rest: 'expanded', progress: 0.5 });
        const almost = applyHeaderCollapseScroll(half, 400 + HEADER_COLLAPSE_RANGE_PX * 0.8, {
            previousDistance: 400 + HEADER_COLLAPSE_RANGE_PX / 2,
        });
        const full = applyHeaderCollapseScroll(almost, 400 + HEADER_COLLAPSE_RANGE_PX, {
            previousDistance: 400 + HEADER_COLLAPSE_RANGE_PX * 0.8,
        });
        expect(full).toMatchObject({ phase: 'rest', rest: 'collapsed', progress: 1 });

        const fling = applyHeaderCollapseScroll(createHeaderCollapseState(), 600, { previousDistance: 400 });
        expect(fling).toMatchObject({ phase: 'snapping', rest: 'collapsed' });
    });

    test('reading downward outside the return zone never reveals a collapsed header', () => {
        const next = applyHeaderCollapseScroll(collapsed, 600, { previousDistance: 900 });
        expect(next).toBe(collapsed);
    });

    test('inside the return zone the header is revealed gradually with the finger', () => {
        const entering = applyHeaderCollapseScroll(collapsed, HEADER_COLLAPSE_RETURN_ZONE_PX - 12, {
            previousDistance: HEADER_COLLAPSE_RETURN_ZONE_PX + 40,
        });
        expect(entering.phase).toBe('tracking');
        expect(entering.progress).toBeCloseTo(0.9, 2);
        const half = applyHeaderCollapseScroll(entering, HEADER_COLLAPSE_RETURN_ZONE_PX / 2, {
            previousDistance: HEADER_COLLAPSE_RETURN_ZONE_PX - 12,
        });
        expect(half.progress).toBe(0.5);
        const edge = applyHeaderCollapseScroll(half, 1, { previousDistance: HEADER_COLLAPSE_RETURN_ZONE_PX / 2 });
        expect(edge).toMatchObject({ phase: 'rest', rest: 'expanded', progress: 0 });
    });

    test('program frames keep state except reaching the live edge', () => {
        expect(applyHeaderCollapseScroll(collapsed, 300, { previousDistance: 200, userDriven: false })).toBe(collapsed);
        expect(applyHeaderCollapseScroll(collapsed, 0, { previousDistance: 200, userDriven: false }))
            .toMatchObject({ phase: 'snapping', rest: 'expanded', progress: 0 });
    });

    test('release commits by direction: up collapses, down expands only inside the zone', () => {
        const mid: HeaderCollapseState = { phase: 'tracking', rest: 'expanded', progress: 0.3 };
        expect(applyHeaderCollapseCommit(mid, 500, 'collapsed')).toMatchObject({ phase: 'snapping', rest: 'collapsed' });
        expect(applyHeaderCollapseCommit(mid, 50, 'expanded')).toMatchObject({ phase: 'snapping', rest: 'expanded' });
        const heavy: HeaderCollapseState = { phase: 'tracking', rest: 'collapsed', progress: 0.7 };
        expect(applyHeaderCollapseCommit(heavy, 500, 'expanded')).toMatchObject({ rest: 'collapsed', progress: 1 });
        expect(applyHeaderCollapseCommit(heavy, 500, null)).toMatchObject({ rest: 'collapsed' });
    });

    test('force expanded snaps and snap-done rests', () => {
        const snapping = applyHeaderCollapseForce(collapsed, 'expanded');
        expect(snapping).toMatchObject({ phase: 'snapping', rest: 'expanded', progress: 0 });
        expect(applyHeaderCollapseSnapDone(snapping)).toMatchObject({ phase: 'rest', rest: 'expanded', progress: 0 });
    });
});
