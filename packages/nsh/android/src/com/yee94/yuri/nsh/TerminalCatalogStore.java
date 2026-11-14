package com.yee94.yuri.nsh;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Metadata-only local journal, ported from TerminalCatalogStore in ios/TerminalBridge.swift.
 * No lease, output, command, token or transport URL is persisted. Validation works on plain
 * maps so the JVM tests exercise it without the Android JSON stub.
 */
public final class TerminalCatalogStore {
    public static final int MAX_HOSTS = 64;
    public static final int MAX_DIRECTORIES = 128;
    public static final int MAX_TABS = 64;
    public static final int MAX_BYTES = 4_194_304;

    /** Persisted JSON codec; the Android implementation is org.json, tests inject one. */
    public interface Codec {
        Object parse(String json) throws Exception;

        String write(Object value) throws Exception;
    }

    /** Document storage; the default keeps one file under the app's files directory. */
    public interface Storage {
        String read() throws IOException;

        void write(String value) throws IOException;
    }

    private final Storage storage;
    private final Codec codec;

    public TerminalCatalogStore(File directory) {
        this(new FileStorage(new File(directory, "terminal-catalog-v1.json")), new AndroidCodec());
    }

    public TerminalCatalogStore(Storage storage, Codec codec) {
        this.storage = storage;
        this.codec = codec;
    }

    private static final class AndroidCodec implements Codec {
        @Override public Object parse(String json) {
            return TerminalJson.parse(json);
        }

        @Override public String write(Object value) {
            return TerminalJson.write(value);
        }
    }

    private static final class FileStorage implements Storage {
        private final File file;

        FileStorage(File file) {
            this.file = file;
        }

        @Override public String read() throws IOException {
            if (!file.exists()) return null;
            if (file.length() > MAX_BYTES) throw new IOException("terminal catalog too large");
            try (FileInputStream input = new FileInputStream(file)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) > 0) {
                    out.write(buffer, 0, read);
                    if (out.size() > MAX_BYTES) throw new IOException("terminal catalog too large");
                }
                return out.toString(StandardCharsets.UTF_8);
            }
        }

        @Override public void write(String value) throws IOException {
            File parent = file.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) throw new IOException("terminal catalog directory");
            File temporary = new File(file.getPath() + ".tmp");
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(value.getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
            try {
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (java.nio.file.AtomicMoveNotSupportedException error) {
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }

    private Map<String, Object> all() throws TerminalFailure {
        String json;
        try {
            json = storage.read();
        } catch (IOException error) {
            throw TerminalFailure.of("response");
        }
        if (json == null) return new LinkedHashMap<>();
        Object parsed;
        try {
            parsed = codec.parse(json);
        } catch (Exception error) {
            throw TerminalFailure.of("response");
        }
        Map<String, Object> values = new LinkedHashMap<>();
        if (!(parsed instanceof Map)) throw TerminalFailure.of("response");
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) parsed).entrySet()) {
            if (!(entry.getKey() instanceof String) || !(entry.getValue() instanceof Map)) throw TerminalFailure.of("response");
            values.put((String) entry.getKey(), entry.getValue());
        }
        if (values.size() > MAX_HOSTS) throw TerminalFailure.of("response");
        return values;
    }

    public Map<String, Object> read(String hostID) throws TerminalFailure {
        Map<String, Object> values = all();
        Object stored = values.get(hostID);
        Map<String, Object> value;
        if (stored instanceof Map) {
            value = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) stored).entrySet()) value.put(String.valueOf(entry.getKey()), entry.getValue());
        } else {
            value = new LinkedHashMap<>();
            value.put("schema", 1L);
            value.put("hostID", hostID);
            value.put("directories", new ArrayList<>());
        }
        validate(value, hostID);
        return value;
    }

    public void validate(Map<String, Object> value, String hostID) throws TerminalFailure {
        if (!value.keySet().equals(Set.of("schema", "hostID", "directories"))) throw TerminalFailure.of("invalid");
        if (!Long.valueOf(1L).equals(TerminalProtocol.integer(value.get("schema")))) throw TerminalFailure.of("invalid");
        if (!hostID.equals(value.get("hostID"))) throw TerminalFailure.of("invalid");
        if (!(value.get("directories") instanceof List)) throw TerminalFailure.of("invalid");
        List<?> directories = (List<?>) value.get("directories");
        if (directories.size() > MAX_DIRECTORIES) throw TerminalFailure.of("invalid");
        Set<String> ids = new LinkedHashSet<>();
        Set<String> paths = new LinkedHashSet<>();
        for (Object raw : directories) {
            if (!(raw instanceof Map)) throw TerminalFailure.of("invalid");
            Map<?, ?> entry = (Map<?, ?>) raw;
            if (!keys(entry).equals(Set.of("directory", "activeId", "tabs"))) throw TerminalFailure.of("invalid");
            if (!(entry.get("directory") instanceof String) || !TerminalProtocol.directory((String) entry.get("directory"))) {
                throw TerminalFailure.of("invalid");
            }
            String path = (String) entry.get("directory");
            if (!paths.add(path)) throw TerminalFailure.of("invalid");
            if (!(entry.get("activeId") instanceof String)) throw TerminalFailure.of("invalid");
            String active = (String) entry.get("activeId");
            if (!(entry.get("tabs") instanceof List)) throw TerminalFailure.of("invalid");
            List<?> tabs = (List<?>) entry.get("tabs");
            if (tabs.isEmpty() || tabs.size() > MAX_TABS) throw TerminalFailure.of("invalid");
            boolean containsActive = false;
            for (Object rawTab : tabs) {
                if (!(rawTab instanceof Map)) throw TerminalFailure.of("invalid");
                Map<?, ?> tab = (Map<?, ?>) rawTab;
                Set<String> keys = keys(tab);
                if (!Set.of("id", "sessionId", "label", "iconKey", "lifecycle", "createUnknown").containsAll(keys)) {
                    throw TerminalFailure.of("invalid");
                }
                if (!(tab.get("id") instanceof String) || !TerminalProtocol.identifier((String) tab.get("id"))) {
                    throw TerminalFailure.of("invalid");
                }
                String id = (String) tab.get("id");
                if (!ids.add(id)) throw TerminalFailure.of("invalid");
                Object lifecycle = tab.get("lifecycle");
                if (!(lifecycle instanceof String) || !Set.of("idle", "running", "exited").contains(lifecycle)) {
                    throw TerminalFailure.of("invalid");
                }
                Object sessionID = tab.get("sessionId");
                if (sessionID != null && (!(sessionID instanceof String) || !TerminalProtocol.identifier((String) sessionID))) {
                    throw TerminalFailure.of("invalid");
                }
                Object label = tab.get("label");
                if (label != null && (!(label instanceof String) || utf8((String) label) > 1024)) throw TerminalFailure.of("invalid");
                Object iconKey = tab.get("iconKey");
                if (iconKey != null && (!(iconKey instanceof String) || utf8((String) iconKey) > 128)) throw TerminalFailure.of("invalid");
                Object createUnknown = tab.get("createUnknown");
                if (createUnknown != null && !(createUnknown instanceof Boolean)) throw TerminalFailure.of("invalid");
                containsActive = containsActive || id.equals(active);
            }
            if (!containsActive) throw TerminalFailure.of("invalid");
        }
    }

    public void write(Object input, String hostID) throws TerminalFailure {
        if (!(input instanceof Map)) throw TerminalFailure.of("invalid");
        Map<String, Object> value = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) input).entrySet()) value.put(String.valueOf(entry.getKey()), entry.getValue());
        validate(value, hostID);
        Map<String, Object> values = all();
        values.put(hostID, value);
        String json;
        try {
            json = codec.write(values);
        } catch (Exception error) {
            throw TerminalFailure.of("response");
        }
        if (values.size() > MAX_HOSTS || utf8(json) > MAX_BYTES) throw TerminalFailure.of("overflow");
        try {
            storage.write(json);
        } catch (IOException error) {
            throw TerminalFailure.of("response");
        }
    }

    public boolean contains(String hostID, String owner, String directory, String sessionID) throws TerminalFailure {
        Map<String, Object> value = read(hostID);
        for (Object raw : (List<?>) value.get("directories")) {
            Map<?, ?> entry = (Map<?, ?>) raw;
            if (!directory.equals(entry.get("directory"))) continue;
            for (Object rawTab : (List<?>) entry.get("tabs")) {
                Map<?, ?> tab = (Map<?, ?>) rawTab;
                if (owner.equals(tab.get("id")) && sessionID.equals(tab.get("sessionId"))) return true;
            }
        }
        return false;
    }

    public void remember(String hostID, String owner, String directory, String sessionID) throws TerminalFailure {
        Map<String, Object> value = read(hostID);
        List<Object> directories = new ArrayList<>((List<?>) value.get("directories"));
        int index = -1;
        for (int i = 0; i < directories.size(); i++) {
            if (directory.equals(((Map<?, ?>) directories.get(i)).get("directory"))) {
                index = i;
                break;
            }
        }
        Map<String, Object> entry;
        if (index >= 0) {
            entry = mutable((Map<?, ?>) directories.get(index));
        } else {
            entry = new LinkedHashMap<>();
            entry.put("directory", directory);
            entry.put("activeId", owner);
            entry.put("tabs", new ArrayList<>());
        }
        List<Object> tabs = new ArrayList<>((List<?>) entry.get("tabs"));
        int tabIndex = -1;
        for (int i = 0; i < tabs.size(); i++) {
            if (owner.equals(((Map<?, ?>) tabs.get(i)).get("id"))) {
                tabIndex = i;
                break;
            }
        }
        if (tabIndex >= 0) {
            Map<String, Object> tab = mutable((Map<?, ?>) tabs.get(tabIndex));
            tab.put("sessionId", sessionID);
            tab.put("lifecycle", "running");
            tab.remove("createUnknown");
            tabs.set(tabIndex, tab);
        } else {
            Map<String, Object> tab = new LinkedHashMap<>();
            tab.put("id", owner);
            tab.put("sessionId", sessionID);
            tab.put("lifecycle", "running");
            tabs.add(tab);
        }
        entry.put("tabs", tabs);
        if (index >= 0) directories.set(index, entry);
        else directories.add(entry);
        value.put("directories", directories);
        write(value, hostID);
    }

    public void forget(String hostID, String owner) throws TerminalFailure {
        Map<String, Object> value = read(hostID);
        List<Object> directories = new ArrayList<>((List<?>) value.get("directories"));
        for (int index = 0; index < directories.size(); index++) {
            Map<String, Object> entry = mutable((Map<?, ?>) directories.get(index));
            List<Object> tabs = new ArrayList<>((List<?>) entry.get("tabs"));
            for (int tabIndex = 0; tabIndex < tabs.size(); tabIndex++) {
                Map<String, Object> tab = mutable((Map<?, ?>) tabs.get(tabIndex));
                if (!owner.equals(tab.get("id"))) continue;
                tab.remove("sessionId");
                tab.remove("createUnknown");
                tab.put("lifecycle", "exited");
                tabs.set(tabIndex, tab);
            }
            entry.put("tabs", tabs);
            directories.set(index, entry);
        }
        value.put("directories", directories);
        write(value, hostID);
    }

    private static Map<String, Object> mutable(Map<?, ?> value) {
        Map<String, Object> copy = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : value.entrySet()) copy.put(String.valueOf(entry.getKey()), entry.getValue());
        return copy;
    }

    private static Set<String> keys(Map<?, ?> value) {
        Set<String> keys = new LinkedHashSet<>();
        for (Object key : value.keySet()) keys.add(String.valueOf(key));
        return keys;
    }

    static int utf8(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }
}
