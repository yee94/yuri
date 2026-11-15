package com.yee94.yuri.nsh;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * QR scan entry built on {@code android.hardware.camera2} + {@code ImageReader}; frames are
 * decoded by zxing core ({@link QrZxingDecoder}). Like iOS, a first scan asks for the camera
 * permission and continues into the scanner once it is granted. Camera start/stop is
 * serialized and never begins after cancellation; the dialog and the result always run on the
 * UI thread.
 */
public final class QrScanner {
    /** Decodes one QR code from the luma plane of a YUV_420_888 frame, or null. */
    public interface Decoder {
        String decode(byte[] luminance, int width, int height, int rowStride) throws Exception;
    }

    public interface Result {
        /** Exactly one of the two arguments is non-null. */
        void complete(String value, String failure);
    }

    private static final int PERMISSION_REQUEST = 0x5953;
    private static final Decoder DECODER = new QrZxingDecoder();
    private static final Object LOCK = new Object();
    private static PendingPermission permission;

    private QrScanner() {}

    private static final class PendingPermission {
        final Activity activity;
        final Result result;

        PendingPermission(Activity activity, Result result) {
            this.activity = activity;
            this.result = result;
        }
    }

    public static void scan(Activity activity, Result result) {
        NativeHandlers.post(() -> begin(activity, result));
    }

    private static void begin(Activity activity, Result result) {
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            new Session(activity, DECODER, result).start();
            return;
        }
        synchronized (LOCK) {
            if (permission != null) {
                result.complete(null, "camera_scan_busy");
                return;
            }
            permission = new PendingPermission(activity, result);
        }
        try {
            activity.requestPermissions(new String[] {Manifest.permission.CAMERA}, PERMISSION_REQUEST);
        } catch (RuntimeException failure) {
            onRequestPermissionsResult(PERMISSION_REQUEST, new int[0]);
        }
    }

    /** MainActivity.onRequestPermissionsResult handoff; returns whether this scanner owned the request. */
    public static boolean onRequestPermissionsResult(int requestCode, int[] grantResults) {
        if (requestCode != PERMISSION_REQUEST) return false;
        PendingPermission pending;
        synchronized (LOCK) {
            pending = permission;
            permission = null;
        }
        if (pending == null) return true;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) new Session(pending.activity, DECODER, pending.result).start();
        else pending.result.complete(null, "camera_permission_denied");
        return true;
    }

    private static final class Session {
        private final Activity activity;
        private final Decoder decoder;
        private final Result result;
        private final HandlerThread thread = new HandlerThread("yuri-nsh-qr");
        private final Handler handler;
        private final Dialog dialog;
        private final SurfaceView preview;
        private final FrameLayout container;
        private CameraDevice device;
        private CameraCaptureSession capture;
        private ImageReader reader;
        private volatile boolean finished;
        /** Touched only on the camera thread: an in-flight open still needs its callback to close the device. */
        private boolean opening;

        Session(Activity activity, Decoder decoder, Result result) {
            this.activity = activity;
            this.decoder = decoder;
            this.result = result;
            thread.start();
            handler = new Handler(thread.getLooper());
            preview = new SurfaceView(activity);
            container = new FrameLayout(activity);
            container.addView(preview, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
            Button cancel = new Button(activity);
            cancel.setText("取消");
            FrameLayout.LayoutParams cancelParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            cancelParams.gravity = Gravity.TOP | Gravity.START;
            cancelParams.setMargins(48, 48 + statusBarHeight(activity), 0, 0);
            container.addView(cancel, cancelParams);
            cancel.setOnClickListener(view -> finish(null));
            dialog = new Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
            dialog.setContentView(container);
            dialog.setOnCancelListener(ignored -> finish(null));
        }

        private static int statusBarHeight(Activity activity) {
            int id = activity.getResources().getIdentifier("status_bar_height", "dimen", "android");
            return id > 0 ? activity.getResources().getDimensionPixelSize(id) : 0;
        }

        void start() {
            dialog.show();
            preview.getHolder().addCallback(new SurfaceHolder.Callback() {
                @Override public void surfaceCreated(SurfaceHolder holder) { handler.post(() -> open(holder.getSurface())); }

                @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { }

                @Override public void surfaceDestroyed(SurfaceHolder holder) { finish(null); }
            });
        }

        /** Camera2 delivers display-oriented frames to a SurfaceView; fit its aspect instead of stretching. */
        private void fitPreview(android.util.Size size) {
            NativeHandlers.post(() -> {
                if (finished) return;
                DisplayMetrics metrics = activity.getResources().getDisplayMetrics();
                boolean portrait = metrics.heightPixels >= metrics.widthPixels;
                float shownWidth = portrait ? size.getHeight() : size.getWidth();
                float shownHeight = portrait ? size.getWidth() : size.getHeight();
                float scale = Math.min(metrics.widthPixels / shownWidth, metrics.heightPixels / shownHeight);
                FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                    Math.round(shownWidth * scale), Math.round(shownHeight * scale), Gravity.CENTER);
                preview.setLayoutParams(params);
            });
        }

        private void open(Surface previewSurface) {
            if (finished) return;
            CameraManager manager = (CameraManager) activity.getSystemService(Context.CAMERA_SERVICE);
            if (manager == null) { finish(null); return; }
            try {
                String cameraID = null;
                for (String id : manager.getCameraIdList()) {
                    Integer facing = manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
                    if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) { cameraID = id; break; }
                    if (cameraID == null) cameraID = id;
                }
                if (cameraID == null) { finish(null); return; }
                StreamConfigurationMap map = manager.getCameraCharacteristics(cameraID)
                    .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                android.util.Size size = map == null ? null : pickSize(map.getOutputSizes(ImageFormat.YUV_420_888));
                if (size == null) { finish(null); return; }
                fitPreview(size);
                reader = ImageReader.newInstance(size.getWidth(), size.getHeight(), ImageFormat.YUV_420_888, 2);
                reader.setOnImageAvailableListener(this::onFrame, handler);
                opening = true;
                manager.openCamera(cameraID, new CameraDevice.StateCallback() {
                    @Override public void onOpened(CameraDevice camera) {
                        opening = false;
                        device = camera;
                        if (finished) { close(); return; }
                        createCapture(previewSurface);
                    }

                    @Override public void onDisconnected(CameraDevice camera) {
                        opening = false;
                        camera.close();
                        finish(null);
                        close();
                    }

                    @Override public void onError(CameraDevice camera, int error) {
                        opening = false;
                        camera.close();
                        finish(null);
                        close();
                    }
                }, handler);
            } catch (CameraAccessException | SecurityException | IllegalArgumentException failure) {
                opening = false;
                finish(null);
            }
        }

        private android.util.Size pickSize(android.util.Size[] sizes) {
            if (sizes == null) return null;
            android.util.Size best = null;
            for (android.util.Size size : sizes) {
                if (size.getWidth() > 1280) continue;
                if (best == null || size.getWidth() > best.getWidth()) best = size;
            }
            return best;
        }

        private void createCapture(Surface previewSurface) {
            try {
                List<Surface> surfaces = new ArrayList<>();
                surfaces.add(previewSurface);
                surfaces.add(reader.getSurface());
                CaptureRequest.Builder builder = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                builder.addTarget(previewSurface);
                builder.addTarget(reader.getSurface());
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                device.createCaptureSession(surfaces, new CameraCaptureSession.StateCallback() {
                    @Override public void onConfigured(CameraCaptureSession session) {
                        capture = session;
                        if (finished) { close(); return; }
                        try {
                            session.setRepeatingRequest(builder.build(), null, handler);
                        } catch (CameraAccessException | IllegalStateException failure) {
                            finish(null);
                        }
                    }

                    @Override public void onConfigureFailed(CameraCaptureSession session) { finish(null); }
                }, handler);
            } catch (CameraAccessException | IllegalStateException failure) {
                finish(null);
            }
        }

        private void onFrame(ImageReader source) {
            Image image;
            try {
                image = source.acquireLatestImage();
            } catch (IllegalStateException closed) {
                return;
            }
            if (image == null) return;
            String value = null;
            try {
                if (!finished) {
                    Image.Plane plane = image.getPlanes()[0];
                    ByteBuffer buffer = plane.getBuffer();
                    byte[] luma = new byte[buffer.remaining()];
                    buffer.get(luma);
                    value = decoder.decode(luma, image.getWidth(), image.getHeight(), plane.getRowStride());
                }
            } catch (Exception ignored) {
                // A single undecodable frame is not a scan failure.
            } finally {
                image.close();
            }
            if (value != null) finish(value);
        }

        /** Camera teardown stays on the camera thread; the dialog and the result return to the UI thread. */
        private void finish(String value) {
            if (finished) return;
            finished = true;
            handler.post(this::close);
            NativeHandlers.post(() -> {
                dialog.dismiss();
                result.complete(value, value == null ? "camera_scan_cancelled" : null);
            });
        }

        private void close() {
            if (capture != null) {
                try { capture.stopRepeating(); } catch (Exception ignored) { /* closing */ }
                capture.close();
                capture = null;
            }
            if (device != null) { device.close(); device = null; }
            if (reader != null) { reader.close(); reader = null; }
            if (!opening) thread.quitSafely();
        }
    }
}
