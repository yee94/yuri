package com.yee94.yuri.nsh;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Strict HTTP/1.1 client over a plain socket. {@code HttpURLConnection} is avoided on
 * purpose: Android's implementation rejects PATCH, may follow redirects and hides the
 * cookie store, while Host requests must go to exactly the admitted origin with no
 * credential forwarding. Only one request per connection; no pools, no caching.
 */
public final class RuntimeBridgeHttp {
    private RuntimeBridgeHttp() {}

    public static final class Response {
        public final int status;
        public final Map<String, String> headers;
        public final List<String[]> rawHeaders;
        public final byte[] data;

        Response(int status, Map<String, String> headers, List<String[]> rawHeaders, byte[] data) {
            this.status = status;
            this.headers = headers;
            this.rawHeaders = rawHeaders;
            this.data = data;
        }

        public String header(String name) { return headers.get(name.toLowerCase(Locale.ROOT)); }

        /** All values of one header, for a Host that sends more than one Set-Cookie. */
        public Map<String, List<String>> headerValues() {
            Map<String, List<String>> values = new LinkedHashMap<>();
            for (String[] entry : rawHeaders) {
                String key = entry[0].toLowerCase(Locale.ROOT);
                List<String> list = values.get(key);
                if (list == null) { list = new ArrayList<>(); values.put(key, list); }
                list.add(entry[1]);
            }
            return values;
        }
    }

    /** An open response whose body is still streaming; the caller reads and closes it. */
    public static final class Stream implements Closeable {
        public final int status;
        public final Map<String, String> headers;
        public final List<String[]> rawHeaders;
        public final InputStream body;
        private final Socket socket;

        Stream(int status, Map<String, String> headers, List<String[]> rawHeaders, InputStream body, Socket socket) {
            this.status = status;
            this.headers = headers;
            this.rawHeaders = rawHeaders;
            this.body = body;
            this.socket = socket;
        }

        public String header(String name) { return headers.get(name.toLowerCase(Locale.ROOT)); }

        @Override public void close() {
            try { socket.close(); } catch (IOException ignored) { /* closed */ }
        }
    }

    public static Stream open(String url, String method, Map<String, String> headers, byte[] body,
                              int connectTimeoutMs, int readTimeoutMs) throws IOException {
        RuntimeHostUri.Parts parts = RuntimeHostUri.parse(url);
        if (parts == null || parts.scheme == null || parts.host == null || !parts.authority) {
            throw new IOException("invalid request url");
        }
        String scheme = parts.scheme.toLowerCase(Locale.ROOT);
        boolean secure = "https".equals(scheme);
        if (!secure && !"http".equals(scheme)) throw new IOException("invalid request scheme");
        int port = parts.port != null ? parts.port : (secure ? 443 : 80);

        Socket socket = secure ? SSLSocketFactory.getDefault().createSocket() : new Socket();
        boolean complete = false;
        try {
            socket.connect(new InetSocketAddress(parts.host, port), Math.max(1, connectTimeoutMs));
            socket.setSoTimeout(Math.max(1, readTimeoutMs));
            if (secure) {
                SSLSocket tls = (SSLSocket) socket;
                SSLParameters parameters = tls.getSSLParameters();
                parameters.setEndpointIdentificationAlgorithm("HTTPS");
                tls.setSSLParameters(parameters);
                tls.startHandshake();
            }
            String target = (parts.path == null || parts.path.isEmpty() ? "/" : parts.path)
                + (parts.query != null ? "?" + parts.query : "");
            StringBuilder request = new StringBuilder();
            request.append(method).append(' ').append(target).append(" HTTP/1.1\r\n");
            request.append("Host: ").append(parts.host);
            if (parts.port != null && parts.port != (secure ? 443 : 80)) request.append(':').append(parts.port);
            request.append("\r\n");
            request.append("Connection: close\r\n");
            if (headers != null) {
                for (Map.Entry<String, String> header : headers.entrySet()) {
                    if (header.getKey() == null || header.getValue() == null) continue;
                    request.append(header.getKey()).append(": ").append(header.getValue()).append("\r\n");
                }
            }
            int length = body == null ? 0 : body.length;
            request.append("Content-Length: ").append(length).append("\r\n\r\n");
            OutputStream output = socket.getOutputStream();
            output.write(request.toString().getBytes(StandardCharsets.UTF_8));
            if (body != null) output.write(body);
            output.flush();

            InputStream input = new BufferedInputStream(socket.getInputStream());
            String statusLine = readLine(input);
            if (statusLine == null) throw new EOFException("missing status");
            String[] statusParts = statusLine.split(" ", 3);
            if (statusParts.length < 2) throw new IOException("invalid status");
            int status;
            try { status = Integer.parseInt(statusParts[1].trim()); } catch (NumberFormatException failure) { throw new IOException("invalid status"); }
            Map<String, String> responseHeaders = new LinkedHashMap<>();
            List<String[]> rawHeaders = new ArrayList<>();
            String line;
            int guard = 0;
            while ((line = readLine(input)) != null && !line.isEmpty()) {
                if (++guard > 200) throw new IOException("too many headers");
                int colon = line.indexOf(':');
                if (colon <= 0) continue;
                String name = line.substring(0, colon).trim();
                String value = line.substring(colon + 1).trim();
                rawHeaders.add(new String[] {name, value});
                String key = name.toLowerCase(Locale.ROOT);
                // Repeated headers keep the first value for single-value consumers.
                if (!responseHeaders.containsKey(key)) responseHeaders.put(key, value);
            }
            if (status == 204 || status == 205 || status == 304) {
                complete = true;
                return new Stream(status, responseHeaders, rawHeaders, new FixedLengthStream(new byte[0]), socket);
            }
            boolean chunked = false;
            String transfer = responseHeaders.get("transfer-encoding");
            if (transfer != null && transfer.toLowerCase(Locale.ROOT).contains("chunked")) chunked = true;
            String contentLength = responseHeaders.get("content-length");
            InputStream bodyStream;
            if (chunked) bodyStream = new ChunkedStream(input);
            else if (contentLength != null) {
                long declared;
                try { declared = Long.parseLong(contentLength.trim()); } catch (NumberFormatException failure) { throw new IOException("invalid length"); }
                if (declared < 0) throw new IOException("invalid length");
                bodyStream = new LimitedStream(input, declared);
            } else bodyStream = input;
            complete = true;
            return new Stream(status, responseHeaders, rawHeaders, bodyStream, socket);
        } finally {
            if (!complete) {
                try { socket.close(); } catch (IOException ignored) { /* closed */ }
            }
        }
    }

    /** Reads the whole bounded body; exceeding {@code limit} fails instead of truncating. */
    public static Response read(String url, String method, Map<String, String> headers, byte[] body,
                                int limit, int connectTimeoutMs, int readTimeoutMs) throws IOException {
        Stream stream = open(url, method, headers, body, connectTimeoutMs, readTimeoutMs);
        try {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            while (true) {
                int count = stream.body.read(chunk);
                if (count < 0) break;
                if (buffer.size() + count > limit) throw new IOException("response over limit");
                buffer.write(chunk, 0, count);
            }
            return new Response(stream.status, stream.headers, stream.rawHeaders, buffer.toByteArray());
        } finally {
            stream.close();
        }
    }

    private static String readLine(InputStream stream) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int previous = -1;
        while (true) {
            int next = stream.read();
            if (next < 0) return line.size() == 0 ? null : line.toString("UTF-8");
            if (previous == '\r' && next == '\n') {
                byte[] bytes = line.toByteArray();
                int length = bytes.length > 0 && bytes[bytes.length - 1] == '\r' ? bytes.length - 1 : bytes.length;
                return new String(bytes, 0, Math.max(0, length), StandardCharsets.UTF_8);
            }
            line.write(next);
            previous = next;
            if (line.size() > 65536) throw new IOException("header too large");
        }
    }

    private static final class FixedLengthStream extends InputStream {
        private final byte[] value;
        private int offset;

        FixedLengthStream(byte[] value) { this.value = value; }

        @Override public int read() {
            if (offset >= value.length) return -1;
            return value[offset++] & 0xff;
        }
    }

    private static final class LimitedStream extends InputStream {
        private final InputStream source;
        private long remaining;

        LimitedStream(InputStream source, long remaining) {
            this.source = source;
            this.remaining = remaining;
        }

        @Override public int read() throws IOException {
            if (remaining <= 0) return -1;
            int value = source.read();
            if (value < 0) throw new EOFException("truncated body");
            remaining--;
            return value;
        }

        @Override public int read(byte[] buffer, int offset, int length) throws IOException {
            if (remaining <= 0) return -1;
            int count = source.read(buffer, offset, (int) Math.min(length, remaining));
            if (count < 0) throw new EOFException("truncated body");
            remaining -= count;
            return count;
        }
    }

    private static final class ChunkedStream extends InputStream {
        private final InputStream source;
        private long remaining;
        private boolean finished;

        ChunkedStream(InputStream source) { this.source = source; }

        @Override public int read() throws IOException {
            byte[] single = new byte[1];
            int count = read(single, 0, 1);
            return count < 0 ? -1 : single[0] & 0xff;
        }

        @Override public int read(byte[] buffer, int offset, int length) throws IOException {
            if (length == 0) return 0;
            if (finished) return -1;
            if (remaining == 0) {
                String line = readLine(source);
                if (line == null) throw new EOFException("truncated chunk");
                int semicolon = line.indexOf(';');
                String size = (semicolon >= 0 ? line.substring(0, semicolon) : line).trim();
                if (size.isEmpty()) { finished = true; return -1; }
                long declared;
                try { declared = Long.parseLong(size, 16); } catch (NumberFormatException failure) { throw new IOException("invalid chunk"); }
                if (declared < 0) throw new IOException("invalid chunk");
                if (declared == 0) {
                    // Trailer section ends at an empty line.
                    String trailer;
                    while ((trailer = readLine(source)) != null && !trailer.isEmpty()) { /* ignore */ }
                    finished = true;
                    return -1;
                }
                remaining = declared;
            }
            int count = source.read(buffer, offset, (int) Math.min(length, remaining));
            if (count < 0) throw new EOFException("truncated chunk");
            remaining -= count;
            if (remaining == 0) {
                // Consume the CRLF that follows the chunk data.
                readLine(source);
            }
            return count;
        }
    }
}
