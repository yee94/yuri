package com.yee94.yuri.nsh;

import android.app.Activity;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

import java.io.InputStream;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.function.Predicate;

/**
 * Same-origin Host requests, pairing, credentials, event streams and connection lifecycle.
 *
 * <p>This is also the only {@link HostLease} implementation: every other bridge captures a
 * lease and never sees a URL, cookie, password or bearer. Android-specific choices are
 * deliberate and visible here: the client announces {@code devicePlatform: android} and
 * {@code Yuri Native Android}, and the transport is a hand-written socket HTTP/WS client
 * because the SDK ships neither PATCH support nor a WebSocket client and no dependency
 * may be added.
 */
public final class RuntimeBridge implements HostLeaseProvider, AttachmentRuntime {
    /** Native-only exact old authorization cleanup; never fired for ordinary invalidation. */
    public interface AuthorizationRetired {
        void retire(String connectionID, String authorizationID) throws Exception;
    }

    /**
     * Passkey management keeps a separate full UI-session cookie owner; on iOS that owner
     * lives in PasskeyBridge's transport. Here it is reached through
     * {@link PasskeyTransportSource} on the captured lease, so no credential handling moves
     * out of the runtime.
     */
    public interface StreamListener {
        void onOpen(int status, Map<String, String> headers);
        void onData(byte[] chunk);
        void onClosed(Throwable failure);
    }

    public interface Stream { void close(); }

    private static final int RESPONSE_LIMIT = 32 * 1024 * 1024;
    private static final int CONNECT_TIMEOUT = 20000;
    /** iOS TerminalTransportWire.responseLimit / inputLimit. */
    private static final int TERMINAL_LIMIT = 65536;
    /** iOS VoiceRecognitionWire fileLimit / responseLimit. */
    private static final int RECOGNITION_FILE_LIMIT = 1_920_044;
    private static final int RECOGNITION_RESPONSE_LIMIT = 131072;
    /** iOS resourceTransport.speech limit for synthesized audio. */
    private static final int SPEECH_LIMIT = 16 * 1024 * 1024;
    /** iOS attachmentUploader limit for one plain attachment. */
    private static final int ATTACHMENT_LIMIT = 25 * 1024 * 1024;
    /** iOS guiResources budget: at most eight paired GUI request lanes. */
    private static final int GUI_READERS = 8;

    private final Activity activity;
    private final ConnectionStore store;
    private final RuntimeHostAuthority authority = new RuntimeHostAuthority();
    private final Object stateLock = new Object();
    private final ExecutorService worker;
    private final Set<Lease> leases = ConcurrentHashMap.newKeySet();

    private final Map<String, RelayTunnel> tunnels = new LinkedHashMap<>();
    private final Map<String, StreamJob> streams = new LinkedHashMap<>();
    private final Map<String, HostLease.Scope> streamScopes = new LinkedHashMap<>();
    private final Map<String, String> streamTokens = new LinkedHashMap<>();
    private String chatStreamOwner;
    private QrScannerBridge qrScanner;

    private int generation;
    private int connectionAttempt;
    private NshView view;
    private Runnable onInvalidate;
    private AuthorizationRetired onAuthorizationRetired;
    private final Map<String, PasskeyManagementSession> passkeySessions = new LinkedHashMap<>();
    private final Set<ConnectionEditorRetirement> failedRetirements = new LinkedHashSet<>();
    private final Set<ConnectionEditorRetirement> retiring = new LinkedHashSet<>();
    private final Object retirementLock = new Object();
    private boolean retirementRunning;

    public RuntimeBridge(Activity activity, ConnectionStore store) {
        this.activity = activity;
        this.store = store;
        this.worker = Executors.newCachedThreadPool(new ThreadFactory() {
            private final AtomicInteger count = new AtomicInteger();

            @Override public Thread newThread(Runnable runnable) {
                Thread thread = new Thread(runnable, "yuri-nsh-runtime-" + count.incrementAndGet());
                thread.setDaemon(true);
                return thread;
            }
        });
    }

    public ConnectionStore store() { return store; }

    public void setOnInvalidate(Runnable value) { onInvalidate = value; }

    public void setOnAuthorizationRetired(AuthorizationRetired value) { onAuthorizationRetired = value; }

    /** Registers the Host calls owned by the runtime; safe to call once per NshView. */
    public void install(NshView target) {
        view = target;
        target.handle("connection.list", (data, reply) -> async(reply, this::snapshot));
        target.handle("connection.editor", (data, reply) -> async(reply, () -> {
            return store.editor(string(data, "id"));
        }));
        target.handle("connection.rename", (data, reply) -> async(reply, () -> {
            requireForeground();
            store.edit(ConnectionEditorInput.parse(data, true));
            return snapshot();
        }));
        target.handle("connection.edit", (data, reply) -> async(reply, () -> {
            requireForeground();
            store.edit(ConnectionEditorInput.parse(data, false));
            return snapshot();
        }));
        target.handle("connection.select", (data, reply) -> async(reply, () -> {
            requireForeground();
            store.select(string(data, "id"));
            stop();
            return snapshot();
        }));
        target.handle("connection.remove", (data, reply) -> async(reply, () -> {
            requireForeground();
            String id = string(data, "id");
            ConnectionEditorConnection selected = store.selected();
            boolean current = selected != null && selected.id.equals(id);
            store.remove(id);
            if (current) stop();
            retryAuthorizationRetirementsBlocking();
            return snapshot();
        }));
        target.handle("connection.connect", (data, reply) -> async(reply, () -> connect(data)));
        target.handle("runtime.request", (data, reply) -> async(reply, () -> request(data)));
        target.handle("runtime.stream", (data, reply) -> async(reply, () -> startStream(data)));
        target.handle("runtime.stop", (data, reply) -> async(reply, () -> stopStream(data)));
        // camera.scan is owned here (QrScanner) but is not part of the runtime surface; it
        // hangs off install so exactly one instance exists per view.
        qrScanner = new QrScannerBridge(activity, this, target);
        qrScanner.install();
    }

    public void invalidate() {
        QrScannerBridge scanner = qrScanner;
        if (scanner != null) scanner.invalidate();
        retireResources();
    }

    /** Native lifecycle only. Default admission is closed, including queued JS calls. */
    public void setForeground(boolean active) {
        boolean changed;
        synchronized (stateLock) {
            changed = authority.setForeground(active, selectedID());
        }
        if (!changed) return;
        retireResources();
    }

    public void stop() {
        synchronized (stateLock) {
            authority.rotate(selectedID());
        }
        retireResources();
    }

    public Map<String, Object> snapshot() {
        Map<String, Object> value = new LinkedHashMap<>(store.snapshot());
        ConnectionEditorConnection selected = store.selected();
        RuntimeHostScope scope = authority.scope(selected == null ? null : selected.id);
        value.put("runtimeScope", scope == null ? null : scope.publicValue());
        value.put("authorizationCleanup", authorizationRetirementStatus());
        return value;
    }

    public Map<String, Object> authorizationRetirementStatus() {
        List<ConnectionEditorRetirement> pending = store.pendingAuthorizationRetirements();
        int failed = 0;
        synchronized (retirementLock) {
            for (ConnectionEditorRetirement value : pending) {
                if (onAuthorizationRetired == null || failedRetirements.contains(value)) failed += 1;
            }
        }
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("pending", pending.size());
        status.put("failed", failed);
        return status;
    }

    /** Retries cleanup only; it never repeats removal, reauthorization or a reset POST. */
    public void retryAuthorizationRetirements() {
        worker.execute(this::retryAuthorizationRetirementsBlocking);
    }

    /** One retry round off the caller's thread; completes with the resulting safe counts. */
    public CompletableFuture<Map<String, Object>> retryAuthorizationRetirementsOnce() {
        CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        worker.execute(() -> {
            try {
                retryAuthorizationRetirementsBlocking();
                future.complete(authorizationRetirementStatus());
            } catch (Throwable failure) {
                future.completeExceptionally(failure);
            }
        });
        return future;
    }

    private void retryAuthorizationRetirementsBlocking() {
        synchronized (retirementLock) {
            if (retirementRunning) return;
            retirementRunning = true;
        }
        try {
            List<ConnectionEditorRetirement> pending = store.pendingAuthorizationRetirements();
            synchronized (retirementLock) { failedRetirements.retainAll(pending); }
            for (ConnectionEditorRetirement value : pending) retireAuthorization(value);
        } finally {
            synchronized (retirementLock) { retirementRunning = false; }
        }
    }

    private void retireAuthorization(ConnectionEditorRetirement value) {
        synchronized (retiring) {
            if (!store.pendingAuthorizationRetirements().contains(value) || !retiring.add(value)) return;
        }
        try {
            AuthorizationRetired cleanup = onAuthorizationRetired;
            if (cleanup == null) {
                synchronized (retirementLock) { failedRetirements.add(value); }
            } else {
                try {
                    cleanup.retire(value.connectionID, value.authorizationID);
                    store.acknowledgeAuthorizationRetirement(value.connectionID, value.authorizationID);
                    synchronized (retirementLock) { failedRetirements.remove(value); }
                } catch (Exception failure) {
                    boolean stillPending = store.pendingAuthorizationRetirements().contains(value);
                    synchronized (retirementLock) {
                        if (stillPending) failedRetirements.add(value);
                        else failedRetirements.remove(value);
                    }
                }
            }
        } finally {
            synchronized (retiring) { retiring.remove(value); }
        }
        // Counts only: never identifiers, credential state or callback error text.
        NshView target = view;
        if (target != null) target.send("runtime.authorizationRetirement", authorizationRetirementStatus());
    }

    // ----------------------------------------------------------------- host leases

    @Override
    public HostLease capture(HostLease.Scope expected) throws Exception {
        RuntimeHostScope parsed = null;
        if (expected != null) {
            parsed = new RuntimeHostScope(expected.hostID, expected.lease);
            // Re-validate through the shared parser so a hand-built scope cannot skip it.
            Map<String, Object> probe = new LinkedHashMap<>();
            probe.put("hostID", expected.hostID);
            probe.put("lease", expected.lease);
            parsed = RuntimeHostScope.parse(probe);
        }
        HostAdmission admission = admit(parsed, expected != null);
        Lease lease = new Lease(admission.connection, admission.generation, admission.expectedHost);
        leases.add(lease);
        if (!lease.isCurrent()) {
            lease.retire();
            leases.remove(lease);
            throw RuntimeHostScopeFailure.stale();
        }
        return lease;
    }

    /** Convenience for bridges that must observe the current admission without a JS scope. */
    public HostLease captureCurrent() throws Exception { return capture(null); }

    // ----------------------------------------------------------------- attachments

    /**
     * iOS AttachmentBridge's runtime half. The picker, journal and receipt phases stay
     * with AttachmentBridge; only the authenticated transport and the exact original
     * connection live here, so no URL or credential crosses the TSX bridge.
     */
    @Override
    public void validateAttachmentHost(HostLease.Scope expected) throws Exception {
        admitAttachments(expected, true);
    }

    @Override
    public Map<String, Object> uploadPlain(HostLease.Scope expected, byte[] data, String name, String mime)
            throws Exception {
        HostAdmission admission = admitAttachments(expected, true);
        ConnectionEditorConnection connection = admission.connection;
        if (data == null || data.length == 0 || data.length > ATTACHMENT_LIMIT) {
            throw new RuntimeBridgeFailure("attachment_upload_invalid", "附件须为非空文件，且不超过 25 MiB");
        }
        if (name == null || name.isEmpty() || mime == null || mime.isEmpty()
                || RuntimeHostText.hasControl(name) || RuntimeHostText.hasControl(mime)) {
            throw new RuntimeBridgeFailure("attachment_upload_invalid", "无效的附件");
        }
        String digest = AttachmentUploadPolicy.sha256(data);
        String identifier = UUID.randomUUID().toString().toLowerCase(Locale.ROOT);
        Request request = makeRequest("/api/fs/prompt-attachments/" + identifier + "?storage=temporary",
            connection, "PUT", null, false);
        request.body = data;
        request.timeoutMs = 120000;
        request.headers.put("Content-Type", mime);
        request.headers.put("X-Yuri-Content-Length", Integer.toString(data.length));
        request.headers.put("X-Yuri-Sha256", digest);
        request.headers.put("X-Yuri-Mime", mime);
        request.headers.put("X-Yuri-Filename", AttachmentUploadPolicy.encode(name));
        HostLease.JsonResponse response = attachmentJSON(request, connection, admission.generation,
            admission.expectedHost);
        String message = "附件上传失败 (" + response.status + ")，请重新选择文件重试";
        if (response.status != 200 || !(response.body instanceof Map)
                || !Boolean.TRUE.equals(((Map<?, ?>) response.body).get("success"))) {
            throw new RuntimeBridgeFailure("attachment_upload_failed", message);
        }
        Map<?, ?> result = (Map<?, ?>) response.body;
        Object hostPath = result.get("path");
        Object size = result.get("size");
        if (!(hostPath instanceof String) || !digest.equals(result.get("sha256"))
                || !(size instanceof Number) || ((Number) size).longValue() != data.length) {
            throw new RuntimeBridgeFailure("attachment_upload_failed", message);
        }
        String localPath = RuntimeBridgeAttachments.localPath((String) hostPath);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("uri", RuntimeBridgeAttachments.fileURL(localPath));
        value.put("name", name);
        value.put("mime", mime);
        return value;
    }

    @Override
    public AttachmentRuntime.Operation contactOperation(HostLease.Scope expected, String assistantID,
            Integer expectedGeneration, String requestID, AttachmentReceiptJournal.DraftContext context,
            AttachmentReceiptJournal journal) throws Exception {
        HostAdmission admission = admitAttachments(expected, true);
        final ConnectionEditorConnection connection = admission.connection;
        final RuntimeHostScope scope = admission.expectedHost;
        final int leaseGeneration = admission.generation;
        final String transportID = connection.transportID;
        final String authorizationID = connection.authorizationID;
        final String connectionVersion = connection.editorVersion;
        if (authorizationID == null || "legacy".equals(authorizationID) || transportID == null
                || connectionVersion == null || "legacy".equals(connectionVersion)) {
            throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.AUTHORIZATION_UNAVAILABLE);
        }
        final AttachmentUploadPolicy policy = new AttachmentUploadPolicy(assistantID);
        final BooleanSupplier current = () -> attachmentCurrent(connection, leaseGeneration, scope,
            transportID, authorizationID, connectionVersion);
        AttachmentUploadPolicy.Send send = request -> attachmentSend(request, connection, leaseGeneration, scope,
            transportID, authorizationID, connectionVersion);
        policy.prepare(expectedGeneration, current, send);
        Integer generation = expectedGeneration != null ? expectedGeneration : policy.generation();
        if (generation == null) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        AttachmentReceiptJournal.Record record = new AttachmentReceiptJournal.Record(requestID, policy.uploadID,
            assistantID, connection.id, transportID, authorizationID, connectionVersion, generation,
            context.identity, context.revision, context.pageOperation, "prepared", null);
        journal.insert(record);
        policy.persistWith((phase, descriptor) -> journal.update(requestID, policy.uploadID, phase, descriptor));
        // Exact retirement keeps the original authenticated identity and never asks for
        // a new admission or scope, matching the iOS cleanup closure.
        AttachmentUploadPolicy.Send cleanup = request -> {
            if (!"DELETE".equals(request.method)) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            }
            ConnectionEditorConnection original = store.attachmentConnection(record.connectionID,
                record.transportID, record.authorizationID, record.connectionVersion);
            Request wire = makeRequest(request.path, original, "DELETE", null, false);
            if (request.data.length > 0) wire.body = request.data;
            wire.timeoutMs = 120000;
            wire.headers.put("Content-Type", "application/json");
            applyHeaders(wire, request.headers);
            HostLease.JsonResponse response = executeJSON(wire, original, null);
            return new AttachmentUploadPolicy.Response(response.status, response.body);
        };
        return new AttachmentRuntime.Operation(
            (data, name, mime) -> {
                try {
                    return policy.upload(data, name, mime, current, send);
                } catch (AttachmentUploadPolicy.Failure failure) {
                    if (!policy.attempted()) {
                        throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.NOT_DISPATCHED);
                    }
                    throw failure;
                }
            },
            () -> policy.reconcile(current, send),
            () -> {
                if (!policy.retired()) policy.retire(cleanup);
                journal.remove(requestID, policy.uploadID);
            },
            descriptor -> {
                policy.acknowledge(descriptor, () -> attachmentKnown(record));
                journal.remove(requestID, policy.uploadID);
            },
            policy::attempted);
    }

    @Override
    public AttachmentRuntime.Operation restoreOperation(AttachmentReceiptJournal.Record saved,
            HostLease.Scope expected, AttachmentReceiptJournal journal) throws Exception {
        final HostAdmission admission = expected == null ? null : admitAttachments(expected, true);
        if (admission != null && !admission.connection.id.equals(saved.connectionID)) {
            throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.AUTHORIZATION_UNAVAILABLE);
        }
        // Cold restoration never captures a PUT capability; every GET/DELETE resolves
        // the exact original credential identity again.
        store.attachmentConnection(saved.connectionID, saved.transportID, saved.authorizationID,
            saved.connectionVersion);
        final AttachmentUploadPolicy policy = AttachmentUploadPolicy.restoring(saved.assistantID, saved.uploadID,
            saved.generation, saved.descriptor, saved.phase);
        policy.persistWith((phase, descriptor) ->
            journal.update(saved.requestID, saved.uploadID, phase, descriptor));
        final BooleanSupplier current = () -> admission != null
            && attachmentCurrent(admission.connection, admission.generation, admission.expectedHost,
                saved.transportID, saved.authorizationID, saved.connectionVersion);
        AttachmentUploadPolicy.Send send = request -> {
            if (!"GET".equals(request.method) && !"DELETE".equals(request.method)) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            }
            ConnectionEditorConnection original = store.attachmentConnection(saved.connectionID,
                saved.transportID, saved.authorizationID, saved.connectionVersion);
            Request wire = makeRequest(request.path, original, request.method, null, false);
            if (request.data.length > 0) wire.body = request.data;
            wire.timeoutMs = 120000;
            applyHeaders(wire, request.headers);
            HostLease.JsonResponse response = executeJSON(wire, original, null);
            store.attachmentConnection(saved.connectionID, saved.transportID, saved.authorizationID,
                saved.connectionVersion);
            return new AttachmentUploadPolicy.Response(response.status, response.body);
        };
        return new AttachmentRuntime.Operation(
            (data, name, mime) -> {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            },
            () -> policy.reconcile(current, send),
            () -> {
                if (!policy.retired()) policy.retire(send);
                journal.remove(saved.requestID, saved.uploadID);
            },
            descriptor -> {
                policy.acknowledge(descriptor, () -> attachmentKnown(saved));
                journal.remove(saved.requestID, saved.uploadID);
            },
            () -> true);
    }

    private HostAdmission admitAttachments(HostLease.Scope expected, boolean required) throws Exception {
        if (expected == null) throw RuntimeHostScopeFailure.stale();
        Map<String, Object> probe = new LinkedHashMap<>();
        probe.put("hostID", expected.hostID);
        probe.put("lease", expected.lease);
        return admit(RuntimeHostScope.parse(probe), required);
    }

    private boolean attachmentCurrent(ConnectionEditorConnection connection, int leaseGeneration,
            RuntimeHostScope expected, String transportID, String authorizationID, String version) {
        try {
            checkHost(connection, leaseGeneration, expected);
            attachmentKnown(connection.id, transportID, authorizationID, version);
            return true;
        } catch (RuntimeBridgeFailure failure) {
            return false;
        }
    }

    private boolean attachmentKnown(AttachmentReceiptJournal.Record record) {
        return attachmentKnown(record.connectionID, record.transportID, record.authorizationID,
            record.connectionVersion);
    }

    private boolean attachmentKnown(String connectionID, String transportID, String authorizationID,
            String version) {
        try {
            store.attachmentConnection(connectionID, transportID, authorizationID, version);
            return true;
        } catch (RuntimeBridgeFailure failure) {
            return false;
        }
    }

    private AttachmentUploadPolicy.Response attachmentSend(AttachmentUploadPolicy.Request upload,
            ConnectionEditorConnection connection, int leaseGeneration, RuntimeHostScope expected,
            String transportID, String authorizationID, String version) throws Exception {
        checkHost(connection, leaseGeneration, expected);
        store.attachmentConnection(connection.id, transportID, authorizationID, version);
        Request wire = makeRequest(upload.path, connection, upload.method, null, false);
        if (upload.data.length > 0) wire.body = upload.data;
        wire.timeoutMs = 120000;
        applyHeaders(wire, upload.headers);
        HostLease.JsonResponse response = attachmentJSON(wire, connection, leaseGeneration, expected);
        store.attachmentConnection(connection.id, transportID, authorizationID, version);
        return new AttachmentUploadPolicy.Response(response.status, response.body);
    }

    private HostLease.JsonResponse attachmentJSON(Request request, ConnectionEditorConnection connection,
            int leaseGeneration, RuntimeHostScope expected) throws Exception {
        checkHost(connection, leaseGeneration, expected);
        HostLease.JsonResponse response = executeJSON(request, connection, null);
        checkHost(connection, leaseGeneration, expected);
        return response;
    }

    private static void applyHeaders(Request request, Map<String, String> headers) {
        if (headers == null) return;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey() == null || entry.getValue() == null) continue;
            request.headers.put(entry.getKey(), entry.getValue());
        }
    }

    // ----------------------------------------------------------------- gui preview

    /**
     * iOS guiPluginPreviewCapture: one admission plus the buffered GUI read lane.
     * The lossless openGui lane is not offered on Android, so an openGui-only
     * capture still reports unsupported instead of pretending to stream.
     */
    public GuiPluginPreviewBridge.Capture guiPluginPreviewCapture(RuntimeHostScope expectedHost) throws Exception {
        final HostAdmission admission = admit(expectedHost, true);
        final Lease lease = new Lease(admission.connection, admission.generation, admission.expectedHost);
        leases.add(lease);
        if (!lease.isCurrent()) {
            lease.retire();
            leases.remove(lease);
            throw RuntimeHostScopeFailure.stale();
        }
        final RuntimeHostScope expected = admission.expectedHost;
        final ConnectionEditorConnection connection = admission.connection;
        final int leaseGeneration = admission.generation;
        final AtomicInteger readers = new AtomicInteger();
        RuntimeHostUri.Parts captured = RuntimeHostUri.parse(connection.url);
        final String capturedScheme = captured == null || captured.scheme == null ? "" : captured.scheme;
        final String capturedHost = captured == null || captured.host == null ? "" : captured.host;
        final int capturedPort = captured == null ? -1 : captured.effectivePort();

        GuiPluginPreviewBridge.GuiReader readGui = (host, request, limit) -> {
            if (request == null || limit <= 0 || limit > GuiPluginPreviewBridge.REPLY_LIMIT) {
                return ResourceWebPreviewScope.failedFuture(ResourceFailure.limit());
            }
            if (host == null || !expected.equals(host)) {
                return ResourceWebPreviewScope.failedFuture(ResourceFailure.stale());
            }
            if (readers.incrementAndGet() > GUI_READERS) {
                readers.decrementAndGet();
                return ResourceWebPreviewScope.failedFuture(ResourceFailure.busy());
            }
            try {
                return CompletableFuture.completedFuture(
                    guiPluginRead(request, connection, leaseGeneration, expected, limit));
            } catch (Throwable failure) {
                return ResourceWebPreviewScope.failedFuture(ResourceWebPreviewScope.asException(failure));
            } finally {
                readers.decrementAndGet();
            }
        };

        GuiPluginPreviewBridge.Capture capture = new GuiPluginPreviewBridge.Capture(expected,
            host -> lease.isCurrent(),
            ResourceWebPreviewBridge.transport(lease),
            (path, limit) -> {
                throw ResourceFailure.unavailable();
            });
        capture.readGui = readGui;
        capture.isHostResourceURL = url -> {
            if (!lease.isCurrent()) return false;
            RuntimeHostUri.Parts parts = RuntimeHostUri.parse(url);
            return parts != null && parts.userInfo == null && parts.host != null && parts.scheme != null
                && ("http".equals(parts.scheme) || "https".equals(parts.scheme))
                && parts.scheme.equals(capturedScheme) && parts.host.equalsIgnoreCase(capturedHost)
                && parts.effectivePort() == capturedPort;
        };
        return capture;
    }

    private GuiPluginPreviewBridge.Response guiPluginRead(GuiPluginPreviewBridge.Request input,
            ConnectionEditorConnection connection, int leaseGeneration, RuntimeHostScope expected, int limit)
            throws Exception {
        checkHost(connection, leaseGeneration, expected);
        Request wire = makeRequest(input.route, connection, input.method, null, false);
        if (input.body != null) {
            wire.body = input.body;
            if (!wire.headers.containsKey("Content-Type")) {
                wire.headers.put("Content-Type", "application/octet-stream");
            }
        }
        applyHeaders(wire, input.headers);
        wire.timeoutMs = 300000;
        GuiPluginPreviewBridge.Response response;
        if (connection.relay != null) {
            final java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            RelayTunnel.Response result = tunnelFor(connection.relay).stream(route(wire), wire.method,
                wire.headers, wire.body, 300, (status, headers) -> {
                    String declared = header(headers, "content-length");
                    if (declared != null) {
                        try {
                            if (Long.parseLong(declared.trim()) > limit) throw ResourceFailure.limit();
                        } catch (NumberFormatException ignored) {
                            // The byte bound below answers a malformed length.
                        }
                    }
                }, chunk -> {
                    if (buffer.size() + chunk.length > limit) throw ResourceFailure.limit();
                    buffer.write(chunk, 0, chunk.length);
                });
            GuiPluginRuntime.Head head = new GuiPluginRuntime.Head(result.status,
                normalizeHeaders(result.headers));
            response = new GuiPluginPreviewBridge.Response(head.status, head.mime, buffer.toByteArray(),
                head.headers);
        } else {
            RuntimeBridgeHttp.Response result = RuntimeBridgeHttp.read(wire.url, wire.method, wire.headers,
                wire.body, limit, CONNECT_TIMEOUT, (int) wire.timeoutMs);
            GuiPluginRuntime.Head head = new GuiPluginRuntime.Head(result.status,
                normalizeHeaders(result.headers));
            response = new GuiPluginPreviewBridge.Response(head.status, head.mime, result.data, head.headers);
        }
        checkHost(connection, leaseGeneration, expected);
        return response;
    }

    private final class Lease implements HostLease, PasskeyTransportSource, NotificationHostScope.Authorization,
            TerminalTransport.RawPost, VoiceRecognitionRuntime.RawUpload, SpeechPlaybackBridge.TextPost {
        private final ConnectionEditorConnection connection;
        private final int leaseGeneration;
        private final Scope scope;
        private final List<Runnable> cleanups = new ArrayList<>();
        private boolean retired;

        Lease(ConnectionEditorConnection connection, int leaseGeneration, RuntimeHostScope scope) {
            this.connection = connection.copy();
            this.leaseGeneration = leaseGeneration;
            this.scope = scope.toLeaseScope();
        }

        @Override public Scope scope() { return scope; }

        /**
         * Durable authorization generation of the captured connection. It rotates on
         * re-pair, origin or credential change and is never derived from JS or the editor
         * version; a legacy record without one stays null so receipt owners fail closed.
         */
        @Override public String authorizationID() { return connection.authorizationID; }

        @Override public PasskeyTransport passkeyTransport() throws Exception {
            return RuntimeBridge.this.passkeyTransport(
                new HostAdmission(connection, leaseGeneration, RuntimeHostScope.fromLeaseScope(scope)));
        }

        @Override public boolean isCurrent() {
            synchronized (cleanups) { if (retired) return false; }
            try {
                checkHost(connection, leaseGeneration, RuntimeHostScope.fromLeaseScope(scope));
                return true;
            } catch (RuntimeBridgeFailure failure) {
                return false;
            }
        }

        @Override public void onRetire(Runnable cleanup) {
            synchronized (cleanups) {
                if (!retired) { cleanups.add(cleanup); return; }
            }
            cleanup.run();
        }

        void retire() {
            List<Runnable> pending;
            synchronized (cleanups) {
                if (retired) return;
                retired = true;
                pending = new ArrayList<>(cleanups);
                cleanups.clear();
            }
            for (Runnable cleanup : pending) {
                try { cleanup.run(); } catch (RuntimeException ignored) { /* isolation */ }
            }
        }

        private boolean alive() {
            synchronized (cleanups) { return !retired; }
        }

        @Override public CompletableFuture<JsonResponse> json(String path, String method, Map<String, ?> body) {
            CompletableFuture<JsonResponse> future = new CompletableFuture<>();
            worker.execute(() -> {
                try { future.complete(jsonBlocking(path, method, body)); }
                catch (Throwable failure) { future.completeExceptionally(failure); }
            });
            return future;
        }

        private JsonResponse jsonBlocking(String path, String method, Map<String, ?> body) throws Exception {
            if (!alive()) throw RuntimeHostScopeFailure.stale();
            String verb = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
            if (!verb.matches("[A-Z]+")) throw new RuntimeBridgeFailure("invalid_http_method");
            Object payload = body == null ? null : new LinkedHashMap<String, Object>(body);
            Request request = makeRequest(path, connection, verb, payload, false);
            checkHost(connection, leaseGeneration, RuntimeHostScope.fromLeaseScope(scope));
            HostLease.JsonResponse response = executeJSON(request, connection, null);
            if (!alive()) throw RuntimeHostScopeFailure.stale();
            checkHost(connection, leaseGeneration, RuntimeHostScope.fromLeaseScope(scope));
            return response;
        }

        @Override public CompletableFuture<RawResponse> read(String path, int limit) {
            CompletableFuture<RawResponse> future = new CompletableFuture<>();
            worker.execute(() -> {
                try { future.complete(readBlocking(path, limit)); }
                catch (Throwable failure) { future.completeExceptionally(failure); }
            });
            return future;
        }

        private RawResponse readBlocking(String path, int limit) throws Exception {
            if (!alive()) throw RuntimeHostScopeFailure.stale();
            if (limit <= 0 || limit > 25 * 1024 * 1024) throw new RuntimeBridgeFailure("invalid_read_request", "无效的文件读取请求");
            RuntimeHostUri.Parts parts = RuntimeHostUri.parse(path);
            if (parts == null) throw new RuntimeBridgeFailure("invalid_read_request", "无效的文件读取请求");
            String route = parts.path;
            // /api/fs/read is the terminal discovery read; the resource routes keep their
            // exact iOS allowlist and the contact-attachment route stays query-free.
            boolean allowed = "/api/fs/stat".equals(route) || "/api/fs/read".equals(route)
                || route.startsWith("/api/fs/serve/")
                || (parts.query == null && route.matches("/api/yuri/assistants/[^/]+/contact/attachments/[A-Za-z0-9][A-Za-z0-9._-]{0,127}"));
            if (!allowed) throw new RuntimeBridgeFailure("invalid_read_request", "无效的文件读取请求");
            Request request = makeRequest(path, connection, "GET", null, false);
            request.headers.put("Accept", "*/*");
            request.timeoutMs = 60000;
            checkHost(connection, leaseGeneration, RuntimeHostScope.fromLeaseScope(scope));
            if (connection.relay != null) {
                final java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                RelayTunnel.Response response = tunnelFor(connection.relay).stream(route(request), request.method,
                    request.headers, null, 60, (status, headers) -> {
                        String declared = header(headers, "content-length");
                        if (declared != null) {
                            try {
                                if (Long.parseLong(declared.trim()) > limit) {
                                    throw new RuntimeBridgeFailure("resource_limit", "文件超过原生预览大小限制");
                                }
                            } catch (NumberFormatException ignored) {
                                // A malformed length is answered by the byte bound below.
                            }
                        }
                    }, chunk -> {
                        if (buffer.size() + chunk.length > limit) {
                            throw new RuntimeBridgeFailure("resource_limit", "文件超过原生预览大小限制");
                        }
                        buffer.write(chunk, 0, chunk.length);
                    });
                checkHost(connection, leaseGeneration, RuntimeHostScope.fromLeaseScope(scope));
                String relayMime = header(response.headers, "content-type");
                return new RawResponse(response.status,
                    relayMime == null ? "application/octet-stream" : relayMime, buffer.toByteArray(),
                    normalizeHeaders(response.headers));
            }
            RuntimeBridgeHttp.Response response = RuntimeBridgeHttp.read(request.url, request.method, request.headers,
                null, limit, CONNECT_TIMEOUT, (int) request.timeoutMs);
            checkHost(connection, leaseGeneration, RuntimeHostScope.fromLeaseScope(scope));
            String mime = response.header("content-type");
            return new RawResponse(response.status, mime == null ? "application/octet-stream" : mime, response.data,
                normalizeHeaders(response.headers));
        }

        /**
         * One interface, two exact Host requests: terminal input posts a raw {@code text/plain}
         * body to one session's input route; speech posts {@code {text}} to a TTS route and
         * accepts audio. Anything else is invalid, never a generic proxy.
         */
        @Override public RawResponse postText(String path, String text) throws Exception {
            if (path == null || text == null || text.isEmpty()) {
                throw new RuntimeBridgeFailure("invalid_post", "无效的请求内容");
            }
            if (path.matches("/api/terminal/[A-Za-z0-9_-]{1,128}/input")) {
                if (RuntimeHostText.utf8Length(text) > TERMINAL_LIMIT) {
                    throw new RuntimeBridgeFailure("invalid_post", "无效的请求内容");
                }
                Map<String, String> headers = new LinkedHashMap<>();
                headers.put("Content-Type", "text/plain");
                return postRaw(path, headers, text.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    TERMINAL_LIMIT, 15000);
            }
            if ("/api/tts/speak".equals(path) || "/api/tts/say/speak".equals(path)
                    || "/api/dictation/tts/speak".equals(path)) {
                if (RuntimeHostText.utf8Length(text) > 4096) {
                    throw new RuntimeBridgeFailure("invalid_post", "无效的朗读请求");
                }
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("text", text);
                Map<String, String> headers = new LinkedHashMap<>();
                headers.put("Accept", "audio/*");
                return postRaw(path, headers,
                    RuntimeBridgeJson.stringify(body).getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    SPEECH_LIMIT, 60000);
            }
            throw new RuntimeBridgeFailure("invalid_post", "无效的请求内容");
        }

        /** Exactly POST /api/stt/transcribe with audio/wav, the capturing lease's credential. */
        @Override public RawResponse postBytes(String path, String mime, byte[] body) throws Exception {
            if (!"/api/stt/transcribe".equals(path) || !"audio/wav".equals(mime)) {
                throw new RuntimeBridgeFailure("invalid_post", "无效的请求内容");
            }
            if (body == null || body.length == 0 || body.length > RECOGNITION_FILE_LIMIT) {
                throw new RuntimeBridgeFailure("invalid_post", "音频超过大小限制");
            }
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("Content-Type", "audio/wav");
            return postRaw(path, headers, body, RECOGNITION_RESPONSE_LIMIT, 90000);
        }

        private RawResponse postRaw(String path, Map<String, String> headers, byte[] body, int limit, long timeoutMs)
                throws Exception {
            if (!alive()) throw RuntimeHostScopeFailure.stale();
            Request request = makeRequest(path, connection, "POST", null, false);
            if (headers != null) {
                for (Map.Entry<String, String> entry : headers.entrySet()) {
                    if (entry.getKey() == null || entry.getValue() == null) continue;
                    request.headers.put(entry.getKey(), entry.getValue());
                }
            }
            request.body = body;
            request.timeoutMs = timeoutMs;
            checkHost(connection, leaseGeneration, RuntimeHostScope.fromLeaseScope(scope));
            if (connection.relay != null) {
                final java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                RelayTunnel.Response response = tunnelFor(connection.relay).stream(route(request), "POST",
                    request.headers, body, Math.max(1, timeoutMs / 1000), (status, received) -> {
                        String declared = header(received, "content-length");
                        if (declared != null) {
                            try {
                                if (Long.parseLong(declared.trim()) > limit) {
                                    throw new RuntimeBridgeFailure("post_limit", "响应超过大小限制");
                                }
                            } catch (NumberFormatException ignored) {
                                // The byte bound in onData answers a malformed length.
                            }
                        }
                    }, chunk -> {
                        if (buffer.size() + chunk.length > limit) {
                            throw new RuntimeBridgeFailure("post_limit", "响应超过大小限制");
                        }
                        buffer.write(chunk, 0, chunk.length);
                    });
                checkHost(connection, leaseGeneration, RuntimeHostScope.fromLeaseScope(scope));
                String relayMime = header(response.headers, "content-type");
                return new RawResponse(response.status,
                    relayMime == null ? "application/octet-stream" : relayMime, buffer.toByteArray(),
                    normalizeHeaders(response.headers));
            }
            RuntimeBridgeHttp.Response response = RuntimeBridgeHttp.read(request.url, "POST", request.headers, body,
                limit, CONNECT_TIMEOUT, (int) timeoutMs);
            checkHost(connection, leaseGeneration, RuntimeHostScope.fromLeaseScope(scope));
            String mimeHeader = response.header("content-type");
            return new RawResponse(response.status,
                mimeHeader == null ? "application/octet-stream" : mimeHeader, response.data,
                normalizeHeaders(response.headers));
        }

        @Override public CompletableFuture<Socket> openWebSocket(String path, SocketListener listener) {
            CompletableFuture<Socket> future = new CompletableFuture<>();
            worker.execute(() -> {
                try { future.complete(openSocketBlocking(path, listener)); }
                catch (Throwable failure) { future.completeExceptionally(failure); }
            });
            return future;
        }

        private Socket openSocketBlocking(String path, SocketListener listener) throws Exception {
            if (!alive()) throw RuntimeHostScopeFailure.stale();
            if (!"/api/terminal/ws".equals(path) && !"/api/dictation/ws".equals(path)
                    && !"/api/remote-desktop/ws".equals(path) && !"/api/global/event/ws".equals(path)) {
                throw new RuntimeBridgeFailure("invalid_websocket_request", "无效的 WebSocket 请求");
            }
            checkHost(connection, leaseGeneration, RuntimeHostScope.fromLeaseScope(scope));
            ConnectionEditorConnection captured = connection;
            RuntimeHostScope expected = RuntimeHostScope.fromLeaseScope(scope);
            AtomicListener bridge = new AtomicListener() {
                @Override public void check() throws RuntimeBridgeFailure {
                    checkHost(captured, leaseGeneration, expected);
                }
            };
            bridge.listener = listener;
            if (connection.relay != null) {
                SessionMessageStream.UrlToken token = mintUrlToken(connection, tunnelFor(connection.relay), 10000);
                RelayTunnel.WebSocket socket = tunnelFor(connection.relay)
                    .openWebSocket(path, token.value(System.nanoTime() / 1_000_000L), 20);
                return new RelaySocket(socket, bridge, leaseGeneration);
            }
            var headers = new LinkedHashMap<String, String>();
            headers.put("Origin", connection.url.replaceAll("/+$", ""));
            if (!connection.token.isEmpty()) headers.put("Authorization", "Bearer " + connection.token);
            String url = connection.url.startsWith("https")
                ? "wss" + connection.url.substring(5)
                : "ws" + connection.url.substring(4);
            RuntimeBridgeWebSocket client = RuntimeBridgeWebSocket.connect(url + path, headers, CONNECT_TIMEOUT,
                1024 * 1024, new RuntimeBridgeWebSocket.Listener() {
                    @Override public void onOpen() { /* listener sees text/binary frames */ }

                    @Override public void onText(String text) { bridge.onText(text); }

                    @Override public void onBinary(byte[] data) { bridge.onBinary(data); }

                    @Override public void onClosed(int code, String reason, Throwable failure) {
                        bridge.onClosed(failure == null && code == 4001
                            ? new RuntimeBridgeFailure("authentication_required")
                            : failure);
                    }
                });
            return new DirectSocket(client);
        }
    }

    private abstract static class AtomicListener {
        HostLease.SocketListener listener;

        abstract void check() throws RuntimeBridgeFailure;

        void onText(String text) {
            if (listener == null) return;
            try { check(); listener.onText(text); } catch (Exception failure) { /* stale: drop */ }
        }

        void onBinary(byte[] data) {
            if (listener == null) return;
            try { check(); listener.onBinary(data); } catch (Exception failure) { /* stale: drop */ }
        }

        void onClosed(Throwable failure) {
            if (listener == null) return;
            listener.onClosed(failure);
            listener = null;
        }
    }

    private static final class DirectSocket implements HostLease.Socket {
        private final RuntimeBridgeWebSocket client;
        private boolean closed;

        DirectSocket(RuntimeBridgeWebSocket client) { this.client = client; }

        @Override public CompletableFuture<Void> sendText(String text) {
            try {
                client.sendText(text);
                return CompletableFuture.completedFuture(null);
            } catch (Exception failure) {
                CompletableFuture<Void> future = new CompletableFuture<>();
                future.completeExceptionally(failure);
                return future;
            }
        }

        @Override public CompletableFuture<Void> sendBinary(byte[] data) {
            try {
                client.sendBinary(data);
                return CompletableFuture.completedFuture(null);
            } catch (Exception failure) {
                CompletableFuture<Void> future = new CompletableFuture<>();
                future.completeExceptionally(failure);
                return future;
            }
        }

        @Override public void close() {
            if (closed) return;
            closed = true;
            client.close();
        }
    }

    private static final class RelaySocket implements HostLease.Socket {
        private final RelayTunnel.WebSocket socket;
        private final AtomicListener listener;
        private final Thread pump;
        private volatile boolean closed;

        RelaySocket(RelayTunnel.WebSocket socket, AtomicListener listener, int generation) {
            this.socket = socket;
            this.listener = listener;
            this.pump = new Thread(() -> {
                try {
                    while (!closed) {
                        RelayTunnel.Inbox.Message message = socket.receive();
                        if (message.isClosed()) {
                            listener.onClosed(message.closeCode == 4001
                                ? new RuntimeBridgeFailure("authentication_required") : null);
                            return;
                        }
                        if (message.text != null) listener.onText(message.text);
                        else listener.onBinary(message.binary);
                    }
                } catch (Exception failure) {
                    if (!closed) listener.onClosed(failure);
                }
            }, "yuri-nsh-lease-socket");
            pump.setDaemon(true);
            pump.start();
        }

        @Override public CompletableFuture<Void> sendText(String text) {
            try {
                socket.send(text);
                return CompletableFuture.completedFuture(null);
            } catch (Exception failure) {
                CompletableFuture<Void> future = new CompletableFuture<>();
                future.completeExceptionally(failure);
                return future;
            }
        }

        @Override public CompletableFuture<Void> sendBinary(byte[] data) {
            try {
                socket.sendBinary(data);
                return CompletableFuture.completedFuture(null);
            } catch (Exception failure) {
                CompletableFuture<Void> future = new CompletableFuture<>();
                future.completeExceptionally(failure);
                return future;
            }
        }

        @Override public void close() {
            if (closed) return;
            closed = true;
            socket.close();
            listener.onClosed(null);
        }
    }

    /**
     * Authenticated SSE/byte stream for transports that own their own framing (terminal
     * streams, previews). Same admission and cancellation rules as the internal streams.
     */
    public Stream openStream(HostLease.Scope expected, String path, Map<String, String> headers, long timeoutMs,
                             StreamListener listener) throws Exception {
        RuntimeHostScope parsed = expected == null ? null : RuntimeHostScope.parse(scopeMap(expected));
        HostAdmission admission = admit(parsed, expected != null);
        Request request = makeRequest(path, admission.connection, "GET", null, false);
        if (headers != null) {
            for (Map.Entry<String, String> header : headers.entrySet()) {
                if (header.getKey() == null || header.getValue() == null) continue;
                if ("authorization".equalsIgnoreCase(header.getKey()) || "host".equalsIgnoreCase(header.getKey())) continue;
                request.headers.put(header.getKey(), header.getValue());
            }
        }
        if (!request.headers.containsKey("Accept")) request.headers.put("Accept", "text/event-stream");
        request.timeoutMs = Math.max(1000, timeoutMs);
        StreamJob job = new StreamJob();
        Thread thread = new Thread(() -> {
            try {
                checkHost(admission.connection, admission.generation, admission.expectedHost);
                if (admission.connection.relay != null) {
                    tunnelFor(admission.connection.relay).stream(route(request), request.method, request.headers, null,
                        Math.max(1, timeoutMs / 1000), (status, received) -> {
                            if (!job.active()) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                            listener.onOpen(status, received);
                        }, chunk -> {
                            if (!job.active()) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                            checkHost(admission.connection, admission.generation, admission.expectedHost);
                            listener.onData(chunk);
                        });
                    if (job.active()) listener.onClosed(null);
                    return;
                }
                RuntimeBridgeHttp.Stream stream = RuntimeBridgeHttp.open(request.url, request.method, request.headers,
                    null, CONNECT_TIMEOUT, (int) Math.min(Integer.MAX_VALUE, request.timeoutMs));
                job.attach(stream::close);
                if (!job.active()) { stream.close(); return; }
                listener.onOpen(stream.status, stream.headers);
                byte[] buffer = new byte[8192];
                try (InputStream input = stream.body) {
                    while (job.active()) {
                        int count = input.read(buffer);
                        if (count < 0) break;
                        checkHost(admission.connection, admission.generation, admission.expectedHost);
                        byte[] chunk = new byte[count];
                        System.arraycopy(buffer, 0, chunk, 0, count);
                        listener.onData(chunk);
                    }
                } finally {
                    stream.close();
                }
                if (job.active()) listener.onClosed(null);
            } catch (Throwable failure) {
                if (job.active()) listener.onClosed(failure);
            }
        }, "yuri-nsh-open-stream");
        thread.setDaemon(true);
        job.thread = thread;
        thread.start();
        return job;
    }

    // ----------------------------------------------------------------- host calls

    private Object request(Object input) throws Exception {
        String path = string(input, "path");
        Map<String, Object> args = RuntimeBridgeJson.object(input);
        if (args == null) throw new RuntimeBridgeFailure("invalid_request", "缺少参数：path");
        Object methodValue = args.get("method");
        if (methodValue != null && !(methodValue instanceof String)) throw new RuntimeBridgeFailure("invalid_http_method", "不支持的请求方式");
        String method = methodValue == null ? "GET" : (String) methodValue;
        if (!"GET".equals(method) && !"POST".equals(method) && !"PUT".equals(method)
                && !"PATCH".equals(method) && !"DELETE".equals(method)) {
            throw new RuntimeBridgeFailure("invalid_http_method", "不支持的请求方式");
        }
        RuntimeHostScope expected = args.get("expectedHost") == null ? null : RuntimeHostScope.parse(args.get("expectedHost"));
        HostAdmission admission = admit(expected, !"GET".equals(method));
        if (isPasskeyManagement(path, method)) {
            Object body = args.get("body");
            if (body != null && !(body instanceof Map)) throw new PasskeyFailure(PasskeyFailure.INVALID);
            PasskeyTransport transport = passkeyTransport(admission);
            PasskeyTransport.Response response = transport.request(path, method, RuntimeBridgeJson.object(body));
            if (response == null) throw new PasskeyFailure(PasskeyFailure.RESPONSE);
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("status", response.status);
            value.put("body", response.body);
            return value;
        }
        Request request = makeRequest(path, admission.connection, method, args.get("body"), false);
        HostLease.JsonResponse response = executeJSON(request, admission.connection, null);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("status", response.status);
        value.put("body", response.body);
        return value;
    }

    private Object startStream(Object input) throws Exception {
        Map<String, Object> body = RuntimeBridgeJson.object(input);
        if (body == null) throw RuntimeHostScopeFailure.invalid();
        boolean chat = "chat".equals(body.get("key"));
        Set<String> expectedKeys = new LinkedHashSet<>();
        expectedKeys.add("path");
        expectedKeys.add("key");
        expectedKeys.add("expectedHost");
        if (chat) { expectedKeys.add("mode"); expectedKeys.add("ownerID"); }
        if (!body.keySet().equals(expectedKeys)) throw RuntimeHostScopeFailure.invalid();
        String path = string(input, "path");
        String key = string(input, "key");
        RuntimeHostScope expected = RuntimeHostScope.parse(body.get("expectedHost"));
        HostAdmission admission = admit(expected, true);
        if (chat) {
            Object rawMode = body.get("mode");
            Object ownerID = body.get("ownerID");
            SessionMessageStream.Mode mode = mode(rawMode);
            if (mode == null || !(ownerID instanceof String) || !validStreamOwner((String) ownerID)) {
                throw RuntimeHostScopeFailure.invalid();
            }
            sessionStream(path, mode, (String) ownerID, admission);
            return Boolean.TRUE;
        }
        stream(path, key, admission);
        return Boolean.TRUE;
    }

    private Object stopStream(Object input) throws Exception {
        Map<String, Object> body = RuntimeBridgeJson.object(input);
        if (body == null) throw RuntimeHostScopeFailure.invalid();
        Object keyValue = body.get("key");
        if (!"global".equals(keyValue) && !"chat".equals(keyValue)) throw RuntimeHostScopeFailure.invalid();
        String key = (String) keyValue;
        Set<String> expectedKeys = new LinkedHashSet<>();
        expectedKeys.add("key");
        expectedKeys.add("expectedHost");
        if ("chat".equals(key)) expectedKeys.add("ownerID");
        if (!body.keySet().equals(expectedKeys)) throw RuntimeHostScopeFailure.invalid();
        RuntimeHostScope expected = RuntimeHostScope.parse(body.get("expectedHost"));
        if ("chat".equals(key)) {
            Object ownerID = body.get("ownerID");
            if (!(ownerID instanceof String) || !validStreamOwner((String) ownerID)) throw RuntimeHostScopeFailure.invalid();
            synchronized (stateLock) {
                if (!ownerID.equals(chatStreamOwner)) return Boolean.TRUE;
            }
        }
        // Cleanup never adopts current authority: an old scope releases only its stream.
        synchronized (stateLock) {
            HostLease.Scope recorded = streamScopes.get(key);
            if (recorded != null && recorded.equals(expected.toLeaseScope())) {
                streamScopes.remove(key);
                streamTokens.remove(key);
                StreamJob job = streams.remove(key);
                if (job != null) job.cancel();
                if ("chat".equals(key)) chatStreamOwner = null;
            }
        }
        return Boolean.TRUE;
    }

    private void stream(String path, String key, HostAdmission admission) throws Exception {
        if (!"global".equals(key) || !"/api/yuri/events".equals(path)) {
            throw new RuntimeBridgeFailure("unsupported_stream", "不支持的事件流");
        }
        ConnectionEditorConnection connection = admission.connection;
        int scope = admission.generation;
        RuntimeHostScope expected = admission.expectedHost;
        checkHost(connection, scope, expected);
        Request request = makeRequest(path, connection, "GET", null, false);
        request.headers.put("Accept", "text/event-stream");
        request.timeoutMs = 3600000;
        // Parsing, admission, route and request validation all precede replacement.
        StreamJob previous;
        synchronized (stateLock) {
            previous = streams.remove(key);
            StreamJob job = new StreamJob();
            streams.put(key, job);
            streamTokens.put(key, UUID.randomUUID().toString());
            String token = streamTokens.get(key);
            streamScopes.put(key, expected.toLeaseScope());
            job.thread = new Thread(() -> runGlobalStream(job, token, key, connection, scope, expected, request));
            job.thread.setDaemon(true);
            job.thread.start();
            if (previous != null) previous.cancel();
        }
    }

    private void runGlobalStream(StreamJob job, String token, String key, ConnectionEditorConnection connection,
                                 int scope, RuntimeHostScope expected, Request request) {
        long delay = 1;
        while (job.active() && current(token, key, expected)) {
            SessionMessageStream.SSEEvents parser = new SessionMessageStream.SSEEvents((data, id) -> {
                if (!job.active() || !current(token, key, expected)) return;
                Map<String, Object> envelope = new LinkedHashMap<>();
                envelope.put("data", data);
                envelope.put("key", key);
                envelope.put("expectedHost", expected.publicValue());
                sendEvent("runtime.event", envelope);
            });
            try {
                checkHost(connection, scope, expected);
                if (connection.relay != null) {
                    tunnelFor(connection.relay).stream(route(request), "GET", request.headers, null, 3600,
                        (status, headers) -> {
                            if (status != 200) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
                            String mime = header(headers, "content-type");
                            if (mime == null || !mime.toLowerCase(Locale.ROOT).contains("text/event-stream")) {
                                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.DISCONNECTED);
                            }
                            if (!current(token, key, expected)) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                            Map<String, Object> envelope = new LinkedHashMap<>();
                            envelope.put("type", "reconnected");
                            envelope.put("key", key);
                            envelope.put("expectedHost", expected.publicValue());
                            sendEvent("runtime.event", envelope);
                        }, chunk -> {
                            if (!job.active() || !current(token, key, expected)) {
                                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                            }
                            parser.consume(chunk);
                        });
                } else {
                    RuntimeBridgeHttp.Stream stream = RuntimeBridgeHttp.open(request.url, "GET", request.headers,
                        null, CONNECT_TIMEOUT, 3600000);
                    job.attach(stream::close);
                    try {
                        if (!job.active() || !current(token, key, expected)) return;
                        String mime = stream.header("content-type");
                        if (stream.status != 200 || mime == null || !mime.contains("text/event-stream")) {
                            throw new RuntimeBridgeFailure("stream_failed", "事件连接失败");
                        }
                        delay = 1;
                        Map<String, Object> envelope = new LinkedHashMap<>();
                        envelope.put("type", "reconnected");
                        envelope.put("key", key);
                        envelope.put("expectedHost", expected.publicValue());
                        sendEvent("runtime.event", envelope);
                        try (InputStream input = stream.body) {
                            byte[] buffer = new byte[8192];
                            while (job.active()) {
                                int count = input.read(buffer);
                                if (count < 0) break;
                                if (!current(token, key, expected)) return;
                                for (int i = 0; i < count; i++) parser.consume(buffer[i]);
                            }
                        }
                    } finally {
                        stream.close();
                    }
                }
                if (job.active() && current(token, key, expected)) sendDisconnected(key, expected);
            } catch (Throwable failure) {
                if (!job.active() || !current(token, key, expected)) return;
                sendDisconnected(key, expected);
            }
            if (!sleep(delay * 1000)) return;
            delay = Math.min(delay * 2, 30);
        }
    }

    private void sendEvent(String name, Map<String, Object> payload) {
        NshView target = view;
        if (target != null) target.send(name, payload);
    }

    private void sendDisconnected(String key, RuntimeHostScope expected) {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("key", key);
        envelope.put("expectedHost", expected.publicValue());
        sendEvent("runtime.disconnected", envelope);
    }

    private boolean sleep(long millis) {
        try {
            Thread.sleep(millis);
            return true;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static final class StreamJob implements Stream {
        volatile Thread thread;
        private volatile boolean cancelled;
        private volatile Runnable abort;

        void attach(Runnable value) { abort = value; }

        boolean active() { return !cancelled; }

        void cancel() {
            cancelled = true;
            Runnable hook = abort;
            if (hook != null) {
                try { hook.run(); } catch (RuntimeException ignored) { /* closed */ }
            }
            Thread worker = thread;
            if (worker != null && worker != Thread.currentThread()) worker.interrupt();
        }

        @Override public void close() { cancel(); }
    }

    // ----------------------------------------------------------------- chat stream

    private void sessionStream(String path, SessionMessageStream.Mode mode, String ownerID, HostAdmission admission)
            throws Exception {
        RuntimeHostUri.Parts parts = RuntimeHostUri.parse(path);
        if (parts == null || parts.scheme != null || parts.authority || parts.host != null || parts.fragment != null
                || !"/api/event".equals(parts.path) || parts.query == null
                || RuntimeHostText.hasControl(parts.query)) {
            throw RuntimeHostScopeFailure.invalid();
        }
        List<String[]> items = queryItems(parts.query);
        if (items.size() != 1 || !"directory".equals(items.get(0)[0])) throw RuntimeHostScopeFailure.invalid();
        String directory = items.get(0)[1];
        if (directory == null || directory.isEmpty()) throw RuntimeHostScopeFailure.invalid();
        final ConnectionEditorConnection connection = admission.connection;
        final int scope = admission.generation;
        final RuntimeHostScope expected = admission.expectedHost;
        checkHost(connection, scope, expected);
        final Request request = makeRequest(path, connection, "GET", null, false);
        request.headers.put("Accept", "text/event-stream");
        request.timeoutMs = 3600000;
        if (connection.relay != null && connection.token.isEmpty()) throw RuntimeHostScopeFailure.unavailable();
        final String token = UUID.randomUUID().toString();
        StreamJob previous;
        synchronized (stateLock) {
            previous = streams.remove("chat");
            StreamJob job = new StreamJob();
            streams.put("chat", job);
            streamTokens.put("chat", token);
            streamScopes.put("chat", expected.toLeaseScope());
            chatStreamOwner = ownerID;
            SessionMessageStream.Transport transport = new SessionMessageStream.Transport() {
                @Override public boolean relay() { return connection.relay != null; }

                @Override public boolean current() { return job.active() && sessionCurrent(token, ownerID, expected); }

                @Override public SessionMessageStream.Socket open(String cursor) throws Exception {
                    if (!current()) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                    if (connection.relay != null) {
                        if (cursor != null && !SessionMessageStream.validCursor(cursor)) {
                            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_REQUEST);
                        }
                        SessionMessageStream.UrlToken receipt = mintUrlToken(connection, tunnelFor(connection.relay), 10000);
                        String scoped = receipt.value(System.nanoTime() / 1_000_000L);
                        RelayTunnel.WebSocket socket = tunnelFor(connection.relay)
                            .openSessionWebSocket(cursor, scoped, receipt.validUntil, 8);
                        return new SessionMessageStream.Socket() {
                            @Override public String receive() throws Exception {
                                RelayTunnel.Inbox.Message message = socket.receive();
                                if (message.isClosed()) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.WEB_SOCKET_CLOSED);
                                if (message.text == null) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
                                return message.text;
                            }

                            @Override public void close() { socket.close(); }
                        };
                    }
                    String wsUrl = connection.url.startsWith("https")
                        ? "wss" + connection.url.substring(5)
                        : "ws" + connection.url.substring(4);
                    String target = wsUrl + "/api/global/event/ws";
                    if (cursor != null && !cursor.isEmpty()) target += "?lastEventId=" + RuntimeHostUri.encodeForWire(cursor);
                    Map<String, String> headers = new LinkedHashMap<>();
                    headers.put("Origin", connection.url.replaceAll("/+$", ""));
                    if (!connection.token.isEmpty()) headers.put("Authorization", "Bearer " + connection.token);
                    return SessionMessageStreamDirect.open(target, headers, CONNECT_TIMEOUT);
                }

                @Override public void sse(String cursor, SessionMessageStream.Ready ready, SessionMessageStream.Event event,
                                          java.util.function.Consumer<Runnable> register) throws Exception {
                    if (!current()) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                    Map<String, String> headers = new LinkedHashMap<>(request.headers);
                    if (cursor != null && !cursor.isEmpty()) headers.put("Last-Event-ID", cursor);
                    SessionMessageStream.SSEEvents parser = new SessionMessageStream.SSEEvents(event,
                        () -> { if (current()) ready.ready(); });
                    if (connection.relay != null) {
                        tunnelFor(connection.relay).stream(route(request), "GET", headers, null, 3600,
                            (status, received) -> {
                                String mime = header(received, "content-type");
                                if (status != 200 || mime == null || !mime.toLowerCase(Locale.ROOT).contains("text/event-stream")) {
                                    throw new SessionMessageStream.HttpFailure(status);
                                }
                                if (!current()) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                                ready.ready();
                            }, chunk -> {
                                if (!current()) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                                parser.consume(chunk);
                            });
                        return;
                    }
                    RuntimeBridgeHttp.Stream stream = RuntimeBridgeHttp.open(request.url, "GET", headers, null,
                        CONNECT_TIMEOUT, 30000);
                    register.accept(stream::close);
                    try {
                        if (!current()) return;
                        String mime = stream.header("content-type");
                        if (stream.status != 200 || mime == null || !mime.toLowerCase(Locale.ROOT).contains("text/event-stream")) {
                            throw new SessionMessageStream.HttpFailure(stream.status);
                        }
                        ready.ready();
                        try (InputStream input = stream.body) {
                            byte[] buffer = new byte[8192];
                            while (current()) {
                                int count = input.read(buffer);
                                if (count < 0) break;
                                for (int i = 0; i < count; i++) parser.consume(buffer[i]);
                            }
                        }
                    } finally {
                        stream.close();
                    }
                }
            };
            SessionMessageStream controller = new SessionMessageStream(transport, (kind, data) -> {
                if (!job.active() || !sessionCurrent(token, ownerID, expected)) return;
                Map<String, Object> envelope = new LinkedHashMap<>();
                envelope.put("key", "chat");
                envelope.put("ownerID", ownerID);
                envelope.put("expectedHost", expected.publicValue());
                if (kind == SessionMessageStream.OutputKind.EVENT) {
                    envelope.put("data", data);
                    sendEvent("runtime.event", envelope);
                } else if (kind == SessionMessageStream.OutputKind.READY) {
                    envelope.put("type", "reconnected");
                    sendEvent("runtime.event", envelope);
                } else {
                    sendEvent("runtime.disconnected", envelope);
                }
            });
            // An external stop must also flip the controller's own cancellation flag, so
            // the in-flight attempt closes instead of waiting out its readiness deadline.
            job.attach(controller::cancel);
            job.thread = new Thread(() -> {
                controller.run(mode);
                synchronized (stateLock) {
                    if (token.equals(streamTokens.get("chat"))) {
                        streams.remove("chat");
                        streamTokens.remove("chat");
                        streamScopes.remove("chat");
                        if (ownerID.equals(chatStreamOwner)) chatStreamOwner = null;
                    }
                }
            }, "yuri-nsh-chat-stream");
            job.thread.setDaemon(true);
            job.thread.start();
            if (previous != null) previous.cancel();
        }
    }

    private boolean sessionCurrent(String token, String ownerID, RuntimeHostScope expected) {
        synchronized (stateLock) {
            if (!token.equals(streamTokens.get("chat"))) return false;
            HostLease.Scope recorded = streamScopes.get("chat");
            if (recorded == null || !recorded.equals(expected.toLeaseScope())) return false;
            if (!ownerID.equals(chatStreamOwner)) return false;
        }
        return true;
    }

    private boolean current(String token, String key, RuntimeHostScope expected) {
        synchronized (stateLock) {
            if (!token.equals(streamTokens.get(key))) return false;
            HostLease.Scope recorded = streamScopes.get(key);
            if (recorded == null || !recorded.equals(expected.toLeaseScope())) return false;
        }
        ConnectionEditorConnection selected = store.selected();
        return authority.isForeground() && selected != null && selected.id.equals(expected.hostID);
    }

    // ----------------------------------------------------------------- connect

    private Object connect(Object input) throws Exception {
        requireForeground();
        Map<String, Object> args = RuntimeBridgeJson.object(input);
        if (args == null) args = new LinkedHashMap<>();
        Object editingIDValue = args.get("id");
        Object editingVersionValue = args.get("version");
        String editingID = editingIDValue instanceof String ? (String) editingIDValue : null;
        String editingVersion = editingVersionValue instanceof String ? (String) editingVersionValue : null;
        if (editingID != null) {
            if (editingVersion == null || editingID.isEmpty() || editingVersion.isEmpty()) {
                throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
            }
            store.validateReplacement(editingID, editingVersion, args);
        } else if (args.containsKey("id") || args.containsKey("version")) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        final int attempt;
        final int scope;
        synchronized (stateLock) {
            connectionAttempt += 1;
            attempt = connectionAttempt;
            scope = generation;
        }
        String pairing = args.get("pairingLink") instanceof String ? (String) args.get("pairingLink") : "";
        String token = args.get("token") instanceof String ? (String) args.get("token") : "";
        String label = args.get("label") instanceof String ? (String) args.get("label") : "";
        String url;
        ConnectionEditorRelay relay = null;
        RelayTunnel pairingTunnel = null;
        try {
            if (!pairing.isEmpty()) {
                if (pairing.length() > 16384) throw new RuntimeBridgeFailure("invalid_pairing", "无效的配对链接");
                PairingPayload payload = PairingPayload.parse(pairing);
                ConnectionEditorConnection chosen = null;
                Exception lastFailure = null;
                for (Map<String, Object> candidate : payload.candidates) {
                    checkAttempt(attempt, scope);
                    ConnectionEditorRelay configuration = null;
                    RelayTunnel transport = null;
                    String endpoint;
                    if ("relay".equals(candidate.get("type"))) {
                        Object address = candidate.get("relayUrl");
                        Object server = candidate.get("serverId");
                        Object key = candidate.get("hostEncPubJwk");
                        Map<String, Object> jwk = RuntimeBridgeJson.object(key);
                        if (!(address instanceof String) || !(server instanceof String) || jwk == null) {
                            throw new RuntimeBridgeFailure("invalid_pairing", "无效的 Relay 配对信息");
                        }
                        Map<String, String> flattened = new LinkedHashMap<>();
                        for (Map.Entry<String, Object> entry : jwk.entrySet()) {
                            if (!(entry.getValue() instanceof String)) throw new RuntimeBridgeFailure("invalid_pairing", "无效的 Relay 配对信息");
                            flattened.put(entry.getKey(), (String) entry.getValue());
                        }
                        String canonical = ConnectionEditorRelay.canonicalAddress((String) address);
                        configuration = new ConnectionEditorRelay(canonical, (String) server, flattened);
                        transport = new RelayTunnel(canonical, (String) server, flattened);
                        // Routing placeholder only; the Relay never dials an HTTP origin.
                        endpoint = "https://relay.invalid";
                    } else {
                        Object type = candidate.get("type");
                        Object address = candidate.get("url");
                        if (!("lan".equals(type) || "tunnel".equals(type)) || !(address instanceof String)) continue;
                        endpoint = ConnectionEditorRecords.origin((String) address);
                    }
                    ConnectionEditorConnection temporary = new ConnectionEditorConnection("", "", endpoint, "", 0,
                        configuration, null, null, null);
                    try {
                        HostLease.JsonResponse health = exchange(
                            makeRequest("/health", temporary, "GET", null, false), temporary, transport, attempt, scope);
                        if (health.status != 200) {
                            throw new RuntimeBridgeFailure("host_unavailable", "Host 健康检查失败 (" + health.status + ")");
                        }
                        if (payload.expectedServer != null) {
                            Map<String, Object> object = RuntimeBridgeJson.object(health.body);
                            Object server = object == null ? null : object.get("serverId");
                            if (!payload.expectedServer.equals(server)) {
                                throw new RuntimeBridgeFailure("host_mismatch", "Host 身份与配对链接不一致");
                            }
                        }
                        chosen = temporary;
                        pairingTunnel = transport;
                        break;
                    } catch (Exception failure) {
                        if (transport != null) transport.close();
                        checkAttempt(attempt, scope);
                        if (failure instanceof RuntimeHostScopeFailure) throw failure;
                        lastFailure = failure;
                    }
                }
                if (chosen == null) {
                    if (lastFailure != null) throw lastFailure;
                    throw new RuntimeBridgeFailure("pairing_unreachable", "所有配对地址均无法连接，请检查 Host 与网络后重试");
                }
                url = chosen.url;
                relay = chosen.relay;
                // Probe candidates before redeeming. A lost redemption response is ambiguous
                // and is never retried automatically.
                Map<String, Object> redeem = new LinkedHashMap<>();
                redeem.put("pairingId", payload.pairingId);
                redeem.put("secret", payload.secret);
                redeem.put("clientKind", "mobile");
                redeem.put("clientLabel", clientLabel());
                redeem.put("devicePlatform", "android");
                redeem.put("appVersion", appVersion());
                HostLease.JsonResponse response = exchange(
                    makeRequest("/api/client-auth/pairing/redeem", chosen, "POST", redeem, true), chosen,
                    pairingTunnel, attempt, scope);
                Map<String, Object> body = RuntimeBridgeJson.object(response.body);
                Object credential = body == null ? null : body.get("clientToken");
                if (response.status != 200 || !(credential instanceof String) || ((String) credential).isEmpty()) {
                    throw new RuntimeBridgeFailure("pairing_failed", "配对失败 (" + response.status + ")，请确认链接未失效");
                }
                token = (String) credential;
                Map<String, Object> server = body == null ? null : RuntimeBridgeJson.object(body.get("server"));
                Object serverLabel = server == null ? null : server.get("label");
                if (serverLabel instanceof String) label = (String) serverLabel;
            } else {
                url = ConnectionEditorRecords.origin(string(input, "url"));
                Object password = args.get("password");
                if (password instanceof String && !((String) password).isEmpty()) {
                    ConnectionEditorConnection temporary = new ConnectionEditorConnection("", "", url, "", 0, null, null, null, null);
                    Map<String, Object> session = new LinkedHashMap<>();
                    session.put("password", password);
                    session.put("issueClientToken", Boolean.TRUE);
                    session.put("trustDevice", Boolean.TRUE);
                    session.put("clientKind", "mobile");
                    session.put("clientLabel", clientLabel());
                    session.put("devicePlatform", "android");
                    session.put("appVersion", appVersion());
                    HostLease.JsonResponse response = exchange(
                        makeRequest("/auth/session", temporary, "POST", session, true), temporary, null, attempt, scope);
                    Map<String, Object> body = RuntimeBridgeJson.object(response.body);
                    Object credential = body == null ? null : body.get("clientToken");
                    if (response.status != 200 || !(credential instanceof String) || ((String) credential).isEmpty()) {
                        throw new RuntimeBridgeFailure("unlock_failed", "设备解锁失败 (" + response.status + ")");
                    }
                    token = (String) credential;
                }
            }
            ConnectionEditorConnection candidate = new ConnectionEditorConnection("", label, url, token, 0, relay, null, null, null);
            HostLease.JsonResponse settings = exchange(
                makeRequest("/api/config/settings", candidate, "GET", null, false), candidate, pairingTunnel, attempt, scope);
            checkAttempt(attempt, scope);
            if (settings.status != 200) {
                throw new RuntimeBridgeFailure("host_unavailable", "无法访问设备 (" + settings.status + ")，请检查连接授权");
            }
            // Persist only after validation succeeds; a failed write keeps the previous selection.
            if (editingID != null && editingVersion != null) {
                String finalLabel = args.get("label") instanceof String ? (String) args.get("label") : label;
                store.replace(editingID, editingVersion, url, token, finalLabel, relay);
            } else {
                store.save(url, token, label, relay);
            }
        } finally {
            if (pairingTunnel != null) pairingTunnel.close();
        }
        ConnectionEditorConnection selected = store.selected();
        boolean invalidated = editingID == null || (selected != null && selected.id.equals(editingID));
        if (invalidated) stop();
        retryAuthorizationRetirementsBlocking();
        Map<String, Object> value = snapshot();
        value.put("runtimeInvalidated", invalidated);
        return value;
    }

    private HostLease.JsonResponse exchange(Request request, ConnectionEditorConnection connection, RelayTunnel tunnel,
                                            int attempt, int scope) throws Exception {
        checkAttempt(attempt, scope);
        HostLease.JsonResponse response = executeJSON(request, connection, tunnel);
        checkAttempt(attempt, scope);
        return response;
    }

    private void checkAttempt(int attempt, int scope) throws RuntimeHostScopeFailure {
        boolean foreground = authority.isForeground();
        synchronized (stateLock) {
            if (!foreground || attempt != connectionAttempt || scope != generation) throw RuntimeHostScopeFailure.stale();
        }
    }

    private String clientLabel() { return "Yuri Native Android"; }

    private String appVersion() {
        try {
            return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Exception failure) {
            return "0.1.0";
        }
    }

    private static final class PairingPayload {
        final String pairingId;
        final String secret;
        final String expectedServer;
        final List<Map<String, Object>> candidates = new ArrayList<>();

        private PairingPayload(String pairingId, String secret, String expectedServer) {
            this.pairingId = pairingId;
            this.secret = secret;
            this.expectedServer = expectedServer;
        }

        static PairingPayload parse(String link) throws Exception {
            RuntimeHostUri.Parts parts = RuntimeHostUri.parse(link);
            if (parts == null || !"yuri".equals(parts.scheme) || !"connect".equals(parts.host) || parts.query == null) {
                throw new RuntimeBridgeFailure("invalid_pairing", "无效的配对链接");
            }
            String version = null;
            String encoded = null;
            for (String[] item : queryItems(parts.query)) {
                if ("v".equals(item[0])) version = item[1];
                if ("p".equals(item[0])) encoded = item[1];
            }
            if (!"2".equals(version) || encoded == null) throw new RuntimeBridgeFailure("invalid_pairing", "无效的配对链接");
            String base64 = encoded.replace('-', '+').replace('_', '/');
            int padding = (4 - base64.length() % 4) % 4;
            for (int i = 0; i < padding; i++) base64 += "=";
            byte[] data;
            try { data = java.util.Base64.getDecoder().decode(base64); }
            catch (IllegalArgumentException failure) { throw new RuntimeBridgeFailure("invalid_pairing", "无效的配对内容"); }
            Map<String, Object> payload = RuntimeBridgeJson.object(RuntimeBridgeJson.parse(new String(data, java.nio.charset.StandardCharsets.UTF_8)));
            Double payloadVersion = payload == null ? null : RuntimeBridgeJson.number(payload.get("v"));
            List<Object> rawCandidates = payload == null ? null : RuntimeBridgeJson.array(payload.get("candidates"));
            Object pairingId = payload == null ? null : payload.get("pairingId");
            Object secret = payload == null ? null : payload.get("secret");
            if (payloadVersion == null || payloadVersion != 2 || rawCandidates == null || rawCandidates.isEmpty()
                    || rawCandidates.size() > 16 || !(pairingId instanceof String) || ((String) pairingId).isEmpty()
                    || !(secret instanceof String) || ((String) secret).isEmpty()) {
                throw new RuntimeBridgeFailure("invalid_pairing", "无效的配对内容");
            }
            Object expiry = payload.get("expiresAt");
            if (expiry instanceof String) {
                Instant date = null;
                try { date = Instant.parse((String) expiry); }
                catch (Exception ignored) {
                    try { date = OffsetDateTime.parse((String) expiry).toInstant(); } catch (Exception alsoIgnored) { date = null; }
                }
                if (date != null && !date.isAfter(Instant.now())) {
                    throw new RuntimeBridgeFailure("pairing_expired", "配对链接已过期，请在 Host 重新生成");
                }
            }
            List<Map<String, Object>> ordered = new ArrayList<>();
            List<Integer> positions = new ArrayList<>();
            for (int index = 0; index < rawCandidates.size(); index++) {
                Map<String, Object> candidate = RuntimeBridgeJson.object(rawCandidates.get(index));
                if (candidate == null) continue;
                ordered.add(candidate);
                positions.add(index);
            }
            String expectedServer = null;
            for (Map<String, Object> candidate : ordered) {
                if ("relay".equals(candidate.get("type")) && candidate.get("serverId") instanceof String) {
                    expectedServer = (String) candidate.get("serverId");
                    break;
                }
            }
            final List<Map<String, Object>> source = ordered;
            final List<Integer> originalIndexes = positions;
            Integer[] order = new Integer[source.size()];
            for (int i = 0; i < order.length; i++) order[i] = i;
            java.util.Arrays.sort(order, (left, right) -> {
                boolean leftRelay = "relay".equals(source.get(left).get("type"));
                boolean rightRelay = "relay".equals(source.get(right).get("type"));
                if (leftRelay != rightRelay) return leftRelay ? 1 : -1;
                Integer leftPriority = RuntimeBridgeJson.integer(source.get(left).get("priority"));
                Integer rightPriority = RuntimeBridgeJson.integer(source.get(right).get("priority"));
                int l = leftPriority == null ? 100 : leftPriority;
                int r = rightPriority == null ? 100 : rightPriority;
                if (l != r) return Integer.compare(l, r);
                return Integer.compare(originalIndexes.get(left), originalIndexes.get(right));
            });
            PairingPayload parsed = new PairingPayload((String) pairingId, (String) secret, expectedServer);
            for (Integer position : order) parsed.candidates.add(source.get(position));
            return parsed;
        }
    }

    // ----------------------------------------------------------------- passkey management

    /**
     * Native management has a separate full UI-session cookie owner. It never promotes a
     * client bearer, never uses Relay and never alters Host scope classification.
     */
    private PasskeyTransport passkeyTransport(HostAdmission admission) throws Exception {
        final ConnectionEditorConnection connection = admission.connection;
        if (connection.relay != null) throw new PasskeyFailure(PasskeyFailure.LOCKED);
        final RuntimeHostScope expected = admission.expectedHost;
        final java.util.function.BooleanSupplier current = () -> {
            try {
                checkHost(connection, admission.generation, expected);
                return true;
            } catch (RuntimeBridgeFailure failure) {
                return false;
            }
        };
        final String key = connection.id + "\n"
            + (connection.authorizationID == null ? "legacy" : connection.authorizationID);
        final PasskeyManagementSession session;
        synchronized (stateLock) {
            PasskeyManagementSession existing = passkeySessions.get(key);
            if (existing == null) {
                java.net.URI origin = java.net.URI.create(connection.url.replaceAll("/+$", ""));
                existing = new PasskeyManagementSession(origin, current,
                    request -> passkeyExecute(connection, request));
                passkeySessions.put(key, existing);
            }
            session = existing;
        }
        return new PasskeyTransport() {
            private boolean cleaned;

            @Override public java.net.URI origin() { return session.origin(); }

            @Override public boolean isCurrent() { return current.getAsBoolean(); }

            @Override public PasskeyTransport.Response request(String path, String method, Map<String, Object> body) throws Exception {
                PasskeyManagementSession.Response response = session.request(path, method, body);
                return new PasskeyTransport.Response(response.status, response.body);
            }

            @Override public void bind(Map<String, Object> options, String ceremony) throws Exception {
                session.bind(options, ceremony);
            }

            @Override public void complete(String ceremony, String credential) throws Exception {
                session.complete(ceremony, credential);
            }

            @Override public void cancel(String ceremony) { session.cancel(ceremony); }

            @Override public void reset() throws Exception {
                if (!cleaned) {
                    if (!session.resetAcknowledged()) throw new PasskeyFailure(PasskeyFailure.RESET);
                    // Before the first committed cleanup the captured lease must still be valid;
                    // retries never remove a newly authorized connection.
                    if (!current.getAsBoolean()) throw new PasskeyFailure(PasskeyFailure.CANCELLED);
                    store.remove(connection.id);
                    cleaned = true;
                    synchronized (stateLock) { passkeySessions.remove(key); }
                    session.retire();
                    stop();
                }
                if (connection.authorizationID != null) {
                    retireAuthorization(new ConnectionEditorRetirement(connection.id, connection.authorizationID));
                }
                for (ConnectionEditorRetirement pending : store.pendingAuthorizationRetirements()) {
                    if (pending.connectionID.equals(connection.id) && pending.authorizationID.equals(connection.authorizationID)) {
                        throw new PasskeyFailure(PasskeyFailure.CLEANUP);
                    }
                }
            }

            @Override public void onRetire(Runnable cleanup) { session.observeRetirement(cleanup); }
        };
    }

    private PasskeyManagementSession.Response passkeyExecute(ConnectionEditorConnection connection,
                                                             PasskeyManagementSession.Request request) throws Exception {
        RuntimeBridgeHttp.Response response = RuntimeBridgeHttp.read(request.url, request.method, request.headers,
            request.body, 1024 * 1024, CONNECT_TIMEOUT, 20000);
        Map<String, Object> body;
        if (response.data.length == 0) body = new LinkedHashMap<>();
        else {
            body = RuntimeBridgeJson.object(RuntimeBridgeJson.parse(
                new String(response.data, java.nio.charset.StandardCharsets.UTF_8)));
            if (body == null) throw new PasskeyFailure(PasskeyFailure.RESPONSE);
        }
        return new PasskeyManagementSession.Response(response.status, response.headerValues(), body);
    }

    // ----------------------------------------------------------------- transport

    private static final class Request {
        String url;
        String path;
        String query;
        String method = "GET";
        final Map<String, String> headers = new LinkedHashMap<>();
        byte[] body;
        long timeoutMs = 20000;
    }

    private Request makeRequest(String path, ConnectionEditorConnection connection, String method, Object body,
                                boolean authentication) throws RuntimeBridgeFailure {
        RuntimeHostUri.Parts parts = RuntimeHostUri.parse(path);
        if (parts == null || parts.scheme != null || parts.authority || parts.host != null || parts.fragment != null) {
            throw new RuntimeBridgeFailure("invalid_path", "无效的 Host API 路径");
        }
        String decoded = RuntimeHostUri.percentDecode(parts.path);
        if (decoded == null || decoded.indexOf('\\') >= 0 || decoded.indexOf('%') >= 0 || decoded.indexOf("//") >= 0) {
            throw new RuntimeBridgeFailure("invalid_path", "无效的 Host API 路径");
        }
        for (String segment : decoded.split("/", -1)) {
            if (".".equals(segment) || "..".equals(segment)) throw new RuntimeBridgeFailure("invalid_path", "无效的 Host API 路径");
        }
        boolean allowed = decoded.startsWith("/api/") || "/health".equals(decoded)
            || (authentication && "/auth/session".equals(decoded))
            || (authentication && "/api/client-auth/pairing/redeem".equals(decoded))
            || (authentication && "/auth/url-token".equals(decoded));
        if (!allowed) throw new RuntimeBridgeFailure("invalid_path", "无效的 Host API 路径");
        if (!authentication && (decoded.startsWith("/api/client-auth") || "/api/auth".equals(decoded)
                || decoded.startsWith("/api/auth/"))) {
            throw new RuntimeBridgeFailure("invalid_path", "无效的 Host API 路径");
        }
        RuntimeHostUri.Parts origin = RuntimeHostUri.parse(connection.url);
        if (origin == null || origin.host == null) throw new RuntimeBridgeFailure("invalid_path", "无效的 Host API 路径");
        Request request = new Request();
        request.path = parts.path;
        request.query = parts.query;
        request.method = method;
        StringBuilder url = new StringBuilder();
        url.append(origin.scheme).append("://").append(origin.host);
        if (origin.port != null) url.append(':').append(origin.port);
        url.append(RuntimeHostUri.encodeForWire(parts.path));
        if (parts.query != null) url.append('?').append(RuntimeHostUri.encodeForWire(parts.query));
        request.url = url.toString();
        request.headers.put("Accept", "application/json");
        if (connection.token == null || RuntimeHostText.utf8Length(connection.token) > 8192
                || !RuntimeHostText.printableAscii(connection.token)) {
            throw new RuntimeBridgeFailure("invalid_credential", "无效的设备访问凭据");
        }
        if (!connection.token.isEmpty()) request.headers.put("Authorization", "Bearer " + connection.token);
        if (body != null) {
            try {
                request.body = RuntimeBridgeJson.stringify(body).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            } catch (RuntimeBridgeFailure failure) {
                throw new RuntimeBridgeFailure("invalid_body", "无效的请求内容");
            }
            request.headers.put("Content-Type", "application/json");
        }
        return request;
    }

    private static String route(Request request) {
        return request.path + (request.query == null ? "" : "?" + request.query);
    }

    private RelayTunnel tunnelFor(ConnectionEditorRelay relay) throws Exception {
        String key = relay.scope();
        synchronized (stateLock) {
            RelayTunnel existing = tunnels.get(key);
            if (existing != null) return existing;
            RelayTunnel tunnel = new RelayTunnel(relay.relayUrl, relay.serverId, relay.hostEncPubJwk);
            tunnels.put(key, tunnel);
            return tunnel;
        }
    }

    private SessionMessageStream.UrlToken mintUrlToken(ConnectionEditorConnection connection, RelayTunnel tunnel,
                                                       long timeoutMs) throws Exception {
        Request mint = makeRequest("/auth/url-token", connection, "POST", null, true);
        long started = System.nanoTime() / 1_000_000L;
        RelayTunnel.Response response = tunnel.request("/auth/url-token", "POST", mint.headers, null,
            Math.max(1, timeoutMs / 1000));
        Object body;
        try {
            body = RuntimeBridgeJson.parse(new String(response.body, java.nio.charset.StandardCharsets.UTF_8));
        } catch (RuntimeBridgeFailure failure) {
            throw new RuntimeBridgeFailure("token_failed");
        }
        long now = System.nanoTime() / 1_000_000L;
        return SessionMessageStream.urlToken(response.status, response.headers, body, connection.token, started, now);
    }

    private HostLease.JsonResponse executeJSON(Request request, ConnectionEditorConnection connection,
                                               RelayTunnel candidate) throws Exception {
        if (connection.relay != null) {
            RelayTunnel tunnel = candidate != null ? candidate : tunnelFor(connection.relay);
            RelayTunnel.Response response = tunnel.request(route(request), request.method, request.headers, request.body,
                Math.max(1, request.timeoutMs / 1000));
            boolean plain = responseKind(request.path, response.status, response.header("content-type"));
            return decoded(response.body, response.status, plain);
        }
        RuntimeBridgeHttp.Response response = RuntimeBridgeHttp.read(request.url, request.method, request.headers,
            request.body, RESPONSE_LIMIT, CONNECT_TIMEOUT, (int) request.timeoutMs);
        boolean plain = responseKind(request.path, response.status, response.header("content-type"));
        return decoded(response.data, response.status, plain);
    }

    private static boolean responseKind(String path, int status, String contentType) throws RuntimeBridgeFailure {
        String type = contentType == null ? null : contentType.split(";")[0].trim().toLowerCase(Locale.ROOT);
        boolean plainText = "/api/fs/read".equals(path) && "text/plain".equals(type);
        boolean allowed = "application/json".equals(type) || plainText || status == 204 || status == 205;
        if (!allowed) throw new RuntimeBridgeFailure("unexpected_response", "Host 返回了非预期数据，请检查地址与服务版本");
        return plainText;
    }

    private static HostLease.JsonResponse decoded(byte[] data, int status, boolean plainText) throws RuntimeBridgeFailure {
        if (plainText) {
            try {
                String value = java.nio.charset.StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                    .decode(java.nio.ByteBuffer.wrap(data)).toString();
                return new HostLease.JsonResponse(status, value);
            } catch (Exception failure) {
                throw new RuntimeBridgeFailure("invalid_text", "文件不是有效的 UTF-8 文本");
            }
        }
        if (data.length == 0) return new HostLease.JsonResponse(status, null);
        try {
            return new HostLease.JsonResponse(status, RuntimeBridgeJson.parse(
                new String(data, java.nio.charset.StandardCharsets.UTF_8)));
        } catch (RuntimeBridgeFailure failure) {
            throw new RuntimeBridgeFailure("unexpected_response", "Host 返回了非预期数据，请检查地址与服务版本");
        }
    }

    // ----------------------------------------------------------------- admission

    private static final class HostAdmission {
        final ConnectionEditorConnection connection;
        final int generation;
        final RuntimeHostScope expectedHost;

        HostAdmission(ConnectionEditorConnection connection, int generation, RuntimeHostScope expectedHost) {
            this.connection = connection;
            this.generation = generation;
            this.expectedHost = expectedHost;
        }
    }

    /**
     * Synchronous transaction: no state change can occur between validating the caller's
     * lease and copying the exact connection, credential and generation used for I/O.
     */
    private HostAdmission admit(RuntimeHostScope expected, boolean required) throws RuntimeHostScopeFailure {
        synchronized (stateLock) {
            ConnectionEditorConnection selected = store.selected();
            RuntimeHostScope accepted = authority.admit(expected, selected == null ? null : selected.id, required);
            if (selected == null) throw RuntimeHostScopeFailure.unavailable();
            return new HostAdmission(selected.copy(), generation, accepted);
        }
    }

    private void requireForeground() throws RuntimeHostScopeFailure {
        if (!authority.isForeground()) throw RuntimeHostScopeFailure.background();
    }

    private String selectedID() {
        ConnectionEditorConnection selected = store.selected();
        return selected == null ? null : selected.id;
    }

    private void checkHost(ConnectionEditorConnection connection, int scope) throws RuntimeBridgeFailure {
        checkHost(connection, scope, null);
    }

    private void checkHost(ConnectionEditorConnection connection, int scope, RuntimeHostScope expected)
            throws RuntimeBridgeFailure {
        boolean foreground = authority.isForeground();
        int currentGeneration;
        synchronized (stateLock) { currentGeneration = generation; }
        ConnectionEditorConnection selected = store.selected();
        boolean same = selected != null && selected.id.equals(connection.id) && selected.url.equals(connection.url)
            && selected.token.equals(connection.token)
            && (selected.relay == null ? connection.relay == null : selected.relay.equals(connection.relay))
            && (selected.authorizationID == null ? connection.authorizationID == null
                : selected.authorizationID.equals(connection.authorizationID));
        if (!foreground || scope != currentGeneration || !same) throw new RuntimeBridgeFailure(RuntimeHostScopeFailure.STALE);
        if (expected != null && !authority.matches(expected, selected.id)) {
            throw new RuntimeBridgeFailure(RuntimeHostScopeFailure.STALE);
        }
    }

    private void retireResources() {
        List<Lease> retired;
        List<StreamJob> jobs;
        List<RelayTunnel> tunnelsToClose;
        List<PasskeyManagementSession> management;
        synchronized (stateLock) {
            generation += 1;
            connectionAttempt += 1;
            jobs = new ArrayList<>(streams.values());
            streams.clear();
            streamTokens.clear();
            streamScopes.clear();
            chatStreamOwner = null;
            retired = new ArrayList<>(leases);
            leases.clear();
            tunnelsToClose = new ArrayList<>(tunnels.values());
            tunnels.clear();
            management = new ArrayList<>(passkeySessions.values());
            passkeySessions.clear();
        }
        for (PasskeyManagementSession session : management) session.retire();
        for (StreamJob job : jobs) job.cancel();
        for (Lease lease : retired) lease.retire();
        Runnable invalidation = onInvalidate;
        if (invalidation != null) invalidation.run();
        for (RelayTunnel tunnel : tunnelsToClose) tunnel.close();
    }

    // ----------------------------------------------------------------- helpers

    private interface Work { Object run() throws Exception; }

    private void async(NshHostReply reply, Work work) {
        worker.execute(() -> {
            try {
                reply.resolve(work.run());
            } catch (Throwable failure) {
                reply.reject(message(failure));
            }
        });
    }

    /** Never forward Host/URLs/credential text: only our own codes and neutral messages. */
    private static String message(Throwable failure) {
        if (failure instanceof RuntimeHostScopeFailure) return ((RuntimeHostScopeFailure) failure).code;
        if (failure instanceof ConnectionEditorFailure) return ((ConnectionEditorFailure) failure).code;
        if (failure instanceof RuntimeBridgeFailure) return failure.getMessage();
        if (failure instanceof RelayTunnelFailure) return failure.getMessage();
        if (failure instanceof InterruptedException) return "请求已取消";
        return "Host 请求失败，请检查网络与地址";
    }

    private static String string(Object input, String key) throws RuntimeBridgeFailure {
        Map<String, Object> fields = RuntimeBridgeJson.object(input);
        Object value = fields == null ? null : fields.get(key);
        if (!(value instanceof String) || ((String) value).isEmpty()) {
            throw new RuntimeBridgeFailure("missing_parameter", "缺少参数：" + key);
        }
        return (String) value;
    }

    private static SessionMessageStream.Mode mode(Object value) {
        if (!(value instanceof String)) return null;
        switch ((String) value) {
            case "auto": return SessionMessageStream.Mode.AUTO;
            case "ws": return SessionMessageStream.Mode.WS;
            case "sse": return SessionMessageStream.Mode.SSE;
            default: return null;
        }
    }

    private static boolean validStreamOwner(String value) {
        return value != null && RuntimeHostText.identifier(value) && !value.isEmpty();
    }

    private static Map<String, Object> scopeMap(HostLease.Scope scope) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("hostID", scope.hostID);
        value.put("lease", scope.lease);
        return value;
    }

    /** Lowercase-keyed copy so callers can read Content-Type, X-Speech-Pitch, etc. */
    private static Map<String, String> normalizeHeaders(Map<String, String> headers) {
        Map<String, String> values = new LinkedHashMap<>();
        if (headers == null) return values;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey() == null || entry.getValue() == null) continue;
            String key = entry.getKey().toLowerCase(Locale.ROOT);
            if (!values.containsKey(key)) values.put(key, entry.getValue());
        }
        return values;
    }

    private static String header(Map<String, String> headers, String name) {
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (name.equalsIgnoreCase(entry.getKey())) return entry.getValue();
        }
        return null;
    }

    private static List<String[]> queryItems(String query) throws RuntimeBridgeFailure {
        List<String[]> items = new ArrayList<>();
        if (query == null || query.isEmpty()) return items;
        for (String entry : query.split("&")) {
            int split = entry.indexOf('=');
            String name = split < 0 ? entry : entry.substring(0, split);
            String raw = split < 0 ? "" : entry.substring(split + 1);
            String decodedName = RuntimeHostUri.percentDecode(name);
            String decodedValue = RuntimeHostUri.percentDecode(raw);
            if (decodedName == null || decodedValue == null) throw new RuntimeBridgeFailure("invalid_path", "无效的 Host API 路径");
            items.add(new String[] {decodedName, decodedValue});
        }
        return items;
    }

    private static boolean isPasskeyManagement(String path, String method) {
        if ("/auth/passkey/status".equals(path)) return "GET".equals(method);
        if ("/auth/passkey/register/options".equals(path) || "/auth/passkey/register/verify".equals(path)
                || "/api/auth/reset".equals(path)) {
            return "POST".equals(method);
        }
        if ("/api/passkeys".equals(path)) return "GET".equals(method);
        if (path.startsWith("/api/passkeys/") && "DELETE".equals(method)) {
            return RuntimeHostText.identifier(path.substring("/api/passkeys/".length()));
        }
        return false;
    }
}
