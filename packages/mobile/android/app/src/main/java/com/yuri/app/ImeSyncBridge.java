package com.yuri.app;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Android IME owner for Capacitor WebView — two-WebView experiment.
 *
 * Geometry:
 *   The main WebView is never resized by the IME. System frames only set its
 *   native translationY (= -IME inset). At rest the page paints its own
 *   same-layer header. Only during IME motion a separate pinned WebView
 *   ({@link NativeHeaderHost}) is engaged, so translation never moves it.
 *
 * Layout handoff:
 *   At rest the web layout is offset by the IME height inside the page
 *   (window.__yuriImeOffset) so its body box maps exactly onto the visible area.
 *   That change is a single web-side frame while native translation stays
 *   constant: there is no native resize racing an asynchronous web repaint.
 *   Opening applies the offset after the IME settles. Closing removes it in
 *   onPrepare, before the first moving frame; translation always follows the
 *   live IME frame and never waits for the page.
 *
 * Backdrop (gray strip above the keyboard on edge-to-edge):
 *   Paint window / decor / WebView parent / nav bar to match page --background.
 *
 * @see https://developer.android.com/develop/ui/views/layout/sw-keyboard
 */
final class ImeSyncBridge {
    private final BridgeActivity activity;
    private Bridge bridge;
    private View webParent;
    private View rootView;
    private WebView webView;
    private int currentInset;
    private boolean enabled;
    /** IME px the page layout currently absorbs (acknowledged). */
    private int webOffset;
    private int requestedOffset = -1;
    private long offsetGeneration;
    private long headerGeneration;
    private final Set<WindowInsetsAnimationCompat> imeAnimations = new HashSet<>();
    private int lastImeHeight = -1;
    /** Last painted backdrop (ARGB). Avoid redundant window writes. */
    private int lastBackdropArgb = Color.TRANSPARENT;
    private boolean lastImeVisible = false;

    ImeSyncBridge(BridgeActivity activity) {
        this.activity = activity;
    }

    void attach() {
        bridge = activity.getBridge();
        if (bridge == null) return;
        webView = bridge.getWebView();
        if (webView == null) return;
        View content = activity.getWindow().getDecorView().findViewById(android.R.id.content);
        if (content == null) return;
        webParent = (View) webView.getParent();
        rootView = content.getRootView();

        paintBackdrop(resolveThemeBackdrop());
        hideNavigationBar();
        webView.post(this::syncBackdropFromWeb);

        if (webParent != null) {
            // Replace SystemBars' final-frame padding with one native owner.
            ViewCompat.setOnApplyWindowInsetsListener(webParent, (v, insets) -> {
                Insets systemBars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                );
                boolean imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
                if (!imeVisible) {
                    hideNavigationBar();
                }
                // onPrepare precedes final-inset dispatch. Do not jump to that
                // final size before onProgress supplies the animated geometry.
                if (imeAnimations.isEmpty()) {
                    currentInset = imeInset(insets);
                    applyTranslation();
                    requestOffset(enabled ? currentInset : 0);
                    reportImeState(insets, "settled", 0);
                }
                return new WindowInsetsCompat.Builder(insets)
                    .setInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                        Insets.of(
                            systemBars.left,
                            systemBars.top,
                            systemBars.right,
                            imeVisible ? 0 : systemBars.bottom
                        )
                    )
                    .build();
            });
            webParent.setPadding(0, 0, 0, 0);
        }

        // Replace Capacitor Keyboard's empty callback; all frame work stays
        // native. Other inset animations (status/navigation bars) are not IME.
        ViewCompat.setWindowInsetsAnimationCallback(rootView, new WindowInsetsAnimationCompat.Callback(
            WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE
        ) {
            @Override
            public void onPrepare(@NonNull WindowInsetsAnimationCompat animation) {
                if (!isIme(animation)) return;
                if (imeAnimations.isEmpty()) {
                    engageHeader();
                    // A visible IME can only shrink or change height: drop the
                    // page's top offset before the first moving frame. The
                    // translation still holds the composer above the IME, the
                    // shell's top just moves above the screen (no gap).
                    WindowInsetsCompat now = ViewCompat.getRootWindowInsets(rootView);
                    if (now != null && now.isVisible(WindowInsetsCompat.Type.ime())) requestOffset(0);
                }
                imeAnimations.add(animation);
            }

            @NonNull
            @Override
            public WindowInsetsAnimationCompat.BoundsCompat onStart(
                @NonNull WindowInsetsAnimationCompat animation,
                @NonNull WindowInsetsAnimationCompat.BoundsCompat bounds
            ) {
                if (isIme(animation)) {
                    WindowInsetsCompat target = ViewCompat.getRootWindowInsets(rootView);
                    if (target != null) {
                        reportImeState(target, "start", animation.getDurationMillis());
                        // Fallback when onPrepare could not see the IME.
                        if (imeInset(target) < webOffset) requestOffset(0);
                    }
                }
                return bounds;
            }

            @NonNull
            @Override
            public WindowInsetsCompat onProgress(
                @NonNull WindowInsetsCompat insets,
                @NonNull List<WindowInsetsAnimationCompat> runningAnimations
            ) {
                for (WindowInsetsAnimationCompat animation : runningAnimations) {
                    if (isIme(animation)) {
                        currentInset = imeInset(insets);
                        applyTranslation();
                        break;
                    }
                }
                return insets;
            }

            @Override
            public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
                if (!isIme(animation)) return;
                imeAnimations.remove(animation);
                if (!imeAnimations.isEmpty()) return;
                WindowInsetsCompat settled = ViewCompat.getRootWindowInsets(rootView);
                if (settled != null) {
                    currentInset = imeInset(settled);
                    applyTranslation();
                    requestOffset(enabled ? currentInset : 0);
                    if (currentInset == webOffset) releaseHeader();
                    reportImeState(settled, "settled", 0);
                }
            }
        });
        if (webParent != null) webParent.requestApplyInsets();
    }

    private static boolean isIme(WindowInsetsAnimationCompat animation) {
        return (animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0;
    }

    void setEnabled(boolean next) {
        if (enabled == next) return;
        enabled = next;
        applyTranslation();
        requestOffset(enabled && imeAnimations.isEmpty() ? currentInset : 0);
        if (enabled && !imeAnimations.isEmpty()) engageHeader();
        if (!enabled) releaseHeader();
        // A focus transfer need not cause another inset dispatch. Refresh the
        // local field inset / composer state from the current native geometry.
        lastImeHeight = -1;
        WindowInsetsCompat now = rootView == null ? null : ViewCompat.getRootWindowInsets(rootView);
        if (now != null) reportImeState(now, imeAnimations.isEmpty() ? "settled" : "start", 0);
    }

    private static int imeInset(WindowInsetsCompat insets) {
        return Math.max(0, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom);
    }

    private void applyTranslation() {
        if (webView == null) return;
        // Always the live IME frame. Until the page drops a stale top offset
        // the strip under the pinned header shows page background only.
        float next = enabled ? -currentInset : 0;
        if (webView.getTranslationY() != next) webView.setTranslationY(next);
    }

    /** Ask the page to absorb {@code px} IME height in one web frame. */
    private void requestOffset(int px) {
        if (webView == null || px == requestedOffset) return;
        requestedOffset = px;
        final long token = ++offsetGeneration;
        float density = webView.getResources().getDisplayMetrics().density;
        String css = String.format(Locale.US, "%.3f", px / density);
        webView.evaluateJavascript(
            "window.__yuriImeOffset?window.__yuriImeOffset(" + css + "):0", value -> {
                if (token != offsetGeneration || webView == null) return;
                // A stale bundle without the hook keeps today's translation.
                webOffset = px;
                // The callback returns after the script ran; wait for that frame.
                webView.postVisualStateCallback(token, new WebView.VisualStateCallback() {
                    @Override public void onComplete(long requestId) {
                        if (token != offsetGeneration || webView == null) return;
                        if (imeAnimations.isEmpty() && currentInset == webOffset) releaseHeader();
                    }
                });
            });
    }

    /**
     * Pin the mirror synchronously (alpha only) before the first translated
     * frame, then ask the page to hide its own header. Until that lands both
     * coincide at the top.
     */
    private void engageHeader() {
        if (!enabled) return;
        NativeHeaderHost header = NativeHeaderHost.current;
        headerGeneration++;
        if (header == null || webView == null || !header.ready()) return;
        header.setEngaged(true);
        webView.evaluateJavascript("window.__yuriNativeHeader&&window.__yuriNativeHeader(true)", null);
    }

    /** Page header first; drop the mirror only after the page painted it. */
    private void releaseHeader() {
        NativeHeaderHost header = NativeHeaderHost.current;
        if (header == null || webView == null || !header.engaged()) return;
        final long token = ++headerGeneration;
        webView.evaluateJavascript("window.__yuriNativeHeader&&window.__yuriNativeHeader(false)", ignored -> {
            if (token != headerGeneration || webView == null) return;
            webView.postVisualStateCallback(token, new WebView.VisualStateCallback() {
                @Override public void onComplete(long requestId) {
                    if (token != headerGeneration || (enabled && !imeAnimations.isEmpty())) return;
                    header.setEngaged(false);
                }
            });
        });
    }

    private void reportImeState(WindowInsetsCompat insets, String phase, long durationMs) {
        boolean open = insets.isVisible(WindowInsetsCompat.Type.ime());
        int height = open ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
        if (!"start".equals(phase) && open == lastImeVisible && height == lastImeHeight && imeAnimations.isEmpty()) {
            return;
        }
        if (open && !lastImeVisible) syncBackdropFromWeb();
        lastImeVisible = open;
        lastImeHeight = "start".equals(phase) ? -1 : height;
        notifyImeState(open, height, phase, durationMs);
    }

    void detach() {
        offsetGeneration++;
        if (webView != null) webView.setTranslationY(0);
        if (rootView != null) ViewCompat.setWindowInsetsAnimationCallback(rootView, null);
        if (webParent != null) ViewCompat.setOnApplyWindowInsetsListener(webParent, null);
        imeAnimations.clear();
        rootView = null;
        webParent = null;
        webView = null;
        bridge = null;
    }

    @SuppressWarnings("deprecation")
    void hideNavigationBar() {
        Window window = activity.getWindow();
        if (window == null) return;
        View decor = window.getDecorView();
        if (decor == null) return;
        int immersiveFlags =
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
        decor.setSystemUiVisibility(decor.getSystemUiVisibility() | immersiveFlags);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
        if (controller == null) return;
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );
        controller.hide(WindowInsetsCompat.Type.navigationBars());
    }

    /**
     * Paint every native surface that can show between the WebView and the IME.
     * Color must match the web {@code --background} or the strip remains visible.
     */
    private void paintBackdrop(int argb) {
        if (argb == lastBackdropArgb) return;
        lastBackdropArgb = argb;
        Window window = activity.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(argb));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.setNavigationBarContrastEnforced(false);
            }
            window.setNavigationBarColor(argb);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                window.setNavigationBarDividerColor(argb);
            }
            View decor = window.getDecorView();
            if (decor != null) {
                decor.setBackgroundColor(argb);
                boolean lightBg = isLightColor(argb);
                WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(window, decor);
                if (controller != null) {
                    controller.setAppearanceLightNavigationBars(lightBg);
                }
            }
        }
        if (webParent != null) {
            webParent.setBackgroundColor(argb);
        }
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setBackgroundColor(argb);
        }
    }

    private void syncBackdropFromWeb() {
        if (bridge == null || bridge.getWebView() == null) return;
        String script =
            "(function(){"
                + "try{"
                + "var s=getComputedStyle(document.documentElement);"
                + "var c=s.getPropertyValue('--background').trim()||s.backgroundColor;"
                + "if(!c||c==='transparent'||c==='rgba(0, 0, 0, 0)'){"
                + "c=getComputedStyle(document.body).backgroundColor;"
                + "}"
                + "return c||'';"
                + "}catch(e){return '';}"
                + "})()";
        bridge.getWebView().evaluateJavascript(script, value -> {
            int parsed = parseCssColor(value);
            if (parsed != 0) {
                activity.runOnUiThread(() -> paintBackdrop(parsed));
            }
        });
    }

    private int resolveThemeBackdrop() {
        boolean night =
            (activity.getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        return night ? Color.parseColor("#171515") : Color.parseColor("#fffdf4");
    }

    private static int parseCssColor(String raw) {
        if (raw == null || raw.length() < 3) return 0;
        String s = raw.trim();
        if (s.length() >= 2 && s.charAt(0) == '"' && s.charAt(s.length() - 1) == '"') {
            s = s.substring(1, s.length() - 1);
        }
        s = s.replace("\\u003c", "<").trim();
        if (s.isEmpty() || "null".equals(s) || "undefined".equals(s)) return 0;
        try {
            if (s.startsWith("#")) {
                return Color.parseColor(s.length() == 4
                    ? ("#" + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2) + s.charAt(3) + s.charAt(3))
                    : s);
            }
            if (s.startsWith("rgb")) {
                int open = s.indexOf('(');
                int close = s.indexOf(')');
                if (open < 0 || close <= open) return 0;
                String[] parts = s.substring(open + 1, close).split(",");
                if (parts.length < 3) return 0;
                int r = clamp255(parseCssChannel(parts[0]));
                int g = clamp255(parseCssChannel(parts[1]));
                int b = clamp255(parseCssChannel(parts[2]));
                int a = 255;
                if (parts.length >= 4) {
                    float af = parseCssChannel(parts[3]);
                    a = af <= 1f ? clamp255(Math.round(af * 255f)) : clamp255(Math.round(af));
                }
                return Color.argb(a, r, g, b);
            }
            return 0;
        } catch (Exception e) {
            return 0;
        }
    }

    private static float parseCssChannel(String part) {
        String t = part.trim();
        if (t.endsWith("%")) {
            return Float.parseFloat(t.substring(0, t.length() - 1)) * 2.55f;
        }
        return Float.parseFloat(t);
    }

    private static int clamp255(float v) {
        return Math.max(0, Math.min(255, Math.round(v)));
    }

    private static boolean isLightColor(int argb) {
        double r = Color.red(argb) / 255.0;
        double g = Color.green(argb) / 255.0;
        double b = Color.blue(argb) / 255.0;
        double lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return lum > 0.5;
    }

    /** Bookends only: classes and the transcript's existing scroll owner, no JS lift. */
    private void notifyImeState(boolean open, int heightPx, String phase, long durationMs) {
        if (bridge == null) return;
        // Height is informational window px. JS must not subtract it again:
        // the WebView viewport already excludes this native inset.
        String data = String.format(
            Locale.US,
            "{\"open\":%s,\"height\":%d,\"phase\":\"%s\",\"durationMs\":%d,\"nativeResize\":true}",
            open,
            Math.max(0, heightPx),
            phase,
            Math.max(0, durationMs)
        );
        bridge.triggerJSEvent("yuri:ime-state", "window", data);
    }

}
