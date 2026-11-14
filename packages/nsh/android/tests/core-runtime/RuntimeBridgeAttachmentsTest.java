package com.yee94.yuri.nsh;

/**
 * JVM-only evidence for iOS attachmentUploader's Host path acceptance and the local
 * {@code file:///…} URL shape. Run with the fully qualified class name.
 */
public final class RuntimeBridgeAttachmentsTest {
    private static int passed;
    private static int failed;

    public static void main(String[] args) {
        try {
            check("posix absolute", RuntimeBridgeAttachments.localPath("/a/b c.txt").equals("/a/b c.txt"));
            check("windows backslash", RuntimeBridgeAttachments.localPath("C:\\tmp\\a.txt").equals("/C:/tmp/a.txt"));
            check("windows slash", RuntimeBridgeAttachments.localPath("D:/tmp/a.txt").equals("/D:/tmp/a.txt"));
            check("relative rejected", rejects("a.txt"));
            check("drive without separator rejected", rejects("C:tmp"));
            check("empty rejected", rejects(""));
            check("file url", RuntimeBridgeAttachments.fileURL("/a/b c.txt").equals("file:///a/b%20c.txt"));
            check("file url unicode",
                RuntimeBridgeAttachments.fileURL("/a/文件.txt").equals("file:///a/%E6%96%87%E4%BB%B6.txt"));
            check("file url reserved",
                RuntimeBridgeAttachments.fileURL("/tmp/a#b?.txt").equals("file:///tmp/a%23b%3F.txt"));
            check("file url windows", RuntimeBridgeAttachments.fileURL("/C:/tmp/a.txt").equals("file:///C:/tmp/a.txt"));
        } catch (Throwable failure) {
            failed += 1;
            failure.printStackTrace();
        }
        System.out.println(passed + " passed, " + failed + " failed");
        if (failed > 0) throw new IllegalStateException("attachment path tests failed");
    }

    private static boolean rejects(String path) {
        try {
            RuntimeBridgeAttachments.localPath(path);
            return false;
        } catch (RuntimeBridgeFailure expected) {
            return true;
        }
    }

    private static void check(String name, boolean condition) {
        if (condition) passed += 1;
        else {
            failed += 1;
            System.out.println("FAIL " + name);
        }
    }
}
