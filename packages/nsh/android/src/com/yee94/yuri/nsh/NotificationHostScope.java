package com.yee94.yuri.nsh;

/**
 * Notification-side view of one captured Host lease: opaque Host id, transport generation fence and the
 * durable authorization generation. Mirrors iOS NotificationHostScope.
 *
 * <p>HostLease deliberately carries no connection identity, so the authorization generation is read from
 * the lease when the runtime's HostLease implementation also implements {@link Authorization}. Without
 * it the scope is still usable for status/configure suppression, but anything that must persist across a
 * cold start (launch receipts, navigable live notifications) fails closed instead of guessing a value.
 */
public final class NotificationHostScope {
    /** Optional companion of {@link HostLease}: the connection owner's durable authorization generation. */
    public interface Authorization {
        /** Rotates on re-pair, origin or credential change; never a JS-supplied or editor version. */
        String authorizationID();
    }

    private final HostLease lease;
    public final String hostID;
    public final String authorizationID;

    private NotificationHostScope(HostLease lease) {
        String authorization = lease instanceof Authorization ? ((Authorization) lease).authorizationID() : null;
        if (authorization != null && (!NotificationPolicy.identifier(authorization) || "legacy".equals(authorization))) {
            authorization = null;
        }
        this.lease = lease;
        this.hostID = lease.scope().hostID;
        this.authorizationID = authorization;
    }

    public static NotificationHostScope capture(HostLease lease) { return new NotificationHostScope(lease); }

    /** Live transport generation, not a snapshot taken at capture time. */
    public boolean isCurrent() { return lease.isCurrent(); }

    /** Same binding test the bridge applies after a fresh capture. */
    public boolean matches(String hostID, String authorizationID) {
        if (!this.hostID.equals(hostID)) return false;
        return this.authorizationID == null ? authorizationID == null : this.authorizationID.equals(authorizationID);
    }
}
