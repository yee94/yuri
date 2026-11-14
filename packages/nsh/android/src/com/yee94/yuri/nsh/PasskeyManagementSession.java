package com.yee94.yuri.nsh;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.function.BooleanSupplier;

/**
 * Full-UI session owner, independent of the paired-client bearer and the global cookie jar. Its caller
 * supplies an exact captured Host and a lifecycle fence, exactly like iOS PasskeyManagementSession.
 * Blocking I/O is injected so the cookie jar, one-attempt registration proof and reset memory stay here.
 */
public final class PasskeyManagementSession {
    /** Header values are lists: a Host may send more than one Set-Cookie. */
    public interface Io {
        Response execute(Request request) throws Exception;
    }

    public static final class Request {
        public final String url;
        public final String method;
        public final Map<String, String> headers;
        public final byte[] body;

        public Request(String url, String method, Map<String, String> headers, byte[] body) {
            this.url = url;
            this.method = method;
            this.headers = Collections.unmodifiableMap(new LinkedHashMap<>(headers));
            this.body = body;
        }
    }

    public static final class Response {
        public final int status;
        public final Map<String, List<String>> headers;
        public final Map<String, Object> body;

        public Response(int status, Map<String, List<String>> headers, Map<String, Object> body) {
            this.status = status;
            this.headers = headers == null ? Collections.<String, List<String>>emptyMap() : headers;
            this.body = body == null ? Collections.<String, Object>emptyMap() : body;
        }

        public List<String> header(String name) {
            List<String> out = new ArrayList<>();
            for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
                if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name) && entry.getValue() != null) {
                    out.addAll(entry.getValue());
                }
            }
            return out;
        }

        /** Raw header map, as a transport adapter receives it. */
        public Map<String, List<String>> headerValues() { return headers; }

        public String first(String name) {
            List<String> values = header(name);
            return values.isEmpty() ? null : values.get(0);
        }
    }

    private static final class PendingProof {
        final String requestID;
        final byte[] options;
        String ceremony;
        String credential;

        PendingProof(String requestID, byte[] options, String ceremony, String credential) {
            this.requestID = requestID;
            this.options = options;
            this.ceremony = ceremony;
            this.credential = credential;
        }
    }

    private final URI origin;
    private final BooleanSupplier current;
    private final Io io;
    private final List<Runnable> cleanup = new ArrayList<>();
    private final Map<Object, Thread> flights = new LinkedHashMap<>();
    private String cookie;
    private PendingProof pending;
    private boolean resetAcknowledged;
    private boolean resetAttempted;
    private boolean retired;

    public PasskeyManagementSession(URI origin, BooleanSupplier current, Io io) {
        this.origin = origin;
        this.current = current;
        this.io = io;
    }

    public URI origin() { return origin; }
    public boolean resetAcknowledged() { return resetAcknowledged; }

    public synchronized void observeRetirement(Runnable action) {
        if (retired) {
            action.run();
            return;
        }
        cleanup.add(action);
    }

    public synchronized void retire() {
        if (retired) return;
        retired = true;
        cookie = null;
        pending = null;
        List<Runnable> actions = new ArrayList<>(cleanup);
        cleanup.clear();
        for (Runnable action : actions) action.run();
        for (Thread thread : new ArrayList<>(flights.values())) thread.interrupt();
        flights.clear();
    }

    /** A retired session or changed Host generation surfaces as passkey_cancelled, like iOS' fence. */
    private void check() throws PasskeyFailure {
        if (Thread.currentThread().isInterrupted()) throw PasskeyFailure.cancelled();
        if (retired || !current.getAsBoolean()) throw PasskeyFailure.cancelled();
    }

    public Response request(String path, String method, Map<String, Object> body) throws Exception {
        check();
        boolean login = "/auth/session".equals(path) && "POST".equals(method);
        if (!login && !PasskeyWire.management(path, method)) throw PasskeyFailure.invalid();
        synchronized (this) {
            if ("/api/auth/reset".equals(path)) {
                if (resetAttempted) throw new PasskeyFailure(PasskeyFailure.RESET);
                resetAttempted = true;
            }
        }
        String host = origin.getHost();
        boolean local = "localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host);
        if (!"https".equals(origin.getScheme()) && !local) throw new PasskeyFailure(PasskeyFailure.RP);
        if ("/auth/passkey/register/verify".equals(path)) {
            PendingProof proof = pending;
            if (proof == null || proof.ceremony == null || proof.credential == null || body == null
                    || !proof.requestID.equals(body.get("requestId"))) throw PasskeyFailure.cancelled();
            Map<String, Object> response = NotificationJson.map(body.get("response"));
            if (response == null || !proof.credential.equals(response.get("id"))
                    || !proof.credential.equals(response.get("rawId"))) throw PasskeyFailure.cancelled();
            // One attempt only, including an unknown network result.
            pending = null;
        }
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Accept", "application/json");
        String sessionCookie = cookie;
        if (sessionCookie != null) headers.put("Cookie", sessionCookie);
        byte[] encoded = null;
        if (body != null) {
            encoded = NotificationJson.stringify(body).getBytes(StandardCharsets.UTF_8);
            headers.put("Content-Type", "application/json");
        }
        Request request = new Request(origin.toString().replaceAll("/+$", "") + path, method, headers, encoded);
        Object ticket = new Object();
        Response response;
        synchronized (this) {
            flights.put(ticket, Thread.currentThread());
        }
        try {
            response = io.execute(request);
        } finally {
            synchronized (this) {
                flights.remove(ticket);
            }
        }
        check();
        Object locked = response.body.get("tunnelLocked");
        if (Boolean.TRUE.equals(locked) || "tunnel".equals(response.body.get("scope"))) {
            cookie = null;
            throw new PasskeyFailure(PasskeyFailure.LOCKED);
        }
        if (response.status >= 300 && response.status < 400) throw new PasskeyFailure(PasskeyFailure.RESPONSE);
        if (response.status == 401) cookie = null;
        if (login && response.status == 200) {
            Object authenticated = response.body.get("authenticated");
            if (!Boolean.TRUE.equals(authenticated) || "client".equals(response.body.get("scope"))) {
                throw new PasskeyFailure(PasskeyFailure.SESSION);
            }
            String session = sessionCookie(response);
            if (session == null) throw new PasskeyFailure(PasskeyFailure.SESSION);
            cookie = session;
        }
        if ("/auth/passkey/register/options".equals(path) && response.status == 200) {
            Object requestID = response.body.get("requestId");
            Map<String, Object> options = NotificationJson.map(response.body.get("optionsJSON"));
            if (!(requestID instanceof String) || ((String) requestID).isEmpty() || options == null) {
                throw new PasskeyFailure(PasskeyFailure.RESPONSE);
            }
            pending = new PendingProof((String) requestID, PasskeyWire.canonical(options), null, null);
        }
        if ("/api/auth/reset".equals(path) && response.status == 200
                && Boolean.TRUE.equals(response.body.get("cleared"))
                && Boolean.TRUE.equals(response.body.get("signedOutEverywhere"))) {
            synchronized (this) {
                resetAcknowledged = true;
                cookie = null;
                pending = null;
            }
        }
        return response;
    }

    public void bind(Map<String, Object> options, String ceremony) throws Exception {
        check();
        PendingProof proof = pending;
        byte[] canonical = PasskeyWire.canonical(options);
        if (proof == null || proof.ceremony != null || !java.util.Arrays.equals(proof.options, canonical)) {
            throw PasskeyFailure.invalid();
        }
        proof.ceremony = ceremony;
    }

    public void complete(String ceremony, String credential) throws Exception {
        check();
        PendingProof proof = pending;
        if (proof == null || !Objects.equals(proof.ceremony, ceremony)) throw PasskeyFailure.cancelled();
        proof.credential = credential;
    }

    public void cancel(String ceremony) {
        PendingProof proof = pending;
        if (proof != null && Objects.equals(proof.ceremony, ceremony)) pending = null;
    }

    private String sessionCookie(Response response) {
        for (String raw : response.header("set-cookie")) {
            String[] parts = raw.split(";");
            if (parts.length == 0) continue;
            int equals = parts[0].indexOf('=');
            if (equals <= 0) continue;
            String name = parts[0].substring(0, equals).trim();
            String value = parts[0].substring(equals + 1).trim();
            if (!"yuri_ui_session".equals(name) || value.isEmpty()) continue;
            String path = "/";
            String domain = origin.getHost();
            for (int index = 1; index < parts.length; index++) {
                String attribute = parts[index].trim();
                int split = attribute.indexOf('=');
                if (split <= 0) continue;
                String key = attribute.substring(0, split).trim().toLowerCase(Locale.ROOT);
                String attributeValue = attribute.substring(split + 1).trim();
                if ("path".equals(key)) path = attributeValue;
                else if ("domain".equals(key)) domain = attributeValue;
            }
            if (!"/".equals(path)) continue;
            String normalized = domain != null && domain.startsWith(".") ? domain.substring(1) : domain;
            if (normalized == null || !normalized.equalsIgnoreCase(origin.getHost())) continue;
            return name + "=" + value;
        }
        return null;
    }
}
