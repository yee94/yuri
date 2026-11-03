import { createSpeechTimeline, type SpeechCue } from './speech-timeline';

export interface PcmSpeechCache {
  chunks: Uint8Array<ArrayBuffer>[];
  samples: number;
  complete: boolean;
  position: number;
  timeline: ReturnType<typeof createSpeechTimeline>;
}

export function createPcmSpeechCache(text: string): PcmSpeechCache {
  return { chunks: [], samples: 0, complete: false, position: 0, timeline: createSpeechTimeline(text) };
}

/** Play the Host's 24 kHz mono signed-16-bit little-endian PCM stream. */
export async function playPcmStream(response: Response | null, context: AudioContext, options: {
  signal: AbortSignal;
  pitch: number;
  volume: number;
  onStart: () => void;
  onProgress?: (cue: SpeechCue) => void;
  cache?: PcmSpeechCache;
  endAt?: number;
}): Promise<void> {
  if (response && !response.body) throw new Error('Speech response has no stream');
  const cache = options.cache ?? createPcmSpeechCache('');
  const reader = response?.body?.getReader();
  const gain = context.createGain();
  gain.gain.value = options.volume;
  gain.connect(context.destination);
  const sources = new Set<AudioBufferSourceNode>();
  const endings = new Set<Promise<void>>();
  const wake = new Set<() => void>();
  const notify = () => { for (const resolve of wake) resolve(); wake.clear(); };
  const wait = () => new Promise<void>((resolve) => { wake.add(resolve); });
  const decoder = new TextDecoder();
  const segments: Array<{ at: number; end: number; offset: number; duration: number }> = [];
  let nextTime = context.currentTime;
  let started = false;
  let audible = false;
  let received = !reader;
  let terminal = !reader;
  let failure: unknown;
  let lastCueStart = -1;
  const playbackRate = Math.pow(2, options.pitch - 1);
  const startPosition = reader ? 0 : cache.position;
  const clock = () => {
    const stamp = context.getOutputTimestamp?.().contextTime;
    const time = stamp !== undefined && Number.isFinite(stamp) && stamp >= 0 ? stamp : Math.max(0, context.currentTime - (context.outputLatency || 0));
    while (segments.length && time >= segments[0].at) {
      audible = true;
      const segment = segments[0];
      cache.position = segment.offset + Math.min(segment.duration, (time - segment.at) * playbackRate);
      if (time < segment.end) break;
      segments.shift();
    }
    const cue = cache.timeline.at(cache.position);
    if (cue && cue.start > lastCueStart && audible) {
      lastCueStart = cue.start;
      options.onProgress?.(cue);
    }
  };
  const stopSources = () => { for (const source of sources) source.stop(); notify(); };
  const abort = () => {
    clock();
    void reader?.cancel().catch(() => undefined);
    stopSources();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  const timer = setInterval(clock, 50);
  const check = () => { options.signal.throwIfAborted(); if (failure) throw failure; };
  const receive = async () => {
    if (!reader) return;
    let pending = '';
    let carry: number | undefined;
    let bytes = 0;
    const consume = (line: string) => {
      if (!line.trim()) return;
      if (terminal) throw new Error('Unexpected audio after speech completion');
      if (line.length > 1024 * 1024) throw new Error('Speech frame exceeds the size limit');
      const frame = JSON.parse(line);
      if (frame.type === 'error') throw new Error('Speech synthesis interrupted or failed');
      if (frame.type === 'done') { terminal = true; notify(); return; }
      if (frame.type === 'subtitle') { cache.timeline.append(frame); clock(); return; }
      if (frame.type !== 'audio' || typeof frame.data !== 'string' || frame.data.length > 12800) {
        throw new Error('Invalid speech audio frame');
      }
      const binary = atob(frame.data);
      const pcm = new Uint8Array(binary.length + (carry === undefined ? 0 : 1));
      let offset = 0;
      if (carry !== undefined) pcm[offset++] = carry;
      for (let i = 0; i < binary.length; i++) pcm[offset + i] = binary.charCodeAt(i);
      carry = pcm.length % 2 ? pcm[pcm.length - 1] : undefined;
      if (pcm.length > 1) {
        if (cache.samples * 2 + pcm.length > 24 * 1024 * 1024 || cache.chunks.length >= 8192) throw new Error('Speech cache exceeds the size limit');
        const aligned = carry === undefined ? pcm : pcm.slice(0, -1);
        cache.chunks.push(aligned);
        cache.samples += aligned.length / 2;
        notify();
      }
    };
    try {
      while (true) {
        const result = await reader.read();
        options.signal.throwIfAborted();
        if (result.done) break;
        bytes += result.value.length;
        if (bytes > 32 * 1024 * 1024) throw new Error('Speech stream exceeds the size limit');
        pending += decoder.decode(result.value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          consume(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
        if (pending.length > 1024 * 1024) throw new Error('Speech frame exceeds the size limit');
      }
      pending += decoder.decode();
      if (pending.trim()) consume(pending);
      if (!terminal || !cache.samples || carry !== undefined) throw new Error('Incomplete speech audio stream');
      cache.complete = true;
    } finally { received = true; notify(); }
  };
  // Drain metadata independently of the bounded audio scheduler. Otherwise a
  // subtitle behind two seconds of queued audio can never catch the playhead.
  const receiving = receive().catch((error: unknown) => { failure = error; stopSources(); });
  const schedule = async (pcm: Uint8Array<ArrayBuffer>, offset: number) => {
    // Bound scheduled audio to two seconds; received PCM has a separate byte cap.
    while (nextTime - context.currentTime > 2 && endings.size) {
      await Promise.race([Promise.race(endings), wait()]);
      check();
    }
    check();
    const samples = Math.min(pcm.length / 2, Math.max(0, Math.round(((options.endAt ?? Infinity) - offset) * 24000)));
    const skip = Math.max(0, Math.round((startPosition - offset) * 24000));
    if (skip >= samples) return;
    const buffer = context.createBuffer(1, samples - skip, 24000);
    const channel = buffer.getChannelData(0);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = skip; i < samples; i++) channel[i - skip] = view.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.detune.value = (options.pitch - 1) * 1200;
    source.connect(gain);
    let ended!: () => void;
    const ending = new Promise<void>((resolve) => { ended = resolve; });
    endings.add(ending);
    sources.add(source);
    source.onended = () => {
      clock();
      sources.delete(source);
      endings.delete(ending);
      source.disconnect();
      ended();
      notify();
    };
    const at = Math.max(nextTime, context.currentTime + 0.02);
    nextTime = at + buffer.duration / playbackRate;
    segments.push({ at, end: nextTime, offset: offset + skip / 24000, duration: buffer.duration });
    source.start(at);
    if (!started) { started = true; options.onStart(); }
  };
  try {
    check();
    let index = 0;
    let offset = 0;
    let buffering = true;
    while (true) {
      check();
      if (offset >= (options.endAt ?? Infinity)) break;
      if (index >= cache.chunks.length) {
        if (received) break;
        await wait();
        continue;
      }
      // Accumulate 400ms of actual playback before starting or recovering from starvation.
      // Network packet boundaries must not dictate pauses in the audio timeline.
      if (nextTime < context.currentTime + 0.02) buffering = true;
      const available = (cache.samples / 24000 - Math.max(offset, startPosition)) / playbackRate;
      if (buffering && !terminal && available < 0.4) { await wait(); continue; }
      buffering = false;
      const pcm = cache.chunks[index++];
      await schedule(pcm, offset);
      offset += pcm.length / 48000;
    }
    await receiving;
    check();
    if (!started && startPosition < Math.min(cache.samples / 24000, options.endAt ?? Infinity)) throw new Error('Incomplete speech audio stream');
    await Promise.all(endings);
    check();
    cache.position = Math.min(cache.samples / 24000, options.endAt ?? Infinity);
  } finally {
    clock();
    clearInterval(timer);
    options.signal.removeEventListener('abort', abort);
    await reader?.cancel().catch(() => undefined);
    await receiving;
    reader?.releaseLock();
    for (const source of sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    gain.disconnect();
  }
}
