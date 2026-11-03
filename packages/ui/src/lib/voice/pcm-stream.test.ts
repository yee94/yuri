import { describe, expect, it, vi } from 'vitest';
import { createPcmSpeechCache, playPcmStream } from './pcm-stream';

function fixture() {
  const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null; buffer: AudioBuffer | null; detune: { value: number }; connect: ReturnType<typeof vi.fn> }> = [];
  const context = {
    currentTime: 0,
    destination: {},
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
    createBuffer: (_channels: number, samples: number, rate: number) => ({ duration: samples / rate, getChannelData: () => new Float32Array(samples) }),
    createBufferSource: () => {
      const source = { start: vi.fn(), stop: vi.fn(() => source.onended?.()), disconnect: vi.fn(), onended: null as (() => void) | null, buffer: null as AudioBuffer | null, detune: { value: 0 }, connect: vi.fn() };
      sources.push(source);
      return source;
    },
  };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ start(c) { controller = c; }, cancel }));
  const send = (frame: object) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
  const abort = new AbortController();
  const onStart = vi.fn();
  const play = (pitch = 1) => playPcmStream(response, context as unknown as AudioContext, { signal: abort.signal, pitch, volume: 1, onStart });
  return { sources, context, response, controller, cancel, send, abort, onStart, play };
}

describe('streaming PCM playback', () => {
  it('re-buffers after starvation instead of repeatedly playing isolated packets', async () => {
    const f = fixture();
    const playing = f.play();
    const packet = { type: 'audio', data: btoa('\x00\x40'.repeat(4800)) };
    f.send(packet);
    f.send(packet);
    await vi.waitFor(() => expect(f.sources).toHaveLength(2));
    f.sources.forEach((source) => source.onended?.());
    f.context.currentTime = 1;
    f.send(packet);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.sources).toHaveLength(2);
    f.context.currentTime = 1.25;
    f.send(packet);
    await vi.waitFor(() => expect(f.sources).toHaveLength(4));
    expect(f.sources[2].start.mock.calls[0][0]).toBeCloseTo(1.27);
    expect(f.sources[3].start.mock.calls[0][0]).toBeCloseTo(1.47);
    expect(f.onStart).toHaveBeenCalledOnce();
    f.send({ type: 'done' });
    f.controller.close();
    f.sources.slice(2).forEach((source) => source.onended?.());
    await playing;
  });

  it('measures pre-buffering in playback time when pitch speeds up audio', async () => {
    const f = fixture();
    const playing = f.play(2);
    const packet = { type: 'audio', data: btoa('\x00\x40'.repeat(4800)) };
    for (let i = 0; i < 3; i++) f.send(packet);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(f.sources).toHaveLength(0);
    f.send(packet);
    await vi.waitFor(() => expect(f.sources).toHaveLength(4));
    expect(f.sources[3].start.mock.calls[0][0]).toBeCloseTo(0.32);
    f.send({ type: 'done' });
    f.controller.close();
    f.sources.forEach((source) => source.onended?.());
    await playing;
  });

  it.each(['abort', 'error', 'truncated'])('does not play buffered audio on %s before startup', async (failure) => {
    const f = fixture();
    const playing = f.play();
    const rejected = expect(playing).rejects.toThrow();
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(2400)) });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    if (failure === 'abort') f.abort.abort();
    else {
      if (failure === 'error') f.send({ type: 'error' });
      f.controller.close();
    }
    await rejected;
    expect(f.sources).toHaveLength(0);
    expect(f.onStart).not.toHaveBeenCalled();
  });

  it('plays continuously when packets arrive with moderate jitter', async () => {
    const f = fixture();
    const playing = f.play();
    for (const time of [0, 0.25, 0.5]) {
      f.context.currentTime = time;
      f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    f.send({ type: 'done' });
    f.controller.close();
    await vi.waitFor(() => expect(f.sources).toHaveLength(3));
    const gaps = f.sources.slice(1).map((source, i) =>
      source.start.mock.calls[0][0] - (f.sources[i].start.mock.calls[0][0] + f.sources[i].buffer!.duration));
    f.sources.forEach((source) => source.onended?.());
    await playing;
    expect(gaps).toEqual([0, 0]);
  });

  it('starts before response EOF and completes only after the final audio ends', async () => {
    const f = fixture();
    const completed = vi.fn();
    const playing = f.play().then(completed);
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    await vi.waitFor(() => expect(f.onStart).toHaveBeenCalledOnce());
    expect(f.sources[0].start).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
    f.send({ type: 'audio', data: btoa('\x00\x20'.repeat(2400)) });
    f.send({ type: 'done' });
    f.controller.close();
    await vi.waitFor(() => expect(f.sources).toHaveLength(3));
    expect(f.sources[2].start.mock.calls[0][0]).toBeCloseTo(0.42);
    expect(completed).not.toHaveBeenCalled();
    f.sources.forEach((source) => source.onended?.());
    await playing;
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each(['error', 'truncated'])('stops queued audio on %s without completing successfully', async (failure) => {
    const f = fixture();
    const playing = f.play();
    const rejected = expect(playing).rejects.toThrow();
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    await vi.waitFor(() => expect(f.onStart).toHaveBeenCalledOnce());
    if (failure === 'error') f.send({ type: 'error' });
    f.controller.close();
    await rejected;
    expect(f.sources[0].stop).toHaveBeenCalledOnce();
  });

  it('cancels an open response and stops playback immediately', async () => {
    const f = fixture();
    const playing = f.play();
    const rejected = expect(playing).rejects.toThrow();
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    await vi.waitFor(() => expect(f.onStart).toHaveBeenCalledOnce());
    f.abort.abort();
    await rejected;
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.sources[0].stop).toHaveBeenCalledOnce();
  });

  it('handles split JSON and split PCM samples', async () => {
    const f = fixture();
    const playing = f.play();
    const bytes = new TextEncoder().encode('{"type":"audio","data":"AA=="}\n{"type":"audio","data":"QA=="}\n{"type":"done"}\n');
    for (const byte of bytes) f.controller.enqueue(Uint8Array.of(byte));
    f.controller.close();
    await vi.waitFor(() => expect(f.sources).toHaveLength(1));
    f.sources[0].onended?.();
    await playing;
  });

  it('bounds scheduled audio even when synthesis runs ahead of playback', async () => {
    const f = fixture();
    const playing = f.play();
    const rejected = expect(playing).rejects.toThrow();
    for (let i = 0; i < 100; i++) f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    await vi.waitFor(() => expect(f.sources.length).toBe(10));
    expect(f.sources.at(-1)!.start.mock.calls[0][0]).toBeLessThan(2);
    f.abort.abort();
    await rejected;
  });

  it('drains late subtitles past the two-second audio queue without advancing the audible clock', async () => {
    const f = fixture();
    const cache = createPcmSpeechCache('第一句。第二句。');
    const onProgress = vi.fn();
    const playing = playPcmStream(f.response, f.context as unknown as AudioContext, { signal: f.abort.signal, pitch: 1, volume: 1, onStart: f.onStart, cache, onProgress });
    const rejected = expect(playing).rejects.toThrow();
    for (let i = 0; i < 30; i++) f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    f.send({ type: 'subtitle', text: '第二句。', words: [{ word: '第二句。', startTime: 3, endTime: 5.8 }] });
    f.send({ type: 'subtitle', text: '第一句。', words: [{ word: '第一句。', startTime: 0, endTime: 2.8 }] });
    f.send({ type: 'done' }); f.controller.close();
    await vi.waitFor(() => expect(cache.complete).toBe(true));
    expect(cache.timeline.at(3.5)?.text).toBe('第二句。');
    expect(f.sources).toHaveLength(10);
    expect(onProgress).not.toHaveBeenCalled();
    f.context.currentTime = 0.15;
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: '第一句。' })));
    expect(cache.position).toBeCloseTo(0.13);
    f.abort.abort(); await rejected;
  });

  it('ignores expired subtitles and follows pitch-adjusted, starvation-aware audio time', async () => {
    const f = fixture(); const cache = createPcmSpeechCache('第一句。第二句。'); const onProgress = vi.fn();
    const playing = playPcmStream(f.response, f.context as unknown as AudioContext, { signal: f.abort.signal, pitch: 2, volume: 1, onStart: f.onStart, cache, onProgress });
    const rejected = expect(playing).rejects.toThrow();
    for (let i = 0; i < 4; i++) f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    await vi.waitFor(() => expect(f.sources).toHaveLength(4));
    f.context.currentTime = 0.35;
    f.send({ type: 'subtitle', text: '第一句。', words: [{ word: '第一句。', startTime: 0, endTime: 0.3 }] });
    f.send({ type: 'subtitle', text: '第二句。', words: [{ word: '第二句。', startTime: 0.4, endTime: 1.5 }] });
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: '第二句。' })));
    expect(cache.position).toBeCloseTo(0.66);
    f.sources.forEach((source) => source.onended?.()); f.context.currentTime = 5;
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    await vi.waitFor(() => expect(cache.samples / 24000).toBe(1));
    expect(f.sources).toHaveLength(4);
    expect(cache.position).toBeCloseTo(0.8);
    f.abort.abort(); await rejected;
  });

  it('replays complete cached PCM from the stopped sample without a network stream', async () => {
    const f = fixture(); const cache = createPcmSpeechCache('缓存的音频。');
    cache.chunks = [new Uint8Array(48000)]; cache.samples = 24000; cache.complete = true; cache.position = 0.6;
    const playing = playPcmStream(null, f.context as unknown as AudioContext, { signal: f.abort.signal, pitch: 1, volume: 1, onStart: f.onStart, cache });
    await vi.waitFor(() => expect(f.sources).toHaveLength(1));
    expect(f.sources[0].buffer!.duration).toBeCloseTo(0.4);
    f.context.currentTime = 1; f.sources[0].onended?.(); await playing;
    expect(cache.position).toBe(1);
  });

  it('publishes one cue for 500 clock samples and releases its clock on stop', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const cache = createPcmSpeechCache('同一句话。'); const onProgress = vi.fn();
      const playing = playPcmStream(f.response, f.context as unknown as AudioContext, { signal: f.abort.signal, pitch: 1, volume: 1, onStart: f.onStart, cache, onProgress });
      const rejected = expect(playing).rejects.toThrow();
      f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
      f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
      f.send({ type: 'subtitle', text: '同一句话。', words: [{ word: '同一句话。', startTime: 0, endTime: 0.4 }] });
      f.send({ type: 'done' }); f.controller.close();
      for (let index = 0; index < 30; index++) await Promise.resolve();
      f.context.currentTime = 0.1;
      await vi.advanceTimersByTimeAsync(25000);
      expect(onProgress).toHaveBeenCalledTimes(1);
      f.abort.abort(); await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('uses the output timestamp rather than the ahead-of-speaker AudioContext clock', async () => {
    const f = fixture(); const cache = createPcmSpeechCache('第一句。第二句。'); const onProgress = vi.fn();
    let outputTime = 0;
    Object.assign(f.context, { getOutputTimestamp: () => ({ contextTime: outputTime }) });
    const playing = playPcmStream(f.response, f.context as unknown as AudioContext, { signal: f.abort.signal, pitch: 1, volume: 1, onStart: f.onStart, cache, onProgress });
    const rejected = expect(playing).rejects.toThrow();
    for (let index = 0; index < 4; index++) f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    f.send({ type: 'subtitle', text: '第一句。', words: [{ word: '第一句。', startTime: 0, endTime: 0.4 }] });
    f.send({ type: 'subtitle', text: '第二句。', words: [{ word: '第二句。', startTime: 0.4, endTime: 0.8 }] });
    await vi.waitFor(() => expect(f.sources).toHaveLength(4));
    f.context.currentTime = 0.7;
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(onProgress).not.toHaveBeenCalled();
    outputTime = 0.3;
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: '第一句。' })));
    expect(cache.position).toBeCloseTo(0.28);
    f.abort.abort(); await rejected;
  });
});
