# Yuri Native (NSH)

独立的 NSH 原生客户端，优先 iOS。参考 Noop 的 TSX + signals + 原生运行时组织方式，完整对齐当前 Yuri 手机端的项目、助理、计划、设置及其二级页面与弹层；优先级不缩减验收范围。

页面由 NSH 的 UIKit 后端渲染。没有 React、Capacitor 页面或承载主界面的 WebView。iOS 26 的系统 `TabBar` 使用 Liquid Glass，输入区域使用 `glassEffect: regular`；旧系统由 NSH 回退原生材质。应用标识为 `com.yee94.yuri.nsh`，与现有客户端并存。

## 工具链与构建

需要 macOS、Xcode 26+、NSH **0.4.0** 的 macOS arm64 distribution。使用官方预编译包，保留 `bin` 与 `embed/ios/NativeShell.xcframework` 的相对结构。无需安装 NPM 运行时依赖，也无需为 TSX 编译安装 Rust。

```sh
# nsh 在 PATH 中，或者显式指定可执行文件。
export NSH_BIN="/path/to/nsh/bin/nsh"
# 自定义 distribution 布局时指定，否则从 NSH_BIN 推导。
export NSH_DIST="/path/to/nsh"

bun run --cwd packages/nsh nsh:check
bun run --cwd packages/nsh nsh:bundle
bun run --cwd packages/nsh ios:build
```

模拟器产物：`packages/nsh/.nsh/out/YuriNative.app`。

```sh
xcrun simctl install booted packages/nsh/.nsh/out/YuriNative.app
xcrun simctl launch booted com.yee94.yuri.nsh
```

设备架构构建使用 `ios:build:device`。未提供开发签名配置时产物为 unsigned；`NSH_SIGN_IDENTITY` 和 `NSH_PROVISIONING_PROFILE` 指定开发证书与匹配的 development profile。构建脚本校验 application identifier、开发设备和到期时间，不自动发布或上传 TestFlight。

## Android

Android Host 与 iOS 共用同一份 TSX 与 `nsh.json`，由 `com.longbridge.nsh.NshView` 渲染，
无需 Gradle/Kotlin：

```sh
export NSH_BIN="/path/to/nsh/bin/nsh"
export NSH_DIST="/path/to/nsh"        # 含 embed/android/nsh.aar
export ANDROID_HOME="$HOME/Library/Android/sdk"

bun run --cwd packages/nsh android:build
```

产物 `packages/nsh/.nsh/out/YuriNative.apk`（debug keystore 自动生成）。SDK 要求
`platforms/android-35` 与 build-tools；minSdk 28、targetSdk 35。宿主调用、unsupported
清单、JVM 测试与未验证边界见 [`android/README.md`](./android/README.md)。

## 验证

```sh
# 从仓库根运行；NSH_BIN 用于原生引擎交互测试。
bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts
# macOS 原生网络桥接与 Relay 集成验证。
bun run --cwd packages/nsh test:native
# 已启动模拟器上的 UIKit 历史采用/阅读锚点回归（默认测试不启动模拟器）。
NSH_HISTORY_IOS=1 bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/history-layout.test.ts
```

Vitest 负责协议、状态与 UI smoke 测试。UI smoke 通过 NSH CLI 驱动真实 headless 引擎，测试 Host 来自 `tests/host.js`，仅由测试的 `--web-host` 参数加载，不在发布配置中启用。它验证原生视图、输入与请求边界，不能代替 UIKit 模拟器、物理键盘、相机、Keychain 或真实 Host 联调。

代码边界、协议来源和验收范围见 [DOCUMENTATION.md](./DOCUMENTATION.md)。

Chat 当前按同一真实会话逐区还原，不能用协议测试或成功构建代替视觉、键盘和手势验收。最新证据与已知差异见 [CHAT-VALIDATION.md](./CHAT-VALIDATION.md)；最初的全量源码审计保留在 [PARITY.md](./PARITY.md)。

消息分组与 Activity 现直接消费 Web 的纯 turn projection，模型 header 的身份与目录格式化、连续 Skill 和 Thought 折叠规则也共用纯逻辑。`NSH_PARITY_IOS=1` 可运行生产组件的 UIKit 整理/分段/pending-header 专项；这仍不等于动画及真实会话逐帧验收完成。
