# NSH notification launch：native owner 交接

本文件描述 `NotificationBridge.swift`、`NotificationLaunchAPNS.swift` 和 `notification-launch-transport.ts` 的真实合同。main 已在创建 root controller 前安装唯一 delegate，通知 capture 读取连接的真实 optional authorizationID，并开放三个 launch capabilities；旧的即时 route 转发已移除。八类 producer/consumer 与 JS 根恢复仍由通知 root owner 整合，真正授权撤销时的定向清理尚待接线。

## 同一个 protected inbox

- `notification.live` 接收 `{lease,eventID,kind,target,admission}`。admission 按现 `admission-event.js` 逐字段验证，再与外层 eventID/kind/target 相等校验；不从 busy/idle、正文或历史推断通知。缺 proof 的 live 调用 fail-closed（测试通知独立）。JS delivery owner 需把已通过的 safe proof 显式传入，不能 spread raw event。
- OS `userInfo` **始终仅** `{v:1,receipt:UUID}`，identifier 为 `yuri.nsh.local.<receipt>`；OS 中没有 Host、directory、target、authorizationID、URL、正文或凭据。
- App 私有 Application Support 的同一个 inbox 持久化不可重定向的 record：

```ts
{ v:1, receipt, revision, connectionID, authorizationID,
  admission, createdAt, expiresAt }
```

时间为 epoch ms，TTL 七天。新 receipt revision=1；UUID 一经写入不可改目标。单文件 atomic commit，iOS 使用 `completeFileProtectionUntilFirstUserAuthentication`。外层 envelope 另有唯一 `queuedReceipt`，不是第二份通知队列；最新点击优先，不在成功消费后继续打开旧点击。最多 256 records；不驱逐当前 queued receipt。未知/target-only/legacy/额外字段 record 拒绝，读取失败不伪装空集合。

- 写 protected record **先于** OS add。OS add 失败、跨异步迟到时清理该精确 UUID，不清其他 record。磁盘清理失败不能声称已消费。
- `invalidate()` 只退役当前 runtime lease、claims 和 live 内存；**不删除**仍合法的冷恢复 record 或其通知。原生真正撤销授权时才 `try await retireAuthorization(connectionID:authorizationID:)`，只清理该旧绑定。通知层在同 inbox 持久保留 receipt tombstone，等 OS pending/delivered 回读确认缺席后才 ACK；失败保留 journal。重命名、短时断线和 reconnect 不能冒充授权撤销。事务、崩溃点测试与 main async 合同见 `NOTIFICATION-RETIREMENT.md`。
- native claim/ack 再检查当前选中 Host、稳定 authorizationID、真实 transport generation、前台状态、新 lease、TTL 与 queued receipt。ack 必须先有同 lease/revision 的 native claim，随后 CAS consume。nil authorizationID 不可导航，不能使用 editorVersion、Host ID、JS epoch 或旧 lease 代替。
- 锁屏后文件暂不可读时，delegate 在内存保留最新合法 receipt；后续 peek 重试读取/排队。若 OS 尚未允许持久化、进程又立即死亡，不能宣称这段内存已跨进程持久化。

## 精确 bridge 合同

以下三个 capability 由 main owner 加入 `nsh.json`：

```ts
notification.launch.peek({})
  // -> { record: NotificationRecoveryRecord | null }
notification.launch.claim({receipt, connectionID})
  // -> { record: NotificationRecoveryRecord,
  //      route: {hostID,lease,target} }
notification.launch.ack({receipt, connectionID, lease, expectedRevision})
  // -> {ok:true}; failed/stale/CAS mismatch throws, does not consume
```

`peek` 不要求已读到 JS Host scope；用于保留启动意图。claim 必须已经有根配置产生的 native lease。JS 用现 delivery.route 验证 route envelope，proof 仍交现 `createNotificationRecovery` / admitted resolver 处理。`notification-launch-transport.ts` 提供 `createNotificationLaunchTransport({call,scope,validateRoute})` 的 `peek/read/consume/isCurrent/invalidate/dispose`，可直接绑定既有 recovery 的 read/consume，**不再建立第二个 recovery controller/queue**。

**open 必须额外检查 `launchTransport.isCurrent(capturedReceipt)`；不成立时抛 stale，不能静默 return。** 现 recovery 的 current 只核 Host/authorization/generation/TTL，不知道异步 catalog lookup 期间是否发生同 scope 的 lease replacement。resolver 的 current 也应合并这一检查；native ACK 的最终校验不能代替导航前检查。成功 open 后 ACK 失败才可由既有 recovery ledger 避免重开。

其 scope 为 `{connectionID,authorizationID,generation}`，由 root 的真实 ready、前台和 native scope authority 门控；未 ready 返回 null。单一 root 在 `notification.launch.available` hint、根挂载、连接/授权/目录 ready 变化及显式重试时 peek。读未完成/错误不 consume；完整唯一 catalog 和 admission 的 directory/project/parent 绑定验证后才 open，随后 consume。没有首项目、首 Host、近期会话或裸 target fallback。继续复用原 observeRuntime，不能新增 SSE/polling。

delegate 不网络切 Host。JS Host 尚未读到、当前 Host 不符、已保存 Host 被移除、重新授权或 catalog 不完整时保留 receipt，交连接/恢复 UI 明确处理，不把通知路由到另一个 Host。已有 Web 的 newest-wins pending intent 同样不是跨 Host 身份验证。

只保留 **一个** JS tap handler：旧即时 `notification.route` 路径应由 root owner 切换到这个 pending-receipt 路径，不并发消费。构造函数旧 route 参数暂兼容 main 的现调用，但不再直接 fire；新 main 不必传入。

## main Swift 接线

在 `didFinishLaunchingWithOptions` 第一段、创建 root controller / 加载 bundle 之前：

```swift
NotificationLaunchDelegate.shared.install()
```

整个进程只有这个强持有的 OS delegate；`NotificationBridge` 复用它，root 未创建时默认抑制 foreground presentation。真实 UN delegate 的 didReceive 总会完成 OS completion handler，先验证 default action/本模块 ID/receipt，再入同 inbox；不进行导航或请求。若使用 Scene lifecycle，在现 willConnect 中补：

```swift
if let response = connectionOptions.notificationResponse {
    NotificationLaunchDelegate.shared.receive(response)
}
```

scene 与 UN delegate 重复报告同一响应幂等。不要把 `launchOptions[.remoteNotification]` 当“用户点击”或直接路由；那不是点击证据。当前 NSH main 没有 SceneDelegate，本轮没有擅自迁移 UIKit 生命周期。

构造函数与 scope（授权字段需连接 owner 提供后才能完成）：

```swift
let notifications = NotificationBridge(app: surface, capture: { [weak bridge] in
    guard let bridge, let selected = bridge.store.selected else { throw CancellationError() }
    let transport = try bridge.resourceTransport()
    return NotificationHostScope(hostID: selected.id, isCurrent: transport.isCurrent,
                                 authorizationID: selected.authorizationID)
})
// 继续强持有 notifications；现 onInvalidate 中 notifications.invalidate() 保留。
// 只有 owning 连接逻辑确认旧授权真正撤销时：
try await notifications.retireAuthorization(connectionID: oldID, authorizationID: oldAuthorizationID)
```

`SavedConnection.authorizationID` 是待连接 owner 提供的字段，不是本轮已存在 API。缺失时 `NotificationHostScope` 的 optional 默认为 nil，不能冷恢复/发可导航 live 通知。不能为“让测试通过”填固定常量。root/capability 与 native binding 合并前，本轮不声称生产冷恢复已装配。

## APNs：现有协议与阻塞

证据：

- `packages/mobile/ios/App/App/AppDelegate.swift` 将原生 device token/error 转给 Capacitor；`useNativePushRegistration.ts` 经 `createWebPushAPI` 注册实际 installed bundle ID。
- Host `notifications/routes.js` 已有认证 `POST /api/push/apns-token`（token/platform/locale/bundleId）和 `DELETE`（token）；`apns-runtime.js` 持久化/绑定 Push Relay。**该 POST 的 `{ok:true}` 不保证 Push Relay 绑定、Apple 接受或真实送达。**
- `notifications/APNS.md`：Capacitor iOS 的挂起/关闭通知依赖 APNs，前台 presentationOptions=[]；普通 Web 的 SSE/页面和本地通知不能在 iOS 挂起后持续获取新事件。现 Android notification-only foreground SSE 不是可移植到 iOS 的后台保活方案。
- Host `runtime.js` 的普通 APNs data 仅保留 sessionId，联系人为 assistantID/url；没有 connection/authorization proof。不能将这些 payload 归属到“当前 Host”，也不能伪造成本地受保护 receipt。
- 产品默认 Workers Relay 只提供数据传输；现 APNs 文档要求独立已验证 Push origin 或 direct credentials。NSH 的 bundle ID 为另一 App，App ID/topic、profile/entitlement、证书、environment 和 Push origin/allowlist 均未在本轮验证。没有签发资源、读取凭据或新建云服务。

新增 Foundation-only `NativeNotificationAPNSRegistration`：

```swift
func begin(_ context: NativeNotificationAPNSRegistration.Context) -> Bool
func didRegister(_ token: Data) async
func didFailToRegister()
func invalidate()                         // synchronous generation fence
func cancel() async -> Bool               // captured Host DELETE, not OS unregister
```

Context 包含 hostID/installed bundleID/locale、native-only `verifiedPushConfiguration`、isCurrent，以及注入的 captured authenticated POST/DELETE transport。它不调用 OS、不请求权限、不访问网络、不把 token 发给 JS/日志/磁盘。`begin` 只有已验证配置才允许 caller 发行一条 OS registration；旧 OS callback 未 drain 时不能发行另一请求，避免无 ticket 的 AppDelegate callback 归错 Host。POST 在途被退役不会发布 hostAccepted，保留 cleanupPending；取消失败不得借新 Host transport 清理。先 await cancel 再退役旧 transport；已失效则显式保留 cleanupPending。

现 `resourceTransport` 只有 GET/read，不能拿它伪造 token 注册。本轮未修改 RuntimeBridge 新增写 transport，未接实际 registerForRemoteNotifications；仍为阻塞，不能给 backgroundPush:true。native 未来 didRegister/didFail 只能转给这个 owner，并显式区分 OS registration 与 Host ACK。远端点击仍缺 Host 绑定协议，待 owning Host/连接合同补齐，不能用 helper 合成伪成功。

## 验证与未完成范围

- 已运行：纯 Vitest（launch transport + 既有 recovery）、Foundation durable inbox / synthetic OS payload / proof/TTL/authorization/CAS/失败原子性 / APNs captured-transport fence，单独 Apple SDK typecheck（stub NativeShell，不运行 UIKit、engine 或 main）。
- 未执行：真实 permission、通知、APNs、后台挂起交付、杀进程实际点击、真实 Host/Relay、网络、设备、UIKit app、NSH engine、main build、签名/发布。Foundation 重建 inbox 只是模拟进程重建，编译不是送达证据。
- 待合并：连接 owner 稳定授权代际的完整验证、真正撤销授权后的定向清理、root admitted proof 透传和唯一 recovery handler。三个 capabilities 与 main 早期 delegate/capture 已接入；旧即时-route fixture 仍需 root owner 随消费合同更新。
- main 接线复验：`notification-swift.test.ts` 与 `notification-launch-transport.test.ts` 共 10 项通过，包括真实 Apple SDK 对 main 装配的类型检查。此项没有运行通知权限、OS 送达或杀进程点击；授权撤销清理和 JS root 完整链仍未签收。
- dead-code 的 pinned knip 本机未安装，未用 bunx 下载（用户禁止网络/依赖变更）。新 transport 为待接线交付，不把未使用导出假装成已装配。

本轮最终 focused run：launch transport、launch Swift、既有 global recovery、preferences 共 **23 项通过**；旧 Foundation policy 另 **1 项通过**（含 main 的旧 SDK 综合测试未运行）。strict TypeScript 通过。曾扩跑 `notification-core.test.ts`，其 4 项旧 fixture 因并行 owner 已强制 admission proof 而尚未传 proof 失败；未越界修改该文件，不能据本轮 focused run 宣称全量通知测试通过。

证据等级必须分别记录：前台被抑制/本地 OS add 接受、运行中的本地事件、挂起 APNs 交付、杀进程点击恢复、OS token 注册、Host ACK、provider/APNs 接受、用户设备真实送达。任何一项通过都不替代其它项；未完成能力保留，不缩范围。
