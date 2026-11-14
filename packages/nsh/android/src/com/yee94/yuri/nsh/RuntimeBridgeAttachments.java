package com.yee94.yuri.nsh;

import java.nio.charset.StandardCharsets;

/**
 * Pure helpers for the attachment upload reply (iOS attachmentUploader): Host paths
 * are only accepted as absolute POSIX or Windows drive paths, and the local file URL
 * keeps Foundation's {@code file:///…} shape with percent-encoded components.
 */
final class RuntimeBridgeAttachments {
    private RuntimeBridgeAttachments() {}

    static String localPath(String path) throws RuntimeBridgeFailure {
        if (path == null || path.isEmpty()) {
            throw new RuntimeBridgeFailure("attachment_upload_failed", "Host 返回了无效的附件绝对路径");
        }
        if (path.startsWith("/")) return path;
        if (path.matches("^[A-Za-z]:[/\\\\].*")) return "/" + path.replace('\\', '/');
        throw new RuntimeBridgeFailure("attachment_upload_failed", "Host 返回了无效的附件绝对路径");
    }

    static String fileURL(String path) {
        byte[] bytes = path.getBytes(StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder("file://");
        for (byte current : bytes) {
            int unsigned = current & 0xff;
            boolean allowed = unsigned >= 'A' && unsigned <= 'Z' || unsigned >= 'a' && unsigned <= 'z'
                || unsigned >= '0' && unsigned <= '9' || "/-._~!$&'()*+,;=:@".indexOf(unsigned) >= 0;
            if (allowed) out.append((char) unsigned);
            else out.append('%').append(String.format("%02X", unsigned));
        }
        return out.toString();
    }
}
