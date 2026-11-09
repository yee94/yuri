# 窗口 mounted writer 的业务离页协调

`desktop-writer-departure.ts` 只登记已经挂载的原业务句柄。它不是 native writer authority，不持有 grant、capability、target lock、draft、Storage 或第二 writer owner，不调用 acquire/renew，也不缓存 native 授权。原 claim 与 sticky unknown 始终由 Chat/new-session owner 持有。

## 冻结 API

```ts
const writers = createDesktopWriterDeparture<RouteLifetime>({
  scope: originalHostScope, // 稳定的原 Host/授权/代际身份；不能返回每次新建的对象
});
const unregister = writers.register(routeLifetime, {
  current: originalMountedOwnerCurrent,
  prepare: () => originalOwner.prepareRetirement(),
  canClose: () => originalOwner.canClose(),
  cancel: () => { originalOwner.cancel(); },
  release: () => originalOwner.release(),
});
const ticket = writers.capture({
  // 默认 prepare 全部 mounted owner，包括隐藏的草稿；正常 navigation 不传 select。
  // select?: tag => exactAdmissionSubset.has(tag),
  release: tag => actualRemovedLifetimes.has(tag),
  current: () => rootNavigationTicket === exactTicket,
}); // 有另一未结算 ticket / 已 dispose 则返回 null
```

`Tag` 是 main 持有的 opaque route/lifetime 标签，无推断路由语义。`capture` 冻结当时的 admission 集合和 release 子集、原 scope 与全 registry revision；新增/删除任何 registration 都让旧 ticket 过期，不临时接管新 owner。`release` predicate 缺省表示全部释放，适合 Host switch；push/Context/Timeline 等保留 owner 的导航须显式传 `release: () => false`。只读 panel 不登记 writer。临时模态不触发销毁，不 release。

registration 必须在 wrapper mount 时存在，不能等 acquire ACK / Chat 构造后才登记。new-session 尚未 constructed 或 acquire 在途时，用原 pre-source guard 明确返回 false；不能暂时伪装成无 owner。适配器只转发原 owner 的退休端口；新会话 release 走原 source 的 `releaseWriter()`，原 durable 留到真正 unmount 后才本地 close，不创建第二 session claim。native final cleanup 不得再调用业务 close/release。

## 普通导航

```ts
if (!ticket || !await ticket.prepare()) return false;
const admitted = await pageDeparture.request(
  () => {
    commitActualNavigation();
    ticket.finish(); // 恢复保留的 owner；不取消已 dispatch 的 release
  },
  () => ticket.current() && (ticket.canClose() || ticket.canCommit()),
  () => ticket.release(),
);
if (!admitted) ticket.cancel(); // 已 dispatch 则 false；只恢复未 dispatch 的 owner，不回滚 native custody
```

main 必须用真实 `removedRoutes`、inline home 退场和 Host switch 计算 release 子集。**所有捕获 owner 都 prepare 并最终 canClose**，故隐藏 retained owner 的 pending/unknown 同样 veto。仅 release 子集按注册顺序串行等待原 owner 的 ACK；成功前 UI/editor 不销毁。`canCommit()` 只在 release 子集全部确认且 scope/revision/exact ticket 仍有效时为 true，不读取已 release 的 `canClose`。`finish()` 在已准入的同步导航 commit 内调用，恢复未 dispatch 的 retained owner；不自动 reacquire，不再调用 release。

`prepare/canClose/release/canCommit/cancel/current/status/finish` 都属于捕获的 exact ticket。prepare/release 的重复调用复用各自 Promise；重放失败 release 不产生新 I/O。cancelled prepare 尚未 settle 时禁止新 ticket 复用同一 handle；旧 ticket 的迟到 cancel 不能取消新 ticket。`status()` 返回 `{phase,failure,owners,released,failClosed}`；`released` 只计已明确 ACK 的数量，不把未知当未写成功。

一项 prepare 失败/抛错、scope/registration/intent 过期会取消全部已尝试 prepare，保原稿与 unknown。release 部分失败则只取消**尚未 dispatch release** 的 owner（包括 retained 与尚未轮到的移除项），已 dispatch 的 confirmed/unknown owner 绝不取消、重试或 reacquire。原 native ACK 后 editor 最终 veto 时也须调用该 exact `ticket.cancel()`：它恢复未 dispatch owner，但返回 false 表示 native custody 不能完整回滚。在途 cancel 同样令 ticket 失效、阻止下一次 release，等待已发请求的 ACK，绝不取消那个原 owner。ticket 保持 `blocked/failClosed`，不 commit，原 UI/稿保留；已 release/unknown 的原 owner 必须只读，失败呈现由 main 消费 status。不能承诺全部 writer 已回滚为可写。

## 原生窗口关闭

1. capture 全部 mounted guards；`await ticket.prepare()`。
2. 完成其他原文件、设置、导航、layout 等 flush。
3. 最后同步检查 `ticket.canClose()` 与 exact native ticket；才发 `native closeDecision`。
4. veto、decision 失败或 ticket 过期：`ticket.cancel()` 恢复原准入，unknown 不变。
5. 真正 final-close ACK 后：`ticket.finish({closed: true})`，零 release/cancel；随后由原 wrapper cleanup **仅 retire**。不要把普通 `finish()` 用于 final native close。

`writers.dispose()` 只撤销 registration，并取消尚未 dispatch 的活动 prepare；不会 release。final close 若走 dispose 而没有显式 finish，原 owner 必须已由 cleanup 退休，不能让取消恢复新写准入。普通 navigation 不能用 dispose 替代 ACK。

## PageDeparture 的最小异步扩展

`desktop-page-departure.request(commit, validate?, beforeCommit?: () => Promise<boolean>)` 保留旧 caller 默认同步 release→commit 行为。传 hook 时，业务 `requestLeave` callback 只启动并登记 completion Promise；原 requestLeave 与该 Promise 都会被等待，异常不成为 floating rejection。editor 只在两者成功且最终 owner/Host/ticket/validate/**canClose** 均通过后 release→commit。无 editor 也等待 hook；native `requestClose` 不执行 hook 或 release。

第三参也保留原 Header/root adapter 透传的 opaque string 元数据兼容性：非函数字符串仍被忽略，不据它决定 Host switch、保留或移除哪些 route。真正的异步 hook 必须是函数；root adapter 自行消费其 action 元数据，再将实际 release admission 函数交给这个 helper。

**异步 hook 的 editor adapter 必须取得可复验的原 close grant。** 现 TaskEditor 的 `requestLeave`/discard 只校验 callback 当时的快照，不留下 close grant；main 应将该 adapter 的 `requestLeave(done)` 写为 `if (await originalWindowGuard.requestClose()) done()`，而不是先后调用两个确认。这样只确认一次，异步 release 后再次编辑会由同一 `canClose()` veto。没有可复验 grant 时 hook 路径 fail closed，旧无 hook 路径不变。`validate` 必须允许 `ticket.canCommit()`，不能只检查 release 后必然失效的 `ticket.canClose()`。

## 证据边界与工作量

focused Vitest 只使用业务 fake guards，不伪造 opaque grant；覆盖保留导航、精确移除子集、prepare 失败恢复、隐藏 unknown veto、迟到 ACK、scope/revision、exact ticket、partial fail-closed、原生 close 零 release、editor 在 ACK 前仍挂载、nested/late callback，以及 50 次无关 input/resize/status 读取零 prepare/release/cancel I/O。模块无 effect、订阅、timer、网络或 Storage；集合扫描只发生在显式捕获/离页准入，不接入输入或 resize 热路径。

`application.tsx` 已安装该 collector，prepare 全 mounted handles，仅 release 真实移除的 route/inline 子集；Header Host switch release 全部，Add/覆盖页保留。实际 Changes、Navigation、Header、Chat 与新会话等待期均有独立 production-root headless 回归，不再只是协调器 fake。它们仍不代表真实 Host/Vault durability、NSH AppKit/Win32 关窗或视觉已验收。NSH 0.4 工具链与上游保持不变。
