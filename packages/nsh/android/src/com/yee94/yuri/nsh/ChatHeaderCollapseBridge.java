package com.yee94.yuri.nsh;

import android.app.Activity;
import android.view.View;

import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

import java.util.Map;

/**
 * Header/composer collapse writer (iOS ChatHeaderCollapse.swift).
 *
 * Android's NSH renderer draws the chat header itself and exposes no platform
 * navigation bar to transform, so there is no counterpart writer. The
 * component validates its props and reports `unsupported` once instead of
 * silently claiming the collapse was applied.
 */
public final class ChatHeaderCollapseBridge implements NativeHandlers.Bridge {
    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;

    public ChatHeaderCollapseBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    @Override
    public void install() {
        view.registerComponent("yuri.chat.headerCollapse", context -> new Owner(activity, context));
    }

    @Override
    public void invalidate() {}

    private static final class Owner implements NshComponent {
        private final NativeHandlers.RegistrationView registration;
        private final NshComponentContext context;
        private double progress;
        private double duration;
        private boolean active;
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
            switch (name) {
                case "progress":
                    if (value instanceof Number && Double.isFinite(((Number) value).doubleValue())) {
                        progress = Math.min(1, Math.max(0, ((Number) value).doubleValue()));
                    }
                    break;
                case "duration":
                    duration = value instanceof Number ? Math.max(0, ((Number) value).doubleValue()) : 0;
                    break;
                case "active":
                    active = value instanceof Boolean && (Boolean) value;
                    break;
                default:
                    break;
            }
            if (!reported) {
                reported = true;
                context.emit("unsupported", Map.of("reason", "android_native_header_unavailable"));
            }
        }
    }
}
