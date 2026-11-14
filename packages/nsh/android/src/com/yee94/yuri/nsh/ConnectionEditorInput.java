package com.yee94.yuri.nsh;

import java.util.Map;

/** Only metadata travels to JS. Tokens and Relay identities never round-trip through a form. */
public final class ConnectionEditorInput {
    public final String id;
    public final String version;
    public final String label;
    public final String url;

    private ConnectionEditorInput(String id, String version, String label, String url) {
        this.id = id;
        this.version = version;
        this.label = label;
        this.url = url;
    }

    public static ConnectionEditorInput parse(Object input, boolean rename) throws ConnectionEditorFailure {
        Map<String, Object> args = RuntimeBridgeJson.object(input);
        if (args == null) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        for (String key : args.keySet()) {
            boolean allowed = "id".equals(key) || "version".equals(key) || "label".equals(key) || (!rename && "url".equals(key));
            if (!allowed) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        Object id = args.get("id");
        Object version = args.get("version");
        Object rawLabel = args.get("label");
        if (!(id instanceof String) || ((String) id).isEmpty()) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        if (!(version instanceof String) || ((String) version).isEmpty()) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        if (!(rawLabel instanceof String)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        String label = ((String) rawLabel).trim();
        if (label.isEmpty() || label.length() > 120 || RuntimeHostText.hasControl(label)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        if (args.containsKey("url") && !(args.get("url") instanceof String)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        return new ConnectionEditorInput((String) id, (String) version, label, (String) args.get("url"));
    }

    public static ConnectionEditorInput labelOnly(String id, String version, String label) throws ConnectionEditorFailure {
        return new ConnectionEditorInput(id, version, label, null);
    }
}
