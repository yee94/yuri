# NSH 通知：生产装配与验收边界

前两节保留 root/Basic 基线供核对。最新 root 已替换为 admitted-only、复用唯一 protected-receipt recovery；native owner 已升级完整 v1 record。main owner 已接最早 delegate install、真实 authorizationID capture、去掉旧 route 转发并加三个 launch capabilities；该 owner 的 SDK 证据见 `notification-launch-INTEGRATION.md`。本轮不改 application/main/Swift/state。application 仍需下述 catalog/readiness props；之前的 raw/target-only 路由不再作为兼容发送路径。

## 原 root/Basic 基线（原生最新接线见下文）

- `ios/main.swift` 强持有 `NotificationBridge`，在 bundle 加载前注册。capture 取当前 Host ID 和真实 `RuntimeBridge.resourceTransport().isCurrent`（捕获 native generation），只把受控 `hostID/lease/target` 发送到 JS。
- 原 `bridge.onInvalidate` 增加 weak notification capture 与清理；Diagnostics、appearance、resources、web preview、speech、desktop 原回调均保留。
- `applicationWillTerminate` 调用 controller 的同一个 `shutdown`；root controller deinit 把 bridge、notification、diagnostics 强引用交给 `Task @MainActor`，再走同一 shutdown。正常路径调用 `RuntimeBridge.stop()` 复用现有清理链；未完成装配时直接清 notification/diagnostics。不新增生命周期 owner，不在 resign-active/分享失活时清理。iOS 强杀或挂起后杀进程不保证执行 terminate/deinit，不能把这些 hook 写成强杀保证。
- 生产 `nsh.json` 已加入且仅加入六个通知 capability：`notification.status/request/openSettings/configure/live/test`。原 Diagnostics/连接/资源等 capability 保留。
- 生产 `scripts/build-ios.mjs` 已链接 `UserNotifications`；原动态 Swift sources 自动包含新桥。没有新增 APNs entitlement、background mode 或通知 usage-description。
- `settings-basics.tsx` 的 notifications 分支委托给 `SettingsNotifications`；About 和其他分支保持。原始总开关替换为真实系统权限组件，八类 Host 开关完整保留。focused/template 控件在 native 隐藏，旧搜索 focused target 定位到明确说明，不显示一个无效开关。Host 上的 Web mode/templates 不删除、不回写、不传给 native。

## application 单根基线（需补下文 catalog props）

`YuriNativeApp` 已导入 `createNativeNotificationRoot, nativeNotificationScope`（`notification-root.tsx`）以及已有 `assistantChatTarget`（`assistants.tsx`），初始化一次，给原 `observeRuntime` 加第二参数，并在根布局挂 Feedback：

```tsx
const notifications = createNativeNotificationRoot<Route>({
  scope: nativeNotificationScope, settingsRead: () => request('/api/config/settings'), sessions: () => app.sessions(),
  resolve: identity => identity.kind === 'session' ? [{ kind: 'chat', target: { kind: 'session', ...identity.session } }]
    : identity.kind === 'assistant' ? app.bots().filter(bot => text(bot.id) === identity.id).map<Route>(bot => ({ kind: 'chat', target: assistantChatTarget(bot) }))
    : app.tasks().filter(item => text(record(item.task).id) === identity.id).map<Route>(item => ({ kind: 'task', item })),
  open: (route, current) => { if (current()) nav.push(route); },
});
observeRuntime(() => { void run(refresh); }, notifications.onEvent);
const NotificationFeedback = notifications.Feedback;
// 在根 View 内放 <NotificationFeedback />。
```

这是替换原 `observeRuntime` 调用，不是再注册第二个 observer。factory 已自行注册唯一 `notification.route` 订阅并在 owner cleanup 注销；**不要另建 runtime.event/SSE 订阅或手写通知 tap handler**。state 的改动仅为 `observeRuntime` 可选 `onEvent(event,scope)`：在原 parsed-global/active/非 switching 路径分发；原 attention/catalog 调度和 createChat 没有改变。

`resolve` 必须返回全部匹配的当前 Host catalog destinations，而非取首项。root 要求恰好一个结果；session 先通过自身唯一索引验证 ID/directory，再给回调实际 Session。缺失、多目录或多匹配显示已有本地化 `common.unavailable`，不猜 directory、不切 Host、不通过历史读取补身份。异步 resolver 返回后、真正 open 时都检查 `current()`。以上示例只使用现有导航，不创建新会话或发消息。

本轮 **main/application/state 增量为 0**。新 live admission 用独立的只读 identity resolver，不调用导航 resolve/open；cold 仅在完整 proof 与唯一 catalog 身份通过后调用原导航 resolve。当前 application 的 bots/task-ID filter 保留，但仍需下文的完整 catalog authority props。跨 project 同 task ID 必须拒绝，不能先按 source.projectID 隐藏重复。

## 配置 authority、失败与保存

`notification-runtime.ts` 是 root/Basic 共用的单一 transport+delivery lease，import 本身不发请求。root 的 scope/settingsRead/call 是依赖注入；Basic 默认仍使用原 `request('/api/config/settings')` 与 partial `PUT` 协议。

1. root 启动/前台恢复、语言或 Host/generation 改变时，单次 GET 成功后投影九个 Boolean notification preferences，再配置 native。无 GET 成功不创建“空成功”。同时在途的相同 scope/language GET 复用同一个 promise。
2. 普通 refresh 失败保留上次确认的偏好与 native lease，显示错误及手动重试；语言变更先作废旧读取，不把失败当成配置关闭。Host/generation 变化立即使旧 JS lease/catalog 失效，native 的真实 onInvalidate 同步废弃 receipt/fence 并请求 OS 清理旧通知。
3. Basic 的未保存 draft 只在页面 controller 中，不 configure、不发布全局通知状态。Save 在顶部，写入/系统权限操作期间禁用；权限被拒不把总开关草稿改成 true。关闭已启用的 Host 偏好不依赖 iOS 授权。
4. 保存只 PUT 用户实际修改的受控 Boolean 字段；不回写默认值，不覆盖其他 Host 设置、Web mode 或模板。ACK 后仍需要一次 GET 对比 submitted patch。只有该 GET 的冻结 snapshot（transport 的 WeakMap receipt）能用于 native configure；不能把 draft 或伪造的 snapshot 交给 synchronize。
5. PUT 成功后回读/原生配置失败，只重试读回与同步，不自动重放 PUT。未知结果先回读：值一致则确认；不一致保留 draft 和错误，只有用户再次明确 Save 才重写。读取失败保留上一 snapshot。
6. Basic 已确认配置后，通过 transport 的**进程内、当前 scope、受控 preferences** confirmation 通知 root；不传播 raw settings、凭据或模板，也不造成第二次 GET。页面也接纳 root 已确认的 snapshot，保留未保存 edit；初次进入可复用同 scope 的已确认 snapshot，而不重复 GET。native 对同一个仍有效 scope 的相同配置幂等返回原 lease，不因无变化刷新删除已有 receipt。

文案全部使用正式的十种 `*.settings.ts` 字典和 NSH `i18n.t`。`notification-messages.ts` 只保留 key manifest，不再维护平行词典。

## 本轮新增：producer admission 合同

八类领域判定已由真实 Server producer 补齐。生产 root controller 现已装配 admitted-only sink 与 protected-receipt recovery，不再从 raw terminal、bubble 或 list tip 推断。**application 的完整 catalog/readiness props 和设备验收仍须完成，不能称八类已端到端送达。** 本轮仅修改 root/core/runtime、admission/recovery/session resolver 和对应纯测试/预备 fixture。

`admission-event.js/.d.ts` 为 Server、Web parser 和 NSH 共用的纯白名单：

```ts
{ type: 'yuri:notification-admitted', properties: {
  v: 1,
  kind: 'completion' | 'subtask' | 'error' | 'question' | 'permission' | 'goal' | 'schedule' | 'assistant',
  eventID: string,
  target: { kind: 'session' | 'schedule' | 'assistant', id: string },
  source:
    | { type: 'session', sessionID: string, directory: string, parentID: string | null, boundaryID: string }
    | { type: 'schedule', projectID: string, taskID: string, runID: string,
        trigger: 'scheduled', resultOwner: 'unowned', status: 'success' | 'error' }
    | { type: 'assistant', assistantID: string, turnID: string,
        status: 'complete' | 'error', publication: 'published' }
} }
```

所有对象拒绝额外字段；target 必须与 source 同一实体。session directory/parent 来自成功的权威 Session 元数据，不从 UI、历史或首项目猜测。subtask 必须有真实 parent，其他 session kind 保留 root/system-session suppression。此事件只证明 owning 通知判定已通过，不证明 OS 已展示、APNs 已发送或任何客户端收到。

| kind / 独立开关 | owning authority |
| --- | --- |
| completion / `notifyOnCompletion` | 真实 `session.execution.succeeded` + 稳定 event.id，经原有权威 family barrier、system-session 和 native Goal gates；idle 不作为新 admission 的证明 |
| subtask / `notifyOnSubtasks` | 同一 barrier 实例检查 child subtree；成功权威元数据中的 parentID 分类，不要求 child 已在 bounded UI catalog |
| error / `notifyOnError` | 真实失败事件的稳定 boundary；独立于 completion 开关，新执行使旧在途结果失效 |
| question / `notifyOnQuestion` | 原 question/form debounce 决策点，真实 request/form ID（缺失才使用真实 event.id） |
| permission / `notifyOnPermission` | 原 permission debounce 和 auto-accept 判定之后，真实 request ID；已回答和在途取消使新 admission 失效 |
| goal / `notifyOnGoals` | 正式 `Goal.State.complete`，boundary 为 goal.id；active/paused/unknown 不发成功 |
| schedule / `notifyOnScheduledTasks` | scheduler 两处实际通知 callback 传真实 runID；manual、接管、未知 ownership/runID 不产生 admission；handler 严格返回 false 或确无 handler 才是 unowned |
| assistant / `notifyOnAssistants` | 复用 `sendContactTurnNotification`，保留 service 的真实 turnID；silent 分支不调用 notifier，published 的正文/card-only/error 都不再依赖客户端是否碰巧收到 bubble |

原 `yuri:scheduled-task-ran`、contact SSE、`yuri:notification` 正文合同不改。专用 emitter 仅向现有 authenticated global/Yuri SSE fanout 安全 proof，不广播正文、错误详情、模板、URL 或凭据，不新增 SSE。

eventID 使用 kind + 长度前缀 namespace：sessionID/boundaryID、assistantID/turnID、projectID/taskID/runID。领域 ID 仍限 safe ASCII 128，完整 key 上限 384；超限拒绝，不截断或 hash。时间、busy→idle、消息历史、tag 均不补唯一性。Server 已接入此事件；`yuriEvents.ts` 解析为 `{type:'notification-admitted', admission}`，旧消费者继续忽略它。

Server 的 safe admission 去重、session pending 和 schedule/Assistant publication retry 窗口各为 256；session version fence 上限 4096。失败不算已发布，显式 `retryNotificationAdmissions()` / 既有 server.connected 可重试；dispose 拒绝迟到结果。复用原 family timer，不新开 completion gate。legacy ledger 保留 Web/Live Activity 原有 once-per-execution 语义，idle 后再收到 explicit success 只新增安全 admission，不重复旧 fanout。

## Root 已装配的实际路径

`createNotificationRootController` 已移除 `notificationGlobalAuthority`、spoken-turn ledger 和 raw terminal 发送路径；唯一 `createNotificationGlobalAdmission` 接现有 onEvent，唯一 `createNotificationRecovery` 接 native owner 的 `createNotificationLaunchTransport`。未挂 `notification-launch-core` 的旧 controller，不使用其中 activateHost 分支。

1. root 默认 lookup 使用 `notificationSessionLookup(notificationScopedRequest())`，当前 owner 的 captured request 保持不变。resolver 按数组引用建立 session 唯一索引；缺失 child 每次尝试只读取一次 metadata，不读消息、不建 child stream。重复 session ID（包括跨目录）拒绝。cold 点击使用完整 proof 的真实 directory/parent；没有 target-only fallback。
2. `catalog(target,current)` 返回**完整匹配集合** `readonly {target,projectID?}[]`。assistant 从真实 bots catalog 映射；schedule 先在完整 tasks catalog 中按 task ID 找全部匹配，再带上实际 `projectId`。未知/部分读取必须抛错，不能返回伪空成功；禁止先按 source.projectID 筛掉重复。resolver 要求唯一后再校验 projectID。
3. sink 的 `scope/language/active/settings` 取原 root/transport authority。settings 未知用 null；`delivery.acceptLive(event,admission)` 重新白名单校验并核对 eventID/kind/target，向 `notification.live` 仅传 `{lease,eventID,kind,target,admission}`。Native 已按同一 proof 验证，OS userInfo 不扩张。缺真实 authorizationID 时 live 不调用 native，cold 不 claim，状态明确 unsupported。
4. 原 controller 继续拥有配置 GET、Basic confirmation、Feedback。唯一 `notification.route` listener 只接受 receipt-only 输入，旧 `{hostID,lease,target}` 直接拒绝；唯一 `notification.launch.available` listener 仅提示同一个 recovery drain。main 的旧 route callback 已移除，实际 native 入口为 pending receipt hint，两个 callback 不各自导航。`onEvent` reconnect 走原设置 refresh 后 retry；token/raw terminal 零 lookup/目录读取。
5. 初次配置成功、foreground 恢复、语言/Host 变化、Basic confirmation、手动重试完成后调用新 sink.retry；cleanup 调用 dispose。新 sink 的 pending/seen 各 256、同代两并发，失败/stale 保留重试，Host/generation 切换清空、语言变更不清 seen；settings 与身份在异步边界后再检查。
6. warm/cold 点击均使用同一 protected record 路径。scope/setScope、native configure 完成且真实 catalog await 成功后才 claim；验证完整 record、当前授权、TTL、peek/claim fingerprint 一致、route lease 与 target；导航前 current 合并 `launch.isCurrent(receipt)`，防同 scope lease 被换。CAS 失败保留已导航 ledger，重试不重开；新 native hint 同步退役旧 claim，旧在途 lookup 不能再导航。

root 不新增 runtime observer、SSE、polling/timer，不切 Host、不改变导航目的地。辅助 raw helper 可以保留供其他测试，但生产 controller 无引用。Feedback 保留错误、重试与关闭，unsupported 在 state 明确暴露，显示已有本地化 unavailable，不添加临时语言文案。

## application props 与剩余 readiness 接线

main 已接入 `captureRequest`、真实 `authorizationID` 和完整 assistant/schedule catalog，并移除 legacy `settingsRead`。完整 catalog 成功快照的 `catalogReady` await seam 尚待 owning state 模块交付；缺少此门禁时冷恢复继续 fail-closed，不从当前数组推定完整性。

保留一个 `createNativeNotificationRoot<Route>`、一个 `observeRuntime` 和现有 resolve/open。移除旧 `settingsRead:()=>request(...)`；该 legacy prop 暂可编译，但 root 明确忽略它，不会拿 latest unbound request 发设置请求。加：

```ts
captureRequest: captureHostRequest,
authorizationID: nativeNotificationAuthorization,
catalogReady: async current => {
  // 等待 owning catalog 的成功、完整、当前 Host/generation snapshot。
  // 使用已有 catalog owner 的 await/ensure；失败或 partial 抛错。
  // 不能仅用 !loading、app.online()、数组非空或 await refresh() 的吞错结果证明成功。
  await ensureCurrentCompleteNotificationCatalog(current);
},
catalog: () => [
  ...app.bots().map(bot => ({ target: { kind: 'assistant' as const, id: text(bot.id) } })),
  ...app.tasks().map(item => ({ target: { kind: 'schedule' as const, id: text(record(item.task).id) }, projectID: text(item.projectId) })),
],
```

`ensureCurrentCompleteNotificationCatalog` 是所需 owner seam 的占位名，**不是声称已有此 API**。返回前必须确认当前 scope 和 domains 成功完整；若现 owner 没有 authority await，main/state owner 需提供最小只读 seam。root 自身不读取第二份 bots/tasks，不从部分数组伪造完整性。catalog 返回整个集合（或所有同 ID 匹配），禁止按 source.projectID 预筛；root 先按 task ID 确认全局唯一，再校验 source project。既有 `resolve` 保持按 ID 返回全部 destinations，session 使用提供的真实 Session；不发消息、不创建 session。

`nativeNotificationAuthorization()` 只读连接 snapshot 的非 secret `authorizationID`，没有真实字段则 null。最新 ConnectionStore.publicValue 已提供该字段、配对时生成授权代际；root 只消费原始值，绝不从 editorVersion、JS epoch、lease、Host ID 或任意常量构造。真正撤销后的精确定向清理仍归连接 owner。

根 catalog readiness 真正从未知变为成功、或 authority snapshot 发布后，main 的已有 owner 生命周期应调用 `notifications.recover()`；不用新订阅/SSE。scope/语言/实际 foreground 变化已由 root effect 驱动，Basic confirmation/reconnect/手动 refresh 已自动重试。已有 onEvent 回调中保留 diagnostics 分发。

设置与 Basic 共用 `nativeNotificationSettings`，`notificationScopedRequest` 在 Host/generation/root binding 改变时重建 sender，使用实际 `state.captureHostRequest()` → `runtime.bindRequest(fixedScope)`；GET/PUT 及在途 continuation 都检查 captured identity，不晚绑新 scope。新 native runtimeScope 未读到时 root scope 为 null，禁止 unbound 写入/回读。

## 冷启动恢复：已绑定真实 native wire，待 application/设备闭环

`notification-global-recovery.ts` 导出严格 parser 与 `createNotificationRecovery`。OS 点击输入始终只能是 `{v:1,receipt:UUID}`；从 native protected store 读取：

```ts
{ v:1, receipt, revision, connectionID, authorizationID,
  admission, createdAt, expiresAt }
```

这里 admission 必须是上节完整 safe proof，包含 project/directory/parent 的实体绑定；不只保存 target，防止相同 task ID 跨项目重定位。TTL 最多七天；未来创建、过期、额外字段、`authorizationID:'legacy'` 都拒绝。恢复绑定当前 connection/authorization/generation，不自动切 Host；每个异步边界复查，唯一 identity resolve 后才 open，随后按 expectedRevision CAS consume。最多 16 个在途 receipt；同 receipt 合并读取，256 项已导航 fingerprint 使 CAS 失败重试不重复 open，retarget/revision 改变拒绝。**跨进程崩溃不能仅凭此内存 ledger 保证 exactly-once 导航。**

root 已直接复用 native owner 的实际 wire：

```ts
peek({}) -> {record: NotificationRecoveryRecord | null}
claim({connectionID,receipt}) -> {record,route:{hostID,lease,target}}
ack({connectionID,receipt,lease,expectedRevision}) -> {ok:true}
```

完整 Native 信任边界、持久化和 main 接线见 `notification-launch-INTEGRATION.md`。最新 main 已加最早 delegate install、capture selected.authorizationID、三个 capabilities，且删除旧 route callback；不再将它们列为未实现。真实授权撤销的定向 retire/cleanup 仍待连接 owner 接入，不用普通 reconnect 删除有效 receipts。本轮没有修改这些文件，也未重复建立 inbox/controller。

## 保持的安全与未验收边界

- 九个 Boolean 偏好、PUT 后权威 GET、未知写结果不重放、十语正式字典、真实 iOS 权限和 foreground suppression 保持。普通 UIApplication active 通知仍硬抑制，只有显式本地 test 例外。
- OS 文案固定安全十语；userInfo 仅 receipt，不含 Host/target/directory/URL/凭据/正文/模板。scheduled 只代表 OS 接受，不保证横幅或声音。
- 无通用 settings revision tip；仍用原前台/语言/Host/reconnect、Basic confirmation 和手动重试，不虚构 tip、不加 polling。
- APNs 的 NSH app identity、证书/entitlement、token 注册和 provider 真实投递仍未实现/验收；挂起后不能靠当前 SSE 收到新事件。它与已实现的本地 admission 是不同验收项。
- root/native wire 装配已有实现，尚需 application 完整 catalog/readiness props、授权撤销清理及真实权限、系统设置、点击、声音、冷启动/重授权场景验收。

## 验证记录

本轮 root 聚焦验证：

- 九文件 **65 项通过**：runtime、root-core、core、preferences、session-live、global-admission、global-recovery、native owner 的 launch-transport、production source contract。root 测试实例化真实 `createNotificationRootController`，不是 standalone helper 替身；覆盖八类 proof、原始事件零工作、exact child failure/duplicate、schedule 跨项目全 ID 唯一性、Basic receipt/confirmation、语言/前后台/授权/Host fence、完整 protected record、claim/peek 一致、lease/TTL 导航前 fence、CAS 失败不重开、最新点击优先。
- `notification-runtime.test.ts` 使用生产 runtime.bindRequest 与合成 host.call，检查 GET/PUT 都携带创建 owner 时的 fixed expectedHost；Host/generation 替换重建 sender，旧 continuation 不配置新 Host；缺 runtime binding 不发 unbound 请求。
- 专项 tsc 读取原 NSH tsconfig，21 roots（包括 root/runtime/core 测试）及 386 个真实传递文件零诊断，无 stub/跳过诊断。全包 NSH/UI tsc 本轮未重跑，不代替其他 owner 验证。
- Bun 静态 bundle 的 root、Basic、`notification-root-fixture.tsx` 三入口成功；生产 root 确实引用 admission/recovery/launch transport。fixture 使用真实 root 和注入的合成边界；`notification-root-engine.test.ts` 仅准备，**没有运行 engine**，不得作为 UI/设备证据。
- main 后续已显式运行 `NSH_NOTIFICATION_ROOT_ENGINE=1`：真实 root 的合成 transport 引擎用例 **1/1 通过**，覆盖八类 sends、raw 零新增、cold open/ACK 与 rebind。此项不运行 OS 通知、真实授权或主应用完整 catalog 恢复，不替代 UIKit、杀进程点击和 APNs 验收。
- dead-code 使用本机已缓存的同版本 Knip 5.80.0，执行 package.json 中相同参数（直接 node 调缓存入口，避免 bunx 下载）；exit 0，非阻断报告仍有 unused/duplicate 项。新 fixture 因 engine runner 的字符串路径不可静态追踪而列 unused，不删预备 fixture，也不修改配置假装零告警。
- 原 production source assertions 随当前真实合同更新：九 capabilities、delegate 早装配、真实授权 capture、取消旧 callback、单 observer 同时分发 diagnostics、root admitted-only 与复用 launch transport。行为由前述 controller/runtime 测试验证，未仅靠修改 expect 声称通过。

此前 producer 批次的 Server 75 项/Web parser 21 项通过记录仍有效，但本轮没重复跑未修改的 Server/UI；此前 SQLite scheduler 全回归失败见下段。最新 main SDK 与 native launch 的 10 项通过为各 owner 提供的独立证据，本轮未执行 Swift/main SDK 或扩大运行范围。

Scheduler 全文件回归此前为 80 项中 66 通过、14 失败：13 项缺少 `better-sqlite3` Node ABI binding，另有 recovery-stop 超时。没有安装/重建依赖；新增 scheduler admission 测试注入内存 history store，不以它代替 SQLite 全量回归。

不运行 NSH engine、UIKit app、生产 main build、真实通知/权限请求、设备、真实 Host、凭据读取、网络、发布、Git 或付费操作。静态 bundle/类型检查不替代这些验收。
