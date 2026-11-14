package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Process-local admission receipt, not a persisted connection version or provider
 * configuration revision. Neither ConnectionStore nor JSON persistence owns this value.
 */
public final class RuntimeHostScope {
    public final String hostID;
    public final String lease;

    public RuntimeHostScope(String hostID, String lease) { this.hostID = hostID; this.lease = lease; }

    /** Strict {@code {hostID, lease}} envelope; unknown keys are invalid. */
    public static RuntimeHostScope parse(Object input) throws RuntimeHostScopeFailure {
        if (!(input instanceof Map)) throw RuntimeHostScopeFailure.invalid();
        Map<?, ?> value = (Map<?, ?>) input;
        if (value.size() != 2 || !value.containsKey("hostID") || !value.containsKey("lease")) throw RuntimeHostScopeFailure.invalid();
        Object hostID = value.get("hostID");
        Object raw = value.get("lease");
        if (!(hostID instanceof String) || !(raw instanceof String)) throw RuntimeHostScopeFailure.invalid();
        String id = (String) hostID;
        String lease = (String) raw;
        if (id.isEmpty() || RuntimeHostText.utf8Length(id) > 256 || RuntimeHostText.hasControl(id)) throw RuntimeHostScopeFailure.invalid();
        if (RuntimeHostText.utf8Length(lease) != 36 || !RuntimeHostText.uuid(lease)) throw RuntimeHostScopeFailure.invalid();
        return new RuntimeHostScope(id, lease);
    }

    public Map<String, Object> publicValue() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("hostID", hostID);
        value.put("lease", lease.toLowerCase(java.util.Locale.ROOT));
        return value;
    }

    public HostLease.Scope toLeaseScope() { return new HostLease.Scope(hostID, lease.toLowerCase(java.util.Locale.ROOT)); }

    public static RuntimeHostScope fromLeaseScope(HostLease.Scope scope) { return new RuntimeHostScope(scope.hostID, scope.lease); }

    @Override public boolean equals(Object o) {
        if (!(o instanceof RuntimeHostScope)) return false;
        RuntimeHostScope other = (RuntimeHostScope) o;
        return hostID.equals(other.hostID) && RuntimeHostText.lower(lease).equals(RuntimeHostText.lower(other.lease));
    }

    @Override public int hashCode() { return hostID.hashCode() * 31 + RuntimeHostText.lower(lease).hashCode(); }
}
