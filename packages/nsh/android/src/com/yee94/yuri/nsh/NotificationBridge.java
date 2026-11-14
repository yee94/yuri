package com.yee94.yuri.nsh;

import android.app.Activity;
import android.content.Intent;
import android.util.Log;

import com.longbridge.nsh.NshView;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Local notifications plus the durable cold-tap path. Mirrors ios/NotificationBridge.swift.
 *
 * <p>APNs has no Android counterpart without an FCM dependency: there is no push-registration host
 * call and {@code notification.status.backgroundPush} is always false. Everything that can be local
 * (channel, permission, admission proof, receipt journal, launch claim/ack, retirement) is implemented.
 *
 * <p>Two intentional platform differences: foreground suppression is evaluated when a notification is
 * posted because Android has no willPresent delegate, and retirement never has pending asynchronous
 * adds to settle because posting is synchronous.
 */
public final class NotificationBridge implements NativeHandlers.Bridge, NativeHandlers.Foreground {
    private static final int LIMIT = 256;

    private static final class Entry {
        final NotificationHostScope scope;
        final int revision;
        final NotificationTarget target;
        final NotificationConfiguration configuration;
        final boolean test;
        final NotificationAdmission admission;

        Entry(NotificationHostScope scope, int revision, NotificationTarget target,
              NotificationConfiguration configuration, boolean test, NotificationAdmission admission) {
            this.scope = scope;
            this.revision = revision;
            this.target = target;
            this.configuration = configuration;
            this.test = test;
            this.admission = admission;
        }
    }

    private static final class Claim {
        final int revision;
        final String lease;

        Claim(int revision, String lease) { this.revision = revision; this.lease = lease; }
    }

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;
    private final NotificationSystem system;
    private final NotificationLaunch launch;
    private final Map<String, Claim> claims = new HashMap<>();
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final List<String> order = new ArrayList<>();
    private final Set<String> seen = new HashSet<>();
    private final List<String> seenOrder = new ArrayList<>();
    private NotificationHostScope scope;
    private NotificationConfiguration configuration;
    private String lease = "";
    private int revision;
    private volatile boolean foreground;
    private boolean installed;
    private String lastTap;

    public NotificationBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
        this.system = new NotificationSystem(activity);
        this.launch = NotificationLaunch.shared(activity);
    }

    /** Call in MainActivity.onCreate before the bundle loads so a cold tap is never dropped. */
    public static void installLaunch(Activity activity) {
        NotificationLaunch.shared(activity).refreshInbox();
    }

    /** MainActivity onCreate/onNewIntent handoff for one of our notification taps. */
    public static boolean receiveTap(Intent intent) {
        NotificationLaunch owner = NotificationLaunch.installed();
        return owner != null && owner.receive(intent);
    }

    /** MainActivity.onRequestPermissionsResult handoff. */
    public boolean onRequestPermissionsResult(int requestCode, int[] grantResults) {
        return system.onRequestPermissionsResult(requestCode, grantResults);
    }

    public void install() {
        if (installed) return;
        installed = true;
        system.install();
        installLaunch(activity);
        launch.changed(() -> view.send("notification.launch.available", new LinkedHashMap<String, Object>()));
        receiveTapFromIntent();
        view.handle("notification.launch.peek", (data, reply) -> {
            try {
                NotificationPolicy.object(data);
                NotificationLaunchInbox inbox = launch.refreshInbox();
                if (inbox == null) throw NotificationFailure.unavailable();
                NotificationLaunchInbox.Record pending = inbox.pending();
                reply.resolve(NotificationPolicy.map("record", pending == null ? null : pending.value()));
            } catch (Exception error) {
                reply.reject(code(error));
            }
        });
        view.handle("notification.launch.claim", (data, reply) -> {
            try {
                reply.resolve(claimLaunch(data));
            } catch (Exception error) {
                reply.reject(code(error));
            }
        });
        view.handle("notification.launch.ack", (data, reply) -> {
            try {
                acknowledgeLaunch(data);
                reply.resolve(NotificationPolicy.map("ok", true));
            } catch (Exception error) {
                reply.reject(code(error));
            }
        });
        view.handle("notification.status", (data, reply) -> {
            try {
                NotificationPolicy.object(data);
                reply.resolve(statusMap(status()));
            } catch (Exception error) {
                reply.reject(code(error));
            }
        });
        view.handle("notification.request", (data, reply) -> {
            try {
                NotificationPolicy.object(data);
                if (!foreground) throw NotificationFailure.unavailable();
                system.requestPermission(value -> reply.resolve(statusMap(value)));
            } catch (Exception error) {
                reply.reject(code(error));
            }
        });
        view.handle("notification.openSettings", (data, reply) -> {
            try {
                NotificationPolicy.object(data);
                if (!foreground || !system.openSettings()) throw NotificationFailure.unavailable();
                reply.resolve(null);
            } catch (Exception error) {
                reply.reject(code(error));
            }
        });
        view.handle("notification.configure", (data, reply) -> {
            try {
                reply.resolve(configure(data));
            } catch (Exception error) {
                reply.reject(code(error));
            }
        });
        view.handle("notification.live", (data, reply) -> {
            try {
                reply.resolve(live(data));
            } catch (Exception error) {
                reply.reject(code(error));
            }
        });
        view.handle("notification.test", (data, reply) -> {
            try {
                reply.resolve(test(data));
            } catch (Exception error) {
                reply.reject(code(error));
            }
        });
    }

    /** Foreground admission; MainActivity forwards onResume/onPause. */
    public void setForeground(boolean active) {
        boolean changed = foreground != active;
        foreground = active;
        if (!active) return;
        // MainActivity may not forward onRequestPermissionsResult; a resume after the system
        // dialog settles the outstanding prompt instead of leaving the call unanswered.
        system.settlePermission();
        receiveTapFromIntent();
        if (changed) view.send("notification.status", statusMap(status()));
    }

    /** The launching intent is on the activity: a cold tap survives even before the bridge exists. */
    private void receiveTapFromIntent() {
        Intent intent = activity.getIntent();
        if (intent == null || !intent.hasExtra(NotificationSystem.EXTRA_RECEIPT)) return;
        String receipt = intent.getStringExtra(NotificationSystem.EXTRA_RECEIPT);
        if (receipt == null || receipt.equals(lastTap)) return;
        if (NotificationBridge.receiveTap(intent)) lastTap = receipt;
    }

    /** Called synchronously from RuntimeBridge.onInvalidate: Host switch, remove or reconnect fence. */
    public void invalidate() {
        revision++;
        scope = null;
        configuration = null;
        lease = "";
        claims.clear();
        seen.clear();
        seenOrder.clear();
        List<String> identifiers = new ArrayList<>();
        for (String receipt : order) {
            Entry entry = entries.get(receipt);
            if (entry != null && entry.target == null) identifiers.add(NotificationLaunchInbox.PREFIX + receipt);
        }
        // Valid protected records and their OS notifications survive an ordinary transport generation.
        entries.clear();
        order.clear();
        for (String identifier : identifiers) system.cancel(identifier);
    }

    /** Only an explicit authorization revocation calls this; transient generations never do. */
    public void retireAuthorization(String connectionID, String authorizationID) throws Exception {
        if (!NotificationPolicy.identifier(connectionID) || !NotificationPolicy.identifier(authorizationID)
                || "legacy".equals(authorizationID)) throw NotificationFailure.invalid();
        NotificationLaunchInbox inbox = launch.refreshInbox();
        if (inbox == null) throw NotificationFailure.unavailable();
        NotificationLaunchInbox.RetirementBatch batch = inbox.beginRetirement(connectionID, authorizationID);
        Set<String> retired = new HashSet<>(batch.receipts);
        for (String receipt : batch.receipts) {
            entries.remove(receipt);
            claims.remove(receipt);
        }
        order.removeAll(retired);
        if (scope != null && scope.hostID.equals(connectionID) && Objects.equals(scope.authorizationID, authorizationID)) {
            invalidate();
        }
        NotificationLaunchInbox.runRetirementCleanup(inbox, connectionID, authorizationID,
                receipts -> { }, identifiers -> {
                    for (String identifier : identifiers) system.cancel(identifier);
                },
                () -> new ArrayList<>(system.activeIdentifiers()),
                () -> new ArrayList<>(system.activeIdentifiers()));
    }

    private Map<String, Object> claimLaunch(Object input) throws Exception {
        Map<String, Object> value = NotificationPolicy.object(input, "connectionID", "receipt");
        NotificationLaunchInbox.Record pending = launchRecord(value);
        claims.clear();
        claims.put(pending.receipt, new Claim(pending.revision, lease));
        return NotificationPolicy.map("record", pending.value(),
                "route", NotificationPolicy.map("hostID", pending.connectionID, "lease", lease, "target", pending.target().value()));
    }

    private NotificationLaunchInbox.Record launchRecord(Map<String, Object> value) throws Exception {
        NotificationHostScope bound = scope;
        if (!foreground || bound == null || !bound.isCurrent() || lease.isEmpty()
                || !(value.get("receipt") instanceof String)
                || !bound.hostID.equals(value.get("connectionID"))) throw NotificationFailure.stale();
        NotificationLaunchInbox inbox = launch.refreshInbox();
        if (inbox == null) throw NotificationFailure.stale();
        NotificationHostScope captured = capture();
        if (!captured.isCurrent() || !captured.hostID.equals(bound.hostID)
                || !Objects.equals(captured.authorizationID, bound.authorizationID)) throw NotificationFailure.stale();
        return inbox.claim((String) value.get("receipt"), bound.hostID, bound.authorizationID, System.currentTimeMillis());
    }

    private void acknowledgeLaunch(Object input) throws Exception {
        Map<String, Object> value = NotificationPolicy.object(input, "connectionID", "receipt", "lease", "expectedRevision");
        if (!lease.equals(value.get("lease")) || lease.isEmpty()) throw NotificationFailure.stale();
        NotificationLaunchInbox.Record record = launchRecord(NotificationPolicy.map(
                "connectionID", value.get("connectionID"), "receipt", value.get("receipt")));
        int expected = NotificationPolicy.positiveInteger(value.get("expectedRevision"));
        Claim claimed = claims.get(record.receipt);
        if (claimed == null || claimed.revision != expected || !claimed.lease.equals(lease)) throw NotificationFailure.stale();
        NotificationLaunchInbox inbox = launch.inbox();
        NotificationHostScope bound = scope;
        if (inbox == null || bound == null) throw NotificationFailure.invalid();
        inbox.consume(record.receipt, expected, bound.hostID, bound.authorizationID);
        claims.remove(record.receipt);
        entries.remove(record.receipt);
        order.remove(record.receipt);
        system.cancel(NotificationLaunchInbox.PREFIX + record.receipt);
    }

    private String status() {
        return system.authorization();
    }

    private Map<String, Object> statusMap(String authorization) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("authorization", authorization);
        out.put("alert", system.alertSetting());
        out.put("sound", system.soundSetting());
        out.put("badge", system.badgeSetting());
        out.put("backgroundPush", false);
        return out;
    }

    private Map<String, Object> configure(Object input) throws Exception {
        NotificationHostScope captured = capture();
        if (!captured.isCurrent()) throw NotificationFailure.stale();
        NotificationConfiguration next = NotificationConfiguration.parse(input, captured.hostID);
        if (scope != null && scope.hostID.equals(captured.hostID) && scope.isCurrent() && next.equals(configuration)
                && !lease.isEmpty() && Objects.equals(scope.authorizationID, captured.authorizationID)) {
            return NotificationPolicy.map("lease", lease);
        }
        invalidate();
        scope = captured;
        configuration = next;
        lease = UUID.randomUUID().toString();
        return NotificationPolicy.map("lease", lease);
    }

    private boolean current(Entry entry) {
        if (entry.revision != revision || !entry.scope.isCurrent()) return false;
        NotificationHostScope selected;
        try {
            selected = capture();
        } catch (Exception error) {
            return false;
        }
        return selected.isCurrent() && selected.hostID.equals(entry.scope.hostID)
                && Objects.equals(selected.authorizationID, entry.scope.authorizationID);
    }

    private boolean shouldPresent(Entry entry) {
        return current(entry) && NotificationPolicy.present(
                entry.configuration != null && entry.configuration.enabled, foreground, entry.test);
    }

    private Map<String, Object> live(Object input) throws Exception {
        NotificationHostScope bound = scope;
        NotificationConfiguration config = configuration;
        if (bound == null || config == null || !bound.isCurrent()) throw NotificationFailure.stale();
        NotificationEvent event = NotificationEvent.parse(input, lease);
        if (event.admission == null || event.target == null) throw NotificationFailure.invalid();
        Entry entry = new Entry(bound, revision, event.target, config, false, event.admission);
        if (seen.contains(event.eventID)) return NotificationPolicy.map("result", "duplicate");
        seen.add(event.eventID);
        seenOrder.add(event.eventID);
        if (seenOrder.size() > LIMIT) seen.remove(seenOrder.remove(0));
        if (!config.events.contains(event.kind) || !shouldPresent(entry)) {
            return NotificationPolicy.map("result", "suppressed");
        }
        try {
            return schedule(entry, config.language);
        } catch (NotificationFailure error) {
            if (current(entry)) {
                seen.remove(event.eventID);
                seenOrder.remove(event.eventID);
            }
            throw error;
        }
    }

    private Map<String, Object> test(Object input) throws Exception {
        Map<String, Object> value = NotificationPolicy.object(input, "hostID", "language");
        NotificationHostScope captured = capture();
        Object language = value.get("language");
        if (!captured.hostID.equals(value.get("hostID")) || !NotificationPolicy.identifier(captured.hostID)
                || !captured.isCurrent() || !foreground
                || !(language instanceof String) || !NotificationPolicy.LANGUAGES.contains(language)) {
            throw NotificationFailure.invalid();
        }
        return schedule(new Entry(captured, revision, null, null, true, null), (String) language);
    }

    private Map<String, Object> schedule(Entry entry, String language) throws NotificationFailure {
        if (!current(entry)) throw NotificationFailure.stale();
        if (!NotificationPolicy.authorized(system.authorization())) throw NotificationFailure.denied();
        if (!shouldPresent(entry)) return NotificationPolicy.map("result", "suppressed");
        if (entries.size() >= LIMIT) throw NotificationFailure.unavailable();
        String receipt = UUID.randomUUID().toString();
        String identifier = NotificationLaunchInbox.PREFIX + receipt;
        String[] copy = NotificationPolicy.copy(language, entry.test);
        if (entry.target != null) {
            NotificationLaunchInbox inbox = launch.refreshInbox();
            if (inbox == null || entry.scope.authorizationID == null || entry.admission == null) {
                throw NotificationFailure.unavailable();
            }
            inbox.record(receipt, entry.scope.hostID, entry.scope.authorizationID, entry.admission);
        }
        entries.put(receipt, entry);
        order.add(receipt);
        if (order.size() > LIMIT) {
            String oldest = order.remove(0);
            entries.remove(oldest);
            system.cancel(NotificationLaunchInbox.PREFIX + oldest);
        }
        try {
            NotificationLaunchInbox inbox = entry.target == null ? null : launch.inbox();
            NotificationLaunchInbox.submitDelivery(inbox, receipt, () -> current(entry), () -> {
                if (!system.post(identifier, receipt, copy[0], copy[1])) {
                    throw new NotificationFailure(NotificationFailure.UNAVAILABLE);
                }
            }, () -> system.cancel(identifier));
        } catch (NotificationFailure error) {
            entries.remove(receipt);
            order.remove(receipt);
            throw error;
        }
        return NotificationPolicy.map("result", "scheduled");
    }

    private NotificationHostScope capture() throws Exception {
        return NotificationHostScope.capture(leases.capture(null));
    }

    private static String code(Throwable error) {
        if (error instanceof NotificationFailure) return ((NotificationFailure) error).code;
        if (error instanceof PasskeyFailure) return ((PasskeyFailure) error).code;
        String message = error.getMessage();
        if (message != null && !message.isEmpty()) return message;
        Log.w("nsh", "notification bridge failure without a code: " + error.getClass().getName());
        return NotificationFailure.UNAVAILABLE;
    }

    /** Exposed for tests and diagnostics; not part of the host call surface. */
    String lease() { return lease; }
}
