package com.yee94.yuri.nsh;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Deterministic JSON for Host replies, theme overrides and the receipt
 * journal. Numbers keep their integral form; non-finite values are refused.
 */
public final class NativeHandlersJson {
    private NativeHandlersJson() {}

    public static String stringify(Object value) {
        StringBuilder out = new StringBuilder();
        write(out, value);
        return out.toString();
    }

    private static void write(StringBuilder out, Object value) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String) {
            string(out, (String) value);
        } else if (value instanceof Boolean) {
            out.append(value.toString());
        } else if (value instanceof Number) {
            number(out, (Number) value);
        } else if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!(entry.getKey() instanceof String)) throw new IllegalArgumentException("json_object_key");
                if (!first) out.append(',');
                first = false;
                string(out, (String) entry.getKey());
                out.append(':');
                write(out, entry.getValue());
            }
            out.append('}');
        } else if (value instanceof Iterable) {
            out.append('[');
            boolean first = true;
            for (Object item : (Iterable<?>) value) {
                if (!first) out.append(',');
                first = false;
                write(out, item);
            }
            out.append(']');
        } else if (value.getClass().isArray()) {
            out.append('[');
            int length = java.lang.reflect.Array.getLength(value);
            for (int index = 0; index < length; index++) {
                if (index > 0) out.append(',');
                write(out, java.lang.reflect.Array.get(value, index));
            }
            out.append(']');
        } else {
            throw new IllegalArgumentException("json_value");
        }
    }

    private static void number(StringBuilder out, Number value) {
        if (value instanceof Double || value instanceof Float) {
            double number = value.doubleValue();
            if (!Double.isFinite(number)) throw new IllegalArgumentException("json_number");
            if (number == Math.rint(number) && Math.abs(number) <= 9_007_199_254_740_991d) out.append((long) number);
            else out.append(number);
            return;
        }
        out.append(value.toString());
    }

    private static void string(StringBuilder out, String value) {
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
                    if (character < 0x20 || character == 0x7f) out.append(String.format("\\u%04x", (int) character));
                    else out.append(character);
            }
        }
        out.append('"');
    }

    public static Object parse(String text) {
        Parser parser = new Parser(text);
        Object value = parser.value();
        parser.space();
        if (parser.at != text.length()) throw new IllegalArgumentException("json_trailing");
        return value;
    }

    private static final class Parser {
        private final String text;
        private int at;

        Parser(String text) {
            this.text = text;
        }

        Object value() {
            space();
            if (at >= text.length()) throw new IllegalArgumentException("json_end");
            char character = text.charAt(at);
            if (character == '{') return object();
            if (character == '[') return array();
            if (character == '"') return string();
            if (character == 't' && take("true")) return Boolean.TRUE;
            if (character == 'f' && take("false")) return Boolean.FALSE;
            if (character == 'n' && take("null")) return null;
            return number();
        }

        void space() {
            while (at < text.length() && " \t\n\r".indexOf(text.charAt(at)) >= 0) at++;
        }

        private boolean take(String word) {
            if (!text.startsWith(word, at)) return false;
            at += word.length();
            return true;
        }

        private Map<String, Object> object() {
            Map<String, Object> value = new LinkedHashMap<>();
            at++;
            space();
            if (at < text.length() && text.charAt(at) == '}') {
                at++;
                return value;
            }
            while (true) {
                space();
                if (at >= text.length() || text.charAt(at) != '"') throw new IllegalArgumentException("json_key");
                String key = string();
                space();
                if (at >= text.length() || text.charAt(at) != ':') throw new IllegalArgumentException("json_colon");
                at++;
                if (value.put(key, value()) != null) throw new IllegalArgumentException("json_duplicate");
                space();
                if (at >= text.length()) throw new IllegalArgumentException("json_end");
                char next = text.charAt(at++);
                if (next == '}') return value;
                if (next != ',') throw new IllegalArgumentException("json_comma");
            }
        }

        private List<Object> array() {
            List<Object> value = new ArrayList<>();
            at++;
            space();
            if (at < text.length() && text.charAt(at) == ']') {
                at++;
                return value;
            }
            while (true) {
                value.add(value());
                space();
                if (at >= text.length()) throw new IllegalArgumentException("json_end");
                char next = text.charAt(at++);
                if (next == ']') return value;
                if (next != ',') throw new IllegalArgumentException("json_comma");
            }
        }

        private String string() {
            StringBuilder out = new StringBuilder();
            at++;
            while (true) {
                if (at >= text.length()) throw new IllegalArgumentException("json_string");
                char character = text.charAt(at++);
                if (character == '"') return out.toString();
                if (character < 0x20) throw new IllegalArgumentException("json_control");
                if (character != '\\') {
                    out.append(character);
                    continue;
                }
                if (at >= text.length()) throw new IllegalArgumentException("json_escape");
                char escape = text.charAt(at++);
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
                        if (at + 4 > text.length()) throw new IllegalArgumentException("json_unicode");
                        out.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
                        at += 4;
                        break;
                    default: throw new IllegalArgumentException("json_escape");
                }
            }
        }

        private Object number() {
            int start = at;
            if (at < text.length() && text.charAt(at) == '-') at++;
            while (at < text.length() && Character.isDigit(text.charAt(at))) at++;
            boolean fractional = false;
            if (at < text.length() && text.charAt(at) == '.') {
                fractional = true;
                at++;
                while (at < text.length() && Character.isDigit(text.charAt(at))) at++;
            }
            if (at < text.length() && (text.charAt(at) == 'e' || text.charAt(at) == 'E')) {
                fractional = true;
                at++;
                if (at < text.length() && (text.charAt(at) == '+' || text.charAt(at) == '-')) at++;
                while (at < text.length() && Character.isDigit(text.charAt(at))) at++;
            }
            if (start == at) throw new IllegalArgumentException("json_number");
            String raw = text.substring(start, at);
            try {
                if (fractional) return Double.parseDouble(raw);
                long value = Long.parseLong(raw);
                return value >= -9_007_199_254_740_991L && value <= 9_007_199_254_740_991L ? (Object) value : (Object) Double.parseDouble(raw);
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("json_number");
            }
        }
    }
}
