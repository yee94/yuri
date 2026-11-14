package com.yee94.yuri.nsh;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Minimal JSON reader/writer for the resource and GUI bridges. Values are
 * {@code Map}, {@code List}, {@code String}, {@code Double}, {@code Boolean} or
 * {@code null}. Deliberately does not use {@code org.json}, whose android.jar
 * copy is a runtime stub, so the same pure logic runs on a plain JVM.
 */
final class ResourceJson {
    private ResourceJson() {}

    /** Parsed value, or null when {@code text} is not JSON (a JSON null also parses to null). */
    static Object parse(String text) {
        if (text == null) return null;
        try {
            Reader reader = new Reader(text);
            reader.skipSpace();
            Object value = reader.value();
            reader.skipSpace();
            return reader.index == text.length() ? value : null;
        } catch (RuntimeException error) {
            return null;
        }
    }

    /** JSON for the given value; {@code sorted} orders object keys like Foundation's .sortedKeys. */
    static String stringify(Object value, boolean sorted) {
        StringBuilder out = new StringBuilder();
        write(value, sorted, out);
        return out.toString();
    }

    static Map<String, Object> object(Object value) {
        if (!(value instanceof Map)) return null;
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
            if (!(entry.getKey() instanceof String)) return null;
            result.put((String) entry.getKey(), entry.getValue());
        }
        return result;
    }

    static List<Object> array(Object value) {
        if (!(value instanceof List)) return null;
        return new ArrayList<>((List<?>) value);
    }

    static String text(Object value) {
        return value instanceof String ? (String) value : null;
    }

    static boolean isBoolean(Object value) {
        return value instanceof Boolean;
    }

    /** Non-boolean finite number, else null. JSON numbers arrive as Double or Long. */
    static Double number(Object value) {
        if (value instanceof Boolean) return null;
        if (value instanceof Double || value instanceof Float) {
            double result = ((Number) value).doubleValue();
            return Double.isFinite(result) ? result : null;
        }
        if (value instanceof Number) return ((Number) value).doubleValue();
        return null;
    }

    /** Integral (truncated equals itself) number inside [min, max], else null. */
    static Long integer(Object value, long min, long max) {
        Double number = number(value);
        if (number == null || number < min || number > max) return null;
        if (Math.rint(number) != number) return null;
        return number.longValue();
    }

    private static void write(Object value, boolean sorted, StringBuilder out) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String) {
            string((String) value, out);
        } else if (value instanceof Boolean) {
            out.append(((Boolean) value) ? "true" : "false");
        } else if (value instanceof Double || value instanceof Float) {
            double number = ((Number) value).doubleValue();
            if (!Double.isFinite(number)) out.append("null");
            else if (number == Math.rint(number) && Math.abs(number) < 1e15) out.append((long) number);
            else out.append(number);
        } else if (value instanceof Number) {
            out.append(value);
        } else if (value instanceof Map) {
            Map<?, ?> source = (Map<?, ?>) value;
            Map<String, Object> entries = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : source.entrySet()) entries.put(String.valueOf(entry.getKey()), entry.getValue());
            if (sorted) entries = new TreeMap<>(entries);
            out.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> entry : entries.entrySet()) {
                if (!first) out.append(',');
                first = false;
                string(entry.getKey(), out);
                out.append(':');
                write(entry.getValue(), sorted, out);
            }
            out.append('}');
        } else if (value instanceof List) {
            out.append('[');
            boolean first = true;
            for (Object item : (List<?>) value) {
                if (!first) out.append(',');
                first = false;
                write(item, sorted, out);
            }
            out.append(']');
        } else {
            string(String.valueOf(value), out);
        }
    }

    private static void string(String value, StringBuilder out) {
        out.append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                default:
                    if (character < 0x20) out.append(String.format("\\u%04x", (int) character));
                    else out.append(character);
            }
        }
        out.append('"');
    }

    private static final class Reader {
        private final String text;
        private int index = 0;

        Reader(String text) { this.text = text; }

        void skipSpace() {
            while (index < text.length()) {
                char character = text.charAt(index);
                if (character == ' ' || character == '\n' || character == '\r' || character == '\t') index++;
                else break;
            }
        }

        Object value() {
            skipSpace();
            if (index >= text.length()) throw new IllegalArgumentException("eof");
            char character = text.charAt(index);
            switch (character) {
                case '{': return object();
                case '[': return array();
                case '"': return string();
                case 't': literal("true"); return Boolean.TRUE;
                case 'f': literal("false"); return Boolean.FALSE;
                case 'n': literal("null"); return null;
                default: return number();
            }
        }

        private void literal(String expected) {
            if (!text.startsWith(expected, index)) throw new IllegalArgumentException("literal");
            index += expected.length();
        }

        private Map<String, Object> object() {
            Map<String, Object> result = new LinkedHashMap<>();
            index++;
            skipSpace();
            if (index < text.length() && text.charAt(index) == '}') { index++; return result; }
            while (true) {
                skipSpace();
                String key = string();
                skipSpace();
                if (index >= text.length() || text.charAt(index) != ':') throw new IllegalArgumentException("colon");
                index++;
                result.put(key, value());
                skipSpace();
                if (index >= text.length()) throw new IllegalArgumentException("eof");
                char character = text.charAt(index++);
                if (character == '}') return result;
                if (character != ',') throw new IllegalArgumentException("comma");
            }
        }

        private List<Object> array() {
            List<Object> result = new ArrayList<>();
            index++;
            skipSpace();
            if (index < text.length() && text.charAt(index) == ']') { index++; return result; }
            while (true) {
                result.add(value());
                skipSpace();
                if (index >= text.length()) throw new IllegalArgumentException("eof");
                char character = text.charAt(index++);
                if (character == ']') return result;
                if (character != ',') throw new IllegalArgumentException("comma");
            }
        }

        private String string() {
            if (text.charAt(index) != '"') throw new IllegalArgumentException("string");
            index++;
            StringBuilder out = new StringBuilder();
            while (true) {
                if (index >= text.length()) throw new IllegalArgumentException("eof");
                char character = text.charAt(index++);
                if (character == '"') return out.toString();
                if (character != '\\') { out.append(character); continue; }
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
                        out.append((char) Integer.parseInt(text.substring(index, index + 4), 16));
                        index += 4;
                        break;
                    default: throw new IllegalArgumentException("escape");
                }
            }
        }

        private Double number() {
            int start = index;
            while (index < text.length() && "+-0123456789.eE".indexOf(text.charAt(index)) >= 0) index++;
            if (start == index) throw new IllegalArgumentException("number");
            return Double.parseDouble(text.substring(start, index));
        }
    }
}
