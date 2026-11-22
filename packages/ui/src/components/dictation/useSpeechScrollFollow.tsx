import React, { useSyncExternalStore } from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getSpeechTracking, pauseSpeechFollowing, resumeSpeechFollowing, subscribeSpeechTracking } from '@/lib/voice/speech-tracking';

const TOUCH_DRAG_THRESHOLD = 4;

/**
 * Subscribe a standalone scrollable container (such as a Markdown file preview) to
 * active speech tracking: auto-scroll the spoken passage into the middle 60%
 * reading safe zone, pause following on user scroll intent (wheel, touch drag,
 * navigation keys), and expose a floating toggle button to re-engage following.
 */
// eslint-disable-next-line react-refresh/only-export-components -- co-located hook paired with SpeechFollowButton
export function useSpeechScrollFollow(
  scrollContainer: HTMLElement | null,
  enabled = true,
) {
  const touchStartYRef = React.useRef<number | null>(null);

  const followSpeech = useEvent(() => {
    const speech = getSpeechTracking();
    if (!enabled || !scrollContainer || !speech || !scrollContainer.contains(speech.target)) return;
    if (!speech.following || !speech.range || touchStartYRef.current !== null) return;
    const { scrollTop, clientHeight, scrollHeight } = scrollContainer;
    if (scrollHeight - clientHeight <= 1) return;
    const rect = speech.range.getBoundingClientRect?.();
    if (!rect || !rect.height) return;
    const viewport = scrollContainer.getBoundingClientRect();
    const inset = clientHeight * 0.2;
    const trackedHeight = Math.min(rect.height, clientHeight - inset * 2);
    if (rect.top >= viewport.top + inset && rect.top + trackedHeight <= viewport.bottom - inset) return;
    const landingInset = (clientHeight - trackedHeight) / 2;
    const nextTop = Math.min(
      scrollHeight - clientHeight,
      Math.max(0, scrollTop + rect.top - viewport.top - landingInset),
    );
    if (Math.abs(nextTop - scrollTop) <= 1) return;
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    scrollContainer.scrollTo({ top: nextTop, behavior: reducedMotion ? 'instant' : 'smooth' });
  });

  React.useEffect(() => {
    if (!enabled || !scrollContainer) return;
    followSpeech();
    return subscribeSpeechTracking(followSpeech);
  }, [enabled, scrollContainer, followSpeech]);

  const handleWheel = useEvent((event: WheelEvent) => {
    if (scrollContainer && event.deltaY !== 0) pauseSpeechFollowing(scrollContainer);
  });

  const handleTouchStart = useEvent((event: TouchEvent) => {
    touchStartYRef.current = event.touches.item(0)?.clientY ?? null;
  });

  const handleTouchMove = useEvent((event: TouchEvent) => {
    const startY = touchStartYRef.current;
    const touch = event.touches.item(0);
    if (startY === null || !touch || !scrollContainer) return;
    if (Math.abs(touch.clientY - startY) > TOUCH_DRAG_THRESHOLD) {
      pauseSpeechFollowing(scrollContainer);
    }
  });

  const handleTouchEnd = useEvent(() => {
    touchStartYRef.current = null;
  });

  const handleKeyDown = useEvent((event: KeyboardEvent) => {
    if (!scrollContainer || event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      pauseSpeechFollowing(scrollContainer);
    }
  });

  React.useEffect(() => {
    if (!enabled || !scrollContainer) return;
    const passiveCapture = { passive: true, capture: true } as const;
    scrollContainer.addEventListener('wheel', handleWheel, passiveCapture);
    scrollContainer.addEventListener('touchstart', handleTouchStart, passiveCapture);
    scrollContainer.addEventListener('touchmove', handleTouchMove, passiveCapture);
    scrollContainer.addEventListener('touchend', handleTouchEnd, passiveCapture);
    scrollContainer.addEventListener('touchcancel', handleTouchEnd, passiveCapture);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      scrollContainer.removeEventListener('wheel', handleWheel, passiveCapture);
      scrollContainer.removeEventListener('touchstart', handleTouchStart, passiveCapture);
      scrollContainer.removeEventListener('touchmove', handleTouchMove, passiveCapture);
      scrollContainer.removeEventListener('touchend', handleTouchEnd, passiveCapture);
      scrollContainer.removeEventListener('touchcancel', handleTouchEnd, passiveCapture);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [enabled, scrollContainer, handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd, handleKeyDown]);
}

/** Floating follow-reading button scoped to a standalone scroll container. */
export const SpeechFollowButton = React.memo(function SpeechFollowButton({
  scrollContainer,
  className,
}: {
  scrollContainer: HTMLElement | null;
  className?: string;
}) {
  const speech = useSyncExternalStore(subscribeSpeechTracking, getSpeechTracking, () => null);
  const { t } = useI18n();
  const show = speech !== null && Boolean(scrollContainer?.contains(speech.target));
  if (!show) return null;

  return (
    <div className={cn('yuri-transcript-scroll-controls pointer-events-none absolute right-4 bottom-4 z-20', className)}>
      <Button
        type="button"
        size="mobileIcon"
        variant="mobileGlass"
        className={cn('pointer-events-auto', speech.following && 'yuri-speech-follow-active')}
        aria-pressed={speech.following}
        aria-label={t('chat.messageBody.tts.follow')}
        title={t('chat.messageBody.tts.follow')}
        onClick={() => {
          if (speech.following && scrollContainer) pauseSpeechFollowing(scrollContainer);
          else resumeSpeechFollowing();
        }}
      >
        <Icon name="target" weight="medium" className="size-5" />
      </Button>
    </div>
  );
});
