import React from 'react';
import { resolveTurnOffsetTarget } from './chatTurnNavigationCore';

type ChatHashTarget =
    | { kind: 'turn'; id: string }
    | { kind: 'message'; id: string };

const parseChatHashTarget = (hashValue: string): ChatHashTarget | null => {
    const value = hashValue.startsWith('#') ? hashValue.slice(1) : hashValue;
    if (!value) {
        return null;
    }

    const turnMatch = value.match(/^turn-(.+)$/);
    if (turnMatch?.[1]) {
        return { kind: 'turn', id: turnMatch[1] };
    }

    const messageMatch = value.match(/^message-(.+)$/);
    if (messageMatch?.[1]) {
        return { kind: 'message', id: messageMatch[1] };
    }

    return null;
};

const setHash = (hash: string | null): void => {
    if (typeof window === 'undefined') {
        return;
    }

    const nextHash = hash ? `#${hash}` : '';
    const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
    window.history.replaceState(window.history.state, '', nextUrl);
    if (hash) {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
};

/** Point the open chat at a message. The timeline applies `#message-<id>` once the turn exists. */
export const focusChatMessage = (messageId: string): void => {
    if (!messageId) return;
    setHash(`message-${messageId}`);
};

interface UseChatTurnNavigationOptions {
    sessionId: string | null;
    turnIds: string[];
    activeTurnId: string | null;
    scrollToTurn: (turnId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    resumeToBottom: () => void;
}

export interface ChatTurnNavigation {
    scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior; updateHash?: boolean }) => Promise<boolean>;
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior; updateHash?: boolean }) => Promise<boolean>;
    scrollByTurnOffset: (offset: number, options?: { resumePastEnd?: boolean }) => Promise<boolean>;
    resumeToLatest: () => void;
}

export const useChatTurnNavigation = ({
    sessionId,
    turnIds,
    activeTurnId,
    scrollToTurn,
    scrollToMessage,
    resumeToBottom,
}: UseChatTurnNavigationOptions): ChatTurnNavigation => {
    const turnIdsRef = React.useRef(turnIds);
    const activeTurnIdRef = React.useRef(activeTurnId);

    React.useEffect(() => {
        turnIdsRef.current = turnIds;
    }, [turnIds]);

    React.useEffect(() => {
        activeTurnIdRef.current = activeTurnId;
    }, [activeTurnId]);

    const scrollToTurnId = React.useCallback(async (
        turnId: string,
        options?: { behavior?: ScrollBehavior; updateHash?: boolean },
    ): Promise<boolean> => {
        if (!turnId) {
            return false;
        }

        if (options?.updateHash !== false) {
            setHash(`turn-${turnId}`);
        }

        return scrollToTurn(turnId, { behavior: options?.behavior });
    }, [scrollToTurn]);

    const scrollToMessageId = React.useCallback(async (
        messageId: string,
        options?: { behavior?: ScrollBehavior; updateHash?: boolean },
    ): Promise<boolean> => {
        if (!messageId) {
            return false;
        }

        if (options?.updateHash !== false) {
            setHash(`message-${messageId}`);
        }

        return scrollToMessage(messageId, { behavior: options?.behavior });
    }, [scrollToMessage]);

    const scrollByTurnOffset = React.useCallback(async (
        offset: number,
        options?: { resumePastEnd?: boolean },
    ): Promise<boolean> => {
        const turnIds = turnIdsRef.current;
        const target = resolveTurnOffsetTarget(turnIds, activeTurnIdRef.current, offset);

        if (target.kind === 'noop') {
            return offset === 0;
        }

        if (target.kind === 'resume') {
            if (options?.resumePastEnd === false) {
                const lastTurnId = turnIds[turnIds.length - 1];
                return lastTurnId ? scrollToTurnId(lastTurnId, { behavior: 'auto' }) : false;
            }

            setHash(null);
            resumeToBottom();
            return true;
        }

        return scrollToTurnId(target.turnId, { behavior: 'auto' });
    }, [resumeToBottom, scrollToTurnId]);

    const resumeToLatest = React.useCallback(() => {
        setHash(null);
        resumeToBottom();
    }, [resumeToBottom]);

    React.useEffect(() => {
        if (!sessionId || typeof window === 'undefined') {
            return;
        }

        const applyHash = () => {
            const target = parseChatHashTarget(window.location.hash);
            if (!target) {
                return;
            }

            if (target.kind === 'turn') {
                void scrollToTurnId(target.id, { behavior: 'auto', updateHash: false });
                return;
            }

            void scrollToMessageId(target.id, { behavior: 'auto', updateHash: false });
        };

        applyHash();
        window.addEventListener('hashchange', applyHash);
        return () => {
            window.removeEventListener('hashchange', applyHash);
        };
    }, [sessionId, scrollToMessageId, scrollToTurnId, turnIds.length]);

    return {
        scrollToTurnId,
        scrollToMessageId,
        scrollByTurnOffset,
        resumeToLatest,
    };
};
