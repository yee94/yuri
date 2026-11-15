import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));

test('production Android attachment picker reopens after runtime invalidation and cancels without upload', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nsh-attachment-lifecycle-'));
  const stubs: Record<string, string> = {
    'android/app/Activity.java': `package android.app;
      public class Activity {
        public static final int RESULT_OK = -1;
        public final java.io.File folder; public Runnable onPick; public int launches;
        public Activity(java.io.File folder) { this.folder = folder; }
        public java.io.File getFilesDir() { return folder; }
        public String getPackageName() { return "fixture"; }
        public android.content.ContentResolver getContentResolver() { return new android.content.ContentResolver(); }
        public void startActivityForResult(android.content.Intent intent, int request) { launches++; onPick.run(); }
      }`,
    'android/content/Intent.java': `package android.content;
      public class Intent {
        public static final String ACTION_OPEN_DOCUMENT="open", CATEGORY_OPENABLE="openable";
        public static final int FLAG_GRANT_READ_URI_PERMISSION=1;
        public android.net.Uri data;
        public Intent(String action) {} public Intent addCategory(String value) { return this; }
        public Intent setType(String value) { return this; } public Intent addFlags(int value) { return this; }
        public android.net.Uri getData() { return data; }
      }`,
    'android/net/Uri.java': 'package android.net; public class Uri {}',
    'android/content/ContentResolver.java': `package android.content;
      public class ContentResolver {
        public String getType(android.net.Uri uri) { return "text/plain"; }
        public android.database.Cursor query(android.net.Uri uri, String[] projection, String selection, String[] args, String sort) { return null; }
        public java.io.InputStream openInputStream(android.net.Uri uri) { return new java.io.ByteArrayInputStream("fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
      }`,
    'android/util/Log.java': 'package android.util; public class Log { public static int w(String tag, String message, Throwable error) { return 0; } }',
    'com/longbridge/nsh/NshHostReply.java': `package com.longbridge.nsh;
      public interface NshHostReply { void resolve(Object value); void reject(String error); }`,
    'com/longbridge/nsh/NshView.java': `package com.longbridge.nsh;
      public class NshView {
        public interface Handler { void call(Object data, NshHostReply reply); }
        public final java.util.Map<String,Handler> handlers = new java.util.HashMap<>();
        public void handle(String name, Handler handler) { handlers.put(name, handler); }
      }`,
    'com/yee94/yuri/nsh/NativeHandlers.java': `package com.yee94.yuri.nsh;
      public class NativeHandlers {
        public interface Bridge { void install(); void invalidate(); }
        public interface Foreground { void setForeground(boolean value); }
        public interface ActivityResultSink { boolean onActivityResult(int request, int result, android.content.Intent intent); }
        public static void post(Runnable work) { work.run(); }
      }`,
    'com/yee94/yuri/nsh/HostLease.java': `package com.yee94.yuri.nsh;
      public class HostLease {
        public static class Scope {
          public final String hostID, lease;
          public Scope(String host, String lease) { this.hostID=host; this.lease=lease; }
          public boolean equals(Object value) { return value instanceof Scope && hostID.equals(((Scope)value).hostID) && lease.equals(((Scope)value).lease); }
          public int hashCode() { return hostID.hashCode() ^ lease.hashCode(); }
        }
      }`,
    'com/yee94/yuri/nsh/HostLeaseProvider.java': 'package com.yee94.yuri.nsh; public interface HostLeaseProvider {}',
    'com/yee94/yuri/nsh/Check.java': `package com.yee94.yuri.nsh;
      import java.util.*; import java.util.concurrent.*;
      public class Check {
        static class Runtime implements HostLeaseProvider, AttachmentRuntime {
          public int uploads;
          public void validateAttachmentHost(HostLease.Scope scope) {}
          public Map<String,Object> uploadPlain(HostLease.Scope scope, byte[] data, String name, String mime) {
            uploads++;
            if (!scope.hostID.equals("fixture") || !new String(data,java.nio.charset.StandardCharsets.UTF_8).equals("fixture") || !mime.equals("text/plain")) throw new AssertionError("picker descriptor mismatch");
            return Map.of("uri","file:///fixture.txt","name",name,"mime",mime);
          }
          public AttachmentRuntime.Operation contactOperation(HostLease.Scope s,String id,Integer g,String r,AttachmentReceiptJournal.DraftContext c,AttachmentReceiptJournal j) { throw new AssertionError(); }
          public AttachmentRuntime.Operation restoreOperation(AttachmentReceiptJournal.Record r,HostLease.Scope s,AttachmentReceiptJournal j) { throw new AssertionError(); }
        }
        static Object pick(com.longbridge.nsh.NshView view) throws Exception {
          CompletableFuture<Object> done = new CompletableFuture<>();
          view.handlers.get("runtime.pickAttachment").call(Map.of("kind","files","requestId",UUID.randomUUID().toString(),"expectedHost",Map.of("hostID","fixture","lease","lease")),new com.longbridge.nsh.NshHostReply() {
            public void resolve(Object value) { done.complete(value); }
            public void reject(String error) { done.completeExceptionally(new AssertionError(error)); }
          });
          return done.get(2,TimeUnit.SECONDS);
        }
        public static void main(String[] args) throws Exception {
          android.app.Activity activity = new android.app.Activity(new java.io.File(args[0]));
          com.longbridge.nsh.NshView view = new com.longbridge.nsh.NshView();
          Runtime runtime = new Runtime();
          AttachmentBridge bridge = new AttachmentBridge(activity,runtime,view);
          activity.onPick = () -> bridge.onActivityResult(0x5101,0,null);
          bridge.install(); if (pick(view) != null) throw new AssertionError("cancel must resolve null");
          bridge.invalidate(); bridge.setForeground(true); if (pick(view) != null) throw new AssertionError("cancel must resolve null");
          bridge.invalidate(); bridge.setForeground(true); if (pick(view) != null) throw new AssertionError("cancel must resolve null");
          if (activity.launches != 3) throw new AssertionError("picker did not reopen: " + activity.launches);
          if (runtime.uploads != 0) throw new AssertionError("cancelled picker uploaded");
          activity.onPick = () -> {
            android.content.Intent result = new android.content.Intent("result"); result.data = new android.net.Uri();
            bridge.onActivityResult(0x5101,android.app.Activity.RESULT_OK,result);
          };
          if (!(pick(view) instanceof Map) || runtime.uploads != 1) throw new AssertionError("selected file did not upload once");
          activity.onPick = () -> { bridge.invalidate(); bridge.onActivityResult(0x5101,android.app.Activity.RESULT_OK,new android.content.Intent("stale")); };
          if (pick(view) != null || runtime.uploads != 1) throw new AssertionError("retired selection uploaded");
          if (ForegroundHold.held()) throw new AssertionError("picker hold leaked");
          System.out.println("picker reopening, cancelled/stale selections, exact file upload and hold cleanup passed");
        }
      }`,
  };
  try {
    const sources = Object.entries(stubs).map(([file, source]) => {
      const filename = path.join(root, file); mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, source); return filename;
    });
    const sdk = process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools';
    const jar = path.join(sdk, 'platforms/android-35/android.jar');
    const production = ['AttachmentBridge', 'AttachmentRuntime', 'AttachmentReceiptJournal', 'AttachmentUploadPolicy', 'NativeHandlersJson', 'ForegroundHold'];
    sources.push(...production.map(name => path.join(directory, 'android/src/com/yee94/yuri/nsh', name + '.java')));
    const compiled = path.join(root, 'classes');
    const build = spawnSync('javac', ['--release', '17', '-cp', jar, '-d', compiled, ...sources], { encoding: 'utf8', timeout: 20000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const result = spawnSync('java', ['-cp', [compiled, jar].join(path.delimiter), 'com.yee94.yuri.nsh.Check', root], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 40000);
