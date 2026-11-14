package com.yee94.yuri.nsh;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Ported from NativeSpeechVoiceCatalog/NativeSpeechVoiceScope in ios/SpeechVoiceCatalogPolicy.swift.
 * A read-only admission receipt: it carries no transport, credentials or playback owner.
 */
public final class SpeechVoiceCatalogPolicy {
    public static final class Identity {
        public final String identifier;
        public final String name;
        public final String language;

        public Identity(String identifier, String name, String language) {
            this.identifier = identifier;
            this.name = name;
            this.language = language;
        }

        public Map<String, Object> publicValue() {
            java.util.LinkedHashMap<String, Object> value = new java.util.LinkedHashMap<>();
            value.put("identifier", identifier);
            value.put("name", name);
            value.put("language", language);
            return value;
        }
    }

    public interface Voices {
        List<Identity> read() throws Exception;
    }

    public interface Foreground {
        boolean get();
    }

    private SpeechVoiceCatalogPolicy() {}

    public static Map<String, Object> read(Object input, HostLeaseProvider leases, Foreground foreground, Voices voices)
            throws SpeechFailure {
        if (!(input instanceof Map) || !((Map<?, ?>) input).keySet().equals(Set.of("expectedHost"))) {
            throw SpeechFailure.of("runtime_host_scope_invalid");
        }
        HostLease.Scope expected;
        try {
            expected = TerminalBridge.scope(((Map<?, ?>) input).get("expectedHost"));
        } catch (TerminalFailure failure) {
            throw SpeechFailure.of("runtime_host_scope_invalid");
        }
        if (!foreground.get()) throw SpeechFailure.of("runtime_background");
        HostLease captured;
        try {
            captured = leases.capture(expected);
        } catch (Exception error) {
            String message = error.getMessage();
            boolean code = message != null && !message.isEmpty() && message.length() <= 64
                    && message.chars().allMatch(c -> (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_');
            throw SpeechFailure.of(code ? message : "runtime_host_unavailable");
        }
        if (captured == null) throw SpeechFailure.of("runtime_host_unavailable");
        if (!foreground.get()) throw SpeechFailure.of("runtime_background");
        if (!expected.equals(captured.scope()) || !captured.isCurrent()) {
            throw SpeechFailure.of("runtime_host_scope_stale");
        }
        List<Object> result = new ArrayList<>();
        try {
            for (Identity voice : voices.read()) result.add(voice.publicValue());
        } catch (Exception error) {
            throw SpeechFailure.of("unavailable");
        }
        if (!foreground.get()) throw SpeechFailure.of("runtime_background");
        if (!captured.isCurrent()) throw SpeechFailure.of("runtime_host_scope_stale");
        Map<String, Object> value = new java.util.LinkedHashMap<>();
        value.put("voices", result);
        return value;
    }
}
