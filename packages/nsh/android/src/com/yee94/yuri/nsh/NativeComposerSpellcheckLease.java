package com.yee94.yuri.nsh;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.function.ToIntFunction;

/**
 * Platform-neutral half of the composer spellcheck lease (iOS
 * NativeComposerSpellcheckLease.swift). A lease belongs to one editor object,
 * can only restore the trait it captured, and can never enable again after
 * retirement.
 */
public final class NativeComposerSpellcheckLease<Editor> {
    /** Data-only config: {ownerID, inputID}. */
    public static final class Config {
        public final String ownerID;
        public final String inputID;

        private Config(String ownerID, String inputID) {
            this.ownerID = ownerID;
            this.inputID = inputID;
        }

        public static Config of(Object value) {
            if (!(value instanceof Map)) return null;
            Map<?, ?> data = (Map<?, ?>) value;
            if (data.size() != 2) return null;
            Object owner = data.get("ownerID");
            Object input = data.get("inputID");
            if (!(owner instanceof String) || ((String) owner).isEmpty()) return null;
            if (!(input instanceof String) || ((String) input).isEmpty()) return null;
            return new Config((String) owner, (String) input);
        }
    }

    /** The exact two-container/one-editor walk shared with the AX binding. */
    public static final class Tree<Node> {
        public final Function<Node, Node> parent;
        public final Function<Node, List<Node>> children;
        public final Function<Node, Node> window;
        public final Function<Node, String> identifier;
        public final Function<Node, String> editorKind;

        public Tree(Function<Node, Node> parent, Function<Node, List<Node>> children, Function<Node, Node> window,
                    Function<Node, String> identifier, Function<Node, String> editorKind) {
            this.parent = parent;
            this.children = children;
            this.window = window;
            this.identifier = identifier;
            this.editorKind = editorKind;
        }

        public Node resolve(Node registration, Config config) {
            Node window = this.window.apply(registration);
            Node host = parent.apply(registration);
            if (window == null || host == null) return null;
            Node owner = parent.apply(host);
            if (owner == null) return null;
            if (!config.ownerID.equals(identifier.apply(owner))) return null;
            if (this.window.apply(host) != window || this.window.apply(owner) != window) return null;
            Node container = null;
            int containers = 0;
            for (Node child : children.apply(owner)) {
                if (child != host && config.inputID.equals(identifier.apply(child))) {
                    container = child;
                    containers++;
                }
            }
            if (containers != 1 || container == null) return null;
            if (parent.apply(container) != owner || this.window.apply(container) != window) return null;
            Node editor = null;
            int editors = 0;
            for (Node child : children.apply(container)) {
                if (editorKind.apply(child) != null) {
                    editor = child;
                    editors++;
                }
            }
            if (editors != 1 || editor == null) return null;
            if (!"multiline".equals(editorKind.apply(editor))) return null;
            if (parent.apply(editor) != container || this.window.apply(editor) != window) return null;
            if (parent.apply(registration) != host || parent.apply(host) != owner) return null;
            return editor;
        }
    }

    public static final class Access<Editor> {
        public final ToIntFunction<Editor> read;
        public final Predicate<Editor> marked;
        public final BiConsumer<Editor, Integer> write;
        public final int yes;

        public Access(ToIntFunction<Editor> read, Predicate<Editor> marked, BiConsumer<Editor, Integer> write, int yes) {
            this.read = read;
            this.marked = marked;
            this.write = write;
            this.yes = yes;
        }
    }

    private final WeakReference<Editor> editor;
    private final Access<Editor> access;
    private Integer original;
    private boolean retired;
    private boolean settled;
    private boolean pendingRestore;

    public NativeComposerSpellcheckLease(Editor editor, Access<Editor> access) {
        this.editor = new WeakReference<>(editor);
        this.access = access;
    }

    public Editor editor() {
        return editor.get();
    }

    public boolean pendingRestore() {
        return pendingRestore;
    }

    public boolean pendingEnable() {
        return !retired && !settled && editor.get() != null;
    }

    public void enable(BooleanSupplier valid) {
        Editor target = editor.get();
        if (!pendingEnable() || target == null || !valid.getAsBoolean()) return;
        if (access.marked.test(target) || !valid.getAsBoolean() || access.marked.test(target)) return;
        int current = access.read.applyAsInt(target);
        settled = true;
        if (current == access.yes) return;
        original = current;
        access.write.accept(target, access.yes);
    }

    public void retire() {
        if (retired) return;
        retired = true;
        pendingRestore = original != null;
        restore();
    }

    public void restore() {
        if (!retired || !pendingRestore) return;
        Editor target = editor.get();
        Integer captured = original;
        if (target == null || captured == null || access.read.applyAsInt(target) != access.yes) {
            pendingRestore = false;
            original = null;
            return;
        }
        if (access.marked.test(target)) return;
        pendingRestore = false;
        original = null;
        access.write.accept(target, captured);
    }

    /**
     * Only a resolved replacement or an explicit removal retires the lease; no
     * active/Host/window input participates.
     */
    public static final class Coordinator<Editor> {
        public interface Retired<Editor> {
            void accept(NativeComposerSpellcheckLease<Editor> lease);
        }

        private final java.util.function.Supplier<Editor> resolve;
        private final Access<Editor> access;
        private final Predicate<Editor> canEnable;
        private final Retired<Editor> retired;
        private NativeComposerSpellcheckLease<Editor> lease;
        private int generation;
        private boolean disposed;

        public Coordinator(java.util.function.Supplier<Editor> resolve, Access<Editor> access,
                           Predicate<Editor> canEnable, Retired<Editor> retired) {
            this.resolve = resolve;
            this.access = access;
            this.canEnable = canEnable;
            this.retired = retired;
        }

        public NativeComposerSpellcheckLease<Editor> lease() {
            return lease;
        }

        public int generation() {
            return generation;
        }

        private void retireCurrent() {
            NativeComposerSpellcheckLease<Editor> current = lease;
            if (current == null) return;
            lease = null;
            current.retire();
            retired.accept(current);
        }

        public void configure() {
            generation++;
            reconcile();
        }

        public void reset() {
            generation++;
            retireCurrent();
        }

        public void remove() {
            if (disposed) return;
            disposed = true;
            generation++;
            retireCurrent();
        }

        public void reconcile() {
            if (disposed) return;
            Editor editor = resolve.get();
            if (editor == null) return;
            if (lease == null || lease.editor() != editor) {
                generation++;
                retireCurrent();
                lease = new NativeComposerSpellcheckLease<>(editor, access);
            }
            attempt(editor, generation);
        }

        /** An exact-editor notification can only finish its captured generation. */
        public void event(Editor editor, int generation) {
            attempt(editor, generation);
        }

        private void attempt(Editor editor, int captured) {
            NativeComposerSpellcheckLease<Editor> current = lease;
            if (disposed || captured != generation || current == null || current.editor() != editor) return;
            current.enable(() -> !disposed && captured == generation && lease == current && resolve.get() == editor && canEnable.test(editor));
        }
    }

    /** Sorted copy helper for callers that publish the unsupported set. */
    public static List<String> sorted(Iterable<String> values) {
        List<String> result = new ArrayList<>();
        for (String value : values) result.add(value);
        result.sort(String::compareTo);
        return result;
    }
}
