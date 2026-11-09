# Chat writer consumer / 安全退休端口

## 冻结接线 API

`createChat(target, dependencies)` 提供以下可选依赖；writer 类型来自 `desktop-writer-core.ts`，`PageOperation` 来自 `page-operations.ts`：

```ts
writerGrant?: () => VerifiedDesktopWriterGrant | null
writerUnknown?: (cause?: unknown) => void
recoveryReadOperation?: () => PageOperation | null
contactOptimistic?: boolean // 仅正式桌面 Assistant owner 启用；Session / iOS 默认不启用
```

产品桌面 wrapper 在 acquire 原生 ACK 后才构造 Chat/openDraft，向上述两个字段分别传**同一 claim** 的 `grant` / `markUnknown`，负责 acquire、UI waiting、离页准入和最终 native release。state 不启动 capability/bootstrap，不 claim，不 acquire/release。未传依赖的 iOS/原测试 caller 保留原行为。

原 `makeOperationLane` 通过 `bindRequest(scope, readOnly ? undefined : dependencies.writerGrant)` 转发稳定 getter。GET 与 readonly Goal RPC POST 不读 grant，不计入本地在途写；只读 Chat 完全不调用 getter、不传 grant，继续拒绝全部写。

getter 在每次受保护 dispatch 时读取，renew 期间 null 会 fail closed。原 Chat/draft 保留，原 lane 只重绑 captured scope；旧 lane 不能借新 grant dispatch。原 transport 验证 opaque grant 与 scope/target/current，不从 URL 获取 authority。严格的 `DesktopWriterError(outcome:'not-dispatched')` / native `native_host_busy` 不产生第二个 unknown，也不把尚未提交的新 pending intent 留为已提交未知；本来已 uncertain 的 intent 仍保留。

transport 只确认 native envelope，prompt/assistant/compact 的 2xx body 仍由原 domain parser 验证；坏 ACK 同步保留本地 `write-unconfirmed` 并调用 `writerUnknown`。main 必须接同 claim 的 `markUnknown`，使 cleanup/close 无法洗掉 native receipt 的 sticky unknown。回调失败也不会让 state 认定已确认；state 不自动重试、释放或重新 claim。

## Pending receipt 的只读恢复

native claim sticky unknown 后 `grant()` 为 null，产品 `chat.active` 可以继续为 false。`laneCurrent` 不读 grant；原 lane 的 GET 也不读取 writer getter。只读恢复不应放宽 writable active，而是复用 `chat.recoverPendingSend(): Promise<boolean>`；`retrySend()` 遇到 local compact/magic pending 时在进入普通 `send` 前转入此分支，绝不重发 mutation。`readOnly` / shared Chat 不拥有该 journal，直接拒绝恢复，也不读取 admission/getter。

`application.tsx` 的原 `ChatOwner` 已提供独立于 grant 的 read operation；合同如下：

```ts
const recoveryReads = createPageOperations(() =>
  interactiveChatRoute() && !externalModalOpen()
);
const chat = createChat(target, {
  writerGrant,
  writerUnknown,
  recoveryReadOperation: recoveryReads.operation,
});
```

上述两个准入 getter 表示 main 已有的真实 route/inline 交互与 Settings/外部模态状态，不是 state 新增的 controller。operation 必须在当前前台 Chat route 才有效；后台、Settings、其他 route 或外部模态须真正退休旧 operation，恢复后创建新 identity，不能仅临时过滤 getter 后复用旧对象。不要把 grant 加到 read operation 的 active 条件，也不要借 retained/syncActive 证明前台交互。请求始终使用捕获的原 Chat lane，不调用 read operation 的 request，不新增 transport。未提供可选 hook 的既有 caller 仍要求原 `active()`，并同样复验前台、最上层 Chat 与原 connection identity。

每次恢复捕获 read operation；每个 GET 前后复验其对象 identity/current、原 lane generation/scope、Host ID/origin/authorization、前台 lifecycle 和最上层 Chat owner。退休后的迟到响应不能发布；同 causal ID 的 pending object 已被替换也不能被旧 proof 清除。compact 核验 exact causal/session/compaction 类型及 promoted status；magic 的 inbox/exact message 同样核验 session 与 causal ID。404、畸形或不匹配 receipt 返回 false 并保留 pending；无可用 exact proof 的读取失败保留错误，不转为空成功。inbox 读取失败时仍可由匹配的 exact promoted receipt 独立证明。

成功仅清除同一 local pending 并 flush 原 journal，保留后续草稿、附件和其他 owner 的状态；flush 失败恢复原 local pending（不覆盖期间出现的新 pending），并继续报告失败。`true` **只表示该次 pending receipt 已确认及 journal flush 成功**，不是整体恢复可写。不会清除 `writerUnconfirmed`、history unresolved 或 native sticky unknown，不 renew/release/新 claim。纯 lost-ACK receipt 核验后 state 本地 prepare 可能为 true，但 native claim 仍拒绝 release；坏 domain ACK 的本地 `write-unconfirmed` 和旧 history unknown 继续阻止本地 prepare。

## 产品续租的两种因果顺序

`loadConnections` 收到同一已确认 Host ID/origin/authorization、两侧均有真实 native scope 的新 lease 时，`adoptConnections` 将原 Chat 置为可续接 suspend，而不是永久 Host 退休；不依赖后台切换、模态或组件重建。不同 Host/origin/authorization 或缺乏两侧 scope 证据仍硬退休。writable 与 readOnly rebuild 都复验原 origin/authorization，不能借相同 Host ID 复用旧 draft。

1. **resume 早于 renew ACK**：原 `resumeChatOperations()` 可以先构建 captured **新 scope** 的 lane。factory 不读取/缓存 grant，renew getter 的 null 不影响构建。间隙内受保护写在 transport 处明确未派发；原 claim 不会因此变 unknown。ACK 更新同 claim 的 opaque grant 后，这个 lane 的动态 getter 即可写入。随后 `scopeReady` 调用 `chat.rebuildOperationLane()` 返回 false 是「已经重绑，无变化」，不是失去写入能力。
2. **scopeReady 才重绑**：若原 resume 未先执行，ACK 后 `chat.rebuildOperationLane()` 从 retained suspend 显式重绑一次并返回 true。它不 acquire、不 openDraft、不重新 hydrate，也不以模型 busy 为重构依据。

当前 scope/generation 已就绪时，重复 scopeReady/rebuild 或同 scope 的 connection read 均不重建；`messageScope` 引用保持不变。旧 scope 的 in-flight preparation 仍由原 lane/generation fence 拒绝，不能借动态 getter 跳到新 scope dispatch。重绑保留 pendingSend/queueEdit；原在途写计数独立于旧 sending/queueBusy 的展示重置，旧 history unresolved 仍阻止退休。未知 claim 不 renew、不 acquire 替代，也不因新 lane 看似空闲而 release。

这一区分保留 `rebuildOperationLane(): boolean` 原合同，无新增 grant-ready 参数或 claim/caps I/O；root 仍以同 claim 的 ready/phase/scope 为授权依据，而不是把 rebuild 的 false 当作 writer denied。

state 已提供的退休端口：

```ts
chat.writerRetirement(): Readonly<{
  canRelease: boolean;
  needsFlush: boolean;
  reasons: readonly string[];
}>
chat.canReleaseWriter(): boolean
chat.prepareWriterRetirement(): Promise<boolean>
chat.cancelWriterRetirement(): void
```

同步 getter 只读原状态；`canRelease` 只表示 **state 本地** prepare 的写入暂停仍有效、草稿成功持久化且本地写入/unknown 保护已清，必须与原 claim 的 `canRelease()` 和真实 UI/文件/attachment/history guard 组合。`needsFlush` 表示尚无匹配当前 durable revision 的显式 flush ACK，内部后台 flush 不冒充退休确认。异步 prepare 暂停该 Chat 新写入，复用原 durable flush，完成后复验 revision/原 lane 和所有保护，再返回本地可 release；不调用 native release、不关闭 draft。false 恢复准入并保留保护；true 保持暂停。取消离页调用 cancel，恢复同一 Chat 准入，取消也使在途 prepare 的结果失效。

## 已核对的原 writer 路径

| 路径 | 当前 owning transport / 保护 |
| --- | --- |
| prompt、command、shell、compact、Goal | 原 `operationLane.request`；`sending`、durable pendingSend、同一 history/send lane |
| queue cancel/steer/edit | 原 `operationLane.request`；queueBusy/queueFlight，edit 另有 durable queueEdit |
| session interrupt / assistant abort | 原 lane request；不能把服务器 live busy 当成本地未知写 |
| assistant messages | 原 lane request；同一 pendingSend journal |
| form/permission reply/cancel | 原 lane request；需覆盖在途 mutation，不能只看 sending |
| send 前 revert commit | 原 lane request；pendingSend 与原 history lane |
| 独立 transcript stage/clear/fork | `createNativeTranscriptHistory` 捕获 **input PageOperation.request**，并非 Chat lane；unknown journal 在该 owner，通常同时持有 `chat.historyBusy` |
| history import | tour/project 的独立 PageOperation owner，不属于 createChat；不能借 Chat grant 猜测 import 权限 |
| POST /api/session | 当前 `newSession(project, request)` 接收外部 request；新会话 owner/consumer 单独注入，不能借已有 session grant |

实际 `ChatOwner` 已给 transcript history 原 PageOperation 注入同一已验证 writer transport（保留原 current/generation）；不是仅修改 Chat lane。import/new-session 保持各自 owner，不从路径推导 grant。

## 退休保护边界

原 durable 的 pendingSend、queueEdit、发送、historyBusy/unknown、queueBusy/recovery 与所有正在 dispatch 的本地 mutation 都阻止 release。普通 draft、references、attachment metadata、Git context 可以在 flush 成功后随 owner 退休；附件选择/上传/录音属于 application 的真实异步 owner，main 必须组合其 guard，state 不能从 attachments 非空猜 in-flight。

`drafts.close()` 已包含 flush 与 lane 释放；Chat cleanup 仍只调用它一次。prepare 只 flush，不提前 close，不清 pending/queue/history，不把 unknown 当失败回滚。暂停或 Host 退休不能把旧在途/unknown 保护从 release 检查洗掉。模型 running/compaction 等已确认服务端运行本身不阻止本地 writer 安全交接。

原 request 写入计数跨 lane 保留；非 journaled mutation 的丢失 ACK 保持 `write-unconfirmed`，明确 4xx 拒绝（408/429 除外）不产生该保护。已有 pendingSend/queueEdit/history 的请求继续只使用原恢复源；pendingSend 经原 exact reconciliation 确认后不会留下第二份未知 journal。historyBusy 在 lane 重建前尚未解除时，旧保护被保留为 `history-unresolved`，不能用重建/reset 洗成已解决；外层 history 原 unknown/journal guard 仍须组合，不能仅依据新 lane 的空 historyBusy release。

## 验证

`state.test.ts` 的退休 10 场景覆盖 dirty draft/attachment flush、服务器 busy、取消恢复、pending/queue/history/发送保护、迟到/失败 Storage ACK、真实 interrupt 在途/未知/明确拒绝，以及原 pendingSend 成功恢复。

同文件 verified consumer 场景使用真实 `loadDesktopWriterClient` + `StrictWriterHost` 的完整 discovery/acquire/renew ACK 签发 opaque grant，再经产品 `runtime.bindRequest` 进入原 `createChat`。覆盖全部上述 lane 写路径、原 body/expectedHost、只读/50 draft/GET 零 grant reads、无逐次 acquire、坏 domain ACK 的同 claim unknown/cleanup 保锁、wrong-target、renew null 窗口、held old-lane preparation、Host 退休保稿及 native not-dispatched 后重试。测试只使用 synthetic Host，未访问真实 Host、Vault、模型或 OS 窗口；实际 Chat wrapper/history/new-session 根接线由各自 owner 验证。

续租因果回归明确覆盖：active committed scope（不先切后台）、resume 在 ACK 前/后两种顺序、scopeReady 重复 no-op、同一 claim/ownerID/draftReady/referenceScope/attachment 引用、零第二次 Storage hydrate、后续 prompt/interrupt/Goal 与 WorkStatus 源恢复；另覆盖换 origin/auth 拒绝、pending/queue/history unknown 和真实在途写不洗锁。测试不通过模态或 effect remount 获取绿灯。

只读 recovery 回归使用同一正式 client/StrictWriterHost lost compact/magic ACK，使 active/syncActive 均 false、grant=null 后核验原 causal ID，断言零 mutation replay/零 grant reads/native sticky release veto；覆盖 inbox 与 promoted receipt、404/offline/畸形/错 session/causal、后台/Settings/其他 route/scope/origin/authorization、迟到和退休后恢复的 operation、同 ID pending replacement CAS、journal flush 失败、readOnly/shared 拒绝及 domain/history unknown 不洗锁。state 聚合 **19 文件、445 项通过**。main 已另行复跑实际 Commands wrapper，内部两平台 **50/50 场景通过**，包含 grant unknown 后核验与 Settings 退休迟到读取。系统窗口和真实 Host 仍未验，不能从上述结果推断 native unknown 已解锁。

## Desktop Assistant 消息级发送呈现

`contactOptimistic:true` 在原 Chat 内保留最多 64 条临时 user shadow 与 captured intent，不创建第二 store、transport、draft writer 或 List。发送 ID 沿用原 pending journal 的客户端 ID，直接复用 Web `contactOptimisticTurns` 的 sending/admitted/failed 和权威 ID reconciliation。成功空 GET 不等于已接收该消息：同 generation 的未确认 shadow 继续保留；真实新 history generation 才清理旧呈现。达到上限时拒绝新发送、保留全部 shadow 和新草稿，不驱逐未确认行迎合预算。

`messages()`、`contactReadPosition()` 保持权威来源；`visibleMessages()` 才合并临时 shadow。消息级 retry 为 `retryContactMessage(messageID)`：未知 pending 仅进入原 `recoverPendingSend()`，绝不重发 POST 或恢复 native sticky unknown；明确 not-dispatched 的 failed intent 才能在前台、active、未退休的原 lane 显式重试，沿用 ID/附件快照，不消费后来的草稿。admitted 行不能再次重试。附件 parts 直接使用 canonical descriptor，不进入 Session 引用编译。

已被 failed user shadow 接管的发送错误只保留本地化消息级反馈，不重复写入 `chat.error`。附件、历史、scope、草稿持久化等没有消息级 owner 的错误仍保留原全局反馈；global pending retry 仅在 exact failed shadow 已接管时隐藏，冷恢复的 pending 没有 shadow 时仍保留入口。收到正确 admission ACK 后的 journal flush 失败保持 admitted 呈现、恢复原 pending 的只读确认屏障和全局错误，不能将它降为可重投的 failed intent。`retrySend()` 对 Assistant uncertain pending 同样只做 exact readback。

最初独立 state/drafts 检查为 **2 文件、193 项通过**；随后四项同 ID 错角色/错 Assistant 和 recovery journal 失败保 pending 回归进入 paired digest `86fb08…cfe7` 的 **5 文件、258 项通过**批次。覆盖原 ID reconciliation、failed GET 保 prior、lost ACK 零重放/不洗锁、带附件的 not-dispatched 重试保后来草稿、admission 后 journal 失败只读恢复、64 条上限与真实 generation reset。后续 live-card status 源新增后正在重跑，较早数字不背书新源码；这些检查不替代 native OS 证据。
