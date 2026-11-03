import { createContext, useContext, useEffect, type RefObject } from 'react';

export type RenderedReply = { sessionId: string; messageId: string; created: number; text: string; target?: HTMLElement };
type AutoReadContext = { enabled: boolean; available: boolean; toggle: () => void; streaming: (sessionId: string, messageId: string) => void; rendered: (reply: RenderedReply) => void };
export const AutoReadContext = createContext<AutoReadContext | null>(null);
export const AutoReadPlaybackContext = createContext<{ sessionId: string; messageId: string; stop: () => void } | null>(null);

/** Called from the committed, settled assistant body, never from persisted status alone. */
export function useAutoReadRenderedReply({ sessionId, messageId, created, text, completed, streaming = false, targetRef }: RenderedReply & { completed: boolean; streaming?: boolean; targetRef?: RefObject<HTMLElement | null> }) {
    const context = useContext(AutoReadContext);
    useEffect(() => {
        if (!context?.enabled) return;
        if (streaming) context.streaming(sessionId, messageId);
        if (!completed) return;
        let second = 0;
        const first = requestAnimationFrame(() => {
            second = requestAnimationFrame(() => context.rendered({ sessionId, messageId, created, text, target: targetRef?.current ?? undefined }));
        });
        return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    }, [context, sessionId, messageId, created, text, completed, streaming, targetRef]);
}
