package com.yee94.yuri.nsh;

import java.lang.ref.WeakReference;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.Function;

/**
 * Platform-neutral paired-local AX identity binding (iOS
 * NativeInputMetadataBinding.swift): fixed multiline containers only, two
 * independent fields, per-field yielding, rollback touches only the captured
 * editor. It owns no traits, delegates, text or focus.
 */
public final class NativeInputMetadataBinding<Node> {
    /** One atomic registration snapshot: {ownerID, inputID, expectedKind, editorAXID, label, active}. */
    public static final class Config {
        public final String ownerID;
        public final String inputID;
        public final String expectedKind;
        public final String editorAXID;
        public final String label;
        public final boolean active;

        private Config(String ownerID, String inputID, String kind, String editorAXID, String label, boolean active) {
            this.ownerID = ownerID;
            this.inputID = inputID;
            this.expectedKind = kind;
            this.editorAXID = editorAXID;
            this.label = label;
            this.active = active;
        }

        public static Config of(Object value) {
            if (!(value instanceof Map)) return null;
            Map<?, ?> data = (Map<?, ?>) value;
            if (data.size() != 6) return null;
            Object ownerID = data.get("ownerID");
            Object inputID = data.get("inputID");
            Object kind = data.get("expectedKind");
            Object editorAXID = data.get("editorAXID");
            Object label = data.get("label");
            Object active = data.get("active");
            if (!(ownerID instanceof String) || ((String) ownerID).isEmpty()) return null;
            if (!(inputID instanceof String) || ((String) inputID).isEmpty()) return null;
            if (!"multiline".equals(kind)) return null;
            if (!(editorAXID instanceof String) || ((String) editorAXID).isEmpty() || editorAXID.equals(inputID)) return null;
            if (!(label instanceof String) || ((String) label).isEmpty()) return null;
            if (!(active instanceof Boolean)) return null;
            return new Config((String) ownerID, (String) inputID, "multiline",
                (String) editorAXID, (String) label, (Boolean) active);
        }
    }

    /** Public view relationships only. */
    public static class Access<Node> {
        public final Function<Node, Node> parent;
        public final Function<Node, List<Node>> children;
        public final Function<Node, Node> window;
        public final Function<Node, String> kind;
        public final Function<Node, String> identifier;
        public final Function<Node, String> label;
        public final BiConsumer<Node, String> writeIdentifier;
        public final BiConsumer<Node, String> writeLabel;

        public Access(Function<Node, Node> parent, Function<Node, List<Node>> children, Function<Node, Node> window,
                      Function<Node, String> kind, Function<Node, String> identifier, Function<Node, String> label,
                      BiConsumer<Node, String> writeIdentifier, BiConsumer<Node, String> writeLabel) {
            this.parent = parent;
            this.children = children;
            this.window = window;
            this.kind = kind;
            this.identifier = identifier;
            this.label = label;
            this.writeIdentifier = writeIdentifier;
            this.writeLabel = writeLabel;
        }
    }

    private static final class Field {
        String original;
        String lastWritten;
        boolean owns;
        boolean yielded;

        void observe(String current) {
            if (owns && !equal(lastWritten, current)) {
                owns = false;
                yielded = true;
            }
        }

        boolean prepare(String current, String desired) {
            observe(current);
            if (yielded) return false;
            if (!owns) original = current;
            owns = true;
            lastWritten = desired;
            return !equal(current, desired);
        }

        boolean shouldRestore(String current) {
            observe(current);
            return owns && equal(current, lastWritten);
        }

        String original() {
            String value = original;
            owns = false;
            original = null;
            lastWritten = null;
            return value;
        }
    }

    private final Access<Node> access;
    private final WeakReference<Node> registration;
    private WeakReference<Node> editor;
    private WeakReference<Node> boundHost;
    private WeakReference<Node> boundOwner;
    private WeakReference<Node> boundContainer;
    private WeakReference<Node> boundWindow;
    private final Field identifier = new Field();
    private final Field label = new Field();
    private Config config;
    private boolean enabled = true;
    private int generation;
    private Integer pending;

    public NativeInputMetadataBinding(Node registration, Access<Node> access) {
        this.registration = new WeakReference<>(registration);
        this.access = access;
    }

    public void update(Object value) {
        generation++;
        pending = null;
        config = Config.of(value);
        reconcile();
    }

    public void lifecycle(boolean active) {
        generation++;
        pending = null;
        enabled = active;
        reconcile();
    }

    public void changed() {
        generation++;
        pending = null;
        reconcile();
    }

    /** At most one queued mount-order retry; old callbacks cannot adopt a new lease. */
    public void enqueue(java.util.function.Consumer<Runnable> schedule) {
        if (pending != null || !enabled || config == null || !config.active) return;
        int ticket = generation;
        pending = ticket;
        schedule.accept(() -> {
            if (pending == null || pending != ticket || generation != ticket) return;
            pending = null;
            reconcile();
        });
    }

    private static final class Target<Node> {
        final Node host;
        final Node owner;
        final Node container;
        final Node editor;
        final Node window;

        Target(Node host, Node owner, Node container, Node editor, Node window) {
            this.host = host;
            this.owner = owner;
            this.container = container;
            this.editor = editor;
            this.window = window;
        }

        boolean matches(Target<Node> other) {
            return host == other.host && owner == other.owner && container == other.container
                && editor == other.editor && window == other.window;
        }
    }

    private Target<Node> resolve() {
        Node start = registration.get();
        Config captured = config;
        if (!enabled || captured == null || !captured.active || start == null) return null;
        Node window = access.window.apply(start);
        Node host = access.parent.apply(start);
        if (window == null || host == null) return null;
        Node owner = access.parent.apply(host);
        if (owner == null || !captured.ownerID.equals(access.identifier.apply(owner))) return null;
        if (access.window.apply(host) != window || access.window.apply(owner) != window) return null;
        Node container = null;
        int containers = 0;
        for (Node child : access.children.apply(owner)) {
            if (child != host && captured.inputID.equals(access.identifier.apply(child))) {
                container = child;
                containers++;
            }
        }
        if (containers != 1 || container == null) return null;
        if (access.parent.apply(container) != owner || access.window.apply(container) != window) return null;
        Node found = null;
        int editors = 0;
        for (Node child : access.children.apply(container)) {
            if (access.kind.apply(child) != null) {
                found = child;
                editors++;
            }
        }
        if (editors != 1 || found == null) return null;
        if (!captured.expectedKind.equals(access.kind.apply(found))) return null;
        if (access.parent.apply(found) != container || access.window.apply(found) != window) return null;
        if (access.parent.apply(start) != host || access.parent.apply(host) != owner) return null;
        return new Target<>(host, owner, container, found, window);
    }

    public void reconcile() {
        Target<Node> target = resolve();
        Config captured = config;
        if (target == null || captured == null) {
            retire();
            return;
        }
        Node current = editor == null ? null : editor.get();
        if (current != target.editor || boundHost.get() != target.host || boundOwner.get() != target.owner
            || boundContainer.get() != target.container || boundWindow.get() != target.window) {
            boolean replacement = current != target.editor;
            retire();
            editor = new WeakReference<>(target.editor);
            if (replacement) {
                reset(identifier);
                reset(label);
            }
            boundHost = new WeakReference<>(target.host);
            boundOwner = new WeakReference<>(target.owner);
            boundContainer = new WeakReference<>(target.container);
            boundWindow = new WeakReference<>(target.window);
        }
        Target<Node> fresh = resolve();
        if (fresh == null || !target.matches(fresh)) {
            retire();
            return;
        }
        if (identifier.prepare(access.identifier.apply(target.editor), captured.editorAXID)) {
            access.writeIdentifier.accept(target.editor, captured.editorAXID);
        }
        fresh = resolve();
        if (fresh == null || !target.matches(fresh)) {
            retire();
            return;
        }
        if (label.prepare(access.label.apply(target.editor), captured.label)) {
            access.writeLabel.accept(target.editor, captured.label);
        }
    }

    private static void reset(Field field) {
        field.original = null;
        field.lastWritten = null;
        field.owns = false;
        field.yielded = false;
    }

    /** Rollback touches only the captured editor, never a newly discovered replacement. */
    public void retire() {
        boundHost = null;
        boundOwner = null;
        boundContainer = null;
        boundWindow = null;
        Node target = editor == null ? null : editor.get();
        if (target == null) return;
        String currentIdentifier = access.identifier.apply(target);
        if (identifier.shouldRestore(currentIdentifier)) access.writeIdentifier.accept(target, identifier.original());
        else identifier.original();
        String currentLabel = access.label.apply(target);
        if (label.shouldRestore(currentLabel)) access.writeLabel.accept(target, label.original());
        else label.original();
        // Keep only a weak editor and per-field yielding across inactive/invalid
        // snapshots: a late application write is never reclaimed.
    }

    private static boolean equal(String left, String right) {
        return left == null ? right == null : left.equals(right);
    }
}
