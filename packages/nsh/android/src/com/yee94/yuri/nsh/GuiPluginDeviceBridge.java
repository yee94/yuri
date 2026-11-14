package com.yee94.yuri.nsh;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

/**
 * Port of iOS `GuiPluginDeviceBridge` and its policy.
 *
 * Android counterparts: `ACTION_VIEW` intents, `ClipboardManager`, `Toast`, and
 * the system document picker (`ACTION_CREATE_DOCUMENT`) for every save path — no
 * `file://` URI and no storage permission is handed out. `exportPDF` has no
 * Android equivalent (there is no `WKWebView.createPDF`), so it reports both
 * `exportPDF: false` in `capabilities` and an explicit coded failure; the long
 * image renders through `YuriViewExportRenderer` and is saved with the picker.
 */
final class GuiPluginDeviceBridge {
    static final String INVALID = "GUI_PLUGIN_INVALID_INPUT";
    static final String UNSUPPORTED = "GUI_PLUGIN_UNSUPPORTED";
    static final String ABORTED = "GUI_PLUGIN_ABORTED";
    static final String UNAVAILABLE = "GUI_PLUGIN_UNAVAILABLE";
    static final String BUSY = "EXPORT_BUSY";
    static final String SAVE_FAILED = "EXPORT_SAVE_FAILED";

    static final int SAVE_LIMIT = 32 * 1024 * 1024;

    interface Current { boolean current(); }

    interface Progress { void event(Map<String, Object> value); }

    private final Activity activity;
    private final Current current;
    private final Progress progress;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Toast> toasts = new LinkedHashMap<>();
    private final Map<String, String> keys = new LinkedHashMap<>();
    private final List<String> order = new ArrayList<>();
    private final Map<String, Runnable> timers = new LinkedHashMap<>();
    private volatile boolean stopped = false;
    private volatile String taskID;
    private YuriViewExportRenderer renderer;
    private boolean terminating = false;

    GuiPluginDeviceBridge(Activity activity, Current current, Progress progress) {
        this.activity = activity;
        this.current = current;
        this.progress = progress == null ? value -> { } : progress;
    }

    private void check() throws ResourceFailure {
        if (stopped || !current.current() || activity.isFinishing()) throw new ResourceFailure(ABORTED);
    }

    // ------------------------------------------------------------------ policy

    static String filename(Object value) throws ResourceFailure {
        String name = ResourceJson.text(value);
        if (name == null || name.trim().isEmpty() || ResourceWebPreviewScope.utf8Length(name) > 240
                || name.equals(".") || name.equals("..") || name.contains("/") || name.contains("\\")
                || RuntimeHostText.hasControl(name)) throw new ResourceFailure(INVALID);
        return name;
    }

    static String external(Object value) throws ResourceFailure {
        String url = ResourceJson.text(value);
        if (url == null || ResourceWebPreviewScope.utf8Length(url) > 8192) throw new ResourceFailure(INVALID);
        for (int index = 0; index < url.length(); index++) {
            char character = url.charAt(index);
            if (character <= 32 || character == 127) throw new ResourceFailure(INVALID);
        }
        if (url.contains("\\")) throw new ResourceFailure(INVALID);
        ResourceWebPreviewScope.UrlParts parts = ResourceWebPreviewScope.UrlParts.parse(url);
        if (parts == null || !(parts.scheme.equals("http") || parts.scheme.equals("https") || parts.scheme.equals("mailto"))
                || parts.userInfo != null) throw new ResourceFailure(INVALID);
        String host = parts.host == null ? "" : parts.host.toLowerCase(java.util.Locale.ROOT);
        // Host-local links belong to the scoped resource resolver, never the system browser.
        if (host.equals("localhost") || host.equals("127.0.0.1") || host.equals("0.0.0.0")
                || host.equals("::1") || host.equals("[::1]")) throw new ResourceFailure(UNSUPPORTED);
        if (!parts.scheme.equals("mailto") && host.isEmpty()) throw new ResourceFailure(INVALID);
        return url;
    }

    static String text(Object value, int limit) throws ResourceFailure {
        String text = ResourceJson.text(value);
        if (text == null || ResourceWebPreviewScope.utf8Length(text) > limit) throw new ResourceFailure(INVALID);
        return text;
    }

    static String text(Object value) throws ResourceFailure { return text(value, SAVE_LIMIT); }

    static final class ToastModel {
        final String text;
        final double seconds;
        final boolean persistent;

        ToastModel(String text, double seconds, boolean persistent) {
            this.text = text;
            this.seconds = seconds;
            this.persistent = persistent;
        }
    }

    static ToastModel toast(Map<String, Object> input) throws ResourceFailure {
        if (input.containsKey("icon") || input.containsKey("actions")) throw new ResourceFailure(UNSUPPORTED);
        Set<String> allowed = new HashSet<>(java.util.Arrays.asList("title", "description", "variant", "duration", "persistent"));
        if (!allowed.containsAll(input.keySet())) throw new ResourceFailure(INVALID);
        String title = ResourceJson.text(input.get("title"));
        if (title == null || ResourceWebPreviewScope.utf8Length(title) > 16384) throw new ResourceFailure(INVALID);
        Object description = input.get("description");
        if (description != null && !(description instanceof String)) throw new ResourceFailure(INVALID);
        Object variant = input.get("variant");
        if (variant != null && !(variant instanceof String)) throw new ResourceFailure(INVALID);
        String variantValue = variant == null ? "default" : (String) variant;
        if (!java.util.Arrays.asList("default", "success", "error", "loading").contains(variantValue)) throw new ResourceFailure(INVALID);
        Object persistent = input.get("persistent");
        if (persistent != null && !(persistent instanceof Boolean)) throw new ResourceFailure(INVALID);
        Double duration = input.containsKey("duration") ? ResourceJson.number(input.get("duration")) : 5000d;
        if (duration == null || !Double.isFinite(duration) || duration < 0) throw new ResourceFailure(INVALID);
        String descriptionValue = (String) description;
        if (descriptionValue != null && ResourceWebPreviewScope.utf8Length(descriptionValue) > 16384) throw new ResourceFailure(INVALID);
        return new ToastModel(title + (descriptionValue == null ? "" : "\n" + descriptionValue),
                duration / 1000d, Boolean.TRUE.equals(persistent));
    }

    static String toastIdentity(String owner, Map<String, Object> input) throws ResourceFailure {
        if (owner.isEmpty() || ResourceWebPreviewScope.utf8Length(owner) > 128) throw new ResourceFailure(INVALID);
        ToastModel model = toast(input);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("owner", owner);
        value.put("title", input.get("title"));
        value.put("description", input.get("description"));
        value.put("duration", model.seconds);
        value.put("persistent", model.persistent);
        value.put("variant", input.get("variant") == null ? "default" : input.get("variant"));
        return ResourceJson.stringify(value, true);
    }

    // -------------------------------------------------------------- synchronous

    Object synchronous(String method, Map<String, Object> input) throws ResourceFailure {
        check();
        if (method.equals("openExternal")) {
            if (!input.keySet().equals(new HashSet<>(java.util.Arrays.asList("url")))) throw new ResourceFailure(INVALID);
            String url = external(input.get("url"));
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            activity.startActivity(intent);
            return true;
        }
        if (method.equals("toast.show")) {
            if (!input.keySet().equals(new HashSet<>(java.util.Arrays.asList("owner", "toast")))) throw new ResourceFailure(INVALID);
            String owner = ResourceJson.text(input.get("owner"));
            Map<String, Object> toast = ResourceJson.object(input.get("toast"));
            if (owner == null || toast == null) throw new ResourceFailure(INVALID);
            ToastModel model = toast(toast);
            String key = toastIdentity(owner, toast);
            String existing = keys.get(key);
            if (existing == null && toasts.size() >= 32) throw new ResourceFailure(UNAVAILABLE);
            String id = existing == null ? UUID.randomUUID().toString() : existing;
            if (existing == null) {
                Toast created = Toast.makeText(activity, model.text, Toast.LENGTH_LONG);
                toasts.put(id, created);
                keys.put(key, id);
                order.add(id);
                reflow();
                created.show();
            }
            Runnable previous = timers.remove(id);
            if (previous != null) main.removeCallbacks(previous);
            if (!model.persistent) {
                Runnable dismiss = () -> dismissToast(id);
                timers.put(id, dismiss);
                main.postDelayed(dismiss, Math.min((long) (model.seconds * 1000), Integer.MAX_VALUE));
            }
            return id;
        }
        if (method.equals("toast.dismiss")) {
            if (!input.keySet().equals(new HashSet<>(java.util.Arrays.asList("id")))) throw new ResourceFailure(INVALID);
            String id = ResourceJson.text(input.get("id"));
            if (id == null) throw new ResourceFailure(INVALID);
            dismissToast(id);
            return true;
        }
        throw new ResourceFailure(UNSUPPORTED);
    }

    private void reflow() {
        Set<String> visible = new HashSet<>(order.subList(Math.max(0, order.size() - 3), order.size()));
        for (Map.Entry<String, Toast> entry : new ArrayList<>(toasts.entrySet())) {
            if (!visible.contains(entry.getKey())) dismissToast(entry.getKey());
        }
    }

    private void dismissToast(String id) {
        Runnable timer = timers.remove(id);
        if (timer != null) main.removeCallbacks(timer);
        Toast toast = toasts.remove(id);
        if (toast != null) toast.cancel();
        keys.values().removeIf(id::equals);
        order.remove(id);
    }

    // ------------------------------------------------------------------ requests

    Object request(String method, Map<String, Object> input) throws Exception {
        check();
        if (method.equals("capabilities")) {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("version", 1);
            // No native PDF composer exists on Android; the contract must not claim it.
            value.put("exportPDF", false);
            value.put("exportLongImage", true);
            value.put("limits", YuriViewExportRenderer.Request.limits());
            return value;
        }
        if (method.equals("cancel")) {
            String id = ResourceJson.text(input.get("taskId"));
            if (id != null && id.equals(taskID) && renderer != null) renderer.cancel();
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("status", "cancelled");
            return value;
        }
        if (method.equals("copy")) {
            if (!input.keySet().equals(new HashSet<>(java.util.Arrays.asList("text")))) throw new ResourceFailure(INVALID);
            String text = text(input.get("text"));
            check();
            ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("text", text));
            return true;
        }
        if (terminating) throw new ResourceFailure(BUSY);
        YuriViewExportRenderer.Request exportRequest = null;
        String name;
        if (method.equals("save")) {
            if (!input.keySet().equals(new HashSet<>(java.util.Arrays.asList("name", "content")))) throw new ResourceFailure(INVALID);
            name = filename(input.get("name"));
            String content = text(input.get("content"));
            check();
            File folder = new File(activity.getCacheDir(), "gui-device-" + UUID.randomUUID());
            if (!folder.mkdirs() && !folder.isDirectory()) throw new ResourceFailure(SAVE_FAILED);
            File file = new File(folder, name);
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(content.getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            } catch (IOException failure) {
                ResourceBridge.deleteTree(folder);
                throw new ResourceFailure(SAVE_FAILED);
            }
            try {
                taskID = UUID.randomUUID().toString();
                Uri target = picker(name, "application/octet-stream");
                if (target == null) return status("cancelled");
                copyTo(file, target);
                return status("saved");
            } finally {
                ResourceBridge.deleteTree(folder);
                taskID = null;
            }
        }
        boolean pdf = method.equals("exportPDF");
        if (pdf || method.equals("exportLongImage")) {
            if (pdf) throw new ResourceFailure(UNSUPPORTED);
            exportRequest = new YuriViewExportRenderer.Request(input, false);
            name = exportRequest.filename;
        } else {
            throw new ResourceFailure(UNSUPPORTED);
        }
        File folder = new File(activity.getCacheDir(), "gui-device-" + UUID.randomUUID());
        if (!folder.mkdirs() && !folder.isDirectory()) throw new ResourceFailure(SAVE_FAILED);
        final YuriViewExportRenderer.Request export = exportRequest;
        terminating = true;
        taskID = export.taskId;
        try {
            YuriViewExportRenderer created = new YuriViewExportRenderer(export, folder, (stage, completed, total) -> {
                if (stopped || !export.taskId.equals(taskID)) return;
                Map<String, Object> event = new LinkedHashMap<>();
                event.put("taskId", export.taskId);
                event.put("stage", stage);
                if (completed != null) event.put("completed", completed);
                if (total != null) event.put("total", total);
                progress.event(event);
            });
            renderer = created;
            CompletableFuture<File> rendered = created.start(activity.getWindow().getDecorView());
            File file;
            try {
                file = rendered.get();
            } catch (ExecutionException failure) {
                throw ResourceWebPreviewScope.asException(failure.getCause() == null ? failure : failure.getCause());
            } finally {
                renderer = null;
            }
            check();
            progress.event(event(export.taskId, "saving"));
            Uri target = picker(export.filename, "image/png");
            if (target == null) return status("cancelled");
            copyTo(file, target);
            return status("saved");
        } finally {
            terminating = false;
            taskID = null;
            ResourceBridge.deleteTree(folder);
        }
    }

    private static Map<String, Object> status(String value) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", value);
        return result;
    }

    private static Map<String, Object> event(String taskId, String stage) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("taskId", taskId);
        result.put("stage", stage);
        return result;
    }

    private Uri picker(String name, String mime) throws Exception {
        DocumentTarget target = new DocumentTarget(name, mime);
        DocumentTarget.pending = target;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        activity.startActivityForResult(intent, DocumentTarget.REQUEST_CODE);
        try {
            return target.result.get();
        } catch (ExecutionException failure) {
            return null;
        }
    }

    private void copyTo(File file, Uri target) throws Exception {
        java.io.InputStream input = new java.io.FileInputStream(file);
        try {
            java.io.OutputStream output = activity.getContentResolver().openOutputStream(target);
            if (output == null) throw new ResourceFailure(SAVE_FAILED);
            try (java.io.OutputStream closing = output) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) > 0) closing.write(buffer, 0, count);
                closing.flush();
            }
        } finally {
            input.close();
        }
    }

    void stop() {
        stopped = true;
        for (String id : new ArrayList<>(toasts.keySet())) dismissToast(id);
        if (renderer != null) renderer.cancel();
    }

    /** Reply envelope shared by the prompt and message channels. */
    static Map<String, Object> reply(boolean ok, Object value, String code) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", ok);
        if (ok) result.put("value", value);
        else {
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("code", code == null ? "GUI_PLUGIN_FAILED" : code);
            result.put("error", error);
        }
        return result;
    }

    /** System document picker result, routed back by MainActivity.onActivityResult. */
    static final class DocumentTarget {
        static final int REQUEST_CODE = 0x5953;
        static volatile DocumentTarget pending;
        final CompletableFuture<Uri> result = new CompletableFuture<>();

        DocumentTarget(String name, String mime) { }

        static boolean deliver(int requestCode, Uri uri) {
            if (requestCode != REQUEST_CODE) return false;
            DocumentTarget target = pending;
            pending = null;
            if (target != null) target.result.complete(uri);
            return true;
        }
    }
}
