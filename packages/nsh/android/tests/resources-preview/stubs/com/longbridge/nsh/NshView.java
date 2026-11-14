package com.longbridge.nsh;

/**
 * Compile-only stand-in for the `nsh.aar` runtime type while the Android
 * distribution is not built yet. Mirrors the public surface of
 * `crates/nsh-platform-android/java/com/longbridge/nsh/NshView.java`
 * (constructor, `handle`, `send`, `registerComponent`). Never shipped.
 */
public class NshView extends android.view.View {
    public interface HostHandler {
        void handle(Object data, NshHostReply reply);
    }

    public NshView(android.content.Context context) {
        super(context);
    }

    public boolean send(String name, Object data) { return false; }

    public void handle(String name, HostHandler handler) {}

    public void registerComponent(String name, NshComponent.Factory factory) {}
}
