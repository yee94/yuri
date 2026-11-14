package com.yee94.yuri.nsh;

/** Mirrors TerminalFailure in ios/TerminalBridge.swift: the message is the raw value. */
public final class TerminalFailure extends Exception {
    public final String code;

    public TerminalFailure(String code) {
        super(code);
        this.code = code;
    }

    public static TerminalFailure of(String code) {
        return new TerminalFailure(code);
    }
}
