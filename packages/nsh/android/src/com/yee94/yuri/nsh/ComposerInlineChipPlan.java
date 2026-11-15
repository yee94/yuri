package com.yee94.yuri.nsh;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Pure validation for yuri.composer.inlineChips (iOS ComposerInlineChipPlan).
 * Kept free of Android types so the production rules run in JVM checks.
 */
public final class ComposerInlineChipPlan {
    public static final class Chip {
        public final int start;
        public final int end;
        public final String kind;
        public final String icon;
        public final String color;

        Chip(int start, int end, String kind, String icon, String color) {
            this.start = start;
            this.end = end;
            this.kind = kind;
            this.icon = icon;
            this.color = color;
        }
    }

    public static final class Config {
        public final String ownerID;
        public final String inputID;
        public final int textLength;
        public final List<Chip> chips;

        Config(String ownerID, String inputID, int textLength, List<Chip> chips) {
            this.ownerID = ownerID;
            this.inputID = inputID;
            this.textLength = textLength;
            this.chips = chips;
        }
    }

    private static final Set<String> KINDS = Set.of("file", "directory", "agent", "skill", "session");
    private static final Set<String> ICONS = Set.of("file", "folder", "ai-agent", "book-open", "chat-thread");
    private static final Pattern HEX = Pattern.compile("^#[0-9a-fA-F]{6}$");

    private ComposerInlineChipPlan() {}

    public static Config parse(Object value) {
        if (!(value instanceof Map)) return null;
        Map<?, ?> data = (Map<?, ?>) value;
        Object owner = data.get("ownerID"), input = data.get("inputID");
        Integer length = integer(data.get("textLength"));
        Object rows = data.get("chips");
        if (!(owner instanceof String) || ((String) owner).isEmpty() || ((String) owner).length() > 256) return null;
        if (!(input instanceof String) || ((String) input).isEmpty() || ((String) input).length() > 256) return null;
        if (length == null || length < 0 || length > 4_000_000 || !(rows instanceof List)) return null;
        List<?> list = (List<?>) rows;
        if (list.size() > 64) return null;
        List<Chip> chips = new ArrayList<>();
        for (Object line : list) {
            if (!(line instanceof Map)) continue;
            Map<?, ?> chip = (Map<?, ?>) line;
            Integer start = integer(chip.get("start")), end = integer(chip.get("end"));
            Object kind = chip.get("kind"), icon = chip.get("icon"), color = chip.get("color");
            if (start == null || end == null || start < 0 || end <= start || end > length || end - start < 2) continue;
            if (!(kind instanceof String) || !KINDS.contains(kind)) continue;
            if (!(icon instanceof String) || !ICONS.contains(icon)) continue;
            if (!(color instanceof String) || !HEX.matcher((String) color).matches()) continue;
            if (!chips.isEmpty() && start < chips.get(chips.size() - 1).end) continue;
            chips.add(new Chip(start, end, (String) kind, (String) icon, (String) color));
        }
        return new Config((String) owner, (String) input, length, chips);
    }

    private static Integer integer(Object value) {
        if (!(value instanceof Number)) return null;
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number != Math.rint(number) || number < Integer.MIN_VALUE || number > Integer.MAX_VALUE) return null;
        return (int) number;
    }
}
