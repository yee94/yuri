package com.yee94.yuri.nsh;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Ported from SpeechPlaybackBridge in ios/SpeechPlaybackBridge.swift: one page lease, one native
 * player. data-only settings, browser provider through the system synthesizer, Host providers
 * through their existing TTS route.
 *
 * <p>Android has no AVAudioSession/AVAudioUnitVarispeed: {@link android.speech.tts.TextToSpeech}
 * replaces AVSpeechSynthesizer, {@link MediaPlayer} plus {@link android.media.PlaybackParams} (speed
 * and pitch together) replaces AVAudioPlayer/Varispeed, and the synthesizer exposes no per-utterance
 * volume, so {@code speechVolume} applies only to Host audio. {@code speech.awake} keeps the iOS
 * unsupported reply because no releasable app-wide idle-timer assertion exists.
 */
public final class SpeechPlaybackBridge {
    /** RuntimeBridge capability: authenticated POST of a text/plain TTS body. */
    public interface TextPost {
        HostLease.RawResponse postText(String path, String text) throws Exception;
    }

    private static final long PLAYBACK_TIMEOUT_MILLIS = 180_000;

    /** Data-only allowlist, ported from NativeSpeechSettings. */
    static final class Settings {
        static final List<String> PROVIDERS = List.of("browser", "local", "say", "openai", "openai-compatible", "volcengine");
        static final List<String> MODES = List.of("final", "sanitized", "raw", "summarized");

        final String provider;
        final String mode;
        final boolean visible;
        final double rate;
        final double pitch;
        final double volume;
        final String voice;

        private Settings(String provider, String mode, boolean visible, double rate, double pitch, double volume, String voice) {
            this.provider = provider;
            this.mode = mode;
            this.visible = visible;
            this.rate = rate;
            this.pitch = pitch;
            this.volume = volume;
            this.voice = voice;
        }

        static Settings parse(Map<String, Object> value) throws SpeechFailure {
            Object provider = value.get("voiceProvider");
            if (!(provider instanceof String) || !PROVIDERS.contains(provider)) throw SpeechFailure.of("invalid");
            Object mode = value.get("ttsInputMode");
            if (!(mode instanceof String) || !MODES.contains(mode)) throw SpeechFailure.of("invalid");
            if (!(value.get("showMessageTTSButtons") instanceof Boolean)) throw SpeechFailure.of("invalid");
            Object voice = value.get("browserVoice");
            if (voice != null && !(voice instanceof String)) throw SpeechFailure.of("invalid");
            return new Settings((String) provider, (String) mode, (Boolean) value.get("showMessageTTSButtons"),
                    number(value, "speechRate", 0.5, 2), number(value, "speechPitch", 0.5, 2),
                    number(value, "speechVolume", 0, 1), voice == null ? "" : (String) voice);
        }

        private static double number(Map<String, Object> value, String key, double minimum, double maximum) throws SpeechFailure {
            Object raw = value.get(key);
            if (!(raw instanceof Number) || raw instanceof Boolean) throw SpeechFailure.of("invalid");
            double number = ((Number) raw).doubleValue();
            if (Double.isNaN(number) || Double.isInfinite(number) || number < minimum || number > maximum) {
                throw SpeechFailure.of("invalid");
            }
            return number;
        }

        String route() {
            switch (provider) {
                case "browser": return null;
                case "local": return "/api/dictation/tts/speak";
                case "say": return "/api/tts/say/speak";
                default: return "/api/tts/speak";
            }
        }

        Map<String, Object> publicValue() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("provider", provider);
            value.put("mode", mode);
            value.put("visible", visible);
            return value;
        }
    }

    /** Ported from NativeSpeechSegment. */
    static final class Segment {
        final String text;
        final int revision;
        final String source;

        private Segment(String text, int revision, String source) {
            this.text = text;
            this.revision = revision;
            this.source = source;
        }

        static Segment parse(Object input, String owner, int revision) throws SpeechFailure {
            if (!(input instanceof Map)) throw SpeechFailure.of("invalid");
            Map<?, ?> value = (Map<?, ?>) input;
            if (!Set.of("owner", "revision", "text", "source").containsAll(value.keySet())) throw SpeechFailure.of("invalid");
            if (!owner.equals(value.get("owner")) || owner.isEmpty()) throw SpeechFailure.of("invalid");
            Long next = TerminalProtocol.integer(value.get("revision"));
            if (next == null || next <= revision) throw SpeechFailure.of("invalid");
            Object text = value.get("text");
            if (!(text instanceof String) || ((String) text).trim().isEmpty()
                    || TerminalCatalogStore.utf8((String) text) > 4096) {
                throw SpeechFailure.of("invalid");
            }
            Object source = value.containsKey("source") ? value.get("source") : "manual";
            if (!(source instanceof String) || !Set.of("manual", "auto-read", "settings-preview").contains(source)) {
                throw SpeechFailure.of("invalid");
            }
            return new Segment((String) text, next.intValue(), (String) source);
        }

        void validatePlayback(boolean visible, boolean current, boolean foreground) throws SpeechFailure {
            if (!(visible || source.equals("auto-read") || source.equals("settings-preview")) || !current || !foreground) {
                throw SpeechFailure.of("invalid");
            }
        }
    }

    /** Ported from NativeSpeechAwakeRequest: the awake flag stays explicitly unsupported. */
    static final class AwakeRequest {
        final int revision;
        final boolean enabled;

        private AwakeRequest(int revision, boolean enabled) {
            this.revision = revision;
            this.enabled = enabled;
        }

        static AwakeRequest parse(Object input, String owner, int revision) throws SpeechFailure {
            if (!(input instanceof Map)) throw SpeechFailure.of("invalid");
            Map<?, ?> value = (Map<?, ?>) input;
            if (!value.keySet().equals(Set.of("owner", "revision", "enabled"))) throw SpeechFailure.of("invalid");
            if (!owner.equals(value.get("owner")) || owner.isEmpty()) throw SpeechFailure.of("invalid");
            Long next = TerminalProtocol.integer(value.get("revision"));
            if (next == null || next <= revision) throw SpeechFailure.of("invalid");
            Object enabled = value.get("enabled");
            if (!(enabled instanceof Boolean)) throw SpeechFailure.of("invalid");
            return new AwakeRequest(next.intValue(), (Boolean) enabled);
        }

        Map<String, Object> response(boolean current, boolean foreground) throws SpeechFailure {
            if (enabled && !(current && foreground)) throw SpeechFailure.of("invalid");
            // No releasable app-wide idle-timer assertion exists here either; report the gap and
            // never mutate another feature's screen-on request.
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("supported", false);
            value.put("enabled", false);
            return value;
        }
    }

    /** Ported from NativeSpeechAudio: the Host headers can only weaken, never invent, settings. */
    static final class Audio {
        final double pitch;
        final double volume;
        final byte[] bytes;

        Audio(HostLease.RawResponse response, Settings settings) throws SpeechFailure {
            if (response == null) throw SpeechFailure.of("audio");
            if (response.status < 200 || response.status >= 300) throw SpeechFailure.of("audio");
            if (response.mime == null || !response.mime.toLowerCase(Locale.ROOT).startsWith("audio/")) {
                throw SpeechFailure.of("audio");
            }
            if (response.data == null || response.data.length == 0 || response.data.length > 16 * 1024 * 1024) {
                throw SpeechFailure.of("audio");
            }
            // An absent header uses the exact settings value; a present one must parse and stay in
            // range, so a malformed or stronger Host value fails instead of inventing playback.
            pitch = header(response.header("x-speech-pitch"), settings.pitch, 0.5, 2);
            volume = header(response.header("x-speech-volume"), settings.volume, 0, 1);
            bytes = response.data;
        }

        private static double header(String value, double fallback, double minimum, double maximum) throws SpeechFailure {
            if (value == null) return fallback;
            double parsed;
            try {
                parsed = Double.parseDouble(value);
            } catch (NumberFormatException error) {
                throw SpeechFailure.of("audio");
            }
            if (Double.isNaN(parsed) || Double.isInfinite(parsed) || parsed < minimum || parsed > maximum) {
                throw SpeechFailure.of("audio");
            }
            return parsed;
        }
    }

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;
    private final ExecutorService io;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private final AtomicInteger utterances = new AtomicInteger();
    private Settings settings;
    private String owner = "";
    private int revision;
    private int awakeRevision;
    private long preparing;
    private volatile boolean foreground = true;
    private volatile boolean destroyed;
    private TextToSpeech tts;
    private MediaPlayer player;
    private File temporary;
    private CountDownLatch completion;
    private SpeechFailure completionFailure;
    private HostLease transportLease;
    private BroadcastReceiver noisy;

    public SpeechPlaybackBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
        this.io = Executors.newCachedThreadPool(daemon());
    }

    private static ThreadFactory daemon() {
        return runnable -> {
            Thread thread = new Thread(runnable, "yuri-speech");
            thread.setDaemon(true);
            return thread;
        };
    }

    public void install() {
        view.handle("speech.voices", (data, reply) -> dispatch(() -> SpeechVoiceCatalogPolicy.read(data, leases,
                () -> foreground, () -> {
                    TextToSpeech engine = ensureTts();
                    List<SpeechVoiceCatalogPolicy.Identity> voices = new ArrayList<>();
                    for (android.speech.tts.Voice voice : engine.getVoices()) {
                        voices.add(new SpeechVoiceCatalogPolicy.Identity(voice.getName(), voice.getName(),
                                voice.getLocale().toLanguageTag()));
                    }
                    return voices;
                }), reply));
        view.handle("speech.prepare", (data, reply) -> dispatch(() -> prepare(data), reply));
        view.handle("speech.segment", (data, reply) -> dispatch(() -> {
            segment(data);
            return null;
        }, reply));
        view.handle("speech.stop", (data, reply) -> dispatch(() -> {
            if (!(data instanceof Map)) return null;
            Map<?, ?> value = (Map<?, ?>) data;
            if (!value.keySet().equals(Set.of("owner", "revision"))) return null;
            Long next = TerminalProtocol.integer(value.get("revision"));
            synchronized (lock) {
                if (!owner.equals(value.get("owner")) || next == null || next < revision) return null;
                revision = next.intValue();
            }
            stop();
            return null;
        }, reply));
        view.handle("speech.release", (data, reply) -> dispatch(() -> {
            Object value = data instanceof Map ? ((Map<?, ?>) data).get("owner") : null;
            String current;
            synchronized (lock) {
                current = owner;
            }
            if (!current.isEmpty() && current.equals(value)) invalidate();
            return null;
        }, reply));
        view.handle("speech.awake", (data, reply) -> dispatch(() -> {
            AwakeRequest request;
            int currentRevision;
            String currentOwner;
            boolean current;
            synchronized (lock) {
                currentOwner = owner;
                currentRevision = awakeRevision;
            }
            request = AwakeRequest.parse(data, currentOwner, currentRevision);
            boolean hasSettings;
            boolean currentLease;
            synchronized (lock) {
                hasSettings = settings != null;
                currentLease = transportLease != null && transportLease.isCurrent();
            }
            current = hasSettings && currentLease;
            Map<String, Object> response = request.response(current, foreground);
            synchronized (lock) {
                awakeRevision = request.revision;
            }
            return response;
        }, reply));
        observeRouteLoss();
    }

    /** onResume/onPause: hidden or backgrounded speech never keeps playing. */
    public void setForeground(boolean active) {
        foreground = active;
        if (!active) invalidate();
    }

    public void invalidate() {
        String previous;
        synchronized (lock) {
            previous = owner;
            owner = "";
            preparing++;
            settings = null;
            transportLease = null;
            revision = 0;
            awakeRevision = 0;
        }
        stop();
        if (!previous.isEmpty()) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("owner", previous);
            view.send("speech.invalidated", payload);
        }
    }

    /** Called from bridge shutdown. */
    public void release() {
        destroyed = true;
        invalidate();
        BroadcastReceiver receiver = noisy;
        noisy = null;
        if (receiver != null) {
            try {
                activity.unregisterReceiver(receiver);
            } catch (RuntimeException ignored) {
                // The activity may already be gone.
            }
        }
        TextToSpeech engine = tts;
        tts = null;
        if (engine != null) onMain(engine::shutdown);
        io.shutdownNow();
    }

    private Map<String, Object> prepare(Object data) throws SpeechFailure {
        if (!(data instanceof Map)) throw SpeechFailure.of("invalid");
        Map<?, ?> value = (Map<?, ?>) data;
        if (!value.keySet().equals(Set.of("owner"))) throw SpeechFailure.of("invalid");
        Object ownerValue = value.get("owner");
        if (!(ownerValue instanceof String) || ((String) ownerValue).isEmpty()
                || TerminalCatalogStore.utf8((String) ownerValue) > 128) {
            throw SpeechFailure.of("invalid");
        }
        invalidate();
        long ticket;
        synchronized (lock) {
            ticket = ++preparing;
        }
        HostLease captured;
        try {
            captured = leases.capture(null);
        } catch (Exception error) {
            throw SpeechFailure.of("unavailable");
        }
        if (captured == null) throw SpeechFailure.of("unavailable");
        HostLease.JsonResponse response;
        try {
            response = captured.json("/api/voice/settings", "GET", null).get(90, TimeUnit.SECONDS);
        } catch (Exception error) {
            throw SpeechFailure.of("unavailable");
        }
        boolean current;
        synchronized (lock) {
            current = preparing == ticket;
        }
        if (!current || !captured.isCurrent() || !foreground) throw SpeechFailure.of("cancelled");
        if (response.status < 200 || response.status >= 300) throw SpeechFailure.of("unavailable");
        Settings parsed = Settings.parse(TerminalTransport.map(response.body));
        synchronized (lock) {
            this.owner = (String) ownerValue;
            this.transportLease = captured;
            this.settings = parsed;
            this.preparing = 0;
        }
        return parsed.publicValue();
    }

    private void segment(Object data) throws SpeechFailure {
        String capturedOwner;
        int currentRevision;
        Settings currentSettings;
        HostLease transport;
        synchronized (lock) {
            capturedOwner = owner;
            currentRevision = revision;
            currentSettings = settings;
            transport = transportLease;
        }
        Segment segment = Segment.parse(data, capturedOwner, currentRevision);
        if (currentSettings == null || transport == null) throw SpeechFailure.of("invalid");
        segment.validatePlayback(currentSettings.visible, transport.isCurrent(), foreground);
        stop();
        synchronized (lock) {
            revision = segment.revision;
        }
        final int next = segment.revision;
        final Settings capturedSettings = currentSettings;
        final HostLease capturedTransport = transport;
        Current current = () -> {
            synchronized (lock) {
                if (!owner.equals(capturedOwner) || revision != next) return false;
            }
            return capturedTransport.isCurrent() && foreground;
        };
        try {
            byte[] bytes = null;
            Audio audio = null;
            String route = capturedSettings.route();
            if (route != null) {
                if (!(transport instanceof TextPost)) throw SpeechFailure.of("unavailable");
                HostLease.RawResponse response;
                try {
                    response = ((TextPost) transport).postText(route, segment.text);
                } catch (Exception error) {
                    throw SpeechFailure.of("audio");
                }
                if (!current.get()) throw SpeechFailure.of("cancelled");
                audio = new Audio(response, capturedSettings);
                bytes = audio.bytes;
            }
            if (!current.get()) throw SpeechFailure.of("cancelled");
            if (bytes != null) {
                play(bytes, audio, capturedOwner, next, current);
            } else {
                speak(segment.text, capturedSettings, capturedOwner, next, current);
            }
            if (!current.get()) throw SpeechFailure.of("cancelled");
        } catch (SpeechFailure failure) {
            if (current.get()) stop();
            if (failure.unavailable()) throw failure;
            throw failure.code.equals("cancelled") ? failure : SpeechFailure.of("audio");
        }
    }

    /** Host audio: MediaPlayer, with speed and pitch moved together like Web playbackRate. */
    private void play(byte[] bytes, Audio audio, String capturedOwner, int next, Current current) throws SpeechFailure {
        File file = new File(activity.getCacheDir(), "yuri-speech-" + UUID.randomUUID().toString() + ".audio");
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
            output.getFD().sync();
        } catch (IOException error) {
            throw SpeechFailure.of("audio");
        }
        synchronized (lock) {
            temporary = file;
            completion = new CountDownLatch(1);
            completionFailure = null;
        }
        MediaPlayer created = new MediaPlayer();
        synchronized (lock) {
            player = created;
        }
        created.setOnCompletionListener(ignored -> complete(null));
        created.setOnErrorListener((ignored, what, extra) -> {
            complete(SpeechFailure.of("audio"));
            return true;
        });
        try {
            created.setDataSource(file.getPath());
            created.setVolume((float) audio.volume, (float) audio.volume);
            created.prepare();
            if (audio.pitch != 1) {
                android.media.PlaybackParams params = created.getPlaybackParams();
                params.setSpeed((float) audio.pitch);
                params.setPitch((float) audio.pitch);
                created.setPlaybackParams(params);
            }
            created.start();
        } catch (IOException | RuntimeException error) {
            throw SpeechFailure.of("audio");
        }
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("owner", capturedOwner);
        event.put("revision", (long) next);
        view.send("speech.playing", event);
        await(current);
    }

    /** Browser provider: the device synthesizer, resolved by exact unique voice name. */
    private void speak(String text, Settings settings, String capturedOwner, int next, Current current) throws SpeechFailure {
        TextToSpeech engine = ensureTts();
        android.speech.tts.Voice voice = null;
        java.util.Set<android.speech.tts.Voice> voices = engine.getVoices();
        if (voices != null) {
            List<android.speech.tts.Voice> matches = new ArrayList<>();
            if (!settings.voice.isEmpty()) {
                for (android.speech.tts.Voice candidate : voices) {
                    if (candidate.getName().equals(settings.voice)) matches.add(candidate);
                }
                if (matches.size() != 1) throw SpeechFailure.of("unavailable");
                voice = matches.get(0);
            }
        } else if (!settings.voice.isEmpty()) {
            throw SpeechFailure.of("unavailable");
        }
        synchronized (lock) {
            completion = new CountDownLatch(1);
            completionFailure = null;
        }
        android.speech.tts.Voice selected = voice;
        try {
            engine.setSpeechRate((float) settings.rate);
            engine.setPitch((float) settings.pitch);
            if (selected != null) engine.setVoice(selected);
        } catch (RuntimeException error) {
            throw SpeechFailure.of("unavailable");
        }
        String utterance = "yuri-" + utterances.incrementAndGet();
        int result;
        try {
            result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utterance);
        } catch (RuntimeException error) {
            throw SpeechFailure.of("unavailable");
        }
        if (result != TextToSpeech.SUCCESS) throw SpeechFailure.of("unavailable");
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("owner", capturedOwner);
        event.put("revision", (long) next);
        view.send("speech.playing", event);
        await(current);
    }

    private TextToSpeech ensureTts() throws SpeechFailure {
        TextToSpeech existing = tts;
        if (existing != null) return existing;
        final CountDownLatch ready = new CountDownLatch(1);
        final int[] status = { TextToSpeech.ERROR };
        onMain(() -> {
            final TextToSpeech[] holder = new TextToSpeech[1];
            holder[0] = new TextToSpeech(activity, code -> {
                status[0] = code;
                if (code == TextToSpeech.SUCCESS) {
                    holder[0].setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override public void onStart(String utteranceId) {
                            // speech.playing is emitted by the caller that started playback.
                        }

                        @Override public void onDone(String utteranceId) {
                            complete(null);
                        }

                        @Override public void onError(String utteranceId) {
                            complete(SpeechFailure.of("audio"));
                        }

                        @Override public void onError(String utteranceId, int errorCode) {
                            complete(SpeechFailure.of("audio"));
                        }
                    });
                    tts = holder[0];
                }
                ready.countDown();
            });
        });
        try {
            if (!ready.await(10, TimeUnit.SECONDS)) throw SpeechFailure.of("unavailable");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw SpeechFailure.of("cancelled");
        }
        TextToSpeech engine = tts;
        if (status[0] != TextToSpeech.SUCCESS || engine == null) throw SpeechFailure.of("unavailable");
        return engine;
    }

    /** Waits for the current playback, bounded by the same 180 s watchdog as iOS. */
    private void await(Current current) throws SpeechFailure {
        CountDownLatch pending;
        synchronized (lock) {
            pending = completion;
        }
        if (pending == null) throw SpeechFailure.of("audio");
        boolean done;
        try {
            done = pending.await(PLAYBACK_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw SpeechFailure.of("cancelled");
        }
        SpeechFailure failure;
        synchronized (lock) {
            failure = completionFailure;
        }
        if (!current.get()) throw SpeechFailure.of("cancelled");
        if (!done) throw SpeechFailure.of("audio");
        if (failure != null) throw failure;
    }

    private void complete(SpeechFailure failure) {
        CountDownLatch pending;
        synchronized (lock) {
            if (failure != null && completionFailure == null) completionFailure = failure;
            pending = completion;
            completion = null;
        }
        if (pending != null) pending.countDown();
    }

    private void stop() {
        CountDownLatch pending;
        MediaPlayer playing;
        File file;
        TextToSpeech engine;
        synchronized (lock) {
            pending = completion;
            completion = null;
            completionFailure = null;
            playing = player;
            player = null;
            file = temporary;
            temporary = null;
            engine = tts;
        }
        onMain(() -> {
            if (engine != null) {
                try {
                    engine.stop();
                } catch (RuntimeException ignored) {
                    // The engine may already be gone.
                }
            }
            if (playing != null) {
                try {
                    playing.stop();
                } catch (RuntimeException ignored) {
                    // Stop is best effort; release follows.
                }
                try {
                    playing.release();
                } catch (RuntimeException ignored) {
                    // The player may already be released.
                }
            }
        });
        if (file != null && file.exists() && !file.delete()) file.deleteOnExit();
        if (pending != null) pending.countDown();
    }

    private void observeRouteLoss() {
        if (destroyed) return;
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                // A route addition need not stop playback; unplugging headphones must.
                if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) invalidate();
            }
        };
        try {
            activity.registerReceiver(receiver, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
            noisy = receiver;
        } catch (RuntimeException error) {
            noisy = null;
        }
    }

    private void onMain(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
            return;
        }
        CountDownLatch latch = new CountDownLatch(1);
        main.post(() -> {
            try {
                action.run();
            } finally {
                latch.countDown();
            }
        });
        try {
            latch.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private void dispatch(Call call, NshHostReply reply) {
        try {
            io.execute(() -> {
                try {
                    reply.resolve(call.run());
                } catch (SpeechFailure failure) {
                    reply.reject(failure.code);
                } catch (RuntimeException error) {
                    reply.reject("audio");
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException error) {
            reply.reject("unavailable");
        }
    }

    private interface Call {
        Object run() throws SpeechFailure;
    }

    /** Playback fence: the captured page lease, revision and foreground admission. */
    private interface Current {
        boolean get();
    }
}
