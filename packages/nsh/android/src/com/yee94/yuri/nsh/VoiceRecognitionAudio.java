package com.yee94.yuri.nsh;

/**
 * Ported from VoiceRecognitionAudio in ios/VoiceRecognitionCore.swift. The recorder is the only
 * owner of the microphone: incremental 16 kHz mono signed PCM16LE, stop flushes the final bytes and
 * cancel is idempotent.
 */
public interface VoiceRecognitionAudio {
    boolean permission();

    void start() throws VoiceRecognitionFailure;

    /** Incremental PCM since the previous read; never grows past the session limit. */
    byte[] readPCM() throws VoiceRecognitionFailure;

    void stop() throws VoiceRecognitionFailure;

    /** Idempotent: stop recording, release the source and drop retained audio. */
    void cancel() throws VoiceRecognitionFailure;
}
