package com.yee94.yuri.nsh;

/**
 * Typed bridge failure. The code mirrors the iOS failure case name
 * (`ResourceWebPreviewFailure`, `GuiPluginPreviewFailure`, ...) or the GUI
 * device/export code string, so callers see the same shape on both platforms.
 * The message is the iOS user-facing copy when there is one.
 */
final class ResourceFailure extends Exception {
    final String code;

    ResourceFailure(String code) { this(code, code); }

    ResourceFailure(String code, String message) {
        super(message == null ? code : message);
        this.code = code;
    }

    static ResourceFailure invalid() { return new ResourceFailure("invalid"); }
    static ResourceFailure stale() { return new ResourceFailure("stale"); }
    static ResourceFailure busy() { return new ResourceFailure("busy"); }
    static ResourceFailure limit() { return new ResourceFailure("limit"); }
    static ResourceFailure response() { return new ResourceFailure("response"); }
    static ResourceFailure unsupported() { return new ResourceFailure("unsupported"); }
    static ResourceFailure unavailable() { return new ResourceFailure("unavailable"); }
}
