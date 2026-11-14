package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Map;

/** Input projection parity with RemoteDesktopBridge.projectInput. */
public final class RemoteDesktopInputTest {
    public static void main(String[] args) throws Exception {
        Map<String, Object> pointer = input("pointer");
        pointer.put("action", "down");
        pointer.put("x", 0.25d);
        pointer.put("y", 0.75d);
        Map<String, Object> projected = RemoteDesktopBridge.projectInput(Map.of("input", pointer));
        Check.equal("pointer", projected.get("type"), "pointer type");
        Check.equal("down", projected.get("action"), "action");
        Check.equal(0.25d, projected.get("x"), "x");
        Check.equal(0.75d, projected.get("y"), "y");

        Map<String, Object> release = RemoteDesktopBridge.projectInput(Map.of("input", input("release")));
        Check.equal(1, release.size(), "release has only type");

        Map<String, Object> scroll = input("scroll");
        scroll.put("dx", 5_000d);
        scroll.put("dy", -5_000d);
        Map<String, Object> clamped = RemoteDesktopBridge.projectInput(Map.of("input", scroll));
        Check.equal(1000d, clamped.get("dx"), "dx clamp");
        Check.equal(-1000d, clamped.get("dy"), "dy clamp");

        Map<String, Object> text = input("text");
        text.put("text", "hello");
        Check.equal("hello", RemoteDesktopBridge.projectInput(Map.of("input", text)).get("text"), "text");

        Map<String, Object> key = input("key");
        key.put("key", "Enter");
        Check.equal("Enter", RemoteDesktopBridge.projectInput(Map.of("input", key)).get("key"), "key");

        Check.failure("invalid_message", () -> RemoteDesktopBridge.projectInput(Map.of("input", input("drag"))), "unknown type");
        Check.failure("invalid_message", () -> RemoteDesktopBridge.projectInput(Map.of()), "missing input");
        Map<String, Object> badPointer = input("pointer");
        badPointer.put("action", "down");
        badPointer.put("x", 1.5d);
        badPointer.put("y", 0.5d);
        Check.failure("invalid_message", () -> RemoteDesktopBridge.projectInput(Map.of("input", badPointer)), "x range");
        Map<String, Object> badKey = input("key");
        badKey.put("key", "F1");
        Check.failure("invalid_message", () -> RemoteDesktopBridge.projectInput(Map.of("input", badKey)), "key allowlist");
        Map<String, Object> emptyText = input("text");
        emptyText.put("text", "");
        Check.failure("invalid_message", () -> RemoteDesktopBridge.projectInput(Map.of("input", emptyText)), "empty text");
        Map<String, Object> longText = input("text");
        longText.put("text", "x".repeat(1025));
        Check.failure("invalid_message", () -> RemoteDesktopBridge.projectInput(Map.of("input", longText)), "text bound");
        System.out.println("RemoteDesktopInputTest OK");
    }

    private static Map<String, Object> input(String type) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("type", type);
        return value;
    }
}
