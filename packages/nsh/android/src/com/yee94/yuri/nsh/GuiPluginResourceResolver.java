package com.yee94.yuri.nsh;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.Predicate;

/**
 * Port of iOS `GuiPluginResourceResolver`: scoped file, Host-origin and loopback
 * resources for plugin iframes/fonts/images/styles. Its only IO is the already
 * captured `ResourceWebPreviewTransport`; preview tokens never enter a URL that
 * leaves this class.
 */
final class GuiPluginResourceResolver {
    static final String INVALID = "GUI_RESOURCE_INVALID";
    static final String OUTSIDE = "GUI_RESOURCE_OUTSIDE_WORKSPACE";
    static final String UNAVAILABLE = "GUI_RESOURCE_PREVIEW_TRANSPORT_CORE_GAP";
    static final String STALE = "GUI_RESOURCE_STALE";
    static final String LIMIT = "GUI_RESOURCE_LIMIT";
    static final String HOST_IDENTITY = "GUI_RESOURCE_HOST_IDENTITY_CORE_GAP";

    private static final String HOST_PREFIX = "/__gui/host/";
    private static final String FILES_PREFIX = "/__gui/files/";
    private static final String LOOPBACK_PREFIX = "/__gui/loopback/";
    private static final String FILES_ROOT = "/__gui/files";
    private static final String PROXY_PREFIX = "/api/preview/proxy/";

    private final String directory;
    private final ResourceWebPreviewScope.ResourceWebPreviewTransport transport;
    private final Predicate<String> isHostResourceURL;
    private final Map<String, ResourceWebPreviewScope.ResourceWebPreviewProxy> proxies = new LinkedHashMap<>();
    private final Map<String, CompletableFuture<ResourceWebPreviewScope.ResourceWebPreviewProxy>> preparing = new LinkedHashMap<>();
    private boolean stopped = false;

    GuiPluginResourceResolver(String directory, ResourceWebPreviewScope.ResourceWebPreviewTransport transport,
            Predicate<String> isHostResourceURL) throws ResourceFailure {
        if (!ResourceWebPreviewScope.canonicalFile(directory)) throw failure(INVALID);
        this.directory = directory;
        this.transport = transport;
        this.isHostResourceURL = isHostResourceURL;
    }

    private static ResourceFailure failure(String code) { return new ResourceFailure(code); }

    private void check() throws ResourceFailure {
        if (stopped || !transport.isCurrent()) throw failure(STALE);
    }

    CompletableFuture<ResourceWebPreviewScope.ResourceWebPreviewResponse> read(String value, String owner) {
        CompletableFuture<ResourceWebPreviewScope.ResourceWebPreviewResponse> result;
        try {
            check();
            result = route(value, owner);
        } catch (ResourceFailure failure) {
            return ResourceWebPreviewScope.failedFuture(failure);
        }
        return ResourceWebPreviewScope.checked(result.thenApply(response -> {
            try {
                check();
                ResourceWebPreviewScope.validate(response, false);
                return response;
            } catch (ResourceFailure failure) {
                throw ResourceWebPreviewScope.unchecked(failure);
            }
        }));
    }

    private CompletableFuture<ResourceWebPreviewScope.ResourceWebPreviewResponse> route(String value, String owner)
            throws ResourceFailure {
        ResourceWebPreviewScope.UrlParts parts = ResourceWebPreviewScope.UrlParts.parse(value);
        if (parts == null || !parts.scheme.equals(GuiPluginPreviewScope.SCHEME) || !owner.equals(parts.host)
                || parts.port != -1 || parts.userInfo != null) throw failure(INVALID);
        String path = parts.path;
        if (path.startsWith(HOST_PREFIX)) {
            if (parts.query != null || isHostResourceURL == null) throw failure(HOST_IDENTITY);
            String remainder = path.substring(HOST_PREFIX.length());
            int separator = remainder.indexOf('/');
            if (separator < 0) throw failure(INVALID);
            String encoded = remainder.substring(0, separator);
            String suffix = remainder.substring(separator);
            String origin = decodeBase64Url(encoded, 16384);
            ResourceWebPreviewScope.UrlParts parsed = ResourceWebPreviewScope.UrlParts.parse(origin);
            if (parsed == null || !(parsed.scheme.equals("https") || parsed.scheme.equals("http"))
                    || parsed.host == null || parsed.host.isEmpty() || !parsed.path.isEmpty()
                    || parsed.userInfo != null || parsed.query != null || parsed.fragment != null) throw failure(INVALID);
            ResourceWebPreviewScope.UrlParts target = ResourceWebPreviewScope.UrlParts.parse(origin + suffix);
            if (target == null || !target.path.startsWith("/api/fs/serve/")
                    || !isHostResourceURL.test(origin + suffix)) throw failure(INVALID);
            String localPath = target.path.substring("/api/fs/serve".length());
            String local = GuiPluginPreviewScope.SCHEME + "://" + owner + FILES_ROOT + localPath;
            return route(local, owner);
        }
        if (path.startsWith(FILES_PREFIX)) {
            if (parts.query != null) throw failure(INVALID);
            String decoded = ResourceWebPreviewScope.percentDecode(path.substring(FILES_ROOT.length()));
            if (decoded == null || decoded.contains("%") || !ResourceWebPreviewScope.canonicalFile(decoded)
                    || !ResourceWebPreviewScope.within(decoded, directory)) throw failure(OUTSIDE);
            return ResourceWebPreviewScope.checked(transport.readFile.read(
                    "/api/fs/serve" + ResourceWebPreviewScope.encodePath(decoded),
                    ResourceWebPreviewScope.RESPONSE_LIMIT));
        }
        if (path.startsWith(LOOPBACK_PREFIX)) {
            String remainder = path.substring(LOOPBACK_PREFIX.length());
            int separator = remainder.indexOf('/');
            if (separator < 0) throw failure(INVALID);
            String encoded = remainder.substring(0, separator);
            String suffix = remainder.substring(separator);
            String origin = decodeBase64Url(encoded, Integer.MAX_VALUE);
            ResourceWebPreviewScope.Loopback parsed = ResourceWebPreviewScope.loopback(origin);
            if (!(parsed.parts.path.isEmpty() || parsed.parts.path.equals("/"))
                    || parsed.parts.query != null || parsed.parts.fragment != null) throw failure(INVALID);
            String targetValue = origin + suffix + (parts.query == null ? "" : "?" + parts.query);
            ResourceWebPreviewScope.Loopback target = ResourceWebPreviewScope.loopback(targetValue);
            return prepare(origin).thenCompose(proxy -> {
                try {
                    check();
                    ResourceWebPreviewScope scope = ResourceWebPreviewScope.proxy(proxy.basePath, target);
                    String request = GuiPluginPreviewScope.SCHEME + "://" + owner + scope.entryPath;
                    String route = scope.route(request, owner);
                    return ResourceWebPreviewScope.checked(proxy.read.read(route, ResourceWebPreviewScope.RESPONSE_LIMIT));
                } catch (ResourceFailure failure) {
                    return ResourceWebPreviewScope.<ResourceWebPreviewScope.ResourceWebPreviewResponse>failedFuture(failure);
                }
            });
        }
        if (path.startsWith(PROXY_PREFIX)) {
            ResourceWebPreviewScope.ResourceWebPreviewProxy proxy = null;
            synchronized (this) {
                for (ResourceWebPreviewScope.ResourceWebPreviewProxy candidate : proxies.values()) {
                    if (path.startsWith(candidate.basePath + "/")) {
                        proxy = candidate;
                        break;
                    }
                }
            }
            if (proxy == null || proxy.expiresAtMillis <= System.currentTimeMillis()) throw failure(STALE);
            String route = path + (parts.query == null ? "" : "?" + parts.query);
            return ResourceWebPreviewScope.checked(proxy.read.read(route, ResourceWebPreviewScope.RESPONSE_LIMIT));
        }
        throw failure(INVALID);
    }

    /** Single-flight `/api/preview/targets` admission per loopback origin, at most 16. */
    private CompletableFuture<ResourceWebPreviewScope.ResourceWebPreviewProxy> prepare(String origin) throws ResourceFailure {
        synchronized (this) {
            ResourceWebPreviewScope.ResourceWebPreviewProxy cached = proxies.get(origin);
            if (cached != null && cached.expiresAtMillis > System.currentTimeMillis()) {
                return CompletableFuture.completedFuture(cached);
            }
            if (proxies.size() + preparing.size() >= 16 && !preparing.containsKey(origin)) throw failure(LIMIT);
            CompletableFuture<ResourceWebPreviewScope.ResourceWebPreviewProxy> existing = preparing.get(origin);
            if (existing != null) return existing;
            CompletableFuture<ResourceWebPreviewScope.ResourceWebPreviewProxy> flight =
                    ResourceWebPreviewScope.checked(transport.prepareLoopback(origin + "/"));
            preparing.put(origin, flight);
            return flight.thenApply(proxy -> {
                try {
                    check();
                } catch (ResourceFailure failure) {
                    throw ResourceWebPreviewScope.unchecked(failure);
                }
                synchronized (GuiPluginResourceResolver.this) {
                    proxies.put(origin, proxy);
                    preparing.remove(origin);
                }
                return proxy;
            });
        }
    }

    private static String decodeBase64Url(String encoded, int byteLimit) throws ResourceFailure {
        if (encoded == null || encoded.getBytes(StandardCharsets.UTF_8).length > byteLimit) throw failure(INVALID);
        String value = encoded.replace('-', '+').replace('_', '/');
        int padding = (4 - value.length() % 4) % 4;
        StringBuilder padded = new StringBuilder(value);
        for (int index = 0; index < padding; index++) padded.append('=');
        try {
            byte[] data = Base64.getDecoder().decode(padded.toString());
            return new String(data, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException invalid) {
            throw failure(INVALID);
        }
    }

    synchronized void stop() {
        stopped = true;
        preparing.clear();
        proxies.clear();
    }
}
