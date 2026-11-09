# Native composer 本地命令装配

本批已实际装配 Chat 与新会话生产入口；没有改动全局导航 gate、资源两条 route、retirement imports，也没有重写 BTW/Timeline/历史/compact owner。此合同记录本批装配，不替代各 owner 的独立 oracle 或 UIKit 验收。

## 生产调用链

| 入口 | 实际消费者与效果 |
| --- | --- |
| `composer-commands-model.nativeCommandRows` | `NativeCommandSuggestions` 仅在候选浮层 presence 内生成；Chat 注入真实 session/messages 上下文，新会话注入 unsent-draft 上下文 |
| `composer-command-router.createNativeComposerCommandRouter` | 纯 parser/plan 与 captured operation + revision CAS；同一 `choose`/`submit` 处理候选和发送按钮 |
| `chat-composer-commands.createChatComposerCommands` | 实际 Chat 委托 adapter；BTW 使用 `acceptBtwIntent`，其余回调由 application 注入 |
| Chat `referenceKeyboard.chooseCommand` | router.choose；operation identity 进入键盘上下文，Enter/点击走已装配 whitelist，Tab 仅插入 |
| Chat `sendDraft` | 先 router.submit，仅 pass 才调用原 `chat.send`；expanded 与 compact 两个发送按钮共用同一函数 |
| 新会话 `NewSessionBody` | 两入口复用 router；model 保正文并打开原 Sheet；new 幂等留在同一未发送页与 durable owner；已有 receipt/pendingSend 的恢复仍走原 owner.submit，不重解读已捕获命令 |

本地动作只接受 `source: yuri` + `id: yuri:<name>` + 一致的精确名称。Host 同名/isBuiltIn 标记不能自动执行；上下文不可用的本地保留名称也不从 Host metadata 重新加入。Host 显式候选的临时 source affinity 只对同 operation、同 revision、同正文有效；手改或 owner 更换即失效。实际 Host command 能力仍由原发送 owner 核验，不从候选名称推断。

## 命令语义

| 命令 | 候选点击/Enter | Tab | 手动/发送按钮 | 草稿与资源 |
| --- | --- | --- | --- | --- |
| new | 即执行 | 插入 | 打开未发送草稿 | 按 Web 清整个正文，外置附件不动；Chat 复用 header 同一 Nav push，新会话页保持同一 owner；不 POST create |
| undo / redo / fork | 即执行 | 插入 | `history.sessionActions.undo/redo/fork` | 同步正文替换 + revision CAS，外置附件/inline drafts 不动；逐轮 redo、idle/unknown/receipt 与分页 authority 均归原 owner |
| compact | 即执行 | 插入 | 已有 session 调 `chat.compact()`；新草稿走普通 materialization/handoff | session compact 不等待网络维持 composer flight、不设置 sending；新草稿行为见下面源码链 |
| model | 即打开原 picker | 插入 | 打开原 picker | 提交保持完整命令正文、尾随文本与附件，不请求模型或建 session |
| timeline | 仅插入 | 插入 | 打开实际 `NativeChatTimeline` | 不清正文/附件；复用 chat.messages、history.props、messageFocus.focus、原 compact-latest 共用 resumeLatest |
| btw | 先替换 token，再以裸 `/btw` preset 接纳 | 仅替换 token，保尾随文本/引用 | 手动带问题才由 owner ask | accepted 后才 CAS 清正文；引用拒绝保当前完整正文；attachments/queue/queueEdit/pendingSend 不修改 |
| init | 仅插入 | 插入 | 原 Host command 路径 | 目录仅已有空会话；不新增 local executor，不匹配 `/initiate` 等前缀 |
| summary | 仅插入 | 插入 | 原 magic compiler | 限已有 session |
| workspace-review / craft-goal / catch-up / debug / weigh / explore | 仅插入 | 插入 | 原 magic compiler | 已有 session 或未发送草稿可用；不改已有保存格式或编译 owner |

无 session 的新草稿不伪造 undo/redo/fork/timeline/btw/summary/init authority。`/goal` 与 shell 继续走原 route，没有 Goal 后端循环。

源码证据与精确分支：

- `packages/ui/src/components/chat/CommandAutocomplete.tsx:218` 无条件列出 compact；`commandSelection.ts:12` 将 compact/model 等列入即时 whitelist。Tab 不 submit，点击/Enter 由同一个 whitelist 判断。
- `ChatInput.tsx:5702` 构造并 promotion `/<icon-slot>name `；`:5708` 仅 BTW 做 token-range edit，其余本地候选 `:5716` 调 `replacePlainDocument`；`:5728` 即时动作以裸 `commandText` preset 调 handleSubmit。`use-composer-controller.ts:224` 明确将正文 references 与 mentions 清空，附件与 inline-comment drafts 归独立 resources。
- `ChatInput.tsx:3050` 的 BTW preset 分支不从尾随正文取 question；手动提交才读取完整 snapshot。`:3119` 的 model handler 直接打开并 return，不消费正文。`immediateCommandTextConsumption.ts:14` 清完整正文，与只删 token 不同。
- 无 session compact 不满足 `ChatInput.tsx:3847` 的 local handler 条件，落入 `:4073` 的普通 send。`chatInputSurfaceWiring.ts:96` → `ChatInput.tsx:1664` → `session-ui-store.ts:2145` 的新草稿普通路径，`:2182` 调既有 materialization，`:2205` 调 routeMessage；其 `:318` 后按真实 metadata 决定 command/reference，未匹配 `:397` 落入普通 prompt。这是用户点击/提交触发的 Web 既有行为，不是新增 Native create 权限或自造 compact executor。
- Native 两路候选已按上述语义对齐；即时 compact 的 preset 通过既有 `preparedText` 字段持久，author body/reference snapshot 与原 source/destination cleanup 不改变。command 与 skill metadata 在真实创建后、首次 handoff dispatch 前读取；同名 skill 按 Web 优先，用 Native 已有的 `{skills:[{id}]}` 传输能力，未新增本地 skill/compact executor。metadata 失败不作空成功，不重放 create。现存 session compact 仍只用冻结的 `chat.compact` owner。

## BTW / Timeline 生命周期

BTW binding 在 Chat 的真实 page-operation / Host lease 生命周期内创建，不随正文编辑或 render 重建。current 同时核对 exact operation、captured runtime scope、page top、active 和 lifecycle。失活/换 lease 退役旧 owner，保留主草稿；Sheet 容器稳定存在，旧 presentation 等自己的 native completion 后由独立 owner 切换。cancel/close/retire 只 local abort，不能声称物理取消 HTTP 或费用。

`acceptBtwIntent` 必须同步返回 accepted 才能 CAS 清正文。若 generate 接纳过程中主草稿版本改变，问题仍归 BTW owner，但新正文不被清除。迟到答案只触及仍有效的 side owner，不触及主 queue/history。

Timeline 不新增 toolbar 入口或 List writer。候选选择仅插入，submit 才 opensheet；共用 `resumeLatest()` 的 `scrollToIndex({index:0,animated:true,viewPosition:1})`，无 JS offset。pending-close、fork completion 后导航与旧 Sheet generation fence 仍由冻结 Timeline owner 执行。

## Oracle P2：未派发准备失败的生产 Retry

首次 admission 不再在 metadata 前记作派发 unknown；source v1 receipt 增加可恢复的 `preparing` 值，旧 `unknown` / `acknowledged` 读取与保守语义不变。真正的 HTTP dispatch 仍由 createChat 的原 destination write-ahead journal 拥有：只有它会在请求前持久 `pendingSend.uncertain:true`，本模块不修改 state 或伪造已派发/ACK。

| 证据 | `admission.run` 显式 Retry | `admission.reconcile` / 退役完成 |
| --- | --- | --- |
| source preparing 写入已确认 + exact inputID pending `uncertain:false` + destination draft ready | 复用原 receipt/session/inputID 重查 metadata、继续准备和首次 dispatch | 仅核对，不自动派发 |
| source unknown（含旧版本记录），即使 pending 的 uncertain 为 false | 仅核对，不将 unknown 改成 preparing | 仅核对 |
| pending uncertain true，或 pending 已缺失 | 仅核对，不能生成新 inputID 或重放 command/prompt | 仅核对 |
| source journal 写入成功与否未知，或 destination draft 存储 error | 不把内存 pending 的 false 当安全证明，不派发 | 不假 ACK 或清 receipt |
| 真实 admission ACK / source acknowledged | 只重试源清理/release，不再 send | 不重复 admission |

source 写入错误在当前 owner 内保守锁定为 unknown；迟到旧 operation 的失败不会给新 operation 写该锁。判断前等待真实 source 与 destination hydration。operation/Host 变化后仍使用捕获 request 与 existing source authority；metadata 的迟到成功不得编译/flush/派发旧输入。

实际 application 的 `chat-send-retry` 回调保持原样，仍调用 `admission.run()`。`new-session-admission.test.ts` 从生产 TSX 提取并执行该回调，联合真实 durable source、installed destination、Chat recovery/send 与 admission owner 验证：first failed/malformed metadata 为 0 dispatch；恢复后 retry metadata 读取第二次，同 inputID 仅 first-dispatch 1、create 1；command 与 prompt 的 lost ACK 均不重放；source/destination 两类 Storage unknown 不误判安全；旧 unknown 不清；metadata 延迟遇到 Host 退役无迟到写入；preparing 关闭/重开后同一 receipt 可显式首次发送。

## 证据和待验

- `chat-composer-commands.test.ts` 执行 application 的真实 Chat 声明、候选/发送回调与 JSX props；真实 BTW JS owner + mock scoped generate，覆盖全部动作的 Enter/Tab/Send、后台 compact 后继续输入、错误/旧 operation fence、引用拒绝、revision race、同 Host lease ABA、原 history/focus/latest 注入、稳定 BTW Sheet 挂载及两种发送按钮的主 flight 绕行。
- `new-session-page.test.ts` 执行生产 TSX 回调与实际新会话/durable owner；覆盖两路 model/new、初次 session 不被本地命令意外创建、附件保留、same-text operation ABA、200 次 onChange 的零 catalog/network/sync-storage 操作数和原 handoff。
- 本轮先将生产 model/new/timeline 候选与无 session compact 用例改为上述 Web 结果，确认 8 项 red，再实现 green。新增 compact 的手输/Enter/Tab → 普通 create/handoff，以及 Host built-in、非 built-in、未注册 prompt fallback 全 mock 回归；新增 `composer-command-selection-parity.test.ts` 直接执行真实 Web `handleCommandSelect`，逐项比较 11 种本地候选在 Tab/Enter 下的完整正文、inline references 与 preset。
- `composer-command-router.test.ts`、`composer-commands.test.ts` 覆盖精确 token/slot、Host collision、条件 init/magic、unknown local identity、引用范围保留与失效 CAS；`composer-reference-keyboard.test.ts` 的两个纯用例覆盖键盘 CAS 和 operation 更换。
- 已运行 focused Vitest、NSH TypeScript 和 dead-code；未运行设备、真实 Host、真实模型、Git 或付费请求。未跑 engine/UIKit 和原生 SDK bundle，不能将 Node/VM callbacks 当作原生手势、焦点、Sheet completion 或性能预算的证明。
- Oracle P2 修复验证：先确认两类生产 Retry 失败为 red；修复后包含 admission 的 7 文件、135 项通过，NSH TypeScript 通过。冻结清单更新后交原 oracle 复核，独立复核未完成前不声称已验收。

主会话 UIKit 验收路线：已有 session 分别用候选 Enter/点击、Tab 后 Send、手输 Send 执行八个动作（含 model），核对候选整体替换/inline refs 清除与外置附件保留，单独核对手动 model 保全文；timeline 二次提交打开、搜索/分页/消息定位、pending-close、fork 真实 dismiss completion 后导航及返回最新；BTW 候选 Enter 只打开而 Tab 保留尾问题，手动带问题接纳、引用拒绝、主稿同时编辑和换 Host lease 后迟到回答隔离；compact admission pending 时继续输入与原 queue/steer；新会话 compact 候选/手输走原一次 create/handoff（仅测试 Host/模型 mock，不以真实模型验证），new 不建 session、summary/init 不出现。
