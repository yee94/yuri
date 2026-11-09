# Session slash action seam（本批冻结接口）

`createNativeTranscriptHistory` 的既有 `props(message)`、消息行 `edit/revert/fork` 和 Indicator 的完整 redo 保持原行为。新增入口只用于现有 session 的本地 slash intent：

```ts
history.sessionActions.undo(): Promise<void>
history.sessionActions.redo(): Promise<void>
history.sessionActions.fork(): Promise<void>
history.sessionReceipt(): NativeSessionHistoryReceipt | null

chat.compact(): Promise<boolean>
chat.compactReceipt(): NativeCompactReceipt | null
chat.compactionBarrier(): boolean
chat.draftRevision(): number // 直接透传原 durable owner，供命令消费 CAS
chat.historyActionStorageKey: string | null // state → history 的内部持久 scope；router 无需消费
```

Application/router owner 负责把这四个回调传入本地 intent router；本 owner 未修改 `application.tsx`、new-session-page 或 composer-commands-model。调用方同步消费属于命令的 token，按原 CAS 保留其余草稿、附件和引用。compact 立即释放调用方的 composer submit flight，后台观察返回值/错误；**不能 await compact 的 Promise 来保持整个 composer submit flight**。`chat.compact()` 自身不设置 `sending`，只等待 Host admission，不等待压缩执行结束。后续 `send` 只在原 writeAhead 等待这一 admission，捕获的 queue/steer 不变，压缩 barrier 存续且未显式选 steer 时使用 queue。没有普通 prompt 或同名 Host command 替代路径。

历史 slash 复用 `conversation-order` 的纯 undo/redo 规则，native shell/synthetic 的展示 role 不作为 authored user。数据源为 `chat.prepareHistoryAction` + `chat.historyActionSnapshot` + 原 `loadOlder`，不是 `visibleMessages`。未知 marker/前一轮边界逐页核验，不以 ID 排序猜测；cursor 不推进、读取失败、缺失完整边界均禁止写入。第一次动作已采用的页保留，下一次 slash 动作在成功刷新 latest/marker 后，直接以原 opaque cursor 重试失败页，不要求另一次 scroll。每次 marker authority 有 revision，即使 A→B→A 也不采纳旧完成。消息行原有全恢复按钮仍 DELETE revert；slash redo 只推进至下一 user，最后一轮才 DELETE。

整会话 fork 使用真实 Host `POST /api/session/:id/fork` 空 body，不用末消息伪造 boundary。本批入口要求权威 idle；运行中不写入，保留既有行级 fork 的 live-boundary 行为。响应/导航均受捕获的 page-operation 与 marker revision fence 约束。fork receipt 丢失 ACK 后不自动重复创建。

compact wire 复用 `session-compaction-api.ts`：`POST /api/session/:id/compact?directory=…`，body `{delivery}`；成功必须为同 session 的 compaction inbox item。NSH 沿既有原生 request 浅代理，未创建 SDK 方法。Context7 查询受月度额度阻断；已只读核对本机已安装 SDK 的 `V2Session.compact` 路由为 `/api/session/{sessionID}/compact`，其生成类型不接受 delivery，因此以已有 Web wire 契约为准。fork 的 `before` 也以现有 Web wrapper 与共享 boundary 契约为准。

`nativeSessionActionStorageKey` 的真实 tuple 为 `[connection.id, connection.url, connection.authorizationID ?? null, target.kind, target.directory, target.id]`，由 `createChat` 创建时捕获，跨 lease/remount 保持稳定。compact 使用 `nsh:compact:v1:${key}`；history 优先消费 `chat.historyActionStorageKey`，使用 `nsh:history-action:v1:${key}`，不依赖 application 旧 `storageKey` 中不完整的 tuple。旧调用方 key 仍仅供不具备该 state adapter 的 fixture/fallback，原历史草稿备份 key 不变。实际 state 测试逐项改变 Host ID/URL/auth/session/directory 验证不同桶，并核对真实写出的 compact key；history 的 production owner 测试验证即使 caller 传旧子集，也采用完整 state key。

首次 compact 请求前原子写 unknown receipt；journal 写入结果未知时不发送 POST、不重复请求。旧 intent 的 no-replay receipt 与当前普通输入 admission gate 分开：lost ACK、journal 结果未知和重挂后仍禁止重放旧 compact；新普通输入可经既有 Host `/api/sessions/:id/delivery` 的完整 inbox、显式 `compactionRunning:false` 以及 `/api/session/active` 的权威 idle 重新准入，保留旧 receipt 的 unknown 状态，不伪造旧请求 ACK。恢复由原 `load` 和 `send` writeAhead 内的只读核验完成，无新增 router recovery callback、轮询或后台 loop。失败/缺字段/迟到快照继续保留 prior 并拒绝该次发送，后续显式发送仍可重试只读核验。

compaction/inbox 事件只使 authority revision 失效并触发既有刷新；无稳定 inbox 身份的 terminal 不能清当前 receipt/barrier/inbox。A running、B queue 时，A terminal 无论在 B ACK 前后都不能认领 B 终态。确认 ACK 始终保存 B 的真实 inbox ID；权威 delivery 中只要仍有 B 或其它 compaction，queue barrier 保留；只有完整无 compaction、非运行且 idle 的成功快照才清已确认 receipt。清除期间仍持有旧 receipt，Storage 失败转 unknown 但不把已恢复的普通输入重新封锁。实际物理 receipt 读写按完整 key 跨退役/重挂 owner 串行，异步 clear 还检查原 receipt/写序号，旧失败不能覆盖新 receipt 或擦掉较新 write-ahead。历史 action 的 Storage receipt 同样先持久 unknown 再写入，且清除失败保持 unknown，不重放成功 stage。

验证覆盖 deferred scope、marker ABA、分页失败/非推进、整会话 fork、late ACK 导航、compact admission 顺序、显式 steer、lost ACK/no replay、journal 写入未知与重挂恢复。聚焦 Vitest 使用 fixture Host，未访问真实 Host、设备或执行 Git。独立 oracle、application/router 装配、UIKit 呈现和真实 Host 运行均仍需主会话验收，不能将本 seam 通过视作完整 slash 已交付。

Oracle 修订冻结检查：五个聚焦文件 `transcript-actions.test.ts`、`transcript-actions-state.test.ts`、`transcript-actions-session.test.ts`、`transcript-actions-compaction.test.ts`、`transcript-actions-storage.test.ts` 共 78/78 通过；`application-recovery.test.ts` 的历史 operation 生产 owner 用例独立通过（其它17项未在该聚焦命令执行）；完整 `tsc --noEmit -p packages/nsh/tsconfig.json` 通过。`bun run dead-code` 已执行并检查，报告仍有仓库未使用文件/导出与 NSH 配置提示。额外尝试完整 application-recovery 时，三个其它 owner 用例失败：Projects 缺 `current` port，session/assistant Chat fixture 缺新 `createChatComposerCommands` port；本 owner 未修改这些装配。既往 `transcript-actions-reuse.test.ts` 两条用例因 `spawnSync nsh ENOENT` 未启动，本轮亦未找到明确 NSH executable，未执行 engine/设备验证。
