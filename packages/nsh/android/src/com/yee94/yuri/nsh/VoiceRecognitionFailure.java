package com.yee94.yuri.nsh;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Ported from VoiceRecognitionFailure/Wire/Response in ios/VoiceRecognitionCore.swift and
 * ios/VoiceRecognitionRuntime.swift. Wire limits and the authenticated socket boundary live here so
 * the core state machine never sees a transport, credential or URL.
 */
public final class VoiceRecognitionFailure extends Exception {
    public final String code;

    public VoiceRecognitionFailure(String code) {
        super(code);
        this.code = code;
    }

    public static VoiceRecognitionFailure of(String code) {
        return new VoiceRecognitionFailure(code);
    }
}
