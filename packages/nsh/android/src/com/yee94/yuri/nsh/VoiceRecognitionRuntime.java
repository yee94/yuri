package com.yee94.yuri.nsh;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Ported from VoiceRecognitionWire and the socket lease in ios/VoiceRecognitionRuntime.swift.
 * Android leases deliver socket frames through a listener, so the pending-operation continuations
 * become blocking deadlines over a bounded inbox with exactly the same size limits.
 */
public final class VoiceRecognitionRuntime {
    public static final int FILE_LIMIT = 1_920_044;
    public static final int SETTINGS_LIMIT = 65_536;
    public static final int RESPONSE_LIMIT = 131_072;
    public static final int MESSAGE_LIMIT = 131_072;
    public static final int SEND_LIMIT = 16_384;

    private VoiceRecognitionRuntime() {}

    /** RuntimeBridge capability: authenticated POST of a binary body (audio/wav). */
    public interface RawUpload {
        HostLease.RawResponse postBytes(String path, String mime, byte[] body) throws Exception;
    }

    public static final class Response {
        public final int status;
        public final String mime;
        public final Map<String, Object> body;

        public Response(int status, String mime, Map<String, Object> body) {
            this.status = status;
            this.mime = mime == null ? "" : mime;
            this.body = body == null ? new LinkedHashMap<>() : body;
        }

        public int encodedLength() {
            return TerminalProtocol.encode(body).getBytes(StandardCharsets.UTF_8).length;
        }
    }

    /** One text/binary socket with the iOS text-only contract: binary is a transport failure. */
    public static final class Socket {
        private HostLease.Socket raw;
        private final ArrayDeque<String> queue = new ArrayDeque<>();
        private Throwable failure;
        private boolean closed;

        Socket() {}

        void attach(HostLease.Socket value) {
            raw = value;
        }

        void pushText(String text) {
            synchronized (this) {
                if (failure != null || closed) return;
                if (text == null || text.getBytes(StandardCharsets.UTF_8).length > MESSAGE_LIMIT) {
                    failure = VoiceRecognitionFailure.of("limit");
                    notifyAll();
                    return;
                }
                queue.addLast(text);
                notifyAll();
            }
        }

        void fail(Throwable error) {
            synchronized (this) {
                if (failure != null) return;
                failure = error;
                queue.clear();
                notifyAll();
            }
        }

        public synchronized String receive(long timeoutMillis) throws VoiceRecognitionFailure, InterruptedException {
            long deadline = System.currentTimeMillis() + timeoutMillis;
            while (true) {
                if (failure != null) throw VoiceRecognitionRuntime.failure(failure);
                if (!queue.isEmpty()) return queue.removeFirst();
                if (closed) throw VoiceRecognitionFailure.of("transport");
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) throw VoiceRecognitionFailure.of("transport");
                wait(remaining);
            }
        }

        public void send(String text) throws VoiceRecognitionFailure {
            if (text.getBytes(StandardCharsets.UTF_8).length > SEND_LIMIT) throw VoiceRecognitionFailure.of("limit");
            HostLease.Socket socket = raw;
            if (socket == null) throw VoiceRecognitionFailure.of("transport");
            await(socket.sendText(text), 20);
        }

        public void close() {
            HostLease.Socket socket;
            synchronized (this) {
                if (closed) return;
                closed = true;
                notifyAll();
                socket = raw;
            }
            if (socket == null) return;
            try {
                socket.close();
            } catch (RuntimeException ignored) {
                // Pending reads already fail through the closed flag.
            }
        }
    }

    /** No response may exceed its limit or answer with a non-JSON body. */
    public static void head(int status, String mime, long length, int limit) throws VoiceRecognitionFailure {
        if (length > limit) throw VoiceRecognitionFailure.of("limit");
        if (status < 200 || status >= 300) {
            throw VoiceRecognitionFailure.of(status == 401 || status == 403 ? "unavailable" : "transport");
        }
        String normalized = mime == null ? "" : mime.split(";", 2)[0].trim().toLowerCase(java.util.Locale.ROOT);
        if (!normalized.equals("application/json")) throw VoiceRecognitionFailure.of("transport");
    }

    public static Response response(Response value, int limit) throws VoiceRecognitionFailure {
        head(value.status, value.mime, value.encodedLength(), limit);
        return value;
    }

    public static VoiceRecognitionFailure failure(Throwable error) {
        if (error instanceof CancellationException) return VoiceRecognitionFailure.of("cancelled");
        if (error instanceof VoiceRecognitionFailure) return (VoiceRecognitionFailure) error;
        // Native/Host/transport descriptions may contain endpoints or credentials.
        return VoiceRecognitionFailure.of("transport");
    }

    public static <T> T await(CompletableFuture<T> future, long seconds) throws VoiceRecognitionFailure {
        if (future == null) throw VoiceRecognitionFailure.of("transport");
        try {
            return future.get(seconds, TimeUnit.SECONDS);
        } catch (TimeoutException error) {
            future.cancel(true);
            throw VoiceRecognitionFailure.of("transport");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            future.cancel(true);
            throw VoiceRecognitionFailure.of("cancelled");
        } catch (CancellationException error) {
            throw VoiceRecognitionFailure.of("cancelled");
        } catch (ExecutionException error) {
            throw failure(error.getCause() == null ? error : error.getCause());
        }
    }
}
