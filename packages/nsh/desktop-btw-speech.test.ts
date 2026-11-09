import { expect, test, vi } from 'vitest';
import { createDesktopBtwSpeech } from './desktop-btw-speech';
import type { NativeSpeech } from './speech';
import type { SpeechState } from './speech-core';

function fixture() {
  let current = true, state: SpeechState = { status: 'idle', settings: { visible: true, provider: 'browser', mode: 'final' } };
  const play = vi.fn(async () => 'completed' as const), stop = vi.fn(async () => {}), canResume = vi.fn(() => false);
  let controller = { play }, resolve!: (value: 'resume' | 'restart' | 'cancel') => void;
  const resume = vi.fn(() => new Promise<'resume' | 'restart' | 'cancel'>(yes => { resolve = yes; }));
  const speech = { state: () => state, capture: () => controller, play, stop, canResume } as unknown as NativeSpeech;
  const read = createDesktopBtwSpeech({ speech, identity: 'exact-session', current: () => current, resume });
  return { read, play, stop, canResume, resume, reply: (value: 'resume' | 'restart' | 'cancel') => resolve(value), retire: () => { current = false; },
    state: (value: Partial<SpeechState>) => { state = { ...state, ...value }; }, replace: () => { controller = { play }; } };
}

test('BTW delegates to the existing Chat owner with namespaced IDs and respects visible preference', async () => {
  const f = fixture(), port = f.read()!; await port.speak('btw_1', 'Answer');
  const id = JSON.stringify(['btw', 'exact-session', 'btw_1']); expect(f.play).toHaveBeenCalledWith(id, 'Answer', false);
  f.state({ status: 'playing', messageID: id }); expect(port.state('btw_1')).toBe('playing');
  expect(port.state('other')).toBe('idle'); await port.stop('other'); expect(f.stop).not.toHaveBeenCalled();
  await port.stop('btw_1'); expect(f.stop).toHaveBeenCalledTimes(1);
  f.state({ messageID: 'main-message' }); await port.stop('btw_1'); expect(f.stop).toHaveBeenCalledTimes(1);
  f.state({ settings: { visible: false, provider: 'browser', mode: 'final' } }); expect(f.read()).toBeUndefined();
  await port.speak('btw_1', 'Hidden'); expect(f.play).toHaveBeenCalledTimes(1);
});

test.each(['retire', 'replace', 'cancel'] as const)('resume confirmation %s cannot start audio for a retired controller', async mode => {
  const f = fixture(); f.canResume.mockReturnValue(true); const pending = f.read()!.speak('btw_1', 'Keep checkpoint');
  if (mode !== 'cancel') f[mode](); f.reply(mode === 'cancel' ? 'cancel' : 'resume'); await pending;
  expect(f.play).not.toHaveBeenCalled();
});

test('fifty unrelated reads do not prepare audio, enumerate catalogs or alter a main message', () => {
  const f = fixture(); f.state({ status: 'playing', messageID: 'main' });
  for (let index = 0; index < 50; index++) expect(f.read()!.state('btw_1')).toBe('idle');
  expect(f.play).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled();
});
