package com.yee94.yuri.nsh;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Port of iOS `ResourceWebPreviewScope` (and its response/proxy/transport types).
 * Pure string logic so it runs on a plain JVM as well as in the app.
 */
final class ResourceWebPreviewScope {
    static final String SCHEME = "yuri-resource";
    static final int RESPONSE_LIMIT = 8 * 1024 * 1024;
    static final int TOTAL_LIMIT = 32 * 1024 * 1024;
    static final String POLICY = "default-src 'none'; script-src 'self' 'unsafe-inline'; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "
            + "media-src 'self' blob:; connect-src 'self'; frame-src 'none'; worker-src 'none'; "
            + "object-src 'none'; base-uri 'none'; form-action 'none'";

    private static final String ALLOWED_PATH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
    private static final Set<String> LOOPBACK_HOSTS = new HashSet<>(Arrays.asList("localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"));
    private static final Set<String> FORBIDDEN_QUERY = new HashSet<>(Arrays.asList(
            "oc_client_token", "yuri_client_token", "yuri_url_token", "authorization", "access_token", "token"));

    final String directory;
    final String proxyBase;
    final String entryPath;

    private ResourceWebPreviewScope(String directory, String proxyBase, String entryPath) {
        this.directory = directory;
        this.proxyBase = proxyBase;
        this.entryPath = entryPath;
    }

    static boolean canonicalFile(String value) {
        if (value == null || !value.startsWith("/") || value.startsWith("//") || value.contains("\\")) return false;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 32 || character == 127) return false;
        }
        if (value.equals("/")) return true;
        for (String part : value.substring(1).split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        }
        return true;
    }

    static boolean within(String path, String root) {
        return root.equals("/") || path.startsWith(root + "/");
    }

    static ResourceWebPreviewScope html(String directory, String path) throws ResourceFailure {
        if (!canonicalFile(directory) || !canonicalFile(path) || !within(path, directory)
                || !ResourceMediaPolicy.isHtmlPath(path)) throw ResourceFailure.invalid();
        return new ResourceWebPreviewScope(directory, null, encodePath(path));
    }

    static Loopback loopback(String value) throws ResourceFailure {
        if (value == null || utf8Length(value) > 8192) throw ResourceFailure.invalid();
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character <= 32 || character == 127) throw ResourceFailure.invalid();
        }
        if (value.contains("\\")) throw ResourceFailure.invalid();
        UrlParts parts = UrlParts.parse(value);
        if (parts == null || !(parts.scheme.equals("http") || parts.scheme.equals("https"))) throw ResourceFailure.invalid();
        if (!LOOPBACK_HOSTS.contains(parts.host == null ? "" : parts.host.toLowerCase(Locale.ROOT))) throw ResourceFailure.invalid();
        if (parts.userInfo != null || parts.port != -1 && (parts.port < 1 || parts.port > 65535)) throw ResourceFailure.invalid();
        if (!safeQuery(parts.query)) throw ResourceFailure.invalid();
        if (hasForbiddenQuery(parts.query, "yuri_preview_token")) throw ResourceFailure.invalid();
        String decoded = percentDecode(parts.path);
        if (decoded == null || decoded.contains("\\")) throw ResourceFailure.invalid();
        for (int index = 0; index < decoded.length(); index++) {
            char character = decoded.charAt(index);
            if (character < 32 || character == 127) throw ResourceFailure.invalid();
        }
        return new Loopback(value, parts, decoded);
    }

    static ResourceWebPreviewScope proxy(String basePath, Loopback target) throws ResourceFailure {
        if (basePath == null || !basePath.matches("^/api/preview/proxy/[a-f0-9]{16,64}$")) throw ResourceFailure.invalid();
        String path = target.parts.path.isEmpty() ? "/" : target.parts.path;
        String entry = basePath + path
                + (target.parts.query == null ? "" : "?" + target.parts.query)
                + (target.parts.fragment == null ? "" : "#" + target.parts.fragment);
        ResourceWebPreviewScope scope = new ResourceWebPreviewScope(null, basePath, entry);
        scope.route(SCHEME + "://fixture" + entry, "fixture");
        return scope;
    }

    static String encodePath(String path) {
        StringBuilder out = new StringBuilder();
        String[] parts = path.split("/", -1);
        for (int index = 0; index < parts.length; index++) {
            if (index > 0) out.append('/');
            out.append(percentEncode(parts[index]));
        }
        return out.toString();
    }

    static String statRoute(String path) {
        return "/api/fs/stat?path=" + encodePath(path).replace("/", "%2F");
    }

    static void validateStat(ResourceWebPreviewResponse response) throws ResourceFailure {
        if (response.data.length > 65536 || response.status < 200 || response.status >= 300
                || !response.mime.toLowerCase(Locale.ROOT).startsWith("application/json")) throw ResourceFailure.response();
        Object parsed = ResourceJson.parse(new String(response.data, StandardCharsets.UTF_8));
        if (parsed == null) parsed = ResourceJson.parse(new String(response.data, StandardCharsets.ISO_8859_1));
        java.util.Map<String, Object> metadata = ResourceJson.object(parsed);
        if (metadata == null || !Boolean.TRUE.equals(metadata.get("isFile"))) throw ResourceFailure.response();
        Long size = ResourceJson.integer(metadata.get("size"), 0, Long.MAX_VALUE);
        if (size == null || size < 0) throw ResourceFailure.response();
        if (size > RESPONSE_LIMIT) throw ResourceFailure.limit();
    }

    static void validate(ResourceWebPreviewResponse response, boolean document) throws ResourceFailure {
        if (response.status < 200 || response.status >= 300 || response.data.length > RESPONSE_LIMIT) throw ResourceFailure.response();
        if (response.mime.indexOf('\r') >= 0 || response.mime.indexOf('\n') >= 0) throw ResourceFailure.response();
        if (response.contentSecurityPolicy != null
                && (response.contentSecurityPolicy.indexOf('\r') >= 0 || response.contentSecurityPolicy.indexOf('\n') >= 0)) {
            throw ResourceFailure.response();
        }
        String mime = response.mime.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        if (document && !mime.equals("text/html")) throw ResourceFailure.response();
    }

    /** Host-relative route for one scoped document/subresource URL. */
    String route(String url, String owner) throws ResourceFailure {
        UrlParts parts = UrlParts.parse(url);
        if (parts == null || !parts.scheme.equals(SCHEME) || !owner.equals(parts.host)
                || parts.userInfo != null || parts.port != -1 || !safeQuery(parts.query)) throw ResourceFailure.invalid();
        String decoded = percentDecode(parts.path);
        if (decoded == null || decoded.contains("%")) throw ResourceFailure.invalid();
        String checked = proxyBase != null && decoded.endsWith("/") ? decoded.substring(0, decoded.length() - 1) : decoded;
        if (!canonicalFile(checked)) throw ResourceFailure.invalid();
        if (directory != null) {
            if (!within(decoded, directory)) throw ResourceFailure.invalid();
            return "/api/fs/serve" + encodePath(decoded);
        }
        if (proxyBase == null || !decoded.startsWith(proxyBase + "/")) throw ResourceFailure.invalid();
        return parts.path + (parts.query == null ? "" : "?" + parts.query);
    }

    static String percentEncode(String value) {
        StringBuilder out = new StringBuilder();
        for (byte raw : value.getBytes(StandardCharsets.UTF_8)) {
            int character = raw & 0xff;
            if (character < 0x80 && ALLOWED_PATH.indexOf((char) character) >= 0) out.append((char) character);
            else out.append('%').append(String.format("%02X", character));
        }
        return out.toString();
    }

    /** Percent-decoded UTF-8, or null for a malformed escape. */
    static String percentDecode(String value) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character == '%') {
                if (index + 2 >= value.length()) return null;
                int high = Character.digit(value.charAt(index + 1), 16);
                int low = Character.digit(value.charAt(index + 2), 16);
                if (high < 0 || low < 0) return null;
                bytes.write((high << 4) + low);
                index += 2;
            } else {
                byte[] encoded = String.valueOf(character).getBytes(StandardCharsets.UTF_8);
                bytes.write(encoded, 0, encoded.length);
            }
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }

    static int utf8Length(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }

    private static boolean safeQuery(String query) {
        if (query == null) return true;
        for (QueryPair pair : queryPairs(query)) {
            if (FORBIDDEN_QUERY.contains(pair.name.toLowerCase(Locale.ROOT))) return false;
            for (int index = 0; index < pair.value.length(); index++) {
                char character = pair.value.charAt(index);
                if (character < 32 || character == 127) return false;
            }
        }
        return true;
    }

    static boolean hasForbiddenQuery(String query, String name) {
        if (query == null) return false;
        for (QueryPair pair : queryPairs(query)) {
            if (pair.name.toLowerCase(Locale.ROOT).equals(name)) return true;
        }
        return false;
    }

    static List<QueryPair> queryPairs(String query) {
        List<QueryPair> pairs = new ArrayList<>();
        if (query == null || query.isEmpty()) return pairs;
        for (String item : query.split("&")) {
            int equals = item.indexOf('=');
            String rawName = equals < 0 ? item : item.substring(0, equals);
            String rawValue = equals < 0 ? "" : item.substring(equals + 1);
            String name = percentDecode(rawName);
            String value = percentDecode(rawValue);
            pairs.add(new QueryPair(name == null ? rawName : name, value == null ? rawValue : value));
        }
        return pairs;
    }

    static final class QueryPair {
        final String name;
        final String value;
        QueryPair(String name, String value) { this.name = name; this.value = value; }
    }

    /** A parsed loopback http(s) target: credentials-free Host-local origin plus its path. */
    static final class Loopback {
        final String value;
        final UrlParts parts;
        final String decodedPath;
        Loopback(String value, UrlParts parts, String decodedPath) {
            this.value = value;
            this.parts = parts;
            this.decodedPath = decodedPath;
        }
    }

    /** Minimal URL split; keeps percent-encoded path/query/fragment bytes intact. */
    static final class UrlParts {
        String scheme;
        String userInfo;
        String host;
        int port = -1;
        String path = "";
        String query;
        String fragment;

        static UrlParts parse(String value) {
            if (value == null) return null;
            int colon = value.indexOf(':');
            if (colon <= 0) return null;
            String scheme = value.substring(0, colon);
            if (!scheme.matches("[a-zA-Z][a-zA-Z0-9+.-]*")) return null;
            UrlParts parts = new UrlParts();
            parts.scheme = scheme.toLowerCase(Locale.ROOT);
            int index = colon + 1;
            String rest = value.substring(index);
            if (rest.startsWith("//")) {
                int end = rest.length();
                for (int position = 2; position < rest.length(); position++) {
                    char character = rest.charAt(position);
                    if (character == '/' || character == '?' || character == '#') { end = position; break; }
                }
                String authority = rest.substring(2, end);
                rest = rest.substring(end);
                if (!parts.authority(authority)) return null;
            } else if (!rest.startsWith("/")) {
                // Opaque reference such as `mailto:`; no authority, host stays null.
                int stop = rest.length();
                for (int position = 0; position < rest.length(); position++) {
                    char character = rest.charAt(position);
                    if (character == '?' || character == '#') { stop = position; break; }
                }
                parts.path = rest.substring(0, stop);
                rest = rest.substring(stop);
            }
            int hash = rest.indexOf('#');
            if (hash >= 0) {
                parts.fragment = rest.substring(hash + 1);
                rest = rest.substring(0, hash);
            }
            int question = rest.indexOf('?');
            if (question >= 0) {
                parts.query = rest.substring(question + 1);
                rest = rest.substring(0, question);
            }
            parts.path = rest;
            return parts;
        }

        private boolean authority(String authority) {
            String value = authority;
            int at = value.lastIndexOf('@');
            if (at >= 0) {
                userInfo = value.substring(0, at);
                value = value.substring(at + 1);
            }
            if (value.startsWith("[")) {
                int close = value.indexOf(']');
                if (close < 0) return false;
                host = value.substring(0, close + 1);
                String tail = value.substring(close + 1);
                if (!tail.isEmpty()) {
                    if (!tail.startsWith(":")) return false;
                    Integer port = parsePort(tail.substring(1));
                    if (port == null) return false;
                    this.port = port;
                }
                return true;
            }
            int portColon = value.lastIndexOf(':');
            if (portColon >= 0) {
                Integer port = parsePort(value.substring(portColon + 1));
                if (port == null) return false;
                this.port = port;
                value = value.substring(0, portColon);
            }
            host = value;
            return true;
        }

        private static Integer parsePort(String value) {
            if (value.isEmpty() || !value.matches("[0-9]{1,5}")) return null;
            try {
                return Integer.parseInt(value);
            } catch (NumberFormatException error) {
                return null;
            }
        }
    }

    /** One bounded native read: status, MIME and bytes. */
    static final class ResourceWebPreviewResponse {
        final int status;
        final String mime;
        final byte[] data;
        final String contentSecurityPolicy;

        ResourceWebPreviewResponse(int status, String mime, byte[] data, String contentSecurityPolicy) {
            this.status = status;
            this.mime = mime == null ? "" : mime;
            this.data = data == null ? new byte[0] : data;
            this.contentSecurityPolicy = contentSecurityPolicy;
        }

        ResourceWebPreviewResponse(int status, String mime, byte[] data) {
            this(status, mime, data, null);
        }

        /** Response headers handed to the WebView; the iOS WKURLSchemeTask equivalent. */
        java.util.Map<String, String> webHeaders() {
            java.util.Map<String, String> headers = new java.util.LinkedHashMap<>();
            headers.put("Content-Type", mime);
            headers.put("Content-Security-Policy", POLICY + (contentSecurityPolicy == null ? "" : ", " + contentSecurityPolicy));
            headers.put("Cache-Control", "no-store");
            headers.put("Referrer-Policy", "no-referrer");
            headers.put("X-Content-Type-Options", "nosniff");
            return headers;
        }
    }

    /** Short-lived preview proxy minted by the captured Runtime owner. */
    static final class ResourceWebPreviewProxy {
        final String basePath;
        final long expiresAtMillis;
        final ResourceWebPreviewTransport.ReadRoute read;

        ResourceWebPreviewProxy(String basePath, long expiresAtMillis, ResourceWebPreviewTransport.ReadRoute read) {
            this.basePath = basePath;
            this.expiresAtMillis = expiresAtMillis;
            this.read = read;
        }
    }

    /** Authenticated, bounded, generation-fenced reads supplied by RuntimeBridge. */
    static final class ResourceWebPreviewTransport {
        interface ReadRoute {
            CompletableFuture<ResourceWebPreviewResponse> read(String route, int limit);
        }

        /** Direction of one raw request with explicit headers; only RuntimeBridge installs it. */
        interface Send {
            CompletableFuture<ResourceWebPreviewResponse> send(String method, String route, byte[] body,
                    java.util.Map<String, String> headers, int limit);
        }

        final ReadRoute readFile;
        final HostLease lease;
        final Send send;

        ResourceWebPreviewTransport(ReadRoute readFile, HostLease lease, Send send) {
            this.readFile = readFile;
            this.lease = lease;
            this.send = send;
        }

        boolean isCurrent() {
            return lease != null && lease.isCurrent();
        }

        /** The `/api/preview/targets` admission; unsupported when no raw sender is installed. */
        CompletableFuture<ResourceWebPreviewProxy> prepareLoopback(String value) {
            if (send == null) return failedFuture(ResourceFailure.unsupported());
            ResourceWebPreviewScope.Loopback target;
            try {
                target = ResourceWebPreviewScope.loopback(value);
            } catch (ResourceFailure failure) {
                return failedFuture(failure);
            }
            java.util.Map<String, Object> body = new java.util.LinkedHashMap<>();
            body.put("url", value);
            body.put("ttlMs", 300000);
            body.put("allowExternal", false);
            java.util.Map<String, String> headers = new java.util.LinkedHashMap<>();
            headers.put("X-Yuri-Native-Preview", "1");
            return checked(send.send("POST", "/api/preview/targets",
                    ResourceJson.stringify(body, false).getBytes(StandardCharsets.UTF_8), headers, 65536)
                    .thenApply(response -> {
                        try {
                            return admit(target, response);
                        } catch (ResourceFailure failure) {
                            throw unchecked(failure);
                        }
                    }));
        }

        private ResourceWebPreviewProxy admit(ResourceWebPreviewScope.Loopback target,
                ResourceWebPreviewResponse response) throws ResourceFailure {
            if (!isCurrent()) throw ResourceFailure.stale();
            if (response.status < 200 || response.status >= 300 || response.data.length > 65536
                    || !response.mime.split(";", 2)[0].trim().toLowerCase(Locale.ROOT).equals("application/json")) {
                throw ResourceFailure.response();
            }
            java.util.Map<String, Object> object = ResourceJson.object(
                    ResourceJson.parse(new String(response.data, StandardCharsets.UTF_8)));
            if (object == null) throw ResourceFailure.response();
            String id = ResourceJson.text(object.get("id"));
            String base = ResourceJson.text(object.get("proxyBasePath"));
            String token = ResourceJson.text(object.get("previewToken"));
            Double expiry = ResourceJson.number(object.get("expiresAt"));
            if (id == null || !id.matches("^[a-f0-9]{16,64}$")) throw ResourceFailure.response();
            if (base == null || !base.equals("/api/preview/proxy/" + id)) throw ResourceFailure.response();
            if (token == null || !token.matches("^[a-f0-9]{32}$")) throw ResourceFailure.response();
            if (expiry == null) throw ResourceFailure.response();
            long expiresAt = (long) (expiry / 1000);
            long now = System.currentTimeMillis();
            if (expiresAt <= now || expiresAt - now > 300_000L) throw ResourceFailure.response();
            ResourceWebPreviewScope scope = ResourceWebPreviewScope.proxy(base, target);
            return new ResourceWebPreviewProxy(base, expiresAt, (route, limit) -> checked(
                    send.send("GET", stripPreviewToken(scope, route), null, previewReadHeaders(token), limit)
                            .thenApply(result -> {
                                try {
                                    if (!isCurrent() || expiresAt <= System.currentTimeMillis()) throw ResourceFailure.stale();
                                    if (result.data.length > limit) throw ResourceFailure.limit();
                                    ResourceWebPreviewScope.validate(result, false);
                                    return result;
                                } catch (ResourceFailure failure) {
                                    throw unchecked(failure);
                                }
                            })));
        }

        /** Rewritten resources may carry an old scoped token; never forward it. */
        private static String stripPreviewToken(ResourceWebPreviewScope scope, String route) {
            try {
                if (route.isEmpty() || route.contains("%00")) throw ResourceFailure.invalid();
                String checked = scope.route(SCHEME + "://capture" + route, "capture");
                String[] pieces = checked.split("\\?", 2);
                String query = pieces.length > 1 ? pieces[1] : null;
                if (query == null) return pieces[0];
                List<String> kept = new ArrayList<>();
                for (QueryPair pair : queryPairs(query)) {
                    if (pair.name.toLowerCase(Locale.ROOT).equals("yuri_preview_token")) continue;
                    kept.add(percentEncode(pair.name) + "=" + percentEncode(pair.value));
                }
                return kept.isEmpty() ? pieces[0] : pieces[0] + "?" + String.join("&", kept);
            } catch (ResourceFailure failure) {
                throw unchecked(failure);
            }
        }

        private static java.util.Map<String, String> previewReadHeaders(String token) {
            java.util.Map<String, String> headers = new java.util.LinkedHashMap<>();
            headers.put("X-Yuri-Native-Preview", "1");
            headers.put("X-Yuri-Preview-Token", token);
            return headers;
        }
    }

    static java.util.concurrent.CompletionException unchecked(Throwable error) {
        return new java.util.concurrent.CompletionException(error);
    }

    /** Unwraps CompletionException so callers see the typed failure. */
    static <T> CompletableFuture<T> checked(CompletableFuture<T> future) {
        CompletableFuture<T> result = new CompletableFuture<>();
        future.whenComplete((value, error) -> {
            if (error == null) result.complete(value);
            else result.completeExceptionally(unwrap(error));
        });
        return result;
    }

    /** Narrowed form for code paths that may only throw checked exceptions. */
    static Exception asException(Throwable error) {
        Throwable unwrapped = unwrap(error);
        if (unwrapped instanceof Exception) return (Exception) unwrapped;
        return new java.util.concurrent.CompletionException(unwrapped);
    }

    static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while (current instanceof java.util.concurrent.CompletionException && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    static <T> CompletableFuture<T> failedFuture(Throwable error) {
        CompletableFuture<T> future = new CompletableFuture<>();
        future.completeExceptionally(error);
        return future;
    }
}
