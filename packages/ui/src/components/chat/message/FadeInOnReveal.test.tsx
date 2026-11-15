import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { FadeInOnReveal } from './FadeInOnReveal';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test('a live user reveal never waits for a JavaScript frame or remounts when consumed', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    const render = (skipAnimation: boolean) => root.render(
        <FadeInOnReveal forceAnimation skipAnimation={skipAnimation} ignoreContextDisabled>
            <div data-bubble>first prompt</div>
        </FadeInOnReveal>,
    );
    try {
        await act(async () => render(false));
        const bubble = host.querySelector('[data-bubble]');
        expect(frame).not.toHaveBeenCalled();
        expect(host.querySelector('.opacity-0')).toBeNull();
        await act(async () => render(true));
        expect(host.querySelector('[data-bubble]')).toBe(bubble);
        await act(async () => render(false));
        expect(host.querySelector('[data-bubble]')).toBe(bubble);
    } finally {
        await act(async () => root.unmount());
        frame.mockRestore();
        host.remove();
    }
});
