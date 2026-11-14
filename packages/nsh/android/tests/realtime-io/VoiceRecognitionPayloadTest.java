package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Map;

/** WAV/transcript/admission parity with VoiceRecognitionPCM and VoiceRecognitionSettings. */
public final class VoiceRecognitionPayloadTest {
    public static void main(String[] args) throws Exception {
        wavHeader();
        payloadOffsets();
        transcript();
        settings();
        request();
        System.out.println("VoiceRecognitionPayloadTest OK");
    }

    private static void wavHeader() throws Exception {
        byte[] pcm = new byte[320];
        byte[] wav = VoiceRecognitionCore.Pcm.wav(pcm);
        Check.equal(44 + 320, wav.length, "wav length");
        Check.equal("RIFF", ascii(wav, 0, 4), "RIFF");
        Check.equal("WAVE", ascii(wav, 8, 12), "WAVE");
        Check.equal("fmt ", ascii(wav, 12, 16), "fmt");
        Check.equal("data", ascii(wav, 36, 40), "data");
        Check.equal(320 + 36, littleEndian(wav, 4, 4), "RIFF size");
        Check.equal(16_000, littleEndian(wav, 24, 4), "sample rate");
        Check.equal(32_000, littleEndian(wav, 28, 4), "byte rate");
        Check.equal(320, littleEndian(wav, 40, 4), "data size");
        Check.failure("limit", () -> VoiceRecognitionCore.Pcm.wav(new byte[3]), "odd length");
    }

    private static void payloadOffsets() throws Exception {
        byte[] wav = VoiceRecognitionCore.Pcm.wav(new byte[64]);
        Check.equal(44, VoiceRecognitionCore.Pcm.payloadOffset(wav), "offset");
        Check.nullValue(VoiceRecognitionCore.Pcm.payloadOffset(new byte[4]), "short header");

        byte[] badRate = wav.clone();
        badRate[25] = (byte) 0x40; // 16000 -> 16512, so the fmt block must be rejected
        Check.failure("audio", () -> VoiceRecognitionCore.Pcm.payloadOffset(badRate), "format mismatch");

        byte[] notRiff = wav.clone();
        notRiff[0] = 'X';
        Check.failure("audio", () -> VoiceRecognitionCore.Pcm.payloadOffset(notRiff), "not RIFF");

        byte[] truncated = new byte[20];
        System.arraycopy(wav, 0, truncated, 0, 20);
        Check.nullValue(VoiceRecognitionCore.Pcm.payloadOffset(truncated), "incomplete chunk");
    }

    private static void transcript() throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("transcript", "hello");
        Check.equal("hello", VoiceRecognitionCore.Pcm.transcript(response(200, "application/json", body)), "transcript");
        Check.failure("transport", () -> VoiceRecognitionCore.Pcm.transcript(response(500, "application/json", body)), "status");
        Check.failure("transport", () -> VoiceRecognitionCore.Pcm.transcript(response(200, "text/plain", body)), "mime");
        Map<String, Object> missing = new LinkedHashMap<>();
        Check.failure("transport", () -> VoiceRecognitionCore.Pcm.transcript(response(200, "application/json", missing)), "field");
        Map<String, Object> longText = new LinkedHashMap<>();
        longText.put("transcript", "x".repeat(65_537));
        Check.failure("transport", () -> VoiceRecognitionCore.Pcm.transcript(response(200, "application/json", longText)),
                "text bound");
    }

    private static void settings() throws Exception {
        Map<String, Object> local = new LinkedHashMap<>();
        local.put("sttProvider", "local");
        VoiceRecognitionCore.Settings parsed = VoiceRecognitionCore.Settings.parse(
                response(200, "application/json", local), "local");
        Check.equal("local", parsed.provider, "provider");
        Check.equal(9, parsed.authority.size(), "authority snapshot");

        Check.failure("settingsChanged", () -> VoiceRecognitionCore.Settings.parse(
                response(200, "application/json", local), "volcengine"), "provider change");

        Map<String, Object> volcengine = new LinkedHashMap<>();
        volcengine.put("sttProvider", "volcengine");
        Check.failure("unavailable", () -> VoiceRecognitionCore.Settings.parse(
                response(200, "application/json", volcengine), "volcengine"), "unconfigured volcengine");

        Map<String, Object> compatible = new LinkedHashMap<>();
        compatible.put("sttProvider", "openai-compatible");
        compatible.put("sttServerUrl", "  ");
        Check.failure("unavailable", () -> VoiceRecognitionCore.Settings.parse(
                response(200, "application/json", compatible), "openai-compatible"), "blank server");

        Map<String, Object> unknown = new LinkedHashMap<>();
        unknown.put("sttProvider", "cloud");
        Check.failure("invalid", () -> VoiceRecognitionCore.Settings.parse(
                response(200, "application/json", unknown), "cloud"), "unknown provider");

        Map<String, Object> changed = new LinkedHashMap<>();
        changed.put("sttProvider", "local");
        changed.put("sttModel", "large");
        VoiceRecognitionCore.Settings first = VoiceRecognitionCore.Settings.parse(
                response(200, "application/json", local), "local");
        VoiceRecognitionCore.Settings second = VoiceRecognitionCore.Settings.parse(
                response(200, "application/json", changed), "local");
        Check.isFalse(first.authority.equals(second.authority), "authority detects saved changes");
    }

    private static void request() throws Exception {
        HostLease.Scope scope = new HostLease.Scope("host-a", "00000000-0000-4000-8000-000000000000");
        Map<String, Object> start = new LinkedHashMap<>();
        start.put("owner", "settings-voice-1");
        start.put("revision", 1L);
        start.put("provider", "local");
        start.put("expectedHost", Map.of("hostID", scope.hostID, "lease", scope.lease));
        VoiceRecognitionCore.Request parsed = VoiceRecognitionCore.Request.parse(start, true);
        Check.equal("settings-voice-1", parsed.owner, "owner");
        Check.equal(1, parsed.revision, "revision");
        Check.equal("local", parsed.provider, "provider");
        Check.equal(scope, parsed.expectedHost, "scope");

        Map<String, Object> extra = new LinkedHashMap<>(start);
        extra.put("apiKey", "x");
        Check.failure("invalid", () -> VoiceRecognitionCore.Request.parse(extra, true), "extra key rejected");
        Check.failure("invalid", () -> VoiceRecognitionCore.Request.parse(start, false), "finish keys");
        start.put("provider", "cloud");
        Check.failure("invalid", () -> VoiceRecognitionCore.Request.parse(start, true), "unknown provider");
    }

    private static VoiceRecognitionRuntime.Response response(int status, String mime, Map<String, Object> body) {
        return new VoiceRecognitionRuntime.Response(status, mime, body);
    }

    private static String ascii(byte[] data, int from, int to) {
        return new String(data, from, to - from, java.nio.charset.StandardCharsets.US_ASCII);
    }

    private static int littleEndian(byte[] data, int offset, int count) {
        int value = 0;
        for (int i = 0; i < count; i++) value |= (data[offset + i] & 255) << (8 * i);
        return value;
    }
}
