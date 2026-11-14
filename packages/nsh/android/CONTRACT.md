# NSH Android Host: 分工合同

目标：为 `packages/nsh`（TSX 层不改）实现与 `packages/nsh/ios/*.swift` 对等的 Android Host。每个 Swift Bridge 对应一个 Java 类，行为、校验、失败码、事件名和大小/超时上限与 iOS 保持一致；iOS 源码是唯一权威规格。

## 硬约束

- 只写 Java（JDK 21 `javac --release 17`，无 Gradle、无 Kotlin、无第三方依赖）。运行时由 `nsh.aar`（`com.longbridge.nsh.NshView`，见 `~/Code/github/nsh/website/docs/android.md`）提供；minSdk 28，compileSdk 35。可以直接读 `~/Code/github/nsh/crates/nsh-platform-android/java` 了解运行时 API，**不要修改 `~/Code/github/nsh`**。
- 所有 Java 源码放 `packages/nsh/android/src/com/yee94/yuri/nsh/`，包名 `com.yee94.yuri.nsh`。资源放 `packages/nsh/android/res/`，清单 `packages/nsh/android/AndroidManifest.xml`。
- TSX、`nsh.json`、`packages/ui` 等现有文件不要改。不运行任何 git 命令。不记录或打印 secret、bearer、配对凭据。
- 不修改已有注释。新代码注释保持精简，仅解释不明显的行为。
- 凭据、Authorization 头、Keychain 对应物（Android Keystore + `SharedPreferences`/文件加密存储）只存在于 Java 侧，不进入 JS。
- iOS 专属且 Android 没有对应物的能力，必须返回与 iOS 同形状的明确 `unsupported`/失败 reply（不能静默成功，也不能崩溃）；在对应类的头部注释一行说明原因。
- 每个 Bridge 在 `host` 名称、入参校验、返回值形状上与 iOS 逐项一致。`nsh.json` 中 `capabilities.host` 是权威调用清单。

## 共享接口（已存在，不要改签名）

`HostLease.java`：对单个 Host、单个生命周期代的已认证访问。只有 `RuntimeBridge` 实现它；其他 Bridge 通过 `HostLeaseProvider` 取得。对应 iOS 的 `ResourceTransport/TerminalTransport/RemoteDesktopTransport/...`。

`HostLeaseProvider.java`（已存在）：

```java
public interface HostLeaseProvider {
    /** expected 为 null 表示用当前 scope；scope 失配抛 RuntimeHostScopeFailure（code 与 iOS 同名）。 */
    HostLease capture(HostLease.Scope expected) throws Exception;
}
```

每个 Bridge 的统一形状：

```java
public final class XxxBridge {
    public XxxBridge(Activity activity, HostLeaseProvider leases, NshView view);
    public void install();      // view.handle("name", ...) 注册
    public void invalidate();   // Host/授权/代际变化时撤销所有进行中的工作
}
```

`MainActivity` 持有全部 Bridge，并在 `RuntimeBridge.onInvalidate` 里统一调用各 `invalidate()`；`onResume/onPause` 转 `setForeground`。事件用 `view.send(name, data)` 回传，事件名与 iOS 相同。

## 分工（每个 Agent 独占自己的文件，不跨界改动）

### Agent 1 `core-runtime`
`ConnectionStore`、`RuntimeHostScope`/`RuntimeHostAuthority`、`RuntimeBridge`（含 `HostLease` 实现、配对、密码登录、URL/重定向/大小限制、SSE）、`RelayTunnel`（P-256/HKDF/AES-GCM，用 `javax.crypto`/`java.security`）、`SessionMessageStream`(+Direct)、`AuthorizationCacheCleanup`(+Bridge)、`connection-editor`、`QRScanner`/`camera.scan`（用 CameraX 不可用时用 `Intent` 到系统扫码不可行，则提供基于 `android.hardware.camera2`+`ImageReader` 的自写 QR 解码入口并在不可用时 reject；不得新增依赖）。
文件前缀：`ConnectionStore*`、`RuntimeHost*`、`RuntimeBridge*`、`RelayTunnel*`、`SessionMessageStream*`、`AuthorizationCache*`、`ConnectionEditor*`、`QrScanner*`。

### Agent 2 `shell-app`
构建与入口：`scripts/build-android.mjs`（`bun run --cwd packages/nsh android:build`，复用 `stage-native-application.mjs` 产出 TSX bundle，用 SDK build-tools 的 `aapt2/javac/d8/zipalign/apksigner` 直接构建 APK，debug keystore 自动生成；支持 `NSH_DIST` 指向含 `embed/android/nsh.aar` 的发行目录）、`AndroidManifest.xml`、`MainActivity`/`YuriApplication`、启动页与图标（取 `assets/brand/yuri`，可用 `aapt2` 编译 vector/png）、`package.json` 新增 `android:build` 脚本、`README.md`/`DOCUMENTATION.md` 的 Android 章节、`android/README.md`。
其余 Bridge：`AppearanceBridge`、`NativeFont*`（字体下载注册，用 `Typeface.createFromFile` 能力受限则按 iOS 的失败反馈返回 unsupported）、`DiagnosticsBridge`、`NavigationBridge`、`FeedbackLayoutBridge`、`ScheduleDateBridge`、`DatePicker`、`ChatHeaderCollapse`、`ComposerPress`、`NativeComposerSpellcheck*`、`NativeInputMetadata*`、`NewSessionPickerOwners`、`SheetPresentation`（Android 用运行时自带的非 iOS Sheet fallback，仅需把 NSH 能力声明对齐）、`AttachmentBridge`/`AttachmentReceiptJournal`/`AttachmentUploadPolicy`（系统文件/相册选择器 `ACTION_OPEN_DOCUMENT`）。
文件前缀：`MainActivity*`、`YuriApplication*`、`Appearance*`、`NativeFont*`、`Diagnostics*`、`Navigation*`、`FeedbackLayout*`、`ScheduleDate*`、`DatePicker*`、`ChatHeader*`、`Composer*`、`NativeComposer*`、`NativeInput*`、`NewSessionPicker*`、`Sheet*`、`Attachment*`、`NativeHandlers`（统一注册表）。Agent 2 负责最后把所有 Bridge 装配进 `MainActivity`。

### Agent 3 `resources-preview`
`ResourceBridge`、`ResourceHTMLComponents`、`ResourceWebPreviewBridge`/`ResourceWebPreviewView`（`android.webkit.WebView`，禁用 JS 桥注入、仅允许资源 URL，严格对齐 iOS 的拦截/大小/MIME 规则）、`ResourceSVGImageComponent`、`GuiPluginPreviewBridge`、`GuiPluginDeviceBridge`、`GuiPluginRuntime`、`GuiPluginResourceResolver`（`YuriViewExportRenderer` 的 Android 对应物自写，iOS 原件在 `packages/mobile/ios/App/App/YuriViewExportRenderer.swift`）。
文件前缀：`Resource*`、`GuiPlugin*`、`YuriViewExport*`。

### Agent 4 `realtime-io`
`TerminalBridge`/`TerminalTransport`/`NativeTerminalPreview`、`RemoteDesktopBridge`（JPEG 解码后 ACK）、`VoiceRecognitionBridge`/`Core`/`Runtime`（`AudioRecord` 采集，逻辑在 Core 里与平台无关的部分原样移植）、`SpeechPlaybackBridge`/`SpeechVoiceCatalogPolicy`（`TextToSpeech` + `MediaPlayer`；`speech.awake` 沿用 iOS 的 unsupported 语义）。
文件前缀：`Terminal*`、`NativeTerminal*`、`RemoteDesktop*`、`VoiceRecognition*`、`Speech*`。

### Agent 5 `security-notify`
`PasskeyBridge`/`PasskeyPolicy`（Android Credential Manager 在无 AndroidX 依赖时不可用：用 `android.credentials.CredentialManager`（API 34+）反射/直接调用，低版本返回与 iOS 同形状的 unsupported）、`NotificationBridge`/`NotificationLaunch*`（用 `NotificationManager` 渠道 + 本地通知；FCM 无依赖不可用，APNs 对应的推送注册返回明确 unsupported，`notification.live`/`launch.*` 的本地 admission/receipt 逻辑完整实现）。
文件前缀：`Passkey*`、`Notification*`。

## 验收（每个 Agent 交付前自测）

1. `bun scripts/check-native-bridge.mjs` 与现有 Vitest 不得被你的改动破坏（你不应改动 TS）。
2. 本机 `javac --release 17 -cp <nsh.aar classes.jar + android.jar> ...` 编译自己的文件无错误（`nsh.aar` 位于 `~/Code/github/nsh/dist/nsh/embed/android/`；尚未生成时，先对 `android.jar` 编译并对尚缺的 `NshView` API 以注释标明待核对，随后 Agent 2 统一联编）。
3. 对纯逻辑（校验、CAS、journal、解析、Relay 加密）写 JVM 单元测试到 `packages/nsh/android/tests/<name>/`，用 `javac` + `java` 直接运行（不引入 JUnit，使用自带 `main` 断言），并在 `android/README.md` 的测试表里登记命令。
4. 在交付说明里逐项列出：已实现的 host 调用名、返回 unsupported 的调用名及原因、哪些只做了 JVM 层验证而未在真机/模拟器验证。不得把未验证说成已验证。
