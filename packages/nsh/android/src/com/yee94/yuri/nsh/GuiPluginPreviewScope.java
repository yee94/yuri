package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Map;

/** Scoped plugin document: scheme, entry, asset paths and response headers. */
final class GuiPluginPreviewScope {
    static final String SCHEME = "yuri-plugin";
    static final String ENTRY = "/index.html";
    static final String ORIGIN = "https://yuri-plugin.invalid";
    static final int LIMIT = ResourceWebPreviewScope.RESPONSE_LIMIT;
    static final int REPLY_LIMIT = GuiPluginRuntime.REPLY_LIMIT;
    static final int TOTAL_LIMIT = ResourceWebPreviewScope.TOTAL_LIMIT;
    static final String POLICY = "default-src 'none'; script-src 'self' blob: 'unsafe-eval' 'unsafe-inline'; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "
            + "connect-src 'self'; frame-src 'self' blob:; worker-src 'none'; object-src 'none'; "
            + "base-uri 'none'; form-action 'none'";
    // Resource documents execute scripts in an opaque sandbox origin: omitting
    // allow-same-origin keeps a same-origin child from reaching parent eval.
    static final String RESOURCE_POLICY = "default-src 'none'; sandbox allow-scripts allow-modals allow-downloads; "
            + "script-src yuri-plugin: blob: 'unsafe-eval' 'unsafe-inline'; style-src yuri-plugin: 'unsafe-inline'; "
            + "img-src yuri-plugin: data: blob:; font-src yuri-plugin: data:; connect-src yuri-plugin:; "
            + "frame-src yuri-plugin: blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

    private GuiPluginPreviewScope() {}

    static Map<String, String> responseHeaders(GuiPluginPreviewBridge.Response response, boolean applicationDocument) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", response.mime);
        headers.put("Content-Security-Policy", (applicationDocument ? POLICY : RESOURCE_POLICY)
                + (response.headers.containsKey("content-security-policy") ? ", " + response.headers.get("content-security-policy") : ""));
        headers.put("Cache-Control", "no-store");
        headers.put("Referrer-Policy", "no-referrer");
        headers.put("X-Content-Type-Options", "nosniff");
        if (!applicationDocument) {
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cross-Origin-Resource-Policy", "cross-origin");
        }
        return headers;
    }

    static boolean assetPath(String path) {
        return path != null && ResourceWebPreviewScope.canonicalFile(path) && !path.contains("%")
                && (path.equals(ENTRY) || path.startsWith("/assets/"));
    }

    /** Strict asset URL: exact scheme/owner, no query/fragment, entry or `/assets/…`. */
    static String asset(String url, String owner) throws ResourceFailure {
        ResourceWebPreviewScope.UrlParts parts = ResourceWebPreviewScope.UrlParts.parse(url);
        if (parts == null || !parts.scheme.equals(SCHEME) || !owner.equals(parts.host)
                || parts.userInfo != null || parts.port != -1 || parts.query != null || parts.fragment != null) {
            throw ResourceFailure.invalid();
        }
        String path = ResourceWebPreviewScope.percentDecode(parts.path);
        if (path == null || !ResourceWebPreviewScope.canonicalFile(path) || path.contains("%") || !assetPath(path)) {
            throw ResourceFailure.invalid();
        }
        return path;
    }
}
