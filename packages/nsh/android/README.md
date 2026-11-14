# Android Host

`com.yee94.yuri.nsh` 的 Android Host，与 `packages/nsh/ios/*.swift` 对等移植。
一个 `AndroidManifest.xml`、一个 `MainActivity`、一个 `com.longbridge.nsh.NshView`
引擎；TSX 层（`App.tsx` 等）不改，`nsh.json` 不改。

## 构建

前置：

- Android SDK：`platforms/android-35`、`build-tools`（含 `aapt2`、`d8`、`zipalign`、`apksigner`）、
  `platform-tools`（可选，安装用）。`ANDROID_HOME` / `ANDROID_SDK_ROOT` 或常见安装位置。
- JDK 17+（`javac --release 17`），`JAVA_HOME` 或 PATH。
- NSH distribution：`embed/android/nsh.aar`（`NSH_DIST`，默认从 `NSH_BIN` 推导）。
- `nsh` 可执行文件（`NSH_BIN`，默认 PATH），用于把 TSX 编译成 `bundle.nshc`。

```sh
export NSH_BIN="/path/to/nsh/bin/nsh"
export NSH_DIST="/path/to/nsh"        # 含 embed/android/nsh.aar
export ANDROID_HOME="$HOME/Library/Android/sdk"

bun run --cwd packages/nsh android:build
```

产物：`packages/nsh/.nsh/out/YuriNative.apk`（debug keystore 自动生成于
`~/.android/debug.keystore`）。构建证据：`.nsh/out/android-evidence.json`。
脚本直接调用 SDK 工具，无 Gradle、无 Kotlin、无第三方依赖。

APK 内容：`classes.dex`（本包 Java + `nsh.aar` 的 `classes.jar`）、
`lib/<abi>/libnsh.so`（来自 `jni/`，store 不压缩）、`assets/nsh`（TSX bundle）、
`assets/terminal-ghostty*`（离线终端资源）、`res/`（图标与启动页）。

## 布局

| 路径 | 内容 |
| --- | --- |
| `AndroidManifest.xml` | 包名、权限、`MainActivity`、`yuri://connect` 深链 |
| `src/com/yee94/yuri/nsh/` | 全部 Java 源码，包名 `com.yee94.yuri.nsh` |
| `res/` | 主题、启动页、图标 |
| `tests/` | JVM 单测（无 JUnit），用 `javac` + `java` 直接运行 |
| `../scripts/build-android.mjs` | 构建脚本 |

## 宿主调用

本目录负责的 Host 调用：

| 调用 | 说明 |
| --- | --- |
| `appearance.reset` / `appearance.apply` / `appearance.fonts.retry` | 语义色板整包校验、`cssVars` + 字体 token 覆盖、字体投影重试；返回 `{...fontState, fontRevision, systemColorScheme}` |
| `native.clientMetadata` | 版本/构建 + 固定 updates 阻塞项，内容无关 |
| `native.diagnostics.status` / `setEnabled` / `append` / `export` | 有界内存 ring、内容无关事件投影、`ACTION_CREATE_DOCUMENT` 导出（有真实完成回调） |
| `navigation.anchor` | 唯一 surface 坐标；Android 无 AX identifier 时返回 `null` |
| `feedback.layout` | 只读顶部 inset/平台 Toolbar 几何 |
| `schedule.dateContext` | IANA 时区偏移与 DST transition，`java.time` |
| `runtime.pickAttachment` / `cancelAttachment` / `reconcileAttachment` / `acknowledgeAttachment` / `pendingAttachments` | `ACTION_OPEN_DOCUMENT`、25 MiB/非空校验、SHA-256、receipt journal 与阶段 CAS |
| `camera.scan` | 由 `QrScanner`（Agent 1）提供；本目录不重复注册 |

注册的 NSH 原生组件：

| 组件 | Android 行为 |
| --- | --- |
| `yuri.datePicker` | `CalendarView` inline 单日期；严格 `yyyy-MM-dd`、周起始、min/max |
| `yuri.newSession.inputAX` | 结构化定位唯一输入框并写 `contentDescription`；歧义时报 `failure` 事件 |
| `yuri.input.metadata` | 校验同形快照，Android 无 AX identifier → 报 `unsupported` |
| `yuri.composer.spellcheck` | 移植 lease/coordinator 生命周期；Android 无 per-editor spellcheck → `unsupported`，绝不写 |
| `yuri.composer.press` | Android 无法从兄弟组件缩放 NSH 渲染的输入卡 → `unsupported` |
| `yuri.chat.headerCollapse` | Android 无平台导航栏可变换 → `unsupported` |
| `yuri.sheet.presentation` | Android 使用 NSH 自带 Sheet fallback；组件仅校验 props |

`MainActivity` 装配全部 Bridge（含其他文件的 `RuntimeBridge`、`Resource*`、
`GuiPlugin*`、`Terminal*`、`RemoteDesktop*`、`VoiceRecognition*`、`SpeechPlayback*`、
`Passkey*`、`Notification*`、`AuthorizationCacheCleanup*`），
`RuntimeBridge.setOnInvalidate` 统一调用 `NativeHandlers.invalidate()`，
`onResume/onPause` 转 `setForeground`。`TerminalBridge` 自己创建并注册
`NativeTerminalPreview`（不另建）。听写前先停止朗读
（`VoiceRecognitionBridge.setBeforeCapture(speech::invalidate)`），退出时
`SpeechPlaybackBridge.release()`。

`onRequestPermissionsResult` 合并转发给 `VoiceRecognitionPermissions.dispatch`
与 `NotificationBridge`；`onNewIntent` 的通知回执转交 `NotificationBridge.receiveTap`。

资源预览注册 `yuri.resource.html` / `yuri.resource.presentation` /
`yuri.resource.svgImage`，并转发 `ResourceBridge.SaveRequest` 与
`GuiPluginDeviceBridge.DocumentTarget` 的活动结果。GUI 浏览器 bundle 由构建脚本
staging 到 APK `assets/gui-plugin-preview`，首次使用复制到 `files/gui-plugin-preview`。
`HostLease` 尚无 GUI read lane，因此 GUI capture 的 `readGui` 为 `null`，
仅 `openGui` 的读取按合同报告 `unsupported`。

Passkey 的 RP 校验读取 manifest meta-data
`com.yee94.yuri.nsh.associatedDomains`（逗号分隔 `webcredentials:<host>`）。
构建时设置 `YURI_WEBCREDENTIALS_DOMAINS="example.com,login.example.com"` 注入；
未设置则不写该 meta-data，passkey 明确返回 `passkey_associated_domain_required`。

## 明确 unsupported / 受限项

| 能力 | 原因 |
| --- | --- |
| 下载/内置 Web 字体应用 | Android `Typeface.createFromFile` 的实例无法被 NSH 的 family-name token 解析，WOFF2 也不是 Typeface 格式；任何非 `system-ui`/`monospace` 都投影为 `fontStatus: "unsupported"` 并列入 `unsupportedFonts` |
| `appearance.apply` 的强制深浅色 | 无 AndroidX 时框架没有强制 `uiMode` 的公开 API；`mode` 仍严格校验，并由 TSX `setColorScheme` 应用，原生 chrome 跟随系统 |
| `yuri.input.metadata`、`yuri.composer.spellcheck`、`yuri.composer.press`、`yuri.chat.headerCollapse` | 见上表；组件发 `unsupported` 事件，不伪造成功 |
| 附件 Host 传输 | `AttachmentBridge` 的传输/原始授权在 `RuntimeBridge`。后者实现 `AttachmentRuntime` 后附件可用；未实现时五个附件调用明确失败 `attachment_runtime_unavailable`（当前状态） |
| APNs 推送注册 | 无 FCM 依赖；`NotificationBridge` 负责本地 admission/receipt |

## 测试

纯逻辑（校验、receipt 阶段 CAS、journal、JSON、spellcheck lease、AX binding）
不需要 Android 运行时，直接在本机 JDK 运行：

```sh
cd packages/nsh/android
# receipt journal / upload policy / JSON
rm -rf /tmp/nsh-attachment && mkdir -p /tmp/nsh-attachment
javac --release 17 -d /tmp/nsh-attachment \
  src/com/yee94/yuri/nsh/NativeHandlersJson.java \
  src/com/yee94/yuri/nsh/AttachmentUploadPolicy.java \
  src/com/yee94/yuri/nsh/AttachmentReceiptJournal.java \
  tests/attachment-receipt/Main.java
java -cp /tmp/nsh-attachment Main

# composer spellcheck lease / input metadata binding
rm -rf /tmp/nsh-bindings && mkdir -p /tmp/nsh-bindings
javac --release 17 -d /tmp/nsh-bindings \
  src/com/yee94/yuri/nsh/NativeComposerSpellcheckLease.java \
  src/com/yee94/yuri/nsh/NativeInputMetadataBinding.java \
  tests/native-input-bindings/Main.java
java -cp /tmp/nsh-bindings Main

# notifications / passkeys (platform-free policy classes only)
files=$(ls src/com/yee94/yuri/nsh/Notification*.java src/com/yee94/yuri/nsh/Passkey*.java src/com/yee94/yuri/nsh/HostLease.java \
  | grep -v -E '/(NotificationBridge|NotificationLaunch|NotificationSystem|PasskeyBridge)\.java$')
rm -rf /tmp/nsh-policy && mkdir -p /tmp/nsh-policy
javac -d /tmp/nsh-policy $files tests/notification-policy/Main.java && java -cp /tmp/nsh-policy Main
javac -d /tmp/nsh-policy $files tests/passkey-policy/Main.java && java -cp /tmp/nsh-policy Main

# terminal / remote desktop / voice recognition（见各自 run.sh）
sh packages/nsh/android/tests/realtime-io/run.sh

# resources / GUI preview（编译期 NSH 存根 + android.jar；见 tests/resources-preview/README.md）
sh packages/nsh/android/tests/resources-preview/run.sh
```

| 测试 | 覆盖 |
| --- | --- |
| `tests/attachment-receipt` | assistant/uploadId 校验、percent-encoding、SHA-256、prepare→PUT→GET→ACK→DELETE、retiring fence、journal 64 上限/CAS/损坏存储 |
| `tests/native-input-bindings` | spellcheck 只在非 composition 时启用、retire 恢复、替换与 stale generation；AX binding 写入/让权/回滚/替换/单行拒绝 |
| `tests/notification-policy` | 通知 admission、receipt/TTL、CAS 与 retirement |
| `tests/passkey-policy` | passkey policy、会话隔离与单次尝试证明 |
| `tests/realtime-io` | 终端协议/渲染、远程桌面几何、语音识别的纯逻辑 |
| `tests/resources-preview` | 资源路由/MIME/上限、GUI 资产与响应白名单、导出策略 |
| `tests/resources-preview` | `Resource*`/`GuiPlugin*`/`YuriViewExport*` 媒体类型、scope 路由与 loopback/proxy admission、响应/MIME/大小校验、JSON、GUI header 白名单、有界 buffer/Relay 背压与尾段、contact attachment 描述符/generation/digest、preview 与 export 请求边界、设备策略（`sh tests/resources-preview/run.sh`，153 项） |

整包编译（`nsh.aar` 未生成时以 `android.jar` + 本地 `com.longbridge.nsh` API 存根验证）：

```sh
javac --release 17 -cp "$ANDROID_HOME/platforms/android-35/android.jar" -d /tmp/nsh-out $(find src -name '*.java')
```

`nsh.aar` 就绪后，把 `classes.jar` 加入 `-cp` 做最终联编；`android:build` 本身即执行该联编。

## 未在真机/模拟器验证

- `aapt2/d8/zipalign/apksigner` 全链路：本机尚无 `embed/android/nsh.aar`，构建脚本未端到端运行。
- `com.longbridge.nsh` 真实 API 签名：按 `~/Code/github/nsh/crates/nsh-platform-android/java`
  与文档写成，联编时仍需以 AAR 为准。
- 附件 PUT/DELETE 与 Host receipt 协议的真实网络行为；依赖 `RuntimeBridge` 实现 `AttachmentRuntime`。
- 字体、AX 标签、`CalendarView` 语言/周起始、启动页/图标在真实设备上的渲染。
- 相机扫码、语音、通知、终端、远程桌面、GUI 插件等其它 Agent 的能力。
