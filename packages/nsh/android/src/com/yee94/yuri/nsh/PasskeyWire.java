package com.yee94.yuri.nsh;

import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** WebAuthn wire helpers and the exact management path allowlist, identical to iOS PasskeyWire. */
public final class PasskeyWire {
    private PasskeyWire() {}

    private static final Set<String> POST_PATHS = new HashSet<>(Arrays.asList(
            "/auth/passkey/register/options", "/auth/passkey/register/verify", "/api/auth/reset"));

    public static String encode(byte[] data) { return Base64.getUrlEncoder().withoutPadding().encodeToString(data); }

    public static byte[] decode(Object value) throws PasskeyFailure {
        if (!(value instanceof String)) throw PasskeyFailure.invalid();
        String text = (String) value;
        if (text.isEmpty() || NotificationPolicy.utf8Length(text) > 131072) throw PasskeyFailure.invalid();
        for (int index = 0; index < text.length(); index++) {
            char ch = text.charAt(index);
            boolean allowed = (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
                    || ch == '-' || ch == '_';
            if (!allowed) throw PasskeyFailure.invalid();
        }
        byte[] decoded;
        try {
            decoded = Base64.getUrlDecoder().decode(text);
        } catch (IllegalArgumentException error) {
            throw PasskeyFailure.invalid();
        }
        if (!encode(decoded).equals(text)) throw PasskeyFailure.invalid();
        return decoded;
    }

    /** Sorted-key JSON, the byte value compared by the one-attempt registration proof. */
    public static byte[] canonical(Map<String, Object> value) {
        return NotificationJson.stringify(value).getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    /** Host paths the full-UI management session may reach; everything else is rejected before I/O. */
    public static boolean management(String path, String method) {
        if (path == null || method == null) return false;
        if (path.equals("/auth/passkey/status")) return method.equals("GET");
        if (POST_PATHS.contains(path)) return method.equals("POST");
        if (path.equals("/api/passkeys")) return method.equals("GET");
        if (path.startsWith("/api/passkeys/") && method.equals("DELETE")) {
            String id = path.substring("/api/passkeys/".length());
            if (id.isEmpty()) return false;
            for (int index = 0; index < id.length(); index++) {
                char ch = id.charAt(index);
                boolean allowed = (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
                        || ch == '-' || ch == '_';
                if (!allowed) return false;
            }
            return true;
        }
        return false;
    }
}
