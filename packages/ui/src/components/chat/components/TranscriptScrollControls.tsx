import React, { useSyncExternalStore } from 'react';
import { useEvent, useResizeObserver } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getSpeechTracking, pauseSpeechFollowing, resumeSpeechFollowing, subscribeSpeechTracking } from '@/lib/voice/speech-tracking';

export const TranscriptScrollControls = React.memo(function TranscriptScrollControls({ scrollRef, active, showScrollToBottom, onScrollToBottom }: {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    active: boolean;
    showScrollToBottom: boolean;
    onScrollToBottom: () => void;
}) {
    const speech = useSyncExternalStore(subscribeSpeechTracking, getSpeechTracking, () => null);
    const { t } = useI18n();
    const controlsRef = React.useRef<HTMLDivElement | null>(null);
    const [composer, setComposer] = React.useState<HTMLElement | null>(null);
    const attachControls = useEvent((element: HTMLDivElement | null) => {
        controlsRef.current = element;
        setComposer(element?.parentElement?.querySelector<HTMLElement>('.yuri-mobile-composer') ?? null);
    });
    const measureCompactAnchor = useEvent(() => {
        const controls = controlsRef.current;
        const stack = composer?.querySelector<HTMLElement>('.yuri-mobile-composer-stack');
        const pill = composer?.querySelector<HTMLElement>('.yuri-mobile-composer-compact-layer');
        if (!controls || !stack || !pill || !pill.offsetHeight) return;
        const foot = controls.parentElement!;
        const inset = foot.getBoundingClientRect().bottom - stack.getBoundingClientRect().bottom
            + (Number.parseFloat(getComputedStyle(pill).bottom) || 0) + pill.offsetHeight;
        const value = `${inset}px`;
        if (controls.style.getPropertyValue('--yuri-transcript-compact-inset') !== value) {
            controls.style.setProperty('--yuri-transcript-compact-inset', value);
        }
    });
    useResizeObserver(composer, measureCompactAnchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- composer attachment owns measurement; the handler is useEvent-stable.
    React.useLayoutEffect(() => { measureCompactAnchor(); }, [composer]);
    const showSpeechFollow = speech !== null && Boolean(scrollRef.current?.contains(speech.target));
    if (!active || (!showSpeechFollow && !showScrollToBottom)) return null;
    return (
        <div ref={attachControls} className="yuri-transcript-scroll-controls absolute inset-x-0 bottom-full mb-2 pointer-events-none">
            <div className="chat-input-column">
                <div className="yuri-transcript-scroll-controls-row mx-auto flex items-center justify-end gap-2">
                    {showScrollToBottom && <Button size="mobileIcon" variant="mobileGlass" className="pointer-events-auto"
                        onClick={onScrollToBottom} aria-label={t('chat.scrollToBottom.aria')} title={t('chat.scrollToBottom.aria')}>
                        <Icon name="arrow-down" weight="medium" className="size-5" />
                    </Button>}
                    {showSpeechFollow && <Button size="mobileIcon" variant="mobileGlass"
                        className={`pointer-events-auto${speech?.following ? ' yuri-speech-follow-active' : ''}`} aria-pressed={speech?.following}
                        onClick={() => {
                            if (speech?.following && scrollRef.current) pauseSpeechFollowing(scrollRef.current);
                            else resumeSpeechFollowing();
                        }} aria-label={t('chat.messageBody.tts.follow')}
                        title={t('chat.messageBody.tts.follow')}>
                        <Icon name="target" weight="medium" className="size-5" />
                    </Button>}
                </div>
            </div>
        </div>
    );
});
