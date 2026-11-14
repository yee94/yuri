package com.yee94.yuri.nsh;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;

/**
 * Bounded logical message inbox for the terminal WebSocket, ported from TerminalStreamInbox in
 * ios/TerminalTransport.swift. Values are {@link String} text or {@code byte[]} binary; nothing is
 * silently dropped: overflow, a lost socket and closure are explicit failures.
 */
public final class TerminalStreamInbox {
    public static final int MAX_MESSAGES = 64;
    public static final int MAX_BYTES = 2_097_152;

    private final ArrayDeque<Object> queue = new ArrayDeque<>();
    private int bytes;
    private boolean opened;
    private Throwable failure;
    private Throwable end;

    public synchronized void didOpen() throws TerminalFailure {
        if (opened || failure != null) throw TerminalFailure.of("protocolViolation");
        opened = true;
        notifyAll();
    }

    public synchronized void waitOpen(long timeoutMillis) throws TerminalFailure, InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMillis;
        while (!opened) {
            if (failure != null) throw TerminalFailure.of("connectionFailed");
            long remaining = deadline - System.currentTimeMillis();
            if (remaining <= 0) throw TerminalFailure.of("connectionFailed");
            wait(remaining);
        }
    }

    /** Next message, or a failure once the inbox failed, ended or timed out. */
    public synchronized Object receive(long timeoutMillis) throws TerminalFailure, InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMillis;
        while (true) {
            if (failure != null) throw TerminalFailure.of("connectionFailed");
            if (!queue.isEmpty()) {
                Object value = queue.removeFirst();
                bytes -= size(value);
                return value;
            }
            if (end != null) throw TerminalFailure.of("connectionFailed");
            long remaining = deadline - System.currentTimeMillis();
            if (remaining <= 0) throw TerminalFailure.of("connectionFailed");
            wait(remaining);
        }
    }

    public synchronized void push(Object value) throws TerminalFailure {
        if (failure != null || !opened) throw TerminalFailure.of("connectionFailed");
        int count = size(value);
        if (count > TerminalProtocol.MESSAGE_LIMIT) throw TerminalFailure.of("overflow");
        if (queue.size() >= MAX_MESSAGES || bytes + count > MAX_BYTES) throw TerminalFailure.of("overflow");
        queue.addLast(value);
        bytes += count;
        notifyAll();
    }

    public synchronized void fail(Throwable error) {
        if (failure != null) return;
        failure = error;
        queue.clear();
        bytes = 0;
        notifyAll();
    }

    public synchronized void end(Throwable error) {
        if (failure != null || end != null) return;
        end = error;
        if (queue.isEmpty()) notifyAll();
    }

    public synchronized boolean isFailed() {
        return failure != null;
    }

    public synchronized int queued() {
        return queue.size();
    }

    private static int size(Object value) {
        if (value instanceof String) return ((String) value).getBytes(StandardCharsets.UTF_8).length;
        if (value instanceof byte[]) return ((byte[]) value).length;
        return 0;
    }
}
