# Composer AX metadata owner

本任务只负责原编辑器的 `accessibilityIdentifier` / `accessibilityLabel`。不写 spellcheck、autocorrect、text、delegate、selection、focus、IME、布局或 Glass。**拼写检查仍未完成；setter/readback 和 SDK 编译均不是 VoiceOver 验收。**

## 固定 multiline paired-local 合同

registration → nativeComponent host → 现有 TS wrapper，严格两级。wrapper 的 `accessibilityIdentifier` 必须等于 `ownerID`；只检查 wrapper 直接 siblings 中 ID 等于 `inputID` 的容器，必须恰好一个。该容器的直接公开 UITextView/UITextField 合计恰好一个，且为固定 multiline UITextView。每次 apply 字段前重新解析全部关系、父对象身份及同一非空 window。任何失败统一 retire。无需全树、window、私有类、坐标、tag、timer 或文本通知查找。

本机 NSH 0.4 Source（e626a8d）证据：`crates/nsh-platform-ios/src/input.rs:730` 的 `Input::view` 返回 container；`Input::attach` 在 `:780` 把 `editor_view()` 直接 `container.addSubview(view)`，placeholder 属于 UITextView 自身。`component.rs:235` 的 `ComponentHost::attach` 把 registration 的 `component.view()` 直接放入组件 container。`mount.rs:1045` 将原生 child view 直接加到 parent，`:3672` 将 testID 写到该 node view 的 accessibilityIdentifier。业务原有 wrapper 的直接 Input 与 registration host 因而是 siblings。只复用这个固定结构，不将其扩大成任意后代 resolver。

唯一 prop 是完整 `{ownerID,inputID,expectedKind,editorAXID,label,active}` snapshot；缺失/多余字段、错误类型和非 multiline 均无效。nil 和空字符串的字段原值保持区分；每字段分别保存 original/lastWritten/owns。检测到应用晚写立即放弃该字段，在同一编辑器的 props、失活/恢复、无效快照后均不抢回；另一字段继续独立更新。retire/deinit 只对捕获的旧编辑器恢复仍为 ours 且 current==lastWritten 的字段，不解析或写入新 replacement。恢复是对历史所有权的回滚，不能因 parent/window 已移除而跳过释放。

local wrapper/container ID 可在 retained pages 中重复；只在当前 registration 的 wrapper 内解析。编辑器 AX ID 与容器 ID 分离，由 TS module counter 在每个 helper mount 产生一次；页面实例并存仍不同，普通响应更新不重新生成。原 Input testID/ref 保持不变，原 Input 也显式接收现有本地化 label。active 由现有 page/lifecycle authority 提供，Swift 同时在应用失活时回滚。

props、registration window/parent/layout 回调同步 reconcile，允许合并一次 main-queue mount-order retry；新 props/lifecycle/关系事件使旧 ticket 失效。无永久 replacement observer。**无回调的 silent editor replacement 不保证即时发现**；下次 registration layout/window/parent 或 config 事件才会重新解析、退役旧对象并接纳新对象。本阶段固定 multiline，不支持 hot swap kind。

## 安装清单与 seam

| 目标 | 注册 | 编译输入 |
| --- | --- | --- |
| 生产 `ios/main.swift` | 已加入 `NativeInputMetadataOwner.install(on: surface)`，在 loadBundle 前 | `scripts/build-ios.mjs` 自动发现 `ios/*.swift`，包含两个新文件 |
| 生产组件 UIKit fixture `tests/history-production-uikit/main.swift` | 已加入同一 install，在 loadBundle 前 | **主会话需给 `build.mjs` 的 swiftSources 添加 `ios/NativeInputMetadataBinding.swift` 和 `ios/NativeInputMetadataOwner.swift`**；本任务按授权不修改 build/Host/Observer |
| 其它调用生产 Chat/新会话的 UIKit fixture | 必须在对应 NshAppView loadBundle 前调用同一 install | 必须纳入上述两个 Swift 文件；TS helper 不会自动安装 Swift factory |

缺 install 时 public nativeComponent 只产生空视图，不能据此声称 AX 已接通。`UIKitSDKProbe.swift` 仅编译真实 install、UIView/UITextView/UITextField seam，不执行 UIKit，不证明运行时工厂生命周期或 VoiceOver 输出。

## 验证

```sh
NSH_DIST=/existing/nsh/distribution bunx --offline vitest run --config packages/nsh/vitest.config.ts packages/nsh/native-input-metadata.test.ts
bunx --offline tsc --noEmit -p packages/nsh/tsconfig.json
bun run dead-code
```

纯 Swift executable 直接执行生产 binding/resolver，覆盖完整/无效 snapshot、missing/duplicate IDs、wrong wrapper/kind、两 editor、错误 ancestry/window、nil/empty、逐字段晚写让权、失活/恢复、detach、replacement、两次字段写之间拓扑变更、合并/迟到 task、retained pages/Sheet 邻居和 deinit。相同状态 100 次 reconcile 不重复 setter。不运行 headless engine、设备或 Host。

主会话仍需在真实 UIKit 验证：空且未 focus、空且 focus、有文本 focus、blur、clear 后 blur；twoComposers/retained pages、Sheet 搜索邻居和中文 IME；原编辑器实例、选区/undo/回调与几何/Glass；VoiceOver 实际朗读和 active-page AX 唯一性。无上述设备证据不能标记运行时或无障碍验收完成。

2026-11-08 静态/纯状态验证记录：上述聚焦 Vitest 3/3 通过（12 组生产 Swift 状态检查、真实 SDK whole-module object 编译、两个 main 的安装 seam）；NSH `tsc --noEmit` 通过。`bun run dead-code` 已运行并查看，报告有 130 个 unused files、797 个 unused exports、6 组 duplicate exports，未命中新 metadata 模块；没有为清理报告改动无关文件。未运行 engine、UIKit App、设备或 Host，也未运行尚待主会话更新编译输入的完整生产 UIKit fixture build。
