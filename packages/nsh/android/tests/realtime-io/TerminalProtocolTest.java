package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Pure validation/encoding parity with TerminalProtocol in ios/TerminalBridge.swift. */
public final class TerminalProtocolTest {
    public static void main(String[] args) throws Exception {
        loopback();
        integers();
        directories();
        identifiers();
        sizes();
        frames();
        System.out.println("TerminalProtocolTest OK");
    }

    private static void loopback() {
        Check.isTrue(TerminalProtocol.loopback("http://localhost:3000"), "plain loopback");
        Check.isTrue(TerminalProtocol.loopback("https://127.0.0.1"), "https ipv4");
        Check.isTrue(TerminalProtocol.loopback("http://0.0.0.0:8080/path?x=1"), "ipv4 wildcard with query");
        Check.isTrue(TerminalProtocol.loopback("http://[::1]:3000/"), "ipv6 loopback");
        Check.isFalse(TerminalProtocol.loopback("http://example.com"), "public host rejected");
        Check.isFalse(TerminalProtocol.loopback("http://localhost:3000/?access_token=1"), "auth query rejected");
        Check.isFalse(TerminalProtocol.loopback("http://localhost:3000/?Token=x"), "auth query case-insensitive");
        Check.isFalse(TerminalProtocol.loopback("ftp://localhost"), "scheme rejected");
        Check.isFalse(TerminalProtocol.loopback("http://user:pass@localhost:3000"), "credentials rejected");
        Check.isFalse(TerminalProtocol.loopback("http://localhost:0"), "port zero rejected");
        Check.isFalse(TerminalProtocol.loopback("http://localhost:70000"), "port overflow rejected");
        Check.isFalse(TerminalProtocol.loopback("http://localhost:3000\\win"), "backslash rejected");
        Check.isFalse(TerminalProtocol.loopback("http://localhost:3000\n"), "control char rejected");
        StringBuilder longValue = new StringBuilder("http://localhost/");
        while (longValue.length() <= 8192) longValue.append('a');
        Check.isFalse(TerminalProtocol.loopback(longValue.toString()), "oversized URL rejected");
    }

    private static void integers() {
        Check.equal(5L, TerminalProtocol.integer(5), "integer");
        Check.equal(5L, TerminalProtocol.integer(5.0d), "integral double");
        Check.nullValue(TerminalProtocol.integer(5.5d), "fractional rejected");
        Check.nullValue(TerminalProtocol.integer("5"), "string rejected");
        Check.nullValue(TerminalProtocol.integer(Boolean.TRUE), "boolean rejected");
        Check.nullValue(TerminalProtocol.integer(Double.NaN), "NaN rejected");
        Check.nullValue(TerminalProtocol.integer(9_007_199_254_740_992d), "unsafe integer rejected");
        Check.equal(9_007_199_254_740_991L, TerminalProtocol.integer(9_007_199_254_740_991d), "safe boundary");
    }

    private static void directories() {
        Check.isTrue(TerminalProtocol.directory("/"), "root");
        Check.isTrue(TerminalProtocol.directory("/Users/yuri/project"), "absolute path");
        Check.isFalse(TerminalProtocol.directory("relative/path"), "relative rejected");
        Check.isFalse(TerminalProtocol.directory("//server/share"), "double slash rejected");
        Check.isFalse(TerminalProtocol.directory("/a/../b"), "traversal rejected");
        Check.isFalse(TerminalProtocol.directory("/a/./b"), "dot segment rejected");
        Check.isFalse(TerminalProtocol.directory("/a//b"), "empty segment rejected");
        Check.isFalse(TerminalProtocol.directory("/a\\b"), "backslash rejected");
        Check.isFalse(TerminalProtocol.directory("/a\tb"), "control char rejected");
    }

    private static void identifiers() {
        Check.isTrue(TerminalProtocol.identifier("terminal-surface-abcd_1-2"), "identifier");
        Check.isFalse(TerminalProtocol.identifier(""), "empty rejected");
        Check.isFalse(TerminalProtocol.identifier("a/b"), "slash rejected");
        Check.isFalse(TerminalProtocol.identifier(repeat('a', 129)), "length rejected");
        Check.isTrue(TerminalProtocol.identifier(repeat('a', 128)), "length boundary");
    }

    private static void sizes() {
        Map<String, Object> ok = new LinkedHashMap<>();
        ok.put("cols", 80L);
        ok.put("rows", 24L);
        try {
            int[] size = TerminalProtocol.size(ok);
            Check.equal(80, size[0], "cols");
            Check.equal(24, size[1], "rows");
        } catch (TerminalFailure failure) {
            throw new AssertionError(failure);
        }
        Check.failure("invalid", () -> TerminalProtocol.size(Map.of("cols", 1L, "rows", 24L)), "cols lower bound");
        Check.failure("invalid", () -> TerminalProtocol.size(Map.of("cols", 1001L, "rows", 24L)), "cols upper bound");
        Check.failure("invalid", () -> TerminalProtocol.size(Map.of("cols", 80L, "rows", 0L)), "rows lower bound");
        Check.failure("invalid", () -> TerminalProtocol.size(Map.of("cols", 80L)), "missing rows");
    }

    private static void frames() throws Exception {
        Map<String, Object> bind = new LinkedHashMap<>();
        bind.put("t", "b");
        bind.put("s", "abc-1");
        bind.put("r", 7L);
        bind.put("v", 2L);
        byte[] frame = TerminalProtocol.frame(bind);
        Check.equal((byte) 1, frame[0], "tag byte");
        Check.equal("{\"t\":\"b\",\"s\":\"abc-1\",\"r\":7,\"v\":2}",
                new String(frame, 1, frame.length - 1, java.nio.charset.StandardCharsets.UTF_8), "frame JSON");

        Map<String, Object> escaped = new LinkedHashMap<>();
        escaped.put("d", "a\"b\\c\n\t\u001f");
        escaped.put("n", 1.5d);
        escaped.put("f", false);
        escaped.put("z", null);
        escaped.put("list", List.of(1, "two"));
        Check.equal("{\"d\":\"a\\\"b\\\\c\\n\\t\\u001f\",\"n\":1.5,\"f\":false,\"z\":null,\"list\":[1,\"two\"]}",
                TerminalProtocol.encode(escaped), "escaping");

        Map<String, Object> chrome = new LinkedHashMap<>();
        chrome.put("b", 1L);
        chrome.put("a", Map.of("z", 1L, "y", List.of(Map.of("q", 2L, "p", 3L))));
        Check.equal("{\"a\":{\"y\":[{\"p\":3,\"q\":2}],\"z\":1},\"b\":1}", TerminalProtocol.canonical(chrome),
                "canonical nested sorting");
    }

    private static String repeat(char value, int count) {
        StringBuilder out = new StringBuilder(count);
        for (int i = 0; i < count; i++) out.append(value);
        return out.toString();
    }
}
