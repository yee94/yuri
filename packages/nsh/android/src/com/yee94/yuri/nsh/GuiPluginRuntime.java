package com.yee94.yuri.nsh;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

/**
 * Port of iOS `GuiPluginRuntime`: response metadata, the bounded pull stream and
 * the Relay/direct chunk plumbing that RuntimeBridge feeds.
 *
 * The Android runtime supplies byte chunks instead of an `AsyncSequence`, so the
 * two producers are a `ChunkSource` (direct) and `Rendezvous` (Relay frame with
 * back-pressure). Both keep the iOS rules: at most 64 KiB per read, no whole-body
 * buffering, and a terminal upstream error still drains the bytes already arrived.
 */
final class GuiPluginRuntime {
    static final int CHUNK_LIMIT = 65536;
    static final int REPLY_LIMIT = 32 * 1024 * 1024;

    /** Headers that may leave the Host; everything else is dropped. */
    static final Set<String> METADATA_HEADERS = new HashSet<>(java.util.Arrays.asList(
            "x-yuri-file-exists", "x-yuri-gui-revision", "x-yuri-gui-code"));

    private GuiPluginRuntime() {}

    static final class Head {
        final int status;
        final String mime;
        final Map<String, String> headers;

        Head(int status, Map<String, String> headers) throws ResourceFailure {
            if (status < 200 || status > 599 || status >= 300 && status < 400) throw ResourceFailure.response();
            String contentType = null;
            Map<String, String> metadata = new LinkedHashMap<>();
            if (headers != null) {
                for (Map.Entry<String, String> entry : headers.entrySet()) {
                    String name = entry.getKey().toLowerCase(java.util.Locale.ROOT);
                    String value = entry.getValue() == null ? "" : entry.getValue();
                    if (name.equals("content-type")) {
                        if (contentType != null) throw ResourceFailure.response();
                        contentType = value;
                    }
                    if (METADATA_HEADERS.contains(name)) {
                        if (metadata.containsKey(name)) throw ResourceFailure.response();
                        metadata.put(name, value);
                    }
                }
            }
            if (contentType != null && (contentType.indexOf('\r') >= 0 || contentType.indexOf('\n') >= 0
                    || contentType.indexOf('\0') >= 0)) throw ResourceFailure.response();
            this.status = status;
            this.mime = contentType == null ? "" : contentType;
            this.headers = checkedHeaders(metadata);
        }
    }

    /** Strict whitelist used by every buffered, streamed and reply header path. */
    static Map<String, String> checkedHeaders(Map<String, String> values) throws ResourceFailure {
        Map<String, String> result = new LinkedHashMap<>();
        if (values == null) return result;
        for (Map.Entry<String, String> entry : values.entrySet()) {
            String name = entry.getKey().toLowerCase(java.util.Locale.ROOT);
            String value = entry.getValue();
            if (!METADATA_HEADERS.contains(name) || result.containsKey(name) || value == null) throw ResourceFailure.response();
            if (ResourceWebPreviewScope.utf8Length(value) > 1024 || RuntimeHostText.hasControl(value)) throw ResourceFailure.response();
            if (name.equals("x-yuri-file-exists") && !(value.equals("true") || value.equals("false"))) throw ResourceFailure.response();
            if (name.equals("x-yuri-gui-revision") && !value.matches("^[a-f0-9]{64}$")) throw ResourceFailure.response();
            if (name.equals("x-yuri-gui-code") && !(value.equals("cached") || value.equals("full"))) throw ResourceFailure.response();
            result.put(name, value);
        }
        return result;
    }

    /** Lossless pull lane: status/mime/headers plus at most 64 KiB per read. */
    interface ByteStream {
        int status();

        String mime();

        Map<String, String> headers();

        /** Next chunk, or null at EOF; a bounded failure ends the stream. */
        CompletableFuture<byte[]> read(int limit);

        void cancel();
    }

    /** One captured stream instance with the exact-owner retirement rule. */
    static final class StreamLease {
        final int status;
        final String mime;
        final Map<String, String> headers;
        private final ByteStream stream;
        private boolean closed = false;
        private boolean reading = false;

        StreamLease(ByteStream stream) throws ResourceFailure {
            if (stream.status() < 200 || stream.status() > 599 || stream.status() >= 300 && stream.status() < 400
                    || stream.mime().indexOf('\r') >= 0 || stream.mime().indexOf('\n') >= 0) throw ResourceFailure.response();
            headers = checkedHeaders(stream.headers());
            this.stream = stream;
            status = stream.status();
            mime = stream.mime();
        }

        synchronized boolean closed() { return closed; }

        byte[] next() throws Exception {
            synchronized (this) {
                if (closed || reading) throw ResourceFailure.stale();
                reading = true;
            }
            try {
                byte[] bytes = stream.read(CHUNK_LIMIT).get();
                synchronized (this) {
                    if (closed) throw ResourceFailure.stale();
                    reading = false;
                }
                if (bytes == null) {
                    stop();
                    return null;
                }
                if (bytes.length == 0 || bytes.length > CHUNK_LIMIT) throw ResourceFailure.limit();
                return bytes;
            } catch (Exception failure) {
                synchronized (this) { reading = false; }
                stop();
                throw ResourceWebPreviewScope.asException(failure);
            }
        }

        void stop() {
            synchronized (this) {
                if (closed) return;
                closed = true;
            }
            stream.cancel();
        }
    }

    /** Bounded accumulator for the legacy buffered read; exceeding it is a failure. */
    static final class Buffer {
        private final int limit;
        private byte[] bytes = new byte[0];

        Buffer(int limit) { this.limit = limit; }

        synchronized void append(byte[] chunk) throws ResourceFailure {
            if (chunk.length > limit - bytes.length) throw ResourceFailure.limit();
            byte[] next = new byte[bytes.length + chunk.length];
            System.arraycopy(bytes, 0, next, 0, bytes.length);
            System.arraycopy(chunk, 0, next, bytes.length, chunk.length);
            bytes = next;
        }

        synchronized byte[] value() { return bytes.clone(); }
    }

    /** Direct byte source: a URLSession stream on iOS, a bounded reader here. */
    interface ChunkSource {
        /** Next byte chunk, or null at EOF. */
        byte[] next() throws Exception;
    }

    /** Owns one captured source; a later read never repeats collected bytes. */
    static final class DirectBody {
        private ChunkSource source;
        private boolean reading = false;
        private boolean closed = false;
        private Exception terminal;

        DirectBody(ChunkSource source) { this.source = source; }

        synchronized void cancel() {
            closed = true;
            source = null;
        }

        synchronized byte[] read(int limit) throws Exception {
            synchronized (this) {
                if (closed) throw ResourceFailure.stale();
                if (terminal != null) throw terminal;
                if (reading || limit < 1 || limit > CHUNK_LIMIT || source == null) throw ResourceFailure.busy();
                reading = true;
            }
            byte[] chunk = new byte[0];
            try {
                while (chunk.length < limit) {
                    byte[] next = source.next();
                    if (next == null || next.length == 0) break;
                    int take = Math.min(next.length, limit - chunk.length);
                    byte[] merged = new byte[chunk.length + take];
                    System.arraycopy(chunk, 0, merged, 0, chunk.length);
                    System.arraycopy(next, 0, merged, chunk.length, take);
                    chunk = merged;
                    if (take < next.length) break;
                }
                synchronized (this) {
                    if (closed) throw ResourceFailure.stale();
                    reading = false;
                }
                return chunk.length == 0 ? null : chunk;
            } catch (Exception failure) {
                synchronized (this) {
                    reading = false;
                    if (closed) {
                        closed = true;
                        throw ResourceFailure.stale();
                    }
                    terminal = failure;
                }
                // Never turn bytes already collected by this read into a false EOF.
                if (chunk.length > 0) return chunk;
                throw failure;
            }
        }
    }

    /**
     * Relay frame rendezvous: the producer appends one wire frame and waits until
     * the consumer drained it. A terminal error keeps the unconsumed tail; only an
     * explicit cancel discards bytes.
     */
    static final class Rendezvous implements ByteStream {
        private Head head;
        private Exception failure;
        private boolean ended = false;
        private boolean cancelled = false;
        private byte[] bytes;
        private int offset = 0;
        private CompletableFuture<Head> headWaiter;
        private CompletableFuture<byte[]> readWaiter;
        private int readLimit = 0;
        private CompletableFuture<Void> producerWaiter;

        synchronized void response(int status, Map<String, String> headers) throws ResourceFailure {
            if (ended || head != null) throw ResourceFailure.stale();
            head = new Head(status, headers);
            if (headWaiter != null) {
                CompletableFuture<Head> waiter = headWaiter;
                headWaiter = null;
                waiter.complete(head);
            }
        }

        CompletableFuture<Head> awaitHead() {
            synchronized (this) {
                if (failure != null) return ResourceWebPreviewScope.failedFuture(failure);
                if (head != null) return CompletableFuture.completedFuture(head);
                if (ended || headWaiter != null) return ResourceWebPreviewScope.failedFuture(ResourceFailure.response());
                headWaiter = new CompletableFuture<>();
                return headWaiter;
            }
        }

        /** Producer side: at most one frame in flight, released when fully consumed. */
        CompletableFuture<Void> receive(byte[] value) {
            synchronized (this) {
                if (ended || head == null || bytes != null || producerWaiter != null) {
                    return ResourceWebPreviewScope.failedFuture(ResourceFailure.stale());
                }
                if (value == null || value.length == 0) return CompletableFuture.completedFuture(null);
                bytes = value;
                offset = 0;
                producerWaiter = new CompletableFuture<>();
                CompletableFuture<Void> waiter = producerWaiter;
                drainLocked();
                return waiter;
            }
        }

        @Override public CompletableFuture<byte[]> read(int limit) {
            synchronized (this) {
                if (readWaiter != null || limit < 1 || limit > CHUNK_LIMIT) {
                    return ResourceWebPreviewScope.failedFuture(ResourceFailure.invalid());
                }
                if (bytes == null) {
                    if (failure != null) return ResourceWebPreviewScope.failedFuture(failure);
                    if (ended) return CompletableFuture.completedFuture(null);
                }
                readWaiter = new CompletableFuture<>();
                readLimit = limit;
                CompletableFuture<byte[]> waiter = readWaiter;
                drainLocked();
                return waiter;
            }
        }

        private void drainLocked() {
            if (readWaiter == null || bytes == null) return;
            int end = Math.min(bytes.length, offset + readLimit);
            byte[] chunk = new byte[end - offset];
            System.arraycopy(bytes, offset, chunk, 0, chunk.length);
            offset = end;
            CompletableFuture<byte[]> read = readWaiter;
            readWaiter = null;
            readLimit = 0;
            CompletableFuture<Void> producer = null;
            if (offset == bytes.length) {
                bytes = null;
                offset = 0;
                producer = producerWaiter;
                producerWaiter = null;
            }
            read.complete(chunk);
            if (producer != null) producer.complete(null);
        }

        /** Terminal upstream result: arrived bytes stay readable, then EOF or the error. */
        synchronized void finish(Exception error) {
            if (ended) return;
            ended = true;
            failure = error;
            CompletableFuture<Head> opening = headWaiter;
            headWaiter = null;
            if (opening != null) {
                if (head == null) opening.completeExceptionally(error == null ? ResourceFailure.response() : error);
                else opening.complete(head);
            }
            if (error != null && producerWaiter != null) {
                CompletableFuture<Void> producer = producerWaiter;
                producerWaiter = null;
                producer.completeExceptionally(error);
            }
            if (bytes == null && readWaiter != null) {
                CompletableFuture<byte[]> read = readWaiter;
                readWaiter = null;
                if (error != null) read.completeExceptionally(error);
                else read.complete(null);
            }
            drainLocked();
        }

        /** Explicit ownership revocation discards bytes even after a transport error. */
        @Override public synchronized void cancel() {
            cancelled = true;
            ended = true;
            failure = ResourceFailure.stale();
            bytes = null;
            offset = 0;
            if (headWaiter != null) {
                CompletableFuture<Head> opening = headWaiter;
                headWaiter = null;
                opening.completeExceptionally(failure);
            }
            if (readWaiter != null) {
                CompletableFuture<byte[]> read = readWaiter;
                readWaiter = null;
                read.completeExceptionally(failure);
            }
            if (producerWaiter != null) {
                CompletableFuture<Void> producer = producerWaiter;
                producerWaiter = null;
                producer.completeExceptionally(failure);
            }
        }

        synchronized boolean cancelled() { return cancelled; }

        @Override public synchronized int status() { return head == null ? 0 : head.status; }

        @Override public synchronized String mime() { return head == null ? "" : head.mime; }

        @Override public synchronized Map<String, String> headers() {
            return head == null ? new LinkedHashMap<>() : new LinkedHashMap<>(head.headers);
        }
    }

    /** Buffered bytes as a one-shot stream (asset reads and the buffered lane). */
    static ByteStream ofBytes(int status, String mime, Map<String, String> headers, byte[] data) {
        return new ByteStream() {
            private byte[] bytes = data;
            private boolean cancelled = false;

            @Override public int status() { return status; }

            @Override public String mime() { return mime; }

            @Override public Map<String, String> headers() { return headers == null ? new LinkedHashMap<>() : headers; }

            @Override public synchronized CompletableFuture<byte[]> read(int limit) {
                if (cancelled) return ResourceWebPreviewScope.failedFuture(ResourceFailure.stale());
                if (limit < 1 || limit > CHUNK_LIMIT) return ResourceWebPreviewScope.failedFuture(ResourceFailure.invalid());
                if (bytes == null) return CompletableFuture.completedFuture(null);
                int take = Math.min(bytes.length, limit);
                byte[] chunk = new byte[take];
                System.arraycopy(bytes, 0, chunk, 0, take);
                int rest = bytes.length - take;
                if (rest == 0) bytes = null;
                else {
                    byte[] next = new byte[rest];
                    System.arraycopy(bytes, take, next, 0, rest);
                    bytes = next;
                }
                return CompletableFuture.completedFuture(chunk);
            }

            @Override public synchronized void cancel() {
                cancelled = true;
                bytes = null;
            }
        };
    }

    static String utf8(byte[] data) { return new String(data, StandardCharsets.UTF_8); }

    static Map<String, String> headersOf(String... pairs) {
        Map<String, String> result = new HashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) result.put(pairs[index], pairs[index + 1]);
        return result;
    }
}
