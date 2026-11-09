# 主 Chat writer controller（main 接线 API）

`desktop-chat-writer.ts` 的 `createDesktopChatWriter` 只管理原主 Chat 的 native claim 生命周期。只读 panel、iOS 不经过它；不拥有第二 Chat、draft、sync、Storage、全局 registry 或窗口目录。第二生产窗 / MiniChat 仍禁用。

## 冻结 API

```ts
const writer = createDesktopChatWriter({
  client: () => windowWriterClient, // root 唯一 loadNativeDesktopWriterClient 的结果
  capabilitiesReady: () => rootDiscoveryFinished,
  target: { kind: 'session', id: sessionID }, // 或 assistant；原始未编码 ID
  committedRuntimeScope: () => app.runtimeScope(),
  stableAuthorityIdentity: () => stableHostOriginAuthorizationKey,
  current: stableMainRouteOwnerCurrent,
  handoff: originalNewSessionHandoff?.desktopWriter,
  renderChild: (writerGrant, writerUnknown) => constructOriginalChat({ writerGrant, writerUnknown }),
  scopeReady: scope => rebindOriginalStateLaneAfterAck(scope),
  changed: invalidateWriterPresentation,
});
await writer.reconcile(); // ready 是同一方法；同一在途 intent 共用 Promise
writer.child(); // 第一次 verified ACK 后只构造一次，续租/模态不重构
writer.status(); // phase / constructed / writable / pending；不含 native grant 字符串
writer.grant(); writer.markUnknown(cause);
```

main 在 stable route owner 下创建一次 controller。只在 root discovery 完成 / committed scope / stable route lifetime 变化时显式 `reconcile`，不在每个输入、modal、active 或后台切换时建 controller。`changed` 只发布窄 presentation invalidation，不创建 Chat。

NSH 产品接线优先用 `desktop-chat-writer-native.tsx` 的 `NativeDesktopChatWriter`：同形 getter/target/handoff/scopeReady props，另收 `onOwner(owner)`（可返回精确 unregister）、`waiting(status)` 与 `children(grant, markUnknown, owner)`。内部只有 admitted 的单向 false→true 分支，真实 children 在 mounted NSH owner 中构造，不在 acquire 的 async continuation 中注册 cleanup/effect。waiting 由 main 交既有文案；children 中 `owner.bindBusiness(chat, additionalCanClose)` 接原业务退休端口。wrapper cleanup 只 retire；不自动 release。

`renderChild` **之前**不允许 construct 原 Chat / `openDraft` / restore。它收到稳定 getter 和原 claim 的 sticky unknown 标记；main 把这两个依赖交给原 `createChat`，transcript history 原 PageOperation 也须使用同一 getter。等待 UI 由 main 沿用既有 loading/unavailable/error 文案 key，区分 `capabilities-loading`、`waiting-scope`、`unsupported`、`denied`、`unknown`，不新增入口。controller 本身不构造 UI。

`scopeReady` 为同步 ACK 后通知，第一次可无已构造 Chat；续租时 main 调原 `chat.rebuildOperationLane()` 并重绑原 PageOperation/HTTP lane。不关闭 durable draft、不重新 restore。即使外部尚未 reconcile，scope 不同的 getter 已同步返回 null；renew await 期间旧 opaque grant 已失效，已构造 Child 保留。新 Host/origin/auth 或 target 只能退休旧 owner，不能靠 renew 接管旧 draft。

## 新会话 handoff 的所有权前提

只传原 new-session custody 实际生产的 `DesktopWriterClaim`；不手写 metadata，不发第二 session acquire。controller 检查当前 route/authority、native window、target、scope、ownerID，并通过真实 opaque transport receipt 验证来源（只做本地 begin/finish-not-dispatched，零 native call）。过期/错 target/错 scope/伪造 grant 拒绝构造，不动原 claim。

**原 producer 的 `claim.current` 必须已经交接到稳定主 route lifetime。** 若它仍闭包引用已卸载的新会话页面 owner，原 grant 会永久退休，consumer 不能修复；main/new-session worker 必须在转移时保证该前提。不能把 modal/后台 active 当 current。

## 退休与关窗

```ts
// 所有已有 UI、附件、history、文件等异步业务 guard 先完成；再捕获 exact owner/scope。
const prepared = await writer.prepareRetirement(chat, additionalCanClose);
// chat 只需 prepareWriterRetirement / canReleaseWriter / cancelWriterRetirement 三个原方法。
// 或 ChatOwner mount 时 writer.bindBusiness(chat, additionalCanClose)，onOwner 注册的 handle 可无参 prepareRetirement()。
// bindBusiness 返回匹配原 binding 的卸载函数；同一 controller 不可同时绑定两个业务 owner。
if (!prepared || !writer.canClose()) { writer.cancel(); return false; }

// 普通 route 离页：最终复验 -> 原生 release ACK -> 才 commit。
if (!await writer.release()) { writer.cancel(); return false; }
commitRouteDeparture();

// 原生关窗：绝不提前 release。
// prepare -> 其他根 flush -> 最终 canClose -> native closeDecision。
// native final-close ACK 真正成功后只 writer.retire()，Rust 已经清理。
// native veto/失败则 writer.cancel()，原 Chat/draft/claim 继续使用。
```

prepare 同时暂停 getter 并调用原 Chat 的 durable flush；只有原业务确认、本地 claim pending/unknown/current 与 additional 最终复验全部通过才可 release。cancel 恢复原 Chat 准入但从不清 unknown；release 已开始时 cancel 返回 false，不可在 native custody 未决时重新开放。失败保原 Child/draft 和 receipt；unknown 不自动重发。

`retire()` 同步撤销使用、零 native I/O，cleanup 只调用它；**禁止 cleanup 自动 allowed:true release**。未构造 Chat 的 late acquire 可由 main 在确认无业务 owner/安全 guard 后显式 `await writer.close({allowed})`，等待原 receipt 后只清理原 client/authority/scope，绝不借新 client。已构造 Chat 的 close 返回 false，必须走 prepare/release。native closeTicket/window guard 与 `pageDeparture` 注册由 main 负责。

## 验证边界

focused tests 使用真实 `loadDesktopWriterClient` + `StrictWriterHost`，不伪造 opaque grant。独立 NSH fixture 的 macOS/Windows headless 验证不等于生产 application 接线、真实 Host/Vault 磁盘、系统关窗或多窗签收。

本轮结果：`desktop-chat-writer.test.ts` 19 场景、`desktop-chat-writer-state.test.ts` 4 场景均通过；后者实际构造原 `createChat`、原 durable 与 native verified writer transport，证实 prepare 的 getter=null 不会阻塞现有 laneCurrent/flush，覆盖原 history guard、Storage 失败保稿、取消恢复和真实 interrupt unknown veto。与既有 writer core/transport 合跑为 72/72。完整 package TypeScript `--noEmit` 通过。

`desktop-chat-writer-native.test.ts` 包装真实 NSH 0.4 runner 的 4 场景（Mac/Windows 各正常/坏 ACK），已通过。fixture 的 adapter 只延迟交付原 `StrictWriterHost` ACK，不发明 grant，也不把未支持 capability 设 true；NSH 单一 Host-handler 调度循环不能用阻塞 handler 的 gate 同时驱动下一交互，所以延迟放在 fixture 内的 transport adapter。原 `openDraft` 的 Storage getter/setter 可观测：ACK 前零 I/O；正常输入仍保留原 300ms durable flush/CAS，不伪称输入永不落盘。续租保同一 mounted child/durable，旧 opaque 对象在两个 scope 都拒绝。

state 已补齐同身份 committed lease 变化时的 retained suspension，区分 resume 早于/晚于 renew ACK 的因果顺序；main 的 `scopeReady` 接回同一个 Chat 的 `rebuildOperationLane()`。重复重绑返回 false 可表示 lane 已就绪，不当成 denied；合同及回归见 `state-writer-DOCUMENTATION.md`。`dead-code` 已尝试，但仓库配置加载因既有缺失 `vite-plugin-pwa` 中止；未安装依赖。

## 实际根消费

`application.tsx` 已安装正式 `NativeDesktopChatWriter`：verified ACK 前不构造 Chat/读取 durable，之后只恢复一次；Chat 与 transcript PageOperations 共用同一 getter。wrapper 从 mount 起登记到唯一 mounted guard collector，inline Assistant、普通 route 与新会话 handoff 保持各自精确 lifetime。临时模态不 release；真实移除子集与 Host 切换等 ACK 后才 commit；原生关窗只 prepare/最终复验。Header/Navigation 实际根覆盖 ACK 等待、关窗拒绝后继续编辑、同身份 renew 保原稿及零第二次 hydrate；这些 headless 证据不替代真实 final-close、冷恢复或第二生产窗口。
