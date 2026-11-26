import { expect, test } from 'vitest';
import { isAudioSource, isMediaSource } from './video';

test('audio files open the media preview alongside video', () => {
  expect(isAudioSource('/workspace/song.mp3')).toBe(true);
  expect(isAudioSource('https://example.test/voice.m4a?sig=1')).toBe(true);
  expect(isAudioSource('/workspace/clip', 'audio/wav')).toBe(true);
  expect(isAudioSource('/workspace/clip.mp4')).toBe(false);
  expect(isMediaSource('/workspace/clip.mp4')).toBe(true);
  expect(isMediaSource('/workspace/song.flac')).toBe(true);
  expect(isMediaSource('/workspace/notes.md')).toBe(false);
});
