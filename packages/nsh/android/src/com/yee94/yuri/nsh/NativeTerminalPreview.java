package com.yee94.yuri.nsh;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.longbridge.nsh.NshView;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Ported from NativeTerminalPreview in ios/NativeTerminalPreview.swift: one explicit load admits
 * one GET of one local document in an {@link WebView} that has no NSH bridge, no arbitrary HTML,
 * no URL navigation and no network. Links, redirects, frames and popups are denied.
 *
 * <p>Android has no WKURLSchemeHandler or WKContentRuleList: the fixed document is served by
 * intercepting its own scheme, and {@link WebSettings#setBlockNetworkLoads} blocks every network
 * load instead of the iOS rule list. The document reports through a JavascriptInterface named
 * {@code YuriTerminalBridge} because {@code window.webkit.messageHandlers} is iOS-only; the fixed
 * CSP ({@code frame-src 'none'}) and the generated document bound that surface. The source frame
 * of a JavascriptInterface call cannot be observed, unlike WKScriptMessage.frameInfo.
 */
public final class NativeTerminalPreview {
    private static final String SCHEME = "yuri-terminal";
    private static final Pattern COLOR = Pattern.compile("^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$");

    static final String POLICY = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; "
            + "style-src 'unsafe-inline'; connect-src 'none'; img-src data:; font-src 'none'; "
            + "frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

    private static final String SHIM = "window.webkit={messageHandlers:{terminal:{postMessage:function(v){"
            + "YuriTerminalBridge.post(JSON.stringify(v));}}}};";

    private static final Set<String> PALETTE_KEYS = Set.of(
            "background", "foreground", "cursor", "selectionBackground", "cursorAccent", "selectionForeground",
            "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
            "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite");
    private static final Set<String> REQUIRED_PALETTE = Set.of("background", "foreground", "cursor", "selectionBackground");
    private static final String[] ASSET_PATHS = { "terminal-ghostty", "nsh/terminal-ghostty" };

    private final Activity activity;
    private final TerminalBridge bridge;
    private final NshView view;
    private final Handler main = new Handler(Looper.getMainLooper());
    private HostLease.Scope scope;
    private String pendingOwner;
    private long opening;
    private Surface surface;
    private Dialog dialog;

    public NativeTerminalPreview(Activity activity, TerminalBridge bridge, NshView view) {
        this.activity = activity;
        this.bridge = bridge;
        this.view = view;
    }

    public void install() {
        view.handle("terminal.preview.open", (data, reply) -> {
            try {
                open(TerminalBridge.object(data), reply);
            } catch (TerminalFailure failure) {
                reply.reject(failure.code);
            }
        });
        view.handle("terminal.preview.render", (data, reply) -> {
            try {
                Map<String, Object> value = TerminalBridge.object(data);
                Surface current = surface;
                if (current == null || !current.owner.equals(value.get("owner")) || scope == null) {
                    throw TerminalFailure.of("stale");
                }
                HostLease.Scope expected = TerminalBridge.scope(value.get("expectedHost"));
                if (!expected.equals(scope)) throw TerminalFailure.of("stale");
                bridge.admitted(scope);
                current.update(value);
                reply.resolve(true);
            } catch (TerminalFailure failure) {
                reply.reject(failure.code);
            }
        });
        view.handle("terminal.preview.finish", (data, reply) -> {
            Object owner = data instanceof Map ? ((Map<?, ?>) data).get("owner") : null;
            if (owner instanceof String) {
                if (owner.equals(pendingOwner)) {
                    opening++;
                    pendingOwner = null;
                }
                if (surface != null && owner.equals(surface.owner)) finish();
            }
            reply.resolve(true);
        });
    }

    public void invalidate() {
        opening++;
        pendingOwner = null;
        finish();
    }

    private void open(Map<String, Object> body, com.longbridge.nsh.NshHostReply reply) throws TerminalFailure {
        HostLease.Scope expected = TerminalBridge.scope(body.get("expectedHost"));
        TerminalTransport transport = bridge.admitted(expected);
        if (activity.isFinishing() || (android.os.Build.VERSION.SDK_INT >= 17 && activity.isDestroyed())) {
            throw TerminalFailure.of("unavailable");
        }
        if (dialog != null || surface != null || pendingOwner != null) throw TerminalFailure.of("unavailable");
        Object owner = body.get("owner");
        if (!(owner instanceof String) || !TerminalProtocol.identifier((String) owner)) throw TerminalFailure.of("unavailable");
        Map<String, Object> palette = palette(body.get("palette"));
        Object familyValue = body.get("fontFamily");
        Object labelValue = body.get("inputLabel");
        Object sizeValue = body.get("fontSize");
        if (!(familyValue instanceof String) || !(labelValue instanceof String) || !(sizeValue instanceof Number)) {
            throw TerminalFailure.of("unavailable");
        }
        double size = ((Number) sizeValue).doubleValue();
        String family = (String) familyValue;
        String label = (String) labelValue;
        final String surfaceOwner = (String) owner;
        final long token = ++opening;
        pendingOwner = surfaceOwner;
        // The renderer assets are read and the fixed document is built off the UI thread.
        Thread loader = new Thread(() -> {
            String document;
            try {
                document = Document.render(asset(".js", 4_000_000), asset(".wasm", 1_500_000), palette, family, size, label);
            } catch (TerminalFailure failure) {
                main.post(() -> failOpen(token, reply, failure.code));
                return;
            } catch (IOException error) {
                main.post(() -> failOpen(token, reply, "unavailable"));
                return;
            }
            final String built = document;
            main.post(() -> {
                if (opening != token || !surfaceOwner.equals(pendingOwner) || dialog != null || surface != null
                        || !bridge.isForeground()) {
                    reply.reject("stale");
                    return;
                }
                try {
                    show(surfaceOwner, expected, built, transport);
                    reply.resolve(true);
                } catch (TerminalFailure failure) {
                    reply.reject(failure.code);
                } catch (RuntimeException error) {
                    reply.reject("unavailable");
                }
            });
        }, "yuri-terminal-preview-loader");
        loader.setDaemon(true);
        loader.start();
    }

    private void failOpen(long token, com.longbridge.nsh.NshHostReply reply, String code) {
        if (opening == token) pendingOwner = null;
        reply.reject(code);
    }

    private void show(String owner, HostLease.Scope expected, String document, TerminalTransport transport) throws TerminalFailure {
        Surface page = new Surface(owner, expected, document, transport);
        scope = expected;
        surface = page;
        pendingOwner = null;
        try {
            page.show();
        } catch (RuntimeException error) {
            finish();
            throw TerminalFailure.of("unavailable");
        }
    }

    private void finish() {
        Surface value = surface;
        if (value == null) return;
        surface = null;
        HostLease.Scope expected = scope;
        scope = null;
        value.stop();
        if (dialog != null) {
            Dialog closing = dialog;
            dialog = null;
            closing.dismiss();
        }
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", "closed");
        event.put("owner", value.owner);
        event.put("expectedHost", expected == null ? new HashMap<>() : TerminalBridge.scopeMap(expected));
        view.send("terminal.preview.event", event);
    }

    private byte[] asset(String suffix, int limit) throws IOException {
        IOException failure = null;
        for (String prefix : ASSET_PATHS) {
            try {
                return read(activity.getAssets().open(prefix + suffix), limit);
            } catch (IOException error) {
                failure = error;
            }
        }
        throw failure == null ? new IOException("missing terminal asset") : failure;
    }

    private static byte[] read(InputStream input, int limit) throws IOException {
        try (InputStream stream = input) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = stream.read(buffer)) > 0) {
                out.write(buffer, 0, count);
                if (out.size() > limit) throw new IOException("asset too large");
            }
            return out.toByteArray();
        }
    }

    private static Map<String, Object> palette(Object value) throws TerminalFailure {
        if (!(value instanceof Map)) throw TerminalFailure.of("unavailable");
        Map<String, Object> palette = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
            String key = String.valueOf(entry.getKey());
            if (!PALETTE_KEYS.contains(key)) throw TerminalFailure.of("unavailable");
            Object color = entry.getValue();
            if (!(color instanceof String) || !COLOR.matcher((String) color).matches()) throw TerminalFailure.of("unavailable");
            palette.put(key, color);
        }
        if (!palette.keySet().containsAll(REQUIRED_PALETTE)) throw TerminalFailure.of("unavailable");
        return palette;
    }

    /** Exact document admission and renderer construction, mirrored from NativeTerminalDocument. */
    static final class Document {
        private Document() {}

        static String render(byte[] javascript, byte[] wasm, Map<String, Object> palette, String family,
                             double size, String label) throws TerminalFailure {
            if (javascript == null || javascript.length > 4_000_000) throw TerminalFailure.of("invalid");
            if (wasm == null || wasm.length > 1_500_000) throw TerminalFailure.of("invalid");
            if (wasm.length < 4 || wasm[0] != 0 || wasm[1] != 97 || wasm[2] != 115 || wasm[3] != 109) {
                throw TerminalFailure.of("invalid");
            }
            String source = new String(javascript, StandardCharsets.UTF_8);
            if (source.isEmpty()) throw TerminalFailure.of("invalid");
            if (family.isEmpty() || TerminalCatalogStore.utf8(family) > 1024) throw TerminalFailure.of("invalid");
            if (!(size >= 6 && size <= 72)) throw TerminalFailure.of("invalid");
            if (TerminalCatalogStore.utf8(label) > 1024) throw TerminalFailure.of("invalid");
            Set<?> keys = palette.keySet();
            if (!PALETTE_KEYS.containsAll(keys) || !keys.containsAll(REQUIRED_PALETTE)) throw TerminalFailure.of("invalid");
            for (Object color : palette.values()) {
                if (!(color instanceof String) || !COLOR.matcher((String) color).matches()) throw TerminalFailure.of("invalid");
            }
            String escaped = replaceIgnoreCase(source, "</script", "<\\/script");
            Map<String, Object> config = new LinkedHashMap<>();
            config.put("wasm", Base64.encodeToString(wasm, Base64.NO_WRAP));
            config.put("palette", palette);
            config.put("family", family);
            config.put("size", size);
            config.put("label", label);
            String json = json(config);
            String background = (String) palette.get("background");
            return "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1\">"
                    + "<meta http-equiv=\"Content-Security-Policy\" content=\"" + POLICY + "\">"
                    + "<style>html,body,#terminal{width:100%;height:100%;margin:0;overflow:hidden;background:" + background + "}"
                    + "#input{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:.01;font-size:16px}</style></head>"
                    + "<body><div id=\"terminal\"></div><textarea id=\"input\" autocomplete=\"off\" autocorrect=\"off\" "
                    + "autocapitalize=\"off\" spellcheck=\"false\"></textarea>"
                    + "<script>" + SHIM + "</script>"
                    + "<script>" + escaped + "</script>"
                    + "<script>" + bootstrap() + "\nstartNativeTerminal(" + json + ");</script></body></html>";
        }

        static String bootstrap() {
            StringBuilder out = new StringBuilder();
            for (String line : BOOTSTRAP_LINES) out.append(line);
            return out.toString();
        }

        static String json(Object value) {
            return TerminalProtocol.encode(value)
                    .replace("<", "\\u003c")
                    .replace("\u2028", "\\u2028")
                    .replace("\u2029", "\\u2029");
        }

        private static String replaceIgnoreCase(String value, String target, String replacement) {
            StringBuilder out = new StringBuilder();
            String lowerValue = value.toLowerCase(Locale.ROOT);
            String lowerTarget = target.toLowerCase(Locale.ROOT);
            int index = 0;
            int found;
            while ((found = lowerValue.indexOf(lowerTarget, index)) >= 0) {
                out.append(value, index, found).append(replacement);
                index = found + target.length();
            }
            return out.append(value.substring(index)).toString();
        }
    }

    static final String[] BOOTSTRAP_LINES = {
        "async function startNativeTerminal(config) {\n",
        "  const post = value => window.webkit.messageHandlers.terminal.postMessage(value);\n",
        "  try {\n",
        "    window.open = () => null;\n",
        "    const bytes = Uint8Array.from(atob(config.wasm), c => c.charCodeAt(0));\n",
        "    const module = await WebAssembly.compile(bytes);\n",
        "    const instance = await WebAssembly.instantiate(module, {env:{log(){}}});\n",
        "    const terminal = new GhosttyWeb.Terminal({ghostty:new GhosttyWeb.Ghostty(instance),disableStdin:true,fontFamily:config.family,fontSize:config.size,theme:config.palette,scrollback:10000,cursorBlink:false});\n",
        "    const fit = new GhosttyWeb.FitAddon(); terminal.loadAddon(fit); terminal.open(document.getElementById('terminal'));\n",
        "    window.terminalFontPreferences = value => {\n",
        "      if(!value || !Number.isFinite(value.fontSize) || value.fontSize < 9 || value.fontSize > 52 || typeof value.fontFamily !== 'string' || !value.fontFamily.length || value.fontFamily.length > 1024)throw new Error('invalid_font_preferences');\n",
        "      if(terminal.options.fontSize === value.fontSize && terminal.options.fontFamily === value.fontFamily)return;\n",
        "      if(terminal.options.fontSize !== value.fontSize)terminal.options.fontSize = value.fontSize;\n",
        "      if(terminal.options.fontFamily !== value.fontFamily)terminal.options.fontFamily = value.fontFamily;\n",
        "      resize();\n",
        "    };\n",
        "    const input = document.getElementById('input'); input.setAttribute('aria-label',config.label);\n",
        "    let key = '', cursor = 0, live = false, composing = false;\n",
        "    let follow = true;\n",
        "    const originalBottom = terminal.scrollToBottom.bind(terminal);\n",
        "    terminal.scrollToBottom = () => { if(follow)originalBottom(); };\n",
        "    terminal.onScroll(y => { follow = !terminal.hasSelection() && y <= .5; });\n",
        "    terminal.onSelectionChange(() => { follow = !terminal.hasSelection() && terminal.getViewportY() <= .5; });\n",
        "    const queue = []; let queuedBytes = 0, receipt = 0, blocked = false;\n",
        "    const drafts = new Map(), rejectedKeys = new Set();\n",
        "    const byteLength = text => { let n=0;for(const point of text){const c=point.codePointAt(0);n+=c<=127?1:c<=2047?2:c<=65535?3:4;}return n; };\n",
        "    const reject = code => post({type:'inputRejected',key,code});\n",
        "    const retain = items => {\n",
        "      const prefixes = new Map();\n",
        "      for(const item of items)prefixes.set(item.key,(prefixes.get(item.key)||'')+item.retained);\n",
        "      for(const [owner,text] of prefixes){\n",
        "        if(owner===key)input.value=text+input.value;\n",
        "        else drafts.set(owner,text+(drafts.get(owner)||''));\n",
        "      }\n",
        "    };\n",
        "    const removeQueued = predicate => {\n",
        "      const removed=[];\n",
        "      for(let i=0;i<queue.length;){\n",
        "        const item=queue[i];\n",
        "        if(predicate(item)){removed.push(item);queuedBytes-=item.size;queue.splice(i,1);}else i++;\n",
        "      }\n",
        "      return removed;\n",
        "    };\n",
        "    const pump = () => {\n",
        "      const item=queue[0];if(!live||blocked||rejectedKeys.has(key)||!item||item.sent||item.key!==key)return;\n",
        "      item.sent=true;post({type:'input',key:item.key,data:item.data,receipt:item.receipt});\n",
        "    };\n",
        "    const send = (data, retained=data) => {\n",
        "      if(!data)return true;\n",
        "      const size=byteLength(data);\n",
        "      if(!live||blocked||rejectedKeys.has(key)||size>65536||queue.length>=4||queuedBytes+size>262144){reject(blocked?'input_unknown':rejectedKeys.has(key)?'input_not_accepted':size>65536?'input_too_large':'input_backpressure');return false;}\n",
        "      queue.push({key,data,retained,size,receipt:++receipt,sent:false});queuedBytes+=size;pump();return true;\n",
        "    };\n",
        "    window.terminalInputResult = value => {\n",
        "      const item=queue[0];if(blocked||!item||!item.sent||value.key!==item.key||value.receipt!==item.receipt)return;\n",
        "      if(value.status==='accepted'){queue.shift();queuedBytes-=item.size;pump();return;}\n",
        "      if(value.status!=='rejected'&&value.status!=='unknown')return;\n",
        "      // Restore only each receipt's original Tab; prefix preserved text to\n",
        "      // newer edits instead of replacing them. Unknown halts the whole lane.\n",
        "      if(value.status==='unknown'){\n",
        "        blocked=true;retain(removeQueued(()=>true));reject('input_unknown');\n",
        "      }else{\n",
        "        rejectedKeys.add(item.key);retain(removeQueued(pending=>pending.key===item.key));\n",
        "        if(item.key===key)reject('input_not_accepted');\n",
        "        pump();\n",
        "      }\n",
        "    };\n",
        "    terminal.onData(send);\n",
        "    input.addEventListener('compositionstart',()=>{composing=true;});\n",
        "    input.addEventListener('compositionend',()=>{composing=false;if(send(input.value))input.value='';});\n",
        "    input.addEventListener('input',event=>{if(!composing&&!event.isComposing){if(send(input.value))input.value='';}});\n",
        "    input.addEventListener('paste',event=>{\n",
        "      if(composing)return;\n",
        "      const text=event.clipboardData?.getData('text')||'';if(!text)return;\n",
        "      event.preventDefault();event.stopPropagation();\n",
        "      const payload=terminal.hasBracketedPaste()?'\\x1b[200~'+text+'\\x1b[201~':text;\n",
        "      if(!send(payload,text))input.value+=text;\n",
        "    });\n",
        "    input.addEventListener('beforeinput',event=>{\n",
        "      if(composing||event.isComposing)return;\n",
        "      if(input.value)return;\n",
        "      if(event.inputType==='deleteContentBackward'){event.preventDefault();send('\\x7f');}\n",
        "      if(event.inputType==='insertLineBreak'||event.inputType==='insertParagraph'){event.preventDefault();send('\\r');}\n",
        "    });\n",
        "    const keys={Escape:'\\x1b',Tab:'\\t',Enter:'\\r',Backspace:'\\x7f',Delete:'\\x1b[3~',Home:'\\x1b[H',End:'\\x1b[F',PageUp:'\\x1b[5~',PageDown:'\\x1b[6~',ArrowUp:'\\x1b[A',ArrowDown:'\\x1b[B',ArrowLeft:'\\x1b[D',ArrowRight:'\\x1b[C'};\n",
        "    input.addEventListener('keydown',event=>{\n",
        "      if(composing||event.isComposing||event.keyCode===229)return;\n",
        "      const letter=event.key.toLowerCase();\n",
        "      const copy=(event.metaKey&&!event.ctrlKey&&!event.altKey||event.ctrlKey&&event.shiftKey&&!event.metaKey&&!event.altKey)&&letter==='c';\n",
        "      if(copy&&terminal.hasSelection()){\n",
        "        event.preventDefault();const text=terminal.getSelection();\n",
        "        // Native copy events populate the clipboard without a PTY input.\n",
        "        const handler=e=>{e.preventDefault();e.clipboardData?.setData('text/plain',text);};\n",
        "        document.addEventListener('copy',handler);document.execCommand('copy');document.removeEventListener('copy',handler);return;\n",
        "      }\n",
        "      if(event.metaKey&&!keys[event.key])return;\n",
        "      if(input.value&&['Backspace','Delete','Enter'].includes(event.key))return;\n",
        "      if(event.ctrlKey&&!event.altKey&&/^[a-z]$/i.test(event.key)){event.preventDefault();send(String.fromCharCode(event.key.toUpperCase().charCodeAt(0)&31));}\n",
        "      else if(keys[event.key]){event.preventDefault();send(keys[event.key]);}\n",
        "    });\n",
        "    document.getElementById('terminal').addEventListener('click',()=>{if(live&&!moved)input.focus();});\n",
        "    document.addEventListener('click',event=>{if(event.target.closest&&event.target.closest('a'))event.preventDefault();},true);\n",
        "    // Same canvas scrollback mapping/kinetic constants as TerminalViewport's\n",
        "    // touch path. The document itself never scrolls and swipes don't type.\n",
        "    const container = document.getElementById('terminal');\n",
        "    let pointer = null, lastY = 0, lastTime = 0, startX = 0, startY = 0, moved = false, velocity = 0, remainder = 0, frame = null;\n",
        "    const now = () => Date.now(), lineHeight = () => Math.max(12,Math.round(terminal.options.fontSize*1.35));\n",
        "    const stopKinetic = () => { if(frame!==null)window.cancelAnimationFrame(frame);frame=null; };\n",
        "    const scrollPixels = delta => {\n",
        "      const before=terminal.getViewportY(),height=lineHeight(),total=remainder+delta,lines=Math.trunc(total/height);remainder=total-lines*height;\n",
        "      if(lines)terminal.scrollLines(lines);return terminal.getViewportY()!==before;\n",
        "    };\n",
        "    container.addEventListener('pointerdown',event=>{\n",
        "      if(event.pointerType!=='touch')return;\n",
        "      stopKinetic();pointer=event.pointerId;startX=event.clientX;startY=lastY=event.clientY;lastTime=now();velocity=0;moved=false;\n",
        "      try{container.setPointerCapture(pointer);}catch{}\n",
        "    },{passive:false});\n",
        "    container.addEventListener('pointermove',event=>{\n",
        "      if(event.pointerType!=='touch'||event.pointerId!==pointer)return;\n",
        "      if(Math.hypot(event.clientX-startX,event.clientY-startY)>=6)moved=true;\n",
        "      const current=now(),delta=lastY-event.clientY,dt=Math.max(current-lastTime,8);lastY=event.clientY;lastTime=current;\n",
        "      if(Math.abs(delta)<1)return;\n",
        "      const pixels=delta*(2.2+Math.min(2.8,Math.abs(delta)/25));velocity=Math.max(-8,Math.min(8,velocity*.75+(pixels/dt)*.25));\n",
        "      if(moved){if(event.cancelable)event.preventDefault();event.stopPropagation();}scrollPixels(pixels);\n",
        "    },{passive:false});\n",
        "    const endPointer=(event,cancelled)=>{\n",
        "      if(event.pointerId!==pointer)return;\n",
        "      try{container.releasePointerCapture(pointer);}catch{}pointer=null;\n",
        "      if(cancelled){stopKinetic();velocity=0;return;}\n",
        "      if(!moved){if(live)input.focus();return;}\n",
        "      if(Math.abs(velocity)<.05)return;\n",
        "      let last=now();const step=()=>{\n",
        "        const current=now(),dt=Math.max(current-last,8);last=current;\n",
        "        const changed=scrollPixels(velocity*dt),magnitude=Math.max(0,Math.abs(velocity)-.015*dt);velocity=Math.sign(velocity)*magnitude;\n",
        "        if(!changed||magnitude<=.05){stopKinetic();velocity=0;return;}frame=window.requestAnimationFrame(step);\n",
        "      };frame=window.requestAnimationFrame(step);\n",
        "    };\n",
        "    container.addEventListener('pointerup',event=>endPointer(event,false),{passive:false});\n",
        "    container.addEventListener('pointercancel',event=>endPointer(event,true),{passive:false});\n",
        "    const resize=()=>{fit.fit();if(terminal.cols>=2&&terminal.rows>=1)post({type:'resize',key,cols:terminal.cols,rows:terminal.rows});};\n",
        "    const observer=new ResizeObserver(resize);observer.observe(document.getElementById('terminal'));\n",
        "    window.terminalRender=value=>{\n",
        "      if(!value||value.type!=='render'||typeof value.key!=='string'||!Array.isArray(value.chunks))return;\n",
        "      // Keep exactly the in-flight receipt across a switch. Unsent old-Tab\n",
        "      // input becomes a draft and never occupies another Tab's queue head.\n",
        "      if(key!==value.key||value.live!==true)retain(removeQueued(item=>!item.sent));\n",
        "      live=value.live===true;\n",
        "      if(!live){input.blur();composing=false;stopKinetic();pointer=null;}\n",
        "      if(key!==value.key){drafts.set(key,input.value);key=value.key;input.value=drafts.get(key)||'';drafts.delete(key);cursor=0;follow=true;stopKinetic();terminal.reset();resize();}\n",
        "      const pending=value.chunks.filter(chunk=>typeof chunk.data==='string'&&chunk.id>cursor);\n",
        "      pending.forEach((chunk,index)=>{cursor=chunk.id;terminal.write(chunk.data,index===pending.length-1?()=>post({type:'ack',key:value.key,cursor:chunk.id,serial:value.serial}):undefined);});\n",
        "      if(value.focus&&live)input.focus();\n",
        "      pump();\n",
        "    };\n",
        "    window.addEventListener('pagehide',()=>{live=false;stopKinetic();observer.disconnect();terminal.dispose();});\n",
        "    post({type:'ready'});resize();\n",
        "  }catch{post({type:'error',code:'renderer_unavailable'});}\n",
        "}\n",
    };
    private final class Surface implements Runnable {
        final String owner;
        final HostLease.Scope expected;
        final String document;
        final TerminalTransport transport;
        final String entry;
        Dialog ownDialog;
        WebView web;
        LinearLayout tabs;
        LinearLayout keys;
        TextView status;
        String previousChrome = "";
        volatile boolean stopped;
        boolean loading = true;

        Surface(String owner, HostLease.Scope expected, String document, TerminalTransport transport) {
            this.owner = owner;
            this.expected = expected;
            this.document = document;
            this.transport = transport;
            this.entry = SCHEME + "://" + java.util.UUID.randomUUID().toString().toLowerCase(Locale.ROOT) + "/index.html";
        }

        @Override public void run() {
            // Dialog dismissal (back press, window close) ends the same generation.
            finish();
        }

        boolean current() {
            return !stopped && surface == this && expected.equals(scope) && bridge.isForeground()
                    && transport.isCurrent() && !activity.isFinishing();
        }

        void show() {
            LinearLayout root = new LinearLayout(activity);
            root.setOrientation(LinearLayout.VERTICAL);
            root.setBackgroundColor(Color.WHITE);

            LinearLayout bar = new LinearLayout(activity);
            bar.setOrientation(LinearLayout.HORIZONTAL);
            tabs = new LinearLayout(activity);
            tabs.setOrientation(LinearLayout.HORIZONTAL);
            HorizontalScrollView scroll = new HorizontalScrollView(activity);
            scroll.setHorizontalScrollBarEnabled(false);
            scroll.addView(tabs, new HorizontalScrollView.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            bar.addView(scroll, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            Button done = button("Done", true, NativeTerminalPreview.this::finish);
            bar.addView(done);
            root.addView(bar);

            web = new WebView(activity);
            WebSettings settings = web.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setDomStorageEnabled(false);
            settings.setSupportMultipleWindows(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setBlockNetworkLoads(true);
            settings.setMediaPlaybackRequiresUserGesture(true);
            web.setBackgroundColor(Color.TRANSPARENT);
            web.setWebViewClient(new Client());
            web.addJavascriptInterface(new JsHost(), "YuriTerminalBridge");
            root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

            status = new TextView(activity);
            status.setTextSize(12f);
            root.addView(status);

            keys = new LinearLayout(activity);
            keys.setOrientation(LinearLayout.HORIZONTAL);
            HorizontalScrollView keyScroll = new HorizontalScrollView(activity);
            keyScroll.setHorizontalScrollBarEnabled(false);
            keyScroll.addView(keys, new HorizontalScrollView.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            root.addView(keyScroll);

            Dialog dialog = new Dialog(activity);
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
            dialog.setContentView(root);
            Window window = dialog.getWindow();
            if (window != null) {
                window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
                window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            }
            dialog.setOnDismissListener(ignored -> finish());
            ownDialog = dialog;
            NativeTerminalPreview.this.dialog = dialog;
            dialog.show();
            web.loadUrl(entry);
        }

        private Button button(String title, boolean enabled, Runnable action) {
            Button control = new Button(activity);
            control.setText(title);
            control.setAllCaps(false);
            control.setTextSize(13f);
            control.setEnabled(enabled);
            control.setBackgroundColor(enabled ? 0xFFEDEDED : 0xFFF6F6F6);
            control.setOnClickListener(ignored -> {
                if (!stopped) action.run();
            });
            return control;
        }

        void update(Map<String, Object> value) throws TerminalFailure {
            Object fontPreferences = value.get("fontPreferences");
            if (fontPreferences instanceof Map) {
                Map<?, ?> preferences = (Map<?, ?>) fontPreferences;
                Object size = preferences.get("fontSize");
                Object family = preferences.get("fontFamily");
                if (!(size instanceof Number)) throw TerminalFailure.of("invalid");
                double number = ((Number) size).doubleValue();
                if (Double.isNaN(number) || Double.isInfinite(number) || number < 9 || number > 52) {
                    throw TerminalFailure.of("invalid");
                }
                if (!(family instanceof String) || ((String) family).isEmpty() || TerminalCatalogStore.utf8((String) family) > 1024) {
                    throw TerminalFailure.of("invalid");
                }
                if (!current()) throw TerminalFailure.of("stale");
                call("window.terminalFontPreferences(" + Document.json(preferences) + ")");
                return;
            }
            Object inputResult = value.get("inputResult");
            if (inputResult instanceof Map) {
                Map<?, ?> result = (Map<?, ?>) inputResult;
                Object key = result.get("key");
                Long receipt = TerminalProtocol.integer(result.get("receipt"));
                Object outcome = result.get("status");
                if (!(key instanceof String) || !TerminalProtocol.identifier((String) key)) throw TerminalFailure.of("invalid");
                if (receipt == null || receipt <= 0) throw TerminalFailure.of("invalid");
                if (!(outcome instanceof String) || !Set.of("accepted", "rejected", "unknown").contains(outcome)) {
                    throw TerminalFailure.of("invalid");
                }
                if (!current()) throw TerminalFailure.of("stale");
                call("window.terminalInputResult(" + Document.json(result) + ")");
                return;
            }
            if (!current()) throw TerminalFailure.of("stale");
            Object renderValue = value.get("render");
            if (!(renderValue instanceof Map)) throw TerminalFailure.of("invalid");
            Map<?, ?> render = (Map<?, ?>) renderValue;
            Object key = render.get("key");
            if (!(key instanceof String) || TerminalCatalogStore.utf8((String) key) > 128) throw TerminalFailure.of("invalid");
            Object chunks = render.get("chunks");
            if (!(chunks instanceof List) || ((List<?>) chunks).size() > 65_536) throw TerminalFailure.of("invalid");
            for (Object raw : (List<?>) chunks) {
                if (!(raw instanceof Map)) throw TerminalFailure.of("invalid");
                Object data = ((Map<?, ?>) raw).get("data");
                if (!(data instanceof String) || TerminalCatalogStore.utf8((String) data) > TerminalProtocol.MESSAGE_LIMIT) {
                    throw TerminalFailure.of("invalid");
                }
                if (TerminalProtocol.integer(((Map<?, ?>) raw).get("id")) == null) throw TerminalFailure.of("invalid");
            }
            Object rowsValue = value.get("tabs");
            if (!(rowsValue instanceof List) || ((List<?>) rowsValue).size() > 64) throw TerminalFailure.of("invalid");
            for (Object raw : (List<?>) rowsValue) {
                if (!(raw instanceof Map)) throw TerminalFailure.of("invalid");
                Map<?, ?> row = (Map<?, ?>) raw;
                if (!(row.get("id") instanceof String) || !TerminalProtocol.identifier((String) row.get("id"))) {
                    throw TerminalFailure.of("invalid");
                }
                if (!(row.get("label") instanceof String) || TerminalCatalogStore.utf8((String) row.get("label")) > 1024) {
                    throw TerminalFailure.of("invalid");
                }
            }
            Map<String, Object> chrome = new LinkedHashMap<>(value);
            chrome.remove("render");
            String encoded = TerminalProtocol.canonical(chrome);
            if (!encoded.equals(previousChrome)) {
                previousChrome = encoded;
                rebuild(value, render, (String) key, (List<?>) rowsValue);
            }
            call("window.terminalRender(" + Document.json(render) + ")");
        }

        private void rebuild(Map<String, Object> value, Map<?, ?> render, String key, List<?> rows) {
            tabs.removeAllViews();
            boolean live = Boolean.TRUE.equals(render.get("live"));
            for (Object raw : rows) {
                Map<?, ?> row = (Map<?, ?>) raw;
                String id = (String) row.get("id");
                String label = (String) row.get("label");
                Button choose = button(label, true, () -> emit("select", id));
                if (id.equals(key)) choose.setBackgroundColor(0xFFDDDDDD);
                tabs.addView(choose);
                Object close = value.get("closeLabel");
                if (close instanceof String) {
                    Button remove = button("×", true, () -> emit("closeTab", id));
                    remove.setContentDescription((String) close);
                    tabs.addView(remove);
                }
            }
            if (value.get("newLabel") instanceof String) {
                Button add = button("＋", true, () -> emit("newTab", null));
                add.setContentDescription((String) value.get("newLabel"));
                tabs.addView(add);
            }
            if (value.get("previewLabel") instanceof String && Boolean.TRUE.equals(value.get("hasPreview"))) {
                tabs.addView(button((String) value.get("previewLabel"), true, () -> emit("preview", key)));
            }
            if (value.get("retryLabel") instanceof String) {
                tabs.addView(button((String) value.get("retryLabel"), true, () -> emit("retry", null)));
            }
            if (value.get("restartLabel") instanceof String) {
                tabs.addView(button((String) value.get("restartLabel"), true, () -> emit("restart", null)));
            }
            keys.removeAllViews();
            Object items = value.get("keys");
            if (items instanceof List) {
                for (Object raw : (List<?>) items) {
                    if (!(raw instanceof Map)) continue;
                    Map<?, ?> item = (Map<?, ?>) raw;
                    Object label = item.get("label");
                    Object itemKey = item.get("key");
                    if (!(label instanceof String) || !(itemKey instanceof String)) continue;
                    Button control = button((String) label, live, () -> emit("key", (String) itemKey));
                    if (itemKey.equals(value.get("modifier"))) control.setBackgroundColor(0xFFDDDDDD);
                    keys.addView(control);
                }
            }
            Object actions = value.get("actions");
            if (actions instanceof List) {
                for (Object raw : (List<?>) actions) {
                    if (!(raw instanceof Map)) continue;
                    Map<?, ?> action = (Map<?, ?>) raw;
                    Object id = action.get("id");
                    Object name = action.get("name");
                    if (!(id instanceof String) || !(name instanceof String)) continue;
                    keys.addView(button((String) name, true, () -> emit("action", (String) id)));
                }
            }
            Object activeAction = value.get("activeAction");
            Object stopLabel = value.get("stopLabel");
            if (activeAction instanceof String && stopLabel instanceof String) {
                keys.addView(button((String) stopLabel, true, () -> emit("stopAction", (String) activeAction)));
            }
            Object text = value.get("status");
            status.setText(text instanceof String ? (String) text : "");
        }

        /** Emits one chrome event with this generation's owner and scope. */
        void emit(String type, String id) {
            if (!current()) return;
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("type", type);
            if (id != null) event.put("id", id);
            event.put("owner", owner);
            event.put("expectedHost", TerminalBridge.scopeMap(expected));
            view.send("terminal.preview.event", event);
        }

        void receive(String json) {
            if (stopped || !current()) return;
            Object parsed = TerminalJson.parse(json);
            if (!(parsed instanceof Map)) return;
            Map<String, Object> value = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) parsed).entrySet()) value.put(String.valueOf(entry.getKey()), entry.getValue());
            Object type = value.get("type");
            if ("rendererFailed".equals(type)) {
                Map<String, Object> event = new LinkedHashMap<>();
                event.put("type", "error");
                event.put("code", "renderer_failed");
                event.put("owner", owner);
                event.put("expectedHost", TerminalBridge.scopeMap(expected));
                view.send("terminal.preview.event", event);
                return;
            }
            if (!(type instanceof String)) return;
            if (!Set.of("ready", "input", "inputRejected", "resize", "ack", "error").contains(type)) return;
            if ("input".equals(type)) {
                Object data = value.get("data");
                Long receipt = TerminalProtocol.integer(value.get("receipt"));
                if (!(data instanceof String) || TerminalCatalogStore.utf8((String) data) > TerminalProtocol.INPUT_LIMIT) return;
                if (receipt == null || receipt <= 0) return;
            }
            value.put("owner", owner);
            value.put("expectedHost", TerminalBridge.scopeMap(expected));
            view.send("terminal.preview.event", value);
        }

        private void call(String expression) {
            WebView target = web;
            if (target == null) return;
            String script = "(function(){try{" + expression + "}catch(e){"
                    + "if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.terminal)"
                    + "window.webkit.messageHandlers.terminal.postMessage({type:'rendererFailed'});}})()";
            target.evaluateJavascript(script, null);
        }

        void stop() {
            stopped = true;
            WebView target = web;
            web = null;
            if (target == null) return;
            target.stopLoading();
            target.removeJavascriptInterface("YuriTerminalBridge");
            target.setWebViewClient(new WebViewClient());
            ViewGroup parent = (ViewGroup) target.getParent();
            if (parent != null) parent.removeView(target);
            target.destroy();
        }

        private final class Client extends WebViewClient {
            @Override public boolean shouldOverrideUrlLoading(WebView target, WebResourceRequest request) {
                if (!current()) return true;
                boolean mainFrame = request.isForMainFrame();
                boolean get = "GET".equalsIgnoreCase(request.getMethod());
                boolean entryLoad = request.getUrl() != null && sameEntry(request.getUrl().toString());
                boolean allow = get && mainFrame && entryLoad && loading;
                if (allow) loading = false;
                return !allow;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView target, WebResourceRequest request) {
                if (!current() || request.getUrl() == null || !sameEntry(request.getUrl().toString())
                        || !"GET".equalsIgnoreCase(request.getMethod())) {
                    return blocked();
                }
                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Type", "text/html; charset=utf-8");
                headers.put("Content-Security-Policy", POLICY);
                headers.put("Cache-Control", "no-store");
                headers.put("X-Content-Type-Options", "nosniff");
                return new WebResourceResponse("text/html", "utf-8", 200, "OK", headers,
                        new ByteArrayInputStream(document.getBytes(StandardCharsets.UTF_8)));
            }

            @Override public void onPageFinished(WebView target, String url) {
                loading = false;
            }

            @Override public void onReceivedError(WebView target, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (stopped || request == null || !request.isForMainFrame()) return;
                Map<String, Object> event = new LinkedHashMap<>();
                event.put("type", "error");
                event.put("code", "renderer_failed");
                event.put("owner", owner);
                event.put("expectedHost", TerminalBridge.scopeMap(expected));
                view.send("terminal.preview.event", event);
            }

            @Override public boolean onRenderProcessGone(WebView target, android.webkit.RenderProcessGoneDetail detail) {
                if (!stopped) {
                    Map<String, Object> event = new LinkedHashMap<>();
                    event.put("type", "error");
                    event.put("code", "renderer_failed");
                    event.put("owner", owner);
                    event.put("expectedHost", TerminalBridge.scopeMap(expected));
                    view.send("terminal.preview.event", event);
                }
                NativeTerminalPreview.this.finish();
                return true;
            }

            private boolean sameEntry(String url) {
                return url.equals(entry);
            }

            private WebResourceResponse blocked() {
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-store");
                return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", headers,
                        new ByteArrayInputStream(new byte[0]));
            }
        }

        private final class JsHost {
            @JavascriptInterface public void post(String json) {
                main.post(() -> {
                    if (!stopped) receive(json);
                });
            }
        }
    }
}
