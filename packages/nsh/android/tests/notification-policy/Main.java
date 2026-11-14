import com.yee94.yuri.nsh.NotificationAdmission;
import com.yee94.yuri.nsh.NotificationConfiguration;
import com.yee94.yuri.nsh.NotificationEvent;
import com.yee94.yuri.nsh.NotificationFailure;
import com.yee94.yuri.nsh.NotificationJson;
import com.yee94.yuri.nsh.NotificationLaunchInbox;
import com.yee94.yuri.nsh.NotificationPolicy;
import com.yee94.yuri.nsh.NotificationTarget;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Plain JVM checks for notification admission, receipts, TTL, CAS and retirement. */
public final class Main {
    private static int checks;

    private static void check(boolean condition, String label) {
        checks++;
        if (!condition) throw new AssertionError(label);
    }

    private static void rejects(String label, Action action) {
        try {
            action.run();
        } catch (Exception expected) {
            checks++;
            return;
        }
        throw new AssertionError("accepted " + label);
    }

    private interface Action { void run() throws Exception; }

    private static Map<String, Object> map(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) out.put((String) pairs[index], pairs[index + 1]);
        return out;
    }

    private static String eventID(String kind, String... parts) {
        StringBuilder out = new StringBuilder("admitted_").append(kind);
        for (String part : parts) {
            out.append('_').append(part.getBytes(StandardCharsets.UTF_8).length).append('_').append(part);
        }
        return out.toString();
    }

    private static Map<String, Object> sessionSource(String kind) {
        Map<String, Object> source = map("type", "session", "sessionID", "session1", "directory", "/tmp/project",
                "parentID", null, "boundaryID", "boundary1");
        if ("subtask".equals(kind)) source.put("parentID", "parent1");
        return source;
    }

    private static Map<String, Object> admission(String kind) {
        String[] parts;
        Map<String, Object> source;
        Map<String, Object> target;
        if ("assistant".equals(kind)) {
            parts = new String[] {"assistant1", "turn1"};
            source = map("type", "assistant", "assistantID", "assistant1", "turnID", "turn1",
                    "status", "complete", "publication", "published");
            target = target("assistant", "assistant1");
        } else if ("schedule".equals(kind)) {
            parts = new String[] {"project1", "task1", "run1"};
            source = map("type", "schedule", "projectID", "project1", "taskID", "task1", "runID", "run1",
                    "trigger", "scheduled", "resultOwner", "unowned", "status", "success");
            target = target("schedule", "task1");
        } else {
            parts = new String[] {"session1", "boundary1"};
            source = sessionSource(kind);
            target = target("session", "session1");
        }
        return map("v", 1L, "kind", kind, "eventID", eventID(kind, parts), "target", target, "source", source);
    }

    private static Map<String, Object> target(String kind, String id) { return map("kind", kind, "id", id); }

    public static void main(String[] args) throws Exception {
        // Exact-key objects and bounded identifiers.
        check(NotificationPolicy.object(map(), new String[0]) != null, "empty object accepted");
        for (Object invalid : new Object[] {null, new ArrayList<>(), map("url", "https://outside.invalid")}) {
            rejects("object keys", () -> NotificationPolicy.object(invalid));
        }
        for (String invalid : new String[] {"", "../../private", "https://outside.invalid", "id?token=x", repeat("a", 129)}) {
            rejects("target id " + invalid, () -> NotificationTarget.parse(map("kind", "session", "id", invalid)));
        }
        rejects("target extra key", () -> NotificationTarget.parse(map("kind", "session", "id", "session-1", "url", "x")));
        check(NotificationTarget.parse(map("kind", "session", "id", "session-1")).value().get("id").equals("session-1"), "target value");
        rejects("boolean is not a number", () -> NotificationPolicy.positiveInteger(true));
        rejects("fractional revision", () -> NotificationPolicy.positiveInteger(1.5d));
        check(NotificationPolicy.positiveInteger(1L) == 1, "positive integer");
        rejects("boolean flag", () -> NotificationPolicy.bool(1L));

        // Configuration.
        Map<String, Object> configuration = map("hostID", "host-a", "enabled", true, "mode", "hidden-only",
                "events", new ArrayList<>(List.of("completion", "permission")), "language", "en");
        NotificationConfiguration parsed = NotificationConfiguration.parse(configuration, "host-a");
        check(parsed.enabled && parsed.events.contains("completion") && parsed.events.size() == 2, "configuration events");
        for (Object[] invalid : new Object[][] {
                {"enabled", 1L}, {"hostID", "host-b"}, {"mode", "sometimes"}, {"language", "ar"},
                {"events", new ArrayList<>(List.of("completion", "completion"))},
                {"events", new ArrayList<>(List.of("https://outside.invalid"))}, {"token", "excluded"}}) {
            Map<String, Object> bad = new LinkedHashMap<>(configuration);
            bad.put((String) invalid[0], invalid[1]);
            rejects("configuration " + invalid[0], () -> NotificationConfiguration.parse(bad, "host-a"));
        }

        // Admission proofs: recomputed ids, exact sources and kind-specific rules.
        for (String kind : new String[] {"completion", "subtask", "error", "question", "permission", "goal", "assistant", "schedule"}) {
            NotificationAdmission proof = NotificationAdmission.parse(admission(kind));
            check(proof.kind.equals(kind), "admission kind " + kind);
            check(NotificationAdmission.parse(proof.value()).eventID.equals(proof.eventID), "admission round trip " + kind);
        }
        rejects("tampered event", () -> NotificationAdmission.parse(with(admission("completion"), "eventID", eventID("completion", "session2", "boundary1"))));
        rejects("wrong kind id", () -> NotificationAdmission.parse(with(admission("completion"), "kind", "error")));
        rejects("host text in source", () -> {
            Map<String, Object> value = admission("completion");
            Map<String, Object> source = new LinkedHashMap<>(cast(value.get("source")));
            source.put("directory", "  ");
            value.put("source", source);
            NotificationAdmission.parse(value);
        });
        rejects("subtask without parent", () -> {
            Map<String, Object> value = admission("subtask");
            Map<String, Object> source = new LinkedHashMap<>(cast(value.get("source")));
            source.put("parentID", null);
            value.put("source", source);
            NotificationAdmission.parse(value);
        });
        rejects("completion with parent", () -> {
            Map<String, Object> value = admission("completion");
            Map<String, Object> source = new LinkedHashMap<>(cast(value.get("source")));
            source.put("parentID", "parent1");
            value.put("source", source);
            NotificationAdmission.parse(value);
        });
        rejects("assistant unpublished", () -> {
            Map<String, Object> value = admission("assistant");
            Map<String, Object> source = new LinkedHashMap<>(cast(value.get("source")));
            source.put("publication", "draft");
            value.put("source", source);
            NotificationAdmission.parse(value);
        });

        // Live events.
        String receipt = "7c1a2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
        Map<String, Object> event = map("lease", "lease-1", "eventID", eventID("completion", "session1", "boundary1"),
                "kind", "completion", "target", target("session", "session1"), "admission", admission("completion"));
        check(NotificationEvent.parse(event, "lease-1").admission != null, "event admission");
        rejects("event lease mismatch", () -> NotificationEvent.parse(event, "lease-2"));
        rejects("event body", () -> NotificationEvent.parse(with(event, "body", "leak"), "lease-1"));
        rejects("event requireHidden", () -> NotificationEvent.parse(with(event, "requireHidden", false), "lease-1"));
        rejects("event admission mismatch", () -> NotificationEvent.parse(with(event, "kind", "error"), "lease-1"));
        check(NotificationPolicy.present(true, false, false) && !NotificationPolicy.present(true, true, false)
                && !NotificationPolicy.present(false, true, false) && NotificationPolicy.present(false, true, true), "present rules");
        for (String language : NotificationPolicy.LANGUAGES) {
            String[] normal = NotificationPolicy.copy(language, false);
            String[] test = NotificationPolicy.copy(language, true);
            check(normal[0].equals("Yuri") && !normal[1].isEmpty() && !test[0].isEmpty() && !test[1].isEmpty(), "copy " + language);
        }
        check(NotificationPolicy.receipt(map("v", 1L, "receipt", receipt)).equals(receipt), "OS payload receipt");
        check(NotificationPolicy.receipt(map("v", true, "receipt", receipt)) == null, "OS payload boolean version");
        check(NotificationPolicy.receipt(map("v", 1L, "receipt", "not-a-uuid")) == null, "OS payload uuid");
        check(NotificationPolicy.receipt(map("v", 1L, "receipt", receipt, "url", "x")) == null, "OS payload extra key");

        // Durable inbox: write-ahead, newest-wins tap, CAS consume, TTL, retirement journal.
        File directory = Files.createTempDirectory("nsh-notification-inbox").toFile();
        File file = new File(directory, "notification-launch/receipts.json");
        NotificationLaunchInbox inbox = new NotificationLaunchInbox(file);
        check(inbox.pending() == null && inbox.records().isEmpty(), "empty inbox");
        long now = System.currentTimeMillis();
        String first = "11111111-2222-4333-8444-555555555555";
        String second = "99999999-8888-4777-8666-555555555555";
        inbox.record(first, "host-a", "auth-a", NotificationAdmission.parse(admission("completion")), now);
        check(file.isFile(), "record persisted");
        check(inbox.pending() == null, "record is not a queued tap");
        check(inbox.receive("default", NotificationLaunchInbox.PREFIX + first,
                map("v", 1L, "receipt", first)), "tap accepted");
        check(inbox.pending().receipt.equals(first), "newest tap wins");
        check(inbox.receive("default", NotificationLaunchInbox.PREFIX + first,
                map("v", 1L, "receipt", first)), "duplicate tap is idempotent");
        inbox.record(second, "host-a", "auth-a", NotificationAdmission.parse(admission("assistant")), now);
        check(inbox.receive("default", NotificationLaunchInbox.PREFIX + second,
                map("v", 1L, "receipt", second)), "second tap accepted");
        check(inbox.pending().receipt.equals(second), "tapped receipt replaces older");
        check(!inbox.receive("default", NotificationLaunchInbox.PREFIX + receipt,
                map("v", 1L, "receipt", receipt)), "unknown tap is not accepted");
        check(!inbox.receive("reply", NotificationLaunchInbox.PREFIX + second,
                map("v", 1L, "receipt", second)), "wrong action is not accepted");
        rejects("stale claim host", () -> inbox.claim(second, "host-b", "auth-a", now));
        rejects("stale claim authorization", () -> inbox.claim(second, "host-a", "auth-b", now));
        rejects("expired claim", () -> inbox.claim(second, "host-a", "auth-a", now + 8L * 24 * 60 * 60 * 1000));
        rejects("revision CAS", () -> inbox.consume(second, 2, "host-a", "auth-a"));
        check(new NotificationLaunchInbox(file).pending().receipt.equals(second), "reload keeps queued tap");
        inbox.consume(second, 1, "host-a", "auth-a");
        check(inbox.pending() == null && inbox.records().size() == 1, "consume removes exactly one");

        NotificationLaunchInbox.RetirementBatch batch = inbox.beginRetirement("host-a", "auth-a");
        check(batch.receipts.size() == 1 && batch.identifiers().get(0).equals(NotificationLaunchInbox.PREFIX + first), "retirement journal");
        check(inbox.records().isEmpty() && inbox.pendingRetirements().size() == 1, "retirement keeps tombstone");
        rejects("record during pending retirement", () -> inbox.record(receipt, "host-a", "auth-a",
                NotificationAdmission.parse(admission("completion")), now));
        inbox.acknowledgeRetirement(batch);
        check(inbox.pendingRetirements().isEmpty(), "retirement acknowledged");
        check(new NotificationLaunchInbox(file).pendingRetirements().isEmpty(), "retirement durable");
        rejects("legacy authorization", () -> inbox.beginRetirement("host-a", "legacy"));

        // Failure atomicity: an unreadable/corrupt store is never an empty inbox.
        File corrupt = new File(directory, "corrupt.json");
        Files.write(corrupt.toPath(), "{\"v\":1,\"records\":[{\"v\":1}],\"queuedReceipt\":null}".getBytes(StandardCharsets.UTF_8));
        rejects("corrupt store", () -> new NotificationLaunchInbox(corrupt));

        System.out.println("PASS: " + checks + " notification policy/inbox checks");
    }

    private static String repeat(String value, int count) {
        StringBuilder out = new StringBuilder();
        for (int index = 0; index < count; index++) out.append(value);
        return out.toString();
    }

    private static Map<String, Object> with(Map<String, Object> source, String key, Object value) {
        Map<String, Object> out = new LinkedHashMap<>(source);
        out.put(key, value);
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Object value) { return (Map<String, Object>) value; }
}
