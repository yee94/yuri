package com.yee94.yuri.nsh;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Metadata-only receipt journal (iOS AttachmentReceiptJournal.swift). It keeps
 * the exact assistant/upload/request/generation and opaque original
 * connection/transport/authorization/record references, never a credential,
 * URL, user path, source byte or closure. Every write rereads the bounded
 * journal first; a late completion cannot resurrect or erase another
 * operation, and unreadable storage is failure rather than an empty journal.
 */
public final class AttachmentReceiptJournal {
    /** Draft identity and page-operation reference for one contact attachment. */
    public static final class DraftContext {
        private static final Pattern PAGE = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");

        public final String identity;
        public final int revision;
        public final String pageOperation;

        private DraftContext(String identity, int revision, String pageOperation) {
            this.identity = identity;
            this.revision = revision;
            this.pageOperation = pageOperation;
        }

        public static DraftContext of(Map<?, ?> fields) {
            Object identity = fields.get("draftIdentity");
            Object page = fields.get("pageOperation");
            if (!(identity instanceof String) || ((String) identity).isEmpty()
                || ((String) identity).getBytes(StandardCharsets.UTF_8).length > 16384) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            }
            if (!(page instanceof String) || !PAGE.matcher((String) page).matches()) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            }
            int revision = AttachmentUploadPolicy.safeInteger(fields.get("draftRevision"));
            return new DraftContext(AttachmentUploadPolicy.sha256Text((String) identity), revision, (String) page);
        }
    }

    /** One durable receipt row. */
    public static final class Record {
        private static final Pattern ID = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
        private static final Pattern DRAFT = Pattern.compile("^[a-f0-9]{64}$");
        private static final Set<String> KEYS = new HashSet<>(Set.of("requestID", "uploadID", "assistantID",
            "connectionID", "transportID", "authorizationID", "connectionVersion", "generation", "draftID",
            "draftRevision", "pageOperation", "phase", "descriptor"));

        public final String requestID;
        public final String uploadID;
        public final String assistantID;
        public final String connectionID;
        public final String transportID;
        public final String authorizationID;
        public final String connectionVersion;
        public final int generation;
        public final String draftID;
        public final int draftRevision;
        public final String pageOperation;
        public String phase;
        public Map<String, Object> descriptor;

        public Record(String requestID, String uploadID, String assistantID, String connectionID, String transportID,
                      String authorizationID, String connectionVersion, int generation, String draftID, int draftRevision,
                      String pageOperation, String phase, Map<String, Object> descriptor) {
            this.requestID = require(requestID, ID, AttachmentUploadPolicy.Failure.INVALID);
            this.uploadID = require(uploadID, ID, AttachmentUploadPolicy.Failure.INVALID);
            this.assistantID = assistant(assistantID);
            this.connectionID = require(connectionID, ID, AttachmentUploadPolicy.Failure.INVALID);
            this.transportID = require(transportID, ID, AttachmentUploadPolicy.Failure.INVALID);
            this.authorizationID = require(authorizationID, ID, AttachmentUploadPolicy.Failure.INVALID);
            if ("legacy".equals(this.authorizationID)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            this.connectionVersion = require(connectionVersion, ID, AttachmentUploadPolicy.Failure.INVALID);
            if ("legacy".equals(this.connectionVersion)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            this.generation = AttachmentUploadPolicy.safeInteger(generation);
            this.draftID = require(draftID, DRAFT, AttachmentUploadPolicy.Failure.INVALID);
            this.draftRevision = AttachmentUploadPolicy.safeInteger(draftRevision);
            this.pageOperation = require(pageOperation, ID, AttachmentUploadPolicy.Failure.INVALID);
            if (!Set.of("prepared", "unknown", "retiring", "retired").contains(phase)) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            }
            this.phase = phase;
            this.descriptor = descriptor;
            // Restore through the same typed descriptor owner, never a lossy copy.
            AttachmentUploadPolicy.restoring(this.assistantID, this.uploadID, this.generation, descriptor, phase);
        }

        static String assistant(String value) {
            if (value == null || value.isEmpty() || value.getBytes(StandardCharsets.UTF_8).length > 256) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            }
            for (int index = 0; index < value.length(); index++) {
                char character = value.charAt(index);
                if (character < 0x20 || character == 0x7f) {
                    throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
                }
            }
            return value;
        }

        private static String require(String value, Pattern pattern, String code) {
            if (value == null || !pattern.matcher(value).matches()) throw new AttachmentUploadPolicy.Failure(code);
            return value;
        }

        @SuppressWarnings("unchecked")
        static Record from(Object raw) {
            if (!(raw instanceof Map)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            Map<?, ?> value = (Map<?, ?>) raw;
            Set<String> keys = new HashSet<>();
            for (Object key : value.keySet()) {
                if (!(key instanceof String)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
                keys.add((String) key);
            }
            if (!keys.equals(KEYS)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            Object descriptor = value.get("descriptor");
            if (descriptor != null && !(descriptor instanceof Map)) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            }
            Object phase = value.get("phase");
            if (!(phase instanceof String)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            try {
                return new Record((String) value.get("requestID"), (String) value.get("uploadID"),
                    (String) value.get("assistantID"), (String) value.get("connectionID"), (String) value.get("transportID"),
                    (String) value.get("authorizationID"), (String) value.get("connectionVersion"),
                    AttachmentUploadPolicy.safeInteger(value.get("generation")),
                    (String) value.get("draftID"), AttachmentUploadPolicy.safeInteger(value.get("draftRevision")),
                    (String) value.get("pageOperation"), (String) phase,
                    descriptor == null ? null : (Map<String, Object>) descriptor);
            } catch (ClassCastException error) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            } catch (AttachmentUploadPolicy.Failure failure) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            }
        }

        public boolean sameUpload(Record other) {
            return assistantID.equals(other.assistantID) && uploadID.equals(other.uploadID);
        }

        public Map<String, Object> json() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("requestID", requestID);
            value.put("uploadID", uploadID);
            value.put("assistantID", assistantID);
            value.put("connectionID", connectionID);
            value.put("transportID", transportID);
            value.put("authorizationID", authorizationID);
            value.put("connectionVersion", connectionVersion);
            value.put("generation", generation);
            value.put("draftID", draftID);
            value.put("draftRevision", draftRevision);
            value.put("pageOperation", pageOperation);
            value.put("phase", phase);
            value.put("descriptor", descriptor);
            return value;
        }

        /** The read-only projection a freshly opened JS page may see. */
        public Map<String, Object> publicValue() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("requestId", requestID);
            value.put("uploadID", uploadID);
            value.put("assistantID", assistantID);
            value.put("generation", generation);
            value.put("draftRevision", draftRevision);
            value.put("phase", phase);
            return value;
        }
    }

    public interface Load {
        byte[] load() throws Exception;
    }

    public interface Save {
        void save(byte[] bytes) throws Exception;
    }

    private static final int MAX_RECORDS = 64;
    private static final int MAX_BYTES = 262144;

    private final Load load;
    private final Save save;

    public AttachmentReceiptJournal(File directory) {
        File file = new File(directory, "native-contact-upload-receipts-v1.json");
        this.load = () -> {
            if (!file.isFile()) return null;
            try (InputStream input = new FileInputStream(file)) {
                byte[] bytes = new byte[(int) file.length()];
                int read = 0;
                while (read < bytes.length) {
                    int step = input.read(bytes, read, bytes.length - read);
                    if (step < 0) break;
                    read += step;
                }
                return read == bytes.length ? bytes : java.util.Arrays.copyOf(bytes, read);
            }
        };
        this.save = (bytes) -> {
            File parent = file.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("receipt_directory");
            File temporary = new File(parent, file.getName() + ".tmp");
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes);
                output.getFD().sync();
            }
            if (!temporary.renameTo(file)) {
                if (!file.delete() || !temporary.renameTo(file)) throw new IOException("receipt_replace");
            }
        };
    }

    public AttachmentReceiptJournal(Load load, Save save) {
        this.load = load;
        this.save = save;
    }

    public List<Record> records() {
        try {
            byte[] bytes = load.load();
            if (bytes == null) return new ArrayList<>();
            if (bytes.length > MAX_BYTES) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            Object root = NativeHandlersJson.parse(new String(bytes, StandardCharsets.UTF_8));
            if (!(root instanceof Map)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            Map<?, ?> value = (Map<?, ?>) root;
            if (!value.keySet().equals(Set.of("version", "receipts"))) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            }
            if (AttachmentUploadPolicy.safeInteger(value.get("version")) != 1) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            }
            if (!(value.get("receipts") instanceof List)) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            }
            List<?> rows = (List<?>) value.get("receipts");
            if (rows.size() > MAX_RECORDS) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
            List<Record> result = new ArrayList<>();
            Set<String> requests = new HashSet<>();
            Set<String> uploads = new HashSet<>();
            for (Object row : rows) {
                Record record = Record.from(row);
                if (!requests.add(record.requestID)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
                if (!uploads.add(record.assistantID + "\n" + record.uploadID)) {
                    throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
                }
                result.add(record);
            }
            return result;
        } catch (Exception error) {
            throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
        }
    }

    private void write(List<Record> rows) {
        try {
            List<Object> receipts = new ArrayList<>();
            for (Record record : rows) receipts.add(record.json());
            Map<String, Object> root = new LinkedHashMap<>();
            root.put("version", 1);
            root.put("receipts", receipts);
            byte[] bytes = NativeHandlersJson.stringify(root).getBytes(StandardCharsets.UTF_8);
            if (rows.size() > MAX_RECORDS || bytes.length > MAX_BYTES) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.CAPACITY);
            }
            save.save(bytes);
        } catch (AttachmentUploadPolicy.Failure failure) {
            throw failure;
        } catch (Exception error) {
            throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
        }
    }

    public void insert(Record record) {
        List<Record> rows = records();
        if (rows.size() >= MAX_RECORDS) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.CAPACITY);
        for (Record row : rows) {
            if (row.requestID.equals(record.requestID) || row.sameUpload(record)) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            }
        }
        rows.add(record);
        write(rows);
    }

    public void update(String requestID, String uploadID, String phase, Map<String, Object> descriptor) {
        List<Record> rows = records();
        int index = -1;
        for (int at = 0; at < rows.size(); at++) {
            Record row = rows.get(at);
            if (row.requestID.equals(requestID) && row.uploadID.equals(uploadID)) {
                index = at;
                break;
            }
        }
        if (index < 0) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.STORAGE);
        Record row = rows.get(index);
        // An ACK arriving after retirement can retain identity, never undo its fence.
        if ((!row.phase.equals("retired") && !row.phase.equals("retiring")) || "retired".equals(phase)) row.phase = phase;
        if (descriptor != null) row.descriptor = descriptor;
        rows.set(index, Record.from(row.json()));
        write(rows);
    }

    public void remove(String requestID, String uploadID) {
        List<Record> rows = records();
        int index = -1;
        for (int at = 0; at < rows.size(); at++) {
            if (rows.get(at).requestID.equals(requestID)) {
                index = at;
                break;
            }
        }
        if (index < 0) return;
        if (!rows.get(index).uploadID.equals(uploadID)) {
            throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        }
        rows.remove(index);
        write(rows);
    }
}
