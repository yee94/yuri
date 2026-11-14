package com.yee94.yuri.nsh;

import java.util.Map;

/** Explicit-password management labels supplied by JS; bounded, control-character free copy. */
public final class PasskeyManagementLabels {
    public final String title;
    public final String cancel;
    public final String submit;
    public final String passwordPlaceholder;

    private PasskeyManagementLabels(String title, String cancel, String submit, String passwordPlaceholder) {
        this.title = title;
        this.cancel = cancel;
        this.submit = submit;
        this.passwordPlaceholder = passwordPlaceholder;
    }

    public static PasskeyManagementLabels parse(Object input) throws PasskeyFailure {
        Map<String, Object> values;
        try {
            values = NotificationPolicy.object(input, "title", "cancel", "submit", "passwordPlaceholder");
        } catch (NotificationFailure error) {
            throw PasskeyFailure.invalid();
        }
        return new PasskeyManagementLabels(label(values, "title"), label(values, "cancel"),
                label(values, "submit"), label(values, "passwordPlaceholder"));
    }

    private static String label(Map<String, Object> values, String key) throws PasskeyFailure {
        Object raw = values.get(key);
        if (!(raw instanceof String)) throw PasskeyFailure.invalid();
        String value = (String) raw;
        if (NotificationPolicy.utf8Length(value) > 512 || trim(value).isEmpty()) throw PasskeyFailure.invalid();
        for (int index = 0; index < value.length(); index++) {
            char ch = value.charAt(index);
            if (Character.isISOControl(ch)) throw PasskeyFailure.invalid();
        }
        return value;
    }

    private static String trim(String value) {
        int start = 0, end = value.length();
        while (start < end && (Character.isWhitespace(value.charAt(start)) || Character.isSpaceChar(value.charAt(start)))) start++;
        while (end > start && (Character.isWhitespace(value.charAt(end - 1)) || Character.isSpaceChar(value.charAt(end - 1)))) end--;
        return value.substring(start, end);
    }
}
