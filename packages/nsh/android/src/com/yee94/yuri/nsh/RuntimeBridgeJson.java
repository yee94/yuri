package com.yee94.yuri.nsh;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal strict JSON codec shared by the Host bridges. The module has to run on a plain
 * JVM for its tests, where android.jar's {@code org.json} is absent, and no dependency may
 * be added. Object model: Map (insertion ordered), List, String, Long, Double, Boolean, null.
 */
public final class RuntimeBridgeJson {
    private RuntimeBridgeJson() {}

    public static Object parse(String text) throws RuntimeBridgeFailure {
        if (text == null) throw new RuntimeBridgeFailure("invalid_json");
        Parser parser = new Parser(text);
        Object value = parser.value();
        parser.skipWhitespace();
        if (!parser.done()) throw new RuntimeBridgeFailure("invalid_json");
        return value;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> object(Object value) {
        return value instanceof Map ? (Map<String, Object>) value : null;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> array(Object value) {
        return value instanceof List ? (List<Object>) value : null;
    }

    public static String string(Object value) { return value instanceof String ? (String) value : null; }

    public static Double number(Object value) {
        if (value instanceof Double) return (Double) value;
        if (value instanceof Long) return ((Long) value).doubleValue();
        return null;
    }

    public static Integer integer(Object value) {
        if (!(value instanceof Number)) return null;
        double raw = ((Number) value).doubleValue();
        if (!Double.isFinite(raw) || raw != Math.rint(raw)) return null;
        if (raw < Integer.MIN_VALUE || raw > Integer.MAX_VALUE) return null;
        return (int) raw;
    }

    public static String stringify(Object value) throws RuntimeBridgeFailure {
        StringBuilder out = new StringBuilder();
        write(out, value);
        return out.toString();
    }

    private static void write(StringBuilder out, Object value) throws RuntimeBridgeFailure {
        if (value == null) { out.append("null"); return; }
        if (value instanceof String) { writeString(out, (String) value); return; }
        if (value instanceof Boolean) { out.append(((Boolean) value) ? "true" : "false"); return; }
        if (value instanceof Number) { writeNumber(out, (Number) value); return; }
        if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (entry.getKey() == null) throw new RuntimeBridgeFailure("invalid_json");
                if (!first) out.append(',');
                first = false;
                writeString(out, String.valueOf(entry.getKey()));
                out.append(':');
                write(out, entry.getValue());
            }
            out.append('}');
            return;
        }
        if (value instanceof Collection) {
            out.append('[');
            boolean first = true;
            for (Object entry : (Collection<?>) value) {
                if (!first) out.append(',');
                first = false;
                write(out, entry);
            }
            out.append(']');
            return;
        }
        if (value instanceof Object[]) {
            out.append('[');
            Object[] entries = (Object[]) value;
            for (int i = 0; i < entries.length; i++) {
                if (i > 0) out.append(',');
                write(out, entries[i]);
            }
            out.append(']');
            return;
        }
        throw new RuntimeBridgeFailure("invalid_json");
    }

    private static void writeNumber(StringBuilder out, Number number) throws RuntimeBridgeFailure {
        if (number instanceof Long || number instanceof Integer || number instanceof Short || number instanceof Byte) {
            out.append(number.longValue());
            return;
        }
        double value = number.doubleValue();
        if (!Double.isFinite(value)) throw new RuntimeBridgeFailure("invalid_json");
        if (value == Math.rint(value) && Math.abs(value) < 1e15) { out.append((long) value); return; }
        out.append(Double.toString(value));
    }

    private static void writeString(StringBuilder out, String value) {
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
                    if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        out.append('"');
    }

    private static final class Parser {
        private final String text;
        private int index;

        Parser(String text) { this.text = text; }

        boolean done() { return index >= text.length(); }

        void skipWhitespace() {
            while (index < text.length()) {
                char c = text.charAt(index);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') index++;
                else break;
            }
        }

        Object value() throws RuntimeBridgeFailure {
            skipWhitespace();
            if (done()) throw new RuntimeBridgeFailure("invalid_json");
            char c = text.charAt(index);
            switch (c) {
                case '{': return objectValue();
                case '[': return arrayValue();
                case '"': return stringValue();
                case 't': literal("true"); return Boolean.TRUE;
                case 'f': literal("false"); return Boolean.FALSE;
                case 'n': literal("null"); return null;
                default: return numberValue();
            }
        }

        private void literal(String expected) throws RuntimeBridgeFailure {
            if (!text.startsWith(expected, index)) throw new RuntimeBridgeFailure("invalid_json");
            index += expected.length();
        }

        private Map<String, Object> objectValue() throws RuntimeBridgeFailure {
            LinkedHashMap<String, Object> value = new LinkedHashMap<>();
            index++;
            skipWhitespace();
            if (!done() && text.charAt(index) == '}') { index++; return value; }
            while (true) {
                skipWhitespace();
                if (done() || text.charAt(index) != '"') throw new RuntimeBridgeFailure("invalid_json");
                String key = stringValue();
                skipWhitespace();
                if (done() || text.charAt(index) != ':') throw new RuntimeBridgeFailure("invalid_json");
                index++;
                value.put(key, value());
                skipWhitespace();
                if (done()) throw new RuntimeBridgeFailure("invalid_json");
                char c = text.charAt(index++);
                if (c == '}') return value;
                if (c != ',') throw new RuntimeBridgeFailure("invalid_json");
            }
        }

        private List<Object> arrayValue() throws RuntimeBridgeFailure {
            ArrayList<Object> value = new ArrayList<>();
            index++;
            skipWhitespace();
            if (!done() && text.charAt(index) == ']') { index++; return value; }
            while (true) {
                value.add(value());
                skipWhitespace();
                if (done()) throw new RuntimeBridgeFailure("invalid_json");
                char c = text.charAt(index++);
                if (c == ']') return value;
                if (c != ',') throw new RuntimeBridgeFailure("invalid_json");
            }
        }

        private String stringValue() throws RuntimeBridgeFailure {
            index++;
            StringBuilder out = new StringBuilder();
            while (true) {
                if (done()) throw new RuntimeBridgeFailure("invalid_json");
                char c = text.charAt(index++);
                if (c == '"') return out.toString();
                if (c != '\\') {
                    if (c < 0x20) throw new RuntimeBridgeFailure("invalid_json");
                    out.append(c);
                    continue;
                }
                if (done()) throw new RuntimeBridgeFailure("invalid_json");
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
                        if (index + 4 > text.length()) throw new RuntimeBridgeFailure("invalid_json");
                        int code = 0;
                        for (int i = 0; i < 4; i++) {
                            int digit = Character.digit(text.charAt(index++), 16);
                            if (digit < 0) throw new RuntimeBridgeFailure("invalid_json");
                            code = code * 16 + digit;
                        }
                        out.append((char) code);
                        break;
                    default: throw new RuntimeBridgeFailure("invalid_json");
                }
            }
        }

        private Object numberValue() throws RuntimeBridgeFailure {
            int start = index;
            if (!done() && text.charAt(index) == '-') index++;
            while (!done() && Character.isDigit(text.charAt(index))) index++;
            boolean fractional = false;
            if (!done() && text.charAt(index) == '.') {
                fractional = true;
                index++;
                while (!done() && Character.isDigit(text.charAt(index))) index++;
            }
            if (!done() && (text.charAt(index) == 'e' || text.charAt(index) == 'E')) {
                fractional = true;
                index++;
                if (!done() && (text.charAt(index) == '+' || text.charAt(index) == '-')) index++;
                while (!done() && Character.isDigit(text.charAt(index))) index++;
            }
            if (index == start) throw new RuntimeBridgeFailure("invalid_json");
            String slice = text.substring(start, index);
            if (!fractional) {
                try { return Long.parseLong(slice); } catch (NumberFormatException ignored) { /* falls through */ }
            }
            try {
                double value = Double.parseDouble(slice);
                if (!Double.isFinite(value)) throw new RuntimeBridgeFailure("invalid_json");
                return value;
            } catch (NumberFormatException error) {
                throw new RuntimeBridgeFailure("invalid_json");
            }
        }
    }
}
