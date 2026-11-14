package com.yee94.yuri.nsh;

import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Terminal transport over one captured {@link HostLease}, mirroring TerminalTransport in
 * ios/TerminalBridge.swift. Only the lease issues authenticated requests and sockets, so no URL,
 * cookie, password or bearer crosses this boundary.
 *
 * <p>Android leases expose JSON, byte reads and WebSockets. SSE output has no lease equivalent, so
 * {@link #supportsEventStream()} is always false. HTTP text input needs {@link RawPost}, which
 * RuntimeBridge implements; a lease without it reports {@code unavailable} exactly like an iOS Host
 * without that capability.
 */
public final class TerminalTransport {
    /** RuntimeBridge capability: authenticated POST of a text/plain body to a Host path. */
    public interface RawPost {
        HostLease.RawResponse postText(String path, String text) throws Exception;
    }

    public static final class Response {
        public final int status;
        public final Map<String, Object> body;

        Response(int status, Map<String, Object> body) {
            this.status = status;
            this.body = body;
        }

        public boolean ok() {
            return status >= 200 && status < 300;
        }

        public boolean success() {
            Object value = body == null ? null : body.get("success");
            return Boolean.TRUE.equals(value);
        }
    }

    public static final class Socket {
        public final HostLease.Socket raw;
        public final TerminalStreamInbox inbox;

        Socket(HostLease.Socket raw, TerminalStreamInbox inbox) {
            this.raw = raw;
            this.inbox = inbox;
        }

        public void sendText(String value) throws TerminalFailure {
            TerminalTransport.await(raw.sendText(value), 15);
        }

        public void sendBinary(byte[] value) throws TerminalFailure {
            TerminalTransport.await(raw.sendBinary(value), 15);
        }

        public void close() {
            try {
                raw.close();
            } catch (RuntimeException ignored) {
                // Closing is best effort; the inbox already fails the read loop.
            }
        }
    }

    private final HostLease lease;

    TerminalTransport(HostLease lease) {
        this.lease = lease;
    }

    public static TerminalTransport of(HostLease lease) {
        return new TerminalTransport(lease);
    }

    public HostLease.Scope scope() {
        return lease.scope();
    }

    public boolean isCurrent() {
        return lease.isCurrent();
    }

    public boolean supportsWebSocket() {
        return true;
    }

    public boolean supportsEventStream() {
        return false;
    }

    public boolean supportsHttpInput() {
        return lease instanceof RawPost;
    }

    public Response request(String method, String path, Map<String, Object> body) throws TerminalFailure {
        HostLease.JsonResponse response = await(lease.json(path, method, body), 15);
        Map<String, Object> value = map(response.body);
        return new Response(response.status, value);
    }

    /** Authenticated text/plain POST; unavailable when the lease has no such transport. */
    public Response requestText(String path, String text) throws TerminalFailure {
        if (!(lease instanceof RawPost)) throw TerminalFailure.of("unavailable");
        HostLease.RawResponse response;
        try {
            response = ((RawPost) lease).postText(path, text);
        } catch (TerminalFailure failure) {
            throw failure;
        } catch (Exception error) {
            throw TerminalFailure.of("connectionFailed");
        }
        if (response == null) throw TerminalFailure.of("connectionFailed");
        if (response.status >= 300 && response.status < 400) throw TerminalFailure.of("response");
        if (response.data != null && response.data.length > TerminalProtocol.INPUT_LIMIT) throw TerminalFailure.of("overflow");
        Object parsed = response.data == null ? null : TerminalJson.parse(new String(response.data, StandardCharsets.UTF_8));
        return new Response(response.status, map(parsed));
    }

    /** Authenticated GET /api/fs/read; null means authoritative absence only. */
    public String optionalFile(String directory, String file) throws TerminalFailure {
        String path = (directory.equals("/") ? "" : directory) + "/" + file;
        String query = "/api/fs/read?path=" + encode(path) + "&directory=" + encode(directory) + "&optional=true";
        HostLease.RawResponse response = await(lease.read(query, TerminalProtocol.MESSAGE_LIMIT), 15);
        // The Host states absence in x-yuri-file-exists; a 404 is the fallback for transports
        // that cannot report headers.
        if ("false".equals(response.header("x-yuri-file-exists"))) return null;
        if (response.status == 404) return null;
        if (response.status != 200) throw TerminalFailure.of("response");
        String mime = response.mime == null ? "" : response.mime.split(";")[0].trim().toLowerCase(Locale.ROOT);
        if (!mime.equals("text/plain")) throw TerminalFailure.of("response");
        return decode(response.data);
    }

    /** Authenticated GET /api/system/free-port; no process is started here. */
    public Long freePort() throws TerminalFailure {
        Response response = request("GET", "/api/system/free-port", null);
        if (response.status != 200) throw TerminalFailure.of("response");
        Long port = TerminalProtocol.integer(response.body == null ? null : response.body.get("port"));
        if (port == null || port < 1 || port > 65535) throw TerminalFailure.of("response");
        return port;
    }

    public Socket open() throws TerminalFailure {
        TerminalStreamInbox inbox = new TerminalStreamInbox();
        inbox.didOpen();
        HostLease.Socket socket = await(lease.openWebSocket("/api/terminal/ws", new HostLease.SocketListener() {
            @Override public void onText(String text) {
                try {
                    inbox.push(text);
                } catch (TerminalFailure failure) {
                    inbox.fail(failure);
                }
            }

            @Override public void onBinary(byte[] data) {
                try {
                    inbox.push(data);
                } catch (TerminalFailure failure) {
                    inbox.fail(failure);
                }
            }

            @Override public void onClosed(Throwable failure) {
                inbox.end(TerminalFailure.of("connectionFailed"));
            }
        }), 15);
        return new Socket(socket, inbox);
    }

    static Map<String, Object> map(Object value) {
        if (!(value instanceof Map)) return new LinkedHashMap<>();
        Map<String, Object> mapped = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) mapped.put(String.valueOf(entry.getKey()), entry.getValue());
        return mapped;
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String decode(byte[] data) throws TerminalFailure {
        if (data == null) return "";
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(data)).toString();
        } catch (CharacterCodingException error) {
            throw TerminalFailure.of("response");
        }
    }

    /** Settles a lease future, mapping transport failures to the iOS terminal failure codes. */
    static <T> T await(CompletableFuture<T> future, long seconds) throws TerminalFailure {
        if (future == null) throw TerminalFailure.of("connectionFailed");
        try {
            return future.get(seconds, TimeUnit.SECONDS);
        } catch (TimeoutException error) {
            future.cancel(true);
            throw TerminalFailure.of("connectionFailed");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            future.cancel(true);
            throw TerminalFailure.of("stale");
        } catch (CancellationException error) {
            throw TerminalFailure.of("stale");
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof TerminalFailure) throw (TerminalFailure) cause;
            if (cause instanceof CancellationException) throw TerminalFailure.of("stale");
            if (cause instanceof InterruptedException) {
                Thread.currentThread().interrupt();
                throw TerminalFailure.of("stale");
            }
            throw TerminalFailure.of("connectionFailed");
        }
    }
}
