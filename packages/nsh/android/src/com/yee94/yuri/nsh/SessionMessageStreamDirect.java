package com.yee94.yuri.nsh;

import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * Session-only authenticated socket. RuntimeBridge supplies the admitted same-origin
 * request; no credential construction or persistence lives here. Text frames only, so a
 * binary frame is a protocol failure rather than a silently ignored message.
 */
public final class SessionMessageStreamDirect {
    private static final Object INVALID = new Object();
    private static final Object CLOSED = new Object();

    private SessionMessageStreamDirect() {}

    public static SessionMessageStream.Socket open(String url, Map<String, String> headers, int connectTimeoutMs)
            throws Exception {
        final LinkedBlockingQueue<Object> queue = new LinkedBlockingQueue<>(2);
        RuntimeBridgeWebSocket client = RuntimeBridgeWebSocket.connect(url, headers, connectTimeoutMs, 1024 * 1024,
            new RuntimeBridgeWebSocket.Listener() {
                @Override public void onOpen() { /* frames follow */ }

                @Override public void onText(String text) {
                    try { queue.put(text); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                }

                @Override public void onBinary(byte[] data) {
                    try { queue.put(INVALID); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                }

                @Override public void onClosed(int code, String reason, Throwable failure) {
                    try { queue.put(failure == null ? CLOSED : failure); } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                    }
                }
            });
        return new SessionMessageStream.Socket() {
            private boolean closed;

            @Override public String receive() throws Exception {
                if (closed) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                Object value = queue.take();
                if (value == INVALID) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                if (value == CLOSED) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.WEB_SOCKET_CLOSED);
                if (value instanceof Throwable) throw (Exception) value;
                return (String) value;
            }

            @Override public void close() {
                if (closed) return;
                closed = true;
                client.close();
            }
        };
    }
}
