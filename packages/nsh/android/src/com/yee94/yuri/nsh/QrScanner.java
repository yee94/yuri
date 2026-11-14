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
 * QR scan entry built on {@code android.hardware.camera2} + {@code ImageReader}, because
 * CameraX, ML Kit and zxing would all be new dependencies. No QR decoder is bundled, so
 * {@link #scan} rejects with {@code camera_scan_unsupported} instead of opening a camera it
 * cannot decode with; installing a {@link Decoder} enables the full pipeline. Camera
 * start/stop is serialized and never begins after cancellation, matching iOS.
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

    private static volatile Decoder decoder;

    private QrScanner() {}

    public static void setDecoder(Decoder value) { decoder = value; }

    public static boolean supported() { return decoder != null; }

    public static void scan(Activity activity, Result result) {
        Decoder current = decoder;
        if (current == null) {
            result.complete(null, "camera_scan_unsupported");
            return;
        }
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            // The activity owns the permission callback; JS retries after the user grants it.
            activity.requestPermissions(new String[] {Manifest.permission.CAMERA}, 0x5952);
            result.complete(null, "camera_permission_required");
            return;
        }
        new Session(activity, current, result).start();
    }

    private static final class Session {
        private final Activity activity;
        private final Decoder decoder;
        private final Result result;
        private final HandlerThread thread = new HandlerThread("yuri-nsh-qr");
        private final Handler handler;
        private final Dialog dialog;
        private final SurfaceView preview;
        private CameraDevice device;
        private CameraCaptureSession capture;
        private ImageReader reader;
        private boolean finished;

        Session(Activity activity, Decoder decoder, Result result) {
            this.activity = activity;
            this.decoder = decoder;
            this.result = result;
            thread.start();
            handler = new Handler(thread.getLooper());
            preview = new SurfaceView(activity);
            FrameLayout container = new FrameLayout(activity);
            container.addView(preview, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
            Button cancel = new Button(activity);
            cancel.setText("取消");
            FrameLayout.LayoutParams cancelParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            cancelParams.gravity = Gravity.TOP | Gravity.START;
            cancelParams.setMargins(48, 48, 0, 0);
            container.addView(cancel, cancelParams);
            cancel.setOnClickListener(view -> finish(null));
            dialog = new Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
            dialog.setContentView(container);
            dialog.setOnCancelListener(ignored -> finish(null));
        }

        void start() {
            dialog.show();
            preview.getHolder().addCallback(new SurfaceHolder.Callback() {
                @Override public void surfaceCreated(SurfaceHolder holder) { open(holder.getSurface()); }

                @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { }

                @Override public void surfaceDestroyed(SurfaceHolder holder) { finish(null); }
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
                reader = ImageReader.newInstance(size.getWidth(), size.getHeight(), ImageFormat.YUV_420_888, 2);
                reader.setOnImageAvailableListener(this::onFrame, handler);
                manager.openCamera(cameraID, new CameraDevice.StateCallback() {
                    @Override public void onOpened(CameraDevice camera) {
                        device = camera;
                        if (finished) { close(); return; }
                        createCapture(previewSurface);
                    }

                    @Override public void onDisconnected(CameraDevice camera) { camera.close(); finish(null); }

                    @Override public void onError(CameraDevice camera, int error) { camera.close(); finish(null); }
                }, handler);
            } catch (CameraAccessException | SecurityException | IllegalArgumentException failure) {
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
            Image image = source.acquireLatestImage();
            if (image == null) return;
            String value = null;
            try {
                Image.Plane plane = image.getPlanes()[0];
                ByteBuffer buffer = plane.getBuffer();
                byte[] luma = new byte[buffer.remaining()];
                buffer.get(luma);
                value = decoder.decode(luma, image.getWidth(), image.getHeight(), plane.getRowStride());
            } catch (Exception ignored) {
                // A single undecodable frame is not a scan failure.
            } finally {
                image.close();
            }
            if (value != null) {
                String scanned = value;
                handler.post(() -> finish(scanned));
            }
        }

        private void finish(String value) {
            if (finished) return;
            finished = true;
            close();
            dialog.dismiss();
            thread.quitSafely();
            result.complete(value, value == null ? "camera_scan_cancelled" : null);
        }

        private void close() {
            if (capture != null) {
                try { capture.stopRepeating(); } catch (Exception ignored) { /* closing */ }
                capture.close();
                capture = null;
            }
            if (device != null) { device.close(); device = null; }
            if (reader != null) { reader.close(); reader = null; }
        }
    }
}
