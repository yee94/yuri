package com.yee94.yuri.nsh;

import android.app.Activity;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;

import com.longbridge.nsh.NshView;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One registry for every Host bridge, plus the few helpers the bridges share:
 * main-thread replies, dp conversion and a small deterministic JSON codec.
 *
 * Bridges owned by this file's owner are constructed directly; the runtime,
 * resource, terminal, desktop, voice, passkey and notification bridges belong to
 * the other files of this package and are adopted through their uniform
 * (Activity, HostLeaseProvider, NshView) shape. Bridge classes without the small
 * `Bridge` interface are reached reflectively, so one missing optional lifecycle
 * method can never turn into a silent success.
 */
public final class NativeHandlers {
    /** The uniform bridge shape of CONTRACT.md. */
    public interface Bridge {
        void install();

        void invalidate();
    }

    /** Bridges that care about the activity's foreground state. */
    public interface Foreground {
        void setForeground(boolean foreground);
    }

    /** Bridges that receive picker/export activity results. */
    public interface ActivityResultSink {
        boolean onActivityResult(int requestCode, int resultCode, Intent data);
    }

    private static final String TAG = "YuriNsh";
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private final Activity activity;
    private final NshView view;
    private final HostLeaseProvider leases;
    private final List<Bridge> bridges = new ArrayList<>();
    private final List<ActivityResultSink> sinks = new ArrayList<>();
    private Object runtime;
    private NotificationBridge notifications;
    private SpeechPlaybackBridge speech;
    private GuiPluginPreviewBridge guiPreview;
    private boolean installed;
    private boolean invalidated;
    private boolean foreground = true;

    public NativeHandlers(Activity activity, NshView view) {
        this.activity = activity;
        this.view = view;
        this.leases = new LateLeases();
    }

    /**
     * Adopts the runtime first, then every bridge. Safe to call once.
     * `leaseSource` is RuntimeBridge's HostLeaseProvider; null means no Host is
     * reachable and the lease-based bridges report that explicitly.
     */
    public void install(Object runtime, HostLeaseProvider leaseSource) {
        if (installed) return;
        installed = true;
        this.runtime = runtime;
        if (leaseSource != null) ((LateLeases) leases).set(leaseSource);
        if (runtime != null) {
            attachInvalidation(runtime);
        } else {
            Log.w(TAG, "runtime bridge unavailable: host calls will report runtime_unavailable");
        }
        add(new AppearanceBridge(activity, leases, view));
        add(new DiagnosticsBridge(activity, leases, view));
        add(new ScheduleDateBridge(activity, leases, view));
        add(new NavigationBridge(activity, leases, view));
        add(new FeedbackLayoutBridge(activity, leases, view));
        add(new DatePickerBridge(activity, leases, view));
        add(new ChatHeaderCollapseBridge(activity, leases, view));
        add(new ComposerPressBridge(activity, leases, view));
        add(new SheetPresentationBridge(activity, leases, view));
        add(new NewSessionPickerBridge(activity, leases, view));
        add(new NativeInputMetadataBridge(activity, leases, view));
        add(new NativeComposerSpellcheckBridge(activity, leases, view));
        add(new AttachmentBridge(activity, leases, view));
        add(reflective(new TerminalBridge(activity, leases, view)));
        add(reflective(new RemoteDesktopBridge(activity, leases, view)));
        add(new PasskeyBridge(activity, leases, view));
        notifications = new NotificationBridge(activity, leases, view);
        add(notifications);
        add(reflective(new AuthorizationCacheCleanupBridge(activity, leases, view)));
        speech = new SpeechPlaybackBridge(activity, leases, view);
        add(reflective(speech));
        VoiceRecognitionBridge voice = new VoiceRecognitionBridge(activity, leases, view);
        voice.setBeforeCapture(speech::invalidate);
        add(reflective(voice));
        wireResources();
        for (Bridge bridge : bridges) bridge.install();
        if (runtime != null) setForeground(foreground);
    }

    /**
     * Resource preview components plus the staged browser bundle for GUI plugin
     * preview. The bundle is copied out of APK assets because the GUI owner reads
     * an app-private directory; a partially staged directory is replaced, never
     * merged.
     */
    private void wireResources() {
        ResourceBridge resources = new ResourceBridge(activity, leases, view);
        add(reflective(resources));
        ResourceWebPreviewBridge web = new ResourceWebPreviewBridge(activity, leases, view);
        web.setInitialFile((lease, path, expectedHost) -> {
            Map<String, Object> original = resources.htmlInitial(lease, path, expectedHost);
            return new ResourceWebPreviewScope.ResourceWebPreviewResponse(200,
                (String) original.get("mime"), (byte[]) original.get("data"), null);
        });
        add(reflective(web));
        ResourceHTMLComponents.installView(view, web);
        ResourceHTMLComponents.installPresentationAnchor(view, resources);
        ResourceSVGImageComponent.install(view, resources.svgResolver());

        guiPreview = new GuiPluginPreviewBridge(activity, leases, view);
        try {
            GuiPluginPreviewBridge.Resources guiResources = new GuiPluginPreviewBridge.Resources(
                stagedGuiPreview(), new java.io.File(activity.getFilesDir(), "gui-plugin-storage"));
            guiPreview.setCaptureProvider(expectedHost -> {
                // The runtime owns the GUI read lane; the app-owned Resources keep
                // assets, storage, context and labels exactly as before.
                GuiPluginPreviewBridge.Capture io = runtime instanceof RuntimeBridge
                    ? ((RuntimeBridge) runtime).guiPluginPreviewCapture(expectedHost) : null;
                GuiPluginPreviewBridge.Capture captured = guiResources.capture(expectedHost,
                    expected -> {
                        try {
                            return runtime != null && ((HostLeaseProvider) runtime).capture(expectedHost.toLeaseScope()).isCurrent();
                        } catch (Exception error) {
                            return false;
                        }
                    },
                    io == null ? ResourceWebPreviewBridge.transport(leases.capture(expectedHost.toLeaseScope())) : io.resource,
                    io == null ? null : io.readGui);
                if (io != null) captured.isHostResourceURL = io.isHostResourceURL;
                return captured;
            });
        } catch (Exception error) {
            Log.w(TAG, "GUI plugin preview bundle unavailable", error);
        }
        add(reflective(guiPreview));
    }

    /** Extracts `assets/<name>` into `files/<name>` once; the bundle is trusted APK content. */
    private java.io.File stagedGuiPreview() throws java.io.IOException {
        java.io.File target = new java.io.File(activity.getFilesDir(), "gui-plugin-preview");
        if (new java.io.File(target, "manifest.json").isFile()) return target;
        java.io.File staging = new java.io.File(activity.getFilesDir(), "gui-plugin-preview.staging");
        delete(staging);
        copyAssetTree("gui-plugin-preview", staging);
        if (!new java.io.File(staging, "manifest.json").isFile()) throw new java.io.IOException("gui_plugin_bundle_missing");
        delete(target);
        if (!staging.renameTo(target)) throw new java.io.IOException("gui_plugin_bundle_replace");
        return target;
    }

    private void copyAssetTree(String asset, java.io.File directory) throws java.io.IOException {
        String[] children = activity.getAssets().list(asset);
        if (children == null || children.length == 0) {
            if (!directory.getParentFile().isDirectory() && !directory.getParentFile().mkdirs()) throw new java.io.IOException("gui_plugin_dir");
            try (java.io.InputStream input = activity.getAssets().open(asset);
                 java.io.OutputStream output = new java.io.FileOutputStream(directory)) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) > 0) output.write(buffer, 0, count);
            }
            return;
        }
        if (!directory.isDirectory() && !directory.mkdirs()) throw new java.io.IOException("gui_plugin_dir");
        for (String child : children) copyAssetTree(asset + "/" + child, new java.io.File(directory, child));
    }

    private static void delete(java.io.File file) {
        java.io.File[] children = file.listFiles();
        if (children != null) for (java.io.File child : children) delete(child);
        file.delete();
    }

    private void add(Bridge bridge) {
        bridges.add(bridge);
        if (bridge instanceof ActivityResultSink) sinks.add((ActivityResultSink) bridge);
    }

    /** Shutdown: retire every bridge, then release the speech owner's audio resources. */
    public void shutdown() {
        invalidate();
        if (speech != null) {
            try {
                speech.release();
            } catch (RuntimeException error) {
                Log.w(TAG, "speech release failed", error);
            }
        }
    }

    public void invalidate() {
        if (invalidated) return;
        invalidated = true;
        for (Bridge bridge : bridges) {
            try {
                bridge.invalidate();
            } catch (RuntimeException error) {
                Log.w(TAG, "bridge invalidation failed", error);
            }
        }
    }

    public void setForeground(boolean value) {
        foreground = value;
        for (Bridge bridge : bridges) {
            if (bridge instanceof Foreground) {
                try {
                    ((Foreground) bridge).setForeground(value);
                } catch (RuntimeException error) {
                    Log.w(TAG, "foreground change failed", error);
                }
            }
        }
        call(runtime, "setForeground", new Class<?>[] { boolean.class }, value);
    }

    /** MainActivity.onRequestPermissionsResult handoff for the notification owner. */
    public boolean onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        boolean owned = VoiceRecognitionPermissions.dispatch(requestCode, permissions, grantResults);
        if (notifications != null && notifications.onRequestPermissionsResult(requestCode, grantResults)) owned = true;
        return owned;
    }

    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        android.net.Uri uri = data == null ? null : data.getData();
        if (ResourceBridge.SaveRequest.deliver(requestCode, uri)) return true;
        if (GuiPluginDeviceBridge.DocumentTarget.deliver(requestCode, uri)) return true;
        for (ActivityResultSink sink : sinks) {
            try {
                if (sink.onActivityResult(requestCode, resultCode, data)) return true;
            } catch (RuntimeException error) {
                Log.w(TAG, "activity result failed", error);
            }
        }
        return false;
    }

    private void attachInvalidation(Object target) {
        Runnable cleanup = this::invalidate;
        for (String name : new String[] { "setOnInvalidate", "setInvalidateListener" }) {
            if (call(target, name, new Class<?>[] { Runnable.class }, cleanup)) return;
        }
    }

    private static Bridge reflective(Object target) {
        Method install = method(target.getClass(), "install");
        Method invalidate = method(target.getClass(), "invalidate");
        Method foreground = method(target.getClass(), "setForeground", boolean.class);
        return new ReflectedBridge(target, install, invalidate, foreground);
    }

    private static final class ReflectedBridge implements Bridge, Foreground {
        private final Object target;
        private final Method install;
        private final Method invalidate;
        private final Method foreground;

        ReflectedBridge(Object target, Method install, Method invalidate, Method foreground) {
            this.target = target;
            this.install = install;
            this.invalidate = invalidate;
            this.foreground = foreground;
        }

        @Override
        public void install() {
            invoke(install, target);
        }

        @Override
        public void invalidate() {
            invoke(invalidate, target);
        }

        @Override
        public void setForeground(boolean value) {
            if (foreground == null) return;
            try {
                foreground.invoke(target, value);
            } catch (ReflectiveOperationException error) {
                Log.w(TAG, "foreground change failed", error);
            }
        }
    }

    private static Method method(Class<?> type, String name, Class<?>... parameters) {
        try {
            return type.getMethod(name, parameters);
        } catch (NoSuchMethodException absent) {
            try {
                Method value = type.getDeclaredMethod(name, parameters);
                value.setAccessible(true);
                return value;
            } catch (NoSuchMethodException missing) {
                return null;
            }
        }
    }

    private static void invoke(Method method, Object target) {
        if (method == null) return;
        try {
            method.invoke(target);
        } catch (ReflectiveOperationException error) {
            Log.w(TAG, "bridge method failed: " + (method.getName()), error);
        }
    }

    private static boolean call(Object target, String name, Class<?>[] signature, Object argument) {
        if (target == null) return false;
        try {
            target.getClass().getMethod(name, signature).invoke(target, argument);
            return true;
        } catch (ReflectiveOperationException absent) {
            return false;
        }
    }

    /** Posts to the UI thread; replies must never run on a worker thread. */
    public static void post(Runnable work) {
        if (Looper.myLooper() == Looper.getMainLooper()) work.run();
        else MAIN.post(work);
    }

    public static float density(View view) {
        return view.getResources().getDisplayMetrics().density;
    }

    public static int dp(View view, float value) {
        return Math.round(value * density(view));
    }

    /** The ancestor whose direct children are the paired containers and this registration's host. */
    public static View ownerOf(View registration) {
        if (!(registration.getParent() instanceof View)) return null;
        View host = (View) registration.getParent();
        return host.getParent() instanceof View ? (View) host.getParent() : null;
    }

    public static View hostOf(View registration) {
        return registration.getParent() instanceof View ? (View) registration.getParent() : null;
    }

    /** Collects views of `kind` under `root`, skipping the registration's own host subtree. */
    public static void collect(View root, View skip, Class<?> kind, List<View> out) {
        if (root == skip) return;
        if (kind.isInstance(root)) out.add(root);
        if (root instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) root;
            for (int index = 0; index < group.getChildCount(); index++) collect(group.getChildAt(index), skip, kind, out);
        }
    }

    public static boolean isDescendant(View node, View ancestor) {
        View current = node;
        while (current != null) {
            if (current == ancestor) return true;
            current = current.getParent() instanceof View ? (View) current.getParent() : null;
        }
        return false;
    }

    /** A zero-size, non-interactive registration view that reports attach/layout changes. */
    public static final class RegistrationView extends View {
        Runnable changed;

        public RegistrationView(android.content.Context context) {
            super(context);
            setAccessibilityDelegate(null);
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            setClickable(false);
            setFocusable(false);
        }

        @Override
        protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            if (changed != null) changed.run();
        }

        @Override
        protected void onDetachedFromWindow() {
            super.onDetachedFromWindow();
            if (changed != null) changed.run();
        }

        @Override
        protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
            super.onLayout(changed, left, top, right, bottom);
            if (this.changed != null) this.changed.run();
        }
    }

    /**
     * Late-bound provider shared by every bridge. It also forwards the attachment
     * runtime, so AttachmentBridge's {@code instanceof AttachmentRuntime} check is
     * true for the one runtime instance MainActivity owns.
     */
    private static final class LateLeases implements HostLeaseProvider, AttachmentRuntime {
        private volatile HostLeaseProvider delegate;

        void set(HostLeaseProvider value) {
            delegate = value;
        }

        @Override
        public HostLease capture(HostLease.Scope expected) throws Exception {
            HostLeaseProvider provider = delegate;
            if (provider == null) throw new IllegalStateException("runtime_unavailable");
            return provider.capture(expected);
        }

        private AttachmentRuntime attachments() throws Exception {
            HostLeaseProvider provider = delegate;
            if (!(provider instanceof AttachmentRuntime)) {
                throw new RuntimeBridgeFailure("attachment_runtime_unavailable");
            }
            return (AttachmentRuntime) provider;
        }

        @Override
        public void validateAttachmentHost(HostLease.Scope expected) throws Exception {
            attachments().validateAttachmentHost(expected);
        }

        @Override
        public Map<String, Object> uploadPlain(HostLease.Scope expected, byte[] data, String name, String mime)
                throws Exception {
            return attachments().uploadPlain(expected, data, name, mime);
        }

        @Override
        public AttachmentRuntime.Operation contactOperation(HostLease.Scope expected, String assistantID,
                Integer expectedGeneration, String requestID, AttachmentReceiptJournal.DraftContext context,
                AttachmentReceiptJournal journal) throws Exception {
            return attachments().contactOperation(expected, assistantID, expectedGeneration, requestID, context,
                journal);
        }

        @Override
        public AttachmentRuntime.Operation restoreOperation(AttachmentReceiptJournal.Record saved,
                HostLease.Scope expected, AttachmentReceiptJournal journal) throws Exception {
            return attachments().restoreOperation(saved, expected, journal);
        }
    }

}
