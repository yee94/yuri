import com.yee94.yuri.nsh.NotificationFailure;
import com.yee94.yuri.nsh.PasskeyFailure;
import com.yee94.yuri.nsh.PasskeyManagementLabels;
import com.yee94.yuri.nsh.PasskeyManagementSession;
import com.yee94.yuri.nsh.PasskeyPresentationAdmission;
import com.yee94.yuri.nsh.PasskeyRegistrationOptions;
import com.yee94.yuri.nsh.PasskeyWire;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Plain JVM checks for the Android passkey policy, session isolation and one-attempt proof. */
public final class Main {
    private static int checks;

    private static void check(boolean condition, String label) {
        checks++;
        if (!condition) throw new AssertionError(label);
    }

    private interface Action { void run() throws Exception; }

    private static void rejects(String label, Action action) {
        try {
            action.run();
        } catch (Exception expected) {
            checks++;
            return;
        }
        throw new AssertionError("accepted " + label);
    }

    private static Map<String, Object> map(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) out.put((String) pairs[index], pairs[index + 1]);
        return out;
    }

    private static Map<String, List<String>> headers(String name, String value) {
        Map<String, List<String>> out = new HashMap<>();
        out.put(name, new ArrayList<>(List.of(value)));
        return out;
    }

    public static void main(String[] args) throws Exception {
        // Presentation reservation: cancel keeps the receipt occupied until its owner releases it.
        PasskeyPresentationAdmission admission = new PasskeyPresentationAdmission();
        UUID first = admission.reserve();
        rejects("second reservation is busy", admission::reserve);
        admission.release(UUID.randomUUID());
        rejects("wrong receipt cannot release", admission::reserve);
        admission.cancel(first);
        rejects("cancelled receipt stays occupied", admission::reserve);
        admission.release(first);
        UUID second = admission.reserve();
        admission.release(first);
        check(admission.isCurrent(second), "late old release cannot clear a newer owner");
        admission.beginClose();
        rejects("closed admission rejects new work", admission::reserve);
        check(!admission.drain(50), "close waits for the exact live owner");
        admission.release(second);
        check(admission.drain(50), "owner release completes the close");

        // Labels.
        Map<String, Object> labels = map("title", "解锁 Yuri", "cancel", "取消", "submit", "解锁",
                "passwordPlaceholder", "输入密码");
        PasskeyManagementLabels.parse(labels);
        Map<String, Object> extra = new LinkedHashMap<>(labels);
        extra.put("password", "not-permitted");
        rejects("label extra key", () -> PasskeyManagementLabels.parse(extra));
        for (Object invalid : new Object[] {"", "\n", repeat("x", 513), 42L, null, "line\nbreak"}) {
            Map<String, Object> bad = new LinkedHashMap<>(labels);
            bad.put("submit", invalid);
            rejects("label content bounded", () -> PasskeyManagementLabels.parse(bad));
        }

        // Wire and options.
        URI origin = URI.create("https://host.example");
        Map<String, Object> options = map(
                "rp", map("id", "host.example", "name", "Yuri"),
                "user", map("id", "AQI", "name", "yuri-ui"),
                "challenge", "AwQ",
                "pubKeyCredParams", new ArrayList<>(List.of(map("type", "public-key", "alg", -7L))),
                "excludeCredentials", new ArrayList<>(List.of(map("id", "BQY", "type", "public-key"))),
                "authenticatorSelection", map("residentKey", "required", "userVerification", "required"),
                "attestation", "none");
        Set<String> domains = new HashSet<>(List.of("webcredentials:host.example"));
        PasskeyRegistrationOptions parsed = PasskeyRegistrationOptions.parse(options, origin, domains);
        check(Arrays.equals(parsed.userID, new byte[] {1, 2}) && parsed.excluded.size() == 1
                && Arrays.equals(parsed.excluded.get(0), new byte[] {5, 6}) && parsed.verification.equals("required"),
                "real base64url options");
        for (String invalid : new String[] {"AQ==", "+w", "A", " AB", "AB"}) {
            rejects("noncanonical base64url " + invalid, () -> PasskeyWire.decode(invalid));
        }
        rejects("missing entitlement", () -> PasskeyRegistrationOptions.parse(options, origin, new HashSet<>()));
        rejects("relay RP substitution", () -> PasskeyRegistrationOptions.parse(options,
                URI.create("https://relay.example"), domains));
        Map<String, Object> unsupported = new LinkedHashMap<>(options);
        unsupported.put("pubKeyCredParams", new ArrayList<>(List.of(map("type", "public-key", "alg", -257L))));
        rejects("unsupported algorithms", () -> PasskeyRegistrationOptions.parse(unsupported, origin, domains));
        Map<String, Object> residentKey = new LinkedHashMap<>(options);
        residentKey.put("authenticatorSelection", map("residentKey", "sometimes"));
        rejects("resident key enum", () -> PasskeyRegistrationOptions.parse(residentKey, origin, domains));
        Map<String, Object> extensions = new LinkedHashMap<>(options);
        extensions.put("extensions", map("credProps", true));
        rejects("extension semantics", () -> PasskeyRegistrationOptions.parse(extensions, origin, domains));
        Map<String, Object> attestation = new LinkedHashMap<>(options);
        attestation.put("attestation", "direct");
        rejects("attestation preference", () -> PasskeyRegistrationOptions.parse(attestation, origin, domains));

        for (String path : new String[] {"/api/passkeys/../auth/reset", "/api/passkeys/abc?token=secret",
                "/auth/passkey/register/options?x=1", "/api/passkeys/abc%2fdef", "/api/passkeys/", "/auth/session"}) {
            check(!PasskeyWire.management(path, "POST"), "exact path admission " + path);
        }
        check(PasskeyWire.management("/api/passkeys/AQ-_", "DELETE"), "exact credential deletion");
        check(PasskeyWire.management("/auth/passkey/status", "GET") && !PasskeyWire.management("/auth/passkey/status", "POST"),
                "status is GET only");

        // Management session: the paired bearer never enters, the cookie jar stays per Host.
        boolean[] current = {true};
        List<PasskeyManagementSession.Request> requests = new ArrayList<>();
        boolean[] cookieSeen = {false};
        PasskeyManagementSession owner = new PasskeyManagementSession(origin, () -> current[0], request -> {
            requests.add(request);
            check(request.headers.get("Authorization") == null, "client bearer never promoted");
            check(!request.headers.containsKey("Origin") && !request.url.contains("?token"), "no fake origin or URL credential");
            String path = URI.create(request.url).getPath();
            switch (path) {
                case "/auth/session":
                    return new PasskeyManagementSession.Response(200,
                            headers("Set-Cookie", "yuri_ui_session=fixture-session; Path=/; Secure; HttpOnly"),
                            map("authenticated", true));
                case "/api/passkeys":
                    cookieSeen[0] = "yuri_ui_session=fixture-session".equals(request.headers.get("Cookie"));
                    return new PasskeyManagementSession.Response(cookieSeen[0] ? 200 : 401, null, map("passkeys", new ArrayList<>()));
                case "/auth/passkey/register/options":
                    return new PasskeyManagementSession.Response(200, null, map("requestId", "request-1", "optionsJSON", options));
                case "/auth/passkey/register/verify":
                    return new PasskeyManagementSession.Response(200, null, map("verified", true));
                case "/api/auth/reset":
                    return new PasskeyManagementSession.Response(200, null, map("cleared", true, "signedOutEverywhere", true));
                default:
                    return new PasskeyManagementSession.Response(404, null, map());
            }
        });
        check(owner.request("/api/passkeys", "GET", null).status == 401, "no full session before native login");
        owner.request("/auth/session", "POST", map("password", "fixture-only", "issueClientToken", false));
        owner.request("/api/passkeys", "GET", null);
        check(cookieSeen[0], "full session captured natively");
        owner.request("/auth/passkey/register/options", "POST", map("label", "Yuri Android"));
        owner.bind(options, "cancelled");
        owner.cancel("cancelled");
        rejects("late attestation cannot complete", () -> owner.complete("cancelled", "AQI"));
        check(requests.size() == 4, "cancelled ceremony cannot verify");
        owner.request("/auth/passkey/register/options", "POST", null);
        owner.bind(options, "success");
        owner.complete("success", "AQI");
        Map<String, Object> proof = map("requestId", "request-1",
                "response", map("id", "AQI", "rawId", "AQI"));
        Map<String, Object> wrong = map("requestId", "request-1",
                "response", map("id", "other", "rawId", "other"));
        rejects("exact credential only", () -> owner.request("/auth/passkey/register/verify", "POST", wrong));
        owner.request("/auth/passkey/register/verify", "POST", proof);
        rejects("one verify attempt", () -> owner.request("/auth/passkey/register/verify", "POST", proof));

        boolean[] otherCookie = {false};
        PasskeyManagementSession other = new PasskeyManagementSession(URI.create("https://other.example"), () -> true, request -> {
            otherCookie[0] = request.headers.containsKey("Cookie");
            return new PasskeyManagementSession.Response(401, null, map());
        });
        other.request("/api/passkeys", "GET", null);
        check(!otherCookie[0], "another Host never receives the session");

        owner.request("/api/auth/reset", "POST", null);
        check(owner.resetAcknowledged(), "only a true reset ACK permits cleanup");
        int afterReset = requests.size();
        rejects("no automatic reset replay", () -> owner.request("/api/auth/reset", "POST", null));
        check(requests.size() == afterReset, "no second reset POST");

        List<String> retiredCount = new ArrayList<>();
        owner.observeRetirement(() -> retiredCount.add("retired"));
        owner.retire();
        owner.retire();
        check(retiredCount.size() == 1, "retirement notifies exactly once");
        rejects("retired cannot use session", () -> owner.request("/api/passkeys", "GET", null));

        int[] lockedCalls = {0};
        PasskeyManagementSession locked = new PasskeyManagementSession(origin, () -> true, request -> {
            lockedCalls[0]++;
            return new PasskeyManagementSession.Response(200, null, map("tunnelLocked", true));
        });
        rejects("unknown public locked", () -> locked.request("/auth/passkey/status", "GET", null));
        check(lockedCalls[0] == 1, "no login after a locked status");

        PasskeyManagementSession client = new PasskeyManagementSession(origin, () -> true, request ->
                new PasskeyManagementSession.Response(200, null,
                        map("authenticated", true, "scope", "client", "clientToken", "fixture-bearer")));
        rejects("bearer response is not a full session", () -> client.request("/auth/session", "POST",
                map("password", "fixture-only")));

        boolean[] late = {true};
        PasskeyManagementSession lateSession = new PasskeyManagementSession(origin, () -> late[0], request -> {
            late[0] = false;
            return new PasskeyManagementSession.Response(200, null, map("cleared", true, "signedOutEverywhere", true));
        });
        rejects("late reset ACK is fenced", () -> lateSession.request("/api/auth/reset", "POST", null));
        check(!lateSession.resetAcknowledged(), "stale Host ACK cannot authorize cleanup");

        int[] unknownPosts = {0};
        PasskeyManagementSession unknown = new PasskeyManagementSession(origin, () -> true, request -> {
            unknownPosts[0]++;
            throw new IllegalStateException("fixture network failure");
        });
        rejects("unknown reset", () -> unknown.request("/api/auth/reset", "POST", null));
        rejects("unknown reset no replay", () -> unknown.request("/api/auth/reset", "POST", null));
        check(!unknown.resetAcknowledged() && unknownPosts[0] == 1, "unknown reset cannot cleanup or replay");

        // Wrong-Host cookie parsing: a cookie for another domain must not become the session.
        PasskeyManagementSession foreign = new PasskeyManagementSession(origin, () -> true, request ->
                new PasskeyManagementSession.Response(200,
                        headers("Set-Cookie", "yuri_ui_session=other; Path=/; Domain=other.example"),
                        map("authenticated", true)));
        rejects("foreign session cookie", () -> foreign.request("/auth/session", "POST", map("password", "x")));

        System.out.println("PASS: " + checks + " passkey policy/session checks");
    }

    private static String repeat(String value, int count) {
        StringBuilder out = new StringBuilder();
        for (int index = 0; index < count; index++) out.append(value);
        return out.toString();
    }
}
