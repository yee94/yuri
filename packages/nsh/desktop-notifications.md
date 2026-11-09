# Desktop native notifications slice

## 交付边界

`desktop-host/src/notifications*.rs` 保持独立模块，现已由主 Host 生产源码安装，并接入连接 actor publication、native activity、UI mailbox、Control shutdown 与 Vault intent handoff。**当前边界是“生产源码已接入、合成集成已有通过证据、真实 OS 验收未完成”，不是 macOS/Windows 通知全链路已验收。** Darwin 编译、metadata 检查或 installer artifact 都不能证明 Windows 已完成。

本轮只更新本文档，不修改 Host owner 维护的入口、Vault、grant、installer 或通知实现。验证结果按执行方与轮次分别记录，见末节。

依据是现有 `notification-core.ts`、`notification-launch-transport.ts`、`notification-global-recovery.ts`、Web `server/lib/notifications/admission-event.js`、iOS `NotificationBridge.swift`，并核对 Electron `main.mjs` 的 originating-window/runtime fence。保留原有窄 wire，不接收 Host 文本、URL、credentials 或任意通知模板。系统标题/正文逐语言复用 iOS 的十语言固定隐私文案。

## 生产 ownership 与 API 合同

| owning 源码（相对 `packages/nsh/`） | 当前生产职责 |
| --- | --- |
| `desktop-host/src/main.rs`、`desktop-host/src/native_ui.rs` | 通用 bridge 后、JS load 前 prepare application、取得 private Store grant、安装通知及 platform factory，将 `UiInbox` 交原生 loop。grant 失败时每个通知方法明确 reject `notification_unsupported_private_directory`，不伪成功。 |
| `desktop-host/src/host_services.rs` | `Port` 通过 `Arc<OnceLock<Arc<notifications::Owner>>>` 持有一次安装的 Owner；连接 actor 发布 durable identity 并去重。安装等待不持 State；安装后重查 `state.live`，避免 shutdown 漏掉迟到 Owner。 |
| `desktop-host/src/native_ui.rs`、`desktop-host/src/native_ui_windows.rs` | 真实 application activity 无 Host State mutex 转发，UI mailbox 使用 owning NSWindow/HWND 执行 job；关闭先经 Port 执行通知 Control fence，再做其余 services 收尾。 |
| `desktop-host/src/bridge.rs`、`desktop-host/src/notification_retirement.rs` | Vault 同事务写 bounded retirement intents，Store durable tombstone 后新 Vault 事务清 exact intent；启动恢复、安装后 `RefreshNotifications` 及显式 `connection.list` 恢复／重试。 |
| `desktop-host/src/notification_store_grant.rs`、`desktop-host/src/private_directory_windows.rs` | Host 自选目录、平台权限及祖先检查；grant handles 随 Store 持有。不是 JS 路径或普通 AppData 目录即获信任。 |
| `scripts/native-notification-installer.mjs`、`scripts/install-native-notifications.ps1`、`desktop-host/src/notification_identity_windows.rs`、`desktop-host/src/runner_args.rs` | Windows build artifact、显式 per-user 安装、runtime identity 回读与严格 cold 参数解析分层；build/startup 不执行安装注册。 |

1. 生产入口已声明 `mod notifications;`，经 bridge/services 在通用 bridge 安装完成后、JS load 前调用一次 `notifications::install(&host, storage, factory)`，保留返回的 `Owner`、`UiInbox`。独立 examples 只是 compile/test 载体，不是生产入口，不链接进产品。
2. 原生 Host 创建自己的专用本地 private directory，再构造 `store::FileStore::in_private_directory(&dir)`；**目录不能来自 JS/Host path**。macOS 要求 mode 0700；Windows owner 必须提供受保护当前用户 DACL、可信且无 reparse 的父目录。模块拒绝末级 symlink/reparse，持有 flock（Mac）或 share=0 lock-file handle（Win）到 Store drop，防止第二个通知进程覆盖同一 inbox。Windows DACL/祖先路径的创建和验证仍属于调用方 grant，不能把普通 AppData 目录假称已验证。
3. `Factory` 为 `Box<dyn FnOnce(Activation) -> Result<Box<dyn Driver>, String> + Send>`，**由内部 worker 调用**。不要在 UI/Engine 线程先构造 COM 对象后跨线程搬运：

   ```rust
   #[cfg(target_os = "macos")]
   let factory: notifications::Factory = Box::new(|activation| {
       Ok(Box::new(notifications::macos::Native::new(activation)?))
   });
   #[cfg(target_os = "windows")]
   let factory: notifications::Factory = Box::new(move |activation| {
       Ok(Box::new(notifications::windows::Native::new(installed_identity, activation)?))
   });
   let (owner, ui_inbox) = notifications::install(&host, Box::new(storage), factory)?;
   ```

   install 等待 worker 构造结束（上限 5 秒），保证委托/COM registration 已安装才返回；driver 构造失败保留稳定错误给 status/request/live/test，不伪造可用平台。Mac 必须先在主线程创建真实 NSApplication（Native 检查 NSApp 非空，绝不在 worker 初始化 AppKit），再在 didFinishLaunching 返回前执行这一安装，不能等 JS ready 或第一次 test 才装 UN delegate。已有其它 UN delegate 时明确拒绝，不抢占。
4. 同一个连接 actor 从**已 durable commit 的 selected connection**创建 `Identity { host_id, authorization_id, runtime_lease }`，调用 `owner.publish(Some(identity))`。三个字段只含公开标识，不含 token、origin 或请求对象。authorization 必须是 native owner 的非 legacy durable generation；origin/授权变更必须换 authorizationID，transport 恢复只换 runtime lease。切换/删除 selected、quarantine、失效前先 `publish(None)`；成功后再发布新的 selected。非 selected metadata 操作不要重复发布。每次 publish 都同步 fence，不等 OS add；但它与正在进行的 durable ACK 共用 native identity 锁，ACK 写盘期间 publication 会串行等待，**应在连接 actor 调用而非 UI 阻塞等待**。固定锁序 identity→inbox，不能在切换已生效后提交旧 ACK。旧排队调用、claim 和 late add 不能接管新身份。
5. lifecycle 路径不得先锁 Host State 再取 Owner。当前生产 `Port` 从 OnceLock 无锁取得共享 Owner，`Port::set_foreground` 调用 `owner.set_foreground`，后者转发给只操作原子的 Control；不取 State、publication、identity 或 receipt mutex。也可在 install 返回后提取 `owner.control()`，由 UI 独立持有可 Clone/Send/Sync 的 Control，但生产不要求这一持有形式。activity 必须来自 Mac application active/resign、Win `WM_ACTIVATEAPP`；初始化默认 false。不要用 TS 声称、窗口是否最小化或“引擎已运行”替代。不要因普通失焦轮换 Host lease。
6. 在已有 UI mailbox 调度位置、退出 RefCell/其它 UI mutable borrow 后，每轮至多取一项 `ui_inbox.try_recv()` 并 `unsafe { job.run(live_native_window) }`。参数只准真实 owning NSWindow*/HWND。这里实际导出了 `try_recv/run`，**没有 register/poll/pump 虚构 API**：`openSettings` 只在显式调用后入队；已验证 OS 点击只入队 focus，永远不直接导航或切 Host。focus 的 Store 检查使用 try_lock；ACK 写盘占锁时把 job 放回 bounded mailbox、等下一轮，不在 UI 等磁盘。队列满只丢 focus hint，持久 receipt 不消费。系统拒绝前台激活不会消费回执；UI 仍可在恢复前台后 peek/recover。focus 不修改 Windows 的正常/最大化几何，仅恢复最小化窗口。
7. `owner.activation()` 是 Rust-only 的备用系统 ingress，`Activation::receive(uuid)` 只接受 UUID，查私有记录后持久化点击。Mac UN delegate、Win COM activator 已自动调用它；若外层生命周期也收到**相同默认动作**，可再次转同一 receipt，持久去重。外层必须先验证它来自系统 native callback、exact request prefix/default action；**不能把任意 deep link/JS 参数直接喂入它**。不要把 OS payload 的 target、Host、目录当 authority。
8. 只有显式撤销/删除授权或替换 authorization，退休 exact saved connection ID＋旧 authorizationID。`commit_retirement(host, authorization) -> Result<()>` 独立提交 durable deny tombstone，不取 driver、不入 worker 队列；**Vault 跨存储 intent 只以这个返回值为清除依据**。`retry_retirement_cleanup(host, authorization) -> Result<Receiver<Result<()>>>` 仅清已有 tombstone 的 OS 残留：零 receipts 直接返回 ready Ok，不取 driver、不调用 OS；有 receipts 的 unsupported/失败保留 Store 待清记录供显式重试。`retire_authorization(...)` 仍是两步包装，不能用它的整体 Err 推断 tombstone 没提交。receiver 必须在 actor/worker 等待，**禁止 UI 阻塞等待**。worker 先让先前 add 结束，再 remove、读取系统 pending/history 验证不存在，才删待清记录。下次启动也做一次 pending retirement 恢复尝试；`pending_retirement_cleanups() -> Result<Vec<(String,String)>>` 返回仍有 retired receipts 的去重 connection/authorization 对，unknown Store 返回 Err 而非空列表。即使当前无 OS 通知，也保留 bounded authorization tombstone，旧授权永远不能再次 reserve。
9. 关闭时在 stop AppView/销毁窗口前先执行通知 Control fence。生产 `Port::shutdown` 从 OnceLock 获取 Owner 并调用 `owner.control().shutdown()`，**先 fence、后取 services State mutex**；不是先等 actor/identity/ACK 才撤权。Control 只持三个共享原子字段，不持 identity、Store、HostChannel 或 window；setter/shutdown 不取任何 mutex、不做 I/O、不排队、不 join。shutdown 首次设置 terminal stopped 并轮换 generation，重复调用幂等；迟到 foreground=true 不可恢复权限。Owner 的原 `shutdown(&mut self)` 和 Drop 也是相同无锁 fence＋detach。物理 identity 清空、旧 OS 调用结束、delegate/COM 释放由 worker 完成；已进入的 durable ACK 允许完成，不能声称被 shutdown 回滚。随后销毁／drop UI inbox 使未执行 job 的 HostReply 失败。这里只保证通知 fence 不等待，**不声称整个 Port services shutdown 或 OS callback 均无阻塞**。普通 shutdown/lease 变化不删除正常的持久 launch records，否则冷启动点击会丢失。

   以下是直接持 Control 的最小 seam 示例，不是生产 Port 持有结构的逐字实现：

   ```rust
   let (owner, ui_inbox) = notifications::install(&host, Box::new(storage), factory)?;
   let ui_control: notifications::Control = owner.control(); // 在移入 actor State 前取一次
   // actor 保存 owner；UI 保存 ui_control.clone() 和 ui_inbox。
   ui_control.set_foreground(actual_application_active);
   // UI teardown 的第一步，不进入 actor 的 State mutex：
   ui_control.shutdown();
   // 随后 stop AppView / 销毁 owning window / drop UI inbox；actor 自行收尾 Owner。
   ```

生命周期性能合同：0～256 条 receipt、ACK/Store 锁被持有时，Control 路径仍是固定原子操作、零 receipt 扫描/分配/磁盘/队列等待。set_foreground 最多两次 load 和两次 store；shutdown 一次 swap、一次 store，且仅首次追加 generation fetch_add。合成测试持有两个实际锁、或暂停真实 ACK commit，验证 UI fence 可以先完成；这不是图形会话的延迟/p95 或全部系统通知 callback 已无阻塞的实测结论。

### Vault／通知 Store 跨存储退休顺序

生产 Vault 记录使用可选 `notificationRetirements` 数组，元素为 exact `{hostID,authorizationID}`，其中 hostID 是 saved connection ID；最多 256 对、禁止重复／legacy authorization。无论通知 Store 当时是否可用，actor 都在同一事务保存授权替换/删除与旧授权 intent；通知 unsupported 不禁用其它服务，intent 留待通知 Store 可用时 handoff。不要先永久 tombstone 再尝试一个可能确定失败的 Vault 写入。Vault commit 确认后，fence 旧 authority，逐条 `commit_retirement`；只有 Ok 才在新的 Vault 事务中清该 exact intent，不重放 connect、生成新 authorization 或重做删除。清 intent 的 Vault 写失败时保留 intent，下次幂等提交同 marker 即可；已证明 durable marker 的 replay 不再次写 Store。普通写失败、容量不足或 `notification_store_unknown` 都不能清 intent。

启动从 authoritative Vault 恢复 intents；安装后 `RefreshNotifications` 对已加载的 actor state 补做 handoff，再发布 notification identity。pending intent 或 `notification_store_unknown` 阻止恢复通知 authority，不能静默跳过。unknown 在本进程 sticky，`connection.list` 也不重试恢复 authority；需下一进程核验实际持久结果，不能重放 reauthorization 或靠内存猜测。

OS cleanup 与 Vault intent 完成分离：tombstone 已提交后，无论 driver unsupported、OS remove 失败或 mailbox 满，都可以清 Vault intent；残留清理归通知 Store 的 retired rows 和显式 retry，不得重放已提交连接操作。每次 recovery 最多重试一个待清 OS pair，actor 等待上限 2 秒，超时为 `notification_cleanup_pending`；`connection.list` 是显式恢复／重试入口，没有新增 timer，不请求权限、不发送通知。

连接 snapshot 仅在存在 intents 或错误时附加 `notificationRetirement:{pending,error}`。`pending` 是 Vault intents 数，不是 OS 残留数；OS cleanup 失败可出现 `pending:0` 且 `error` 非空，不能据此推断授权变更未提交或重发 connect。Host owner 实现 Vault 格式和事务，通知模块只拥有 Store tombstone／cleanup seam。

TS 端仍用现有唯一 notification root、settings transport 和 launch transport。Host 侧不得另起事件流、定时拉消息、派生第二套 notification classifier 或在点击时自动连接另一 Host。`notification.launch.available` 只是可丢失的唤醒 hint，私有 inbox/peek 才是 authority。内部 100 ms receiver timeout 仅检查 shutdown，不查询系统/Host，不是通知 polling。

## Wire 与权限语义

| 方法 | 合同 |
| --- | --- |
| status `{}` | 只读真实系统状态；严格保留 authorization/alert/sound/badge/backgroundPush:false |
| request `{}` | 仅真实前台、显式调用；Mac 仅 notDetermined 调用系统授权，Win 无 per-app prompt，仅回读真实 Setting |
| openSettings `{}` | 仅前台显式调用，UI mailbox 打开系统 Notifications 页面；路由失败 reject |
| configure | exact `{hostID,enabled,mode,events,language}`；同配置/同代幂等；更新配置轮换 notification lease 并 fence 旧 presentation/claim；不请求授权、不发送 |
| live | exact `{lease,eventID,kind,target,admission}`；native 再验 Web proof 全部字段与 namespace；默认 enabled=false，按用户偏好决定；desktop `always` 允许前台，hidden-only 抑制前台 |
| test | exact `{hostID,language}`；仅当前身份/前台显式调用；不会顺带申请授权，不需要先启用 live 偏好 |
| launch.peek `{}` | Host 恢复前可读 `{record:null|record}`，只返回持久 queued 的第一个正常回执 |
| launch.claim | exact `{receipt,connectionID}`；实际前台、已 configure、当前 native generation/authorization；返回 exact `{record,route:{hostID,lease,target}}` |
| launch.ack | exact `{receipt,connectionID,lease,expectedRevision}`；必须已有同 lease/revision claim；磁盘成功才 `{ok:true}`；先持久消费，再 best-effort OS 视觉清理，视觉失败不伪造 ACK 未提交 |

`scheduled` 只代表系统接受提交，**不是 delivered/用户看到了**。Focus Assist/勿扰、用户 alert/sound 设置、系统限额仍可使其不可见。无权限返回 notification_denied，非可用平台/身份返回明确 unsupported 错误，不回退 Alert、balloon 或 fake success。安装、配置和 status 从来不会触发权限弹框或 test。

## 回执、故障和有界性

- OS 只获得 `yuri.nsh.local.<UUID>` 与 `{v:1,receipt}`（Win 为同 prefix launch 参数），不获得原始目录、session/assistant、Host authorization 或 bearer。目录仅在 app-private admission source 中保留，以便 existing TS catalog resolver 验证 exact session/directory；assistant、schedule 不冒充 session。
- 正常回执沿用 `{v,receipt,revision,connectionID,authorizationID,admission,createdAt,expiresAt}`，有效期 7 天。先持久 reserve 再 add；失败/未知结果不重放同 event。内存 seen 最多 256，持久 outstanding 最多 256；满时拒绝新提交，**绝不淘汰未 ACK 点击**。多个点击逐个保留，重复点击不新增、不覆盖另一 queued receipt。
- claim 只绑定当前 runtime，普通切 Host/reconnect 使 claim 失效但不抹记录；重新切回同 durable authorization 后须 configure/claim，再 ACK。跨 origin/重新授权不能拿到旧回执。测试回执没有导航 admission，不可 claim。
- FileStore：最多 8 MiB；私有目录中随机 create_new stage、完整写与 sync、替换后回读；Mac 再 sync directory。Windows 用 MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)，不把 API 返回错误视为一定未提交。回读无法证实 candidate 或 prior 时 `notification_store_unknown`，inbox quarantine，不假装空成功、不继续 ACK。格式损坏拒绝启动，不清空旧文件。
- 点击 commit 的确定失败保留最多 256 个内存待持久点击，后续 peek 重试。**磁盘永久失败/进程在未持久化期间崩溃无法承诺零丢失**；当前进程保留错误，不返回虚假 ACK。store unknown 需下一进程重新核验，不能盲重置。
- Mac add 超时仍保留真实 pending callback；retirement 不会在 pending 未 settle 时 ACK absence。迟到 callback 再验 native scope/停止/retirement，并移除迟到提交。新启动保留 tombstone 后再次核验系统清理。持久 tombstone 最多 256 个、不自动淘汰；上限明确 unavailable。
- 当前不会自动淘汰过期/未消费的正常回执或测试回执；容量耗尽需明确管理/授权退休，不用静默删记录冒充无限可用。这是容量/维护限制，不是无限 exactly-once 保证。

## 平台与 ABI 证据

### macOS

实际调用 `UNUserNotificationCenter` settings/request/add、pending/delivered 查询和精确 remove；保留强 delegate，公开委托回调检查 exact prefix、v/receipt/default action，willPresent 在最后时刻重验 native fence。仅在 application bundle 有 bundleIdentifier 时获取 center；无 bundle 或已有 delegate 明确拒绝。没有 APNs/background networking，backgroundPush 恒 false。

无新增 block2/objc 依赖：使用 NSH 0.4.0 已公开 re-export 的 objc2/Foundation；自持 Clang Blocks ABI，copy/dispose 持有 Arc，超时不会悬空；BOOL signature 区分 arm64 `B` 与 x64 `c`。worker 的构造/操作/销毁以及系统 block callback 各自有 autorelease pool，不依赖 std thread 自带 Cocoa pool。链接 UserNotifications/CoreFoundation。查证本机 SDK `UNUserNotificationCenter.h` 的 authorization/presentation bits、callback 参数与 weak delegate；Blocks 布局对照 [Clang Block ABI](https://clang.llvm.org/docs/Block-ABI-Apple.html)。纯 block ABI tests 不查询通知中心或打开窗口。

macOS 没有公开 UN app-specific settings opener；显式操作通过 NSWorkspace 打开 Notifications 系统 pane URL `x-apple.systempreferences:com.apple.Notifications-Settings.extension`。该系统 URL 不构成 Apple 稳定 API 保证，旧 OS/路由变更会 unavailable，不能声称覆盖所有 macOS 设置深链。

### Windows 10+ desktop

实际源码：RoInitialize(MTA)、RoGetActivationFactory、HSTRING、XML DOM LoadXml、ToastNotificationFactory、ToastNotifier Setting/Show/Hide、ToastNotification2 Tag/Group、ToastHistory remove/readback。UUID 分成各 16 个 hex 的 tag/group，组合仍保留全部 128 bit，不靠可能冲突的短 hash。

实现真实 IClassFactory/INotificationActivationCallback、IUnknown/IAgileObject、原子 COM refcount、CoRegisterClassObject/CoRevokeClassObject；检查 exact process AUMID、callback AUMID/default launch 参数、忽略任何 user-input action。不使用 WinRT toast per-object Activated handler冒充冷启动；由同一个系统 COM activator覆盖 warm/cold。

**生产 installer／identity 源码边界（不等于已执行注册或已 ready）**：

`build-desktop.mjs` 经 `native-notification-installer.mjs` 仅生成 `native-notification-identity.json` 和 `Install-Notifications.ps1`；后者源文件为 `install-native-notifications.ps1`。只有用户显式运行该 per-user installer 才创建 shortcut／LocalServer32；build 和 startup 不代执行注册。runtime 的 `notification_identity_windows::installed()` 必须回读实际 `.lnk` target 等于当前 exe、arguments 为空、AppUserModel.ID 与 ToastActivatorCLSID 均精确匹配 artifact；artifact 存在本身不是安装证明。

1. 在构造 Native 前设置产品 exact process AUMID；Start Menu shortcut 持有相同 AppUserModel.ID 和 ToastActivatorCLSID。
2. 当前用户 `Software\Classes\CLSID\{CLSID}\LocalServer32` 的默认 REG_SZ 必须为 `"<actual-exe>" --notification-activation`。Native 真实 RegGetValueW 回读并与当前 executable 比较，缺失/不符为 notification_unsupported_identity；不代写注册、不运行注册命令。当前只支持这套 per-user 注册，不推断 HKLM/packaged identity 等价。
3. `runner_args::parse` 在 Windows 只接受 exact `--notification-activation`，可再带一个 `-Embedding` 或 `/Embedding`；拒绝 cold mode 混入 `--bundle`、Host、receipt path 或其它参数。使用既定本地 bundle／receipt Store 安装 COM class factory，再交真实 application loop；不把 activation 参数当连接 authority，不自动发送或跳过 existing TS 恢复确认。只注册 factory 而没有 shortcut/LocalServer32，不算冷启动已接通。
4. Windows callback 可来自 RPC 线程；它先持久接收再返回 HRESULT，UI focus 交 mailbox。系统仍可能拒绝 SetForegroundWindow；回执保持 queued，不能自动 ACK。

私有目录 grant 已有生产源码：`notification_store_grant.rs` 包装 `private_directory_windows.rs`，从真实 Known Folder LocalAppData 与当前用户 SID 建立受保护 DACL，打开 handle 回读 owner／DACL，固定无 reparse ancestors 并随 Store 保留 handles；不信任环境或 JS 路径，不修补陌生目录权限。**这些 Windows-only 检查尚无目标平台运行验收**，不能因源码存在就声称 DACL、锁或崩溃持久性已证明。

WinRT GUID、IUnknown+IInspectable 前六槽、method slot/参数来自微软 [Windows.UI.Notifications 生成源码](https://github.com/microsoft/windows-rs/blob/master/crates/libs/windows/src/Windows/UI/Notifications/mod.rs) 与 [XML DOM](https://github.com/microsoft/windows-rs/blob/master/crates/libs/windows/src/Windows/Data/Xml/Dom/mod.rs)。COM IID/Activate 的 LPCWSTR、NOTIFICATION_USER_INPUT_DATA、ULONG 参数查证微软 [NotificationActivationCallback.h](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/NotificationActivationCallback.h)；设置流程见 [COM activation API](https://learn.microsoft.com/en-us/windows/win32/api/notificationactivationcallback/nn-notificationactivationcallback-inotificationactivationcallback)。本地源码没有引入 windows crate/SDK。

## 已执行的验证与未验收

使用固定 NSH 0.4.0 checkout 的 source patch config；examples 不构造任何真实 Native driver，不读真实 Vault／用户 Host，不打开系统通知、权限窗口或设置。独立 harness：

```sh
cargo --config packages/nsh/.nsh/desktop/cargo-source-patch.toml test \
  --manifest-path packages/nsh/desktop-host/Cargo.toml \
  --target-dir packages/nsh/.nsh/desktop-target --example notifications_contract
cargo --config packages/nsh/.nsh/desktop/cargo-source-patch.toml check \
  --manifest-path packages/nsh/desktop-host/Cargo.toml \
  --target-dir packages/nsh/.nsh/desktop-target --example notifications_windows_typecheck
```

`notifications_windows_typecheck` 把**实际** Windows driver 源码纳入 Darwin metadata frontend；常量断言检查 GUID、COM vtable/object 首地址、UserInput 的 pointer-width layout。它不是替代 Windows std 的假 shim，但也**不是 Windows target、Windows 链接或 DLL/COM 运行验证**，不覆盖 `FileStore` 的 Windows-only std 分支。DLL link 属性只在真实 Windows target 启用，default example main 为空，避免新增 example 使 Darwin 的常规 Cargo examples 构建失败；Darwin 仅允许纯 layout tests，绝不构造 Windows Native 或调用其系统函数。

通知模块 owner 上一轮独立执行 `notifications_contract`：**38 passed / 0 failed / 0 ignored**，其中 notifications 新增 29 项，复用 policy/vault 的既有纯合成 9 项。覆盖八域 Web admission 真源码对照、十语言 iOS 文案对照、默认无副作用、foreground/mode、denied、exact claim/ACK、多个点击、写失败/unknown quarantine、退休 OS readback 失败重试、迟到 add、容量、private-file 独占/损坏、Blocks copy/dispose 和布局，以及 unsupported driver 的零/非零 receipt、durable marker 幂等、失败/unknown handoff、恢复时 marker/retired-row 一致性、Control 的锁争用/暂停 ACK/迟到 publish/终态与 focus 非阻塞重排。两个 examples 的 `cargo clippy -- -D warnings`、Windows 实际源码 metadata `cargo check` 通过；随后仅为两个 optional API 添加局部 documented dead-code allowance，production bin Clippy `-D warnings` 与独立 38 项再验通过。`bun run dead-code` 已运行，但仓库已有 `packages/web/vite.config.ts` 缺少 `vite-plugin-pwa`，未能完成；未安装依赖绕过。

通知模块 owner 同轮另外执行了 `cargo build --example notifications_windows_typecheck` 验证默认空 main 在 Darwin 可链接，以及 `cargo test --example notifications_windows_typecheck windows_source::abi_tests::com_layout_and_uuid_split_are_exact`：**1 passed / 38 filtered out**。这项只检查真实 Windows 源码的 GUID/layout/tag-group/XML escape 纯算法，没有构造 Native、加载 Windows DLL 或调用任何 Windows 系统函数；filtered out 的共享 tests 不计为再次通过。

Host owner 最终报告（亦已记入 `desktop-host/README.md` 的 exact 账本）：scoped binary **181 passed / 0 failed / 0 ignored**、synthetic example **181 passed / 0 failed / 0 ignored**，独立 `notification_host_contract` **42 passed / 0 failed / 0 ignored**；scoped Clippy 与 Mac build 通过。最终聚合已包含 consent 磁盘测试、通知 Store 不可用仍保留 Vault intent／不禁其它服务，以及安装等待期间 shutdown 拒绝迟到 Owner 的回归，不再沿用早期 162 项结果。这是 Host 执行的结果，不是本文档更新者重跑。

`notification_owner_tests.rs` 使用真实 actor／HostChannel／QuickJS，注入 synthetic Store／Driver 验证生产接线，不调用真实通知。binary 与 example 的额外项不同，同为 181 不表示集合完全相同；独立 harness、聚合与 ABI tests 有重叠，各自记录，不相加声称独立覆盖数。上述通过仍不代表 UI、真实系统通知或 installer 注册已验收。

本轮仅做文档与当前生产源码的一致性核对，不重跑 Rust 聚合，不启动 Native driver，不读取真实 Vault／凭据／Host，不打开通知、权限或设置窗口，不执行 installer 或系统注册。

仍未验收：真实 Mac UN permission/denied/banner/click/cold launch、系统设置 URL、Mac x64、Windows target 编译／SDK 链接／实际 installer 注册／Show／Denied／Focus Assist／COM warm+cold activation、Windows DACL／锁／MoveFileExW 崩溃语义，以及图形会话下前后台 lifecycle。Host owner 报告离线 Windows target 检查仍被缺失的 `byteorder-lite` 阻塞；没有安装 SDK、target 或依赖绕过。生产源码接线与合成测试不填补这些缺口；后续平台验收必须使用独立 synthetic identity/store/installer，不读取现有用户通知或凭据。
