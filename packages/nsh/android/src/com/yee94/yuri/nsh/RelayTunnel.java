package com.yee94.yuri.nsh;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * Native relay-v1 HTTP/SSE/WebSocket multiplexer. One instance owns one carrier
 * connection; a broken connection fails every stream and the next call reconnects with
 * fresh keys, never replaying a mutation. The Relay is untrusted: no bearer is placed on
 * the socket and every application byte is encrypted to the paired Host key.
 */
public final class RelayTunnel {
    public static final class Response {
        public final int status;
        public final Map<String, String> headers;
        public final byte[] body;

        Response(int status, Map<String, String> headers, byte[] body) {
            this.status = status;
            this.headers = headers;
            this.body = body;
        }

        public String header(String name) { return headers.get(name.toLowerCase(Locale.ROOT)); }
    }

    public interface OnResponse { void onResponse(int status, Map<String, String> headers) throws Exception; }

    public interface OnData { void onData(byte[] chunk) throws Exception; }

    /** The bounded mailbox shared with the direct socket paths; never drops silently. */
    public static final class Inbox {
        public static final class Message {
            public final String text;
            public final byte[] binary;
            public final int closeCode;
            public final boolean closed;

            private Message(String text, byte[] binary, int closeCode, boolean closed) {
                this.text = text;
                this.binary = binary;
                this.closeCode = closeCode;
                this.closed = closed;
            }

            public boolean isText() { return text != null; }
            public boolean isClosed() { return closed; }
        }

        private final int maxMessageBytes;
        private final int maxMessages;
        private final long byteBudget;
        private final List<Message> messages = new ArrayList<>();
        private final Map<Integer, ByteArrayOutputStream> fragments = new LinkedHashMap<>();
        private boolean opened;
        private RelayTunnelFailure failure;
        private Integer closeCode;
        private long bytes;

        public Inbox(int maxMessageBytes) { this(maxMessageBytes, 2, 1024 * 1024); }

        private Inbox(int maxMessageBytes, int maxMessages, long byteBudget) {
            this.maxMessageBytes = maxMessageBytes;
            this.maxMessages = maxMessages;
            this.byteBudget = byteBudget;
        }

        public static Inbox sessionStream() { return new Inbox(1024 * 1024, 4096, 8L * 1024 * 1024); }

        public synchronized void waitUntilOpen(long timeoutMs) throws RelayTunnelFailure {
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (!opened && failure == null && closeCode == null) {
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.TIMEOUT);
                try { wait(remaining); } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
                }
            }
            if (failure != null) throw failure;
            if (closeCode != null) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.WEB_SOCKET_CLOSED, closeCode);
        }

        public synchronized void didOpen() throws RelayTunnelFailure {
            if (opened || failure != null || closeCode != null) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
            opened = true;
            notifyAll();
        }

        public synchronized Message receive(long timeoutMs) throws RelayTunnelFailure {
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (messages.isEmpty()) {
                if (failure != null) throw failure;
                if (closeCode != null) return new Message(null, null, closeCode, true);
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.TIMEOUT);
                try { wait(remaining); } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
                }
            }
            Message message = messages.remove(0);
            bytes -= size(message);
            return message;
        }

        public synchronized void consume(int type, byte[] payload, boolean more) throws RelayTunnelFailure {
            if (!opened || failure != null || closeCode != null || (type != 8 && type != 9)) {
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
            }
            ByteArrayOutputStream existing = fragments.get(type);
            int previous = existing == null ? 0 : existing.size();
            if (payload.length > maxMessageBytes - previous) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
            long bufferedFragments = 0;
            for (ByteArrayOutputStream value : fragments.values()) bufferedFragments += value.size();
            if (bytes + bufferedFragments + payload.length > byteBudget) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
            ByteArrayOutputStream data = fragments.remove(type);
            if (data == null) data = new ByteArrayOutputStream();
            data.write(payload, 0, payload.length);
            if (more) { fragments.put(type, data); return; }
            Message message;
            if (type == 8) {
                String text = new String(data.toByteArray(), StandardCharsets.UTF_8);
                if (text.indexOf('\uFFFD') >= 0) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                message = new Message(text, null, 0, false);
            } else message = new Message(null, data.toByteArray(), 0, false);
            if (messages.size() >= maxMessages) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
            messages.add(message);
            bytes += size(message);
            notifyAll();
        }

        public synchronized void end(int code) {
            if (failure != null || closeCode != null) return;
            closeCode = code;
            messages.clear();
            fragments.clear();
            bytes = 0;
            notifyAll();
        }

        public synchronized void fail(Throwable error) {
            if (failure != null || closeCode != null) return;
            failure = error instanceof RelayTunnelFailure
                ? (RelayTunnelFailure) error
                : new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
            messages.clear();
            fragments.clear();
            bytes = 0;
            notifyAll();
        }

        private static int size(Message message) {
            if (message.text != null) return RuntimeHostText.utf8Length(message.text);
            if (message.binary != null) return message.binary.length;
            return 0;
        }
    }

    /** An opened multiplexed WebSocket substream. */
    public static final class WebSocket {
        public interface Receive { Inbox.Message receive() throws RelayTunnelFailure; }
        public interface Send { void send(byte[] value) throws RelayTunnelFailure; }

        private final Receive receiver;
        private final Send textSender;
        private final Send binarySender;
        private final Runnable closer;

        WebSocket(Receive receiver, Send textSender, Send binarySender, Runnable closer) {
            this.receiver = receiver;
            this.textSender = textSender;
            this.binarySender = binarySender;
            this.closer = closer;
        }

        public Inbox.Message receive() throws RelayTunnelFailure { return receiver.receive(); }

        public void send(String text) throws RelayTunnelFailure { textSender.send(text.getBytes(StandardCharsets.UTF_8)); }

        public void sendBinary(byte[] data) throws RelayTunnelFailure { binarySender.send(data); }

        public void close() { closer.run(); }
    }

    private static final int MAX_PLAINTEXT = 65536;
    private static final int MAX_PAYLOAD = RelayTunnelFrame.MAX_PAYLOAD;
    private static final int MAX_BODY = 32 * 1024 * 1024;
    private static final long TOTAL_BODY_BUDGET = 64L * 1024 * 1024;
    private static final long QUEUE_BUDGET = 2L * 1024 * 1024;
    private static final int MAX_STREAMS = 32;
    private static final int MAX_SOCKETS = 4;

    private final String endpoint;
    private final Map<String, String> hostKey;
    private final Object lock = new Object();
    private final Object sendLock = new Object();

    private RuntimeBridgeWebSocket socket;
    private RelayTunnelCrypto crypto;
    private Thread keepalive;
    private long generation;
    private boolean ready;
    private boolean closed;
    private boolean connecting;
    private RelayTunnelFailure terminalError;
    private long nextStream = 1;

    private final Map<UUID, Pending> pending = new LinkedHashMap<>();
    private final Map<Integer, UUID> streams = new LinkedHashMap<>();
    private final Map<Integer, Inbox> sockets = new LinkedHashMap<>();
    private long inputBytes;
    private long responseBytes;
    private long lastReceived;
    private long lastSent;
    private Long probeStarted;

    private static final class Pending {
        final UUID token;
        final byte[] requestBody;
        Integer streamID;
        int headStatus = -1;
        Map<String, String> headHeaders;
        final ByteArrayOutputStream responseBody = new ByteArrayOutputStream();
        boolean done;
        RelayTunnelFailure failure;
        Response response;
        OnData onData;
        OnResponse onResponse;

        Pending(UUID token, byte[] requestBody) {
            this.token = token;
            this.requestBody = requestBody;
        }
    }

    public RelayTunnel(String relayUrl, String serverId, Map<String, String> hostEncPubJwk) throws RelayTunnelFailure {
        RuntimeHostUri.Parts parts = RuntimeHostUri.parse(relayUrl);
        if (parts == null || parts.scheme == null || parts.host == null || !parts.authority
                || parts.hasCredentials() || parts.query != null || parts.fragment != null) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_CONFIGURATION);
        }
        String scheme = parts.scheme.toLowerCase(Locale.ROOT);
        if (!"ws".equals(scheme) && !"wss".equals(scheme)) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_CONFIGURATION);
        if (!ConnectionEditorRelay.validServerId(serverId)) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_CONFIGURATION);
        hostKey = new LinkedHashMap<>(hostEncPubJwk);
        // Only public routing metadata is placed in the carrier URL; no client credential.
        StringBuilder url = new StringBuilder();
        url.append(scheme).append("://").append(parts.host);
        if (parts.port != null) url.append(':').append(parts.port);
        url.append(parts.path);
        url.append("?v=1&role=client&serverId=").append(percentEncode(serverId));
        endpoint = url.toString();
    }

    public String scope() { return endpoint; }

    public Response request(String path, String method, Map<String, String> headers, byte[] body, long timeoutSeconds)
            throws RelayTunnelFailure {
        return perform(path, method, headers, body, timeoutSeconds, null, null);
    }

    /** Callbacks run on the carrier reader thread in wire order, giving natural backpressure. */
    public Response stream(String path, String method, Map<String, String> headers, byte[] body, long timeoutSeconds,
                           OnResponse onResponse, OnData onData) throws RelayTunnelFailure {
        Map<String, String> streamHeaders = new LinkedHashMap<>(headers == null ? new LinkedHashMap<>() : headers);
        boolean hasAccept = false;
        for (String key : streamHeaders.keySet()) if ("accept".equalsIgnoreCase(key)) hasAccept = true;
        if (!hasAccept) streamHeaders.put("Accept", "text/event-stream");
        return perform(path, method, streamHeaders, body, timeoutSeconds, onResponse, onData);
    }

    public static boolean allowsWebSocketPath(String path) {
        return "/api/remote-desktop/ws".equals(path) || "/api/dictation/ws".equals(path) || "/api/terminal/ws".equals(path);
    }

    public WebSocket openWebSocket(String path, String urlToken, long timeoutSeconds) throws RelayTunnelFailure {
        return openSocket(path, urlToken, timeoutSeconds, false, null, 0);
    }

    public WebSocket openSessionWebSocket(String lastEventID, String urlToken, long validUntilUptime, long timeoutSeconds)
            throws RelayTunnelFailure {
        if (!SessionMessageStream.validCursor(lastEventID) || validUntilUptime <= 0
                || System.nanoTime() / 1_000_000L >= validUntilUptime) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
        }
        return openSocket("/api/global/event/ws", urlToken, timeoutSeconds, true, lastEventID, validUntilUptime);
    }

    private WebSocket openSocket(String path, final String urlToken, long timeoutSeconds, boolean sessionStream,
                                 String lastEventID, long tokenDeadline) throws RelayTunnelFailure {
        synchronized (lock) {
            if (closed) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
            if (terminalError != null) throw terminalError;
        }
        boolean pathAllowed = sessionStream ? "/api/global/event/ws".equals(path) : allowsWebSocketPath(path);
        if (!pathAllowed || urlToken == null || urlToken.isEmpty() || RuntimeHostText.utf8Length(urlToken) > 8192
                || !RuntimeHostText.printableAscii(urlToken) || timeoutSeconds <= 0 || timeoutSeconds > 600) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
        }
        ensureConnection(timeoutSeconds * 1000);
        final int id;
        final Inbox inbox;
        synchronized (lock) {
            if (sockets.size() >= MAX_SOCKETS || pending.size() + sockets.size() >= MAX_STREAMS || nextStream > 0xffffffffL) {
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
            }
            id = (int) nextStream;
            nextStream += 2;
            inbox = sessionStream ? Inbox.sessionStream()
                : new Inbox("/api/terminal/ws".equals(path) ? 1024 * 1024 : 512 * 1024);
            sockets.put(id, inbox);
        }
        StringBuilder query = new StringBuilder();
        query.append("yuri_url_token=").append(percentEncode(urlToken));
        if (lastEventID != null && !lastEventID.isEmpty()) query.append("&lastEventId=").append(percentEncode(lastEventID));
        long deadline = System.currentTimeMillis() + timeoutSeconds * 1000;
        try {
            if (tokenDeadline > 0 && System.nanoTime() / 1_000_000L >= tokenDeadline) {
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.AUTHENTICATION);
            }
            Map<String, Object> head = new LinkedHashMap<>();
            head.put("path", path);
            head.put("query", query.toString());
            byte[] payload = RuntimeBridgeJson.stringify(head).getBytes(StandardCharsets.UTF_8);
            send(6, id, payload);
            long remaining = Math.max(1, deadline - System.currentTimeMillis());
            inbox.waitUntilOpen(remaining);
        } catch (RelayTunnelFailure failure) {
            closeSocket(id, failure);
            throw failure;
        } catch (RuntimeBridgeFailure failure) {
            RelayTunnelFailure reported = new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
            closeSocket(id, reported);
            throw reported;
        }
        final boolean terminalPath = "/api/terminal/ws".equals(path);
        return new WebSocket(
            () -> inbox.receive(Long.MAX_VALUE / 2),
            value -> {
                if (value.length > (terminalPath ? 1024 * 1024 : 96 * 1024)) {
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
                }
                sendSocket(id, inbox, value, 8);
            },
            value -> {
                if (!terminalPath) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
                if (value.length > 1024 * 1024) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
                sendSocket(id, inbox, value, 9);
            },
            () -> closeSocket(id, new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED)));
    }

    private void sendSocket(int id, Inbox inbox, byte[] bytes, int type) throws RelayTunnelFailure {
        synchronized (lock) {
            if (sockets.get(id) != inbox) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
        }
        int offset = 0;
        do {
            int end = Math.min(offset + MAX_PAYLOAD, bytes.length);
            byte[] chunk = new byte[end - offset];
            System.arraycopy(bytes, offset, chunk, 0, chunk.length);
            send(end < bytes.length ? (type | 0x80) : type, id, chunk);
            offset = end;
        } while (offset < bytes.length);
    }

    private void closeSocket(int id, RelayTunnelFailure error) {
        Inbox inbox;
        synchronized (lock) {
            inbox = sockets.remove(id);
            if (inbox == null) return;
            // Bytes already handed to the carrier cannot be unsent; settle the caller now.
        }
        inbox.fail(error);
        if (!isReady()) return;
        try {
            send(10, id, "{\"code\":1000,\"reason\":\"\"}".getBytes(StandardCharsets.UTF_8));
        } catch (RelayTunnelFailure failure) {
            failConnection(failure);
        }
    }

    private Response perform(String path, String method, Map<String, String> headers, byte[] body, long timeoutSeconds,
                             OnResponse onResponse, OnData onData) throws RelayTunnelFailure {
        synchronized (lock) {
            if (closed) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
            if (terminalError != null) throw terminalError;
        }
        if (timeoutSeconds <= 0 || timeoutSeconds > 7L * 24 * 3600) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
        RuntimeHostUri.Parts parts = RuntimeHostUri.parse(path);
        if (parts == null || parts.scheme != null || parts.authority || parts.host != null
                || parts.fragment != null || !path.startsWith("/") || path.startsWith("//") || path.indexOf('\\') >= 0) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
        }
        if (method == null || method.isEmpty() || method.length() > 32) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
        for (int i = 0; i < method.length(); i++) {
            char c = method.charAt(i);
            if (c < 'A' || c > 'Z') throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
        }
        if (headers != null) {
            if (headers.size() > 128) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
            for (Map.Entry<String, String> header : headers.entrySet()) {
                if (header.getKey() == null || header.getKey().isEmpty() || header.getValue() == null
                        || header.getKey().indexOf('\r') >= 0 || header.getKey().indexOf('\n') >= 0
                        || header.getValue().indexOf('\r') >= 0 || header.getValue().indexOf('\n') >= 0) {
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
                }
            }
        }
        int bodyLength = body == null ? 0 : body.length;
        synchronized (lock) {
            if (pending.size() + sockets.size() >= MAX_STREAMS
                    || bodyLength > MAX_BODY || inputBytes + bodyLength > TOTAL_BODY_BUDGET) {
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
            }
        }
        Map<String, Object> head = new LinkedHashMap<>();
        head.put("method", method);
        head.put("path", parts.path);
        head.put("query", parts.query == null ? "" : parts.query);
        head.put("headers", headers == null ? new LinkedHashMap<String, Object>() : new LinkedHashMap<String, Object>(headers));
        byte[] headBytes;
        try {
            headBytes = RuntimeBridgeJson.stringify(head).getBytes(StandardCharsets.UTF_8);
        } catch (RuntimeBridgeFailure failure) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
        }
        if (headBytes.length > MAX_PAYLOAD) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);

        ensureConnection(timeoutSeconds * 1000);

        Pending item = new Pending(UUID.randomUUID(), body);
        item.onResponse = onResponse;
        item.onData = onData;
        synchronized (lock) {
            pending.put(item.token, item);
            inputBytes += bodyLength;
        }
        long deadline = System.currentTimeMillis() + timeoutSeconds * 1000;
        try {
            final int id;
            synchronized (lock) {
                if (nextStream > 0xffffffffL) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
                id = (int) nextStream;
                nextStream += 2;
                item.streamID = id;
                streams.put(id, item.token);
            }
            send(1, id, headBytes);
            if (bodyLength > 0) {
                int offset = 0;
                while (offset < bodyLength) {
                    int end = Math.min(offset + MAX_PAYLOAD, bodyLength);
                    byte[] chunk = new byte[end - offset];
                    System.arraycopy(body, offset, chunk, 0, chunk.length);
                    send(2, id, chunk);
                    offset = end;
                }
            }
            send(4, id, new byte[0]);
            synchronized (item) {
                while (!item.done) {
                    long remaining = deadline - System.currentTimeMillis();
                    if (remaining <= 0) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.TIMEOUT);
                    try { item.wait(remaining); } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
                    }
                }
            }
            if (item.failure != null) throw item.failure;
            return item.response;
        } catch (RelayTunnelFailure failure) {
            cancelRequest(item.token, failure);
            throw failure;
        }
    }

    private boolean isReady() {
        synchronized (lock) { return ready; }
    }

    private void ensureConnection(long timeoutMs) throws RelayTunnelFailure {
        boolean owner = false;
        synchronized (lock) {
            if (closed) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
            if (terminalError != null) throw terminalError;
            if (ready) return;
            if (!connecting) { connecting = true; owner = true; }
        }
        if (owner) {
            try {
                establish(timeoutMs);
            } catch (RelayTunnelFailure failure) {
                synchronized (lock) { connecting = false; lock.notifyAll(); }
                throw failure;
            }
            synchronized (lock) {
                connecting = false;
                lock.notifyAll();
                if (!ready) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
            }
            return;
        }
        long deadline = System.currentTimeMillis() + timeoutMs;
        synchronized (lock) {
            while (!ready && connecting && terminalError == null && !closed) {
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.TIMEOUT);
                try { lock.wait(Math.min(remaining, 200)); } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
                }
            }
            if (terminalError != null) throw terminalError;
            if (!ready) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
        }
    }

    private void establish(long timeoutMs) throws RelayTunnelFailure {
        RelayTunnelCrypto channel;
        try {
            channel = new RelayTunnelCrypto(RelayTunnelCrypto.importKey(hostKey));
        } catch (RelayTunnelFailure failure) {
            throw failure;
        }
        final Object readyLock = new Object();
        final boolean[] opened = new boolean[1];
        final RelayTunnelFailure[] openedFailure = new RelayTunnelFailure[1];
        final long current;
        synchronized (lock) {
            generation += 1;
            current = generation;
            // Register the new generation before dialing so a close during the handshake
            // fails this connection only and never a newer one.
        }
        RuntimeBridgeWebSocket.Listener listener = new RuntimeBridgeWebSocket.Listener() {
            @Override public void onOpen() { /* ready arrives as a text frame */ }

            @Override public void onText(String text) {
                if (!isReadyText(text)) return;
                synchronized (readyLock) {
                    opened[0] = true;
                    readyLock.notifyAll();
                }
            }

            @Override public void onBinary(byte[] data) {
                long atGeneration;
                synchronized (lock) {
                    if (!ready || generation != current) return;
                    atGeneration = generation;
                }
                handleEncrypted(data, atGeneration);
            }

            @Override public void onClosed(int code, String reason, Throwable failure) {
                synchronized (readyLock) {
                    if (!opened[0]) {
                        openedFailure[0] = code == 4010
                            ? new RelayTunnelFailure(RelayTunnelFailure.Kind.AUTHENTICATION)
                            : new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
                        readyLock.notifyAll();
                    }
                }
                if (opened[0]) {
                    failConnection(code == 4010
                        ? new RelayTunnelFailure(RelayTunnelFailure.Kind.AUTHENTICATION)
                        : new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED), current);
                }
            }
        };
        RuntimeBridgeWebSocket wire;
        try {
            wire = RuntimeBridgeWebSocket.connect(endpoint, null, 20000, MAX_PLAINTEXT + 29, listener);
        } catch (RuntimeBridgeWebSocket.HandshakeException failure) {
            throw new RelayTunnelFailure(failure.status == 401 || failure.status == 403
                ? RelayTunnelFailure.Kind.AUTHENTICATION
                : RelayTunnelFailure.Kind.DISCONNECTED);
        } catch (Exception failure) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
        }
        synchronized (lock) {
            socket = wire;
            crypto = channel;
        }
        try {
            try {
                wire.sendText(channel.hello);
            } catch (Exception failure) {
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
            }
            long deadline = System.currentTimeMillis() + Math.min(timeoutMs <= 0 ? 30000 : timeoutMs, 30000);
            long nextHello = System.currentTimeMillis() + 1000;
            boolean received;
            synchronized (readyLock) {
                while (!opened[0] && openedFailure[0] == null) {
                    long remaining = deadline - System.currentTimeMillis();
                    if (remaining <= 0) {
                        openedFailure[0] = new RelayTunnelFailure(RelayTunnelFailure.Kind.TIMEOUT);
                        break;
                    }
                    try { readyLock.wait(Math.min(remaining, 250)); } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        openedFailure[0] = new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
                        break;
                    }
                    if (!opened[0] && openedFailure[0] == null && System.currentTimeMillis() >= nextHello) {
                        nextHello = System.currentTimeMillis() + 1000;
                        try { wire.sendText(channel.hello); } catch (Exception ignored) { /* close reported */ }
                    }
                }
                received = opened[0];
            }
            if (!received) throw openedFailure[0] != null ? openedFailure[0]
                : new RelayTunnelFailure(RelayTunnelFailure.Kind.TIMEOUT);
            synchronized (lock) {
                if (generation != current) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                ready = true;
                terminalError = null;
                lastReceived = System.currentTimeMillis();
                lastSent = lastReceived;
                keepalive = new Thread(() -> keepaliveLoop(current), "yuri-nsh-relay-keepalive");
                keepalive.setDaemon(true);
            }
            keepalive.start();
        } catch (RelayTunnelFailure failure) {
            try { wire.close(); } catch (Exception ignored) { /* closed */ }
            synchronized (lock) {
                if (generation == current) {
                    socket = null;
                    crypto = null;
                    ready = false;
                }
            }
            throw failure;
        }
    }

    private static boolean isReadyText(String text) {
        if (text == null || RuntimeHostText.utf8Length(text) > MAX_PLAINTEXT) return false;
        try {
            Map<String, Object> value = RuntimeBridgeJson.object(RuntimeBridgeJson.parse(text));
            if (value == null) return false;
            Double version = RuntimeBridgeJson.number(value.get("v"));
            return version != null && version == 1 && "ready".equals(value.get("t"));
        } catch (RuntimeBridgeFailure failure) {
            return false;
        }
    }

    private void handleEncrypted(byte[] data, long atGeneration) {
        RelayTunnelCrypto channel;
        synchronized (lock) {
            if (generation != atGeneration) return;
            channel = crypto;
        }
        if (channel == null) return;
        byte[] frame;
        try {
            frame = channel.decrypt(data);
        } catch (RelayTunnelFailure failure) {
            failConnection(failure, atGeneration);
            return;
        }
        handleFrame(frame, atGeneration);
    }

    private void handleFrame(byte[] frame, long atGeneration) {
        RelayTunnelFrame.Frame decoded;
        try {
            decoded = RelayTunnelFrame.decode(frame);
        } catch (RelayTunnelFailure failure) {
            failConnection(failure, atGeneration);
            return;
        }
        int type = decoded.type;
        boolean more = decoded.more;
        int id = decoded.streamId;
        byte[] payload = decoded.payload;
        synchronized (lock) {
            lastReceived = System.currentTimeMillis();
            probeStarted = null;
        }
        if (type == 11) {
            try { send(12, id, new byte[0]); } catch (RelayTunnelFailure failure) { failConnection(failure, atGeneration); }
            return;
        }
        if (type == 12) return;
        Inbox inbox;
        synchronized (lock) { inbox = sockets.get(id); }
        if (inbox != null) {
            try {
                if (type == 7) {
                    Map<String, Object> head = RuntimeBridgeJson.object(RuntimeBridgeJson.parse(new String(payload, StandardCharsets.UTF_8)));
                    if (head == null) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                    Object protocol = head.get("protocol");
                    if (protocol != null && !"".equals(protocol)) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                    inbox.didOpen();
                } else if (type == 8 || type == 9) {
                    inbox.consume(type, payload, more);
                } else if (type == 10) {
                    Map<String, Object> close = RuntimeBridgeJson.object(RuntimeBridgeJson.parse(new String(payload, StandardCharsets.UTF_8)));
                    Integer code = close == null ? null : RuntimeBridgeJson.integer(close.get("code"));
                    Object reason = close == null ? null : close.get("reason");
                    if (code == null || code < 1000 || code > 4999 || !(reason instanceof String)
                            || RuntimeHostText.utf8Length((String) reason) > 123) {
                        throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                    }
                    synchronized (lock) { sockets.remove(id); }
                    inbox.end(code);
                } else if (type == 5) {
                    Map<String, Object> abort = RuntimeBridgeJson.object(RuntimeBridgeJson.parse(new String(payload, StandardCharsets.UTF_8)));
                    Object reason = abort == null ? null : abort.get("reason");
                    if (!(reason instanceof String)) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                    throw webSocketRejection((String) reason);
                } else {
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                }
            } catch (RelayTunnelFailure failure) {
                closeSocket(id, failure);
            } catch (RuntimeBridgeFailure failure) {
                closeSocket(id, new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME));
            }
            return;
        }
        Pending item;
        synchronized (lock) {
            UUID token = streams.get(id);
            item = token == null ? null : pending.get(token);
        }
        if (item == null) return;
        try {
            if (type == 3) {
                Map<String, Object> head = RuntimeBridgeJson.object(RuntimeBridgeJson.parse(new String(payload, StandardCharsets.UTF_8)));
                if (head == null || item.headStatus >= 0) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                Integer status = RuntimeBridgeJson.integer(head.get("status"));
                Map<String, Object> rawHeaders = RuntimeBridgeJson.object(head.get("headers"));
                if (status == null || status < 200 || status > 599 || rawHeaders == null || head.containsKey("encoding")) {
                    throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                }
                Map<String, String> headerValues = new LinkedHashMap<>();
                for (Map.Entry<String, Object> entry : rawHeaders.entrySet()) {
                    if (!(entry.getValue() instanceof String)) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                    headerValues.put(entry.getKey(), (String) entry.getValue());
                }
                item.headStatus = status;
                item.headHeaders = headerValues;
                if (item.onResponse != null) item.onResponse.onResponse(status, headerValues);
            } else if (type == 2) {
                if (item.headStatus < 0) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                if (item.onData != null) {
                    item.onData.onData(payload);
                } else {
                    synchronized (lock) {
                        if (item.responseBody.size() + payload.length > MAX_BODY
                                || responseBytes + payload.length > TOTAL_BODY_BUDGET) {
                            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
                        }
                        item.responseBody.write(payload, 0, payload.length);
                        responseBytes += payload.length;
                    }
                }
            } else if (type == 4) {
                if (item.headStatus < 0 || payload.length != 0) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                finish(item.token, new Response(item.headStatus, item.headHeaders, item.responseBody.toByteArray()), null);
            } else if (type == 5) {
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.HOST_ABORTED);
            } else {
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
            }
        } catch (RelayTunnelFailure failure) {
            if (!stillCurrent(atGeneration)) return;
            cancelRequest(item.token, failure);
        } catch (RuntimeBridgeFailure failure) {
            if (!stillCurrent(atGeneration)) return;
            cancelRequest(item.token, new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME));
        } catch (Exception failure) {
            if (!stillCurrent(atGeneration)) return;
            cancelRequest(item.token, new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME));
        }
    }

    private boolean stillCurrent(long atGeneration) {
        synchronized (lock) { return generation == atGeneration; }
    }

    private static RelayTunnelFailure webSocketRejection(String reason) {
        if ("Relay pairing authorization required".equals(reason)) {
            return new RelayTunnelFailure(RelayTunnelFailure.Kind.AUTHENTICATION);
        }
        for (int status : new int[] {401, 403, 409, 501}) {
            if (("Unexpected server response: " + status).equals(reason)) {
                return new RelayTunnelFailure(RelayTunnelFailure.Kind.WEB_SOCKET_REJECTED, status);
            }
        }
        return new RelayTunnelFailure(RelayTunnelFailure.Kind.HOST_ABORTED);
    }

    private void keepaliveLoop(long atGeneration) {
        while (true) {
            try { Thread.sleep(15000); } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return;
            }
            synchronized (lock) {
                if (atGeneration != generation || !ready) return;
                long now = System.currentTimeMillis();
                if (probeStarted != null) {
                    if (now - probeStarted >= 15000) {
                        failConnection(new RelayTunnelFailure(RelayTunnelFailure.Kind.TIMEOUT), atGeneration);
                        return;
                    }
                    continue;
                }
                if (now - lastReceived < 30000 && now - lastSent < 30000) continue;
                probeStarted = now;
            }
            try {
                send(11, 0, new byte[0]);
            } catch (RelayTunnelFailure failure) {
                failConnection(failure, atGeneration);
                return;
            }
        }
    }

    private void send(int type, int streamID, byte[] payload) throws RelayTunnelFailure {
        if (payload.length > MAX_PAYLOAD) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
        if (payload.length + 5 > QUEUE_BUDGET) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
        RuntimeBridgeWebSocket wire;
        RelayTunnelCrypto channel;
        synchronized (lock) {
            if (!ready || socket == null || crypto == null) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
            wire = socket;
            channel = crypto;
        }
        byte[] frame = RelayTunnelFrame.encode(type, streamID, payload);
        synchronized (sendLock) {
            byte[] encrypted = channel.encrypt(frame);
            try {
                wire.sendBinary(encrypted);
            } catch (Exception failure) {
                RelayTunnelFailure reported = new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
                failConnection(reported);
                throw reported;
            }
            synchronized (lock) { lastSent = System.currentTimeMillis(); }
        }
    }

    private void finish(UUID token, Response response, RelayTunnelFailure failure) {
        Pending item;
        synchronized (lock) {
            item = pending.remove(token);
            if (item == null) return;
            if (item.streamID != null) streams.remove(item.streamID);
            inputBytes -= item.requestBody == null ? 0 : item.requestBody.length;
            responseBytes -= item.responseBody.size();
        }
        item.response = response;
        item.failure = failure;
        synchronized (item) {
            item.done = true;
            item.notifyAll();
        }
    }

    private void cancelRequest(UUID token, RelayTunnelFailure error) {
        Pending item;
        Integer id;
        synchronized (lock) {
            item = pending.get(token);
            id = item == null ? null : item.streamID;
        }
        finish(token, null, error);
        if (id == null || !isReady()) return;
        try {
            send(5, id, "{\"reason\":\"cancelled\"}".getBytes(StandardCharsets.UTF_8));
        } catch (RelayTunnelFailure failure) {
            failConnection(failure);
        }
    }

    /** Permanently closes this instance: handshake, pending requests, SSE and sockets. */
    public void close() {
        synchronized (lock) {
            if (closed) return;
            closed = true;
        }
        failConnection(new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED));
    }

    /** Cancels current work but keeps the instance usable for a later call. */
    public void cancel() {
        failConnection(new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED));
    }

    private void failConnection(RelayTunnelFailure error) {
        long current;
        synchronized (lock) { current = generation; }
        failConnection(error, current);
    }

    private void failConnection(RelayTunnelFailure error, long atGeneration) {
        List<Pending> failed;
        List<Inbox> failedSockets;
        RuntimeBridgeWebSocket wire;
        synchronized (lock) {
            if (atGeneration != generation) return;
            generation += 1;
            if (error.kind == RelayTunnelFailure.Kind.AUTHENTICATION) terminalError = error;
            ready = false;
            connecting = false;
            wire = socket;
            socket = null;
            crypto = null;
            probeStarted = null;
            failed = new ArrayList<>(pending.values());
            failedSockets = new ArrayList<>(sockets.values());
            pending.clear();
            streams.clear();
            sockets.clear();
            inputBytes = 0;
            responseBytes = 0;
            lock.notifyAll();
        }
        if (wire != null) {
            try { wire.close(); } catch (Exception ignored) { /* closed */ }
        }
        for (Pending item : failed) {
            item.failure = error;
            synchronized (item) { item.done = true; item.notifyAll(); }
        }
        for (Inbox inbox : failedSockets) inbox.fail(error);
    }

    private static String percentEncode(String value) {
        StringBuilder out = new StringBuilder();
        for (byte raw : value.getBytes(StandardCharsets.UTF_8)) {
            int octet = raw & 0xff;
            boolean unreserved = (octet >= 'A' && octet <= 'Z') || (octet >= 'a' && octet <= 'z')
                || (octet >= '0' && octet <= '9') || octet == '-' || octet == '_' || octet == '.' || octet == '~';
            if (unreserved) out.append((char) octet);
            else out.append('%').append(String.format("%02X", octet));
        }
        return out.toString();
    }
}
