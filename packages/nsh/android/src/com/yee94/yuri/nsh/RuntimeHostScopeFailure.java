package com.yee94.yuri.nsh;

/** Code parity with iOS {@code RuntimeHostScopeFailure}; the message JS sees is the code. */
public final class RuntimeHostScopeFailure extends Exception {
    public static final String INVALID = "runtime_host_scope_invalid";
    public static final String REQUIRED = "runtime_host_scope_required";
    public static final String STALE = "runtime_host_scope_stale";
    public static final String BACKGROUND = "runtime_background";
    public static final String UNAVAILABLE = "runtime_host_unavailable";

    public final String code;

    public RuntimeHostScopeFailure(String code) { super(code); this.code = code; }

    public static RuntimeHostScopeFailure invalid() { return new RuntimeHostScopeFailure(INVALID); }
    public static RuntimeHostScopeFailure required() { return new RuntimeHostScopeFailure(REQUIRED); }
    public static RuntimeHostScopeFailure stale() { return new RuntimeHostScopeFailure(STALE); }
    public static RuntimeHostScopeFailure background() { return new RuntimeHostScopeFailure(BACKGROUND); }
    public static RuntimeHostScopeFailure unavailable() { return new RuntimeHostScopeFailure(UNAVAILABLE); }
}
