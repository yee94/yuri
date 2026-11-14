package com.longbridge.nsh;

/**
 * Compile-only stand-in for the nsh.aar API while the distribution is not built locally.
 * Signatures match com.longbridge.nsh.NshView; never shipped.
 */
public class NshView extends android.widget.FrameLayout {
    public interface HostHandler { void handle(Object data, NshHostReply reply); }

    public NshView(android.content.Context context) { super(context); }

    public NshView(android.content.Context context, boolean trace) { super(context); }

    public boolean send(String name, Object data) { return true; }

    public void handle(String name, HostHandler handler) {}

    public void destroy() {}
}
