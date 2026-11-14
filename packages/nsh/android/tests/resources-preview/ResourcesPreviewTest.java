package com.yee94.yuri.nsh;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

/**
 * JVM contract test for the resources/preview bridges' pure logic.
 * Run with the commands in tests/resources-preview/README.md; no JUnit, no device.
 */
public final class ResourcesPreviewTest {
    private static int passed = 0;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        mediaPolicy();
        canonicalFiles();
        previewScopeAdmission();
        loopbackAdmission();
        scopeRouting();
        responseValidation();
        json();
        headersAndHeads();
        buffersAndRendezvous();
        contactAttachments();
        previewRequests();
        exportRequests();
        devicePolicy();
        System.out.println(passed + " assertions passed");
        if (!failures.isEmpty()) {
            System.out.println(failures.size() + " FAILED:");
            for (String failure : failures) System.out.println("  " + failure);
            System.exit(1);
        }
    }

    // ------------------------------------------------------------------- groups

    private static void mediaPolicy() {
        check("m3u playlist", ResourceMediaPolicy.kind("/a/list.m3u", "", false, false).equals("binary"));
        check("hls mime", ResourceMediaPolicy.kind("/a/x", "application/vnd.apple.mpegurl", false, false).equals("binary"));
        check("png", ResourceMediaPolicy.kind("/a/b.PNG", "", false, false).equals("image"));
        check("svg by ext", ResourceMediaPolicy.kind("/a/b.svg", "", false, false).equals("svg"));
        check("svg by mime", ResourceMediaPolicy.kind("/a/b", "image/svg+xml", false, false).equals("svg"));
        check("pdf", ResourceMediaPolicy.kind("/a/b.pdf", "", false, false).equals("pdf"));
        check("video mime", ResourceMediaPolicy.kind("/a/b", "video/mp4", false, false).equals("video"));
        check("audio mime", ResourceMediaPolicy.kind("/a/b", "audio/mpeg; charset=x", false, false).equals("audio"));
        check("mp4 ext", ResourceMediaPolicy.kind("/a/b.mp4", "", false, false).equals("video"));
        check("flac ext", ResourceMediaPolicy.kind("/a/b.flac", "", false, false).equals("audio"));
        check("text default", ResourceMediaPolicy.kind("/a/b.txt", "", false, false).equals("text"));
        check("binary flag", ResourceMediaPolicy.kind("/a/b.txt", "", true, false).equals("binary"));
        check("null byte", ResourceMediaPolicy.kind("/a/b.txt", "", false, true).equals("binary"));
        check("trailing dot extension", ResourceMediaPolicy.kind("/a/dir.v2/file", "", false, false).equals("text"));
        check("html path", ResourceMediaPolicy.isHtmlPath("/a/b.HTM"));
        check("null scan", ResourceMediaPolicy.containsNull(new byte[] {1, 0, 2}));
    }

    private static void canonicalFiles() {
        check("root", ResourceWebPreviewScope.canonicalFile("/"));
        check("nested", ResourceWebPreviewScope.canonicalFile("/a/b.html"));
        check("relative", !ResourceWebPreviewScope.canonicalFile("a/b"));
        check("double slash", !ResourceWebPreviewScope.canonicalFile("//a"));
        check("empty segment", !ResourceWebPreviewScope.canonicalFile("/a//b"));
        check("dot", !ResourceWebPreviewScope.canonicalFile("/a/./b"));
        check("dotdot", !ResourceWebPreviewScope.canonicalFile("/a/../b"));
        check("backslash", !ResourceWebPreviewScope.canonicalFile("/a\\b"));
        check("control", !ResourceWebPreviewScope.canonicalFile("/a\u0001b"));
        check("within root", ResourceWebPreviewScope.within("/a/b", "/"));
        check("within dir", ResourceWebPreviewScope.within("/a/b", "/a"));
        check("within prefix trap", !ResourceWebPreviewScope.within("/ab/b", "/a"));
        check("utf8 length", ResourceWebPreviewScope.utf8Length("é") == 2);
    }

    private static void previewScopeAdmission() throws Exception {
        ResourceWebPreviewScope scope = ResourceWebPreviewScope.html("/project", "/project/index.html");
        check("html entry encoded", scope.entryPath.equals("/project/index.html"));
        check("html directory scope", scope.directory.equals("/project") && scope.proxyBase == null);
        expectInvalid("html outside", () -> ResourceWebPreviewScope.html("/project", "/other/index.html"));
        expectInvalid("html non html", () -> ResourceWebPreviewScope.html("/project", "/project/index.txt"));
        expectInvalid("html traversal", () -> ResourceWebPreviewScope.html("/project", "/project/../x.html"));
    }

    private static void loopbackAdmission() throws Exception {
        ResourceWebPreviewScope.loopback("https://localhost:3000/path?x=1");
        ResourceWebPreviewScope.loopback("http://127.0.0.1:5173/");
        ResourceWebPreviewScope.loopback("https://0.0.0.0:8080/a#b");
        expectInvalid("ftp scheme", () -> ResourceWebPreviewScope.loopback("ftp://localhost/x"));
        expectInvalid("external host", () -> ResourceWebPreviewScope.loopback("https://example.com/x"));
        expectInvalid("credentials", () -> ResourceWebPreviewScope.loopback("https://user:pass@localhost/x"));
        expectInvalid("token query", () -> ResourceWebPreviewScope.loopback("https://localhost/x?token=1"));
        expectInvalid("preview token", () -> ResourceWebPreviewScope.loopback("https://localhost/x?yuri_preview_token=1"));
        expectInvalid("port zero", () -> ResourceWebPreviewScope.loopback("https://localhost:0/x"));
        expectInvalid("control char", () -> ResourceWebPreviewScope.loopback("https://localhost/a b"));
        expectInvalid("backslash", () -> ResourceWebPreviewScope.loopback("https://localhost/a\\b"));
        expectInvalid("space in host", () -> ResourceWebPreviewScope.loopback("https://local host/x"));
    }

    private static void scopeRouting() throws Exception {
        ResourceWebPreviewScope scope = ResourceWebPreviewScope.html("/project", "/project/index.html");
        check("route entry", scope.route("yuri-resource://owner/project/index.html", "owner").equals("/api/fs/serve/project/index.html"));
        check("route space", scope.route("yuri-resource://owner/project/a%20b.txt", "owner").equals("/api/fs/serve/project/a%20b.txt"));
        expectInvalid("route outside", () -> scope.route("yuri-resource://owner/other/x.html", "owner"));
        expectInvalid("route wrong owner", () -> scope.route("yuri-resource://intruder/project/index.html", "owner"));
        expectInvalid("route port", () -> scope.route("yuri-resource://owner:80/project/index.html", "owner"));
        expectInvalid("route credentials", () -> scope.route("yuri-resource://u@owner/project/index.html", "owner"));
        expectInvalid("route token", () -> scope.route("yuri-resource://owner/project/index.html?access_token=1", "owner"));
        expectInvalid("route dotdot", () -> scope.route("yuri-resource://owner/project/../secret", "owner"));
        expectInvalid("encoded slash escape", () -> scope.route("yuri-resource://owner/project/a%2F..%2Fb", "owner"));

        ResourceWebPreviewScope.Loopback target = ResourceWebPreviewScope.loopback("https://localhost:3000/app/index.html?q=1");
        ResourceWebPreviewScope proxy = ResourceWebPreviewScope.proxy("/api/preview/proxy/" + "a".repeat(32), target);
        check("proxy entry", proxy.entryPath.equals("/api/preview/proxy/" + "a".repeat(32) + "/app/index.html?q=1"));
        check("proxy route", proxy.route("yuri-resource://owner" + proxy.entryPath, "owner").startsWith("/api/preview/proxy/"));
        expectInvalid("proxy base", () -> ResourceWebPreviewScope.proxy("/api/preview/proxy/xyz", target));
        expectInvalid("proxy outside", () -> proxy.route("yuri-resource://owner/api/elsewhere/x", "owner"));

        check("encode path", ResourceWebPreviewScope.encodePath("/a b/c.txt").equals("/a%20b/c.txt"));
        check("stat route", ResourceWebPreviewScope.statRoute("/a b/c.txt").equals("/api/fs/stat?path=%2Fa%20b%2Fc.txt"));
        check("decode", "/a b".equals(ResourceWebPreviewScope.percentDecode("%2Fa%20b")));
        check("decode invalid", ResourceWebPreviewScope.percentDecode("%2") == null);
    }

    private static void responseValidation() throws Exception {
        ResourceWebPreviewScope.validate(new ResourceWebPreviewScope.ResourceWebPreviewResponse(200, "text/html; charset=utf-8",
                "x".getBytes(StandardCharsets.UTF_8)), true);
        expectFailure("300 status", () -> ResourceWebPreviewScope.validate(
                new ResourceWebPreviewScope.ResourceWebPreviewResponse(300, "text/html", new byte[0]), true));
        expectFailure("document mime", () -> ResourceWebPreviewScope.validate(
                new ResourceWebPreviewScope.ResourceWebPreviewResponse(200, "text/plain", new byte[0]), true));
        expectFailure("mime newline", () -> ResourceWebPreviewScope.validate(
                new ResourceWebPreviewScope.ResourceWebPreviewResponse(200, "text/html\nx", new byte[0]), true));

        ResourceWebPreviewScope.validateStat(new ResourceWebPreviewScope.ResourceWebPreviewResponse(200, "application/json",
                "{\"isFile\":true,\"size\":10}".getBytes(StandardCharsets.UTF_8)));
        expectFailure("stat not file", () -> ResourceWebPreviewScope.validateStat(
                new ResourceWebPreviewScope.ResourceWebPreviewResponse(200, "application/json",
                        "{\"isFile\":false}".getBytes(StandardCharsets.UTF_8))));
        expectFailure("stat mime", () -> ResourceWebPreviewScope.validateStat(
                new ResourceWebPreviewScope.ResourceWebPreviewResponse(200, "text/plain",
                        "{\"isFile\":true,\"size\":1}".getBytes(StandardCharsets.UTF_8))));
        expectCode("stat too large", "limit", () -> ResourceWebPreviewScope.validateStat(
                new ResourceWebPreviewScope.ResourceWebPreviewResponse(200, "application/json",
                        ("{\"isFile\":true,\"size\":" + (ResourceWebPreviewScope.RESPONSE_LIMIT + 1) + "}").getBytes(StandardCharsets.UTF_8))));
    }

    private static void json() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("z", 1.0);
        value.put("a", Arrays.asList("x", true, null));
        check("json sorted", ResourceJson.stringify(value, true).equals("{\"a\":[\"x\",true,null],\"z\":1}"));
        Object parsed = ResourceJson.parse("{\"a\":[1,{\"b\":null}],\"c\":\"d\\u0041\"}");
        Map<String, Object> object = ResourceJson.object(parsed);
        check("json parse map", object != null && object.containsKey("c"));
        check("json unicode escape", "dA".equals(object.get("c")));
        check("json bad", ResourceJson.parse("{") == null);
        check("json integer helper", Long.valueOf(5).equals(ResourceJson.integer(5.0, 0, 10)));
        check("json integral check", ResourceJson.integer(5.5, 0, 10) == null);
        check("json bool not number", ResourceJson.number(Boolean.TRUE) == null);
    }

    private static void headersAndHeads() throws Exception {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("X-Yuri-File-Exists", "true");
        headers.put("x-yuri-gui-revision", "a".repeat(64));
        headers.put("x-yuri-gui-code", "full");
        Map<String, String> checked = GuiPluginRuntime.checkedHeaders(headers);
        check("header normalize", checked.containsKey("x-yuri-file-exists") && checked.size() == 3);
        Map<String, String> unknown = new LinkedHashMap<>();
        unknown.put("cookie", "x");
        expectCode("unknown header", "response", () -> GuiPluginRuntime.checkedHeaders(unknown));
        Map<String, String> badExists = new LinkedHashMap<>();
        badExists.put("x-yuri-file-exists", "yes");
        expectCode("bad exists", "response", () -> GuiPluginRuntime.checkedHeaders(badExists));
        Map<String, String> badRevision = new LinkedHashMap<>();
        badRevision.put("x-yuri-gui-revision", "abc");
        expectCode("bad revision", "response", () -> GuiPluginRuntime.checkedHeaders(badRevision));
        Map<String, String> badCode = new LinkedHashMap<>();
        badCode.put("x-yuri-gui-code", "stale");
        expectCode("bad code", "response", () -> GuiPluginRuntime.checkedHeaders(badCode));

        Map<String, String> headHeaders = new LinkedHashMap<>();
        headHeaders.put("Content-Type", "application/json");
        GuiPluginRuntime.Head head = new GuiPluginRuntime.Head(200, headHeaders);
        check("head mime", head.mime.equals("application/json"));
        expectCode("head redirect", "response", () -> new GuiPluginRuntime.Head(302, new LinkedHashMap<>()));
        expectCode("head 600", "response", () -> new GuiPluginRuntime.Head(600, new LinkedHashMap<>()));
        check("head no mime", new GuiPluginRuntime.Head(204, new LinkedHashMap<>()).mime.isEmpty());
    }

    private static void buffersAndRendezvous() throws Exception {
        GuiPluginRuntime.Buffer buffer = new GuiPluginRuntime.Buffer(4);
        buffer.append(new byte[] {1, 2});
        buffer.append(new byte[] {3, 4});
        check("buffer value", buffer.value().length == 4);
        expectCode("buffer limit", "limit", () -> buffer.append(new byte[] {5}));

        GuiPluginRuntime.DirectBody body = new GuiPluginRuntime.DirectBody(new GuiPluginRuntime.ChunkSource() {
            private int calls = 0;

            @Override public byte[] next() throws Exception {
                calls += 1;
                if (calls == 1) return new byte[] {1, 2, 3};
                throw new IllegalStateException("upstream");
            }
        });
        byte[] first = body.read(8);
        check("direct keeps partial bytes", first != null && first.length == 3);
        try {
            body.read(8);
            check("direct terminal error", false);
        } catch (IllegalStateException expected) {
            check("direct terminal error", true);
        }
        GuiPluginRuntime.DirectBody big = new GuiPluginRuntime.DirectBody(() -> null);
        expectCode("direct limit", "busy", () -> big.read(70000));

        GuiPluginRuntime.Rendezvous relay = new GuiPluginRuntime.Rendezvous();
        check("relay head pending", !relay.awaitHead().isDone());
        relay.response(200, GuiPluginRuntime.headersOf("Content-Type", "application/json"));
        GuiPluginRuntime.Head head = relay.awaitHead().get();
        check("relay head", head.status == 200 && head.mime.equals("application/json"));
        CompletableFuture<Void> producer = relay.receive(new byte[] {1, 2, 3, 4, 5});
        check("relay backpressure", !producer.isDone());
        byte[] chunk = relay.read(2).get();
        check("relay chunk", chunk.length == 2 && chunk[0] == 1);
        check("relay still held", !producer.isDone());
        relay.read(16).get();
        check("relay producer released", producer.get(1, TimeUnit.SECONDS) == null);
        relay.finish(null);
        check("relay eof", relay.read(4).get() == null);
        relay.cancel();
        check("relay cancel", relay.cancelled());

        GuiPluginRuntime.Rendezvous failing = new GuiPluginRuntime.Rendezvous();
        failing.response(200, new LinkedHashMap<>());
        failing.awaitHead().get();
        CompletableFuture<Void> held = failing.receive(new byte[] {9, 8});
        failing.finish(new IllegalStateException("upstream"));
        byte[] tail = failing.read(1).get();
        check("relay tail kept", tail.length == 1 && tail[0] == 9);
        try {
            held.get();
            check("relay producer error", false);
        } catch (ExecutionException expected) {
            check("relay producer error", true);
        }
        failing.read(1).get();
        try {
            failing.read(1).get();
            check("relay terminal error", false);
        } catch (ExecutionException expected) {
            check("relay terminal error", "upstream".equals(expected.getCause().getMessage()));
        }
    }

    private static void contactAttachments() throws Exception {
        Map<String, Object> descriptor = new LinkedHashMap<>();
        descriptor.put("type", "file");
        descriptor.put("attachmentID", "abc.DEF-1");
        byte[] data = "hello".getBytes(StandardCharsets.UTF_8);
        descriptor.put("sha256", ResourceBridge.sha256Hex(data));
        descriptor.put("size", (double) data.length);
        descriptor.put("mime", "text/plain");
        descriptor.put("filename", "note.txt");
        descriptor.put("generation", 7.0);
        Map<String, Object> source = new LinkedHashMap<>();
        source.put("kind", "contact");
        source.put("assistantID", "assistant 1");
        source.put("descriptor", descriptor);
        ResourceBridge.ContactAttachment contact = ResourceBridge.ContactAttachment.parse(source);
        check("contact route encodes", contact.route.equals("/api/yuri/assistants/assistant%201/contact/attachments/abc.DEF-1"));
        check("contact generation route", contact.generationRoute.endsWith("/contact/messages?limit=1"));
        check("contact name", contact.name.equals("note.txt"));
        check("contact descriptor round trip", contact.descriptor().get("generation").equals(7L));
        check("contact descriptor omits absent", !contact.descriptor().containsKey("filename") == false);

        FakeLease lease = new FakeLease();
        lease.raw("/api/yuri/assistants/assistant%201/contact/messages?limit=1", 200, "application/json",
                "{\"generation\":7}".getBytes(StandardCharsets.UTF_8));
        lease.raw(contact.route, 200, "text/plain", data);
        HostLease.RawResponse verified = contact.readVerified(1000, lease);
        check("contact verified bytes", verified.data.length == 5);

        lease.reset();
        lease.raw("/api/yuri/assistants/assistant%201/contact/messages?limit=1", 200, "application/json",
                "{\"generation\":8}".getBytes(StandardCharsets.UTF_8));
        expectCode("contact stale generation", "stale", () -> contact.readVerified(1000, lease));

        Map<String, Object> wrongHash = new LinkedHashMap<>(descriptor);
        wrongHash.put("sha256", "b".repeat(64));
        Map<String, Object> badSource = new LinkedHashMap<>(source);
        badSource.put("descriptor", wrongHash);
        ResourceBridge.ContactAttachment mismatch = ResourceBridge.ContactAttachment.parse(badSource);
        FakeLease mismatchLease = new FakeLease();
        mismatchLease.raw(mismatch.generationRoute, 200, "application/json", "{\"generation\":7}".getBytes(StandardCharsets.UTF_8));
        mismatchLease.raw(mismatch.route, 200, "text/plain", data);
        expectCode("contact digest mismatch", "invalid", () -> mismatch.readVerified(1000, mismatchLease));

        Map<String, Object> legacy = new LinkedHashMap<>(descriptor);
        legacy.remove("generation");
        Map<String, Object> legacySource = new LinkedHashMap<>(source);
        legacySource.put("descriptor", legacy);
        ResourceBridge.ContactAttachment legacyContact = ResourceBridge.ContactAttachment.parse(legacySource);
        check("legacy contact has no generation", legacyContact.generation == null);

        Map<String, Object> boolSize = new LinkedHashMap<>(descriptor);
        boolSize.put("size", Boolean.TRUE);
        Map<String, Object> badSizeSource = new LinkedHashMap<>(source);
        badSizeSource.put("descriptor", boolSize);
        expectInvalid("contact boolean size", () -> ResourceBridge.ContactAttachment.parse(badSizeSource));

        Map<String, Object> tooBig = new LinkedHashMap<>(descriptor);
        tooBig.put("size", (double) (ResourceMediaPolicy.BINARY_LIMIT + 1));
        Map<String, Object> tooBigSource = new LinkedHashMap<>(source);
        tooBigSource.put("descriptor", tooBig);
        expectInvalid("contact size limit", () -> ResourceBridge.ContactAttachment.parse(tooBigSource));

        Map<String, Object> extra = new LinkedHashMap<>(source);
        extra.put("path", "/etc/passwd");
        expectInvalid("contact extra key", () -> ResourceBridge.ContactAttachment.parse(extra));

        Map<String, Object> traversalName = new LinkedHashMap<>(descriptor);
        traversalName.put("filename", "../secret");
        Map<String, Object> traversalSource = new LinkedHashMap<>(source);
        traversalSource.put("descriptor", traversalName);
        expectInvalid("contact traversal name", () -> ResourceBridge.ContactAttachment.parse(traversalSource));
    }

    private static void previewRequests() throws Exception {
        Map<String, Object> expected = new LinkedHashMap<>();
        expected.put("hostID", "host");
        expected.put("lease", "1b4e28ba-2fa1-11d2-883f-0016d3cca427");
        Map<String, Object> html = new LinkedHashMap<>();
        html.put("kind", "html");
        html.put("directory", "/project");
        html.put("path", "/project/index.html");
        html.put("expectedHost", expected);
        html.put("owner", "owner-1");
        ResourceWebPreviewBridge.Request request = ResourceWebPreviewBridge.Request.parse(html);
        check("preview request scope", request.scope.directory.equals("/project"));

        Map<String, Object> loopback = new LinkedHashMap<>();
        loopback.put("kind", "loopback");
        loopback.put("url", "https://localhost:5173/app");
        loopback.put("expectedHost", expected);
        loopback.put("owner", "owner_2");
        ResourceWebPreviewBridge.Request parsed = ResourceWebPreviewBridge.Request.parse(loopback);
        check("preview loopback", parsed.url.equals("https://localhost:5173/app") && parsed.scope == null);

        Map<String, Object> badOwner = new LinkedHashMap<>(html);
        badOwner.put("owner", "bad owner!");
        expectInvalid("preview owner", () -> ResourceWebPreviewBridge.Request.parse(badOwner));

        Map<String, Object> extra = new LinkedHashMap<>(html);
        extra.put("sessionId", "x");
        expectInvalid("preview extra key", () -> ResourceWebPreviewBridge.Request.parse(extra));

        Map<String, Object> svg = new LinkedHashMap<>();
        svg.put("lease", "1b4e28ba-2fa1-11d2-883f-0016d3cca427");
        svg.put("expectedHost", expected);
        svg.put("active", true);
        ResourceSVGImageComponent.Request svgRequest = ResourceSVGImageComponent.Request.parse(svg);
        check("svg request", svgRequest.active && svgRequest.lease.startsWith("1b4e28ba"));
        Map<String, Object> inactive = new LinkedHashMap<>(svg);
        inactive.put("active", "yes");
        expectInvalid("svg active type", () -> ResourceSVGImageComponent.Request.parse(inactive));

        String wrapper = ResourceSVGImageComponent.wrapper("<svg/>".getBytes(StandardCharsets.UTF_8));
        check("svg wrapper policy", wrapper.contains("script-src 'none'") && wrapper.contains("data:image/svg+xml;base64,"));
        try {
            ResourceSVGImageComponent.wrapper(new byte[ResourceSVGImageComponent.BYTE_LIMIT + 1]);
            check("svg byte limit", false);
        } catch (ResourceFailure expectedFailure) {
            check("svg byte limit", expectedFailure.code.equals("limit"));
        }

        check("plugin asset entry", GuiPluginPreviewScope.assetPath("/index.html"));
        check("plugin asset files", GuiPluginPreviewScope.assetPath("/assets/entry.js"));
        check("plugin asset outside", !GuiPluginPreviewScope.assetPath("/other.js"));
        check("plugin asset url", GuiPluginPreviewScope.asset("yuri-plugin://owner/assets/a.js", "owner").equals("/assets/a.js"));
        expectInvalid("plugin asset query", () -> GuiPluginPreviewScope.asset("yuri-plugin://owner/assets/a.js?x=1", "owner"));
        expectInvalid("plugin asset owner", () -> GuiPluginPreviewScope.asset("yuri-plugin://other/index.html", "owner"));
        expectInvalid("plugin asset port", () -> GuiPluginPreviewScope.asset("yuri-plugin://owner:80/index.html", "owner"));
    }

    private static void exportRequests() throws Exception {
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("html", "<div>ok</div>");
        snapshot.put("width", 400.0);
        snapshot.put("height", 900.0);
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("taskId", "task-1");
        input.put("snapshot", snapshot);
        input.put("filename", "report.html");
        YuriViewExportRenderer.Request request = new YuriViewExportRenderer.Request(input, false);
        check("export filename", request.filename.equals("report.png"));
        check("export image size", request.imageWidth() == 800 && request.imageHeight() == 1800);
        check("export document", request.document().contains("width:400px!important"));

        Map<String, Object> pdf = new LinkedHashMap<>(input);
        pdf.put("pageSize", "a4");
        check("export pdf filename", new YuriViewExportRenderer.Request(pdf, true).filename.equals("report.pdf"));
        Map<String, Object> badPage = new LinkedHashMap<>(input);
        badPage.put("pageSize", "a4");
        expectCode("export page without pdf", "EXPORT_INVALID_INPUT", () -> new YuriViewExportRenderer.Request(badPage, false));

        Map<String, Object> script = new LinkedHashMap<>(input);
        Map<String, Object> scriptSnapshot = new LinkedHashMap<>(snapshot);
        scriptSnapshot.put("html", "<script>alert(1)</script>");
        script.put("snapshot", scriptSnapshot);
        expectCode("export script", "EXPORT_FORBIDDEN", () -> new YuriViewExportRenderer.Request(script, false));

        Map<String, Object> huge = new LinkedHashMap<>(input);
        Map<String, Object> hugeSnapshot = new LinkedHashMap<>(snapshot);
        hugeSnapshot.put("width", 5000.0);
        huge.put("snapshot", hugeSnapshot);
        expectCode("export width", "EXPORT_TOO_LARGE", () -> new YuriViewExportRenderer.Request(huge, false));

        Map<String, Object> fractional = new LinkedHashMap<>(input);
        Map<String, Object> fractionalSnapshot = new LinkedHashMap<>(snapshot);
        fractionalSnapshot.put("width", 10.5);
        fractional.put("snapshot", fractionalSnapshot);
        expectCode("export fractional", "EXPORT_INVALID_INPUT", () -> new YuriViewExportRenderer.Request(fractional, false));

        Map<String, Object> traversal = new LinkedHashMap<>(input);
        traversal.put("filename", "../evil");
        expectCode("export filename", "EXPORT_INVALID_INPUT", () -> new YuriViewExportRenderer.Request(traversal, false));

        // The 32768 px ceiling already bounds A4 pages far below the 128-page cap.
        Map<String, Object> tall = new LinkedHashMap<>(snapshot);
        tall.put("height", 32768.0);
        tall.put("width", 200.0);
        Map<String, Object> tallest = new LinkedHashMap<>(input);
        tallest.put("snapshot", tall);
        tallest.put("pageSize", "letter");
        check("export tall pdf", new YuriViewExportRenderer.Request(tallest, true).letter);
        Map<String, Object> pixels = new LinkedHashMap<>(input);
        Map<String, Object> pixelSnapshot = new LinkedHashMap<>(snapshot);
        pixelSnapshot.put("width", 2048.0);
        pixelSnapshot.put("height", 8192.0);
        pixels.put("snapshot", pixelSnapshot);
        expectCode("export max pixels", "EXPORT_TOO_LARGE", () -> new YuriViewExportRenderer.Request(pixels, false));
        check("export limits", YuriViewExportRenderer.Request.limits().get("maxPixels").equals(YuriViewExportRenderer.MAX_PIXELS));
    }

    private static void devicePolicy() {
        try {
            check("device filename", GuiPluginDeviceBridge.filename("a.txt").equals("a.txt"));
            expectCode("device filename slash", "GUI_PLUGIN_INVALID_INPUT", () -> GuiPluginDeviceBridge.filename("a/b"));
            expectCode("device filename dotdot", "GUI_PLUGIN_INVALID_INPUT", () -> GuiPluginDeviceBridge.filename(".."));
            check("device external", GuiPluginDeviceBridge.external("https://example.com/x").equals("https://example.com/x"));
            check("device mailto", GuiPluginDeviceBridge.external("mailto:a@b.c").equals("mailto:a@b.c"));
            expectCode("device localhost", "GUI_PLUGIN_UNSUPPORTED", () -> GuiPluginDeviceBridge.external("http://localhost:3000/x"));
            expectCode("device ftp", "GUI_PLUGIN_INVALID_INPUT", () -> GuiPluginDeviceBridge.external("ftp://example.com/x"));
            expectCode("device credentials", "GUI_PLUGIN_INVALID_INPUT", () -> GuiPluginDeviceBridge.external("https://u:p@example.com/x"));

            Map<String, Object> toast = new LinkedHashMap<>();
            toast.put("title", "Saved");
            toast.put("description", "now");
            toast.put("variant", "success");
            toast.put("duration", 1000.0);
            GuiPluginDeviceBridge.ToastModel model = GuiPluginDeviceBridge.toast(toast);
            check("device toast text", model.text.equals("Saved\nnow") && model.seconds == 1.0);
            String identity = GuiPluginDeviceBridge.toastIdentity("owner", toast);
            check("device toast identity sorted", identity.startsWith("{\"description\""));
            Map<String, Object> withIcon = new LinkedHashMap<>(toast);
            withIcon.put("icon", "x");
            expectCode("device toast icon", "GUI_PLUGIN_UNSUPPORTED", () -> GuiPluginDeviceBridge.toast(withIcon));
            Map<String, Object> extra = new LinkedHashMap<>(toast);
            extra.put("actions", new ArrayList<>());
            expectCode("device toast actions", "GUI_PLUGIN_UNSUPPORTED", () -> GuiPluginDeviceBridge.toast(extra));
            Map<String, Object> negative = new LinkedHashMap<>(toast);
            negative.put("duration", -1.0);
            expectCode("device toast duration", "GUI_PLUGIN_INVALID_INPUT", () -> GuiPluginDeviceBridge.toast(negative));
            check("device reply", Boolean.TRUE.equals(GuiPluginDeviceBridge.reply(true, 1, null).get("ok")));
            Map<String, Object> error = GuiPluginDeviceBridge.reply(false, null, "EXPORT_BUSY");
            check("device error reply", ((Map<?, ?>) error.get("error")).get("code").equals("EXPORT_BUSY"));
        } catch (ResourceFailure unexpected) {
            check("device policy unexpected failure: " + unexpected.code, false);
        }
    }

    // ------------------------------------------------------------------ helpers

    private interface Body { void run() throws Exception; }

    private static void check(String name, boolean condition) {
        if (condition) {
            passed += 1;
        } else {
            failures.add(name);
        }
    }

    private static void expectInvalid(String name, Body body) {
        expectCode(name, "invalid", body);
    }

    private static void expectFailure(String name, Body body) {
        try {
            body.run();
            check(name + " (no failure)", false);
        } catch (Exception expected) {
            check(name, true);
        }
    }

    private static void expectCode(String name, String code, Body body) {
        try {
            body.run();
            check(name + " (no failure)", false);
        } catch (ResourceFailure failure) {
            check(name + " [" + failure.code + "]", failure.code.equals(code));
        } catch (YuriViewExportRenderer.Failure failure) {
            check(name + " [" + failure.code + "]", failure.code.equals(code));
        } catch (Exception other) {
            check(name + " (unexpected " + other.getClass().getSimpleName() + ": " + other.getMessage() + ")", false);
        }
    }

    /** Minimal authenticated transport: exact path -> fixed response, else 404. */
    private static final class FakeLease implements HostLease {
        private final Map<String, RawResponse> responses = new LinkedHashMap<>();
        private final Scope scope = new Scope("host", "1b4e28ba-2fa1-11d2-883f-0016d3cca427");
        private boolean current = true;

        void reset() { responses.clear(); current = true; }

        void raw(String path, int status, String mime, byte[] data) {
            responses.put(path, new RawResponse(status, mime, data));
        }

        @Override public Scope scope() { return scope; }

        @Override public boolean isCurrent() { return current; }

        @Override public void onRetire(Runnable cleanup) { }

        @Override public CompletableFuture<JsonResponse> json(String path, String method, Map<String, ?> body) {
            return CompletableFuture.completedFuture(new JsonResponse(404, null));
        }

        @Override public CompletableFuture<RawResponse> read(String path, int limit) {
            RawResponse response = responses.get(path);
            if (response == null) return CompletableFuture.completedFuture(new RawResponse(404, "text/plain", new byte[0]));
            return CompletableFuture.completedFuture(response);
        }

        @Override public CompletableFuture<Socket> openWebSocket(String path, SocketListener listener) {
            return CompletableFuture.completedFuture(null);
        }
    }
}
