package com.yee94.yuri.nsh;

import android.content.Context;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Port of iOS `ResourceHTMLComponents`: the two NSH components the TSX resource
 * page registers — `yuri.resource.html` (inline HTML document) and
 * `yuri.resource.presentation` (the exact dialog that may host a system preview).
 *
 * UIKit's responder-chain controller capture does not exist on Android: the
 * anchor proves its own attachment to a live window instead, and the preview it
 * authorizes is the bridge's own fullscreen `Dialog`. Attachment is therefore the
 * only admission signal, and every failure still reports the same event names.
 */
public final class ResourceHTMLComponents {
    private ResourceHTMLComponents() {}

    public static void installView(NshView surface, ResourceWebPreviewBridge bridge) {
        Context context = surface.getContext();
        surface.registerComponent("yuri.resource.html", new NshComponent.Factory() {
            @Override public NshComponent create(NshComponentContext host) {
                return new HTMLComponent(context, bridge, host);
            }
        });
    }

    public static void installPresentationAnchor(NshView surface, ResourceBridge bridge) {
        Context context = surface.getContext();
        surface.registerComponent("yuri.resource.presentation", new NshComponent.Factory() {
            @Override public NshComponent create(NshComponentContext host) {
                return new PresentationAnchor(context, bridge, host);
            }
        });
    }

    private static final class HTMLComponent implements NshComponent {
        private final ResourceWebPreviewView.Mount mount;

        HTMLComponent(Context context, ResourceWebPreviewBridge bridge, NshComponentContext host) {
            mount = new ResourceWebPreviewView.Mount(context, bridge,
                    owner -> {
                        Map<String, Object> event = new LinkedHashMap<>();
                        event.put("owner", owner);
                        host.emit("failed", event);
                    },
                    presentationOwner -> bridge.ownsPresentation(presentationOwner));
        }

        @Override public android.view.View view() { return mount; }

        @Override public void setProp(String name, Object value) {
            if ("config".equals(name)) mount.update(value);
        }
    }

    /** Registers only the dialog actually containing this anchor; no topmost search. */
    private static final class PresentationAnchor implements NshComponent {
        private final FrameLayout anchor;
        private final ResourceBridge bridge;
        private final NshComponentContext host;
        private final String registration = UUID.randomUUID().toString();
        private String owner;
        private RuntimeHostScope expected;
        private boolean ready = false;
        private boolean retired = false;
        private boolean opening = false;
        private boolean opened = false;
        private boolean closeRequested = false;
        private int closeAttempt = 0;
        private Integer failedAttempt;
        private boolean captured = false;

        PresentationAnchor(Context context, ResourceBridge bridge, NshComponentContext host) {
            this.bridge = bridge;
            this.host = host;
            anchor = new FrameLayout(context);
            anchor.setClickable(false);
            anchor.setFocusable(false);
            anchor.addOnAttachStateChangeListener(new android.view.View.OnAttachStateChangeListener() {
                @Override public void onViewAttachedToWindow(android.view.View view) { attach(); }

                @Override public void onViewDetachedFromWindow(android.view.View view) {
                    if (captured && !opened) failClose("controller_detached");
                    if (ready) {
                        retired = true;
                        bridge.markPresenterDetached(owner, registration);
                    }
                }
            });
        }

        @Override public android.view.View view() { return anchor; }

        @Override public void setProp(String name, Object value) {
            if ("closing".equals(name)) {
                closeRequested = Boolean.TRUE.equals(value);
                attach();
                dismissIfRequested();
                return;
            }
            if ("closeAttempt".equals(name)) {
                Long attempt = ResourceJson.integer(value, 1, Integer.MAX_VALUE);
                if (attempt != null && attempt.intValue() > closeAttempt) {
                    closeAttempt = attempt.intValue();
                    attach();
                    dismissIfRequested();
                }
                return;
            }
            if (!"config".equals(name) || owner != null) return;
            Map<String, Object> args = ResourceJson.object(value);
            if (args == null || !args.keySet().equals(new java.util.HashSet<>(
                    java.util.Arrays.asList("owner", "expectedHost")))) return;
            String next = ResourceJson.text(args.get("owner"));
            if (next == null || next.isEmpty()) return;
            try {
                expected = ResourceBridge.scope(args.get("expectedHost"));
            } catch (ResourceFailure invalid) {
                return;
            }
            owner = next;
            attach();
        }

        @Override public void destroy() {
            if (owner != null) bridge.unregisterPresenter(owner, registration);
        }

        private void attach() {
            if (retired || anchor.getWindowToken() == null || owner == null || expected == null) return;
            if (captured) {
                finishOpening();
                dismissIfRequested();
                return;
            }
            captured = true;
            try {
                bridge.registerPresenter(owner, registration, expected);
                ready = true;
                Map<String, Object> event = new LinkedHashMap<>();
                event.put("owner", owner);
                host.emit("ready", event);
            } catch (Exception failure) {
                Map<String, Object> event = new LinkedHashMap<>();
                event.put("owner", owner);
                host.emit("failed", event);
            }
            finishOpening();
        }

        private void finishOpening() {
            if (opening || opened || failedAttempt != null && failedAttempt == closeAttempt) return;
            opening = true;
            // The anchor's own container is already on screen; no system transition
            // is pending, which is the iOS `opening_transition_unavailable`-free branch.
            opening = false;
            opened = true;
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("owner", owner);
            host.emit("opened", event);
            dismissIfRequested();
        }

        private void dismissIfRequested() {
            if (!closeRequested || closeAttempt <= 0 || !captured || !opened) return;
            if (failedAttempt != null && failedAttempt == closeAttempt) return;
            if (bridge.ownsPresentation(owner)) {
                if (!bridge.dismissOwnedPresentation(owner)) {
                    failClose("controller_not_dismissible");
                    return;
                }
                Map<String, Object> event = new LinkedHashMap<>();
                event.put("owner", owner);
                host.emit("closed", event);
                return;
            }
            // Nothing is presented for this owner: the request is already satisfied.
            if (bridge.hasPresentedOwner()) return;
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("owner", owner);
            host.emit("closed", event);
        }

        private void failClose(String code) {
            if (!closeRequested || closeAttempt <= 0 || owner == null) return;
            if (failedAttempt != null && failedAttempt == closeAttempt) return;
            failedAttempt = closeAttempt;
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("owner", owner);
            event.put("attempt", closeAttempt);
            event.put("code", code);
            host.emit("closeFailed", event);
        }
    }
}
