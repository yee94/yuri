package com.yee94.yuri.nsh;

import android.app.Activity;
import android.graphics.Rect;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Toolbar;

import com.longbridge.nsh.NshView;

import java.util.Map;

/**
 * Read-only shell geometry (iOS FeedbackLayoutBridge.swift). It has no Host,
 * credential or notification access. The Android equivalent of the iOS
 * navigation bar is the action bar or a platform Toolbar; NSH's own header is
 * rendered inside the surface and is not a separate platform bar.
 */
public final class FeedbackLayoutBridge implements NativeHandlers.Bridge {
    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;

    public FeedbackLayoutBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    @Override
    public void install() {
        view.handle("feedback.layout", (input, reply) -> {
            if (!(input instanceof Map) || !((Map<?, ?>) input).isEmpty()) {
                reply.reject("feedback_layout_invalid");
                return;
            }
            float density = NativeHandlers.density(view);
            float top = insetTop() / density;
            Toolbar toolbar = toolbar();
            if (toolbar != null && visible(toolbar)) {
                Rect bounds = new Rect(0, 0, toolbar.getWidth(), toolbar.getHeight());
                offset(toolbar, view, bounds);
                if (bounds.width() > 0 && bounds.height() > 0 && bounds.bottom > 0 && bounds.top < view.getHeight() / 2f) {
                    top = Math.max(top, bounds.bottom / density);
                }
            }
            reply.resolve(Map.of("top", top));
        });
    }

    @Override
    public void invalidate() {}

    private float insetTop() {
        WindowInsets insets = view.getRootWindowInsets();
        if (insets == null) return 0;
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
            return bars.top;
        }
        return insets.getSystemWindowInsetTop();
    }

    private Toolbar toolbar() {
        return find(activity.getWindow().getDecorView());
    }

    private static Toolbar find(View node) {
        if (node instanceof Toolbar && node.getVisibility() == View.VISIBLE) return (Toolbar) node;
        if (node instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) node;
            for (int index = 0; index < group.getChildCount(); index++) {
                Toolbar match = find(group.getChildAt(index));
                if (match != null) return match;
            }
        }
        return null;
    }

    private static boolean visible(View node) {
        View current = node;
        while (current != null) {
            if (current.getVisibility() != View.VISIBLE || current.getAlpha() <= 0.01f) return false;
            current = current.getParent() instanceof View ? (View) current.getParent() : null;
        }
        return node.getWindowToken() != null;
    }

    private static void offset(View node, View surface, Rect bounds) {
        int[] target = new int[2];
        int[] origin = new int[2];
        node.getLocationOnScreen(target);
        surface.getLocationOnScreen(origin);
        bounds.offset(target[0] - origin[0], target[1] - origin[1]);
    }
}
