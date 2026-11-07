# 持久授权退役 journal 与 main 接线

通知 owner 后续已修复本文记录的 receipt 删除→OS 删除崩溃窗口：同 inbox 保留 `pendingRetirements` tombstone，OS 两份回读确认后持久 ACK；Bridge 方法升级为 `async throws`，调用需 `try await`。下文原批次的窗口描述保留为历史证据，最新实现、限制与测试见 `NOTIFICATION-RETIREMENT.md`。本更新不改变 store journal API。

## 所有权与存储合同

第一阶段修改 `ios/ConnectionStore.swift`、`ios/connection-editor.swift`，增加专属测试与本文。追加授权后，第二阶段仅修改 `ios/RuntimeBridge.swift` 的 retirement 字段/status/retry 和成功 mutation 后的退役调用，接通 durable journal。没有修改 NotificationBridge、main、application、Relay，保留 GUI 独立 Relay lanes/字节 drain/strict streams、terminal、ASR 的现有实现与无关注释。

退役元数据并入已有单条 Keychain records 原子存储，字段为：

```json
{
  "connections": [],
  "pendingAuthorizationRetirements": [
    {"connectionID": "connection-id", "authorizationID": "retired-authorization-id"}
  ]
}
```

`AuthorizationRetirement` 仅包含精确 connectionID 和 authorizationID，不保存 token、URL、Relay 信息、通知正文、scope lease、wall clock 或错误内容。字段为 1–128 bytes 的 ASCII 字母/数字/下划线/连字符；authorizationID 不接受 `legacy`。条目严格解码，不接受额外字段；旧 records 缺 journal 字段默认 `[]`，不在读取/启动时重写旧数据，不为 legacy nil 生成退役身份。显式 null、重复、超量和与仍有效授权冲突的 journal 都明确读取失败，不能被当作空成功。

`ConnectionEditorRecords.commit` 在同一个同步事务内比较旧 records 与候选 records，追加被删除或被新 authorizationID 替换的旧授权，再编码整份 records、调用原 persist，成功后才发布新内存状态。save、显式 replace、remove 均经过它；普通 rename、select、lastUsedAt 和后台 transport invalidation 不制造退役。独立授权成功后的重新配对即使 token 相同也轮换 authorizationID，旧代际仍记录。相同 authorizationID 下直接替换 credential/origin/Relay 被拒绝，不能复用旧授权身份。

原有 pending 在普通 commit 中始终保留，不能因为调用者构造新 records 候选而消失。journal 最多 1024 条；空间不足则撤销本次 mutation 的全部提交，保留旧连接/选择/凭据与全部 pending，不写入、不退役、不淘汰记录。错误 `authorization_retirement_capacity` 必须对用户可见。清理 pending 后用户可再次明确尝试原操作，不能后台重放 remove/replace。

同设备经不同 Relay 连接仍使用原有 `RelayConfiguration.scope` 分别存储不同 connectionID 和 authorizationID；单个授权退役/ACK 不会合并或撤销另一 Relay 的授权。未更改 scope/配对规则。

## Native 最小 API

```swift
// 只读值快照；不暴露 JS mutation authority。
store.pendingAuthorizationRetirements // [AuthorizationRetirement]

// 仅在实际通知清理成功后，确认这一精确 pair。
try store.acknowledgeAuthorizationRetirement(
    connectionID: retired.connectionID,
    authorizationID: retired.authorizationID
)
```

ACK 只从 journal 移除该 pair，不改变连接、选择、editorVersion、authorizationID 或 runtime scope。未知/重复 ACK 是无写入 no-op；ACK persist 失败保留内存和持久 pending，调用者必须看到失败，下次只重复幂等 cleanup+ACK，不重放原 mutation。A1→A2→A3 后迟到 ACK A1 不会移除 A2 的 pending 或影响有效 A3。

## RuntimeBridge 消费与 main 最后接线

追加实现已移除 RuntimeBridge 的进程内待办字典和旧 snapshot diff。`retryAuthorizationRetirements()` 每次读取完整 `store.pendingAuthorizationRetirements`；成功 remove、save/replace 后也使用该入口。persist 失败发生于调用 retry 前，不会触发未提交授权的 cleanup。

两个 process Set 仅保存精确 pair 的 in-flight 去重与本轮 failure，不是待办来源。retry 从当前 pending 修剪过期 failure；同 pair 的重叠 retry 不重复调用正在进行的 cleanup。cleanup 和 ACK 错误在单项内处理，不阻断后续完整项；失败项留待下一次显式 retry，不在一次 drain 内无限重试。回调和其返回后的 ACK 都检查调用任务取消，取消保留 pending。没有依赖当前选择、最新 authorizationID 或 runtime scope 猜测旧授权。

`authorizationRetirementStatus` 和 snapshot 的 `authorizationCleanup` 以 durable pending 数量为准；failed 只统计仍 pending 的失败项。没有 hook 时所有 pending 明确标为 failed，即使 process Set 为空也不会显示假零。事件仍只有 pending/failed 计数，不携带身份或错误内容。rename/select/background 不制造退役，也不因普通重启清理仍有效授权的通知。

**Runtime 现在拥有 ACK，main hook 只负责真实通知清理。** Runtime 内部顺序为：

```swift
try await notifications.retireAuthorization(
    connectionID: connectionID,
    authorizationID: authorizationID
)
try Task.checkCancellation()
try store.acknowledgeAuthorizationRetirement(
    connectionID: connectionID,
    authorizationID: authorizationID
)
```

以上是顺序示意，不应把第二步再次塞回 main hook：Runtime 在 `try await onAuthorizationRetired(...)` 成功后调用 store ACK。任一步失败 Runtime 均保留 pending 与 failure；ACK 写失败不撤销已经成功的连接 removal/replacement，只保留再次清理的 pending，绝不重放该 mutation。通知回调的 async throws 类型保持不变。

已只读核对 main 当前接线：真实 hook 内 `try await notifications.retireAuthorization(...)`，安装后 cold-start `Task { [weak bridge] in await bridge?.retryAuthorizationRetirements() }`，`resumeRuntime` 也调用同一入口；本 owner 未修改 main。弱引用丢失须 throw，不能假成功。不需要另加 store ACK，也不应在 hook 未安装前把 retry 当 ready。最终 main build 与真实通知验收仍归 main。

## 通知幂等证据与未闭环窗口

只读核对 inbox 的授权筛选：仅筛选 `connectionID == id && authorizationID == authorization`，其余记录与非目标 queued receipt 保留。兼容的 `retireAuthorization` 第二次清同 pair 返回空 newly-retired 数组，不会删除同连接另一 authorization 或另一连接同 authorization。新增测试直接运行生产 Foundation inbox 的 retire/filter/commit 逻辑，仅以内存替代磁盘 I/O，证明 store ACK 失败后跨重读重清不会误删其它授权。

第一阶段发现的 inbox 删除 receipt 到 OS 删除之间崩溃窗口已交 Notification owner。当前源码已由它新增 staged `beginRetirement` / `acknowledgeRetirement`、持久 receipt 待办和 async `NativeNotificationRetirementCleanup`；主 NotificationBridge 也已改为 async。本 owner 未修改或运行系统通知，不能把 store/Runtime 纯内存测试扩展为 OS pending/delivered 物理回收证据；通知 owner 的独立验收与 main 最终组合验收仍须保留。

## 编译与验证边界

没有新增生产 Swift 文件。原有 `ConnectionStore.swift` + `connection-editor.swift` 编译清单不变；原生 build 的 `ios/*.swift` glob 无需修改。只编译 ConnectionStore 头部类型或用替身的消费者仍应带上 connection-editor（原先已有依赖）；其新增 `AuthorizationRetirement` 无额外模块依赖。

专属 `authorization-retirement-native.test.ts` 仅替换生产 ConnectionStore 的 Keychain initializer/persist，静态断言替身中没有 Security/SecItem/kSec。通知 inbox 替身仅替换文件读写，保留生产 decode、record、retire 和 commit 发布顺序；不链接或执行系统通知。测试还实际启动两个独立 Foundation 子进程，用 stdin/stdout 传递合成 records bytes，验证退出后重读不依赖 Runtime ledger。全部凭据、Relay、域名都是固定 synthetic 测试值，不连接网络。

Apple SDK 检查只 typecheck 生产 store 与 records，不执行 Keychain；未运行真实通知、Host、engine、device、main build、Git 或依赖安装。系统 Keychain 与通知物理行为仍由 main 最终运行验收。

实际聚焦验证：

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/authorization-retirement-native.test.ts packages/nsh/connection-editor-native.test.ts
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-voice-recognition-transport.test.ts -t 'authorization-(legacy|roundtrip|replacements|failed-write|remove-readd)'
```

第一条 2 文件 / 14 项通过（含生产 store Apple SDK typecheck）；第二条既有 RuntimeBridge 的纯内存 durable authorization 场景 5 项通过，其余 102 项未选。覆盖旧无字段与 nil、save/remove/replace 写失败、凭据/origin/Relay/key 替换、非当前授权替换、A-B-A、A1-A2-A3 迟到 ACK、ACK 写失败、满队列拒绝撤销且允许 rename/select、超量/非法 decode、同设备不同 Relay 独立记录与 inbox 精确幂等过滤。生产 records.commit 同 authID 下改 token、URL、Relay 三条路径均断言不触碰 persist。

实际调用同模型 `magpie-remote-magpie%2Fcodex/codex/gpt-6.1-sol` 的独立只读 reviewer 会话 `ses_e4a27a036ffex1j3m27ToZSKK0` 完成两轮审查。首轮确认 store/records 无确定性阻塞，提出的覆盖建议已加入上述断言；最终复核重新读取测试与交接合同，确认相符，未发现新增实际阻塞。两轮均仅 read/grep，没有执行测试，不能作为独立运行证据。通知 receipt 删除后、OS 删除前的崩溃窗口也经 reviewer 只读核对，仍交 main/Notification owner 协调。

没有运行 `dead-code`：本地未安装该脚本所需 knip，禁网络/依赖安装下不触发 bunx 下载。新增文件仅为测试和本文，生产 Swift 编译清单不变。

## Runtime 追加交付验证

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-voice-recognition-transport.test.ts packages/nsh/authorization-retirement-native.test.ts packages/nsh/connection-editor-native.test.ts
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/terminal-runtime.test.ts -t '^production successful-persist-only authorization retirement'
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/resource-web-preview-swift.test.ts -t '^typechecks the full iOS'
```

最终第一条 3 文件 / 134 项通过（原 native transport 107、新 Runtime retirement 13、store/connection-editor 14）；第二条 7 项通过、56 项未选；第三条 1 项 iOS SDK 组合 typecheck 通过、4 项未选。没有执行 WebKit probe、NSH engine、真实网络、Keychain、通知、设备、main build 或 Git。

新增 `tests/runtime-authorization-retirement.swift` 是独立纯内存 @main runner，生产源码依然是当前 RuntimeBridge/ConnectionStore/records；只替换 Keychain I/O 与声明 NativeShell handler/event。13 项覆盖：冷恢复完整 journal、hook 缺失、cleanup 失败、ACK persist 失败后重建 runtime、失败项不阻成功项、重叠 retry 精确去重、旧 A1/A2 完成不伤当前 A4、rename/select/background 与 legacy nil 不制造退役、成功 remove/connect 消费完整 backlog、失败 mutation 零 cleanup、实际 Task.cancel 后保留 pending。事件断言只有安全计数。

旧 `tests/settings-voice-recognition-transport.swift` 的 main 入口不增加对 retirement runner 的依赖，GUI/terminal 编译消费者继续原样使用它；仅 `settings-voice-recognition-transport.test.ts` 在同一纯内存生产依赖集上分别编译两个 runner。独立 store 真实源码派生保留 pending/ACK API，没有 fake 当前授权或伪 receipt。terminal 既有授权回归已实际编译/运行通过。

Runtime 追加任务实际续同模型/同 reviewer 会话两轮只读审查：首轮确认 durable 源、status、精确 ACK、重入与失败隔离无确定性阻塞；最终复核确认双 runner 隔离、旧 GUI/terminal 消费者清单与 main await/启动接线相符，无新增实际阻塞。review 仅 read/grep，没有运行测试。串行 retry 仍须等待通知 hook 返回，纯内存取消测试不替代该 hook 的真实系统完成/取消时序验收；本 owner 没有添加猜测性 timeout 或新通知调度器。
