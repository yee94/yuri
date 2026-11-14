package com.yee94.yuri.nsh;

import android.app.Activity;
import android.view.View;
import android.widget.EditText;

import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Paired-local accessibility identity for the three new-session fields (iOS
 * NewSessionPickerOwners.swift). Only registered new-session leaves take part;
 * there is no window/application traversal and no background AX write.
 *
 * Android's NSH host exposes no accessibility identifier for JS `testID`, so
 * linkage is structural: the registration's host, its owner and the single
 * editor directly below that owner. Any ambiguity is a coded failure instead
 * of writing a label to a guessed field.
 */
public final class NewSessionPickerBridge implements NativeHandlers.Bridge {
    private static final Set<String> FIELDS = Set.of("selection", "presets", "directory");

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;

    public NewSessionPickerBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    @Override
    public void install() {
        view.registerComponent("yuri.newSession.inputAX", context -> new Owner(activity, context));
    }

    @Override
    public void invalidate() {}

    private static final class Owner implements NshComponent {
        private final NativeHandlers.RegistrationView registration;
        private final NshComponentContext context;
        private String field;
        private String label;
        private EditText editor;
        private String savedLabel;
        private String writtenLabel;
        private String lastFailure;

        Owner(Activity activity, NshComponentContext context) {
            this.context = context;
            this.registration = new NativeHandlers.RegistrationView(activity);
            this.registration.changed = this::bind;
        }

        @Override
        public View view() {
            return registration;
        }

        @Override
        public void setProp(String name, Object value) {
            if ("field".equals(name) && value instanceof String) field = (String) value;
            if ("label".equals(name) && value instanceof String) label = (String) value;
            bind();
        }

        /** Rollback touches only the editor this owner wrote. */
        private void restore() {
            if (editor != null) {
                CharSequence current = editor.getContentDescription();
                if (writtenLabel != null && writtenLabel.contentEquals(current == null ? "" : current)) {
                    editor.setContentDescription(savedLabel);
                }
            }
            editor = null;
            savedLabel = null;
            writtenLabel = null;
        }

        private void fail(String code) {
            if (code.equals(lastFailure)) return;
            lastFailure = code;
            context.emit("failure", Map.of("code", code));
        }

        private void bind() {
            if (registration.getWindowToken() == null) {
                restore();
                return;
            }
            List<View> candidates = new ArrayList<>();
            View host = NativeHandlers.hostOf(registration);
            View owner = NativeHandlers.ownerOf(registration);
            if (field == null || !FIELDS.contains(field) || label == null || label.isEmpty() || host == null || owner == null) {
                return;
            }
            NativeHandlers.collect(owner, host, EditText.class, candidates);
            if (candidates.size() != 1) {
                restore();
                fail("expected-one-owned-text-field");
                return;
            }
            View target = candidates.get(0);
            View container = target.getParent() instanceof View ? (View) target.getParent() : null;
            if (target.getWindowToken() != registration.getWindowToken() || container == null
                || container.getParent() != owner) {
                restore();
                fail("expected-one-owned-text-field");
                return;
            }
            CharSequence existing = target.getContentDescription();
            String current = existing == null ? null : existing.toString();
            if (current != null && !current.equals(label) && target != editor) {
                restore();
                fail("conflicting-editor-identity");
                return;
            }
            if (target != editor) {
                restore();
                editor = (EditText) target;
                savedLabel = current;
            }
            writtenLabel = label;
            target.setContentDescription(label);
            lastFailure = null;
        }
    }
}
