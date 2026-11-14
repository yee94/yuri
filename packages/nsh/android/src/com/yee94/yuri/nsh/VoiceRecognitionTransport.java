package com.yee94.yuri.nsh;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Ported from VoiceRecognitionTransport in ios/VoiceRecognitionCore.swift: captured, authenticated
 * same-Host operations only. No endpoint, provider key, audio or session ticket crosses into the app.
 *
 * <p>Batch transcription posts raw WAV through {@link VoiceRecognitionRuntime.RawUpload}, which
 * RuntimeBridge implements; a lease without it reports {@code unavailable} instead of silently
 * falling back to another endpoint.
 */
public final class VoiceRecognitionTransport {
    private final HostLease lease;

    VoiceRecognitionTransport(HostLease lease) {
        this.lease = lease;
    }

    public static VoiceRecognitionTransport of(HostLease lease) {
        return new VoiceRecognitionTransport(lease);
    }

    public boolean isCurrent() {
        return lease.isCurrent();
    }

    public boolean supportsTranscription() {
        return lease instanceof VoiceRecognitionRuntime.RawUpload;
    }

    /** Exact GET /api/voice/settings. */
    public VoiceRecognitionRuntime.Response settings() throws VoiceRecognitionFailure {
        HostLease.JsonResponse response = VoiceRecognitionRuntime.await(lease.json("/api/voice/settings", "GET", null), 90);
        if (!isCurrent()) throw VoiceRecognitionFailure.of("cancelled");
        return new VoiceRecognitionRuntime.Response(response.status, "application/json", TerminalTransport.map(response.body));
    }

    /** Exact POST /api/stt/transcribe with audio/wav and no configuration headers. */
    public VoiceRecognitionRuntime.Response transcribe(byte[] wav) throws VoiceRecognitionFailure {
        if (wav == null || wav.length == 0 || wav.length > VoiceRecognitionRuntime.FILE_LIMIT) {
            throw VoiceRecognitionFailure.of("limit");
        }
        if (!(lease instanceof VoiceRecognitionRuntime.RawUpload)) throw VoiceRecognitionFailure.of("unavailable");
        HostLease.RawResponse response;
        try {
            response = ((VoiceRecognitionRuntime.RawUpload) lease).postBytes("/api/stt/transcribe", "audio/wav", wav);
        } catch (Exception error) {
            throw VoiceRecognitionRuntime.failure(error);
        }
        if (response == null) throw VoiceRecognitionFailure.of("transport");
        if (!isCurrent()) throw VoiceRecognitionFailure.of("cancelled");
        Map<String, Object> body = new LinkedHashMap<>();
        if (response.data != null && response.data.length <= VoiceRecognitionRuntime.RESPONSE_LIMIT) {
            Object parsed = TerminalJson.parse(new String(response.data, StandardCharsets.UTF_8));
            if (parsed instanceof Map) body = TerminalTransport.map(parsed);
        }
        return new VoiceRecognitionRuntime.Response(response.status, response.mime, body);
    }

    /** Exact /api/dictation/ws through the existing native direct / authorized encrypted Relay. */
    public VoiceRecognitionRuntime.Socket open() throws VoiceRecognitionFailure {
        VoiceRecognitionRuntime.Socket wrapped = new VoiceRecognitionRuntime.Socket();
        HostLease.Socket socket = VoiceRecognitionRuntime.await(lease.openWebSocket("/api/dictation/ws", new HostLease.SocketListener() {
            @Override public void onText(String text) {
                wrapped.pushText(text);
            }

            @Override public void onBinary(byte[] data) {
                wrapped.fail(VoiceRecognitionFailure.of("transport"));
            }

            @Override public void onClosed(Throwable failure) {
                wrapped.fail(VoiceRecognitionFailure.of("transport"));
            }
        }), 20);
        wrapped.attach(socket);
        return wrapped;
    }
}
