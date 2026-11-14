package com.yee94.yuri.nsh;

import android.app.Activity;
import android.view.View;

import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * System page-sheet presentation (iOS SheetPresentation.swift).
 *
 * Android uses the NSH runtime's own Dialog/Sheet fallback, so
 * `NativeSheet` never mounts this component there. It is still registered so
 * the component name is declared consistently, validates the same props and
 * never presents a second sheet of its own.
 */
public final class SheetPresentationBridge implements NativeHandlers.Bridge {
    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;

    public SheetPresentationBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    @Override
    public void install() {
        view.registerComponent("yuri.sheet.presentation", context -> new Owner(activity, context));
    }

    @Override
    public void invalidate() {}

    private static final class Owner implements NshComponent {
        private final NativeHandlers.RegistrationView registration;
        private final NshComponentContext context;
        private int generation;
        private final List<Double> detents = new ArrayList<>(List.of(0.5, 1.0));
        private int initial;
        private boolean viewportDetents;
        private boolean dismissible = true;

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
                case "generation":
                    if (generation == 0 && value instanceof Number) {
                        double id = ((Number) value).doubleValue();
                        if (id == Math.rint(id) && id > 0) generation = (int) id;
                    }
                    break;
                case "detents":
                    if (value instanceof List) {
                        Set<Double> valid = new LinkedHashSet<>();
                        for (Object item : (List<?>) value) {
                            if (!(item instanceof Number)) continue;
                            double fraction = ((Number) item).doubleValue();
                            if (Double.isFinite(fraction) && fraction > 0 && fraction <= 1) valid.add(fraction);
                        }
                        if (!valid.isEmpty()) {
                            detents.clear();
                            detents.addAll(valid);
                            detents.sort(Double::compareTo);
                        }
                    }
                    break;
                case "initialDetent":
                    initial = value instanceof Number ? Math.max(0, ((Number) value).intValue()) : 0;
                    break;
                case "viewportDetents":
                    viewportDetents = value instanceof Boolean && (Boolean) value;
                    break;
                case "dismissible":
                    dismissible = !(value instanceof Boolean) || (Boolean) value;
                    break;
                case "diagnostic":
                    // Closed metadata projection only; nothing is stored or logged.
                    break;
                default:
                    break;
            }
        }

        @Override
        public void command(String name, Object args) {
            // No native sheet exists here: dismissal is owned by the NSH runtime.
        }
    }
}
