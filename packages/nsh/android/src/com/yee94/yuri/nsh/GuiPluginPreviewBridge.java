package com.yee94.yuri.nsh;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Predicate;

/**
 * Port of iOS `GuiPluginPreviewBridge` (with `GuiPluginPreviewScope`, intent,
 * assets, storage, context and the ownership gate).
 *
 * Android has no `WKScriptMessageHandlerWithReply`, so the plugin document gets a
 * narrow emulated port: a `window.webkit.messageHandlers.guiPluginPreview`
 * promise shim over one `addJavascriptInterface` object. Only the entry document
 * receives that shim; any other document is refused. Storage/device prompts use
 * `onJsPrompt` exactly where iOS uses `runJavaScriptTextInputPanelWithPrompt`.
 *
 * The lossless pull lane (`openGui` / `chunk`) is not wired on Android yet: only
 * the buffered `readGui` lane is offered, and an `openGui`-only capture reports
 * `unsupported` instead of pretending to stream.
 */
public final class GuiPluginPreviewBridge {
    static final String ENTRY = GuiPluginPreviewScope.ENTRY;
    static final int REPLY_LIMIT = GuiPluginRuntime.REPLY_LIMIT;

    static final class Response {
        final int status;
        final String mime;
        final byte[] data;
        final Map<String, String> headers;

        Response(int status, String mime, byte[] data, Map<String, String> headers) {
            this.status = status;
            this.mime = mime == null ? "" : mime;
            this.data = data == null ? new byte[0] : data;
            this.headers = headers == null ? new LinkedHashMap<>() : headers;
        }
    }

    interface Current { boolean isCurrent(RuntimeHostScope expected); }

    interface AssetRead { Response read(String path, int limit) throws Exception; }

    interface GuiReader { CompletableFuture<Response> read(RuntimeHostScope expected, Request request, int limit); }

    interface CaptureProvider { Capture capture(RuntimeHostScope expectedHost) throws Exception; }

    static final class Intent {
        final String owner;
        final RuntimeHostScope expectedHost;
        final String sessionID;
        final String directory;
        final String path;
        final Context context;

        private Intent(String owner, RuntimeHostScope expectedHost, String sessionID, String directory, String path, Context context) {
            this.owner = owner;
            this.expectedHost = expectedHost;
            this.sessionID = sessionID;
            this.directory = directory;
            this.path = path;
            this.context = context;
        }

        static String[] identity(Object input) throws ResourceFailure {
            Map<String, Object> args = ResourceJson.object(input);
            String owner = args == null ? null : ResourceJson.text(args.get("owner"));
            if (owner == null || owner.isEmpty() || ResourceWebPreviewScope.utf8Length(owner) > 128
                    || !owner.matches("^[a-zA-Z0-9_-]+$")) throw ResourceFailure.invalid();
            return new String[] { null, owner };
        }

        static Intent parse(Object input) throws ResourceFailure {
            Map<String, Object> args = ResourceJson.object(input);
            String owner = identity(input)[1];
            Set<String> required = new HashSet<>(Arrays.asList("directory", "path", "expectedHost", "owner"));
            if (args == null || !args.keySet().containsAll(required) || !new HashSet<>(Arrays.asList(
                    "directory", "path", "expectedHost", "owner", "sessionId", "context")).containsAll(args.keySet())) {
                throw ResourceFailure.invalid();
            }
            String directory = ResourceJson.text(args.get("directory"));
            String path = ResourceJson.text(args.get("path"));
            if (directory == null || path == null || !valid(directory) || !valid(path)) throw ResourceFailure.invalid();
            String sessionID = null;
            if (args.containsKey("sessionId")) {
                sessionID = ResourceJson.text(args.get("sessionId"));
                if (sessionID == null || sessionID.isEmpty() || sessionID.length() > 1024 || RuntimeHostText.hasControl(sessionID)) {
                    throw ResourceFailure.invalid();
                }
            }
            RuntimeHostScope expected = ResourceBridge.scope(args.get("expectedHost"));
            Context context = args.containsKey("context") ? Context.parse(args.get("context"), expected) : null;
            return new Intent(owner, expected, sessionID, directory, path, context);
        }

        private static boolean valid(String value) {
            if (value.isEmpty() || ResourceWebPreviewScope.utf8Length(value) > 8192 || RuntimeHostText.hasControl(value)) return false;
            if (!value.matches("(?i)^[a-z][a-z0-9+.-]*:.*")) return true;
            return value.toLowerCase(java.util.Locale.ROOT).startsWith("file:") || value.matches("(?i)^[a-z]:[/\\\\].*");
        }

        Map<String, Object> json() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("directory", directory);
            value.put("path", path);
            value.put("expectedHost", expectedHost.publicValue());
            value.put("owner", owner);
            if (sessionID != null) value.put("sessionId", sessionID);
            return value;
        }
    }

    static final class Labels {
        final String loading, failed, back, close, retry;
        String source, preview;

        Labels(String loading, String failed, String back, String close, String retry, String source, String preview) {
            this.loading = loading;
            this.failed = failed;
            this.back = back;
            this.close = close;
            this.retry = retry;
            this.source = source;
            this.preview = preview;
        }
    }

    static final class Bootstrap {
        final String runtimeKey, locale, mode, themeCSS, preferenceKey;

        Bootstrap(String runtimeKey, String locale, String mode, String themeCSS, String preferenceKey) {
            this.runtimeKey = runtimeKey;
            this.locale = locale;
            this.mode = mode;
            this.themeCSS = themeCSS;
            this.preferenceKey = preferenceKey;
        }

        Map<String, Object> json() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("runtimeKey", runtimeKey);
            value.put("locale", locale);
            value.put("mode", mode);
            value.put("themeCSS", themeCSS);
            value.put("preferenceKey", preferenceKey);
            return value;
        }
    }

    /** Operation-owner data, independently checked against native admission. */
    static final class Context {
        static final List<String> LOCALES = Arrays.asList("en", "zh-CN", "zh-TW", "ja", "ko", "fr", "es", "pl", "pt-BR", "uk");
        static final Set<String> LABEL_KEYS = new HashSet<>(Arrays.asList(
                "loading", "failed", "back", "close", "retry", "source", "preview"));
        final String runtimeKey, preferenceKey, locale, mode, themeCSS;
        final Labels labels;

        private Context(String runtimeKey, String preferenceKey, String locale, String mode, String themeCSS, Labels labels) {
            this.runtimeKey = runtimeKey;
            this.preferenceKey = preferenceKey;
            this.locale = locale;
            this.mode = mode;
            this.themeCSS = themeCSS;
            this.labels = labels;
        }

        static String runtimeKey(String hostID) { return "nsh:" + hostID; }

        static String preferenceKey(String runtimeKey) {
            String identity = Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(runtimeKey.getBytes(StandardCharsets.UTF_8));
            return "yuri.inst." + identity + ".gui-plugins.disabled";
        }

        static Context parse(Object input, RuntimeHostScope expectedHost) throws ResourceFailure {
            Map<String, Object> args = ResourceJson.object(input);
            if (args == null || !args.keySet().equals(new HashSet<>(Arrays.asList(
                    "runtimeKey", "preferenceKey", "locale", "mode", "themeCSS", "labels")))) throw ResourceFailure.invalid();
            String runtimeKey = ResourceJson.text(args.get("runtimeKey"));
            if (runtimeKey == null || !runtimeKey.equals(runtimeKey(expectedHost.hostID))
                    || ResourceWebPreviewScope.utf8Length(runtimeKey) > 2048) throw ResourceFailure.invalid();
            String preferenceKey = ResourceJson.text(args.get("preferenceKey"));
            if (preferenceKey == null || !preferenceKey.equals(preferenceKey(runtimeKey))) throw ResourceFailure.invalid();
            String locale = ResourceJson.text(args.get("locale"));
            if (locale == null || !LOCALES.contains(locale)) throw ResourceFailure.invalid();
            String mode = ResourceJson.text(args.get("mode"));
            if (mode == null || !(mode.equals("light") || mode.equals("dark"))) throw ResourceFailure.invalid();
            String css = ResourceJson.text(args.get("themeCSS"));
            if (css == null || css.trim().isEmpty() || ResourceWebPreviewScope.utf8Length(css) > 512 * 1024
                    || css.indexOf('\0') >= 0 || css.matches("(?is).*</(script|style)\\b.*")) throw ResourceFailure.invalid();
            Map<String, Object> rawLabels = ResourceJson.object(args.get("labels"));
            if (rawLabels == null || !rawLabels.keySet().equals(LABEL_KEYS)) throw ResourceFailure.invalid();
            Map<String, String> values = new LinkedHashMap<>();
            for (String key : LABEL_KEYS) {
                String value = ResourceJson.text(rawLabels.get(key));
                if (value == null || value.trim().isEmpty() || ResourceWebPreviewScope.utf8Length(value) > 2048
                        || RuntimeHostText.hasControl(value)) throw ResourceFailure.invalid();
                values.put(key, value);
            }
            Labels labels = new Labels(values.get("loading"), values.get("failed"), values.get("back"),
                    values.get("close"), values.get("retry"), values.get("source"), values.get("preview"));
            return new Context(runtimeKey, preferenceKey, locale, mode, css, labels);
        }

        Bootstrap bootstrap() { return new Bootstrap(runtimeKey, locale, mode, themeCSS, preferenceKey); }
    }

    /** Native persistent backend for the official synchronous GUI storage API. */
    static final class Storage {
        private final File file;
        private final String preferenceKey;
        private final String runtimeKey;
        private final Map<String, String> values = new LinkedHashMap<>();

        Storage(File directory, String connectionID) throws Exception {
            this(directory, Context.runtimeKey(connectionID), Context.preferenceKey(Context.runtimeKey(connectionID)));
        }

        Storage(File directory, String runtimeKey, String preferenceKey) throws Exception {
            if (!directory.isAbsolute() || runtimeKey.isEmpty() || preferenceKey.isEmpty()) throw ResourceFailure.invalid();
            if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory()) throw ResourceFailure.invalid();
            String name = Base64.getUrlEncoder().withoutPadding().encodeToString(runtimeKey.getBytes(StandardCharsets.UTF_8));
            this.file = new File(directory, name + ".json");
            this.preferenceKey = preferenceKey;
            this.runtimeKey = runtimeKey;
            if (file.exists()) {
                byte[] data = readAll(file, 4 * 1024 * 1024);
                Map<String, Object> stored = ResourceJson.object(ResourceJson.parse(new String(data, StandardCharsets.UTF_8)));
                if (stored == null) throw ResourceFailure.response();
                for (Map.Entry<String, Object> entry : stored.entrySet()) {
                    String value = ResourceJson.text(entry.getValue());
                    if (value == null) throw ResourceFailure.response();
                    values.put(entry.getKey(), value);
                }
            }
        }

        boolean matches(String runtimeKey, String preferenceKey) {
            return this.runtimeKey.equals(runtimeKey) && this.preferenceKey.equals(preferenceKey);
        }

        synchronized Object transact(Object input) throws Exception {
            Map<String, Object> args = ResourceJson.object(input);
            String method = args == null ? null : ResourceJson.text(args.get("method"));
            if (method == null) throw ResourceFailure.invalid();
            if (method.equals("keys")) {
                List<String> keys = new ArrayList<>(values.keySet());
                java.util.Collections.sort(keys);
                return keys;
            }
            if (method.equals("clear")) {
                commit(new LinkedHashMap<>());
                return true;
            }
            String key = ResourceJson.text(args.get("key"));
            if (key == null) throw ResourceFailure.invalid();
            if (!key.equals(preferenceKey)) {
                String prefix = "yuri.gui-plugin.";
                if (!key.startsWith(prefix)) throw ResourceFailure.invalid();
                Object identity = ResourceJson.parse(key.substring(prefix.length()));
                List<Object> parts = ResourceJson.array(identity);
                if (parts == null || parts.isEmpty() || !runtimeKey.equals(ResourceJson.text(parts.get(0)))) {
                    throw ResourceFailure.invalid();
                }
            }
            if (method.equals("get")) return values.containsKey(key) ? values.get(key) : null;
            Map<String, String> next = new LinkedHashMap<>(values);
            if (method.equals("set")) {
                String value = ResourceJson.text(args.get("value"));
                if (value == null) throw ResourceFailure.invalid();
                next.put(key, value);
            } else if (method.equals("remove")) {
                next.remove(key);
            } else {
                throw ResourceFailure.invalid();
            }
            commit(next);
            return true;
        }

        private void commit(Map<String, String> next) throws Exception {
            byte[] bytes = ResourceJson.stringify(next, true).getBytes(StandardCharsets.UTF_8);
            File temporary = new File(file.getParentFile(), file.getName() + ".tmp");
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes);
                output.getFD().sync();
            }
            if (!temporary.renameTo(file)) {
                //noinspection ResultOfMethodCallIgnored
                temporary.delete();
                throw ResourceFailure.response();
            }
            values.clear();
            values.putAll(next);
        }
    }

    /** Immutable, bounded snapshot of explicitly staged application assets. */
    static final class Assets {
        private final Map<String, Response> entries = new LinkedHashMap<>();

        Assets(File stagedDirectory) throws Exception {
            this(stagedDirectory, manifest(stagedDirectory));
        }

        private static Map<String, Object[]> manifest(File stagedDirectory) throws Exception {
            File file = new File(stagedDirectory, "manifest.json");
            byte[] data = readAll(file, 131072);
            Map<String, Object> root = ResourceJson.object(ResourceJson.parse(new String(data, StandardCharsets.UTF_8)));
            if (root == null || !Long.valueOf(1).equals(ResourceJson.integer(root.get("version"), 0, 1))
                    || !GuiPluginPreviewScope.ENTRY.equals(ResourceJson.text(root.get("entry")))) throw ResourceFailure.invalid();
            Map<String, Object> assets = ResourceJson.object(root.get("assets"));
            if (assets == null) throw ResourceFailure.invalid();
            Map<String, Object[]> types = new LinkedHashMap<>();
            for (Map.Entry<String, Object> entry : assets.entrySet()) {
                Map<String, Object> value = ResourceJson.object(entry.getValue());
                String mime = value == null ? null : ResourceJson.text(value.get("mime"));
                if (mime == null) throw ResourceFailure.invalid();
                types.put(entry.getKey(), new Object[] { mime, value.get("bytes"), value.get("sha256") });
            }
            return types;
        }

        Assets(File directory, Map<String, Object[]> manifest) throws Exception {
            String entryMime = manifest.containsKey(GuiPluginPreviewScope.ENTRY)
                    ? (String) manifest.get(GuiPluginPreviewScope.ENTRY)[0] : null;
            if (entryMime == null || !entryMime.split(";", 2)[0].equals("text/html")
                    || manifest.isEmpty() || manifest.size() > 256) throw ResourceFailure.invalid();
            String root = directory.getCanonicalPath();
            long total = 0;
            for (Map.Entry<String, Object[]> entry : manifest.entrySet()) {
                String path = entry.getKey();
                String mime = (String) entry.getValue()[0];
                if (!GuiPluginPreviewScope.assetPath(path) || mime.isEmpty() || mime.indexOf('\r') >= 0 || mime.indexOf('\n') >= 0) {
                    throw ResourceFailure.invalid();
                }
                File file = new File(root, path.substring(1)).getCanonicalFile();
                if (!file.getPath().startsWith(root + File.separator)) throw ResourceFailure.invalid();
                byte[] data = readAll(file, GuiPluginPreviewScope.LIMIT);
                Long declaredBytes = ResourceJson.integer(entry.getValue()[1], 0, Long.MAX_VALUE);
                String declaredSha = ResourceJson.text(entry.getValue()[2]);
                if (declaredBytes != null && declaredBytes != data.length) throw ResourceFailure.response();
                if (declaredSha != null && !declaredSha.equals(ResourceBridge.sha256Hex(data))) throw ResourceFailure.response();
                if (data.length > GuiPluginPreviewScope.LIMIT
                        || data.length > GuiPluginPreviewScope.TOTAL_LIMIT - total) throw ResourceFailure.limit();
                total += data.length;
                entries.put(path, new Response(200, mime, data, new LinkedHashMap<>()));
            }
        }

        Response read(String path, int limit) throws ResourceFailure {
            Response response = entries.get(path);
            if (limit <= 0 || limit > GuiPluginPreviewScope.LIMIT || response == null) throw ResourceFailure.unavailable();
            if (response.data.length > limit) throw ResourceFailure.limit();
            return response;
        }
    }

    /** Exact presentation tickets, including opening and native dismissal. */
    static final class Ownership {
        static final class Ticket {
            final Intent intent;
            final Capture captured;
            boolean closing = false;
            final List<CompletableFuture<Void>> closed = new ArrayList<>();

            Ticket(Intent intent, Capture captured) {
                this.intent = intent;
                this.captured = captured;
            }
        }

        Ticket active;
        private final Map<String, Set<String>> closedOwners = new HashMap<>();
        private final Set<String> overflowScopes = new HashSet<>();

        private static String key(RuntimeHostScope scope) { return scope.hostID + ":" + scope.lease; }

        private synchronized void keepCurrentProof(RuntimeHostScope scope) {
            Set<String> keep = new HashSet<>();
            keep.add(key(scope));
            if (active != null) keep.add(key(active.intent.expectedHost));
            closedOwners.keySet().retainAll(keep);
            overflowScopes.retainAll(keep);
        }

        private synchronized void remember(RuntimeHostScope scope, String owner) {
            String scopeKey = key(scope);
            Set<String> owners = closedOwners.get(scopeKey);
            if (owners != null && owners.contains(owner)) return;
            if (owners != null && owners.size() >= 4096) {
                overflowScopes.add(scopeKey);
                return;
            }
            if (owners == null) {
                owners = new HashSet<>();
                closedOwners.put(scopeKey, owners);
            }
            owners.add(owner);
        }

        synchronized Ticket begin(Object input, CaptureProvider provider, boolean requireContext) throws Exception {
            Intent intent = Intent.parse(input);
            if (requireContext && intent.context == null) throw ResourceFailure.unavailable();
            if (active != null) throw ResourceFailure.busy();
            Capture captured = provider.capture(intent.expectedHost);
            if (!captured.expectedHost.equals(intent.expectedHost) || !captured.isCurrent.isCurrent(intent.expectedHost)
                    || !captured.resource.isCurrent()) throw ResourceFailure.stale();
            if (intent.context != null) captured = captured.applying(intent.context);
            keepCurrentProof(intent.expectedHost);
            Set<String> owners = closedOwners.get(key(intent.expectedHost));
            if (overflowScopes.contains(key(intent.expectedHost)) || owners != null && owners.contains(intent.owner)) {
                throw ResourceFailure.stale();
            }
            Ticket ticket = new Ticket(intent, captured);
            active = ticket;
            return ticket;
        }

        synchronized boolean matches(Ticket ticket) { return active == ticket && !ticket.closing; }

        synchronized boolean startClosing(Ticket ticket) {
            if (!matches(ticket)) return false;
            remember(ticket.intent.expectedHost, ticket.intent.owner);
            ticket.closing = true;
            return true;
        }

        synchronized boolean retire(Ticket ticket) {
            if (active != ticket) return false;
            active = null;
            List<CompletableFuture<Void>> pending = new ArrayList<>(ticket.closed);
            ticket.closed.clear();
            for (CompletableFuture<Void> waiter : pending) waiter.complete(null);
            return true;
        }

        synchronized CompletableFuture<Void> waitClosed(Ticket ticket) {
            if (active != ticket) return CompletableFuture.completedFuture(null);
            CompletableFuture<Void> waiter = new CompletableFuture<>();
            ticket.closed.add(waiter);
            return waiter;
        }

        synchronized Ticket closing(Object input, CaptureProvider provider) throws Exception {
            Map<String, Object> args = ResourceJson.object(input);
            String owner = Intent.identity(input)[1];
            if (args == null || !args.keySet().equals(new HashSet<>(Arrays.asList("expectedHost", "owner")))) {
                throw ResourceFailure.invalid();
            }
            RuntimeHostScope expected = ResourceBridge.scope(args.get("expectedHost"));
            if (active != null && active.intent.expectedHost.equals(expected) && active.intent.owner.equals(owner)) return active;
            Capture captured = provider.capture(expected);
            if (!captured.expectedHost.equals(expected) || !captured.isCurrent.isCurrent(expected) || !captured.resource.isCurrent()) {
                throw ResourceFailure.stale();
            }
            keepCurrentProof(expected);
            remember(expected, owner);
            return null;
        }
    }

    /** What the application supplies: its own trusted content adapter, not a second runtime. */
    static final class Capture {
        final RuntimeHostScope expectedHost;
        final Current isCurrent;
        final ResourceWebPreviewScope.ResourceWebPreviewTransport resource;
        final AssetRead readAsset;
        Labels labels;
        Bootstrap bootstrap;
        Storage storage;
        GuiReader readGui;
        Predicate<String> isHostResourceURL;

        Capture(RuntimeHostScope expectedHost, Current isCurrent,
                ResourceWebPreviewScope.ResourceWebPreviewTransport resource, AssetRead readAsset) {
            this.expectedHost = expectedHost;
            this.isCurrent = isCurrent;
            this.resource = resource;
            this.readAsset = readAsset;
        }

        /** Adds context data only when every identity still matches native admission. */
        Capture applying(Context context) throws ResourceFailure {
            if (!isCurrent.isCurrent(expectedHost) || !resource.isCurrent()
                    || !context.runtimeKey.equals(Context.runtimeKey(expectedHost.hostID))
                    || !context.preferenceKey.equals(Context.preferenceKey(context.runtimeKey))) throw ResourceFailure.stale();
            if (storage == null || !storage.matches(context.runtimeKey, context.preferenceKey)) throw ResourceFailure.unavailable();
            Capture next = new Capture(expectedHost, isCurrent, resource, readAsset);
            next.readGui = readGui;
            next.isHostResourceURL = isHostResourceURL;
            next.storage = storage;
            next.labels = context.labels;
            next.bootstrap = context.bootstrap();
            return next;
        }
    }

    /** App-owned paths enter here once; JS only selects its already admitted Host. */
    static final class Resources {
        private final Assets assets;
        private final File storageDirectory;
        private String selectedHost;
        private Storage selectedStorage;

        Resources(File stagedDirectory, File storageDirectory) throws Exception {
            if (!storageDirectory.isAbsolute()) throw ResourceFailure.invalid();
            this.assets = new Assets(stagedDirectory);
            this.storageDirectory = storageDirectory;
        }

        Capture capture(RuntimeHostScope expectedHost, Current isCurrent,
                ResourceWebPreviewScope.ResourceWebPreviewTransport resource, GuiReader readGui) throws Exception {
            if (!isCurrent.isCurrent(expectedHost) || !resource.isCurrent()) throw ResourceFailure.stale();
            Storage storage;
            if (expectedHost.hostID.equals(selectedHost) && selectedStorage != null) storage = selectedStorage;
            else {
                storage = new Storage(storageDirectory, expectedHost.hostID);
                selectedHost = expectedHost.hostID;
                selectedStorage = storage;
            }
            Capture capture = new Capture(expectedHost, isCurrent, resource,
                    (path, limit) -> {
                        Response stored = assets.read(path, limit);
                        return new Response(stored.status, stored.mime, stored.data, stored.headers);
                    });
            capture.storage = storage;
            capture.readGui = readGui;
            return capture;
        }
    }

    static final class Request {
        final String method;
        final String route;
        final Map<String, String> headers;
        final byte[] body;

        private Request(String method, String route, Map<String, String> headers, byte[] body) {
            this.method = method;
            this.route = route;
            this.headers = headers;
            this.body = body;
        }

        static Request parse(Object input) throws ResourceFailure {
            Map<String, Object> args = ResourceJson.object(input);
            if (args == null || !new HashSet<>(Arrays.asList("method", "route", "headers", "body")).containsAll(args.keySet())) {
                throw ResourceFailure.invalid();
            }
            String method = ResourceJson.text(args.get("method"));
            String route = ResourceJson.text(args.get("route"));
            if (method == null || route == null) throw ResourceFailure.invalid();
            if (ResourceWebPreviewScope.utf8Length(route) > 16384 || !route.startsWith("/api/") || route.startsWith("//")
                    || route.contains("\\") || RuntimeHostText.hasControl(route)) throw ResourceFailure.invalid();
            int hash = route.indexOf('#');
            if (hash >= 0) throw ResourceFailure.invalid();
            String path = route;
            String query = null;
            int question = route.indexOf('?');
            if (question >= 0) {
                path = route.substring(0, question);
                query = route.substring(question + 1);
            }
            String decoded = ResourceWebPreviewScope.percentDecode(path);
            if (decoded == null || decoded.contains("\\") || RuntimeHostText.hasControl(decoded)) throw ResourceFailure.invalid();
            Set<String> reads = new HashSet<>(Arrays.asList(
                    "/api/plugin", "/api/plugin/gui", "/api/fs/stat", "/api/fs/read", "/api/fs/list", "/api/fs/find"));
            boolean read = method.equals("GET") && reads.contains(path);
            boolean rpc = method.equals("POST") && path.matches("^/api/rpc/[^/]+/[^/]+$");
            if (!read && !rpc) throw ResourceFailure.unsupported();
            for (String segment : path.split("/", -1)) {
                String value = ResourceWebPreviewScope.percentDecode(segment);
                if (".".equals(value) || "..".equals(value)) throw ResourceFailure.unsupported();
            }
            Set<String> forbidden = new HashSet<>(Arrays.asList(
                    "authorization", "token", "access_token", "api_key", "apikey", "oc_client_token",
                    "yuri_client_token", "yuri_url_token", "yuri_preview_token"));
            for (ResourceWebPreviewScope.QueryPair pair : ResourceWebPreviewScope.queryPairs(query)) {
                if (forbidden.contains(pair.name.toLowerCase(java.util.Locale.ROOT))) throw ResourceFailure.invalid();
                if (RuntimeHostText.hasControl(pair.value)) throw ResourceFailure.invalid();
            }
            Object rawHeaders = args.get("headers");
            Map<String, String> headers = new LinkedHashMap<>();
            if (rawHeaders != null) {
                Map<String, Object> values = ResourceJson.object(rawHeaders);
                if (values == null) throw ResourceFailure.invalid();
                Set<String> allowed = new HashSet<>(Arrays.asList(
                        "accept", "content-type", "x-opencode-directory", "x-opencode-workspace", "x-yuri-gui-revision"));
                for (Map.Entry<String, Object> entry : values.entrySet()) {
                    String name = entry.getKey().toLowerCase(java.util.Locale.ROOT);
                    String value = ResourceJson.text(entry.getValue());
                    if (!allowed.contains(name) || headers.containsKey(name) || value == null
                            || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0 || value.indexOf('\0') >= 0) {
                        throw ResourceFailure.invalid();
                    }
                    headers.put(name, value);
                }
            }
            byte[] body = null;
            if (args.containsKey("body")) {
                String text = ResourceJson.text(args.get("body"));
                if (read || text == null || ResourceWebPreviewScope.utf8Length(text) > REPLY_LIMIT) throw ResourceFailure.invalid();
                body = text.getBytes(StandardCharsets.UTF_8);
            }
            return new Request(method, route, headers, body);
        }
    }

    /** Captured token-and-transport lease; used by the surface, never by JS. */
    static final class Lease {
        private final ResourceWebPreviewScope.ResourceWebPreviewTransport transport;
        final RuntimeHostScope expectedHost;
        private final Current isCurrent;
        private final GuiReader readGui;
        boolean closed = false;

        Lease(ResourceWebPreviewScope.ResourceWebPreviewTransport transport, RuntimeHostScope expectedHost,
                Current isCurrent, GuiReader readGui) {
            this.transport = transport;
            this.expectedHost = expectedHost;
            this.isCurrent = isCurrent;
            this.readGui = readGui;
        }

        void check() throws ResourceFailure {
            if (closed || !isCurrent.isCurrent(expectedHost) || !transport.isCurrent()) throw ResourceFailure.stale();
        }

        Response read(Object input) throws Exception {
            check();
            Request request = Request.parse(input);
            Response result;
            String requestPath = request.route.split("\\?", 2)[0];
            if (request.method.equals("GET") && requestPath.equals("/api/fs/stat") && request.headers.isEmpty()) {
                ResourceWebPreviewScope.ResourceWebPreviewResponse response = ResourceWebPreviewScope.checked(
                        transport.readFile.read(request.route, GuiPluginPreviewScope.LIMIT)).get();
                result = new Response(response.status, response.mime, response.data, null);
            } else {
                if (readGui == null) throw ResourceFailure.unsupported();
                result = ResourceWebPreviewScope.checked(readGui.read(expectedHost, request, REPLY_LIMIT)).get();
            }
            check();
            if (result.status < 200 || result.status > 599 || result.status >= 300 && result.status < 400
                    || result.data.length > REPLY_LIMIT || result.mime.indexOf('\r') >= 0 || result.mime.indexOf('\n') >= 0) {
                throw ResourceFailure.response();
            }
            return new Response(result.status, result.mime, result.data, GuiPluginRuntime.checkedHeaders(result.headers));
        }

        void close() { closed = true; }
    }

    /** Gate that keeps the native file surface usable until the registry reports. */
    static final class Match {
        private CompletableFuture<Boolean> gate;
        private Boolean result;
        private Throwable terminal;

        CompletableFuture<Boolean> waitFor() {
            synchronized (this) {
                if (result != null) return CompletableFuture.completedFuture(result);
                if (terminal != null) return ResourceWebPreviewScope.failedFuture(terminal);
                if (gate != null) return ResourceWebPreviewScope.failedFuture(ResourceFailure.busy());
                gate = new CompletableFuture<>();
                return gate;
            }
        }

        void finish(Boolean matched) {
            CompletableFuture<Boolean> waiting;
            synchronized (this) {
                if (result != null) return;
                result = matched;
                waiting = gate;
                gate = null;
            }
            if (waiting != null) waiting.complete(matched);
        }

        void fail(Throwable error) {
            CompletableFuture<Boolean> waiting;
            synchronized (this) {
                if (result != null) return;
                terminal = terminal == null ? error : terminal;
                waiting = gate;
                gate = null;
            }
            if (waiting != null) waiting.completeExceptionally(error);
        }
    }

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newFixedThreadPool(3, runnable -> {
        Thread thread = new Thread(runnable, "yuri-gui-preview");
        thread.setDaemon(true);
        return thread;
    });
    private final Ownership ownership = new Ownership();
    private CaptureProvider provider = expectedHost -> {
        throw ResourceFailure.unavailable();
    };
    private CompletableFuture<Object> completion;
    private Dialog dialog;
    private Surface surface;

    public GuiPluginPreviewBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    /** MainActivity installs the same Runtime capture the other bridges use. */
    public void setCaptureProvider(CaptureProvider provider) { this.provider = provider; }

    public void install() {
        view.handle("plugins.preview.present", (data, reply) -> present(data, reply));
        view.handle("plugins.preview.close", (data, reply) -> {
            CompletableFuture<Void> closed;
            try {
                closed = close(data);
            } catch (Exception failure) {
                reply.reject(ResourceBridge.messageOf(failure));
                return;
            }
            closed.whenComplete((value, error) -> {
                if (error == null) reply.resolve(true);
                else reply.reject(ResourceBridge.messageOf(error));
            });
        });
    }

    public void invalidate() {
        Ownership.Ticket ticket = ownership.active;
        if (ticket != null) terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("stale")));
        executor.shutdownNow();
    }

    void setForeground(boolean foreground) {
        if (!foreground && ownership.active != null) {
            terminate(ownership.active, ResourceWebPreviewScope.unchecked(new ResourceFailure("stale")));
        }
    }

    private void present(Object data, NshHostReply reply) {
        Ownership.Ticket ticket;
        try {
            if (activity.isFinishing() || activity.isDestroyed()) throw ResourceFailure.stale();
            ticket = ownership.begin(data, provider, true);
        } catch (Exception failure) {
            reply.reject(ResourceBridge.messageOf(failure));
            return;
        }
        CompletableFuture.runAsync(() -> {
            try {
                Object result = prepareAndPresent(ticket);
                reply.resolve(result);
            } catch (Exception failure) {
                if (ownership.matches(ticket)) terminate(ticket, failure);
                reply.reject(ResourceBridge.messageOf(failure));
            }
        }, executor);
    }

    private Object prepareAndPresent(Ownership.Ticket ticket) throws Exception {
        if (!ownership.matches(ticket)) throw ResourceFailure.busy();
        Capture captured = ticket.captured;
        if (captured.readGui == null) throw ResourceFailure.unsupported();
        if (captured.bootstrap == null || captured.storage == null || captured.labels == null
                || captured.labels.source == null || captured.labels.preview == null) throw ResourceFailure.unavailable();
        final Intent intent = ticket.intent;
        Lease lease = new Lease(captured.resource, intent.expectedHost, captured.isCurrent, captured.readGui);
        Current current = expected -> ownership.matches(ticket) && captured.isCurrent.isCurrent(intent.expectedHost)
                && captured.resource.isCurrent() && !activity.isFinishing();
        lease.check();
        Response entry = captured.readAsset.read(ENTRY, GuiPluginPreviewScope.LIMIT);
        if (!current.isCurrent(intent.expectedHost)) throw ResourceFailure.stale();
        ResourceWebPreviewScope.ResourceWebPreviewResponse document =
                new ResourceWebPreviewScope.ResourceWebPreviewResponse(entry.status, entry.mime, entry.data);
        ResourceWebPreviewScope.validate(document, true);
        Surface created = new Surface(intent, captured, captured.labels, lease, entry, current);
        CompletableFuture<Boolean> matchedFuture = created.prepare();
        CompletableFuture<Object> pending = new CompletableFuture<>();
        main.post(() -> {
            if (!ownership.matches(ticket) || completion != null) {
                pending.completeExceptionally(ResourceFailure.busy());
                return;
            }
            completion = pending;
            surface = created;
            Dialog sheet = new Dialog(activity, android.R.style.Theme_Material_NoActionBar_Fullscreen);
            LinearLayout column = new LinearLayout(activity);
            column.setOrientation(LinearLayout.VERTICAL);
            column.addView(created, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
            sheet.setContentView(column);
            sheet.setOnCancelListener(ignored -> terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled"))));
            created.onClose = () -> terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled")));
            dialog = sheet;
            sheet.show();
        });
        Boolean matched;
        try {
            // The bundle reports `mounted`/`unmatched`; a blank modal is never left open.
            matched = matchedFuture.get(120, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception failure) {
            terminate(ticket, ResourceWebPreviewScope.asException(failure));
            throw ResourceWebPreviewScope.asException(failure);
        }
        if (!Boolean.TRUE.equals(matched)) {
            terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled")));
            return closedResult(false);
        }
        if (!current.isCurrent(intent.expectedHost)) {
            terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("stale")));
            throw ResourceFailure.stale();
        }
        try {
            pending.get();
        } catch (java.util.concurrent.ExecutionException failure) {
            Throwable cause = ResourceWebPreviewScope.unwrap(failure);
            // A native close/back/cancel is a normal closed result, not a host failure.
            if (cause instanceof ResourceFailure && ((ResourceFailure) cause).code.equals("cancelled")) return closedResult(true);
            if (cause instanceof ResourceFailure) throw (ResourceFailure) cause;
            throw ResourceWebPreviewScope.asException(cause);
        }
        return closedResult(true);
    }

    private static Map<String, Object> closedResult(boolean matched) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("closed", true);
        value.put("matched", matched);
        return value;
    }

    private CompletableFuture<Void> close(Object data) throws Exception {
        Ownership.Ticket ticket = ownership.closing(data, provider);
        if (ticket == null) return CompletableFuture.completedFuture(null);
        terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled")));
        return ownership.waitClosed(ticket);
    }

    private void terminate(Ownership.Ticket ticket, Throwable failure) {
        if (!ownership.startClosing(ticket)) return;
        Surface closingSurface = surface;
        surface = null;
        Dialog closingDialog = dialog;
        dialog = null;
        CompletableFuture<Object> pending = completion;
        completion = null;
        if (closingSurface != null) closingSurface.stop();
        if (closingDialog != null) closingDialog.dismiss();
        ownership.retire(ticket);
        if (pending != null) pending.completeExceptionally(failure);
    }

    // ------------------------------------------------------------------ surface

    /** The isolated plugin document: one WebView, one shim, no application bridge. */
    private final class Surface extends FrameLayout {
        private final Capture captured;
        private final Labels labels;
        private final Lease lease;
        private final Response initial;
        private final Current current;
        private final Intent intent;
        private final Match match = new Match();
        private final ProgressBar spinner;
        private final TextView failureLabel;
        private final Button retry;
        private final LinearLayout status;
        private WebView web;
        private String owner = UUID.randomUUID().toString().toLowerCase(java.util.Locale.ROOT);
        private GuiPluginResourceResolver resolver;
        private GuiPluginDeviceBridge device;
        private int bytes = 0;
        private int requests = 0;
        private boolean stopped = false;
        private final Map<String, GuiPluginRuntime.StreamLease> streams = new HashMap<>();
        Runnable onClose;

        Surface(Intent intent, Capture captured, Labels labels, Lease lease, Response initial, Current current) {
            super(activity);
            this.intent = intent;
            this.captured = captured;
            this.labels = labels;
            this.lease = lease;
            this.initial = initial;
            this.current = current;
            setBackgroundColor(0xff111111);
            status = new LinearLayout(getContext());
            status.setOrientation(LinearLayout.VERTICAL);
            status.setGravity(Gravity.CENTER);
            spinner = new ProgressBar(getContext());
            failureLabel = new TextView(getContext());
            failureLabel.setText(labels.failed);
            failureLabel.setTextColor(0xffffffff);
            retry = new Button(getContext());
            retry.setText(labels.retry);
            status.addView(spinner);
            status.addView(failureLabel);
            status.addView(retry);
            LayoutParams params = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            params.gravity = Gravity.CENTER;
            addView(status, params);
            retry.setOnClickListener(ignored -> reload());
        }

        CompletableFuture<Boolean> prepare() {
            reload();
            return match.waitFor();
        }

        private void reload() {
            if (stopped || !current.isCurrent(intent.expectedHost)) {
                match.fail(ResourceFailure.stale());
                return;
            }
            cancelAll();
            bytes = 0;
            requests = 0;
            owner = UUID.randomUUID().toString().toLowerCase(java.util.Locale.ROOT);
            status.setVisibility(android.view.View.VISIBLE);
            spinner.setVisibility(android.view.View.VISIBLE);
            failureLabel.setVisibility(android.view.View.GONE);
            WebView created = new WebView(getContext());
            WebSettings settings = created.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(false);
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            settings.setSupportMultipleWindows(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setMediaPlaybackRequiresUserGesture(true);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            created.addJavascriptInterface(new Channel(this), "yuriGuiPreview");
            created.setWebChromeClient(new WebChromeClient() {
                @Override public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
                    result.confirm(prompt(view, url, message, defaultValue));
                    return true;
                }

                @Override public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                    result.cancel();
                    return true;
                }
            });
            created.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return !permittedNavigation(request.getUrl().toString());
                }

                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    return intercept(request);
                }

                @Override public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                    if (request.isForMainFrame()) failed();
                }

                @Override public void onPageFinished(WebView view, String url) {
                    // The bundle reports its own state; a plain finish keeps the spinner.
                }
            });
            web = created;
            addView(created, 0, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            status.bringToFront();
            String html = new String(initial.data, StandardCharsets.UTF_8);
            created.loadDataWithBaseURL(GuiPluginPreviewScope.ORIGIN + "/" + owner + ENTRY, shim() + html,
                    "text/html", "utf-8", null);
        }

        private boolean permittedNavigation(String url) {
            if (stopped || !current.isCurrent(intent.expectedHost)) return false;
            if (url.equals("about:blank") || url.startsWith("about:srcdoc") || url.startsWith("blob:")) return true;
            String entry = GuiPluginPreviewScope.ORIGIN + "/" + owner + ENTRY;
            if (url.equals(entry)) return true;
            String prefix = GuiPluginPreviewScope.ORIGIN + "/" + owner;
            if (!url.startsWith(prefix)) return false;
            String path = url.substring(prefix.length());
            return path.startsWith("/__gui/") || path.startsWith("/api/preview/proxy/");
        }

        private WebResourceResponse intercept(WebResourceRequest request) {
            if (stopped || !current.isCurrent(intent.expectedHost)) return refused("invalid");
            if (!"GET".equals(request.getMethod())) return refused("invalid");
            if (requests >= 256) return refused("limit");
            String url = request.getUrl().toString();
            String prefix = GuiPluginPreviewScope.ORIGIN + "/" + owner;
            if (!url.startsWith(prefix)) return refused("invalid");
            String path = url.substring(prefix.length());
            int queryAt = path.indexOf('?');
            String route = queryAt >= 0 ? path.substring(0, queryAt) : path;
            requests += 1;
            try {
                Response response;
                boolean document = route.equals(ENTRY);
                if (document) response = initial;
                else if (route.startsWith("/assets/") || route.equals(ENTRY)) response = captured.readAsset.read(route, GuiPluginPreviewScope.LIMIT);
                else {
                    synchronized (this) {
                        if (resolver == null) {
                            resolver = new GuiPluginResourceResolver(intent.directory, captured.resource, captured.isHostResourceURL);
                        }
                    }
                    ResourceWebPreviewScope.ResourceWebPreviewResponse resolved = ResourceWebPreviewScope.checked(resolver.read(
                            GuiPluginPreviewScope.SCHEME + "://" + owner + path, owner)).get();
                    response = new Response(resolved.status, resolved.mime, resolved.data, null);
                }
                if (!current.isCurrent(intent.expectedHost) || stopped) return refused("stale");
                ResourceWebPreviewScope.validate(
                        new ResourceWebPreviewScope.ResourceWebPreviewResponse(response.status, response.mime, response.data), document);
                if (response.data.length > GuiPluginPreviewScope.TOTAL_LIMIT - bytes) return refused("limit");
                bytes += response.data.length;
                Map<String, String> headers = GuiPluginPreviewScope.responseHeaders(response, document);
                byte[] data = document ? (shim() + new String(response.data, StandardCharsets.UTF_8)).getBytes(StandardCharsets.UTF_8) : response.data;
                return new WebResourceResponse(response.mime, null, response.status, "OK", headers, new ByteArrayInputStream(data));
            } catch (Exception failure) {
                if (route.equals(ENTRY)) failed();
                return refused("response");
            }
        }

        private WebResourceResponse refused(String code) {
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("Content-Security-Policy", GuiPluginPreviewScope.POLICY);
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", headers, new ByteArrayInputStream(new byte[0]));
        }

        private String shim() {
            return "<script>(function(){var serial=0,pending={};"
                    + "window.__yuriGuiReply=function(id,ok,json,error){var entry=pending[id];if(!entry)return;delete pending[id];"
                    + "var value=json===null||json===undefined?null:JSON.parse(json);"
                    + "if(ok)entry.resolve(value);else entry.reject(new Error(error||'GUI_PLUGIN_FAILED'));};"
                    + "window.webkit=window.webkit||{};window.webkit.messageHandlers=window.webkit.messageHandlers||{};"
                    + "if(!window.webkit.messageHandlers.guiPluginPreview){window.webkit.messageHandlers.guiPluginPreview={"
                    + "postMessage:function(body){return new Promise(function(resolve,reject){"
                    + "var id=String(++serial);pending[id]={resolve:resolve,reject:reject};"
                    + "try{window.yuriGuiPreview.send(JSON.stringify(body===undefined?null:body),id);}"
                    + "catch(error){delete pending[id];reject(error);}});}};}})();</script>";
        }

        String prompt(WebView view, String url, String message, String defaultValue) {
            if (!(message.equals("yuri.gui.storage.v1") || message.equals("yuri.gui.device.v1"))) return null;
            if (stopped || !current.isCurrent(intent.expectedHost) || view != web || defaultValue == null) return null;
            Map<String, Object> request = ResourceJson.object(ResourceJson.parse(defaultValue));
            if (request == null) return null;
            try {
                RuntimeHostScope expected = ResourceBridge.scope(request.get("expectedHost"));
                if (!expected.equals(lease.expectedHost)) throw ResourceFailure.stale();
                lease.check();
                if (message.equals("yuri.gui.device.v1")) {
                    if (!request.keySet().equals(new HashSet<>(Arrays.asList("expectedHost", "method", "input")))) {
                        throw new ResourceFailure(GuiPluginDeviceBridge.INVALID);
                    }
                    String method = ResourceJson.text(request.get("method"));
                    Map<String, Object> payload = ResourceJson.object(request.get("input"));
                    if (method == null || payload == null) throw new ResourceFailure(GuiPluginDeviceBridge.INVALID);
                    try {
                        Object value = device().synchronous(method, payload);
                        return ResourceJson.stringify(GuiPluginDeviceBridge.reply(true, value, null), false);
                    } catch (ResourceFailure failure) {
                        return ResourceJson.stringify(GuiPluginDeviceBridge.reply(false, null, failure.code), false);
                    }
                }
                Map<String, Object> operation = ResourceJson.object(request.get("operation"));
                Object value = captured.storage.transact(operation);
                Map<String, Object> reply = new LinkedHashMap<>();
                reply.put("ok", true);
                reply.put("value", value);
                return ResourceJson.stringify(reply, false);
            } catch (Exception failure) {
                return "{\"ok\":false}";
            }
        }

        private synchronized GuiPluginDeviceBridge device() {
            if (device == null) {
                device = new GuiPluginDeviceBridge(activity, () -> !stopped && current.isCurrent(intent.expectedHost),
                        event -> handleProgress(event));
            }
            return device;
        }

        private void handleProgress(Map<String, Object> event) {
            WebView target = web;
            if (target == null || stopped) return;
            target.evaluateJavascript("window.dispatchEvent(new CustomEvent('yuri.gui.device.progress',"
                    + "{detail:" + ResourceJson.stringify(event, false) + "}))", null);
        }

        /** One main-frame message: same names, payloads and bounds as the iOS channel. */
        void receive(String body, String id) {
            if (stopped || !current.isCurrent(intent.expectedHost)) {
                reply(id, false, "stale");
                return;
            }
            Map<String, Object> args = ResourceJson.object(ResourceJson.parse(body));
            if (args == null) {
                reply(id, false, "stale");
                return;
            }
            String name = ResourceJson.text(args.get("name"));
            if (name == null) {
                reply(id, false, "stale");
                return;
            }
            if (name.equals("intent")) {
                reply(id, true, intent.json());
                return;
            }
            if (name.equals("bootstrap")) {
                if (captured.bootstrap == null || captured.storage == null || captured.bootstrap.runtimeKey.isEmpty()
                        || !(captured.bootstrap.mode.equals("light") || captured.bootstrap.mode.equals("dark"))
                        || captured.bootstrap.locale.isEmpty() || captured.bootstrap.themeCSS.isEmpty()
                        || labels.source == null || labels.preview == null) {
                    reply(id, false, "unavailable");
                    return;
                }
                Map<String, Object> value = captured.bootstrap.json();
                value.put("intent", intent.json());
                Map<String, Object> labelsValue = new LinkedHashMap<>();
                labelsValue.put("loading", labels.loading);
                labelsValue.put("failed", labels.failed);
                labelsValue.put("retry", labels.retry);
                labelsValue.put("source", labels.source);
                labelsValue.put("preview", labels.preview);
                value.put("labels", labelsValue);
                reply(id, true, value);
                return;
            }
            RuntimeHostScope expected;
            try {
                expected = ResourceBridge.scope(args.get("expectedHost"));
            } catch (ResourceFailure failure) {
                reply(id, false, "stale");
                return;
            }
            if (!expected.equals(lease.expectedHost)) {
                reply(id, false, "stale");
                return;
            }
            if (name.equals("state")) {
                String phase = ResourceJson.text(args.get("phase"));
                if (phase == null || !Arrays.asList("loading", "mounted", "source", "unmatched", "error", "closed").contains(phase)) {
                    reply(id, false, "invalid");
                    return;
                }
                if (phase.equals("mounted")) {
                    match.finish(true);
                    spinner.setVisibility(android.view.View.GONE);
                } else if (phase.equals("unmatched")) {
                    match.finish(false);
                    failed();
                } else if (phase.equals("closed")) {
                    match.fail(ResourceFailure.stale());
                } else if (phase.equals("error")) {
                    failed();
                }
                reply(id, true, true);
                return;
            }
            if (name.equals("cancel")) {
                String requestID = ResourceJson.text(args.get("id"));
                if (requestID == null) {
                    reply(id, false, "invalid");
                    return;
                }
                synchronized (this) {
                    GuiPluginRuntime.StreamLease stream = streams.remove(requestID);
                    if (stream != null) stream.stop();
                }
                reply(id, true, true);
                return;
            }
            if (name.equals("device")) {
                if (!args.keySet().equals(new HashSet<>(Arrays.asList("name", "expectedHost", "method", "input")))) {
                    reply(id, false, "invalid");
                    return;
                }
                String method = ResourceJson.text(args.get("method"));
                Map<String, Object> payload = ResourceJson.object(args.get("input"));
                if (method == null || payload == null) {
                    reply(id, false, "invalid");
                    return;
                }
                try {
                    lease.check();
                    reply(id, true, device().request(method, payload));
                } catch (ResourceFailure failure) {
                    reply(id, false, failure.code);
                } catch (Exception failure) {
                    reply(id, false, "GUI_PLUGIN_FAILED");
                }
                return;
            }
            if (name.equals("chunk")) {
                // The lossless pull lane is not wired on Android; never fake a chunk.
                reply(id, false, "unsupported");
                return;
            }
            if (!name.equals("request")) {
                reply(id, false, "unsupported");
                return;
            }
            try {
                lease.check();
                Response result = lease.read(args.get("input"));
                Map<String, Object> value = new LinkedHashMap<>();
                value.put("status", result.status);
                value.put("mime", result.mime);
                value.put("headers", result.headers);
                value.put("base64", Base64.getEncoder().encodeToString(result.data));
                reply(id, true, value);
            } catch (Exception failure) {
                reply(id, false, "response");
            }
        }

        private void reply(String id, boolean ok, Object value) {
            main.post(() -> {
                WebView target = web;
                if (target == null || stopped) return;
                String script = "window.__yuriGuiReply(" + ResourceJson.stringify(id, false) + ","
                        + (ok ? "true" : "false") + ","
                        + ResourceJson.stringify(ok ? value : null, false) + ","
                        + ResourceJson.stringify(ok ? null : String.valueOf(value), false) + ")";
                target.evaluateJavascript(script, null);
            });
        }

        private void failed() {
            match.fail(ResourceFailure.response());
            spinner.setVisibility(android.view.View.GONE);
            failureLabel.setVisibility(android.view.View.VISIBLE);
            retry.setVisibility(android.view.View.VISIBLE);
        }

        synchronized void cancelAll() {
            if (resolver != null) {
                resolver.stop();
                resolver = null;
            }
            if (device != null) {
                device.stop();
                device = null;
            }
            for (GuiPluginRuntime.StreamLease stream : streams.values()) stream.stop();
            streams.clear();
        }

        void stop() {
            if (stopped) return;
            stopped = true;
            lease.close();
            cancelAll();
            match.fail(ResourceFailure.stale());
            WebView closing = web;
            web = null;
            if (closing != null) {
                closing.removeJavascriptInterface("yuriGuiPreview");
                closing.stopLoading();
                closing.setWebViewClient(new WebViewClient());
                closing.setWebChromeClient(null);
                removeView(closing);
                closing.destroy();
            }
        }
    }

    /** The only object JS can reach; it never exposes Host bytes or credentials. */
    public final class Channel {
        private final Surface surface;

        Channel(Surface surface) { this.surface = surface; }

        @JavascriptInterface
        public void send(String body, String id) {
            CompletableFuture.runAsync(() -> surface.receive(body, id), executor);
        }
    }

    static byte[] readAll(File file, int limit) throws Exception {
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] data = new byte[limit + 1];
            int total = 0;
            while (total < data.length) {
                int count = input.read(data, total, data.length - total);
                if (count < 0) break;
                total += count;
            }
            if (total > limit) throw ResourceFailure.limit();
            byte[] result = new byte[total];
            System.arraycopy(data, 0, result, 0, total);
            return result;
        }
    }
}

