package com.yee94.yuri.nsh;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.pdf.PdfRenderer;
import android.media.MediaExtractor;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.MediaController;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.VideoView;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Port of iOS `ResourceBridge`: read-only file and opaque contact-attachment
 * leases plus native present/save/share.
 *
 * Android differences, each an explicit failure instead of a silent success:
 * QuickLook/AVKit do not exist, so an image/PDF lease previews in a local
 * `Dialog` (PdfRenderer) and video/audio in a `VideoView`/`MediaPlayer`; format
 * support is probed on the private local copy exactly like the iOS playability
 * probe. System *share* needs a `FileProvider` declared by the app manifest
 * (`com.yee94.yuri.nsh.files`); without it the action fails instead of handing
 * out a `file://` URI that Android forbids.
 */
public final class ResourceBridge {
    static final String SHARE_AUTHORITY = "com.yee94.yuri.nsh.files";

    private static final class Lease {
        File file;
        HostLease transport;
        String kind;
        String preview;
        String sourcePath;
        String mime;
        ContactAttachment contact;
        RuntimeHostScope expectedHost;
        boolean current() { return transport != null && transport.isCurrent(); }
    }

    private static final class Presenter {
        final String owner;
        final String registration;
        final RuntimeHostScope expectedHost;
        volatile boolean attached = true;

        Presenter(String owner, String registration, RuntimeHostScope expectedHost) {
            this.owner = owner;
            this.registration = registration;
            this.expectedHost = expectedHost;
        }
    }

    /** Opaque contact attachment descriptor: an owned route, never a Host path. */
    static final class ContactAttachment {
        final String route;
        final String generationRoute;
        final String assistantID;
        final String attachmentID;
        final Long generation;
        final String filename;
        final String name;
        final long size;
        final String sha256;
        final String mime;

        private ContactAttachment(String assistantID, String id, String digest, long size, String mime,
                String filename, String name, Long generation) {
            String encoded = ResourceWebPreviewScope.percentEncode(assistantID);
            this.route = "/api/yuri/assistants/" + encoded + "/contact/attachments/" + id;
            this.generationRoute = "/api/yuri/assistants/" + encoded + "/contact/messages?limit=1";
            this.assistantID = assistantID;
            this.attachmentID = id;
            this.sha256 = digest;
            this.size = size;
            this.mime = mime;
            this.filename = filename;
            this.name = name;
            this.generation = generation;
        }

        static ContactAttachment parse(Object input) throws ResourceFailure {
            Map<String, Object> source = ResourceJson.object(input);
            if (source == null) throw ResourceFailure.invalid();
            if (!source.keySet().equals(new HashSet<>(java.util.Arrays.asList("kind", "assistantID", "descriptor")))) throw ResourceFailure.invalid();
            if (!"contact".equals(ResourceJson.text(source.get("kind")))) throw ResourceFailure.invalid();
            String assistant = ResourceJson.text(source.get("assistantID"));
            if (assistant == null || assistant.isEmpty() || ResourceWebPreviewScope.utf8Length(assistant) > 256
                    || RuntimeHostText.hasControl(assistant)) throw ResourceFailure.invalid();
            Map<String, Object> descriptor = ResourceJson.object(source.get("descriptor"));
            if (descriptor == null) throw ResourceFailure.invalid();
            Set<String> allowed = new HashSet<>(java.util.Arrays.asList(
                    "type", "attachmentID", "sha256", "size", "mime", "filename", "generation"));
            if (!allowed.containsAll(descriptor.keySet())) throw ResourceFailure.invalid();
            if (!"file".equals(ResourceJson.text(descriptor.get("type")))) throw ResourceFailure.invalid();
            String id = ResourceJson.text(descriptor.get("attachmentID"));
            if (id == null || !id.matches("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")) throw ResourceFailure.invalid();
            String digest = ResourceJson.text(descriptor.get("sha256"));
            if (digest == null || !digest.matches("^[a-f0-9]{64}$")) throw ResourceFailure.invalid();
            Long size = ResourceJson.integer(descriptor.get("size"), 1, ResourceMediaPolicy.BINARY_LIMIT);
            if (size == null) throw ResourceFailure.invalid();
            String mime = ResourceJson.text(descriptor.get("mime"));
            if (mime == null || !mime.matches("^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$")) throw ResourceFailure.invalid();
            Object rawFilename = descriptor.get("filename");
            if (rawFilename != null && !(rawFilename instanceof String)) throw ResourceFailure.invalid();
            String filename = (String) rawFilename;
            String name = filename != null ? filename : id;
            if (name.isEmpty() || name.length() > 512 || ResourceWebPreviewScope.utf8Length(name) > 1024
                    || !name.equals(name.trim()) || name.contains("/") || name.contains("\\")
                    || name.contains("..") || RuntimeHostText.hasControl(name)) throw ResourceFailure.invalid();
            Long generation = null;
            if (descriptor.containsKey("generation")) {
                generation = ResourceJson.integer(descriptor.get("generation"), 0, 9007199254740991L);
                if (generation == null) throw ResourceFailure.invalid();
            }
            return new ContactAttachment(assistant, id, digest, size, mime, filename, name, generation);
        }

        Map<String, Object> descriptor() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("type", "file");
            value.put("attachmentID", attachmentID);
            value.put("sha256", sha256);
            value.put("size", size);
            value.put("mime", mime);
            if (filename != null) value.put("filename", filename);
            if (generation != null) value.put("generation", generation);
            return value;
        }

        /** Legacy descriptors keep their existing raw GET contract. */
        void validateGeneration(HostLease transport) throws Exception {
            if (generation == null) return;
            if (!transport.isCurrent()) throw ResourceFailure.stale();
            HostLease.RawResponse response = transport.read(generationRoute, ResourceMediaPolicy.TEXT_LIMIT).get();
            if (!transport.isCurrent()) throw ResourceFailure.stale();
            if (response.status != 200 || response.data.length > ResourceMediaPolicy.TEXT_LIMIT) throw ResourceFailure.stale();
            Map<String, Object> body = ResourceJson.object(ResourceJson.parse(new String(response.data, StandardCharsets.UTF_8)));
            if (body == null) throw ResourceFailure.stale();
            Long current = ResourceJson.integer(body.get("generation"), 0, 9007199254740991L);
            if (current == null || !current.equals(generation)) throw ResourceFailure.stale();
        }

        HostLease.RawResponse readVerified(int limit, HostLease transport) throws Exception {
            validateGeneration(transport);
            if (!transport.isCurrent()) throw ResourceFailure.stale();
            HostLease.RawResponse response = transport.read(route, limit).get();
            if (!transport.isCurrent()) throw ResourceFailure.stale();
            if (response.data.length > limit) throw ResourceFailure.stale();
            verify(response);
            validateGeneration(transport);
            return response;
        }

        void verify(HostLease.RawResponse response) throws Exception {
            if (response.status != 200 || response.data.length != size
                    || !response.mime.split(";", 2)[0].equals(mime)
                    || !sha256Hex(response.data).equals(sha256)) throw ResourceFailure.invalid();
        }
    }

    private static final class ReadRequest {
        final String path;
        final String requestID;
        final RuntimeHostScope expectedHost;
        final ContactAttachment contact;

        private ReadRequest(String path, String requestID, RuntimeHostScope expectedHost, ContactAttachment contact) {
            this.path = path;
            this.requestID = requestID;
            this.expectedHost = expectedHost;
            this.contact = contact;
        }

        static ReadRequest parse(Object input) throws ResourceFailure {
            Map<String, Object> value = ResourceJson.object(input);
            if (value == null) throw ResourceFailure.invalid();
            Set<String> allowed = new HashSet<>(java.util.Arrays.asList("path", "source", "requestId", "expectedHost"));
            if (!allowed.containsAll(value.keySet())) throw ResourceFailure.invalid();
            if (value.get("source") != null && value.get("path") != null) throw ResourceFailure.invalid();
            ContactAttachment contact = value.get("source") == null ? null : ContactAttachment.parse(value.get("source"));
            String path = contact != null ? "/" + contact.name : ResourceJson.text(value.get("path"));
            if (path == null || !path.startsWith("/") || path.contains("\\") || RuntimeHostText.hasControl(path)) {
                throw ResourceFailure.invalid();
            }
            for (String part : path.split("/", -1)) if (part.equals(".") || part.equals("..")) throw ResourceFailure.invalid();
            Object rawRequest = value.get("requestId");
            if (rawRequest != null && !(rawRequest instanceof String)) throw ResourceFailure.invalid();
            String requestID = (String) rawRequest;
            if (requestID != null && (requestID.isEmpty() || ResourceWebPreviewScope.utf8Length(requestID) > 128)) {
                throw ResourceFailure.invalid();
            }
            return new ReadRequest(path, requestID, scope(value.get("expectedHost")), contact);
        }
    }

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "yuri-resource");
        thread.setDaemon(true);
        return thread;
    });
    private final File folder;
    private final Map<String, Lease> held = new HashMap<>();
    private final Map<String, CompletableFuture<?>> reads = new HashMap<>();
    private final Map<String, String> requests = new HashMap<>();
    private final Map<String, Presenter> presenters = new HashMap<>();
    private final Map<String, Map<String, Runnable>> svgObservers = new HashMap<>();
    private int generation = 0;
    private String presented;
    private CompletableFuture<Object> completion;
    private Dialog dialog;
    private MediaPlayer player;
    private String presentedOwner;

    public ResourceBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
        folder = new File(activity.getCacheDir(), "resources-" + UUID.randomUUID());
    }

    public void install() {
        view.handle("resources.read", (data, reply) -> handleRead(data, reply));
        view.handle("resources.present", (data, reply) -> handlePresent(data, reply));
        view.handle("resources.release", (data, reply) -> {
            Map<String, Object> args = ResourceJson.object(data);
            String key = args == null ? null : ResourceJson.text(args.get("lease"));
            if (key != null) release(key);
            reply.resolve(true);
        });
        view.handle("resources.cancel", (data, reply) -> {
            Map<String, Object> args = ResourceJson.object(data);
            String request = args == null ? null : ResourceJson.text(args.get("requestId"));
            if (request != null) {
                CompletableFuture<?> read;
                synchronized (this) {
                    String ticket = requests.get(request);
                    read = ticket == null ? null : reads.get(ticket);
                }
                if (read != null) read.cancel(true);
            }
            reply.resolve(true);
        });
        view.handle("resources.close", (data, reply) -> {
            Map<String, Object> args = ResourceJson.object(data);
            String key = args == null ? null : ResourceJson.text(args.get("lease"));
            if (key == null) {
                reply.resolve(true);
                return;
            }
            // close() retires this exact presentation; the SVG watcher is retired by release.
            if (key.equals(presented) && completion != null) closePresentation();
            reply.resolve(true);
        });
    }

    /** Host/authorization/generation change or teardown: revoke reads and presentations. */
    public void invalidate() {
        suspend();
        presenters.clear();
        for (String key : new ArrayList<>(held.keySet())) release(key);
        executor.shutdownNow();
        deleteTree(folder);
    }

    /** Background stops playback and pending reads; a valid foreground lease can reopen. */
    private void suspend() {
        generation += 1;
        for (CompletableFuture<?> read : new ArrayList<>(reads.values())) read.cancel(true);
        for (String key : new ArrayList<>(svgObservers.keySet())) retireSVG(key);
        closePresentation();
    }

    // ---------------------------------------------------------------- handlers

    private void handleRead(Object data, NshHostReply reply) {
        ReadRequest request;
        HostLease transport;
        try {
            request = ReadRequest.parse(data);
            transport = leases.capture(request.expectedHost.toLeaseScope());
        } catch (ResourceFailure failure) {
            reply.reject(failure.getMessage());
            return;
        } catch (RuntimeHostScopeFailure failure) {
            reply.reject(failure.code);
            return;
        } catch (Exception failure) {
            reply.reject("runtime_host_unavailable");
            return;
        }
        if (!transport.isCurrent()) {
            reply.reject("runtime_host_scope_stale");
            return;
        }
        synchronized (this) {
            if (reads.size() >= 2) {
                reply.reject("正在读取其他文件，请稍后重试");
                return;
            }
            if (request.requestID != null && requests.containsKey(request.requestID)) {
                reply.reject("无效或重复的文件请求");
                return;
            }
        }
        String ticket = UUID.randomUUID().toString();
        int scope = generation;
        CompletableFuture<Object> task = CompletableFuture.supplyAsync(() -> {
            try {
                return (Object) read(request, scope, transport);
            } catch (Exception failure) {
                throw ResourceWebPreviewScope.unchecked(failure);
            }
        }, executor);
        synchronized (this) {
            reads.put(ticket, task);
            if (request.requestID != null) requests.put(request.requestID, ticket);
        }
        task.whenComplete((result, error) -> {
            synchronized (this) {
                reads.remove(ticket);
                if (request.requestID != null) requests.remove(request.requestID);
            }
            if (error != null) {
                reply.reject(messageOf(error));
                return;
            }
            if (task.isCancelled() || scope != generation || !transport.isCurrent()) {
                Map<String, Object> value = ResourceJson.object(result);
                String key = value == null ? null : ResourceJson.text(value.get("lease"));
                if (key != null) release(key);
                reply.reject("cancelled");
                return;
            }
            reply.resolve(result);
        });
    }

    private void handlePresent(Object data, NshHostReply reply) {
        Map<String, Object> args = ResourceJson.object(data);
        String key = args == null ? null : ResourceJson.text(args.get("lease"));
        String action = args == null ? null : ResourceJson.text(args.get("action"));
        String presenter = args == null ? null : ResourceJson.text(args.get("presentationOwner"));
        Lease lease;
        synchronized (this) { lease = key == null ? null : held.get(key); }
        if (lease == null || !lease.current()) {
            reply.reject("Host 已切换或文件已关闭，请重新加载");
            return;
        }
        if (action == null || !(action.equals("preview") || action.equals("save") || action.equals("share"))) {
            reply.reject("无效的文件操作");
            return;
        }
        Lease captured = lease;
        CompletableFuture.runAsync(() -> {
            try {
                if (captured.contact != null) {
                    if (captured.transport == null) throw ResourceFailure.invalid();
                    captured.contact.readVerified((int) captured.contact.size, captured.transport);
                    Lease current;
                    synchronized (this) { current = held.get(key); }
                    if (current != captured || !captured.current()) throw ResourceFailure.stale();
                }
                Map<String, Object> request = new LinkedHashMap<>();
                request.put("lease", key);
                request.put("action", action);
                if (presenter != null) request.put("presentationOwner", presenter);
                main.post(() -> showPresentation(request, captured, reply));
            } catch (Exception failure) {
                reply.reject(messageOf(failure));
            }
        }, executor);
    }

    private void showPresentation(Map<String, Object> args, Lease lease, NshHostReply reply) {
        String key = ResourceJson.text(args.get("lease"));
        String action = ResourceJson.text(args.get("action"));
        String owner = ResourceJson.text(args.get("presentationOwner"));
        if (owner != null) {
            Presenter registration = presenters.get(owner);
            if (registration == null || !registration.attached || !registration.expectedHost.equals(lease.expectedHost)) {
                reply.reject("请先关闭当前系统窗口");
                return;
            }
        }
        if (completion != null) {
            reply.reject("请先关闭当前系统窗口");
            return;
        }
        if ("preview".equals(action) && "unsupported".equals(lease.preview)) {
            reply.reject("此格式或编码没有可用的原生预览；可保存或分享原文件");
            return;
        }
        presentedOwner = owner;
        CompletableFuture<Object> pending = new CompletableFuture<>();
        completion = pending;
        presented = key;
        try {
            if ("save".equals(action)) {
                saveDocument(lease, pending);
            } else if ("share".equals(action)) {
                shareDocument(lease, pending);
            } else {
                showPreviewDialog(key, lease, pending);
            }
        } catch (Exception failure) {
            finishPresentation(ResourceWebPreviewScope.unchecked(failure));
        }
        pending.whenComplete((value, error) -> {
            if (error == null) reply.resolve(value);
            else reply.reject(messageOf(error));
        });
    }

    private void saveDocument(Lease lease, CompletableFuture<Object> pending) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(lease.mime == null || lease.mime.isEmpty() ? "application/octet-stream" : lease.mime);
        intent.putExtra(Intent.EXTRA_TITLE, lease.file.getName());
        activity.startActivityForResult(intent, SaveRequest.REQUEST_CODE);
        SaveRequest.pending = uri -> {
            if (uri == null) {
                finishPresentation(null, completed(false));
                return;
            }
            CompletableFuture.runAsync(() -> {
                try (FileInputStream input = new FileInputStream(lease.file);
                        java.io.OutputStream output = activity.getContentResolver().openOutputStream(uri)) {
                    if (output == null) throw new IOException("no output");
                    byte[] buffer = new byte[64 * 1024];
                    int count;
                    while ((count = input.read(buffer)) > 0) output.write(buffer, 0, count);
                    output.flush();
                } catch (IOException error) {
                    finishPresentation(ResourceWebPreviewScope.unchecked(error));
                    return;
                }
                finishPresentation(null, completed(true));
            }, executor);
        };
    }

    private void shareDocument(Lease lease, CompletableFuture<Object> pending) {
        // Android forbids file:// URIs since API 24; ResourceShareProvider is that provider.
        if (activity.getPackageManager().resolveContentProvider(SHARE_AUTHORITY, 0) == null) {
            finishPresentation(ResourceWebPreviewScope.unchecked(new ResourceFailure(
                    "unsupported", "系统分享需要应用声明 FileProvider：" + SHARE_AUTHORITY)));
            return;
        }
        Uri uri = ResourceShareProvider.uriFor(activity, lease.file);
        if (uri == null) {
            finishPresentation(ResourceWebPreviewScope.unchecked(new ResourceFailure("unsupported", "系统分享不可用")));
            return;
        }
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType(lease.mime == null || lease.mime.isEmpty() ? "*/*" : lease.mime);
        intent.putExtra(Intent.EXTRA_STREAM, uri);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        activity.startActivity(Intent.createChooser(intent, null));
        finishPresentation(null, completed(true));
    }

    private void showPreviewDialog(String key, Lease lease, CompletableFuture<Object> pending) {
        Dialog sheet = new Dialog(activity, android.R.style.Theme_Material_NoActionBar_Fullscreen);
        FrameLayout root = new FrameLayout(activity);
        root.setBackgroundColor(0xff000000);
        View content = buildPreview(lease);
        root.addView(content, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        TextView done = new TextView(activity);
        done.setText("✕");
        done.setTextSize(22f);
        done.setTextColor(0xffffffff);
        done.setPadding(dp(16), dp(12), dp(16), dp(12));
        done.setOnClickListener(ignored -> closePresentation());
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.gravity = Gravity.TOP | Gravity.END;
        root.addView(done, params);
        sheet.setContentView(root);
        sheet.setOnCancelListener(ignored -> closePresentation());
        dialog = sheet;
        sheet.show();
    }

    private View buildPreview(Lease lease) {
        if ("svg".equals(lease.kind)) {
            ResourceSVGImageComponent.View image = new ResourceSVGImageComponent.View(activity, svgResolver());
            Map<String, Object> config = new LinkedHashMap<>();
            config.put("lease", presented);
            config.put("expectedHost", lease.expectedHost.publicValue());
            config.put("active", true);
            image.update(config);
            return image;
        }
        if ("image".equals(lease.kind) || "pdf".equals(lease.kind)) {
            if ("pdf".equals(lease.kind)) {
                ScrollView scroll = new ScrollView(activity);
                android.widget.LinearLayout column = new android.widget.LinearLayout(activity);
                column.setOrientation(android.widget.LinearLayout.VERTICAL);
                scroll.addView(column);
                try (ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(lease.file, ParcelFileDescriptor.MODE_READ_ONLY);
                        PdfRenderer renderer = new PdfRenderer(descriptor)) {
                    int pages = Math.min(renderer.getPageCount(), 50);
                    for (int index = 0; index < pages; index++) {
                        try (PdfRenderer.Page page = renderer.openPage(index)) {
                            int width = page.getWidth();
                            int height = page.getHeight();
                            Bitmap bitmap = Bitmap.createBitmap(Math.max(1, width), Math.max(1, height), Bitmap.Config.ARGB_8888);
                            bitmap.eraseColor(0xffffffff);
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                            ImageView view = new ImageView(activity);
                            view.setImageBitmap(bitmap);
                            view.setAdjustViewBounds(true);
                            column.addView(view, new android.widget.LinearLayout.LayoutParams(
                                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                        }
                    }
                } catch (Exception unreadable) {
                    return message("此 PDF 无法由系统原生呈现；可保存或分享原文件");
                }
                return scroll;
            }
            ImageView view = new ImageView(activity);
            view.setScaleType(ImageView.ScaleType.FIT_CENTER);
            view.setImageBitmap(BitmapFactory.decodeFile(lease.file.getAbsolutePath()));
            return view;
        }
        if ("video".equals(lease.kind) || "audio".equals(lease.kind)) {
            if ("audio".equals(lease.kind)) {
                try {
                    if (player != null) player.release();
                    player = new MediaPlayer();
                    player.setDataSource(lease.file.getAbsolutePath());
                    player.prepare();
                    player.setLooping(false);
                    player.start();
                } catch (IOException unplayable) {
                    return message("此媒体编码或容器无法由系统原生播放；可保存或分享原文件");
                }
                return message(lease.file.getName());
            }
            VideoView video = new VideoView(activity);
            video.setMediaController(new MediaController(activity));
            video.setVideoPath(lease.file.getAbsolutePath());
            video.start();
            return video;
        }
        return message("此格式没有可用的原生预览；可保存或分享原文件");
    }

    private TextView message(String text) {
        TextView view = new TextView(activity);
        view.setText(text);
        view.setTextColor(0xffffffff);
        view.setPadding(dp(24), dp(24), dp(24), dp(24));
        return view;
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    private static Map<String, Object> completed(boolean value) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("completed", value);
        return result;
    }

    private void finishPresentation(Throwable failure) {
        finishPresentation(failure, null);
    }

    private void finishPresentation(Throwable failure, Object value) {
        CompletableFuture<Object> pending = completion;
        completion = null;
        String key = presented;
        presented = null;
        presentedOwner = null;
        if (player != null) {
            try {
                player.stop();
            } catch (IllegalStateException ignored) {
                // already stopped
            }
            player.release();
            player = null;
        }
        if (dialog != null) {
            Dialog closing = dialog;
            dialog = null;
            closing.dismiss();
        }
        if (pending != null) {
            if (failure != null) pending.completeExceptionally(failure);
            else pending.complete(value);
        }
        if (key != null) {
            // A release requested during presentation is applied after the real dismissal.
            if (pendingRelease.remove(key)) release(key);
        }
    }

    private final Set<String> pendingRelease = new HashSet<>();

    /** Dismiss the exact presented lease; the pending present reply settles once. */
    private void closePresentation() {
        finishPresentation(ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled")), null);
    }

    // ------------------------------------------------------------- lease surface

    void release(String key) {
        retireSVG(key);
        if (key.equals(presented)) {
            pendingRelease.add(key);
            return;
        }
        Lease lease;
        synchronized (this) { lease = held.remove(key); }
        if (lease == null) return;
        deleteTree(lease.file.getParentFile());
    }

    /**
     * Only opaque local leases reach the SVG view; contact descriptors never do.
     * The resolver has no Host request capability of its own.
     */
    ResourceSVGImageComponent.Resolve svgResolver() {
        return new ResourceSVGImageComponent.Resolve() {
            @Override public ResourceSVGImageComponent.Asset resolve(String key, RuntimeHostScope expectedHost) throws Exception {
                Lease lease;
                synchronized (ResourceBridge.this) { lease = held.get(key); }
                if (lease == null || !"svg".equals(lease.kind) || !lease.expectedHost.equals(expectedHost) || !lease.current()) {
                    throw ResourceFailure.invalid();
                }
                return new ResourceSVGImageComponent.Asset(lease.file, lease.transport, null);
            }

            @Override public Runnable observe(String key, Runnable retire) {
                return observeSvg(key, retire);
            }
        };
    }

    Runnable observeSvg(String key, Runnable retire) {
        final Map<String, Runnable> observers;
        synchronized (this) {
            Map<String, Runnable> existing = svgObservers.get(key);
            if (existing == null) {
                existing = new HashMap<>();
                svgObservers.put(key, existing);
            }
            observers = existing;
        }
        final String ticket = UUID.randomUUID().toString();
        synchronized (observers) { observers.put(ticket, retire); }
        return () -> {
            synchronized (observers) { observers.remove(ticket); }
        };
    }

    private void retireSVG(String key) {
        Map<String, Runnable> observers;
        synchronized (this) { observers = svgObservers.remove(key); }
        if (observers == null) return;
        List<Runnable> copy;
        synchronized (observers) { copy = new ArrayList<>(observers.values()); }
        for (Runnable retire : copy) retire.run();
    }

    /** Original bounded read for the inline HTML document; no reload of the file. */
    Map<String, Object> htmlInitial(String key, String path, RuntimeHostScope expectedHost) throws Exception {
        Lease lease;
        synchronized (this) { lease = held.get(key); }
        if (lease == null || !"text".equals(lease.kind) || !path.equals(lease.sourcePath)
                || !lease.expectedHost.equals(expectedHost) || !lease.current()
                || !ResourceMediaPolicy.isHtmlPath(lease.file.getName())) throw ResourceFailure.invalid();
        byte[] data = readBounded(lease.file, ResourceMediaPolicy.TEXT_LIMIT);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("mime", lease.mime);
        result.put("data", data);
        return result;
    }

    void registerPresenter(String owner, String registration, RuntimeHostScope expectedHost) throws Exception {
        HostLease transport = leases.capture(expectedHost.toLeaseScope());
        if (!transport.isCurrent()) throw ResourceFailure.invalid();
        synchronized (this) {
            Presenter existing = presenters.get(owner);
            if (existing != null && !existing.registration.equals(registration)) throw ResourceFailure.invalid();
            presenters.put(owner, new Presenter(owner, registration, expectedHost));
        }
    }

    void markPresenterDetached(String owner, String registration) {
        synchronized (this) {
            Presenter existing = presenters.get(owner);
            if (existing != null && existing.registration.equals(registration)) existing.attached = false;
        }
    }

    void unregisterPresenter(String owner, String registration) {
        synchronized (this) {
            Presenter existing = presenters.get(owner);
            if (existing == null || !existing.registration.equals(registration)) return;
            presenters.remove(owner);
        }
        if (owner.equals(presentedOwner) && completion != null) closePresentation();
    }

    boolean ownsPresentation(String owner) {
        return completion != null && owner != null && owner.equals(presentedOwner);
    }

    boolean hasPresentedOwner() { return completion != null && presentedOwner != null; }

    /** Dismiss the presentation this exact presenter owns; false when another owner holds it. */
    boolean dismissOwnedPresentation(String owner) {
        synchronized (this) {
            if (completion == null || owner == null || !owner.equals(presentedOwner)) return false;
        }
        closePresentation();
        return true;
    }

    // -------------------------------------------------------------- read pipeline

    private Map<String, Object> read(ReadRequest request, int scope, HostLease transport) throws Exception {
        if (scope != generation || !transport.isCurrent()) throw new ResourceFailure("cancelled");
        String path = request.path;
        int count;
        synchronized (this) { count = held.size(); }
        if (count >= 32) throw new ResourceFailure("busy", "打开文件过多，请关闭部分预览后重试");
        String encodedPath = ResourceWebPreviewScope.percentEncode(path);
        Map<String, Object> metadata;
        if (request.contact != null) {
            metadata = new LinkedHashMap<>();
            metadata.put("isFile", true);
            metadata.put("size", request.contact.size);
            metadata.put("isBinary", !request.contact.mime.startsWith("text/") && !request.contact.mime.equals("application/json"));
        } else {
            HostLease.RawResponse stat = transport.read("/api/fs/stat?path=" + encodedPath, ResourceMediaPolicy.STAT_LIMIT).get();
            if (scope != generation || !transport.isCurrent()) throw new ResourceFailure("cancelled");
            if (stat.status < 200 || stat.status >= 300 || stat.data.length > ResourceMediaPolicy.STAT_LIMIT) {
                throw new ResourceFailure("response", "无法读取文件属性，请检查文件权限与 Host 连接后重试");
            }
            Map<String, Object> fields = ResourceJson.object(ResourceJson.parse(new String(stat.data, StandardCharsets.UTF_8)));
            if (fields == null || !Boolean.TRUE.equals(fields.get("isFile"))) {
                throw new ResourceFailure("response", "无法读取文件属性，请检查文件权限与 Host 连接后重试");
            }
            metadata = fields;
        }
        boolean binary = Boolean.TRUE.equals(metadata.get("isBinary"));
        String initialKind = ResourceMediaPolicy.kind(path, "", binary, false);
        int limit = initialKind.equals("text") || initialKind.equals("svg")
                ? ResourceMediaPolicy.TEXT_LIMIT : ResourceMediaPolicy.BINARY_LIMIT;
        Double declaredSize = ResourceJson.number(metadata.get("size"));
        if (declaredSize != null && declaredSize > limit) {
            throw new ResourceFailure("limit", "文件超过原生预览限制：文本 1 MB，其他文件 25 MiB；未下载文件");
        }
        String route = request.contact != null ? request.contact.route
                : "/api/fs/serve" + encodePathSegments(path);
        HostLease.RawResponse response;
        if (request.contact != null) {
            try {
                response = request.contact.readVerified(limit, transport);
            } catch (ResourceFailure failure) {
                throw failure;
            }
        } else {
            response = transport.read(route, limit).get();
        }
        if (scope != generation || !transport.isCurrent()) throw new ResourceFailure("cancelled");
        if (response.status != 200) {
            throw new ResourceFailure("response", "文件读取失败 (HTTP " + response.status + ")；原有预览保留，可重试");
        }
        if (response.data.length > limit) {
            throw new ResourceFailure("limit", "文件超过原生预览限制：文本 1 MB，其他文件 25 MiB；未保存不完整文件");
        }
        if (response.mime.toLowerCase(java.util.Locale.ROOT).startsWith("text/html") && !ResourceMediaPolicy.isHtmlPath(path)) {
            throw new ResourceFailure("response", "Host 返回了 HTML 而非所需文件");
        }
        String kind = ResourceMediaPolicy.kind(path, response.mime, binary, ResourceMediaPolicy.containsNull(response.data));
        String key = UUID.randomUUID().toString();
        String fileName = path.substring(path.lastIndexOf('/') + 1);
        if (fileName.isEmpty()) fileName = "resource";
        File directory = new File(folder, key);
        if (!directory.mkdirs() && !directory.isDirectory()) throw new ResourceFailure("response", "无法创建临时目录");
        File file = new File(directory, fileName);
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(response.data);
            output.getFD().sync();
        } catch (IOException failure) {
            deleteTree(directory);
            throw failure;
        }
        try {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("kind", kind);
            result.put("lease", key);
            result.put("size", (long) response.data.length);
            if (request.contact == null && metadata.get("size") != null
                    && metadata.get("mtimeMs") != null && metadata.get("isBinary") != null) {
                Map<String, Object> stat = new LinkedHashMap<>();
                stat.put("size", metadata.get("size"));
                stat.put("mtimeMs", metadata.get("mtimeMs"));
                stat.put("isBinary", metadata.get("isBinary"));
                result.put("stat", stat);
            }
            String preview = "unsupported";
            if (kind.equals("image") && probeImage(file)) preview = "quicklook";
            if (kind.equals("pdf") && probePdf(file)) preview = "quicklook";
            if (kind.equals("svg")) preview = "svg-image";
            if (kind.equals("video") || kind.equals("audio")) {
                if (probeMedia(file)) preview = "avkit";
                else result.put("previewError", "此媒体编码或容器无法由系统原生播放；可保存或分享原文件");
            }
            result.put("preview", preview);
            if (kind.equals("text")) {
                String text = utf8(response.data);
                if (text == null) throw new ResourceFailure("invalid", "文件不是有效的 UTF-8 文本，可按二进制文件导出");
                result.put("text", text);
            }
            if (kind.equals("image")) {
                String thumbnail = thumbnail(file);
                if (thumbnail == null) throw new ResourceFailure("response", "无法生成缩略图");
                result.put("thumbnail", thumbnail);
            }
            if (request.contact != null) request.contact.validateGeneration(transport);
            if (scope != generation || !transport.isCurrent()) throw new ResourceFailure("cancelled");
            synchronized (this) {
                if (held.size() >= 32) throw new ResourceFailure("busy", "打开文件过多，请关闭部分预览后重试");
                Lease lease = new Lease();
                lease.file = file;
                lease.transport = transport;
                lease.kind = kind;
                lease.preview = preview;
                lease.sourcePath = request.contact == null ? request.path : null;
                lease.mime = response.mime;
                lease.contact = request.contact;
                lease.expectedHost = request.expectedHost;
                held.put(key, lease);
            }
            return result;
        } catch (Exception failure) {
            deleteTree(directory);
            throw failure;
        }
    }

    private static String encodePathSegments(String path) {
        StringBuilder out = new StringBuilder();
        String[] parts = path.split("/", -1);
        for (int index = 0; index < parts.length; index++) {
            if (index > 0) out.append('/');
            out.append(ResourceWebPreviewScope.percentEncode(parts[index]));
        }
        return out.toString();
    }

    private static boolean probeImage(File file) {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        return options.outWidth > 0 && options.outHeight > 0;
    }

    private static boolean probePdf(File file) {
        try (ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
                PdfRenderer renderer = new PdfRenderer(descriptor)) {
            return renderer.getPageCount() > 0;
        } catch (Exception unreadable) {
            return false;
        }
    }

    private static boolean probeMedia(File file) {
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(file.getAbsolutePath());
            return extractor.getTrackCount() > 0;
        } catch (IOException unreadable) {
            return false;
        } finally {
            extractor.release();
        }
    }

    private static String thumbnail(File file) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
        int sample = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / sample > 1024) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        if (bitmap == null) return null;
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        boolean compressed = bitmap.compress(Bitmap.CompressFormat.JPEG, 85, bytes);
        bitmap.recycle();
        if (!compressed) return null;
        return "data:image/jpeg;base64," + android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP);
    }

    private static String utf8(byte[] data) {
        boolean ascii = true;
        for (byte value : data) if ((value & 0x80) != 0) { ascii = false; break; }
        if (ascii) return new String(data, StandardCharsets.US_ASCII);
        try {
            java.nio.charset.CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT);
            return decoder.decode(java.nio.ByteBuffer.wrap(data)).toString();
        } catch (java.nio.charset.CharacterCodingException invalid) {
            return null;
        }
    }

    private static byte[] readBounded(File file, int limit) throws Exception {
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] data = new byte[limit + 1];
            int total = 0;
            while (total < data.length) {
                int count = input.read(data, total, data.length - total);
                if (count < 0) break;
                total += count;
            }
            if (total > limit) throw new ResourceFailure("limit");
            byte[] result = new byte[total];
            System.arraycopy(data, 0, result, 0, total);
            return result;
        }
    }

    static String sha256Hex(byte[] data) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest(data);
            StringBuilder out = new StringBuilder(hashed.length * 2);
            for (byte value : hashed) out.append(String.format("%02x", value));
            return out.toString();
        } catch (java.security.NoSuchAlgorithmException missing) {
            throw new IllegalStateException(missing);
        }
    }

    static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    static String messageOf(Throwable error) {
        Throwable current = ResourceWebPreviewScope.unwrap(error);
        if (current instanceof ResourceFailure) return current.getMessage();
        if (current.getCause() != null && current.getCause() instanceof ResourceFailure) return current.getCause().getMessage();
        String message = current.getMessage();
        return message == null || message.isEmpty() ? "response" : message;
    }

    static RuntimeHostScope scope(Object input) throws ResourceFailure {
        try {
            return RuntimeHostScope.parse(input);
        } catch (RuntimeHostScopeFailure failure) {
            throw new ResourceFailure(failure.code);
        }
    }

    /** System document picker result for `save`, routed back by the activity. */
    static final class SaveRequest {
        static final int REQUEST_CODE = 0x5952;
        static volatile java.util.function.Consumer<Uri> pending;

        static boolean deliver(int requestCode, Uri uri) {
            if (requestCode != REQUEST_CODE) return false;
            java.util.function.Consumer<Uri> callback = pending;
            pending = null;
            if (callback != null) callback.accept(uri);
            return true;
        }
    }
}
