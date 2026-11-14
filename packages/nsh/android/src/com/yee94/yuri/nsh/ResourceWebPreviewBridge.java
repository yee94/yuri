package com.yee94.yuri.nsh;

import android.app.Activity;
import android.app.Dialog;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

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
 * Port of iOS `ResourceWebPreviewBridge`: the independent resource HTML preview
 * (inline Files mount and fullscreen modal). It never renders the NSH UI and adds
 * no application JavaScript bridge.
 *
 * WK's exact-controller presentation and scheme handler have no Android
 * counterpart: the modal is our own fullscreen `Dialog`, and the document is
 * served through `shouldInterceptRequest` with the identical owner/route/size
 * rules (see `ResourceWebPreviewView`). `presentationOwner` registration is
 * therefore not consumed here — `resources.present` uses it instead.
 */
public final class ResourceWebPreviewBridge {
    static final class Request {
        final RuntimeHostScope expectedHost;
        final String owner;
        final ResourceWebPreviewScope scope;
        final String path;
        final String url;

        private Request(RuntimeHostScope expectedHost, String owner, ResourceWebPreviewScope scope, String path, String url) {
            this.expectedHost = expectedHost;
            this.owner = owner;
            this.scope = scope;
            this.path = path;
            this.url = url;
        }

        static String[] identity(Object input) throws ResourceFailure {
            Map<String, Object> args = ResourceJson.object(input);
            String owner = args == null ? null : ResourceJson.text(args.get("owner"));
            if (owner == null || owner.isEmpty() || ResourceWebPreviewScope.utf8Length(owner) > 128
                    || !owner.matches("^[a-zA-Z0-9_-]+$")) throw ResourceFailure.invalid();
            return new String[] { null, owner };
        }

        static Request parse(Object input) throws ResourceFailure {
            Map<String, Object> args = ResourceJson.object(input);
            String owner = identity(input)[1];
            String kind = ResourceJson.text(args.get("kind"));
            RuntimeHostScope expected = ResourceBridge.scope(args.get("expectedHost"));
            if ("html".equals(kind) && args.keySet().equals(new HashSet<>(
                    java.util.Arrays.asList("kind", "directory", "path", "expectedHost", "owner")))) {
                String directory = ResourceJson.text(args.get("directory"));
                String path = ResourceJson.text(args.get("path"));
                if (directory == null || path == null) throw ResourceFailure.invalid();
                return new Request(expected, owner, ResourceWebPreviewScope.html(directory, path), path, null);
            }
            if ("loopback".equals(kind) && args.keySet().equals(new HashSet<>(
                    java.util.Arrays.asList("kind", "url", "expectedHost", "owner")))) {
                String url = ResourceJson.text(args.get("url"));
                if (url == null) throw ResourceFailure.invalid();
                ResourceWebPreviewScope.loopback(url);
                return new Request(expected, owner, null, null, url);
            }
            throw ResourceFailure.invalid();
        }
    }

    /** Exact-ticket gate shared by admission and the WebView callbacks. */
    static final class Ownership {
        static final class Ticket {
            final Request request;
            final ResourceWebPreviewScope.ResourceWebPreviewTransport transport;
            boolean closing = false;
            final List<CompletableFuture<Void>> closed = new ArrayList<>();

            Ticket(Request request, ResourceWebPreviewScope.ResourceWebPreviewTransport transport) {
                this.request = request;
                this.transport = transport;
            }
        }

        interface Capture {
            ResourceWebPreviewScope.ResourceWebPreviewTransport capture(RuntimeHostScope expectedHost) throws Exception;
        }

        Ticket active;
        private final Map<String, Set<String>> closedOwners = new HashMap<>();
        private int closedCount = 0;
        private boolean closedOverflow = false;

        private static String scopeKey(RuntimeHostScope scope) { return scope.hostID + ":" + scope.lease; }

        synchronized Ticket begin(Object input, Capture capture) throws Exception {
            Request request = Request.parse(input);
            Set<String> closed = closedOwners.get(scopeKey(request.expectedHost));
            if (closedOverflow || closed != null && closed.contains(request.owner)) throw ResourceFailure.stale();
            if (active != null) throw ResourceFailure.busy();
            ResourceWebPreviewScope.ResourceWebPreviewTransport transport = capture.capture(request.expectedHost);
            if (!transport.isCurrent()) throw ResourceFailure.stale();
            Ticket ticket = new Ticket(request, transport);
            active = ticket;
            return ticket;
        }

        synchronized boolean matches(Ticket ticket) { return active == ticket && !ticket.closing; }

        synchronized boolean startClosing(Ticket ticket) {
            if (!matches(ticket)) return false;
            rememberClosed(ticket.request.expectedHost, ticket.request.owner);
            ticket.closing = true;
            return true;
        }

        synchronized boolean retire(Ticket ticket) {
            if (active != ticket) return false;
            active = null;
            List<CompletableFuture<Void>> pending = new ArrayList<>(ticket.closed);
            ticket.closed.clear();
            for (CompletableFuture<Void> waiter : pending) waiter.complete(null);
            return true;
        }

        synchronized CompletableFuture<Void> waitClosed(Ticket ticket) {
            if (active != ticket) return CompletableFuture.completedFuture(null);
            CompletableFuture<Void> waiter = new CompletableFuture<>();
            ticket.closed.add(waiter);
            return waiter;
        }

        synchronized void invalidateClosedOwners() {
            closedOwners.clear();
            closedCount = 0;
            closedOverflow = false;
        }

        /** Returns the active ticket, or null after remembering an admitted unknown close. */
        synchronized Ticket closing(Object input, Capture capture) throws Exception {
            Map<String, Object> args = ResourceJson.object(input);
            String owner = Request.identity(input)[1];
            if (args == null || !args.keySet().equals(new HashSet<>(java.util.Arrays.asList("expectedHost", "owner")))) {
                throw ResourceFailure.invalid();
            }
            RuntimeHostScope expected = ResourceBridge.scope(args.get("expectedHost"));
            if (active != null && active.request.owner.equals(owner) && active.request.expectedHost.equals(expected)) {
                rememberClosed(expected, owner);
                return active;
            }
            try {
                if (!capture.capture(expected).isCurrent()) return null;
            } catch (Exception unavailable) {
                return null;
            }
            rememberClosed(expected, owner);
            return null;
        }

        private void rememberClosed(RuntimeHostScope expected, String owner) {
            String key = scopeKey(expected);
            Set<String> owners = closedOwners.get(key);
            if (owners != null && owners.contains(owner)) return;
            if (closedCount >= 4096) {
                closedOverflow = true;
                return;
            }
            if (owners == null) {
                owners = new HashSet<>();
                closedOwners.put(key, owners);
            }
            owners.add(owner);
            closedCount += 1;
        }
    }

    interface InitialFile {
        ResourceWebPreviewScope.ResourceWebPreviewResponse read(String lease, String path, RuntimeHostScope expectedHost) throws Exception;
    }

    interface Diagnostic {
        void report(String stage, String domain, Integer code);
    }

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "yuri-resource-web");
        thread.setDaemon(true);
        return thread;
    });
    private final Ownership ownership = new Ownership();
    private final Ownership.Capture capture = this::captureTransport;
    private InitialFile initialFile;
    private Diagnostic diagnostic;
    private CompletableFuture<Object> completion;
    private Dialog dialog;
    private ResourceWebPreviewView surface;
    private ResourceWebPreviewView.Mount embedded;
    private String stage = "capture";
    private String presentingOwner;
    private boolean diagnosedFailure = false;

    public ResourceWebPreviewBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    /** The captured Runtime owner may add a raw sender for loopback previews. */
    public void setInitialFile(InitialFile initialFile) { this.initialFile = initialFile; }

    public void setDiagnostic(Diagnostic diagnostic) { this.diagnostic = diagnostic; }

    public void install() {
        view.handle("resources.web.present", (data, reply) -> present(data, reply));
        view.handle("resources.web.close", (data, reply) -> {
            CompletableFuture<Void> closed = close(data);
            closed.whenComplete((value, error) -> reply.resolve(true));
        });
    }

    /** Runtime invalidation, background and teardown. */
    public void invalidate() {
        enter("invalidated");
        Ownership.Ticket ticket = ownership.active;
        if (ticket != null) terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled")));
        ownership.invalidateClosedOwners();
        executor.shutdownNow();
    }

    boolean ownsPresentation(String owner) {
        return completion != null && owner != null && owner.equals(presentingOwner);
    }

    void setForeground(boolean foreground) {
        if (!foreground && ownership.active != null) {
            terminate(ownership.active, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled")));
        }
    }

    private void report(String nextStage, String domain, Integer code) {
        stage = nextStage;
        if (domain != null) diagnosedFailure = true;
        if (diagnostic != null) diagnostic.report(nextStage, domain, code);
    }

    private void enter(String nextStage) { report(nextStage, null, null); }

    // ---------------------------------------------------------------- present

    private void present(Object data, NshHostReply reply) {
        Ownership.Ticket ticket;
        try {
            if (activity.isFinishing() || activity.isDestroyed()) throw ResourceFailure.stale();
            ticket = ownership.begin(data, capture);
        } catch (Exception failure) {
            reply.reject(ResourceBridge.messageOf(failure));
            return;
        }
        diagnosedFailure = false;
        enter("capture");
        CompletableFuture.runAsync(() -> {
            try {
                ResourceWebPreviewView.Prepared prepared = prepare(ticket, null);
                main.post(() -> show(ticket, prepared, reply));
            } catch (Exception failure) {
                if (ownership.matches(ticket) && !diagnosedFailure) report(stage, domainOf(failure), 0);
                if (ownership.matches(ticket)) terminate(ticket, failure);
                reply.reject(ResourceBridge.messageOf(failure));
            }
        }, executor);
    }

    private void show(Ownership.Ticket ticket, ResourceWebPreviewView.Prepared prepared, NshHostReply reply) {
        if (!ownership.matches(ticket) || dialog != null || completion != null) {
            terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("busy")));
            reply.reject("busy");
            return;
        }
        if (!prepared.current.current() || activity.isFinishing()) {
            terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled")));
            reply.reject("cancelled");
            return;
        }
        enter("modal.present");
        ResourceWebPreviewView content = new ResourceWebPreviewView(activity, prepared);
        surface = content;
        CompletableFuture<Object> pending = new CompletableFuture<>();
        completion = pending;
        presentingOwner = null;
        Dialog sheet = new Dialog(activity, android.R.style.Theme_Material_NoActionBar_Fullscreen);
        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.addView(bar(ticket, content), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        column.addView(content, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        sheet.setContentView(column);
        sheet.setOnCancelListener(ignored -> terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled"))));
        content.onFailure = () -> terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("response")));
        dialog = sheet;
        sheet.show();
        pending.whenComplete((value, error) -> {
            if (error == null) reply.resolve(value);
            else reply.reject(ResourceBridge.messageOf(error));
        });
    }

    private View bar(Ownership.Ticket ticket, ResourceWebPreviewView content) {
        LinearLayout bar = new LinearLayout(activity);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(0xff1b1b1b);
        Button back = button("‹");
        back.setVisibility(View.GONE);
        back.setOnClickListener(ignored -> {
            if (content.canGoBack()) {
                content.goBack();
                back.setVisibility(View.VISIBLE);
            }
        });
        Button close = button("✕");
        close.setOnClickListener(ignored -> terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled"))));
        Button retry = button("⟳");
        retry.setOnClickListener(ignored -> {
            if (!ownership.matches(ticket)) return;
            terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled")));
        });
        bar.addView(back);
        TextView title = new TextView(activity);
        title.setText(ticket.request.path == null ? ticket.request.url : ticket.request.path);
        title.setTextColor(0xffffffff);
        title.setSingleLine(true);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(retry);
        bar.addView(close);
        content.onLoaded = () -> { };
        return bar;
    }

    private Button button(String label) {
        Button button = new Button(activity);
        button.setText(label);
        button.setBackgroundColor(0x00000000);
        button.setTextColor(0xffffffff);
        return button;
    }

    private CompletableFuture<Void> close(Object data) {
        try {
            Ownership.Ticket ticket = ownership.closing(data, capture);
            if (ticket == null) return CompletableFuture.completedFuture(null);
            terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled")));
            return ownership.waitClosed(ticket);
        } catch (Exception failure) {
            CompletableFuture<Void> failed = new CompletableFuture<>();
            failed.completeExceptionally(failure);
            return failed;
        }
    }

    private void terminate(Ownership.Ticket ticket, Throwable failure) {
        if (!ownership.startClosing(ticket)) return;
        ResourceWebPreviewView closingSurface = surface;
        surface = null;
        ResourceWebPreviewView.Mount closingEmbedded = embedded;
        embedded = null;
        Dialog closingDialog = dialog;
        dialog = null;
        CompletableFuture<Object> pending = completion;
        completion = null;
        if (closingSurface != null) closingSurface.stop();
        if (closingEmbedded != null) closingEmbedded.stop(ticket.request.owner);
        if (closingDialog != null) closingDialog.dismiss();
        enter("closed");
        ownership.retire(ticket);
        if (pending != null) pending.completeExceptionally(failure);
    }

    // ------------------------------------------------------------------ mount

    void mount(Object input, ResourceWebPreviewView.Mount host) throws Exception {
        Map<String, Object> args = ResourceJson.object(input);
        if (args == null || !args.keySet().equals(new HashSet<>(
                java.util.Arrays.asList("owner", "expectedHost", "directory", "path", "lease")))) throw ResourceFailure.invalid();
        String lease = ResourceJson.text(args.get("lease"));
        String path = ResourceJson.text(args.get("path"));
        if (lease == null || path == null || initialFile == null || activity.isFinishing()) throw ResourceFailure.invalid();
        Map<String, Object> intent = new LinkedHashMap<>(args);
        intent.remove("lease");
        intent.put("kind", "html");
        Ownership.Ticket ticket = ownership.begin(intent, capture);
        ResourceWebPreviewScope.ResourceWebPreviewResponse initial;
        try {
            initial = initialFile.read(lease, path, ticket.request.expectedHost);
        } catch (Exception failure) {
            terminate(ticket, failure);
            throw failure;
        }
        embedded = host;
        CompletableFuture.runAsync(() -> {
            try {
                ResourceWebPreviewView.Prepared prepared = prepare(ticket, initial);
                main.post(() -> {
                    if (!ownership.matches(ticket) || !prepared.current.current() || host.getWindowToken() == null) {
                        terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled")));
                        return;
                    }
                    enter("response.construct");
                    ResourceWebPreviewView content = new ResourceWebPreviewView(activity, prepared);
                    content.onFailure = () -> {
                        host.failed(ticket.request.owner);
                        terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("response")));
                    };
                    host.adopt(content, ticket.request.owner);
                });
            } catch (Exception failure) {
                main.post(() -> {
                    if (!ownership.matches(ticket)) return;
                    host.failed(ticket.request.owner);
                    terminate(ticket, failure);
                });
            }
        }, executor);
    }

    void detach(String owner) {
        Ownership.Ticket ticket = ownership.active;
        if (ticket == null || !ticket.request.owner.equals(owner)) return;
        terminate(ticket, ResourceWebPreviewScope.unchecked(new ResourceFailure("cancelled")));
    }

    // ----------------------------------------------------------------- prepare

    private ResourceWebPreviewView.Prepared prepare(Ownership.Ticket ticket,
            ResourceWebPreviewScope.ResourceWebPreviewResponse adopted) throws Exception {
        if (activity.isFinishing() || activity.isDestroyed()) throw ResourceFailure.stale();
        if (!ownership.matches(ticket)) throw ResourceFailure.stale();
        ResourceWebPreviewScope.ResourceWebPreviewTransport transport = ticket.transport;
        Request request = ticket.request;
        ResourceWebPreviewView.Current admitted = () -> ownership.matches(ticket) && transport.isCurrent()
                && !activity.isFinishing() && !activity.isDestroyed();
        if (!admitted.current()) throw ResourceFailure.stale();
        enter("intent");
        ResourceWebPreviewScope scope;
        ResourceWebPreviewScope.ResourceWebPreviewTransport.ReadRoute read;
        final long expiresAt;
        if (request.scope != null) {
            scope = request.scope;
            read = transport.readFile;
            expiresAt = 0;
        } else {
            ResourceWebPreviewScope.Loopback target = ResourceWebPreviewScope.loopback(request.url);
            enter("proxy.prepare");
            ResourceWebPreviewScope.ResourceWebPreviewProxy proxy = ResourceWebPreviewScope.checked(
                    transport.prepareLoopback(request.url)).get();
            if (!admitted.current()) throw ResourceFailure.stale();
            scope = ResourceWebPreviewScope.proxy(proxy.basePath, target);
            read = proxy.read;
            expiresAt = proxy.expiresAtMillis;
        }
        final String owner = UUID.randomUUID().toString().toLowerCase(java.util.Locale.ROOT);
        enter("entry.url");
        final ResourceWebPreviewScope capturedScope = scope;
        final String entryPath = scope.entryPath;
        ResourceWebPreviewView.Current current = () -> admitted.current()
                && (expiresAt == 0 || expiresAt > System.currentTimeMillis());
        enter("current");
        if (!current.current()) throw ResourceFailure.stale();
        if (adopted == null && request.path != null && scope.directory != null) {
            enter("stat.read");
            ResourceWebPreviewScope.ResourceWebPreviewResponse stat = ResourceWebPreviewScope.checked(
                    read.read(ResourceWebPreviewScope.statRoute(request.path), ResourceMediaPolicy.STAT_LIMIT)).get();
            enter("stat.validate");
            ResourceWebPreviewScope.validateStat(stat);
            if (!current.current()) throw ResourceFailure.stale();
        }
        enter("entry.read");
        ResourceWebPreviewScope.ResourceWebPreviewResponse initial = adopted;
        if (initial == null) {
            String entry = capturedScope.route(ResourceWebPreviewScope.SCHEME + "://" + owner + entryPath, owner);
            initial = ResourceWebPreviewScope.checked(read.read(entry, ResourceWebPreviewScope.RESPONSE_LIMIT)).get();
        }
        enter("entry.validate");
        ResourceWebPreviewScope.validate(initial, true);
        if (!current.current()) throw ResourceFailure.stale();
        return new ResourceWebPreviewView.Prepared(capturedScope, owner, entryPath, initial, current,
                (route, limit) -> {
                    try {
                        return ResourceWebPreviewScope.checked(read.read(route, limit)).get();
                    } catch (java.util.concurrent.ExecutionException failure) {
                        throw ResourceWebPreviewScope.asException(failure);
                    }
                },
                (reportedStage, domain, code) -> {
                    if (ownership.matches(ticket)) report(reportedStage, domain, code);
                });
    }

    private ResourceWebPreviewScope.ResourceWebPreviewTransport captureTransport(RuntimeHostScope expectedHost) throws Exception {
        HostLease lease = leases.capture(expectedHost.toLeaseScope());
        return transport(lease);
    }

    /** Authenticated, generation-fenced transport for one captured Host. */
    static ResourceWebPreviewScope.ResourceWebPreviewTransport transport(HostLease lease) {
        ResourceWebPreviewScope.ResourceWebPreviewTransport.ReadRoute read = (route, limit) ->
                lease.read(route, limit).thenApply(response ->
                        new ResourceWebPreviewScope.ResourceWebPreviewResponse(response.status, response.mime, response.data));
        return new ResourceWebPreviewScope.ResourceWebPreviewTransport(read, lease, null);
    }

    private static String domainOf(Throwable error) {
        Throwable unwrapped = ResourceWebPreviewScope.unwrap(error);
        if (unwrapped instanceof ResourceFailure) return "ResourceWebPreviewFailure";
        if (unwrapped instanceof java.util.concurrent.CancellationException) return "CancellationError";
        return "OtherErrorDomain";
    }

    /** Optional native-only diagnostics: stage plus error domain/code, never URLs or page data. */
    static final class StageNames {
        private StageNames() {}
        static final String CAPTURE = "capture", INTENT = "intent", PROXY_PREPARE = "proxy.prepare";
        static final String ENTRY_URL = "entry.url", CURRENT = "current", STAT_READ = "stat.read";
    }
}
