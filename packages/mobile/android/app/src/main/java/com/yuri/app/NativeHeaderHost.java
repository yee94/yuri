package com.yuri.app;

import android.app.Activity;
import android.graphics.Color;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import com.getcapacitor.Bridge;
import java.io.ByteArrayInputStream;
import org.json.JSONObject;

/**
 * A second, bridge-less, transparent WebView pinned above the main WebView.
 * At rest the page paints its own same-layer header (live backdrop blur,
 * collapse). The mirror stays rasterized at alpha 0 and is engaged only while
 * the IME moves, so translation never moves the header. Engaged, it follows
 * the page's collapse contract via native translationY/alpha (snapping uses
 * the same 240ms curve). Mirror glass is plain translucency: CSS
 * backdrop-filter cannot sample another WebView. The main app stays the only
 * state owner; taps return as child-index paths.
 */
final class NativeHeaderHost {
    interface Listener {
        void shown(int seq);
        void tap(String path);
    }

    /** Owned by the plugin; read by ImeSyncBridge. */
    static NativeHeaderHost current;

    private static final android.view.animation.Interpolator SNAP =
        new android.view.animation.PathInterpolator(0.22f, 1f, 0.36f, 1f);

    private static final String SHELL = "<!doctype html><html><head>"
        + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover\">"
        + "<style id=\"yuri-css\"></style>"
        // The mirrored root classes match app rules such as
        // :root.yuri-capacitor-app body { background: var(--background) !important }.
        // Out-rank them so the page below shows through.
        + "<style>:root:root:root,:root:root:root body,:root:root:root #yuri-h{margin:0!important;padding:0!important;background:transparent!important;overflow:hidden!important;height:100%!important}"
        + ":root:root:root body::before,:root:root:root body::after{content:none!important}</style>"
        + "</head><body><div id=\"yuri-sprite\" style=\"display:none\"></div><div id=\"yuri-h\"></div><script>"
        + "window.__yuriSet=function(p){var d=document,r=d.documentElement;"
        + "if(p.css!=null)d.getElementById('yuri-css').textContent=p.css;"
        + "if(p.sprite!=null)d.getElementById('yuri-sprite').innerHTML=p.sprite;"
        + "r.className=p.rootClass;r.style.cssText=p.rootStyle;d.body.className=p.bodyClass;"
        + "d.getElementById('yuri-h').innerHTML=p.html;return 1};"
        + "document.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();"
        + "var h=document.getElementById('yuri-h').firstElementChild,n=e.target,path=[];"
        + "if(!h)return;while(n&&n!==h){var p=n.parentElement;if(!p)return;path.unshift(Array.prototype.indexOf.call(p.children,n));n=p}"
        + "if(n===h)YuriHeaderBridge.tap(JSON.stringify(path))},true);"
        + "</script></body></html>";

    private final Listener listener;
    private WebView view;
    private boolean ready;
    private JSONObject pending;
    private int latestSeq;
    private int shownSeq = -1;
    private boolean shown;
    private boolean engaged;
    private float collapse;
    private float collapseDistance;
    private boolean interactive = true;
    private android.animation.ValueAnimator snap;
    private int height = -1;
    private int hitBottom;

    NativeHeaderHost(Activity activity, Bridge bridge, Listener listener) {
        this.listener = listener;
        ViewGroup content = activity.findViewById(android.R.id.content);
        view = new WebView(activity) {
            private boolean passThrough;

            @Override public boolean dispatchTouchEvent(MotionEvent event) {
                // The transparent fade strip never swallows transcript touches;
                // a collapsing/collapsed header is not interactive (as on web).
                if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                    passThrough = !engaged || !shown || !interactive || event.getY() > hitBottom;
                }
                return !passThrough && super.dispatchTouchEvent(event);
            }
        };
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setTextZoom(100);
        settings.setOffscreenPreRaster(true);
        view.setBackgroundColor(Color.TRANSPARENT);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // Taps must not steal focus from the main composer (that closes the IME).
        view.setFocusable(false);
        view.setFocusableInTouchMode(false);
        view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        view.setAlpha(0f);
        view.addJavascriptInterface(new Object() {
            @JavascriptInterface public void tap(String path) {
                activity.runOnUiThread(() -> { if (view != null && engaged && shown && interactive) listener.tap(path); });
            }
        }, "YuriHeaderBridge");
        final String host = android.net.Uri.parse(bridge.getLocalUrl()).getHost();
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                // Fonts/images referenced by mirrored CSS come from the app bundle only.
                if (host != null && host.equals(request.getUrl().getHost())) {
                    return bridge.getLocalServer().shouldInterceptRequest(request);
                }
                if ("data".equalsIgnoreCase(request.getUrl().getScheme())) return null;
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }
            @Override public void onPageFinished(WebView v, String url) {
                ready = true;
                if (pending != null) { JSONObject next = pending; pending = null; apply(next); }
            }
        });
        content.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1, Gravity.TOP));
        view.loadDataWithBaseURL(bridge.getLocalUrl() + "/", SHELL, "text/html", "UTF-8", null);
    }

    void update(JSONObject payload) {
        if (view == null) return;
        latestSeq = payload.optInt("seq");
        if (!payload.optBoolean("visible")) {
            // The page already shows its own header (or none); drop the mirror.
            pending = null;
            shown = false;
            engaged = false;
            cancelSnap();
            view.setAlpha(0f);
            return;
        }
        if (!ready) {
            // Keep css/sprite from an unapplied earlier payload.
            if (pending != null) {
                try {
                    if (!payload.has("css") && pending.has("css")) payload.put("css", pending.get("css"));
                    if (!payload.has("sprite") && pending.has("sprite")) payload.put("sprite", pending.get("sprite"));
                } catch (org.json.JSONException ignored) { }
            }
            pending = payload;
            return;
        }
        apply(payload);
    }

    private void apply(JSONObject payload) {
        final int seq = payload.optInt("seq");
        int nextHeight = Math.max(1, payload.optInt("height"));
        hitBottom = payload.optInt("hitBottom", nextHeight);
        collapseDistance = (float) payload.optDouble("collapseDistance", nextHeight);
        if (nextHeight != height) {
            height = nextHeight;
            ViewGroup.LayoutParams params = view.getLayoutParams();
            params.height = height;
            view.setLayoutParams(params);
        }
        view.evaluateJavascript("window.__yuriSet(" + payload + ")", ignored -> {
            if (view == null || seq != latestSeq) return;
            view.postVisualStateCallback(seq, new WebView.VisualStateCallback() {
                @Override public void onComplete(long requestId) {
                    if (view == null || seq != latestSeq) return;
                    shownSeq = seq;
                    if (!shown) {
                        shown = true;
                        renderCollapse();
                    }
                    listener.shown(seq);
                }
            });
        });
    }

    /**
     * Page collapse state (progress 0 expanded .. 1 collapsed). Tracking and
     * rest apply directly; snapping animates natively like the CSS transition.
     */
    void setCollapse(float progress, String phase, String rest) {
        if (view == null) return;
        float target = Math.max(0f, Math.min(1f, progress));
        interactive = "rest".equals(phase) && !"collapsed".equals(rest);
        if ("snapping".equals(phase)) {
            if (snap != null && snap.isRunning()) return;
            float from = collapse;
            if (from == target) return;
            snap = android.animation.ValueAnimator.ofFloat(from, target);
            snap.setDuration(android.animation.ValueAnimator.areAnimatorsEnabled() ? 240 : 0);
            snap.setInterpolator(SNAP);
            snap.addUpdateListener(a -> { collapse = (float) a.getAnimatedValue(); renderCollapse(); });
            snap.start();
            return;
        }
        // Snap end publishes rest at the same target: let the animation finish.
        if (snap != null && snap.isRunning() && "rest".equals(phase)) return;
        cancelSnap();
        collapse = target;
        renderCollapse();
    }

    private void cancelSnap() {
        if (snap != null) snap.cancel();
        snap = null;
    }

    private void renderCollapse() {
        if (view == null || !shown) return;
        view.setTranslationY(-collapse * collapseDistance);
        view.setAlpha(engaged ? 1f - collapse : 0f);
    }

    /** The mirror has painted the page's latest header state. */
    boolean ready() {
        return view != null && shown && shownSeq == latestSeq;
    }

    boolean engaged() {
        return engaged;
    }

    void setEngaged(boolean value) {
        engaged = value && view != null;
        renderCollapse();
    }

    void destroy() {
        if (current == this) current = null;
        engaged = false;
        cancelSnap();
        shown = false;
        if (view == null) return;
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        view.destroy();
        view = null;
    }
}
