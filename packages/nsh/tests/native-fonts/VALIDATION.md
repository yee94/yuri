# 固定目录字体实现交接（2026-11-08）

## 当前交付与冻结

- 独立应用：`packages/nsh/.nsh/native-fonts/2026-11-08T00-46-52-763Z-84528a1e/NativeFontsFixture.app`
- bundle ID：`example.nsh.native-fonts.run-84528a1e`
- 冻结清单：同目录 `fixture-build.json`，含生产 TS graph、四个 Swift 字体/外观模块、fixture、builder 的 SHA，原始 SDK public interface SHA，全部 47 个字体 fixture SHA 与可执行文件 SHA。使用原始发行 SDK，没有修改 distribution、SourceSelection 或 Input hit slop。
- builder 已完成 TS graph 检查、原始 iOS SDK typecheck、NSH release bundle、Swift 链接、ad-hoc 签名及 verify。`appBuilt=true`，`installed=false`、`launched=false`、`uiKitValidated=false`。没有安装、启动或访问设备。
- 正式装配不需要修改 main.swift：既有 AppearanceBridge init 在内部安装 NativeFontOwner；`build-ios.mjs` 既有 Swift 文件发现包含三个新模块。唯一新增 capability 是 `appearance.fonts.retry`，已加入正式 nsh.json。
- manifest 是本次构建的不可变输入快照，不声称整个并行工作树之后保持不变。此前核对发现共享 state.ts 与十语言字典已有后续差异，未覆盖这些差异。以 manifest 的冻结源码评审该包；字体 owner/bridge/projection 的当前源码需与其各自 SHA 核对。本验证说明与后续测试数量更正不修改既有 app 或 manifest。

## 已运行

- 完整 NSH `tsc --noEmit -p packages/nsh/tsconfig.json` 通过。
- 12 个聚焦文件、100 项通过：native-fonts、native-font-projection、appearance-font-feedback、appearance、appearance-core、appearance-native、appearance-fonts、appearance-code-consumers、appearance-settings-host、native-editor-style、device-appearance-core、transcript-body-markdown。
- native-fonts 使用本轮读取的真实公开 Fontsource 固定响应（本机任务临时目录，未加入仓库）：全部 16 字体、47 face 经生产 NativeFontRegistry 在 macOS CoreText 注册，并按实际 family/PSName 读回；并发相同源只有一次读取。包含同 PSName 的外部预注册拒绝、注册完成后被外部同名字体替换时 source cache 失效、后续 face collision 的已注册 face 回滚、malformed 第二 face 不改 prior、bundled JetBrains 2.304→Web 2.211 的受控 process 替换（仍持有旧 CTFont 对象）。
- owner deferred 回归覆盖 default system 零读取、200 级 no-op/重复事件、未知 ID/family、UI/mono 独立成功/失败、保 prior、显式重试、Host/同 Host revision 退休、旧完成只可进入固定源 cache，不能更新新投影。三并发源实测最多两 reader，连续失败不会耗尽 budget。
- JS 根回归覆盖 font completion 不发 GET、不重放 appearance.apply、不变更 palette 引用；旧 Host/generation/revision/ticket 拒绝；retry ready 事件早于新 ticket 响应时仍正确采用。真实反馈 JSX 通过 VM 执行验证十语言键的使用、原始名字/错误 URL 不渲染、重试防重与 GET error 优先级。
- `bun run dead-code` 执行完成，non-blocking。报告包含既有大量 unused 项及 NSH entry 覆盖提示；新 native-font projection/retry 没有未消费报告，未据此删除其它 owner 文件。
- 一次扩大列表误选 appearance-settings.test.ts 的两项 headless 场景：PATH 中无 nsh，spawn ENOENT，未启动引擎。未修改该文件，未把两项计为通过；最终上述 100 项仅含本轮允许的无设备回归。没有跑主应用设备场景、真实 Host/Relay 或模型调用。

## main / oracle 必须继续签收的边界

1. 按 README 安装独立包，依次运行八组，并读取 `font-audit-0.json` 至 `font-audit-7.json`。`valid=true` 才证明该组真正由 unavailable→生产注册→实际 UIKit UILabel、NSH UI/mono Input 与 Skills editor UIFont 应用。最后累计 47 reader 次数，循环后不增加。当前 worker 没有这些运行证据。
2. UILabel 是 fixture 原生 probe；NSH Text 为 CoreText 自绘，不能将 probe 冒充 NSH Text 的 CTRun 读回。全字号/粗体/各 face、真实 TextView/Diff、选区、IME、阅读位置及视觉对帧仍需运行验收。已核对公开 font-sans/font-mono token 和本机 SDK core Text/Input relayout 路径，没有新增私有 introspection。
3. Native 字体下载为同 Web 的独立公开 CDN 路径，不是 Host 资源，也不走 Relay。公开资源本轮经 curl 读取并按 x-jsd-version/SHA 固定；生产 URLSession reader 的真实 CDN/iOS 网络路径没有联调，fixture 只替换该 byte reader。没有测试实际 Relay Host 上的设置重连。
4. Web loader 当前 URL 浮动 latest；本实现锁定本轮相同版本/字节（Source Sans 3/Source Code Pro 5.3.1，其余 5.3.0）。以后 latest 改变时必须显式升级 manifest，不能声称无期限与浮动 URL 相同。
5. NSH engine 的 root font inheritance 不等于 UIKit 系统 chrome 全部继承。当前 SDK `navigation.rs::bar_appearance` 只设置 title 颜色，系统 Nav/Tab/Alert 字体没有本轮 UIFont 应用证明；若手机 Web 1:1 要求它们也改字体，需要 main 的 native-chrome owner 明确合同并通过正式 SDK/平台入口接入，不能遍历所有 UILabel 强制覆盖。本轮没有改 SDK。
6. WK 是独立字体环境。GUI 当前 CSS 投影只提供 Web font stack，Terminal 目前只接收 fontFamily 字符串；本轮 CoreText process 注册不能证明 WK 已加载 FontFace。若这两类 surface 需要相同自定义字体，应由各自 owner 复用本固定目录/身份添加明确 Web FontFace 字节/URL通道并单独验收，保持 ResourceHTML/RuntimeBridge 冻结；没有修改这些模块或将其计为完成。
7. 当前 Web `YuriVisualSettings.tsx:1175` 的 UI 字体选择明确受 `!isMobile` 限制，mono 选择则在手机可达。因此 Native Prefs 没有 uiFont 选择入口**不能作为手机 1:1 缺项**，不应自行增加。UI 字体仍由既有 canonical Host 设置（例如 Web 桌面设置页）选择，再由原 appearance 根同步应用。本轮未改 settings-preferences*，也没有新增字体设置设计。

这些边界不缩减全量 1:1 的验收范围；本交付完成的是固定目录的原生下载/身份注册/全局 engine 字体投影，不能据此宣布整个 NSH 外观 1:1 已验收。
