package com.yee94.yuri.nsh;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * org.json bridge for Host payloads. Android ships org.json; the JVM tests avoid this class so
 * they can run without the platform stub (which throws for every method).
 */
public final class TerminalJson {
    private TerminalJson() {}

    public static Object parse(String json) {
        if (json == null) return null;
        try {
            return convert(new org.json.JSONTokener(json).nextValue());
        } catch (JSONException | RuntimeException error) {
            return null;
        }
    }

    public static Object convert(Object value) {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            Map<String, Object> map = new LinkedHashMap<>();
            java.util.Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                map.put(key, convert(object.opt(key)));
            }
            return map;
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            List<Object> list = new ArrayList<>(array.length());
            for (int i = 0; i < array.length(); i++) list.add(convert(array.opt(i)));
            return list;
        }
        if (value == JSONObject.NULL) return null;
        return value;
    }

    /** Serializes Java maps/lists/scalars for JavaScript evaluation or an HTTP text body. */
    public static String write(Object value) {
        if (value == null) return "null";
        if (value instanceof Map) {
            JSONObject object = new JSONObject();
            try {
                for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                    object.put(String.valueOf(entry.getKey()), wrap(entry.getValue()));
                }
            } catch (JSONException | RuntimeException error) {
                return "null";
            }
            return object.toString();
        }
        if (value instanceof List) {
            JSONArray array = new JSONArray();
            try {
                for (Object item : (List<?>) value) array.put(wrap(item));
            } catch (RuntimeException error) {
                return "null";
            }
            return array.toString();
        }
        return JSONObject.quote(String.valueOf(value));
    }

    private static Object wrap(Object value) {
        if (value instanceof Map) return new JSONObject((Map<?, ?>) value);
        if (value instanceof List) {
            JSONArray array = new JSONArray();
            for (Object item : (List<?>) value) array.put(wrap(item));
            return array;
        }
        return value == null ? JSONObject.NULL : value;
    }
}
