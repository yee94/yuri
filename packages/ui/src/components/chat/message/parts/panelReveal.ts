export const PANEL_REVEAL_DURATION_MS = 200;

const prefersReducedMotion = (): boolean =>
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Visual-only unfold for a panel whose layout is already at its final height.
 * Only clip-path and opacity move: no layout, no ResizeObserver, no virtualizer
 * re-measure per frame. A Web Animation leaves no inline style behind when it
 * finishes or is cancelled, so the open panel is never left clipped. The caller
 * owns any scroll movement.
 */
export const playPanelReveal = (element: HTMLElement): Animation | null => {
    if (prefersReducedMotion() || typeof element.animate !== 'function') return null;
    return element.animate(
        [
            { clipPath: 'inset(0 0 100% 0)', opacity: 0 },
            { clipPath: 'inset(0 0 0% 0)', opacity: 1 },
        ],
        { duration: PANEL_REVEAL_DURATION_MS, easing: 'ease-out' },
    );
};

export const cancelPanelReveal = (animation: Animation | null): void => {
    animation?.cancel();
};
