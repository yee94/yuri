package com.yee94.yuri.nsh;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.MimeTypeMap;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * System picker plus the exact receipt protocol (iOS AttachmentBridge.swift).
 * Only the completed Host descriptor crosses the NSH bridge; bytes never do.
 * Cancellation returns null. Android has no PHPicker: both kinds use
 * ACTION_OPEN_DOCUMENT, which needs no storage permission.
 *
 * The Host transport, captured original authorization and every upload are
 * owned by RuntimeBridge through {@link AttachmentRuntime}; without it these
 * calls fail with attachment_runtime_unavailable instead of pretending to work.
 */
public final class AttachmentBridge implements NativeHandlers.Bridge, NativeHandlers.Foreground, NativeHandlers.ActivityResultSink {
    private static final String TAG = "YuriNsh";
    private static final int REQUEST = 0x5101;
    private static final int MAX_RECEIPTS = 64;
    private static final int MAX_BYTES = 25 * 1024 * 1024;

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;
    private final AttachmentRuntime runtime;
    private final AttachmentReceiptJournal journal;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "yuri-attachment");
        thread.setDaemon(true);
        return thread;
    });

    private static final class ReceiptOwner {
        final HostLease.Scope host;
        final AttachmentRuntime.Operation operation;

        ReceiptOwner(HostLease.Scope host, AttachmentRuntime.Operation operation) {
            this.host = host;
            this.operation = operation;
        }
    }

    private static final class RecoveredAcknowledgement {
        final HostLease.Scope host;
        final AttachmentRuntime.Operation.Acknowledge acknowledge;

        RecoveredAcknowledgement(HostLease.Scope host, AttachmentRuntime.Operation.Acknowledge acknowledge) {
            this.host = host;
            this.acknowledge = acknowledge;
        }
    }

    private static final class Admission {
        final String requestID;
        final HostLease.Scope host;
        final Map<String, Object> descriptor;

        Admission(String requestID, HostLease.Scope host, Map<String, Object> descriptor) {
            this.requestID = requestID;
            this.host = host;
            this.descriptor = descriptor;
        }
    }

    private static final class Cancelled extends Exception {
        Cancelled() {
            super("attachment_pick_cancelled", null, false, false);
        }
    }

    private static final class Session {
        final String requestID;
        final String kind;
        final HostLease.Scope expected;
        final CompletableFuture<Uri> picked = new CompletableFuture<>();
        volatile boolean cancelled;
        volatile AttachmentRuntime.Operation operation;

        Session(String requestID, String kind, HostLease.Scope expected) {
            this.requestID = requestID;
            this.kind = kind;
            this.expected = expected;
        }
    }

    private final Object lock = new Object();
    private Session session;
    private final Map<String, ReceiptOwner> receipts = new LinkedHashMap<>();
    private final Map<String, RecoveredAcknowledgement> recovered = new LinkedHashMap<>();
    private final List<String> confirmedRetirements = new ArrayList<>();
    private final List<Admission> confirmedAdmissions = new ArrayList<>();
    private volatile boolean invalidated;

    public AttachmentBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
        this.runtime = leases instanceof AttachmentRuntime ? (AttachmentRuntime) leases : null;
        File storage = new File(activity.getFilesDir(), "nsh/" + activity.getPackageName());
        this.journal = new AttachmentReceiptJournal(storage);
    }

    @Override
    public void install() {
        view.handle("runtime.pickAttachment", (data, reply) -> async(reply, () -> pick(data)));
        view.handle("runtime.cancelAttachment", (data, reply) -> async(reply, () -> {
            retirePick(data);
            return null;
        }));
        view.handle("runtime.reconcileAttachment", (data, reply) -> async(reply, () -> reconcilePick(data)));
        view.handle("runtime.acknowledgeAttachment", (data, reply) -> async(reply, () -> {
            acknowledgePick(data);
            return null;
        }));
        view.handle("runtime.pendingAttachments", (data, reply) -> {
            try {
                reply.resolve(pendingReceipts(data));
            } catch (Failure error) {
                reply.reject(error.code);
            } catch (Exception error) {
                reply.reject(message(error));
            }
        });
    }

    @Override
    public void invalidate() {
        invalidated = true;
        cancelSession();
        worker.shutdownNow();
        synchronized (lock) {
            receipts.clear();
            recovered.clear();
            session = null;
        }
    }

    @Override
    public void setForeground(boolean foreground) {
        if (!foreground) cancelSession();
    }

    @Override
    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST) return false;
        Session current;
        synchronized (lock) {
            current = session;
        }
        if (current == null) return true;
        if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
            current.picked.complete(data.getData());
        } else {
            current.picked.complete(null);
        }
        return true;
    }

    private void async(NshHostReply reply, Work work) {
        if (invalidated) {
            reply.reject("attachment_runtime_unavailable");
            return;
        }
        try {
            worker.execute(() -> {
            try {
                Object value = work.run();
                NativeHandlers.post(() -> reply.resolve(value));
            } catch (Failure failure) {
                NativeHandlers.post(() -> reply.reject(failure.code));
            } catch (Cancelled cancelled) {
                NativeHandlers.post(() -> reply.resolve(null));
            } catch (Exception error) {
                Log.w(TAG, "attachment call failed", error);
                NativeHandlers.post(() -> reply.reject(message(error)));
            }
            });
        } catch (java.util.concurrent.RejectedExecutionException stopped) {
            reply.reject("attachment_runtime_unavailable");
        }
    }

    private interface Work {
        Object run() throws Exception;
    }

    private static final class Failure extends Exception {
        final String code;

        Failure(String code) {
            super(code, null, false, false);
            this.code = code;
        }
    }

    private static String message(Exception error) {
        if (error instanceof AttachmentUploadPolicy.Failure) return ((AttachmentUploadPolicy.Failure) error).code;
        if (error instanceof Cancelled) return "attachment_upload_unknown";
        String text = error.getMessage();
        return text == null || text.isEmpty() ? "common_unavailable" : text;
    }

    private AttachmentRuntime runtime() throws Failure {
        AttachmentRuntime value = runtime;
        if (value == null || invalidated) throw new Failure("attachment_runtime_unavailable");
        return value;
    }

    /** Read-only list of exact receipts for one draft; a live page can only retire it. */
    private List<Object> pendingReceipts(Object input) throws Exception {
        AttachmentRuntime host = runtime();
        if (!(input instanceof Map)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        Map<?, ?> args = (Map<?, ?>) input;
        Object assistant = args.get("assistantID");
        if (!(assistant instanceof String)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        HostLease.Scope expected = scope(args.get("expectedHost"));
        AttachmentReceiptJournal.DraftContext context = AttachmentReceiptJournal.DraftContext.of(args);
        host.validateAttachmentHost(expected);
        List<Object> result = new ArrayList<>();
        synchronized (lock) {
            for (AttachmentReceiptJournal.Record saved : journal.records()) {
                if (!saved.connectionID.equals(expected.hostID) || !saved.assistantID.equals(assistant)
                    || !saved.draftID.equals(context.identity)) {
                    continue;
                }
                Map<String, Object> value = saved.publicValue();
                ReceiptOwner live = receipts.get(saved.requestID);
                if (live != null) {
                    // A newly opened JS page cannot inherit an older page's live
                    // adopter. It can only retire that exact captured operation.
                    value.put("phase", "retiring");
                    value.put("cleanupHost", publicScope(live.host));
                }
                result.add(value);
            }
        }
        return result;
    }

    private Object pick(Object input) throws Exception {
        AttachmentRuntime host = runtime();
        Map<?, ?> args = input instanceof Map ? (Map<?, ?>) input : Map.of();
        Object assistantValue = args.get("assistantID");
        if (assistantValue != null && !(assistantValue instanceof String)) {
            throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        }
        Object kind = args.get("kind");
        if (!"images".equals(kind) && !"files".equals(kind)) throw new Failure("无效的附件类型");
        Session next;
        synchronized (lock) {
            if (invalidated) throw new Cancelled();
            if (session != null) throw new Failure("请先关闭当前选择窗口");
            HostLease.Scope expected = scope(args.get("expectedHost"));
            Object requestValue = args.get("requestId");
            if (!(requestValue instanceof String)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            String requestID = (String) requestValue;
            if (requestID.isEmpty() || AttachmentUploadPolicy.utf8(requestID).length > 128 || hasControl(requestID)) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            }
            if (assistantValue != null) {
                if (receipts.containsKey(requestID) || journal.records().size() >= MAX_RECEIPTS) {
                    throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.CAPACITY);
                }
            }
            next = new Session(requestID, (String) kind, expected);
            session = next;
        }
        try {
            AttachmentRuntime.Operation captured = null;
            if (assistantValue != null) {
                String assistantID = (String) assistantValue;
                Integer generation = null;
                if (args.containsKey("contactGeneration")) {
                    generation = AttachmentUploadPolicy.safeInteger(args.get("contactGeneration"));
                }
                AttachmentReceiptJournal.DraftContext context = AttachmentReceiptJournal.DraftContext.of(args);
                try {
                    captured = host.contactOperation(next.expected, assistantID, generation, next.requestID, context, journal);
                } catch (AttachmentUploadPolicy.Failure failure) {
                    throw new Failure("attachment_capture_not_dispatched:" + failure.code);
                } catch (Exception error) {
                    throw new Failure("attachment_capture_not_dispatched:attachment_upload_invalid");
                }
                next.operation = captured;
                synchronized (lock) {
                    receipts.put(next.requestID, new ReceiptOwner(next.expected, captured));
                }
                if (next.cancelled || invalidated) {
                    retireReceipt(next.requestID);
                    throw new Cancelled();
                }
            }
            launchPicker(next);
            Uri picked = awaitPick(next);
            if (picked == null) {
                retireReceipt(next.requestID);
                return null;
            }
            if (invalidated || next.cancelled) throw new Cancelled();
            NativeAttachment attachment = read(picked);
            AttachmentRuntime.Operation operation = next.operation;
            try {
                if (operation != null) return operation.upload.upload(attachment.data, attachment.name, attachment.mime);
                return host.uploadPlain(next.expected, attachment.data, attachment.name, attachment.mime);
            } catch (AttachmentUploadPolicy.Failure failure) {
                ReceiptOwner receipt = receipts.get(next.requestID);
                if (receipt != null && receipt.operation != null && !receipt.operation.dispatched.getAsBoolean()) {
                    throw new Failure(AttachmentUploadPolicy.Failure.NOT_DISPATCHED);
                }
                throw failure;
            }
        } finally {
            synchronized (lock) {
                if (session == next) session = null;
            }
        }
    }

    private void launchPicker(Session next) throws Exception {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("images".equals(next.kind) ? "image/*" : "*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        CompletableFuture<Void> launched = new CompletableFuture<>();
        NativeHandlers.post(() -> {
            try {
                activity.startActivityForResult(intent, REQUEST);
                launched.complete(null);
            } catch (RuntimeException error) {
                launched.completeExceptionally(error);
            }
        });
        try {
            launched.get();
        } catch (ExecutionException error) {
            throw new Failure("无法打开文件选择器");
        }
    }

    private Uri awaitPick(Session next) throws Exception {
        try {
            return next.picked.get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new Cancelled();
        } catch (ExecutionException error) {
            throw new Cancelled();
        }
    }

    private void retirePick(Object input) throws Exception {
        if (!(input instanceof Map)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        Map<?, ?> args = (Map<?, ?>) input;
        Object requestValue = args.get("requestId");
        if (!(requestValue instanceof String)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        String requestID = (String) requestValue;
        HostLease.Scope expected = scope(args.get("expectedHost"));
        cancelExact(requestID, expected);
        ReceiptOwner receipt;
        synchronized (lock) {
            receipt = receipts.get(requestID);
        }
        if (receipt != null) {
            if (!receipt.host.equals(expected)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            retireReceipt(requestID);
            return;
        }
        Session current;
        synchronized (lock) {
            current = session;
        }
        if (current != null && current.requestID.equals(requestID)) {
            // A generation capture may still be in flight; absence is not ACK.
            throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.UNKNOWN);
        }
        AttachmentReceiptJournal.Record saved = null;
        for (AttachmentReceiptJournal.Record record : journal.records()) {
            if (record.requestID.equals(requestID)) {
                saved = record;
                break;
            }
        }
        if (saved != null) {
            if (!saved.connectionID.equals(expected.hostID)) {
                throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            }
            synchronized (lock) {
                recovered.remove(requestID);
            }
            if ("retired".equals(saved.phase)) journal.remove(requestID, saved.uploadID);
            else runtime().restoreOperation(saved, expected, journal).retire.retire();
            confirmRetirement(requestID);
            return;
        }
        if (args.get("assistantID") != null && !confirmedRetirements.contains(requestID)) {
            throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.UNKNOWN);
        }
    }

    private Object reconcilePick(Object input) throws Exception {
        AttachmentRuntime host = runtime();
        if (!(input instanceof Map)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        Map<?, ?> args = (Map<?, ?>) input;
        Object requestValue = args.get("requestId");
        if (!(requestValue instanceof String)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        String requestID = (String) requestValue;
        HostLease.Scope expected = scope(args.get("expectedHost"));
        ReceiptOwner receipt;
        synchronized (lock) {
            receipt = receipts.get(requestID);
        }
        if (receipt != null) {
            if (!receipt.host.equals(expected)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            return receipt.operation.reconcile.reconcile();
        }
        AttachmentReceiptJournal.Record saved = null;
        for (AttachmentReceiptJournal.Record record : journal.records()) {
            if (record.requestID.equals(requestID)) {
                saved = record;
                break;
            }
        }
        if (saved == null) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.UNKNOWN);
        AttachmentRuntime.Operation restored = host.restoreOperation(saved, expected, journal);
        Map<String, Object> descriptor = restored.reconcile.reconcile();
        if (descriptor != null) {
            // Retain only exact local disposal after a committed cold GET.
            synchronized (lock) {
                recovered.put(requestID, new RecoveredAcknowledgement(expected, restored.acknowledge));
            }
        }
        return descriptor;
    }

    private void acknowledgePick(Object input) throws Exception {
        if (!(input instanceof Map)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        Map<?, ?> args = (Map<?, ?>) input;
        Object requestValue = args.get("requestId");
        if (!(requestValue instanceof String)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        String requestID = (String) requestValue;
        HostLease.Scope expected = scope(args.get("expectedHost"));
        synchronized (lock) {
            for (Admission prior : confirmedAdmissions) {
                if (!prior.requestID.equals(requestID)) continue;
                if (!prior.host.equals(expected) || !prior.descriptor.equals(args.get("descriptor"))) {
                    throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
                }
                return;
            }
        }
        ReceiptOwner receipt;
        RecoveredAcknowledgement recovery;
        synchronized (lock) {
            receipt = receipts.get(requestID);
            recovery = recovered.get(requestID);
        }
        if (receipt != null) {
            if (!receipt.host.equals(expected)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            receipt.operation.acknowledge.acknowledge(args.get("descriptor"));
            synchronized (lock) {
                receipts.remove(requestID);
            }
        } else if (recovery != null) {
            if (!recovery.host.equals(expected)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
            recovery.acknowledge.acknowledge(args.get("descriptor"));
            synchronized (lock) {
                recovered.remove(requestID);
            }
        } else {
            throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.UNKNOWN);
        }
        Object descriptor = args.get("descriptor");
        if (!(descriptor instanceof Map)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        @SuppressWarnings("unchecked")
        Map<String, Object> value = (Map<String, Object>) descriptor;
        synchronized (lock) {
            confirmedAdmissions.add(new Admission(requestID, expected, value));
            if (confirmedAdmissions.size() > MAX_RECEIPTS) confirmedAdmissions.remove(0);
        }
    }

    private void cancelSession() {
        Session current;
        synchronized (lock) {
            current = session;
        }
        if (current == null) return;
        current.cancelled = true;
        current.picked.completeExceptionally(new Cancelled());
    }

    private void cancelExact(String requestID, HostLease.Scope expected) {
        Session current;
        synchronized (lock) {
            current = session;
        }
        if (current == null || !current.requestID.equals(requestID) || !current.expected.equals(expected)) return;
        cancelSession();
    }

    private void retireReceipt(String requestID) throws Exception {
        ReceiptOwner receipt;
        synchronized (lock) {
            receipt = receipts.remove(requestID);
        }
        if (receipt == null) return;
        receipt.operation.retire.retire();
        confirmRetirement(requestID);
    }

    private void confirmRetirement(String requestID) {
        synchronized (lock) {
            confirmedRetirements.removeIf(value -> value.equals(requestID));
            confirmedRetirements.add(requestID);
            if (confirmedRetirements.size() > MAX_RECEIPTS) confirmedRetirements.remove(0);
        }
    }

    private HostLease.Scope scope(Object value) throws AttachmentUploadPolicy.Failure {
        if (!(value instanceof Map)) throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        Map<?, ?> data = (Map<?, ?>) value;
        Object hostID = data.get("hostID");
        Object lease = data.get("lease");
        if (!(hostID instanceof String) || ((String) hostID).isEmpty()
            || AttachmentUploadPolicy.utf8((String) hostID).length > 512) {
            throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        }
        if (!(lease instanceof String) || ((String) lease).isEmpty()) {
            throw new AttachmentUploadPolicy.Failure(AttachmentUploadPolicy.Failure.INVALID);
        }
        return new HostLease.Scope((String) hostID, (String) lease);
    }

    private static Map<String, Object> publicScope(HostLease.Scope scope) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("hostID", scope.hostID);
        value.put("lease", scope.lease);
        return value;
    }

    private static boolean hasControl(String value) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7f) return true;
        }
        return false;
    }

    private static final class NativeAttachment {
        final byte[] data;
        final String name;
        final String mime;

        NativeAttachment(byte[] data, String name, String mime) {
            this.data = data;
            this.name = name;
            this.mime = mime;
        }
    }

    /** No-follow regular file only: directories, empty files and >25 MiB are refused. */
    private NativeAttachment read(Uri uri) throws Exception {
        ContentResolver resolver = activity.getContentResolver();
        String mime = resolver.getType(uri);
        String name = null;
        long declared = -1;
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) declared = cursor.getLong(sizeIndex);
            }
        }
        if ("vnd.android.document/directory".equals(mime)) throw new Failure("不支持目录或符号链接，请选择单个文件");
        if (declared == 0 || declared > MAX_BYTES || declared < -1) throw new Failure("附件须为非空文件，且不超过 25 MiB");
        byte[] data = new byte[Math.max(64 * 1024, declared > 0 ? (int) declared : 64 * 1024)];
        int read = 0;
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) throw new Failure("无法读取附件，请重新选择文件");
            while (true) {
                if (read == data.length) {
                    if (read >= MAX_BYTES) throw new Failure("附件超过 25 MiB 限制");
                    data = Arrays.copyOf(data, Math.min(MAX_BYTES + 1, Math.max(read + 64 * 1024, read * 2)));
                }
                int step = input.read(data, read, Math.min(data.length - read, MAX_BYTES + 1 - read));
                if (step < 0) break;
                read += step;
                if (read > MAX_BYTES) throw new Failure("附件超过 25 MiB 限制");
            }
        }
        if (read == 0) throw new Failure("附件为空");
        if (declared > 0 && read != declared) throw new Failure("无法读取附件，请重新选择文件");
        String filename = name == null ? "attachment" : name;
        int separator = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
        if (separator >= 0) filename = filename.substring(separator + 1);
        if (filename.isEmpty() || AttachmentUploadPolicy.utf8(filename).length > 1024 || hasControl(filename)) {
            throw new Failure("无效的附件文件名");
        }
        if (filename.contains("..")) throw new Failure("无效的附件文件名");
        if (mime == null) {
            int dot = filename.lastIndexOf('.');
            mime = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(filename.substring(dot + 1).toLowerCase(java.util.Locale.ROOT));
        }
        if (mime == null) mime = "application/octet-stream";
        return new NativeAttachment(Arrays.copyOf(data, read), filename, mime);
    }
}
