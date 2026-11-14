package com.yee94.yuri.nsh;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Minimal RFC 6455 client over a plain socket. Android's SDK ships no WebSocket client and
 * no dependency may be added, so the Runtime owns the handshake, masking and framing it uses.
 * Redirects are never followed: the caller's authenticated URL is the only origin dialed.
 */
public final class RuntimeBridgeWebSocket {
    /** Non-101 handshake status; the Relay/desktop layers map it to their own failure codes. */
    public static final class HandshakeException extends IOException {
        public final int status;
        HandshakeException(int status) { super("websocket handshake " + status); this.status = status; }
    }

    public interface Listener {
        void onOpen();
        void onText(String text);
        void onBinary(byte[] data);
        /** Exactly once; {@code failure} is null for a peer- or caller-initiated clean close. */
        void onClosed(int code, String reason, Throwable failure);
    }

    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Socket socket;
    private final InputStream input;
    private final OutputStream output;
    private final Listener listener;
    private final int maxMessageBytes;
    private final Object writeLock = new Object();
    private volatile boolean open = true;
    private volatile boolean closing = false;

    private RuntimeBridgeWebSocket(Socket socket, InputStream input, OutputStream output, Listener listener, int maxMessageBytes) {
        this.socket = socket;
        this.input = input;
        this.output = output;
        this.listener = listener;
        this.maxMessageBytes = maxMessageBytes;
    }

    public static RuntimeBridgeWebSocket connect(String url, Map<String, String> headers, int connectTimeoutMs,
                                                 int maxMessageBytes, Listener listener) throws IOException {
        RuntimeHostUri.Parts parts = RuntimeHostUri.parse(url);
        if (parts == null || parts.scheme == null || !parts.authority || parts.host == null) {
            throw new IOException("invalid websocket url");
        }
        String scheme = parts.scheme.toLowerCase(Locale.ROOT);
        boolean secure = "wss".equals(scheme);
        if (!secure && !"ws".equals(scheme)) throw new IOException("invalid websocket scheme");
        String host = parts.host;
        int port = parts.port != null ? parts.port : (secure ? 443 : 80);

        Socket socket = secure ? SSLSocketFactory.getDefault().createSocket() : new Socket();
        try {
            socket.connect(new InetSocketAddress(host, port), Math.max(1, connectTimeoutMs));
            socket.setSoTimeout(0);
            if (secure) ((SSLSocket) socket).startHandshake();

            String path = (parts.path == null || parts.path.isEmpty() ? "/" : parts.path)
                + (parts.query != null ? "?" + parts.query : "");
            byte[] nonce = new byte[16];
            RANDOM.nextBytes(nonce);
            String key = java.util.Base64.getEncoder().encodeToString(nonce);
            StringBuilder request = new StringBuilder();
            request.append("GET ").append(path).append(" HTTP/1.1\r\n");
            request.append("Host: ").append(host);
            if (parts.port != null && parts.port != (secure ? 443 : 80)) request.append(':').append(parts.port);
            request.append("\r\n");
            request.append("Upgrade: websocket\r\nConnection: Upgrade\r\n");
            request.append("Sec-WebSocket-Key: ").append(key).append("\r\n");
            request.append("Sec-WebSocket-Version: 13\r\n");
            if (headers != null) {
                for (Map.Entry<String, String> header : headers.entrySet()) {
                    if (header.getKey() == null || header.getValue() == null) continue;
                    String name = header.getKey();
                    if ("upgrade".equalsIgnoreCase(name) || "connection".equalsIgnoreCase(name)
                            || "sec-websocket-key".equalsIgnoreCase(name) || "sec-websocket-version".equalsIgnoreCase(name)
                            || "host".equalsIgnoreCase(name) || "content-length".equalsIgnoreCase(name)) continue;
                    request.append(name).append(": ").append(header.getValue()).append("\r\n");
                }
            }
            request.append("\r\n");
            OutputStream output = socket.getOutputStream();
            output.write(request.toString().getBytes(StandardCharsets.UTF_8));
            output.flush();

            InputStream input = new BufferedInputStream(socket.getInputStream());
            String statusLine = readLine(input);
            int status = statusLine == null ? 0 : parseStatus(statusLine);
            Map<String, String> response = new LinkedHashMap<>();
            String line;
            int guard = 0;
            while ((line = readLine(input)) != null && !line.isEmpty()) {
                if (++guard > 200) break;
                int colon = line.indexOf(':');
                if (colon <= 0) continue;
                response.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
            }
            if (status != 101) throw new HandshakeException(status);
            String accept = response.get("sec-websocket-accept");
            if (accept == null || !accept.equals(acceptValue(key))) throw new IOException("websocket handshake");

            RuntimeBridgeWebSocket client = new RuntimeBridgeWebSocket(socket, input, output, listener, maxMessageBytes);
            client.start();
            return client;
        } catch (IOException | RuntimeException failure) {
            try { socket.close(); } catch (IOException ignored) { /* closed */ }
            throw failure;
        }
    }

    private void start() {
        if (listener != null) listener.onOpen();
        Thread reader = new Thread(this::readLoop, "yuri-nsh-ws");
        reader.setDaemon(true);
        reader.start();
    }

    public boolean isOpen() { return open; }

    public void sendText(String text) throws IOException { send(0x1, text.getBytes(StandardCharsets.UTF_8)); }

    public void sendBinary(byte[] data) throws IOException { send(0x2, data); }

    public void close() {
        if (!open) return;
        closing = true;
        open = false;
        try { sendFrame(0x8, new byte[] {0x03, (byte) 0xE8}); } catch (IOException ignored) { /* closing anyway */ }
        try { socket.close(); } catch (IOException ignored) { /* already closed */ }
    }

    private void readLoop() {
        Throwable failure = null;
        int code = 0;
        String reason = "";
        try {
            ByteArrayOutputStream fragments = new ByteArrayOutputStream();
            int fragmentOpcode = 0;
            while (open) {
                int first = input.read();
                if (first < 0) throw new EOFException("websocket eof");
                int second = input.read();
                if (second < 0) throw new EOFException("websocket eof");
                boolean fin = (first & 0x80) != 0;
                int opcode = first & 0x0f;
                boolean masked = (second & 0x80) != 0;
                long length = second & 0x7f;
                if (length == 126) length = readShort();
                else if (length == 127) length = readLong();
                if (length < 0 || length > Math.max(maxMessageBytes, 1024 * 1024)) {
                    throw new IOException("websocket frame too large");
                }
                byte[] mask = null;
                if (masked) {
                    mask = new byte[4];
                    readFully(mask);
                }
                byte[] payload = new byte[(int) length];
                readFully(payload);
                if (masked) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
                switch (opcode) {
                    case 0x0:
                        if (fragmentOpcode == 0) throw new IOException("websocket fragment");
                        append(fragments, payload);
                        if (fin) { deliver(fragmentOpcode, fragments.toByteArray()); fragments.reset(); fragmentOpcode = 0; }
                        break;
                    case 0x1:
                    case 0x2:
                        if (fragmentOpcode != 0) throw new IOException("websocket fragment");
                        if (fin) deliver(opcode, payload);
                        else { fragmentOpcode = opcode; fragments.reset(); append(fragments, payload); }
                        break;
                    case 0x8:
                        code = payload.length >= 2 ? (((payload[0] & 0xff) << 8) | (payload[1] & 0xff)) : 0;
                        if (payload.length > 2) reason = new String(payload, 2, payload.length - 2, StandardCharsets.UTF_8);
                        open = false;
                        try { sendFrame(0x8, new byte[0]); } catch (IOException ignored) { /* peer closed */ }
                        return;
                    case 0x9:
                        sendFrame(0xA, payload);
                        break;
                    case 0xA:
                        break;
                    default:
                        throw new IOException("websocket opcode");
                }
            }
        } catch (Throwable error) {
            failure = error;
        } finally {
            open = false;
            try { socket.close(); } catch (IOException ignored) { /* closed */ }
            if (listener != null) {
                Throwable reported = closing ? null : failure;
                listener.onClosed(code, reason, reported);
            }
        }
    }

    private void deliver(int opcode, byte[] payload) {
        if (listener == null) return;
        if (opcode == 0x1) listener.onText(new String(payload, StandardCharsets.UTF_8));
        else listener.onBinary(payload);
    }

    private void append(ByteArrayOutputStream buffer, byte[] payload) throws IOException {
        if (buffer.size() + payload.length > maxMessageBytes) throw new IOException("websocket message too large");
        buffer.write(payload);
    }

    private void send(int opcode, byte[] payload) throws IOException {
        if (!open) throw new IOException("websocket closed");
        if (payload.length > maxMessageBytes) throw new IOException("websocket message too large");
        sendFrame(opcode, payload);
    }

    private void sendFrame(int opcode, byte[] payload) throws IOException {
        synchronized (writeLock) {
            ByteArrayOutputStream frame = new ByteArrayOutputStream(payload.length + 14);
            frame.write(0x80 | opcode);
            if (payload.length < 126) {
                frame.write(0x80 | payload.length);
            } else if (payload.length <= 0xffff) {
                frame.write(0x80 | 126);
                frame.write((payload.length >>> 8) & 0xff);
                frame.write(payload.length & 0xff);
            } else {
                frame.write(0x80 | 127);
                long length = payload.length;
                for (int i = 0; i < 8; i++) frame.write((int) ((length >>> (8 * (7 - i))) & 0xff));
            }
            byte[] mask = new byte[4];
            RANDOM.nextBytes(mask);
            frame.write(mask, 0, 4);
            byte[] masked = new byte[payload.length];
            for (int i = 0; i < payload.length; i++) masked[i] = (byte) (payload[i] ^ mask[i % 4]);
            frame.write(masked, 0, masked.length);
            output.write(frame.toByteArray());
            output.flush();
        }
    }

    private int readShort() throws IOException {
        int high = input.read();
        int low = input.read();
        if (high < 0 || low < 0) throw new EOFException("websocket eof");
        return (high << 8) | low;
    }

    private long readLong() throws IOException {
        long value = 0;
        for (int i = 0; i < 8; i++) {
            int next = input.read();
            if (next < 0) throw new EOFException("websocket eof");
            value = (value << 8) | next;
        }
        return value;
    }

    private void readFully(byte[] target) throws IOException {
        int offset = 0;
        while (offset < target.length) {
            int read = input.read(target, offset, target.length - offset);
            if (read < 0) throw new EOFException("websocket eof");
            offset += read;
        }
    }

    private static String acceptValue(String key) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            return java.util.Base64.getEncoder().encodeToString(digest.digest((key + GUID).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception failure) {
            return null;
        }
    }

    private static int parseStatus(String value) {
        String[] parts = value.split(" ", 3);
        if (parts.length < 2) return 0;
        try { return Integer.parseInt(parts[1].trim()); } catch (NumberFormatException failure) { return 0; }
    }

    private static String readLine(InputStream stream) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int previous = -1;
        while (true) {
            int next = stream.read();
            if (next < 0) return null;
            if (previous == '\r' && next == '\n') {
                byte[] bytes = line.toByteArray();
                int length = bytes.length > 0 && bytes[bytes.length - 1] == '\r' ? bytes.length - 1 : bytes.length;
                return new String(bytes, 0, Math.max(0, length), StandardCharsets.UTF_8);
            }
            line.write(next);
            previous = next;
            if (line.size() > 8192) throw new IOException("websocket header too large");
        }
    }
}
