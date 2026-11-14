# resources-preview: JVM contract tests (Agent 3)

Pure-logic tests for `Resource*`, `GuiPlugin*` and `YuriViewExport*`. They need no
device, emulator, network or `nsh.aar`: the runtime types are compiled from the
compile-only stubs in `stubs/` (mirrors of
`~/Code/github/nsh/crates/nsh-platform-android/java/com/longbridge/nsh`), and
`android.jar` is on the runtime classpath only so the bridge classes verify. No
Android method is invoked.

```sh
cd packages/nsh/android
ANDROID_JAR=/opt/homebrew/share/android-commandlinetools/platforms/android-35/android.jar
OUT=$(mktemp -d)

javac --release 17 -d "$OUT/classes" -cp "$ANDROID_JAR" \
  tests/resources-preview/stubs/com/longbridge/nsh/*.java \
  src/com/yee94/yuri/nsh/HostLease.java src/com/yee94/yuri/nsh/HostLeaseProvider.java \
  src/com/yee94/yuri/nsh/RuntimeHostScope.java src/com/yee94/yuri/nsh/RuntimeHostScopeFailure.java \
  src/com/yee94/yuri/nsh/RuntimeHostText.java \
  src/com/yee94/yuri/nsh/Resource*.java src/com/yee94/yuri/nsh/GuiPlugin*.java \
  src/com/yee94/yuri/nsh/YuriViewExport*.java

javac --release 17 -d "$OUT/test" -cp "$OUT/classes:$ANDROID_JAR" \
  tests/resources-preview/ResourcesPreviewTest.java

java -cp "$OUT/test:$OUT/classes:$ANDROID_JAR" com.yee94.yuri.nsh.ResourcesPreviewTest
```

Current result: **153 assertions passed**.

Covered: media-kind policy, canonical path/scope routing (`yuri-resource://`),
loopback and preview-proxy admission, response/MIME/size validation, JSON reader
and writer, GUI response-header whitelist and head validation, bounded buffer,
direct-body partial-error behaviour, Relay rendezvous back-pressure/tail/terminal
error, contact-attachment descriptor parsing + generation/digest verification,
resource web preview and SVG request parsing, GUI asset scope, export request
bounds, and the GUI device policy.

Not covered here (needs a device, Host or `nsh.aar`): WebView interception,
`PdfRenderer` previews, `MediaExtractor` probes, thumbnails, toast rendering,
the JavaScript message-channel shim, SAF save/share, and any real Host request.

## MainActivity wiring this agent does not own

```java
// Files / resources
ResourceBridge resources = new ResourceBridge(activity, runtime, view);
resources.install();
ResourceWebPreviewBridge web = new ResourceWebPreviewBridge(activity, runtime, view);
web.setInitialFile(resources::htmlInitial);   // bounded original read for the inline HTML mount
web.install();
ResourceHTMLComponents.installView(view, web);              // yuri.resource.html
ResourceHTMLComponents.installPresentationAnchor(view, resources); // yuri.resource.presentation
ResourceSVGImageComponent.install(view, resources.svgResolver());  // yuri.resource.svgImage

// GUI plugin preview (needs the staged browser bundle from build-gui-plugin-preview.mjs)
GuiPluginPreviewBridge gui = new GuiPluginPreviewBridge(activity, runtime, view);
GuiPluginPreviewBridge.Resources guiResources = new GuiPluginPreviewBridge.Resources(
        new File(filesDir, "gui-plugin-preview"), new File(filesDir, "gui-plugin-storage"));
gui.setCaptureProvider(expected -> guiResources.capture(expected, runtime::isCurrent,
        ResourceWebPreviewBridge.transport(runtime.capture(expected)), runtime.guiReader()));
gui.install();
```

- Call `web.setForeground(false)`, `gui.setForeground(false)` and each `invalidate()`
  from `onPause` / `RuntimeBridge.onInvalidate` / `onDestroy`.
- Forward activity results: `ResourceBridge.SaveRequest.deliver(requestCode, uri)` and
  `GuiPluginDeviceBridge.DocumentTarget.deliver(requestCode, uri)`.
- `resources.present` action `share` needs the manifest provider (no AndroidX):
  `com.yee94.yuri.nsh.ResourceShareProvider` with authority
  `com.yee94.yuri.nsh.files`, `exported="false"`,
  `grantUriPermissions="true"`.
- `runtime.guiReader()` has no equivalent yet in `HostLease`; until `RuntimeBridge`
  exposes the GUI read lane, `plugins.preview.present` fails with `unsupported`
  exactly like an iOS capture without `readGui`.
