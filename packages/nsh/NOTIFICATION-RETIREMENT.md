# 通知授权退役：receipt tombstone 与 OS 回读确认

## 已修复的崩溃窗口

旧路径先从 inbox 持久删除 receipt，随后调用 OS remove。两步之间进程退出时，连接 journal 仍有精确授权对，但已无法找回系统通知 identifier。

现在 `ios/NotificationBridge.swift` 使用原 inbox 的同一个原子文件保存 `pendingRetirements`：

```ts
{ v: 1, records: [...], queuedReceipt: string | null,
  pendingRetirements: [{ connectionID, authorizationID, receipt }] }
```

该字段缺失的旧 v1 envelope 默认 `[]`，只读取不重写；显式 null、额外字段、非法身份、重复 receipt、与活跃 record 的 receipt 冲突或超过预算都拒绝，不伪装为空成功。字段只含精确 pair 与 UUID，不含正文、URL、凭据、lease 或消息 proof。

`beginRetirement` 在一次 commit 中把目标 pair 的所有 live records 转为 tombstone，同时清除属于这些 records 的 queuedReceipt。其余 connection/auth 的 records 和当前 queued receipt 保留。commit 成功才更新内存；失败保留原内存与文件，不调用 OS 删除。tombstone 不出现在 pending/peek，receive/claim/consume 不能使其恢复导航；普通 remove/迟到 add cleanup 也不能清掉 tombstone。

live records + tombstones **共用原 256 项预算**，没有第二个无界队列。begin 是等量转移，不额外占容量。普通新增只能沿用原规则驱逐非 queued live record，不能驱逐 tombstone；预算全被 tombstone/当前 queued 占用时新增明确失败，保留 prior。live record 的七天 TTL 不变；tombstone 不能因七天到期被删，必须保留 identifier 直到 OS 确认和持久 ACK。仍保留原文件 8 MiB 读取上限和 iOS 文件保护写入。

## Typed 事务

```swift
let batch: NativeNotificationLaunchInbox.RetirementBatch =
    try inbox.beginRetirement(connectionID: id, authorizationID: authorization)
// batch.connectionID / authorizationID / receipts / identifiers
// identifiers 只在这里由本模块 prefix + receipt 构造。

try inbox.acknowledgeRetirement(batch)
```

begin 重试返回该 pair 尚未 ACK 的全部 receipt IDs，进程重读后仍相同。ack 仅移除 batch 指定且 pair 完全相同的 tombstone；迟到 ACK 不影响另一 pair 或新授权。重复/未知 ACK 是无写入 no-op。ACK persist 失败保留内存和持久 tombstones，让调用者看到错误。

旧 Foundation `inbox.retireAuthorization(...) -> [String]` 保留源码兼容，返回本次新转入 tombstone 的 receipt；它不等于 cleanup 成功，重试系统清理必须使用 typed begin 的全部 pending batch。Bridge 已使用新路径，不能再根据旧方法返回空数组 ACK 连接 journal。

## OS 删除确认与在途 add

本机 Apple SDK 的 `UNUserNotificationCenter.h` 明确：

```objc
- (void)removePendingNotificationRequestsWithIdentifiers:(NSArray<NSString *> *)identifiers;
- (void)removeDeliveredNotificationsWithIdentifiers:(NSArray<NSString *> *)identifiers;
- (void)getPendingNotificationRequestsWithCompletionHandler:(void(^)(NSArray<UNNotificationRequest *> *requests))completionHandler;
- (void)getDeliveredNotificationsWithCompletionHandler:(void(^)(NSArray<UNNotification *> *notifications))completionHandler;
```

两个 remove 都没有 completion。本次实际 Bridge 路径：

1. 原子 begin，退役该 pair 的 live entries/claims；只有当前配置 pair 同时匹配时 invalidate，不误伤同 Host 的新授权。
2. await 该批 receipts 的在途 `center.add` task settle。add 失败也继续幂等移除；不把 add 失败视为已删除。否则 remove/read-back 可能早于迟到 add。in-flight add 最多 256，满预算明确失败，不淘汰尚未结束的 task。
3. 仅向 OS removePending/removeDelivered 传该 typed batch 的精确 identifiers，不使用 removeAll、前缀全扫或重启全清。
4. 通过原生 Swift async overlay 等待 getPending/getDelivered callback 回读，核验两份结果均没有任何目标 identifier。没有 sleep、timer、猜完成或自动 busy-loop。
5. 只有目标全消失才执行 notification tombstone 持久 ACK，然后 Bridge 成功返回。若仍可见、回读失败、Task 取消或 ACK 写失败则 throw，保留 notification/store journal；上层只显式 retry 相同 pair，不重放原连接 mutation。callback 一直不返回时不产生成功 ACK。

`NativeNotificationRetirementCleanup.run` 是生产与 Foundation synthetic OS 共用的上述 begin/settle/remove/read-back/ack lane；测试只替换存储 I/O 与 OS closures。它不创建新 observer、后台循环、权限请求或 Host 请求。

## main / Runtime owner 精确合同

Bridge 的签名现为：

```swift
@MainActor
func retireAuthorization(connectionID: String, authorizationID: String) async throws
```

既有 `onAuthorizationRetired` async hook 中的顺序：

```swift
guard let notifications else { throw NativeFailure.message("notification_unavailable") }
try await notifications.retireAuthorization(connectionID: connectionID, authorizationID: authorizationID)
// 仅以上 await 成功后，由 store owner ACK 同一个 pair：
try store.acknowledgeAuthorizationRetirement(connectionID: connectionID, authorizationID: authorizationID)
```

若 store ACK 在 notification ACK 后失败，连接 durable pair 仍保留；下一次 cleanup 无 pending receipt 时幂等返回，再精确 store ACK。两个 store 独立，但通知 IDs 在 OS 未确认前不会丢。Runtime 必须仍以 `store.pendingAuthorizationRetirements` 为 durable 源，未安装 hook/weak owner 缺失/任何 throw 都不能清 journal。

main 最新 callback 已使用 `try await`；本 owner 未改 main/runtime/ConnectionStore/connection-editor。任何 SDK 隔离 stub 若替代 NotificationBridge，只需把同名方法改成 `async throws`；已有 async callback 类型无需改，不能在 stub 中吞错或添加成功常量。main 综合 SDK fixture 由 main owner 更新/执行，本轮只 typecheck 实际通知桥与 NativeShell 最小声明，不构建/运行生产 main。

## 验证与证据边界

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/notification-retirement-native.test.ts \
  packages/nsh/notification-launch-swift.test.ts \
  packages/nsh/authorization-retirement-native.test.ts
```

本轮三文件 **28 项通过**：新 retirement 13、既有 launch Foundation/Apple SDK 2、authorization retirement/store SDK 13。新测试编译实际 Foundation inbox/cleanup lane，仅把文件 I/O 换内存 fake persist、OS 换 fake closures；旧 launch 测试使用合成文件并重读，不运行 UserNotifications。覆盖 begin 后退出重读、独立 Foundation 子进程重建、OS after/before ACK、ACK persist fail、读回仍可见/失败、begin write fail、精准 pair/迟到 ACK、旧 envelope 默认值、非法/超量、256 预算、当前 queued 被撤销不复活、非目标 queued 保留、迟到 add settle 顺序和取消保留 journal。

本轮没有真实通知、权限、Keychain、Host、网络、engine、设备、main build、Git、依赖变更。Apple SDK 通过只证明声明及类型匹配；fake OS 回读只证明控制流和 journal 行为。系统 remove 调用不等于已删除，回读结果只提供本次 OS snapshot 目标缺席的证据；真实设备物理行为、系统进程重启/强杀时序仍未验收，也没有任何 APNs 投递证据。
