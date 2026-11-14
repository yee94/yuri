package com.yee94.yuri.nsh;

import java.io.ByteArrayOutputStream;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.function.Consumer;

/**
 * Chat's single event stream. Attempts are WebSocket-first on direct transports and SSE
 * otherwise, with the same cursors, ready barrier and bounded backoff as iOS. Captured
 * admission, credentials, the shared Relay and socket registry stay in RuntimeBridge.
 */
public final class SessionMessageStream {
    public enum Mode { AUTO, WS, SSE }

    public static final class UrlToken {
        public final String token;
        /** Monotonic uptime milliseconds after which the scoped token must not be used. */
        public final long validUntil;

        UrlToken(String token, long validUntil) { this.token = token; this.validUntil = validUntil; }

        public String value(long monotonicNow) throws RelayTunnelFailure {
            if (monotonicNow >= validUntil) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.AUTHENTICATION);
            return token;
        }
    }

    public interface Socket {
        String receive() throws Exception;
        void close();
    }

    public interface Ready { void ready(); }

    public interface Event { void event(String data, String id) throws Exception; }

    public interface Transport {
        boolean relay();
        boolean current();
        Socket open(String cursor) throws Exception;
        /** Blocking SSE read until EOF, cancellation or failure; registers its abort hook. */
        void sse(String cursor, Ready ready, Event event, Consumer<Runnable> register) throws Exception;
    }

    /** A non-success stream response; 4xx (except 408/429) is a permanent rejection. */
    public static final class HttpFailure extends Exception {
        public final int status;
        public HttpFailure(int status) { super("stream_http_" + status); this.status = status; }
    }

    public enum OutputKind { EVENT, READY, DISCONNECTED }

    public interface Output {
        void emit(OutputKind kind, String data);
    }

    private static final int MAX_EVENT_BYTES = 2_000_000;

    /** SSE boundary parsing: explicit CR/LF handling keeps empty lines as event boundaries. */
    public static final class SSEEvents {
        private final ByteArrayOutputStream line = new ByteArrayOutputStream();
        private final java.util.List<String> eventLines = new java.util.ArrayList<>();
        private int eventSize;
        private boolean previousCR;
        private boolean firstLine = true;
        private String eventID;
        private final Event emit;
        private final Ready activity;

        public SSEEvents(Event emit) { this(emit, () -> { }); }

        public SSEEvents(Event emit, Ready activity) {
            this.emit = emit;
            this.activity = activity;
        }

        public void consume(byte[] data) throws Exception {
            for (byte value : data) consume((byte) value);
        }

        public void consume(byte value) throws Exception {
            if (previousCR && value == 10) { previousCR = false; return; }
            previousCR = false;
            if (value == 10 || value == 13) {
                previousCR = value == 13;
                String text = decodeUtf8(line.toByteArray());
                if (firstLine) {
                    firstLine = false;
                    if (!text.isEmpty() && text.charAt(0) == '\uFEFF') text = text.substring(1);
                }
                activity.ready();
                if (text.isEmpty()) {
                    if (!eventLines.isEmpty() || eventID != null) {
                        emit.event(String.join("\n", eventLines), eventID);
                    }
                    eventLines.clear();
                    eventSize = 0;
                    eventID = null;
                } else {
                    int split = text.indexOf(':');
                    String field = split < 0 ? text : text.substring(0, split);
                    String content = split < 0 ? "" : text.substring(split + 1);
                    if (!content.isEmpty() && content.charAt(0) == ' ') content = content.substring(1);
                    if ("data".equals(field)) {
                        eventSize += line.size() + 1;
                        if (eventSize > MAX_EVENT_BYTES) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                        eventLines.add(content);
                    } else if ("id".equals(field) && content.indexOf('\0') < 0) {
                        eventID = content;
                    }
                }
                line.reset();
            } else {
                if (line.size() >= MAX_EVENT_BYTES) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                line.write(value);
            }
        }

        private static String decodeUtf8(byte[] data) throws Exception {
            try {
                return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(java.nio.ByteBuffer.wrap(data)).toString();
            } catch (CharacterCodingException failure) {
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
            }
        }
    }

    public static boolean validCursor(String id) {
        if (id == null) return true;
        return RuntimeHostText.utf8Length(id) <= 8192 && id.indexOf('\r') < 0 && id.indexOf('\n') < 0 && id.indexOf('\0') < 0;
    }

    /** Host Date has one-second precision; its upper edge gives a conservative remaining TTL. */
    public static UrlToken urlToken(int status, Map<String, String> headers, Object body, String credential,
                                    long requestStartedAt, long now) throws Exception {
        if (status != 200) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
        Map<String, Object> value = RuntimeBridgeJson.object(body);
        String token = value == null ? null : RuntimeBridgeJson.string(value.get("token"));
        Double expiry = value == null ? null : RuntimeBridgeJson.number(value.get("expiresAt"));
        String date = headers == null ? null : headers.get("date");
        if (token == null || token.isEmpty() || token.equals(credential)
                || RuntimeHostText.utf8Length(token) > 8192 || !RuntimeHostText.printableAscii(token)
                || expiry == null || !Double.isFinite(expiry) || date == null) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
        }
        long serverTime = parseDate(date);
        double remaining = expiry - (serverTime + 1000);
        if (!(remaining > 0) || remaining > 60_000) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
        UrlToken receipt = new UrlToken(token, requestStartedAt + (long) remaining);
        receipt.value(now);
        return receipt;
    }

    private static long parseDate(String value) throws Exception {
        SimpleDateFormat format = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("GMT"));
        format.setLenient(false);
        try {
            java.util.Date date = format.parse(value);
            if (date == null || !format.format(date).equals(value)) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
            return date.getTime();
        } catch (ParseException failure) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
        }
    }

    private final Transport transport;
    private final Output output;
    private volatile boolean cancelled;
    private volatile long activity;
    private volatile long readyAt;
    private volatile boolean ready;
    private volatile String cursor;
    private volatile long fallbackUntil;
    private int failures;

    public SessionMessageStream(Transport transport, Output output) {
        this.transport = transport;
        this.output = output;
    }

    public String cursor() { return cursor; }

    public void cancel() { cancelled = true; }

    public void run(Mode mode) {
        while (!cancelled && transport.current()) {
            boolean webSocket = mode == Mode.WS
                || (mode == Mode.AUTO && !transport.relay() && now() >= fallbackUntil);
            ready = false;
            readyAt = 0;
            activity = now();
            Attempt attempt = new Attempt(webSocket);
            Thread worker = new Thread(attempt, "yuri-nsh-session-stream");
            worker.setDaemon(true);
            worker.start();
            while (worker.isAlive()) {
                sleep(250);
                if (cancelled) break;
                long budget = ready ? 30000 : (webSocket ? (transport.relay() ? 8000 : 2000) : 30000);
                if (now() - activity > budget) {
                    attempt.cancel();
                    break;
                }
            }
            attempt.cancel();
            try { worker.join(3000); } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return;
            }
            if (cancelled || !transport.current()) return;
            output.emit(OutputKind.DISCONNECTED, null);
            failures += 1;
            if (mode == Mode.AUTO && webSocket && (!ready || now() - readyAt < 2000)) {
                fallbackUntil = now() + 60000;
                continue;
            }
            long delay = attempt.permanentFailure ? 60 : Math.min(30, (long) Math.pow(2, Math.min(failures - 1, 5)));
            if (!sleep(delay * 1000)) return;
        }
    }

    private boolean sleep(long millis) {
        try {
            Thread.sleep(millis);
            return true;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static long now() { return System.nanoTime() / 1_000_000L; }

    private void check() throws RelayTunnelFailure {
        if (cancelled || !transport.current()) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
    }

    private void connected() {
        ready = true;
        readyAt = now();
        activity = readyAt;
        output.emit(OutputKind.READY, null);
    }

    private void delivered(String data, String id) throws Exception {
        check();
        if (!validCursor(id)) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        if (data != null && !data.isEmpty()) {
            Map<String, Object> value = RuntimeBridgeJson.object(RuntimeBridgeJson.parse(data));
            if (value == null) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
            Map<String, Object> event = RuntimeBridgeJson.object(value.get("payload"));
            Map<String, Object> target = event != null ? event : value;
            Object type = target.get("type");
            if (!(type instanceof String) || ((String) type).isEmpty()) {
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
            }
            output.emit(OutputKind.EVENT, data);
        }
        // An empty SSE id explicitly resets Last-Event-ID; a missing id invents nothing.
        if (id != null) cursor = id.isEmpty() ? null : id;
        activity = now();
        if (ready && activity - readyAt >= 2000) failures = 0;
    }

    private static final class Frame {
        static final Frame READY = new Frame(0, null, null);
        static final Frame BACKPRESSURE = new Frame(2, null, null);
        final int kind;
        final String data;
        final String id;

        Frame(int kind, String data, String id) { this.kind = kind; this.data = data; this.id = id; }

        static Frame event(String data, String id) { return new Frame(1, data, id); }
    }

    private static Frame decode(String text) throws Exception {
        Map<String, Object> frame = RuntimeBridgeJson.object(RuntimeBridgeJson.parse(text));
        if (frame == null) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        Object type = frame.get("type");
        if (!(type instanceof String)) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        switch ((String) type) {
            case "ready":
                if (!"global".equals(frame.get("scope"))) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                return Frame.READY;
            case "backpressure": {
                Double buffered = RuntimeBridgeJson.number(frame.get("bufferedBytes"));
                Double maximum = RuntimeBridgeJson.number(frame.get("maxBytes"));
                if (buffered == null || maximum == null || !Double.isFinite(buffered) || !Double.isFinite(maximum)
                        || buffered < 0 || maximum <= 0) {
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                }
                return Frame.BACKPRESSURE;
            }
            case "event": {
                Map<String, Object> payload = RuntimeBridgeJson.object(frame.get("payload"));
                Object kind = payload == null ? null : payload.get("type");
                if (!(kind instanceof String) || ((String) kind).isEmpty()) {
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                }
                if (frame.containsKey("directory") && !(frame.get("directory") instanceof String)) {
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                }
                if (frame.containsKey("eventId") && !(frame.get("eventId") instanceof String)) {
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                }
                Map<String, Object> envelope = new LinkedHashMap<>();
                envelope.put("payload", payload);
                envelope.put("directory", frame.containsKey("directory") ? frame.get("directory") : "");
                return Frame.event(RuntimeBridgeJson.stringify(envelope),
                    frame.containsKey("eventId") ? (String) frame.get("eventId") : null);
            }
            default:
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        }
    }

    private final class Attempt implements Runnable {
        private final boolean webSocket;
        private volatile boolean cancelled;
        private volatile boolean permanentFailure;
        private volatile Socket socket;
        private volatile Runnable abort;

        Attempt(boolean webSocket) { this.webSocket = webSocket; }

        void cancel() {
            cancelled = true;
            Runnable hook = abort;
            if (hook != null) hook.run();
            Socket current = socket;
            if (current != null) current.close();
        }

        @Override public void run() {
            try {
                check();
                if (webSocket) {
                    Socket value = transport.open(cursor);
                    socket = value;
                    check();
                    while (!cancelled) {
                        String text = value.receive();
                        check();
                        Frame frame = decode(text);
                        if (frame.kind == 1) delivered(frame.data, frame.id);
                        else if (frame.kind == 0) connected();
                        else activity = now();
                    }
                } else {
                    transport.sse(cursor,
                        () -> { if (!cancelled && transport.current()) connected(); },
                        this::deliver,
                        hook -> abort = hook);
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                }
            } catch (HttpFailure rejection) {
                permanentFailure = rejection.status >= 400 && rejection.status < 500
                    && rejection.status != 408 && rejection.status != 429;
            } catch (Throwable failure) {
                if (failure instanceof RelayTunnelFailure
                        && ((RelayTunnelFailure) failure).kind == RelayTunnelFailure.Kind.WEB_SOCKET_REJECTED) {
                    int status = ((RelayTunnelFailure) failure).status;
                    permanentFailure = status >= 400 && status < 500 && status != 408 && status != 429;
                }
            } finally {
                Socket current = socket;
                if (current != null) current.close();
                socket = null;
            }
        }

        private void deliver(String data, String id) throws Exception {
            delivered(data, id);
        }
    }
}
