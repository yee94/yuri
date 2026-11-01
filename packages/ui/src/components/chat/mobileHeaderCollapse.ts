/**
 * Mobile chat header collapse. The header owns no state: it mirrors the
 * composer swap state (same progress, phase and rest), so header and composer
 * can never disagree. Progress 0 = expanded, 1 = collapsed (composer compact).
 */

import type { ComposerSwapState } from './mobileComposerSwap';

export const HEADER_COLLAPSE_CSS_VAR = '--yuri-mobile-header-collapse';
export const HEADER_COLLAPSE_SELECTOR = ':scope > [data-yuri-collapsible-header="true"]';

export type HeaderCollapsePublished = { progress: string; phase: string; rest: string };

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
    state: ComposerSwapState,
    last?: HeaderCollapsePublished,
): HeaderCollapsePublished => {
    const progress = String(state.progress);
    const phase = state.phase;
    const rest = state.rest === 'compact' ? 'collapsed' : 'expanded';
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
