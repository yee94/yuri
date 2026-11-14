package com.yee94.yuri.nsh;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Validation and fixed copy shared by the notification bridge. Behaviour matches iOS
 * NativeNotificationPolicy: opaque identifiers only, no Host text ever reaches a lock screen.
 */
public final class NotificationPolicy {
    private NotificationPolicy() {}

    public static final Set<String> KINDS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "completion", "subtask", "error", "question", "permission", "schedule", "assistant", "goal")));
    public static final Set<String> LANGUAGES = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "en", "zh-CN", "zh-TW", "ja", "ko", "fr", "es", "pl", "pt-BR", "uk")));
    public static final Set<String> TARGETS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "session", "assistant", "schedule")));

    private static final Pattern UUID_PATTERN =
            Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    public static boolean identifier(String value) { return identifier(value, 128); }
    public static boolean eventIdentifier(String value) { return identifier(value, 384); }

    private static boolean identifier(String value, int limit) {
        if (value == null || value.isEmpty()) return false;
        int bytes = utf8Length(value);
        if (bytes > limit) return false;
        for (int index = 0; index < value.length(); index++) {
            char ch = value.charAt(index);
            boolean allowed = (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
                    || ch == '-' || ch == '_';
            if (!allowed) return false;
        }
        return true;
    }

    public static boolean uuid(String value) { return value != null && UUID_PATTERN.matcher(value).matches(); }

    public static int utf8Length(String value) { return value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length; }

    /** Exact-key object, exactly as iOS NativeNotificationPolicy.object. */
    public static Map<String, Object> object(Object input, String... keys) throws NotificationFailure {
        Map<String, Object> value = NotificationJson.map(input);
        if (value == null || !NotificationJson.hasExactKeys(value, keys)) throw NotificationFailure.invalid();
        return value;
    }

    /** Booleans are not numbers: 1 is a rejection, not true. */
    public static boolean bool(Object value) throws NotificationFailure {
        if (!(value instanceof Boolean)) throw NotificationFailure.invalid();
        return (Boolean) value;
    }

    public static int positiveInteger(Object value) throws NotificationFailure {
        if (!(value instanceof Number) || value instanceof Boolean) throw NotificationFailure.invalid();
        double raw = ((Number) value).doubleValue();
        if (Double.isNaN(raw) || Double.isInfinite(raw) || raw != Math.rint(raw) || raw < 1 || raw > 9_007_199_254_740_991d) {
            throw NotificationFailure.invalid();
        }
        return (int) raw;
    }

    public static boolean authorized(String status) {
        return "authorized".equals(status) || "provisional".equals(status) || "ephemeral".equals(status);
    }

    /** A live event can never bypass foreground suppression; an explicit local test may. */
    public static boolean present(boolean enabled, boolean active, boolean test) {
        return test || (enabled && !active);
    }

    /** OS payload of a local notification: only {v:1, receipt:UUID}. */
    public static String receipt(Map<?, ?> input) {
        if (input == null || input.size() != 2 || !input.containsKey("v") || !input.containsKey("receipt")) return null;
        Object version = input.get("v");
        if (!(version instanceof Number) || version instanceof Boolean || ((Number) version).doubleValue() != 1d) return null;
        Object value = input.get("receipt");
        if (!(value instanceof String) || !uuid((String) value)) return null;
        return (String) value;
    }

    /** title/body for the OS; test copy is explicit, live copy is a fixed "open Yuri" line. */
    public static String[] copy(String language, boolean test) {
        String title;
        String body;
        String live;
        if ("zh-CN".equals(language)) {
            title = "测试通知"; body = "这是一条来自 Yuri 的测试通知。"; live = "打开 Yuri 查看最新动态。";
        } else if ("zh-TW".equals(language)) {
            title = "測試通知"; body = "這是一則來自 Yuri 的測試通知。"; live = "開啟 Yuri 查看最新動態。";
        } else if ("ja".equals(language)) {
            title = "テスト通知"; body = "これは Yuri からのテスト通知です。"; live = "Yuri を開いて更新を確認してください。";
        } else if ("ko".equals(language)) {
            title = "테스트 알림"; body = "Yuri에서 보낸 테스트 알림입니다."; live = "Yuri를 열어 새 소식을 확인하세요.";
        } else if ("fr".equals(language)) {
            title = "Notification de test"; body = "Ceci est une notification de test de Yuri."; live = "Ouvrez Yuri pour consulter la mise à jour.";
        } else if ("es".equals(language)) {
            title = "Notificación de prueba"; body = "Esta es una notificación de prueba de Yuri."; live = "Abre Yuri para ver la actualización.";
        } else if ("pl".equals(language)) {
            title = "Powiadomienie testowe"; body = "To jest powiadomienie testowe od Yuri."; live = "Otwórz Yuri, aby zobaczyć aktualizację.";
        } else if ("pt-BR".equals(language)) {
            title = "Notificação de teste"; body = "Esta é uma notificação de teste do Yuri."; live = "Abra o Yuri para ver a atualização.";
        } else if ("uk".equals(language)) {
            title = "Тестове сповіщення"; body = "Це тестове сповіщення від Yuri."; live = "Відкрийте Yuri, щоб переглянути оновлення.";
        } else {
            title = "Test Notification"; body = "This is a test notification from Yuri."; live = "Open Yuri to view the update.";
        }
        return test ? new String[] {title, body} : new String[] {"Yuri", live};
    }

    public static Map<String, Object> map(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) out.put((String) pairs[index], pairs[index + 1]);
        return out;
    }

    static List<Object> list(Object... values) { return Arrays.asList(values); }
}
