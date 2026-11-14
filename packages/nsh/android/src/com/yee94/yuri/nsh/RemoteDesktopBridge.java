package com.yee94.yuri.nsh;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.ConnectivityManager;
import android.net.Network;
import android.util.Base64;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Ported from RemoteDesktopBridge in ios/RemoteDesktopBridge.swift. Native capture receiver only:
 * no permission prompts, Host settings writes, WebView, stored credential, frame persistence or
 * input replay. A frame is acknowledged only after {@link BitmapFactory} decoded it.
 *
 * <p>Reachability uses {@link ConnectivityManager} instead of NWPathMonitor and falls back to
 * "online" when the host app holds no ACCESS_NETWORK_STATE; the retry/backoff contract is unchanged.
 */
public final class RemoteDesktopBridge {
    private static final Pattern OWNER = Pattern.compile("^desktop-[0-9]{1,16}$");
    private static final Set<String> TERMINAL_CODES = Set.of(
            "disabled", "unsupported", "helper_unavailable", "authentication_required", "permission_denied", "runtime_changed");

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;
    private final Object lock = new Object();
    private final ExecutorService io;
    private final ScheduledExecutorService scheduler;
    private Session session;
    private boolean foreground = true;
    private volatile boolean online = true;
    private volatile boolean destroyed;
    private ConnectivityManager.NetworkCallback network;

    private static final class Session {
        final String owner;
        final RemoteDesktopTransport transport;
        final Object writeLock = new Object();
        Thread task;
        ScheduledFuture<?> heartbeat;
        ScheduledFuture<?> frameDeadline;
        int queued;
        RemoteDesktopTransport.Socket socket;
        long attempt;
        String attemptError;
        long frameSequence;
        Long pendingFrame;
        boolean live;
        int failures;
        boolean desiredZoom;
        boolean sentZoom;
        boolean zoomSupported;
        boolean syncingZoom;
        boolean fallback;
        boolean terminal;
        int inputCount;
        long inputWindow;
        long startupDeadline;

        Session(String owner, RemoteDesktopTransport transport, boolean zoomed) {
            this.owner = owner;
            this.transport = transport;
            this.desiredZoom = zoomed;
        }
    }

    private static final class Decoded {
        final int width;
        final int height;
        final String source;

        Decoded(int width, int height, String source) {
            this.width = width;
            this.height = height;
            this.source = source;
        }
    }

    public RemoteDesktopBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
        this.io = Executors.newCachedThreadPool(daemon("yuri-desktop"));
        this.scheduler = Executors.newScheduledThreadPool(2, daemon("yuri-desktop-scheduler"));
        observeReachability();
    }

    private static ThreadFactory daemon(String name) {
        return runnable -> {
            Thread thread = new Thread(runnable, name);
            thread.setDaemon(true);
            return thread;
        };
    }

    public void install() {
        view.handle("remoteDesktop.open", (data, reply) -> dispatch(() -> {
            open(data);
            return true;
        }, reply));
        view.handle("remoteDesktop.close", (data, reply) -> dispatch(() -> {
            Object owner = data instanceof Map ? ((Map<?, ?>) data).get("owner") : null;
            Session value;
            synchronized (lock) {
                value = session;
            }
            if (value != null && owner instanceof String && owner.equals(value.owner)) stopSession();
            return true;
        }, reply));
        view.handle("remoteDesktop.input", (data, reply) -> dispatch(() -> {
            Session value = owned(data);
            boolean live;
            synchronized (lock) {
                live = value.live;
            }
            if (!live) throw RemoteDesktopFailure.of("connection_failed");
            long now = System.nanoTime() / 1_000_000_000L;
            Map<String, Object> message;
            long attempt;
            synchronized (lock) {
                if (now - value.inputWindow >= 1) {
                    value.inputWindow = now;
                    value.inputCount = 0;
                }
                value.inputCount++;
                if (value.inputCount > 128) throw RemoteDesktopFailure.of("rate_limited");
                attempt = value.attempt;
            }
            message = projectInput(data);
            send(message, value, attempt);
            return true;
        }, reply));
        view.handle("remoteDesktop.view", (data, reply) -> dispatch(() -> {
            Session value = owned(data);
            Boolean zoomed = booleanValue(data instanceof Map ? ((Map<?, ?>) data).get("zoomed") : null);
            if (zoomed == null) throw RemoteDesktopFailure.of("invalid_message");
            long attempt;
            synchronized (lock) {
                value.desiredZoom = zoomed;
                attempt = value.attempt;
            }
            syncZoom(value, attempt);
            return true;
        }, reply));
        view.handle("remoteDesktop.ack", (data, reply) -> dispatch(() -> {
            Session value = owned(data);
            long attempt;
            Object frameValue = data instanceof Map ? ((Map<?, ?>) data).get("frame") : null;
            synchronized (lock) {
                attempt = value.attempt;
                Double frame = number(frameValue);
                if (frame == null || Math.rint(frame) != frame) throw RemoteDesktopFailure.of("invalid_message");
                if (value.pendingFrame == null || value.pendingFrame.doubleValue() != frame) {
                    throw RemoteDesktopFailure.of("invalid_message");
                }
                value.pendingFrame = null;
                if (value.frameDeadline != null) {
                    value.frameDeadline.cancel(false);
                    value.frameDeadline = null;
                }
            }
            send(Map.of("type", "ack"), value, attempt);
            if (!current(value, attempt)) throw RemoteDesktopFailure.of("connection_failed");
            boolean becameLive = false;
            synchronized (lock) {
                value.failures = 0;
                if (!value.live) {
                    value.live = true;
                    becameLive = true;
                }
            }
            if (becameLive) state(value, "live", null);
            return true;
        }, reply));
    }

    /** onResume/onPause. */
    public void setForeground(boolean active) {
        if (destroyed) return;
        boolean changed;
        synchronized (lock) {
            changed = foreground != active;
            foreground = active;
        }
        if (!changed) return;
        if (active) foreground();
        else background();
    }

    public void invalidate() {
        destroyed = true;
        ConnectivityManager manager = (ConnectivityManager) activity.getSystemService(Activity.CONNECTIVITY_SERVICE);
        ConnectivityManager.NetworkCallback registered = network;
        network = null;
        if (manager != null && registered != null) {
            try {
                manager.unregisterNetworkCallback(registered);
            } catch (RuntimeException ignored) {
                // The callback may already be gone with the process.
            }
        }
        Session value;
        synchronized (lock) {
            value = session;
        }
        if (value == null) return;
        state(value, "closed", "runtime_changed");
        stopSession();
    }

    private void open(Object data) throws RemoteDesktopFailure {
        synchronized (lock) {
            if (destroyed || !foreground) throw RemoteDesktopFailure.of("invalid_message");
            if (session != null) throw RemoteDesktopFailure.of("occupied");
        }
        if (!(data instanceof Map)) throw RemoteDesktopFailure.of("invalid_message");
        Map<?, ?> args = (Map<?, ?>) data;
        Object owner = args.get("owner");
        if (!(owner instanceof String) || !OWNER.matcher((String) owner).matches()) {
            throw RemoteDesktopFailure.of("invalid_message");
        }
        Boolean zoomed = booleanValue(args.get("zoomed"));
        if (zoomed == null) throw RemoteDesktopFailure.of("invalid_message");
        RemoteDesktopTransport transport;
        try {
            HostLease lease = leases.capture(null);
            if (lease == null) throw RemoteDesktopFailure.of("authentication_required");
            transport = RemoteDesktopTransport.of(lease);
        } catch (RemoteDesktopFailure failure) {
            throw failure;
        } catch (Exception error) {
            throw RemoteDesktopFailure.of("authentication_required");
        }
        if (transport == null || !transport.isCurrent()) throw RemoteDesktopFailure.of("connection_failed");
        Session value = new Session((String) owner, transport, zoomed);
        synchronized (lock) {
            session = value;
        }
        start(value);
    }

    private void start(Session value) {
        Thread thread = new Thread(() -> runLoop(value), "yuri-desktop-session-" + value.owner);
        thread.setDaemon(true);
        synchronized (lock) {
            if (session != value) return;
            value.task = thread;
        }
        thread.start();
    }

    private Session owned(Object data) throws RemoteDesktopFailure {
        Session value;
        synchronized (lock) {
            value = session;
        }
        Object owner = data instanceof Map ? ((Map<?, ?>) data).get("owner") : null;
        if (value == null || !(owner instanceof String) || !owner.equals(value.owner) || !value.transport.isCurrent()) {
            throw RemoteDesktopFailure.of("connection_failed");
        }
        synchronized (lock) {
            if (!foreground) throw RemoteDesktopFailure.of("connection_failed");
        }
        return value;
    }

    private boolean current(Session value, long attempt) {
        synchronized (lock) {
            return session == value && value.attempt == attempt && value.transport.isCurrent()
                    && foreground && !Thread.currentThread().isInterrupted();
        }
    }

    private void state(Session value, String phase, String code) {
        synchronized (lock) {
            if (session != value) return;
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("owner", value.owner);
        payload.put("type", "state");
        payload.put("phase", phase);
        if (code != null) payload.put("code", code);
        view.send("remoteDesktop.event", payload);
    }

    private void stopAttempt(Session value) {
        RemoteDesktopTransport.Socket socket;
        synchronized (lock) {
            value.attempt++;
            value.live = false;
            value.pendingFrame = null;
            value.syncingZoom = false;
            if (value.heartbeat != null) {
                value.heartbeat.cancel(false);
                value.heartbeat = null;
            }
            if (value.frameDeadline != null) {
                value.frameDeadline.cancel(false);
                value.frameDeadline = null;
            }
            value.queued = 0;
            socket = value.socket;
            value.socket = null;
        }
        if (socket != null) socket.close();
    }

    private void failAttempt(Session value, long attempt, String code) {
        RemoteDesktopTransport.Socket socket;
        synchronized (lock) {
            if (!current(value, attempt)) return;
            value.attemptError = code;
            value.live = false;
            socket = value.socket;
        }
        if (socket != null) socket.close();
    }

    private void stopSession() {
        Session value;
        synchronized (lock) {
            value = session;
            session = null;
        }
        if (value == null) return;
        Thread task;
        synchronized (lock) {
            task = value.task;
            value.task = null;
        }
        if (task != null) task.interrupt();
        stopAttempt(value);
    }

    private void background() {
        Session value;
        synchronized (lock) {
            value = session;
        }
        if (value == null) return;
        if (!value.terminal) state(value, "paused", null);
        Thread task;
        synchronized (lock) {
            task = value.task;
            value.task = null;
        }
        if (task != null) task.interrupt();
        stopAttempt(value);
    }

    private void foreground() {
        Session value;
        synchronized (lock) {
            value = session;
        }
        // The native boundary also recovers if the app was suspended before handling its
        // background effect. It never revives an explicitly denied session.
        if (value == null || value.task != null || value.terminal) return;
        if (!value.transport.isCurrent()) {
            invalidate();
            return;
        }
        start(value);
    }

    private void runLoop(Session value) {
        String lastError = null;
        try {
            while (!Thread.currentThread().isInterrupted()) {
                synchronized (lock) {
                    if (session != value) break;
                }
                if (!value.transport.isCurrent()) {
                    synchronized (lock) {
                        value.terminal = true;
                    }
                    state(value, "closed", "runtime_changed");
                    break;
                }
                if (!online) {
                    state(value, "closed", lastError == null ? "connection_failed" : lastError);
                    if (!retryWait(value, 60)) break;
                    continue;
                }
                long attempt;
                synchronized (lock) {
                    attempt = value.attempt;
                    value.attemptError = null;
                    value.fallback = false;
                    value.zoomSupported = false;
                    value.sentZoom = false;
                }
                state(value, "connecting", lastError);
                try {
                    RemoteDesktopTransport.Response capability = value.transport.capability();
                    if (!current(value, attempt)) break;
                    if (capability.status == 401 || capability.status == 403) {
                        throw RemoteDesktopFailure.of("authentication_required");
                    }
                    if (capability.status == 501) throw RemoteDesktopFailure.of("unsupported");
                    Boolean supported = booleanValue(capability.body.get("supported"));
                    Boolean enabled = booleanValue(capability.body.get("enabled"));
                    if (capability.status != 200 || supported == null || enabled == null) {
                        throw RemoteDesktopFailure.of("connection_failed");
                    }
                    if (!supported) throw RemoteDesktopFailure.of("unsupported");
                    if (!enabled) throw RemoteDesktopFailure.of("disabled");
                    long deadline;
                    synchronized (lock) {
                        value.startupDeadline = activityUptime() + 60_000;
                        deadline = value.startupDeadline;
                    }
                    RemoteDesktopTransport.Socket socket = value.transport.open();
                    if (!current(value, attempt)) {
                        socket.close();
                        break;
                    }
                    if (activityUptime() >= deadline) {
                        socket.close();
                        throw RemoteDesktopFailure.of("connection_failed");
                    }
                    synchronized (lock) {
                        value.socket = socket;
                    }
                    heartbeat(value, attempt);
                    // No native WebRTC stack: request the Host's existing compatibility stream
                    // instead of embedding a browser peer.
                    long remaining = Math.max(1, (deadline - activityUptime()) / 1000);
                    frameDeadline(value, attempt, remaining * 1000);
                    while (current(value, attempt)) {
                        Object message = socket.receive(30_000);
                        if (!current(value, attempt)) break;
                        receive(message, value, attempt);
                    }
                    String errorCode;
                    synchronized (lock) {
                        errorCode = value.attemptError;
                    }
                    throw RemoteDesktopFailure.of(errorCode == null ? "connection_failed" : errorCode);
                } catch (RemoteDesktopFailure failure) {
                    synchronized (lock) {
                        if (session != value) return;
                    }
                    if (Thread.currentThread().isInterrupted()) return;
                    if (!value.transport.isCurrent()) {
                        synchronized (lock) {
                            value.terminal = true;
                        }
                        state(value, "closed", "runtime_changed");
                        break;
                    }
                    String code = failure.code;
                    stopAttempt(value);
                    lastError = code;
                    state(value, "closed", code);
                    if (TERMINAL_CODES.contains(code)) {
                        synchronized (lock) {
                            value.terminal = true;
                        }
                        break;
                    }
                    int failures;
                    synchronized (lock) {
                        failures = value.failures;
                    }
                    long delay = code.equals("permission_required") || !online ? 60 : Math.min(1L << Math.min(failures, 5), 30);
                    synchronized (lock) {
                        value.failures = Math.min(failures + 1, 6);
                    }
                    if (!retryWait(value, delay)) break;
                }
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        } finally {
            synchronized (lock) {
                if (value.task == Thread.currentThread()) value.task = null;
            }
            synchronized (lock) {
                boolean active = session == value;
                if (active && !Thread.currentThread().isInterrupted()) stopAttempt(value);
            }
        }
    }

    /** Interruptible retry wait; returns false when the session or thread retired. */
    private boolean retryWait(Session value, long seconds) {
        long deadline = System.currentTimeMillis() + seconds * 1000;
        while (System.currentTimeMillis() < deadline) {
            synchronized (lock) {
                if (session != value) return false;
            }
            if (Thread.currentThread().isInterrupted()) return false;
            try {
                Thread.sleep(100);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return true;
    }

    private void heartbeat(Session value, long attempt) {
        synchronized (lock) {
            if (value.heartbeat != null) value.heartbeat.cancel(false);
            value.heartbeat = scheduler.scheduleAtFixedRate(() -> {
                if (!current(value, attempt)) return;
                try {
                    send(Map.of("type", "ping"), value, attempt);
                } catch (RemoteDesktopFailure failure) {
                    failAttempt(value, attempt, "connection_failed");
                }
            }, 5, 5, TimeUnit.SECONDS);
        }
    }

    private void frameDeadline(Session value, long attempt, long millis) {
        synchronized (lock) {
            if (value.frameDeadline != null) value.frameDeadline.cancel(false);
            value.frameDeadline = scheduler.schedule(() -> failAttempt(value, attempt, "connection_failed"),
                    Math.max(1, millis), TimeUnit.MILLISECONDS);
        }
    }

    private void rearmFrameDeadline(Session value, long attempt) {
        long delay;
        synchronized (lock) {
            delay = value.live ? 15_000 : Math.min(15_000, Math.max(1, value.startupDeadline - activityUptime()));
        }
        frameDeadline(value, attempt, delay);
    }

    private void requestFallback(Session value, long attempt) throws RemoteDesktopFailure {
        synchronized (lock) {
            if (value.fallback) return;
            value.fallback = true;
        }
        send(Map.of("type", "fallback"), value, attempt);
        rearmFrameDeadline(value, attempt);
    }

    private void receive(Object message, Session value, long attempt) throws RemoteDesktopFailure, InterruptedException {
        if (message instanceof byte[]) {
            byte[] data = (byte[]) message;
            boolean fallback;
            synchronized (lock) {
                fallback = value.fallback;
            }
            synchronized (lock) {
                if (!fallback || value.pendingFrame != null) throw RemoteDesktopFailure.of("invalid_message");
            }

            if (data.length == 0 || data.length > RemoteDesktopTransport.INCOMING_LIMIT) {
                throw RemoteDesktopFailure.of("invalid_message");
            }
            Decoded decoded = decode(data);
            if (!current(value, attempt)) throw RemoteDesktopFailure.of("connection_failed");
            long sequence;
            synchronized (lock) {
                value.frameSequence++;
                value.pendingFrame = value.frameSequence;
                sequence = value.frameSequence;
            }
            rearmFrameDeadline(value, attempt);
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("owner", value.owner);
            event.put("type", "frame");
            event.put("frame", sequence);
            event.put("width", (long) decoded.width);
            event.put("height", (long) decoded.height);
            event.put("source", decoded.source);
            view.send("remoteDesktop.event", event);
            return;
        }
        if (!(message instanceof String)) throw RemoteDesktopFailure.of("invalid_message");
        String text = (String) message;
        if (text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 96 * 1024) {
            throw RemoteDesktopFailure.of("invalid_message");
        }
        Object parsed = TerminalJson.parse(text);
        if (!(parsed instanceof Map)) throw RemoteDesktopFailure.of("invalid_message");
        Object type = ((Map<?, ?>) parsed).get("type");
        if (!(type instanceof String)) throw RemoteDesktopFailure.of("invalid_message");
        if (type.equals("error")) {
            Object code = ((Map<?, ?>) parsed).get("code");
            throw RemoteDesktopFailure.of(code instanceof String ? (String) code : "connection_failed");
        }
        if (type.equals("ready")) {
            synchronized (lock) {
                value.zoomSupported = Boolean.TRUE.equals(booleanValue(((Map<?, ?>) parsed).get("zoomQuality")));
            }
            syncZoom(value, attempt);
            requestFallback(value, attempt);
        } else if (type.equals("offer") || type.equals("rtc-failed")) {
            requestFallback(value, attempt);
        } else if (!type.equals("ice") && !type.equals("pong")) {
            throw RemoteDesktopFailure.of("invalid_message");
        }
    }

    private void syncZoom(Session value, long attempt) throws RemoteDesktopFailure {
        synchronized (lock) {
            if (!value.zoomSupported || value.socket == null || value.syncingZoom) return;
            value.syncingZoom = true;
        }
        try {
            while (current(value, attempt)) {
                boolean desired;
                boolean sent;
                synchronized (lock) {
                    desired = value.desiredZoom;
                    sent = value.sentZoom;
                }
                if (desired == sent) return;
                send(Map.of("type", "view", "zoomed", desired), value, attempt);
                synchronized (lock) {
                    if (value.attempt == attempt) value.sentZoom = desired;
                }
            }
        } finally {
            synchronized (lock) {
                if (value.attempt == attempt) value.syncingZoom = false;
            }
        }
    }

    private void send(Map<String, Object> message, Session value, long attempt) throws RemoteDesktopFailure {
        synchronized (value.writeLock) {
            RemoteDesktopTransport.Socket socket;
            synchronized (lock) {
                if (!current(value, attempt) || value.socket == null || value.attemptError != null || value.queued >= 32) {
                    throw RemoteDesktopFailure.of("connection_failed");
                }
                socket = value.socket;
                value.queued++;
            }
            try {
                String text = TerminalJson.write(message);
                if (text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 96 * 1024) {
                    throw RemoteDesktopFailure.of("invalid_message");
                }
                socket.send(text);
                if (!current(value, attempt)) throw RemoteDesktopFailure.of("connection_failed");
            } catch (RemoteDesktopFailure failure) {
                failAttempt(value, attempt, "connection_failed");
                throw failure;
            } finally {
                synchronized (lock) {
                    if (value.attempt == attempt) value.queued--;
                }
            }
        }
    }

    private static Decoded decode(byte[] data) throws RemoteDesktopFailure {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
        if (!"image/jpeg".equals(bounds.outMimeType)) throw RemoteDesktopFailure.of("decode_failed");
        int width = bounds.outWidth;
        int height = bounds.outHeight;
        if (width <= 0 || height <= 0 || width > 2560 || height > 2560 || (long) width * height > 2560L * 1440) {
            throw RemoteDesktopFailure.of("decode_failed");
        }
        BitmapFactory.Options full = new BitmapFactory.Options();
        full.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bitmap = BitmapFactory.decodeByteArray(data, 0, data.length, full);
        if (bitmap == null) throw RemoteDesktopFailure.of("decode_failed");
        try {
            if (bitmap.getWidth() != width || bitmap.getHeight() != height) throw RemoteDesktopFailure.of("decode_failed");
        } finally {
            bitmap.recycle();
        }
        return new Decoded(width, height, "data:image/jpeg;base64," + Base64.encodeToString(data, Base64.NO_WRAP));
    }

    static Map<String, Object> projectInput(Object data) throws RemoteDesktopFailure {
        if (!(data instanceof Map)) throw RemoteDesktopFailure.of("invalid_message");
        Object inputValue = ((Map<?, ?>) data).get("input");
        if (!(inputValue instanceof Map)) throw RemoteDesktopFailure.of("invalid_message");
        Map<?, ?> input = (Map<?, ?>) inputValue;
        Object type = input.get("type");
        if (!(type instanceof String)) throw RemoteDesktopFailure.of("invalid_message");
        Map<String, Object> projected = new LinkedHashMap<>();
        projected.put("type", type);
        if (type.equals("release")) return projected;
        if (type.equals("pointer")) {
            Object action = input.get("action");
            Double x = number(input.get("x"));
            Double y = number(input.get("y"));
            if (!(action instanceof String) || !Set.of("move", "down", "up", "click", "right").contains(action)) {
                throw RemoteDesktopFailure.of("invalid_message");
            }
            if (x == null || y == null || x < 0 || x > 1 || y < 0 || y > 1) throw RemoteDesktopFailure.of("invalid_message");
            projected.put("action", action);
            projected.put("x", x);
            projected.put("y", y);
            return projected;
        }
        if (type.equals("scroll")) {
            Double dx = number(input.get("dx"));
            Double dy = number(input.get("dy"));
            if (dx == null || dy == null) throw RemoteDesktopFailure.of("invalid_message");
            projected.put("dx", Math.max(-1000d, Math.min(1000d, dx)));
            projected.put("dy", Math.max(-1000d, Math.min(1000d, dy)));
            return projected;
        }
        if (type.equals("text")) {
            Object text = input.get("text");
            if (!(text instanceof String) || ((String) text).isEmpty() || ((String) text).length() > 1024) {
                throw RemoteDesktopFailure.of("invalid_message");
            }
            projected.put("text", text);
            return projected;
        }
        if (type.equals("key")) {
            Object key = input.get("key");
            if (!(key instanceof String) || !Set.of("Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown",
                    "ArrowLeft", "ArrowRight", "Delete", "Home", "End", "PageUp", "PageDown").contains(key)) {
                throw RemoteDesktopFailure.of("invalid_message");
            }
            projected.put("key", key);
            return projected;
        }
        throw RemoteDesktopFailure.of("invalid_message");
    }

    private static Boolean booleanValue(Object value) {
        return value instanceof Boolean ? (Boolean) value : null;
    }

    private static Double number(Object value) {
        if (!(value instanceof Number) || value instanceof Boolean) return null;
        double result = ((Number) value).doubleValue();
        if (Double.isNaN(result) || Double.isInfinite(result)) return null;
        return result;
    }

    private static long activityUptime() {
        return android.os.SystemClock.elapsedRealtime();
    }

    private void observeReachability() {
        try {
            ConnectivityManager manager = (ConnectivityManager) activity.getSystemService(Activity.CONNECTIVITY_SERVICE);
            if (manager == null) return;
            ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network network) {
                    boolean recovered = !online;
                    online = true;
                    if (recovered) {
                        // The run loop owns the retry; wake it by clearing the socket attempt.
                        Session value;
                        synchronized (lock) {
                            value = session;
                        }
                        if (value != null) {
                            Thread task;
                            synchronized (lock) {
                                task = value.task;
                            }
                            if (task != null) task.interrupt();
                            foreground();
                        }
                    }
                }

                @Override public void onLost(Network network) {
                    online = false;
                }
            };
            manager.registerDefaultNetworkCallback(callback);
            network = callback;
            online = manager.getActiveNetwork() != null;
        } catch (RuntimeException error) {
            // Without ACCESS_NETWORK_STATE the bridge stays optimistic; retries still back off.
            online = true;
        }
    }

    private void dispatch(Call call, NshHostReply reply) {
        try {
            io.execute(() -> {
                try {
                    reply.resolve(call.run());
                } catch (RemoteDesktopFailure failure) {
                    reply.reject(failure.code);
                } catch (RuntimeException error) {
                    reply.reject("connection_failed");
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException error) {
            reply.reject("connection_failed");
        }
    }

    private interface Call {
        Object run() throws RemoteDesktopFailure;
    }
}
