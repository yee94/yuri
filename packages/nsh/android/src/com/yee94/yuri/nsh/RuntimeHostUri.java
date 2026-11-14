package com.yee94.yuri.nsh;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * The narrow subset of Foundation's {@code URLComponents} the Runtime needs: strict
 * validation, no implicit percent-encoding and no lenient repair. Returns null instead of
 * guessing whenever the input is not an unambiguous absolute origin or Host-relative path.
 */
public final class RuntimeHostUri {
    private RuntimeHostUri() {}

    public static final class Parts {
        public String scheme;
        public String userInfo;
        public String host;
        public Integer port;
        public String path = "";
        public String query;
        public String fragment;
        public boolean authority;

        public boolean hasCredentials() { return userInfo != null; }

        public int effectivePort() {
            if (port != null) return port;
            return "https".equals(scheme) || "wss".equals(scheme) ? 443 : 80;
        }
    }

    /** Parse an absolute URI or a Host-relative reference; null when malformed. */
    public static Parts parse(String value) {
        if (value == null || value.isEmpty()) return null;
        Parts parts = new Parts();
        int index = 0;
        int colon = value.indexOf(':');
        int firstStop = value.length();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '/' || c == '?' || c == '#') { firstStop = i; break; }
        }
        if (colon > 0 && colon < firstStop) {
            String scheme = value.substring(0, colon);
            if (!validScheme(scheme)) return null;
            parts.scheme = scheme.toLowerCase(Locale.ROOT);
            index = colon + 1;
        }
        if (value.startsWith("//", index)) {
            parts.authority = true;
            index += 2;
            int end = value.length();
            for (int i = index; i < value.length(); i++) {
                char c = value.charAt(i);
                if (c == '/' || c == '?' || c == '#') { end = i; break; }
            }
            String authority = value.substring(index, end);
            int at = authority.lastIndexOf('@');
            if (at >= 0) {
                parts.userInfo = authority.substring(0, at);
                authority = authority.substring(at + 1);
            }
            String host;
            Integer port = null;
            if (authority.startsWith("[")) {
                int close = authority.indexOf(']');
                if (close < 0) return null;
                host = authority.substring(1, close);
                String rest = authority.substring(close + 1);
                if (!rest.isEmpty()) {
                    if (!rest.startsWith(":")) return null;
                    port = parsePort(rest.substring(1));
                    if (port == null) return null;
                }
                if (host.isEmpty() || !validIpv6(host)) return null;
            } else {
                int portAt = authority.lastIndexOf(':');
                if (portAt >= 0) {
                    host = authority.substring(0, portAt);
                    port = parsePort(authority.substring(portAt + 1));
                    if (port == null) return null;
                } else {
                    host = authority;
                }
                if (!validHost(host)) return null;
            }
            parts.host = host;
            parts.port = port;
            index = end;
        }
        int fragmentAt = value.indexOf('#', index);
        String remainder = value;
        if (fragmentAt >= 0) {
            parts.fragment = value.substring(fragmentAt + 1);
            remainder = value.substring(0, fragmentAt);
        }
        int queryAt = remainder.indexOf('?', index);
        if (queryAt >= 0) {
            parts.query = remainder.substring(queryAt + 1);
            parts.path = remainder.substring(index, queryAt);
        } else {
            parts.path = remainder.substring(index);
        }
        if (parts.fragment != null && !validComponent(parts.fragment)) return null;
        if (parts.query != null && !validComponent(parts.query)) return null;
        if (!validComponent(parts.path)) return null;
        if (parts.userInfo != null && !validComponent(parts.userInfo)) return null;
        return parts;
    }

    /** Percent-decodes a URI path; null for an invalid or non-UTF-8 escape sequence. */
    public static String percentDecode(String value) {
        if (value == null) return null;
        StringBuilder out = new StringBuilder(value.length());
        int index = 0;
        while (index < value.length()) {
            char c = value.charAt(index);
            if (c != '%') {
                out.append(c);
                index++;
                continue;
            }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            boolean any = false;
            while (index < value.length() && value.charAt(index) == '%') {
                if (index + 2 >= value.length()) return null;
                int high = Character.digit(value.charAt(index + 1), 16);
                int low = Character.digit(value.charAt(index + 2), 16);
                if (high < 0 || low < 0) return null;
                bytes.write((high << 4) | low);
                index += 3;
                any = true;
            }
            if (!any) return null;
            String decoded = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
            if (decoded.indexOf('\uFFFD') >= 0) return null;
            out.append(decoded);
        }
        return out.toString();
    }

    /**
     * Percent-encodes only the bytes a URL may not carry literally, keeping existing
     * escapes intact. Foundation's {@code URL(string:relativeTo:)} does the same for the
     * paths the Runtime forwards.
     */
    public static String encodeForWire(String value) {
        if (value == null) return null;
        StringBuilder out = new StringBuilder(value.length());
        for (byte raw : value.getBytes(StandardCharsets.UTF_8)) {
            int octet = raw & 0xff;
            boolean allowed = (octet >= 'A' && octet <= 'Z') || (octet >= 'a' && octet <= 'z')
                || (octet >= '0' && octet <= '9')
                || "-._~!$&'()*+,;=:@/?%[]".indexOf(octet) >= 0;
            if (allowed) out.append((char) octet);
            else out.append('%').append(String.format("%02X", octet));
        }
        return out.toString();
    }

    private static boolean validScheme(String value) {
        if (value.isEmpty()) return false;
        char first = value.charAt(0);
        if (!((first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z'))) return false;
        for (int i = 1; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.';
            if (!ok) return false;
        }
        return true;
    }

    private static boolean validHost(String value) {
        if (value.isEmpty()) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_';
            if (!ok) return false;
        }
        return true;
    }

    private static boolean validIpv6(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f') || c == ':' || c == '.';
            if (!ok) return false;
        }
        return true;
    }

    private static Integer parsePort(String value) {
        if (value.isEmpty() || value.length() > 5) return null;
        for (int i = 0; i < value.length(); i++) if (!Character.isDigit(value.charAt(i))) return null;
        int port = Integer.parseInt(value);
        return port >= 1 && port <= 65535 ? port : null;
    }

    private static boolean validComponent(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x20 || c == 0x7F || c == '\\') return false;
        }
        return true;
    }

    public static String origin(Parts parts, boolean includePath) {
        StringBuilder out = new StringBuilder();
        out.append(parts.scheme).append("://");
        if (parts.userInfo != null) out.append(parts.userInfo).append('@');
        out.append(parts.host);
        if (parts.port != null) out.append(':').append(parts.port);
        if (includePath) out.append(parts.path);
        return out.toString();
    }
}
