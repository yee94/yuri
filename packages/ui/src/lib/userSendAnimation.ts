/**
 * Module-level tracker for user-send animations.
 *
 * Marks a session when the user presses "send" so that MessageList
 * can distinguish genuinely new user messages from historical ones
 * arriving via async loading / session switch.
 *
 * The consumed message id is remembered after the pending count is
 * taken so a React Strict Mode remount can re-latch the same send.
 * Component state and the pending count do not survive that remount.
 * It is not last-read memory: the primary list delayed-clears this
 * latch on leave so a later reopen cannot park on that user row.
 */

import { startContactSendFlight, type ContactSendFlightSource } from '@/components/assistants/contactSendFlight';

const pendingCounts = new Map<string, number>();
const lastConsumedSends = new Map<string, string>();
const lastUserOrders = new Map<string, readonly string[]>();

/*
 * User send flight, applied as an aspect over the transcript DOM. Senders
 * register a source frame at send time; no message or composer component
 * carries flight state, hooks or effects. A MutationObserver exists only while
 * a flight waits for its bubble (at most USER_SEND_FLIGHT_TTL_MS) and
 * disconnects as soon as nothing is pending, so idle rendering pays nothing.
 */
type PendingUserSendFlight = { source: ContactSendFlightSource; expiresAt: number };
const pendingSendFlights = new Map<string, PendingUserSendFlight>();
const USER_SEND_FLIGHT_TTL_MS = 1500;
// Messages that already flew. A queued chip can outlive its admitted row, so a
// later registration must not replay the flight.
const flownSendFlights = new Set<string>();
const FLOWN_SEND_FLIGHT_LIMIT = 64;
let observer: MutationObserver | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

const prefersReducedMotion = (): boolean => (
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
);

const rememberFlown = (messageId: string): void => {
    flownSendFlights.add(messageId);
    if (flownSendFlights.size > FLOWN_SEND_FLIGHT_LIMIT) {
        flownSendFlights.delete(flownSendFlights.values().next().value as string);
    }
};

const disarmIfIdle = (): void => {
    if (pendingSendFlights.size > 0) return;
    observer?.disconnect();
    observer = null;
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
};

const findBubble = (messageId: string): HTMLElement | null => (
    document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"] [data-user-message-bubble]`)
);

// The row's own mount fade would move the landing slot mid-flight; the flight is its entrance.
const settleEntrance = (bubble: HTMLElement): void => {
    for (let node: HTMLElement | null = bubble; node && !node.hasAttribute('data-message-id'); node = node.parentElement) {
        node.getAnimations?.().forEach((animation) => animation.finish());
    }
};

// Runs as a microtask after the commit that inserted the row, before paint.
const launchReady = (): void => {
    const now = Date.now();
    for (const [messageId, pending] of pendingSendFlights) {
        if (now > pending.expiresAt) {
            pendingSendFlights.delete(messageId);
            continue;
        }
        const bubble = findBubble(messageId);
        if (!bubble) continue;
        pendingSendFlights.delete(messageId);
        rememberFlown(messageId);
        settleEntrance(bubble);
        startContactSendFlight(pending.source, bubble);
    }
    disarmIfIdle();
};

/**
 * Fly the user bubble for `messageId` out of `source` when that bubble appears
 * in the transcript. Call at send time, before or after the row mounts.
 */
export const registerUserSendFlight = (messageId: string, source: ContactSendFlightSource): void => {
    if (typeof document === 'undefined' || flownSendFlights.has(messageId) || prefersReducedMotion()) return;
    pendingSendFlights.set(messageId, { source, expiresAt: Date.now() + USER_SEND_FLIGHT_TTL_MS });
    if (!observer) {
        observer = new MutationObserver(launchReady);
        observer.observe(document.body, { childList: true, subtree: true });
    }
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(launchReady, USER_SEND_FLIGHT_TTL_MS + 50);
    // The row may already be mounted (a queued chip that leaves after its row lands).
    launchReady();
};

/** Call when user triggers a send (before the API call). */
export const markPendingUserSendAnimation = (sessionId: string): void => {
    pendingCounts.set(sessionId, (pendingCounts.get(sessionId) ?? 0) + 1);
};

/** Check whether this session has pending send animations. */
export const hasPendingUserSendAnimation = (sessionId: string): boolean => {
    return (pendingCounts.get(sessionId) ?? 0) > 0;
};

/**
 * Consume one pending send animation for the session.
 * Returns true if there was one to consume.
 */
export const consumePendingUserSendAnimation = (sessionId: string): boolean => {
    const count = pendingCounts.get(sessionId) ?? 0;
    if (count <= 0) return false;
    if (count === 1) {
        pendingCounts.delete(sessionId);
    } else {
        pendingCounts.set(sessionId, count - 1);
    }
    return true;
};

/** Remember the user-message id that just consumed a send latch. */
export const rememberConsumedUserSendAnimation = (sessionId: string, messageId: string): void => {
    lastConsumedSends.set(sessionId, messageId);
};

/** Last consumed send for this session, if the park has not been released. */
export const peekConsumedUserSendAnimation = (sessionId: string): string | null => {
    return lastConsumedSends.get(sessionId) ?? null;
};

/** Drop a session's remount latch (overflow, collapse that reopens the hole, session leave). */
export const clearConsumedUserSendAnimation = (sessionId: string): void => {
    lastConsumedSends.delete(sessionId);
};

export const resetUserSendAnimationForTests = (): void => {
    pendingCounts.clear();
    lastConsumedSends.clear();
    lastUserOrders.clear();
    pendingSendFlights.clear();
    flownSendFlights.clear();
    disarmIfIdle();
};

/**
 * User-message id that should park this render.
 *
 * Pending is the send signal. The last user row is the just-sent
 * message — including when a sibling or earlier paint already stored
 * that id. After the pending count is consumed, the remembered id
 * re-latches the same send across a remount.
 */
export const resolveConsumedSendMessageId = ({
    sessionId,
    currentUserOrder,
    animatedIds,
}: {
    readonly sessionId: string;
    readonly sessionChanged: boolean;
    readonly previousUserOrder: readonly string[];
    readonly currentUserOrder: readonly string[];
    readonly animatedIds: Set<string>;
}): string | null => {
    const tracked = lastUserOrders.get(sessionId);
    let consumedSendMessageId: string | null = null;
    // Pending is the send signal — history loads never mark it. The last
    // user row is the one that was just sent, even when an earlier render
    // already recorded that id in the module order before pending landed
    // (a sibling transcript, or the optimistic row beating the mark).
    if (hasPendingUserSendAnimation(sessionId)) {
        const currentLast = currentUserOrder[currentUserOrder.length - 1];
        if (currentLast !== undefined && !animatedIds.has(currentLast)) {
            if (consumePendingUserSendAnimation(sessionId)) {
                rememberConsumedUserSendAnimation(sessionId, currentLast);
                animatedIds.add(currentLast);
                consumedSendMessageId = currentLast;
            }
        }
    }
    // An empty or shorter sibling must not erase the live order; that
    // would hide a later append from the primary transcript.
    if (!tracked || currentUserOrder.length >= tracked.length) {
        lastUserOrders.set(sessionId, currentUserOrder);
    }
    if (consumedSendMessageId !== null) return consumedSendMessageId;

    const remembered = peekConsumedUserSendAnimation(sessionId);
    if (remembered !== null) {
        if (currentUserOrder.includes(remembered)) {
            animatedIds.add(remembered);
        }
        return remembered;
    }
    return null;
};
