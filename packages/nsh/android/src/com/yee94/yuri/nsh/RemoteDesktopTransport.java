package com.yee94.yuri.nsh;

import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Remote desktop transport over one captured {@link HostLease}, mirroring RemoteDesktopTransport in
 * ios/RemoteDesktopBridge.swift. The lease keeps the origin/redirect policy and the authorized
 * encrypted Relay multiplexing; this class never builds a URL, mints a token or falls back to a
 * direct connection.
 */
public final class RemoteDesktopTransport {
    public static final int INCOMING_LIMIT = 512 * 1024;
    private static final java.util.Set<String> KNOWN = java.util.Set.of(
            "authentication_required", "unsupported", "disabled", "permission_denied", "permission_required",
            "helper_unavailable", "invalid_message", "occupied", "rate_limited", "runtime_changed",
            "connection_failed", "decode_failed");

    public static final class Response {
        public final int status;
        public final Map<String, Object> body;

        Response(int status, Map<String, Object> body) {
            this.status = status;
            this.body = body;
        }
    }

    public static final class Socket {
        final HostLease.Socket raw;
        final RemoteDesktopInbox inbox;

        Socket(HostLease.Socket raw, RemoteDesktopInbox inbox) {
            this.raw = raw;
            this.inbox = inbox;
        }

        public Object receive(long timeoutMillis) throws RemoteDesktopFailure, InterruptedException {
            return inbox.receive(timeoutMillis);
        }

        public void send(String text) throws RemoteDesktopFailure {
            RemoteDesktopTransport.await(raw.sendText(text), 10);
        }

        public void close() {
            inbox.close();
            try {
                raw.close();
            } catch (RuntimeException ignored) {
                // The inbox already fails every pending read.
            }
        }
    }

    private final HostLease lease;

    RemoteDesktopTransport(HostLease lease) {
        this.lease = lease;
    }

    public static RemoteDesktopTransport of(HostLease lease) {
        return new RemoteDesktopTransport(lease);
    }

    public boolean isCurrent() {
        return lease.isCurrent();
    }

    public HostLease.Scope scope() {
        return lease.scope();
    }

    /** Exact GET /api/remote-desktop through the authenticated JSON transport. */
    public Response capability() throws RemoteDesktopFailure {
        HostLease.JsonResponse response = await(lease.json("/api/remote-desktop", "GET", null), 10);
        return new Response(response.status, TerminalTransport.map(response.body));
    }

    /** Exact /api/remote-desktop/ws; incoming frames stay bounded by the lease and this inbox. */
    public Socket open() throws RemoteDesktopFailure {
        RemoteDesktopInbox inbox = new RemoteDesktopInbox();
        HostLease.Socket socket = await(lease.openWebSocket("/api/remote-desktop/ws", new HostLease.SocketListener() {
            @Override public void onText(String text) {
                if (text != null && text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > INCOMING_LIMIT) {
                    inbox.fail(RemoteDesktopFailure.of("invalid_message"));
                    return;
                }
                inbox.pushText(text);
            }

            @Override public void onBinary(byte[] data) {
                if (data != null && data.length > INCOMING_LIMIT) {
                    inbox.fail(RemoteDesktopFailure.of("invalid_message"));
                    return;
                }
                inbox.pushBinary(data);
            }

            @Override public void onClosed(Throwable failure) {
                inbox.fail(RemoteDesktopFailure.of("connection_failed"));
            }
        }), 60);
        return new Socket(socket, inbox);
    }

    static <T> T await(CompletableFuture<T> future, long seconds) throws RemoteDesktopFailure {
        if (future == null) throw RemoteDesktopFailure.of("connection_failed");
        try {
            return future.get(seconds, TimeUnit.SECONDS);
        } catch (TimeoutException error) {
            future.cancel(true);
            throw RemoteDesktopFailure.of("connection_failed");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            future.cancel(true);
            throw RemoteDesktopFailure.of("connection_failed");
        } catch (CancellationException error) {
            throw RemoteDesktopFailure.of("connection_failed");
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof RemoteDesktopFailure) throw (RemoteDesktopFailure) cause;
            if (cause instanceof CancellationException) throw RemoteDesktopFailure.of("connection_failed");
            String message = cause == null ? null : cause.getMessage();
            // Only codes this bridge already understands; a transport description never leaks.
            if (message == null || !KNOWN.contains(message)) throw RemoteDesktopFailure.of("connection_failed");
            throw RemoteDesktopFailure.of(message);
        }
    }
}
