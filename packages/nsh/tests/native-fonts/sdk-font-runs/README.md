# 实际 Text CTRun 诊断端口

公开 NSH 0.4 Swift interface 只有 trace timing，没有 CTFont/CTRun 读回。`docs/dev/text.md` 的 `onTextLayout` 只报告 range/box/ascender 等几何，不能证明实际采用的字体。iOS `text_view.rs::draw_rect` 持有 `CoreTextLayout.lines`，逐个 `CTLine.draw`；本端口只在该绘制循环结束后读同一批 `CTRun` 的 `kCTFontAttributeName`。

## 最小可合补丁

`scripts/build-font-run-sdk.mjs` 只在专用 source 副本生成这些改动：

1. `Cargo.toml`：默认关闭的 `font-diagnostics = ["embed"]` feature。
2. `src/lib.rs`：只在该 feature 下挂新模块。
3. 新 `src/font_diagnostics.rs`：精确 root + 中性 testID allowlist、最多四 root/每 root 24 ID/每 Text 128 run 的有界捕获；不保存文本、glyph 内容、URL或用户数据。request/stop/read 是显式 test API。
4. `src/text_view.rs`：feature-gated layout generation 计数器、set_layout 后计数、真实 drawRect 的 CTLine 绘制完成后读取 run。布局几何、renderer、选区与 Input 均不改。
5. `src/text.rs`：feature 下对命名 family 先读取全部真实 face 的 OS/2 `usWeightClass`，再按 CSS Fonts Level 4 的 400/500 分界选择最近 face。CoreText 的原生 weight trait 会把 Atkinson 的 500 选成 Bold；此匹配只在真实 face 中选择，不合成字重。找不到 OS/2 或 family 时保留原 CoreText fallback。
6. `src/embed.rs` / `include/nsh.h`：test SDK 的 begin/read/stop C ABI，App destroy 时清理 scope。
7. `swift/NativeShell.swift`：`#if NSH_TEXT_FONT_DIAGNOSTICS` 下公开 `beginTextFontDiagnostics(testIDs:generation:)`、`textFontDiagnostics(generation:)`、`stopTextFontDiagnostics()`。

输出 `font-runs-sdk.patch` 是可直接评审/合并的 unified diff；不包含 SourceSelection、Input hitSlop 或其他 port 改动。若 main 的合并 SDK 已修改 text_view.rs，按两个局部 hook 合入，不覆盖整个文件。默认 release SDK 没有该 feature/Swift define，诊断代码不进入常规渲染路径。

`begin` 要求 generation 递增，清空本代记录，并通过公开 UIView testID 请求这些精确视图的正常 `setNeedsDisplay`。没有直接调用 draw、私有 runtime-class/layer 查询、overlay 或替代 UILabel。`read` 不触发布局/绘制，只返回真实 draw hook 产生的记录；过时代返回固定 error，缺少实际绘制的 ID 保留在 missing，不能当通过。Root 由 weak UIView 所有并在销毁/stop 时清理。

## 隔离构建

提供现有源、发行包和已装工具链，绝不下载或安装：

```sh
NSH_FONT_SDK_SOURCE=/existing/unmodified/nsh-source \
NSH_FONT_ORIGINAL_DIST=/existing/nsh-distribution \
NSH_FONT_SDK_WORKDIR=/new/task-only/font-sdk \
NSH_FONT_CARGO_HOME=/existing/offline/cargo-home \
NSH_FONT_RUSTUP_HOME=/existing/offline/rustup-home \
  node packages/nsh/scripts/build-font-run-sdk.mjs
```

多工具链环境额外指定 `NSH_FONT_RUST_TOOLCHAIN` 为该 rustup-home 中已存在的完整目录名。Cargo 始终 `--offline --locked`，只构建已装的 simulator target；输出是独立 `dist/embed/ios/NativeShell.xcframework` 的 simulator slice，原始 source/dist 不写入。`--prepare-only` 仅生成副本与 patch，`--resume` 仅用于本任务工作目录的后续编译。

本轮成功构建使用已有 Rust 1.99.1，root 编译参数为 `opt-level=1,lto=thin,codegen-units=8`，Rust 编译耗时 5m49s。thin LTO 将 LLVM 23 的缓存依赖处理成机器码，避开 Apple LLVM 21 无法读取这些 bitcode 的链接错误；这是诊断构建，不提供发布性能结论。

```sh
NSH_BIN=/existing/nsh/bin/nsh \
NSH_DIST=/task-only/font-sdk/dist \
NSH_FONT_RUN_DIAGNOSTICS=1 \
NSH_FONT_FIXTURE_DIRECTORY=/existing/verified-web-woff2 \
  node packages/nsh/scripts/build-native-fonts-uikit.mjs
```

Carrier 是八组字体 fixture 的诊断变体。所有新字体仍只读已校验离线 byte fixture，不访问真实 CDN/Host/Relay。真实 NSH Text 使用 root UI inheritance 与 font-mono token，样本为 `HAMBURGEFONTSIV 012345`。UI 16pt、mono 13pt，三种字重分别 400/500/600。期望 PSName 来自该组选定的生产 registry face；Atkinson 只有 400/700，按 Web CSS 匹配 500→400、600→700，不伪造缺失 face。

main 独占设备运行，每组的 `font-audit-N.json.actualTextRuns` 必须包含六个 ID 的真实 runs、正确 capture/layout/display generation，以及实际 PSName/fontVersion/pointSize。fontVersion 必须与离线源 face 的 CTFont version 相同，避免 JetBrains 2.304 与 2.211 同 PSName 被误判一致。`textCTRunReadback=true` 仅在这些真实记录全部匹配时产生；missing、旧代、版本/字重/字号不匹配均使 valid=false。截图/图像指标只作视觉佐证，不替代 run 数据。若 actual face 与期望不同，应保留失败记录并修实际匹配链，不能改成 fallback 通过。

## Atkinson 500 修复

`21769d66` 的 pair2 真实 CTRun 保留在 `.scratch/nsh/fonts-21769d66-uikit/font-audit-2.json`：Atkinson regular 为 Regular、semibold 为 Bold，但 medium 实际为 Bold，expected 仍是 Regular。真实 CoreText 探测显示 Regular trait 为 0、Bold trait 为 0.40；请求 UIFont medium trait 0.23 时，CoreText 选择 Bold。CSS Fonts Level 4 对只有 400/700 的 family 要求 500 选择 400、600 选择 700。

修复读取每个真实 face 的 OS/2 `usWeightClass`，按该标准在已注册 face 中选择，不新增、合成或改写 Atkinson face。三档字体的 400/500/600 仍精确命中。旧 `21769d66` app、源码和失败 audit 保留；新 SDK 与 carrier 独立构建。

## 本轮交付

Carrier 为 `packages/nsh/.nsh/native-fonts/2026-11-08T02-01-10-249Z-21769d66/NativeFontsFixture.app`，bundle ID `example.nsh.native-fonts.run-21769d66`。同目录 `fixture-build.json` 冻结源码及 47 face 的 SHA；`sdk-handoff/` 冻结可合并补丁、SDK manifest 与 `preservation.json`。App 已完成 typecheck、bundle、链接、签名，未安装、未运行，尚无真实 CTRun 记录。

验证已完成：此前字体聚焦 12 文件 102 项回归、版本增强后的独立 Swift evidence validator 测试、完整 NSH tsc、两个构建脚本语法检查、隔离 SDK 及 carrier 构建。新增模块后的 dead-code 已完成，仍报告仓库现有 unused/duplicate exports 与 NSH entry 配置提示；没有据此删除其他模块文件。

`21769d66` 的 registry/owner SHA 与 P2 包 `bba6824b` 相同；相对旧 `84528a1e` 的修复对照见 [P2-VALIDATION.md](../P2-VALIDATION.md)。三个 artifact 独立保留，原 `.scratch/nsh/fonts-84528a1e-uikit` 设备证据仍只归旧包。

保全检查核验两棵原始源码树各 2272 文件、隔离 SDK 仅六处既有文件加一个诊断模块、Cargo.lock 未变、carrier 冻结源码 136 文件、两个旧包 executable SHA，以及原发行 SDK public interface 与旧 manifest 一致。已有 toolchain 构建的 framework baseline 与发行 SDK 是不同产物，不能用它证明发行 SDK 完整二进制未变；本轮没有该发行包的完整事前 hash baseline。具体核验边界记录于 `preservation.json`。

main 运行新 carrier 时沿用八组及回环流程，每组保存原始 audit；六个 Text 全部匹配后才进入下一组。八组累计读取应为 6/12/17/23/29/35/41/47，回到 pair0 后仍为 47。失败时保留该组 actualTextRuns/expected/missing；当前 carrier 的按钮会阻止未 verified 的组继续。设备安装和运行由 main 执行。

## 系统控件与 WK 的具体合同

- Web `YuriVisualSettings.tsx:1175` 的 UI 字体选择限定 `!isMobile`；手机仍消费 Host 已保存 UI 字体，不增加新的设置设计。
- 现有 Web/Capacitor 原生 Tab 合同 `native-ios-tab-bar.ts:30` 只传 tabs、selection、appearance、ariaLabel、accentColor，没有 font 字段；NSH iOS `system_tab_bar.rs` 同样用 UIKit 系统 Tab。NSH `navigation.rs::bar_appearance` 仅设置系统 title 颜色，`system.rs::show_dialog` 创建 UIAlertController/ActionSheet 并配置系统 appearance/tint，没有私有字体覆盖。结合仓库明确的系统 Nav/Tab/Alert 设计，这些 chrome 保持系统字体；不能为了 UI 字体偏好遍历 UILabel 或扩大本诊断端口去强改它们。Web HTML fallback 的 CSS 字体与原生系统 chrome 是明确的 runtime 差异。
- WK GUI/Terminal 是 Web 字体环境，不能借 CoreText process 注册证明已经生效。GUI 的当前构建器 `build-gui-plugin-preview.mjs:35–52` 使用 font-sans/font-mono，并只定义 bundled JetBrains 2.304 的 @font-face；`gui-plugin-browser/factory` 没有调用 Web fontLoader。Terminal `NativeTerminalPreview.swift` 只写 `terminal.options.fontFamily`，当前生产源码仍无 NativeTerminalPage 调用点，不能将尚未装配的 Terminal 计为手机已有字体消费者。GUI 内容 surface 的自定义字体有实际适用合同，不能当成系统 chrome 默认字体豁免。
- WK 后续接入应复用本 registry 的固定源/验证字节，为当前 presentation 的 source-family 别名/weight 建立 document.fonts 的 FontFace，scope/retirement 仍归原 GUI/Terminal owner；未知 theme family 不构造 URL、不能放开 WebKit CDN 或借用 Relay/Host file API。由相应 owner 用 selected byte identity + 当前 presentation ticket 接入，验证 document.fonts 实际 face/Canvas text、晚完成与 source switch。当前任务优先交付本 CTRun carrier，不修改冻结的 ResourceHTML/RuntimeBridge/WK owner。
