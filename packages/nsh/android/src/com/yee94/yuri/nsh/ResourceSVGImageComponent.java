package com.yee94.yuri.nsh;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

import java.io.File;
import java.io.FileInputStream;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Port of iOS `ResourceSVGImageComponent` and the SVG image mode of
 * `ResourceWebPreviewBridge`.
 *
 * Android has no SVG decoder in the framework, so the fixed local wrapper is
 * rendered by a `WebView` in its own non-persistent data directory with every
 * network/file scheme blocked, the wrapper loaded as data (never a URL) and
 * scripts of the *document* limited to the single decode probe we evaluate
 * ourselves. SVG source, its DOM and its text never leave that wrapper.
 */
public final class ResourceSVGImageComponent implements NshComponent {
    static final int BYTE_LIMIT = 1_000_000;
    static final String POLICY = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; "
            + "img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; "
            + "base-uri 'none'; form-action 'none'";
    static final String PROBE = "(function(){var image=document.getElementById('image');"
            + "if(!(image instanceof HTMLImageElement)||document.images.length!==1"
            + "||image.parentElement!==document.body) return false;"
            + "var src=image.getAttribute('src')||'';"
            + "if(src.indexOf('data:image/svg+xml;base64,')!==0) return false;"
            + "return !!(image.complete&&image.naturalWidth>0&&image.naturalHeight>0);})()";

    /** Local lease plus the transport that owns Host validity. */
    static final class Asset {
        final File file;
        final HostLease transport;
        final Runnable retireRegistration;

        Asset(File file, HostLease transport, Runnable retireRegistration) {
            this.file = file;
            this.transport = transport;
            this.retireRegistration = retireRegistration;
        }

        boolean current() { return transport != null && transport.isCurrent(); }
    }

    /** Resolver for an already verified private lease; it has no Host request capability. */
    interface Resolve {
        Asset resolve(String lease, RuntimeHostScope expectedHost) throws Exception;

        /** Called when this exact lease is retired by the owner; returns an unsubscribe. */
        default Runnable observe(String lease, Runnable retire) { return () -> {}; }
    }

    static final class Request {
        final String lease;
        final RuntimeHostScope expectedHost;
        final boolean active;

        private Request(String lease, RuntimeHostScope expectedHost, boolean active) {
            this.lease = lease;
            this.expectedHost = expectedHost;
            this.active = active;
        }

        static Request parse(Object input) throws ResourceFailure {
            Map<String, Object> value = ResourceJson.object(input);
            if (value == null) throw ResourceFailure.invalid();
            Set<String> allowed = new java.util.HashSet<>(java.util.Arrays.asList("lease", "expectedHost", "active"));
            if (!value.keySet().equals(allowed)) throw ResourceFailure.invalid();
            String lease = ResourceJson.text(value.get("lease"));
            if (lease == null || !RuntimeHostText.uuid(lease)) throw ResourceFailure.invalid();
            Object active = value.get("active");
            if (!(active instanceof Boolean)) throw ResourceFailure.invalid();
            return new Request(lease.toLowerCase(Locale.ROOT), ResourceBridge.scope(value.get("expectedHost")), (Boolean) active);
        }

        @Override public boolean equals(Object other) {
            if (!(other instanceof Request)) return false;
            Request value = (Request) other;
            return lease.equals(value.lease) && expectedHost.equals(value.expectedHost) && active == value.active;
        }

        @Override public int hashCode() { return lease.hashCode() * 31 + expectedHost.hashCode() + (active ? 1 : 0); }
    }

    static final class Lifetime {
        Request request;
        int generation = 0;
        boolean retired = false;

        boolean update(Object value) {
            Request next = null;
            try {
                next = Request.parse(value);
            } catch (ResourceFailure ignored) {
                // A malformed value keeps the previous request but revokes this generation.
            }
            if (next == null ? request == null : next.equals(request)) return false;
            request = next;
            retired = false;
            generation += 1;
            return true;
        }

        void stop() { generation += 1; }

        void retire() { retired = true; stop(); }

        boolean accepts(int ticket) { return ticket == generation && request != null && request.active && !retired; }
    }

    static final class Presentation {
        enum Phase { STOPPED, LOADING, DECODING, READY, FAILED, EXPIRED }

        Phase phase = Phase.STOPPED;
        Integer ticket;

        void begin(int generation) { ticket = generation; phase = Phase.LOADING; }

        boolean wrapperFinished(int generation) {
            if (ticket == null || ticket != generation || phase != Phase.LOADING) return false;
            phase = Phase.DECODING;
            return true;
        }

        boolean decoded(int generation, boolean success) {
            if (ticket == null || ticket != generation || phase != Phase.DECODING) return false;
            phase = success ? Phase.READY : Phase.FAILED;
            return true;
        }

        boolean fail(int generation, boolean expired) {
            if (ticket == null || ticket != generation) return false;
            ticket = null;
            phase = expired ? Phase.EXPIRED : Phase.FAILED;
            return true;
        }

        void stop() { ticket = null; phase = Phase.STOPPED; }

        void expire() { ticket = null; phase = Phase.EXPIRED; }
    }

    /** Native copy follows the system language, like the Save/Share system UI. */
    static final class Copy {
        final String loading, failed, expired, retry, image;

        private Copy(String loading, String failed, String expired, String retry, String image) {
            this.loading = loading;
            this.failed = failed;
            this.expired = expired;
            this.retry = retry;
            this.image = image;
        }

        static Copy localized() {
            String tag = Locale.getDefault().toLanguageTag().toLowerCase(Locale.ROOT).replace('_', '-');
            if (tag.startsWith("zh-hant") || tag.startsWith("zh-tw") || tag.startsWith("zh-hk") || tag.startsWith("zh-mo")) {
                return new Copy("正在載入 SVG…", "SVG 預覽失敗。請重試，或儲存／分享原始檔案。", "預覽已失效，請重新開啟檔案。", "重試", "SVG 圖片");
            }
            if (tag.startsWith("zh")) return new Copy("正在加载 SVG…", "SVG 预览失败。请重试，或保存／分享原文件。", "预览已失效，请重新打开文件。", "重试", "SVG 图片");
            if (tag.startsWith("ja")) return new Copy("SVG を読み込み中…", "SVG をプレビューできません。再試行するか、元のファイルを保存・共有してください。", "プレビューは無効になりました。ファイルを開き直してください。", "再試行", "SVG 画像");
            if (tag.startsWith("ko")) return new Copy("SVG 불러오는 중…", "SVG 미리보기에 실패했습니다. 다시 시도하거나 원본 파일을 저장하거나 공유하세요.", "미리보기가 만료되었습니다. 파일을 다시 여세요.", "다시 시도", "SVG 이미지");
            if (tag.startsWith("fr")) return new Copy("Chargement du SVG…", "Échec de l’aperçu SVG. Réessayez ou enregistrez ou partagez le fichier original.", "L’aperçu a expiré. Rouvrez le fichier.", "Réessayer", "Image SVG");
            if (tag.startsWith("es")) return new Copy("Cargando SVG…", "No se pudo mostrar el SVG. Reinténtalo o guarda o comparte el archivo original.", "La vista previa ha caducado. Abre el archivo de nuevo.", "Reintentar", "Imagen SVG");
            if (tag.startsWith("pl")) return new Copy("Wczytywanie SVG…", "Nie udało się wyświetlić SVG. Spróbuj ponownie lub zapisz albo udostępnij oryginalny plik.", "Podgląd wygasł. Otwórz plik ponownie.", "Spróbuj ponownie", "Obraz SVG");
            if (tag.startsWith("pt")) return new Copy("Carregando SVG…", "Não foi possível visualizar o SVG. Tente novamente ou salve ou compartilhe o arquivo original.", "A visualização expirou. Abra o arquivo novamente.", "Tentar novamente", "Imagem SVG");
            if (tag.startsWith("uk")) return new Copy("Завантаження SVG…", "Не вдалося переглянути SVG. Повторіть спробу або збережіть чи поширте оригінальний файл.", "Термін дії перегляду минув. Відкрийте файл знову.", "Повторити", "Зображення SVG");
            return new Copy("Loading SVG…", "SVG preview failed. Retry, or save or share the original file.", "This preview has expired. Reopen the file.", "Retry", "SVG image");
        }
    }

    /** The fixed wrapper: the only document this view ever loads. */
    static String wrapper(byte[] data) throws ResourceFailure {
        if (data.length > BYTE_LIMIT) throw ResourceFailure.limit();
        String encoded = java.util.Base64.getEncoder().encodeToString(data);
        return "<!doctype html><html><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<meta http-equiv=\"Content-Security-Policy\" content=\"" + POLICY + "\">"
                + "<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}"
                + "img{display:block;width:100%;height:100%;object-fit:contain}</style></head><body>"
                + "<img id=\"image\" alt=\"SVG\" src=\"data:image/svg+xml;base64," + encoded + "\"></body></html>";
    }

    static String load(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] data = new byte[BYTE_LIMIT + 1];
            int total = 0;
            while (total < data.length) {
                int count = input.read(data, total, data.length - total);
                if (count < 0) break;
                total += count;
            }
            if (total > BYTE_LIMIT) throw ResourceFailure.limit();
            byte[] exact = new byte[total];
            System.arraycopy(data, 0, exact, 0, total);
            return wrapper(exact);
        }
    }

    // ------------------------------------------------------------------ component

    private final View view;

    private ResourceSVGImageComponent(Context context, Resolve resolve) {
        view = new View(context, resolve);
    }

    @Override public android.view.View view() { return view; }

    @Override public void setProp(String name, Object value) {
        if ("config".equals(name)) view.update(value);
    }

    /** Registers {@code yuri.resource.svgImage}; inline Files and fullscreen share it. */
    public static void install(NshView surface, Resolve resolve) {
        Context context = surface.getContext();
        surface.registerComponent("yuri.resource.svgImage", new NshComponent.Factory() {
            @Override public NshComponent create(NshComponentContext ignored) {
                return new ResourceSVGImageComponent(context, resolve);
            }
        });
    }

    /** One narrow WebView image mode; never a top-level SVG document. */
    static final class View extends FrameLayout {
        private final Resolve resolve;
        private final Copy copy = Copy.localized();
        private final Lifetime lifetime = new Lifetime();
        private final Presentation presentation = new Presentation();
        private final LinearLayout statusPanel;
        private final TextView statusLabel;
        private final ProgressBar spinner;
        private final Button retry;
        private WebView web;
        private Runnable unsubscribe;
        private Asset asset;
        private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
        private Runnable deadline;

        View(Context context, Resolve resolve) {
            super(context);
            this.resolve = resolve;
            setBackgroundColor(Color.TRANSPARENT);
            statusPanel = new LinearLayout(context);
            statusPanel.setOrientation(LinearLayout.VERTICAL);
            statusPanel.setGravity(Gravity.CENTER);
            statusLabel = new TextView(context);
            statusLabel.setGravity(Gravity.CENTER);
            statusLabel.setTextColor(0xff888888);
            spinner = new ProgressBar(context);
            retry = new Button(context);
            statusPanel.addView(spinner, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            statusPanel.addView(statusLabel, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            statusPanel.addView(retry, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            LayoutParams panel = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            panel.gravity = Gravity.CENTER;
            addView(statusPanel, panel);
            retry.setOnClickListener(ignored -> retry());
            renderStatus();
        }

        void update(Object value) {
            if (!lifetime.update(value)) {
                if (!(value instanceof Map) || parseFails(value)) expire();
                return;
            }
            stop();
            if (lifetime.request == null) expire();
            else reconcile();
        }

        private boolean parseFails(Object value) {
            try {
                Request.parse(value);
                return false;
            } catch (ResourceFailure ignored) {
                return true;
            }
        }

        @Override protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            reconcile();
        }

        @Override protected void onDetachedFromWindow() {
            stop();
            super.onDetachedFromWindow();
        }

        @Override protected void onWindowVisibilityChanged(int visibility) {
            if (visibility == android.view.View.VISIBLE) reconcile();
            else if (!lifetime.retired) stop();
        }

        private void retry() {
            if (presentation.phase != Presentation.Phase.FAILED && presentation.phase != Presentation.Phase.EXPIRED) return;
            Request request = lifetime.request;
            if (lifetime.retired || request == null || !request.active || getWindowToken() == null) {
                expire();
                return;
            }
            clearWork();
            presentation.stop();
            reconcile();
        }

        private void reconcile() {
            if (web != null || !isAttachedToWindow()) return;
            Request request = lifetime.request;
            if (request == null || !request.active) return;
            if (lifetime.retired) { expire(); return; }
            if (presentation.phase == Presentation.Phase.FAILED || presentation.phase == Presentation.Phase.EXPIRED) {
                renderStatus();
                return;
            }
            int ticket = lifetime.generation;
            presentation.begin(ticket);
            renderStatus();
            Asset resolved;
            try {
                resolved = resolve.resolve(request.lease, request.expectedHost);
            } catch (Exception failure) {
                expire();
                return;
            }
            if (!resolved.current()) { expire(); return; }
            asset = resolved;
            unsubscribe = resolve.observe(request.lease, () -> {
                Request current = lifetime.request;
                if (current != null && current.lease.equals(request.lease)) {
                    lifetime.retire();
                    expire();
                }
            });
            if (lifetime.retired || !resolved.current()) { expire(); return; }
            scheduleDeadline(ticket);
            CompletableFuture.supplyAsync(() -> {
                try {
                    return load(resolved.file);
                } catch (Exception failure) {
                    return null;
                }
            }).thenAccept(wrapper -> main.post(() -> {
                if (!lifetime.accepts(ticket)) return;
                if (wrapper == null) { fail(ticket); return; }
                if (!current()) { expire(); return; }
                installWeb(ticket, wrapper);
            }));
        }

        private void scheduleDeadline(int ticket) {
            cancelDeadline();
            deadline = () -> {
                if (!lifetime.accepts(ticket)) return;
                Presentation.Phase phase = presentation.phase;
                if (phase != Presentation.Phase.LOADING && phase != Presentation.Phase.DECODING) return;
                if (current()) fail(ticket);
                else expire();
            };
            main.postDelayed(deadline, 10_000L);
        }

        private void installWeb(int ticket, String wrapper) {
            removeWeb();
            WebView created = new WebView(getContext());
            WebSettings settings = created.getSettings();
            // The probe is our own evaluateJavascript call; document scripts stay blocked by CSP.
            settings.setJavaScriptEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setDomStorageEnabled(false);
            settings.setDatabaseEnabled(false);
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            settings.setBlockNetworkLoads(true);
            settings.setSupportMultipleWindows(false);
            settings.setMediaPlaybackRequiresUserGesture(true);
            created.setBackgroundColor(Color.TRANSPARENT);
            created.setVerticalScrollBarEnabled(false);
            created.setHorizontalScrollBarEnabled(false);
            created.setContentDescription(copy.image);
            created.loadDataWithBaseURL(null, wrapper, "text/html", "utf-8", null);
            created.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                    return true; // no navigation of any kind leaves the wrapper
                }

                @Override public void onPageFinished(WebView view, String url) {
                    if (web != created) return;
                    if (!current()) { expire(); return; }
                    if (!presentation.wrapperFinished(ticket)) return;
                    renderStatus();
                    probeDecode(view, ticket, 20);
                }

                @Override public void onReceivedError(WebView view, android.webkit.WebResourceRequest request,
                        android.webkit.WebResourceError error) {
                    if (web == created) fail(lifetime.generation);
                }
            });
            web = created;
            addView(created, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            statusPanel.bringToFront();
            renderStatus();
        }

        /** A data URI decodes within a frame or two; bounded retries replace `await image.decode()`. */
        private void probeDecode(WebView target, int ticket, int attemptsLeft) {
            target.evaluateJavascript(PROBE, value -> main.post(() -> {
                if (web != target || !lifetime.accepts(ticket)) return;
                if (!current()) { expire(); return; }
                if ("true".equals(value)) {
                    cancelDeadline();
                    if (presentation.decoded(ticket, true)) renderStatus();
                    return;
                }
                if (attemptsLeft > 0) main.postDelayed(() -> probeDecode(target, ticket, attemptsLeft - 1), 100L);
                else fail(ticket);
            }));
        }

        private boolean current() {
            return !lifetime.retired && lifetime.request != null && lifetime.request.active
                    && asset != null && asset.current() && isAttachedToWindow();
        }

        void stop() {
            clearWork();
            presentation.stop();
            renderStatus();
        }

        private void clearWork() {
            lifetime.stop();
            cancelDeadline();
            Runnable cancel = unsubscribe;
            unsubscribe = null;
            if (cancel != null) cancel.run();
            asset = null;
            removeWeb();
        }

        private void fail(int ticket) {
            if (!presentation.fail(ticket, false)) return;
            clearWorkKeepAsset();
            renderStatus();
        }

        private void clearWorkKeepAsset() {
            lifetime.stop();
            cancelDeadline();
            asset = null;
            removeWeb();
        }

        private void expire() {
            clearWork();
            presentation.expire();
            renderStatus();
        }

        private void cancelDeadline() {
            if (deadline != null) main.removeCallbacks(deadline);
            deadline = null;
        }

        private void removeWeb() {
            if (web == null) return;
            WebView removing = web;
            web = null;
            removing.stopLoading();
            removing.setWebViewClient(new WebViewClient());
            removeView(removing);
            removing.destroy();
        }

        private void renderStatus() {
            Presentation.Phase phase = presentation.phase;
            boolean loading = phase == Presentation.Phase.LOADING || phase == Presentation.Phase.DECODING;
            boolean failure = phase == Presentation.Phase.FAILED || phase == Presentation.Phase.EXPIRED;
            statusPanel.setVisibility(loading || failure ? android.view.View.VISIBLE : android.view.View.GONE);
            statusLabel.setText(phase == Presentation.Phase.EXPIRED ? copy.expired : failure ? copy.failed : copy.loading);
            spinner.setVisibility(loading ? android.view.View.VISIBLE : android.view.View.GONE);
            retry.setText(copy.retry);
            retry.setVisibility(failure ? android.view.View.VISIBLE : android.view.View.GONE);
            retry.setEnabled(failure);
            if (web != null) web.setVisibility(phase == Presentation.Phase.READY ? android.view.View.VISIBLE : android.view.View.GONE);
            statusPanel.bringToFront();
        }
    }
}
