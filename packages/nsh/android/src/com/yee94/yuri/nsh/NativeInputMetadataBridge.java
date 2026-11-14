package com.yee94.yuri.nsh;

import android.app.Activity;
import android.view.View;

import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

import java.util.Map;

/**
 * Paired-local AX metadata for the chat composer (iOS NativeInputMetadata*).
 *
 * The iOS binding verifies the owner and input container by accessibility
 * identifier, which the Android NSH host does not expose for JS `testID`
 * values. Without that identity a structural guess could label the wrong
 * editor, so this component validates the same atomic snapshot and reports
 * `unsupported` instead of writing an AX identity it cannot verify.
 */
public final class NativeInputMetadataBridge implements NativeHandlers.Bridge {
    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;

    public NativeInputMetadataBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    @Override
    public void install() {
        view.registerComponent("yuri.input.metadata", context -> new Owner(activity, context));
    }

    @Override
    public void invalidate() {}

    private static final class Owner implements NshComponent {
        private final NativeHandlers.RegistrationView registration;
        private final NshComponentContext context;
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
            NativeInputMetadataBinding.Config config = NativeInputMetadataBinding.Config.of(value);
            if (config == null || reported) return;
            reported = true;
            context.emit("unsupported", Map.of("reason", "android_accessibility_identifier_unavailable"));
        }
    }
}
