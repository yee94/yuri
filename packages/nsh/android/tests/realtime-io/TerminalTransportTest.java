package com.yee94.yuri.nsh;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/** File discovery plus the x-yuri-file-exists preference in TerminalTransport.optionalFile. */
public final class TerminalTransportTest {
    public static void main(String[] args) throws Exception {
        HeaderLease lease = new HeaderLease();
        TerminalTransport transport = TerminalTransport.of(lease);

        lease.response = new HostLease.RawResponse(200, "text/plain", "{\"scripts\":{}}".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                Map.of("x-yuri-file-exists", "false"));
        Check.nullValue(transport.optionalFile("/work", "package.json"), "header states absence");

        lease.response = new HostLease.RawResponse(200, "text/plain", "{\"name\":\"yuri\"}".getBytes("UTF-8"),
                Map.of("x-yuri-file-exists", "true"));
        Check.equal("{\"name\":\"yuri\"}", transport.optionalFile("/work", "package.json"), "header states presence");

        lease.response = new HostLease.RawResponse(200, "text/plain; charset=utf-8", "bun".getBytes("UTF-8"), null);
        Check.equal("bun", transport.optionalFile("/", "bun.lock"), "missing header keeps the body");
        Check.equal("/api/fs/read?path=%2Fbun.lock&directory=%2F&optional=true", lease.lastPath, "query shape");

        lease.response = new HostLease.RawResponse(404, "application/json", new byte[0], null);
        Check.nullValue(transport.optionalFile("/work", "index.html"), "404 falls back to absence");

        lease.response = new HostLease.RawResponse(500, "application/json", new byte[0], null);
        Check.failure("response", () -> transport.optionalFile("/work", "index.html"), "server failure");

        lease.response = new HostLease.RawResponse(200, "application/json", "{}".getBytes("UTF-8"), null);
        Check.failure("response", () -> transport.optionalFile("/work", "package.json"), "mime must be text/plain");

        lease.response = new HostLease.RawResponse(200, "text/plain", new byte[] { (byte) 0xff, (byte) 0xfe }, null);
        Check.failure("response", () -> transport.optionalFile("/work", "package.json"), "invalid UTF-8");

        lease.response = new HostLease.RawResponse(200, "text/plain", "x".getBytes("UTF-8"), null);
        transport.optionalFile("/work", "package.json");
        Check.equal(TerminalProtocol.MESSAGE_LIMIT, lease.lastLimit, "read is bounded");

        Check.failure("connectionFailed", () -> {
            lease.failure = new IllegalStateException("http://host/api?token=secret");
            try {
                transport.optionalFile("/work", "package.json");
            } finally {
                lease.failure = null;
            }
        }, "transport failure settles as a fixed code");

        System.out.println("TerminalTransportTest OK");
    }

    /** Minimal lease double: only the byte read used by file discovery answers. */
    static final class HeaderLease implements HostLease {
        final HostLease.Scope scope = new HostLease.Scope("host-a", "00000000-0000-4000-8000-000000000000");
        HostLease.RawResponse response;
        RuntimeException failure;
        String lastPath;
        int lastLimit;

        @Override public HostLease.Scope scope() {
            return scope;
        }

        @Override public boolean isCurrent() {
            return true;
        }

        @Override public void onRetire(Runnable cleanup) {}

        @Override public CompletableFuture<JsonResponse> json(String path, String method, Map<String, ?> body) {
            CompletableFuture<JsonResponse> value = new CompletableFuture<>();
            value.completeExceptionally(new IllegalStateException("unused"));
            return value;
        }

        @Override public CompletableFuture<RawResponse> read(String path, int limit) {
            lastPath = path;
            lastLimit = limit;
            CompletableFuture<RawResponse> value = new CompletableFuture<>();
            if (failure != null) value.completeExceptionally(failure);
            else value.complete(response);
            return value;
        }

        @Override public CompletableFuture<Socket> openWebSocket(String path, SocketListener listener) {
            CompletableFuture<Socket> value = new CompletableFuture<>();
            value.completeExceptionally(new IllegalStateException("unused"));
            return value;
        }
    }
}
