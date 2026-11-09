# Native window kernel：当前可消费合同与未完成边界

## 已注入的公开 descriptor

每个 AppView/Engine **load 之前**，本仓 Rust `native_ui::validate_windows` 合并原参数并写入：

```ts
host.params: {
  windowKey: string;
  windowKind: 'main';
  windowCoordination: 'single-engine' | 'multi-engine';
  /* 原有参数保留 */
}
```

- 字段由 native Window spec 构造，不接收 JS 参数或 JS supported bool。当前产品主窗口及其 Dock 重开使用已有稳定 key **`primary`**，用于兼容旧主窗口 metadata/journal。其他 native spec 必须有非空唯一 key，≤128 ASCII 字节，字符集 `[A-Za-z0-9_.:-]`。当前产品恢复仍只接 `primary`，其他 key 明确 `window_restore_secondary_not_enabled`；底层安全 namespace 已实装，但不将其接到旧 primary journal，也不从 HTTP receipt、lease、当前时间或 TS nonce 推导。
- 本次只签收 `windowKind: 'main'`；**没有已可用的 `mini-chat` producer**。不得因为类型可以扩展就挂 MiniChat 页面。描述符不包含 token、授权、origin、目录或 session；它不是网络 authority。
- `host.params.windowKey` 与 `host_services::Port::window_id()` 不同。后者仍是原生随机 receipt 身份，只用于 HTTP/download/close 等 exact-window 校验，不能作为跨启动的 Storage key。
- TS owner 负责只 namespace 导航、工作台 tabs、layout、快捷键等窗口私有 UI metadata。不要把安全 draft/file journal 搬到 NSH Storage，不要把所有设备偏好都改成窗口私有。`primary` 的旧无前缀 metadata 兼容由相应 TS consumer 显式处理；不得无条件复制给第二个窗口。
- `windowCoordination` 是 native owner 的 process policy，不是 `windowKey !== 'primary'` 的推测。**产品已经切到共享 Process，从第一个 primary Engine 起始终是 `multi-engine`**，关到剩一窗/同 key 重开也不降级。`single-engine` 仅保留给旧注入式 synthetic harness。没有原生 device-preference CAS/changed lane，Diff preference 等全局设备偏好在 multi-engine 下仍须 `supported:false`/零 I/O；不能给各窗复制一份全局偏好假装兼容。未知/缺失 descriptor 应 fail-closed，不能默认为 single。

## 精确操作边界

固定 NSH 0.4.0 的现有 `nsh/desktop` **本窗口**公开 API 仍可用，不添加重复 Host 方法：

| 操作 | 精确 API | 当前边界 |
| --- | --- | --- |
| 前置当前窗口 | `Window.orderFront()` | SDK 当前窗口命令；不是跨窗口 `focusMain` 或按 key 寻址 |
| 固定当前窗口 | `Window.setLevel('floating')` / `Window.setLevel('normal')` | SDK 原生层级；不是持久 pin metadata，也不是已验收的 MiniChat pin |
| 请求关闭当前窗口 | `Window.close()` | 走本仓 native close 拦截、TS 保护和精确 ticket；不直接 dispose |
| 关闭决策 | `host.call('desktop.window.closeDecision', {ticket, approved})` | 现有 granted 方法；只在相同 HostChannel/原生 windowID/代际/30 秒期限内生效 |
| 新主窗 / MiniChat / 跨窗聚焦 | **尚无可消费的 Host 方法或 capability** | 不猜方法名、不 grant、不返回 supported |

SDK 源码依据为 `nsh-core/src/runtime/desktop.rs`、`element/desktop.rs`，两平台 `chrome.rs` 的 `DesktopCommand::{OrderFront,SetLevel,Close}`；没有修改上游。平台 `isAvailable` 仅说明当前 SDK 窗口 API 可用，不代表本仓多窗口 factory 或独立 runtime authority 已开放。

## 真实 runner 结构

- `native_ui::Window` 是装配后的窗口 spec，包含独立 HostChannel/AppOptions/appearance inbox/services/dialog inboxes，以及可选原 bridge Owner 的生命周期。`window_kernel::Catalog` 按真实 NSWindow 指针或 HWND 路由，native ID 不写磁盘。
- Mac 从 process-wide `CLOSE/STOP` 改为真实窗口 catalog 和逐窗 AppView/pump/cleanup；保留唯一 `NSApplication.run()` 与一个 50ms common-mode timer。delegate 使用 sender/notification object 找精确窗口。普通 close 只退休本窗；生产 factory 在最后窗关闭后保留 App，Dock reopen 经同一 factory 建立新的独立 Engine，旧 actor 实际退出后才允许重新装配。合成 observer 模式仍在最后窗关闭后返回，不留下测试常驻 App。
- Windows 从 `WINDOW: Option` 改为 HWND map；逐窗 AppView、appearance、decision queue、tab observer、服务退休/销毁，一份 OLE apartment、thread timer 和 message loop。保留既有 Comctl32 subclass chain，close 一窗不结束另一窗；最后 HWND 退出才结束 loop。WM_QUIT 不是批准，WM_QUERYENDSESSION 先 FALSE 再全窗异步准入；ENDSESSION(FALSE) 只取消 exact query 的 quit serial，不取消之后的普通 close 或新 quit。
- Quit fanout 每个窗口独立票据。已批准 decision 的 promise 暂不 ACK，让现有 TS committing lock 保持；任一 veto/投递失败/超时，拒绝已持有的批准 promise，取消这次 quit 且不退休任何窗。装 persistence 后，还须完整最终 capture、worker flush ACK、真实 authority epoch/完整集合/票据复验，才能先 fence 全窗再 ACK/cleanup。普通 close 只 fence 本窗。services 的 shutdown 同步 fence 原 actor admission，不等下一帧 UI 才拦新请求；原 bridge 的幂等 `begin_shutdown()` 独立记录是否已执行 teardown，不能因 admission 已被 fence 而跳过原 actor 的真实退出。UI 不 join，SSH 仍只认 `on_stopped(Ok)`。
- 每轮每窗 decision/appearance 有界处理，初始 spec 数量在创建 Engine **之前**采用 worker 的同一 `window_state::MAX_WINDOWS=8`。不同窗口不得共享 services/windowID/HostChannel；重复 key/Channel/native owner 在 load 前拒绝。当前多 spec 的低层 harness 还要求不同显式 Storage backend，拒绝默认共享 Storage；这只是 TS metadata namespace 与 writer 协调完成前的 fail-closed 护栏，不是把安全草稿永久拆成各窗明文 Storage 的设计。
- 系统 chooser 全局串行；仅 live、未关闭、真实前台/key/visible 的所属窗口可 dequeue。download owner 在 Mac deferred 呈现时及 Win32 chooser 入口再次采样 OS foreground/live/enabled/minimized/modal 与持续 Current fence，堵住 dequeue 后失焦/撤权的竞态。这个门禁不撤销普通后台传输的 authority。

## 已装配的持久化与 geometry 合同（Rust-only）

`window_state*` / `window_geometry*` 仍由其 owner 独占；冻结 API 依据见 [WINDOW-STATE-INSTALL.md](./WINDOW-STATE-INSTALL.md)。该文记录原 slice 交还时的安装缺项，**以下才是当前入口集成状态**，不覆盖其模块实现。

- `notification_store_grant::native_granted("window-state") -> Result<(PathBuf, notifications::Store)>`：同次 OS 验证的 leaf path + 保持祖先 grant 的 Store；Mac/Win 固定 whitelist 增加独立 `window-state`。复用原安全 IO/文件锁，不复制 FS 实现，不调用 Vault，不与通知/consent 共目录。grant/read 失败会拒绝产品启动并保留原记录；尚无友好恢复 UI。
- `window_persistence::Port::native() -> Result<Port>` 只在产品入口调用一次。唯一 `yuri-window-state` worker 在线程内取得 grant、构造 `Owner::from_granted_store` 并检查 snapshot/failure；5 秒 startup-only ready barrier，UI pump 不等待磁盘。`status() -> Result<Status {snapshot:Option<Snapshot>,error:Option<String>}>` 返回已确认 prior，不把 pending 当 durable。`Port` clone 不新增 Store/writer。
- `Port::{capture(Vec<MainWindow>), flush(Vec<MainWindow>, quit:bool), cancel_quit(), closed(Vec<MainWindow>)}` 为 native-only。`flush` 返回 `Receiver<Result<()>>`，UI 每轮 `try_recv`，30 秒关闭屏障期限；发布 status 早于 ACK。16 项 bounded FIFO，仅合并队尾尚未派发的完整 Capture，不跨 Flush/Cancel/Closed；取消有一个保留槽。相同 pending 沿 owning Owner 的 300ms debounce，不在 OS callback 写盘。已知失败保持 pending/prior，只有显式 close/quit flush 重试；Unknown sticky、零重放。timeout/取消命令不清除先前 error，Drop 不 flush。
- 首个恢复 capture 必须覆盖保存的完整有序 key 集合，任一未采样、getter 失败、身份缺失或 mixed Some/None 都不能过滤成“完整”。原 actor committed publication 投影 `connectionID=hostID` / `runtimeKey="nsh:"+hostID`，不持久 lease/auth/origin；native capture 另带不落盘的 epoch，防 A→B→A/暂停恢复绕过最终复验。未绑定且无旧恢复记录的全新窗允许不写恢复文件；有旧记录时不能用空身份覆盖它。
- `bridge::install(host,caps,metadata,ui,restoreTarget:Option<String>)` 在首次 Vault load **之前**冻结 target；不会先发布旧/default Host 再切换，也不为恢复主动改全局 selected 记录。target 缺失或 SSH endpoint 未获得 fresh 原生 receipt 时 `connection.list` 稳定拒绝 `window_restore_target_unavailable`，不回退 local/首连接、不删除恢复项。目前缺少该失败的产品重试/替代目标入口，不能宣称恢复体验完成。
- Mac 真实 window 在 show 前 restore/clamp，恢复时不再无条件 center；以真实 normal seed 采样。原 delegate 只标记 move/resize/minimize/fullscreen dirty，原 pump 读取 getter；异步 fullscreen 完成前冻结，失败保留明确 unresolved；下一次真实 transition 才重试。getter 失败不能下一轮用 cached geometry 清错，显式关窗重采样可重试 getter。创建后的 geometry/fullscreen 失败由已建立的 RAII owner 清理 observer/view/window，不遗漏部分装配。
- Windows 原 subclass 接收 MOVE/SIZE/WINDOWPOSCHANGED/EXITSIZEMOVE/DPICHANGED/DISPLAYCHANGE dirty；使用真实 HWND 的 owning-thread borrow/getter。恢复普通/最大化用 beforeShow + `show_restored` 代替无条件 show。**恢复 fullscreen 仍明确拒绝 `window_fullscreen_requires_nsh_command`**，未私改 NSH fullscreen bookkeeping。
- 普通 close 的最终完整 capture 成功后才放行；实际 committed close 从 catalog 移除时显式发送 remaining catalog 并 flush，不依靠渐进销毁采样。该后置保存失败保 prior/error，不能撤回已经结束的窗口；最后窗不写空列表。Quit 则 freeze 完整 catalog，获批后绝不保存 shrinking catalog。被取消/超时的迟到 ACK 不得关闭后来的窗口。

上述 API **不经过 HostChannel，不在 manifest grant，不接受 JS path/Store 注入**。TS main 不需要也不能调用磁盘 owner；保持现有 closeDecision 消费即可。

## 共享原 Vault lane：已实装的分阶段 native process API

`src/window_process.rs` / `window_process_vault.rs` 声明为 `bridge::process`，**现已替换产品 Rust factory 的 legacy bridge 安装**。同一个 worker 驱动多个真实原 `Actor` runtime context，各自持有 HostChannel、selection/scope、取消、HTTP jobs、streams、resources、appearance 和 services。`main.rs` 创建唯一 Process、一次 SSH install，首次和 Dock reopen 均走 `window_factory::open`，然后安装各窗 services，最后才 load Engine。没有 JS create grant，不能把安装迁移称为全量生产多窗完成。

当前可直接调用的 Rust 合同：

```rust
Process::native(metadata: Value) -> Result<Process>
Process::open_window(&self, WindowRequest)
    -> Result<Receiver<Result<bridge::Owner>>>
WindowRequest {
    window_key: String, host: HostChannel, capabilities: Value, metadata: Value,
    appearance: appearance::Port, restore_target: Option<String>,
}
Process::install_ssh(&mut self, driver: ssh::Result<Arc<dyn ssh::Driver>>, version: String)
    -> Result<()>
Process::connection_actor_port(&self) -> connection_actor_port::Port
Process::connection_actor_http_port(&self) -> connection_actor_http_port::Port
Process::shutdown(&mut self) // 同步 fence，异步退休，不 join UI
Process::stopped(&self) -> bool // 服务成功退休 + worker/Vault 析构 + 真正 join 后才 true
```

- `native()` 只构造**一份**原始 NativeVault/Network，进程级 sticky admission 拒绝第二次 native install（包括关闭后重装）；不能销毁重建 pool 来清 Unknown。每窗仅持该 lane 的 native view，绝不 `new NativeVault`。测试仅通过注入式 `install` 进入同一 `install_inner`，不调用 native credential discovery。原 secure record 的 registry/credentials 在同一个事务 worker 内串行；每次 generation 改变，在下一次窗口 dispatch 前采用最新共享 registry，同时保留该窗的 selected/lease。两个 Engine 对不同连接做 metadata mutation 不会用旧集合覆盖另一窗已提交结果；同实体仍走原 editor/registry CAS。
- 非 primary view 的安全记录写入保留 primary 的 legacy cold default；本窗 select/restore 不广播给别窗，不轮别窗 lease。连接删除/换授权则撤销实际受影响窗口的旧 authority/jobs，不回退 default/首 Host。共享 record 的未知/冲突 fence 所有 contexts，已知未提交失败保 prior，禁止自动重放。原 Keychain 无跨进程原子 CAS；有 baseline/readback 检查，但不宣称能解决无关进程在 OS setter 窗口内抢写。
- 原 native typed SSH/raw HTTP 只路由到 process anchor；一个 dispatcher，可从各窗调用六个 connection-only 方法，不能逐窗安装。window services 只借用 Control，关闭 view 不 shutdown process SSH；`Owner::install_ssh` 对 process view 返回 `ssh_process_singleton_required`。Process shutdown 才停止服务，原 actor 活到 `on_stopped(Ok)`；Err 保持 unresolved，不能用窗口数归零推断已释放原 Vault lane。
- window Owner 的 `begin_shutdown()/stopped()/services()` 沿原 API；它只结束本 context，迟到 HTTP/stream 仍进旧 mailbox，不能投递到复用同 stable key 的新窗。普通 HTTP 的 requestID 额外有 process-lifetime、4096 上限的完整 identity tombstone，不能换 window/owner/scope 重用。每窗仍为原 64 槽 mailbox、每轮至多16项、原8 HTTP jobs；不是无限队列。当前 worker 使用 10ms bounded poll，尚无真实多窗 CPU/延迟预算签收。
- `open_window` 只是16槽非阻塞安装准入，须取得 exact `Ok(Owner)` 后才能 load Engine；full/closing/重复 key/共享或复用 HostChannel/第九 view 拒绝，不修改已装窗口的 handler。必须传新 HostChannel，native 保留字段 `windowKey/windowKind/windowCoordination` 在此安装前不得由 caller 提前填写；带旧 descriptor 的 channel 返回 `window_channel_reused`，即使旧窗已关闭，也不能把迟到旧 Engine 绑定到新 context。窗口 ready 不授予设备偏好、draft/file writer、journal 或跨窗创建能力。
- 已用两个**真实 QuickJS Engine**、唯一 synthetic Vault 对象与原请求实现验证：独立 restore/select/lease、分别发带本窗 bearer 的 synthetic POST、共享 metadata 合并不丢更新、peer removal/已知失败、普通 HTTP wrong window/requestID/迟到回执、关闭一窗后另一继续、共享 SSH/一窗关闭不退休隧道、process join 才释放 Vault、Unknown/外部 baseline 冲突全窗 fence、SSH `on_stopped(Err)` 不释放 anchor。失败测试仅用测试私有 stop 清理合成 unresolved worker，无生产 force-unlock。

## 已安装的 journal/catalog 与退出屏障

- `window_factory.rs` 是产品和双 QuickJS 测试共用的 pre-Engine 装配入口；只接可信 native 参数和 Store，不收 JS path。稳定 key 校验先于 channel 安装。`primary` journal 原 `file-journal-v1/primary`、terminal catalog 原 `terminal-catalog.json` 完整保留，**不复制/迁移旧记录**。其余 key 用 `SHA256(ASCII "yuri-native-window-v1" + NUL字节 + ASCII key)` 的 64 字节小写 hex 映射到 journal namespace 和 `window-terminal-<hash>` catalog 私有目录；不替换标点、不使用随机 receipt，不把 Host/lease/凭据写进 namespace。
- catalog 通过原 private-directory grant 和事务 `FileStore::named("terminal-catalog")` 安装，持有祖先 grant、独占 lock；不再在产品中使用裸 PathBuf + create_dir_all/rename。Mac primary 仍是系统用户 Application Support 下原文件；Windows primary 使用系统 KnownFolder RoamingAppData 对齐 NSH 0.4 的原 APPDATA 文件，其他私有目录仍走 LocalAppData。拒绝不安全的旧权限/链接，不 chmod、不复制到新位置假装恢复。Mac catalog 文件/lock 另检查 owner/0600/单 hardlink；Windows文件安全和 FFI 未经真实 target/SDK/OS 验证。
- catalog 已知失败保 prior；`notification_store_unknown` 转为 sticky `terminal_catalog_unknown`，本 owner 后续 read/write 都拒绝，零重放/假空。终端 owner 退休时释放 Store，即使旧 Engine 仍持 handler，也不能继续占同 stable key 的文件锁。
- journal shutdown 持有真实 worker join receipt；window context 只有 journal 磁盘 owner 已析构、worker 真正 join 后才 stopped，不是只发 stop。原有 TS journal.sync/final-capture/flush 屏障仍保留。
- Mac 正常关最后一窗保留同一 Process/SSH 以供 Dock reopen；Quit 全窗 capture/磁盘 ACK/票据复验后 fence 全窗，窗口退休完毕再 poll `ExitBarrier` → 原 `Process::shutdown()/stopped()`。Mac AppKit stop 与 Win32 正常 loop break 都须等这一 receipt，SSH `on_stopped(Err)` 或 writer cleanup 失败不假释放原 actor/Vault。Windows等待沿原 UI timer，不新增 busy loop。未执行物理窗口/OS Quit。

## Main 可消费：显式 native writer v1

产品 manifest 已精确增加以下四个 handler；旧 bundle 必须重新生成 capabilities。TS core/薄 adapter/runtime/HTTP seam 见 [desktop-writer-DOCUMENTATION.md](../desktop-writer-DOCUMENTATION.md)。当前 `application.tsx` 的窗口根已加载 verified client，正式 Chat 通过 `NativeDesktopChatWriter` 在 acquire ACK 后才构造 `ChatOwner`，同 authority 续 lease 保留业务 owner 并重绑 operation lane；新会话 root/route 都已注入同一 client。不能因为 consumer 已接线就放开第二生产 Engine。

```ts
type WriterTarget = { kind: 'session' | 'assistant' | 'new-session'; id: string };
// session/assistant: 原始实体 ID（不先 encodeURIComponent）；new-session: exact canonical Host directory。
type WriterInput = { ownerID: string; target: WriterTarget; expectedHost: RuntimeScope };
type WriterGrant = WriterInput & { schemaVersion: 1; windowID: string; grantID: string };

host.call('desktop.writer.capabilities', {});
// {schemaVersion:1,supported:true,acquire:true,release:true,renew:true,recovery:false,
//  requiresExpectedHost:true,windowID,maxWriters:64}
host.call('desktop.writer.acquire', input); // → WriterGrant，持久 ACK 后才返回
host.call('desktop.writer.release', { ...input, grantID }); // → {released:true,grantID}
host.call('desktop.writer.renew', { ...input, expectedHost: newCommittedScope, grantID }); // → 新 WriterGrant
// 原 runtime.request / runtime.http.request 的 envelope 增加：writerGrant?: string（grantID）
// 路由、HTTP body、expectedHost 保持原形；runtime.http.cancel 的 identity 不变。
```

- 唯一 writer book 在原 Process worker，共用**原 Vault lane/secure record** 的 `nativeWindowWriters`；没有第二 Vault/锁文件或 JS Storage writer registry。native 自取实际 window receipt 和 stable key，`expectedHost` 须是本窗 committed scope。每个 Host ID + target.kind + target.id 最多一个 grant；同 owner/window/scope acquire 幂等返回原 native grant，peer `writer_conflict`。能力/namespace 不等于已取得 writer。
- **被动续 lease 使用显式 renew，不销毁 draft owner。** native 新 grant 的 held row/Active 同时记录真实 committed `{origin,authorizationID}`，不持久 token/lease，不向 JS 返回这些字段。renew 持有同 native window/owner/target/Host ID 和旧 grantID，在原 lane 核验 saved/active authority 都等于真实当前 Connection、pending=0/unknown=false 后原子换 grantID/scope；持久 ACK 后才返回。旧 grant 在两 HTTP gate 都不能执行；origin/auth 改变、peer window/owner、旧 grant、pending/unknown 都拒绝。无 JS supported bool 或自报 origin/auth 参数。
- v1 既有 held row 没有 `authority` 字段时仍保留读取，但不从当前 Connection 回填：冷启动没有原 active receipt，只能 recovery_required；renew 不能接管。renew 的 CommitUnknown 仍由原 secure lane fence 全 Process，零重试，不以新 Process/Vault 或新 JS client 清锁。TS 对应入口是同一 claim 的 `renew({expectedHost:newScope})`，不能继续 old-scope release。
- Main 必须在恢复/编辑 draft 前 acquire，在 owner/Host/route 退休前完成自己的 pending/unknown/dirty 保护后 release；只读 panel 不 acquire。不要仅在点击发送时 acquire。所有受保护写通过 captured `grantID` 注入 `writerGrant`；native 在原 `start_job`、fetch **之前**核验 durable target、当前 scope、真实 window、native grant epoch。漏 grant、借用 peer grant、旧 grant、旧 scope、raw HTTP 旁路都拒绝，零 fetch；GET 不取 writer。
- gate 覆盖 `/api/session/<encodedID>/...` 和 `/api/yuri/assistants/<encodedID>/...` 的全部非 GET，ID 包含 `%2F` 时仍按单个实体段匹配；编码 route alias 拒绝。`POST /api/session` 只认已授予的 `new-session` directory grant，与现有 `{location:{directory}}` body exact 匹配；得到真实 session ID 后，Main 先 acquire session grant，再 release new-session grant，不从路由/随机 ID 猜新 session。未映射的 mutation RPC 拒绝，只有现有 `opencode.goal/get` POST 被识别为只读；今后增加 mutation 入口必须补 native mapping/test，不能绕到 RPC。
- grant 持久化在网络前；每个已派发写有 native in-flight guard。完整有效 JSON/2xx 只表示 native transport 已退休，不代替 TS domain ACK/unknown 校验。cancel、超时、scope 失效、坏 JSON、非2xx、网络失败/缺 ACK 保守置 sticky unknown，release/final-close 拒绝，不重放。capabilities 明确 `recovery:false`，未提供强解锁。
- final close 只有真实 window-kernel 票据/全窗 flush 最终通过才设置 native-only approval。native writer pending/unknown 会 veto，即使所有 TS 都投 approved，也保持窗口/authority live。clean close 在原 lane 持久删除**本窗** grants 后才让 context stopped；落盘失败/竞态未解时保留原 cleanup lane，不伪造停止。非批准 native destroy、直接 Drop、异常退出不删 durable held grants。冷启动或同 key 重开不能凭 stable key 继承旧 grant；找不到 live receipt 时返回 `writer_recovery_required`，不 TTL、不自动释放、不自动重发。
- 当前按显式 target 身份互斥，**未新增 assistant 后端 session alias 的权威解析/迁移协议**。如果 Main 要同时承载 assistant 和其真实 backing session，需在放开生产多窗前补 exact alias authority 与原子 claim/transfer 验证，不能把读到的 HTTP 字段当授权。全局 NSH device preferences 仍 multi-engine unsupported/零 I/O。

### 当前 Main consumer 装配事实（源码核对，不代替完整验收）

- `YuriNativeApp` 持有每窗口唯一 verified client；`Chat` 包含正式 session/assistant target，grant getter 进入 `createPageOperations` 与 `createChat`。`NativeDesktopChatWriter` 仅在真实 acquire ACK 后挂业务子树，等待/unsupported/denied 不先恢复或编辑 draft；同 authority 续 lease 使用原 claim 的 renew。
- `NativeNewSessionPage` 的 `NewSessionOwnershipSlot` 先取得 canonical directory 的 new-session admission；`openNativeNewSession` 强制该 admission，创建获得真实 session ID 后 `ensureSession`，handoff 交接原 verified session claim。它不是根据 route 猜 ID 或为每次发送临时 acquire。
- `ChatOwner` 注入独立 `recoveryReadOperation`；`recoverPendingSend` 用 captured operation/scope/实体复验，只读查询 inbox/精确 message 后结算原 pending receipt，不自动重发。**这不是 unknown/crash native held-grant 的冷恢复 resolver**，native 仍 `recovery:false`。
- `createDesktopWriterDeparture` 已接 route、inline conversation 切换和原生关窗；Chat/项目根的真实 `NativeChangesPresentationHandle.canLeave` 同时登记。原生关闭只 prepare/flush/最终 canClose，不提前 release；拒绝或失败会 cancel ticket，真实 final-close 的 native cleanup 才退休本窗 grant。
- assistant inline root 仍在主线补验范围；这里仅记录当前可见装配，不沿用别的 worker 尚未交还的测试数字，不签收 backing-session alias、多窗口或完整 UI parity。

## 未完成：不能报 full multiwindow available

1. **产品当前只自动创建一个主窗，但已使用真实共享 Process。** safe journal/catalog、native target writer 和 Process 退出屏障已安装；root/正式 Chat/new-session 已消费 writer、pending-send 只读恢复与 Changes guard，仍需各 owning consumer 完整生命周期验收，未开放第二可写生产 Engine。没有另建 pool/Vault，也没有把 native 能力声明成完整产品可用。
2. 产品冷恢复仍只允许一条 `primary`；多条记录明确 `window_restore_multiple_writers_not_enabled` 并保原文件，不截断为首条。通知 receipt owner/全局 diagnostics consent 仍需 process-singleton 共享审查，assistant backing-session alias、Storage runner 准入、consumer 最终生命期测试也未闭合；不能现在删除冷恢复 gate。Windows fullscreen producer、失败恢复 UI、系统 transition/多屏/DPI 的真实验收仍缺。
3. Unknown/crash held grant 保留并只读拒绝，无生产 recovery resolver/UI；不提供强解锁。受保护写须先消费新 writer 合同，未显式注入 writer 的旧 runtime caller 仍由 native 拒绝。旧 bundle/capabilities 尚未重生成。
4. MiniChat 的 runtime+session/assistant dedupe、draft 不 dedupe、目标 schema、520×760/min360×480、assistant Relay 拒绝、focusMain/open/focus/close 的跨窗 Host capability 尚未完成。TS 页面由 main owner 所有；这里没有用 Rust 重写页面或提前 grant 空 producer。
5. Mac 最后窗/Dock reopen、双 AppView 的物理焦点/关闭/菜单，Windows target/SDK/link/OS、全屏/多屏/DPI、真实 dialog/SSH/Host/模型均未验收。锁屏期间不启动真实 UI 或绕过前台 gate。

## 证据

- `window_kernel_tests.rs`：两个真实 QuickJS Engine/HostChannel 的事件隔离；关闭一 Engine 后另一继续收精确 ping；Quit 全窗批准、veto 解锁、timeout/late decision、重复 native owner、第九主窗拒绝。不是 OS 窗口测试。
- `native_window_tests.rs`：原生 spec 在 load 前拒绝 shared HostChannel/services/key/Storage，复用同一主窗预算；真实两个 Engine 读取实际 native 注入的 `windowKey/windowKind`，不从 receipt 猜 key。
- `synthetic_smoke --two-windows <new-private-synthetic-root>` 已编译为显式物理 AppKit harness：两个真实 AppView、独立 Engine/HostChannel/read-only synthetic runtime，关闭第一窗、第二窗继续收 ping、最后 Quit。**锁屏下未执行**；它本身也不证明独立可写 production authority。
- product-manifest 回归用真实 `nsh.json` capability policy + HostChannel + 原 actor + installed download owner，覆盖五个 v2 grant、排 native job/status/cancel、禁止 resume cancelled receipt、原 actor 正常停止；没有运行 chooser 或读取用户文件。
- 新的 `window_persistence_tests.rs` / `window_kernel_tests.rs` 使用真实 owner-only 临时 FileStore、双 Engine/HostChannel 和受控故障：完整恢复拒绝 partial、失败保 prior、Unknown 零重放、16 槽/10000 个 trailing captures 合并不跨 barrier、last-close 保留、Drop 零写、异步 flush 前零 teardown、authority 退休后迟到 ACK 拒绝、普通 close remaining catalog、timeout 解锁。sampler 另有 10000 次 cached turns 零 getter/不清失败测试；不将这些操作数当 OS 性能签收。
- 同次 grant 的实际 path/独立 lock/通知目录隔离/0600/拒绝权限修复与 symlink；原 actor 恢复 target 在首次 publication 前准入、失败稳定拒绝且零 Vault 写/默认 Host fallback；services.shutdown 在 UI 下一轮前 fence 原 mailbox、Owner 随后仍实际退出。均只操作自建临时树或合成 Vault。
- 六个 SSH connection-only grants 已加产品 manifest，并以真实 policy + HostChannel + 原 service/actor + synthetic Driver 验证 capabilities/read/save/remove/start/cancel，未 grant Sync/Files。当前主线仍只安装一个 service；不能在开放多窗时逐窗复制 install。
- `window_process_tests.rs` 现从真实产品 manifest（仅追加 test.output instrumentation）和同一 `window_factory::open/install_stores` 装两个真实 QuickJS Engine：独立 stable namespace 的真实私有临时磁盘、primary 原路径、cold restore、held writer/peer/旧 epoch/两种 HTTP/new-session directory grant/unknown crash、原 Process exit receipt。terminal viewport 用纯 Registration，不调用真实 renderer；不是两个 OS 窗口或 Windows target 证据。`window_kernel_tests` 另验 native writer veto 覆盖全体 TS 同意票、拒绝后不 teardown 并可重试。
- **历史 renew 阶段**：binary 与 `synthetic_smoke` 各 **372/0/0**（passed/failed/ignored），不是前轮 368 基线；当时显式启用全部隔离 fixtures。renew 回归额外核验 peer/错 owner/target/旧 scope/JS bool 拒绝、确定持久失败不替换旧记录、同 origin 重授权及同 ID 换 origin 拒绝、旧 grant 两 HTTP gate 零 fetch、legacy 缺 authority 零回填和 CommitUnknown fence 原 Process/零重放。该阶段全 target Clippy `-D warnings`、Mac binary/example build 与 Windows metadata frontend 通过；Mac 链接仍有既有 compact-unwind 大小 warning，Windows target/SDK/OS 与真实窗口仍未验。TS 证据及 queued-renew 消费规则见 [writer 合同](../desktop-writer-DOCUMENTATION.md#本轮验证证据)；不将这一历史计数当本次重跑结果。
- **2026-11-08 历史 377 基线**：binary **377/0/0**、`synthetic_smoke` **377/0/0**，均零 filtered；显式 `--include-ignored --test-threads=1` 执行 terminal 两项、journal 一项、download 两项所需的全部真实 fixture，每 target 另含 14 项专属临时 SSH IO 与 5 项合成 OpenInApps 回归。两个 target/child lock probe 不相加计独立覆盖。固定只读 NSH 0.4.0/e626a8dd，既有 source patch，Cargo 全程 offline/locked；该阶段全 target Clippy `-D warnings`、Mac binary/example build 均 exit 0（保留既有 unwind linker warning）。Windows Vault/UI/WinHTTP 三项 metadata frontend exit 0，geometry example **5/0/0**；仍非 Windows target/SDK/link/OS。完整历史命令与 fixture 环境见 [Host 历史隔离重跑](./README.md#2026-11-08-host-隔离重跑历史-377)。该结果先于新增 Assistant 附件，不替晚到附件交付背书；不签收 cold held-grant resolver、生产多窗、assistant root 的并行补验或完整 UI parity。
- **2026-11-08 Assistant 附件后最新业务基线**：binary **384/0/0**、`synthetic_smoke` **384/0/0**，均零 filtered；五项原 ignored fixtures 全部显式执行，每 target 包含新增七项 Assistant 附件、14 项专属 SSH IO 与五项合成 OpenInApps 回归。全 target Clippy `-D warnings` exit 0，不重复累加两个 target/child probe。使用原 NSH 0.4.0/e626a8dd、原 CLI 和已审计的既有 source-patch 配置，Cargo 全程 offline/locked，独立私有临时 target；前后 Host Rust 源码、manifest/lock/产品 policy、配置及 CLI 摘要一致。**这是业务逻辑基线，不是 compat-patched CLI/devhost/Shift 或系统验收**，没有调用 preparation 脚本或争抢其锁。附件沿原 picker/worker/actor，未新增 Rust main 安装；本次未重跑 Windows metadata/geometry、产品普通 build/bundle、TS/完整 UI、真实用户 SSH/Vault/网络或物理窗口。命令与精确证据边界见 [Host 附件后业务基线](./README.md#2026-11-08-assistant-附件后业务-host-基线重跑)；cold resolver、生产多窗与完整 Mac/Windows 1:1 继续未签收。
