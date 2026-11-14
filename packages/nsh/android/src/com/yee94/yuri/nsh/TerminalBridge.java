package com.yee94.yuri.nsh;

import android.app.Activity;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * Ported from TerminalBridge in ios/TerminalBridge.swift. PTY ownership only: it never opens a
 * shell, reads credentials or exposes a transport to the app. Detach and background close only
 * sockets; DELETE is exclusive to explicit terminal.close.
 *
 * <p>Host admission is delegated to {@link HostLeaseProvider}; the bridge never sees a URL or a
 * bearer. Calls run on the bridge's own I/O executor and reply from any thread, which is what
 * {@link NshHostReply} allows.
 */
public final class TerminalBridge {
    static final String[] NAMES = {
        "terminal.capabilities", "terminal.discovery.file", "terminal.discovery.port",
        "terminal.catalog.read", "terminal.catalog.write", "terminal.restore", "terminal.probe",
        "terminal.create", "terminal.attach", "terminal.detach", "terminal.input", "terminal.resize",
        "terminal.close", "terminal.forceKill",
    };

    private static final Set<String> ALLOWED_FILES = Set.of(
            "package.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "index.html");

    final Activity activity;
    final HostLeaseProvider leases;
    final NshView view;
    private final TerminalCatalogStore catalog;
    private final NativeTerminalPreview preview;
    private final Object lock = new Object();
    private final Map<String, Session> sessions = new LinkedHashMap<>();
    private final ExecutorService io;
    private final ScheduledExecutorService scheduler;
    private boolean foreground = true;
    private boolean destroyed;

    private static final class Session {
        final String owner;
        final String directory;
        final TerminalTransport transport;
        final HostLease.Scope scope;
        final Object writeLock = new Object();
        String id;
        boolean createUnknown;
        boolean closing;
        boolean missing;
        boolean bound;
        boolean exited;
        boolean sse;
        boolean preferSSE;
        boolean httpInput;
        long attempt;
        long outputID;
        long cursor;
        long attachment;
        int queuedBytes;
        TerminalTransport.Socket socket;
        Thread reader;
        Future<?> createTask;
        ScheduledFuture<?> heartbeat;
        ScheduledFuture<?> timer;

        Session(String owner, String directory, TerminalTransport transport, HostLease.Scope scope) {
            this.owner = owner;
            this.directory = directory;
            this.transport = transport;
            this.scope = scope;
        }
    }

    public TerminalBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
        this.io = Executors.newCachedThreadPool(daemon("yuri-terminal"));
        this.scheduler = Executors.newScheduledThreadPool(2, daemon("yuri-terminal-scheduler"));
        this.catalog = new TerminalCatalogStore(activity.getFilesDir());
        this.preview = new NativeTerminalPreview(activity, this, view);
    }

    /** Admission failures surface only code-shaped messages; never a transport description or URL. */
    private static String admissionCode(Exception error) {
        String message = error.getMessage();
        if (message == null || message.isEmpty() || message.length() > 64) return "unavailable";
        for (int i = 0; i < message.length(); i++) {
            char c = message.charAt(i);
            if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return "unavailable";
        }
        return message;
    }

    private static ThreadFactory daemon(String name) {
        return runnable -> {
            Thread thread = new Thread(runnable, name);
            thread.setDaemon(true);
            return thread;
        };
    }

    public void install() {
        for (String name : NAMES) {
            view.handle(name, (data, reply) -> dispatch(name, data, reply));
        }
        preview.install();
    }

    public void invalidate() {
        preview.invalidate();
        List<Session> values;
        synchronized (lock) {
            destroyed = true;
            values = new ArrayList<>(sessions.values());
            sessions.clear();
        }
        for (Session value : values) stop(value);
        io.shutdownNow();
        scheduler.shutdownNow();
    }

    /** onResume/onPause. Resume is only a demand hint; it never replays input. */
    public void setForeground(boolean active) {
        List<Session> values;
        synchronized (lock) {
            foreground = active;
            values = new ArrayList<>(sessions.values());
        }
        for (Session value : values) {
            if (value.exited || value.closing) continue;
            if (!active) {
                stop(value);
                event(value, "paused", null);
            } else {
                event(value, "resume", null);
            }
        }
    }

    /** True while the host is foreground; the preview and interactive calls require it. */
    boolean isForeground() {
        synchronized (lock) {
            return foreground && !destroyed;
        }
    }

    TerminalTransport admitted(HostLease.Scope expected) throws TerminalFailure {
        HostLease lease;
        try {
            lease = leases.capture(expected);
        } catch (TerminalFailure failure) {
            throw failure;
        } catch (Exception error) {
            throw TerminalFailure.of(admissionCode(error));
        }
        if (lease == null) throw TerminalFailure.of("unavailable");
        if (expected != null && !expected.equals(lease.scope())) throw TerminalFailure.of("stale");
        if (!lease.isCurrent()) throw TerminalFailure.of("stale");
        return TerminalTransport.of(lease);
    }

    private void dispatch(String name, Object data, NshHostReply reply) {
        Map<String, Object> body;
        try {
            body = object(data);
        } catch (TerminalFailure failure) {
            reply.reject(failure.code);
            return;
        }
        try {
            io.execute(() -> {
                try {
                    reply.resolve(call(name, body));
                } catch (TerminalFailure failure) {
                    reply.reject(failure.code);
                } catch (RuntimeException error) {
                    reply.reject("connectionFailed");
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException error) {
            reply.reject("stale");
        }
    }

    private Object call(String name, Map<String, Object> body) throws TerminalFailure {
        switch (name) {
            case "terminal.capabilities": {
                TerminalTransport transport = admitted(scope(body.get("expectedHost")));
                Map<String, Object> value = new LinkedHashMap<>();
                value.put("schema", 1L);
                value.put("wsVersion", 2L);
                value.put("wsAvailable", transport.supportsWebSocket());
                value.put("httpInput", transport.supportsHttpInput());
                value.put("sseOutput", transport.supportsEventStream());
                value.put("durableMetadata", true);
                value.put("actionDiscovery", true);
                value.put("scope", "native-opaque");
                return value;
            }
            case "terminal.discovery.file":
            case "terminal.discovery.port":
                return discovery(name, body);
            case "terminal.detach":
                return detach(body);
            case "terminal.catalog.read":
            case "terminal.catalog.write":
            case "terminal.restore":
                return catalogCall(name, body);
            case "terminal.probe":
                return probe(body);
            case "terminal.create":
                return create(body);
            default:
                break;
        }
        Session value = owned(body, !name.equals("terminal.detach") && !name.equals("terminal.close"));
        switch (name) {
            case "terminal.attach":
                return attach(body, value);
            case "terminal.input":
                return input(body, value);
            case "terminal.resize":
                return resize(body, value);
            case "terminal.close":
            case "terminal.forceKill":
                return close(name, value);
            default:
                throw TerminalFailure.of("invalid");
        }
    }

    private Object discovery(String name, Map<String, Object> body) throws TerminalFailure {
        TerminalTransport transport = admitted(scope(body.get("expectedHost")));
        if (name.equals("terminal.discovery.port")) {
            Long port = transport.freePort();
            if (!transport.isCurrent()) throw TerminalFailure.of("stale");
            return port;
        }
        Object directory = body.get("directory");
        Object file = body.get("file");
        if (!(directory instanceof String) || !TerminalProtocol.directory((String) directory)) throw TerminalFailure.of("invalid");
        if (!(file instanceof String) || !ALLOWED_FILES.contains(file)) throw TerminalFailure.of("invalid");
        String text = transport.optionalFile((String) directory, (String) file);
        if (!transport.isCurrent()) throw TerminalFailure.of("stale");
        if (text == null) return null;
        if (TerminalCatalogStore.utf8(text) > TerminalProtocol.MESSAGE_LIMIT) throw TerminalFailure.of("overflow");
        return text;
    }

    private Object detach(Map<String, Object> body) throws TerminalFailure {
        HostLease.Scope expected = scope(body.get("expectedHost"));
        Object owner = body.get("owner");
        Long attachment = TerminalProtocol.integer(body.get("attachment"));
        if (!(owner instanceof String) || !TerminalProtocol.identifier((String) owner)) throw TerminalFailure.of("invalid");
        if (attachment == null || attachment <= 0) throw TerminalFailure.of("invalid");
        Session value;
        synchronized (lock) {
            value = sessions.get(owner);
            if (value == null || !value.scope.equals(expected) || attachment != value.attachment) return true;
        }
        stop(value);
        return true;
    }

    private Object catalogCall(String name, Map<String, Object> body) throws TerminalFailure {
        HostLease.Scope expected = scope(body.get("expectedHost"));
        TerminalTransport transport = admitted(expected);
        if (name.equals("terminal.catalog.read")) return catalog.read(expected.hostID);
        if (name.equals("terminal.catalog.write")) {
            Object raw = body.get("catalog");
            if (!(raw instanceof Map)) throw TerminalFailure.of("invalid");
            Map<?, ?> journal = (Map<?, ?>) raw;
            Object entries = journal.get("directories");
            if (entries instanceof List) {
                for (Object entryValue : (List<?>) entries) {
                    if (!(entryValue instanceof Map)) continue;
                    Map<?, ?> entry = (Map<?, ?>) entryValue;
                    Object tabs = entry.get("tabs");
                    if (!(tabs instanceof List)) continue;
                    for (Object tabValue : (List<?>) tabs) {
                        if (!(tabValue instanceof Map)) continue;
                        Map<?, ?> tab = (Map<?, ?>) tabValue;
                        Object id = tab.get("sessionId");
                        if (!(id instanceof String)) continue;
                        Object owner = tab.get("id");
                        Object directory = entry.get("directory");
                        if (!(owner instanceof String) || !(directory instanceof String)) throw TerminalFailure.of("invalid");
                        boolean known;
                        synchronized (lock) {
                            Session value = sessions.get(owner);
                            known = value != null && id.equals(value.id) && directory.equals(value.directory) && value.scope.equals(expected);
                        }
                        if (!known && !catalog.contains(expected.hostID, (String) owner, (String) directory, (String) id)) {
                            throw TerminalFailure.of("invalid");
                        }
                    }
                }
            }
            Map<String, Object> copy = mutable(journal);
            List<Object> directories = list(copy.get("directories"));
            // A metadata write queued before a create receipt must not erase the stronger
            // native receipt when its completion arrives late.
            for (int index = 0; index < directories.size(); index++) {
                if (!(directories.get(index) instanceof Map)) continue;
                Map<String, Object> entry = mutable((Map<?, ?>) directories.get(index));
                List<Object> tabs = list(entry.get("tabs"));
                for (int tabIndex = 0; tabIndex < tabs.size(); tabIndex++) {
                    if (!(tabs.get(tabIndex) instanceof Map)) continue;
                    Map<String, Object> tab = mutable((Map<?, ?>) tabs.get(tabIndex));
                    Object owner = tab.get("id");
                    if (!(owner instanceof String)) continue;
                    Session live;
                    synchronized (lock) {
                        live = sessions.get(owner);
                        if (live == null || !live.scope.equals(expected) || live.exited || live.id == null) continue;
                        tab.put("sessionId", live.id);
                    }
                    tab.put("lifecycle", "running");
                    tab.remove("createUnknown");
                    tabs.set(tabIndex, tab);
                }
                entry.put("tabs", tabs);
                directories.set(index, entry);
            }
            copy.put("directories", directories);
            catalog.write(copy, expected.hostID);
            return true;
        }
        Object owner = body.get("owner");
        Object directory = body.get("directory");
        Object id = body.get("sessionId");
        if (!(owner instanceof String) || !TerminalProtocol.identifier((String) owner)) throw TerminalFailure.of("invalid");
        if (!(directory instanceof String) || !(id instanceof String) || !TerminalProtocol.identifier((String) id)) {
            throw TerminalFailure.of("invalid");
        }
        if (!catalog.contains(expected.hostID, (String) owner, (String) directory, (String) id)) throw TerminalFailure.of("invalid");
        Session existing;
        synchronized (lock) {
            existing = sessions.get(owner);
            if (existing == null) {
                Session value = new Session((String) owner, (String) directory, transport, expected);
                value.id = (String) id;
                sessions.put((String) owner, value);
                return Map.of("sessionId", id);
            }
        }
        if (!existing.scope.equals(expected) || !id.equals(existing.id) || !directory.equals(existing.directory)) {
            throw TerminalFailure.of("stale");
        }
        return Map.of("sessionId", id);
    }

    private Object probe(Map<String, Object> body) throws TerminalFailure {
        TerminalTransport transport = admitted(scope(body.get("expectedHost")));
        Object url = body.get("url");
        if (!(url instanceof String) || !TerminalProtocol.loopback((String) url)) throw TerminalFailure.of("invalid");
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("url", url);
        TerminalTransport.Response response = transport.request("POST", "/api/system/probe-url", request);
        if (!transport.isCurrent()) throw TerminalFailure.of("stale");
        if (!response.ok()) throw TerminalFailure.of("response");
        Object ok = response.body.get("ok");
        if (!(ok instanceof Boolean)) throw TerminalFailure.of("response");
        return ok;
    }

    private Session owned(Map<String, Object> body, boolean interactive) throws TerminalFailure {
        HostLease.Scope expected = scope(body.get("expectedHost"));
        Object owner = body.get("owner");
        if (!(owner instanceof String)) throw TerminalFailure.of("invalid");
        Session value;
        synchronized (lock) {
            value = sessions.get(owner);
            if (value == null || !value.scope.equals(expected) || !value.transport.isCurrent()) throw TerminalFailure.of("stale");
            if (!Objects.equals(body.get("directory"), value.directory)) throw TerminalFailure.of("stale");
            Object sessionID = body.get("sessionId");
            if (sessionID != null && !sessionID.equals(value.id)) throw TerminalFailure.of("stale");
            if (interactive && !foreground) throw TerminalFailure.of("stale");
        }
        admitted(value.scope);
        return value;
    }

    private boolean current(Session value, long attempt) {
        synchronized (lock) {
            return currentLocked(value, attempt);
        }
    }

    private boolean currentLocked(Session value, long attempt) {
        return sessions.get(value.owner) == value && foreground && value.transport.isCurrent()
                && value.attempt == attempt && !value.closing;
    }

    private void event(Session value, String type, Map<String, Object> fields) {
        if (!value.transport.isCurrent()) return;
        String sessionID;
        long attachment;
        synchronized (lock) {
            sessionID = value.id;
            attachment = value.attachment;
        }
        Map<String, Object> body = new LinkedHashMap<>();
        if (fields != null) body.putAll(fields);
        body.put("type", type);
        body.put("owner", value.owner);
        body.put("sessionId", sessionID);
        body.put("expectedHost", scopeMap(value.scope));
        body.put("attachment", attachment);
        view.send("terminal.event", body);
    }

    private void stop(Session value) {
        TerminalTransport.Socket socket;
        Thread reader;
        synchronized (lock) {
            value.attempt++;
            value.bound = false;
            if (value.timer != null) {
                value.timer.cancel(false);
                value.timer = null;
            }
            if (value.heartbeat != null) {
                value.heartbeat.cancel(false);
                value.heartbeat = null;
            }
            socket = value.socket;
            value.socket = null;
            reader = value.reader;
            value.reader = null;
            value.queuedBytes = 0;
            value.sse = false;
        }
        if (socket != null) socket.close();
        if (reader != null) reader.interrupt();
    }

    private Object attach(Map<String, Object> body, Session value) throws TerminalFailure {
        Long cursor = TerminalProtocol.integer(body.get("cursor"));
        Long attachment = TerminalProtocol.integer(body.get("attachment"));
        String id;
        synchronized (lock) {
            if (value.closing || value.exited || value.id == null) throw TerminalFailure.of("invalid");
            if (cursor == null || cursor < 0) throw TerminalFailure.of("invalid");
            if (attachment == null || attachment <= value.attachment) throw TerminalFailure.of("invalid");
            id = value.id;
        }
        stop(value);
        long attempt;
        synchronized (lock) {
            value.cursor = cursor;
            value.attachment = attachment;
            attempt = value.attempt;
        }
        Thread reader = new Thread(() -> readLoop(value, attempt, id), "yuri-terminal-reader-" + value.owner);
        reader.setDaemon(true);
        synchronized (lock) {
            value.reader = reader;
        }
        reader.start();
        deadline(value, attempt, 15);
        return true;
    }

    private void readLoop(Session value, long attempt, String id) {
        try {
            if (value.preferSSE) throw TerminalFailure.of("unavailable");
            TerminalTransport.Socket socket;
            try {
                socket = value.transport.open();
            } catch (TerminalFailure failure) {
                if (!current(value, attempt)) return;
                // No input was written on this failed upgrade: only this unambiguous
                // pre-bind failure may select the event stream, which Android lacks.
                if (value.transport.supportsEventStream()) throw failure;
                failed(value, attempt, "connection_failed");
                return;
            }
            synchronized (lock) {
                if (!currentLocked(value, attempt)) {
                    socket.close();
                    return;
                }
                value.socket = socket;
            }
            Map<String, Object> bind = new LinkedHashMap<>();
            bind.put("t", "b");
            bind.put("s", id);
            bind.put("r", value.cursor);
            bind.put("v", 2L);
            send(value, attempt, TerminalProtocol.frame(bind), 256, true);
            deadline(value, attempt, 15);
            heartbeat(value, attempt);
            while (current(value, attempt)) {
                Object message = socket.inbox.receive(65_000);
                if (!current(value, attempt)) return;
                receive(message, value, attempt);
            }
        } catch (TerminalFailure failure) {
            failed(value, attempt, "sessionNotFound".equals(failure.code) ? "session_not_found" : "connection_failed");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private void heartbeat(Session value, long attempt) {
        synchronized (lock) {
            if (value.heartbeat != null) value.heartbeat.cancel(false);
            value.heartbeat = scheduler.scheduleAtFixedRate(() -> {
                if (!current(value, attempt)) return;
                try {
                    Map<String, Object> ping = new LinkedHashMap<>();
                    ping.put("t", "p");
                    ping.put("v", 2L);
                    send(value, attempt, TerminalProtocol.frame(ping), 64, true);
                } catch (TerminalFailure failure) {
                    failed(value, attempt, "connection_failed");
                }
            }, 20, 20, TimeUnit.SECONDS);
        }
    }

    private void deadline(Session value, long attempt, long seconds) {
        synchronized (lock) {
            if (value.timer != null) value.timer.cancel(false);
            value.timer = scheduler.schedule(() -> failed(value, attempt, "connection_failed"), seconds, TimeUnit.SECONDS);
        }
    }

    private void failed(Session value, long attempt, String code) {
        synchronized (lock) {
            if (!currentLocked(value, attempt)) return;
            value.missing = "session_not_found".equals(code);
        }
        stop(value);
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("code", code);
        event(value, "error", fields);
    }

    private void receive(Object message, Session value, long attempt) throws TerminalFailure {
        if (message instanceof byte[]) {
            Map<String, Object> control = TerminalProtocol.parseBinary((byte[]) message);
            if (!(control.get("t") instanceof String)) throw TerminalFailure.of("protocolViolation");
            String type = (String) control.get("t");
            if (type.equals("bok") || type.equals("d") || type.equals("x")) {
                if (!Objects.equals(control.get("s"), value.id)) throw TerminalFailure.of("protocolViolation");
            }
            switch (type) {
                case "ok":
                case "po":
                    break;
                case "bok": {
                    Long version = TerminalProtocol.integer(control.get("v"));
                    if (version == null || version != 2) throw TerminalFailure.of("protocolViolation");
                    synchronized (lock) {
                        value.bound = true;
                    }
                    Map<String, Object> fields = new LinkedHashMap<>();
                    fields.put("transport", "ws");
                    event(value, "connected", fields);
                    break;
                }
                case "d": {
                    Long id = TerminalProtocol.integer(control.get("i"));
                    Object data = control.get("d");
                    Map<String, Object> fields = null;
                    synchronized (lock) {
                        if (!value.bound || id == null || id <= 0 || !(data instanceof String)) {
                            throw TerminalFailure.of("protocolViolation");
                        }
                        if (id > value.cursor) {
                            boolean gap = id > value.cursor + 1;
                            value.cursor = id;
                            value.outputID++;
                            fields = new LinkedHashMap<>();
                            fields.put("id", value.outputID);
                            fields.put("cursor", value.cursor);
                            fields.put("data", data);
                            fields.put("replayGap", gap);
                        }
                    }
                    if (fields != null) event(value, "data", fields);
                    break;
                }
                case "x": {
                    synchronized (lock) {
                        value.exited = true;
                    }
                    stop(value);
                    Map<String, Object> fields = new LinkedHashMap<>();
                    Long exitCode = TerminalProtocol.integer(control.get("exitCode"));
                    Long signal = TerminalProtocol.integer(control.get("signal"));
                    if (exitCode != null) fields.put("exitCode", exitCode);
                    if (signal != null) fields.put("signal", signal);
                    event(value, "exit", fields);
                    return;
                }
                case "e": {
                    boolean missing;
                    synchronized (lock) {
                        missing = "SESSION_NOT_FOUND".equals(control.get("c"));
                        value.missing = missing;
                    }
                    failed(value, attempt, missing ? "session_not_found" : "connection_failed");
                    return;
                }
                default:
                    throw TerminalFailure.of("protocolViolation");
            }
        } else if (message instanceof String) {
            // v2 Host uses tagged output only. Do not invent replay IDs for legacy raw output.
            if (!((String) message).isEmpty()) throw TerminalFailure.of("protocolViolation");
        }
        boolean bound;
        synchronized (lock) {
            bound = value.bound;
        }
        if (current(value, attempt) && bound) deadline(value, attempt, 60);
    }

    private void send(Session value, long attempt, byte[] message, int bytes, boolean binary) throws TerminalFailure {
        TerminalTransport.Socket socket;
        synchronized (lock) {
            if (!currentLocked(value, attempt) || value.socket == null) throw TerminalFailure.of("stale");
            if (value.queuedBytes + bytes > TerminalProtocol.QUEUE_LIMIT) throw TerminalFailure.of("overflow");
            value.queuedBytes += bytes;
            socket = value.socket;
        }
        try {
            synchronized (value.writeLock) {
                if (!current(value, attempt)) throw TerminalFailure.of("stale");
                if (binary) socket.sendBinary(message);
                else socket.sendText(new String(message, StandardCharsets.UTF_8));
                if (!current(value, attempt)) throw TerminalFailure.of("stale");
            }
        } finally {
            synchronized (lock) {
                value.queuedBytes -= bytes;
            }
        }
    }

    private Object input(Map<String, Object> body, Session value) throws TerminalFailure {
        Object data = body.get("data");
        long attempt;
        boolean bound;
        synchronized (lock) {
            if (value.closing || value.id == null) throw TerminalFailure.of("invalid");
            bound = value.bound;
            attempt = value.attempt;
        }
        if (!bound) throw TerminalFailure.of("invalid");
        if (!(data instanceof String) || ((String) data).isEmpty()) throw TerminalFailure.of("invalid");
        String text = (String) data;
        int bytes = TerminalCatalogStore.utf8(text);
        if (bytes > TerminalProtocol.INPUT_LIMIT) throw TerminalFailure.of("invalid");
        boolean http;
        synchronized (lock) {
            http = value.sse || value.httpInput;
        }
        try {
            if (http) {
                synchronized (lock) {
                    if (value.queuedBytes + bytes > TerminalProtocol.QUEUE_LIMIT) throw TerminalFailure.of("overflow");
                    value.queuedBytes += bytes;
                }
                try {
                    synchronized (value.writeLock) {
                        if (!current(value, attempt)) throw TerminalFailure.of("stale");
                        TerminalTransport.Response response = value.transport.requestText("/api/terminal/" + value.id + "/input", text);
                        if (!current(value, attempt) || !response.ok() || !response.success()) {
                            throw TerminalFailure.of("inputUnknown");
                        }
                    }
                } finally {
                    synchronized (lock) {
                        value.queuedBytes -= bytes;
                    }
                }
            } else {
                send(value, attempt, text.getBytes(StandardCharsets.UTF_8), bytes, false);
            }
        } catch (TerminalFailure failure) {
            failed(value, attempt, "input_unknown");
            throw TerminalFailure.of("inputUnknown");
        }
        return true;
    }

    private Object resize(Map<String, Object> body, Session value) throws TerminalFailure {
        String id;
        synchronized (lock) {
            if (value.closing || value.id == null) throw TerminalFailure.of("invalid");
            id = value.id;
        }
        int[] size = TerminalProtocol.size(body);
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("cols", (long) size[0]);
        request.put("rows", (long) size[1]);
        TerminalTransport.Response response = value.transport.request("POST", "/api/terminal/" + id + "/resize", request);
        if (!value.transport.isCurrent()) throw TerminalFailure.of("stale");
        if (!response.ok() || !response.success()) throw TerminalFailure.of("response");
        return true;
    }

    private Object close(String name, Session value) throws TerminalFailure {
        Future<?> pending;
        synchronized (lock) {
            if (value.closing) throw TerminalFailure.of("closeUnknown");
            value.closing = true;
            pending = value.createTask;
        }
        stop(value);
        String id;
        boolean createUnknown;
        synchronized (lock) {
            id = value.id;
            createUnknown = value.createUnknown;
        }
        try {
            if (pending != null) {
                try {
                    pending.get(30, TimeUnit.SECONDS);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                } catch (ExecutionException | java.util.concurrent.TimeoutException error) {
                    // The create outcome stays unknown; close still proceeds to its explicit DELETE.
                }
                synchronized (lock) {
                    id = value.id;
                    createUnknown = value.createUnknown;
                }
            }
            if (!value.transport.isCurrent()) throw TerminalFailure.of("stale");
            if (id != null) {
                Map<String, Object> request = new LinkedHashMap<>();
                if (name.equals("terminal.forceKill")) request.put("sessionId", id);
                TerminalTransport.Response response = name.equals("terminal.forceKill")
                        ? value.transport.request("POST", "/api/terminal/force-kill", request)
                        : value.transport.request("DELETE", "/api/terminal/" + id, null);
                if (!value.transport.isCurrent()) throw TerminalFailure.of("stale");
                if (response.status != 404 && (!response.ok() || !response.success())) throw TerminalFailure.of("closeUnknown");
            } else if (createUnknown) {
                throw TerminalFailure.of("closeUnknown");
            }
            catalog.forget(value.scope.hostID, value.owner);
            synchronized (lock) {
                sessions.remove(value.owner);
            }
            return Map.of("closed", true);
        } finally {
            synchronized (lock) {
                value.closing = false;
            }
        }
    }

    private Object create(Map<String, Object> body) throws TerminalFailure {
        HostLease.Scope expected = scope(body.get("expectedHost"));
        Object ownerValue = body.get("owner");
        Object directoryValue = body.get("directory");
        synchronized (lock) {
            if (!foreground) throw TerminalFailure.of("invalid");
        }
        if (!(ownerValue instanceof String) || !TerminalProtocol.identifier((String) ownerValue)) throw TerminalFailure.of("invalid");
        if (!(directoryValue instanceof String) || !TerminalProtocol.directory((String) directoryValue)) throw TerminalFailure.of("invalid");
        String owner = (String) ownerValue;
        String directory = (String) directoryValue;
        synchronized (lock) {
            Session prior = sessions.get(owner);
            if (prior != null) {
                if (!prior.missing || !prior.scope.equals(expected)) throw TerminalFailure.of("invalid");
                stop(prior);
                sessions.remove(owner);
            }
        }
        int[] size = TerminalProtocol.size(body);
        TerminalTransport transport = admitted(expected);
        Session value = new Session(owner, directory, transport, expected);
        synchronized (lock) {
            sessions.put(owner, value);
        }
        Future<String> task = io.submit(() -> {
            if (!transport.isCurrent()) throw TerminalFailure.of("stale");
            Map<String, Object> request = new LinkedHashMap<>();
            request.put("cwd", directory);
            request.put("cols", (long) size[0]);
            request.put("rows", (long) size[1]);
            TerminalTransport.Response response = transport.request("POST", "/api/terminal/create", request);
            if (!transport.isCurrent()) throw TerminalFailure.of("stale");
            Object id = response.body.get("sessionId");
            if (!response.ok() || !(id instanceof String) || !TerminalProtocol.identifier((String) id)) {
                throw TerminalFailure.of("response");
            }
            Object capabilities = response.body.get("capabilities");
            if (capabilities instanceof Map) {
                Map<?, ?> map = (Map<?, ?>) capabilities;
                synchronized (lock) {
                    value.id = (String) id;
                    value.preferSSE = explicitlyNonWS(map.get("stream"));
                    value.httpInput = explicitlyNonWS(map.get("input"));
                }
            } else {
                synchronized (lock) {
                    value.id = (String) id;
                }
            }
            catalog.remember(expected.hostID, owner, directory, (String) id);
            return (String) id;
        });
        synchronized (lock) {
            value.createTask = task;
        }
        try {
            String id = task.get();
            synchronized (lock) {
                value.createTask = null;
            }
            if (!transport.isCurrent()) throw TerminalFailure.of("stale");
            return Map.of("sessionId", id);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            synchronized (lock) {
                value.createTask = null;
                value.createUnknown = true;
            }
            throw TerminalFailure.of("createUnknown");
        } catch (ExecutionException error) {
            synchronized (lock) {
                value.createTask = null;
                value.createUnknown = true;
            }
            throw TerminalFailure.of("createUnknown");
        }
    }

    private static boolean explicitlyNonWS(Object input) {
        if (!(input instanceof Map)) return false;
        Map<?, ?> value = (Map<?, ?>) input;
        if ("ws".equals(value.get("preferred"))) return false;
        Object transports = value.get("transports");
        if (transports instanceof List) {
            for (Object item : (List<?>) transports) {
                if ("ws".equals(item)) return false;
            }
        }
        return true;
    }

    /** Strict {hostID, lease} admission receipt, mirroring RuntimeHostScope on iOS. */
    static HostLease.Scope scope(Object value) throws TerminalFailure {
        if (!(value instanceof Map)) throw TerminalFailure.of("runtime_host_scope_invalid");
        Map<?, ?> map = (Map<?, ?>) value;
        Set<String> keys = new LinkedHashSet<>();
        for (Object key : map.keySet()) keys.add(String.valueOf(key));
        if (!keys.equals(Set.of("hostID", "lease"))) throw TerminalFailure.of("runtime_host_scope_invalid");
        Object hostID = map.get("hostID");
        Object lease = map.get("lease");
        if (!(hostID instanceof String) || ((String) hostID).isEmpty()) throw TerminalFailure.of("runtime_host_scope_invalid");
        if (TerminalCatalogStore.utf8((String) hostID) > 256) throw TerminalFailure.of("runtime_host_scope_invalid");
        for (int i = 0; i < ((String) hostID).length(); i++) {
            if (Character.isISOControl(((String) hostID).charAt(i))) throw TerminalFailure.of("runtime_host_scope_invalid");
        }
        if (!(lease instanceof String) || ((String) lease).length() != 36) throw TerminalFailure.of("runtime_host_scope_invalid");
        String raw = ((String) lease).toLowerCase(Locale.ROOT);
        try {
            UUID.fromString(raw);
        } catch (IllegalArgumentException error) {
            throw TerminalFailure.of("runtime_host_scope_invalid");
        }
        return new HostLease.Scope((String) hostID, raw);
    }

    static Map<String, Object> scopeMap(HostLease.Scope scope) {
        Map<String, Object> value = new HashMap<>();
        value.put("hostID", scope.hostID);
        value.put("lease", scope.lease);
        return value;
    }

    static Map<String, Object> object(Object value) throws TerminalFailure {
        if (!(value instanceof Map)) throw TerminalFailure.of("invalid");
        Map<String, Object> body = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) body.put(String.valueOf(entry.getKey()), entry.getValue());
        return body;
    }

    private static Map<String, Object> mutable(Map<?, ?> value) {
        Map<String, Object> copy = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : value.entrySet()) copy.put(String.valueOf(entry.getKey()), entry.getValue());
        return copy;
    }

    private static List<Object> list(Object value) {
        List<Object> copy = new ArrayList<>();
        if (value instanceof List) {
            for (Object item : (List<?>) value) copy.add(item);
        }
        return copy;
    }
}
