package com.yee94.yuri.nsh;

import java.util.ArrayDeque;

/**
 * Bounded text/binary boundary for the remote desktop socket, keeping the WebSocket frame type the
 * Relay preserved. A lost socket, overflow or closure is an explicit failure, never an empty read.
 */
public final class RemoteDesktopInbox {
    static final int MAX_MESSAGES = 32;
    static final int MAX_BYTES = 2_097_152;

    private final ArrayDeque<Object> queue = new ArrayDeque<>();
    private int bytes;
    private Throwable failure;
    private boolean closed;

    public synchronized void pushText(String text) {
        push(text, text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
    }

    public synchronized void pushBinary(byte[] data) {
        push(data, data.length);
    }

    private void push(Object value, int size) {
        if (failure != null || closed) return;
        if (queue.size() >= MAX_MESSAGES || bytes + size > MAX_BYTES) {
            failure = RemoteDesktopFailure.of("connection_failed");
            notifyAll();
            return;
        }
        queue.addLast(value);
        bytes += size;
        notifyAll();
    }

    public synchronized Object receive(long timeoutMillis) throws RemoteDesktopFailure, InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMillis;
        while (true) {
            if (failure != null) throw RemoteDesktopFailure.of("connection_failed");
            if (!queue.isEmpty()) {
                Object value = queue.removeFirst();
                bytes -= size(value);
                return value;
            }
            if (closed) throw RemoteDesktopFailure.of("connection_failed");
            long remaining = deadline - System.currentTimeMillis();
            if (remaining <= 0) throw RemoteDesktopFailure.of("connection_failed");
            wait(remaining);
        }
    }

    public synchronized void fail(Throwable error) {
        if (failure != null) return;
        failure = error;
        queue.clear();
        bytes = 0;
        notifyAll();
    }

    public synchronized void close() {
        if (closed) return;
        closed = true;
        notifyAll();
    }

    private static int size(Object value) {
        if (value instanceof String) return ((String) value).getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        if (value instanceof byte[]) return ((byte[]) value).length;
        return 0;
    }
}
