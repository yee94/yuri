package com.yee94.yuri.nsh;

import android.app.Activity;
import android.graphics.Rect;
import android.view.View;
import android.view.ViewGroup;

import com.longbridge.nsh.NshView;

import java.util.Map;
import java.util.Set;

/**
 * Real surface bounds for an anchored overlay (iOS NavigationBridge.swift).
 *
 * Android's NSH renderer owns the chat header as ordinary rendered views and
 * exposes no accessibility identifier for it, so the two registered anchors
 * cannot be resolved; the call answers null (the same shape iOS uses when the
 * anchor is absent) instead of inventing coordinates.
 */
public final class NavigationBridge implements NativeHandlers.Bridge {
    private static final Set<String> IDS = Set.of("chat-header-metadata", "chat-header-options");

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;

    public NavigationBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    @Override
    public void install() {
        view.handle("navigation.anchor", (input, reply) -> {
            if (!(input instanceof Map)) {
                reply.resolve(null);
                return;
            }
            Object id = ((Map<?, ?>) input).get("id");
            if (!(id instanceof String) || !IDS.contains(id)) {
                reply.resolve(null);
                return;
            }
            View anchor = find((String) id, activity.getWindow().getDecorView());
            if (anchor == null || !visible(anchor)) {
                reply.resolve(null);
                return;
            }
            Rect bounds = new Rect(0, 0, anchor.getWidth(), anchor.getHeight());
            offset(anchor, view, bounds);
            if (bounds.width() <= 0 || bounds.height() <= 0
                || !Rect.intersects(bounds, new Rect(0, 0, view.getWidth(), view.getHeight()))) {
                reply.resolve(null);
                return;
            }
            float density = NativeHandlers.density(view);
            Map<String, Object> origin = new java.util.LinkedHashMap<>();
            origin.put("x", bounds.left / density);
            origin.put("y", bounds.top / density);
            Map<String, Object> size = new java.util.LinkedHashMap<>();
            size.put("width", bounds.width() / density);
            size.put("height", bounds.height() / density);
            Map<String, Object> value = new java.util.LinkedHashMap<>();
            value.put("origin", origin);
            value.put("size", size);
            reply.resolve(value);
        });
    }

    @Override
    public void invalidate() {}

    private static View find(String id, View node) {
        Object tag = node.getTag();
        if (id.equals(tag) || id.equals(node.getContentDescription())) return node;
        if (node instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) node;
            for (int index = 0; index < group.getChildCount(); index++) {
                View match = find(id, group.getChildAt(index));
                if (match != null) return match;
            }
        }
        return null;
    }

    private static boolean visible(View node) {
        View current = node;
        while (current != null) {
            if (current.getVisibility() != View.VISIBLE || current.getAlpha() <= 0f) return false;
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
