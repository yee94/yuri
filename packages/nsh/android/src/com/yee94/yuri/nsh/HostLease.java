package com.yee94.yuri.nsh;

import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Captured, authenticated access to exactly one Host at one lifecycle generation.
 * RuntimeBridge is the only implementation; every other bridge (resources, terminal,
 * remote desktop, voice, passkey, GUI preview, notifications) builds its transport on
 * top of this interface and never sees a URL, cookie, password or bearer.
 * Mirrors the iOS *Transport structs in packages/nsh/ios/RuntimeBridge.swift.
 */
public interface HostLease {
    /** Opaque scope the TSX layer echoes back as `expectedHost` ({hostID, lease}). */
    final class Scope {
        public final String hostID;
        public final String lease;
        public Scope(String hostID, String lease) { this.hostID = hostID; this.lease = lease; }
        @Override public boolean equals(Object o) {
            return o instanceof Scope && ((Scope) o).hostID.equals(hostID) && ((Scope) o).lease.equals(lease);
        }
        @Override public int hashCode() { return hostID.hashCode() * 31 + lease.hashCode(); }
    }

    final class JsonResponse {
        public final int status;
        /** Parsed JSON: Map, List, String, Number, Boolean or null. */
        public final Object body;
        public JsonResponse(int status, Object body) { this.status = status; this.body = body; }
    }

    final class RawResponse {
        public final int status;
        public final String mime;
        public final byte[] data;
        /**
         * Lowercase-keyed response headers for the few callers that need one (file
         * existence, speech pitch/volume). Empty when the transport cannot report them.
         */
        public final Map<String, String> headers;

        public RawResponse(int status, String mime, byte[] data) {
            this(status, mime, data, null);
        }

        public RawResponse(int status, String mime, byte[] data, Map<String, String> headers) {
            this.status = status;
            this.mime = mime;
            this.data = data;
            this.headers = headers == null ? java.util.Collections.<String, String>emptyMap() : headers;
        }

        public String header(String name) {
            return name == null ? null : headers.get(name.toLowerCase(java.util.Locale.ROOT));
        }
    }

    interface SocketListener {
        void onText(String text);
        void onBinary(byte[] data);
        /** Terminal: called exactly once, with null on a clean close. */
        void onClosed(Throwable failure);
    }

    interface Socket {
        CompletableFuture<Void> sendText(String text);
        CompletableFuture<Void> sendBinary(byte[] data);
        void close();
    }

    Scope scope();

    /** False once the Host, authorization, relay endpoint, or foreground generation changed. */
    boolean isCurrent();

    /** Run `cleanup` when this lease is retired (immediately if already retired). */
    void onRetire(Runnable cleanup);

    /** Authenticated JSON request over the direct or Relay transport; path is Host-relative. */
    CompletableFuture<JsonResponse> json(String path, String method, Map<String, ?> body);

    /** Authenticated byte read bounded by `limit` bytes (fails past the limit). */
    CompletableFuture<RawResponse> read(String path, int limit);

    /** Authenticated WebSocket to an exact Host path, Relay-multiplexed when paired over Relay. */
    CompletableFuture<Socket> openWebSocket(String path, SocketListener listener);
}
