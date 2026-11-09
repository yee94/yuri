# Native BTW owner / main 装配合同

本 owner 批次包含 `chat-btw-model.ts`、`chat-btw-presentation.ts`、`chat-btw.tsx` 和 focused Vitest；不修改 application、新会话、state、transcript-actions、composer router。主会话已在 application 接入组件与 command adapter；本批只验证独立 owner/surface 及实际回调合同，**不将接线或静态测试视为完整 /btw 设备验收通过。**

## main 接口

- 在实际 Chat scope 创建 `createNativeBtwOwner({ runtime, sessionID, directory }, current)`。`current` 必须读取真实页面 active 与 captured Host lease 比较，不能只比较 Host ID。Host/lease 替换销毁旧 owner；cleanup 会 retire。当前实现失活 close 清除 side history，与 Web close 语义一致。
- 将返回的 `owner/state` 交给 `NativeBtwSheet`。这是独立原生系统 Sheet，不参与主 transcript 几何，也没有主列表滚动命令。main 隐藏 Sheet 时必须 close；不能仅隐藏 view 仍让请求拥有 authority。
- 纯 router 将解析出的 `{ question: string }` 交给 `acceptBtwIntent(owner, intent, hasReferences)`。必须在主 send flight、selection flush、queue/history/draft admission 之前调用；queued-only/assistant/shell 的命令范围归 router。
- `plainTextRequired` 用既有十语言 `chat.btw.plainTextRequired` 提示，完整主草稿不动；无已有会话使用 `chat.btw.sessionRequired`。
- `accepted` 后，主 composer 只按捕获草稿 revision CAS 清空正文。附件、inline drafts、队列、引用及 selection ownership 不交给 BTW，也不能调用通用 clearDraft。`blocked` 不清正文。裸命令仅打开，无请求；带问题同步接纳并打开，一条请求未完成时新问题保留正文。
- owner `capture()` 返回 owner identity + revision；异步 UI continuation 应把该 action 传给 ask/submit/retry/cancel/close/edit/open，拒绝旧 render/关闭重开动作。原生系统 Sheet 的 presentation generation 仍由现有 NativeSheet 所有。

## P2 关闭完成归属与 reopen 规则

`NativeBtwSheet` 每一代实际呈现固定捕获 `BtwOwner` 与 `capturePresentation()` 的 owner/generation 票据；`onOpenChange(false)` 只交给该票据，绝不在完成时按最新 `props.owner` 调用通用 close。`onClose` 也只能退休自己。新外部 intent、显式 close/clear 都推进 `presentationGeneration`；side input 编辑、完成响应、cancel/retry 不推进，所以当前 Sheet 在普通编辑/响应后仍能正常关闭。

关闭中的 NativeSheet root 保留到真实 `onClose`，期间不重用旧 presentation。新外部 intent 先按既有 adapter 同步接纳，然后只等待呈现；同一 mounted surface 每次只保留一个实际 root。较新的外部打开意图会请求关闭已有 root，即使 UIKit 的交互关闭开始尚未上报；旧回调的 close ticket 此时已失效。新 root 只在旧 root completion 后构造，body、按钮和 Input 全部捕获同一 owner，旧关闭中的 body 冻结且禁用。

呈现等待槽采用 latest accepted generation，不添加问题请求队列：关闭中 `裸 /btw → 带问题 /btw` 两个 intent 都可接纳，问题和请求保留，最终只呈现最新代；已有 pending 时下一问题明确 `blocked`，主 composer 不清正文。显式 `close → 问题 A → close → 问题 B` 按 Web close/clear 顺序只保留 B；A 已发出的请求失权，不受之后旧 root completion 再次清空。没有关闭动作时不会暗中清除已接纳的 turns。owner 替换的旧 completion 仅能作用于旧 owner，已退休的 presentation 回调是 no-op。

公开 `NativeBtwSheet` props 与 `acceptBtwIntent` 返回值未变；`BtwState` 新增只读 `presentationGeneration`，owner 新增 close ticket 与 external intent 方法。router 必须继续使用 `acceptBtwIntent`，不要绕过它以普通 `ask` 代替外部命令；普通 `ask/submit` 归当前 side composer。若装配层在 owner 更换时销毁整个 `NativeBtwSheet`，旧 callbacks 仍因 dispose 失效；跨 owner 的实际 presentation 等待只有在保持 surface 挂载时延续，不能宣称跨组件重建也已验证 UIKit 串行呈现。

回归 `chat-btw-surface.test.ts` 从生产 TSX 获取真实 NativeSheet props，并加载生产 `native-sheet.tsx` 的 iOS `Presentation.onDismissed → finish → onOpenChange/onClose` 路径，覆盖同 owner 新问题、owner 替换、重复旧 completion、当前关闭、两次 close/reopen、裸打开和问题混合及 concurrent blocked。VM 只模拟 lazy JSX/signals 和 native event 交付，不证明 UIKit 拖动时序、布局或动画效果。

## 官方合同与刻意限制

已读安装的 `@opencode/protocol@2.2.1/dist/groups/session.js` session.generate：POST `/api/session/:sessionID/generate`，JSON `{ prompt }`，HTTP body `{ data: { text } }`。没有 location query、model/agent 字段。`@opencode/client` 的 `SessionGenerateOutput` 解开 data；Native 原始桥必须自行严格解开一次，不能接纳猜测的 flat envelope。

安装的 `@opencode/core` `src/session/generate.ts` 编译产物先 `context.select(session.id)`、`resolveModel(selection.session)`，用 selection.agent 与服务端历史构造 transcript，再执行一次 llm.generate。因此继承当前服务端 session 模型、Agent 与上下文；不下载主历史，不执行客户端工具循环。Web 当前发送前 applySendSelection 会额外写 session，本任务禁止该写入，Native 不复制。若未 flush 的 composer selection 与 session 不同，实际使用 session 已确认选择，不能声称选择完全相同。

Web 机制是完整响应非流式：12 条已完成 side turns 拼入 prompt、展示最多 50 条、loading 到最终 Markdown。cancel 结算当前 turn，可原位 retry；close 清历史/side draft。unknown、无 data、无 text、空 text、网络失败都为 failed，可重试。没有 session create/chat.send/session.command/PUT/history 写入或新后端。

现有 `bindRequest`/Swift runtime.request 没有公开 AbortSignal/cancel。close/cancel/retire 只能 local abort：精确 request object 立即失权，迟到成功/失败不发布；**不能宣称取消远端模型费用或物理 HTTP**。同 owner 最多一条有发布权请求；取消后重试时原生旧 HTTP 可能仍运行。

Context7 resolve 已执行，但服务返回 monthly quota reached；未虚构在线核验。只运行 mock 请求；未调用付费模型、真实 Host 或设备。单测不能证明 UIKit、模型回答质量、原生键盘和视觉一致。
