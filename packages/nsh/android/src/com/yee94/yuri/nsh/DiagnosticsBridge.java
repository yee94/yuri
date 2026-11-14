package com.yee94.yuri.nsh;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Content-free diagnostics projection (iOS DiagnosticsBridge.swift). The
 * in-memory ring holds only closed, validated event rows; no Host response,
 * credential, URL, message text or error string is ever stored. A
 * snapshot-sharing opt-in is not consent to runtime event recording.
 *
 * Android exports through ACTION_CREATE_DOCUMENT, which gives a real
 * completion signal (unlike a share chooser), so no protected temp file and no
 * FileProvider are needed.
 */
public final class DiagnosticsBridge implements NativeHandlers.Bridge, NativeHandlers.ActivityResultSink {
    private static final String TAG = "YuriNsh";
    private static final String PREFERENCE = "nsh.about.eventDiagnostics.enabled.v2";
    private static final int REQUEST_EXPORT = 0x5201;
    private static final String FILE_NAME = "yuri-native-diagnostics.json";

    /** Closed, content-free projection. */
    public static final class AboutSnapshot {
        public static final List<String> BLOCKERS = List.of("signed-artifact", "trusted-update-origin", "signed-manifest-verifier", "native-install-lifecycle");
        public static final List<String> MANAGEMENT = List.of("manual-global", "manual-external", "bundled", "in-app", "none");
        public static final List<String> OPERATIONS = List.of("checking", "downloading", "installing", "restarting", "succeeded", "failed");
        private static final Pattern VERSION = Pattern.compile("^v?[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$");
        private static final Pattern BUILD = Pattern.compile("^[0-9]{1,18}(?:\\.[0-9]{1,6}){0,2}$");

        static String version(Object value) {
            if (!(value instanceof String)) return null;
            String text = ((String) value).trim();
            if (text.getBytes(StandardCharsets.UTF_8).length > 96 || !VERSION.matcher(text).matches()) return null;
            return text;
        }

        static String build(Object value) {
            if (!(value instanceof String)) return null;
            String text = (String) value;
            if (!text.equals(text.trim()) || !BUILD.matcher(text).matches()) return null;
            return text;
        }

        static Map<String, Object> metadata(Map<String, Object> info) {
            Map<String, Object> updates = new LinkedHashMap<>();
            updates.put("status", "unsupported");
            updates.put("blockers", BLOCKERS);
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("schemaVersion", 1);
            value.put("version", version(info.get("versionName")));
            value.put("build", build(info.get("versionCode")));
            value.put("updates", updates);
            return value;
        }

        static Object bool(Object value) {
            return value instanceof Boolean ? value : null;
        }

        static Object choice(Object value, List<String> allowed) {
            return value instanceof String && allowed.contains(value) ? value : null;
        }

        static Map<String, Object> make(Object input, Map<String, Object> info) {
            if (!(input instanceof Map)) throw new IllegalStateException("diagnostics_snapshot");
            Map<?, ?> root = (Map<?, ?>) input;
            Object schema = root.get("schemaVersion");
            if (!(schema instanceof Number) || ((Number) schema).doubleValue() != 1d) {
                throw new IllegalStateException("diagnostics_snapshot");
            }
            Map<?, ?> host = root.get("host") instanceof Map ? (Map<?, ?>) root.get("host") : Map.of();
            Map<?, ?> opencode = root.get("opencode") instanceof Map ? (Map<?, ?>) root.get("opencode") : Map.of();
            Map<?, ?> update = root.get("hostUpdate") instanceof Map ? (Map<?, ?>) root.get("hostUpdate") : Map.of();
            List<String> states = List.of("unknown", "ready", "failed");
            Map<String, Object> client = metadata(info);
            Map<String, Object> hostValue = new LinkedHashMap<>();
            hostValue.put("version", version(host.get("version")));
            hostValue.put("status", choice(host.get("status"), states));
            Map<String, Object> opencodeValue = new LinkedHashMap<>();
            opencodeValue.put("version", version(opencode.get("version")));
            opencodeValue.put("status", choice(opencode.get("status"), states));
            opencodeValue.put("management", choice(opencode.get("management"), MANAGEMENT));
            opencodeValue.put("canManage", bool(opencode.get("canManage")));
            Map<String, Object> updateValue = new LinkedHashMap<>();
            updateValue.put("status", choice(update.get("status"), states));
            updateValue.put("supported", bool(update.get("supported")));
            updateValue.put("operation", choice(update.get("operation"), OPERATIONS));
            updateValue.put("checkFailed", bool(update.get("checkFailed")));
            Map<String, Object> snapshot = new LinkedHashMap<>();
            snapshot.put("schemaVersion", 1);
            snapshot.put("kind", "nsh-about-snapshot");
            snapshot.put("mode", "snapshot-only");
            snapshot.put("client", client);
            snapshot.put("host", hostValue);
            snapshot.put("opencode", opencodeValue);
            snapshot.put("hostUpdate", updateValue);
            return snapshot;
        }
    }

    /** In-memory ring only; no defaults/log-file persistence and no recursive redactor. */
    public static final class EventDiagnostics {
        public static final int MAX_ENTRIES = 500;
        public static final int MAX_BYTES = 256 * 1024;
        public static final int MAX_EXPORT_BYTES = 512 * 1024;
        public static final Set<String> TYPES = Set.of(
            "reconnected", "server.connected", "global.disposed", "session.status", "session.idle", "session.error", "session.created", "session.updated", "session.deleted",
            "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
            "session.step.started", "session.step.finished", "session.tool.started", "session.tool.finished",
            "session.step.failed", "session.text.started", "session.text.ended", "session.reasoning.started", "session.reasoning.ended",
            "session.tool.input.started", "session.tool.input.ended", "session.tool.called", "session.tool.success", "session.tool.failed",
            "session.retry.scheduled", "session.inbox.delivered", "session.inbox.cancelled", "session.instructions.updated", "session.metadata.updated", "session.usage.updated",
            "session.revert.staged", "session.revert.committed", "session.revert.cleared",
            "message.updated", "message.removed", "message.part.updated", "message.part.removed",
            "permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected", "form.asked", "form.replied", "form.cancelled",
            "yuri:session-status", "yuri:session-index-changed", "yuri:assistants-changed", "yuri:scheduled-tasks-changed",
            "yuri:contact-turn-start", "yuri:contact-turn-end",
            "yuri:project-order-changed", "yuri:worktree-topology-changed");
        private static final Pattern SESSION = Pattern.compile("^session-(?:0|[1-9][0-9]{0,2})$");
        private static final Set<String> ROW_KEYS = Set.of("at", "feat", "kind", "sessionID", "source", "sseType", "surfaceKind");

        private byte[][] ring = new byte[MAX_ENTRIES][];
        private int head;
        public int count;
        public int bytes;
        public int dropped;
        public boolean enabled;
        public String lease;

        public void setEnabled(boolean next) {
            if (enabled == next) return;
            invalidate();
            enabled = next;
            lease = next ? UUID.randomUUID().toString() : null;
        }

        public void invalidate() {
            ring = new byte[MAX_ENTRIES][];
            head = 0;
            count = 0;
            bytes = 0;
            dropped = 0;
            lease = enabled ? UUID.randomUUID().toString() : null;
        }

        static byte[] project(Object input) {
            if (!(input instanceof Map)) throw new IllegalArgumentException("diagnostics_row");
            Map<?, ?> row = (Map<?, ?>) input;
            Set<String> keys = new HashSet<>();
            for (Object key : row.keySet()) {
                if (!(key instanceof String)) throw new IllegalArgumentException("diagnostics_row");
                keys.add((String) key);
            }
            if (!keys.equals(ROW_KEYS)) throw new IllegalArgumentException("diagnostics_row");
            if (!"transcript".equals(row.get("feat")) || !"sse-event".equals(row.get("kind")) || !"sse".equals(row.get("source"))) {
                throw new IllegalArgumentException("diagnostics_row");
            }
            Object at = row.get("at");
            if (!(at instanceof Number)) throw new IllegalArgumentException("diagnostics_row");
            double time = ((Number) at).doubleValue();
            if (!Double.isFinite(time) || time < 0 || time > 9007199254740991d) throw new IllegalArgumentException("diagnostics_row");
            Object session = row.get("sessionID");
            if (!(session instanceof String) || !SESSION.matcher((String) session).matches()) throw new IllegalArgumentException("diagnostics_row");
            Object type = row.get("sseType");
            if (!(type instanceof String) || !TYPES.contains(type)) throw new IllegalArgumentException("diagnostics_row");
            Object channel = row.get("surfaceKind");
            if (!"global".equals(channel) && !"chat".equals(channel)) throw new IllegalArgumentException("diagnostics_row");
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("at", at);
            value.put("feat", "transcript");
            value.put("kind", "sse-event");
            value.put("source", "sse");
            value.put("sessionID", session);
            value.put("sseType", type);
            value.put("surfaceKind", channel);
            return NativeHandlersJson.stringify(value).getBytes(StandardCharsets.UTF_8);
        }

        public void append(Object input, String expectedLease, int ingressDropped) {
            if (!enabled || !expectedLease.equals(lease) || ingressDropped < 0 || ingressDropped > 1_000_000) {
                throw new IllegalArgumentException("diagnostics_append");
            }
            if (!(input instanceof List)) throw new IllegalArgumentException("diagnostics_append");
            List<?> rows = (List<?>) input;
            if (rows.isEmpty() || rows.size() > 32) throw new IllegalArgumentException("diagnostics_append");
            // Validate the whole batch first, so a bad later row cannot partially commit.
            List<byte[]> data = new ArrayList<>();
            for (Object row : rows) data.add(project(row));
            dropped = (int) Math.min((long) dropped + ingressDropped, Integer.MAX_VALUE);
            for (byte[] item : data) {
                while (count > 0 && (count == MAX_ENTRIES || bytes + item.length > MAX_BYTES)) {
                    bytes -= ring[head] == null ? 0 : ring[head].length;
                    ring[head] = null;
                    head = (head + 1) % MAX_ENTRIES;
                    count--;
                    dropped++;
                }
                if (item.length > MAX_BYTES) {
                    dropped++;
                    continue;
                }
                ring[(head + count) % MAX_ENTRIES] = item;
                count++;
                bytes += item.length;
            }
        }

        byte[] report(Object snapshot, Map<String, Object> info) {
            if (!enabled) throw new IllegalStateException("diagnostics_disabled");
            List<Object> events = new ArrayList<>();
            for (int index = 0; index < count; index++) {
                events.add(NativeHandlersJson.parse(new String(ring[(head + index) % MAX_ENTRIES], StandardCharsets.UTF_8)));
            }
            Map<String, Object> report = new LinkedHashMap<>();
            report.put("schema", "yuri.client-diagnostics.v1");
            report.put("exportedAt", System.currentTimeMillis());
            report.put("feats", count > 0 ? List.of("transcript") : List.of());
            report.put("kind", "nsh-client-diagnostics");
            report.put("mode", "event-recorder");
            report.put("eventCount", count);
            report.put("events", events);
            report.put("dropped", dropped);
            report.put("context", AboutSnapshot.make(snapshot, info));
            report.put("coverage", "runtime-global-and-chat-events-content-free");
            report.put("maxEntries", MAX_ENTRIES);
            report.put("maxBytes", MAX_BYTES);
            byte[] data = NativeHandlersJson.stringify(report).getBytes(StandardCharsets.UTF_8);
            if (data.length > MAX_EXPORT_BYTES) throw new IllegalStateException("diagnostics_export_size");
            return data;
        }
    }

    private static final class PendingExport {
        final HostLease.Scope scope;
        final byte[] data;
        final int eventCount;
        final NshHostReply reply;
        boolean finished;

        PendingExport(HostLease.Scope scope, byte[] data, int eventCount, NshHostReply reply) {
            this.scope = scope;
            this.data = data;
            this.eventCount = eventCount;
            this.reply = reply;
        }
    }

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;
    private final SharedPreferences preferences;
    private final EventDiagnostics recorder = new EventDiagnostics();
    private PendingExport export;

    public DiagnosticsBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
        this.preferences = activity.getSharedPreferences("yuri-nsh", Activity.MODE_PRIVATE);
    }

    @Override
    public void install() {
        recorder.setEnabled(preferences.getBoolean(PREFERENCE, false));
        view.handle("native.clientMetadata", (data, reply) -> reply.resolve(AboutSnapshot.metadata(appInfo())));
        view.handle("native.diagnostics.status", (data, reply) -> reply.resolve(status()));
        view.handle("native.diagnostics.setEnabled", (data, reply) -> {
            try {
                if (!(data instanceof Map)) throw new IllegalArgumentException("diagnostics_invalid");
                Map<?, ?> body = (Map<?, ?>) data;
                if (!body.keySet().equals(Set.of("enabled")) || !(body.get("enabled") instanceof Boolean)) {
                    throw new IllegalArgumentException("diagnostics_invalid");
                }
                synchronized (this) {
                    if (export != null) throw new IllegalStateException("diagnostics_busy");
                }
                boolean enabled = (Boolean) body.get("enabled");
                preferences.edit().putBoolean(PREFERENCE, enabled).apply();
                recorder.setEnabled(enabled);
                reply.resolve(status());
            } catch (RuntimeException error) {
                reply.reject("native_diagnostics_unavailable");
            }
        });
        view.handle("native.diagnostics.append", (data, reply) -> {
            try {
                if (!(data instanceof Map)) throw new IllegalArgumentException("diagnostics_invalid");
                Map<?, ?> body = (Map<?, ?>) data;
                if (!body.keySet().equals(Set.of("hostID", "lease", "events", "dropped"))) {
                    throw new IllegalArgumentException("diagnostics_invalid");
                }
                Object lease = body.get("lease");
                Object dropped = body.get("dropped");
                if (!(lease instanceof String) || !(dropped instanceof Number)) throw new IllegalArgumentException("diagnostics_invalid");
                double value = ((Number) dropped).doubleValue();
                if (!Double.isFinite(value) || value < 0 || value > 1_000_000 || Math.rint(value) != value) {
                    throw new IllegalArgumentException("diagnostics_invalid");
                }
                HostLease captured = leases.capture(null);
                if (!body.get("hostID").equals(captured.scope().hostID) || !captured.isCurrent()) {
                    throw new IllegalArgumentException("diagnostics_invalid");
                }
                recorder.append(body.get("events"), (String) lease, (int) value);
                reply.resolve(Map.of("accepted", true));
            } catch (Exception error) {
                reply.reject("native_diagnostics_unavailable");
            }
        });
        view.handle("native.diagnostics.export", this::export);
    }

    @Override
    public void invalidate() {
        recorder.invalidate();
        PendingExport pending;
        synchronized (this) {
            pending = export;
            export = null;
        }
        if (pending != null) finish(pending, "cancelled");
    }

    @Override
    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_EXPORT) return false;
        PendingExport pending;
        synchronized (this) {
            pending = export;
        }
        if (pending == null) return true;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            finish(pending, "cancelled");
            return true;
        }
        Uri target = data.getData();
        new Thread(() -> {
            try {
                ContentResolver resolver = activity.getContentResolver();
                try (OutputStream output = resolver.openOutputStream(target, "wt")) {
                    if (output == null) throw new IllegalStateException("diagnostics_export");
                    output.write(pending.data);
                }
                finish(pending, "shared");
            } catch (Exception error) {
                Log.w(TAG, "diagnostics export failed", error);
                finish(pending, "failed");
            }
        }, "yuri-diagnostics-export").start();
        return true;
    }

    private Map<String, Object> status() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("schemaVersion", 2);
        value.put("enabled", recorder.enabled);
        value.put("mode", "event-recorder");
        value.put("recordingLease", recorder.lease);
        value.put("eventCount", recorder.count);
        value.put("maxEntries", EventDiagnostics.MAX_ENTRIES);
        value.put("maxBytes", EventDiagnostics.MAX_BYTES);
        return value;
    }

    private void export(Object input, NshHostReply reply) {
        if (invalid()) {
            reply.resolve(Map.of("outcome", "failed"));
            return;
        }
        if (!preferences.getBoolean(PREFERENCE, false)
            || !(input instanceof Map)
            || !((Map<?, ?>) input).keySet().equals(Set.of("hostID", "snapshot"))
            || activity.isFinishing()) {
            reply.resolve(Map.of("outcome", "failed"));
            return;
        }
        Map<?, ?> body = (Map<?, ?>) input;
        HostLease.Scope scope;
        byte[] data;
        try {
            HostLease captured = leases.capture(null);
            scope = captured.scope();
            if (scope.hostID.isEmpty() || !body.get("hostID").equals(scope.hostID) || !captured.isCurrent()) {
                reply.resolve(Map.of("outcome", "cancelled"));
                return;
            }
            data = recorder.report(body.get("snapshot"), appInfo());
        } catch (Exception error) {
            reply.resolve(Map.of("outcome", "cancelled"));
            return;
        }
        PendingExport pending = new PendingExport(scope, data, recorder.count, reply);
        synchronized (this) {
            if (export != null) {
                reply.resolve(Map.of("outcome", "failed"));
                return;
            }
            export = pending;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, FILE_NAME);
        try {
            activity.startActivityForResult(intent, REQUEST_EXPORT);
        } catch (RuntimeException error) {
            finish(pending, "failed");
        }
    }

    private boolean invalid() {
        return activity.isFinishing() || activity.isDestroyed();
    }

    private void finish(PendingExport pending, String outcome) {
        synchronized (this) {
            if (pending.finished) return;
            pending.finished = true;
            if (export == pending) export = null;
        }
        String value = outcome;
        if (!pending.scope.equals(currentScope())) value = "cancelled";
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("outcome", value);
        result.put("eventCount", pending.eventCount);
        NativeHandlers.post(() -> pending.reply.resolve(result));
    }

    private HostLease.Scope currentScope() {
        try {
            return leases.capture(null).scope();
        } catch (Exception error) {
            return null;
        }
    }

    private Map<String, Object> appInfo() {
        Map<String, Object> info = new LinkedHashMap<>();
        try {
            android.content.pm.PackageInfo packageInfo = activity.getPackageManager()
                .getPackageInfo(activity.getPackageName(), 0);
            if (packageInfo.versionName != null) info.put("versionName", packageInfo.versionName);
            info.put("versionCode", Long.toString(packageInfo.getLongVersionCode()));
        } catch (android.content.pm.PackageManager.NameNotFoundException absent) {
            // A missing package record leaves both fields null, as on iOS.
        }
        return info;
    }
}
