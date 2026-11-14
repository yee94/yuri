package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Map;

/** Durable revocation identity only. No credential, endpoint or clock-derived identity. */
public final class ConnectionEditorRetirement {
    public static final String INVALID = "authorization_retirement_invalid";
    public static final String CAPACITY = "authorization_retirement_capacity";

    public final String connectionID;
    public final String authorizationID;

    public ConnectionEditorRetirement(String connectionID, String authorizationID) throws ConnectionEditorFailure {
        if (!identifier(connectionID) || !identifier(authorizationID) || "legacy".equals(authorizationID)) {
            throw new ConnectionEditorFailure(INVALID);
        }
        this.connectionID = connectionID;
        this.authorizationID = authorizationID;
    }

    private static boolean identifier(String value) {
        if (value == null || value.isEmpty() || RuntimeHostText.utf8Length(value) > 128) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '-' || c == '_';
            if (!ok) return false;
        }
        return true;
    }

    public Map<String, Object> encode() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("connectionID", connectionID);
        value.put("authorizationID", authorizationID);
        return value;
    }

    public static ConnectionEditorRetirement decode(Object value) throws ConnectionEditorFailure {
        Map<String, Object> fields = RuntimeBridgeJson.object(value);
        if (fields == null || fields.size() != 2) throw new ConnectionEditorFailure(INVALID);
        Object connection = fields.get("connectionID");
        Object authorization = fields.get("authorizationID");
        if (!(connection instanceof String) || !(authorization instanceof String)) throw new ConnectionEditorFailure(INVALID);
        return new ConnectionEditorRetirement((String) connection, (String) authorization);
    }

    @Override public boolean equals(Object o) {
        if (!(o instanceof ConnectionEditorRetirement)) return false;
        ConnectionEditorRetirement other = (ConnectionEditorRetirement) o;
        return connectionID.equals(other.connectionID) && authorizationID.equals(other.authorizationID);
    }

    @Override public int hashCode() { return connectionID.hashCode() * 31 + authorizationID.hashCode(); }
}
