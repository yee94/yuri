package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * One durable transport identity: a direct Host origin or a Relay endpoint plus server ID.
 * Direct connections and each server/Relay endpoint have separate identities.
 */
public final class ConnectionEditorTransport {
    public final String address;
    public final String serverID;

    public ConnectionEditorTransport(String address, String serverID) {
        this.address = address;
        this.serverID = serverID;
    }

    public static ConnectionEditorTransport from(String url, ConnectionEditorRelay relay) throws ConnectionEditorFailure {
        if (relay != null) {
            if (!ConnectionEditorRelay.validServerId(relay.serverId)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
            return new ConnectionEditorTransport(ConnectionEditorRelay.canonicalAddress(relay.relayUrl), relay.serverId);
        }
        return new ConnectionEditorTransport(ConnectionEditorRecords.origin(url), null);
    }

    public Map<String, Object> encode() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("address", address);
        if (serverID != null) value.put("serverID", serverID);
        return value;
    }

    public static ConnectionEditorTransport decode(Object value) throws ConnectionEditorFailure {
        Map<String, Object> fields = RuntimeBridgeJson.object(value);
        if (fields == null || fields.size() > 2 || !fields.containsKey("address")) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        Object address = fields.get("address");
        Object server = fields.get("serverID");
        if (!(address instanceof String) || (server != null && !(server instanceof String))) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        ConnectionEditorRelay relay = server == null
            ? null
            : new ConnectionEditorRelay((String) address, (String) server, new LinkedHashMap<>());
        ConnectionEditorTransport decoded = from((String) address, relay);
        if (!decoded.address.equals(address)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        return decoded;
    }

    @Override public boolean equals(Object o) {
        if (!(o instanceof ConnectionEditorTransport)) return false;
        ConnectionEditorTransport other = (ConnectionEditorTransport) o;
        if (serverID == null ? other.serverID != null : !serverID.equals(other.serverID)) return false;
        return address.equals(other.address);
    }

    @Override public int hashCode() { return address.hashCode() * 31 + (serverID == null ? 0 : serverID.hashCode()); }
}
