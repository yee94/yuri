package com.yee94.yuri.nsh;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * One selected appearance's font projection, independent of palette ownership
 * (iOS NativeFontOwner.swift). Android cannot apply App fonts, so every
 * non-system request resolves to an explicit `unsupported` projection rather
 * than a silent fallback; the ticket still advances so retry is observable.
 */
public final class NativeFontOwner {
    public static final class Projection {
        public String ui = "system-ui";
        public String mono = "monospace";
        public String assistantLight = "system-ui";
        public String assistantDark = "system-ui";
        public List<String> unsupported = new ArrayList<>();
        public String status = "ready";
        public int ticket = 0;

        public Map<String, Object> value() {
            Map<String, Object> fontFamilies = new LinkedHashMap<>();
            fontFamilies.put("light", assistantLight);
            fontFamilies.put("dark", assistantDark);
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("uiFontFamily", ui);
            value.put("monoFontFamily", mono);
            value.put("assistantFontFamilies", fontFamilies);
            value.put("unsupportedFonts", unsupported);
            value.put("fontStatus", status);
            value.put("fontTicket", ticket);
            return value;
        }
    }

    public interface Changed {
        void accept(String hostID, int revision, Projection projection);
    }

    private final NativeFontRegistry registry;
    private final Changed changed;
    private int operation;
    private String hostID;
    private int revision;
    private Map<String, String> selected = new LinkedHashMap<>();
    private final Set<String> pending = new LinkedHashSet<>();
    private final Set<String> failed = new LinkedHashSet<>();
    private final Set<String> unsupported = new LinkedHashSet<>();
    public Projection projection = new Projection();

    public NativeFontOwner(NativeFontRegistry registry, Changed changed) {
        this.registry = registry;
        this.changed = changed;
    }

    public Projection projection() {
        return projection;
    }

    public void invalidate() {
        operation++;
        hostID = null;
        selected = new LinkedHashMap<>();
        pending.clear();
        failed.clear();
        unsupported.clear();
        projection = new Projection();
    }

    public Projection select(String hostID, int revision, Map<String, String> fonts, boolean retry) {
        if (!retry && hostID.equals(this.hostID) && revision == this.revision && selected.equals(fonts)) return projection;
        operation++;
        this.hostID = hostID;
        this.revision = revision;
        selected = new LinkedHashMap<>(fonts);
        int captured = operation;
        pending.clear();
        failed.clear();
        unsupported.clear();
        projection.ticket = captured;
        for (String[] role : new String[][] { { "ui", "ui", "system-ui" }, { "mono", "mono", "monospace" } }) {
            String family = fonts.containsKey(role[0]) ? fonts.get(role[0]) : role[2];
            if (role[2].equals(family)) {
                assign(role[0], role[2]);
                continue;
            }
            NativeFontCatalog.Definition definition = NativeFontCatalog.family(family);
            if (definition == null || !definition.kind.equals(role[1])) {
                unsupported.add(family);
                continue;
            }
            NativeFontRegistry.RegisteredFont cached = registry.cached(definition);
            if (cached != null) {
                assign(role[0], stack(cached.family, role[1]));
                continue;
            }
            // Android cannot register the App's immutably downloaded face.
            unsupported.add(family);
        }
        resolveAssistants();
        updateStatus();
        return projection;
    }

    private void assign(String role, String family) {
        if ("ui".equals(role)) projection.ui = family;
        else projection.mono = family;
    }

    private void resolveAssistants() {
        unsupported.retainAll(onlyMainRoles());
        projection.assistantLight = resolve("assistantLight");
        projection.assistantDark = resolve("assistantDark");
    }

    private Set<String> onlyMainRoles() {
        Set<String> values = new LinkedHashSet<>();
        for (String role : new String[] { "ui", "mono" }) {
            if (selected.containsKey(role)) values.add(selected.get(role));
        }
        return values;
    }

    private String resolve(String key) {
        String name = selected.containsKey(key) ? selected.get(key) : "system-ui";
        if ("system-ui".equals(name) || "monospace".equals(name)) return name;
        if (name.equals(selected.get("ui")) && !pending.contains("ui") && !failed.contains("ui")) return projection.ui;
        if (name.equals(selected.get("mono")) && !pending.contains("mono") && !failed.contains("mono")) return projection.mono;
        NativeFontCatalog.Definition definition = NativeFontCatalog.family(name);
        if (definition != null) {
            NativeFontRegistry.RegisteredFont value = registry.cached(definition);
            if (value != null) return stack(value.family, definition.kind);
        }
        if ("JetBrains Mono".equals(name)) {
            String bundled = registry.bundledMono();
            if (bundled != null) return bundled;
        }
        // A renderer family never creates a CDN URL or initiates a download.
        unsupported.add(name);
        return projection.ui;
    }

    private void updateStatus() {
        List<String> values = new ArrayList<>(unsupported);
        values.sort(String::compareTo);
        projection.unsupported = values;
        projection.status = !pending.isEmpty() ? "loading" : !failed.isEmpty() ? "failed" : !unsupported.isEmpty() ? "unsupported" : "ready";
    }

    private static String stack(String family, String kind) {
        return family + ("mono".equals(kind) ? ", monospace" : ", system-ui");
    }
}
