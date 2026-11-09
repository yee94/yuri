# Yuri Native (NSH)

独立的 NSH 原生客户端，优先 iOS。参考 Noop 的 TSX + signals + 原生运行时组织方式，完整对齐当前 Yuri 手机端的项目、助理、计划、设置及其二级页面与弹层；优先级不缩减验收范围。

页面由 NSH 的 UIKit 后端渲染。没有 React、Capacitor 页面或承载主界面的 WebView。iOS 26 的系统 `TabBar` 使用 Liquid Glass，输入区域使用 `glassEffect: regular`；旧系统由 NSH 回退原生材质。应用标识为 `com.yee94.yuri.nsh`，与现有客户端并存。

实验性桌面分支使用 NSH 0.4.0 的 AppKit / Win32 后端、三栏工作区与原生菜单，保留 iOS 分支。桌面目标是逐项对齐 Web 桌面，不是手机布局放大；当前没有完成 Mac/Windows 功能与视觉签收。实现和未验范围见 [DESKTOP-PARITY.md](./DESKTOP-PARITY.md)。

## 工具链与构建

iOS framework 构建需要 macOS、Xcode 26+、NSH **0.4.0** 的 macOS arm64 distribution；保留 `bin` 与 `embed/ios/NativeShell.xcframework` 的相对结构。无需安装 NPM 运行时依赖。项目统一 check/bundle 与桌面入口另需 Rust 工具链、已缓存依赖和审计过的源码，以构建同补丁的 CLI/runtime；不会自动获取缺失依赖。

```sh
# nsh 在 PATH 中，或者显式指定可执行文件。
export NSH_BIN="/path/to/nsh/bin/nsh"
export NSH_SOURCE_DIR="/path/to/audited/nsh"
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

### 桌面开发构建

```sh
# 在目标 OS 上运行，需要已缓存的 Rust 依赖、对应原生 SDK 和审计过的源码。
export NSH_SOURCE_DIR=/path/to/audited/nsh
bun run --cwd packages/nsh desktop:build:debug
bun run --cwd packages/nsh desktop:check
bun run --cwd packages/nsh desktop:test
```

macOS 输出 `.nsh/desktop/YuriNative.app`，Windows 输出 `.nsh/desktop/YuriNative-windows/`。凭据由独立 Rust Host 使用系统 Keychain / Credential Manager 保存，不写 NSH 明文 Storage。构建脚本不启动应用、不读取现有用户连接、不执行发布；具体安全、平台限制及合成测试边界见 [desktop-host/README.md](./desktop-host/README.md)。

桌面构建及 `scripts/nsh.mjs` 的 check/bundle 入口统一消费 [版本锚定兼容补丁](./patches/nsh-0.4.0/README.md)，自行构建并校验同源 CLI/runtime，不以旧 `NSH_BIN` 或版本字符串作为补丁生效证明。iOS 原生 framework 构建仍使用原发行包流程。

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
