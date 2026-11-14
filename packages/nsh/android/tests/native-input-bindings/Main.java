import com.yee94.yuri.nsh.NativeComposerSpellcheckLease;
import com.yee94.yuri.nsh.NativeInputMetadataBinding;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JVM-only checks for the platform-neutral composer spellcheck lease and the
 * paired-local AX metadata binding. No Android classes, no UIKit.
 */
public final class Main {
    private static int checks = 0;

    public static void main(String[] args) {
        spellcheckLease();
        spellcheckCoordinator();
        metadataBinding();
        System.out.println(checks + " native input binding checks passed");
    }

    private static void spellcheckLease() {
        Editor editor = new Editor();
        NativeComposerSpellcheckLease<Editor> lease = new NativeComposerSpellcheckLease<>(editor, access());
        lease.enable(() -> true);
        check(editor.trait == 1, "trait enabled");
        lease.retire();
        check(editor.trait == 0, "trait restored");
        check(!lease.pendingRestore(), "nothing left to restore");

        Editor marked = new Editor();
        marked.marked = true;
        NativeComposerSpellcheckLease<Editor> blocked = new NativeComposerSpellcheckLease<>(marked, access());
        blocked.enable(() -> true);
        check(marked.trait == 0, "composition blocks enable");
        blocked.retire();
        check(!blocked.pendingRestore(), "nothing was written");

        Editor pending = new Editor();
        NativeComposerSpellcheckLease<Editor> delayed = new NativeComposerSpellcheckLease<>(pending, access());
        delayed.enable(() -> true);
        pending.marked = true;
        delayed.retire();
        check(pending.trait == 1 && delayed.pendingRestore(), "IME pending keeps restoration");
        pending.marked = false;
        delayed.restore();
        check(pending.trait == 0, "restoration finishes after composition");

        Editor fenced = new Editor();
        NativeComposerSpellcheckLease<Editor> stale = new NativeComposerSpellcheckLease<>(fenced, access());
        boolean[] valid = { false };
        stale.enable(() -> valid[0]);
        check(fenced.trait == 0 && stale.pendingEnable(), "invalid fence blocks enable");
    }

    private static void spellcheckCoordinator() {
        List<Editor> resolved = new ArrayList<>();
        Editor first = new Editor();
        Editor second = new Editor();
        resolved.add(first);
        List<NativeComposerSpellcheckLease<Editor>> retired = new ArrayList<>();
        NativeComposerSpellcheckLease.Coordinator<Editor> coordinator = new NativeComposerSpellcheckLease.Coordinator<>(
            () -> resolved.get(0), access(), editor -> true, retired::add);
        coordinator.configure();
        check(first.trait == 1 && coordinator.generation() >= 1, "configure enables");
        int captured = coordinator.generation();
        resolved.set(0, second);
        coordinator.reconcile();
        check(first.trait == 0, "replacement restores the old editor");
        check(retired.size() == 1 && second.trait == 1, "replacement adopts the new editor");
        int after = coordinator.generation();
        coordinator.event(first, captured);
        check(first.trait == 0 && after == coordinator.generation(), "stale event cannot adopt");
        coordinator.remove();
        check(second.trait == 0, "remove restores");
    }

    private static void metadataBinding() {
        Tree tree = new Tree();
        NodeAccess access = new NodeAccess();
        NativeInputMetadataBinding<Node> binding = new NativeInputMetadataBinding<>(tree.registration, access);
        binding.update(config("ax_1", "Composer", true, "input_1"));
        check("ax_1".equals(tree.editor.id), "identifier written");
        check("Composer".equals(tree.editor.label), "label written");
        check("owner_1".equals(tree.owner.id), "owner identity untouched");

        tree.editor.label = "Application label";
        binding.changed();
        check("Application label".equals(tree.editor.label), "application write is not reclaimed");
        binding.retire();
        check("Application label".equals(tree.editor.label), "yielded label is not restored");
        check(tree.editor.id == null, "identifier restored to its original");

        Node fresh = new Node("editor2", tree.window);
        fresh.kind = "multiline";
        tree.container.children.clear();
        fresh.parent = tree.container;
        tree.container.children.add(fresh);
        binding.update(config("ax_2", "Second", true, "input_1"));
        check("ax_2".equals(fresh.id) && "Second".equals(fresh.label), "replacement editor bound");
        binding.retire();
        check(fresh.id == null && fresh.label == null, "replacement editor restored");

        Node single = new Node("single", tree.window);
        single.kind = "singleline";
        Node container2 = new Node("container2", tree.window);
        container2.id = "input_2";
        container2.parent = tree.owner;
        single.parent = container2;
        container2.children.add(single);
        tree.owner.children.add(container2);
        binding.update(config("ax_3", "Line", true, "input_2"));
        check(single.id == null, "singleline editor refused");

        binding.update(config("ax_4", "Composer", false, "input_1"));
        check(fresh.id == null && fresh.label == null, "inactive snapshot releases the binding");
    }

    private static NativeComposerSpellcheckLease.Access<Editor> access() {
        return new NativeComposerSpellcheckLease.Access<>(editor -> editor.trait,
            editor -> editor.marked, (editor, value) -> editor.trait = value, 1);
    }

    private static Map<String, Object> config(String ax, String label, boolean active, String input) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("ownerID", "owner_1");
        value.put("inputID", input);
        value.put("expectedKind", "multiline");
        value.put("editorAXID", ax);
        value.put("label", label);
        value.put("active", active);
        return value;
    }

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        checks++;
    }

    private static final class Tree {
        final Node window = new Node("window", null);
        final Node owner = new Node("owner", window);
        final Node host = new Node("host", window);
        final Node container = new Node("container", window);
        final Node editor = new Node("editor", window);
        final Node registration = new Node("registration", window);

        Tree() {
            owner.id = "owner_1";
            container.id = "input_1";
            editor.kind = "multiline";
            attach(owner, host);
            attach(owner, container);
            attach(container, editor);
            attach(host, registration);
        }
    }

    private static void attach(Node parent, Node child) {
        child.parent = parent;
        parent.children.add(child);
    }

    private static final class Editor {
        int trait = 0;
        boolean marked = false;
    }

    private static final class Node {
        final String name;
        final Node windowRoot;
        Node parent;
        final List<Node> children = new ArrayList<>();
        String id;
        String label;
        String kind;

        Node(String name, Node windowRoot) {
            this.name = name;
            this.windowRoot = windowRoot;
        }
    }

    private static final class NodeAccess extends NativeInputMetadataBinding.Access<Node> {
        NodeAccess() {
            super(node -> node.parent, node -> node.children, node -> node.windowRoot,
                node -> node.kind, node -> node.id, node -> node.label,
                (node, value) -> node.id = value, (node, value) -> node.label = value);
        }
    }
}
