package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One saved Host. Credentials stay in this native record; {@link #publicValue()} is the
 * only shape JS receives and never contains the token or the pinned Relay key.
 */
public final class ConnectionEditorConnection {
    public final String id;
    public String label;
    public final String url;
    public final String token;
    public double lastUsedAt;
    public final ConnectionEditorRelay relay;
    public String editorVersion;
    public String authorizationID;
    public String transportID;

    public ConnectionEditorConnection(String id, String label, String url, String token, double lastUsedAt,
                                      ConnectionEditorRelay relay, String editorVersion, String authorizationID,
                                      String transportID) {
        this.id = id;
        this.label = label;
        this.url = url;
        this.token = token;
        this.lastUsedAt = lastUsedAt;
        this.relay = relay;
        this.editorVersion = editorVersion;
        this.authorizationID = authorizationID;
        this.transportID = transportID;
    }

    public ConnectionEditorConnection copy() {
        return new ConnectionEditorConnection(id, label, url, token, lastUsedAt, relay, editorVersion, authorizationID, transportID);
    }

    public Map<String, Object> publicValue() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("id", id);
        value.put("label", label);
        value.put("url", relay != null ? relay.relayUrl : url);
        value.put("transport", relay == null ? "direct" : "relay");
        value.put("lastUsedAt", lastUsedAt);
        if (authorizationID != null) value.put("authorizationID", authorizationID);
        if (transportID != null) value.put("transportID", transportID);
        return value;
    }

    public Map<String, Object> editorValue() {
        Map<String, Object> value = publicValue();
        value.put("version", editorVersion != null ? editorVersion : "legacy");
        return value;
    }

    public Map<String, Object> encode() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("id", id);
        value.put("label", label);
        value.put("url", url);
        value.put("token", token);
        value.put("lastUsedAt", lastUsedAt);
        if (relay != null) value.put("relay", relay.encode());
        if (editorVersion != null) value.put("editorVersion", editorVersion);
        if (authorizationID != null) value.put("authorizationID", authorizationID);
        if (transportID != null) value.put("transportID", transportID);
        return value;
    }

    public static ConnectionEditorConnection decode(Object value) throws ConnectionEditorFailure {
        Map<String, Object> fields = RuntimeBridgeJson.object(value);
        if (fields == null) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        for (String key : fields.keySet()) {
            boolean allowed = "id".equals(key) || "label".equals(key) || "url".equals(key) || "token".equals(key)
                || "lastUsedAt".equals(key) || "relay".equals(key) || "editorVersion".equals(key)
                || "authorizationID".equals(key) || "transportID".equals(key);
            if (!allowed) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        Object id = fields.get("id");
        Object label = fields.get("label");
        Object url = fields.get("url");
        Object token = fields.get("token");
        Object lastUsedAt = fields.get("lastUsedAt");
        if (!(id instanceof String) || ((String) id).isEmpty()) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        if (!(label instanceof String)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        if (!(url instanceof String)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        if (!(token instanceof String)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        Double used = RuntimeBridgeJson.number(lastUsedAt);
        if (used == null || !Double.isFinite(used)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        ConnectionEditorRelay relay = fields.containsKey("relay") ? ConnectionEditorRelay.decode(fields.get("relay")) : null;
        String editorVersion = optionalString(fields, "editorVersion");
        String authorizationID = optionalString(fields, "authorizationID");
        String transportID = optionalString(fields, "transportID");
        // The stored origin must still be canonical, otherwise the partition identity drifts.
        ConnectionEditorTransport.from((String) url, relay);
        return new ConnectionEditorConnection((String) id, (String) label, (String) url, (String) token, used, relay,
            editorVersion, authorizationID, transportID);
    }

    private static String optionalString(Map<String, Object> fields, String key) throws ConnectionEditorFailure {
        Object value = fields.get(key);
        if (value == null) return null;
        if (!(value instanceof String)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        return (String) value;
    }
}
