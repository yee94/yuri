package com.yee94.yuri.nsh;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;

import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

import java.io.File;
import java.io.IOException;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Android port of iOS `ResourceRasterImage`/`ResourceSVGImageComponent` raster mode.
 *
 * The renderer only ever receives an already verified private lease from
 * {@link ResourceBridge}: it has no Host request capability, and neither the
 * filesystem path nor original bytes are returned to JS. The strict config parser
 * and lifetime fence are the same ones the SVG image surface uses.
 */
public final class ResourceRasterImageComponent implements NshComponent {
    /** Per-edge decode cap; EXIF transform is applied afterwards. */
    static final int MAX_PIXEL_SIZE = 4096;
    /** Rough ARGB_8888 budget (~32 MiB) applied together with the per-edge cap. */
    static final int MAX_PIXEL_COUNT = 8_000_000;
    static final long DECODE_TIMEOUT_MS = 15_000L;

    /** Resolver for an already verified private lease; no Host request capability. */
    interface Resolve {
        Asset resolve(String lease, RuntimeHostScope expectedHost) throws Exception;

        /** Called when this exact lease is retired by the owner; returns an unsubscribe. */
        default Runnable observe(String lease, Runnable retire) { return () -> {}; }
    }

    /** Local lease plus the transport that owns Host validity. */
    static final class Asset {
        final File file;
        final HostLease transport;
        final Runnable retireRegistration;

        Asset(File file, HostLease transport, Runnable retireRegistration) {
            this.file = file;
            this.transport = transport;
            this.retireRegistration = retireRegistration;
        }

        boolean current() { return transport != null && transport.isCurrent(); }
    }

    interface Emitter { void emit(String name, Map<String, Object> body); }

    // ------------------------------------------------------------------ decode policy

    /** @return per-edge sample cap that also respects {@link #MAX_PIXEL_COUNT}. */
    static int maximumPixel(int width, int height) {
        if (width <= 0 || height <= 0) return MAX_PIXEL_SIZE;
        double scale = Math.min(1d, Math.sqrt((double) MAX_PIXEL_COUNT / ((double) width * (double) height)));
        int sampled = (int) Math.floor(Math.max(width, height) * scale);
        return Math.max(1, Math.min(MAX_PIXEL_SIZE, sampled));
    }

    /** EXIF orientations 5...8 rotate the displayed size by 90°. */
    static int[] displaySize(int width, int height, int orientation) {
        if (width <= 0 || height <= 0) return new int[] {0, 0};
        return orientation >= 5 && orientation <= 8 ? new int[] {height, width} : new int[] {width, height};
    }

    static int orientation(File file) {
        try {
            return new ExifInterface(file.getAbsolutePath()).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (IOException | RuntimeException unsupported) {
            return ExifInterface.ORIENTATION_NORMAL;
        }
    }

    static final class Decoded {
        final Bitmap bitmap;
        final int width;
        final int height;

        Decoded(Bitmap bitmap, int width, int height) {
            this.bitmap = bitmap;
            this.width = width;
            this.height = height;
        }
    }

    /**
     * Header-only display size for `resources.read` metadata. Returns {@code null}
     * when the format has no readable bounds; the read itself still succeeds.
     */
    static int[] readDisplaySize(File file) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
        return displaySize(bounds.outWidth, bounds.outHeight, orientation(file));
    }

    /** Bounded background decode of the private original; never a full-size decode. */
    static Decoded decode(File file) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw new IOException("image_bounds_unavailable");
        int sourceOrientation = orientation(file);
        int[] display = displaySize(bounds.outWidth, bounds.outHeight, sourceOrientation);
        int maxPixel = maximumPixel(display[0], display[1]);
        int sample = 1;
        while (sample < 4096 && (Math.max(bounds.outWidth, bounds.outHeight) / sample > maxPixel
                || (long) (bounds.outWidth / sample) * (bounds.outHeight / sample) > MAX_PIXEL_COUNT)) {
            sample *= 2;
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        options.inScaled = false;
        Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        if (bitmap == null) throw new IOException("image_decode_failed");
        Bitmap oriented = applyOrientation(bitmap, sourceOrientation);
        return new Decoded(oriented, display[0], display[1]);
    }

    private static Bitmap applyOrientation(Bitmap bitmap, int orientation) {
        Matrix matrix = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: matrix.setScale(-1f, 1f); break;
            case ExifInterface.ORIENTATION_ROTATE_180: matrix.setRotate(180f); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: matrix.setScale(1f, -1f); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: matrix.setRotate(90f); matrix.postScale(-1f, 1f); break;
            case ExifInterface.ORIENTATION_ROTATE_90: matrix.setRotate(90f); break;
            case ExifInterface.ORIENTATION_TRANSVERSE: matrix.setRotate(-90f); matrix.postScale(-1f, 1f); break;
            case ExifInterface.ORIENTATION_ROTATE_270: matrix.setRotate(-90f); break;
            default: return bitmap;
        }
        Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
        if (rotated != bitmap) bitmap.recycle();
        return rotated;
    }

    /** Raster has no document phase; a decode either applies or reports a failure. */
    static final class Presentation {
        enum Phase { STOPPED, LOADING, READY, FAILED, EXPIRED }

        Phase phase = Phase.STOPPED;
        Integer ticket;

        void begin(int generation) { ticket = generation; phase = Phase.LOADING; }

        boolean loaded(int generation) {
            if (ticket == null || ticket != generation || phase != Phase.LOADING) return false;
            phase = Phase.READY;
            return true;
        }

        boolean fail(int generation, boolean expired) {
            if (ticket == null || ticket != generation) return false;
            ticket = null;
            phase = expired ? Phase.EXPIRED : Phase.FAILED;
            return true;
        }

        void stop() { ticket = null; phase = Phase.STOPPED; }

        void expire() { ticket = null; phase = Phase.EXPIRED; }
    }

    // ------------------------------------------------------------------ component

    private final View view;

    private ResourceRasterImageComponent(Context context, Resolve resolve, Emitter emit) {
        view = new View(context, resolve, emit);
    }

    @Override public android.view.View view() { return view; }

    @Override public void setProp(String name, Object value) {
        if ("config".equals(name)) view.update(value);
    }

    @Override public void destroy() { view.stop(); }

    /** Registers {@code yuri.resource.rasterImage}; the JS preview owner mounts it. */
    public static void install(NshView surface, Resolve resolve) {
        Context context = surface.getContext();
        surface.registerComponent("yuri.resource.rasterImage", new NshComponent.Factory() {
            @Override public NshComponent create(NshComponentContext component) {
                return new ResourceRasterImageComponent(context, resolve, component::emit);
            }
        });
    }

    /** Contain-only raster surface; gestures/chrome belong to the JS preview owner. */
    static final class View extends FrameLayout {
        private final Resolve resolve;
        private final Emitter emit;
        private final ImageView image;
        private final ResourceSVGImageComponent.Lifetime lifetime = new ResourceSVGImageComponent.Lifetime();
        private final Presentation presentation = new Presentation();
        private final Handler main = new Handler(Looper.getMainLooper());
        private Runnable unsubscribe;
        private Runnable deadline;
        private Asset asset;
        private Bitmap bitmap;

        View(Context context, Resolve resolve, Emitter emit) {
            super(context);
            this.resolve = resolve;
            this.emit = emit;
            setBackgroundColor(0x00000000);
            image = new ImageView(context);
            image.setScaleType(ImageView.ScaleType.FIT_CENTER);
            image.setBackgroundColor(0x00000000);
            addView(image, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }

        void update(Object value) {
            if (!lifetime.update(value)) {
                if (parseFails(value)) expire();
                return;
            }
            stop();
            if (lifetime.request == null) expire();
            else reconcile();
        }

        private boolean parseFails(Object value) {
            try {
                ResourceSVGImageComponent.Request.parse(value);
                return false;
            } catch (ResourceFailure ignored) {
                return true;
            }
        }

        @Override protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            reconcile();
        }

        @Override protected void onDetachedFromWindow() {
            stop();
            super.onDetachedFromWindow();
        }

        @Override protected void onWindowVisibilityChanged(int visibility) {
            if (visibility == android.view.View.VISIBLE) reconcile();
            else if (!lifetime.retired) stop();
        }

        /** Retry keeps the captured lease/Host receipt; no new Host capture or path fallback. */
        void retry() {
            if (presentation.phase != Presentation.Phase.FAILED && presentation.phase != Presentation.Phase.EXPIRED) return;
            ResourceSVGImageComponent.Request request = lifetime.request;
            if (lifetime.retired || request == null || !request.active || getWindowToken() == null) {
                expire();
                return;
            }
            clearWork();
            presentation.stop();
            reconcile();
        }

        private void reconcile() {
            if (!isAttachedToWindow()) return;
            ResourceSVGImageComponent.Request request = lifetime.request;
            if (request == null || !request.active) return;
            if (lifetime.retired) { expire(); return; }
            if (presentation.phase == Presentation.Phase.FAILED || presentation.phase == Presentation.Phase.EXPIRED) return;
            if (presentation.phase == Presentation.Phase.LOADING || presentation.phase == Presentation.Phase.READY) return;
            int ticket = lifetime.generation;
            presentation.begin(ticket);
            Asset resolved;
            try {
                resolved = resolve.resolve(request.lease, request.expectedHost);
            } catch (Exception failure) {
                expire();
                return;
            }
            if (!resolved.current()) { expire(); return; }
            asset = resolved;
            unsubscribe = resolve.observe(request.lease, () -> {
                ResourceSVGImageComponent.Request current = lifetime.request;
                if (current != null && current.lease.equals(request.lease)) {
                    lifetime.retire();
                    expire();
                }
            });
            if (lifetime.retired || !resolved.current()) { expire(); return; }
            scheduleDeadline(ticket);
            CompletableFuture.supplyAsync(() -> {
                try {
                    return decode(resolved.file);
                } catch (Exception failure) {
                    return null;
                }
            }).thenAccept(decoded -> main.post(() -> {
                if (!lifetime.accepts(ticket)) return;
                if (decoded == null) { fail(ticket); return; }
                if (!current()) { expire(); return; }
                cancelDeadline();
                if (!presentation.loaded(ticket)) return;
                show(decoded);
                emit(decoded, ticket);
            }));
        }

        private void emit(Decoded decoded, int ticket) {
            if (!lifetime.accepts(ticket)) return;
            java.util.Map<String, Object> size = new java.util.LinkedHashMap<>();
            size.put("width", decoded.width);
            size.put("height", decoded.height);
            this.emit.emit("size", size);
            java.util.Map<String, Object> loaded = new java.util.LinkedHashMap<>();
            loaded.put("width", decoded.width);
            loaded.put("height", decoded.height);
            this.emit.emit("load", loaded);
        }

        private void scheduleDeadline(int ticket) {
            cancelDeadline();
            deadline = () -> {
                if (!lifetime.accepts(ticket)) return;
                if (presentation.phase != Presentation.Phase.LOADING) return;
                if (current()) fail(ticket);
                else expire();
            };
            main.postDelayed(deadline, DECODE_TIMEOUT_MS);
        }

        private boolean current() {
            return !lifetime.retired && lifetime.request != null && lifetime.request.active
                    && asset != null && asset.current() && isAttachedToWindow();
        }

        void stop() {
            clearWork();
            presentation.stop();
            clearBitmap();
        }

        private void clearWork() {
            lifetime.stop();
            cancelDeadline();
            Runnable cancel = unsubscribe;
            unsubscribe = null;
            if (cancel != null) cancel.run();
            asset = null;
        }

        private void fail(int ticket) {
            if (!presentation.fail(ticket, false)) return;
            clearWork();
            clearBitmap();
            java.util.Map<String, Object> body = new java.util.LinkedHashMap<>();
            body.put("code", "decode");
            emit.emit("error", body);
        }

        private void expire() {
            clearWork();
            presentation.expire();
            clearBitmap();
            java.util.Map<String, Object> body = new java.util.LinkedHashMap<>();
            body.put("code", "expired");
            emit.emit("error", body);
        }

        /** The view owns the decoded bitmap; release it when replaced or retired. */
        private void show(Decoded decoded) {
            clearBitmap();
            bitmap = decoded.bitmap;
            image.setImageBitmap(bitmap);
        }

        private void clearBitmap() {
            image.setImageDrawable(null);
            Bitmap retired = bitmap;
            bitmap = null;
            if (retired != null) retired.recycle();
        }

        private void cancelDeadline() {
            if (deadline != null) main.removeCallbacks(deadline);
            deadline = null;
        }
    }
}
