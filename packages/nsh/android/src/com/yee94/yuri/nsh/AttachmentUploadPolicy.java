package com.yee94.yuri.nsh;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/**
 * One selection, one PUT (iOS AttachmentUploadPolicy.swift). An ambiguous
 * result keeps this exact receipt until an authoritative GET reconciliation or
 * a durable exact retirement succeeds. No byte buffer or credential crosses
 * the TSX bridge.
 */
public final class AttachmentUploadPolicy {
    /** Explicit failure codes, identical to the iOS raw values. */
    public static final class Failure extends RuntimeException {
        public final String code;

        public Failure(String code) {
            super(code, null, false, false);
            this.code = code;
        }

        public static final String INVALID = "attachment_upload_invalid";
        public static final String UNKNOWN = "attachment_upload_unknown";
        public static final String RETIRED = "attachment_upload_retired";
        public static final String CAPACITY = "attachment_upload_pending_capacity";
        public static final String STORAGE = "attachment_receipt_storage_failed";
        public static final String AUTHORIZATION_UNAVAILABLE = "attachment_original_authorization_unavailable";
        public static final String NOT_DISPATCHED = "attachment_upload_not_dispatched";
        public static final String GENERATION_CONFLICT = "attachment_contact_generation_conflict";
    }

    public static final class Request {
        public final String path;
        public final byte[] data;
        public final Map<String, String> headers;
        public final String method;

        public Request(String path) {
            this(path, new byte[0], new LinkedHashMap<>(), "GET");
        }

        public Request(String path, byte[] data, Map<String, String> headers, String method) {
            this.path = path;
            this.data = data == null ? new byte[0] : data;
            this.headers = headers == null ? new LinkedHashMap<>() : headers;
            this.method = method;
        }
    }

    public static final class Response {
        public final int status;
        public final Object body;

        public Response(int status, Object body) {
            this.status = status;
            this.body = body;
        }
    }

    public interface Send {
        Response send(Request request) throws Exception;
    }

    public interface Persist {
        void persist(String phase, Map<String, Object> descriptor) throws Exception;
    }

    private static final Pattern UPLOAD_ID = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");
    private static final Pattern HASH = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern MIME = Pattern.compile("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$");
    private static final Set<String> DESCRIPTOR_KEYS = new HashSet<>(Arrays.asList(
        "type", "attachmentID", "sha256", "size", "mime", "filename", "generation"));
    private static final char[] COMPONENT =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()".toCharArray();

    public final String assistantID;
    public final String uploadID;
    private Integer generation;
    private Map<String, Object> descriptor;
    private boolean attempted;
    private boolean retired;
    private boolean retiring;
    private boolean recoveryOnly;
    private Persist persist;
    private Expected expected;

    private static final class Expected {
        final String hash;
        final int size;
        final String mime;
        final String name;

        Expected(String hash, int size, String mime, String name) {
            this.hash = hash;
            this.size = size;
            this.mime = mime;
            this.name = name;
        }
    }

    public static final class Receipt {
        public final String state;
        public final int current;
        public final Map<String, Object> descriptor;

        Receipt(String state, int current, Map<String, Object> descriptor) {
            this.state = state;
            this.current = current;
            this.descriptor = descriptor;
        }
    }

    public AttachmentUploadPolicy(String assistantID) {
        this(assistantID, newUploadID());
    }

    public AttachmentUploadPolicy(String assistantID, String uploadID) {
        if (assistantID == null || assistantID.isEmpty() || utf8(assistantID).length > 256 || hasControl(assistantID)) {
            throw new Failure(Failure.INVALID);
        }
        if (uploadID == null || !UPLOAD_ID.matcher(uploadID).matches()) throw new Failure(Failure.INVALID);
        this.assistantID = assistantID;
        this.uploadID = uploadID;
    }

    /** Restores only the exact typed receipt a journal record names. */
    public static AttachmentUploadPolicy restoring(String assistantID, String uploadID, Object generation,
                                                   Map<String, Object> descriptor, String phase) {
        AttachmentUploadPolicy policy = new AttachmentUploadPolicy(assistantID, uploadID);
        policy.generation = safeInteger(generation);
        if (descriptor != null) policy.descriptor = policy.parseDescriptor(descriptor);
        policy.attempted = true;
        policy.recoveryOnly = true;
        policy.retiring = "retiring".equals(phase);
        policy.retired = "retired".equals(phase);
        return policy;
    }

    public static String newUploadID() {
        return java.util.UUID.randomUUID().toString().toLowerCase(java.util.Locale.ROOT);
    }

    public static int safeInteger(Object value) {
        if (!(value instanceof Number)) throw new Failure(Failure.INVALID);
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < 0 || number > 9007199254740991d) throw new Failure(Failure.INVALID);
        if (Math.floor(number) != number) throw new Failure(Failure.INVALID);
        return (int) number;
    }

    public void persistWith(Persist value) {
        this.persist = value;
    }

    public Integer generation() {
        return generation;
    }

    public Map<String, Object> descriptor() {
        return descriptor;
    }

    public boolean attempted() {
        return attempted;
    }

    public boolean retired() {
        return retired;
    }

    public boolean retiring() {
        return retiring;
    }

    private String base() {
        return "/api/yuri/assistants/" + encode(assistantID) + "/contact";
    }

    private String receiptPath() {
        return base() + "/attachments/uploads/" + uploadID;
    }

    /** Requires explicit Host protocol support before a picker becomes visible. */
    public void prepare(Integer expectedGeneration, BooleanSupplier current, Send send) throws Exception {
        if (generation != null || !current.getAsBoolean() || retiring) throw new Failure(Failure.INVALID);
        Response response = send.send(new Request(base() + "/messages?limit=1"));
        if (response.status != 200 || !(response.body instanceof Map) || !current.getAsBoolean()) {
            throw new Failure(Failure.INVALID);
        }
        Map<?, ?> body = (Map<?, ?>) response.body;
        generation = safeInteger(body.get("generation"));
        if (expectedGeneration != null && !expectedGeneration.equals(generation)) throw new Failure(Failure.INVALID);
        Receipt receipt = read(send);
        if (!"not_found".equals(receipt.state) || receipt.current != generation || !current.getAsBoolean() || retiring) {
            throw new Failure(Failure.INVALID);
        }
    }

    private Map<String, Object> parseDescriptor(Object raw) {
        if (!(raw instanceof Map)) throw new Failure(Failure.INVALID);
        Map<?, ?> body = (Map<?, ?>) raw;
        Set<String> keys = new HashSet<>();
        for (Object key : body.keySet()) {
            if (!(key instanceof String) || !DESCRIPTOR_KEYS.contains(key)) throw new Failure(Failure.INVALID);
            keys.add((String) key);
        }
        if (!"file".equals(body.get("type"))) throw new Failure(Failure.INVALID);
        Object id = body.get("attachmentID");
        if (!(id instanceof String) || !UPLOAD_ID.matcher((String) id).matches()) throw new Failure(Failure.INVALID);
        Object hash = body.get("sha256");
        if (!(hash instanceof String) || !HASH.matcher((String) hash).matches()) throw new Failure(Failure.INVALID);
        Object mime = body.get("mime");
        if (!(mime instanceof String) || !MIME.matcher((String) mime).matches()) throw new Failure(Failure.INVALID);
        if (generation == null || safeInteger(body.get("generation")) != generation) throw new Failure(Failure.INVALID);
        int size = safeInteger(body.get("size"));
        if (size <= 0 || size > 25 * 1024 * 1024) throw new Failure(Failure.INVALID);
        if (body.containsKey("filename")) {
            Object name = body.get("filename");
            if (!(name instanceof String) || !validName((String) name)) throw new Failure(Failure.INVALID);
        }
        if (expected != null) {
            Object name = body.get("filename");
            if (!hash.equals(expected.hash) || size != expected.size || !mime.equals(expected.mime)
                || (name != null && !name.equals(expected.name))) {
                throw new Failure(Failure.INVALID);
            }
        }
        if (descriptor != null && !descriptor.equals(asObjects(body))) throw new Failure(Failure.INVALID);
        return asObjects(body);
    }

    private static Map<String, Object> asObjects(Map<?, ?> body) {
        Map<String, Object> value = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : body.entrySet()) value.put((String) entry.getKey(), entry.getValue());
        return value;
    }

    private static boolean validName(String name) {
        if (name.isEmpty() || utf8(name).length > 1024) return false;
        if (name.length() > 512) return false;
        if (!name.equals(name.trim())) return false;
        if (name.contains("/") || name.contains("\\") || name.contains("..")) return false;
        return !hasControl(name);
    }

    private Receipt receipt(int status, Object raw, boolean deletion) throws Exception {
        if (!(raw instanceof Map)) throw new Failure(Failure.INVALID);
        Map<?, ?> body = (Map<?, ?>) raw;
        if (!assistantID.equals(body.get("assistantID"))) throw new Failure(Failure.INVALID);
        if (!uploadID.equals(body.get("uploadID"))) throw new Failure(Failure.INVALID);
        if (generation == null || safeInteger(body.get("generation")) != generation) throw new Failure(Failure.INVALID);
        Object stateValue = body.get("state");
        if (!(stateValue instanceof String)) throw new Failure(Failure.INVALID);
        String state = (String) stateValue;
        boolean known = (status == 404 && "not_found".equals(state))
            || (status == 200 && ("inflight".equals(state) || "committed".equals(state) || "retired".equals(state)));
        if (!known || !body.containsKey("descriptor")) throw new Failure(Failure.INVALID);
        int now = safeInteger(body.get("currentGeneration"));
        if (now < generation) throw new Failure(Failure.INVALID);
        Object rawDescriptor = body.get("descriptor");
        Map<String, Object> parsed = rawDescriptor == null ? null : parseDescriptor(rawDescriptor);
        if ("committed".equals(state) && parsed == null) throw new Failure(Failure.INVALID);
        if (("not_found".equals(state) || "inflight".equals(state)) && parsed != null) throw new Failure(Failure.INVALID);
        if (descriptor != null && parsed == null) throw new Failure(Failure.INVALID);
        if (deletion) {
            if (status != 200 || !"retired".equals(state)) throw new Failure(Failure.INVALID);
            if (!Boolean.FALSE.equals(body.get("newAdmissionAllowed"))) throw new Failure(Failure.INVALID);
            if (!Boolean.FALSE.equals(body.get("bytesDeleted"))) throw new Failure(Failure.INVALID);
            if (!Boolean.valueOf(parsed != null).equals(body.get("ownershipRetained"))) throw new Failure(Failure.INVALID);
        }
        if (parsed != null) descriptor = parsed;
        String phase = "retired".equals(state) ? "retired" : retiring ? "retiring" : "unknown";
        if (persist != null) persist.persist(phase, descriptor);
        if ("retired".equals(state)) retired = true;
        return new Receipt(state, now, parsed);
    }

    private Receipt read(Send send) throws Exception {
        if (generation == null) throw new Failure(Failure.INVALID);
        Response response = send.send(new Request(receiptPath() + "?generation=" + generation));
        return receipt(response.status, response.body, false);
    }

    public Map<String, Object> reconcile(BooleanSupplier current, Send send) throws Exception {
        if (!attempted || retiring || retired) throw new Failure(Failure.RETIRED);
        Receipt value = read(send);
        if (retiring || retired) throw new Failure(Failure.RETIRED);
        if (!current.getAsBoolean()) throw new Failure(Failure.UNKNOWN);
        if (value.current != generation) throw new Failure(Failure.GENERATION_CONFLICT);
        return "committed".equals(value.state) ? value.descriptor : null;
    }

    public void retire(Send send) throws Exception {
        retiring = true; // irreversible local adoption fence, including a failed DELETE
        if (generation == null) throw new Failure(Failure.INVALID);
        if (persist != null) persist.persist("retiring", descriptor);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("generation", generation);
        body.put("descriptor", descriptor);
        Response response = send.send(new Request(receiptPath(), NativeHandlersJson.stringify(body).getBytes(StandardCharsets.UTF_8),
            new LinkedHashMap<>(Map.of("Content-Type", "application/json")), "DELETE"));
        receipt(response.status, response.body, true);
    }

    public void acknowledge(Object raw, BooleanSupplier current) throws Exception {
        if (retiring || retired || !current.getAsBoolean() || descriptor == null || raw == null) {
            throw new Failure(Failure.UNKNOWN);
        }
        if (!descriptor.equals(parseDescriptor(raw))) throw new Failure(Failure.UNKNOWN);
    }

    public Map<String, Object> upload(byte[] data, String name, String mime, BooleanSupplier current, Send send) throws Exception {
        if (generation == null || attempted || retiring || retired || recoveryOnly) throw new Failure(Failure.UNKNOWN);
        if (!current.getAsBoolean()) throw new Failure(Failure.UNKNOWN);
        if (data == null || data.length == 0 || data.length > 25 * 1024 * 1024 || !validName(name)
            || mime == null || !MIME.matcher(mime).matches()) {
            throw new Failure(Failure.INVALID);
        }
        String digest = sha256(data);
        if (!current.getAsBoolean() || retiring) throw new Failure(Failure.UNKNOWN);
        expected = new Expected(digest, data.length, mime, name);
        if (persist != null) persist.persist("unknown", descriptor); // durable write-ahead: failure here sent zero PUTs
        attempted = true;
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Accept", "application/vnd.yuri.contact-upload+json");
        headers.put("Content-Type", mime);
        headers.put("X-Content-SHA256", digest);
        headers.put("X-Content-Size", Integer.toString(data.length));
        headers.put("X-Attachment-Filename", encode(name));
        Request request = new Request(base() + "/attachments/" + uploadID + "?generation=" + generation, data, headers, "PUT");
        try {
            Response response = send.send(request);
            if (response.status != 201) throw new Failure(Failure.UNKNOWN);
            Map<String, Object> parsed = parseDescriptor(response.body);
            descriptor = parsed; // retain the exact ACK even after the original page retired
            if (persist != null) persist.persist(retiring ? "retiring" : "unknown", parsed);
            if (!current.getAsBoolean() || retiring || retired) throw new Failure(Failure.UNKNOWN);
            Receipt confirmed = read(send);
            if (retiring || retired) throw new Failure(Failure.RETIRED);
            if (confirmed.current != generation) throw new Failure(Failure.GENERATION_CONFLICT);
            if (!current.getAsBoolean() || !"committed".equals(confirmed.state)) throw new Failure(Failure.UNKNOWN);
            return parsed;
        } catch (Failure failure) {
            if (Failure.GENERATION_CONFLICT.equals(failure.code) || Failure.RETIRED.equals(failure.code)) throw failure;
            throw new Failure(Failure.UNKNOWN);
        } catch (Exception error) {
            throw new Failure(Failure.UNKNOWN);
        }
    }

    public static String sha256(byte[] data) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(data);
            StringBuilder out = new StringBuilder(bytes.length * 2);
            for (byte value : bytes) out.append(String.format("%02x", value & 0xff));
            return out.toString();
        } catch (java.security.NoSuchAlgorithmException absent) {
            throw new IllegalStateException(absent);
        }
    }

    /** encodeURIComponent semantics with the iOS upload component set. */
    public static String encode(String value) {
        byte[] bytes = utf8(value);
        StringBuilder out = new StringBuilder(bytes.length);
        outer:
        for (byte current : bytes) {
            int unsigned = current & 0xff;
            for (char allowed : COMPONENT) {
                if (unsigned == allowed) {
                    out.append(allowed);
                    continue outer;
                }
            }
            out.append('%').append(String.format("%02X", unsigned));
        }
        return out.toString();
    }

    public static byte[] utf8(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private static boolean hasControl(String value) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7f) return true;
        }
        return false;
    }

    /** Bounded hex helper used by the journal identity. */
    public static String sha256Text(String value) {
        return sha256(utf8(value));
    }
}
