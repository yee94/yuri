package com.yee94.yuri.nsh;

import android.content.Context;
import android.graphics.Color;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Port of iOS `ResourceWebPreviewView` (`ResourceHTMLContentView` +
 * `ResourceWebPreviewMountView`) on top of `android.webkit.WebView`.
 *
 * WKURLSchemeHandler has no Android counterpart. The entry document is loaded
 * with `loadDataWithBaseURL` against a fixed in-app https origin, and every
 * document/subresource request is served from, or rejected by,
 * `shouldInterceptRequest` under the same owner, GET, limit, MIME and total-byte
 * rules as iOS. No request reaches the network: anything outside the captured
 * scope gets an empty 403. No JavaScript bridge object is added.
 */
final class ResourceWebPreviewView extends FrameLayout {
    static final String ORIGIN = "https://yuri-resource.invalid";

    /** Everything the scope admitted before the document was created. */
    static final class Prepared {
        final ResourceWebPreviewScope scope;
        final String owner;
        final String entryPath;
        final ResourceWebPreviewScope.ResourceWebPreviewResponse initial;
        final Current current;
        final Read read;
        final Diagnostic diagnostic;

        Prepared(ResourceWebPreviewScope scope, String owner, String entryPath,
                ResourceWebPreviewScope.ResourceWebPreviewResponse initial,
                Current current, Read read, Diagnostic diagnostic) {
            this.scope = scope;
            this.owner = owner;
            this.entryPath = entryPath;
            this.initial = initial;
            this.current = current;
            this.read = read;
            this.diagnostic = diagnostic;
        }
    }

    interface Current { boolean current(); }

    interface Read { ResourceWebPreviewScope.ResourceWebPreviewResponse read(String route, int limit) throws Exception; }

    interface Diagnostic { void report(String stage, String domain, Integer code); }

    private final Prepared prepared;
    private ResourceWebPreviewScope.ResourceWebPreviewResponse initial;
    private WebView web;
    private int bytes = 0;
    private int requests = 0;
    private int pending = 0;
    private boolean stopped = false;
    Runnable onFailure;
    Runnable onLoaded;

    ResourceWebPreviewView(Context context, Prepared prepared) {
        super(context);
        this.prepared = prepared;
        this.initial = prepared.initial;
        WebView created = new WebView(context);
        WebSettings settings = created.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setDomStorageEnabled(false);
        settings.setDatabaseEnabled(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        created.setBackgroundColor(Color.WHITE);
        created.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                boolean permitted = !stopped && prepared.current.current() && "GET".equals(request.getMethod())
                        && logicalRoute(request.getUrl().toString()) != null;
                prepared.diagnostic.report("navigation.policy", permitted ? null : "invalid", permitted ? null : 0);
                return !permitted;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return intercept(request);
            }

            @Override public void onPageFinished(WebView view, String url) {
                if (!stopped && prepared.current.current() && onLoaded != null) onLoaded.run();
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) fail("navigation.provisional", "OtherErrorDomain", error.getErrorCode());
            }
        });
        web = created;
        addView(created, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        String html = new String(prepared.initial.data, StandardCharsets.UTF_8);
        // Base URL keeps relative subresources inside the captured owner and entry directory.
        created.loadDataWithBaseURL(ORIGIN + "/" + prepared.owner + basePath(prepared.entryPath), html, "text/html", "utf-8", null);
    }

    private static String basePath(String entryPath) {
        int stop = entryPath.length();
        for (int index = 0; index < entryPath.length(); index++) {
            char character = entryPath.charAt(index);
            if (character == '?' || character == '#') { stop = index; break; }
        }
        return entryPath.substring(0, stop);
    }

    private String logicalRoute(String url) {
        String prefix = ORIGIN + "/" + prepared.owner;
        if (!url.startsWith(prefix)) return null;
        String rest = url.substring(ORIGIN.length());
        if (!rest.startsWith("/" + prepared.owner + "/")) return null;
        String pathAndQuery = rest.substring(("/" + prepared.owner).length());
        try {
            return prepared.scope.route(ResourceWebPreviewScope.SCHEME + "://" + prepared.owner + pathAndQuery, prepared.owner);
        } catch (ResourceFailure failure) {
            return null;
        }
    }

    private WebResourceResponse intercept(WebResourceRequest request) {
        if (stopped || !prepared.current.current()) return reject("scheme.admission", "invalid");
        if (!"GET".equals(request.getMethod())) return reject("scheme.admission", "invalid");
        if (pending >= 8 || requests >= 256) return reject("scheme.admission", "invalid");
        String url = request.getUrl().toString();
        String route = logicalRoute(url);
        if (route == null) return reject("scheme.admission", "invalid");
        requests += 1;
        pending += 1;
        try {
            String entryRoute = prepared.scope.route(
                    ResourceWebPreviewScope.SCHEME + "://" + prepared.owner + prepared.entryPath, prepared.owner);
            ResourceWebPreviewScope.ResourceWebPreviewResponse response;
            boolean document = route.equals(entryRoute);
            if (document && initial != null) {
                response = initial;
                initial = null;
            } else {
                int limit = Math.min(ResourceWebPreviewScope.RESPONSE_LIMIT, ResourceWebPreviewScope.TOTAL_LIMIT - bytes);
                if (limit <= 0) return reject("subresource.read", "limit");
                prepared.diagnostic.report("subresource.read", null, null);
                response = prepared.read.read(route, limit);
            }
            if (!prepared.current.current() || stopped) return reject("response.validate", "stale");
            prepared.diagnostic.report("response.validate", null, null);
            ResourceWebPreviewScope.validate(response, document);
            if (response.data.length > ResourceWebPreviewScope.TOTAL_LIMIT - bytes) {
                return reject("response.validate", "limit");
            }
            bytes += response.data.length;
            prepared.diagnostic.report("response.deliver", null, null);
            Map<String, String> headers = response.webHeaders();
            WebResourceResponse result = new WebResourceResponse(
                    response.mime.isEmpty() ? "application/octet-stream" : response.mime,
                    null, response.status, "OK", headers, new ByteArrayInputStream(response.data));
            return result;
        } catch (Exception failure) {
            prepared.diagnostic.report("response.validate", domainOf(failure), 0);
            fail("response.validate", domainOf(failure), 0);
            return reject("response.construct", "response");
        } finally {
            pending -= 1;
        }
    }

    private WebResourceResponse reject(String stage, String code) {
        prepared.diagnostic.report(stage, code, 0);
        Map<String, String> headers = new java.util.LinkedHashMap<>();
        headers.put("Content-Security-Policy", ResourceWebPreviewScope.POLICY);
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", headers,
                new ByteArrayInputStream(new byte[0]));
    }

    private static String domainOf(Throwable error) {
        Throwable unwrapped = ResourceWebPreviewScope.unwrap(error);
        if (unwrapped instanceof ResourceFailure) return "ResourceWebPreviewFailure";
        if (unwrapped instanceof ExecutionException || unwrapped instanceof TimeoutException) return "CancellationError";
        return "OtherErrorDomain";
    }

    private void fail(String stage, String domain, int code) {
        if (stopped) return;
        prepared.diagnostic.report(stage, domain, code);
        if (onFailure != null) onFailure.run();
    }

    /** Reads one route synchronously: called on the WebView's request thread. */
    static ResourceWebPreviewScope.ResourceWebPreviewResponse await(
            java.util.concurrent.CompletableFuture<ResourceWebPreviewScope.ResourceWebPreviewResponse> future)
            throws Exception {
        try {
            return future.get(120, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw ResourceFailure.stale();
        } catch (ExecutionException failure) {
            throw ResourceWebPreviewScope.asException(failure);
        }
    }

    boolean canGoBack() { return web != null && web.canGoBack(); }

    void goBack() { if (web != null) web.goBack(); }

    void stop() {
        if (stopped) return;
        stopped = true;
        initial = null;
        if (web != null) {
            WebView closing = web;
            web = null;
            closing.stopLoading();
            closing.setWebViewClient(new WebViewClient());
            removeView(closing);
            closing.destroy();
        }
    }

    /** Inline mount carrier: owns one document and the loading indicator. */
    static final class Mount extends FrameLayout {
        interface Failure { void failed(String owner); }

        private final ResourceWebPreviewBridge bridge;
        private final Failure failure;
        private final Covered covered;
        private final ProgressBar loading;
        private Map<String, Object> config;
        private String owner;
        private String presentationOwner;
        private boolean started = false;
        private boolean retired = false;
        private ResourceWebPreviewView content;

        Mount(Context context, ResourceWebPreviewBridge bridge, Failure failure, Covered covered) {
            super(context);
            this.bridge = bridge;
            this.failure = failure;
            this.covered = covered;
            loading = new ProgressBar(context);
            LayoutParams params = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            params.gravity = Gravity.CENTER;
            addView(loading, params);
        }

        interface Covered { boolean coveredByOwnPresentation(String presentationOwner); }

        void update(Object value) {
            if (retired || started || config != null) return;
            Map<String, Object> args = ResourceJson.object(value);
            if (args == null) return;
            String nextOwner = ResourceJson.text(args.get("owner"));
            if (nextOwner == null) return;
            presentationOwner = ResourceJson.text(args.remove("presentationOwner"));
            config = args;
            owner = nextOwner;
            begin();
        }

        @Override protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            begin();
        }

        @Override protected void onDetachedFromWindow() {
            if (started && !covered.coveredByOwnPresentation(presentationOwner) && owner != null) {
                retired = true;
                bridge.detach(owner);
            }
            super.onDetachedFromWindow();
        }

        private void begin() {
            if (retired || started || config == null || owner == null || getWindowToken() == null) return;
            started = true;
            loading.setVisibility(android.view.View.VISIBLE);
            try {
                bridge.mount(config, this);
            } catch (Exception failure) {
                retired = true;
                loading.setVisibility(android.view.View.GONE);
                this.failure.failed(owner);
            }
        }

        void adopt(ResourceWebPreviewView view, String adoptedOwner) {
            if (retired || !adoptedOwner.equals(owner)) {
                view.stop();
                return;
            }
            content = view;
            addView(view, 0, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            view.onLoaded = () -> loading.setVisibility(android.view.View.GONE);
        }

        void failed(String failedOwner) {
            if (failedOwner.equals(owner)) {
                loading.setVisibility(android.view.View.GONE);
                failure.failed(failedOwner);
            }
        }

        void stop(String stoppedOwner) {
            if (!stoppedOwner.equals(owner)) return;
            retired = true;
            loading.setVisibility(android.view.View.GONE);
            if (content != null) {
                content.stop();
                removeView(content);
                content = null;
            }
            config = null;
        }
    }
}
