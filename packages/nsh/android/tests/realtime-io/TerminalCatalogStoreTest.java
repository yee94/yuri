package com.yee94.yuri.nsh;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Journal validation/merge parity with TerminalCatalogStore in ios/TerminalBridge.swift. */
public final class TerminalCatalogStoreTest {
    private static final String HOST = "host-a";

    public static void main(String[] args) throws Exception {
        defaults();
        validation();
        rememberForget();
        capacity();
        System.out.println("TerminalCatalogStoreTest OK");
    }

    private static void defaults() throws Exception {
        TerminalCatalogStore store = store();
        Map<String, Object> value = store.read(HOST);
        Check.equal(1L, value.get("schema"), "default schema");
        Check.equal(HOST, value.get("hostID"), "default host");
        Check.isTrue(value.get("directories") instanceof List, "default directories");
        Check.isTrue(((List<?>) value.get("directories")).isEmpty(), "default empty");
    }

    private static void validation() throws Exception {
        TerminalCatalogStore store = store();
        Check.failure("invalid", () -> store.write(Map.of("schema", 1L, "hostID", HOST), HOST), "missing directories");
        Check.failure("invalid", () -> store.write(Map.of("schema", 2L, "hostID", HOST, "directories", List.of()), HOST),
                "schema version");
        Check.failure("invalid", () -> store.write(Map.of("schema", 1L, "hostID", "other", "directories", List.of()), HOST),
                "host mismatch");
        Check.failure("invalid", () -> store.write(Map.of("schema", 1L, "hostID", HOST, "directories", List.of(
                entry("/tmp", "owner-1", List.of(tab("owner-1", "session-1", "running"))), entry("/tmp", "owner-2",
                        List.of(tab("owner-2", "session-2", "running"))))), HOST), "duplicate directory");
        Check.failure("invalid", () -> store.write(Map.of("schema", 1L, "hostID", HOST, "directories", List.of(
                entry("relative", "owner-1", List.of(tab("owner-1", "session-1", "running"))))), HOST), "invalid directory");
        Check.failure("invalid", () -> store.write(Map.of("schema", 1L, "hostID", HOST, "directories", List.of(
                entry("/tmp", "owner-1", List.of(tab("owner-1", "session-1", "bogus"))))), HOST), "invalid lifecycle");
        Check.failure("invalid", () -> store.write(Map.of("schema", 1L, "hostID", HOST, "directories", List.of(
                entry("/tmp", "owner-1", List.of(tab("owner-1", "session-1", "running"),
                        tab("owner-1", "session-2", "running"))))), HOST), "duplicate tab id");
        Check.failure("invalid", () -> store.write(Map.of("schema", 1L, "hostID", HOST, "directories", List.of(
                entry("/tmp", "owner-9", List.of(tab("owner-1", "session-1", "running"))))), HOST), "active id missing");
        Check.failure("invalid", () -> store.write(Map.of("schema", 1L, "hostID", HOST, "directories", List.of(
                entry("/tmp", "owner-1", List.of(createUnknown("owner-1", "maybe"))))), HOST), "createUnknown type");
        Map<String, Object> unknownKey = tab("owner-1", "session-1", "running");
        unknownKey.put("extra", true);
        Check.failure("invalid", () -> store.write(Map.of("schema", 1L, "hostID", HOST, "directories", List.of(
                entry("/tmp", "owner-1", List.of(unknownKey)))), HOST), "unknown tab key");

        Map<String, Object> launched = new LinkedHashMap<>();
        launched.put("schema", 1L);
        launched.put("hostID", HOST);
        launched.put("directories", List.of(entry("/tmp", "owner-1", List.of(tab("owner-1", "session-1", "running")))));
        store.write(launched, HOST);
        Check.equal(launched.get("directories"), store.read(HOST).get("directories"), "round trip");
    }

    private static void rememberForget() throws Exception {
        TerminalCatalogStore store = store();
        store.remember(HOST, "owner-1", "/tmp/project", "session-1");
        Check.isTrue(store.contains(HOST, "owner-1", "/tmp/project", "session-1"), "remembered");
        Check.isFalse(store.contains(HOST, "owner-1", "/tmp/project", "session-2"), "exact session required");
        Map<String, Object> value = store.read(HOST);
        Map<?, ?> entry = (Map<?, ?>) ((List<?>) value.get("directories")).get(0);
        Check.equal("owner-1", entry.get("activeId"), "active owner");
        store.forget(HOST, "owner-1");
        Check.isFalse(store.contains(HOST, "owner-1", "/tmp/project", "session-1"), "forgotten session");
        Map<?, ?> tab = (Map<?, ?>) ((List<?>) ((Map<?, ?>) ((List<?>) store.read(HOST).get("directories")).get(0))
                .get("tabs")).get(0);
        Check.equal("exited", tab.get("lifecycle"), "forget marks exited");
        Check.nullValue(tab.get("sessionId"), "forget clears session");
    }

    private static void capacity() throws Exception {
        TerminalCatalogStore store = store();
        Map<String, Object> crowded = new LinkedHashMap<>();
        crowded.put("schema", 1L);
        crowded.put("hostID", HOST);
        List<Object> directories = new ArrayList<>();
        for (int i = 0; i < 129; i++) {
            directories.add(entry("/tmp/" + i, "owner-" + i, List.of(tab("owner-" + i, "session-" + i, "running"))));
        }
        crowded.put("directories", directories);
        Check.failure("invalid", () -> store.write(crowded, HOST), "directory bound");
    }

    private static TerminalCatalogStore store() {
        final String[] document = new String[1];
        return new TerminalCatalogStore(
                new TerminalCatalogStore.Storage() {
                    @Override public String read() {
                        return document[0];
                    }

                    @Override public void write(String value) {
                        document[0] = value;
                    }
                },
                new TerminalCatalogStore.Codec() {
                    @Override public Object parse(String json) {
                        return last;
                    }

                    @Override public String write(Object value) {
                        last = value;
                        return "stored";
                    }

                    private Object last;
                });
    }

    private static Map<String, Object> entry(String directory, String activeID, List<Object> tabs) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("directory", directory);
        entry.put("activeId", activeID);
        entry.put("tabs", tabs);
        return entry;
    }

    private static Map<String, Object> tab(String id, String sessionID, String lifecycle) {
        Map<String, Object> tab = new LinkedHashMap<>();
        tab.put("id", id);
        tab.put("sessionId", sessionID);
        tab.put("lifecycle", lifecycle);
        return tab;
    }

    private static Map<String, Object> createUnknown(String id, String marker) {
        Map<String, Object> tab = new LinkedHashMap<>();
        tab.put("id", id);
        tab.put("lifecycle", "idle");
        tab.put("createUnknown", marker);
        return tab;
    }
}
