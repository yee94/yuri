import { describe, expect, test, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSpeechTracking, resumeSpeechFollowing, trackSpeech } from '@/lib/voice/speech-tracking';

import {
    isWithinSessionOpenPinGrace,
    SESSION_OPEN_PIN_GRACE_MS,
    useChatAutoFollow,
    type UseChatAutoFollowResult,
} from './useChatAutoFollow';

const here = dirname(fileURLToPath(import.meta.url));

test.each([true, false].flatMap((nativeResize) => [true, false].flatMap((following) =>
    (nativeResize ? [true, false] : [false]).map((handoff) => ({ nativeResize, following, handoff })))))(
    'keyboard viewport keeps the existing scroll owner (native=$nativeResize following=$following handoff=$handoff)', async ({ nativeResize, following, handoff }) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        let api!: UseChatAutoFollowResult;
        let top = 1700;
        let height = 300;
        const write = vi.fn(() => { top = 2000 - height; return true; });
        const controller = { current: { scrollToBottom: write, cancelScroll: vi.fn() } };
        function Harness() {
            api = useChatAutoFollow({ currentSessionId: null, sessionMessageCount: 10, sessionIsWorking: false, isMobile: true, scrollControllerRef: controller });
            return React.createElement('div', { ref: api.scrollRef }, React.createElement('div'));
        }
        try {
            await act(async () => root.render(React.createElement(Harness)));
            const scroller = api.scrollRef.current!;
            Object.defineProperties(scroller, {
                scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
                clientHeight: { configurable: true, get: () => height },
                scrollHeight: { configurable: true, value: 2000 },
            });
            await act(async () => {
                if (!following) { api.releaseAutoFollow(); top = 800; }
                window.dispatchEvent(new CustomEvent('yuri:keyboard-anim', {
                    detail: { phase: 'show', durationMs: 250, nativeResize },
                }));
            });
            write.mockClear();
            if (handoff) await act(async () => window.dispatchEvent(new Event('yuri:keyboard-native-layout')));
            height = 200;
            await act(async () => scroller.dispatchEvent(new Event('scroll')));
            await act(async () => window.dispatchEvent(new CustomEvent('yuri:keyboard-settled', {
                detail: { open: true, nativeResize },
            })));
            expect(top).toBe(!following ? handoff ? 900 : 800 : nativeResize ? 1800 : 1700);
            expect(write.mock.calls.length).toBe(nativeResize && following ? 1 : 0);
            expect(api.state).toBe(following ? 'following' : 'released');
            if (handoff) {
                // No second compensation on repeated settled/resize delivery.
                await act(async () => window.dispatchEvent(new CustomEvent('yuri:keyboard-settled', {
                    detail: { open: true, nativeResize },
                })));
                expect(top).toBe(following ? 1800 : 900);
                await act(async () => window.dispatchEvent(new Event('yuri:keyboard-native-layout')));
                height = 300;
                top = Math.min(top, 2000 - height); // Browser clamps on viewport expansion.
                await act(async () => window.dispatchEvent(new CustomEvent('yuri:keyboard-settled', {
                    detail: { open: false, nativeResize },
                })));
                expect(top).toBe(following ? 1700 : 800);
            }
        } finally {
            await act(async () => root.unmount());
            host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
        }
    },
);

test.each(['no-overflow', 'visible-bottom-edge', 'visible-top-edge', 'clamped-noop', 'subpixel-noop', 'unmeasured-range', 'mobile-no-overflow', 'mobile-clamped-noop'] as const)(
    'speech does not write or release a stationary viewport: %s', async (scenario) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        let api!: UseChatAutoFollowResult;
        let playback: ReturnType<typeof trackSpeech> | undefined;
        const noOverflow = scenario === 'no-overflow' || scenario === 'mobile-no-overflow';
        const initialTop = noOverflow ? 0 : scenario === 'subpixel-noop' ? 599.5 : 600;
        let top = initialTop;
        const scrollTo = vi.fn();
        const cancelScroll = vi.fn();
        const controller = { current: { scrollToBottom: () => true, cancelScroll } };
        const makeRange = document.createRange.bind(document);
        vi.spyOn(document, 'createRange').mockImplementation(() => {
            const range = makeRange();
            range.getBoundingClientRect = () => new DOMRect(0,
                scenario === 'visible-top-edge' ? 60 : scenario.endsWith('clamped-noop') || scenario === 'subpixel-noop' ? 350 : 220,
                200, scenario === 'unmeasured-range' ? 0 : 20);
            return range;
        });
        function Harness() {
            api = useChatAutoFollow({ currentSessionId: null, sessionMessageCount: 2, sessionIsWorking: false, isMobile: scenario.startsWith('mobile'), scrollControllerRef: controller });
            return React.createElement('div', { ref: (element: HTMLDivElement | null) => {
                api.scrollRef.current = element;
                if (!element) return;
                Object.defineProperties(element, {
                    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
                    clientHeight: { configurable: true, value: 300 },
                    scrollHeight: { configurable: true, value: noOverflow ? 300 : 900 },
                });
                element.getBoundingClientRect = () => new DOMRect(0, 0, 500, 300);
                element.scrollTo = scrollTo;
            } }, React.createElement('p', { 'data-speech-content': true }, '海风轻轻吹来。'));
        }
        try {
            await act(async () => root.render(React.createElement(Harness)));
            cancelScroll.mockClear(); scrollTo.mockClear();
            await act(async () => { playback = trackSpeech(api.scrollRef.current!.firstElementChild as HTMLElement); playback.update('海风轻轻吹来。', 0); });
            await act(async () => resumeSpeechFollowing());
            await act(async () => playback!.stop());
            expect({ writes: scrollTo.mock.calls.length, cancels: cancelScroll.mock.calls.length, state: api.state, top })
                .toEqual({ writes: 0, cancels: 0, state: 'following', top: initialTop });
            expect(api.showScrollButton).toBe(false);
        } finally {
            await act(async () => { playback?.stop(); root.unmount(); });
            host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
        }
    },
);

test.each([
    { isMobile: false, reducedMotion: false }, { isMobile: true, reducedMotion: false },
    { isMobile: false, reducedMotion: true }, { isMobile: true, reducedMotion: true },
])('speech keeps breathing room and respects smooth/reduced motion (mobile=$isMobile, reduced=$reducedMotion)', async ({ isMobile, reducedMotion }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
        const media = matchMedia(query);
        if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(media, 'matches', { value: reducedMotion });
        return media;
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let api!: UseChatAutoFollowResult;
    let playback: ReturnType<typeof trackSpeech> | undefined;
    let top = 0;
    let writes = 0;
    const behaviors: (ScrollBehavior | undefined)[] = [];
    function Harness() {
        api = useChatAutoFollow({ currentSessionId: null, sessionMessageCount: 10, sessionIsWorking: false, isMobile });
        return React.createElement('div', { ref: api.scrollRef }, React.createElement('p', { 'data-speech-content': true }, '第一段。第二段。'));
    }
    try {
        await act(async () => root.render(React.createElement(Harness)));
        const scroller = api.scrollRef.current!;
        Object.defineProperties(scroller, {
            scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
            clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 2000 },
        });
        scroller.getBoundingClientRect = () => new DOMRect(0, 0, 500, 300);
        scroller.scrollTo = (options?: ScrollToOptions | number) => {
            if (typeof options === 'object') { top = options.top ?? top; writes++; behaviors.push(options.behavior); }
        };
        await act(async () => { playback = trackSpeech(scroller.firstElementChild as HTMLElement); playback.update('第一段。', 0); });
        getSpeechTracking()!.range!.getBoundingClientRect = () => new DOMRect(0, 900 - top, 300, 40);
        await act(async () => resumeSpeechFollowing());
        expect(top).toBe(770);
        expect(behaviors).toEqual([reducedMotion ? 'instant' : 'smooth']);
        expect(getSpeechTracking()!.range!.getBoundingClientRect().top).toBe(130);
        expect(api.state).toBe('released');
        await act(async () => {
            scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
            top = 1000; scroller.dispatchEvent(new Event('scroll'));
        });
        expect(getSpeechTracking()?.following).toBe(false);
        const count = writes;
        await act(async () => playback!.update('第二段。', 1));
        expect(writes).toBe(count);
        expect(top).toBe(1000);
        getSpeechTracking()!.range!.getBoundingClientRect = () => new DOMRect(0, 1200 - top, 300, 40);
        await act(async () => resumeSpeechFollowing());
        expect(getSpeechTracking()?.following).toBe(true);
        expect(top).toBe(1000); // Already fully visible: do not move the reader unnecessarily.
        expect(writes).toBe(count);
    } finally {
        await act(async () => { playback?.stop(); root.unmount(); });
        host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    }
});

test.each([false, true].flatMap((isMobile) => [300, 1000].flatMap((height) =>
    ['top-edge', 'bottom-edge', 'above-safe-zone', 'below-safe-zone', 'tall-passage'].map((position) => ({ isMobile, height, position })),
)))('speech uses the middle 60% before reaching screen edges (mobile=$isMobile, height=$height, position=$position)', async ({ isMobile, height, position }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let api!: UseChatAutoFollowResult;
    let playback: ReturnType<typeof trackSpeech> | undefined;
    let top = 1000;
    const viewportTop = 80;
    const passageHeight = position === 'tall-passage' ? height * 0.8 : 20;
    const passageTop = position === 'bottom-edge' ? height * 0.8 - passageHeight
        : position === 'below-safe-zone' ? height * 0.8 - passageHeight + 1
        : height * 0.2 - (position === 'above-safe-zone' ? 1 : 0);
    const contentTop = top + passageTop;
    const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
        if (typeof options === 'object') top = options.top ?? top;
    });
    const makeRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
        const range = makeRange();
        range.getBoundingClientRect = () => new DOMRect(0, viewportTop + contentTop - top, 200, passageHeight);
        return range;
    });
    function Harness() {
        api = useChatAutoFollow({ currentSessionId: null, sessionMessageCount: 10, sessionIsWorking: false, isMobile });
        return React.createElement('div', { ref: api.scrollRef }, React.createElement('p', { 'data-speech-content': true }, '当前段落。'));
    }
    try {
        await act(async () => root.render(React.createElement(Harness)));
        const scroller = api.scrollRef.current!;
        Object.defineProperties(scroller, {
            scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
            clientHeight: { configurable: true, value: height }, scrollHeight: { configurable: true, value: 6000 },
        });
        scroller.getBoundingClientRect = () => new DOMRect(0, viewportTop, 500, height);
        scroller.scrollTo = scrollTo;
        await act(async () => { playback = trackSpeech(scroller.firstElementChild as HTMLElement); playback.update('当前段落。', 0); });
        const shouldMove = position === 'above-safe-zone' || position === 'below-safe-zone';
        expect(scrollTo).toHaveBeenCalledTimes(shouldMove ? 1 : 0);
        if (shouldMove) {
            expect(contentTop - top + passageHeight / 2).toBeCloseTo(height / 2);
        } else expect(top).toBe(1000);
        for (let index = 0; index < 50; index++) await act(async () => resumeSpeechFollowing());
        expect(scrollTo).toHaveBeenCalledTimes(shouldMove ? 1 : 0);
    } finally {
        await act(async () => { playback?.stop(); root.unmount(); });
        host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    }
});

describe('virtual list scroll ownership', () => {
    test('normal-flow jump preserves independent overflow axes', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        let api!: UseChatAutoFollowResult;
        function Harness() {
            api = useChatAutoFollow({ currentSessionId: null, sessionMessageCount: 2,
                sessionIsWorking: false, isMobile: true });
            return React.createElement('div', { ref: api.scrollRef, style: { overflowX: 'hidden', overflowY: 'auto' } });
        }
        try {
            await act(async () => root.render(React.createElement(Harness)));
            await act(async () => api.goToBottom('instant'));
            expect(api.scrollRef.current!.style.overflowX).toBe('hidden');
            expect(api.scrollRef.current!.style.overflowY).toBe('auto');
        } finally {
            await act(async () => root.unmount());
            host.remove();
            vi.unstubAllGlobals();
        }
    });

    test.each([true, false])('explicit jump delegates once with auto-follow enabled=%s', async (enabled) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        let api!: UseChatAutoFollowResult;
        let top = 100;
        let height = 900;
        let rawWrites = 0;
        const scrollToBottom = vi.fn(() => { top = height - 300; return true; });
        const cancelScroll = vi.fn();
        const controller = { current: { scrollToBottom, cancelScroll } };
        function Harness() {
            api = useChatAutoFollow({ enabled, scrollControllerRef: controller, currentSessionId: null,
                sessionMessageCount: 12, sessionIsWorking: false, isMobile: false });
            return React.createElement('div', { ref: (element: HTMLDivElement | null) => {
                api.scrollRef.current = element;
                if (!element) return;
                Object.defineProperties(element, {
                    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; rawWrites++; } },
                    scrollHeight: { configurable: true, get: () => height },
                    clientHeight: { configurable: true, get: () => 300 },
                });
            } }, React.createElement('div'));
        }
        try {
            await act(async () => root.render(React.createElement(Harness)));
            scrollToBottom.mockClear();
            rawWrites = 0;
            await act(async () => api.goToBottom('instant'));
            expect(scrollToBottom).toHaveBeenCalledExactlyOnceWith({ behavior: 'auto' });
            expect(top).toBe(600);
            expect(rawWrites).toBe(0);
            expect(api.scrollRef.current!.style.overflow).toBe('');
            scrollToBottom.mockClear();
            await act(async () => api.goToBottom('instant', { reveal: false }));
            expect(scrollToBottom).toHaveBeenCalledExactlyOnceWith({ behavior: 'auto', reveal: false });
            expect(top).toBe(600);
            if (enabled) {
                scrollToBottom.mockClear();
                await act(async () => { height += 100; api.notifyContentChange('text'); });
                expect(scrollToBottom).toHaveBeenCalledExactlyOnceWith({ behavior: 'auto', reveal: false });
                await act(async () => api.releaseAutoFollow());
                expect(cancelScroll).toHaveBeenCalled();
                scrollToBottom.mockClear();
                await act(async () => { height += 100; api.notifyContentChange('text'); });
                expect(scrollToBottom).not.toHaveBeenCalled();
                expect(api.state).toBe('released');
                expect(rawWrites).toBe(0);
            }
        } finally {
            await act(async () => root.unmount());
            host.remove();
            vi.unstubAllGlobals();
        }
    });
});

describe('primary transcript reading ownership', () => {
    test('capture subscriptions survive 50 unchanged renders and detach when disabled', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        const scroller = document.createElement('div');
        const add = vi.spyOn(scroller, 'addEventListener');
        const remove = vi.spyOn(scroller, 'removeEventListener');
        const captured = (calls: ReadonlyArray<ReadonlyArray<unknown>>) => calls.filter((call) => (
            typeof call[2] === 'object' && call[2] !== null && 'capture' in call[2] && call[2].capture === true
        ));
        function Harness({ enabled }: { enabled: boolean }) {
            const api = useChatAutoFollow({ enabled, currentSessionId: null, sessionMessageCount: 5,
                sessionIsWorking: false, isMobile: true });
            api.scrollRef.current = scroller;
            return null;
        }
        try {
            await act(async () => root.render(React.createElement(Harness, { enabled: true })));
            expect(captured(add.mock.calls)).toHaveLength(5);
            for (let edit = 0; edit < 50; edit++) {
                await act(async () => root.render(React.createElement(Harness, { enabled: true })));
            }
            expect(captured(add.mock.calls)).toHaveLength(5);
            expect(captured(remove.mock.calls)).toHaveLength(0);
            await act(async () => root.render(React.createElement(Harness, { enabled: false })));
            expect(captured(remove.mock.calls)).toEqual(captured(add.mock.calls));
        } finally {
            await act(async () => root.unmount());
            host.remove();
            add.mockRestore();
            remove.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    test.each(['touch', 'wheel', 'nested-wheel'] as const)('capture observes %s intent even when a child stops bubbling', async (gesture) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        let api!: UseChatAutoFollowResult;
        let top = 600;
        const scrollToBottom = vi.fn(() => true);
        const controller = { current: { scrollToBottom, cancelScroll: vi.fn() } };
        function Harness() {
            api = useChatAutoFollow({ currentSessionId: null, sessionMessageCount: 5,
                sessionIsWorking: false, isMobile: true, scrollControllerRef: controller });
            return React.createElement('div', { ref: api.scrollRef }, React.createElement('pre'));
        }
        try {
            await act(async () => root.render(React.createElement(Harness)));
            const scroller = api.scrollRef.current!;
            const child = scroller.firstElementChild as HTMLElement;
            Object.defineProperties(scroller, {
                scrollTop: { configurable: true, get: () => top },
                scrollHeight: { configurable: true, value: 900 },
                clientHeight: { configurable: true, value: 300 },
            });
            if (gesture === 'nested-wheel') {
                child.style.overflowY = 'auto';
                Object.defineProperties(child, {
                    scrollTop: { configurable: true, value: 50 },
                    scrollHeight: { configurable: true, value: 400 },
                    clientHeight: { configurable: true, value: 100 },
                });
            }
            for (const type of ['touchstart', 'touchmove', 'wheel']) child.addEventListener(type, (event) => event.stopPropagation());
            await act(async () => {
                scroller.dispatchEvent(new Event('scroll'));
                api.notifyContentChange('animation');
            });
            scrollToBottom.mockClear();
            await act(async () => {
                if (gesture === 'touch') {
                    for (const [type, y] of [['touchstart', 100], ['touchmove', 130]] as const) {
                        const event = new Event(type, { bubbles: true });
                        Object.defineProperty(event, 'touches', { value: { item: () => ({ clientX: 20, clientY: y }) } });
                        child.dispatchEvent(event);
                    }
                } else child.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
                if (gesture !== 'nested-wheel') {
                    top = 400;
                    scroller.dispatchEvent(new Event('scroll'));
                }
            });
            expect(api.showScrollButton).toBe(gesture !== 'nested-wheel');
            expect(api.state).toBe(gesture === 'nested-wheel' ? 'following' : 'released');
            expect(scrollToBottom).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            host.remove();
            vi.unstubAllGlobals();
        }
    });

    test.each(['anchor-correction', 'short-measurement-frame'] as const)('history completion does not reacquire follow from a %s', async (geometryChange) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        let api!: UseChatAutoFollowResult;
        let top = 100;
        let height = 900;
        let writes = 0;
        function Harness() {
            api = useChatAutoFollow({ currentSessionId: null, sessionMessageCount: 24, sessionIsWorking: false, isMobile: false });
            return React.createElement('div', { ref: (element: HTMLDivElement | null) => {
                api.scrollRef.current = element;
                if (!element) return;
                Object.defineProperties(element, {
                    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.min(value, height - 300); writes++; } },
                    scrollHeight: { configurable: true, get: () => height },
                    clientHeight: { configurable: true, get: () => 300 },
                });
            } }, React.createElement('div'));
        }
        try {
            await act(async () => root.render(React.createElement(Harness)));
            await act(async () => {
                api.beginHistoryViewportPreservation();
                top = 100;
                api.scrollRef.current!.dispatchEvent(new Event('scroll'));
                api.endHistoryViewportPreservation();
            });
            await act(async () => {
                api.scrollRef.current!.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
                top = 200;
                api.scrollRef.current!.dispatchEvent(new Event('scroll'));
                api.scrollRef.current!.dispatchEvent(new Event('scrollend'));
            });
            writes = 0;
            await act(async () => {
                height = geometryChange === 'short-measurement-frame' ? 300 : 600;
                top = height - 300;
                api.scrollRef.current!.dispatchEvent(new Event('scroll'));
            });
            const readingTop = top;
            await act(async () => { height = 1800; api.notifyContentChange('structural'); });
            expect({ state: api.state, top, writes }).toEqual({ state: 'released', top: readingTop, writes: 0 });
            await act(async () => {
                api.scrollRef.current!.dispatchEvent(new WheelEvent('wheel', { deltaY: 500 }));
                top = 800;
                api.scrollRef.current!.dispatchEvent(new Event('scroll'));
                top = 1500;
                api.scrollRef.current!.dispatchEvent(new Event('scroll'));
            });
            expect(api.state).toBe('following');
        } finally {
            await act(async () => root.unmount());
            host.remove();
            vi.unstubAllGlobals();
        }
    });

    test.each(['small-scroll', 'released-at-edge', 'released-stationary', 'cumulative-touch', 'horizontal-touch', 'content-shrink', 'bottom-bounce'] as const)('%s preserves reading/follow ownership through content growth', async (scenario) => {
        let clock = 10000;
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const time = vi.spyOn(performance, 'now').mockImplementation(() => clock);
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        let api!: UseChatAutoFollowResult;
        let top = 600;
        let height = 900;
        let writes = 0;
        const bind = (element: HTMLDivElement | null) => {
            api.scrollRef.current = element;
            if (!element) return;
            Object.defineProperties(element, {
                scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.min(value, height - 300); writes += 1; } },
                scrollHeight: { configurable: true, get: () => height },
                clientHeight: { configurable: true, get: () => 300 },
            });
        };
        function Harness() {
            api = useChatAutoFollow({ currentSessionId: null, sessionMessageCount: 5, sessionIsWorking: false, isMobile: true });
            return React.createElement('div', { ref: bind }, React.createElement('div'));
        }
        try {
            await act(async () => root.render(React.createElement(Harness)));
            clock += 1000;
            const element = api.scrollRef.current!;
            await act(async () => element.dispatchEvent(new Event('scroll')));
            writes = 0;
            await act(async () => {
                if (scenario === 'released-at-edge' || scenario === 'released-stationary') api.releaseAutoFollow();
                if (scenario === 'cumulative-touch' || scenario === 'horizontal-touch') {
                    for (let step = 0; step <= 3; step += 1) {
                        const event = new Event(step === 0 ? 'touchstart' : 'touchmove');
                        Object.defineProperty(event, 'touches', { value: { item: () => ({ clientX: 100 + (scenario === 'horizontal-touch' ? step * 5 : 0), clientY: 100 + step }) } });
                        element.dispatchEvent(event);
                    }
                } else {
                    if (scenario === 'content-shrink') height = 850;
                    if (scenario === 'bottom-bounce') {
                        top = 620;
                        element.dispatchEvent(new Event('scroll'));
                    }
                    top = scenario === 'content-shrink' ? 550 : scenario === 'bottom-bounce' || scenario === 'released-stationary' ? 600 : 599;
                    element.dispatchEvent(new Event('scroll'));
                }
            });
            const readingTop = top;
            await act(async () => {
                height = 960;
                api.notifyContentChange('text');
            });
            const remainsFollowing = scenario === 'horizontal-touch' || scenario === 'content-shrink' || scenario === 'bottom-bounce';
            expect({ top, writes, state: api.state }).toEqual(remainsFollowing
                ? { top: 660, writes: 1, state: 'following' }
                : { top: readingTop, writes: 0, state: 'released' });
            await act(async () => {
                element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
                top = 660;
                element.dispatchEvent(new Event('scroll'));
            });
            expect(api.state).toBe('following');
        } finally {
            await act(async () => root.unmount());
            host.remove();
            time.mockRestore();
            vi.unstubAllGlobals();
        }
    });
});

describe('session-open pin grace', () => {
    test.each(['touch', 'wheel', 'key', 'late-restore', 'inherited-touch'] as const)('%s immediately after entry preserves the correct viewport owner through late history growth', async (gesture) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        let clock = 10000;
        const time = vi.spyOn(performance, 'now').mockImplementation(() => clock);
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        let api!: UseChatAutoFollowResult;
        let top = 600;
        let height = 900;
        let writes = 0;
        const controller = { current: {
            scrollToBottom: vi.fn(() => { top = height - 300; writes++; return true; }),
            cancelScroll: vi.fn(),
        } };
        function Harness() {
            api = useChatAutoFollow({ currentSessionId: 'rapid-entry', sessionMessageCount: 12,
                sessionIsWorking: false, isMobile: true, scrollControllerRef: controller });
            return React.createElement('div', { ref: (element: HTMLDivElement | null) => {
                api.scrollRef.current = element;
                if (!element) return;
                Object.defineProperties(element, {
                    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; writes++; } },
                    scrollHeight: { configurable: true, get: () => height },
                    clientHeight: { configurable: true, get: () => 300 },
                });
            } }, React.createElement('div'));
        }
        try {
            await act(async () => root.render(React.createElement(Harness)));
            if (gesture === 'inherited-touch') {
                await act(async () => {
                    const event = new Event('touchstart');
                    Object.defineProperty(event, 'touches', { value: { item: () => ({ clientX: 100, clientY: 100 }) } });
                    api.scrollRef.current!.dispatchEvent(event);
                });
            }
            await act(async () => { await api.restoreSnapshot(); });
            writes = 0;
            clock += 50;
            await act(async () => {
                if (gesture === 'wheel') {
                    api.scrollRef.current!.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
                } else if (gesture === 'key') {
                    api.scrollRef.current!.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }));
                } else {
                    for (const [type, y] of [['touchstart', 100], ['touchmove', 180]] as const) {
                        if (gesture === 'inherited-touch' && type === 'touchstart') continue;
                        const event = new Event(type);
                        Object.defineProperty(event, 'touches', { value: { item: () => ({ clientX: 100, clientY: y }) } });
                        api.scrollRef.current!.dispatchEvent(event);
                    }
                }
                if (gesture !== 'inherited-touch') {
                    expect(controller.current.cancelScroll, 'the gesture must cancel the entry scroll before content grows').toHaveBeenCalled();
                }
                top = 520;
                api.scrollRef.current!.dispatchEvent(new Event('scroll'));
                height += 300;
                api.notifyContentChange('structural');
            });
            if (gesture === 'late-restore') await act(async () => { await api.restoreSnapshot(); });
            expect(api.state).toBe(gesture === 'inherited-touch' ? 'following' : 'released');
            expect(top).toBe(gesture === 'inherited-touch' ? 900 : 520);
            expect(writes).toBe(gesture === 'inherited-touch' ? 1 : 0);
            if (gesture === 'inherited-touch') expect(controller.current.cancelScroll).not.toHaveBeenCalled();
            else expect(controller.current.cancelScroll).toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            host.remove();
            time.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    test('ignores leftover gestures until the grace expires', () => {
        expect(isWithinSessionOpenPinGrace(100, 550)).toBe(true);
        expect(isWithinSessionOpenPinGrace(550, 550)).toBe(false);
        expect(isWithinSessionOpenPinGrace(551, 550)).toBe(false);
    });

    test('restoreSnapshot arms the grace and force-pins on mobile', () => {
        const source = readFileSync(join(here, 'useChatAutoFollow.ts'), 'utf8');
        expect(source).toContain('armSessionOpenPinGrace()');
        expect(source).toContain('forceBottomDefeatingMomentum()');
        expect(source).toContain('isWithinSessionOpenPinGrace(now(), sessionOpenPinGraceUntilRef.current)');
        expect(SESSION_OPEN_PIN_GRACE_MS).toBeGreaterThan(0);
    });
});
