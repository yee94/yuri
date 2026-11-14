package com.yee94.yuri.nsh;

import android.app.Activity;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

/**
 * {@code camera.scan}: resolves a scanned pairing link, or null when the user cancels.
 *
 * <p>Rejects with {@code camera_scan_unsupported} because no QR decoder is bundled: see
 * {@link QrScanner}. One scan at a time; the caller owns the camera dialog's lifetime.
 */
public final class QrScannerBridge {
    private final Activity activity;
    private NshView view;
    private NshHostReply pending;

    public QrScannerBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.view = view;
    }

    public void install() {
        NshView target = view;
        if (target == null) return;
        target.handle("camera.scan", (data, reply) -> scan(reply));
    }

    /** Drops the pending call; the camera dialog still ends through its own cancel. */
    public void invalidate() {
        NshHostReply target;
        synchronized (this) {
            target = pending;
            pending = null;
        }
        if (target != null) target.reject("请求已取消");
    }

    private void scan(NshHostReply reply) {
        synchronized (this) {
            if (view == null) {
                reply.reject(RuntimeHostScopeFailure.BACKGROUND);
                return;
            }
            if (pending != null) {
                reply.reject("camera_scan_busy");
                return;
            }
            pending = reply;
        }
        QrScanner.scan(activity, (value, failure) -> {
            NshHostReply target;
            synchronized (this) {
                target = pending;
                pending = null;
            }
            if (target == null) return;
            if (failure != null) target.reject(failure);
            else target.resolve(value);
        });
    }
}
