package com.yee94.yuri.nsh;

import android.app.Activity;
import android.text.InputType;
import android.view.View;
import android.widget.EditText;

import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Composer spellcheck lease (iOS NativeComposerSpellcheck*.swift).
 *
 * Android has no per-editor spellcheck trait: it is a system setting applied by
 * the input method, not a TextView property, so there is nothing a host bridge
 * may capture, enable or restore. The lease/coordinator lifecycle is ported and
 * kept exact, its platform access never writes, and the component reports
 * `unsupported` once instead of claiming the trait changed.
 */
public final class NativeComposerSpellcheckBridge implements NativeHandlers.Bridge {
    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;

    public NativeComposerSpellcheckBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    @Override
    public void install() {
        view.registerComponent("yuri.composer.spellcheck", context -> new Owner(activity, context));
    }

    @Override
    public void invalidate() {}

    private static final class Owner implements NshComponent {
        private final NativeHandlers.RegistrationView registration;
        private final NshComponentContext context;
        private final NativeComposerSpellcheckLease.Coordinator<EditText> coordinator;
        private NativeComposerSpellcheckLease.Config config;
        private boolean removed;
        private boolean reported;

        Owner(Activity activity, NshComponentContext context) {
            this.context = context;
            this.registration = new NativeHandlers.RegistrationView(activity);
            this.registration.changed = this::changed;
            NativeComposerSpellcheckLease.Access<EditText> access = new NativeComposerSpellcheckLease.Access<>(
                editor -> 0,
                editor -> false,
                (editor, value) -> {
                    // No Android per-editor spellcheck write exists.
                },
                1);
            this.coordinator = new NativeComposerSpellcheckLease.Coordinator<>(this::resolve, access,
                editor -> true, lease -> {
                });
        }

        @Override
        public View view() {
            return registration;
        }

        @Override
        public void setProp(String name, Object value) {
            if (!"config".equals(name) || removed) return;
            config = NativeComposerSpellcheckLease.Config.of(value);
            if (config == null) coordinator.reset();
            else coordinator.configure();
            changed();
        }

        @Override
        public void command(String name, Object args) {
            if (!"retire".equals(name) || removed) return;
            removed = true;
            coordinator.remove();
        }

        private void changed() {
            if (removed) return;
            coordinator.reconcile();
            if (config != null && !reported) {
                reported = true;
                context.emit("unsupported", Map.of("reason", "android_spellcheck_not_per_editor"));
            }
        }

        /** Structural resolution; Android exposes no accessibility identifier for the container. */
        private EditText resolve() {
            if (removed || config == null) return null;
            View host = NativeHandlers.hostOf(registration);
            View owner = NativeHandlers.ownerOf(registration);
            if (host == null || owner == null || registration.getWindowToken() == null) return null;
            List<View> editors = new ArrayList<>();
            NativeHandlers.collect(owner, host, EditText.class, editors);
            if (editors.size() != 1) return null;
            EditText editor = (EditText) editors.get(0);
            View container = editor.getParent() instanceof View ? (View) editor.getParent() : null;
            if (container == null || container.getParent() != owner) return null;
            if (editor.getWindowToken() != registration.getWindowToken()) return null;
            boolean multiline = (editor.getInputType() & InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0;
            return multiline ? editor : null;
        }
    }
}
