package com.yee94.yuri.nsh;

public interface HostLeaseProvider {
    /** expected == null uses the current scope; a stale or missing scope throws a RuntimeHostScopeFailure. */
    HostLease capture(HostLease.Scope expected) throws Exception;
}
