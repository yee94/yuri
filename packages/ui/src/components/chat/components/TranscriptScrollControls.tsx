import React, { useSyncExternalStore } from 'react';
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
    const showSpeechFollow = speech !== null && Boolean(scrollRef.current?.contains(speech.target));
    if (!active || (!showSpeechFollow && !showScrollToBottom)) return null;
    return (
        <div className="yuri-transcript-scroll-controls absolute inset-x-0 bottom-full mb-2 pointer-events-none">
            <div className="chat-input-column flex items-center justify-end gap-2">
                {showScrollToBottom && <Button size="mobileIcon" variant="mobileGlass" className="pointer-events-auto"
                    onClick={onScrollToBottom} aria-label={t('chat.scrollToBottom.aria')} title={t('chat.scrollToBottom.aria')}>
                    <Icon name="arrow-down" weight="medium" className="size-5" />
                </Button>}
                {showSpeechFollow && <Button size="mobileIcon" variant="mobileGlass"
                    className={`pointer-events-auto${speech?.following ? ' yuri-mobile-inverse-action' : ''}`} aria-pressed={speech?.following}
                    onClick={() => {
                        if (speech?.following && scrollRef.current) pauseSpeechFollowing(scrollRef.current);
                        else resumeSpeechFollowing();
                    }} aria-label={t('chat.messageBody.tts.follow')}
                    title={t('chat.messageBody.tts.follow')}>
                    <Icon name="target" weight="medium" className="size-5" />
                </Button>}
            </div>
        </div>
    );
});
