package com.yee94.yuri.nsh;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

/**
 * Ported from VoiceRecognitionCore (and its Request/Settings/PCM/Stream types) in
 * ios/VoiceRecognitionCore.swift. The owner is the production state machine: a cancelled start
 * cannot acquire audio, and a failed finish retains bounded PCM for an explicit retry with the same
 * captured provider, never a new microphone.
 *
 * <p>UIKit actors become synchronized state plus blocking deadlines on the caller's thread, so the
 * ordering rules stay explicit: admission before TTS stop, settings, permission and audio start.
 */
public final class VoiceRecognitionCore {
    public static final int SAMPLE_RATE = 16_000;
    public static final int MAXIMUM_SECONDS = 60;
    public static final int MAXIMUM_BYTES = SAMPLE_RATE * 2 * MAXIMUM_SECONDS;
    public static final int CHUNK_BYTES = 6_400;
    public static final List<String> PROVIDERS = List.of("local", "openai-compatible", "volcengine");

    public interface AudioFactory {
        VoiceRecognitionAudio create();
    }

    public interface Listener {
        void partial(String owner, int revision, String text);

        void invalidated(String owner, int revision);
    }

    /** Parsed outside the UI so admission-before-side-effect uses one production entrypoint. */
    static final class Request {
        final String owner;
        final int revision;
        final String provider;
        final HostLease.Scope expectedHost;

        private Request(String owner, int revision, String provider, HostLease.Scope expectedHost) {
            this.owner = owner;
            this.revision = revision;
            this.provider = provider;
            this.expectedHost = expectedHost;
        }

        static Request parse(Object input, boolean start) throws VoiceRecognitionFailure {
            if (!(input instanceof Map)) throw VoiceRecognitionFailure.of("invalid");
            Map<?, ?> object = (Map<?, ?>) input;
            Set<String> expected = start ? Set.of("owner", "revision", "provider", "expectedHost") : Set.of("owner", "revision");
            if (!object.keySet().equals(expected)) throw VoiceRecognitionFailure.of("invalid");
            Object owner = object.get("owner");
            if (!(owner instanceof String) || ((String) owner).isEmpty() || TerminalCatalogStore.utf8((String) owner) > 128) {
                throw VoiceRecognitionFailure.of("invalid");
            }
            Long revision = TerminalProtocol.integer(object.get("revision"));
            if (revision == null || revision <= 0) throw VoiceRecognitionFailure.of("invalid");
            Object provider = object.get("provider");
            if (start && !PROVIDERS.contains(provider)) throw VoiceRecognitionFailure.of("invalid");
            HostLease.Scope scope = start ? scopeOf(object.get("expectedHost")) : null;
            return new Request((String) owner, revision.intValue(), (String) provider, scope);
        }

        private static HostLease.Scope scopeOf(Object value) throws VoiceRecognitionFailure {
            try {
                return TerminalBridge.scope(value);
            } catch (TerminalFailure failure) {
                throw VoiceRecognitionFailure.of("invalid");
            }
        }
    }

    /** Saved non-secret ASR settings snapshot; the Host API exposes no config revision token. */
    static final class Settings {
        static final String[] KEYS = {
            "sttProvider", "configured", "sttApiKeyConfigured", "sttServerUrl", "sttModel",
            "sttLocalModel", "sttLanguage", "asrResourceId", "asrContext",
        };

        final String provider;
        final List<Object> authority;

        private Settings(String provider, List<Object> authority) {
            this.provider = provider;
            this.authority = authority;
        }

        static Settings parse(VoiceRecognitionRuntime.Response response, String expected) throws VoiceRecognitionFailure {
            if (response.status < 200 || response.status >= 300) throw VoiceRecognitionFailure.of("invalid");
            if (!response.mime.toLowerCase(java.util.Locale.ROOT).startsWith("application/json")) {
                throw VoiceRecognitionFailure.of("invalid");
            }
            if (response.encodedLength() > VoiceRecognitionRuntime.SETTINGS_LIMIT) throw VoiceRecognitionFailure.of("invalid");
            Object provider = response.body.get("sttProvider");
            if (!(provider instanceof String) || !PROVIDERS.contains(provider)) throw VoiceRecognitionFailure.of("invalid");
            if (!provider.equals(expected)) throw VoiceRecognitionFailure.of("settingsChanged");
            if (provider.equals("volcengine") && !Boolean.TRUE.equals(response.body.get("configured"))) {
                throw VoiceRecognitionFailure.of("unavailable");
            }
            if (provider.equals("openai-compatible")) {
                Object server = response.body.get("sttServerUrl");
                if (!(server instanceof String) || ((String) server).trim().isEmpty()) {
                    throw VoiceRecognitionFailure.of("unavailable");
                }
            }
            List<Object> snapshot = new ArrayList<>(KEYS.length);
            for (String key : KEYS) snapshot.add(response.body.get(key));
            return new Settings((String) provider, snapshot);
        }
    }

    /** WAV container and transcript parsing, ported from VoiceRecognitionPCM. */
    static final class Pcm {
        private Pcm() {}

        static byte[] wav(byte[] pcm) throws VoiceRecognitionFailure {
            if (pcm.length % 2 != 0 || pcm.length > MAXIMUM_BYTES) throw VoiceRecognitionFailure.of("limit");
            ByteArrayOutputStream out = new ByteArrayOutputStream(pcm.length + 44);
            out.writeBytes(new byte[] { 'R', 'I', 'F', 'F' });
            append(out, pcm.length + 36, 4);
            out.writeBytes(new byte[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' });
            append(out, 16, 4);
            append(out, 1, 2);
            append(out, 1, 2);
            append(out, SAMPLE_RATE, 4);
            append(out, 32_000, 4);
            append(out, 2, 2);
            append(out, 16, 2);
            out.writeBytes(new byte[] { 'd', 'a', 't', 'a' });
            append(out, pcm.length, 4);
            out.writeBytes(pcm);
            return out.toByteArray();
        }

        /** Chunk traversal validating the actual fmt block; null when the header is incomplete. */
        static Integer payloadOffset(byte[] data) throws VoiceRecognitionFailure {
            if (data.length < 12) return null;
            if (!ascii(data, 0, 4).equals("RIFF") || !ascii(data, 8, 12).equals("WAVE")) {
                throw VoiceRecognitionFailure.of("audio");
            }
            int offset = 12;
            boolean validFormat = false;
            while (offset + 8 <= data.length) {
                String kind = ascii(data, offset, offset + 4);
                int size = number(data, offset + 4, 4);
                if (kind.equals("data")) {
                    if (!validFormat) throw VoiceRecognitionFailure.of("audio");
                    return offset + 8;
                }
                if (size < 0 || size > 65_536) throw VoiceRecognitionFailure.of("audio");
                if (offset + 8 + size > data.length) return null;
                if (kind.equals("fmt ")) {
                    if (size < 16 || number(data, offset + 8, 2) != 1 || number(data, offset + 10, 2) != 1
                            || number(data, offset + 12, 4) != SAMPLE_RATE || number(data, offset + 20, 2) != 2
                            || number(data, offset + 22, 2) != 16) {
                        throw VoiceRecognitionFailure.of("audio");
                    }
                    validFormat = true;
                }
                offset += 8 + size + size % 2;
            }
            return null;
        }

        static String transcript(VoiceRecognitionRuntime.Response response) throws VoiceRecognitionFailure {
            if (response.status < 200 || response.status >= 300) throw VoiceRecognitionFailure.of("transport");
            if (!response.mime.toLowerCase(java.util.Locale.ROOT).startsWith("application/json")) {
                throw VoiceRecognitionFailure.of("transport");
            }
            if (response.encodedLength() > VoiceRecognitionRuntime.RESPONSE_LIMIT) throw VoiceRecognitionFailure.of("transport");
            Object text = response.body.get("transcript");
            if (!(text instanceof String) || TerminalCatalogStore.utf8((String) text) > 65_536) {
                throw VoiceRecognitionFailure.of("transport");
            }
            return (String) text;
        }

        private static void append(ByteArrayOutputStream out, int value, int bytes) {
            for (int i = 0; i < bytes; i++) out.write((value >>> (8 * i)) & 255);
        }

        private static String ascii(byte[] data, int from, int to) {
            return new String(data, from, to - from, StandardCharsets.US_ASCII);
        }

        private static int number(byte[] data, int offset, int count) {
            int value = 0;
            for (int i = 0; i < count; i++) value |= (data[offset + i] & 255) << (8 * i);
            return value;
        }
    }

    /** One dictation stream: bounded waits, tagged messages and an adaptive finish deadline. */
    static final class Stream {
        final VoiceRecognitionRuntime.Socket socket;
        final String id = UUID.randomUUID().toString();
        private final Current current;
        private final Partial partial;
        private Thread reader;
        private boolean ready;
        private boolean started;
        private boolean closed;
        private boolean finishing;
        private VoiceRecognitionFailure failure;
        private String text;
        private long finishDeadline;
        private int sequence;

        interface Current {
            boolean get();
        }

        interface Partial {
            void accept(String text);
        }

        Stream(VoiceRecognitionRuntime.Socket socket, Current current, Partial partial) {
            this.socket = socket;
            this.current = current;
            this.partial = partial;
            Thread thread = new Thread(this::read, "yuri-dictation-" + id);
            thread.setDaemon(true);
            reader = thread;
            thread.start();
        }

        void start() throws VoiceRecognitionFailure {
            waitFor(10_000, () -> ready);
            Map<String, Object> message = new LinkedHashMap<>();
            message.put("type", "start");
            message.put("dictationId", id);
            message.put("format", "audio/pcm;rate=16000;bits=16;channels=1");
            send(message);
            waitFor(15_000, () -> started);
        }

        void append(byte[] data) throws VoiceRecognitionFailure {
            for (int offset = 0; offset < data.length; offset += CHUNK_BYTES) {
                int end = Math.min(offset + CHUNK_BYTES, data.length);
                byte[] chunk = new byte[end - offset];
                System.arraycopy(data, offset, chunk, 0, chunk.length);
                int seq;
                synchronized (this) {
                    seq = sequence++;
                }
                Map<String, Object> message = new LinkedHashMap<>();
                message.put("type", "chunk");
                message.put("dictationId", id);
                message.put("seq", (long) seq);
                message.put("audio", android.util.Base64.encodeToString(chunk, android.util.Base64.NO_WRAP));
                send(message);
            }
        }

        String finish() throws VoiceRecognitionFailure {
            int finalSeq;
            synchronized (this) {
                finishing = true;
                finishDeadline = System.currentTimeMillis() + 30_000;
                finalSeq = sequence - 1;
            }
            Map<String, Object> message = new LinkedHashMap<>();
            message.put("type", "finish");
            message.put("dictationId", id);
            message.put("finalSeq", (long) finalSeq);
            send(message);
            while (true) {
                check();
                String value;
                long deadline;
                synchronized (this) {
                    value = text;
                    deadline = finishDeadline;
                }
                if (value != null) return value;
                if (System.currentTimeMillis() >= deadline) throw VoiceRecognitionFailure.of("transport");
                try {
                    Thread.sleep(10);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw VoiceRecognitionFailure.of("cancelled");
                }
            }
        }

        void cancel() {
            Thread thread;
            synchronized (this) {
                if (closed) return;
                closed = true;
                thread = reader;
                reader = null;
            }
            if (thread != null) thread.interrupt();
            socket.close();
        }

        private void send(Map<String, Object> object) throws VoiceRecognitionFailure {
            check();
            String text = TerminalProtocol.encode(object);
            socket.send(text);
            check();
        }

        private void check() throws VoiceRecognitionFailure {
            if (Thread.currentThread().isInterrupted()) throw VoiceRecognitionFailure.of("cancelled");
            boolean open;
            VoiceRecognitionFailure pending;
            synchronized (this) {
                open = !closed;
                pending = failure;
            }
            if (!open || !current.get()) throw VoiceRecognitionFailure.of("cancelled");
            if (pending != null) throw pending;
        }

        private void waitFor(long millis, java.util.function.BooleanSupplier condition) throws VoiceRecognitionFailure {
            long deadline = System.currentTimeMillis() + millis;
            while (true) {
                check();
                if (condition.getAsBoolean()) return;
                if (System.currentTimeMillis() >= deadline) throw VoiceRecognitionFailure.of("transport");
                try {
                    Thread.sleep(10);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw VoiceRecognitionFailure.of("cancelled");
                }
            }
        }

        private void read() {
            try {
                while (true) {
                    synchronized (this) {
                        if (closed) return;
                    }
                    String raw = socket.receive(305_000);
                    check();
                    Object parsed = TerminalJson.parse(raw);
                    if (!(parsed instanceof Map)) throw VoiceRecognitionFailure.of("transport");
                    Map<?, ?> value = (Map<?, ?>) parsed;
                    Object type = value.get("type");
                    if (!(type instanceof String)) throw VoiceRecognitionFailure.of("transport");
                    if (type.equals("ready")) {
                        synchronized (this) {
                            if (ready) throw VoiceRecognitionFailure.of("transport");
                            ready = true;
                        }
                        continue;
                    }
                    if (!id.equals(value.get("dictationId"))) throw VoiceRecognitionFailure.of("transport");
                    if (type.equals("ack")) {
                        Long seq = TerminalProtocol.integer(value.get("ackSeq"));
                        int currentSeq;
                        synchronized (this) {
                            currentSeq = sequence;
                        }
                        if (seq == null || seq < -1 || (seq >= currentSeq && seq != -1)) {
                            throw VoiceRecognitionFailure.of("transport");
                        }
                        if (seq == -1) {
                            synchronized (this) {
                                started = true;
                            }
                        }
                    } else if (type.equals("partial") || type.equals("final")) {
                        boolean isStarted;
                        boolean isFinishing;
                        synchronized (this) {
                            isStarted = started;
                            isFinishing = finishing;
                        }
                        Object text = value.get("text");
                        if (!isStarted || (type.equals("final") && !isFinishing)) {
                            throw VoiceRecognitionFailure.of("transport");
                        }
                        if (!(text instanceof String) || TerminalCatalogStore.utf8((String) text) > 65_536) {
                            throw VoiceRecognitionFailure.of("transport");
                        }
                        if (type.equals("final")) {
                            synchronized (this) {
                                this.text = (String) text;
                            }
                            return;
                        }
                        partial.accept((String) text);
                    } else if (type.equals("finish_accepted")) {
                        boolean isFinishing;
                        synchronized (this) {
                            isFinishing = finishing;
                        }
                        Double timeout = value.get("timeoutMs") instanceof Number
                                ? ((Number) value.get("timeoutMs")).doubleValue() : null;
                        if (!isFinishing || timeout == null || Double.isNaN(timeout) || Double.isInfinite(timeout)
                                || timeout < 1 || timeout > 300_000) {
                            throw VoiceRecognitionFailure.of("transport");
                        }
                        // Same bounded adaptive budget as the Host stream manager, plus a
                        // small transport margin; never shorten valid local ASR work.
                        synchronized (this) {
                            finishDeadline = System.currentTimeMillis() + (long) timeout.doubleValue() + 5_000;
                        }
                    } else {
                        throw VoiceRecognitionFailure.of("transport");
                    }
                }
            } catch (VoiceRecognitionFailure error) {
                synchronized (this) {
                    if (!closed) failure = error;
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private static final class Lease {
        final String owner;
        final int revision;
        final String provider;
        final VoiceRecognitionTransport transport;
        final VoiceRecognitionAudio audio;
        final ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        volatile Settings settings;
        volatile Stream stream;
        volatile boolean recording;
        boolean cancelled;
        boolean starting;
        volatile VoiceRecognitionFailure failure;
        volatile String result;
        Thread pump;
        Long recordingDeadline;
        CompletableFuture<String> processing;

        Lease(String owner, int revision, String provider, VoiceRecognitionTransport transport, VoiceRecognitionAudio audio) {
            this.owner = owner;
            this.revision = revision;
            this.provider = provider;
            this.transport = transport;
            this.audio = audio;
        }
    }

    private final HostLeaseProvider leases;
    private final AudioFactory audio;
    private final Runnable beforeCapture;
    private final Listener listener;
    private final Object lock = new Object();
    private volatile boolean foreground = true;
    private Lease lease;

    public VoiceRecognitionCore(HostLeaseProvider leases, AudioFactory audio, Runnable beforeCapture, Listener listener) {
        this.leases = leases;
        this.audio = audio;
        this.beforeCapture = beforeCapture;
        this.listener = listener;
    }

    public void setForeground(boolean active) {
        foreground = active;
    }

    public boolean isForeground() {
        return foreground;
    }

    public Map<String, Object> start(Object input) throws VoiceRecognitionFailure {
        Request request = Request.parse(input, true);
        return start(request.owner, request.revision, request.provider, request.expectedHost);
    }

    public Map<String, Object> start(String owner, int revision, String provider, HostLease.Scope expectedHost)
            throws VoiceRecognitionFailure {
        if (owner.isEmpty() || TerminalCatalogStore.utf8(owner) > 128 || revision <= 0
                || !PROVIDERS.contains(provider) || !foreground) {
            throw VoiceRecognitionFailure.of("invalid");
        }
        synchronized (lock) {
            // A page must cancel its exact prior lease before opening another one.
            if (lease != null) throw VoiceRecognitionFailure.of("unavailable");
        }
        HostLease captured;
        try {
            captured = leases.capture(expectedHost);
        } catch (Exception error) {
            throw VoiceRecognitionRuntime.failure(error);
        }
        if (captured == null || !captured.isCurrent()) throw VoiceRecognitionFailure.of("cancelled");
        // Capture performs native synchronous Host admission. It precedes TTS stop, the recorder
        // factory, settings GET, OS permission and audio start.
        if (beforeCapture != null) beforeCapture.run();
        if (!captured.isCurrent()) throw VoiceRecognitionFailure.of("cancelled");
        Lease value = new Lease(owner, revision, provider, VoiceRecognitionTransport.of(captured), audio.create());
        synchronized (lock) {
            value.starting = true;
            lease = value;
        }
        watch(value);
        try {
            prepare(value);
            synchronized (lock) {
                value.starting = false;
            }
            check(value);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("provider", provider);
            result.put("owner", owner);
            result.put("revision", (long) revision);
            return result;
        } catch (VoiceRecognitionFailure failure) {
            boolean owned;
            synchronized (lock) {
                owned = lease == value;
            }
            if (owned) {
                try {
                    cancel(owner, revision);
                } catch (VoiceRecognitionFailure ignored) {
                    // Failed cleanup keeps the cancelled lease for an explicit retry.
                }
            }
            throw failure;
        }
    }

    private void prepare(Lease value) throws VoiceRecognitionFailure {
        check(value);
        Settings settings = Settings.parse(value.transport.settings(), value.provider);
        check(value);
        value.settings = settings;
        if (!value.audio.permission()) throw VoiceRecognitionFailure.of("permissionDenied");
        check(value);
        if (!settings.provider.equals("openai-compatible")) value.stream = openStream(value);
        check(value);
        value.audio.start();
        value.recording = true;
        long deadline = now() + MAXIMUM_SECONDS * 1000L;
        value.recordingDeadline = deadline;
        Thread pump = new Thread(() -> pump(value, deadline), "yuri-dictation-pump");
        pump.setDaemon(true);
        synchronized (lock) {
            value.pump = pump;
        }
        pump.start();
    }

    private void pump(Lease value, long deadline) {
        try {
            while (true) {
                synchronized (lock) {
                    if (!value.recording) return;
                }
                Thread.sleep(200);
                check(value);
                synchronized (lock) {
                    if (!value.recording) return;
                }
                if (now() >= deadline) throw VoiceRecognitionFailure.of("limit");
                byte[] bytes = value.audio.readPCM();
                check(value);
                append(bytes, value);
                Stream stream;
                synchronized (lock) {
                    stream = value.stream;
                }
                if (stream != null) {
                    try {
                        stream.append(bytes);
                    } catch (VoiceRecognitionFailure failure) {
                        stream.cancel();
                        synchronized (lock) {
                            if (value.stream == stream) value.stream = null;
                        }
                    }
                }
            }
        } catch (VoiceRecognitionFailure failure) {
            boolean owned;
            synchronized (lock) {
                owned = lease == value && !value.cancelled && value.recording;
            }
            if (owned) invalidate();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private void watch(Lease value) {
        Thread watchdog = new Thread(() -> {
            while (true) {
                synchronized (lock) {
                    if (lease != value) return;
                }
                try {
                    Thread.sleep(200);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    return;
                }
                long instant = now();
                boolean expired;
                synchronized (lock) {
                    expired = value.recordingDeadline != null && instant >= value.recordingDeadline && value.recording;
                }
                if (!current(value) || expired) {
                    invalidate();
                    return;
                }
            }
        }, "yuri-dictation-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
    }

    public String finish(String owner, int revision) throws VoiceRecognitionFailure {
        Lease value;
        synchronized (lock) {
            value = lease;
        }
        if (value == null || !value.owner.equals(owner) || value.revision != revision) {
            throw VoiceRecognitionFailure.of("cancelled");
        }
        if (!current(value)) {
            cancel(owner, revision);
            throw VoiceRecognitionFailure.of("cancelled");
        }
        boolean starting;
        synchronized (lock) {
            starting = value.starting;
        }
        if (starting) throw VoiceRecognitionFailure.of("unavailable");
        CompletableFuture<String> future;
        boolean owner2 = false;
        synchronized (lock) {
            if (value.result != null) return value.result;
            if (value.processing == null) {
                value.processing = new CompletableFuture<>();
                owner2 = true;
            }
            future = value.processing;
        }
        if (owner2) {
            final CompletableFuture<String> pending = future;
            Thread thread = new Thread(() -> {
                try {
                    pending.complete(process(value));
                } catch (VoiceRecognitionFailure failure) {
                    pending.completeExceptionally(failure);
                } catch (RuntimeException error) {
                    pending.completeExceptionally(VoiceRecognitionFailure.of("transport"));
                }
            }, "yuri-dictation-finish");
            thread.setDaemon(true);
            thread.start();
        }
        try {
            return future.get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw VoiceRecognitionFailure.of("cancelled");
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof VoiceRecognitionFailure) throw (VoiceRecognitionFailure) cause;
            throw VoiceRecognitionRuntime.failure(cause == null ? error : cause);
        }
    }

    private String process(Lease value) throws VoiceRecognitionFailure {
        boolean recording;
        synchronized (lock) {
            recording = value.recording;
            value.recording = false;
        }
        if (recording) {
            // Stop the microphone before waiting for a slow socket, then join the sole
            // incremental reader before reading the flushed tail.
            value.audio.stop();
            Thread pump;
            synchronized (lock) {
                pump = value.pump;
                value.pump = null;
            }
            if (pump != null) {
                try {
                    pump.join(2_000);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw VoiceRecognitionFailure.of("cancelled");
                }
            }
            check(value);
            byte[] tail = value.audio.readPCM();
            check(value);
            append(tail, value);
            Stream stream;
            synchronized (lock) {
                stream = value.stream;
            }
            if (stream != null) {
                try {
                    stream.append(tail);
                } catch (VoiceRecognitionFailure failure) {
                    stream.cancel();
                    synchronized (lock) {
                        if (value.stream == stream) value.stream = null;
                    }
                }
            }
        }
        VoiceRecognitionFailure failure;
        synchronized (lock) {
            failure = value.failure;
        }
        if (failure != null) throw failure;
        // Re-read before billing/replay. This Host API has no settings revision/CAS; never
        // substitute a draft or silently accept a changed provider.
        Settings saved = Settings.parse(value.transport.settings(), value.provider);
        check(value);
        if (value.settings == null || !saved.authority.equals(value.settings.authority)) {
            throw VoiceRecognitionFailure.of("settingsChanged");
        }
        String text;
        if (value.provider.equals("openai-compatible")) {
            byte[] captured;
            synchronized (lock) {
                captured = value.pcm.toByteArray();
            }
            text = Pcm.transcript(value.transport.transcribe(Pcm.wav(captured)));
        } else {
            Stream stream;
            synchronized (lock) {
                stream = value.stream;
            }
            if (stream == null) {
                stream = openStream(value);
                synchronized (lock) {
                    value.stream = stream;
                }
                byte[] captured;
                synchronized (lock) {
                    captured = value.pcm.toByteArray();
                }
                try {
                    stream.append(captured);
                } catch (VoiceRecognitionFailure appendFailure) {
                    stream.cancel();
                    synchronized (lock) {
                        if (value.stream == stream) value.stream = null;
                    }
                    throw appendFailure;
                }
            }
            try {
                text = stream.finish();
            } finally {
                stream.cancel();
                synchronized (lock) {
                    if (value.stream == stream) value.stream = null;
                }
            }
        }
        check(value);
        synchronized (lock) {
            value.result = text;
            value.pcm.reset();
        }
        value.audio.cancel();
        return text;
    }

    private Stream openStream(Lease value) throws VoiceRecognitionFailure {
        VoiceRecognitionRuntime.Socket socket = value.transport.open();
        try {
            check(value);
        } catch (VoiceRecognitionFailure failure) {
            socket.close();
            throw failure;
        }
        Stream stream = new Stream(socket, () -> current(value),
                text -> listener.partial(value.owner, value.revision, text));
        // Install before suspending so cancellation closes an in-flight start too.
        synchronized (lock) {
            value.stream = stream;
        }
        try {
            stream.start();
            check(value);
            return stream;
        } catch (VoiceRecognitionFailure failure) {
            stream.cancel();
            synchronized (lock) {
                if (value.stream == stream) value.stream = null;
            }
            throw failure;
        }
    }

    private void append(byte[] data, Lease value) throws VoiceRecognitionFailure {
        synchronized (lock) {
            if (data.length % 2 != 0 || data.length > MAXIMUM_BYTES - value.pcm.size()) {
                value.failure = VoiceRecognitionFailure.of("limit");
                throw VoiceRecognitionFailure.of("limit");
            }
            value.pcm.write(data, 0, data.length);
        }
    }

    /** Idempotent per lease; failed audio cleanup retains the cancelled lease for a retry. */
    public void cancel(String owner, int revision) throws VoiceRecognitionFailure {
        Lease value;
        synchronized (lock) {
            value = lease;
            if (value == null || !value.owner.equals(owner) || value.revision != revision) return;
        }
        value.cancelled = true;
        value.recording = false;
        Stream stream;
        Thread pump;
        CompletableFuture<String> processing;
        synchronized (lock) {
            stream = value.stream;
            value.stream = null;
            pump = value.pump;
            value.pump = null;
            processing = value.processing;
            value.processing = null;
        }
        if (processing != null) processing.cancel(true);
        if (pump != null) pump.interrupt();
        if (stream != null) stream.cancel();
        synchronized (lock) {
            value.pcm.reset();
        }
        value.audio.cancel();
        synchronized (lock) {
            if (lease == value) lease = null;
        }
    }

    public void invalidate() {
        Lease value;
        synchronized (lock) {
            value = lease;
        }
        if (value == null) return;
        try {
            cancel(value.owner, value.revision);
        } catch (VoiceRecognitionFailure ignored) {
            // The cancelled lease stays so UI cleanup can retry it.
        }
        listener.invalidated(value.owner, value.revision);
    }

    private boolean current(Lease value) {
        synchronized (lock) {
            return lease == value && !value.cancelled && value.transport.isCurrent() && foreground;
        }
    }

    private void check(Lease value) throws VoiceRecognitionFailure {
        if (Thread.currentThread().isInterrupted()) throw VoiceRecognitionFailure.of("cancelled");
        if (!current(value)) throw VoiceRecognitionFailure.of("cancelled");
    }

    private static long now() {
        return android.os.SystemClock.elapsedRealtime();
    }
}
