package com.longbridge.nsh;

/**
 * Compile-only stand-in for the nsh.aar API while the distribution is not built locally.
 * Signatures match com.longbridge.nsh.NshHostReply; never shipped.
 */
public final class NshHostReply {
    public boolean isPost() { return false; }
    public void resolve(Object value) {}
    public void reject(String message) {}
}
