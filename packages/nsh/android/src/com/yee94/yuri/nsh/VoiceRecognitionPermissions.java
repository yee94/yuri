package com.yee94.yuri.nsh;

import android.app.Activity;
import android.content.pm.PackageManager;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Android record-permission admission for {@link VoiceRecognitionRecorder}. iOS resolves this through
 * AVAudioSession's completion; Android needs the host activity to forward the system result:
 * call {@link #dispatch(int, String[], int[])} from {@code MainActivity.onRequestPermissionsResult}
 * (it returns whether a pending voice request was settled). Without that forwarding the request
 * times out and the start fails with {@code permissionDenied} rather than recording silently.
 */
public final class VoiceRecognitionPermissions {
    private static final AtomicInteger NEXT = new AtomicInteger(0x5900);
    private static final long TIMEOUT_MILLIS = 60_000;
    private static final Map<Integer, CountDownLatch> PENDING = new ConcurrentHashMap<>();

    private VoiceRecognitionPermissions() {}

    public static boolean granted(Activity activity, String permission) {
        return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** Requests from the UI thread and waits for the forwarded system result. */
    public static boolean request(Activity activity, String permission) {
        CountDownLatch latch = new CountDownLatch(1);
        int code = NEXT.getAndIncrement();
        PENDING.put(code, latch);
        Runnable request = () -> {
            try {
                activity.requestPermissions(new String[] { permission }, code);
            } catch (RuntimeException error) {
                settle(code);
            }
        };
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) request.run();
        else activity.runOnUiThread(request);
        try {
            return latch.await(TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
                    && granted(activity, permission);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        } finally {
            PENDING.remove(code);
        }
    }

    /** Returns true when this code belonged to a pending voice request. */
    public static boolean dispatch(int requestCode, String[] permissions, int[] grantResults) {
        CountDownLatch latch = PENDING.remove(requestCode);
        if (latch == null) return false;
        latch.countDown();
        return true;
    }

    private static void settle(int code) {
        CountDownLatch latch = PENDING.remove(code);
        if (latch != null) latch.countDown();
    }
}
