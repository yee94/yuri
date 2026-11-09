export type DesktopAssistantSendFeedbackState = 'inactive' | 'sending' | 'flight' | 'processing' | 'idle';

/** Only live owner inputs decide presence. Failed/history rows are not activity authority. */
export function desktopAssistantSendFeedbackState(input: {
  sending: boolean;
  processing: boolean;
  current: boolean;
  sameScopeSendFlight?: boolean;
}): DesktopAssistantSendFeedbackState {
  if (!input.current) return 'inactive';
  if (input.sending) return 'sending';
  if (input.sameScopeSendFlight === true) return 'flight';
  return input.processing ? 'processing' : 'idle';
}

/** AssistantConversationSurface's status slot, not transcript/List padding. */
export const desktopAssistantSendFeedbackGeometry = Object.freeze({
  slotLeft: 46, slotBottom: 4, slotHeight: 40,
  bubbleHeight: 36, bubbleWidth: 58, bubbleRadius: 21.6,
  bubblePadding: 16, dotSize: 6, dotGap: 4,
  avatarSlotWidth: 36, avatarSize: 32, avatarLeft: -46, avatarTop: 2,
  pulseDuration: 1400, pulseDelays: [-450, -220, 0] as readonly number[],
  enterDuration: 180,
});
