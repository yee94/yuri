import { afterEach, describe, expect, test, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChatAutoFollow, type UseChatAutoFollowResult } from './useChatAutoFollow';

const VIEWPORT = 300;

async function mount(options: { reducedMotion?: boolean; release?: boolean }) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
        const media = matchMedia(query);
        if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(media, 'matches', { value: !!options.reducedMotion });
        return media;
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let api!: UseChatAutoFollowResult;
    function Harness() {
        api = useChatAutoFollow({ currentSessionId: null, sessionMessageCount: 10, sessionIsWorking: false, isMobile: false });
        return React.createElement('div', { ref: api.scrollRef }, React.createElement('section'));
    }
    await act(async () => root.render(React.createElement(Harness)));
    const scroller = api.scrollRef.current!;
    const calls: ScrollToOptions[] = [];
    let top = 500;
    Object.defineProperties(scroller, {
        scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
        clientHeight: { configurable: true, value: VIEWPORT },
        scrollHeight: { configurable: true, value: 2000 },
    });
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 500, VIEWPORT);
    scroller.scrollTo = (arg?: ScrollToOptions | number) => {
        if (typeof arg === 'object') { calls.push(arg); top = arg.top ?? top; }
    };
    if (options.release) await act(async () => api.releaseAutoFollow());
    const panel = scroller.firstElementChild as HTMLElement;
    const place = (rectTop: number, height: number) => {
        panel.getBoundingClientRect = () => new DOMRect(0, rectTop, 400, height);
    };
    const reveal = () => act(async () => api.notifyContentChange('reveal', { revealElement: panel }));
    return { calls, place, reveal, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('reveal request (panel laid out at final height)', () => {
    test('eases once, just far enough to show the bottom edge', async () => {
        const h = await mount({ release: true });
        try {
            h.place(250, 200); // bottom 450 vs usable bottom 284 → 166px
            await h.reveal();
            expect(h.calls).toEqual([{ top: 666, behavior: 'smooth' }]);
        } finally { await h.cleanup(); }
    });

    test('never pushes the panel header out of view', async () => {
        const h = await mount({ release: true });
        try {
            h.place(100, 600); // taller than the viewport: header may only travel to the top margin
            await h.reveal();
            expect(h.calls).toEqual([{ top: 584, behavior: 'smooth' }]);
        } finally { await h.cleanup(); }
    });

    test('a panel that already fits does not move the viewport', async () => {
        const h = await mount({ release: true });
        try {
            h.place(20, 100);
            await h.reveal();
            expect(h.calls).toEqual([]);
        } finally { await h.cleanup(); }
    });

    test('bottom-following needs no reveal write: the bottom chase follows the growth', async () => {
        const h = await mount({ release: false });
        try {
            h.place(250, 200);
            await h.reveal();
            expect(h.calls).toEqual([]);
        } finally { await h.cleanup(); }
    });

    test('reduced motion moves instantly', async () => {
        const h = await mount({ release: true, reducedMotion: true });
        try {
            h.place(250, 200);
            await h.reveal();
            expect(h.calls).toEqual([{ top: 666, behavior: 'instant' }]);
        } finally { await h.cleanup(); }
    });
});
