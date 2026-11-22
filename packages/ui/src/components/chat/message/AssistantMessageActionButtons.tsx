import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ReadAloudButton } from '@/components/dictation/ReadAloudButton';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { AutoReadPlaybackContext } from '@/mobile/chat/auto-read-context';
import { useConfigStore } from '@/stores/useConfigStore';
import { useChatSurfaceMode } from '../useChatSurfaceMode';
import { getSessionSurfaceActionAvailability, useSessionSurface } from '../SessionSurfaceContext';
import { MESSAGE_ACTION_ICON_BUTTON_CLASS, MESSAGE_ACTION_ICON_CLASS, MESSAGE_ACTION_ICON_WEIGHT } from './AssistantMessageFooter';

interface AssistantMessageActionButtonsProps {
    messageId?: string;
    hasCopyableText: boolean;
    isTouchContext: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    ttsText: string;
    /** Source OpenCode session for hosted Assistant replies; omitted for primary chat. */
    sessionId?: string;
    allowSourceSession?: boolean;
}

export const AssistantMessageActionButtons = React.memo(({
    messageId, hasCopyableText, isTouchContext, onCopyMessage, ttsText, sessionId, allowSourceSession = true,
}: AssistantMessageActionButtonsProps) => {
    const { t } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const sessionSurface = useSessionSurface();
    const sessionSurfaceActions = getSessionSurfaceActionAvailability(sessionSurface);
    const autoReadPlayback = React.useContext(AutoReadPlaybackContext);
    const isAutoReadPlaying = Boolean(autoReadPlayback && autoReadPlayback.sessionId === sessionId && autoReadPlayback.messageId === messageId);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const [isMessageCopied, setIsMessageCopied] = React.useState(false);
    const ttsAnchorRef = React.useRef<HTMLSpanElement | null>(null);
    const copyHintTimeoutRef = React.useRef<number | null>(null);
    const copiedResetTimeoutRef = React.useRef<number | null>(null);
    const canCopyMessage = Boolean(onCopyMessage);
    // Prefer the surface session/directory: history rows rebind the surface to
    // sourceSessionID + sourceDirectory, while live Assistant replies use the host
    // binding. message.info.sessionID alone can lag or disagree with the surface.
    const openSourceSessionId = sessionSurface.sessionId || sessionId;
    const canOpenSourceSession = Boolean(
        allowSourceSession && openSourceSessionId && sessionSurface.directory
        && sessionSurfaceActions.openSourceSession && chatSurfaceMode !== 'mini-chat',
    );
    const clearCopyHintTimeout = useEvent(() => {
        if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copyHintTimeoutRef.current);
            copyHintTimeoutRef.current = null;
        }
    });
    const clearCopiedResetTimeout = useEvent(() => {
        if (copiedResetTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copiedResetTimeoutRef.current);
            copiedResetTimeoutRef.current = null;
        }
    });
    React.useEffect(() => () => {
        clearCopyHintTimeout();
        clearCopiedResetTimeout();
    }, [clearCopiedResetTimeout, clearCopyHintTimeout]);
    React.useEffect(() => {
        if (!hasCopyableText || !canCopyMessage) {
            setCopyHintVisible(false);
            setIsMessageCopied(false);
            clearCopyHintTimeout();
            clearCopiedResetTimeout();
        }
    }, [canCopyMessage, clearCopiedResetTimeout, clearCopyHintTimeout, hasCopyableText]);
    const revealCopyHint = useEvent(() => {
        if (!isTouchContext || !canCopyMessage || !hasCopyableText || typeof window === 'undefined') return;
        clearCopyHintTimeout();
        setCopyHintVisible(true);
        copyHintTimeoutRef.current = window.setTimeout(() => {
            setCopyHintVisible(false);
            copyHintTimeoutRef.current = null;
        }, 1800);
    });
    const handleCopyButtonClick = useEvent(async (event: React.MouseEvent<HTMLButtonElement>) => {
        if (!onCopyMessage || !hasCopyableText) return;
        event.stopPropagation();
        event.preventDefault();
        const copied = await onCopyMessage();
        if (copied === false) return;
        clearCopiedResetTimeout();
        setIsMessageCopied(true);
        if (typeof window !== 'undefined') {
            copiedResetTimeoutRef.current = window.setTimeout(() => {
                setIsMessageCopied(false);
                copiedResetTimeoutRef.current = null;
            }, 2000);
        }
        if (isTouchContext) revealCopyHint();
    });
    // Jump from a stitched Assistant reply into the underlying OpenCode session.
    const handleOpenSourceSessionClick = useEvent((event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        event.preventDefault();
        const targetSessionId = sessionSurface.sessionId || sessionId;
        if (!allowSourceSession || !targetSessionId || !sessionSurface.directory || !sessionSurface.openSourceSession) return;
        sessionSurface.openSourceSession(targetSessionId, sessionSurface.directory);
    });
    const getSpeechTarget = useEvent(() => ttsAnchorRef.current?.closest<HTMLElement>('[data-message-text-export-root]') ?? undefined);
    return <>
        {onCopyMessage && <Tooltip>
            <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon"
                    data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                    className={cn(MESSAGE_ACTION_ICON_BUTTON_CLASS, !hasCopyableText && 'opacity-50')}
                    disabled={!hasCopyableText} aria-label={t('chat.messageBody.actions.copyMessageAria')} aria-hidden={!hasCopyableText}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => { void handleCopyButtonClick(event); }}
                    onFocus={() => { if (hasCopyableText) setCopyHintVisible(true); }}
                    onBlur={() => { if (!isMessageCopied) setCopyHintVisible(false); }}>
                    {isMessageCopied
                        ? <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="check" className={cn(MESSAGE_ACTION_ICON_CLASS, 'text-[color:var(--status-success)]')} />
                        : <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="file-copy" className={MESSAGE_ACTION_ICON_CLASS} />}
                </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyAnswer')}</TooltipContent>
        </Tooltip>}
        {canOpenSourceSession ? <Tooltip>
            <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className={MESSAGE_ACTION_ICON_BUTTON_CLASS}
                    aria-label={t('chat.messageBody.actions.openSourceSessionAria')}
                    onPointerDown={(event) => event.stopPropagation()} onClick={handleOpenSourceSessionClick}>
                    <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="target" className={MESSAGE_ACTION_ICON_CLASS} />
                </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.openSourceSession')}</TooltipContent>
        </Tooltip> : null}
        {chatSurfaceMode !== 'mini-chat' && showMessageTTSButtons && hasCopyableText && ttsText.trim() && (
            <span ref={ttsAnchorRef} className="inline-flex">
                <ReadAloudButton
                    text={ttsText}
                    getTarget={getSpeechTarget}
                    isTouchContext={isTouchContext}
                    externalActive={isAutoReadPlaying}
                    onExternalStop={autoReadPlayback?.stop}
                    menuSide="top"
                    menuAlign="start"
                    buttonClassName={MESSAGE_ACTION_ICON_BUTTON_CLASS}
                    iconClassName={MESSAGE_ACTION_ICON_CLASS}
                    stopPropagation
                />
            </span>
        )}
    </>;
});
