import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useServerTTS, type UseServerTTSReturn } from './useServerTTS';

const mocks = vi.hoisted(() => ({
  speech: vi.fn(), fetch: vi.fn(), identity: 'runtime-a', listeners: new Set<() => void>(),
}));
vi.mock('@/lib/voice/direct-tts', () => ({ requestSpeechAudio: mocks.speech }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => mocks.identity,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
}));

type Source = {
  buffer: AudioBuffer | null; detune: { value: number }; onended: (() => void) | null;
  start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
};
let audio: { time: number; sources: Source[]; decode: ReturnType<typeof vi.fn<(data: ArrayBuffer) => Promise<AudioBuffer>>> };
class Context {
  state = 'running';
  destination = {};
  get currentTime() { return audio.time; }
  createBuffer(_channels: number, samples: number, sampleRate: number) {
    return { duration: samples / sampleRate, length: samples, numberOfChannels: 1, sampleRate,
      getChannelData: () => new Float32Array(samples), copyFromChannel: () => {}, copyToChannel: () => {} } satisfies AudioBuffer;
  }
  createBufferSource() {
    const source: Source = {
      buffer: null, detune: { value: 0 }, onended: null,
      start: vi.fn(), stop: vi.fn(() => source.onended?.()), connect: vi.fn(), disconnect: vi.fn(),
    };
    audio.sources.push(source); return source;
  }
  createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; }
  decodeAudioData(data: ArrayBuffer) { return audio.decode(data); }
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const pcm = () => audio.sources.filter((source) => source.buffer?.sampleRate === 24000);
const packet = { type: 'audio', data: btoa('\x00\x40'.repeat(4800)) };
const subtitle = (text: string, startTime: number, endTime: number) => ({ type: 'subtitle', text, words: [{ word: text, startTime, endTime }] });
function stream(frames = [packet, packet, packet, packet, packet, { type: 'done' }]) {
  return new Response(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
}
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
let root: ReturnType<typeof createRoot>;
let tts: UseServerTTSReturn;
function Probe({ enabled = false }) { tts = useServerTTS({ enabled }); return null; }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks(); mocks.identity = 'runtime-a';
  mocks.speech.mockImplementation(async () => stream());
  mocks.fetch.mockResolvedValue(Response.json({ available: false }));
  audio = { time: 0, sources: [], decode: vi.fn() };
  vi.stubGlobal('AudioContext', Context);
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Probe)));
});
afterEach(async () => {
  await act(async () => { for (const listener of mocks.listeners) listener(); await flush(); root.unmount(); });
  vi.unstubAllGlobals();
});

it('requests the full text through the existing speech transport, without client-local synthesis configuration', async () => {
  let playing!: Promise<void>;
  await act(async () => { playing = tts.speak('第一段。\n\n第二段。'); await flush(); });
  expect(mocks.speech).toHaveBeenCalledExactlyOnceWith('第一段。\n\n第二段。', expect.any(AbortSignal));
  await act(async () => { tts.stop(); await playing; });
});

it('cancels a late fetch body and never starts stale decoding or playback', async () => {
  const first = deferred<Response>(); const cancel = vi.fn(); const ended = vi.fn();
  mocks.speech.mockReturnValueOnce(first.promise);
  let stale!: Promise<void>; let active!: Promise<void>;
  await act(async () => { stale = tts.speak('旧请求', { onEnd: ended }); active = tts.speak('新请求'); await flush(); });
  await act(async () => { first.resolve(new Response(new ReadableStream({ cancel }))); await stale; });
  expect(cancel).toHaveBeenCalledOnce(); expect(audio.decode).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
  expect(tts.isPlaying).toBe(true);
  await act(async () => { tts.stop(); await active; });
});

it('fences stale MP3 decoding and fetch errors', async () => {
  const decode = deferred<AudioBuffer>(); const ended = vi.fn(); const failed = vi.fn();
  mocks.speech.mockResolvedValueOnce(new Response('mp3'));
  audio.decode.mockReturnValueOnce(decode.promise);
  let stale!: Promise<void>; let active!: Promise<void>;
  await act(async () => { stale = tts.speak('旧解码', { onEnd: ended }); await flush(); });
  await act(async () => { active = tts.speak('当前音频'); await flush(); });
  await act(async () => { decode.resolve({ duration: 1, sampleRate: 24000 } as AudioBuffer); await stale; });
  expect(ended).not.toHaveBeenCalled(); expect(tts.isPlaying).toBe(true);
  await act(async () => { tts.stop(); await active; });

  const failure = deferred<Response>(); mocks.speech.mockReturnValueOnce(failure.promise);
  await act(async () => { stale = tts.speak('旧错误', { onError: failed }); active = tts.speak('新音频'); await flush(); });
  await act(async () => { failure.reject(new Error('stale failure')); await stale; });
  expect(failed).not.toHaveBeenCalled(); expect(tts.error).toBeNull();
  await act(async () => { tts.stop(); await active; });
});

it('ignores an MP3 ended callback saved before another playback takes ownership', async () => {
  mocks.speech.mockResolvedValueOnce(new Response('mp3'));
  audio.decode.mockResolvedValueOnce(new Context().createBuffer(1, 24000, 24000));
  const ended = vi.fn();
  await act(async () => { await tts.speak('旧音频', { onEnd: ended }); });
  const oldEnded = pcm()[0].onended!;
  let playing!: Promise<void>;
  await act(async () => { playing = tts.speak('新音频'); await flush(); oldEnded(); });
  expect(ended).not.toHaveBeenCalled(); expect(tts.isPlaying).toBe(true);
  await act(async () => { tts.stop(); await playing; });
});

it('resumes fully received audio at its stopped sample without obtaining another ticket or synthesis', async () => {
  const key = {}; const ended = vi.fn();
  let playing!: Promise<void>;
  await act(async () => { playing = tts.speak('缓存的音频。', { playbackKey: key, onEnd: ended }); await flush(); });
  expect(pcm()).toHaveLength(5);
  await act(async () => { audio.time = 0.35; tts.stop(); await playing; });
  const count = pcm().length;
  await act(async () => { playing = tts.speak('缓存的音频。', { playbackKey: key, resume: true, onEnd: ended }); await flush(); });
  expect(mocks.speech).toHaveBeenCalledTimes(1);
  const replay = pcm().slice(count);
  expect(replay.reduce((total, source) => total + source.buffer!.duration, 0)).toBeCloseTo(0.67);
  expect(ended).not.toHaveBeenCalled();
  await act(async () => { audio.time = 2; replay.forEach((source) => source.onended?.()); await playing; });
  expect(ended).toHaveBeenCalledOnce();
});

it('uses a cached partial tail to a known subtitle boundary, then requests the remaining text once', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>; const cancelled = vi.fn();
  mocks.speech.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { controller = c; }, cancel: cancelled }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
  const key = {}; const ended = vi.fn(); const progress = vi.fn(); let playing!: Promise<void>;
  await act(async () => {
    playing = tts.speak('第一句。第二句。', { playbackKey: key, onProgress: progress });
    controller.enqueue(new TextEncoder().encode([packet, packet, packet, subtitle('第一句。', 0, 0.4)].map((frame) => JSON.stringify(frame)).join('\n') + '\n'));
    await flush();
  });
  await act(async () => { audio.time = 0.1; tts.stop(); await playing; });
  expect(cancelled).toHaveBeenCalledOnce();
  const count = pcm().length;
  await act(async () => { playing = tts.speak('第一句。第二句。', { playbackKey: key, resume: true, onProgress: progress, onEnd: ended }); await flush(); });
  expect(mocks.speech).toHaveBeenCalledTimes(1);
  expect(ended).not.toHaveBeenCalled();
  await act(async () => { audio.time = 1; pcm().slice(count).forEach((source) => source.onended?.()); await flush(); });
  expect(mocks.speech).toHaveBeenCalledTimes(2);
  expect(mocks.speech.mock.calls[1][0]).toBe('第二句。');
  expect(ended).not.toHaveBeenCalled();
  await act(async () => { audio.time = 3; pcm().forEach((source) => source.onended?.()); await playing; });
  expect(ended).toHaveBeenCalledOnce();
});

it('never treats an unconfirmed terminal stream as complete just because all text has subtitles', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  mocks.speech.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
  const key = {}; let playing!: Promise<void>;
  await act(async () => {
    playing = tts.speak('第一句。', { playbackKey: key });
    controller.enqueue(new TextEncoder().encode([packet, packet, subtitle('第一句。', 0, 0.4)].map((frame) => JSON.stringify(frame)).join('\n') + '\n'));
    await flush();
  });
  await act(async () => { tts.stop(); await playing; });
  await act(async () => { playing = tts.speak('第一句。', { playbackKey: key, resume: true }); await flush(); });
  expect(mocks.speech).toHaveBeenCalledTimes(2);
  await act(async () => { tts.stop(); await playing; });
});

it.each(['restart', 'runtime', 'different-owner'])('does not reuse cached audio after %s', async (reason) => {
  const key = {}; let playing!: Promise<void>;
  await act(async () => { playing = tts.speak('相同文本。', { playbackKey: key }); await flush(); tts.stop(); await playing; });
  if (reason === 'runtime') await act(async () => { mocks.identity = 'runtime-b'; for (const listener of mocks.listeners) listener(); });
  await act(async () => { playing = tts.speak('相同文本。', { playbackKey: reason === 'different-owner' ? {} : key, resume: reason !== 'restart' }); await flush(); });
  expect(mocks.speech).toHaveBeenCalledTimes(2);
  await act(async () => { tts.stop(); await playing; });
});

it('keeps availability requests isolated by transport identity', async () => {
  const first = deferred<Response>(); const second = deferred<Response>();
  mocks.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  mocks.identity = 'availability-a';
  await act(async () => root.render(React.createElement(Probe, { enabled: true })));
  await act(async () => { mocks.identity = 'availability-b'; for (const listener of mocks.listeners) listener(); });
  await act(async () => { second.resolve(Response.json({ available: false })); await flush(); });
  await act(async () => { first.resolve(Response.json({ available: true })); await flush(); });
  expect(tts.isAvailable).toBe(false);
});
