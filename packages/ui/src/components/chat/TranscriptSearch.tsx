import React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { ChatMessageEntry } from './lib/turns/types';
import { createTranscriptSearcher } from './lib/transcriptSearch';
import { TranscriptSearchContext } from './TranscriptSearchContext';

interface TranscriptSearchProps {
    messages: readonly ChatMessageEntry[];
    enabled: boolean;
    canOpen: (event: KeyboardEvent) => boolean;
    onNavigate: () => void;
    children: React.ReactNode;
}

export function TranscriptSearch({ messages, enabled, canOpen, onNavigate, children }: TranscriptSearchProps) {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const deferredQuery = React.useDeferredValue(query);
    const [index, setIndex] = React.useState(0);
    const [navigationId, setNavigationId] = React.useState(0);
    if (!enabled && open) setOpen(false);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const searchRef = React.useRef<HTMLDivElement>(null);
    const previousFocus = React.useRef<HTMLElement | null>(null);
    const visible = enabled && open;
    const search = React.useMemo(() => visible ? createTranscriptSearcher(deferredQuery) : null, [visible, deferredQuery]);
    const results = React.useMemo(() => search?.(messages) ?? [], [search, messages]);
    const selected = Math.min(index, Math.max(0, results.length - 1));
    const match = visible && query === deferredQuery ? results[selected] ?? null : null;
    const messageId = match?.messageId;
    const partId = match?.partId;
    const occurrence = match?.occurrence;
    const matchQuery = match?.query;
    // Streaming updates can replace results without changing the selected hit.
    const target = React.useMemo(() => messageId !== undefined && partId !== undefined && occurrence !== undefined && matchQuery !== undefined
        ? { messageId, partId, occurrence, query: matchQuery, navigationId } : null,
    [messageId, partId, occurrence, matchQuery, navigationId]);
    const close = useEvent(() => {
        setOpen(false);
        if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    });
    const navigate = useEvent((direction: number) => {
        if (!results.length) return;
        onNavigate();
        setIndex((selected + direction + results.length) % results.length);
        setNavigationId((value) => value + 1);
    });
    useEventListener('keydown', (event: KeyboardEvent) => {
        if (!enabled || event.defaultPrevented || event.isComposing) return;
        if (!(event.target instanceof Node && searchRef.current?.contains(event.target)) && !canOpen(event)) return;
        const primaryModifierOnly = event.metaKey !== event.ctrlKey;
        if (primaryModifierOnly && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            event.stopPropagation();
            if (!visible) {
                previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                onNavigate();
                setOpen(true);
            } else {
                inputRef.current?.focus({ preventScroll: true });
                inputRef.current?.select();
            }
        } else if (visible && event.key === 'Escape') {
            event.preventDefault();
            close();
        }
    });
    React.useEffect(() => {
        if (visible) inputRef.current?.focus({ preventScroll: true });
    }, [visible]);

    return <TranscriptSearchContext.Provider value={target}>
        {children}
        {visible && <div ref={searchRef} role="search" aria-label={t('chat.find.label')} className="yuri-transcript-find yuri-mobile-overlay-surface yuri-popup-surface absolute right-3 top-3 z-30 w-[min(22rem,calc(100%-1.5rem))] overflow-hidden rounded-2xl">
            <div className="flex items-center gap-2 px-3 py-1.5">
                <Icon name="search" className="size-4 shrink-0 text-foreground" />
                <Input ref={inputRef} bordered={false} value={query} aria-label={t('chat.find.label')} placeholder={t('chat.find.label')}
                    onChange={(event) => { onNavigate(); setQuery(event.target.value); setIndex(0); }}
                    onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            close();
                        } else if (event.key === 'Enter') {
                            event.preventDefault();
                            navigate(event.shiftKey ? -1 : 1);
                        }
                    }} />
                <div className="yuri-transcript-find-close pl-1.5">
                    <Button variant="ghost" size="icon" aria-label={t('chat.find.close')} onClick={close}><Icon name="close" className="size-4" /></Button>
                </div>
            </div>
            <div className="yuri-transcript-find-navigation flex items-center gap-0.5 px-2 py-0.5">
                <Button variant="ghost" size="icon" disabled={!results.length || query !== deferredQuery} aria-label={t('chat.find.previous')} onClick={() => navigate(-1)}><Icon name="arrow-up" className="size-4" /></Button>
                <Button variant="ghost" size="icon" disabled={!results.length || query !== deferredQuery} aria-label={t('chat.find.next')} onClick={() => navigate(1)}><Icon name="arrow-down" className="size-4" /></Button>
                <span className="ml-auto pr-2 typography-meta tabular-nums text-muted-foreground" role="status" aria-live="polite">
                    {t('chat.find.count', { current: results.length ? selected + 1 : 0, total: results.length })}
                </span>
            </div>
        </div>}
    </TranscriptSearchContext.Provider>;
}
