import React from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { VoiceActivityIcon } from '@/components/dictation/VoiceActivityIcon';
import { Icon } from '@/components/icon/Icon';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';

export interface ReadAloudButtonProps {
  /** Text to read aloud. */
  text: string;
  /** Resolve the relative speech owner element containing `[data-speech-content]`. */
  getTarget?: () => HTMLElement | null | undefined;
  /** True on touch/mobile surfaces so Resume/Restart menu items keep a 44px hit height. */
  isTouchContext?: boolean;
  /** Active state from an external owner such as mobile auto-read. */
  externalActive?: boolean;
  /** Stop callback for an external owner before stopping manual playback. */
  onExternalStop?: () => void;
  /** Accessible label when idle; defaults to message read-aloud. */
  readAloudLabel?: string;
  /** Accessible label when playing; defaults to stop speaking. */
  stopSpeakingLabel?: string;
  /** Tooltip label when idle; defaults to provider-qualified message read-aloud. */
  tooltipLabel?: string;
  /** Show a desktop tooltip around the trigger. */
  showTooltip?: boolean;
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
  tooltipSideOffset?: number;
  menuSide?: 'top' | 'bottom' | 'left' | 'right';
  menuAlign?: 'start' | 'center' | 'end';
  buttonSize?: React.ComponentProps<typeof Button>['size'];
  buttonClassName?: string;
  iconClassName?: string;
  stopPropagation?: boolean;
}

export const ReadAloudButton = React.memo(function ReadAloudButton({
  text,
  getTarget,
  isTouchContext = false,
  externalActive = false,
  onExternalStop,
  readAloudLabel,
  stopSpeakingLabel,
  tooltipLabel,
  showTooltip = true,
  tooltipSide = 'top',
  tooltipSideOffset = 6,
  menuSide = 'bottom',
  menuAlign = 'end',
  buttonSize = 'icon',
  buttonClassName,
  iconClassName = 'size-4',
  stopPropagation = false,
}: ReadAloudButtonProps) {
  const { t } = useI18n();
  const { isPlaying: isManualTTSPlaying, play: playTTS, stop: stopTTS, canResume: canResumeTTS } = useMessageTTS();
  const voiceProvider = useConfigStore((state) => state.voiceProvider);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const isPlaying = isManualTTSPlaying || externalActive;

  const idleLabel = readAloudLabel ?? t('chat.messageBody.tts.readAloud');
  const activeLabel = stopSpeakingLabel ?? t('chat.messageBody.tts.stopSpeaking');
  const resolvedTooltip = React.useMemo(() => {
    if (isPlaying) return activeLabel;
    if (tooltipLabel) return tooltipLabel;
    const providerLabel = voiceProvider === 'browser' ? 'Browser' : voiceProvider === 'openai' ? 'OpenAI' : voiceProvider === 'openai-compatible' ? 'Custom' : 'Say';
    return t('chat.messageBody.tts.readAloudWithProvider', { provider: providerLabel });
  }, [activeLabel, isPlaying, t, tooltipLabel, voiceProvider]);

  const start = useEvent((restart = false) => {
    setMenuOpen(false);
    if (!text.trim()) return;
    const target = getTarget?.() ?? undefined;
    void playTTS(text, (error) => { if (error) toast.error(t('chat.messageBody.tts.failed')); }, { target, restart });
  });

  const handleOpenChange = useEvent((open: boolean, details: Parameters<NonNullable<React.ComponentProps<typeof DropdownMenu>['onOpenChange']>>[1]) => {
    if (!open) { setMenuOpen(false); return; }
    if (isPlaying) {
      details.cancel();
      if (externalActive) onExternalStop?.();
      stopTTS();
      return;
    }
    const target = getTarget?.() ?? undefined;
    if (canResumeTTS(text, target)) { setMenuOpen(true); return; }
    details.cancel();
    start(false);
  });

  const triggerButton = (
    <Button
      type="button"
      variant="ghost"
      size={buttonSize}
      className={cn(
        '!bg-transparent shadow-none',
        isPlaying ? 'text-[var(--primary-base)]' : 'hover:text-foreground/80',
        buttonClassName,
      )}
      aria-label={isPlaying ? activeLabel : idleLabel}
      aria-pressed={isPlaying}
      onPointerDown={stopPropagation ? (event) => event.stopPropagation() : undefined}
      onClick={stopPropagation ? (event) => event.stopPropagation() : undefined}
    >
      <VoiceActivityIcon kind="speaker" active={isPlaying} className={iconClassName} />
    </Button>
  );

  return (
    <DropdownMenu open={menuOpen && !isPlaying} onOpenChange={handleOpenChange} modal={false}>
      {showTooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide} sideOffset={tooltipSideOffset}>{resolvedTooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        side={menuSide}
        align={menuAlign}
        sideOffset={6}
        onClick={stopPropagation ? (event) => event.stopPropagation() : undefined}
      >
        <DropdownMenuItem className={isTouchContext ? 'min-h-11 px-3' : undefined} onSelect={() => start(false)}>
          <Icon name="play" weight="medium" className="size-4" />{t('chat.messageBody.tts.resume')}
        </DropdownMenuItem>
        <DropdownMenuItem className={isTouchContext ? 'min-h-11 px-3' : undefined} onSelect={() => start(true)}>
          <Icon name="restart" weight="medium" className="size-4" />{t('chat.messageBody.tts.restart')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
