package com.yee94.yuri.nsh;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Minimal `FileProvider` for `resources.present` action `share`, because Android
 * forbids handing a `file://` URI to another app and this host takes no AndroidX
 * dependency.
 *
 * It serves read-only descriptors for files under this app's cache directory
 * inside a resource/GUI temporary folder, and nothing else. The app manifest must
 * declare it (Agent 2 wiring):
 *
 * <pre>
 * &lt;provider android:name="com.yee94.yuri.nsh.ResourceShareProvider"
 *     android:authorities="com.yee94.yuri.nsh.files"
 *     android:exported="false" android:grantUriPermissions="true" /&gt;
 * </pre>
 *
 * Without that declaration the share action fails explicitly instead of exposing
 * an unreadable URI.
 */
public final class ResourceShareProvider extends ContentProvider {
    static final String AUTHORITY = ResourceBridge.SHARE_AUTHORITY;
    static final String SCHEME = "content";

    /** Content URI for one app-private temporary file, or null when outside the shared roots. */
    static Uri uriFor(Context context, File file) {
        String root = context.getCacheDir().getAbsolutePath();
        String path = file.getAbsolutePath();
        if (!path.startsWith(root + File.separator)) return null;
        String relative = path.substring(root.length() + 1);
        if (!(relative.startsWith("resources-") || relative.startsWith("gui-device-"))) return null;
        return new Uri.Builder().scheme(SCHEME).authority(AUTHORITY)
                .appendEncodedPath(Uri.encode(relative, "/")).build();
    }

    private File resolve(Uri uri) throws FileNotFoundException {
        if (!AUTHORITY.equals(uri.getAuthority())) throw new FileNotFoundException("authority");
        String relative = uri.getPath() == null ? "" : uri.getPath().replaceFirst("^/", "");
        if (relative.isEmpty() || relative.contains("..") || relative.contains("\\")) throw new FileNotFoundException("path");
        File root = getContext() == null ? null : getContext().getCacheDir();
        if (root == null) throw new FileNotFoundException("root");
        if (!(relative.startsWith("resources-") || relative.startsWith("gui-device-"))) throw new FileNotFoundException("root");
        File file;
        String rootPath;
        try {
            file = new File(root, relative).getCanonicalFile();
            rootPath = root.getCanonicalPath();
        } catch (java.io.IOException failure) {
            throw new FileNotFoundException("path");
        }
        if (!file.getPath().startsWith(rootPath + File.separator) || !file.isFile()) {
            throw new FileNotFoundException("path");
        }
        return file;
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (mode != null && !mode.equals("r")) throw new FileNotFoundException("read only");
        return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public String getType(Uri uri) {
        String name = uri.getLastPathSegment();
        String extension = name == null ? "" : ResourceMediaPolicy.extension(name);
        switch (extension) {
            case "png": return "image/png";
            case "jpg":
            case "jpeg": return "image/jpeg";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "pdf": return "application/pdf";
            case "svg": return "image/svg+xml";
            case "txt": return "text/plain";
            case "html":
            case "htm": return "text/html";
            case "mp4": return "video/mp4";
            case "mp3": return "audio/mpeg";
            default: return "application/octet-stream";
        }
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override public Uri insert(Uri uri, ContentValues values) { return null; }

    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }

    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
}
