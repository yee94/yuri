# Exact history-cache retirement handoff

## 主接入 seam

`state.ts` 持有原有唯一 `createNativeHistoryCache(Storage)`，只需导出包装：

```ts
export const retireHistoryAuthorization = (connectionID: string, authorizationID: string) =>
  historyCache.retireAuthorization(connectionID, authorizationID);
```

`historyCache` 替换为现有 singleton 的实际变量名。禁止为 cleanup 新建第二个 cache writer；所有 history index 操作必须共用这个 singleton 的串行 lane。

production root 安装 `NativeAuthorizationCacheCleanupRoot`（`newauthorization-cache-cleanup-root.tsx`），内部复用 `createAuthorizationCacheCleanup`。五个固定 handler 已由 `AuthorizationCacheCleanupBridge` 注册：

| JS bridge | Swift helper | 参数及返回 |
| --- | --- | --- |
| `ready()` | `ready()` | 返回 `{owner,tickets}`；每次新 root 安装都会撤销旧 root 的 ticket/claim/completion |
| `list(owner)` | `list(owner:)` | 仅当前原生 durable pending 的 opaque ticket 数组 |
| `claim(owner,ticket)` | `claim(owner:ticket:)` | 原生检查 pending receipt，返回 exact `{connectionID,authorizationID}` |
| `ack(owner,ticket)` | `ack(owner:ticket:)` | 仅已 claim 且仍 pending 的同一 ticket；不接收 JS identity/completed 布尔值 |
| `retry()` | 注入的 `afterSweep()` | 仅调用 RuntimeBridge 的退役重试，不执行 reset POST |

handler 名固定为 `authorization.cache.ready/list/claim/ack/retry`；ready/retry 输入严格 `{}`，list 严格 `{owner}`，claim/ack 严格 `{owner,ticket}`。值为 1–128 ASCII 字母数字/下划线/连字符；未知 key、空值、错误类型、超长输入均失败。ACK/retry 返回 `true`；生产 JS adapter 严格检查该确认及所有回包形状，缺 handler 不能当成功。

main 保留 bridge 的强引用，原生初始化：

```swift
let cleanup = AuthorizationCacheCleanupBridge(app: surface, pending: {
    Set(store.pendingAuthorizationRetirements.map {
        AuthorizationCacheCleanup.Identity(connectionID: $0.connectionID, authorizationID: $0.authorizationID)
    })
}, afterSweep: { [weak runtime] in
    guard let runtime else { throw CancellationError() }
    await runtime.retryAuthorizationRetirements()
})
```

`runtime` 使用 main 实际 RuntimeBridge 变量名。`afterSweep` 的唯一动作是现有 `retryAuthorizationRetirements()`；该方法当前不抛错，若合同改变则传播错误。不要放任何连接选择、网络登录或 POST。

productionApp 的接线示例（main/application owner 实施）：

```tsx
const cacheReady = signal(false);
const cacheState = signal({ ready: false, busy: false, failed: false });
let retryCache: (() => Promise<void>) | null = null;
return <>
  <NativeAuthorizationCacheCleanupRoot
    retire={retireHistoryAuthorization}
    onReady={() => cacheReady.set(true)}
    onState={value => cacheState.set(value)}
    onRetryAvailable={retry => { retryCache = retry; }}
  />
  <If when={cacheReady()} else={/* 本地等待/失败页；失败按钮只调用 retryCache?.() */}>
    {/* 在这里才创建业务子树，不能提前创建 Chat/cache reader */}
  </If>
</>;
```

示例中的等待/失败页由主 owner 复用已有 UI；`onState` 只有安全的 ready/busy/failed，不含异常原文/凭据。gate 初始 false，首次 sweep 所有 ticket 物理删除且 ACK 成功才单向 true；后续失败只反馈，不卸载业务。缺 handler、初扫失败均保持 gate 关闭。Native retry 的其它 owner 失败可反馈 failed，但所有 cache ticket 已 ACK 时无需阻塞 cache gate。

组件先订阅 `authorization.cache.pending` 再首次 sweep；同一 flight 期间的 tip 标记 dirty，完成后补扫。最后同步检查和 promise finally 间的 tip 也会重新调度。无 timer、无失败自动循环；foreground、native tip、用户显式 retry 才重试。原生 retry 发回 pending tip 时，空补扫不会再次 native retry 自循环；用户显式 retry 仍能重试先前失败的 native cleanup。

native owner 失败作为 root 生命周期内的 `nativeFailed` 保留；后续空 tip/drain、busy 状态发布均不会清除。仅实际 `bridge.retry()` 成功才清除，失败则继续反馈 `failed:true`；cache gate 仍单向，不因通知/receipt owner 失败卸载已挂业务。finally 交界处发起的显式 retry 会等待后续 dirty 补扫链，不能提前返回而遗漏真实 cleanup 结果。main 的 afterSweep 必须在 RuntimeBridge 重试后检查所有 owner 的失败状态，不能用 RuntimeBridge 的正常返回代替清理成功。

销毁先撤销 alive 再取消订阅，物理删除不能取消，但删除返回后不会再发 ACK 或 onReady。新 root 会 ready 轮换 owner；旧 owner 的迟到 ACK 由 native 拒绝。旧 root 的成功不会打开新 root gate。旧 fixture 可明确不挂生产 root，不能用默认成功绕过 handler 缺失。

`onAuthorizationRetired(connectionID,authorizationID)` 先 `cleanup.requestSweep()` 发 tip，再检查 `cleanup.requireCompletion(connectionID:authorizationID:)`，和 NotificationBridge 等其它 owner 组合 await。foreground 也调用 `requestSweep()`。如果 callback 先于 JS sweep，`cleanupPending` 是可恢复失败；JS sweep 的 retry handler 会让 RuntimeBridge 只重试 durable receipt。此 bridge 不调用 ConnectionStore ACK、不操作通知。最终 durable receipt 仍由 RuntimeBridge 在所有 owner 完成后 ACK；不能吞异常或重复 reset POST。

main/state/application/RuntimeBridge/nshjson 没有由本变更修改；未接线前不能声称 production reset 已闭环。生产 Swift 构建的 `ios/*.swift` 会收集新 wrapper；手写 harness 显式清单需主 owner 加入两个 cleanup Swift 源文件。

## 持久化与恢复

- key 仍为原格式 JSON 数组；仅解码后前两项 exact connectionID/authorizationID 相等的 history entry 被删除。不是字符串 prefix。其它 Host、新授权、draft/pendingSend/queueEdit/receipt/attachments 的存储键不参与清理。
- `retireAuthorization` 调用同步撤销 memory 和后续/排队 read/write admission；正在 Storage await 的读也在发布前复核。永久 tombstone 不随 clearMemory/invalidate 消失。其它授权的内存 snapshot 引用不变。
- 在同一个 history index 原子 `setItem` 中持久化 `retired` 与被删除 entry 的 garbage slots，之后才 removeItem。旧 v1 index 无 `retired` 字段可直接读取。write/invalidate/LRU 保留 tombstone。
- tombstone 首次写失败：不删除任何 record，返回失败，当前内存仍退役；原生 durable pending 保留。重启必须先扫原生 pending，再接纳业务历史访问，以防首次 tombstone 尚未落盘的旧 index 被读取。
- 每个 garbage/pending slot 独立尝试删除，失败后继续其它槽位；失败槽位与 `owners[slot]` 持久保留。owner 为 exact JSON `[connectionID,authorizationID]`，显式 null 表示已知非授权旧 key，缺字段表示未知。新 candidate journal 在内容写入前保存 owner，entry 淘汰/替换/退役时保存原 owner。
- 旧 v1 没有 owners：清理前从 record 的 version/key 恢复；读取失败/损坏保持未知。exact retirement 仅因自己的剩余槽位或未知归属失败槽位 reject；已知其它授权的失败不阻止本授权物理删除 ACK。普通 cache read/write/invalidate 保留失败 GC journal 后可继续，不把 GC 延迟当服务端读取成功或失败；journal 写失败始终 reject。
- 已落盘 tombstone 阻止冷启动复活。再次 exact retire/read/write 幂等重试 journal；部分 record 已删仍可安全重试，index 更新保留旧失败槽位，不被后续新 candidate/替换/失效覆盖。删除成功但 journal 更新失败仍不 ACK。
- tombstone 为永久小型 identity 记录，不缓存正文，不按 LRU 淘汰。当前设计依赖 Storage 单 key 写入的原子替换能力；不支持多个 cache 实例/进程同时写同一 index。

## 显式手动全量 history cache 清理

`createNativeHistoryCache` 现有唯一 writer 新增 **`clear(): Promise<void>`**。主 owner 从同一个 singleton 导出最窄包装（不创建 cache、不复制 index writer）：

```ts
export const clearHistoryCache = (): Promise<void> => historyCache.clear();
```

`historyCache` 使用 state 当前真实 singleton 变量名。主 Settings UI 只在用户点已翻译的确认按钮后调用该包装，持有 busy/progress 到 promise 结算；reject 保留失败反馈和显式重试入口，不显示成功、不定时重试。未确认、页面挂载或 foreground 均不得调用 clear。本 owner 未改 state/application/settings-preferences/main/root bridge。

- clear 调用同步清除内存 seeds，并递增局部 clear version，fence 此调用之前所有排队读写和晚到 read/write 发布。它不变更消息、live Chat authority、Host generation、草稿或发送状态，也不冒充 native retirement/source/ACK。
- 同一串行 lane 中先把全部 indexed entries、既有 garbage 和 pending 槽位写入 durable journal，再逐槽物理删除；单槽失败继续其余槽位。只有所有槽位删除成功且最后 journal 更新成功才 resolve。保留 index metadata 与每个授权 tombstone，不删除 index metadata 记录本身。
- 首次 journal 写失败时不开始删除；memory 已清，旧盘 index 仍有效，失败不能宣传擦除成功，用户可明确再次 clear。journal 已落盘后崩溃/删除失败则 entries 为空、失败槽位持久保留，冷启动不会恢复旧展示 seed；显式 clear 重试和原有 journal 恢复均幂等。最后 journal 写失败也 reject，即使物理内容已删除。
- clear 不轮询重试，保留 authorization retirement 的 owner metadata、永久 tombstone 和所有原生 pending receipt。只有原有 exact retirement runner 才能完成 native history owner ACK。A/B 授权失败隔离仍由原合同保障。
- clear 后调用的新权威 cache write 仍合法，串行排在清理之后；失败 clear 也不永久封锁新写入。旧失败槽位留在 journal，分配新 slot 时显式避开 index/pending/garbage 已占用身份，即使重启后时钟/随机值重复也不会复用，防止后续垃圾回收删除新内容。
- 并发 clear 共享同一个 promise 和第一次调用的清理边界；共享 flight 中随后排队的新写入保留。该 flight 结算后再次明确 clear 是新一次全量清理，包含当时已经存在的新缓存。
- 仅清 history-cache 拥有且被 index/journal 跟踪的 record slots；不会枚举 Storage，更不会删除 draft/pendingSend/queue/attachments/settings/credentials。index 损坏时失败关闭，不猜测其它存储键。

本轮红绿验证：新增 8 项 full-clear 行为（其中 journal 写失败包含两个参数场景），与原 retirement/root 合计 **34/34 focused tests 通过**。覆盖 queued read/write、in-flight read/write、clear 之后的新写入、并发 coalesce、indexed/pending/garbage、单槽失败继续、跨重启显式恢复、授权 tombstone、无关键与原快照不变、slot 身份碰撞，以及原 A/B runner 隔离。

### 最终 seed consumer 的 clear admission

异步 `read()` 内部检查无法封住“已返回 snapshot，经 Promise 传递后才调用 seed consumer”这个窗口。新增 **`captureRead(key): () => boolean`**：在 memory peek / disk read **之前捕获一次**，返回的函数在最终 signal 写入前同步核验。clear 调用同步撤销所有旧捕获，即使 journal 写失败也不恢复；exact authorization retirement 同步撤销该授权，其他授权仍有效。clear 后新权威写入和新捕获继续合法。这个 token 只补 full-clear/retirement admission，不能替代原 Chat scope、authority、revert、messagesLoaded 等 guard，也不能在 `.then` 或 seed consumer 内重新捕获来接纳旧 snapshot。

当前生产读取追踪：`application.tsx` 的 Chat（session/assistant 共用）调用 `state.createChat`；唯一生产 history-cache reader 是 `state.ts`，其 memory `peek` 与异步 `read` 都交给 `seedHistory`。当前约 `state.ts:1447–1459` 的窄接线由主 owner 实施，和 attachments/send 区域不重叠；本 owner 没有修改 state。具体替换如下，保留原 guards 和 signal 写入：

```ts
const historySeedCurrent = historyCache.captureRead(cacheKey);
function seedHistory(snapshot: ReturnType<typeof historyCache.peek>) {
  if (!snapshot || !current() || messagesLoaded || messages().length || historyNeedsReset || !snapshot.messages.length) return;
  if (historyRevision && revertSource()?.messageID !== snapshot.revert?.messageID) return;
  batch(() => {
    // Final synchronous admission, directly before the first seed signal write.
    if (!historySeedCurrent()) return;
    messages.set(snapshot.messages); cursor = snapshot.cursor; more.set(!snapshot.complete); messagesLoaded = true;
    authorityMessageIDs = new Set(snapshot.messages.map(message => message.id));
    contactGeneration = snapshot.generation; contactRevision = snapshot.revision ?? -1;
    if (!historyRevision) revertSource.set(snapshot.revert);
  });
  // Keep the existing comment about unresolved/non-live presentation seeds.
}
seedHistory(historyCache.peek(cacheKey));
if (!messagesLoaded) void historyCache.read(cacheKey).then(seedHistory).catch(() => {});
```

Promise 交接回归使用真实 cache：read 完成最后 index 写入且返回旧 snapshot 后，先执行同步 clear 的 Promise consumer，再执行受 admission 保护的 seed-write consumer。断言 live authority 未变而 seed setter 未执行、新写入仍可读取。另覆盖 held memory peek + clear 首次 journal 失败、旧 token 永不恢复，以及 exact retirement 不撤销其它授权 token。该测试验证真实 cache 和 consumer 写入 seam；state 接线前不能宣称生产 consumer 的窗口已闭环。

admission 本轮结果：新增 3 项 pure consumer/cache 回归，合计 **37/37 focused Vitest 通过**，完整 `tsc --noEmit -p packages/nsh/tsconfig.json` 通过。没有运行 engine、设备、真实 Storage、Host 或 Git，也未修改 state/attachments/main；主接线后需由主 owner/oracle 复核生产 seed consumer。

最终完整 `tsc --noEmit -p packages/nsh/tsconfig.json` 通过。初次运行曾因并发修改的 `transcript-actions-backup.ts:13` 中 `Attachment.uri` 可为 undefined 失败；未修改该文件，随后主完整类型检查复跑通过。以继承同一 NSH tsconfig、仅 include `history-cache.ts` 的临时配置检查完整缓存依赖图也通过。dead-code 使用本机已缓存的相同版本 knip 及 package script 参数尝试运行，但启动时缺少 `formatly`，没有生成审计报告；遵守禁止 dependencies 的限制未下载或安装。没有执行真实 Storage 清理、NSH engine、设备、Host、凭据或 Git 操作。

## 验证

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/history-cache.test.ts packages/nsh/authorization-cache-cleanup.test.ts
swiftc -parse-as-library packages/nsh/ios/AuthorizationCacheCleanup.swift packages/nsh/tests/authorization-cache-cleanup/main.swift -o "$TASK_TEMP/authorization-cache-cleanup-tests"
"$TASK_TEMP/authorization-cache-cleanup-tests"
node packages/nsh/tests/authorization-cache-cleanup/check.mjs
```

Foundation 测试覆盖 forged/unclaimed ticket、旧 root owner、exact receipt、新 auth、pending 消失及重启不伪造 completion。Vitest 覆盖物理删除、失败与幂等恢复、冷启动 tombstone、迟到 read/queued write、其它授权引用和 partial failure。没有 NSH engine、设备、真实 Host 或凭据操作。主装配、真实 Storage 和原生回调闭环仍需主 owner 验证。

`check.mjs` 用内存 NativeShell handler/send stand-in 执行真实 wrapper，并使用本机 iPhoneOS SDK、iOS 15 target 类型检查 wrapper/helper；无 NSH engine。它不证明真实 NativeShell ABI 或生产 app 装配。

本轮验证：26/26 focused Vitest 通过；`check.mjs` 的内存 wrapper 执行和 iPhoneOS SDK 类型检查在上一轮通过，本次纯 TS root 修复未重跑 Swift；`./node_modules/.bin/tsc --noEmit -p packages/nsh/tsconfig.json` 通过。root controller 的纯测试覆盖订阅前置、flight 中及 finally 间的 tip、初扫失败/显式重试/单向 gate、销毁后禁止 ACK/ready、缺 handler、native retry 自回事件不循环，以及 cache ACK 成功后其它 native owner 失败跨空 tip 保留、显式 cleanup retry 成功后清除。真实 cache + 真实 cleanup runner 联合覆盖 A 永久删除失败/B 物理删除并 ACK/A journal 跨重启保留、新授权及其它 snapshot 引用不变；另覆盖旧 v1 garbage/pending owner 恢复、未知 owner 拒绝完成、删除后 journal 写失败不 ACK。未运行生产 root 的 NSH engine 或 UIKit 生命周期验证。

本机没有 knip，`dead-code` 脚本会下载依赖，遵守本任务禁止新增依赖的限制未运行。
