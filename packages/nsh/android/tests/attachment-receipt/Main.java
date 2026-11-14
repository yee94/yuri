import com.yee94.yuri.nsh.AttachmentReceiptJournal;
import com.yee94.yuri.nsh.AttachmentUploadPolicy;
import com.yee94.yuri.nsh.NativeHandlersJson;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JVM-only checks for the receipt protocol and the metadata journal.
 * Run: javac + java (no JUnit, no Android, no network).
 */
public final class Main {
    private static int checks = 0;

    public static void main(String[] args) throws Exception {
        json();
        validation();
        uploadLifecycle();
        journal();
        System.out.println(checks + " attachment receipt checks passed");
    }

    private static void json() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("text", "a\"b\\c\n");
        value.put("number", 42);
        value.put("list", List.of(1, 2));
        value.put("map", new LinkedHashMap<>(Map.of("k", "v")));
        String encoded = NativeHandlersJson.stringify(value);
        Object decoded = NativeHandlersJson.parse(encoded);
        check(decoded instanceof Map, "object round-trip");
        check(NativeHandlersJson.stringify(decoded).equals(encoded), "value equality");
        check(!"{}".equals(NativeHandlersJson.stringify(null)), "null is null");
        boolean rejected = false;
        try {
            NativeHandlersJson.parse("{\"a\":1,\"a\":2}");
        } catch (IllegalArgumentException expected) {
            rejected = true;
        }
        check(rejected, "duplicate key rejected");
    }

    private static void validation() {
        expect(AttachmentUploadPolicy.Failure.class, () -> new AttachmentUploadPolicy("bot\n", "u1"));
        expect(AttachmentUploadPolicy.Failure.class, () -> new AttachmentUploadPolicy("bot", "../u"));
        check(AttachmentUploadPolicy.safeInteger(7) == 7, "safe integer");
        expect(RuntimeException.class, () -> AttachmentUploadPolicy.safeInteger(-1));
        check(AttachmentUploadPolicy.encode("a b/中").equals("a%20b%2F%E4%B8%AD"), "percent encoding");
        check(AttachmentUploadPolicy.sha256("abc".getBytes(StandardCharsets.UTF_8))
            .equals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"), "sha256");
    }

    private static void uploadLifecycle() throws Exception {
        byte[] data = "hello".getBytes(StandardCharsets.UTF_8);
        FakeHost host = new FakeHost(data);
        AttachmentUploadPolicy policy = new AttachmentUploadPolicy("bot_1", "u1");
        List<String> phases = new ArrayList<>();
        policy.persistWith((phase, descriptor) -> phases.add(phase));
        policy.prepare(3, () -> true, host::handle);
        check(phases.equals(List.of("unknown")), "prepare reads one receipt");
        Map<String, Object> descriptor = policy.upload(data, "a b.txt", "text/plain", () -> true, host::handle);
        check(descriptor != null && descriptor.get("attachmentID").equals("a1"), "descriptor returned");
        check("a%20b.txt".equals(host.lastFilename), "filename header encoded");
        check(host.lastHash.equals(AttachmentUploadPolicy.sha256(data)), "digest header");
        expect(AttachmentUploadPolicy.Failure.class, () -> policy.upload(data, "a.txt", "text/plain", () -> true, host::handle));
        check(policy.reconcile(() -> true, host::handle) != null, "reconcile committed");
        policy.acknowledge(descriptor, () -> true);
        expect(AttachmentUploadPolicy.Failure.class, () -> policy.acknowledge(Map.of(), () -> true));
        policy.retire(host::handle);
        check(policy.retired(), "retired after DELETE");
        expect(AttachmentUploadPolicy.Failure.class, () -> policy.reconcile(() -> true, host::handle));
    }

    private static void journal() {
        Map<String, byte[]> storage = new LinkedHashMap<>();
        AttachmentReceiptJournal journal = new AttachmentReceiptJournal(
            () -> storage.get("receipts"),
            bytes -> storage.put("receipts", bytes));
        check(journal.records().isEmpty(), "empty journal");
        AttachmentReceiptJournal.Record record = record("req_1", "u1");
        journal.insert(record);
        check(journal.records().size() == 1, "insert");
        expect(AttachmentUploadPolicy.Failure.class, () -> journal.insert(record("req_1", "u2")));
        journal.update("req_1", "u1", "retiring", null);
        check(journal.records().get(0).phase.equals("retiring"), "retiring persists");
        journal.update("req_1", "u1", "unknown", null);
        check(journal.records().get(0).phase.equals("retiring"), "ACK cannot undo the fence");
        journal.update("req_1", "u1", "retired", null);
        check(journal.records().get(0).phase.equals("retired"), "retired wins");
        journal.remove("req_1", "u1");
        check(journal.records().isEmpty(), "remove");
        storage.put("receipts", "{not json".getBytes(StandardCharsets.UTF_8));
        expect(AttachmentUploadPolicy.Failure.class, journal::records);
        storage.clear();
        for (int index = 0; index < 64; index++) {
            journal.insert(record("req_" + index, "u" + index));
        }
        expect(AttachmentUploadPolicy.Failure.class, () -> journal.insert(record("req_64", "u64")));
    }

    private static AttachmentReceiptJournal.Record record(String request, String upload) {
        return new AttachmentReceiptJournal.Record(request, upload, "bot_1", "conn_1", "transport_1",
            "authorization_1", "version_1", 3, "a".repeat(64), 0, "page_1", "prepared", null);
    }

    private interface Work {
        void run() throws Exception;
    }

    private static void expect(Class<? extends Throwable> kind, Work work) {
        try {
            work.run();
        } catch (Throwable error) {
            if (kind.isInstance(error)) {
                checks++;
                return;
            }
            throw new AssertionError("expected " + kind.getSimpleName() + " but got " + error);
        }
        throw new AssertionError("expected " + kind.getSimpleName());
    }

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        checks++;
    }

    private static final class FakeHost {
        final byte[] data;
        final String digest;
        final Map<String, Object> descriptor;
        String lastFilename;
        String lastHash;
        boolean inflight;

        FakeHost(byte[] data) {
            this.data = data;
            this.digest = AttachmentUploadPolicy.sha256(data);
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("type", "file");
            value.put("attachmentID", "a1");
            value.put("sha256", digest);
            value.put("size", data.length);
            value.put("mime", "text/plain");
            value.put("filename", "a b.txt");
            value.put("generation", 3);
            this.descriptor = value;
        }

        AttachmentUploadPolicy.Response handle(AttachmentUploadPolicy.Request request) {
            String path = request.path;
            if (path.endsWith("/messages?limit=1")) {
                return new AttachmentUploadPolicy.Response(200, Map.of("generation", 3));
            }
            boolean receipt = path.contains("/attachments/uploads/u1");
            if (request.method.equals("PUT")) {
                lastFilename = request.headers.get("X-Attachment-Filename");
                lastHash = request.headers.get("X-Content-SHA256");
                if (!java.util.Arrays.equals(request.data, data)
                    || !String.valueOf(data.length).equals(request.headers.get("X-Content-Size"))) {
                    return new AttachmentUploadPolicy.Response(400, Map.of());
                }
                inflight = true;
                return new AttachmentUploadPolicy.Response(201, descriptor);
            }
            if (request.method.equals("DELETE")) {
                Map<String, Object> value = new LinkedHashMap<>();
                value.put("assistantID", "bot_1");
                value.put("uploadID", "u1");
                value.put("generation", 3);
                value.put("state", "retired");
                value.put("currentGeneration", 3);
                value.put("descriptor", descriptor);
                value.put("newAdmissionAllowed", false);
                value.put("bytesDeleted", false);
                value.put("ownershipRetained", true);
                return new AttachmentUploadPolicy.Response(200, value);
            }
            if (receipt) {
                if (!inflight) {
                    Map<String, Object> empty = new LinkedHashMap<>();
                    empty.put("assistantID", "bot_1");
                    empty.put("uploadID", "u1");
                    empty.put("generation", 3);
                    empty.put("state", "not_found");
                    empty.put("currentGeneration", 3);
                    empty.put("descriptor", null);
                    return new AttachmentUploadPolicy.Response(404, empty);
                }
                Map<String, Object> value = new LinkedHashMap<>();
                value.put("assistantID", "bot_1");
                value.put("uploadID", "u1");
                value.put("generation", 3);
                value.put("state", "committed");
                value.put("currentGeneration", 3);
                value.put("descriptor", descriptor);
                return new AttachmentUploadPolicy.Response(200, value);
            }
            return new AttachmentUploadPolicy.Response(404, Map.of());
        }
    }
}
