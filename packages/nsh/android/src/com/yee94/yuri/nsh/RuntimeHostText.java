package com.yee94.yuri.nsh;

/** Character/byte predicates mirrored from the iOS Foundation checks the Runtime relies on. */
public final class RuntimeHostText {
    private RuntimeHostText() {}

    /** Foundation {@code CharacterSet.controlCharacters}: ISO controls plus format characters. */
    public static boolean isControl(int cp) {
        if (Character.isISOControl(cp)) return true;
        return (cp >= 0x200B && cp <= 0x200F) || (cp >= 0x202A && cp <= 0x202E)
            || (cp >= 0x2060 && cp <= 0x206F) || cp == 0xFEFF || cp == 0x061C
            || cp == 0x00AD || cp == 0x180E;
    }

    public static boolean hasControl(String value) {
        for (int i = 0; i < value.length(); ) {
            int cp = value.codePointAt(i);
            if (isControl(cp)) return true;
            i += Character.charCount(cp);
        }
        return false;
    }

    /** UTF-8 byte length without allocating. */
    public static int utf8Length(String value) {
        int count = 0;
        for (int i = 0; i < value.length(); ) {
            int cp = value.codePointAt(i);
            count += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
            i += Character.charCount(cp);
        }
        return count;
    }

    /** {@code [A-Za-z0-9_-]{1,128}} — connection, authorization and transport identities. */
    public static boolean identifier(String value) {
        if (value == null || value.isEmpty() || value.length() > 128) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '-' || c == '_';
            if (!ok) return false;
        }
        return true;
    }

    /** All characters are printable ASCII above the space (bearer/url-token safety). */
    public static boolean printableAscii(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c <= 32 || c >= 127) return false;
        }
        return true;
    }

    /** RFC 4122 canonical hyphenated form, as {@code UUID(uuidString:)} accepts it. */
    public static boolean uuid(String value) {
        if (value == null || value.length() != 36) return false;
        for (int i = 0; i < 36; i++) {
            char c = value.charAt(i);
            boolean dash = i == 8 || i == 13 || i == 18 || i == 23;
            if (dash) { if (c != '-') return false; continue; }
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!hex) return false;
        }
        return true;
    }

    public static String lower(String value) { return value == null ? null : value.toLowerCase(java.util.Locale.ROOT); }
}
