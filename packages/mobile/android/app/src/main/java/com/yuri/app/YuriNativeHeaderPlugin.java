package com.yuri.app;

import android.webkit.JavascriptInterface;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Main-WebView endpoint for the pinned header WebView (Android IME experiment). */
@CapacitorPlugin(name = "YuriNativeHeader")
public class YuriNativeHeaderPlugin extends Plugin {
    private NativeHeaderHost host;
    private float collapse;
    private String phase = "rest";
    private String rest = "expanded";

    @Override
    public void load() {
        // Collapse tracking is per-frame. A synchronous JS interface avoids the
        // Capacitor message queue and promise round trip of a plugin call.
        getBridge().getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface public void set(float progress, String nextPhase, String nextRest) {
                getActivity().runOnUiThread(() -> {
                    collapse = progress;
                    phase = nextPhase;
                    rest = nextRest;
                    if (host != null) host.setCollapse(collapse, phase, rest);
                });
            }
        }, "YuriHeaderCollapse");
    }

    @PluginMethod
    public void update(PluginCall call) {
        JSObject data = call.getData();
        getActivity().runOnUiThread(() -> {
            if (host == null) {
                host = new NativeHeaderHost(getActivity(), getBridge(), new NativeHeaderHost.Listener() {
                    @Override public void shown(int seq) {
                        JSObject event = new JSObject();
                        event.put("seq", seq);
                        notifyListeners("shown", event);
                    }
                    @Override public void tap(String path) {
                        JSObject event = new JSObject();
                        event.put("path", path);
                        notifyListeners("tap", event);
                    }
                });
                host.setCollapse(collapse, phase, rest);
                NativeHeaderHost.current = host;
            }
            host.update(data);
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (host != null) host.destroy();
        host = null;
    }
}
