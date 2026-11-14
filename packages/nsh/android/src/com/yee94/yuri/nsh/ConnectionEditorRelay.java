package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** Relay routing identity pinned at pairing time; never a credential. */
public final class ConnectionEditorRelay {
    public final String relayUrl;
    public final String serverId;
    public final Map<String, String> hostEncPubJwk;

    public ConnectionEditorRelay(String relayUrl, String serverId, Map<String, String> hostEncPubJwk) {
        this.relayUrl = relayUrl;
        this.serverId = serverId;
        this.hostEncPubJwk = hostEncPubJwk == null ? new LinkedHashMap<>() : new LinkedHashMap<>(hostEncPubJwk);
    }

    public String scope() { return relayUrl + "\n" + serverId; }

    /** ws(s), no userinfo/query/fragment; default ports are dropped and case normalized. */
    public static String canonicalAddress(String value) throws ConnectionEditorFailure {
        if (value == null || value.indexOf('\\') >= 0 || RuntimeHostText.hasControl(value)) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        RuntimeHostUri.Parts parts = RuntimeHostUri.parse(value);
        if (parts == null || parts.scheme == null || !parts.authority) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        String scheme = parts.scheme.toLowerCase(Locale.ROOT);
        if (!"ws".equals(scheme) && !"wss".equals(scheme)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        if (parts.host == null || parts.host.isEmpty() || parts.hasCredentials()
                || parts.query != null || parts.fragment != null) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        Integer port = parts.port;
        if (("wss".equals(scheme) && port != null && port == 443) || ("ws".equals(scheme) && port != null && port == 80)) port = null;
        StringBuilder out = new StringBuilder();
        out.append(scheme).append("://").append(parts.host.toLowerCase(Locale.ROOT));
        if (port != null) out.append(':').append(port);
        out.append(parts.path);
        return out.toString();
    }

    static boolean validServerId(String value) {
        if (value == null || value.isEmpty() || RuntimeHostText.utf8Length(value) > 256) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
            if (!ok) return false;
        }
        return true;
    }

    public Map<String, Object> encode() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("relayUrl", relayUrl);
        value.put("serverId", serverId);
        value.put("hostEncPubJwk", new LinkedHashMap<String, Object>(hostEncPubJwk));
        return value;
    }

    public static ConnectionEditorRelay decode(Object value) throws ConnectionEditorFailure {
        Map<String, Object> fields = RuntimeBridgeJson.object(value);
        if (fields == null || fields.size() != 3) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        Object url = fields.get("relayUrl");
        Object server = fields.get("serverId");
        Object key = fields.get("hostEncPubJwk");
        if (!(url instanceof String) || !(server instanceof String)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        Map<String, Object> jwk = RuntimeBridgeJson.object(key);
        if (jwk == null) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        Map<String, String> flattened = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : jwk.entrySet()) {
            if (!(entry.getValue() instanceof String)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
            flattened.put(entry.getKey(), (String) entry.getValue());
        }
        String canonical = canonicalAddress((String) url);
        if (!validServerId((String) server)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        return new ConnectionEditorRelay(canonical, (String) server, flattened);
    }

    @Override public boolean equals(Object o) {
        if (!(o instanceof ConnectionEditorRelay)) return false;
        ConnectionEditorRelay other = (ConnectionEditorRelay) o;
        return relayUrl.equals(other.relayUrl) && serverId.equals(other.serverId) && hostEncPubJwk.equals(other.hostEncPubJwk);
    }

    @Override public int hashCode() { return scope().hashCode() * 31 + hostEncPubJwk.hashCode(); }
}
