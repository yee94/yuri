package com.yee94.yuri.nsh;

import android.app.Activity;
import android.content.res.Configuration;
import android.util.Log;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Accepts data-only semantic colors and font family names, never CSS or
 * executable code (iOS AppearanceBridge.swift). Palette, mode and font tokens
 * are validated as a whole before any previously valid native appearance
 * changes.
 *
 * Android has no framework (non-AndroidX) override of the system colour
 * scheme: `mode` is validated and the TSX colour-scheme signal applies it,
 * while native chrome keeps the system scheme. Nothing else is skipped.
 */
public final class AppearanceBridge implements NativeHandlers.Bridge {
    private static final String TAG = "YuriNsh";
    private static final int MAX_PAYLOAD = 16384;
    private static final Set<String> TOKENS = Set.of(
        "background", "foreground", "card", "card-foreground", "primary", "primary-foreground",
        "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground",
        "border", "input", "ring", "destructive", "success", "chat-user", "chat-user-foreground",
        "chat-assistant", "chat-assistant-foreground");
    private static final Set<String> FONT_KEYS = Set.of("ui", "mono", "assistantLight", "assistantDark");

    private static final class Failure extends Exception {
        Failure(String message) {
            super(message, null, false, false);
        }
    }

    private static final class Invalid extends RuntimeException {
        Invalid() {
            super("appearance_invalid", null, false, false);
        }
    }

    private static final class Contract {
        String mode;
        Map<String, Map<String, String>> cssVars;
        Map<String, String> fonts;
    }

    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;
    private final NativeFontRegistry registry = new NativeFontRegistry();
    private final NativeFontOwner fonts;
    private int revision;
    private Contract contract;

    public AppearanceBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
        this.fonts = new NativeFontOwner(registry, (hostID, revision, projection) -> {
            if (!hostID.equals(selectedHost()) || revision != this.revision || contract == null) return;
            try {
                renderFonts(projection);
                Map<String, Object> value = projection.value();
                value.put("hostID", hostID);
                value.put("fontRevision", revision);
                view.send("appearance.fonts", value);
            } catch (Exception error) {
                view.send("appearance.error", Map.of("message", "原生字体应用失败"));
            }
        });
    }

    @Override
    public void install() {
        view.handle("appearance.reset", (input, reply) -> {
            try {
                validateReset(input);
                invalidate();
                reply.resolve(Map.of("revision", revision));
            } catch (Failure failure) {
                reply.reject(failure.getMessage());
            } catch (Exception error) {
                reply.reject("原生外观范围已失效");
            }
        });
        view.handle("appearance.apply", (input, reply) -> {
            try {
                reply.resolve(apply(input));
            } catch (Invalid | Failure failure) {
                reply.reject("原生外观范围已失效或数据无效");
            } catch (Exception error) {
                Log.w(TAG, "appearance apply failed", error);
                reply.reject("原生外观范围已失效或数据无效");
            }
        });
        view.handle("appearance.fonts.retry", (input, reply) -> {
            try {
                reply.resolve(retryFonts(input));
            } catch (Invalid | Failure failure) {
                reply.reject("原生外观范围已失效或数据无效");
            } catch (Exception error) {
                reply.reject("原生外观范围已失效或数据无效");
            }
        });
    }

    @Override
    public void invalidate() {
        revision++;
        contract = null;
        fonts.invalidate();
        try {
            view.setThemeOverrides(null);
            view.setFontScale(0f);
        } catch (RuntimeException error) {
            view.send("appearance.error", Map.of("message", "原生外观重置失败"));
        }
    }

    private String selectedHost() {
        try {
            return leases.capture(null).scope().hostID;
        } catch (Exception absent) {
            return null;
        }
    }

    private Object apply(Object input) throws Exception {
        String hostID = selectedHost();
        if (hostID == null) throw new Failure("原生外观范围已失效");
        Contract decoded = decode(input, hostID, revision);
        contract = decoded;
        NativeFontOwner.Projection projection = fonts.select(hostID, revision, decoded.fonts, false);
        renderFonts(projection);
        view.setFontScale(1f); // Host percentages apply to semantic sizes, not twice via system font scale.
        Map<String, Object> value = projection.value();
        value.put("fontRevision", revision);
        value.put("systemColorScheme", systemColorScheme());
        return value;
    }

    private Object retryFonts(Object input) throws Exception {
        if (!(input instanceof Map)) throw new Invalid();
        Map<?, ?> data = (Map<?, ?>) input;
        if (!data.keySet().equals(Set.of("hostID", "fontRevision", "fontTicket"))) throw new Invalid();
        String hostID = selectedHost();
        if (!(data.get("hostID") instanceof String) || !data.get("hostID").equals(hostID)) throw new Invalid();
        double fontRevision = number(data.get("fontRevision"));
        if (fontRevision != revision) throw new Invalid();
        double ticket = number(data.get("fontTicket"));
        if (ticket != fonts.projection().ticket) throw new Invalid();
        Contract captured = contract;
        if (captured == null) throw new Failure("原生外观范围已失效");
        NativeFontOwner.Projection projection = fonts.select(hostID, revision, captured.fonts, true);
        renderFonts(projection);
        Map<String, Object> value = projection.value();
        value.put("hostID", hostID);
        value.put("fontRevision", revision);
        return value;
    }

    private void validateReset(Object input) throws Failure {
        Map<String, Object> data = payload(input, Set.of("hostID"));
        Object hostID = data.get("hostID");
        if (hostID == null) return;
        String selected = selectedHost();
        if (!(hostID instanceof String) || ((String) hostID).isEmpty() || ((String) hostID).getBytes(StandardCharsets.UTF_8).length > 512
            || !hostID.equals(selected)) {
            throw new Failure("原生外观范围已失效");
        }
    }

    private Contract decode(Object input, String selectedHost, int revision) throws Failure {
        Map<String, Object> data = payload(input, Set.of("hostID", "revision", "mode", "cssVars", "fonts"));
        Object hostID = data.get("hostID");
        if (!(hostID instanceof String) || ((String) hostID).isEmpty()
            || ((String) hostID).getBytes(StandardCharsets.UTF_8).length > 512 || !hostID.equals(selectedHost)) {
            throw new Failure("原生外观范围已失效");
        }
        if (number(data.get("revision")) != revision) throw new Failure("原生外观范围已失效");
        Object mode = data.get("mode");
        if (!(mode instanceof String) || !Set.of("light", "dark", "system").contains(mode)) throw new Failure("原生外观范围已失效");
        Object vars = data.get("cssVars");
        if (!(vars instanceof Map)) throw new Failure("原生外观范围已失效");
        Map<?, ?> cssVars = (Map<?, ?>) vars;
        if (!cssVars.keySet().equals(Set.of("light", "dark"))) throw new Failure("原生外观范围已失效");
        Object fonts = data.get("fonts");
        if (!(fonts instanceof Map)) throw new Failure("原生外观范围已失效");
        Map<?, ?> fontValues = (Map<?, ?>) fonts;
        if (!fontValues.keySet().equals(FONT_KEYS)) throw new Failure("原生外观范围已失效");
        Map<String, String> decodedFonts = new LinkedHashMap<>();
        for (String key : FONT_KEYS) {
            Object value = fontValues.get(key);
            if (!(value instanceof String)) throw new Failure("原生外观范围已失效");
            String family = (String) value;
            if (family.isEmpty() || family.getBytes(StandardCharsets.UTF_8).length > 64 || !familyCharacters(family)) {
                throw new Failure("原生外观范围已失效");
            }
            decodedFonts.put(key, family);
        }
        Contract value = new Contract();
        value.mode = (String) mode;
        value.fonts = decodedFonts;
        value.cssVars = new LinkedHashMap<>();
        value.cssVars.put("light", palette(cssVars.get("light")));
        value.cssVars.put("dark", palette(cssVars.get("dark")));
        return value;
    }

    private static Map<String, Object> payload(Object input, Set<String> keys) throws Failure {
        if (!(input instanceof Map)) throw new Failure("原生外观范围已失效或数据无效");
        Map<?, ?> data = (Map<?, ?>) input;
        Set<String> actual = new LinkedHashSet<>();
        for (Object key : data.keySet()) {
            if (!(key instanceof String)) throw new Failure("原生外观范围已失效或数据无效");
            actual.add((String) key);
        }
        if (!actual.equals(keys)) throw new Failure("原生外观范围已失效或数据无效");
        Map<String, Object> value = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : data.entrySet()) value.put((String) entry.getKey(), entry.getValue());
        if (NativeHandlersJson.stringify(value).getBytes(StandardCharsets.UTF_8).length > MAX_PAYLOAD) {
            throw new Failure("原生外观范围已失效或数据无效");
        }
        return value;
    }

    private static Map<String, String> palette(Object value) throws Failure {
        if (!(value instanceof Map)) throw new Failure("原生外观范围已失效或数据无效");
        Map<?, ?> colors = (Map<?, ?>) value;
        Set<String> actual = new LinkedHashSet<>();
        for (Object key : colors.keySet()) {
            if (!(key instanceof String)) throw new Failure("原生外观范围已失效或数据无效");
            actual.add((String) key);
        }
        if (!actual.equals(TOKENS)) throw new Failure("原生外观范围已失效或数据无效");
        Map<String, String> result = new LinkedHashMap<>();
        for (String token : TOKENS) {
            Object raw = colors.get(token);
            if (!(raw instanceof String)) throw new Failure("原生外观范围已失效或数据无效");
            String color = (String) raw;
            int length = color.getBytes(StandardCharsets.UTF_8).length;
            if (!color.startsWith("#") || !(length == 4 || length == 5 || length == 7 || length == 9)
                || !hex(color.substring(1))) {
                throw new Failure("原生外观范围已失效或数据无效");
            }
            result.put(token, color);
        }
        return result;
    }

    private static boolean hex(String value) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            boolean digit = character >= '0' && character <= '9';
            boolean upper = character >= 'A' && character <= 'F';
            boolean lower = character >= 'a' && character <= 'f';
            if (!digit && !upper && !lower) return false;
        }
        return true;
    }

    private static boolean familyCharacters(String value) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            boolean digit = character >= '0' && character <= '9';
            boolean upper = character >= 'A' && character <= 'Z';
            boolean lower = character >= 'a' && character <= 'z';
            if (!digit && !upper && !lower && character != ' ' && character != '-') return false;
        }
        return true;
    }

    private static double number(Object value) throws Failure {
        if (!(value instanceof Number)) throw new Failure("原生外观范围已失效或数据无效");
        double result = ((Number) value).doubleValue();
        if (!Double.isFinite(result)) throw new Failure("原生外观范围已失效或数据无效");
        return result;
    }

    private void renderFonts(NativeFontOwner.Projection projection) throws Exception {
        Contract captured = contract;
        if (captured == null) throw new Failure("原生外观范围已失效");
        // setThemeOverrides replaces the override document: merge into the CURRENT
        // contract so a font completion never captures or replays a palette.
        Map<String, Map<String, String>> cssVars = new LinkedHashMap<>();
        for (String variant : new String[] { "light", "dark" }) {
            Map<String, String> values = new LinkedHashMap<>(captured.cssVars.get(variant));
            values.put("font-sans", projection.ui);
            values.put("font-mono", projection.mono);
            cssVars.put(variant, values);
        }
        view.setThemeOverrides(NativeHandlersJson.stringify(Map.of("cssVars", cssVars)));
    }

    private String systemColorScheme() {
        int mode = activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES ? "dark" : "light";
    }
}
