import { afterEach, describe, expect, test, vi } from 'vitest';
import { createScrollSpy } from './scrollSpy';

const setup = (withResizeObserver = true) => {
    if (!withResizeObserver) vi.stubGlobal('ResizeObserver', undefined);
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    let resize: ResizeObserverCallback | undefined;
    let mutate: MutationCallback | undefined;
    const disconnectResize = vi.fn();
    const disconnectMutation = vi.fn();
    const root = document.createElement('div');
    let secondTop = 200;
    const first = document.createElement('div');
    const second = document.createElement('div');
    const geometry = vi.fn();
    const rect = (top: number) => ({ top } as DOMRect);
    root.getBoundingClientRect = () => { geometry(); return rect(0); };
    first.getBoundingClientRect = () => { geometry(); return rect(-root.scrollTop); };
    second.getBoundingClientRect = () => { geometry(); return rect(secondTop - root.scrollTop); };
    const onActive = vi.fn();
    class Resize {
        constructor(callback: ResizeObserverCallback) { resize = callback; }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = disconnectResize;
    }
    class Mutation {
        constructor(callback: MutationCallback) { mutate = callback; }
        observe = vi.fn();
        disconnect = disconnectMutation;
        takeRecords = () => [];
    }
    const spy = createScrollSpy({
        onActive,
        raf: (cb) => { frames.set(++frameId, cb); return frameId; },
        caf: (id) => { frames.delete(id); },
        ResizeObserver: withResizeObserver ? Resize as unknown as typeof ResizeObserver : undefined,
        MutationObserver: Mutation as unknown as typeof MutationObserver,
    });
    const flush = () => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
    };
    spy.setContainer(root);
    spy.register(first, 'first');
    spy.register(second, 'second');
    flush();
    geometry.mockClear();
    return {
        spy, root, geometry, onActive, flush, frames, disconnectResize, disconnectMutation,
        growFirst: () => { secondTop = 400; },
        resize: () => resize?.([], {} as ResizeObserver),
        mutate: () => mutate?.([], {} as MutationObserver),
    };
};

describe('scroll spy geometry ownership', () => {
    afterEach(() => vi.unstubAllGlobals());
    test('streaming subtree mutations do not force geometry when ResizeObserver owns layout', () => {
        const h = setup();
        for (let i = 0; i < 100; i += 1) { h.mutate(); h.flush(); }
        expect(h.geometry).toHaveBeenCalledTimes(0);
        h.spy.destroy();
    });

    test('reads changed geometry in the post-layout resize callback, not the next animation frame', () => {
        const h = setup();
        h.growFirst();
        h.root.scrollTop = 150;
        h.resize();
        expect(h.geometry).toHaveBeenCalledTimes(3);
        h.geometry.mockClear();
        h.flush();
        expect(h.geometry).toHaveBeenCalledTimes(0);
        expect(h.spy.getActiveId()).toBe('first');
        h.root.scrollTop = 350;
        h.spy.onScroll();
        h.flush();
        expect(h.spy.getActiveId()).toBe('second');
        expect(h.geometry).toHaveBeenCalledTimes(0);
        h.spy.destroy();
    });

    test('coalesces scrolling and cancels pending work on teardown', () => {
        const h = setup();
        for (let i = 0; i < 100; i += 1) h.spy.onScroll();
        expect(h.frames.size).toBe(1);
        h.spy.destroy();
        expect(h.frames.size).toBe(0);
        expect(h.disconnectResize).toHaveBeenCalled();
    });

    test('retains mutation-driven geometry when ResizeObserver is unavailable', () => {
        const h = setup(false);
        h.growFirst();
        h.root.scrollTop = 150;
        h.mutate();
        h.flush();
        expect(h.geometry).toHaveBeenCalledTimes(3);
        expect(h.spy.getActiveId()).toBe('first');
        h.spy.destroy();
        expect(h.disconnectMutation).toHaveBeenCalled();
    });

    test('register and unregister refresh structural offsets and preserve monotonic selection', () => {
        const h = setup();
        h.root.scrollTop = 150;
        h.spy.onScroll();
        h.flush();
        expect(h.spy.getActiveId()).toBe('second');
        h.spy.unregister('second');
        h.flush();
        expect(h.spy.getActiveId()).toBe('first');
        h.spy.destroy();
    });
});
