package com.yee94.yuri.nsh;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Small JSON codec for the pieces that must behave identically on a plain JVM (unit tests) and on
 * Android: the durable notification inbox, PasskeyWire.canonical and base64url checks. Numbers parse
 * to Long when integral, otherwise Double; maps stringify with sorted keys, matching Foundation's
 * .sortedKeys output used by the iOS port.
 */
public final class NotificationJson {
    private NotificationJson() {}

    public static Object parse(String text) throws NotificationFailure {
        if (text == null) throw NotificationFailure.invalid();
        Parser parser = new Parser(text);
        Object value = parser.value();
        parser.whitespace();
        if (!parser.done()) throw NotificationFailure.invalid();
        return value;
    }

    public static String stringify(Object value) {
        StringBuilder out = new StringBuilder();
        write(value, out);
        return out.toString();
    }

    /** Exact-key check helper shared by the notification and passkey validators. */
    public static boolean hasExactKeys(Map<?, ?> value, String... keys) {
        if (value == null || value.size() != keys.length) return false;
        for (String key : keys) if (!value.containsKey(key)) return false;
        return true;
    }

    public static Map<String, Object> map(Object value) {
        if (!(value instanceof Map)) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
            if (!(entry.getKey() instanceof String)) return null;
            out.put((String) entry.getKey(), entry.getValue());
        }
        return out;
    }

    private static void write(Object value, StringBuilder out) {
        if (value == null) { out.append("null"); return; }
        if (value instanceof String) { quote((String) value, out); return; }
        if (value instanceof Boolean) { out.append(value); return; }
        if (value instanceof Map) {
            Map<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!(entry.getKey() instanceof String)) throw new IllegalArgumentException("non-string key");
                sorted.put((String) entry.getKey(), entry.getValue());
            }
            out.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> entry : sorted.entrySet()) {
                if (!first) out.append(',');
                first = false;
                quote(entry.getKey(), out);
                out.append(':');
                write(entry.getValue(), out);
            }
            out.append('}');
            return;
        }
        if (value instanceof List) {
            out.append('[');
            boolean first = true;
            for (Object item : (List<?>) value) {
                if (!first) out.append(',');
                first = false;
                write(item, out);
            }
            out.append(']');
            return;
        }
        if (value instanceof Number) {
            Number number = (Number) value;
            if (value instanceof Double || value instanceof Float) {
                double raw = number.doubleValue();
                if (Double.isNaN(raw) || Double.isInfinite(raw)) throw new IllegalArgumentException("non-finite number");
                if (raw == Math.rint(raw) && Math.abs(raw) <= 9.007199254740991E15) {
                    out.append(Long.toString((long) raw));
                    return;
                }
                out.append(Double.toString(raw));
                return;
            }
            out.append(number.toString());
            return;
        }
        throw new IllegalArgumentException("unsupported JSON value: " + value.getClass().getName());
    }

    private static void quote(String value, StringBuilder out) {
        out.append('"');
        for (int index = 0; index < value.length(); index++) {
            char ch = value.charAt(index);
            switch (ch) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                default:
                    if (ch < 0x20) out.append(String.format("\\u%04x", (int) ch));
                    else out.append(ch);
            }
        }
        out.append('"');
    }

    private static final class Parser {
        private final String text;
        private int index;

        Parser(String text) { this.text = text; }

        boolean done() { return index >= text.length(); }

        void whitespace() {
            while (index < text.length()) {
                char ch = text.charAt(index);
                if (ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') index++;
                else return;
            }
        }

        Object value() {
            whitespace();
            if (done()) throw new IllegalArgumentException("eof");
            char ch = text.charAt(index);
            if (ch == '{') return object();
            if (ch == '[') return array();
            if (ch == '"') return string();
            if (text.startsWith("true", index)) { index += 4; return Boolean.TRUE; }
            if (text.startsWith("false", index)) { index += 5; return Boolean.FALSE; }
            if (text.startsWith("null", index)) { index += 4; return null; }
            return number();
        }

        private Map<String, Object> object() {
            Map<String, Object> out = new LinkedHashMap<>();
            index++;
            whitespace();
            if (!done() && text.charAt(index) == '}') { index++; return out; }
            while (true) {
                whitespace();
                if (done() || text.charAt(index) != '"') throw new IllegalArgumentException("key");
                String key = string();
                whitespace();
                if (done() || text.charAt(index) != ':') throw new IllegalArgumentException("colon");
                index++;
                Object parsed = value();
                if (out.containsKey(key)) throw new IllegalArgumentException("duplicate key");
                out.put(key, parsed);
                whitespace();
                if (done()) throw new IllegalArgumentException("eof");
                char ch = text.charAt(index++);
                if (ch == '}') return out;
                if (ch != ',') throw new IllegalArgumentException("separator");
            }
        }

        private List<Object> array() {
            List<Object> out = new ArrayList<>();
            index++;
            whitespace();
            if (!done() && text.charAt(index) == ']') { index++; return out; }
            while (true) {
                out.add(value());
                whitespace();
                if (done()) throw new IllegalArgumentException("eof");
                char ch = text.charAt(index++);
                if (ch == ']') return out;
                if (ch != ',') throw new IllegalArgumentException("separator");
            }
        }

        private String string() {
            StringBuilder out = new StringBuilder();
            index++;
            while (true) {
                if (done()) throw new IllegalArgumentException("eof");
                char ch = text.charAt(index++);
                if (ch == '"') return out.toString();
                if (ch != '\\') { out.append(ch); continue; }
                if (done()) throw new IllegalArgumentException("escape");
                char escape = text.charAt(index++);
                switch (escape) {
                    case '"': out.append('"'); break;
                    case '\\': out.append('\\'); break;
                    case '/': out.append('/'); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'u':
                        if (index + 4 > text.length()) throw new IllegalArgumentException("unicode");
                        out.append((char) Integer.parseInt(text.substring(index, index + 4), 16));
                        index += 4;
                        break;
                    default: throw new IllegalArgumentException("escape");
                }
            }
        }

        private Object number() {
            int start = index;
            if (!done() && (text.charAt(index) == '-' || text.charAt(index) == '+')) index++;
            boolean integral = true;
            while (!done()) {
                char ch = text.charAt(index);
                if (ch >= '0' && ch <= '9') { index++; continue; }
                if (ch == '.' || ch == 'e' || ch == 'E' || ch == '+' || ch == '-') { integral = false; index++; continue; }
                break;
            }
            if (start == index) throw new IllegalArgumentException("number");
            String token = text.substring(start, index);
            if (integral) {
                try { return Long.parseLong(token); } catch (NumberFormatException ignored) { /* falls through */ }
            }
            double value = Double.parseDouble(token);
            if (Double.isNaN(value) || Double.isInfinite(value)) throw new IllegalArgumentException("number");
            return value;
        }
    }
}
