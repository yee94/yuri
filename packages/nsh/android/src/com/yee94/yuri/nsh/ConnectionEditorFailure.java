package com.yee94.yuri.nsh;

/** Codes parity with iOS {@code ConnectionEditorFailure}; the message JS sees is the code. */
public final class ConnectionEditorFailure extends Exception {
    public static final String INVALID = "connection_editor_invalid";
    public static final String MISSING = "connection_editor_missing";
    public static final String STALE = "connection_editor_stale";
    public static final String PAIRING_REQUIRED = "connection_editor_pairing_required";
    public static final String DUPLICATE = "connection_editor_duplicate";
    public static final String STORAGE = "connection_editor_storage";

    public final String code;

    public ConnectionEditorFailure(String code) { super(code); this.code = code; }
}
