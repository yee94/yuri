package com.yee94.yuri.nsh;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Ported from TerminalProtocol in ios/TerminalBridge.swift. Validation is pure Java so the
 * same routines run in the JVM tests; only the wire codec touches org.json at runtime.
 */
public final class TerminalProtocol {
    private TerminalProtocol() {}

    public static final int MESSAGE_LIMIT = 1_048_576;
    public static final int INPUT_LIMIT = 65_536;
    public static final int QUEUE_LIMIT = 262_144;
    public static final long SAFE_INTEGER = 9_007_199_254_740_991L;

    private static final Set<String> LOOPBACK_HOSTS = Set.of("localhost", "127.0.0.1", "0.0.0.0", "::1", "::");
    private static final Set<String> FORBIDDEN_QUERY = Set.of(
            "token", "access_token", "authorization", "password", "secret", "yuri_client_token", "yuri_url_token");

    /** Exact loopback preview URL admission: http(s), loopback host, no credentials, no auth query. */
    public static boolean loopback(String value) {
        if (value == null) return false;
        byte[] utf8 = value.getBytes(StandardCharsets.UTF_8);
        if (utf8.length > 8192) return false;
        for (int i = 0; i < value.length(); i++) {
            int c = value.charAt(i);
            if (c <= 32 || c == 127) return false;
        }
        if (value.contains("\\")) return false;
        URI url;
        try {
            url = new URI(value);
        } catch (Exception error) {
            return false;
        }
        String scheme = url.getScheme();
        if (scheme == null || !(scheme.toLowerCase(Locale.ROOT).equals("http") || scheme.toLowerCase(Locale.ROOT).equals("https"))) return false;
        String host = url.getHost();
        if (host == null) return false;
        String normalized = host.toLowerCase(Locale.ROOT);
        if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.substring(1, normalized.length() - 1);
        if (!LOOPBACK_HOSTS.contains(normalized)) return false;
        if (url.getRawUserInfo() != null) return false;
        int port = url.getPort();
        if (port != -1 && (port < 1 || port > 65535)) return false;
        String query = url.getRawQuery();
        if (query != null) {
            for (String item : query.split("&", -1)) {
                if (item.isEmpty()) continue;
                int equals = item.indexOf('=');
                String name = equals < 0 ? item : item.substring(0, equals);
                try {
                    name = URLDecoder.decode(name, "UTF-8");
                } catch (UnsupportedEncodingException | IllegalArgumentException error) {
                    return false;
                }
                if (FORBIDDEN_QUERY.contains(name.toLowerCase(Locale.ROOT))) return false;
            }
        }
        return true;
    }

    /** Integral, finite, safe-range number; booleans are not numbers here. */
    public static Long integer(Object value) {
        if (!(value instanceof Number)) return null;
        if (value instanceof Boolean) return null;
        double number = ((Number) value).doubleValue();
        if (Double.isNaN(number) || Double.isInfinite(number)) return null;
        if (Math.rint(number) != number) return null;
        if (Math.abs(number) > (double) SAFE_INTEGER) return null;
        return (long) number;
    }

    public static boolean directory(String value) {
        if (value == null || !value.startsWith("/") || value.startsWith("//")) return false;
        if (value.contains("\\")) return false;
        for (int i = 0; i < value.length(); i++) {
            int c = value.charAt(i);
            if (c < 32 || c == 127) return false;
        }
        if (value.equals("/")) return true;
        for (String part : value.substring(1).split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        }
        return true;
    }

    public static boolean identifier(String value) {
        if (value == null || value.isEmpty() || value.length() > 128) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
            if (!ok) return false;
        }
        return true;
    }

    /** {cols, rows} from a request body; same 2...1000 / 1...1000 bounds as iOS. */
    public static int[] size(Map<String, Object> body) throws TerminalFailure {
        Long cols = integer(body.get("cols"));
        Long rows = integer(body.get("rows"));
        if (cols == null || rows == null) throw TerminalFailure.of("invalid");
        if (cols < 2 || cols > 1000 || rows < 1 || rows > 1000) throw TerminalFailure.of("invalid");
        return new int[] { cols.intValue(), rows.intValue() };
    }

    /** Byte 1 followed by the JSON control object: the only v2 output/bind frame shape. */
    public static byte[] frame(Map<String, Object> object) {
        byte[] json = encode(object).getBytes(StandardCharsets.UTF_8);
        byte[] out = new byte[json.length + 1];
        out[0] = 1;
        System.arraycopy(json, 0, out, 1, json.length);
        return out;
    }

    /** Runtime-only decode of a binary control frame. */
    public static Map<String, Object> parseBinary(byte[] bytes) throws TerminalFailure {
        if (bytes == null || bytes.length == 0 || bytes[0] != 1 || bytes.length > MESSAGE_LIMIT) {
            throw TerminalFailure.of("protocolViolation");
        }
        Object parsed = TerminalJson.parse(new String(bytes, 1, bytes.length - 1, StandardCharsets.UTF_8));
        if (!(parsed instanceof Map)) throw TerminalFailure.of("protocolViolation");
        @SuppressWarnings("unchecked")
        Map<String, Object> value = (Map<String, Object>) parsed;
        return value;
    }

    /** Minimal deterministic JSON writer for control frames; insertion order is preserved. */
    public static String encode(Object value) {
        StringBuilder out = new StringBuilder();
        write(value, out);
        return out.toString();
    }

    private static void write(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String) {
            writeString((String) value, out);
        } else if (value instanceof Boolean) {
            out.append(((Boolean) value) ? "true" : "false");
        } else if (value instanceof Number) {
            Number number = (Number) value;
            double asDouble = number.doubleValue();
            if (Double.isNaN(asDouble) || Double.isInfinite(asDouble)) {
                out.append("null");
            } else if (asDouble == Math.rint(asDouble) && Math.abs(asDouble) <= SAFE_INTEGER) {
                out.append(number.longValue());
            } else {
                out.append(number.toString());
            }
        } else if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!first) out.append(',');
                first = false;
                writeString(String.valueOf(entry.getKey()), out);
                out.append(':');
                write(entry.getValue(), out);
            }
            out.append('}');
        } else if (value instanceof Iterable) {
            out.append('[');
            boolean first = true;
            for (Object item : (Iterable<?>) value) {
                if (!first) out.append(',');
                first = false;
                write(item, out);
            }
            out.append(']');
        } else {
            writeString(String.valueOf(value), out);
        }
    }

    private static void writeString(String value, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                default:
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                        out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
    }

    /** Sorted-key canonical JSON, used only for the terminal preview chrome comparison. */
    public static String canonical(Object value) {
        StringBuilder out = new StringBuilder();
        writeCanonical(value, out);
        return out.toString();
    }

    private static void writeCanonical(Object value, StringBuilder out) {
        if (value instanceof Map) {
            List<String> keys = new ArrayList<>();
            for (Object key : ((Map<?, ?>) value).keySet()) keys.add(String.valueOf(key));
            keys.sort(String::compareTo);
            out.append('{');
            boolean first = true;
            for (String key : keys) {
                if (!first) out.append(',');
                first = false;
                writeString(key, out);
                out.append(':');
                writeCanonical(((Map<?, ?>) value).get(key), out);
            }
            out.append('}');
        } else if (value instanceof Iterable) {
            out.append('[');
            boolean first = true;
            for (Object item : (Iterable<?>) value) {
                if (!first) out.append(',');
                first = false;
                writeCanonical(item, out);
            }
            out.append(']');
        } else {
            write(value, out);
        }
    }
}
