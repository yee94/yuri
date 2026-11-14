package com.yee94.yuri.nsh;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Validated device notification configuration for exactly one Host. */
public final class NotificationConfiguration {
    public final boolean enabled;
    public final Set<String> events;
    public final String language;
    public final String mode;

    private NotificationConfiguration(boolean enabled, Set<String> events, String language, String mode) {
        this.enabled = enabled;
        this.events = Collections.unmodifiableSet(events);
        this.language = language;
        this.mode = mode;
    }

    public static NotificationConfiguration parse(Object input, String hostID) throws NotificationFailure {
        Map<String, Object> value = NotificationPolicy.object(input, "hostID", "enabled", "mode", "events", "language");
        if (!(value.get("hostID") instanceof String) || !hostID.equals(value.get("hostID"))
                || !NotificationPolicy.identifier(hostID)) throw NotificationFailure.invalid();
        Object mode = value.get("mode");
        if (!"always".equals(mode) && !"hidden-only".equals(mode)) throw NotificationFailure.invalid();
        if (!(value.get("events") instanceof List)) throw NotificationFailure.invalid();
        List<?> raw = (List<?>) value.get("events");
        if (raw.size() > NotificationPolicy.KINDS.size()) throw NotificationFailure.invalid();
        Set<String> events = new LinkedHashSet<>();
        for (Object item : raw) {
            if (!(item instanceof String) || !NotificationPolicy.KINDS.contains(item)) throw NotificationFailure.invalid();
            if (!events.add((String) item)) throw NotificationFailure.invalid();
        }
        Object language = value.get("language");
        if (!(language instanceof String) || !NotificationPolicy.LANGUAGES.contains(language)) throw NotificationFailure.invalid();
        return new NotificationConfiguration(NotificationPolicy.bool(value.get("enabled")), events, (String) language, (String) mode);
    }

    @Override public boolean equals(Object other) {
        if (!(other instanceof NotificationConfiguration)) return false;
        NotificationConfiguration value = (NotificationConfiguration) other;
        return enabled == value.enabled && mode.equals(value.mode) && language.equals(value.language)
                && events.equals(value.events);
    }

    @Override public int hashCode() { return Objects.hash(enabled, events, language, mode); }
}
