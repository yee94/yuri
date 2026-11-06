package com.yuri.app;

import android.util.Base64;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.DataInputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

@CapacitorPlugin(name = "YuriGuiNetwork")
public class YuriGuiNetworkPlugin extends Plugin {
    private static final int CHUNK = 16 * 1024;
    private static final int WINDOW = 128 * 1024;
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Map<Long, Stream> streams = new ConcurrentHashMap<>();
    private final AtomicLong sequence = new AtomicLong();
    private volatile String scope;
    private volatile ServerSocket listener;
    private volatile URI relayEndpoint;
    private volatile boolean prepared;
    private boolean destroyed;
    private final List<PluginCall> prepareCalls = new ArrayList<>();
    private final Map<String, WebSocket> wires = new ConcurrentHashMap<>();
    private final OkHttpClient wireClient = new OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build();

    private static final class Stream {
        final Socket socket;
        final Semaphore opened = new Semaphore(0);
        final Semaphore credit = new Semaphore(0);
        volatile boolean closed;
        volatile boolean inputEnded;
        volatile boolean outputEnded;
        Socket direct;
        Stream(Socket socket) { this.socket = socket; }
    }

    @PluginMethod public void capabilities(PluginCall call) {
        call.resolve(new JSObject().put("supported", prepared));
    }

    @PluginMethod public synchronized void prepare(PluginCall call) {
        if (destroyed) { call.reject("closed"); return; }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            call.reject("unsupported"); return;
        }
        if (prepared) { call.resolve(); return; }
        prepareCalls.add(call);
        if (prepareCalls.size() > 1) return;
        io.execute(() -> {
            try {
                ServerSocket server = new ServerSocket(0, 32, InetAddress.getByAddress(new byte[] {127, 0, 0, 1}));
                synchronized (this) {
                    if (destroyed) { server.close(); return; }
                    listener = server;
                }
                getActivity().runOnUiThread(() -> {
                    synchronized (this) { if (destroyed || listener != server) return; }
                    try {
                        ProxyConfig config = new ProxyConfig.Builder()
                            .addProxyRule("socks://127.0.0.1:" + server.getLocalPort())
                            .removeImplicitRules()
                            .build();
                        ProxyController.getInstance().setProxyOverride(config, Runnable::run, () -> finishPrepare(null));
                    } catch (Exception error) { finishPrepare("proxy_failed"); }
                });
                while (listener == server && !server.isClosed()) {
                    Socket socket = server.accept();
                    synchronized (this) {
                        if (listener != server || streams.size() >= 32) { socket.close(); continue; }
                        long id = sequence.updateAndGet(value -> value >= 0xffffffffL ? 1 : value + 1);
                        Stream stream = new Stream(socket);
                        String owner = scope;
                        streams.put(id, stream);
                        io.execute(() -> read(owner, id, stream));
                    }
                }
            } catch (Exception error) {
                emit(scope, new JSObject().put("type", "failed"));
                finishPrepare("proxy_failed");
            }
        });
    }

    private synchronized void finishPrepare(String error) {
        prepared = error == null && listener != null && !listener.isClosed();
        for (PluginCall call : prepareCalls) {
            if (prepared) call.resolve(); else call.reject("proxy_failed");
        }
        prepareCalls.clear();
    }

    @PluginMethod public synchronized void start(PluginCall call) {
        String next = call.getString("scope");
        final URI relay;
        try {
            relay = new URI(call.getString("relayUrl", ""));
            String hostname = relay.getHost();
            if (next == null || next.isEmpty() || hostname == null || hostname.isEmpty() || hostname.contains("*")
                || !("ws".equals(relay.getScheme()) || "wss".equals(relay.getScheme()))
                || relay.getUserInfo() != null || relay.getFragment() != null) throw new Exception();
        } catch (Exception error) { call.reject("invalid_relay"); return; }
        if (!prepared) { call.reject("unsupported"); return; }
        if (scope != null) { call.reject("busy"); return; }
        scope = next; relayEndpoint = relay;
        for (Long id : streams.keySet()) close(null, id, false);
        call.resolve();
    }

    private void emit(String owner, JSObject value) {
        if (owner != null && owner.equals(scope)) notifyListeners("stream", value.put("scope", owner));
    }

    private void read(String owner, long id, Stream stream) {
        try {
            stream.socket.setTcpNoDelay(true);
            stream.socket.setSoTimeout(20000);
            DataInputStream input = new DataInputStream(stream.socket.getInputStream());
            OutputStream output = stream.socket.getOutputStream();
            if (input.readUnsignedByte() != 5) throw new Exception();
            int count = input.readUnsignedByte();
            boolean noAuth = false;
            for (int i = 0; i < count; i++) if (input.readUnsignedByte() == 0) noAuth = true;
            if (!noAuth) throw new Exception();
            output.write(new byte[] {5, 0});
            if (input.readUnsignedByte() != 5 || input.readUnsignedByte() != 1 || input.readUnsignedByte() != 0) throw new Exception();
            int kind = input.readUnsignedByte();
            int length = kind == 1 ? 4 : kind == 4 ? 16 : kind == 3 ? input.readUnsignedByte() : 0;
            if (length == 0) throw new Exception();
            byte[] address = new byte[length];
            input.readFully(address);
            String host = kind == 3 ? new String(address, StandardCharsets.UTF_8) : InetAddress.getByAddress(address).getHostAddress();
            int port = input.readUnsignedShort();
            if (owner == null) { openDirect(id, stream, host, port); return; }
            emit(owner, new JSObject().put("type", "open").put("id", id).put("hostname", host).put("port", port));
            if (!stream.opened.tryAcquire(20, TimeUnit.SECONDS) || stream.closed) throw new Exception();
            stream.socket.setSoTimeout(120000);
            while (!stream.closed && owner.equals(scope)) {
                if (!stream.credit.tryAcquire(CHUNK, 120, TimeUnit.SECONDS)) throw new Exception();
                byte[] bytes = new byte[CHUNK];
                int received = input.read(bytes);
                if (received < 0) {
                    stream.inputEnded = true;
                    emit(owner, new JSObject().put("type", "fin").put("id", id));
                    if (stream.outputEnded) close(owner, id, true);
                    return;
                }
                stream.credit.release(CHUNK - received);
                emit(owner, new JSObject().put("type", "data").put("id", id)
                    .put("data", Base64.encodeToString(bytes, 0, received, Base64.NO_WRAP)));
            }
        } catch (Exception error) { close(owner, id, true); }
    }

    private void openDirect(long id, Stream stream, String hostname, int port) throws Exception {
        Socket target = new Socket();
        synchronized (stream) {
            if (stream.closed) { target.close(); return; }
            stream.direct = target;
        }
        target.connect(new InetSocketAddress(hostname, port), 15000);
        target.setTcpNoDelay(true); target.setSoTimeout(120000);
        stream.socket.setSoTimeout(120000);
        stream.socket.getOutputStream().write(new byte[] {5, 0, 0, 1, 0, 0, 0, 0, 0, 0});
        io.execute(() -> pipeDirect(id, stream, target, false));
        pipeDirect(id, stream, target, true);
    }

    private void pipeDirect(long id, Stream stream, Socket target, boolean input) {
        Socket source = input ? stream.socket : target;
        Socket destination = input ? target : stream.socket;
        try {
            byte[] bytes = new byte[CHUNK];
            while (!stream.closed) {
                int received = source.getInputStream().read(bytes);
                if (received < 0) {
                    destination.shutdownOutput();
                    if (input) stream.inputEnded = true; else stream.outputEnded = true;
                    if (stream.inputEnded && stream.outputEnded) close(null, id, false);
                    return;
                }
                destination.getOutputStream().write(bytes, 0, received);
            }
        } catch (Exception error) { close(null, id, false); }
    }

    @PluginMethod public void send(PluginCall call) {
        String owner = call.getString("scope");
        Long id = call.getLong("id");
        String type = call.getString("type");
        if (owner == null || !owner.equals(scope) || id == null || type == null) { call.reject("closed"); return; }
        Stream stream = streams.get(id);
        if (stream == null) { call.reject("stream_closed"); return; }
        io.execute(() -> {
            try {
                if (stream.closed) throw new Exception();
                switch (type) {
                    case "opened":
                        stream.socket.getOutputStream().write(new byte[] {5, 0, 0, 1, 0, 0, 0, 0, 0, 0});
                        stream.credit.release(WINDOW);
                        stream.opened.release();
                        break;
                    case "credit":
                        int credit = call.getInt("bytes", 0);
                        if (credit <= 0 || stream.credit.availablePermits() + credit > WINDOW) throw new Exception();
                        stream.credit.release(credit);
                        break;
                    case "data":
                        byte[] bytes = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
                        if (bytes.length > CHUNK || stream.outputEnded) throw new Exception();
                        stream.socket.getOutputStream().write(bytes);
                        break;
                    case "fin":
                        stream.outputEnded = true;
                        stream.socket.shutdownOutput();
                        if (stream.inputEnded) close(owner, id, true);
                        break;
                    case "close": close(owner, id, false); break;
                    default: throw new Exception();
                }
                call.resolve();
            } catch (Exception error) { close(owner, id, true); call.reject("stream_closed"); }
        });
    }

    private void close(String owner, long id, boolean notify) {
        Stream stream = streams.remove(id);
        if (stream == null) return;
        synchronized (stream) {
            stream.closed = true;
            try { if (stream.direct != null) stream.direct.close(); } catch (Exception ignored) { }
        }
        stream.opened.release();
        stream.credit.release(CHUNK);
        try { stream.socket.close(); } catch (Exception ignored) { }
        if (notify) emit(owner, new JSObject().put("type", "close").put("id", id));
    }

    @PluginMethod public synchronized void stop(PluginCall call) {
        String owner = call.getString("scope");
        if (owner == null || !owner.equals(scope)) { call.resolve(); return; }
        releaseRelay();
        call.resolve();
    }
    private void releaseRelay() {
        String owner = scope;
        scope = null;
        relayEndpoint = null;
        for (WebSocket wire : wires.values()) wire.cancel();
        wires.clear();
        for (Long id : streams.keySet()) close(owner, id, false);
    }
    private synchronized void shutdown() {
        destroyed = true;
        releaseRelay();
        try { if (listener != null) listener.close(); } catch (Exception ignored) { }
        listener = null; prepared = false;
        finishPrepare("proxy_failed");
    }
    @PluginMethod public synchronized void connect(PluginCall call) {
        String owner = call.getString("scope");
        String id = call.getString("wireId");
        final URI url;
        try {
            url = URI.create(call.getString("url", ""));
            URI relay = relayEndpoint;
            if (owner == null || !owner.equals(scope) || id == null || id.isEmpty() || wires.containsKey(id) || wires.size() >= 4
                || relay == null || !relay.getScheme().equals(url.getScheme()) || !relay.getHost().equals(url.getHost())
                || relay.getPort() != url.getPort() || !relay.getPath().equals(url.getPath())
                || url.getUserInfo() != null || url.getFragment() != null) throw new Exception();
        } catch (Exception error) { call.reject("invalid_relay"); return; }
        WebSocket wire = wireClient.newWebSocket(new Request.Builder().url(url.toString()).build(), new WebSocketListener() {
            private boolean current(WebSocket socket) {
                synchronized (YuriGuiNetworkPlugin.this) { return owner.equals(scope) && wires.get(id) == socket; }
            }
            private void event(WebSocket socket, JSObject data) {
                if (current(socket)) notifyListeners("wire", data.put("scope", owner).put("wireId", id));
            }
            @Override public void onOpen(WebSocket socket, Response response) { event(socket, new JSObject().put("type", "open")); }
            @Override public void onMessage(WebSocket socket, String text) {
                if (text.length() > 128 * 1024) { socket.cancel(); return; }
                event(socket, new JSObject().put("type", "message").put("text", text));
            }
            @Override public void onMessage(WebSocket socket, ByteString bytes) {
                if (bytes.size() > 2 * 1024 * 1024) { socket.cancel(); return; }
                event(socket, new JSObject().put("type", "message").put("data", bytes.base64()));
            }
            @Override public void onClosing(WebSocket socket, int code, String reason) { socket.close(code, null); }
            @Override public void onClosed(WebSocket socket, int code, String reason) { end(socket, code); }
            @Override public void onFailure(WebSocket socket, Throwable error, Response response) { end(socket, 1006); }
            private void end(WebSocket socket, int code) {
                event(socket, new JSObject().put("type", "close").put("code", code));
                wires.remove(id, socket);
            }
        });
        wires.put(id, wire);
        call.resolve();
    }

    @PluginMethod public void write(PluginCall call) {
        String owner = call.getString("scope");
        String id = call.getString("wireId");
        WebSocket wire = id == null ? null : wires.get(id);
        if (owner == null || !owner.equals(scope) || wire == null || wire.queueSize() > 4 * 1024 * 1024) { call.reject("closed"); return; }
        String text = call.getString("text");
        String encoded = call.getString("data");
        boolean sent = false;
        if (text != null && text.length() <= 128 * 1024) sent = wire.send(text);
        else if (encoded != null) {
            ByteString bytes = ByteString.decodeBase64(encoded);
            if (bytes != null && bytes.size() <= 2 * 1024 * 1024) sent = wire.send(bytes);
        }
        if (sent) call.resolve(); else call.reject("wire_closed");
    }

    @PluginMethod public void disconnect(PluginCall call) {
        String owner = call.getString("scope");
        String id = call.getString("wireId");
        if (owner != null && owner.equals(scope) && id != null) {
            WebSocket wire = wires.remove(id);
            if (wire != null) wire.cancel();
        }
        call.resolve();
    }

    @Override protected void handleOnDestroy() {
        shutdown(); io.shutdownNow(); wireClient.dispatcher().executorService().shutdown(); wireClient.connectionPool().evictAll();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            ProxyController.getInstance().clearProxyOverride(Runnable::run, () -> {});
        }
    }
}
