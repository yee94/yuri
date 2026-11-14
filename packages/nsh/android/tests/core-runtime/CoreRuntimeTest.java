import com.yee94.yuri.nsh.ConnectionEditorConnection;
import com.yee94.yuri.nsh.ConnectionEditorFailure;
import com.yee94.yuri.nsh.ConnectionEditorInput;
import com.yee94.yuri.nsh.ConnectionEditorRecords;
import com.yee94.yuri.nsh.ConnectionEditorRelay;
import com.yee94.yuri.nsh.ConnectionEditorRetirement;
import com.yee94.yuri.nsh.RelayTunnelCrypto;
import com.yee94.yuri.nsh.RelayTunnelFailure;
import com.yee94.yuri.nsh.RelayTunnelFrame;
import com.yee94.yuri.nsh.RuntimeBridgeFailure;
import com.yee94.yuri.nsh.RuntimeBridgeJson;
import com.yee94.yuri.nsh.RuntimeHostAuthority;
import com.yee94.yuri.nsh.RuntimeHostScope;
import com.yee94.yuri.nsh.RuntimeHostScopeFailure;
import com.yee94.yuri.nsh.RuntimeHostText;
import com.yee94.yuri.nsh.RuntimeHostUri;
import com.yee94.yuri.nsh.SessionMessageStream;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * JVM-only evidence for the pure core-runtime logic: JSON, origin/scope validation,
 * connection record transactions and retirement ledger, SSE parsing, chat stream state
 * machine, the Relay mux codec and the Relay crypto. No Android, Host, network or keychain.
 *
 * <pre>
 * javac -d /tmp/core-runtime-test packages/nsh/android/tests/core-runtime/CoreRuntimeTest.java \
 *   packages/nsh/android/src/com/yee94/yuri/nsh/{RuntimeBridgeJson,RuntimeHostText,RuntimeHostUri,
 *   RuntimeHostScope,RuntimeHostScopeFailure,RuntimeHostAuthority,ConnectionEditorFailure,
 *   ConnectionEditorInput,ConnectionEditorRelay,ConnectionEditorRetirement,ConnectionEditorTransport,
 *   ConnectionEditorConnection,ConnectionEditorPartition,ConnectionEditorRecords,RelayTunnelFailure,
 *   RelayTunnelFrame,RelayTunnelCrypto,SessionMessageStream}.java
 * java -cp /tmp/core-runtime-test CoreRuntimeTest
 * </pre>
 */
public final class CoreRuntimeTest {
    private static int passed;
    private static int failed;

    public static void main(String[] args) throws Exception {
        json();
        origins();
        scope();
        records();
        sse();
        chatStream();
        relayCodec();
        relayCrypto();
        System.out.println(passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    // ------------------------------------------------------------------ JSON

    private static void json() throws Exception {
        Object parsed = RuntimeBridgeJson.parse("{\"a\":[1,2.5,-3e2,true,null,\"x\\u00e9\"],\"b\":{}}");
        Map<String, Object> object = RuntimeBridgeJson.object(parsed);
        check("json object", object != null);
        List<Object> array = RuntimeBridgeJson.array(object.get("a"));
        check("json array", array != null && array.size() == 6);
        check("json long", array.get(0) instanceof Long && ((Long) array.get(0)) == 1L);
        check("json double", array.get(1) instanceof Double && ((Double) array.get(1)) == 2.5);
        check("json exponent", array.get(2) instanceof Double && ((Double) array.get(2)) == -300.0);
        check("json booleans", Boolean.TRUE.equals(array.get(3)) && array.get(4) == null);
        check("json escape", "x\u00e9".equals(array.get(5)));

        fails("json trailing", () -> RuntimeBridgeJson.parse("{}x"));
        fails("json control", () -> RuntimeBridgeJson.parse("\"a\u0001\""));
        fails("json escape", () -> RuntimeBridgeJson.parse("\"\\q\""));
        fails("json truncated", () -> RuntimeBridgeJson.parse("{\"a\":"));

        Map<String, Object> value = new LinkedHashMap<>();
        value.put("n", 200L);
        value.put("d", 1.5);
        value.put("s", "a\"b\\c\n");
        check("json stringify", "{\"n\":200,\"d\":1.5,\"s\":\"a\\\"b\\\\c\\n\"}".equals(RuntimeBridgeJson.stringify(value)));
        Object roundTrip = RuntimeBridgeJson.parse(RuntimeBridgeJson.stringify(value));
        check("json round trip", value.equals(roundTrip));
        fails("json non finite", () -> RuntimeBridgeJson.stringify(Double.NaN));
    }

    // ------------------------------------------------------------------ origins

    private static void origins() throws Exception {
        check("origin lower", "https://host.example".equals(ConnectionEditorRecords.origin("HTTPS://Host.Example/")));
        check("origin default port", "https://host.example".equals(ConnectionEditorRecords.origin("https://host.example:443")));
        check("origin keeps port", "http://host.example:8080".equals(ConnectionEditorRecords.origin("http://host.example:8080/")));
        for (String value : new String[] {"https://host.example/path", "https://host.example?a=1", "https://host.example#x",
                "https://user:pass@host.example", "ftp://host.example", "https://host.example:0", "https:\\\\host",
                "https://host example", ""}) {
            fails("origin rejects " + value, () -> ConnectionEditorRecords.origin(value));
        }
        check("relay canonical", "wss://relay.example".equals(ConnectionEditorRelay.canonicalAddress("WSS://Relay.Example:443")));
        check("relay keeps path", "ws://relay.example:81/ws".equals(ConnectionEditorRelay.canonicalAddress("ws://relay.example:81/ws")));
        fails("relay rejects http", () -> ConnectionEditorRelay.canonicalAddress("http://relay.example"));
        fails("relay rejects query", () -> ConnectionEditorRelay.canonicalAddress("wss://relay.example?x=1"));
        check("wire encode", "/api/fs/stat?path=%2Fa%20b".equals(RuntimeHostUri.encodeForWire("/api/fs/stat?path=%2Fa b")));
        check("percent decode", "/a b".equals(RuntimeHostUri.percentDecode("%2Fa%20b")));
        check("percent decode reject", RuntimeHostUri.percentDecode("%zz") == null);
        check("origin parse closes", RuntimeHostUri.parse("https://h:443/p?q#f").port == 443);
    }

    // ------------------------------------------------------------------ scope

    private static void scope() throws Exception {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("hostID", "host-1");
        value.put("lease", "01234567-89ab-cdef-0123-456789abcdef");
        RuntimeHostScope scope = RuntimeHostScope.parse(value);
        check("scope public", "01234567-89ab-cdef-0123-456789abcdef".equals(scope.publicValue().get("lease")));
        fails("scope extra key", () -> RuntimeHostScope.parse(extra(value, "extra")));
        fails("scope bad uuid", () -> RuntimeHostScope.parse(with(value, "lease", "not-a-uuid")));
        fails("scope control host", () -> RuntimeHostScope.parse(with(value, "hostID", "h\u0001")));

        RuntimeHostAuthority authority = new RuntimeHostAuthority();
        try { authority.admit(null, "host-1", false); fail("authority closed"); }
        catch (RuntimeHostScopeFailure failure) { check("authority background", failure.code.equals(RuntimeHostScopeFailure.BACKGROUND)); }
        check("authority transition", authority.setForeground(true, "host-1"));
        check("authority idempotent", !authority.setForeground(true, "host-1"));
        RuntimeHostScope issued = authority.admit(null, "host-1", false);
        check("authority issues", issued.hostID.equals("host-1"));
        try { authority.admit(null, "host-2", false); fail("authority unavailable"); }
        catch (RuntimeHostScopeFailure failure) { check("authority unavailable code", failure.code.equals(RuntimeHostScopeFailure.UNAVAILABLE)); }
        try { authority.admit(scope, "host-1", false); fail("authority stale"); }
        catch (RuntimeHostScopeFailure failure) { check("authority stale code", failure.code.equals(RuntimeHostScopeFailure.STALE)); }
        try { authority.admit(null, "host-1", true); fail("authority required"); }
        catch (RuntimeHostScopeFailure failure) { check("authority required code", failure.code.equals(RuntimeHostScopeFailure.REQUIRED)); }
        authority.rotate("host-1");
        try { authority.admit(issued, "host-1", true); fail("authority rotated"); }
        catch (RuntimeHostScopeFailure failure) { check("authority rotated stale", failure.code.equals(RuntimeHostScopeFailure.STALE)); }
        check("identifier", RuntimeHostText.identifier("chat-owner_1"));
        check("identifier rejects", !RuntimeHostText.identifier("chat owner"));
        check("printable ascii", RuntimeHostText.printableAscii("abc") && !RuntimeHostText.printableAscii("a b"));
    }

    // ------------------------------------------------------------------ records

    private static void records() throws Exception {
        final byte[][] persisted = new byte[1][];
        ConnectionEditorRecords records = new ConnectionEditorRecords();
        records.selected = "c1";
        records.connections.add(new ConnectionEditorConnection("c1", "Primary", "https://a.example", "token-a", 100,
            null, "v1", "auth1", null));
        records = records.commit(records, null, data -> persisted[0] = data);
        check("records persisted", persisted[0] != null);
        check("records partition assigned", records.connections.get(0).transportID != null);
        String partition = records.connections.get(0).transportID;
        final ConnectionEditorRecords primary = records;

        // Legacy records without partitions migrate on the next commit.
        ConnectionEditorRecords legacy = ConnectionEditorRecords.decode(
            "{\"connections\":[{\"id\":\"c1\",\"label\":\"Primary\",\"url\":\"https://a.example\",\"token\":\"token-a\",\"lastUsedAt\":100,\"editorVersion\":\"v1\",\"authorizationID\":\"auth1\"}],\"selected\":\"c1\"}".getBytes(StandardCharsets.UTF_8));
        check("legacy partitions null", legacy.partitions == null);
        legacy = legacy.commit(legacy, null, data -> { });
        check("legacy migrated", legacy.connections.get(0).transportID != null);

        // A rename keeps the transport partition and the authorization identity.
        ConnectionEditorInput rename = ConnectionEditorInput.parse(mapOf("id", "c1", "version", "v1", "label", "Renamed"), true);
        ConnectionEditorRecords edited = primary.editing(rename);
        ConnectionEditorRecords renamed = edited.commit(edited, null, data -> { });
        check("rename keeps partition", partition.equals(renamed.connections.get(0).transportID));
        check("rename keeps authorization", "auth1".equals(renamed.connections.get(0).authorizationID));
        check("rename new version", !"v1".equals(renamed.connections.get(0).editorVersion));

        // Metadata editing cannot move the origin without a new pairing.
        fails("edit origin requires pairing", () -> primary.editing(
            ConnectionEditorInput.parse(mapOf("id", "c1", "version", "v1", "label", "x", "url", "https://b.example"), false)));
        check("same origin allowed", primary.editing(ConnectionEditorInput.parse(
            mapOf("id", "c1", "version", "v1", "label", "x", "url", "HTTPS://A.example:443/"), false)) != null);
        fails("stale edit", () -> primary.editing(ConnectionEditorInput.parse(mapOf("id", "c1", "version", "old", "label", "x"), true)));
        fails("missing edit", () -> primary.editing(ConnectionEditorInput.parse(mapOf("id", "nope", "version", "v1", "label", "x"), true)));

        // Changing the credential retires the old authorization exactly once.
        ConnectionEditorRecords rotatedNext = primary.copy();
        rotatedNext.connections.set(0, new ConnectionEditorConnection("c1", "Primary", "https://a.example", "token-b", 100,
            null, "v2", "auth2", partition));
        ConnectionEditorRecords rotated = primary.commit(rotatedNext, null, data -> { });
        check("retirement recorded", rotated.pending.size() == 1
            && rotated.pending.get(0).authorizationID.equals("auth1"));
        ConnectionEditorRecords acknowledged = rotated.commit(rotated,
            new ConnectionEditorRetirement("c1", "auth1"), data -> { });
        check("retirement acknowledged", acknowledged.pending.isEmpty());
        ConnectionEditorRecords again = rotated.commit(rotated,
            new ConnectionEditorRetirement("c1", "auth1"), data -> { });
        check("retirement idempotent", again.pending.isEmpty());

        // Ordinary mutations cannot silently drop an outstanding receipt.
        ConnectionEditorRecords dropped = rotated.copy();
        dropped.pending.clear();
        check("pending preserved", rotated.commit(dropped, null, data -> { }).pending.size() == 1);

        // A replacement candidate needs a token, a fresh version and a unique transport.
        fails("replacement needs token", () -> primary.replacing("c1", "v1",
            new ConnectionEditorConnection("c1", "Primary", "https://a.example", "", 0, null, null, null, null)));
        ConnectionEditorRecords replaced = primary.replacing("c1", "v1",
            new ConnectionEditorConnection("c1", "Primary", "https://a.example", "token-c", 0, null, null, null, null));
        check("replacement rotates authorization", !"auth1".equals(replaced.connections.get(0).authorizationID));
        check("replacement keeps lastUsed", replaced.connections.get(0).lastUsedAt == 100);
        ConnectionEditorRecords two = primary.copy();
        two.connections.add(new ConnectionEditorConnection("c2", "Second", "https://a.example", "token-d", 50,
            null, "v9", "auth9", null));
        fails("duplicate transport", () -> two.replacing("c1", "v1",
            new ConnectionEditorConnection("c1", "Primary", "https://a.example", "token-e", 0, null, null, null, null)));

        // Snapshot order follows lastUsedAt, not identity.
        Map<String, Object> snapshot = two.snapshot();
        List<Object> entries = RuntimeBridgeJson.array(snapshot.get("connections"));
        check("snapshot sorted", entries.size() == 2
            && "c1".equals(RuntimeBridgeJson.object(entries.get(0)).get("id")));
        check("snapshot hides token", !RuntimeBridgeJson.object(entries.get(0)).containsKey("token"));

        // Round trip and corruption detection.
        byte[] encoded = RuntimeBridgeJson.stringify(primary.encode()).getBytes(StandardCharsets.UTF_8);
        ConnectionEditorRecords decoded = ConnectionEditorRecords.decode(encoded);
        check("records round trip", decoded.connections.size() == 1 && decoded.connections.get(0).token.equals("token-a"));
        fails("records corrupt", () -> ConnectionEditorRecords.decode("{\"connections\":[{}]}".getBytes(StandardCharsets.UTF_8)));
        fails("retirement reserved", () -> new ConnectionEditorRetirement("c1", "legacy"));
        fails("retirement identifier", () -> new ConnectionEditorRetirement("c1/x", "auth1"));
    }

    // ------------------------------------------------------------------ SSE

    private static void sse() throws Exception {
        List<String[]> events = new ArrayList<>();
        SessionMessageStream.SSEEvents parser = new SessionMessageStream.SSEEvents((data, id) -> events.add(new String[] {data, id}));
        byte[] payload = "\uFEFFdata: one\r\ndata: two\r\nid: 42\r\n\r\ndata: three\n\n:comment\n\nid\n\ndata: four\n\n"
            .getBytes(StandardCharsets.UTF_8);
        for (byte value : payload) parser.consume(value);
        check("sse event count", events.size() == 4);
        check("sse multiline", "one\ntwo".equals(events.get(0)[0]) && "42".equals(events.get(0)[1]));
        check("sse lf only", "three".equals(events.get(1)[0]) && events.get(1)[1] == null);
        check("sse comment ignored", events.get(2)[0].isEmpty() && "".equals(events.get(2)[1]));
        check("sse id reset", "four".equals(events.get(3)[0]) && events.get(3)[1] == null);

        // A multi-byte character split across chunks must still decode.
        List<String[]> split = new ArrayList<>();
        SessionMessageStream.SSEEvents utf8 = new SessionMessageStream.SSEEvents((data, id) -> split.add(new String[] {data}));
        byte[] encoded = "data: 中\n\n".getBytes(StandardCharsets.UTF_8);
        for (int i = 0; i < encoded.length - 1; i++) utf8.consume(encoded[i]);
        utf8.consume(encoded[encoded.length - 1]);
        check("sse utf8 split", split.size() == 1 && "中".equals(split.get(0)[0]));

        SessionMessageStream.SSEEvents limited = new SessionMessageStream.SSEEvents((data, id) -> { });
        byte[] huge = new byte[2_000_100];
        Arrays.fill(huge, (byte) 'a');
        boolean threw = false;
        try { limited.consume(huge); } catch (RelayTunnelFailure failure) { threw = true; }
        check("sse size bound", threw);

        check("cursor accepts", SessionMessageStream.validCursor(null) && SessionMessageStream.validCursor("abc"));
        check("cursor rejects", !SessionMessageStream.validCursor("a\nb") && !SessionMessageStream.validCursor("a\0"));
    }

    // ------------------------------------------------------------------ chat stream

    private static void chatStream() throws Exception {
        check("frame ready", decodeKind("{\"type\":\"ready\",\"scope\":\"global\"}") == 0);
        check("frame backpressure", decodeKind("{\"type\":\"backpressure\",\"bufferedBytes\":1,\"maxBytes\":2}") == 2);
        check("frame event", decodeKind("{\"type\":\"event\",\"payload\":{\"type\":\"message\"},\"directory\":\"/d\"}") == 1);
        // Unknown/foreign ready scopes must not count as connected.
        List<String> outputs = new ArrayList<>();
        SessionMessageStream.Transport transport = new SessionMessageStream.Transport() {
            private int attempt;

            @Override public boolean relay() { return false; }

            @Override public boolean current() { return true; }

            @Override public SessionMessageStream.Socket open(String cursor) throws Exception {
                attempt += 1;
                return new SessionMessageStream.Socket() {
                    private boolean sent;

                    @Override public String receive() throws Exception {
                        if (sent) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
                        sent = true;
                        return "{\"type\":\"event\",\"payload\":{\"type\":\"message\"},\"eventId\":\"7\"}";
                    }

                    @Override public void close() { }
                };
            }

            @Override public void sse(String cursor, SessionMessageStream.Ready ready, SessionMessageStream.Event event,
                                      java.util.function.Consumer<Runnable> register) throws Exception {
                ready.ready();
                event.event("{\"payload\":{\"type\":\"message\"},\"directory\":\"/d\"}", null);
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.CLOSED);
            }
        };
        SessionMessageStream stream = new SessionMessageStream(transport, (kind, data) -> {
            synchronized (outputs) { outputs.add(kind + ":" + data); }
        });
        Thread thread = new Thread(() -> stream.run(SessionMessageStream.Mode.AUTO));
        thread.setDaemon(true);
        thread.start();
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            synchronized (outputs) { if (outputs.size() >= 3) break; }
            Thread.sleep(25);
        }
        stream.cancel();
        thread.join(2000);
        synchronized (outputs) {
            check("stream ws event", outputs.size() >= 2 && outputs.get(0).startsWith("EVENT:"));
            check("stream disconnected", outputs.stream().anyMatch(value -> value.startsWith("DISCONNECTED")));
        }
    }

    private static int decodeKind(String text) throws Exception {
        SessionMessageStream.Transport transport = new SessionMessageStream.Transport() {
            @Override public boolean relay() { return false; }
            @Override public boolean current() { return false; }
            @Override public SessionMessageStream.Socket open(String cursor) { return null; }
            @Override public void sse(String cursor, SessionMessageStream.Ready ready, SessionMessageStream.Event event,
                                      java.util.function.Consumer<Runnable> register) { }
        };
        java.lang.reflect.Method method = SessionMessageStream.class.getDeclaredMethod("decode", String.class);
        method.setAccessible(true);
        Object frame = method.invoke(null, text);
        java.lang.reflect.Field kind = frame.getClass().getDeclaredField("kind");
        kind.setAccessible(true);
        return (Integer) kind.get(frame);
    }

    // ------------------------------------------------------------------ relay codec

    private static void relayCodec() throws Exception {
        byte[] frame = RelayTunnelFrame.encode(8 | 0x80, 0x01020304, new byte[] {1, 2, 3});
        RelayTunnelFrame.Frame decoded = RelayTunnelFrame.decode(frame);
        check("frame type", decoded.type == 8 && decoded.more);
        check("frame id", decoded.streamId == 0x01020304);
        check("frame payload", Arrays.equals(decoded.payload, new byte[] {1, 2, 3}));
        fails("frame bad type", () -> RelayTunnelFrame.encode(13, 1, new byte[0]));
        fails("frame bad more", () -> RelayTunnelFrame.decode(new byte[] {(byte) (0x80 | 1), 0, 0, 0, 1}));
        fails("frame short", () -> RelayTunnelFrame.decode(new byte[] {1, 2}));
        fails("frame oversize", () -> RelayTunnelFrame.encode(1, 1, new byte[RelayTunnelFrame.MAX_PAYLOAD + 1]));
        fails("frame head status", () -> RelayTunnelFrame.head(199, new LinkedHashMap<>()));
    }

    // ------------------------------------------------------------------ relay crypto

    private static void relayCrypto() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair host = generator.generateKeyPair();
        RelayTunnelCrypto client = new RelayTunnelCrypto((ECPublicKey) host.getPublic());

        Map<String, Object> hello = RuntimeBridgeJson.object(RuntimeBridgeJson.parse(client.hello));
        check("hello fields", hello != null && "hello".equals(hello.get("t"))
            && RuntimeBridgeJson.number(hello.get("v")) == 1 && Boolean.FALSE.equals(hello.get("batch")));
        Map<String, Object> jwk = RuntimeBridgeJson.object(hello.get("clientPubJwk"));
        check("hello jwk", jwk != null && "EC".equals(jwk.get("kty")) && "P-256".equals(jwk.get("crv"))
            && ((String) jwk.get("x")).length() == 43 && ((String) jwk.get("y")).length() == 43);
        String nonce = (String) hello.get("nonce");
        check("hello nonce", nonce != null && nonce.length() == 22);

        // Peer: the Host derives the same 64 bytes and mirrors the direction split.
        byte[] clientX = Base64.getUrlDecoder().decode((String) jwk.get("x"));
        byte[] clientY = Base64.getUrlDecoder().decode((String) jwk.get("y"));
        java.security.spec.ECParameterSpec parameters = ((ECPublicKey) host.getPublic()).getParams();
        ECPublicKey clientKey = (ECPublicKey) java.security.KeyFactory.getInstance("EC").generatePublic(
            new java.security.spec.ECPublicKeySpec(new java.security.spec.ECPoint(
                new java.math.BigInteger(1, clientX), new java.math.BigInteger(1, clientY)), parameters));
        javax.crypto.KeyAgreement agreement = javax.crypto.KeyAgreement.getInstance("ECDH");
        agreement.init(host.getPrivate());
        agreement.doPhase(clientKey, true);
        byte[] secret = agreement.generateSecret();
        byte[] material = hkdf(secret, Base64.getUrlDecoder().decode(nonce), "yuri-relay-v1".getBytes(StandardCharsets.UTF_8), 64);
        byte[] clientOutgoing = Arrays.copyOfRange(material, 0, 32);
        byte[] clientIncoming = Arrays.copyOfRange(material, 32, 64);

        byte[] plaintext = "{\"t\":\"request\"}".getBytes(StandardCharsets.UTF_8);
        byte[] sealed = client.encrypt(plaintext);
        check("crypto frame shape", sealed.length == 1 + 12 + plaintext.length + 16 && sealed[0] == 1);
        check("crypto direction", Arrays.equals(open(sealed, clientOutgoing, 1L), plaintext));

        byte[] hostPrefix = new byte[] {9, 8, 7, 6};
        byte[] reply = seal(plaintext, clientIncoming, hostPrefix, 1L);
        check("crypto reply", Arrays.equals(client.decrypt(reply), plaintext));
        fails("crypto replay", () -> client.decrypt(reply));

        byte[] tampered = sealed.clone();
        tampered[tampered.length - 1] ^= 1;
        fails("crypto tamper", () -> open(tampered, clientOutgoing, 1L));
        fails("crypto short frame", () -> client.decrypt(new byte[10]));
        fails("crypto version", () -> client.decrypt(withFirst(reply, (byte) 2)));
        fails("crypto bad key", () -> RelayTunnelCrypto.importKey(mapOfStrings("kty", "EC", "crv", "P-256", "x", "short", "y", "short")));
    }

    private static byte[] hkdf(byte[] input, byte[] salt, byte[] info, int length) throws Exception {
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new javax.crypto.spec.SecretKeySpec(salt, "HmacSHA256"));
        byte[] pseudo = mac.doFinal(input);
        byte[] output = new byte[length];
        byte[] block = new byte[0];
        int offset = 0;
        int counter = 1;
        while (offset < length) {
            mac.init(new javax.crypto.spec.SecretKeySpec(pseudo, "HmacSHA256"));
            mac.update(block);
            mac.update(info);
            mac.update((byte) counter);
            block = mac.doFinal();
            int take = Math.min(block.length, length - offset);
            System.arraycopy(block, 0, output, offset, take);
            offset += take;
            counter++;
        }
        return output;
    }

    private static byte[] seal(byte[] plaintext, byte[] key, byte[] prefix, long counter) throws Exception {
        byte[] iv = new byte[12];
        System.arraycopy(prefix, 0, iv, 0, 4);
        for (int i = 0; i < 8; i++) iv[4 + i] = (byte) (counter >>> (8 * (7 - i)));
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, new javax.crypto.spec.SecretKeySpec(key, "AES"),
            new javax.crypto.spec.GCMParameterSpec(128, iv));
        byte[] sealed = cipher.doFinal(plaintext);
        byte[] frame = new byte[1 + iv.length + sealed.length];
        frame[0] = 1;
        System.arraycopy(iv, 0, frame, 1, iv.length);
        System.arraycopy(sealed, 0, frame, 1 + iv.length, sealed.length);
        return frame;
    }

    private static byte[] open(byte[] frame, byte[] key, long counter) throws Exception {
        byte[] iv = Arrays.copyOfRange(frame, 1, 13);
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(javax.crypto.Cipher.DECRYPT_MODE, new javax.crypto.spec.SecretKeySpec(key, "AES"),
            new javax.crypto.spec.GCMParameterSpec(128, iv));
        return cipher.doFinal(frame, 13, frame.length - 13);
    }

    private static byte[] withFirst(byte[] value, byte first) {
        byte[] copy = value.clone();
        copy[0] = first;
        return copy;
    }

    // ------------------------------------------------------------------ helpers

    private interface Work { void run() throws Exception; }

    private static void fails(String name, Work work) {
        try {
            work.run();
            fail(name + " (expected failure)");
        } catch (Exception expected) {
            passed += 1;
        }
    }

    private static boolean throwsFailure(Work work) {
        try {
            work.run();
            return false;
        } catch (Exception expected) {
            return true;
        }
    }

    private static void check(String name, boolean condition) {
        if (condition) passed += 1;
        else fail(name);
    }

    private static void fail(String name) {
        failed += 1;
        System.out.println("FAIL " + name);
    }

    private static Map<String, Object> mapOf(Object... values) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < values.length; i += 2) map.put((String) values[i], values[i + 1]);
        return map;
    }

    private static Map<String, String> mapOfStrings(String... values) {
        Map<String, String> map = new LinkedHashMap<>();
        for (int i = 0; i < values.length; i += 2) map.put(values[i], values[i + 1]);
        return map;
    }

    private static Map<String, Object> with(Map<String, Object> source, String key, Object value) {
        Map<String, Object> copy = new LinkedHashMap<>(source);
        copy.put(key, value);
        return copy;
    }

    private static Map<String, Object> extra(Map<String, Object> source, String key) {
        return with(source, key, "extra");
    }
}
