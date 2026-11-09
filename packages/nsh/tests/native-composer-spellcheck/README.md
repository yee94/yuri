# Composer fixed spellcheck consumer

独立、默认关闭的 UIKit 只读诊断载体及 main 获取真实 trait/marked-text 读回的方法见 [PROBE.md](./PROBE.md)。该诊断不修改本 consumer 或冻结 AX owner；实际设备读回仍由 main 执行，不能以 SDK 编译替代。

这个独立 consumer 只给 Chat/新会话原 multiline `UITextView` 配置 `spellCheckingType = .yes`。没有移动端设置，也不读取 Host 的 spellcheck 偏好；不以 autocorrect 代替。Web 现有 `ChatInput`、`CommitInput` 已使用 `isMobile || inputSpellcheckEnabled`，设置页已用 `!isMobile` 隐藏开关，本任务保留这些实现。

## 生命周期与边界

`native-composer-spellcheck.tsx` 和原 Input 在同一个既有玻璃 wrapper 内同挂载/卸载。helper 仅传完整 `{ownerID,inputID}` snapshot，没有 active/Host/window props。TS cleanup 通过原 registration ref 调用 `retire`；Swift deinit 也走同一永久移除路径。consumer 可以单独卸载而 editor 仍挂载，不等待其离窗。

`NativeComposerSpellcheckLease.swift` 独立拥有固定 trait 状态、composer generation 和 paired-local resolver；`NativeComposerSpellcheck.swift` 独立拥有 UIKit registration、pending 观察和 editor-associated restoration。没有修改或复用 AX 的 active=false/离窗恢复语义，也没有修改 density、style、Input ref、Glass 或输入回调。

本机 NSH Source e626a8d 的 `crates/nsh-platform-ios/src/mount.rs:1055` 中 `MountItem::Remove` 只把 native view 从 superview 移除；`:1069` 的 `Delete` 才取走并销毁 slot。因此离窗、隐藏、后台、Host 变化及暂时无法 resolve **不退役同一个 editor 的 trait lease**。首次绑定/替换仅采用完整公开 paired-local resolve：registration → component host → 精确两级 wrapper，wrapper ID 必须匹配；直接 sibling 中 inputID 容器恰好一个，其直接公开 UITextView/UITextField 合计恰好一个且必须是 multiline UITextView；对象 parent 与同一非空 window 均核验。Source 的 Input::attach / ComponentHost::attach 依据与 AX 合同相同，但 resolver 和租约状态独立。

第一次安全 full resolve 且 `markedTextRange == nil` 时保存原 trait 并写 `.yes`；原来已经是 `.yes` 时不冒领写入/恢复所有权。已 settled 的 lease 永不重复 setter，layout/props/通知也不重抢外部晚写。

IME 中只 pending，不写 trait。仅 pending enable 或 retired restore 时监听 begin/end/change 三种 UITextView 通知；先匹配弱 editor 对象身份，再合并一次 main queue 执行。active pending 回调核验捕获的 composer generation、当前 lease、完整 resolve 与 marked text；旧 editor 的通知不能采用或写入 replacement。NotificationCenter 的 sender filter 使用 nil，避免 filter 保留 editor；回调在任何排队/业务操作前即作 exact object identity 过滤，不搜索 view/window，不读取文本。

永久移除、无效 snapshot 或观察到新的 editor 对象时退役旧 lease：未写入的取消 pending；已写入的仅在 current 仍为 `.yes` 且 marked=nil 时恢复原值。若仍有 marked text，由**旧 editor 自己的 associated object** 保留 restoration ticket。ticket/core lease/通知 closure 均只弱引用 editor，只有 editor 保留 ticket；通知安全后只做条件恢复并移除 association/observer。它不持有 owner、registration、Host 或 replacement resolver，永远不能重新写 `.yes`。editor 销毁自然结束 ticket，不轮询、不计时。另一个 consumer 不得在该 editor 有 pending restoration 时写入，防止重叠 trait writer。

**ABA/唯一 writer 边界：**本 consumer 是同一 composer editor 的唯一应用 trait writer。current 值不同则让权、不恢复；其它代码写回相同 `.yes`（包括 `.yes → other → .yes` 而中间未被观察）的来源无法靠 current 比较区分。没有 KVO、swizzle 或保证检测同值 ABA 的声明。NSH 现有 `input.rs` 只配置 autocorrection，本 consumer 不改变该行为。

没有 `reloadInputViews`、resign/becomeFirstResponder、delegate replacement、text/selection/undo/IME 写入或 style/geometry 改动。也不保证无 registration/config 回调的 silent editor replacement 能立即被发现；下一次公开完整 resolve 才会采用新 editor、退役旧对象。

## 安装清单

| 目标 | 安装/编译 |
| --- | --- |
| `ios/main.swift` | 已在 loadBundle 前调用 `NativeComposerSpellcheck.install(on: surface)`；生产 build 自动发现新的 `ios/*.swift` |
| `tests/history-production-uikit/main.swift` | 已调用同一 install |
| `tests/history-production-uikit/build.mjs` | 仅给原 `swiftSources` 追加 `ios/NativeComposerSpellcheckLease.swift`、`ios/NativeComposerSpellcheck.swift`，保留原 v3/AX/Host/Observer inputs 和其余构建逻辑 |
| 其它加载真实 Chat/新会话的 UIKit harness | 需要同一 install 和上述两个 Swift inputs；TS helper 不会自动注册 Swift factory |

`UIKitSDKProbe.swift` 只用于真实 UIKit/NativeShell SDK 对象编译，不执行 App。

## 验证与未验范围

```sh
NSH_DIST=/existing/nsh/distribution bunx --offline vitest run --config packages/nsh/vitest.config.ts --testTimeout=120000 packages/nsh/native-composer-spellcheck.test.ts packages/nsh/native-input-metadata.test.ts
bunx --offline tsc --noEmit -p packages/nsh/tsconfig.json
bun run dead-code
```

生产 Swift core 的纯状态检查覆盖完整 config、固定首次写入/无重复 setter、原 trait 已 yes、隐藏/后台/Host/离窗保留、IME pending/取消、IME 退役后仅恢复、外部晚写让权、旧 generation/旧 editor 通知不写 replacement、弱释放、单独卸载、invalid snapshot/deinit 和 resolver 的缺失/重复 ID、wrong kind、双 editor、wrong window/ancestry、Sheet 邻居。真实 SDK object 编译同时纳入冻结 AX 两文件，验证能独立共存。

**配置证据不等于效果验收。**没有运行 engine、设备、Host 或完整 UIKit fixture build。真实错拼标记、不同语言/系统键盘、中文 IME 和退役中恢复、selection/undo/焦点与 Glass 几何均由主会话验收；setter/readback 不能签收这些行为。

2026-11-08 验证记录：新 consumer 4/4 与冻结 AX 3/3 聚焦 Vitest 通过（新 16 组 Swift 状态检查及真实 SDK whole-module object 编译）；NSH `tsc --noEmit`、fixture build 脚本 `node --check` 通过。另独立运行原 `observer.test.ts` 的 SDK-only 用例，1 passed / 4 因 `-t` 未选中，包含**全部当前 swiftSources（含两个新输入）的真实 SDK typecheck**以及原 Observer/probe 对象编译，未执行 App/Host。dead-code 报告已查看（130 unused files、798 unused exports、6 组 duplicates），未命中新 `native-composer-spellcheck` 模块。首次并行 tsc/Swift 检查时冻结 AX 的原 5 秒测试期限触发超时；未改冻结测试，使用命令行 `--testTimeout=120000` 后通过。
