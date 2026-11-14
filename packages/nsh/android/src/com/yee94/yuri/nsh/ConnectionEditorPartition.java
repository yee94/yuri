package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Map;

/** Opaque transport partition identity so renamed/re-authorized Hosts keep their bucket. */
public final class ConnectionEditorPartition {
    public final ConnectionEditorTransport transport;
    public final String id;

    public ConnectionEditorPartition(ConnectionEditorTransport transport, String id) {
        this.transport = transport;
        this.id = id;
    }

    public Map<String, Object> encode() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("transport", transport.encode());
        value.put("id", id);
        return value;
    }

    public static ConnectionEditorPartition decode(Object value) throws ConnectionEditorFailure {
        Map<String, Object> fields = RuntimeBridgeJson.object(value);
        if (fields == null || fields.size() != 2 || !fields.containsKey("transport") || !fields.containsKey("id")) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        Object id = fields.get("id");
        if (!(id instanceof String)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        return new ConnectionEditorPartition(ConnectionEditorTransport.decode(fields.get("transport")), (String) id);
    }
}
