import com.yee94.yuri.nsh.ComposerInlineChipPlan;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class PlanChecks {
    private static int passed;
    public static void main(String[] args) {
        Map<String, Object> valid = new HashMap<>();
        valid.put("ownerID", "composer-glass");
        valid.put("inputID", "composer");
        valid.put("textLength", 12);
        List<Map<String, Object>> rows = new ArrayList<>();
        rows.add(chip(0, 9, "file", "file", "#112233"));
        rows.add(chip(10, 12, "skill", "book-open", "#ff8800"));
        valid.put("chips", rows);
        ComposerInlineChipPlan.Config config = ComposerInlineChipPlan.parse(valid);
        check(config != null, "valid config");
        check(config.chips.size() == 2, "two chips");
        check(config.chips.get(0).start == 0 && config.chips.get(0).end == 9, "first range");

        Map<String, Object> inactive = new HashMap<>();
        inactive.put("ownerID", "o");
        inactive.put("inputID", "i");
        inactive.put("textLength", 20);
        inactive.put("chips", new ArrayList<>());
        ComposerInlineChipPlan.Config cleared = ComposerInlineChipPlan.parse(inactive);
        check(cleared != null && cleared.chips.isEmpty(), "inactive has no chips");
        check(cleared != null && cleared.textLength == 20, "inactive keeps the real length");

        Map<String, Object> fractional = new HashMap<>(valid);
        fractional.put("textLength", 1.5);
        check(ComposerInlineChipPlan.parse(fractional) == null, "fractional length");

        Map<String, Object> booleanLength = new HashMap<>(valid);
        booleanLength.put("textLength", true);
        check(ComposerInlineChipPlan.parse(booleanLength) == null, "boolean length");

        List<Map<String, Object>> many = new ArrayList<>();
        for (int index = 0; index < 65; index++) many.add(chip(0, 2, "file", "file", "#000000"));
        Map<String, Object> over = new HashMap<>(valid);
        over.put("chips", many);
        check(ComposerInlineChipPlan.parse(over) == null, "over 64");

        List<Map<String, Object>> invalid = new ArrayList<>();
        invalid.add(chip(5, 5, "file", "file", "#000000"));
        invalid.add(chip(6, 21, "file", "file", "#000000"));
        invalid.add(chip(0, 3, "unknown", "file", "#000000"));
        invalid.add(chip(4, 7, "file", "unknown", "#000000"));
        invalid.add(chip(8, 11, "file", "file", "red"));
        invalid.add(chip(12, 15, "agent", "ai-agent", "#00ff00"));
        Map<String, Object> partial = new HashMap<>(valid);
        partial.put("textLength", 20);
        partial.put("chips", invalid);
        ComposerInlineChipPlan.Config filtered = ComposerInlineChipPlan.parse(partial);
        check(filtered != null && filtered.chips.size() == 1, "invalid rows dropped");
        check(filtered != null && "agent".equals(filtered.chips.get(0).kind), "remaining row");
        System.out.println(passed + " composer inline chip Java plan checks passed");
    }

    private static Map<String, Object> chip(int start, int end, String kind, String icon, String color) {
        Map<String, Object> row = new HashMap<>();
        row.put("start", start);
        row.put("end", end);
        row.put("kind", kind);
        row.put("icon", icon);
        row.put("color", color);
        return row;
    }

    private static void check(boolean value, String name) {
        if (!value) throw new AssertionError("failed: " + name);
        passed++;
    }
}
