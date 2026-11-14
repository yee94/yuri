package com.yee94.yuri.nsh;

import java.net.URI;
import java.util.Map;

/**
 * Captured native-only management transport, the Android peer of iOS PasskeyTransport. No cookie,
 * password or bearer crosses JS; the runtime owner supplies origin, generation fence and the exact
 * proof hooks for one ceremony.
 */
public interface PasskeyTransport {
    final class Response {
        public final int status;
        public final Map<String, Object> body;

        public Response(int status, Map<String, Object> body) {
            this.status = status;
            this.body = body;
        }
    }

    /** Immutable origin the management session, RP check and cookie jar are bound to. */
    URI origin();

    boolean isCurrent();

    /** Full-UI session request; never the paired-client bearer and never a Relay transport. */
    Response request(String path, String method, Map<String, Object> body) throws Exception;

    /** Binds the one-shot registration proof to this ceremony. */
    void bind(Map<String, Object> options, String ceremony) throws Exception;

    /** Attaches the finished credential so exactly one verify may consume it. */
    void complete(String ceremony, String credential) throws Exception;

    void cancel(String ceremony);

    /** Completes only after the Host reset ACK and the exact authorization retirement chain. */
    void reset() throws Exception;

    void onRetire(Runnable cleanup);
}
