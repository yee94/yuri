# Business request owner safety

业务页面、controller 和 root 的 Host 请求只能使用其构造时的 `captureHostRequest()` 结果。事件回调、确认弹窗后的 continuation 和重试复用该 sender，不读取新的 scope。旧 controller 的 epoch 不回填；Host 变化由 application 的现有 epoch remount / owner replacement 创建新对象。

## Ownership seams

- Projects 目录、Search、注册目录与删除 journal 各自捕获。Projects、Search、注册目录不再在 refresh/search/initialize 中回填 epoch。
- Bot 编辑器、助理列表/详情/渠道/配置集合、计划目录与历史、模型/Agent 控件、Chat header/context overview、workspace changes、transcript history/tool navigation、朗读 summary 和文件目录使用 captured sender。
- `createNewSessionCatalog` 和 `createTranscriptActions` 只接收调用方注入的 sender，不读取 app/runtime。transcript 行复用页面 history owner 的 sender。
- `createNewSessionAdmission` 构造时捕获 sender，经 `sendNewSessionHandoff` 的第四个参数传入。该 helper 在需要 ACK 后只读核验或 prompt 编译时，缺少 sender 明确失败；不从调用时的当前 Host 补取。稳定 inputID、snapshot、receipt、目录核验、ACK 后仅 GET 和保留后续草稿的协议不变。
- `NativeAppearanceSync` 在 scope 变化时 pause 旧 controller 并创建带 captured sender 的新 controller。`saveNativeAppearanceMode(mode, current, send)` 由设置页注入其已捕获的 sender，缺失时 fail closed；不得改为读取当前 root sender。

## Pure regression coverage

`business-request-owner.test.ts` 执行生产组件/controller 的实际函数体和 async 回调，只把最终 JSX 返回改为观察 seam，不启动 NSH engine、UIKit、设备、网络或 Host：

- workspace 确认等待期间 A→B 和 A→B→A，旧回调及保留的 stage 回调都被 immutable sender 拒绝；替换 owner 可使用新 generation；
- 新会话模型收藏 GET 等待期间 A→B→A，PUT 不借用返回后的 Host；
- Search 旧 controller 不能通过 search 回填 epoch，新 controller 可正常读取；
- context route 只在构造时捕获一次，并把同一 sender 交给只读 controller；
- 实际新会话 admission 与 handoff 在 draftReady 后进行 ACK 只读核验时仍使用旧 sender，失败不 complete、不 release source。

这些测试的 request admission boundary 是纯合成实现，证明的是生产 owner 接线和 continuation 行为，不是 Swift 的实际拒绝或设备零副作用证据。

## Integration gaps

- `settings-preferences.tsx` 的外观保存调用由 settings owner 接入第三个 captured sender 参数；本业务迁移不修改 settings 文件。
- 直接调用 `sendNewSessionHandoff` 的旧测试/fixture 调用方，也必须注入其 owner sender；不得以 unbound 写入或放宽 strict fixture 修复。
- `NativeReferencePicker` 保留显式 request 注入；application 所有的 Chat caller 必须传 captured sender，不能继续传全局 request。当前 Chat caller 已由 application owner 接入 captured sender。
- application 的根 Home/Tab 仍须按 Host generation 重建；不能依赖 controller 自行更新 epoch 继续工作。
- ResourcePreview 的 native `resources.read`、`resources.present` 与 HTML preview 不是 HTTP request 工厂调用。TS 增加构造 epoch 退休保护，但 Swift resource bridge 当前在收到 native 调用时捕获 transport，仍需 native owner 为迟到 native 调用提供 admission 合同，不能据此声明已完成原生边界修复。
- speech 与 schedule.dateContext 等 native 调用保留原有 native owner 协议；本页列出的 HTTP 迁移不代替这些桥的安全验收。

运行测试时仅使用本地已有 Vitest / TypeScript；不调用 engine、UIKit、device、主构建、真实 Host、网络、Git，也不安装依赖。全包 tsc 的其它 owner/共享 UI 错误单独报告，不能用局部测试通过冒充全包通过。

本轮实际结果：7 个纯测试文件、76 项通过（business-request-owner、appearance、context-usage-route-surface、new-session-ui、new-session-selection、transcript-actions、chat-changes-actions）。全包 `tsc --noEmit` 未通过：gui-plugin-browser.test.tsx 的缺失依赖/props 类型与共享 ui/lib/desktop.ts 的 Window 声明错误；本轮迁移文件没有出现在该次错误输出中。未运行完整 suite、native/engine/UI 验证或 dead-code；本地没有 knip，不为验证下载依赖。
