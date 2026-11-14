package com.yee94.yuri.nsh;

import android.app.Activity;

import com.longbridge.nsh.NshView;

import java.time.Instant;
import java.time.ZoneId;
import java.time.zone.ZoneOffsetTransition;
import java.time.zone.ZoneRules;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.GregorianCalendar;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

/**
 * Read-only IANA offset data (iOS ScheduleDateBridge.swift). Cron parsing and
 * iteration remain in cron-parser; this class has no credentials, network,
 * file access, scheduler mutation or persistent cache.
 */
public final class ScheduleDateBridge implements NativeHandlers.Bridge {
    private static final class Failure extends Exception {
        final String code;

        Failure(String code) {
            super(code, null, false, false);
            this.code = code;
        }
    }

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;

    public ScheduleDateBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    @Override
    public void install() {
        view.handle("schedule.dateContext", (input, reply) -> {
            try {
                HostLease captured = leases.capture(null);
                if (!captured.isCurrent()) throw new Failure("schedule_date_stale_scope");
                Map<String, Object> value = make(input, captured.scope().hostID);
                if (!captured.isCurrent()) throw new Failure("schedule_date_stale_scope");
                reply.resolve(value);
            } catch (Failure failure) {
                reply.reject(failure.code);
            } catch (Exception error) {
                reply.reject("schedule_date_invalid_request");
            }
        });
    }

    @Override
    public void invalidate() {}

    static Map<String, Object> make(Object input, String expectedHostID) throws Failure {
        if (!(input instanceof Map)) throw new Failure("schedule_date_invalid_request");
        Map<?, ?> value = (Map<?, ?>) input;
        Set<String> keys = new java.util.HashSet<>();
        for (Object key : value.keySet()) {
            if (!(key instanceof String)) throw new Failure("schedule_date_invalid_request");
            keys.add((String) key);
        }
        if (!keys.equals(Set.of("hostID", "timeZone", "startMs", "endMs"))) {
            throw new Failure("schedule_date_invalid_request");
        }
        if (expectedHostID.isEmpty() || !expectedHostID.equals(value.get("hostID"))) {
            throw new Failure("schedule_date_invalid_request");
        }
        Object zoneValue = value.get("timeZone");
        if (!(zoneValue instanceof String)) throw new Failure("schedule_date_invalid_request");
        String identifier = (String) zoneValue;
        if (identifier.isEmpty() || identifier.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 128
            || !zoneCharacters(identifier)) {
            throw new Failure("schedule_date_invalid_request");
        }
        double startMs = milliseconds(value.get("startMs"));
        double endMs = milliseconds(value.get("endMs"));
        if (startMs < -62135596800000d || endMs > 253402300799999d || startMs >= endMs
            || endMs - startMs > 64d * 366d * 86400000d) {
            throw new Failure("schedule_date_invalid_range");
        }
        ZoneId zone;
        try {
            zone = ZoneId.of(identifier);
        } catch (RuntimeException error) {
            throw new Failure("schedule_date_invalid_iana_zone");
        }
        Instant start = Instant.ofEpochMilli((long) startMs);
        Instant end = Instant.ofEpochMilli((long) endMs);
        ZoneRules rules = zone.getRules();
        List<Object> transitions = new ArrayList<>();
        transitions.add(transition(startMs, rules.getOffset(start).getTotalSeconds()));
        Instant cursor = start;
        while (true) {
            ZoneOffsetTransition next = rules.nextTransition(cursor);
            if (next == null) break;
            Instant at = next.getInstant();
            if (!at.isBefore(end)) break;
            double atMs = at.toEpochMilli();
            if (!at.isAfter(cursor) || !Double.isFinite(atMs) || transitions.size() >= 1024) {
                throw new Failure("schedule_date_invalid_transition");
            }
            transitions.add(transition(atMs, next.getOffsetAfter().getTotalSeconds()));
            cursor = at.plusMillis(1);
        }
        GregorianCalendar calendar = new GregorianCalendar(TimeZone.getTimeZone(zone));
        calendar.setTimeInMillis((long) startMs);
        Map<String, Object> anchor = new LinkedHashMap<>();
        anchor.put("timestampMs", startMs);
        anchor.put("era", calendar.get(Calendar.ERA));
        anchor.put("year", calendar.get(Calendar.YEAR));
        anchor.put("month", calendar.get(Calendar.MONTH) + 1);
        anchor.put("day", calendar.get(Calendar.DAY_OF_MONTH));
        anchor.put("hour", calendar.get(Calendar.HOUR_OF_DAY));
        anchor.put("minute", calendar.get(Calendar.MINUTE));
        anchor.put("second", calendar.get(Calendar.SECOND));
        anchor.put("weekday", calendar.get(Calendar.DAY_OF_WEEK));
        anchor.put("offsetSeconds", rules.getOffset(start).getTotalSeconds());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schemaVersion", 1);
        result.put("hostID", expectedHostID);
        result.put("timeZone", identifier);
        result.put("startMs", startMs);
        result.put("endMs", endMs);
        result.put("transitions", transitions);
        result.put("anchor", anchor);
        return result;
    }

    private static Map<String, Object> transition(double atMs, int offsetSeconds) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("atMs", atMs);
        value.put("offsetSeconds", offsetSeconds);
        return value;
    }

    private static double milliseconds(Object value) throws Failure {
        if (!(value instanceof Number)) throw new Failure("schedule_date_invalid_request");
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || Math.rint(number) != number) throw new Failure("schedule_date_invalid_request");
        return number;
    }

    private static boolean zoneCharacters(String value) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            boolean digit = character >= '0' && character <= '9';
            boolean upper = character >= 'A' && character <= 'Z';
            boolean lower = character >= 'a' && character <= 'z';
            if (!digit && !upper && !lower && character != '+' && character != '-' && character != '/' && character != '_') {
                return false;
            }
        }
        return true;
    }
}
