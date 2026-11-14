package com.yee94.yuri.nsh;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

/**
 * Ported from VoiceRecognitionBridge in ios/VoiceRecognitionBridge.swift: NSH Speech listens to the
 * same recorder owner and every interruption, route loss or background transition retires it.
 *
 * <p>iOS observes AVAudioSession interruption/route/reset notifications; Android has no such session,
 * so the bridge observes {@link AudioManager#ACTION_AUDIO_BECOMING_NOISY} (unplugging headphones)
 * plus the activity's foreground handoff.
 */
public final class VoiceRecognitionBridge {
    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;
    private final VoiceRecognitionCore core;
    private final ExecutorService io;
    private Runnable beforeCapture = () -> {};
    private BroadcastReceiver noisy;
    private volatile boolean destroyed;

    public VoiceRecognitionBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
        this.io = Executors.newCachedThreadPool(daemon());
        this.core = new VoiceRecognitionCore(leases,
                () -> new VoiceRecognitionRecorder(activity),
                () -> {
                    Runnable hook = beforeCapture;
                    if (hook != null) hook.run();
                },
                new VoiceRecognitionCore.Listener() {
                    @Override public void partial(String owner, int revision, String text) {
                        Map<String, Object> payload = new LinkedHashMap<>();
                        payload.put("owner", owner);
                        payload.put("revision", (long) revision);
                        payload.put("text", text);
                        view.send("voiceRecognition.partial", payload);
                    }

                    @Override public void invalidated(String owner, int revision) {
                        Map<String, Object> payload = new LinkedHashMap<>();
                        payload.put("owner", owner);
                        payload.put("revision", (long) revision);
                        view.send("voiceRecognition.invalidated", payload);
                    }
                });
    }

    private static ThreadFactory daemon() {
        return runnable -> {
            Thread thread = new Thread(runnable, "yuri-voice");
            thread.setDaemon(true);
            return thread;
        };
    }

    /** Called on explicit start admission so the shared TTS owner stops before the microphone. */
    public void setBeforeCapture(Runnable hook) {
        this.beforeCapture = hook == null ? () -> {} : hook;
    }

    public void install() {
        view.handle("voiceRecognition.capabilities", (data, reply) -> {
            try {
                if (!(data instanceof Map) || !((Map<?, ?>) data).isEmpty()) throw VoiceRecognitionFailure.of("invalid");
                reply.resolve(capabilities());
            } catch (VoiceRecognitionFailure failure) {
                reply.reject(failure.code);
            }
        });
        view.handle("voiceRecognition.start", (data, reply) -> dispatch(() -> core.start(data), reply));
        view.handle("voiceRecognition.finish", (data, reply) -> dispatch(() -> {
            VoiceRecognitionCore.Request request = VoiceRecognitionCore.Request.parse(data, false);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("text", core.finish(request.owner, request.revision));
            return result;
        }, reply));
        view.handle("voiceRecognition.cancel", (data, reply) -> dispatch(() -> {
            VoiceRecognitionCore.Request request = VoiceRecognitionCore.Request.parse(data, false);
            core.cancel(request.owner, request.revision);
            return null;
        }, reply));
        observeRouteLoss();
    }

    private static Map<String, Object> capabilities() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("providers", List.of("local", "openai-compatible", "volcengine"));
        value.put("maximumSeconds", (long) VoiceRecognitionCore.MAXIMUM_SECONDS);
        value.put("maximumBytes", (long) VoiceRecognitionCore.MAXIMUM_BYTES);
        return value;
    }

    /** onResume/onPause; leaving the foreground retires the exact lease. */
    public void setForeground(boolean active) {
        core.setForeground(active);
        if (!active) core.invalidate();
    }

    public void invalidate() {
        destroyed = true;
        core.invalidate();
        BroadcastReceiver receiver = noisy;
        noisy = null;
        if (receiver != null) {
            try {
                activity.unregisterReceiver(receiver);
            } catch (RuntimeException ignored) {
                // The activity may already be torn down.
            }
        }
        io.shutdownNow();
    }

    private void observeRouteLoss() {
        if (destroyed) return;
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) core.invalidate();
            }
        };
        try {
            activity.registerReceiver(receiver, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
            noisy = receiver;
        } catch (RuntimeException error) {
            // Without a receiver the lease still retires on background or Host changes.
            noisy = null;
        }
    }

    private void dispatch(Call call, NshHostReply reply) {
        try {
            io.execute(() -> {
                try {
                    reply.resolve(call.run());
                } catch (VoiceRecognitionFailure failure) {
                    reply.reject(failure.code);
                } catch (RuntimeException error) {
                    reply.reject("transport");
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException error) {
            reply.reject("cancelled");
        }
    }

    private interface Call {
        Object run() throws VoiceRecognitionFailure;
    }
}
