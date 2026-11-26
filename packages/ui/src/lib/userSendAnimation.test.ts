import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ContactSendFlightSource } from '@/components/assistants/contactSendFlight';

const flight = vi.hoisted(() => ({ start: vi.fn(() => () => {}) }));
vi.mock('@/components/assistants/contactSendFlight', () => ({ startContactSendFlight: flight.start }));

import {
    clearConsumedUserSendAnimation,
    hasPendingUserSendAnimation,
    markPendingUserSendAnimation,
    peekConsumedUserSendAnimation,
    registerUserSendFlight,
    resetUserSendAnimationForTests,
    resolveConsumedSendMessageId,
} from './userSendAnimation';

describe('resolveConsumedSendMessageId', () => {
    beforeEach(() => {
        resetUserSendAnimationForTests();
    });

    test('consumes a pending send on append and remembers it', () => {
        markPendingUserSendAnimation('ses');
        const animatedIds = new Set<string>();
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a'],
            currentUserOrder: ['a', 'b'],
            animatedIds,
        })).toBe('b');
        expect(hasPendingUserSendAnimation('ses')).toBe(false);
        expect(peekConsumedUserSendAnimation('ses')).toBe('b');
        expect(animatedIds.has('b')).toBe(true);
    });

    test('re-latches the remembered send after a remount that already consumed pending', () => {
        markPendingUserSendAnimation('ses');
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a'],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        });

        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        })).toBe('b');
    });

    test('does not re-latch after the park is released', () => {
        markPendingUserSendAnimation('ses');
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a'],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        });
        clearConsumedUserSendAnimation('ses');

        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        })).toBeNull();
    });

    test('does not treat historical first paint as a send', () => {
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        })).toBeNull();
    });

    test('a remount still sees the append against the module-scoped previous order', () => {
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['a'],
            animatedIds: new Set(),
        });
        markPendingUserSendAnimation('ses');
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        })).toBe('b');
    });

    test('pending still parks the last user row when the module order already includes it', () => {
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a'],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        });
        markPendingUserSendAnimation('ses');
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a', 'b'],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        })).toBe('b');
    });

    test('a shorter sibling transcript does not erase the live user order', () => {
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        });
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a', 'b'],
            currentUserOrder: [],
            animatedIds: new Set(),
        });
        markPendingUserSendAnimation('ses');
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b', 'c'],
            animatedIds: new Set(),
        })).toBe('c');
    });

    test('a prepend that lands with the send still parks the new last user row', () => {
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['b'],
            animatedIds: new Set(),
        });
        markPendingUserSendAnimation('ses');
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['b'],
            currentUserOrder: ['older', 'b', 'c'],
            animatedIds: new Set(),
        })).toBe('c');
    });
});

describe('user send flight aspect', () => {
    const source: ContactSendFlightSource = { textBox: { left: 0, top: 0, width: 100, height: 20 }, text: 'hi' };
    const mountRow = (id: string) => {
        const row = document.createElement('div');
        row.dataset.messageId = id;
        row.innerHTML = '<div data-user-message-bubble="true">hi</div>';
        document.body.appendChild(row);
        return row.querySelector<HTMLElement>('[data-user-message-bubble]')!;
    };
    const observers = () => (globalThis as unknown as { __observed?: number }).__observed ?? 0;
    let OriginalObserver: typeof MutationObserver;

    beforeEach(() => {
        resetUserSendAnimationForTests();
        flight.start.mockClear();
        OriginalObserver = globalThis.MutationObserver;
        (globalThis as unknown as { __observed?: number }).__observed = 0;
        globalThis.MutationObserver = class extends OriginalObserver {
            observe(target: Node, options?: MutationObserverInit) { (globalThis as unknown as { __observed: number }).__observed++; super.observe(target, options); }
            disconnect() { (globalThis as unknown as { __observed: number }).__observed--; super.disconnect(); }
        };
    });
    afterEach(() => {
        resetUserSendAnimationForTests();
        globalThis.MutationObserver = OriginalObserver;
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    test('nothing observes the DOM until a send registers a flight', () => {
        mountRow('msg_idle');
        expect(observers()).toBe(0);
    });

    test('flies once the bubble mounts, then disconnects', async () => {
        registerUserSendFlight('msg_1', source);
        expect(observers()).toBe(1);
        const bubble = mountRow('msg_1');
        await Promise.resolve();
        expect(flight.start).toHaveBeenCalledWith(source, bubble);
        expect(observers()).toBe(0);
    });

    test('flies immediately when the row is already mounted', () => {
        const bubble = mountRow('msg_1');
        registerUserSendFlight('msg_1', source);
        expect(flight.start).toHaveBeenCalledWith(source, bubble);
        expect(observers()).toBe(0);
    });

    test('expires and disconnects when the row never mounts in time', () => {
        vi.useFakeTimers();
        registerUserSendFlight('msg_1', source);
        vi.advanceTimersByTime(1600);
        expect(observers()).toBe(0);
        mountRow('msg_1');
        expect(flight.start).not.toHaveBeenCalled();
    });

    test('a flown message cannot be re-registered by a chip that outlives its row', () => {
        mountRow('msg_1');
        registerUserSendFlight('msg_1', source);
        registerUserSendFlight('msg_1', source);
        expect(flight.start).toHaveBeenCalledTimes(1);
    });
});
