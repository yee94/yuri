package com.yee94.yuri.nsh;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The UNUserNotificationCenter counterpart: one local channel, runtime permission and the active
 * notification set. APNs has no Android counterpart without an FCM dependency, so
 * {@code notification.status.backgroundPush} stays false and there is no push registration call.
 *
 * <p>Because Android has no willPresent delegate, foreground suppression is applied when the
 * notification is posted (see NotificationBridge.schedule); a notification already posted keeps
 * showing even if the app returns to the foreground afterwards. This is an intentional platform
 * difference, not a re-derivation of the iOS decision.
 */
public final class NotificationSystem {
    private static final String CHANNEL_ID = "yuri.nsh.local";
    private static final String CHANNEL_NAME = "Yuri";
    private static final String PREFERENCES = "yuri.nsh.notifications";
    private static final String REQUESTED = "permissionRequested";
    private static final int REQUEST_CODE = 4801;

    public static final String EXTRA_VERSION = "v";
    public static final String EXTRA_RECEIPT = "receipt";

    private final Activity activity;
    private final NotificationManager manager;
    private final Map<String, Integer> requestCodes = new HashMap<>();
    private final List<Pending> permissionWaiters = new ArrayList<>();
    private int nextRequestCode = 1;
    private long requestedAt;

    private static final class Pending {
        final java.util.function.Consumer<String> done;
        Pending(java.util.function.Consumer<String> done) { this.done = done; }
    }

    public NotificationSystem(Activity activity) {
        this.activity = activity;
        this.manager = (NotificationManager) activity.getSystemService(Activity.NOTIFICATION_SERVICE);
    }

    /** Creates the single channel; called once from the bridge constructor. */
    public void install() {
        if (manager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT);
        channel.setShowBadge(true);
        try {
            manager.createNotificationChannel(channel);
        } catch (RuntimeException ignored) {
            // A missing channel is reported through the setting projections below.
        }
    }

    public String authorization() {
        if (manager == null) return "unknown";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            boolean granted = activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
            if (!granted) return requested() ? "denied" : "notDetermined";
        }
        return manager.areNotificationsEnabled() ? "authorized" : "denied";
    }

    private boolean requested() {
        SharedPreferences preferences = activity.getSharedPreferences(PREFERENCES, Activity.MODE_PRIVATE);
        return preferences.getBoolean(REQUESTED, false);
    }

    public String alertSetting() { return setting(Setting.ALERT); }
    public String soundSetting() { return setting(Setting.SOUND); }
    public String badgeSetting() { return setting(Setting.BADGE); }

    private enum Setting { ALERT, SOUND, BADGE }

    private String setting(Setting setting) {
        if (manager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "unsupported";
        if (!manager.areNotificationsEnabled()) return "disabled";
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        if (channel == null) return "disabled";
        if (setting == Setting.BADGE) return channel.canShowBadge() ? "enabled" : "disabled";
        int importance = channel.getImportance();
        if (importance == NotificationManager.IMPORTANCE_NONE) return "disabled";
        if (setting == Setting.ALERT) return "enabled";
        boolean sound = channel.getSound() != null && importance >= NotificationManager.IMPORTANCE_DEFAULT;
        return sound ? "enabled" : "disabled";
    }

    /** The runtime POST_NOTIFICATIONS prompt; below API 33 the projection is already authoritative. */
    public void requestPermission(java.util.function.Consumer<String> done) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            done.accept(authorization());
            return;
        }
        if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            done.accept(authorization());
            return;
        }
        permissionWaiters.add(new Pending(done));
        requestedAt = android.os.SystemClock.elapsedRealtime();
        activity.getSharedPreferences(PREFERENCES, Activity.MODE_PRIVATE).edit().putBoolean(REQUESTED, true).apply();
        activity.requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQUEST_CODE);
    }

    /**
     * Fallback for a host activity that does not forward onRequestPermissionsResult: the system
     * dialog pauses the activity, so the following resume is the answer. The short guard keeps a
     * call issued without a dialog from resolving immediately.
     */
    public void settlePermission() {
        if (permissionWaiters.isEmpty() || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (android.os.SystemClock.elapsedRealtime() - requestedAt < 350) return;
        List<Pending> pending = new ArrayList<>(permissionWaiters);
        permissionWaiters.clear();
        String status = authorization();
        for (Pending waiter : pending) waiter.done.accept(status);
    }

    /** MainActivity.onRequestPermissionsResult handoff; returns whether this bridge owned the request. */
    public boolean onRequestPermissionsResult(int requestCode, int[] grantResults) {
        if (requestCode != REQUEST_CODE) return false;
        List<Pending> pending = new ArrayList<>(permissionWaiters);
        permissionWaiters.clear();
        String status = authorization();
        for (Pending waiter : pending) waiter.done.accept(status);
        return true;
    }

    public boolean openSettings() {
        try {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            return true;
        } catch (RuntimeException first) {
            try {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.fromParts("package", activity.getPackageName(), null))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(intent);
                return true;
            } catch (RuntimeException second) {
                return false;
            }
        }
    }

    /** Posts one local notification whose tap carries only {v:1, receipt}. */
    public boolean post(String identifier, String receipt, String title, String body) {
        if (manager == null) return false;
        Intent intent = new Intent(activity, activity.getClass())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_VERSION, 1)
                .putExtra(EXTRA_RECEIPT, receipt);
        PendingIntent content = PendingIntent.getActivity(activity, code(identifier), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(activity, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_EVENT)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setContentIntent(content);
        try {
            manager.notify(identifier, code(identifier), builder.build());
            return true;
        } catch (SecurityException denied) {
            return false;
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    public void cancel(String identifier) {
        if (manager == null) return;
        Integer code = requestCodes.remove(identifier);
        manager.cancel(identifier, code == null ? identifier.hashCode() : code);
    }

    /** Active notifications are both this platform's pending and delivered set. */
    public Set<String> activeIdentifiers() {
        Set<String> out = new LinkedHashSet<>();
        if (manager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return out;
        StatusBarNotification[] active = manager.getActiveNotifications();
        if (active == null) return out;
        for (StatusBarNotification entry : active) {
            String tag = entry.getTag();
            out.add(tag != null ? tag : entry.getKey());
        }
        return out;
    }

    private int code(String identifier) {
        Integer existing = requestCodes.get(identifier);
        if (existing != null) return existing;
        int code = nextRequestCode++;
        requestCodes.put(identifier, code);
        return code;
    }
}
