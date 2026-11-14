package com.yee94.yuri.nsh;

import java.util.UUID;

/**
 * Shared synchronous presentation reservation. Cancellation invalidates the receipt without freeing it;
 * only the owning operation's release can drain it. Mirrors iOS PasskeyPresentationAdmission.
 */
public final class PasskeyPresentationAdmission {
    private UUID owner;
    private boolean cancelled;
    private boolean closed;

    public synchronized void requireOpen() throws PasskeyFailure {
        if (closed) throw PasskeyFailure.cancelled();
    }

    public synchronized UUID reserve() throws PasskeyFailure {
        requireOpen();
        if (owner != null) throw new PasskeyFailure(PasskeyFailure.BUSY);
        UUID id = UUID.randomUUID();
        owner = id;
        cancelled = false;
        return id;
    }

    public synchronized boolean isCurrent(UUID id) {
        return !closed && !cancelled && id != null && id.equals(owner);
    }

    public synchronized void check(UUID id) throws PasskeyFailure {
        if (Thread.currentThread().isInterrupted()) throw PasskeyFailure.cancelled();
        if (!isCurrent(id)) throw PasskeyFailure.cancelled();
    }

    public synchronized void cancel(UUID id) {
        if (id != null && id.equals(owner)) cancelled = true;
    }

    public synchronized void release(UUID id) {
        if (id == null || !id.equals(owner)) return;
        owner = null;
        notifyAll();
    }

    public synchronized void beginClose() { closed = true; }

    /** Close waits for the exact live owner's release; call off the UI thread. */
    public synchronized boolean drain(long timeoutMillis) throws InterruptedException {
        long deadline = System.currentTimeMillis() + Math.max(0, timeoutMillis);
        while (owner != null) {
            long remaining = deadline - System.currentTimeMillis();
            if (remaining <= 0) return false;
            wait(remaining);
        }
        return true;
    }

    public synchronized boolean isClosed() { return closed; }
}
