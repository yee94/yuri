package com.yee94.yuri.nsh;

import android.app.Activity;
import android.view.View;

import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

import java.util.Map;

/**
 * Whole-card press scale (iOS ComposerPress.swift).
 *
 * Android's NSH renderer owns the glass composer card and its transform; the
 * host cannot scale one rendered card from a sibling component, and the
 * editor's scroll must stay untransformed. The component validates its config
 * and reports `unsupported` once; it never moves the card or the editor.
 */
public final class ComposerPressBridge implements NativeHandlers.Bridge {
    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;

    public ComposerPressBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    @Override
    public void install() {
        view.registerComponent("yuri.composer.press", context -> new Owner(activity, context));
    }

    @Override
    public void invalidate() {}

    private static final class Owner implements NshComponent {
        private final NativeHandlers.RegistrationView registration;
        private final NshComponentContext context;
        private NativeComposerSpellcheckLease.Config config;
        private boolean reported;

        Owner(Activity activity, NshComponentContext context) {
            this.context = context;
            this.registration = new NativeHandlers.RegistrationView(activity);
        }

        @Override
        public View view() {
            return registration;
        }

        @Override
        public void setProp(String name, Object value) {
            if (!"config".equals(name)) return;
            config = NativeComposerSpellcheckLease.Config.of(value);
            if (config != null && !reported) {
                reported = true;
                context.emit("unsupported", Map.of("reason", "android_composer_card_transform_unavailable"));
            }
        }

        @Override
        public void command(String name, Object args) {
            if ("retire".equals(name)) config = null;
        }
    }
}
