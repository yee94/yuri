import { cleanup, computed, createMotion, effect, lifecycle, reduceMotion, token, untracked, View } from 'nsh';
import { AssistantAvatar } from './assistants-avatar-live';
import { t } from './i18n';
import type { Row } from './model';
import { desktopAssistantSendFeedbackGeometry as geometry, desktopAssistantSendFeedbackState } from './desktop-assistant-send-feedback-model';

export type NativeDesktopAssistantSendFeedbackProps = {
  sending: boolean;
  processing: boolean;
  current: () => boolean;
  bot: Row;
  sameScopeSendFlight?: boolean;
};

function dotColor() {
  const color = token('muted-foreground'), match = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(color);
  return match ? `#${match[1]}${Math.round((match[2] ? parseInt(match[2], 16) : 255) * .7).toString(16).padStart(2, '0')}` : color;
}

function Processing(props: { bot: Row; current: () => boolean }) {
  const motion = createMotion();
  effect(() => {
    const reduced = reduceMotion();
    untracked(() => {
      motion.reset();
      if (!reduced) void motion.play({ keyframes: [{ opacity: 0, scale: .8 }, { opacity: 1, scale: 1 }], duration: geometry.enterDuration, easing: 'easeOut' });
    });
  });
  cleanup(() => motion.stop());
  return <View testID="desktop-assistant-processing-feedback" accessible role="text"
    accessibilityState={{ busy: true }} accessibilityLabel={t('assistants.contact.processing')}
    class="relative flex-row items-center bg-muted"
    style={{ ...motion.style, height: geometry.bubbleHeight, width: geometry.bubbleWidth, paddingHorizontal: geometry.bubblePadding,
      gap: geometry.dotGap, borderRadius: geometry.bubbleRadius, transformOrigin: 'left bottom', pointerEvents: 'none' }}>
    <View testID="desktop-assistant-processing-avatar-slot" accessible={false} class="absolute items-center"
      style={{ left: geometry.avatarLeft, top: geometry.avatarTop, width: geometry.avatarSlotWidth }}>
      <AssistantAvatar bot={props.bot} size={geometry.avatarSize} active={props.current()} testID="desktop-assistant-processing-avatar" />
    </View>
    <Each of={geometry.pulseDelays}>{(delay, index) => <View testID={`desktop-assistant-processing-dot-${index()}`} accessible={false}
      style={{ width: geometry.dotSize, height: geometry.dotSize, borderRadius: geometry.dotSize / 2, backgroundColor: dotColor(),
        animationName: !reduceMotion() ? 'pulse' : 'none', animationDuration: geometry.pulseDuration,
        animationDelay: delay(), animationIterationCount: 'infinite' }} />}</Each>
  </View>;
}

/** Mount in the caller's exact transcript column overlay, never in a List header.
 * Sending feedback remains with the original message/send button. No flight is invented. */
export function NativeDesktopAssistantSendFeedback(props: NativeDesktopAssistantSendFeedbackProps) {
  const state = computed(() => desktopAssistantSendFeedbackState({ sending: props.sending, processing: props.processing,
    current: props.current() && lifecycle() === 'active', sameScopeSendFlight: props.sameScopeSendFlight }));
  return <View testID="desktop-assistant-send-feedback-slot" accessible={false} class="absolute justify-center"
    style={{ left: geometry.slotLeft, bottom: geometry.slotBottom, width: geometry.bubbleWidth, height: geometry.slotHeight, pointerEvents: 'none' }}>
    <If when={state() === 'processing'}><Processing bot={props.bot} current={props.current} /></If>
  </View>;
}
