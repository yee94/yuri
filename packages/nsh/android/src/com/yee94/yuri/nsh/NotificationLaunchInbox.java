package com.yee94.yuri.nsh;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Durable, app-private route receipts: no notification text, URLs, transport leases or credentials.
 * A tap is committed before the OS callback returns, and a missing JS Host is not a rejection.
 * The Android file lives in the app's private files directory (no iOS file protection class exists).
 */
public final class NotificationLaunchInbox {
    public static final String PREFIX = "yuri.nsh.local.";
    private static final long TTL_MILLIS = 7L * 24 * 60 * 60 * 1000;
    private static final int LIMIT = 256;
    private static final long MAX_BYTES = 8L * 1024 * 1024;

    public static final class Retirement {
        public final String connectionID;
        public final String authorizationID;
        public final String receipt;

        Retirement(String connectionID, String authorizationID, String receipt) {
            this.connectionID = connectionID;
            this.authorizationID = authorizationID;
            this.receipt = receipt;
        }

        Map<String, Object> value() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("connectionID", connectionID);
            out.put("authorizationID", authorizationID);
            out.put("receipt", receipt);
            return out;
        }
    }

    public static final class RetirementBatch {
        public final String connectionID;
        public final String authorizationID;
        public final List<String> receipts;

        RetirementBatch(String connectionID, String authorizationID, List<String> receipts) {
            this.connectionID = connectionID;
            this.authorizationID = authorizationID;
            this.receipts = Collections.unmodifiableList(new ArrayList<>(receipts));
        }

        public List<String> identifiers() {
            List<String> out = new ArrayList<>(receipts.size());
            for (String receipt : receipts) out.add(PREFIX + receipt);
            return out;
        }
    }

    public static final class Record {
        public final String receipt;
        public final int revision;
        public final String connectionID;
        public final String authorizationID;
        public final NotificationAdmission admission;
        public final double createdAt;
        public final double expiresAt;

        Record(String receipt, int revision, String connectionID, String authorizationID,
               NotificationAdmission admission, double createdAt, double expiresAt) {
            this.receipt = receipt;
            this.revision = revision;
            this.connectionID = connectionID;
            this.authorizationID = authorizationID;
            this.admission = admission;
            this.createdAt = createdAt;
            this.expiresAt = expiresAt;
        }

        public NotificationTarget target() { return admission.target; }

        public Map<String, Object> value() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("v", 1L);
            out.put("receipt", receipt);
            out.put("revision", (long) revision);
            out.put("connectionID", connectionID);
            out.put("authorizationID", authorizationID);
            out.put("admission", admission.value());
            out.put("createdAt", createdAt);
            out.put("expiresAt", expiresAt);
            return out;
        }

        public boolean unexpired(double now) {
            return !Double.isNaN(now) && !Double.isInfinite(now) && createdAt <= now && expiresAt > now;
        }
    }

    private final File file;
    private List<Record> records = new ArrayList<>();
    private String queuedReceipt;
    private List<Retirement> pendingRetirements = new ArrayList<>();

    public NotificationLaunchInbox(File file) throws NotificationFailure {
        this.file = file;
        if (!file.exists()) return;
        String text;
        try {
            if (Files.size(file.toPath()) > MAX_BYTES) throw NotificationFailure.invalid();
            text = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw NotificationFailure.unavailable();
        }
        Object decoded = NotificationJson.parse(text);
        Map<String, Object> raw = NotificationJson.map(decoded);
        if (raw == null) throw NotificationFailure.invalid();
        Map<String, Object> root = NotificationPolicy.object(decoded, raw.containsKey("pendingRetirements")
                ? new String[] {"v", "records", "queuedReceipt", "pendingRetirements"}
                : new String[] {"v", "records", "queuedReceipt"});
        Object version = root.get("v");
        if (!(version instanceof Number) || version instanceof Boolean || ((Number) version).doubleValue() != 1d) {
            throw NotificationFailure.invalid();
        }
        if (!(root.get("records") instanceof List)) throw NotificationFailure.invalid();
        List<?> rows = (List<?>) root.get("records");
        if (rows.size() > LIMIT) throw NotificationFailure.invalid();
        Set<String> seen = new HashSet<>();
        List<Record> parsed = new ArrayList<>(rows.size());
        for (Object row : rows) {
            Map<String, Object> value = NotificationPolicy.object(row,
                    "v", "receipt", "revision", "connectionID", "authorizationID", "admission", "createdAt", "expiresAt");
            Object rowVersion = value.get("v");
            Object receipt = value.get("receipt");
            Object connectionID = value.get("connectionID");
            Object authorizationID = value.get("authorizationID");
            if (!(rowVersion instanceof Number) || rowVersion instanceof Boolean || ((Number) rowVersion).doubleValue() != 1d
                    || !(receipt instanceof String) || !NotificationPolicy.uuid((String) receipt) || !seen.add((String) receipt)
                    || !(connectionID instanceof String) || !NotificationPolicy.identifier((String) connectionID)
                    || !(authorizationID instanceof String) || !NotificationPolicy.identifier((String) authorizationID)
                    || "legacy".equals(authorizationID)) throw NotificationFailure.invalid();
            double createdAt = finite(value.get("createdAt"));
            double expiresAt = finite(value.get("expiresAt"));
            if (createdAt < 0 || expiresAt <= createdAt || expiresAt - createdAt > TTL_MILLIS) throw NotificationFailure.invalid();
            parsed.add(new Record((String) receipt, NotificationPolicy.positiveInteger(value.get("revision")),
                    (String) connectionID, (String) authorizationID,
                    NotificationAdmission.parse(value.get("admission")), createdAt, expiresAt));
        }
        records = parsed;
        Object queued = root.get("queuedReceipt");
        if (queued != null) {
            if (!(queued instanceof String) || !contains(parsed, (String) queued)) throw NotificationFailure.invalid();
            queuedReceipt = (String) queued;
        }
        if (root.containsKey("pendingRetirements")) {
            if (!(root.get("pendingRetirements") instanceof List)) throw NotificationFailure.invalid();
            List<?> retired = (List<?>) root.get("pendingRetirements");
            if (retired.size() + records.size() > LIMIT) throw NotificationFailure.invalid();
            List<Retirement> pending = new ArrayList<>(retired.size());
            for (Object row : retired) {
                Map<String, Object> value = NotificationPolicy.object(row, "connectionID", "authorizationID", "receipt");
                Object connectionID = value.get("connectionID");
                Object authorizationID = value.get("authorizationID");
                Object receipt = value.get("receipt");
                if (!(connectionID instanceof String) || !NotificationPolicy.identifier((String) connectionID)
                        || !(authorizationID instanceof String) || !NotificationPolicy.identifier((String) authorizationID)
                        || "legacy".equals(authorizationID)
                        || !(receipt instanceof String) || !NotificationPolicy.uuid((String) receipt)
                        || !seen.add((String) receipt)) throw NotificationFailure.invalid();
                pending.add(new Retirement((String) connectionID, (String) authorizationID, (String) receipt));
            }
            pendingRetirements = pending;
        }
    }

    public List<Record> records() { return Collections.unmodifiableList(records); }
    public String queuedReceipt() { return queuedReceipt; }
    public List<Retirement> pendingRetirements() { return Collections.unmodifiableList(pendingRetirements); }

    public Record pending() {
        if (queuedReceipt == null) return null;
        for (Record record : records) if (record.receipt.equals(queuedReceipt)) return record;
        return null;
    }

    private static double finite(Object value) throws NotificationFailure {
        if (!(value instanceof Number) || value instanceof Boolean) throw NotificationFailure.invalid();
        double raw = ((Number) value).doubleValue();
        if (Double.isNaN(raw) || Double.isInfinite(raw)) throw NotificationFailure.invalid();
        return raw;
    }

    private static boolean contains(List<Record> rows, String receipt) {
        for (Record record : rows) if (record.receipt.equals(receipt)) return true;
        return false;
    }

    private void commit(List<Record> next, String queued, List<Retirement> retirements) throws NotificationFailure {
        List<Retirement> retired = retirements == null ? pendingRetirements : retirements;
        if (next.size() + retired.size() > LIMIT) throw NotificationFailure.unavailable();
        List<Object> recordValues = new ArrayList<>(next.size());
        for (Record record : next) recordValues.add(record.value());
        List<Object> retiredValues = new ArrayList<>(retired.size());
        for (Retirement retirement : retired) retiredValues.add(retirement.value());
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("v", 1L);
        root.put("records", recordValues);
        root.put("queuedReceipt", queued);
        root.put("pendingRetirements", retiredValues);
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw NotificationFailure.unavailable();
        }
        File temporary = new File(parent == null ? file.getAbsolutePath() + ".tmp"
                : new File(parent, file.getName() + ".tmp").getPath());
        try {
            FileOutputStream stream = new FileOutputStream(temporary);
            try {
                stream.write(NotificationJson.stringify(root).getBytes(StandardCharsets.UTF_8));
                stream.getFD().sync();
            } finally {
                stream.close();
            }
            try {
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomic) {
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException error) {
            temporary.delete();
            throw NotificationFailure.unavailable();
        }
        // Failed persistence must never become an acknowledged or consumed tap.
        records = new ArrayList<>(next);
        queuedReceipt = queued;
        pendingRetirements = new ArrayList<>(retired);
    }

    public void record(String receipt, String hostID, String authorizationID, NotificationAdmission admission)
            throws NotificationFailure {
        record(receipt, hostID, authorizationID, admission, System.currentTimeMillis());
    }

    public void record(String receipt, String hostID, String authorizationID, NotificationAdmission admission, long now)
            throws NotificationFailure {
        if (!NotificationPolicy.uuid(receipt) || !NotificationPolicy.identifier(hostID)
                || !NotificationPolicy.identifier(authorizationID) || "legacy".equals(authorizationID) || now < 0) {
            throw NotificationFailure.invalid();
        }
        for (Record record : records) {
            if (record.receipt.equals(receipt)) throw NotificationFailure.invalid();
        }
        for (Retirement retirement : pendingRetirements) {
            if (retirement.receipt.equals(receipt)
                    || (retirement.connectionID.equals(hostID) && retirement.authorizationID.equals(authorizationID))) {
                throw NotificationFailure.invalid();
            }
        }
        List<Record> next = new ArrayList<>(records);
        if (next.size() + pendingRetirements.size() == LIMIT) {
            int index = -1;
            for (int cursor = 0; cursor < next.size(); cursor++) {
                if (queuedReceipt == null || !next.get(cursor).receipt.equals(queuedReceipt)) { index = cursor; break; }
            }
            if (index < 0) throw NotificationFailure.unavailable();
            next.remove(index);
        }
        next.add(new Record(receipt, 1, hostID, authorizationID, admission, now, now + TTL_MILLIS));
        commit(next, queuedReceipt, null);
    }

    /** Returns true when this OS tap names a protected record; a duplicate report of one tap is idempotent. */
    public boolean receive(String action, String identifier, Map<?, ?> payload) throws NotificationFailure {
        String receipt = NotificationPolicy.receipt(payload);
        if (!"default".equals(action) || receipt == null || !identifier.equals(PREFIX + receipt)
                || !contains(records, receipt)) return false;
        if (receipt.equals(queuedReceipt)) return true;
        commit(records, receipt, null);
        return true;
    }

    public void remove(String receipt, boolean includingQueued) throws NotificationFailure {
        if (receipt.equals(queuedReceipt) && !includingQueued) return;
        List<Record> next = new ArrayList<>(records.size());
        for (Record record : records) if (!record.receipt.equals(receipt)) next.add(record);
        commit(next, receipt.equals(queuedReceipt) ? null : queuedReceipt, null);
    }

    public Record claim(String receipt, String hostID, String authorizationID, long now) throws NotificationFailure {
        Record pending = pending();
        if (pending == null || !pending.receipt.equals(receipt) || !pending.connectionID.equals(hostID)
                || !Objects.equals(pending.authorizationID, authorizationID) || !pending.unexpired(now)) {
            throw NotificationFailure.stale();
        }
        return pending;
    }

    public void consume(String receipt, int expectedRevision, String hostID, String authorizationID) throws NotificationFailure {
        Record record = claim(receipt, hostID, authorizationID, System.currentTimeMillis());
        if (record.revision != expectedRevision) throw NotificationFailure.stale();
        remove(receipt, true);
    }

    /** Only an explicit authorization revocation calls this; transient transport generations never do. */
    public List<String> retireAuthorization(String connectionID, String authorizationID) throws NotificationFailure {
        List<String> newlyRetired = new ArrayList<>();
        for (Record record : records) {
            if (record.connectionID.equals(connectionID) && record.authorizationID.equals(authorizationID)) {
                newlyRetired.add(record.receipt);
            }
        }
        beginRetirement(connectionID, authorizationID);
        return newlyRetired;
    }

    public RetirementBatch beginRetirement(String connectionID, String authorizationID) throws NotificationFailure {
        if (!NotificationPolicy.identifier(connectionID) || !NotificationPolicy.identifier(authorizationID)
                || "legacy".equals(authorizationID)) throw NotificationFailure.invalid();
        List<Record> removed = new ArrayList<>();
        for (Record record : records) {
            if (record.connectionID.equals(connectionID) && record.authorizationID.equals(authorizationID)) removed.add(record);
        }
        if (!removed.isEmpty()) {
            Set<String> receipts = new HashSet<>();
            List<Record> next = new ArrayList<>(records.size());
            for (Record record : removed) receipts.add(record.receipt);
            for (Record record : records) if (!receipts.contains(record.receipt)) next.add(record);
            List<Retirement> retired = new ArrayList<>(pendingRetirements);
            for (Record record : removed) retired.add(new Retirement(connectionID, authorizationID, record.receipt));
            commit(next, receipts.contains(queuedReceipt) ? null : queuedReceipt, retired);
        }
        List<String> batch = new ArrayList<>();
        for (Retirement retirement : pendingRetirements) {
            if (retirement.connectionID.equals(connectionID) && retirement.authorizationID.equals(authorizationID)) {
                batch.add(retirement.receipt);
            }
        }
        return new RetirementBatch(connectionID, authorizationID, batch);
    }

    public void acknowledgeRetirement(RetirementBatch batch) throws NotificationFailure {
        if (!NotificationPolicy.identifier(batch.connectionID) || !NotificationPolicy.identifier(batch.authorizationID)
                || "legacy".equals(batch.authorizationID)) throw NotificationFailure.invalid();
        Set<String> receipts = new HashSet<>();
        for (String receipt : batch.receipts) {
            if (!NotificationPolicy.uuid(receipt) || !receipts.add(receipt)) throw NotificationFailure.invalid();
        }
        List<Retirement> next = new ArrayList<>(pendingRetirements.size());
        for (Retirement retirement : pendingRetirements) {
            boolean drop = retirement.connectionID.equals(batch.connectionID)
                    && retirement.authorizationID.equals(batch.authorizationID) && receipts.contains(retirement.receipt);
            if (!drop) next.add(retirement);
        }
        if (next.size() != pendingRetirements.size()) commit(records, queuedReceipt, next);
    }

    /** One bounded cleanup attempt; a void OS remove call is never its completion evidence. */
    public static void runRetirementCleanup(NotificationLaunchInbox inbox, String connectionID, String authorizationID,
                                            Consumer<List<String>> settleAdds, Consumer<List<String>> remove,
                                            Supplier<List<String>> pending, Supplier<List<String>> delivered)
            throws NotificationFailure {
        RetirementBatch batch = inbox.beginRetirement(connectionID, authorizationID);
        if (batch.receipts.isEmpty()) return;
        settleAdds.accept(batch.receipts);
        if (Thread.currentThread().isInterrupted()) throw NotificationFailure.stale();
        remove.accept(batch.identifiers());
        Set<String> targets = new HashSet<>(batch.identifiers());
        for (String identifier : pending.get()) if (targets.contains(identifier)) throw NotificationFailure.unavailable();
        for (String identifier : delivered.get()) if (targets.contains(identifier)) throw NotificationFailure.unavailable();
        if (Thread.currentThread().isInterrupted()) throw NotificationFailure.stale();
        inbox.acknowledgeRetirement(batch);
    }

    /** The add/late-result lane: a failed or stale add removes exactly its own record and OS notification. */
    public static void submitDelivery(NotificationLaunchInbox inbox, String receipt, BooleanSupplier current,
                                      Add add, Runnable removeOS) throws NotificationFailure {
        if (!current.getAsBoolean()) {
            discard(inbox, receipt, removeOS);
            throw NotificationFailure.stale();
        }
        try {
            add.run();
        } catch (Exception error) {
            discard(inbox, receipt, removeOS);
            throw NotificationFailure.unavailable();
        }
        if (!current.getAsBoolean()) {
            discard(inbox, receipt, removeOS);
            throw NotificationFailure.stale();
        }
    }

    public interface Add { void run() throws Exception; }

    private static void discard(NotificationLaunchInbox inbox, String receipt, Runnable removeOS) {
        if (inbox != null) {
            try {
                inbox.remove(receipt, true);
            } catch (NotificationFailure ignored) {
                // A failed disk cleanup must not turn into a claimed consumption.
            }
        }
        removeOS.run();
    }
}
