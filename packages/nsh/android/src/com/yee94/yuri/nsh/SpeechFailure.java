package com.yee94.yuri.nsh;

/** Mirrors SpeechFailure in ios/SpeechPlaybackBridge.swift: the code is the rejection message. */
public final class SpeechFailure extends Exception {
    public final String code;

    public SpeechFailure(String code) {
        super(code);
        this.code = code;
    }

    /** The only failure iOS re-throws unchanged: the Host route itself is unavailable. */
    public boolean unavailable() {
        return code.equals("unavailable");
    }

    public static SpeechFailure of(String code) {
        return new SpeechFailure(code);
    }
}
