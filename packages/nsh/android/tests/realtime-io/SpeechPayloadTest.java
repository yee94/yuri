package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Map;

/** Settings/segment/awake parity with SpeechPlaybackBridge.swift value types. */
public final class SpeechPayloadTest {
    public static void main(String[] args) throws Exception {
        settings();
        segments();
        awake();
        audioHeaders();
        System.out.println("SpeechPayloadTest OK");
    }

    private static Map<String, Object> settingsBody() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("voiceProvider", "local");
        value.put("ttsInputMode", "final");
        value.put("showMessageTTSButtons", true);
        value.put("speechRate", 1.0d);
        value.put("speechPitch", 1.0d);
        value.put("speechVolume", 1.0d);
        value.put("browserVoice", "en-us-x-sfg");
        return value;
    }

    private static void settings() throws Exception {
        SpeechPlaybackBridge.Settings parsed = SpeechPlaybackBridge.Settings.parse(settingsBody());
        Check.equal("local", parsed.provider, "provider");
        Check.equal("/api/dictation/tts/speak", parsed.route(), "local route");
        Check.equal("en-us-x-sfg", parsed.voice, "voice");
        Check.isTrue(parsed.visible, "visible");
        Map<String, Object> publicValue = parsed.publicValue();
        Check.equal(3, publicValue.size(), "public keys");

        Map<String, Object> browser = settingsBody();
        browser.put("voiceProvider", "browser");
        Check.nullValue(SpeechPlaybackBridge.Settings.parse(browser).route(), "browser route");
        Map<String, Object> say = settingsBody();
        say.put("voiceProvider", "say");
        Check.equal("/api/tts/say/speak", SpeechPlaybackBridge.Settings.parse(say).route(), "say route");
        Map<String, Object> openai = settingsBody();
        openai.put("voiceProvider", "volcengine");
        Check.equal("/api/tts/speak", SpeechPlaybackBridge.Settings.parse(openai).route(), "host route");

        Map<String, Object> unknown = settingsBody();
        unknown.put("voiceProvider", "cloud");
        Check.failure("invalid", () -> SpeechPlaybackBridge.Settings.parse(unknown), "unknown provider");
        Map<String, Object> mode = settingsBody();
        mode.put("ttsInputMode", "speech");
        Check.failure("invalid", () -> SpeechPlaybackBridge.Settings.parse(mode), "unknown mode");
        Map<String, Object> flag = settingsBody();
        flag.put("showMessageTTSButtons", "true");
        Check.failure("invalid", () -> SpeechPlaybackBridge.Settings.parse(flag), "boolean flag");
        Map<String, Object> rate = settingsBody();
        rate.put("speechRate", 2.5d);
        Check.failure("invalid", () -> SpeechPlaybackBridge.Settings.parse(rate), "rate bound");
        Map<String, Object> volume = settingsBody();
        volume.put("speechVolume", -1d);
        Check.failure("invalid", () -> SpeechPlaybackBridge.Settings.parse(volume), "volume bound");
        Map<String, Object> missing = settingsBody();
        missing.remove("speechPitch");
        Check.failure("invalid", () -> SpeechPlaybackBridge.Settings.parse(missing), "missing number");
    }

    private static Map<String, Object> segmentBody(int revision, String source) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("owner", "chat-speech-1");
        value.put("revision", (long) revision);
        value.put("text", "Read this out loud");
        if (source != null) value.put("source", source);
        return value;
    }

    private static void segments() throws Exception {
        SpeechPlaybackBridge.Segment manual = SpeechPlaybackBridge.Segment.parse(segmentBody(2, null), "chat-speech-1", 1);
        Check.equal(2, manual.revision, "revision");
        Check.equal("manual", manual.source, "default source");
        manual.validatePlayback(true, true, true);
        Check.failure("invalid", () -> manual.validatePlayback(false, true, true), "hidden manual segment");

        SpeechPlaybackBridge.Segment automatic = SpeechPlaybackBridge.Segment.parse(
                segmentBody(3, "auto-read"), "chat-speech-1", 2);
        automatic.validatePlayback(false, true, true);

        SpeechPlaybackBridge.Segment preview = SpeechPlaybackBridge.Segment.parse(
                segmentBody(4, "settings-preview"), "chat-speech-1", 3);
        preview.validatePlayback(false, true, true);

        Check.failure("invalid", () -> SpeechPlaybackBridge.Segment.parse(segmentBody(1, null), "chat-speech-1", 1),
                "revision must advance");
        Check.failure("invalid", () -> SpeechPlaybackBridge.Segment.parse(segmentBody(2, null), "other", 1), "owner fence");
        Check.failure("invalid", () -> SpeechPlaybackBridge.Segment.parse(segmentBody(2, "stream"), "chat-speech-1", 1),
                "unknown source");
        Map<String, Object> blank = segmentBody(2, null);
        blank.put("text", "   ");
        Check.failure("invalid", () -> SpeechPlaybackBridge.Segment.parse(blank, "chat-speech-1", 1), "blank text");
        Map<String, Object> extra = segmentBody(2, null);
        extra.put("provider", "x");
        Check.failure("invalid", () -> SpeechPlaybackBridge.Segment.parse(extra, "chat-speech-1", 1), "extra key");
    }

    /** Host audio headers may narrow the settings values but never invent a stronger one. */
    private static void audioHeaders() throws Exception {
        Map<String, Object> body = settingsBody();
        body.put("speechPitch", 1.5d);
        body.put("speechVolume", 0.4d);
        SpeechPlaybackBridge.Settings settings = SpeechPlaybackBridge.Settings.parse(body);
        byte[] audio = { 1, 2, 3 };

        SpeechPlaybackBridge.Audio plain = new SpeechPlaybackBridge.Audio(
                new HostLease.RawResponse(200, "audio/mpeg", audio), settings);
        Check.equal(1.5d, plain.pitch, "absent pitch header uses settings");
        Check.equal(0.4d, plain.volume, "absent volume header uses settings");

        SpeechPlaybackBridge.Audio narrowed = new SpeechPlaybackBridge.Audio(
                new HostLease.RawResponse(200, "audio/mpeg", audio,
                        Map.of("x-speech-pitch", "0.8", "x-speech-volume", "1")), settings);
        Check.equal(0.8d, narrowed.pitch, "header pitch wins");
        Check.equal(1d, narrowed.volume, "header volume wins");

        Check.failure("audio", () -> new SpeechPlaybackBridge.Audio(
                new HostLease.RawResponse(200, "audio/mpeg", audio, Map.of("x-speech-pitch", "3")), settings),
                "pitch above range");
        Check.failure("audio", () -> new SpeechPlaybackBridge.Audio(
                new HostLease.RawResponse(200, "audio/mpeg", audio, Map.of("x-speech-pitch", "0.1")), settings),
                "pitch below range");
        Check.failure("audio", () -> new SpeechPlaybackBridge.Audio(
                new HostLease.RawResponse(200, "audio/mpeg", audio, Map.of("x-speech-pitch", "loud")), settings),
                "pitch must parse");
        Check.failure("audio", () -> new SpeechPlaybackBridge.Audio(
                new HostLease.RawResponse(200, "audio/mpeg", audio, Map.of("x-speech-volume", "-0.1")), settings),
                "volume below range");
        Check.failure("audio", () -> new SpeechPlaybackBridge.Audio(
                new HostLease.RawResponse(500, "audio/mpeg", audio), settings), "status");
        Check.failure("audio", () -> new SpeechPlaybackBridge.Audio(
                new HostLease.RawResponse(200, "application/json", audio), settings), "mime");
        Check.failure("audio", () -> new SpeechPlaybackBridge.Audio(
                new HostLease.RawResponse(200, "audio/mpeg", new byte[0]), settings), "empty audio");
    }

    private static void awake() throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("owner", "chat-speech-1");
        body.put("revision", 1L);
        body.put("enabled", true);
        SpeechPlaybackBridge.AwakeRequest request = SpeechPlaybackBridge.AwakeRequest.parse(body, "chat-speech-1", 0);
        Map<String, Object> response = request.response(true, true);
        Check.equal(false, response.get("supported"), "awake stays unsupported");
        Check.equal(false, response.get("enabled"), "awake never enabled");
        Check.failure("invalid", () -> request.response(false, true), "awake requires a live page");
        Check.failure("invalid", () -> request.response(true, false), "awake requires foreground");

        body.put("revision", 1L);
        Check.failure("invalid", () -> SpeechPlaybackBridge.AwakeRequest.parse(body, "chat-speech-1", 1),
                "revision must advance");
        body.put("enabled", "yes");
        Check.failure("invalid", () -> SpeechPlaybackBridge.AwakeRequest.parse(body, "chat-speech-1", 0),
                "enabled must be boolean");
    }
}
