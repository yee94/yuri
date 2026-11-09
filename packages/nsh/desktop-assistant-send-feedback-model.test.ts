import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { desktopAssistantSendFeedbackGeometry as geometry, desktopAssistantSendFeedbackState as state } from './desktop-assistant-send-feedback-model';

test('live priority: inactive, sending, captured flight, processing, idle; flight defaults false', () => {
  for (const sending of [false, true]) for (const processing of [false, true]) for (const flight of [false, true]) {
    expect(state({ current: false, sending, processing, sameScopeSendFlight: flight })).toBe('inactive');
    expect(state({ current: true, sending, processing, sameScopeSendFlight: flight })).toBe(sending ? 'sending' : flight ? 'flight' : processing ? 'processing' : 'idle');
  }
  expect(state({ current: true, sending: false, processing: true })).toBe('processing');
  // A failed historical row is not an input. Its settled live flags produce idle.
  expect(state({ current: true, sending: false, processing: false })).toBe('idle');
});

test('geometry and gating remain tied to the actual Web status slot, not a new design', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const web = readFileSync(path.join(root, '../ui/src/components/assistants/AssistantConversationSurface.tsx'), 'utf8');
  const slot = web.slice(web.indexOf('data-assistant-contact-status-slot'), web.indexOf('</footer>'));
  expect(web).toContain('pointer-events-none absolute bottom-1 left-[2.875rem] flex h-10 items-center');
  expect(slot).toContain('!sending && sendFlight?.scope !== entryScope && (processing || serverWorking)');
  expect(slot).toContain('h-9 origin-bottom-left items-center gap-1');
  expect(slot).toContain('rounded-[1.35rem]');
  expect(slot).toContain('absolute -left-[2.875rem] top-0.5 flex w-9');
  expect(slot).toContain('size={32}');
  expect(slot).toContain('duration: reducedMotion ? 0 : 0.18');
  for (const delay of ['-0.45s', '-0.22s']) expect(slot).toContain(delay);
  expect(geometry).toMatchObject({ slotLeft: 2.875 * 16, slotBottom: 4, slotHeight: 40, bubbleHeight: 36, bubbleRadius: 1.35 * 16,
    bubbleWidth: 3 * 6 + 2 * 4 + 2 * 16, avatarSlotWidth: 36, avatarSize: 32, avatarLeft: -46, avatarTop: 2, pulseDuration: 1400, enterDuration: 180 });
});

test('presenter owns neither transport/timer/List/Input/scroll nor an alternate avatar player', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(root, 'desktop-assistant-send-feedback.tsx'), 'utf8');
  expect(source).not.toMatch(/\b(?:setTimeout|setInterval|requestAnimationFrame|fetch|Storage|scrollTo|List|Input)\s*\(/);
  expect(source).not.toContain('<List'); expect(source).not.toContain('<Input');
  expect(source).toContain("from './assistants-avatar-live'");
  expect(source).not.toMatch(/createNativeAvatarClock|createAssistantAvatarPlayer|\.subscribe\(/);
  expect(source).toContain("animationName: !reduceMotion() ? 'pulse' : 'none'");
});
