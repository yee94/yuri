# Native desktop SSH slice / root handoff

## 当前交付边界

`desktop-remote-connections.tsx` 提供实际 NSH 表单、集合、检查/连接/取消、文件范围选择、review/apply 与只读运行历史。`desktop-host/src/ssh*.rs` 包含 native registry、连接状态机、受控 OpenSSH driver、原 actor typed adapter、真实 local 文件事务与固定 SSH 文件程序。Host owner 已在 `native_ssh_bridge.rs`、main/services 接入连接-only worker；本线程只读核对，不修改这些装配文件。**安全竞态封闭、敏感同步和平台验收仍未完成，连接-only 接线不代表完整 SSH/sync 交付。**

### 生产与测试编译边界

本线程的生产 SSH 模块只编译连接 service / actor / owner / process。`ssh::sync`、`ssh::io`、`ssh::http`、`SyncGrant`、`Error::SyncUnknown`、`Cancellation::linked`、`Owner::{capture_sync,sync_current}` 及 `NativeDriver` 的 ProgramTransport 实现与 I/O 计数器均为 `#[cfg(test)]`；下文 Files/sync 合同描述的是测试编译实现，不是可在生产构造的服务。重新开放须先完成安全 I/O 与敏感同步合同，再明确生产接入；不能仅删除 cfg 宣称 available。冻结的 `service::install / Handle / Request / Outcome / Phase`、16 槽与关闭屏障不变。

无调用的 `NativeFiles::endpoints` 已删除，实际临时 I/O 测试仍通过 `NativeFiles::new(Local, Remote, Cancellation)`。测试 I/O 复用原 journal 私有 SHA 源码，只在 `ssh_io.rs` 的 `mod digest` 上局部允许 `clippy::duplicate_mod` 并附原因；没有新增 crate/global allow、复制 SHA 或修改 fileJournal。

本轮 native slice 修改 SSH/connection owning modules、原 Actor 的首 load fence 和 Process 装配；没有修改 application/state、main、native_ui、host_services、Cargo/lock、notifications、diagnostics、fileJournal、assistantHome 或 schedules。原 actor 继续唯一持有 Vault、认证提交、当前 Host、HTTP/SSE 和 runtime lease。这里没有创建第二个 Vault、调用 Electron IPC，或预设新的 Host 方法名。

## 源码依据

| 来源 | 使用的实际合同 |
| --- | --- |
| `packages/ui/src/components/sections/remote-instances/RemoteInstancesPage.tsx` 的 `connectWithPortRecovery` / sync wizard | 连接与取消交本机 owner；端口冲突恢复需确认；preview/apply 固定同一方向与范围 |
| `packages/ui/src/stores/useDesktopSshStore.ts` | 本机 registry、独立 statuses、显式连接/断开，不把保存表单当连接 |
| `packages/electron/ssh-manager.mjs` 的 `ensureRemoteServer` / `connectBlocking` / `connect` | managed 检查→初始化/更新→forward→认证→Host 提交；同实例 in-flight 合并 |
| `packages/electron/README.md` 的 SSH provenance / managed lifecycle | SSH 不授予 Relay；普通进入仍初始化；仅重启恢复先试已认证 transport；不能杀手工 daemon |
| `packages/web/server/lib/config-sync/{DOCUMENTATION.md,constants.js,plugins.js}` | 同步白名单、备份/未知结果，以及保留 JSONC 的 NPM-only 插件声明过滤 |
| `settings-remote-instances.tsx` / `desktop-settings-root.tsx` | 同一 Settings publisher 内的精确 `NativeRemoteConnectionsSlot` 透传 |
| `desktop-host/src/{bridge.rs,host_services.rs,vault.rs}` | 唯一 actor 的 durable 认证提交与精确退休，不从 UI badge 推导 authority |

## TS root API

### Window-root connection mutation admission（Header / Settings 同一个 controller）

`createNativeDesktopRemoteConnectionsRoot` 的 `connectionMutation?: DesktopSshConnectionAdmission` 是两入口共用的正式准入。**当前 application 未注入它，因此 Settings Connect 和 Header Connect 都不可用**；不是以 native capability、HTTP grant、按钮显示或 callback 返回 `accepted` 代替授权。`controller.start(id,'connect'|'restore')` 也走同一准入；缺失时零 native start。纯 `check` 不切 Host，保留原路径。

冻结的 callback 参数（类型在 `desktop-remote-connections-core.ts`）：

```ts
Readonly<{
  target: DesktopSshInstance; // frozen exact 八字段，不只校验 ID
  intent: 'connect' | 'restore';
  source: 'header' | 'settings';
  requestID: string;
  current(): boolean;
  canLeave(): boolean;
  dispatch(): Promise<DesktopSshConnectionResult>;
}>
```

- callback 开始前 controller 已保留唯一 reservation，普通根 `guard.canLeave()` 为 false；`mutation.canLeave()` 只排除它自己的 **pre-dispatch** reservation，不能排除其它 busy/unknown/native attempt。main 准备本次连接时使用此 scoped exception；其它导航、切 Host 和原生关闭始终使用普通根 guard。
- Settings publisher 的 `canPrepareConnection(target)` 也只放行 **同一个 Settings target、自身 confirming admission、尚未 dispatch** 的准备阶段。真实 native start、running、unknown 没有例外。表单动作在 reservation 期间禁用；这避免 main 准备 Settings 被它自己的 pending 反锁，并不向 native 授权。
- `current()` 复验原 controller/window、native readiness、调用入口 intent、完整 target、status attempt/requestID/phase 和其它 pending/unknown。main 还须捕获并复验实际旧 Host/origin/authorization/lease、route/mounted handles、file/settings grants；这些 authority 不归 SSH registry，不能从 target 或 ready badge 推断。
- `dispatch()` 在最终同步复验后最多派发一次，不调用 `setActive(true)`、不启动 read/poll。callback 未 dispatch 就返回 accepted 被拒为 unsupported；返回后保存的迟到 dispatch 永远 stale；已 dispatch 的 flight 不因 Header 关闭、Settings 卸载或 callback 抛错被抹掉。
- `accepted` **只表示 native start 已接纳**，不是连接 Ready，也不是 Host 已刷新。receipt 证明原 requestID 已接纳；持续关闭保护必须等同 requestID + exact target + 首次绑定的 attempt 的 terminal status。缺失 status、其它 request/attempt、任意网络错误都不构成否定回执。receipt-only start 保留 unknown；read-only exact recovery 可以更新为 running 或 settled，绝不 resend。
- 既有 `connectFromHeader(target,intent,commit)` option 仅保留原 Header consumer seam，内部仍走此 controller，不授予 Settings 权限。正式 main 接线应注入共用的 `connectionMutation`，不能只填 Header callback 然后让 Settings 裸 start。

root 返回值整体及 `guard` / `header` 均冻结，新增 main 端口：

| 端口 | 合同 |
| --- | --- |
| `guard.current()` | 原 window/native lifetime；不是 selected Host，也不是是否允许关闭 |
| `guard.canLeave()` / `canWindowClose()` | 同步检查 reservation、mutation busy/unknown、snapshot saving、native running/非终态和 sync applying/unknown；不依赖 Settings/Header 是否挂载 |
| `guard.requestWindowClose()` | 无副作用的异步同值检查；main 等其它 flush 完成后仍须最终同步 `canWindowClose()` |
| `connectFromHeader(target,intent)` | 与 `header.connect` 同一个受保护入口；Settings slot 挂载时不接受 Header 动作 |
| `connectFromSettings(target,intent)` | 同一 controller 和共用 admission；UI slot 本身也直接调用同一个 `controller.connect`，不创建另一 engine |
| `snapshot()` | 同步 `{current,ready,snapshotReady,state,connection}`；仅现有 owner，无 discovery/read；cached snapshot 存在不等于当前 ready |
| `subscribe(listener)` | 原 owner 通知；不读、不激活、不构造 source |
| `refresh()` | **显式**只读 capability/snapshot 核验，Settings 卸载后也可核验原 request；无定时器、不重放 start |

`snapshot().connection` / `controller.connectionOperation()` 是 frozen recovery metadata：`{requestID,target,intent,source,dispatched,phase,attempt,outcome,connectionID}`。phase 为 `admitting/dispatching/running/unknown/settled`；terminal outcome 为 `ready/error/idle/denied/not-dispatched`。callback 返回后不自动清除最后一条结果；main 通过 requestID 判断自己负责的那一条，不能把后来其它结果替换旧恢复流程。此 metadata 不携带 Vault、凭据、正文或 writer grant。

#### main 最小接线与真实阻塞

main 已把根 guard 组合到 `requestWriterDeparture` 的异步 current 复验、native close 准备/最终检查，以及 Header navigation/switch/add 的 lifecycle/availability；本线程只读核对了这七处调用，未修改 application。`connectionMutation` 仍未注入，Connect 继续 fail-closed。下面第 2–5 步是正式启用前仍需满足的事务合同，不是已完成声明。

1. 在原窗口根创建这 **一个** remote root，把其 slot 传 Settings、header 传既有 Instance source；向 `connectionMutation` 注入原协调器，不创建第二 controller/catalog/auth/sender。
2. callback 捕获旧 Host/lease、全部 mounted/page owner 与文件/Settings stamp；依次完成原 guard 的确认和最后复验。此阶段仅使用本次 `mutation.canLeave()` 的 self-reservation 例外，不能直接忽略所有 pending。
3. **先取得旧 writer release 的真实 ACK，再调用 `mutation.dispatch()`**。仅 `pageDeparture.request` 的同步 `release():void` 不是该 ACK；不能在 start 之后才释放，不能靠禁用输入代替释放。
4. main 必须保留自己的 released-writer/recovery fence。即使 start 明确 denied、未 dispatch 或用户取消，已 release 的旧 Chat 也不能凭 cancel 立即恢复 write；须读取实际 selected Host/runtime lease，并经原 writer owner 正式 reacquire 或挂载新 owner。`guard.canLeave()==true` 从不等于 writer 已重新获得授权。
5. start accepted 后可显式读取原结果；只有 exact terminal proof 后才根据真实 `connection.list` 刷新 Host，完成新/旧 writer 的正式恢复。unknown 或运行中继续保留离页/原生关闭保护，即使 Settings 卸载/Header popup 关闭。普通关闭先 request 检查，再在其它 flush 后同步复验；`guard.current()==false` 也不能被当成 unknown 已清除。

**尚不能宣称安全事务接线完成：** 旧 native authorize/restore 与 `tick` 的 `recovery-*` 会自行选择 Host；本次 Rust owning slice 已改为 fresh immutable connectionID 的 connection-only commit，背景恢复不选 Host，且已接原 Process 全窗口 selection-protection 快照、exact Current reload/首 load 继承和真实 Process 合成验证，详见下方 native seam。背景 start 不需要提前释放旧 writer；只有 exact Ready 后的显式 `connection.select` 才走原 navigation/writer release ACK 事务。上面的旧 start 前 release 步骤不是新后台连接的准入要求；未知 select 则继续 fail-closed，不能靠 cancel 复活 writer。本 slice 没有修改 application/state 或开放 TS Connect；main 的页面离页/写者 ACK 接线、晚到完整 aggregate 与平台验收仍是独立门槛。

**启动 source 边界：** 现有 startup discovery 只缓存 capability port，没有 registry read。只有第一次 Settings 实际展示才采用它构造唯一 controller 并读取 snapshot。本轮不额外发启动网络、不因为 Header 打开/输入/subscribe 构造 source、不拼接另一个 snapshot。因此 Header 在这次真实读取之前仍是 unavailable，`snapshotReady:false`，不能伪装为 available。若 main 要求启动即展示 SSH registry，必须明确复用原启动流程中的真实同 owner read；目前不存在可直接消费的 startup registry snapshot。`refresh()` 不偷偷采用 cached port。

未知结果是原窗口内存保护，不是跨进程 journal。`dispose()` 只用于最终窗口 teardown，退休 controller/port，不发 cancel、不清原未知状态，也不能作为通过关闭 guard 的办法。

本轮证据：新增 core focused 复现先红后绿，并覆盖 root，含 unknown start→Settings 卸载→根 veto、50 次输入/投影零 I/O、同 target Settings 准备、stale target/Host/lease、迟到/伪 accepted、receipt-only unknown、release 后失败不自动恢复 writer。真实 NSH headless 在 macOS/Windows 各覆盖 Settings/Header presentation teardown、pending/unknown、50 字符输入零 SSH I/O、显式只读恢复不 resend，另保留既有完整/connection-only slot 回归。**不是** AppKit/Win32 真窗口、SSH、Vault、模型或 native 自动选 Host 的端到端证明。

最终合并运行：core/native/root/root-engine/engine/native-engine/Header-root/Header-root-native/production-App-native 共 9 个 Vitest 文件、90 项通过，0 failed/skipped（两个 engine 环境开关均启用；NSH runner 内另有子场景）。整包 `tsc --noEmit`、`nsh:check` 与两文件 Settings audit 通过。`bun run dead-code` 因已有 `packages/web/vite.config.ts` 缺 `vite-plugin-pwa` 失败，报告未完成；命令输出 `Saved lockfile`，未为此添加依赖或手工处理锁文件。iOS 仅覆盖编译检查，未运行 UIKit/真机；未运行真实 SSH/Vault/模型或 Git 命令。

### Main 可消费的 connection-only loader / slot

`desktop-remote-connections-native.ts::loadNativeDesktopRemoteConnections` 连接现有 NSH `host`，纯测试入口为 `desktop-remote-connections-native-core.ts::loadDesktopRemoteConnectionsNative`。先在窗口 bootstrap 的异步准备阶段 discovery，再在窗口 root 创建一次 slot owner：

```ts
import { loadNativeDesktopRemoteConnections } from './desktop-remote-connections-native';
import { createDesktopConnectionOnlyRemoteConnections } from './desktop-remote-connections';

const port = await loadNativeDesktopRemoteConnections({
  current: windowOwnerCurrent, // exact native/window lifetime；false 后不可复活
  runtimeReady: windowBootstrapReady, // 可暂时 false；不是 current、host.available 或主 Host selection
});
if (!windowOwnerCurrent()) { port?.dispose(); return; }
const ssh = port ? createDesktopConnectionOnlyRemoteConnections(port) : undefined;
// 注册到既有窗口 teardown；loader pending 时也须保留 windowOwnerCurrent 的退休 fence。
cleanup(() => ssh?.dispose());
const settings = createNativeDesktopSettingsRoot({
  ...settingsOptions,
  remoteConnections: ssh?.slot,
});
```

精确返回：`Promise<NativeDesktopRemoteConnectionsPort | undefined>`。port 只有 `current / ready / newID / refreshCapabilities / read / save / remove / start / cancel / dispose` 及 `syncSupported:false`，**没有四个 sync 方法**。`createDesktopConnectionOnlyRemoteConnections(port, options?)` 返回 `{controller, slot, refreshCapabilities, dispose}`；slot 仍是既有 `NativeRemoteConnectionsSlot`，可直接传 Settings root 的 `remoteConnections`，不另建 publisher 或 root route。上面的只读装配示例没有传 `options.connectionMutation`，因此不会允许 Connect/Restore；正式可写接线须满足上一节的 root admission 与 writer ACK 合同。

- `runtimeReady` 的 TS 字段为可选以保持已接线调用方可编译，但缺失一律 fail-closed，不发 capability 请求。main 必须显式传窗口 bootstrap 就绪信号；`host.available()` 只是传输存在性的第二道检查，不能替代它。
- Discovery 只发 `desktop.ssh.capabilities({})`（5 秒），不 read、不检查/连接、不写用户配置。exact version 1、connections supported=true / phase=ready / maxPending=16、sync supported=false 才返回 port；拒绝/缺方法/partial/starting/unsupported/迟到退休结果均为 undefined，不伪造空 snapshot。晚就绪可由 root 在 bootstrap 事件后显式重新 discovery；loader 自己没有轮询或重放 loop。
- `current()` 只代表原 window/native lifetime 与捕获的 source/call 身份。`runtimeReady` 或 `host.available()` 暂时 false 时它仍为 true；`ready()` 立即 false、清除能力证明，恢复后必须重新读取 capability。主 Host selection 不参与这两个判断。
- `owner.refreshCapabilities()` 仅重验能力并通知 controller，返回 boolean；`controller.refresh()` 在页面 active 时重验能力后 read。既有 slot 仍只有 active demand 下的 3 秒只读刷新，并跟踪注入的 bootstrap signal；隐藏页面不产生连接操作或断开。缓存 snapshot/draft、registry unknown/pending guard 在暂时不可用时保留，所有动作关闭。
- read/save/remove/start/cancel 映射冻结的 `desktop.ssh.*` 方法，30 秒期限；输入/输出 exact schema 与 safe-number 上界在 adapter 校验。request ID 使用每 owner 的 CSPRNG namespace＋单调 counter，仅为 request identity，不冒充 native window/grant。没有 URL、selected Host、token、password 或 sync 内容进入 payload。
- Ready 连接的 UI **不挂载任何同步选项、preview、apply、history 或 success 元素**。controller 的四个 sync 动作也会直接拒绝且零 native call；没有用 stub success 或禁用按钮冒充 sync 支持。已有完整文件同步 fixture 仍走显式 full port，不是生产可用声明。
- dispatch 前 readiness 拒绝用 `DesktopSshNotDispatched`（本地证明）。派发后 runtime/capability epoch 丢失，即便已经恢复并重新 discovery，迟到 ACK 仍保留 unknown；只有原 request receipt 的只读核验可清除，不能自动 resend。普通 Error/timeout/坏 ACK 也不能当确定拒绝。adapter 只将 frozen worker 明确 Denied 的原生 `ERR_NSH_HOST_ERROR` 分类为 `DesktopSshDenied`，不根据任意 error.message 猜提交确定性。
- `dispose()` 仅退休 TS controller/port，不发 cancel/disconnect、不销毁 Rust actor；Rust `Handle.shutdown` / `on_stopped` 顺序仍归原 Host owner。未就绪、undefined 或 root 退休的 discovery 结果不能后续安装到另一个窗口。

**产品边界不变：** 这套 API 供 main 消费，不修改 main/application/Rust、不增加 capability grant。以下 headless 证据验证的是 loader→严格合成 Host→controller→实际 NSH Settings slot，不是系统 OpenSSH、真实 Host、系统认证或 Windows executable provenance。main 在产品授权前仍须保留其原生验收门槛；本机 service producer/安全 I/O/完整同步未完成。

### 完整注入 Port（文件同步仅测试实现）

```ts
import { createDesktopRemoteConnections } from './desktop-remote-connections';
import type { DesktopRemoteConnectionsPort } from './desktop-remote-connections-core';

// localActorSshPort 必须由真实本机 native owner 适配；这里没有默认 transport。
const ssh = createDesktopRemoteConnections(localActorSshPort);
cleanup(ssh.dispose);
const settings = createNativeDesktopSettingsRoot({
  ...settingsOptions,
  remoteConnections: ssh.slot,
});
```

在窗口 root 创建一次，不在 effect、页面 render 或 route 切换时重建 controller。slot 的类型仍是 `(context: { readonly active: boolean }) => JSX.Element`；它在既有 publisher 下登记自己的 dirty/pending/picker owner。NSH `active` / lifecycle 控制交互和 3 秒只读刷新；隐藏或页面卸载仅停止 UI demand，不断开 native SSH。真正 root 销毁才 dispose TS；native 服务另须显式 shutdown。

编辑器保留打开时的 registry revision；poll 得到新 revision 不会替旧草稿自动升级 CAS。目标字段已经变化时阻止 Connect/检查/取消等针对旧展示身份的动作，用户需显式重新选择该条目。保存/删除提交原 editor revision，不能用最新列表快照覆盖他人编辑。

`DesktopRemoteConnectionsPort` 的生产适配如下；类型声明是唯一字段来源，不存在隐含 IPC 名称。

| Port 方法 | Native 对应 | 回执 |
| --- | --- | --- |
| `current()` | 单调退休的本机 actor lifetime；不是当前选中远端 Host | boolean |
| `ready()` / `refreshCapabilities()` | 连接-only adapter 的 bootstrap＋native capability；不是 lifetime 或连接 status Ready | boolean / Promise<void> |
| `newID()` | window owner request namespace＋单调 counter | 安全 identifier，不含路径/凭据，不是 native authority |
| `read()` | `Owner::snapshot()` | 完整 SSH snapshot |
| `save({requestID,revision,instance})` | `Instance::parse` → `Owner::save` | 已提交 snapshot，含相同 receipt |
| `remove({requestID,revision,id})` | `Owner::remove` | 已提交 snapshot |
| `start({requestID,id,intent})` | `Owner::start(id, request, Intent::{Connect,Restore,Check})` | 操作被接纳的 snapshot，不代表 Ready |
| `cancel({id,attempt})` | `Owner::cancel` | exact attempt 的 idle snapshot；旧 attempt 拒绝 |
| `syncPreview({id,attempt,runID,direction,selections})` | `capture_sync` 后，在同一 grant 下的 `Selections::parse` / `SyncOwner::preview_selected` | metadata-only review |
| `syncApply({id,attempt,runID})` | 同一 grant / run 的 `SyncOwner::apply` | success/failure/unknown 的 run 回执 |
| `syncStatus({id,attempt,runID})` | 原 run 的只读 `SyncOwner::status` | 不重新 prepare、写文件或执行同步 |
| `syncHistory({id,attempt,direction})` | 同一 grant 下的 `SyncOwner::history` | 读取目标端 durable metadata；失败保留旧历史 |

instance exact schema：`{id,label,host,user,port,remotePort,localPort,managed}`。`localPort:0` 表示动态本机端口；其它端口 1–65535。只支持显式 DNS/IPv4 direct target；不接受 command、SSH options、password/token、Relay URL/descriptor、ProxyCommand。label 最多 240 UTF-8 字节，host 253，user 64；TS/Rust 同时拒绝 control 字符。此 schema 不是对 Electron settings 的迁移或隐式降级。

snapshot exact schema：`{revision,saving,instances,statuses,receipts}`。status 为 `{id,attempt,requestID,phase,error,retry,running,connectionID}`；只有 `phase:'ready'` 才有公开 connection ID。健康检查不清该已提交身份、不合成用户操作；连接记录按 registry 顺序显示。token、password、native receipt、配置内容和本地路径均不进入 snapshot。

`DesktopSshDenied` 只可用于已确认未提交的 `ssh_invalid/ssh_stale/ssh_busy/ssh_storage/ssh_authentication`；原 mailbox 的明确未入队 native_host_busy 可映射 busy。普通异常、坏回执、派发后的丢失响应必须保留 unknown；不把错误字符串传 UI。registry unknown 只能 `read()` 核验原 request receipt，缺失 receipt 不是失败证明；sync unknown 只能核验原 run。TS journal 仅在该 root 内存中，**没有跨进程 durable 操作恢复**，不能声称重启后自动重放安全。

## Native actor 接入合同

### connection-ready / selected-Host 最小冻结 seam

后台 `authorize/restore/health-recovery` 只提交原 Vault 内的新 candidate/binding（含私有 endpoint/token/authorization/receipt），不提交 selected Host、不替换同 ID 已选中的连接版本、不轮 selected lease。每次 ready 签发全新、不可复用的 `connectionID`；它是 exact Ready 可公开的 immutable version 证据，start/request/attempt 字段保持不变；没有凭据或 receipt 进入 JS。

**main 无需新 bridge hook：** 现有 `connection.list/select` 足够。TS 可先保持旧 writer 建立后台连接，只有 exact request/target/attempt 的 Ready connectionID 才进入原 Header navigation / writer release ACK → `connection.select({id:connectionID})` 事务；select 自身仍检查原 native live receipt，并由原 `self.commit(next,true)` 完成唯一 durable select、失败保 prior、成功才 invalidate/publish/轮 lease。禁止从 SSH tick、恢复或 status 回调自动调用 select。未知 select 保持原 fail-closed fence，不通过 cancel 恢复 writer。

同 target 的旧 selected binding 与最新 candidate 可同时保留，connectionID/receipt 精确区分；只清理同 target 的旧非 selected candidate，最多原 32 connections，容量不足明确 Busy、保 prior。后台退休只撤自己那一份；旧 attempt 的 late retire 不得撤后来 select 的新 authorization。未 dispatch/pending 在内存，已 probe 的 candidate endpoint 只在原安全 Vault 持久化；cold candidate 没有 live receipt，必须重新认证/restore 签发新 ID 才可显式 select。CommitUnknown 保持原 quarantine，不以读取失败或缺 receipt 当否定证明。

**Process retention 接线（GC 证明，不是第二 authority）：** `window_process.rs::install_inner` 已将唯一 SSH service 和各窗共用的原 Port clone 配置为 `port.with_selection_protection(Arc<dyn Fn(&str)->bool + Send + Sync>)`。`SelectedConnections` 读取原 Process worker 的全部 live context `state.selected`（包括无 runtimeScope 的已选 descriptor、停止中但尚未退休的 context）；每轮在 anchor 收包、异步 continuation 和 tick 前更新。任一未初始化/poison/quarantine context、Process closing 或快照锁失败均 unknown=true。另保留 `window_process_vault::Lane::cached_selection` 的权威 primary cold default，避免非 primary 写保留旧 selected 却回收其连接；该缓存只随原 load/commit 更新，查询绝不触发 Vault I/O。它不是 anchor 自己的选择、registry 猜测或新 authority。authorize/restore/healthy 同一 typed Command 显式携带可选 `selection`；缺 provider 仍默认全部 protected。闭包仅做 ≤8 个 context 加一个 cold default 的有界快照查询，不访问 Vault/网络、不等 actor、不锁 SSH Owner。该值只阻止 GC/提前关闭旧 tunnel，绝不允许 select、签发 receipt 或认证请求。

Owner 在新 attempt 开始时保留旧 session/tunnel；新 attempt 失败或取消不退休旧 selected receipt。只在原 actor 确认 superseded 且未被任何窗口选择后，tick 才 exact 清理旧 session。冷 Restore 仍先 authenticated probe，失败再一次普通 managed check/init/forward；已有 live tunnel 的 Restore 使用新 forward，避免两个 receipt 共用一个可被对方 cleanup 关闭的 tunnel。每条 entry 最多保留两个旧 session，清理未完成时 Busy；shutdown 仍 exact 退休全部自有 session，并等待原 operation worker 退出。

**Process reload fence 接线：** `connection_actor_storage::Native::inherit_live(&previous)` 只按完整 target + connectionID + authorization + receipt + localPort 继承非空 Cancellation Current，不继承/授予 receipt 或 credentials，不写磁盘。`Context::sync` 已在 `State::load` 后继承 context prior Native，再把 anchor 的同 receipt Native fence 分发给各窗；不变 generation/receipt 的 idle tick 不重复做 binding 合并。窗口首个真实调用通过原 `Actor::load_with_native` 在恢复/服务 publish 前导入 exact fence，防止已取消的 restore_target 短暂获得 authority。既有 cancelled Current 不被新 true 替换，同 receipt 的不同 Current identity 冲突保守 deny；已选 authority 的原 scope 可保留，但新 select/新窗口 restore 必须取得真实 live Current。cold records 不调用旧进程 Current，仍要求 fresh restore/probe，不能把成功读盘当 live forward。

**远端 credential 隔离：** Host 的 `remote-clients.js::createClient` 会替换同 dedupeKey 的 token，并迁移删除同 label 的 legacy untagged token。因此 native background mint 仍使用 `clientKind:'desktop-local'`，但 `dedupeKey` 改为 `desktop-local:ssh:<fresh candidate connectionID>`，`clientLabel` 为 `Yuri SSH <fresh candidate connectionID>`；两者必须同时隔离，不能只保留旧本地 token 却在远端撤掉它。新 Rust fixture 从实际 native request 只提取这三个公开 metadata 字段，调用真实 Host client-auth runtime 的纯内存 Fs adapter 验证既有 desktop/legacy token 都仍可认证；不把 password/token 输入桌面 JS，不访问用户磁盘或网络。取消/失败不以远端批量撤权来“回滚” mint。

本轮 owning scoped 验证：`native_actor_contract` **15 passed**（原 7 + 新 8，final-probe 同时覆盖 authorize/restore × cancel/target-CAS/supersede/选其它 Host，含真实 Host client-auth 去重策略）；`native_http_contract` **6**、`native_ssh_contract` **6**、`connection_actor_port::` **2**、`ssh::` **57** 全部 passed、零 failed/ignored，且已在本次 Process 装配后重跑。包含真实原 bounded queue/typed Port/Adapter/Owner 与实际 service scheduler 自动 recovery/shutdown，使用合成 Vault/Network/driver；14 项 SSH IO 只执行专属临时 HOME 的固定 Node 程序，没有用户 SSH/Vault/真实网络。独立 target 从现有 cache clone，原 NSH 0.4.0/e626a8dd、Cargo offline/locked，无 Cargo/lock/preparation 改动。第一次误用文件名过滤得到 0 tests，不算通过；随后使用真实模块名实际运行。dedupe-policy fixture 需显式 `NSH_SSH_IO_NODE`。其首次重跑被晚到的 download test 无效 `HttpBody::is_none()` 调用阻断；owning worker 修复后已实际重跑，没有修改它的文件。

本次 Process 装配后，`bridge::process::tests` 在 binary 和 synthetic_smoke **各 23 passed / 0 failed / 0 ignored**，共享测试不相加；其中新增 `window_process_ssh_tests.rs` 的 **5 项**覆盖：两真实 Engine 的各自 selected/lease/token/authorization 保留及 writer ACK→显式 select；未初始化 context 的 unknown 全保护、退出后释放保护；peer metadata 触发 shared reload 后 exact cancel 仍拒绝，以及新窗 cancelled restore 在 publish 前拒绝；100 次 snapshot refresh 零 Vault I/O、cold default/closing/poison；真实 HostChannel→单 service→原 typed Port→原 Process 的 live Restore/cancel/health 自动 recovery、次窗独占旧版本时保留 tunnel、最后旧 reader 退出后 exact 清理不撤新选择、Process 真正 join 释放 Vault。`inherit_live` 已被 production 消费，不再 unused。首次 all-target Clippy 还发现本侧 let-chain lint，修复后重跑仅剩并行 download owner 的 `file_download_attachment_validation.rs`/`file_journal_hash.rs` duplicate_mod 与 `file_download.rs:370` collapsible_if 阻断；没有替它改文件或加豁免。**完整晚到 aggregate、TS coordinator、真实 OS/SSH/凭据/网络和物理窗口未签收，TS Connect 继续关闭**，不能沿用历史 377/384 或本段 scoped 测试宣称完整 PC 1:1。

同批 `cargo check --bin yuri-nsh-desktop --example synthetic_smoke` 已通过且零 warning。新 Rust 测试文件由上述实际 Cargo targets 编译执行；没有运行安装式 `bunx` dead-code 入口，以遵守本 slice 禁网/禁改锁边界，不把它记为零 unused。

### 可安装的连接-only service worker

实际 dispatcher 是 `ssh::service::install`（`ssh_service.rs`），不是下面的 `actor::create` 构造器。其安装参数为：

```rust
ssh::service::install(
    port: connection_actor_port::Port,
    driver: Arc<dyn ssh::Driver>,
    version: String,
    on_ready: ssh::service::Lifecycle,
    on_stopped: ssh::service::Lifecycle,
) -> ssh::Result<ssh::service::Handle>
// Lifecycle = Box<dyn FnOnce(ssh::Result<()>) + Send>
```

1. 从原 `bridge::Owner::connection_actor_port()` 取 Port clone，将 native 验证的 Driver、exact app version 传给 install。install 只启动 `yuri-ssh-service` 线程后返回；原 actor 的 load 在该 worker 中等待。Err 表示未安装、不会回调；Ok 不代表初始化完成，更不授予 JS available。
2. 保留一个可 clone 的 `Handle`。`phase()` 区分 Starting / Ready / Stopping / Stopped / Failed(error)；on_ready 是初始化结果通知，使用时仍复验 phase，不能把迟到的 ready 通知当成当前准入。
3. `handle.submit(Request, Cancellation, Reply) -> Result<()>` 只接五类 typed Request：Snapshot / Save / Remove / Start / Cancel，字段见 `ssh_service.rs`。16 槽、try_send；Err 明确未保留、不调用 Reply；Busy 不是派发成功。Cancellation 在 dispatcher admission 前检查，**派发后不是用户取消 SSH attempt 的替代品**；已运行的连接仍用 exact Cancel(id,attempt)，整个服务用 shutdown。
4. Reply 为 `Box<dyn FnOnce(Outcome) + Send>`，Outcome 区分 Complete(public metadata)、Denied(error)、Unknown(error)。Ok submit 仅表示已排队。已派发 mutation 的不明结果保持 Unknown，dispatcher 随即退休，不重放；其 shutdown 完成也不能清掉未知写入，on_stopped 保留 CommitUnknown 或实际 quarantine_failure。回调丢失的调用方同样只能核验原 request receipt。
5. 生命周期与 Reply 均在 service worker 调用，只可排入短通知/HostReply，不同步等待自己的队列、不操作 engine/UI。callback panic 被隔离；startup 通知失败会停止服务。worker 自己串行、合并每秒 tick，未添加另一个 Host authority；只读健康检查 Busy/Unavailable 保留已提交连接，不将队列压力伪装成失联并退休它。
6. `handle.shutdown()` 同步关闭准入并取消原生 Current，不等待 actor/driver。随后 worker 拒绝尚未 admission 的队列项，执行 exact retire 并等已取消 SSH operation worker 退出，最后 on_stopped(Ok) 才是完成屏障。原 actor 必须活到该通知；Err 保留未知提交/退休失败，不能据其推断所有 authority 已安全退休或销毁原 actor。最后一个 Handle drop 会发起相同关闭。原 `Owner::shutdown()` 单独调用仍不是此屏障。

**安装范围：** 该 dispatcher 类型没有 Sync / Files / Provider / Magpie 请求，不创建 Local/Remote 文件端点，也不注册 HostChannel、JS 方法或 root slot。可先做原 actor → dispatcher → synthetic Driver 的合成垂直接线；Files 安全竞态、敏感 HTTP seam/持久协调器与平台验收继续独立阻止完整 SSH/sync available。现有完整 TS Port 不是此 Rust-only dispatcher 已经装配的证明。

### 底层 actor adapter

已实现入口 `ssh::actor::create(port: connection_actor_port::Port, driver: Arc<dyn ssh::Driver>, version: String) -> ssh::Result<ssh::actor::Service>`；`Service { owner: Arc<Owner>, adapter: Arc<Adapter> }`。它直接适配真实 `connection_actor_port.rs`，不创建第二 Vault/authority。`create` 会等待 `load`，只能在 service worker 调用。Target 八字段完整映射，Current 只捕获 Cancellation；Busy / CommitUnknown 不降级。quarantine 先永久退休 adapter，再等原 Port ACK；失败保留在 `adapter.quarantine_failure()`，普通调用以后拒绝，exact retire 仍可委托。

真实 Port getter 已固定为 `bridge::Owner::connection_actor_port() -> connection_actor_port::Port`。装配方只取此 clone 并移交 SSH service worker；`Adapter::new(port)` 本身只收 Port，不接 Vault、Network、bridge Owner 或 JS authority。`bridge.rs` 已把 typed Command 放入原 64 槽 Message 队列，认证与持久化由原 actor 的异步 jobs / State transaction 所有；本模块不反向创建或调用另一连接 actor。Host owner 正在继续其原 actor 合成垂直验证，此处 standalone 证据不代替它。

Port 对已 admission mutation 超时的原子 poison 保持原样；adapter 收到 CommitUnknown 后也立即永久退休，不能等后续调用才决定是否重放。queued timeout / queue full 保持 Busy，不 poison、不退休。authorize/restore 的畸形 committed ACK 不能证明未提交，因此同样保留 CommitUnknown，而非 Authentication。只有已确认缺失的 external credential 才保留原 actor Authentication；adapter 不生成或回退密码。上述分支已用真实 typed Port 的零期限 admission fence 验证，迟到 reply 不复活 adapter。

默认 driver 可用 `process::NativeDriver::new(native_verified_openssh_path)`；路径只能由受信任 native installer/actor 提供，不能来自 JS 或环境 PATH。`NativeDriver::new` 本身仅检查绝对路径与文件名，不证明文件的 OS 所有权，注入方仍须验证；Windows 验证未闭合就保持 unsupported。生产装配由 Host owner 所有，同步 DTO 仍仅测试编译。

`ActorPort` 必须桥回 **同一个**现有 actor 的有界 mailbox，处理如下职责：

1. `load/save`：在原安全记录中维护 native SSH registry/revision，CAS 只修改该字段并保留其他连接、配对身份和未知字段。成功缺失的新字段可按 actor 的显式 schema 规则初始化；读错/坏记录不得当空 registry。已提案并由 Host owner 文档接受 `sshRegistry:{schema:1,revision,instances}`；本模块不写 Vault，原 actor 负责该字段与私有凭据事务，不能直接把本模块私有结构覆盖整个 Vault。
2. `password`：managed 使用原 actor 的 native CSPRNG 并经原事务持久化，或取得已有 exact target 凭据；`managed:false` 缺少已有 native credential 时返回 Authentication，不猜密码或 Relay。adapter 仅委托，不从 JS 表单取得。SSH 登录本身只走系统 key/agent，不支持在 TS 输入 SSH 密码。
3. `restore`：只验证该 SSH target 已保存的 **direct** endpoint；无 authority 返回 None/稳定错误，最多降到一次普通初始化。不能返回 Relay commit，也不能把发现的 Relay host 当已配对。Native 当前尚无本模块的已配对 Relay restore 实现。
4. `authorize`：检查原 registry target/代际、前一 exact binding 与 Cancellation；对该 native forward 发起 `/auth/session`，按 Web 合同请求 `trustDevice:true, issueClientToken:true, clientKind:'desktop-local'`，dedupeKey/clientLabel 使用上面的 fresh candidate 隔离合同，在 Rust 中保留 token；认证 probe 与 durable 原连接-only 提交均成功后，才返回 `Committed {connection_id,receipt}`。不选 Host、不改旧 selected 版本或 lease。native 私有 loopback grant 只能允许该 forward，不能替用户关闭全局 HTTPS/redirect 策略。
5. `healthy/retire`：验证/退休 exact receipt，不靠 connection ID、origin 或当前选择猜测；过期 retirement 必须是无害 no-op，不能撤销后来一次授权。`retire` 不删除用户的整个保存连接，不停止远端手工服务。
6. `quarantine`：原 actor 同步撤销 authority 与下游服务。Vault conflict/unknown 归入 `Error::CommitUnknown`；不能返回普通 storage error 后继续使用旧凭据。

`Owner` 的 state mutex 内不调用 actor/driver。所有可能等待原 actor 的操作（包括 `new/save/cancel/shutdown/tick`）必须在服务 worker 上运行，**不能由原 actor mailbox 线程同步调用后再等待同一个 mailbox**，也不能阻塞 NSH engine/UI 线程。`tick` 由既有服务调度器调用，不新增另一个 Host authority 或全局连接 loop。原生收到 window/服务 shutdown 时先显式 `Owner::shutdown()`；worker 持有 Arc，不能只依赖 Drop 来触发取消。

最多 32 条 registry、4 个连接 worker；取消后 worker 仍计数到实际退出。同 request ID 绑定相同 payload，最多保留 4096 项、不淘汰后重放；耗尽明确 busy。attempt 全服务单调递增，删除/重新创建同 ID 不复用。健康失败先 exact retire，再延迟恢复；连续失败最多 5 次，已派发原生工作不会仅因 badge 变 idle 就被视为回滚。

## OpenSSH driver 与尚缺 parity

- 直接 `Command::new(executable).args(...)`，`BatchMode=yes`、已有 trusted host key、关闭用户 SSH config / ProxyCommand / LocalCommand / agent forwarding；`-L` 只绑定 127.0.0.1。固定远端 POSIX/Node 程序通过 stdin 发送，stderr 不回传；无本地 shell、任意用户命令或明文凭据日志。
- managed 要求 PATH 中 Node ≥22 与 npm，检查实际 Yuri 版本；用 `yuri status --json` + live `/api/system/info` 辨认 ssh-remote，再逐个验证 `yuri stop --port ... --json`。安装 exact `@yuriai/web` 与兼容的 `@opencode/cli@2`，只在最后 actor 提交后 Ready。external 不调用安装/停止/serve，但当前检查程序也要求远端 Node 可用。
- managed 当前采用安全的 verified-stop/restart 路径，没有完成 Web 的已知凭据同版本 daemon 复用、login PATH 选择、native-binding repair、bun/download/upload 安装 fallback。无法辨认/认证的 protected daemon 阻止替换，不冒险 kill。远端 bootstrap 有独占 lock；进程异常终止留下的 lock 不自动猜 stale 或删除。取消只保证本机 child/tunnel 清理，不保证已启动的远端包安装回滚；安全的异常 lock 恢复仍未完成。
- Windows cfg 使用稳定 `std::os::windows::process::CommandExt::creation_flags(0x08000000)`（`CREATE_NO_WINDOW`），不使用 cmd/batch、raw_arg、nightly show_window 或自创引号。官方依据：[Command args](https://doc.rust-lang.org/std/process/struct.Command.html#method.args)、[creation_flags](https://doc.rust-lang.org/std/os/windows/process/trait.CommandExt.html#tymethod.creation_flags)。没有 Windows target/SDK/OpenSSH/无闪窗实测。
- 尚缺原生 SSH config import、命令解析、IPv6、额外/LAN forwards、完整端口冲突确认恢复、Open/切 Host consumer 和完整远端 daemon 恢复。这些仍属于 parity 待办，不是从验收范围删减。

## 配置同步：真实文件 I/O 与尚未完成的边界

`ssh_sync.rs::SyncOwner` 的文件计划覆盖 Web 白名单：三个互斥配置按 `config.json → opencode.json → opencode.jsonc` 选第一个；`AGENTS.md`、`cursor-models.json`；agents/commands/skills（及目标 legacy counterparts）、snippet/snippets/plugins；HOME `.agents`。源缺失不删除目标。插件声明仅保留 NPM strings / legacy tuples / V2 objects 及其 options；无关 JSONC/BOM/comments 保留。扩展文件为 native `Vec<u8>`，支持二进制；拒绝符号链接、硬链接、越界/平台别名路径，排除 Web 的 node_modules/.backup/.venv-asc。采用 Web 的 512 MiB / 20,000 项上界（目录 marker 也计项；不是满规模性能证据）。

`Selections::parse` / TS 使用 exact `{fileGroups:[bool],singleFiles:[bool,bool],directories:[6 bool],agentsRoot:bool,providerCredentials:bool,magpie:bool}`；默认全部文件选中，敏感两项关闭。review exact `{runID,phase:'review',direction,files:[{name,bytes}],directories:[{name,fileCount,bytes}],agentsRoot:null|{fileCount,bytes},deletes}`。TS 严格校验 metadata，选择变更废弃旧 review；apply 不重新扫描源。unknown 纳入 Settings pending 保护，只读核验，不能导航绕过。

`Owner::capture_sync(id,attempt)` 返回 Rust-only `SyncGrant {instance,committed,cancel}`；`sync_current(&grant)` 与 exact receipt 复验。同一个公开 connection ID、同设备不同 Relay 或新的 attempt 均不能借旧 grant。健康检查临时移动 tunnel 不改变该有效 grant；cancel/退休/新连接使旧 grant 失效。

真实实现为 `ssh_io.rs` / `ssh_io_local.rs` / `ssh_io_remote.rs` / `ssh_io_remote.cjs`：

- `Local::new(native_trusted_home, identity)` 只接受 native HOME grant；`Remote::new(exact_instance, identity, Arc<dyn ProgramTransport>)` 固定远端 `os.homedir()`。`NativeDriver` 已实现 ProgramTransport，只经原受控 SSH stdin 执行同一固定程序，无 JS root/executable/command/shell 参数。至多两项 process I/O、300 秒期限，不代表性能验收。
- `NativeFiles::new(local, remote, grant.cancel.clone())` 是实际 Files 实现；原 grant 和单次 operation cancellation 合并传播，不允许只在启动时检查取消。
- 目标锁按 HOME 而非连接 identity 互斥，local 与固定远端程序共用 reservation；local 另持 OS file lock。跨 identity 的 applying/unknown 阻止后续写入，不通过换 ID 绕过。异常进程遗留 reservation **不自动判 stale 或删除**，只读 status/history 可继续；安全的显式恢复仍待实现。
- 先持久 prepared、备份与 metadata manifest、私有 staging，再重验目标 snapshot CAS，持久 applying 后逐文件 rename/delete/fsync，最后目录 mode、五代 GC 与 durable success。**不是整个目录原子提交或自动 rollback**；可能已修改时的取消/错误返回 SyncUnknown，保留备份和未知状态。文件/目录类型互换尚未完整支持。
- receipt 位于 `.config/opencode/.yuri.sync-runs/<identity>/<run>/receipt.json`，为原始 JSON record 字符串＋SHA-256 envelope；new file fsync → rename → parent fsync。摘要是损坏检测而非认证。Unix 私有事务/备份目录须当前 euid 且无 group/other 权限，新建为 0700。失 ACK 只读 durable receipt，绝不根据目标内容相似性推断成功。prepared 仅在无 reservation / 无 OS 写锁时可证明未动目标；applying/unknown 不自动升级。
- config 与 agents backup 位于 Web 对应备份根下，generation key 为 `<identity字节数>-<identity>-<run>`，避免分隔符歧义；备份更改/删除前的内容和原 mode/version/hash manifest，保留五代 backup，run metadata 继续保留。history 仅导出 exact `{schema,runID,phase,startedAt,endedAt,files,bytes,applied}`，不导出文件内容、路径或凭据。

**阻止完整验收/生产注册的未完成项：** ancestor 路径检查到 open/rename/delete 的置换竞态尚未用 pinned directory handles 封闭；普通外部写者不服从此锁时，最后一次 CAS 检查到 rename 的窗口仍存在；Windows ACL / 原子替换 / directory fsync 和真实 SSH 取消未验收。不能把静态拒绝 symlink 的测试当作 race-proof 文件事务。

Provider keys / Magpie 在完整 sync 中仍返回 Unavailable，UI 显示未提供，不假装随文件成功。原 actor owner 正实现独立的 `connection_actor_http_port.rs` / `connection_actor_http.rs`；本线程只读其公开签名，未修改这些文件或 bridge。Magpie→files→Provider keys 的持久完整 run coordinator、partial/rollback 与跨进程 run→方向/grant 关联仍未完成；当前 file receipt 成功**不是完整同步成功**。跨进程可读 file history，但不能靠它重建或重放 apply。

### 独立敏感 HTTP adapter（仅测试编译）

`ssh_http.rs` 通过真实 `connection_actor_http_port::Port` 的六个固定 Request 工作，不接收 URL/path/headers/token，不调用 Vault、Network、quarantine 或冻结的连接 Command。当前入口：

```rust
ssh::http::Adapter::remote(port, grant: ssh::SyncGrant) -> native_http::Result<Adapter>
ssh::http::Adapter::local(port, cancellation) -> native_http::Result<Adapter>
adapter.inventory(Kind::{Credentials,Magpie}, &cancellation) -> Result<Inventory>
adapter.export(kind, &cancellation) -> Result<Transfer>
adapter.import(transfer, &cancellation) -> Result<Ack>
```

- `remote` 只移交 exact native connection ID/receipt；每次复验由原 Port/actor 所有。Current 仅捕获 grant lifetime 与单次 operation 的组合 Cancellation，不锁 owner、不解析当前主 Host。
- `local` 只能取得原 Port 的不可伪造 LocalServiceGrant；当前 `local_service()` 明确 Unavailable，所以此入口在提交前失败。没有本机 service producer，不猜 localhost、不以选中的远端 Host 替代，也不另建本地 credential/Magpie 实现。
- `Transfer` 只有私有 kind/bytes，无 Debug/Clone/Serialize 或公开 bytes accessor，export→import 原样移动、import 消耗；不解析/复制敏感 envelope，不写磁盘或公开 snapshot。字节上界复用 Port 的 512 MiB。完整 envelope 验证及原生导入仍由 Host receiver 所有。
- inventory/ACK 最多 1 MiB，按真实 `routes.js` / `credentials.js` / `magpie.js` 校验。Inventory 仅返回 Provider keys 的 `Option<bytes>` 或 Magpie available/installed；读错/非 2xx 不当空成功。ACK 只接受 `ok:true` 与三种已知 Magpie warning；错误正文/额外字段不回传。
- 原 Port Error 原样保留，尤其 `Unknown`（HTTP mutation 不明）与 `CommitUnknown`（authority 已隔离）不合并。非 2xx、超限/坏 ACK 同样是 Unknown；该 adapter 永久 fence 后续 import，但仍可只读 inventory/export。CommitUnknown 则使该 adapter 后续所有请求失败。没有自动 retry、quarantine 或根据 inventory 相似性升级成功。
- import 同一时刻最多一个，额外调用 Busy 且不保留；原 Port 的全局两个 raw queued/running permit 继续生效。**该 fence 只在 adapter 内存中**，不能通过新建 adapter、重启或重导出清除未解决写入；尚缺的 durable run coordinator 必须保留 Unknown，当前没有可证明提交结果的敏感 run receipt/status seam。

以上是与真实 Port 类型编译的独立合成 adapter，不是原 actor HTTP 生产回归或完整同步 available 的证据；连接-only service、HostChannel 方法和 `sync.supported:false` 均未改动。

## 本次验证与下一步

| 证据 | 结果与边界 |
| --- | --- |
| 整包 `tsc --noEmit -p packages/nsh/tsconfig.json` | 本轮通过；未修改范围外 task editor。翻译使用现有十语 key |
| `desktop-remote-connections-core.test.ts` | 13 项；协议、原 editor CAS、unknown/只读核验、完整文件 review/selection/history metadata、失败保 prior、迟到 fence 与十语 |
| `desktop-remote-connections-engine.test.ts` | 显式启用后 macOS/Windows headless 两场景；真实 NSH slot/dirty guard/范围选择/目录与 agents review/history/动作调用，不是平台窗口/网络 |
| `desktop-remote-connections-native.test.ts` | 当前 35 项；实际六方法 DTO、capability exact/失败关闭、current/runtime-ready 分离、只读重验、bootstrap/capability epoch、未知 ACK 零重放、native Denied 与 lookalike 区分、opaque ID 与 teardown。与 core 13 合计 48 项纯 TS 通过 |
| `desktop-remote-connections-native-engine.test.ts` | 显式启用后的 macOS/Windows × ready/denied/partial/late 共 8 场景；真实 loader + 严格 `--web-host` + 实际 connection-only slot，验证 read/save/check/start/cancel/remove、dirty/pending/unknown、runtime-ready 临时失效与 sync 元素零挂载。未使用真实系统 SSH/Host/Vault |
| connection-only consumer 本轮合并验证 | 以上四个 Vitest 文件共 58 passed、0 failed、0 skipped；整包 `tsc --noEmit -p packages/nsh/tsconfig.json` 与 Settings UI audit 通过。命令使用该包独立 `--root . --config packages/nsh/vitest.config.ts`；根 workspace `--project` 此次未发现文件，不将其算通过。未改 application/main/Rust 或增加产品 grant |
| `node packages/nsh/desktop-host/fixtures/check-ssh.mjs` | 当前 61 passed、0 failed、0 ignored：原 48 + 独立 HTTP adapter 11 + 新 HTTP Port 自带 2；另对实际固定远端程序做 Node syntax-only check。adapter 覆盖六请求/私有 bytes、local Unavailable、exact metadata、八种 Error、不明写 fence、坏 ACK、组合取消、并发 import、无效 receipt/导出。不是原 actor Network/Vault 垂直回归 |
| cfg/lint 修复后的 `cargo clippy --offline … --all-targets -- -D warnings` | HTTP seam 接入前通过；本轮 HTTP adapter 后重跑被尚未生产消费的新 bridge getter/HTTP Port dead-code 阻断（8 errors），未改 owner 文件或增加假消费/全局 allow。当前 focused `--tests --example synthetic_smoke -- -D warnings` 通过 |
| HTTP adapter 后的 `cargo test --offline … --bin yuri-nsh-desktop --example synthetic_smoke 'ssh::' -- --test-threads=1` | binary / example 各 57 passed、0 failed、0 ignored；仅运行 SSH 测试，未重跑其它聚合回归。显式注入自建临时根 `NSH_SSH_IO_FIXTURE_ROOT` 与固定 `NSH_SSH_IO_NODE`，finally 清理；含 I/O 的 Cargo 测试必须提供这两个 fixture 环境变量 |
| Host owner 报告的生产桥合成垂直测试 | 2 passed、0 failed、0 ignored：真实 HostChannel/QuickJS → service → Adapter → 原 Port/Vault/异步 Network；覆盖 managed mint/probe/Ready、公开数据无 secret、shutdown exact retire 后原 actor 才退出，以及 unsupported driver 零 Vault、`sync.supported=false`。此为 owner 报告，本线程未独立重跑，不证明真实 SSH 或安全同步可用 |

standalone Rust harness 链接已缓存的 serde_json rlib，不修改 Cargo/main、不安装依赖。fixture 在批准临时根内自建 HOME，仅执行该固定程序并 finally 清理自己的目录；不启动 SSH、用户命令、Vault、真实 Host、用户配置写入或窗口。它不证明模块已进生产 binary、系统认证/凭据、远端安装、Windows cfg 或实际 OpenSSH 取消可用。

Settings UI audit 通过。`bun run dead-code` 已运行，但加载 Web vite config 时因既有 `vite-plugin-pwa` 缺失而失败，未完成报告；命令输出了 `Saved lockfile`，没有为规避错误安装依赖或手工调整锁文件。

下一步先封闭文件路径竞态和类型互换、补安全异常 lock 恢复，再补真实本机 service producer 与完整敏感同步 coordinator，并验证原 actor HTTP seam；Host owner 继续唯一持有 registry/credential/auth-commit/retirement 的生产装配与垂直验证。本轮 adapter/focused 检查不代替其聚合测试，也不开放 sync capability。未完成项继续保留，不能缩成表单保存成功或 headless 通过。
