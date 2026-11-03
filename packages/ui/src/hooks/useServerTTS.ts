/**
 * useServerTTS Hook
 * 
 * React hook for server-side text-to-speech playback.
 * Fetches audio from the server and plays it, bypassing mobile Safari restrictions.
 * 
 * @example
 * ```typescript
 * const { speak, isPlaying, stop, isAvailable } = useServerTTS();
 * 
 * // Speak text
 * await speak('Hello, this is a test');
 * 
 * // Stop playback
 * stop();
 * ```
 */

import { useEffect, useRef, useState } from 'react';
import { useEvent } from '@reactuses/core';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { createPcmSpeechCache, playPcmStream, type PcmSpeechCache } from '@/lib/voice/pcm-stream';
import type { SpeechCue } from '@/lib/voice/speech-timeline';
import { requestSpeechAudio } from '@/lib/voice/direct-tts';
import { prepareSpeechPlayback, subscribeSpeechCapture } from '@/lib/voice/audio-session';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

interface ServerTTSStatusCache {
  available: boolean;
  checkedAt: number;
}

interface PlaybackSession {
  abort: AbortController;
}

interface UseServerTTSOptions {
  enabled?: boolean;
}

const SERVER_TTS_STATUS_TTL_MS = 30000;
const serverTTSStatusCache = new Map<string, ServerTTSStatusCache>();
const serverTTSStatusRequests = new Map<string, Promise<boolean>>();

async function getServerTTSStatus(transportIdentity: string): Promise<boolean> {
  const now = Date.now();
  const cached = serverTTSStatusCache.get(transportIdentity);
  if (cached && now - cached.checkedAt < SERVER_TTS_STATUS_TTL_MS) {
    return cached.available;
  }

  const inFlight = serverTTSStatusRequests.get(transportIdentity);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    try {
      const response = await runtimeFetch('/api/tts/status');
      if (!response.ok) {
        serverTTSStatusCache.set(transportIdentity, { available: false, checkedAt: Date.now() });
        return false;
      }

      const data = await response.json();
      const available = Boolean(data.available);
      serverTTSStatusCache.set(transportIdentity, { available, checkedAt: Date.now() });
      return available;
    } catch {
      serverTTSStatusCache.set(transportIdentity, { available: false, checkedAt: Date.now() });
      return false;
    } finally {
      serverTTSStatusRequests.delete(transportIdentity);
    }
  })();
  serverTTSStatusRequests.set(transportIdentity, request);

  return request;
}

export interface UseServerTTSReturn {
  /** Whether TTS is currently playing */
  isPlaying: boolean;
  /** Whether the server TTS service is available */
  isAvailable: boolean;
  /** Current error if any */
  error: string | null;
  /** Speak the given text */
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  /** Stop current playback */
  stop: () => void;
  /** Check if service is available */
  checkAvailability: () => Promise<boolean>;
  /** Unlock audio for mobile Safari - call this on user gesture before speaking */
  unlockAudio: () => Promise<void>;
}

interface SpeakOptions {
  /** Callback when playback starts */
  onStart?: () => void;
  /** Callback when playback ends */
  onEnd?: () => void;
  /** Callback on error */
  onError?: (error: string) => void;
  onProgress?: (cue: SpeechCue) => void;
  playbackKey?: object;
  resume?: boolean;
  resumeOffset?: number;
}

// Only the most recent stream is retained, shared by automatic/manual owners.
// No tickets, credentials or AudioContext buffers are retained in this cache.
let cachedSpeech: { key: object; identity: string; text: string; offset: number; pcm: PcmSpeechCache; pitch: number; volume: number } | null = null;

// Shared AudioContext for Web Audio API playback (better iOS support)
let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  prepareSpeechPlayback();
  if (!sharedAudioContext) {
    sharedAudioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  return sharedAudioContext;
}

export function useServerTTS(options: UseServerTTSOptions = {}): UseServerTTSReturn {
  const enabled = options.enabled ?? true;
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const sessionRef = useRef<PlaybackSession | null>(null);
  const availabilityGenerationRef = useRef(0);
  

  // Check if server TTS is available
  const checkAvailability = useEvent(async (): Promise<boolean> => {
    const generation = ++availabilityGenerationRef.current;
    const transportIdentity = getRuntimeTransportIdentity();
    const applyAvailability = (available: boolean): boolean => {
      if (generation === availabilityGenerationRef.current && getRuntimeTransportIdentity() === transportIdentity) {
        setIsAvailable(available);
      }
      return available;
    };
    if (!enabled) {
      return applyAvailability(false);
    }

    try {
      return applyAvailability(await getServerTTSStatus(transportIdentity));
    } catch {
      return applyAvailability(false);
    }
  });

  // Check the Host capability when playback becomes enabled.
  useEffect(() => {
    void checkAvailability();
  }, [enabled, checkAvailability]);

  useEffect(() => subscribeRuntimeEndpointChanged(() => {
    void checkAvailability();
  }), [checkAvailability]);

  // Stop current playback
  const stop = useEvent(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.abort.abort();

    // Stop Web Audio API source
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.onended = null;
        audioSourceRef.current.stop();
      } catch {
        // Already stopped
      }
      audioSourceRef.current = null;
    }
    
    setIsPlaying(false);
  });

  // Pre-unlock audio for mobile Safari
  // This must be called within a user gesture context
  const unlockAudio = useEvent(async (): Promise<void> => {
    try {
      // Get or create AudioContext
      const ctx = getAudioContext();
      
      // Resume if suspended (required for iOS Safari)
      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useServerTTS] AudioContext resumed');
      }
      
      // Play a tiny silent buffer to fully unlock
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      
      console.log('[useServerTTS] Audio unlocked for mobile playback');
    } catch (err) {
      console.error('[useServerTTS] Failed to unlock audio:', err);
    }
  });

  // Speak text using server TTS
  const speak = useEvent(async (text: string, options?: SpeakOptions): Promise<void> => {
    // Stop any existing playback
    stop();

    if (!text.trim()) {
      setError('No text to speak');
      options?.onError?.('No text to speak');
      return;
    }

    setError(null);
    const session: PlaybackSession = { abort: new AbortController() };
    sessionRef.current = session;

    try {
      // Unlock audio context first (required for mobile Safari)
      // Must be done before any async operations to stay within user gesture context
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useServerTTS] AudioContext resumed');
      }
      
      // Play a silent buffer to fully unlock audio on iOS
      const silentBuffer = ctx.createBuffer(1, 1, 22050);
      const silentSource = ctx.createBufferSource();
      silentSource.buffer = silentBuffer;
      silentSource.connect(ctx.destination);
      silentSource.start(0);

      const identity = getRuntimeTransportIdentity();
      const previous = options?.resume && options.playbackKey && cachedSpeech?.key === options.playbackKey
        && cachedSpeech.identity === identity && cachedSpeech.text === text ? cachedSpeech : null;
      let offset = Math.max(0, Math.min(text.length, options?.resumeOffset ?? 0));
      const playStream = async (response: Response | null, pcm: PcmSpeechCache, pitch: number, volume: number, base: number, endAt?: number) => {
        await playPcmStream(response, ctx, {
          signal: session.abort.signal, pitch, volume, cache: pcm, endAt,
          onStart: () => {
            if (sessionRef.current !== session) return;
            setIsPlaying(true);
            options?.onStart?.();
          },
          onProgress: (cue) => {
            if (sessionRef.current !== session) return;
            options?.onProgress?.({ ...cue, start: cue.start + base, end: cue.end + base });
          },
        });
      };
      const finish = () => {
        if (sessionRef.current !== session) return;
        if (cachedSpeech?.key === options?.playbackKey) cachedSpeech = null;
        sessionRef.current = null;
        setIsPlaying(false);
        options?.onEnd?.();
      };
      if (previous) {
        if (previous.pcm.complete) {
          await playStream(null, previous.pcm, previous.pitch, previous.volume, previous.offset);
          finish();
          return;
        }
        // A cancelled/broken socket is not resumable. Reuse its cached tail only
        // up to a timestamp-aligned text boundary, then synthesize the remainder
        // in one new session. Unknown audio/text alignment never skips source.
        const boundary = previous.pcm.timeline.lastBefore(previous.pcm.samples / 24000);
        if (boundary && previous.offset + boundary.end < text.trimEnd().length) {
          if (boundary.endTime > previous.pcm.position) {
            await playStream(null, previous.pcm, previous.pitch, previous.volume, previous.offset, boundary.endTime);
          }
          offset = Math.max(offset, previous.offset + boundary.end);
        }
      }
      session.abort.signal.throwIfAborted();
      cachedSpeech = null;
      offset += text.slice(offset).match(/^\s*/u)![0].length;
      if (offset === text.length) { finish(); return; }

      // Fetch audio from server
      const response = await requestSpeechAudio(text.slice(offset), session.abort.signal);

      if (sessionRef.current !== session) {
        await response.body?.cancel();
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const pitch = Number(response.headers.get('X-Speech-Pitch') ?? 1);
      const volume = Number(response.headers.get('X-Speech-Volume') ?? 1);
      if (response.headers.get('content-type')?.includes('application/x-ndjson')) {
        const pcm = createPcmSpeechCache(text.slice(offset));
        if (options?.playbackKey) cachedSpeech = { key: options.playbackKey, identity, text, offset, pcm, pitch, volume };
        await playStream(response, pcm, pitch, volume, offset);
        finish();
        return;
      }

      // Get audio data from response
      const audioBlob = await response.blob();
      const arrayBuffer = await audioBlob.arrayBuffer();
      if (sessionRef.current !== session) {
        return;
      }
      
      // Decode audio data using the same context we unlocked earlier
      console.log('[useServerTTS] Decoding audio data...');
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      if (sessionRef.current !== session) {
        return;
      }
      
      // Create source node
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      // Apply pitch shift via detune (cents): 1200 cents = 1 octave
      if (pitch !== 1.0) {
        source.detune.value = (pitch - 1.0) * 1200;
      }

      // Apply volume via GainNode
      const gainNode = ctx.createGain();
      gainNode.gain.value = volume;

      source.connect(gainNode);
      gainNode.connect(ctx.destination);
      audioSourceRef.current = source;
      
      // Set up event handlers
      source.onended = () => {
        if (sessionRef.current !== session || audioSourceRef.current !== source) {
          return;
        }
        console.log('[useServerTTS] Audio playback ended');
        setIsPlaying(false);
        audioSourceRef.current = null;
        sessionRef.current = null;
        options?.onEnd?.();
      };
      
      // Start playback
      console.log('[useServerTTS] Starting audio playback via Web Audio API...');
      setIsPlaying(true);
      options?.onStart?.();
      if (sessionRef.current !== session || audioSourceRef.current !== source) {
        return;
      }
      source.start(0);
      
    } catch (err) {
      if ((err as Error).name === 'AbortError' || sessionRef.current !== session) {
        // Request was aborted, don't show error
        return;
      }
      
      const errorMsg = err instanceof Error ? err.message : 'Failed to speak';
      console.error('[useServerTTS] Error:', errorMsg);
      setError(errorMsg);
      options?.onError?.(errorMsg);
      setIsPlaying(false);
      if (audioSourceRef.current) {
        audioSourceRef.current.onended = null;
        audioSourceRef.current = null;
      }
      sessionRef.current = null;
    }
  });

  // Cleanup on unmount
  useEffect(() => subscribeRuntimeEndpointChanged(() => { stop(); cachedSpeech = null; }), [stop]);
  useEffect(() => subscribeSpeechCapture(stop), [stop]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    isPlaying,
    isAvailable,
    error,
    speak,
    stop,
    checkAvailability,
    unlockAudio,
  };
}
