/**
 * useMessageTTS Hook
 * 
 * Hook for playing TTS on individual messages.
 * Uses the configured voice provider (browser, OpenAI, or macOS Say).
 */

import { useEffect, useRef, useState } from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { useConfigStore } from '@/stores/useConfigStore';
import { useServerTTS } from './useServerTTS';
import { useSayTTS } from './useSayTTS';
import { useLocalTTS } from './useLocalTTS';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { sanitizeForTTS } from '@/lib/voice/summarize';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeSpeechCapture } from '@/lib/voice/audio-session';
import { splitSpeechText } from '@/lib/voice/speech-segments';
import { trackSpeech } from '@/lib/voice/speech-tracking';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

// Below this length the reply is comfortable to listen to as-is; summarizing
// would only add latency.
const TTS_SUMMARIZE_MIN_CHARS = 600;

let stopActiveMessageSpeech: (() => void) | null = null;
type SpeechCheckpoint = { text: string; mode: string; provider: string; identity?: string; chunks: string[]; index: number };
// One in-memory handoff lets a manually stopped automatic reply resume from its message action.
let interruptedSpeech: SpeechCheckpoint | null = null;

const SUMMARIZE_SYSTEM_PROMPT = 'Summarize the assistant reply for text-to-speech listening. Reply with 2-4 sentences of plain spoken prose in the same language as the reply. No markdown, no lists, no code — mention code changes briefly in words instead.';

async function summarizeForSpeech(
    text: string,
    preferred: { providerID?: string; modelID?: string },
): Promise<string | null> {
    try {
        const response = await runtimeFetch('/api/small-model/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: text,
                system: SUMMARIZE_SYSTEM_PROMPT,
                ...(preferred.providerID ? { preferredProviderID: preferred.providerID } : {}),
                ...(preferred.modelID ? { preferredModelID: preferred.modelID } : {}),
            }),
        });
        if (!response.ok) return null;
        const payload = await response.json().catch(() => null) as { text?: unknown } | null;
        return typeof payload?.text === 'string' && payload.text.trim() ? payload.text.trim() : null;
    } catch {
        return null;
    }
}

export interface UseMessageTTSReturn {
    /** Whether TTS is currently playing for this message */
    isPlaying: boolean;
    /** Play the message text */
    play: (text: string, onSettled?: (error?: Error) => void, options?: { target?: HTMLElement; restart?: boolean }) => Promise<void>;
    /** Check at interaction time whether this exact reply has unfinished playback. */
    canResume: (text: string, target?: HTMLElement) => boolean;
    unlock: () => Promise<void>;
    /** Stop playback */
    stop: () => void;
}

export function useMessageTTS(options: { enabled?: boolean } = {}): UseMessageTTSReturn {
    const [isPlaying, setIsPlaying] = useState(false);
    const generation = useRef(0);
    const checkpoint = useRef<SpeechCheckpoint | null>(null);
    const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
    const tracking = useRef<ReturnType<typeof trackSpeech> | null>(null);
    
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const speechRate = useConfigStore((state) => state.speechRate);
    const speechPitch = useConfigStore((state) => state.speechPitch);
    const speechVolume = useConfigStore((state) => state.speechVolume);
    const browserVoice = useConfigStore((state) => state.browserVoice);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const ttsInputMode = useConfigStore((state) => state.ttsInputMode);

    const isServerProvider = voiceProvider === 'openai' || voiceProvider === 'openai-compatible' || voiceProvider === 'volcengine';
    const shouldCheckSayAvailability = (options.enabled ?? showMessageTTSButtons) && voiceProvider === 'say';

    const { speak: speakServerTTS, stop: stopServerTTS, unlockAudio } = useServerTTS({ enabled: false });
    const { speak: speakSayTTS, stop: stopSayTTS, unlockAudio: unlockSayAudio, isAvailable: isSayTTSAvailable } = useSayTTS({
        enabled: shouldCheckSayAvailability,
    });
    const { speak: speakLocalTTS, stop: stopLocalTTS, unlockAudio: unlockLocalAudio } = useLocalTTS();

    const resumeCheckpoint = useEvent((text: string, target?: HTMLElement) => {
        const identity = target?.dataset.speechIdentity;
        const previous = (identity && interruptedSpeech?.identity === identity ? interruptedSpeech : null) ?? checkpoint.current;
        return previous?.text === text && previous.mode === ttsInputMode
            && previous.provider === voiceProvider && previous.identity === identity && previous.index < previous.chunks.length
            ? previous : null;
    });
    const canResume = useEvent((text: string, target?: HTMLElement) => resumeCheckpoint(text, target) !== null);
    
    const stop = useEvent(() => {
        if (stopActiveMessageSpeech === stop && checkpoint.current && checkpoint.current.index < checkpoint.current.chunks.length) interruptedSpeech = checkpoint.current;
        generation.current += 1;
        if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current);
        if (watchdog.current !== null) clearTimeout(watchdog.current);
        recoveryTimer.current = null;
        watchdog.current = null;
        tracking.current?.stop();
        tracking.current = null;
        setIsPlaying(false);
        stopServerTTS();
        stopSayTTS();
        stopLocalTTS();
        if (stopActiveMessageSpeech === stop) {
            stopActiveMessageSpeech = null;
            browserVoiceService.cancelSpeech();
        }
    });
    useEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || event.isComposing || !isPlaying) return;
        event.preventDefault();
        event.stopPropagation();
        stop();
    }, () => isPlaying ? window : null, { capture: true });
    useEffect(() => subscribeSpeechCapture(stop), [stop]);
    useEffect(() => subscribeRuntimeEndpointChanged(() => { stop(); checkpoint.current = null; interruptedSpeech = null; }), [stop]);
    const unlock = useEvent(async () => {
        const providerUnlock = voiceProvider === 'local' ? unlockLocalAudio
            : voiceProvider === 'say' ? unlockSayAudio : isServerProvider ? unlockAudio : null;
        await Promise.all([providerUnlock?.(), browserVoiceService.resumeAudioContext()]);
    });
    useEffect(() => () => {
        if (stopActiveMessageSpeech === stop) stop();
        else generation.current += 1;
    }, [stop]);
    
    const play = useEvent(async (text: string, onSettled?: (error?: Error) => void, options?: { target?: HTMLElement; restart?: boolean }) => {
        if (!text.trim()) { onSettled?.(); return; }
        
        // Stop any existing playback
        stopActiveMessageSpeech?.();
        stop();
        stopActiveMessageSpeech = stop;
        const request = generation.current;
        let settled = false;
        const finish = (error?: Error) => {
            if (request !== generation.current || settled) return;
            settled = true;
            if (watchdog.current !== null) clearTimeout(watchdog.current);
            watchdog.current = null;
            tracking.current?.stop();
            tracking.current = null;
            if (stopActiveMessageSpeech === stop) stopActiveMessageSpeech = null;
            if (error) {
                interruptedSpeech = checkpoint.current;
                stopServerTTS(); stopSayTTS(); stopLocalTTS(); browserVoiceService.cancelSpeech();
            } else {
                if (interruptedSpeech === checkpoint.current) interruptedSpeech = null;
                checkpoint.current = null;
            }
            setIsPlaying(false);
            onSettled?.(error);
        };
        
        setIsPlaying(true);
        
        try {
            // Summarized mode: replace long replies with a short spoken-prose
            // summary from the small model; fall back to the sanitized
            // original when summarization is unavailable.
            const identity = options?.target?.dataset.speechIdentity;
            const previous = options?.restart ? null : resumeCheckpoint(text, options?.target);
            const resume = previous !== null;
            let sourceText = text;
            if (!resume && ttsInputMode === 'summarized' && text.length >= TTS_SUMMARIZE_MIN_CHARS) {
                const { currentProviderId, currentModelId } = useConfigStore.getState();
                const summary = await summarizeForSpeech(text, {
                    providerID: currentProviderId || undefined,
                    modelID: currentModelId || undefined,
                });
                if (summary) {
                    sourceText = summary;
                }
            }

            if (request !== generation.current) return;
            const shouldUseRaw = ttsInputMode === 'raw' && isServerProvider;
            const sanitizedText = sanitizeForTTS(sourceText, sourceText.length > 280);
            const textToSpeak = shouldUseRaw ? sourceText : sanitizedText;
            if (!textToSpeak.trim()) { finish(); return; }
            
            const progress = resume ? previous : { text, mode: ttsInputMode, provider: voiceProvider, identity, chunks: splitSpeechText(textToSpeak), index: 0 };
            checkpoint.current = progress;
            if (interruptedSpeech?.identity === identity && interruptedSpeech?.text === text) interruptedSpeech = null;
            if (options?.target) {
                const bodies = options.target.querySelectorAll<HTMLElement>('[data-speech-content]');
                const target = ttsInputMode === 'final' ? bodies[bodies.length - 1] ?? options.target : options.target;
                tracking.current = trackSpeech(target, progress.chunks.slice(0, progress.index).join(' '), !shouldUseRaw);
            }
            const speakChunk = async (attempt = 0): Promise<void> => {
                if (request !== generation.current || settled) return;
                const chunk = progress.chunks[progress.index];
                if (!chunk) { finish(); return; }
                let completed = false;
                const clearWatchdog = () => {
                    if (watchdog.current !== null) clearTimeout(watchdog.current);
                    watchdog.current = null;
                };
                const onStart = () => {
                    if (completed || request !== generation.current) return;
                    tracking.current?.update(chunk, progress.index);
                };
                const onEnd = () => {
                    if (completed || request !== generation.current) return;
                    completed = true;
                    clearWatchdog();
                    progress.index += 1;
                    if (progress.index === progress.chunks.length) finish();
                    else void speakChunk();
                };
                const onError = (message: string) => {
                    if (completed || request !== generation.current) return;
                    completed = true;
                    clearWatchdog();
                    const permanent = /not.allowed|autoplay|blocked|not supported|unsupported|HTTP 4\d\d|API.key|unauthorized|forbidden|invalid|no text/i.test(message);
                    if (permanent || attempt >= 2) { finish(new Error(message)); return; }
                    stopServerTTS(); stopSayTTS(); stopLocalTTS(); browserVoiceService.cancelSpeech();
                    recoveryTimer.current = setTimeout(() => {
                        recoveryTimer.current = null;
                        void speakChunk(attempt + 1);
                    }, 600 * (attempt + 1));
                };
                // A missing end/error event must not strand a whole long reply.
                watchdog.current = setTimeout(() => onError('Speech playback stalled'), Math.max(45000, chunk.length * 500 / Math.max(speechRate || 1, 0.1)));
                try {
                    const callbacks = { onStart, onEnd, onError };
                    if (isServerProvider) await speakServerTTS(chunk, callbacks);
                    else if (voiceProvider === 'local') await speakLocalTTS(chunk, callbacks);
                    else if (voiceProvider === 'say' && isSayTTSAvailable) await speakSayTTS(chunk, callbacks);
                    else {
                        await browserVoiceService.waitForVoices();
                        await browserVoiceService.resumeAudioContext();
                        if (request !== generation.current) return;
                        await browserVoiceService.speakText(chunk, navigator.language || 'en-US', onEnd, {
                            rate: speechRate, pitch: speechPitch, volume: speechVolume,
                            voiceName: browserVoice || undefined, onStart, onError,
                        });
                    }
                } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
            };
            await speakChunk();
        } catch (err) {
            console.error('[useMessageTTS] Playback error:', err);
            finish(err instanceof Error ? err : new Error(String(err)));
        }
    });
    
    return {
        isPlaying,
        play,
        canResume,
        stop,
        unlock,
    };
}
