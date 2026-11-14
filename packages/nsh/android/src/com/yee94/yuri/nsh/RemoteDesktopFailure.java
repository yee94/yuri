package com.yee94.yuri.nsh;

/** Mirrors RemoteDesktopBridgeFailure in ios/RemoteDesktopBridge.swift: the code is the message. */
public final class RemoteDesktopFailure extends Exception {
    public final String code;

    public RemoteDesktopFailure(String code) {
        super(code);
        this.code = code;
    }

    public static RemoteDesktopFailure of(String code) {
        return new RemoteDesktopFailure(code);
    }
}
