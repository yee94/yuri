package com.yee94.yuri.nsh;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Only the JS history owner's completion. The caller still combines every other cleanup
 * owner before acknowledging ConnectionStore's durable receipt.
 */
public final class AuthorizationCacheCleanup {
    public static final class Identity {
        public final String connectionID;
        public final String authorizationID;

        public Identity(String connectionID, String authorizationID) {
            this.connectionID = connectionID;
            this.authorizationID = authorizationID;
        }

        @Override public boolean equals(Object o) {
            if (!(o instanceof Identity)) return false;
            Identity other = (Identity) o;
            return connectionID.equals(other.connectionID) && authorizationID.equals(other.authorizationID);
        }

        @Override public int hashCode() { return connectionID.hashCode() * 31 + authorizationID.hashCode(); }
    }

    public interface Pending { Set<Identity> pending(); }

    private final Pending pending;
    private String owner;
    private final Map<String, Identity> tickets = new LinkedHashMap<>();
    private final Set<String> claimed = new LinkedHashSet<>();
    private final Set<Identity> completed = new LinkedHashSet<>();

    public AuthorizationCacheCleanup(Pending pending) { this.pending = pending; }

    public synchronized Map<String, Object> ready() {
        owner = UUID.randomUUID().toString().toUpperCase(Locale.ROOT);
        tickets.clear();
        claimed.clear();
        completed.clear();
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("owner", owner);
        value.put("tickets", new ArrayList<Object>(refreshTickets()));
        return value;
    }

    public synchronized List<String> list(String owner) throws RuntimeBridgeFailure {
        validate(owner);
        return refreshTickets();
    }

    public synchronized Map<String, Object> claim(String owner, String ticket) throws RuntimeBridgeFailure {
        validate(owner);
        Identity identity = tickets.get(ticket);
        if (identity == null || !pending.pending().contains(identity) || completed.contains(identity)) {
            throw new RuntimeBridgeFailure("authorization_cache_invalid_ticket");
        }
        claimed.add(ticket);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("connectionID", identity.connectionID);
        value.put("authorizationID", identity.authorizationID);
        return value;
    }

    public synchronized void ack(String owner, String ticket) throws RuntimeBridgeFailure {
        validate(owner);
        Identity identity = tickets.get(ticket);
        if (identity == null || !pending.pending().contains(identity) || !claimed.contains(ticket)) {
            throw new RuntimeBridgeFailure("authorization_cache_invalid_ticket");
        }
        completed.add(identity);
    }

    /**
     * Called only with RuntimeBridge's native retirement callback arguments. A JS-supplied
     * identity is never proof of completion.
     */
    public synchronized void requireCompletion(String connectionID, String authorizationID) throws RuntimeBridgeFailure {
        Identity identity = new Identity(connectionID, authorizationID);
        if (!pending.pending().contains(identity) || !completed.contains(identity)) {
            throw new RuntimeBridgeFailure("authorization_cache_cleanup_pending");
        }
    }

    private void validate(String value) throws RuntimeBridgeFailure {
        if (owner == null || !owner.equals(value)) throw new RuntimeBridgeFailure("authorization_cache_stale_owner");
    }

    private List<String> refreshTickets() {
        Set<Identity> current = pending.pending();
        tickets.entrySet().removeIf(entry -> !current.contains(entry.getValue()));
        claimed.retainAll(tickets.keySet());
        completed.retainAll(current);
        for (Identity identity : current) {
            if (completed.contains(identity) || tickets.containsValue(identity)) continue;
            tickets.put(UUID.randomUUID().toString().toUpperCase(Locale.ROOT), identity);
        }
        List<String> values = new ArrayList<>();
        for (Map.Entry<String, Identity> entry : tickets.entrySet()) {
            if (!completed.contains(entry.getValue())) values.add(entry.getKey());
        }
        values.sort(String::compareTo);
        return values;
    }
}
