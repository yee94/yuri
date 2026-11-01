/**
 * Mobile chat header collapse: the floating navigation exits upward while the
 * reader moves away from the live edge, and only returns near the live edge.
 *
 * Progress 0 = expanded, 1 = collapsed. Motion is paint-only (transform/opacity).
 *
 * Unlike the composer swap, the two directions are deliberately asymmetric
 * because readers move down the transcript:
 * - Travel away from the bottom follows the finger 1:1 (RANGE ~ header height).
 * - Travel toward the bottom changes nothing until the reader is inside the
 *   return zone; inside it, progress is bounded by `distance / ZONE`, so the
 *   header is revealed gradually and lands expanded exactly at the live edge.
 * - Release commits after the gesture: upward intent collapses, downward intent
 *   inside the zone expands, anything else falls back to the 0.5 midpoint.
 */

import {
    COMPOSER_SWAP_COMMIT_THRESHOLD,
    COMPOSER_SWAP_NOISE_PX,
} from './mobileComposerSwap';

/** Travel that moves progress across 0…1; roughly the header height so it tracks the finger. */
export const HEADER_COLLAPSE_RANGE_PX = 96;
/** Distance from the live edge inside which downward travel reveals the header. */
export const HEADER_COLLAPSE_RETURN_ZONE_PX = 120;
/** One frame moving progress at least this far snaps with the transition. */
const HEADER_COLLAPSE_FLING_STEP = 0.5;
export const HEADER_COLLAPSE_CSS_VAR = '--yuri-mobile-header-collapse';
export const HEADER_COLLAPSE_SELECTOR = ':scope > [data-yuri-collapsible-header="true"]';

export type HeaderCollapseRest = 'expanded' | 'collapsed';
export type HeaderCollapsePhase = 'rest' | 'tracking' | 'snapping';

export type HeaderCollapseState = {
    phase: HeaderCollapsePhase;
    rest: HeaderCollapseRest;
    progress: number;
};

export const createHeaderCollapseState = (): HeaderCollapseState => ({
    phase: 'rest',
    rest: 'expanded',
    progress: 0,
});

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const quantize = (value: number): number => Math.round(clamp01(value) * 1000) / 1000;

const settle = (state: HeaderCollapseState, next: HeaderCollapseState): HeaderCollapseState => (
    state.phase === next.phase && state.rest === next.rest && state.progress === next.progress
        ? state
        : next
);

const progressOf = (rest: HeaderCollapseRest): number => (rest === 'collapsed' ? 1 : 0);

export const applyHeaderCollapseForce = (
    state: HeaderCollapseState,
    rest: HeaderCollapseRest,
): HeaderCollapseState => {
    const progress = progressOf(rest);
    if (state.phase === 'rest' && state.rest === rest && state.progress === progress) return state;
    return settle(state, { phase: 'snapping', rest, progress });
};

export const applyHeaderCollapseScroll = (
    state: HeaderCollapseState,
    distanceFromBottom: number,
    options: {
        previousDistance?: number | null;
        /** False for streaming growth / program scroll; only the live edge may react. */
        userDriven?: boolean;
    } = {},
): HeaderCollapseState => {
    const distance = Math.max(0, distanceFromBottom);
    if (options.userDriven === false) {
        if (distance <= COMPOSER_SWAP_NOISE_PX && state.rest === 'collapsed') {
            return applyHeaderCollapseForce(state, 'expanded');
        }
        return state;
    }

    const previousDistance = options.previousDistance == null
        ? distance
        : Math.max(0, options.previousDistance);
    const base = state.phase === 'snapping'
        ? settle(state, { phase: 'rest', rest: state.rest, progress: progressOf(state.rest) })
        : state;

    if (distance <= COMPOSER_SWAP_NOISE_PX) {
        return settle(base, { phase: 'rest', rest: 'expanded', progress: 0 });
    }

    const travel = distance - previousDistance;
    let progress = base.progress;
    if (travel > 0) {
        progress = quantize(progress + travel / HEADER_COLLAPSE_RANGE_PX);
    } else if (travel < 0 && distance < HEADER_COLLAPSE_RETURN_ZONE_PX) {
        progress = quantize(Math.min(progress, distance / HEADER_COLLAPSE_RETURN_ZONE_PX));
    }

    if (progress === base.progress) return state.phase === 'snapping' ? state : base;

    if (Math.abs(progress - base.progress) >= HEADER_COLLAPSE_FLING_STEP
        && (progress >= 1 || progress <= 0)) {
        return settle(base, {
            phase: 'snapping',
            rest: progress >= 1 ? 'collapsed' : 'expanded',
            progress,
        });
    }
    if (progress >= 1 || progress <= 0) {
        return settle(base, {
            phase: 'rest',
            rest: progress >= 1 ? 'collapsed' : 'expanded',
            progress,
        });
    }
    return settle(base, { phase: 'tracking', rest: base.rest, progress });
};

export const resolveHeaderCollapseCommit = (
    state: HeaderCollapseState,
    distanceFromBottom: number,
    direction: HeaderCollapseRest | null = null,
): HeaderCollapseRest => {
    if (direction === 'collapsed') return 'collapsed';
    if (direction === 'expanded' && distanceFromBottom < HEADER_COLLAPSE_RETURN_ZONE_PX) {
        return 'expanded';
    }
    return state.progress >= COMPOSER_SWAP_COMMIT_THRESHOLD ? 'collapsed' : 'expanded';
};

export const applyHeaderCollapseCommit = (
    state: HeaderCollapseState,
    distanceFromBottom: number,
    direction: HeaderCollapseRest | null = null,
): HeaderCollapseState => {
    if (state.phase === 'snapping') return state;
    const rest = resolveHeaderCollapseCommit(state, distanceFromBottom, direction);
    const progress = progressOf(rest);
    if (state.phase === 'rest' && state.rest === rest && state.progress === progress) return state;
    return settle(state, { phase: 'snapping', rest, progress });
};

export const applyHeaderCollapseSnapDone = (state: HeaderCollapseState): HeaderCollapseState => {
    if (state.phase !== 'snapping') return state;
    return settle(state, { phase: 'rest', rest: state.rest, progress: progressOf(state.rest) });
};

export const resolveCollapsibleHeader = (scope: HTMLElement): HTMLElement | null => {
    const screen = scope.closest<HTMLElement>('.mobile-chat-screen');
    return screen?.querySelector<HTMLElement>(HEADER_COLLAPSE_SELECTOR) ?? null;
};

export const clearHeaderCollapse = (header: HTMLElement): void => {
    header.style.removeProperty(HEADER_COLLAPSE_CSS_VAR);
    delete header.dataset.yuriHeaderCollapsePhase;
    delete header.dataset.yuriHeaderCollapseRest;
};

export const publishHeaderCollapse = (
    header: HTMLElement,
    state: HeaderCollapseState,
    last?: { progress: string; phase: string; rest: string },
): { progress: string; phase: string; rest: string } => {
    const progress = String(state.progress);
    const { phase, rest } = state;
    // Phase first so snapping can arm the CSS transition before progress jumps.
    if (last?.phase !== phase) {
        header.dataset.yuriHeaderCollapsePhase = phase;
        if (phase === 'snapping' && last && last.phase !== 'snapping') {
            void header.offsetWidth;
        }
    }
    if (last?.progress !== progress) {
        header.style.setProperty(HEADER_COLLAPSE_CSS_VAR, progress);
    }
    if (last?.rest !== rest) {
        header.dataset.yuriHeaderCollapseRest = rest;
    }
    return { progress, phase, rest };
};
