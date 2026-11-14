package com.yee94.yuri.nsh;

import android.app.Activity;
import android.content.Intent;

import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * App-wide launch ingress, the counterpart of iOS NotificationLaunchDelegate.
 *
 * <p>Install it in MainActivity.onCreate before the TSX bundle loads
 * ({@link NotificationBridge#installLaunch(Activity)}), then forward
 * onCreate/onNewIntent intents with {@link #receive(Intent)}. A tap while the app was dead is kept as
 * an in-memory receipt when the protected store cannot be read yet, and is re-applied by the next peek.
 */
public final class NotificationLaunch {
    private static volatile NotificationLaunch shared;

    public static synchronized NotificationLaunch shared(Activity activity) {
        if (shared == null) {
            shared = new NotificationLaunch(new File(activity.getFilesDir(), "notification-launch/receipts.json"));
        }
        return shared;
    }

    /** The already installed owner, or null before {@link #shared(Activity)} ran. */
    public static NotificationLaunch installed() { return shared; }

    private final File file;
    private NotificationLaunchInbox inbox;
    private String pendingReceipt;
    private boolean failure;
    private Runnable changed;

    NotificationLaunch(File file) { this.file = file; }

    void changed(Runnable value) { changed = value; }

    boolean failure() { return failure; }

    /** Loads or re-reads the durable store and applies the newest retained tap. */
    public NotificationLaunchInbox refreshInbox() {
        try {
            if (inbox == null) inbox = new NotificationLaunchInbox(file);
            if (pendingReceipt != null) {
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("v", 1L);
                payload.put("receipt", pendingReceipt);
                inbox.receive("default", NotificationLaunchInbox.PREFIX + pendingReceipt, payload);
                pendingReceipt = null;
            }
            failure = false;
            return inbox;
        } catch (NotificationFailure error) {
            failure = true;
            return null;
        }
    }

    /** The last successfully loaded store; never triggers a read. */
    public NotificationLaunchInbox inbox() { return inbox; }

    /** OS tap: default action, module identifier and a {v:1,receipt} payload only. */
    public boolean receive(String action, String identifier, Map<?, ?> payload) {
        String receipt = NotificationPolicy.receipt(payload);
        if (!"default".equals(action) || receipt == null || !identifier.equals(NotificationLaunchInbox.PREFIX + receipt)) {
            return false;
        }
        pendingReceipt = receipt;
        NotificationLaunchInbox current = refreshInbox();
        NotificationLaunchInbox.Record pending = current == null ? null : current.pending();
        boolean accepted = pending != null && pending.receipt.equals(receipt);
        if (changed != null) changed.run();
        return accepted;
    }

    /** onCreate/onNewIntent handoff; returns whether this intent carried one of our taps. */
    public boolean receive(Intent intent) {
        if (intent == null || !intent.hasExtra(NotificationSystem.EXTRA_RECEIPT)) return false;
        String receipt = intent.getStringExtra(NotificationSystem.EXTRA_RECEIPT);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("v", 1L);
        payload.put("receipt", receipt);
        return receive("default", NotificationLaunchInbox.PREFIX + receipt, payload);
    }
}
