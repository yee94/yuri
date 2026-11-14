package com.yee94.yuri.nsh;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.File;
import java.io.FileOutputStream;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Port of iOS `YuriViewExportRenderer`: static, self-contained HTML snapshot for
 * the plugin `exportLongImage` boundary.
 *
 * Android has no `WKPDFConfiguration`/`createPDF`, so PDF export is not offered:
 * `GuiPluginDeviceBridge` reports `exportPDF: false` and fails the call instead of
 * writing a rasterised fake. PNG rendering keeps the iOS bounds (2x scale, 512 px
 * tiles, 8 MiB CSS pixel ceiling, 120 s timeout) and never returns base64 to JS.
 */
final class YuriViewExportRenderer {
    static final int IMAGE_SCALE = 2;
    static final int MAX_HTML_BYTES = 100 * 1024 * 1024;
    static final int MAX_WIDTH = 2048;
    static final int MAX_HEIGHT = 32768;
    static final int MAX_PIXELS = 8 * 1024 * 1024;
    static final int TIMEOUT_MS = 120_000;

    static final class Failure extends Exception {
        final String code;

        Failure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    static final class Request {
        final String taskId;
        final String html;
        final int width;
        final int height;
        final String filename;
        final boolean pdf;
        final boolean letter;

        Request(Map<String, Object> input, boolean pdf) throws Failure {
            if (input == null) throw invalid("Invalid task, snapshot or filename");
            String taskId = ResourceJson.text(input.get("taskId"));
            Map<String, Object> snapshot = ResourceJson.object(input.get("snapshot"));
            String html = snapshot == null ? null : ResourceJson.text(snapshot.get("html"));
            String filename = ResourceJson.text(input.get("filename"));
            if (taskId == null || !taskId.matches("^[A-Za-z0-9_-]{1,128}$") || html == null || html.isEmpty()
                    || filename == null || filename.trim().isEmpty() || ResourceWebPreviewScope.utf8Length(filename) > 240
                    || filename.equals(".") || filename.equals("..") || RuntimeHostText.hasControl(filename)
                    || filename.contains("/") || filename.contains("\\")) throw invalid("Invalid task, snapshot or filename");
            int width = dimension(snapshot, "width", MAX_WIDTH);
            int height = dimension(snapshot, "height", MAX_HEIGHT);
            if (ResourceWebPreviewScope.utf8Length(html) > MAX_HTML_BYTES || (long) width * height > MAX_PIXELS) {
                throw new Failure("EXPORT_TOO_LARGE", "Snapshot exceeds native limits");
            }
            if (input.containsKey("pageSize")) {
                String pageSize = ResourceJson.text(input.get("pageSize"));
                if (!pdf || !(pageSize.equals("a4") || pageSize.equals("letter"))) {
                    throw invalid("pageSize must be a4 or letter for PDF");
                }
            }
            if (pdf) {
                double pageWidth = "letter".equals(ResourceJson.text(input.get("pageSize"))) ? 612 : 595.28;
                double pageHeight = "letter".equals(ResourceJson.text(input.get("pageSize"))) ? 792 : 841.89;
                double scale = Math.min(0.75, (pageWidth - 48) / width);
                int rows = Math.max(1, (int) Math.floor((pageHeight - 48) / scale));
                if ((height + rows - 1) / rows > 128) throw new Failure("EXPORT_TOO_LARGE", "PDF exceeds 128 pages");
            }
            // The input is a fragment, not a document or an executable web application.
            if (html.matches("(?is).*<\\s*(script|iframe|frame|frameset|object|embed|base|link|meta|html|head|body|video|audio)\\b.*")) {
                throw new Failure("EXPORT_FORBIDDEN", "Snapshot must contain static self-contained HTML");
            }
            this.taskId = taskId;
            this.html = html;
            this.width = width;
            this.height = height;
            this.pdf = pdf;
            this.letter = "letter".equals(ResourceJson.text(input.get("pageSize")));
            int dot = filename.lastIndexOf('.');
            this.filename = (dot > 0 ? filename.substring(0, dot) : filename) + (pdf ? ".pdf" : ".png");
        }

        private static int dimension(Map<String, Object> snapshot, String key, int max) throws Failure {
            Double value = snapshot == null ? null : ResourceJson.number(snapshot.get(key));
            if (value == null || !Double.isFinite(value) || value <= 0 || Math.rint(value) != value) {
                throw invalid("Snapshot dimensions must be positive integers");
            }
            if (value > max) throw new Failure("EXPORT_TOO_LARGE", "Snapshot dimensions exceed native limits");
            return value.intValue();
        }

        private static Failure invalid(String message) { return new Failure("EXPORT_INVALID_INPUT", message); }

        int imageWidth() { return width * IMAGE_SCALE; }

        int imageHeight() { return height * IMAGE_SCALE; }

        static Map<String, Object> limits() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("maxHTMLBytes", MAX_HTML_BYTES);
            value.put("maxWidth", MAX_WIDTH);
            value.put("maxHeight", MAX_HEIGHT);
            value.put("maxPixels", MAX_PIXELS);
            return value;
        }

        String document() {
            return "<!doctype html><html><head><meta charset=\"utf-8\">"
                    + "<meta name=\"viewport\" content=\"width=" + width + ",initial-scale=1,maximum-scale=1,user-scalable=no\">"
                    + "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'; "
                    + "style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; "
                    + "object-src 'none'; base-uri 'none'; form-action 'none'\">"
                    + "<style>html,body{margin:0!important;padding:0!important;width:" + width + "px!important;min-width:"
                    + width + "px!important;height:" + height + "px!important;min-height:" + height
                    + "px!important}body{overflow:hidden!important}*{animation:none!important;transition:none!important;"
                    + "caret-color:transparent!important}</style></head><body>" + html + "</body></html>";
        }
    }

    interface Progress { void stage(String stage, Integer completed, Integer total); }

    private final Request request;
    private final File directory;
    private final Progress progress;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CompletableFuture<File> result = new CompletableFuture<>();
    private WebView web;
    private FrameLayout host;
    private Runnable timeout;
    private boolean stopped = false;
    private boolean rendering = false;

    YuriViewExportRenderer(Request request, File directory, Progress progress) {
        this.request = request;
        this.directory = directory;
        this.progress = progress == null ? (stage, completed, total) -> { } : progress;
    }

    File output() { return new File(directory, request.filename); }

    CompletableFuture<File> start(View owner) {
        if (owner == null || !owner.isAttachedToWindow()) {
            fail("Renderer owner is not attached");
            return result;
        }
        progress.stage("preparing", null, null);
        timeout = () -> fail("Snapshot rendering timed out");
        main.postDelayed(timeout, TIMEOUT_MS);
        WebView created = new WebView(owner.getContext());
        WebSettings settings = created.getSettings();
        settings.setJavaScriptEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setDomStorageEnabled(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setBlockNetworkLoads(true);
        settings.setSupportMultipleWindows(false);
        created.setBackgroundColor(Color.WHITE);
        created.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }

            @Override public void onPageFinished(WebView view, String url) {
                if (stopped || rendering) return;
                rendering = true;
                render();
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                fail("Snapshot loading failed");
            }
        });
        web = created;
        // The viewport must stay inside a live hierarchy; it is inserted under the app content.
        FrameLayout container = new FrameLayout(owner.getContext());
        container.setVisibility(View.INVISIBLE);
        container.addView(created, new FrameLayout.LayoutParams(request.width, Math.min(512, request.height)));
        if (owner.getParent() instanceof ViewGroup) {
            ViewGroup parent = (ViewGroup) owner.getParent();
            parent.addView(container, 0, new ViewGroup.LayoutParams(1, 1));
        }
        host = container;
        created.loadDataWithBaseURL(null, request.document(), "text/html", "utf-8", null);
        return result;
    }

    private void render() {
        if (stopped) return;
        if (request.pdf) {
            fail("PDF export is unavailable on Android");
            return;
        }
        WebView target = web;
        if (target == null) {
            fail("Snapshot renderer terminated");
            return;
        }
        Bitmap bitmap;
        try {
            bitmap = Bitmap.createBitmap(request.imageWidth(), request.imageHeight(), Bitmap.Config.ARGB_8888);
        } catch (OutOfMemoryError tooLarge) {
            fail("Could not allocate image output");
            return;
        }
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(Color.WHITE);
        try {
            int y = 0;
            while (y < request.height && !stopped) {
                int tile = Math.min(512, request.height - y);
                target.scrollTo(0, y);
                target.measure(
                        View.MeasureSpec.makeMeasureSpec(request.width, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(tile, View.MeasureSpec.EXACTLY));
                target.layout(0, 0, request.width, tile);
                canvas.save();
                canvas.translate(0, (float) y * IMAGE_SCALE);
                canvas.scale(IMAGE_SCALE, IMAGE_SCALE);
                target.draw(canvas);
                canvas.restore();
                y += tile;
                progress.stage("rendering", y, request.height);
            }
        } catch (RuntimeException failure) {
            fail("Could not capture snapshot tile");
            return;
        }
        progress.stage("encoding", null, null);
        File output = output();
        try (FileOutputStream stream = new FileOutputStream(output)) {
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) {
                fail("Could not encode image");
                return;
            }
            stream.getFD().sync();
        } catch (Exception failure) {
            fail("Could not encode image");
            return;
        } finally {
            bitmap.recycle();
        }
        if (stopped) {
            ResourceBridge.deleteTree(output.getParentFile());
            return;
        }
        main.post(() -> succeed(output));
    }

    private void succeed(File output) {
        if (stopped) return;
        stopped = true;
        dispose();
        result.complete(output);
    }

    private void fail(String message) {
        main.post(() -> {
            if (stopped) return;
            stopped = true;
            dispose();
            result.completeExceptionally(new Failure("EXPORT_RENDER_FAILED", message));
        });
    }

    void cancel() {
        stopped = true;
        main.post(() -> {
            dispose();
            result.completeExceptionally(new Failure("EXPORT_RENDER_FAILED", "cancelled"));
        });
    }

    private void dispose() {
        if (timeout != null) main.removeCallbacks(timeout);
        timeout = null;
        WebView closing = web;
        web = null;
        if (closing != null) {
            closing.stopLoading();
            closing.setWebViewClient(new WebViewClient());
            closing.destroy();
        }
        FrameLayout container = host;
        host = null;
        if (container != null && container.getParent() instanceof ViewGroup) {
            ((ViewGroup) container.getParent()).removeView(container);
        }
    }
}
