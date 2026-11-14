package com.yee94.yuri.nsh;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Build;
import android.text.InputType;
import android.util.Log;
import android.widget.EditText;

import com.longbridge.nsh.NshView;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Platform passkey registration plus the explicit-password management authorization. Mirrors
 * ios/PasskeyBridge.swift, with three Android-specific facts:
 *
 * <ul>
 *   <li>Registration needs API 34's {@code android.credentials.CredentialManager}; below that the call
 *       fails with passkey_registration_requires_android_14 instead of presenting a fake ceremony.</li>
 *   <li>The full-UI management transport (origin, cookie jar, credential retirement) is not part of
 *       HostLease, so it is read from the lease through {@link PasskeyTransportSource}; without that the
 *       call fails closed with passkey_unsupported_on_this_host.</li>
 *   <li>Cancellation has no delegate completion: the ceremony owner finishes immediately and any late
 *       platform result is fenced out, so it can never grant a verify permit.</li>
 * </ul>
 *
 * <p>The RP/associated-domain check reads {@code com.yee94.yuri.nsh.associatedDomains} from the
 * manifest (comma-separated {@code webcredentials:<host>} entries); a missing entry is a real failure.
 */
public final class PasskeyBridge implements NativeHandlers.Bridge, NativeHandlers.Foreground {
    private static final String SCOPE_INVALID = "runtime_host_scope_invalid";
    private static final String META_KEY = "com.yee94.yuri.nsh.associatedDomains";
    private static final int CANCELLED_MEMORY = 256;

    private interface Resetter { void run() throws Exception; }

    private static final class Ceremony {
        final String id;
        final PasskeyTransport transport;
        final android.os.CancellationSignal signal;
        final CompletableFuture<Map<String, Object>> outcome;
        boolean cancelled;

        Ceremony(String id, PasskeyTransport transport, android.os.CancellationSignal signal,
                 CompletableFuture<Map<String, Object>> outcome) {
            this.id = id;
            this.transport = transport;
            this.signal = signal;
            this.outcome = outcome;
        }
    }

    private static final class Login {
        final UUID id;
        final CompletableFuture<String> result;
        volatile AlertDialog dialog;
        boolean dismissing;

        Login(UUID id, CompletableFuture<String> result) {
            this.id = id;
            this.result = result;
        }
    }

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;
    private final PasskeyPresentationAdmission admission = new PasskeyPresentationAdmission();
    private final ExecutorService work;
    private final Map<String, PasskeyTransport> completed = new HashMap<>();
    private final Map<String, Resetter> resets = new HashMap<>();
    private final LinkedHashSet<String> cancelledIDs = new LinkedHashSet<>();
    private volatile Ceremony active;
    private volatile Login login;
    private volatile UUID authorizationID;
    private volatile boolean foreground;
    private boolean installed;

    public PasskeyBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
        final AtomicInteger index = new AtomicInteger();
        this.work = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "nsh-passkey-" + index.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        });
    }

    public void install() {
        if (installed) return;
        installed = true;
        view.handle("passkey.register", (data, reply) -> submit(reply, () -> register(data)));
        view.handle("passkey.authorizeManagement", (data, reply) -> submit(reply, () -> {
            authorize(data);
            return true;
        }));
        view.handle("passkey.authReset", (data, reply) -> submit(reply, () -> {
            authReset(data);
            return true;
        }));
        view.handle("passkey.cancel", (data, reply) -> {
            try {
                Map<String, Object> args = NotificationPolicy.object(data, "ceremonyID");
                Object raw = args.get("ceremonyID");
                if (!(raw instanceof String) || ((String) raw).isEmpty()
                        || NotificationPolicy.utf8Length((String) raw) > 256) throw PasskeyFailure.invalid();
                cancel((String) raw);
                reply.resolve(true);
            } catch (Exception error) {
                reply.reject(code(error));
            }
        });
    }

    /** Foreground admission; MainActivity forwards onResume/onPause. */
    public void setForeground(boolean value) { foreground = value; }

    /** Host, authorization or lifecycle change: revoke presentation, proofs and cached resets. */
    public void invalidate() {
        admission.beginClose();
        UUID authorization = authorizationID;
        if (authorization != null) cancelAuthorization(authorization);
        Ceremony owner = active;
        if (owner != null) beginCancel(owner);
        Map<String, PasskeyTransport> previous = new HashMap<>(completed);
        completed.clear();
        for (Map.Entry<String, PasskeyTransport> entry : previous.entrySet()) entry.getValue().cancel(entry.getKey());
        synchronized (resets) { resets.clear(); }
        try {
            work.execute(() -> {
                try {
                    admission.drain(5000);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            });
        } catch (RejectedExecutionException ignored) {
            // Already shut down.
        }
        work.shutdown();
    }

    private interface Operation { Object run() throws Exception; }

    private void submit(com.longbridge.nsh.NshHostReply reply, Operation operation) {
        try {
            work.execute(() -> {
                try {
                    reply.resolve(operation.run());
                } catch (Throwable error) {
                    reply.reject(code(error));
                }
            });
        } catch (RejectedExecutionException error) {
            reply.reject(PasskeyFailure.CANCELLED);
        }
    }

    private Map<String, Object> register(Object input) throws Exception {
        // iOS requires 17.4 for reliable cancellation and exclusions; the Android peer is API 34.
        if (Build.VERSION.SDK_INT < 34) throw new PasskeyFailure(PasskeyFailure.SYSTEM_VERSION);
        Map<String, Object> args = NotificationPolicy.object(input, "expectedHost", "ceremonyID", "optionsJSON");
        Object rawCeremony = args.get("ceremonyID");
        Map<String, Object> optionsJSON = NotificationJson.map(args.get("optionsJSON"));
        if (!(rawCeremony instanceof String) || ((String) rawCeremony).isEmpty()
                || NotificationPolicy.utf8Length((String) rawCeremony) > 256 || optionsJSON == null) {
            throw PasskeyFailure.invalid();
        }
        String id = (String) rawCeremony;
        UUID reservation = admission.reserve();
        Ceremony owner = null;
        try {
            if (completed.containsKey(id) || isCancelled(id)) throw PasskeyFailure.cancelled();
            PasskeyTransport transport = transport(scope(args.get("expectedHost")));
            PasskeyRegistrationOptions options = PasskeyRegistrationOptions.parse(optionsJSON, transport.origin(),
                    associatedDomains());
            window();
            transport.bind(optionsJSON, id);
            android.os.CancellationSignal signal = new android.os.CancellationSignal();
            CompletableFuture<Map<String, Object>> outcome = PlatformCeremony.start(activity,
                    NotificationJson.stringify(optionsJSON), signal, work);
            owner = new Ceremony(id, transport, signal, outcome);
            active = owner;
            final Ceremony ownerRef = owner;
            transport.onRetire(() -> {
                if (active == ownerRef) beginCancel(ownerRef);
            });
            if (!admission.isCurrent(reservation) || !transport.isCurrent() || Thread.currentThread().isInterrupted()) {
                beginCancel(owner);
                throw PasskeyFailure.cancelled();
            }
            Map<String, Object> value;
            try {
                value = outcome.get();
            } catch (ExecutionException error) {
                throw failure(error.getCause());
            }
            admission.check(reservation);
            if (owner.cancelled || !transport.isCurrent() || !foreground) {
                transport.cancel(id);
                throw PasskeyFailure.cancelled();
            }
            Object credential = value.get("id");
            if (!(credential instanceof String) || ((String) credential).isEmpty()) {
                transport.cancel(id);
                throw new PasskeyFailure(PasskeyFailure.RESPONSE);
            }
            transport.complete(id, (String) credential);
            completed.put(id, transport);
            transport.onRetire(() -> completed.remove(id));
            return value;
        } finally {
            if (owner != null && active == owner) active = null;
            admission.release(reservation);
        }
    }

    private void authorize(Object input) throws Exception {
        UUID id = admission.reserve();
        authorizationID = id;
        try {
            Map<String, Object> args = NotificationPolicy.object(input, "expectedHost", "labels");
            PasskeyManagementLabels labels = PasskeyManagementLabels.parse(args.get("labels"));
            PasskeyTransport transport = transport(scope(args.get("expectedHost")));
            transport.onRetire(() -> cancelAuthorization(id));
            PasskeyTransport.Response status = requestAuthorization(id, transport, "/auth/passkey/status", "GET", null);
            admission.check(id);
            if (!transport.isCurrent()) throw PasskeyFailure.cancelled();
            if (status.status != 200 || Boolean.TRUE.equals(status.body.get("tunnelLocked"))) {
                throw new PasskeyFailure(PasskeyFailure.LOCKED);
            }
            window();
            String password = promptPassword(id, labels, transport.origin());
            admission.check(id);
            if (!transport.isCurrent()) throw PasskeyFailure.cancelled();
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("password", password);
            body.put("trustDevice", false);
            body.put("issueClientToken", false);
            PasskeyTransport.Response result = requestAuthorization(id, transport, "/auth/session", "POST", body);
            admission.check(id);
            if (result.status != 200 || !Boolean.TRUE.equals(result.body.get("authenticated"))) {
                throw new PasskeyFailure(PasskeyFailure.SESSION);
            }
        } finally {
            if (id.equals(authorizationID)) authorizationID = null;
            admission.release(id);
        }
    }

    private PasskeyTransport.Response requestAuthorization(UUID id, PasskeyTransport transport,
                                                           String path, String method, Map<String, Object> body)
            throws Exception {
        admission.check(id);
        if (!transport.isCurrent() || !foreground) throw PasskeyFailure.cancelled();
        PasskeyTransport.Response response = transport.request(path, method, body);
        admission.check(id);
        if (!transport.isCurrent() || !foreground) throw PasskeyFailure.cancelled();
        return response;
    }

    private void authReset(Object input) throws Exception {
        admission.requireOpen();
        Map<String, Object> args = NotificationPolicy.object(input, "expectedHost");
        HostLease.Scope expected = scope(args.get("expectedHost"));
        String key = expected.hostID + "\n" + expected.lease;
        Resetter cached;
        synchronized (resets) { cached = resets.get(key); }
        if (cached != null) {
            cached.run();
            return;
        }
        PasskeyTransport transport = transport(expected);
        Resetter reset = transport::reset;
        synchronized (resets) { resets.put(key, reset); }
        reset.run();
    }

    private void cancel(String id) {
        synchronized (cancelledIDs) {
            cancelledIDs.add(id);
            while (cancelledIDs.size() > CANCELLED_MEMORY) {
                String oldest = cancelledIDs.iterator().next();
                cancelledIDs.remove(oldest);
            }
        }
        PasskeyTransport finished = completed.remove(id);
        if (finished != null) finished.cancel(id);
        Ceremony owner = active;
        if (owner != null && owner.id.equals(id)) beginCancel(owner);
    }

    private boolean isCancelled(String id) {
        synchronized (cancelledIDs) { return cancelledIDs.contains(id); }
    }

    private void beginCancel(Ceremony owner) {
        if (owner.cancelled) return;
        owner.cancelled = true;
        owner.transport.cancel(owner.id);
        owner.signal.cancel();
        // Android reports no cancellation completion; fencing the owner discards a late attestation.
        owner.outcome.completeExceptionally(PasskeyFailure.cancelled());
    }

    private void cancelAuthorization(UUID id) {
        if (!id.equals(authorizationID)) return;
        admission.cancel(id);
        Login owner = login;
        if (owner != null && owner.id.equals(id)) resolveLogin(owner, null);
    }

    private String promptPassword(UUID id, PasskeyManagementLabels labels, java.net.URI origin) throws Exception {
        CompletableFuture<String> result = new CompletableFuture<>();
        Login owner = new Login(id, result);
        login = owner;
        activity.runOnUiThread(() -> {
            if (!admission.isCurrent(id)) {
                result.completeExceptionally(PasskeyFailure.cancelled());
                return;
            }
            EditText field = new EditText(activity);
            field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            field.setHint(labels.passwordPlaceholder);
            AlertDialog dialog = new AlertDialog.Builder(activity)
                    .setTitle(labels.title)
                    .setMessage(origin == null || origin.getHost() == null ? "" : origin.getHost())
                    .setView(field)
                    .setNegativeButton(labels.cancel, (which, argument) -> resolveLogin(owner, null))
                    .setPositiveButton(labels.submit, (which, argument) -> {
                        String text = field.getText() == null ? "" : field.getText().toString();
                        field.setText("");
                        resolveLogin(owner, text);
                    })
                    .setOnCancelListener(which -> resolveLogin(owner, null))
                    .create();
            owner.dialog = dialog;
            dialog.show();
        });
        try {
            return result.get();
        } catch (ExecutionException error) {
            throw failure(error.getCause());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw PasskeyFailure.cancelled();
        }
    }

    private void resolveLogin(Login owner, String password) {
        synchronized (this) {
            if (login != owner || owner.dismissing) return;
            owner.dismissing = true;
            login = null;
        }
        AlertDialog dialog = owner.dialog;
        if (dialog != null) {
            activity.runOnUiThread(dialog::dismiss);
        }
        if (password == null || !admission.isCurrent(owner.id)) owner.result.completeExceptionally(PasskeyFailure.cancelled());
        else owner.result.complete(password);
    }

    private void window() throws PasskeyFailure {
        if (activity.isFinishing() || activity.isDestroyed() || !foreground) throw PasskeyFailure.presentation();
    }

    private PasskeyTransport transport(HostLease.Scope expected) throws Exception {
        HostLease lease = leases.capture(expected);
        if (!(lease instanceof PasskeyTransportSource)) throw PasskeyFailure.unavailable();
        PasskeyTransport transport = ((PasskeyTransportSource) lease).passkeyTransport();
        if (transport == null) throw PasskeyFailure.unavailable();
        return transport;
    }

    /** {hostID, lease} exactly; the runtime owner still validates the receipt against its generation. */
    private static HostLease.Scope scope(Object input) throws PasskeyFailure {
        Map<String, Object> value;
        try {
            value = NotificationPolicy.object(input, "hostID", "lease");
        } catch (NotificationFailure error) {
            throw new PasskeyFailure(SCOPE_INVALID);
        }
        Object hostID = value.get("hostID");
        Object raw = value.get("lease");
        if (!(hostID instanceof String) || ((String) hostID).isEmpty()
                || NotificationPolicy.utf8Length((String) hostID) > 256) throw new PasskeyFailure(SCOPE_INVALID);
        String text = (String) hostID;
        for (int index = 0; index < text.length(); index++) {
            if (Character.isISOControl(text.charAt(index))) throw new PasskeyFailure(SCOPE_INVALID);
        }
        if (!(raw instanceof String) || ((String) raw).length() != 36 || !NotificationPolicy.uuid((String) raw)) {
            throw new PasskeyFailure(SCOPE_INVALID);
        }
        return new HostLease.Scope(text, ((String) raw).toLowerCase(Locale.ROOT));
    }

    private Set<String> associatedDomains() {
        Set<String> out = new HashSet<>();
        try {
            android.os.Bundle meta = activity.getPackageManager()
                    .getApplicationInfo(activity.getPackageName(), android.content.pm.PackageManager.GET_META_DATA).metaData;
            Object raw = meta == null ? null : meta.getString(META_KEY);
            if (raw instanceof String) {
                for (String entry : ((String) raw).split(",")) {
                    String value = entry.trim().toLowerCase(Locale.ROOT);
                    if (!value.isEmpty()) out.add(value);
                }
            }
        } catch (Exception ignored) {
            // A missing or unreadable manifest entry leaves the set empty, which fails closed.
        }
        return out;
    }

    private static Exception failure(Throwable error) {
        if (error instanceof PasskeyFailure) return (PasskeyFailure) error;
        if (error instanceof Exception) return (Exception) error;
        return new Exception(error);
    }

    private static String code(Throwable error) {
        if (error instanceof PasskeyFailure) return ((PasskeyFailure) error).code;
        if (error instanceof NotificationFailure) return ((NotificationFailure) error).code;
        String message = error.getMessage();
        if (message != null && !message.isEmpty()) return message;
        Log.w("nsh", "passkey bridge failure without a code: " + error.getClass().getName());
        return PasskeyFailure.UNSUPPORTED;
    }

    /**
     * Isolated so API 34's {@code android.credentials} types are only loaded when the register branch
     * actually runs. Without AndroidX there is no typed request wrapper, so the documented credential
     * type and bundle keys are used directly; a provider that refuses them fails explicitly.
     */
    private static final class PlatformCeremony {
        private static final String TYPE = "androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL";
        private static final String REQUEST_JSON = "androidx.credentials.BUNDLE_KEY_REQUEST_JSON";
        private static final String RESPONSE_JSON = "androidx.credentials.BUNDLE_KEY_REGISTRATION_RESPONSE_JSON";

        static CompletableFuture<Map<String, Object>> start(Activity activity, String optionsJson,
                                                           android.os.CancellationSignal signal,
                                                           java.util.concurrent.Executor executor) {
            CompletableFuture<Map<String, Object>> outcome = new CompletableFuture<>();
            android.credentials.CredentialManager manager =
                    activity.getSystemService(android.credentials.CredentialManager.class);
            if (manager == null) {
                outcome.completeExceptionally(PasskeyFailure.presentation());
                return outcome;
            }
            android.os.Bundle credentialData = new android.os.Bundle();
            credentialData.putString(REQUEST_JSON, optionsJson);
            android.os.Bundle candidateQueryData = new android.os.Bundle();
            candidateQueryData.putString(REQUEST_JSON, optionsJson);
            android.credentials.CreateCredentialRequest request;
            try {
                request = new android.credentials.CreateCredentialRequest.Builder(TYPE, credentialData, candidateQueryData).build();
            } catch (RuntimeException error) {
                outcome.completeExceptionally(PasskeyFailure.unavailable());
                return outcome;
            }
            try {
                manager.createCredential(activity, request, signal, executor,
                        new android.os.OutcomeReceiver<android.credentials.CreateCredentialResponse,
                                android.credentials.CreateCredentialException>() {
                            @Override public void onResult(android.credentials.CreateCredentialResponse response) {
                                try {
                                    outcome.complete(registration(response));
                                } catch (Throwable error) {
                                    outcome.completeExceptionally(error);
                                }
                            }

                            @Override public void onError(android.credentials.CreateCredentialException error) {
                                String type = error == null ? null : error.getType();
                                if ("android.credentials.TYPE_USER_CANCELED".equals(type)) {
                                    outcome.completeExceptionally(PasskeyFailure.cancelled());
                                } else {
                                    outcome.completeExceptionally(PasskeyFailure.systemType(type));
                                }
                            }
                        });
            } catch (RuntimeException error) {
                outcome.completeExceptionally(PasskeyFailure.unavailable());
            }
            return outcome;
        }

        private static Map<String, Object> registration(android.credentials.CreateCredentialResponse response)
                throws Exception {
            android.os.Bundle data = response.getData();
            String json = data == null ? null : data.getString(RESPONSE_JSON);
            Map<String, Object> value = NotificationJson.map(NotificationJson.parse(json));
            if (value == null) throw new PasskeyFailure(PasskeyFailure.RESPONSE);
            Object id = value.get("id");
            Object rawId = value.get("rawId");
            Map<String, Object> inner = NotificationJson.map(value.get("response"));
            Object clientData = inner == null ? null : inner.get("clientDataJSON");
            Object attestation = inner == null ? null : inner.get("attestationObject");
            if (!(id instanceof String) || ((String) id).isEmpty()
                    || !(rawId instanceof String) || ((String) rawId).isEmpty()
                    || !"public-key".equals(value.get("type"))
                    || !(clientData instanceof String) || ((String) clientData).isEmpty()
                    || !(attestation instanceof String) || ((String) attestation).isEmpty()) {
                throw new PasskeyFailure(PasskeyFailure.RESPONSE);
            }
            Map<String, Object> extensions = NotificationJson.map(value.get("clientExtensionResults"));
            Map<String, Object> responseValue = new LinkedHashMap<>();
            responseValue.put("clientDataJSON", clientData);
            responseValue.put("attestationObject", attestation);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("id", id);
            out.put("rawId", rawId);
            out.put("type", "public-key");
            out.put("response", responseValue);
            out.put("clientExtensionResults", extensions == null ? new LinkedHashMap<String, Object>() : extensions);
            return out;
        }
    }
}
