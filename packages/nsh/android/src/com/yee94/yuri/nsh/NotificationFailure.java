package com.yee94.yuri.nsh;

/** Notification failures; the codes are the strings iOS NativeNotificationFailure throws. */
public final class NotificationFailure extends Exception {
    private static final long serialVersionUID = 1L;

    public static final String INVALID = "notification_invalid";
    public static final String STALE = "notification_stale";
    public static final String DENIED = "notification_denied";
    public static final String UNAVAILABLE = "notification_unavailable";

    public final String code;

    public NotificationFailure(String code) {
        super(code);
        this.code = code;
    }

    public static NotificationFailure invalid() { return new NotificationFailure(INVALID); }
    public static NotificationFailure stale() { return new NotificationFailure(STALE); }
    public static NotificationFailure denied() { return new NotificationFailure(DENIED); }
    public static NotificationFailure unavailable() { return new NotificationFailure(UNAVAILABLE); }
}
