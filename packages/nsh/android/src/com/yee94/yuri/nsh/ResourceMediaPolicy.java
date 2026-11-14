package com.yee94.yuri.nsh;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Port of iOS `ResourceMediaPolicy`. Format admission only; native playback is
 * still probed on the protected local file.
 */
final class ResourceMediaPolicy {
    static final int BINARY_LIMIT = 25 * 1024 * 1024;
    static final int TEXT_LIMIT = 1_000_000;
    static final int STAT_LIMIT = 64 * 1024;

    private static final Set<String> PLAYLISTS = new HashSet<>(Arrays.asList("m3u", "m3u8", "pls", "mpd"));
    private static final Set<String> PLAYLIST_TYPES = new HashSet<>(Arrays.asList(
            "application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl", "application/dash+xml"));
    private static final Set<String> IMAGES = new HashSet<>(Arrays.asList("png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff"));
    private static final Set<String> VIDEOS = new HashSet<>(Arrays.asList("mp4", "m4v", "webm", "mov", "ogv", "ogg"));
    private static final Set<String> AUDIOS = new HashSet<>(Arrays.asList("mp3", "m4a", "aac", "wav", "wave", "aif", "aiff", "caf", "flac", "oga", "opus"));

    private ResourceMediaPolicy() {}

    /** Lowercase extension after the last dot of the final path segment, or "". */
    static String extension(String path) {
        String name = path;
        int slash = name.lastIndexOf('/');
        if (slash >= 0) name = name.substring(slash + 1);
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
    }

    static String kind(String path, String mime, boolean binary, boolean containsNull) {
        String ext = extension(path);
        String type = mime == null ? "" : mime.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        if (PLAYLISTS.contains(ext) || PLAYLIST_TYPES.contains(type)) return "binary";
        if (IMAGES.contains(ext)) return "image";
        if (ext.equals("svg") || type.equals("image/svg+xml")) return "svg";
        if (ext.equals("pdf")) return "pdf";
        if (type.startsWith("video/")) return "video";
        if (type.startsWith("audio/")) return "audio";
        if (VIDEOS.contains(ext)) return "video";
        if (AUDIOS.contains(ext)) return "audio";
        return binary || containsNull ? "binary" : "text";
    }

    static boolean containsNull(byte[] data) {
        for (byte value : data) if (value == 0) return true;
        return false;
    }

    static boolean isHtmlPath(String path) {
        String ext = extension(path);
        return ext.equals("html") || ext.equals("htm");
    }
}
