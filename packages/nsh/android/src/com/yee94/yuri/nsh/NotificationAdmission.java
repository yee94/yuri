package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Native boundary validation of the existing admission-event.js proof. It is not a second producer or
 * classifier: the expected eventID is recomputed from kind plus the exact source identifiers.
 */
public final class NotificationAdmission {
    public final String eventID;
    public final String kind;
    public final NotificationTarget target;
    public final Map<String, Object> source;

    private NotificationAdmission(String eventID, String kind, NotificationTarget target, Map<String, Object> source) {
        this.eventID = eventID;
        this.kind = kind;
        this.target = target;
        this.source = source;
    }

    public Map<String, Object> value() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("v", 1L);
        out.put("kind", kind);
        out.put("eventID", eventID);
        out.put("target", target.value());
        out.put("source", new LinkedHashMap<>(source));
        return out;
    }

    public static NotificationAdmission parse(Object input) throws NotificationFailure {
        Map<String, Object> row = NotificationPolicy.object(input, "v", "kind", "eventID", "target", "source");
        Object version = row.get("v");
        if (!(version instanceof Number) || version instanceof Boolean || ((Number) version).doubleValue() != 1d) {
            throw NotificationFailure.invalid();
        }
        if (!(row.get("kind") instanceof String) || !(row.get("eventID") instanceof String)) {
            throw NotificationFailure.invalid();
        }
        String kind = (String) row.get("kind");
        String eventID = (String) row.get("eventID");
        NotificationTarget target = NotificationTarget.parse(row.get("target"));
        Map<String, Object> source;
        String[] parts;
        if (SESSION_KINDS.contains(kind)) {
            Map<String, Object> value = NotificationPolicy.object(row.get("source"),
                    "type", "sessionID", "directory", "parentID", "boundaryID");
            String session = identifier(value.get("sessionID"));
            String boundary = identifier(value.get("boundaryID"));
            // Validated for presence and size; the directory never reaches the OS payload.
            directory(value.get("directory"));
            if (!"session".equals(value.get("type"))
                    || !"session".equals(target.kind) || !session.equals(target.id)) throw NotificationFailure.invalid();
            boolean parentPresent = value.get("parentID") != null;
            if ("subtask".equals(kind)) {
                identifier(value.get("parentID"));
            } else if (parentPresent) {
                throw NotificationFailure.invalid();
            }
            source = new LinkedHashMap<>(value);
            parts = new String[] {session, boundary};
        } else if ("assistant".equals(kind)) {
            Map<String, Object> value = NotificationPolicy.object(row.get("source"),
                    "type", "assistantID", "turnID", "status", "publication");
            String assistant = identifier(value.get("assistantID"));
            String turn = identifier(value.get("turnID"));
            Object status = value.get("status");
            if (!"assistant".equals(value.get("type"))
                    || !("complete".equals(status) || "error".equals(status))
                    || !"published".equals(value.get("publication"))
                    || !"assistant".equals(target.kind) || !assistant.equals(target.id)) throw NotificationFailure.invalid();
            source = new LinkedHashMap<>(value);
            parts = new String[] {assistant, turn};
        } else if ("schedule".equals(kind)) {
            Map<String, Object> value = NotificationPolicy.object(row.get("source"),
                    "type", "projectID", "taskID", "runID", "trigger", "resultOwner", "status");
            String project = identifier(value.get("projectID"));
            String task = identifier(value.get("taskID"));
            String run = identifier(value.get("runID"));
            Object status = value.get("status");
            if (!"schedule".equals(value.get("type"))
                    || !"scheduled".equals(value.get("trigger"))
                    || !"unowned".equals(value.get("resultOwner"))
                    || !("success".equals(status) || "error".equals(status))
                    || !"schedule".equals(target.kind) || !task.equals(target.id)) throw NotificationFailure.invalid();
            source = new LinkedHashMap<>(value);
            parts = new String[] {project, task, run};
        } else {
            throw NotificationFailure.invalid();
        }
        StringBuilder expected = new StringBuilder("admitted_").append(kind);
        for (String part : parts) expected.append('_').append(NotificationPolicy.utf8Length(part)).append('_').append(part);
        String key = expected.toString();
        if (!NotificationPolicy.eventIdentifier(key) || !key.equals(eventID)) throw NotificationFailure.invalid();
        return new NotificationAdmission(eventID, kind, target, source);
    }

    private static final java.util.Set<String> SESSION_KINDS = java.util.Collections.unmodifiableSet(
            new java.util.HashSet<>(java.util.Arrays.asList("completion", "subtask", "error", "question", "permission", "goal")));

    private static String identifier(Object value) throws NotificationFailure {
        if (!(value instanceof String) || !NotificationPolicy.identifier((String) value)) throw NotificationFailure.invalid();
        return (String) value;
    }

    /** JS trim() semantics: whitespace and space separators, three to four thousand UTF-16 units at most. */
    private static String directory(Object value) throws NotificationFailure {
        if (!(value instanceof String)) throw NotificationFailure.invalid();
        String text = (String) value;
        if (text.length() > 4096) throw NotificationFailure.invalid();
        int start = 0, end = text.length();
        while (start < end && isBlank(text.charAt(start))) start++;
        while (end > start && isBlank(text.charAt(end - 1))) end--;
        if (start == end) throw NotificationFailure.invalid();
        return text;
    }

    private static boolean isBlank(char ch) { return Character.isWhitespace(ch) || Character.isSpaceChar(ch); }
}
