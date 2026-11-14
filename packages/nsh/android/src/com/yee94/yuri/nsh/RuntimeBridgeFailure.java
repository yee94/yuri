package com.yee94.yuri.nsh;

/**
 * Failure whose {@code code} is the machine name shared with iOS and whose message is
 * exactly what JS receives. Messages never contain a URL, bearer, password or pairing
 * secret: Host error text is dropped rather than forwarded.
 */
public final class RuntimeBridgeFailure extends Exception {
    public final String code;

    public RuntimeBridgeFailure(String code) { this(code, code); }

    public RuntimeBridgeFailure(String code, String message) { super(message); this.code = code; }
}
