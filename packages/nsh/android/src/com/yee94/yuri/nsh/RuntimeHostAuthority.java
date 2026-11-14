package com.yee94.yuri.nsh;

import java.util.UUID;

/**
 * Closed until native foreground admission. Observing a snapshot never creates or
 * refreshes a lease; only explicit successful lifecycle/connection transitions do.
 */
public final class RuntimeHostAuthority {
    private boolean foreground = false;
    private RuntimeHostScope issued;

    public synchronized boolean isForeground() { return foreground; }

    public synchronized RuntimeHostScope scope(String hostID) {
        if (!foreground || issued == null || hostID == null || !issued.hostID.equals(hostID)) return null;
        return issued;
    }

    public synchronized void rotate(String hostID) {
        issued = foreground && hostID != null
            ? new RuntimeHostScope(hostID, UUID.randomUUID().toString())
            : null;
    }

    /** @return true when the foreground state actually changed. */
    public synchronized boolean setForeground(boolean active, String hostID) {
        if (active == foreground) return false;
        foreground = active;
        rotate(hostID);
        return true;
    }

    public synchronized RuntimeHostScope admit(RuntimeHostScope expected, String hostID, boolean required)
            throws RuntimeHostScopeFailure {
        if (!foreground) throw RuntimeHostScopeFailure.background();
        if (required && expected == null) throw RuntimeHostScopeFailure.required();
        RuntimeHostScope current = scope(hostID);
        if (current == null) throw RuntimeHostScopeFailure.unavailable();
        if (expected != null && !expected.equals(current)) throw RuntimeHostScopeFailure.stale();
        return current;
    }

    public synchronized boolean matches(RuntimeHostScope expected, String hostID) {
        RuntimeHostScope current = scope(hostID);
        return current != null && expected != null && current.equals(expected);
    }
}
