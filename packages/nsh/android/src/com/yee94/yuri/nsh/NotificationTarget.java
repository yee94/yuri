package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/** Opaque route target: kind plus bounded identifier. No URLs or credentials are route inputs. */
public final class NotificationTarget {
    public final String kind;
    public final String id;

    private NotificationTarget(String kind, String id) {
        this.kind = kind;
        this.id = id;
    }

    public static NotificationTarget parse(Object input) throws NotificationFailure {
        Map<String, Object> value = NotificationPolicy.object(input, "kind", "id");
        Object kind = value.get("kind");
        Object id = value.get("id");
        if (!(kind instanceof String) || !NotificationPolicy.TARGETS.contains(kind)) throw NotificationFailure.invalid();
        if (!(id instanceof String) || !NotificationPolicy.identifier((String) id)) throw NotificationFailure.invalid();
        return new NotificationTarget((String) kind, (String) id);
    }

    public Map<String, Object> value() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("kind", kind);
        out.put("id", id);
        return out;
    }

    @Override public boolean equals(Object other) {
        return other instanceof NotificationTarget
                && Objects.equals(((NotificationTarget) other).kind, kind)
                && Objects.equals(((NotificationTarget) other).id, id);
    }

    @Override public int hashCode() { return Objects.hash(kind, id); }
}
