import { afterEach, describe, expect, test, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChatAutoFollow, type UseChatAutoFollowResult } from './useChatAutoFollow';

const VIEWPORT = 300;

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
let clock = 0;

async function mount(options: { reducedMotion?: boolean } = {}) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    frames.clear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
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
    let top = 700;
    let height = 1000;
    const writes: number[] = [];
    Object.defineProperties(scroller, {
        scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.min(value, height - VIEWPORT); writes.push(top); } },
        clientHeight: { configurable: true, value: VIEWPORT },
        scrollHeight: { configurable: true, get: () => height },
    });
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 500, VIEWPORT);
    const step = async () => {
        const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
        if (!entry) return false;
        frames.delete(entry[0]);
        clock += 16;
        await act(async () => entry[1](clock));
        return true;
    };
    const run = async (max = 200) => { for (let i = 0; i < max && await step(); i += 1); };
    return {
        scroller, writes, step, run,
        top: () => top,
        grow: (by: number) => act(async () => { height += by; api.notifyContentChange('text'); }),
        api: () => api,
        cleanup: async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('bottom chase (growth while following)', () => {
    test('growth does not pin in the same frame; the viewport eases to the new bottom without overshoot', async () => {
        const h = await mount();
        try {
            await h.grow(400);
            expect(h.writes).toEqual([]);
            await h.run();
            expect(h.top()).toBe(1100);
            expect(h.writes.length).toBeGreaterThan(3);
            expect(h.writes.every((value, index, all) => index === 0 || value >= all[index - 1])).toBe(true);
            expect(h.writes.every((value) => value <= 1100)).toBe(true);
            expect(h.api().state).toBe('following');
        } finally { await h.cleanup(); }
    });

    test('a farther gap moves faster per frame', async () => {
        const near = await mount();
        let nearFirst = 0;
        try {
            await near.grow(60);
            await near.step();
            nearFirst = near.writes[0] - 700;
        } finally { await near.cleanup(); }
        const far = await mount();
        try {
            await far.grow(900);
            await far.step();
            expect(far.writes[0] - 700).toBeGreaterThan(nearFirst * 3);
        } finally { await far.cleanup(); }
    });

    test('growth during the chase moves the target instead of restarting it', async () => {
        const h = await mount();
        try {
            await h.grow(300);
            await h.step();
            await h.step();
            await h.grow(300);
            await h.run();
            expect(h.top()).toBe(1300);
            expect(h.writes.every((value, index, all) => index === 0 || value >= all[index - 1])).toBe(true);
        } finally { await h.cleanup(); }
    });

    test('upward user intent stops the chase and writes nothing more', async () => {
        const h = await mount();
        try {
            await h.grow(600);
            await h.step();
            const before = h.writes.length;
            await act(async () => { h.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
            await h.run();
            expect(h.api().state).toBe('released');
            expect(h.writes.length).toBe(before);
        } finally { await h.cleanup(); }
    });

    test('reduced motion pins immediately', async () => {
        const h = await mount({ reducedMotion: true });
        try {
            await h.grow(400);
            expect(h.top()).toBe(1100);
            expect(frames.size).toBe(0);
        } finally { await h.cleanup(); }
    });
});
