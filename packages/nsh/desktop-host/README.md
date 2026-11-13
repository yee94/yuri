# Native desktop Host（NSH 0.4.0）

独立 Rust embedding runner，主界面由 macOS AppKit / Windows Win32 的 NSH 原生后端承载，不是 Electron，也不以 WebView 承载主应用。这里实现连接／编辑／重新授权、HTTP／SSE、外观、文本资源、关闭 admission，并接入独立 browser、terminal、附件与本地 Markdown 导出模块，**不代表桌面完整 parity 或 Windows 平台已验收**。

多窗口 runner 的真实 catalog、逐窗 Engine 生命周期、已冻结 `host.params.windowKey/windowKind`、操作边界与尚未开放的 per-window authority/MiniChat，见 [WINDOW-KERNEL.md](./WINDOW-KERNEL.md)。产品仍只自动创建一个主窗，不将可编译的双窗 harness 称为完整 PC 多窗口。

## 构建与运行

```sh
# 在目标 OS 本机构建；需要已缓存的 Rust 依赖、审计过的 NSH 源码与原生 SDK。
NSH_SOURCE_DIR=/path/to/audited/nsh node packages/nsh/scripts/build-desktop.mjs --debug

# 只检查 Rust / 跑合成测试，不启动 UI、不读取用户凭据。
node packages/nsh/scripts/build-desktop.mjs --check-host
node packages/nsh/scripts/build-desktop.mjs --test-host

# 必须指定已审计的 NSH 0.4.0 checkout（e626a8dd）；也可预先 export。
NSH_SOURCE_DIR=/path/to/nsh node packages/nsh/scripts/build-desktop.mjs --check-host
```

Cargo manifest 精确约束 NSH `=0.4.0`；桌面 check/test/build 统一通过 [项目兼容 preparation](../patches/nsh-0.4.0/README.md) 验证 revision、完整源码摘要、lockfile 及有序补丁。复制源码仅放入忽略的 `.nsh`，同源构建 patched CLI、物理 devhost 与 Yuri Host；显式传配套 `NSH_BIN/NSH_RUNTIME`。全部 Cargo 命令 offline/locked，缺缓存直接失败，不修改外部 checkout 或仓库 lock，也不回退旧发行版。App/bundle staging 验证后才发布，`--skip-bundle` 必须通过同 digest 与内容摘要核验。

输出：

- macOS：`.nsh/desktop/YuriNative.app/Contents/MacOS/yuri-nsh-desktop`，资源在 `Contents/Resources/nsh/`。
- Windows：`.nsh/desktop/YuriNative-windows/yuri-nsh-desktop.exe`，资源在 exe 旁的 `nsh/`。
- 开发 runner 可以传 `--bundle /path/to/bundle.js`。必须带同目录的 `capabilities.json` 与正确 `app.json`；开发 bundle 是受信任本地代码，不能加载不可信下载文件。
- 必须使用 `Bundle::read(bundle.js)`；不把可替换字节码当可信文件加载。完整拷贝 nsh-build bundle、assets 与产品 assets。macOS 由 `native_ui.rs` 在进程主线程自持 AppKit window／NSH `AppView` 与原生事件循环；Windows 由 `native_ui_windows.rs` 自持 AppView／HWND 与 Win32 loop，不再委托隐藏 owner 的 `run_app`。
- macOS 默认仅 ad-hoc 开发签名，`NSH_SIGN_IDENTITY` 可换开发身份；没有发布、公证、安装器、Windows 签名或自动更新。
- 脚本不启动常驻服务或应用窗口；需要手动启动时遵循仓库 tmux 规则。

`NativeStartup` 在业务根之前调用五项 `authorization.cache.{ready,list,claim,ack,retry}`。源 manifest 已授予这些方法并不代表旧 executable 已实现；只更新 bundle、沿用加入这些 handler 之前的 Host，会停在启动错误提示，连连接页都未进入。`authorization-cache-cleanup.test.ts` 覆盖 manifest 与启动握手，实际交付仍须核验配套 native Host。缺 handler 的错误与系统钥匙串等待、后端认证失败是不同阶段，不能以开窗或 `/health` 成功代表真实连接成功。

## 实现边界

| 能力 | 当前行为 |
| --- | --- |
| `host.params.windowKey/windowKind/windowCoordination` | load 前 native 注入；产品已使用 Process，当前 `primary/main/multi-engine`；首窗起明确 multi，不按 key 猜测；全局设备偏好仍 unsupported/零 I/O |
| `connection.list` | 安全存储恢复、公开元数据、选中连接、进程内 `runtimeScope` |
| `connection.connect` | 直连 URL＋token，或 password → `/auth/session` 的 `clientToken` → `/api/config/settings` 验证 → 安全存储提交；只在提交成功后切换 |
| `connection.editor/rename/edit` | 只读元数据 descriptor、exact schema／version CAS 的 direct 元数据编辑；跨 origin 改动要求显式重新授权，metadata-only 不轮 lease |
| `connection.connect`＋`id/version` | 原 ID 的 direct 重新授权；要求新 token 或 password，密码响应及最终 probe 后复验 CAS；保留 recency／selection，新 authorizationID，只有选中项轮 lease |
| `connection.select/remove` | 持久事务成功后更新；选中连接变化取消旧 HTTP／SSE 并轮换 lease；删除选中项不猜另一个默认连接 |
| `authorization.cache.ready/list/claim/ack/retry` | 原连接 actor 在删除或更换授权的同一 Vault 事务中记录历史缓存清理任务；窗口认领精确票据，JS 完成对应历史缓存清理后才能持久确认。启动先处理遗留任务；失败保留任务供重试。当前仅验证单窗口，生产多窗口清理协调尚未验收 |
| `runtime.request` | 保留 method/path/query/JSON body 和 `{status,body}`；新增可选 `writerGrant`，session/assistant/new-session mutation 在 native fetch 前强制要求 exact grant；GET 不取 writer |
| `desktop.writer.capabilities/acquire/release/renew` | 原 Vault durable held grant；native stable origin/auth 的同 owner 原子续 lease，不销毁 draft；pending/unknown veto、clean final-close 释放、crash 不解锁；root、正式 Chat 与新会话已接 consumer，冷 held-grant resolver/生产多窗仍未开放 |
| `desktop.openInApps.capabilities/read/scan/select/open` | 产品已精确授予五项；原 actor 消费进程级 catalog，发现/选择不授予 Host 目录权限；真实本机目录映射 producer 缺失，open 明确 unsupported；未执行系统应用扫描/打开 |
| `runtime.stream/stop` | 保留 `global/chat`，另支持有界 `panel-chat:<owner>:<activation>`；复用现有事件和 exact `expectedHost`，cleanup 不跨 key／lease |
| `runtime.stream.capabilities` | 只读原生支持声明，无需 Vault；panel namespace 上限、key／route 合同由 Rust 返回，bundle 需显式声明该方法 |
| `runtime.http.capabilities/request/cancel` | 原 actor 的 exact owner/request/window/lease 普通 HTTP receipt；只取消对应 job 并结算原 reply，不借用 SSE／资源／PTY stop |
| `desktop.ssh.capabilities/read/save/remove/start/cancel` | 产品 manifest 已精确授予六项；owning service worker → typed adapter → 原 actor；真实 Ready/native driver 决定 connection-only 支持，Windows driver 仍 unsupported，sync 不授予 |
| `appearance.reset/apply` | 两平台自持 AppView 消费 bounded mailbox，真实 token/fontScale setter 成功后回复；macOS 原生 appearance，Windows GDI 字体查询／DWM 标题栏；Windows 实机效果未验 |
| `native.clientMetadata` | 读取装载 bundle 的 app.json 版本/build，更新渠道明确 unsupported；不读取连接凭据 |
| `native.diagnostics.status/setEnabled/append/export` | 通用 fallback 后安装真实匿名 recorder；默认关闭、仅持久 consent metadata、有界内存事件、原生 committed scope/window capture，显式 export 才排系统保存框；系统弹窗未实测 |
| `notification.*` | 生产安装私有 receipt Store／native worker；committed identity、真实 native activity、UI job／shutdown fence；身份缺失或私有目录不安全明确 unsupported，系统通知未实测 |
| `resources.read/release/cancel/close` | exact Host scope 的认证 HTTP stat → read；有界 UTF-8 文本与真实内存租约，精确 owner 清理；非文本及原生 present/save/share 明确 unsupported |
| `desktop.window.closeDecision` | 两平台同一窗口私有 ticket 合同；macOS delegate／Win32 subclass 与 loop 拦截；Windows 未完成跨 target 编译和实机验收 |
| `yuri.desktop.browser` 原生组件 | 生产入口已接独立 browser 模块；Rust-only committed authority、Mac register/poll、Windows Components 注册；不是额外 JS Host 方法或主界面 WebView |
| `terminal.*`／`terminal.desktop.capabilities` | 通用 bridge 后安装真实 terminal Host 与 Components；同一 committed authority 的原生 direct WS-v2 bind／replay／text input，保留 HTTP input／resize 与显式 SSE fallback；Windows renderer／WinHTTP 仍需目标平台验收 |
| `desktop.attachments.pick/status/cancel/release` | 通用 bridge 后安装真实 receipt owner；session/assistant 显式 target 复用同一 picker/worker/actor，receipt 按 exact scope+target 隔离；系统 picker UI mailbox 每轮最多一项，原始字节经同一 actor 的认证 PUT；未知结果只回读 receipt，不重传 |
| `desktop.documents.save/status/cancel` | 通用 bridge 后安装独立 documents Owner；系统 SaveDialog 导出不超过 8 MiB 的 Markdown，与附件 dialog 串行；未知 receipt 只核验、不重写、不返回路径 |
| `desktop.files.journal.snapshot/commit/sync` | pre-Engine factory 按 stable key 的安全 namespace 安装；primary 原路径、peer SHA256 namespace 不复制；shutdown 等磁盘 owner 析构及 journal worker 真实 join |
| `desktop.files.download.*` v2 | 已安装同 actor Reader／documents 流式 Stage／四类 dialog 串行 UI mailbox；持续 native window／scope／origin／authorization／suspension epoch fence；系统 chooser／Windows 未验；见 [文件下载合同](./desktop-file-download-DOCUMENTATION.md) |
| `yuri.desktop.tab-events` 原生组件 | AppView 前 register、同 committed scope publisher、真实窗口 observer/poll/retire；无额外 Windows subclass 或 child HWND，Mac 不吞点击；物理输入未验 |
| 其它 manifest Host 能力 | 明确 reject `unsupported_desktop_capability`，不伪成功 |

产品 `nsh.json` 已精确加入 download v2 的 `desktop.files.download.capabilities/save/status/cancel/resume` 五项，以及 SSH connection-only 的 `desktop.ssh.capabilities/read/save/remove/start/cancel` 六项；另有 writer 四项及 OpenInApps 五项。实际支持仍来自 installed owner 的真实 capability，不从 grant 推断成功。UI dequeue 与 owning download 的真实呈现入口双重检查 exact 前台窗口/live/suspension/Current，后台传输不因普通失焦取消；未运行系统 chooser。download/SSH 两组已有真实产品 manifest policy 垂直回归；不代表真实 SSH/Windows executable 验收，完整 Files/sync 继续 unsupported。旧 bundle 的 `capabilities.json` 不会因源 manifest 修改而自动变化，运行产品须重新 bundle；本次有可用的精确 NSH 0.4.0 CLI，仅用于隔离 terminal fixture，没有重建或启动产品 bundle。

`window_persistence.rs` 的唯一私有 `window-state` worker 保留。**产品 factory 已切到唯一 `bridge::process::Process`/原 Vault lane/单个 SSH dispatcher**，与双 QuickJS 测试共用 `window_factory::open/install_stores`；已安装 stable-key journal/安全事务 catalog、native writer grant/执行 fence、AppKit/Win32 Process exit receipt。首个 primary 就是 multi-engine，全局设备偏好保持 unsupported/零 I/O。`application.tsx` 已在窗口根装配 verified writer client，正式 Chat 在 acquire ACK 后才构造业务 owner；新会话先取 directory writer，再交接真实 session writer。pending-send 恢复已接独立只读 operation，Chat/项目 Changes 的 `canLeave` 也进入离页与关闭 guard。**这不是冷 held-grant resolver 或生产多窗验收**：assistant backing-session alias、通知/diagnostics 全局 store 的多窗共享、Storage runner 准入与完整冷恢复仍未闭合；第二个可写生产窗口继续禁止。受保护 mutation 缺 `writerGrant` 时 native 明确拒绝，不能只靠 metadata namespace 解锁多窗。精确类型、clean-close/unknown/crash 规则与全部未完成项见 [WINDOW-KERNEL.md](./WINDOW-KERNEL.md#main-可消费显式-native-writer-v1)。create/MiniChat/focusMain 均未 grant。

不支持的连接操作（配对链接、E2EE Relay）明确拒绝，不会剥掉 Relay 信息改走直连。未携带编辑目标的普通 connect 重复授权同一 direct origin 仍使用原连接 ID，但产生新的 authorizationID 与 lease；编辑目标必须携带原 ID/version。通用非文本原生资源呈现、语音仍未接入本 Host；terminal 的 Relay、真实 PTY／完整平台验收仍未完成，direct WS-v2 仅有下述合成网络证据。

### 独立只读 panel 会话流

- `runtime.stream.capabilities({})` 直接返回 `{schemaVersion:1,panelChat:{supported:true,maxStreams:4,keyFormat:"panel-chat:<owner>:<activation>",maxID:9007199254740991,path:"/api/event",queryKeys:["directory"],requiresExpectedHost:true}}`；额外输入字段拒绝。该方法在 credential load 之前处理，不读 Vault／访问 Host。`nsh.json` 已精确授予该方法；TS main 只有严格核验真实返回值后才可注入 `DesktopPanelChatStream`，不能以合成端口、文件存在或 JS bool 冒充支持，不自动增加另一个 SSE transport。
- key 两段都是 canonical 正十进制 JS safe integer：1..9007199254740991，无前导零、符号、小数、指数、空白或额外分段。只有 `global`、`chat` 和这个窄 namespace 可用；iOS Swift 未增加该能力。
- panel start 只接受 `/api/event?directory=<encodeURIComponent(capturedTarget.directory)>`，单一非空 UTF-8 directory、无 control 字符，不接受额外 query、其它 route 或编码别名。它仍使用当前连接 actor 的 native bearer／same-origin／禁 redirect 请求，不新增 token、网络引擎或本地目录读取。Host 不知道 TS 的 session target；精确 target 捕获与只读 surface admission 仍由调用端负责，不把 key 当成 session 授权。
- start 和 stop 都要求当前 exact `expectedHost`。同一 key／scope／path 的重复 start 幂等，不重启 socket；同 key 换目录返回 `runtime_stream_target_mismatch`。旧 lease 的 panel stop 拒绝，不取消新代同 key；global/chat 保留旧 cleanup 幂等语义。事件仍是 `runtime.event/disconnected`，保留原 key、scope 和原始 SSE data；旧 ticket 的迟到事件不投递。
- 最多 4 条独立 panel streams，加既有 global/chat 最多 6 条。达到上限返回 `runtime_stream_capacity`，不驱逐任何现有流；stop 精确释放一个槽，scope retire 清全部。PTY 仍归 terminal owner，不进入此集合。100 ms actor tick 仅扫描最多 6 条，重连沿原有有界退避，不增加每条流 timer 或 catalog scan。此为数量／操作数合同，不是图形输入延迟或长期 SSE 吞吐验收。
- `runtime_stream.rs` 的 key／query 边界测试及 `runtime_stream_owner_tests.rs` 的真实 HostChannel/QuickJS 合成垂直测试覆盖 malformed keys、safe-integer 边界、重复/额外 query、容量、50 次 no-op start 零额外 fetch、stale lease、晚到事件、scope retire，以及 panel cleanup 后主 chat/global 继续收事件。它不代替生产 TS tab 装配或真实 Host 交付。

### 可取消普通 HTTP

- `runtime.http.capabilities({})` 在 credential load 前返回 `{version:1,request:true,cancel:true,windowID,maxRequests:4096,maxConcurrent:8,timeoutMs:30000}`；`windowID` 由本窗口 services owner 原生签发，无 Vault 读取。shutdown 后拒绝，不用 JS bool 代替该支持声明。
- `nsh.json` 已精确授予 `runtime.http.capabilities/request/cancel` 三项，TS consumer 仍须先核验真实 capability；iOS 未注册这些方法时保持 loader unsupported，不以 manifest grant 推断 native 支持。本线程没有修改 application、TS loader、tabs 或 iOS Host。
- `runtime.http.request` 只接受 `{ownerID,requestID,windowID,expectedHost,path,method?,body?,writerGrant?}`；受保护 mutation 必须通过 native writer gate，cancel 仍只接受前四项身份字段。ID 非空、最多 128 字节且仅字母数字／下划线／连字符。`expectedHost` 必须是当前 exact scope，window 必须是 capability 返回的 native window；同一个 requestID 在本进程跨 owner／窗口／lease 均不可复用。
- request 复用原 `make_request`、same-origin／禁 redirect／native bearer 策略与 `{status,body}`，不新建 HTTP transport。与其它原 actor HTTP 共用 8 jobs／30 秒期限。receipt 先 reserve，再在 fetch 前 bind 原私有 ticket；容量拒绝、finish、错误、取消、scope 退休后都不重放。最多保留 4096 个 request ID 和已绑定 ticket 的终身 tombstone，不淘汰旧证明。
- cancel-before-start 记录 pre-cancel，对应请求不 fetch；运行中取消只 remove exact job、调用 task.cancel 并以 `http_request_cancelled` 结算原 reply。`{ok:true}` 表示逻辑取消已登记，重复／已完成取消无副作用，不证明服务端模型停止。旧 lease／错误 owner／错误 window 拒绝；不使用 `runtime.stop`、资源 cancel、session abort，也不取消主 prompt／SSE／PTY 或新 lease 的请求。已删除 ticket 的迟到事件无效。
- 原 64 槽队列满时 request/cancel 均在派发前以 `native_host_busy` 拒绝；未登记的取消不能被视为已成功。8-job admission 满与已登记 receipt 是不同边界：已 reserve 的 ID 即使没 fetch 也保留，不允许换 payload 重放。现有 NSH cancel 的系统中止限制仍适用，见下方安全边界。
- `http_jobs_tests.rs` 的真实 HostChannel／QuickJS 回归覆盖 pre-cancel、exact 身份、原 reply、late End、主 HTTP 隔离、旧 lease、新 lease、scope 退休、队列满、共享容量／超时、redirect／坏 JSON 和保留非 2xx `{status,body}`；合成 Network 不等于 OS abort 或真实模型验收。

### 连接编辑与重新授权

独立 SSH owner 的 actor 接入、root slot、受控 process driver、合成测试和未完成边界见 [Native SSH handoff](../desktop-remote-connections-DOCUMENTATION.md)。生产入口现已声明真实 `src/ssh.rs` 并通过自有 `native_ssh_bridge.rs` 消费其 service worker；安全文件 I/O／完整 sync 仍归 SSH owner，未调用或注册成可用。

`src/connection_actor_port.rs` 已通过 `Message::Native` 接入原 64 槽连接 actor，不是第二 Vault 或另一条认证引擎。`bridge::Owner::connection_actor_port()` 返回 Rust-only `Port::{load,save,password,restore,authorize,healthy,retire,quarantine}`，DTO 为 `Target/Registry/Secret/Committed/Current`，不经 HostChannel／JS。`Current` 只能捕获原生 Cancellation 的无锁检查；typed Call 在 admission、异步 continuation 和最终 commit 前复验。只有 SSH 服务 worker 可以等待，不得在 engine/UI、SSH State 锁内或原 actor 自己等待自己。

- `connection_actor_storage.rs` 解析可选 `sshRegistry:{schema:1,revision,instances:[exact public Instance fields]}`：最多 32 条、revision ≤9007199254740000，缺失才为空，坏记录拒绝。registry CAS、未知顶层字段和原连接／通知退休 intent 在同一原安全记录保留；总记录仍限制 64 KiB，容量不足明确失败，不保证 32 条最大长度记录一定容纳。
- 凭据／绑定在私有 `sshNative:{schema:1,credentials:[{target,password}],bindings:[{target,connectionID,authorizationID,receipt,localPort}]}`，不进 registry／公开 snapshot。managed Secret 用 native CSPRNG 生成并在初始化前保存；external 无已保存 native credential 时明确 Authentication，尚无面向用户的 external credential provision 入口，不猜密码、不接受 JS Secret 或 Relay descriptor。
- `connection_actor.rs` 用现有异步 Network jobs 执行 native forward 的 `/auth/session`（trustDevice／issueClientToken、desktop-local clientKind，无旧 bearer；dedupeKey/clientLabel 按 fresh candidate ID 隔离，避免远端替换旧 desktop/legacy token）→ bearer probe → 新 connectionID、authorization、native receipt/binding 同一 Vault transaction。后台 authorize/restore/health-recovery 只 ready，不选 Host、不替换既有 selected endpoint/token/authorization、不轮 lease；只有原 `connection.select` durable 事务才选择和轮 lease。只为原生固定 `127.0.0.1:port` 提供 loopback grant，不改变全局 HTTPS 策略。不同 SSH target 不按 origin 合并，也不抢占普通 direct 同 origin 身份；普通连接编辑／重新授权不能改写 native SSH 绑定。
- 冷启动保存的 loopback endpoint 不发布 runtime scope；restore 仅对 exact saved target／direct binding 做认证 probe，成功提交新 candidate ID/receipt，仍须显式选择。Process 已为原 Port 接全部 live context 的真实 selected-ID 保守快照（并保护权威 cold default），在 anchor 收包/tick 前更新；reload/首 load 在 publish 前继承 exact Current，取消证明不被新 true 洗掉。healthy/retire 比较 exact binding/receipt，旧 cleanup 不撤新选择；已有 selected tunnel 在新 attempt 失败/取消时保留，不删除整个保存连接或停止远端手工服务。本次只有 focused 合成 Process 证据，晚到源码后的完整 aggregate 仍须重跑，TS Connect 继续关闭。
- 满队列返回未派发 Busy；queued timeout 撤销 admission，已派发 mutation timeout 返回 CommitUnknown，同步 fence services／原子 poison 原 actor，不能自动重放或晚到复活。quarantine ACK 只有原 actor 撤权后返回；已经进入 durable write 的操作可完成，不冒充超时回滚；确定未提交的写失败保 prior。
- 七项真实原 queue／注入 Network／合成 Vault 回归覆盖上述 CAS、持久关联、冷 restore、origin 隔离、失败保 prior、取消／target CAS、queue 满、dispatch timeout 和 quarantine。另有下述 HostChannel→真实 service/adapter→原 actor 垂直测试；未执行真实 SSH／用户配置操作，不把 connection-only 注册称作整体 SSH parity 完成。

### SSH connection-only 生产桥与停止屏障

- `bridge::Owner::install_ssh` 只移交原 typed Port；`ssh::service::install` 在自己的 service worker 调 `ssh::actor::create`，后者才等待原 actor load。HostChannel callback 仅移交 payload/reply 到原 64 槽 mailbox；原 actor 做 exact schema 校验，再经 16 槽非阻塞 submit 交 owning service，不在引擎线程解析／序列化，不持 SSH Owner 锁等待原 actor，不新增 Vault、认证引擎或 sync 文件实现。
- 六个方法独立于当前远端 Host 选择：capabilities/read 接受 `{}`；save 为 `{requestID,revision,instance}`，remove 为 `{requestID,revision,id}`，start 为 `{requestID,id,intent:"connect"|"restore"|"check"}`，cancel 为 `{id,attempt}`。instance 严格沿 SSH owner 八字段，拒绝 JS password／command／executable／Relay 参数；公开快照直接返回 owning Owner 的原 schema，无 Secret／native receipt。
- capability 是 `{version:1,connections:{supported,phase,maxPending:16},sync:{supported:false}}`。只有真实 service phase=Ready 才声明窄 connections.supported；starting/stopping/stopped/failed/unsupported 均 false。它不声明整体 SSH available、sync 或模型能力；未注册四个 sync 操作，不返回假 review/history/success。当前产品 manifest 已含六项 connection-only grants，main 在创建 AppView 前通过唯一 Process 安装一次，共享 dispatcher 路由至原 process anchor；主 consumer 仍须单独准入。自定义 bundle 无 SSH grant 时 main 不启动该服务或探测 executable。第二窗仍禁止创建，不能逐窗复制此 install。
- Mac 默认 driver 只接受固定 `/usr/bin/ssh`：逐级 root-owned、无 symlink、无 group/other 写权限，ACL 仅允许 deny，末项必须是有执行位的常规文件。此信任边界依赖 OS/root 本身可信，不接受 PATH、环境覆盖或 JS 路径；没有运行该可执行文件验证。Windows 尚无闭合的 OS-owned executable 证明，明确 unsupported，不以固定字符串或 metadata frontend 冒充验证。
- window shutdown 先同步 fence service admission／Cancellation，既有 Mac/Win UI loop 非阻塞观察 `shutdown_complete()`，等 owning service `on_stopped`（含 active workers 完成和 exact retirement）后才正常 stop AppView。原 bridge Owner drop 同步关闭普通 admission，下游 services 先失效；原 actor 继续只为清理保留，直到 on_stopped barrier 才退出。Retire/Quarantine 仍允许 exact native cleanup，其余新 native 操作拒绝。没有在 UI／原 actor 中 join 或等待自己；系统强制终止仍无法保证正常清理完成。
- `on_stopped(Ok)` 才释放原 actor teardown；`Err` 不设置成功 stopped、不调用已登记的 teardown closure，并由 `Control::shutdown_failure()` 保留原错误。worker 已退出不代表 authority 已安全退休。启动 load CommitUnknown 和已派发 Vault mutation CommitUnknown 都保持 services unavailable、UI shutdown barrier 未完成、原 actor 的 exact cleanup lane 存活；不自动重放、重建 dispatcher 或把 Unknown 清成成功。目前没有解除该 unresolved 状态的生产恢复入口，不能把窗口保留状态描述为已正常退出。
- `native_ssh_bridge_tests.rs` 五项使用实际 HostChannel／QuickJS、原 owning service/adapter、合成 driver/Network 与原 Vault transaction：managed mint/probe/Ready、公开无私密字段、shutdown 先 retire 后 actor exit、Host drop 期间 blocked SSH operation 被 fence 且保留原 actor至退出、unsupported driver 零 Vault／无 fake support、原 actor启动和派发写 CommitUnknown 保持 terminal failed/原错误且不放行 teardown。测试不启动真实 SSH、用户 shell、Host、UI 或读取用户凭据；unresolved 测试最后只通过测试私有 actor stop 清理合成线程，不是生产恢复/强制成功入口。

### Rust-only Provider keys／Magpie raw HTTP seam

- 精确入口为 `bridge::Owner::connection_actor_http_port() -> connection_actor_http_port::Port`；实现是 `src/connection_actor_http_port.rs` 和 `src/connection_actor_http.rs`。没有修改冻结的 `connection_actor_port::Command`／`actor::create`，没有添加 JS Host 方法、manifest grant、另一个 Network 或 Vault。只有 native service worker 可等待该 Port；`Current` 仍必须仅捕获 lock-free Cancellation，不能反向锁 SSH Owner／services 或做 I/O。
- 调用为 `Port::request(Authority, Request, Current) -> Result<Response>`。`Authority::Remote` 接受原 typed `Committed`；每次派发、网络事件和最终响应复验 active native receipt、完整 target/binding、connection ID、authorization、origin/token 和 runtime live fence。它独立于当前选中 Host，不借主窗口 lease；切到其它 Host 不改其认证，exact retire／重新授权／quarantine／shutdown 则撤销。普通 direct connection ID 或 localhost URL 不能构造该 authority。
- `Request` 只有六个 variant，对应现有 server 固定路由，不接受自定义 URL/path/query/header：`CredentialsInventory` → GET `/api/yuri/config-sync/credentials/inventory`；`CredentialsExport` → GET `/api/yuri/config-sync/download/credentials`；`CredentialsImport(Vec<u8>)` → PUT `/api/yuri/config-sync/credentials`；Magpie 三项同形使用 `/magpie/inventory`、`/download/magpie`、`/magpie`。不开放文件 archive、prepare/finalize 或任意其它 config-sync 路由。
- `Response {status:u16,body:Vec<u8>}`、Request 均不实现 Debug/Serialize；不进入 HostReply、普通磁盘、诊断或日志。原 actor 注入 bearer、禁 redirects、使用 no-store 请求；import body 直接移动到 raw bytes，不包 JSON/base64。export 接受 octet-stream；inventory/ACK 接受 JSON，错误读取保留非 2xx status/native body，不伪空成功。最终 URL、MIME、重复 head/Content-Length、长度上界和完整长度均复验。
- `MAX_BYTES=512 MiB` 与 server receiver 上界一致；inventory／import ACK 上限 1 MiB。原 8-job 容量内，raw Port 的所有 clone 共用 queued+running 最多 2 项 permit；队列满、调用者放弃或任务结束释放 permit，不无限缓存敏感 payload。deadline 为 300 秒；actor 既有 tick 扫描最多 8 jobs 以清理 Current 失效／超时。此为内存／操作数边界，不是满规模性能或 OS abort 验收。
- `Error` 为 `Invalid/Stale/Busy/Unavailable/Cancelled/Authentication/CommitUnknown/Unknown`。`Busy`／派发前 Cancelled 是明确未 fetch；HTTP import 一旦标记 dispatch，取消、超时、撤权、redirect、坏回执、非 2xx 或未知网络结果均 `Unknown`。它只表示该敏感同步写未知，不自动 poison 整个 Vault、不自动重放；上层 adapter/coordinator 必须保留 unknown write fence，不能根据一次 inventory 推断成功或解除锁。`CommitUnknown` 专指原 actor authority 已未知／隔离，不能降级成普通网络失败。
- `Port::local_service() -> Result<LocalServiceGrant>` 当前稳定返回 `Unavailable`，sealed grant 无公开构造器；NSH client 没有真实本机 Host service grant producer，绝不以 active remote、saved direct 或猜测 localhost 替代。因此此 seam 只交付 exact remote 的能力，完整 push/pull Provider keys／Magpie 同步仍受本机 source/destination authority 和 owning coordinator 阻塞，未声明 production sync available。production 未消费的 Rust-only contract 仅在相应新 API 上注明 dead-code 原因，测试构建继续检查，不以假调用消除 lint。
- `connection_actor_http_tests.rs` 六项原 actor／合成 Network 回归和 pure Port 两项覆盖固定 routes、NUL/二进制 native byte 保真、选中 Host 隔离、错误 receipt、共享容量、真实原队列满、取消／timeout／late End、exact retire／新授权、redirect／坏 MIME／坏长度／非 2xx、零本机 grant 和 shutdown；没有读取真实 Provider keys／Magpie、用户文件、启动真实 SSH／Host 或模型。

- `connection_editor.rs` 由原 actor 调用，沿用 TS `connection-editor-core.ts` 与 Swift `connection-editor.swift` 的字段和稳定错误。descriptor 不含 token／authorizationID，普通连接 snapshot 不增加 editor version。存储的可选 `editorVersion` 缺失时视为 `legacy`；第一次真实编辑才生成新版本，不要求迁移重写旧记录。
- label trim 后非空、最多 120 UTF-16 code units、禁止 control 字符。rename 只接受 id/version/label；edit 可再接受 url。相同 canonical origin／相同 label 是 no-op，不写 Vault、不改 version。HTTP origin 的语法比较不授予网络权限，真实 connect 仍要求 HTTPS 或显式 loopback gate。
- metadata-only 事务保持 token、authorizationID、连接 ID、选中项、recency、lease 与已有 browser／terminal／HTTP／SSE／documents owner。旧 version 返回 `connection_editor_stale`；普通存储失败返回 `connection_editor_storage` 并保 prior；跨进程 conflict／提交未知继续走原 Vault quarantine，不伪装普通失败后使用旧凭据。
- 重新授权不复用任一已保存 token。密码兑换不携带旧 bearer，新发 token 仅由 Rust 用于认证 probe；密码阶段与最终提交均重新检查原 ID/version，最终再排除其它连接的 origin 冲突。成功保留原 ID、lastUsedAt 和 selection，并生成新 version／authorizationID；历史项不会抢占当前连接或轮当前 lease。网络、CAS 或已确认未提交的存储失败均保 prior。Relay 字段、配对链接和 Relay 安全记录都不能静默转成 direct。

### 外观 owner 与公开 API 边界

`appearance.rs` 重复校验生产 `appearance-core.ts`／iOS `NativeAppearanceContract` 的数据边界：16 KiB、exact host/revision、21 项语义颜色、双 palette、四个有限字体名称。没有接受 CSS、脚本或任意 token。`fixtures/appearance.mjs` 直接调用现有 TS `nativeThemeTokens`，`bun packages/nsh/desktop-host/fixtures/appearance.mjs --check` 校验共享 fixture；Rust 测试再读取同一 fixture，避免另造 palette。

NSH 0.4.0 的 `run_app` 隐藏其 AppView，但两平台的公开 AppView 都有 `set_theme_overrides`、`set_font_scale`。macOS runner 因而自持 AppView；有界 UI mailbox 将完整已验证命令交给主线程，调用这些真实 API，把 `font-sans/font-mono` 映射到已查证的 AppKit 字体。未安装字体明确列在 `unsupportedFonts`，返回实际 generic fallback，不声称已加载打包字体。assistant 字体身份按已有 TS semantic TextStyle 协议返回，不改 TS。

主线程同时更新 NSView 的原生 appearance；NSH 应用自身的 `setColorScheme` 信号继续由现有 TS `changed` 流程所有，不通过 host event 注入，也不替代该 JS authority。这是原生 token/字体 API 实现，不是 AppKit 逐帧效果已验收。原生命令前后检查 generation；连接转换与 reset 轮换 fence，主线程即使 mailbox 满也会按共享 generation 清除旧覆盖。无 owner／队列满／原生调用失败均 reject，不能仅凭 `host.send` 返回成功。

**Windows 实现**：`native_ui_windows.rs` 调用公开 `AppView::new(None, …)`／`hwnd()`／`load()`／`show()`／`stop()`，UI 线程初始化 DPI／OLE 和应用标识；50 ms Win32 thread timer 唤醒 loop 消费两个 bounded mailbox（每轮最多 16 项）。外观通过真实 `set_theme_overrides`／`set_font_scale`，GDI 枚举已安装字体，系统 message font 与 Consolas 对齐 NSH 0.4 自身 generic 映射；不存在的字体返回明确 unsupported 列表和实际 generic fallback。原生标题栏使用 DWM setter，失败 reject 并恢复先前 tokens，不把 setter-only 属性当作可读取的事务 getter；token 解析失败不会先改标题栏。Host invalidation 即使系统模式查询失败也先清除旧 tokens。JS `setColorScheme` 仍由现有根同步拥有。此为跨 cfg 源码，不是 Windows 实机效果证据。

### 资源 owner 与 Host 文件边界

- 沿用 iOS read payload：`{path, requestId?, expectedHost}`。先校验 receipt，再访问 Host `/api/fs/stat?path=…`，确认文件、二进制分类、大小；仅文本走 Host `/api/fs/read?path=…`。这是有意不用 iOS 的通用 serve/本地临时文件/QuickLook 分支：本轮没有安全的桌面媒体 renderer。
- 不调用客户端文件系统读取 Host path，不拼本地 file URL，不把 Host 凭据交给 JS。编辑只保留现有 `runtime.request` → Host `/api/fs/write` 的通道，Rust 不实现客户端文件编辑旁路。
- stat 最多 64 KiB，文本最多 1,000,000 字节；Content-Length 与实际接收双重限制。必须是 text/plain、有效 UTF-8、无 NUL；缺失文件标记、二进制/已知媒体后缀、非法 MIME、超限及重定向都明确失败，不伪造文本内容。
- 最多两条资源读取、32 个租约、共 8 MB 的 native 文本内存。每个返回 UUID 租约都由 Rust Book 持有真实文本和 captured scope；release 只删除该租约，close 对没有原生 presentation 的文本是幂等关闭，不释放正文，cancel 只终止对应未完成读取，不释放任何已完成租约。
- 保留旧 wire 的 `{requestId}` cleanup：requestId 永不在本进程复用，避免迟到 cancel 获取别的 owner；最多保留 4096 个已用 ID，达到上限明确 reject，不通过淘汰旧证明冒险复用。cleanup 也接受可选 expectedHost，并严格匹配原 owner。切 Host 清除全部 pending/lease，迟到网络回调不会产生新租约；tombstone 不因切 Host 清空。

### 系统关闭 admission

- `NSWindowDelegate.windowShouldClose:` 截获系统 X、菜单 Close 和 NSH 的 `Window.close`（已核对上游该动作调用 `performClose`）；`NSApplicationDelegate.applicationShouldTerminate:` 截获 Quit。两者先拒绝系统立即关闭，不同步等待 JS。
- 原生发送 `desktop.window.closeRequested`，payload 为 `{ticket, reason: "close" | "quit", windowID, generation}`。窗口 ID 与 nonce 都由系统 CSPRNG 产生，不含凭据；ticket 绑定窗口身份和本窗口单调递增代际。同一活 ticket 期间再次点击不创建并行确认。
- Host 方法 `desktop.window.closeDecision` 只接受 exact `{ticket, approved: boolean}`。回调只放入本窗 16 项 mailbox，主线程验证当前窗口、ticket 和有效期；普通 close 的 `true` 只关闭所属窗口，`false` 保留窗口。Quit 对全部窗口 fanout，已批准 promise 保持 pending，任一 veto/超时拒绝持有的批准 promise 以解开 TS committing lock，不提前退休其他窗；全部批准后先 fence 全窗服务再 cleanup。非法、旧窗口、旧代、重复或过期 decision 均 reject。
- 30 秒无有效 decision 只使 ticket 失效，不关闭；再次 X/Quit 会发新 ticket。事件投递失败也保留窗口并可重试。不使用“引擎不活跃”“JS 崩溃”作为批准证据。获批后的 teardown 先停止 engine、解除 delegate，再 `window.close`，不会递归创建关闭请求。强制杀进程/系统终止不在可拦截范围内。
- 原生事件分发由唯一 `NSApplication.run()` 所有，50 ms common-mode `NSTimer` 消费逐窗有界 mailbox；不靠手动 `nextEvent` 假代替 AppKit 生命周期。装 persistence 后，完整 final capture/磁盘 ACK/authority epoch/票据复验早于 services fence 与 ACK；services 同步 fence 原 actor admission，Owner 的 teardown 状态与 admission 分开，不能提前置 admission 后跳过真正停止。逐窗 services/actor 退休后停止本窗 Engine 并 teardown；普通最后窗关闭仍保留生产 App，可由 Dock 经原 factory 重开；只有 Quit 完成才 `stop:` 加唤醒事件退出系统 loop，不在 UI 同步等待 JS/actor。
- **TS 接线是单独的必要条件**：主线程已声明 manifest 并接生产事件，先 `files.requestWindowClose`、再 `settingsRoot.requestWindowClose`，两者只确认不 dispose/dismiss，最后 `files.canWindowClose` 同步复验；本目录不修改 App/manifest。原生没有声明、没有监听或监听异常时始终 fail-closed，headless guard 不代替真实 dirty 文件/系统按钮实机验收。
- **Windows Win32 owner**：在 load/show 之前安装 `SetWindowSubclass`，安装或 UI timer 失败则拒绝启动，不回退 `run_app`。`WM_CLOSE`（含 X/Alt-F4 与 NSH Window.close）先发送相同事件，未获有效 true 不链至默认销毁。loop 收到 `WM_QUIT` 也先转 quit admission，不把 GetMessage 返回零当批准；API 读取失败保留窗口、不忙等退出。批准后 stop engine、移除 subclass、销毁本 HWND，无递归请求。
- **Windows 注销/关机**：`WM_QUERYENDSESSION` 必须同步回答，先 FALSE 再全窗异步 reason=quit；批准后只退出本应用，不替用户重发关机。`WM_ENDSESSION(FALSE)` 只撤销 exact 系统 query quit serial，不撤销独立 X/quit 或后来的新 query；迟到确认 stale。`WM_ENDSESSION(TRUE)`/critical/任务管理器强杀无法可靠 veto，记录未批准的强制终止，不当成批准或冒充保存草稿；不主动 DestroyWindow 绕过 guard。强杀的持久性仍需单独验收。

### 独立 browser 的生产接线

- `bridge::install_configured` 内的 actor 使用同一注入 Network 创建唯一 `host_services::Port`，其内创建唯一 `browser_view::Port`；`Owner::services()` 只把原生 clone 交给 UI owner，没有暴露给 JS 的授权方法。生产入口与 synthetic example 都复用此接线，不读取额外凭据。
- 安全存储成功恢复选中连接并签发 scope 后授权一次；转换必须先 durable persist，再同步 invalidate 旧 browser、清理旧 HTTP/SSE/resources，再发布新 state 并授权新 scope。普通写失败保 prior browser；提交未知/conflict 撤销 browser 并 quarantine；非选中项删除不轮换其 authority。空 bearer 等 browser 授权失败不会回滚有效连接，组件独立报告 authority unavailable。
- Mac 在 AppView 创建后、load 之前 register；现有 50 ms common-mode timer 调用 poll，Pump 一直保留至 view.stop。Windows 在 `AppView::new(None, options)` 前注册 `options.components`；其子 HWND 使用 browser 模块自己的 timer，无 `run_app` 隐藏 owner 依赖。退出先 shutdown 原生服务再 stop；同步 publication gate 阻止进行中的 durable write 在 shutdown 后重新授权。
- 本轮仅修改入口／actor／native owner 与集成测试，没有修改 `browser_view*.rs` 实现、TS application 或主线程拥有的 panel 接线。浏览器的协议、隔离约束和未验项见 [desktop-browser-DOCUMENTATION.md](../desktop-browser-DOCUMENTATION.md)。无 GUI 插件、Eficy 或 `resources.web.present` 全屏旁路。

### Terminal／附件的生产接线与 native authority

- `host_services.rs` 是连接 actor 对原生子服务的唯一发布点；selected 的 scope、origin、token、authorization 都来自成功恢复／durable commit，不另读 Vault。terminal capture 是 Rust-only `Captured::direct`，持续校验 exact lease＋authorization。shutdown 与 publish 在同一锁下串行，不能迟到复活；撤权、清 renderer scope 后才 detach 旧 terminal／取消 actor job。
- main 在创建 AppView/load 之前注册 terminal 到同一 `AppOptions.components`，先安装通用 bridge、再安装 registration capability 和 `terminal_host::install`；catalog 使用 NSH 私有 app data 目录，不接受 JS 路径。Registration/terminal Owner 保留到 shutdown。当前 Mac Registration 没有导出 poll，WK delegate 回调驱动；不为满足名义接线虚构 pump 或 ready。Windows 注册随 terminal Agent 模块的真实实现交付，不把未准备的 registration 宣称为 renderer 可用。
- terminal HTTP/SSE 复用同一 NSH Network；direct WS 使用同一 actor 发布的 captured authority 与原生平台网络，没有新 token 来源、外部明文 transport 或剥离 Relay 转直连。`wsAvailable:true` 表示已有原生 adapter，不代表 handshake／bind／renderer ready；SSE 仍明确 `replayUnavailable:true`。退休只 detach，绝不发送 DELETE/force-kill。详见下节及 [terminal-desktop.md](../terminal-desktop.md)。
- `attachment_transport.rs` 的 `Transport::upload` 只在附件 worker 等待；先通过有界 mailbox 把 native Vec 移交 actor。actor 再校验 exact scope 与固定上传路由：session 使用 UUID temporary 路径和五项 native header 白名单，assistant 使用固定 contact attachment 路径和四项白名单；用现有 `make_request` 注入认证、PUT 原始 bytes，不进入 JSON/base64/HostChannel。响应最多 64 KiB，禁止 redirect。超过 actor job 上限或派发前取消可明确 Denied；派发后的超时、坏响应、退休均 Unknown，绝不自动重放；逻辑取消仍接收已知 late receipt以计入临时孤儿文件。
- Assistant 附件扩展复用上述 `attachments*.rs` 与原 actor transport，不新增 Rust main 安装、凭据来源、manifest 方法或网络引擎。pick/status/cancel/release 的可选 `target` 为 `{kind:'session'}` 或 exact `{kind:'assistant',assistantID}`；省略仅兼容 session，不能以 receipt ID 借另一个 target。assistant 上传限定 `PUT /api/yuri/assistants/<opaqueID>/contact/attachments/<UUID>`，仅 `Content-Type/X-Content-Size/X-Content-SHA256/X-Attachment-Filename`，不得自报 Authorization、任意路径或 message 写权限。201 的 exact descriptor 复验 hash/size/MIME/attachmentID 后返回 Host-relative URI＋contact metadata，不返回本地 file URL/路径/bytes；bad receipt/unknown 零重放，partial/late cancel 保留 receipt 与 orphan 计数。单文件 25 MiB、总计 50 MiB、64 文件和有界 receipt 预算不变。`application.tsx` 的实际 composer 已传 session/assistant target，`model.ts`/`drafts.ts` 保留并校验 contact descriptor；这里只核对接线，不借 Rust 测试代替 TS/真实 UI 验收。
- 原生 picker 只由 `attachments::Selected` 的系统 dialog 授予路径，不提供 JS 本地 path 构造器。Mac/Win 每轮 UI mailbox 最多取一项，使用真实 NSWindow/HWND，调度函数不在借用 pump 时进入嵌套 modal。已有 appearance/decision 每轮 16 项上限保留；无新 JS 同步 I/O。长期吞吐和真实输入时延尚未测量，不能从 mailbox 上限推断性能已验收。
- `real_host_actor_authority_drives_terminal_http_sse_and_raw_attachment_without_ui_or_vault` 通过真实 HostChannel／QuickJS／NSH Network 访问无 shell 的合成 loopback：create、SSE、含 NUL/CRLF 的中文输入、resize、lease 退役与 raw 0xff bytes PUT；断言原生 Authorization、无 JSON 编码／凭据泄露、退休不杀 PTY、catalog 不存输入输出。这是生产接线和 transport 证据，不是系统 picker、Ghostty 画面或 Windows COM 已验收。

### 原生 direct PTY WebSocket-v2

- 固定 NSH 0.4.0 的 `Network` 只有 fetch；`nsh_core::websocket` 虽有公开 trait，但 Mac／Windows 没有导出的原生 transport factory。这里没有把 trait 当成可用栈，也没有安装依赖或在 renderer WebView 打开 socket。`terminal_transport.rs` 内嵌 `terminal_transport_ws.rs` 与 `terminal_socket*.rs`，所有既有 Host 入口自动消费同一实现。
- Mac 使用公开 `NSURLSessionWebSocketTask`：ephemeral session、无 cookie/cache/credential storage，凭据只在 Authorization header，Origin 为 captured HTTP origin，HTTP→WS／HTTPS→WSS，redirect delegate 一律拒绝。使用 Foundation 的公开 Objective-C selector／系统 block ABI，无 trust override。Windows 源码使用 WinHTTP upgrade／Send／Receive／Close，禁 redirects、cookies 和 ambient authentication，校验 101 后才 complete upgrade；TLS 使用系统默认校验。
- 与 Web `terminalApi.ts`、iOS `TerminalBridge.swift` 相同：binary byte `0x01`＋JSON；bind `{t:'b',s,r,v:2}`，仅正确 `bok` 后发 connected；`d.i` 是 server cursor，重复 ID 不再输出，跳号显式 `replayGap:true`；`x` 是权威退出，`e` 不冒充成功；20 秒 `p`／`po` keepalive、15 秒 open/bind deadline、60 秒活跃期限。每个 active attachment 独占一条物理 socket，按 iOS owner 结构实现 mux wire，不额外引入全局共享 socket 框架或自动重试循环。
- presentation `id` 与 server `cursor` 分离；attach 只接受已由 native 收到的 safe-integer cursor，renderer ACK 不进入 transport、不推进 replay。重新 attach 使用 controller 保留的 server cursor；坏帧／断线返回明确 error，先前已收到的输出与 catalog 保留。SSE 的后续输出不制造 replay ID。
- 仅 upgrade 失败且尚未发送 bind／输入时允许同一 direct authority 的 SSE fallback；create 显式声明非 WS stream 时沿其 SSE 能力。已打开后的 bind、协议、输出、input 失败不偷偷切到 HTTP 重发。WS text input 保留 Unicode／NUL／CRLF，send completion 只表示与 iOS 相同的 transport acceptance，不冒充服务端 PTY 执行 ACK；WRITE_FAIL／未知发送会锁定原 native session 的 input，直到显式关闭／重启，不因 detach／reattach 重放或解锁。
- 所有阻塞操作留在 worker。native 单消息最多 1 MiB，单 input 64 KiB，socket event mailbox 8 项、input mailbox 4 项；超限明确失败，不静默丢屏。输出另校验 controller 的 1,000,000 UTF-16 上限，避免接收后被 UI 静默丢弃。Mac 每次只保留一个 pending native receive；Windows 单 reader 有界组装 fragments，Close 先取消 pending receive、join 后再释放 handles。真实长期吞吐／系统超时及 Windows 取消行为仍需实测。
- `fixtures/terminal-ws.py` 是只用标准库的短时 localhost RFC6455 fixture，无 PTY/shell/用户文件；严格核验 native Authorization、Origin、固定 path、无 cookie，并验证 masked text input。Rust 测试覆盖真实 Mac 原生 socket 的 fragmented Unicode output、原始输入、gap、断线重绑／duplicate replay、retire、redirect 目标零连接、native 消息上限；另经 committed actor→HostChannel→QuickJS 覆盖生产接线、伪造未来 cursor 拒绝、pre-bind SSE fallback 与 WRITE_FAIL 后零重放。fixture 自起自停，不留下 service；不是用户 Host 或真实 PTY 验收。
- `node packages/nsh/desktop-host/fixtures/check-windows-terminal-socket.mjs` 选择真实 Windows adapter 与真实 common 源码做 `-D warnings` metadata frontend 检查，不使用假 WinHTTP runtime。仍是 Darwin std，**不验证 Windows target／SDK／DLL 链接／系统网络**，不能把它当 Windows 编译或实机证据。公开 API 依据：[Apple WebSocket task](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask)、[WinHTTP upgrade](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpwebsocketcompleteupgrade)、[WinHTTP Receive／Close 取消合同](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpwebsocketreceive)。

### 下载与 tab observer 的生产接线

- main 在通用 fallback 后、JS load 前调用 `services.install_file_download`，强持有 v2 Owner；精确方法为 `desktop.files.download.{capabilities,save,status,cancel,resume}`。Reader 从同 actor committed publication 捕获 scope/window/origin/bearer/authorization，释放 publication State 锁后构造 opaque transport handle；不信 JS 自报授权、不另读 Vault。
- download capture 的 current fence 包括 exact authority 和单调 suspension epoch。metadata-only 不轮 epoch；Host/auth/lease 替换、suspension 和 shutdown 先 invalidate，再改变 publication。wake 不复活旧 handle；shutdown drop Owner 早于 view.stop。真实 HostChannel／QuickJS 与认证 raw GET 回归验证这些生产接线，不执行系统 chooser。续传、Stage、unknown receipt 合同归 [下载 owner](./desktop-file-download-DOCUMENTATION.md)。
- Mac/Win UI 每轮只从 diagnostics、documents、attachments、downloads 四类 mailbox 取一项，并检查四类真实 `is_presenting` 状态；使用已有 NSWindow/HWND，不在持 UI RefCell 借用时进入嵌套 modal。现有 appearance/close 有界处理不变。
- tab 组件在 AppView 前 register，由 services 唯一 committed publisher `set_scope`；UI 在真实窗口建立后、load 前 `install_observer`，现有 loop 传真实 foreground／native modal gate 给 `poll`。每次 lease 退休先 `set_scope(None)`；shutdown 后迟到 publication 不复活。observer 在 view.stop／窗口销毁前 retire。Windows 仅原 window_proc 调 observe 并继续既有分发，不新增 subclass/child HWND；Mac monitor 保留原事件，不用 overlay 抢点击。合同见 [DESKTOP-TAB-EVENTS.md](./DESKTOP-TAB-EVENTS.md)。
- production services 回归直接消费 owner 的 test-only `current_scope()`：安装恢复、list/metadata 保留、失败 Vault 保 prior、换 lease、显式撤权和 shutdown 均核验；不创建窗口，不把 registration 或 metadata frontend 当物理鼠标／键盘验收。

### Documents SaveDialog 的生产接线

- main 创建 `documents::channel`，在通用 bridge fallback 后调用 `install`，`host_services::State` 持有返回的 Owner；authority closure 只查询同一 actor 已提交的 native `Reader.current`，不信任 JS 自报 scope、不另读 Vault。接口合同见 `examples/documents_contract.rs`。
- Mac／Windows UI 在借用 guard 之外，每轮最多从 diagnostics、documents、attachments 或 downloads 取一项，使用真实 NSWindow/HWND 调用 `job.show`；四类共享 UI admission 检查真实 `is_presenting` 状态，覆盖 scheduled／modal 生命周期，避免系统 dialog 重叠。Mac timer 先 take 出 pump closure 再调用，不跨嵌套 modal 持有 RefCell 借用。
- Host／lease 撤权先同步 `Owner.invalidate()`，再清旧 selected／发布新 scope。它与最后的本地 rename 共用 documents gate；gate 内不会反向调用 authority publisher，避免锁序反转。shutdown 取出并 drop Owner 后才 `view.stop()`；Windows 关闭 hook／timer 安装失败、获批系统关闭及系统销毁通知也先撤权，不等待正常 loop 收尾。
- 保存只接受固定 Markdown metadata／最多 8 MiB 正文，路径只来自系统 dialog。status 只读取既有 receipt；未知写入仅核验原生 grant，不能再次打开 dialog／重写。成功回执、错误与 JS 均不包含本地路径。本线程没有修改 documents 模块实现，也没有打开系统弹窗或读写真实用户文档。

### 通知的生产接线与跨存储退休

- main 在通用 fallback 后、JS load 前安装 notification Owner；`host_services::Port` 的 OnceLock 保留 Owner，同一 actor 发布唯一 committed native identity。metadata-only／重复 list 不轮 notification generation，换 Host／lease 先撤旧 identity，shutdown 的 `Control` 原子 fence 在取得 services State 锁前执行。receipt/identity ACK 不在 UI 上等待，services State 锁不跨通知 durable handoff；安装期间若发生 shutdown，迟到 Owner 被停止并拒绝挂载。
- Mac 主线程先创建真实 NSApplication，再由 worker 安装 UN delegate，早于 didFinishLaunching；Mac application active/resign、Windows application activation 驱动真实 foreground，不用 JS、最小化或 engine ready 猜测。通知 UI job 与系统 dialog admission 协调，退出 mutable UI borrow 后每轮至多执行一项。shutdown 早于 AppView.stop，保留正常 queued receipt，不等待 OS worker。
- 删除／换 authorization 时，无论通知 Store 当时是否可用，bounded `notificationRetirements` 都与连接变更在同一 Vault 事务提交。确定 Vault 失败保 prior、不提前 tombstone；成功后 actor 将 exact intent 交 `commit_retirement` 写入通知 Store 的 durable deny，确认后再用另一 Vault 事务清该 intent。清 intent 失败保留并幂等重试，绝不重放 connect／重新授权。Store unknown 在当前进程 sticky，下一进程核验，不假装空成功。
- tombstone 完成与 OS remove 分离；OS cleanup 失败由 Store 的 retired rows 保留重试，即使 Vault intent 已清也不丢失。snapshot 的可选 `notificationRetirement:{pending,error}` 区分剩余 intent 与 cleanup 错误，`connection.list` 可显式重试 handoff 和最多一个 OS cleanup，不重发通知或申请权限。Store 不可用时通知方法明确拒绝，退休 intent 继续 durable 保留，其它原生服务不因缺少通知 Owner 被禁用。
- 通知 receipt 与 journal 分离；原生只接受固定 `notification-receipts`／`native-preferences`／`window-state` 三个独立私有目录名。Mac 用 Foundation home、逐级 nofollow handle、owner／POSIX mode 和权威 ACL 检查；private leaf 拒绝 ACL，祖先仅允许 deny-only ACL。Windows 用 KnownFolder LocalAppData／固定本地卷、pin 无 reparse 祖先、保护当前用户 DACL 并回读核验；从不 chmod／修复陌生目录。grant 失败给所有 notification 方法 `notification_unsupported_private_directory`，不用假内存 Store；身份缺失稳定 `notification_unsupported_identity`。window-state 使用同次 path + pinned Store，不复用 notification 的文件或锁。
- Windows 构建仅生成 `native-notification-identity.json` 与显式 `Install-Notifications.ps1`，CLSID 为实际 app ID 派生的稳定 UUIDv5；不在 build/startup 自动注册。安装脚本生成 per-user Start Menu shortcut 的 AUMID／ToastActivatorCLSID 与 exact LocalServer32，拒绝覆盖其它 executable 注册。runtime 回读 shortcut target／空 arguments／两个属性，native driver 再验 process AUMID／LocalServer32；未注册即 unsupported。runner 冷参数仅接受 `--notification-activation` 与单个合法 embedding 参数，拒绝 bundle／Host／receipt 路径，不提前读 Vault／连接 Host。
- 通知独立 wire／receipt／OS driver 合同见 [desktop-notifications.md](../desktop-notifications.md)。这里的生产安装及合成测试不等于真实 permission、banner、click、COM cold activation 或 DACL 已验收；本轮没有执行安装脚本、注册身份、发送系统通知或启动真实 UI。

### 匿名诊断的生产接线

- main 在通用 bridge fallback 后安装四个诊断方法；`host_services` 强持有诊断 Owner。capture 在同一 publication 锁内读取 selected Host/lease、authorization、native window ID 与 suspension；不另读 Vault，不从 JS/status/首条连接猜授权。
- `Port::window_id()` 为 single-window services owner 签发并保留系统随机身份；close admission 与诊断 job 使用同一 ID。scope/auth/origin 替换前先 invalidate；metadata-only rename 与确定未提交的写失败保留 recording lease。unknown/conflict quarantine、shutdown 先撤权，再清 selected；Owner 在 `view.stop()` 前 drop。
- Mac NSWorkspace sleep/wake、Windows `WM_POWERBROADCAST` 4/7/18 驱动明确的 diagnostics suspension；清录制 epoch，暂停 capture，恢复后下一次 status 发新 recording lease。dialog 失焦、普通 resign-active、遮挡、最小化不被当成 runtime suspension；本 hook **不是** terminal/browser/actor lease 的完整休眠恢复。
- main 通过 `install_diagnostics_with_preference` 注入 `native_preferences::Consent`，复用现有 transactional FileStore，但在独立 `native-preferences` 私有目录，仅写 `{v:1,diagnosticsEnabled:boolean}`；不进入 credential Vault，不保存事件、Host scope、窗口或录制 lease。缺失默认 false，确认的 opt-in 跨启动恢复 bool，事件与 authority 必须重新获取。FileStore 固定文件名虽沿用 `desktop-notification-receipts.json`，但与 notification inbox／journal 不共用目录或内容。
- grant／load 失败安装 disabled + load-failed，不降级成 process-local 假成功；显式 enable 只有 save(true) 成功才启用。disable 先立即撤 consent／清内存／取消导出，即使 save(false) 失败当前进程也停录并报错；无法写盘时不能承诺磁盘旧 true 已被清除或跨崩溃保持关闭，只可显式重试。真实私有临时磁盘测试覆盖 cold restore、false 保存和 corruption 拒绝，生产 HostChannel 测试确认跨实例仅恢复 enabled、不恢复事件／authority。导出版本/build 仍由 `appearance::metadata(app)` 的原生投影提供。
- 本线程新增生产 HostChannel/QuickJS 测试覆盖默认 status 零 Vault 读取、exact auth/window、metadata 保录制、失败写保 prior、pending export 在 retire 返回前 cancelled、suspend/resume、quarantine 与 shutdown；不调用系统 dialog，不读用户文档。细节与独立合同见 [desktop-diagnostics-DOCUMENTATION.md](./desktop-diagnostics-DOCUMENTATION.md)。

### Window-scoped file journal 的生产接线

- main 复用 terminal catalog 同级原生 app data directory，在通用 bridge fallback 后、JS load 前调用 `services.install_file_journal`，固定 native namespace 为 `primary`。JS 不指定客户端路径／namespace；随机 native window ID 不参与磁盘 namespace，冷启动仍找到同一份 journal。
- `host_services::State.file_journal` 强持有独立 Owner；普通 Host metadata／lease／authorization 退役不触碰它。仅 window shutdown 取出并 drop，早于 `view.stop()`；重复安装和 shutdown 后再安装明确拒绝。窗口关闭前已有 TS flush/确认仍为必要条件，Owner drop 不冒充所有排队操作已提交。
- 三个 capability 保留模块 exact wire：snapshot `{}`、commit `{expectedVersion,requestID,records}`、sync `{version,requestID}`。sync 只核验真实持久版本／receipt，不重发 unknown commit；共同容量为 20 条／4 MiB，doc 与 operation authority 分区混合存储，不按当前 Host 过滤其他分区。模块的双 slot／flush／exclusive lock／损坏拒绝合同见 [file_journal_contract.rs](./examples/file_journal_contract.rs)。
- 新增生产 HostChannel/QuickJS＋独立临时目录测试，验证 fallback 覆盖、混合三记录、metadata／换 lease／删除当前 Host 后完整保留、stale CAS 拒绝、Host-filter 额外字段拒绝、shutdown 拒绝以及同一 `primary` namespace 冷恢复。未修改 `file_journal*.rs` 实现或 TS／manifest；主 App 注入由主线程所有。磁盘测试不等于真实 App 编辑器／关闭保护或 Windows 系统行为已验收。

### Windows 64 KiB 安全存储（已写源码，Windows 未验）

已选择 **Credential Manager 不可变分块 + 单 manifest**，不再用 2560-byte 单 record 充当容量支持；没有另加 DPAPI 文件或明文 fallback。输入与 macOS 同为 64 KiB，最多 26 块，每块 <=2560 字节，manifest 在独立小 record 中保存版本、随机 generation、总长、块数、CNG SHA-256。所有记录仍由当前 Windows 用户的 Credential Manager 原生安全存储持有；不是明文 AppData 文件。

- `vault_records.rs` 是生产同用的事务核心，`vault_windows.rs` 仅系统 FFI 适配。写入先检查读时捕获的 manifest/legacy baseline，跨进程、跨登录 session 的 `Global` SID 命名 mutex 锁住验证、stage、commit、cleanup；mutex 新建 DACL 只允许当前 SID 与 SYSTEM，权限/超时失败不降为 Local 或无锁。另一 writer 已改变 baseline 时 conflict，不能用 stale 内存覆盖。
- 每代全新随机 key；stage 所有块并逐块读回，最后只替换单 manifest。manifest 无引用的 orphan 永不被选作 authority；缺块、顺序/大小/摘要不符、坏 manifest 都报错，不回退旧 legacy 冒充成功。原 native v1 record 仅在没有 v2 manifest 时读取；迁移成功确认后才删除 legacy。
- manifest 写返回后必须读回：若仍是 prior，清 staged 并报告普通失败、保 prior state/lease/stream；若确认为完整 candidate（即使 API 返回错误），以 authoritative readback 判成功；无法确定或数据损坏则 `secure_store_commit_unknown`，保留候选/旧记录，不盲目回滚或 GC。actor 对 unknown/conflict 撤销 runtime authority、HTTP/SSE/resources 与 appearance generation，拒绝继续用旧凭据；需在后续新进程恢复核验，不是空连接成功。
- GC 只在确认 commit 后删除旧 generation；stage 清理失败不破坏 prior。下一次写之前必须完成有界私有 namespace prune，枚举超过 256 条或含不认识的名称会拒绝继续添加，避免失败累积无限 orphan。不是全局 Credential Manager 扫描，也不删除其它应用记录。
- 非 Windows 合成 tests 覆盖 0/2560/2561/65536/65537、chunk/manifest 失败、write-error-after-commit、unknown、缺块/损坏、legacy 迁移、stale writer 与 actor quarantine；不代表系统 CredWrite 崩溃原子性、CNG/DACL/mutex 已在 Windows 验证。

未采用的 DPAPI 路线与剩余系统风险：

1. **DPAPI + 用户 AppData 密文文件**：`CryptProtectData`/`CryptUnprotectData` 使用当前用户 scope、`CRYPTPROTECT_UI_FORBIDDEN`、NULL prompt，绝不使用 `CRYPTPROTECT_LOCAL_MACHINE`。输出用 `LocalFree` 释放；不把固定 entropy 当额外密钥。先在内存加密，再写同目录新建密文文件，检查有界密文/解密结果与版本、完整写入、`FlushFileBuffers`，再提交。根目录用 Known Folder API，不信任环境变量拼出的任意路径；目录/文件需受保护 DACL、SID/owner 校验、拒绝 reparse point/不安全链接和网络路径，避免路径检查后的 TOCTOU；跨进程独占锁保护整个 read-modify-commit。
2. **不能把一次 ReplaceFileW 当完整事务**：官方文档明确 1176/1177 时文件名可能已改变，`REPLACEFILE_WRITE_THROUGH` 不受支持。文件方案还需要同卷、受保护的 backup/journal、逐状态恢复和崩溃重启核验。本轮没有采用该文件提交路径；unknown/quarantine 已接入 actor，不能普通 Err 后继续用旧 authority。
3. **Credential Manager 分块 + 单 manifest**：每代使用全新随机 generation 的不可变块，单块 <=2560，写全并读回核验后，只更新一个有界 manifest record（版本、generation、总长、块数/摘要）；未引用块永不被当成已提交。只有 manifest 确认成功后才 GC，旧 generation 留到恢复完成；缺块/顺序错/混代必须失败。跨进程锁仍必需，单条 CredWrite 的异常/崩溃提交语义需 Windows 实测，不能推断多 record 原子性。也可用 DPAPI 不可变密文文件 + Credential Manager 小 manifest，减少文件 rename 恢复面，但仍需 ACL 和提交未知处理。

Windows 待验收：真实 64 KiB、32 Host/长 token、CNG、SID/DACL、锁争用/abandoned、记录数上限、进程在每个 stage/manifest/GC 阶段崩溃、系统写/读回结果未知、错误用户与迁移。所有平台实测必须使用专属 synthetic record，不读取真实用户记录。Windows 安全存储源码已实现，跨平台算法 tests 通过，**Windows 系统能力仍未验收，不能宣称全量兼容完成**。

官方依据：[DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)、[ReplaceFileW 的失败状态](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)、[CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)。

## 独立 synthetic-only AppKit smoke

`examples/synthetic_smoke.rs` 复用生产 bridge/AppView；只注入固定内存 Vault 与无 socket 的 fixture Network，未知 route 返回 501，不变成空成功。不调用 `bridge::install`/`NativeVault`；同时剥离 JS 的网络、文件、process、openUrl、speech/picker/clipboard 权限。Bundle.app_id 与 data_dir 都使用隔离 namespace/全新目录，关闭磁盘缓存，不读取生产 NSH Storage。生产 binary 没有 smoke/auth bypass 参数。

```sh
# 先生成 source patch 配置（或不指定 --config 使用 crates.io 精确 0.4.0）。
NSH_SOURCE_DIR=/path/to/nsh node packages/nsh/scripts/build-desktop.mjs --check-host
~/.cargo/bin/cargo --config packages/nsh/.nsh/desktop/cargo-source-patch.toml build \
  --manifest-path packages/nsh/desktop-host/Cargo.toml \
  --target-dir packages/nsh/.nsh/desktop-target --example synthetic_smoke
```

后续主线程通过已有 tmux session/window upsert 启动，勿重复开同意图窗口；`SMOKE_DIR` 应为已存在的专属临时目录，PNG/state 子路径必须尚不存在：

```sh
tmux new-window -d -t yuri-native-smoke -n appkit-screenshot \
  "exec packages/nsh/.nsh/desktop-target/debug/examples/synthetic_smoke --bundle packages/nsh/.nsh/desktop/YuriNative.app/Contents/Resources/nsh/bundle.js --screenshot $SMOKE_DIR/appkit.png > $SMOKE_DIR/appkit.log 2>&1"
tmux new-window -d -t yuri-native-smoke -n close-admission \
  "exec packages/nsh/.nsh/desktop-target/debug/examples/synthetic_smoke --close-admission $SMOKE_DIR/new-close-state > $SMOKE_DIR/close.log 2>&1"
```

App screenshot 模式加载真实本地 App bundle，使用与上游 native test agent 相同的 OS 激活请求，等待真实 native appearance apply 后再 pump 一秒、主线程 NSView bitmap→PNG、自动退出，15 秒没应用则失败并写独立 `*.timeout.png` 诊断快照；不是 JS 假 ACK。若系统拒绝前台激活（例如屏幕锁定），TS 的真实 foreground gate 不会发起 Host 读取，不能伪造生命周期绕过。该缓存截图不处理 NSH 私有 shader/masked layer 合成，不能据此验收材质、阴影/遮罩或完整视觉 parity。关闭模式不加载生产 App，先用 synthetic JS Engine/HostChannel 调用真实 AppKit appearance reset/apply、认证 stat/read 与 lease cleanup，再验证真实 `performClose` → invalid/false/duplicate → 保留 → `terminate:` → stale 拒绝 → 当前 ticket true → 原生 loop 退出。无 engine/超时场景另由纯状态机测试覆盖，不能把这些当作真实 dirty 文件保存验收。

## 安全与生命周期

- HostChannel 回调仅 `take_data`／`into_reply`／有界 `try_send`；安全存储、JSON 和网络不阻塞引擎线程。一个 actor 串行拥有连接 authority；最多 8 个 HTTP job、global/chat 加 4 个 panel SSE、64 条待处理消息。队列溢出会拒绝／断流重连，不把缺失数据报成完整成功。
- 复用公开 `nsh_engine::net::network()` / `Network::fetch` / `FetchTask`，没有新增 reqwest、tokio 或 npm 依赖。`nsh_core::element::fetch/spawn` 依赖活跃 component owner，不适合在 embedding handler 中当任意后台 executor 使用。
- HTTPS 默认强制开启，采用 NSH rustls/webpki 根证书验证。只有显式 `NSH_ALLOW_HTTP_LOOPBACK=1` 才允许精确 localhost / 127.0.0.1 / [::1] 的 HTTP 开发连接，不开放普通 LAN 明文 HTTP。不提供忽略证书选项。
- origin 无路径、userinfo、query 或 fragment；API 路径校验拒绝跨 origin、重编码、dot segment、反斜杠及 auth 路由旁路。调用者不能传自定义 headers，不能通过 query 传已知 token/password/secret 参数。
- Authorization 只由 Rust 注入 header，兑换得到的 clientToken 不返回 JS；公开 snapshot／事件中没有 token。网络错误只返回稳定错误码，不转发可能含 URL 的底层错误文本。
- `follow_redirects=false`，3xx 与最终 URL 不匹配都失败，不把 bearer 转交重定向目标；没有 cookie 会话 fallback。
- 请求和 HTTP 响应最多 32 MiB，Content-Length 与实际累积双重检查，HTTP job 30 秒逻辑超时。SSE 单行／单事件上限 2,000,000 字节，跨块 UTF-8、CR/LF、multiline data 保持 iOS 协议。失败指数退避，永久 4xx 等 60 秒；数据事件到达才复位失败计数。
- macOS 用 Security.framework 原生 Keychain generic-password FFI；Windows 用 Credential Manager 分块/manifest、BCrypt RNG 与 SHA-256。没有明文 Storage、文件、环境变量 token 或命令行 token fallback。确定未提交的写失败保 prior；提交未知明确隔离，不能继续假定 prior 仍是 authority。
- 两平台输入安全记录上限 64 KiB；Windows 单块仍遵守系统 2560 上限。Keychain 开发签名变化／锁定可触发 OS 授权或写入失败，未绕过系统保护。
- lease 用系统 CSPRNG 生成，不持久化，冷启动与显式成功连接转换重新签发。GET 可沿用现有无绑定只读语义；非 GET 与 stream 必须携带 exact scope；派发、网络事件、最终提交都检查旧 generation/attempt，迟到响应不能写回新 Host。
- runner 当前按单个独立应用进程拥有连接状态；编辑使用进程内 version CAS，跨进程 stale writer 由 Vault baseline conflict 拒绝并 quarantine，不提供自动合并／热同步协议。没有移植 iOS UIApplication foreground admission；最小化不轮换 lease，窗口退出由进程/owner 结束所有逻辑 job。不能宣称已实现系统休眠／唤醒／断网完整恢复。
- **NSH 0.4 网络层限制**：`FetchTask::cancel` 停止后续回调，但不能立刻中断已阻塞的系统读取。旧结果已被 ticket/lease fence 丢弃；不声称物理 socket 已即时关闭或底层残留请求线程有全局硬上限。

## 验证证据

`src/tests.rs` 使用注入的合成内存 Vault；不读取或修改真实用户 Keychain/Credential Manager。覆盖原子写失败保 prior、scope 必填/过期、旧 stop、新连接取消旧请求、坏安全记录、路径/HTTPS、响应大小/content-type、SSE 分块。

其中垂直集成测试启动真实 NSH Engine／HostChannel／QuickJS，调用生产 bridge 与真实 NSH Network，在短生命周期 loopback fixture 上验证 connect → JSON read/write → 拒绝 302 → SSE → select lease → stale reject → remove。fixture 只接受合成 bearer；重定向目标零连接，不是 `host.available` mock。

以下分阶段证据均为历史快照（macOS arm64），保留当时数字、失败及准入状态；其中“未安装 factory / Main 尚未接 writer / 无 SSH grant / 无可用 CLI”等不再代表当前源码。当前入口事实见上方实现边界，本次实际重跑见最后的验证段；不沿用历史 tsc、bundle 或物理 AppKit 结果冒充本次验证。

- crates.io NSH 0.4.0：`cargo check` 通过。
- 上轮的“45/46”是两个 target 的全通过计数，不是通过率：binary **45 passed / 0 failed**，example **46 passed / 0 failed**；唯一额外测试是 `smoke::tests::fixed_resources_and_unknown_routes_never_become_empty_success`，不存在待修的第 46 项失败。
- 编辑器／documents 为 81／82 项、WS-v2 为 86／87、诊断为 99／100；加入 file journal 后完整 scoped 运行：binary **117 passed / 0 failed / 0 ignored**、example **118 passed / 0 failed / 0 ignored**。两 target 共享 117 项，不重复计算覆盖。journal 独立 example 本线程另跑 **17 passed / 0 failed / 0 ignored**；其 child lock probe 不重复算覆盖。三个需要 fixture 的测试通过 `NSH_TERMINAL_CORE_BUNDLE=…`、`NSH_FILE_JOURNAL_FIXTURE=…`＋`--include-ignored` 实际执行。第一轮缺 journal fixture 环境变量时 binary 为 116 passed / 1 failed、独立 example 为 16 passed / 1 failed；构建真实 `desktop-files-storage-fixture.ts`（Bun browser bundle，external nsh）后完整重跑通过，未改成 skip／放松断言。此计数不包含随后通知准备工作。
- `connection_editor_tests.rs` 覆盖 legacy/no-op、exact schema／URL／label、metadata CAS、稳定错误、存储失败／quarantine、selected／历史项重新授权与密码／最终 probe 的并发编辑。真实 QuickJS＋NSH Network loopback 验证密码兑换不带旧 bearer、新 token native probe、in-flight rename 获胜与凭据不出 Rust。另有真实 HostChannel 的 documents 生产安装／metadata 保 pending／切 lease 拒绝旧 scope／shutdown drop 合同；不调用 SaveDialog、不读用户文件。
- `--debug` 完整构建：Rust runner、真实 `App.tsx` bundle 与产品 assets 已打包；`file` 确认 arm64 Mach-O，`codesign --verify --deep --strict` 通过。未启动该应用读取用户连接。
- 上条是前轮完整打包证据；本轮已重新 `cargo build --bin yuri-nsh-desktop --example synthetic_smoke` 验证 Mac Rust 链接，最终 `desktop:test`／完整 App bundle 打包由主线程统一执行，没有启动新窗口或系统 dialog。
- 最终 scoped `cargo clippy --bin yuri-nsh-desktop --example synthetic_smoke -- -D warnings`（`--config` 放在 clippy 后，确保传递给该子命令）与脚本 `node --check` 通过。
- 上条 Clippy 已在 file journal 集成后连同 `--tests` 重跑通过。诊断同源码 duplicate-mod／非 test Driver lint 初次失败已交回 owning Agent scoped 修复，本线程未改诊断实现。诊断独立 example **19 passed / 0 failed / 0 ignored**、两项 TS 文件 **15 passed**已由本线程重跑；不是系统 chooser 验证。
- `node packages/nsh/desktop-host/fixtures/check-windows-vault.mjs` 用已构建 serde_json rlib 对**实际** `vault_windows.rs`／事务源码做 rustc metadata-only 类型检查，包含 Store 的 Send 边界；`vault_windows_abi.rs` 测试实际使用的 CREDENTIALW/SECURITY_ATTRIBUTES/TOKEN_USER 大小和偏移。没有创建假 Windows runtime，也没有链接/调用 Windows DLL；这不替代 Windows target 编译，不检查 Windows UI 模块的所有类型或 SDK 符号。
- `NSH_SOURCE_DIR=/path/to/nsh node packages/nsh/desktop-host/fixtures/check-windows-ui.mjs` 对实际 `native_ui_windows.rs`＋`browser_view_windows.rs` 与 Windows-selected browser core 执行 `-D warnings` metadata frontend 检查；使用**真实 Darwin std**及审计后的 NSH/Win32 签名 stand-ins，静态检查 LOGFONTW/NONCLIENTMETRICSW/MSG 布局。只在忽略的 target 目录选择 browser cfg，不修改 browser 实现。组合检查发现的 `SetTimer` nullable callback 声明冲突已与 browser Agent 协调修复。没有安装 target、依赖或伪造 std；**不验证真实 Windows crate／SDK／链接符号／COM／runtime**，terminal/附件的 Windows 实现也不包含在此 UI harness 内。
- `synthetic_smoke --close-admission` 已在 tmux 实际运行并 exit 0：真实 AppKit appearance reset/apply（含系统字体查询与 token/fontScale API）、认证文本 stat/read/lease cleanup 均通过；真实 `performClose` 被拒绝、false 后保留、invalid/duplicate/stale decision 被拒绝，随后 `terminate:` 的新 ticket true 使 native loop 退出。只跑 synthetic JS，不读取用户凭据；这仍不证明生产 App 的逐帧字体效果。
- 完整 App 的 synthetic screenshot **受锁屏环境阻塞，未验收**：真实 App 已渲染；标准 AppKit loop 的 `running=true`，系统 `active=false / visible=false`，fixture 请求数为零，等待 native appearance apply 超时退出（exit 1）。主线程随后确认 `locked=1`；不解锁、不绕过 foreground gate、不把该超时当作产品验收通过。只保存 `*.timeout.png` 诊断快照，需允许窗口前台的图形会话重跑。
- `bun run dead-code` 已尝试，但仓库既有 `packages/web/vite.config.ts` 缺少 `vite-plugin-pwa`，检查未能完成；未安装依赖规避。
- debug 链接器报告 `__eh_frame` 大于 16 MiB 的 compact-unwind 警告；构建成功，不等于 release 性能已验收。

### 通知／持久 consent／panel stream 前轮聚合

- 该阶段 source 的完整 scoped binary **181 passed / 0 failed / 0 ignored**、synthetic example **181 passed / 0 failed / 0 ignored**。携 `NSH_TERMINAL_CORE_BUNDLE` 与 `NSH_FILE_JOURNAL_FIXTURE`，使用 `--include-ignored` 实际执行；子进程 lock probe 的单项日志不重复计数。两个 target 的额外项不同（runner args／smoke），相同总数不表示完全同一测试集合；不相加声称 362 个独立覆盖。
- `notification_host_contract` **42/0/0**，包含真实 Windows driver／installer identity／private directory 源码的 frontend 和纯 ABI／ACL-policy 测试；没有调用 Windows API。`diagnostics_contract` **29/0/0**、`file_journal_contract` **17/0/0**。并行 documents owner 的 Stage 测试也进入本次共享源码集合，计数不沿用早期 162／24 推测。
- `native_preferences` 两项均通过，含真实临时私有磁盘 cold restore／保存 false／corrupt 读取拒绝；Host 通知生产七项及安装期间 shutdown 回归通过。新增 panel stream **6/0/0**，包含实际 HostChannel／QuickJS 的 key/lease 事件和隔离清理。全部使用合成 Vault／driver／Network 或专用临时文件，无真实 Host／PTY／用户凭据／系统通知／dialog。
- 最终 scoped `cargo clippy` 对 binary、synthetic、notification host、diagnostics examples 和 `--tests -- -D warnings` 通过；`cargo build --bin yuri-nsh-desktop --example synthetic_smoke` 的 Mac 编译／链接通过，仍有上述 unwind 警告。未启动应用；完整产品打包由主线程统一负责。
- installer／diagnostics 三个 focused Vitest 文件 **17 passed**；两个构建／installer MJS 的 `node --check` 通过。本次整包 `tsc` **未通过**：并行生产装配中的 `desktop-panel-tabs-renderers.ts:29` 尚未把 chat tab 的 `{target}` 适配到旧 `DesktopPanelContentRequest` 的 `sessionID/readOnly`；Host 线程未改该 owning 文件，不将之前通过的 tsc 当成本轮结果。
- Windows UI／Vault／WinHTTP 三个 metadata frontend checks 均重跑通过；Windows target 确实重试，但 offline 缺 `byteorder-lite v0.1.0` 失败，仍没有 target／SDK／链接／COM／DACL／toast／cold activation／PowerShell 安装器执行证据。`bun run dead-code` 重跑仍因既有 `vite-plugin-pwa` 缺失失败，未安装依赖或工具链规避。

### 原 actor SSH／下载／tabs／HTTP 接桥前聚合

- 完整 binary **240 passed / 0 failed / 0 ignored**、synthetic example **240 passed / 0 failed / 0 ignored**。显式携 `NSH_TERMINAL_CORE_BUNDLE`、`NSH_FILE_JOURNAL_FIXTURE`、`NSH_FILE_DOWNLOAD_FIXTURE` 和 `--include-ignored` 执行所有 fixture 项；两个 target 有大量共享测试，不相加当独立覆盖。HTTP focused **5/0/0**，SSH 原 actor **7/0/0**；production tabs publication 回归也在其中。最初 tab 测试误在 Rust test worker 调 macOS main-thread register 导致失败，已改为已有纯 Registration 来核验 services publication，不绕过生产 main-thread guard，不声称该测试创建了原生组件或 observer。
- 独立 examples：notification host **42/0/0**、diagnostics **29/0/0**、file journal **17/0/0**、file download **30/0/0**、desktop tab **11/0/0**、typed actor port **2/0/0**、HTTP receipts **16/0/0**。`check-ssh.mjs` 独立 **40/0/0**，仅合成 transport／临时 HOME 系统 I/O，不是生产服务安装或真实 SSH。
- `cargo clippy --all-targets -- -D warnings` 通过；Mac binary 与 synthetic example `cargo build` 编译／链接通过，仍有既有 `__eh_frame` 警告。没有启动 App、notification、chooser、真实 SSH／Host／PTY／模型，也没有读取用户配置／凭据；完整产品打包仍由主线程统一执行。
- Windows UI frontend 已纳入实际 `desktop_tab_windows.rs`；与 Vault、WinHTTP frontend 本轮重跑均通过，仍仅 Darwin metadata／审计 signature stand-ins，不替代 Windows target／SDK／DLL／OS。
- 四个 focused TS 文件（installer、desktop diagnostics、About diagnostics、downloads）**27 passed**，三个相关 MJS syntax checks 通过。本轮整包 `tsc` 未通过：并行 owner 的 `desktop-sidebar.tsx:401` 向 `SubmenuProps` 传不存在的 `popupClass`；Host 线程未改该 owning 文件。`bun run dead-code` 再次因 Web 缺 `vite-plugin-pwa` 在配置加载时失败，输出过 Saved lockfile；未安装依赖绕过或手工丢弃其它 worktree 修改。

### SSH 生产桥／panel capability grant 上一轮聚合

- 最新完整 binary **290 passed / 0 failed / 0 ignored**、synthetic example **290 passed / 0 failed / 0 ignored**。除 terminal/journal/download 三个 bundle fixture，另显式提供专属临时 `NSH_SSH_IO_FIXTURE_ROOT` 和 `NSH_SSH_IO_NODE`，14 个 owning SSH I/O 测试仅在该临时 HOME 运行固定程序；自建根已在测试清理后移除。初次未传这两项的聚合为 275 passed / 14 failed，补齐后完整重跑，不改 skip／不放松断言。
- Host bridge 四项与 panel stream 六项均纳入聚合；panel 六项也单独重跑 **6/0/0**。`nsh.json` 只新增已批准的 `runtime.stream.capabilities`，JSON／唯一精确 grant 校验通过。没有同时授予 SSH、下载或可取消 HTTP；它们的 root consumer／manifest 准入仍须分别交接，不因代码存在默认启用。
- 全 target Clippy `-D warnings` 与 Mac binary／synthetic 编译链接通过。SSH owner 自行修复其 scoped lint／共享 hash duplicate-mod 边界，本线程未编辑 `ssh*.rs`。实际 Windows UI/browser/tabs metadata frontend 通过，仍非 Windows target／SDK／OS 验收；Mac link 保留既有 `__eh_frame` 警告。
- 最新整包 tsc 已通过；`bun run dead-code` 仍因 Web 缺 `vite-plugin-pwa` 在配置加载时失败，未安装依赖绕过。`bun run --cwd packages/nsh nsh:check` 本次因 PATH 无 `nsh`（ENOENT）未完成；没有安装或重建上游 CLI，manifest 静态校验不代替该命令。
- 未运行真实 UI、通知、chooser、OpenSSH、用户 shell、Host／PTY／模型或系统凭据读取；没有产品整体 SSH available／sync 成功声明。完整 App 打包、TS 新 stream adapter 的根消费和真实平台效果仍由对应 owning slice 验证。

### Sensitive raw HTTP seam／BTW grant 历史聚合

- 最新 binary **309 passed / 0 failed / 0 ignored**、synthetic example **309 passed / 0 failed / 0 ignored**；携全部既有 bundle fixtures、专属 SSH IO 临时 HOME 根与显式 Node，`--include-ignored` 实际执行。新 raw actor focused **6/0/0**、pure typed Port **2/0/0**；并行 owner 的 test-only sensitive adapter 也进入聚合，不把两个 target 的共享覆盖相加。
- 原 actor 保持单一 Vault／Network／64 槽 mailbox，raw 与普通 HTTP 共享 8 jobs，但 raw 单独限制 2 个 queued+running permit。通过真实原 queue 的 Busy、固定六 route/认证/bytes、切主 Host、exact receipt/new authorization、取消/timeout/retire/坏回执/late End/no replay 和 sealed local grant 缺失测试；没有真实敏感数据／本机服务发现／SSH 运行／Host／模型。
- 全 target Clippy `-D warnings`、Mac binary/synthetic 编译链接、整包 tsc 均通过；仍有既有 unwind linker 警告。`bun run dead-code` 再次因既有 Web `vite-plugin-pwa` 缺失而在配置加载时失败，未安装依赖、未把失败说成零 unused。
- 按 main 的精确请求，`nsh.json` 新增且仅各一条 `runtime.http.capabilities/request/cancel`；此前 `runtime.stream.capabilities` 保留。JSON／四个 exact grants／无产品 SSH grant 校验通过。iOS 未注册这些 HTTP 方法时继续由 loader 判断 unsupported；本线程未修改 application、TS、tabs、窗口恢复 owner 或其 runner 装配。
- 这里冻结并交付的是原 actor 的 Rust-only remote sensitive transport；本机 `LocalServiceGrant` producer 和完整 sync coordinator 仍缺，不能称 production sync available。window restore/multiwindow 仍需对应 owner 与 runner 入口另行装配，不从其底层文件或这批测试推断已接入。

### Window kernel／download v2 grants 上一轮聚合

- 最新 binary **334 passed / 0 failed / 0 ignored**、synthetic example **334 passed / 0 failed / 0 ignored**，携原 bundle、journal/download fixtures、专属临时 SSH IO 根和显式 Node，实际执行 `--include-ignored`。两个 target 的共享覆盖不相加。root 同时编译并聚合窗口 worker 的冻结 state/geometry 测试，没有修改其独占文件。
- kernel 四项真实双 Engine/HostChannel 准入与隔离、native spec 三项（含两个 Engine 读实际 descriptor）、真实产品 capability policy 的 download v2/actor shutdown 回归均通过。download owner 后续补入实际 chooser 时刻的 OS gate 合成测试也进入同一聚合；全部测试都未执行系统 chooser/真实窗口。
- 全 target Clippy `-D warnings`、Mac binary/双窗 synthetic harness 构建、整包 tsc、Windows UI/browser/tabs metadata frontend 通过；已有 `__eh_frame` linker 警告保留。frontend 使用 Darwin std 与审计过的 Win32 签名 stand-in，不是 Windows target/SDK/link/实机。
- 四个既有 runtime grants + 五个 download v2 grants 均在产品 manifest 中恰好一条，JSON 和文档相对链接检查通过；SSH 未提前授权。`bun run dead-code` 仍被既有 Web 配置缺少 `vite-plugin-pwa` 阻断，命令输出过 Saved lockfile，未安装依赖或丢弃别人锁文件修改。
- 当前可消费边界只有 native `windowKey/windowKind:'main'`、已有本窗 SDK 操作，以及真实 HWND/NSWindow catalog/逐窗生命周期。产品第二个可写 runtime、MiniChat/跨窗 Host API、session writer 互斥、唯一 window-state persistence worker/安全 grant/geometry/显式 close+quit flush 仍未完成，见 [WINDOW-KERNEL.md](./WINDOW-KERNEL.md)。锁屏下没有运行双 AppView harness 或验证 Dock reopen，不把合成 Engine 测试称作物理窗口验收。

### SSH dispatcher stop-result 上一轮聚合

- 修正 owning callback 的消费：`on_stopped(Err)` 不再被忽略为成功关闭；保留错误和原 actor cleanup lane，只有 Ok 放行退出。不修改 `ssh_service.rs`、SSH owner 或其 frozen API。
- focused 原 actor→dispatcher→synthetic Driver→原 Vault/Network/HostChannel **5/5**；增强 startup CommitUnknown 并新增已派发 Vault write CommitUnknown 的 unresolved barrier 回归。两条失败路径都确认未释放原 actor，测试最后仅清理私有合成 worker，不提供生产强制解锁。
- 携完整 fixtures 的 binary **335/0/0**、synthetic example **335/0/0**，`--include-ignored`；全 target Clippy `-D warnings`、Mac binary/example 构建通过，既有 unwind linker 警告保留。dead-code 再次被既有 `vite-plugin-pwa` 缺失阻断，无依赖安装。未运行真实 SSH/用户配置/Vault/UI，未将 Windows frontend 当作 OS 验证，未新增 SSH/Files/sync grant。

### Shared process lane／window-state 安装／产品 SSH grants 上一轮聚合

- binary **358/0/0**、synthetic example **358/0/0**，携全部原 bundle/journal/download/SSH IO fixtures 与 `--include-ignored`；不相加。共享 process focused **8 项**：两个真实 Engine、唯一 synthetic Vault 对象、分别 synthetic runtime POST/本窗 bearer、窗口 select/restore/lease 独立、共享 metadata 合并、已知失败/peer removal、外部 baseline 冲突/Unknown、HTTP receipt/迟到事件隔离、同 key 重开拒绝复用旧 Channel、单例 SSH 与失败 stop 屏障。native constructor只做编译，未调用真实 credential discovery。
- 唯一 window-state worker与同次 path+Store grant、真实 owner-only 临时磁盘、完整恢复/失败保 prior、10000 trailing capture 合并、Unknown 零重放、Drop 零写、双 Engine final capture/flush/authority epoch/timeout 与 remaining catalog 均纳入聚合；Mac/Win sampler 和 beforeShow 已接。原 actor 的 services admission fence 与真实 join（含 Vault destructor）另有回归，不以“发出 stop”推断已释放 writer。
- `nsh.json` 已补六个 exact SSH connection-only grants，真实 policy/HostChannel/service/原 actor/synthetic Driver 垂直通过，download v2 五 grants 回归保留。没有 Files/sync grant；旧 bundle 仍须重新生成 capabilities，未运行 NSH CLI 或启动产品。
- 全 target Clippy `-D warnings`、Mac binary/example build 通过，既有 unwind linker 警告保留。实际 Windows UI/browser/tab/geometry adapter 的 metadata frontend 通过，geometry ABI/clamp example **5/5**；它们仅 Darwin std/审计 stand-ins，不是 Windows target/SDK/DLL/OS 验证，新的 process 也未在 Windows target 编译。
- `bun run dead-code` 仍被既有 Web 配置缺少 `vite-plugin-pwa` 阻断，输出 Saved lockfile，未安装依赖、未回退任何锁文件。Context7 查询配额耗尽，沿用 exact 本地 NSH 0.4.0 source；本轮未改 TS SSH/main application，也未把历史 tsc 结果当作本轮新验证。
- **该历史阶段尚未完成的安装项**：当时 Process API 已有真实可写 runtime contexts，但未切产品 factory，仍只有 legacy primary；安全 journal/catalog stable-key grant、native target writer 与 Process 退出屏障随后已安装，不能再把此段当作当前缺项。create/MiniChat/focusMain producer 与全局设备偏好 CAS/changed lane 仍未开放。完整当前接口与剩余边界见 [WINDOW-KERNEL.md](./WINDOW-KERNEL.md)。

### Process 生产安装／native target writer 历史聚合

- 产品已从 legacy bridge 切为唯一 `Process::native`、一次 SSH install 和共用 `window_factory::open/install_stores`。首个 primary 即 multi-engine；未改 TS main/SSH/其他 worker。Mac/Win 正常退出接同一 `ExitBarrier`/真实 Process join，Mac last-close 不销毁 Process；SSH stop Err 不退出。journal 补真实磁盘 worker join，terminal owner 退休释放独占 catalog Store，不被旧 handler 持续占锁。
- stable-key journal/安全事务 terminal catalog 已安装，primary 保原目录/文件且不复制；peer 采用域分隔 SHA256 namespace。产品不再使用 terminal 裸路径写入。该阶段 native writer 为三个 exact grants/handlers（随后 renew 增至四项），held record 走原 Vault lane；protected mutation 强制 `writerGrant`，native执行前拒绝 peer/漏 grant/旧 epoch，read-only GET 不取 writer。支持 session、assistant 和与真实 create body 匹配的 new-session Host directory grant；无关 mutation RPC fail-closed。
- native pending/unknown 独立 veto TS 全体 close/Quit 同意票，窗口仍 live；clean final-close 在原 lane 移除本窗 grants 后才能停止；异常 destroy/Unknown/crash 不自动释放或重放，cold receipt 缺失返回 recovery_required。完整 JSON/2xx 的 native完成不冒充 TS domain ACK；TS unknown/dirty guard仍必需。无 recovery resolver/强解锁。
- 最新 binary **368/0/0**、synthetic example **368/0/0**，含全部 bundle/journal/download/SSH IO fixtures 与 `--include-ignored`，不相加。Process 聚焦 **14 项**中包含真实产品 manifest（只追加测试输出权限）、同一生产 factory、两个真实 QuickJS Engine、临时用户目录的原 native grant/真实磁盘隔离与 cold restore、两种 HTTP/native writer/encoded ID/新会话目录/unknown crash，以及真实 exit receipt；另有 native close-veto、route alias、pending/unknown cleanup 零 I/O、catalog unknown 零重放回归。不执行物理 UI。
- 全 target Clippy `-D warnings`、Mac binary/example build 通过；保留既有 `__eh_frame` linker 警告。Windows UI/browser/tab/geometry frontend 和 geometry ABI example **5/5** 通过，只是 Darwin metadata/审计 stand-ins，不是 Windows target/SDK/link/DLL/OS 证据。
- `bun run dead-code` 仍因既有缺失 `vite-plugin-pwa` 退出2，并输出 Saved lockfile；未装依赖、未回退锁文件。Context7 配额仍耗尽；按固定 NSH 0.4.0 本地公开源码实现，未改上游/运行 Git/发布或读取真实凭据、SSH、Host/模型/chooser。未重新生成产品 bundle/capabilities。
- **该阶段的 Main 接线缺口已过时**：当时尚须接 writer owner + transport grant；当前 root、正式 Chat、新会话及 Changes guard 已接线，见上方实现边界。仍不能称完整 PC/生产多窗完成：assistant backing-session alias 没有权威原子映射，通知 receipt/diagnostics 全局 store 尚未 process-singleton 化，Storage runner/完整多窗冷恢复仍保守阻断。产品只开一个 primary，create/MiniChat/focusMain 无 producer/grant；不因 native 核心测试通过就移除这些 gate。见 [WINDOW-KERNEL.md](./WINDOW-KERNEL.md)。

### 2026-11-08 Host 隔离重跑（历史 377）

**本段是新增 Assistant 附件交付前的历史 377 基线，不替晚到附件能力背书。** 以下保留当时实际工具输出：只读固定本地 NSH **0.4.0 / e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3**，使用 `build-desktop.mjs` 生成的既有 source-patch 配置，所有 Cargo 操作均 `--offline --locked`。构建仅写忽略的 `.nsh/`；terminal bundle、journal/download TS fixture、SSH IO 根及日志均在新建的 OS 批准私有临时目录。没有修改上游、产品源码、manifest 或 lockfile。

| 本次命令/target | 实际结果 |
| --- | --- |
| `cargo test … --bin yuri-nsh-desktop -- --include-ignored --test-threads=1` | **377 passed / 0 failed / 0 ignored / 0 filtered** |
| `cargo test … --example synthetic_smoke -- --include-ignored --test-threads=1` | **377 passed / 0 failed / 0 ignored / 0 filtered** |
| `cargo clippy … --all-targets -- -D warnings` | 通过，exit 0 |
| `cargo build … --bin yuri-nsh-desktop --example synthetic_smoke` | Mac 编译/链接通过；保留既有 `__eh_frame` 超过 16 MiB 的 compact-unwind warning |
| `node …/check-windows-vault.mjs`、`check-windows-ui.mjs`、`check-windows-terminal-socket.mjs` | 三项均通过，exit 0 |
| `cargo test … --example window_geometry_windows_typecheck -- --include-ignored --test-threads=1` | **5 passed / 0 failed / 0 ignored** |

两个聚合 target 不相加为独立覆盖；child lock probe 的单项子进程结果也不重复计数。本次明确执行原先需要环境的全部 **5 项**：terminal core 的正常/unknown create 两项、journal 的真实 QuickJS+disk 冷未知只读恢复一项、download 的 resume/unknown status 两项。每个 target 的 **14 项 SSH IO** 与 **5 项 OpenInApps** 回归也均通过；SSH fixture 仅调用显式 Node 固定程序、使用专属临时 HOME，OpenInApps 仅用合成 discover，不扫描/打开真实系统应用。

复跑须先按 [`desktop-terminal-host.test.ts`](../desktop-terminal-host.test.ts) 用精确 CLI 构建独立 terminal bundle；用 `bun build --target=browser --format=esm --external=nsh --external='nsh/*'` 分别构建 [`desktop-files-storage-fixture.ts`](../desktop-files-storage-fixture.ts) 与 [`desktop-files-download-fixture.ts`](../desktop-files-download-fixture.ts)。全部输出只放专属 fixture 根；以下共享参数对应本次实际命令：

```sh
# FIXTURE_ROOT 是新建的私有临时目录；三个 fixture 已按上述方式构建。
export NSH_TERMINAL_CORE_BUNDLE="$FIXTURE_ROOT/terminal/bundle/bundle.js"
export NSH_FILE_JOURNAL_FIXTURE="$FIXTURE_ROOT/journal.js"
export NSH_FILE_DOWNLOAD_FIXTURE="$FIXTURE_ROOT/download.js"
export NSH_SSH_IO_FIXTURE_ROOT="$FIXTURE_ROOT/ssh-io" # 先建立空的私有目录
export NSH_SSH_IO_NODE="$(node -p 'process.execPath')"
export TMPDIR="$FIXTURE_ROOT"
HOST_ARGS=(--config packages/nsh/.nsh/desktop/cargo-source-patch.toml
  --offline --locked --manifest-path packages/nsh/desktop-host/Cargo.toml
  --target-dir packages/nsh/.nsh/desktop-target)
~/.cargo/bin/cargo test "${HOST_ARGS[@]}" --bin yuri-nsh-desktop -- --include-ignored --test-threads=1
~/.cargo/bin/cargo test "${HOST_ARGS[@]}" --example synthetic_smoke -- --include-ignored --test-threads=1
~/.cargo/bin/cargo clippy "${HOST_ARGS[@]}" --all-targets -- -D warnings
~/.cargo/bin/cargo build "${HOST_ARGS[@]}" --bin yuri-nsh-desktop --example synthetic_smoke
~/.cargo/bin/cargo test "${HOST_ARGS[@]}" --example window_geometry_windows_typecheck -- --include-ignored --test-threads=1
node packages/nsh/desktop-host/fixtures/check-windows-vault.mjs
node packages/nsh/desktop-host/fixtures/check-windows-ui.mjs
node packages/nsh/desktop-host/fixtures/check-windows-terminal-socket.mjs
```

**证据边界不变**：Windows 三项 frontend 和 geometry 只使用 Darwin std/审计签名 stand-ins；不是 Windows target、SDK、DLL 链接或 Windows OS 验证。本次未重试 Windows target、未下载依赖/安装 target、未重建产品 bundle/capabilities、未运行 TS/整包 UI 测试或 dead-code。未启动真实 App/物理 AppKit harness，不与其它窗口验收争用；没有系统 chooser、通知、真实凭据、用户 SSH、Host/PTY/模型操作。Main assistant 实际 root 的并行补验数字未纳入本段；cold held-grant resolver、第二生产窗、完整 Mac/Windows 功能和视觉 1:1 仍未签收。

### 2026-11-08 Assistant 附件后业务 Host 基线重跑

**这是新增 Assistant 附件交付后的实际全 fixture 业务测试，不是兼容补丁系统验收。** Rust 使用已审计原本地 NSH **0.4.0/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3** 与既有 `cargo-source-patch.toml`；terminal fixture 直接用原 0.4.0 CLI 重建，journal/download fixture 从当前 TS 重建。原 CLI SHA-256 为 `cc9676f7d8f763e6903e1b4b1d8f4f21376689e16381a6fe77e68861da106416`，仅标识本次基线二进制，不是 preparation worker 的正式兼容补丁 digest。

所有 Cargo 命令均 `--offline --locked`，串行运行、`--test-threads=1`，使用**新建私有临时根中的独立 target**，不与 preparation 共用 Cargo target；未调用 `scripts/build-desktop.mjs`/`scripts/nsh.mjs`，未请求或轮询 compat preparation 锁。执行前后全部 Host `src/examples` Rust 源文件、Host manifest/lock、产品 `nsh.json` 内容摘要无变化，source-patch 配置与原 CLI 摘要也保持一致。

| 本次命令/target | 实际结果 |
| --- | --- |
| `cargo test … --bin yuri-nsh-desktop -- --include-ignored --test-threads=1` | **384 passed / 0 failed / 0 ignored / 0 filtered** |
| `cargo test … --example synthetic_smoke -- --include-ignored --test-threads=1` | **384 passed / 0 failed / 0 ignored / 0 filtered** |
| `cargo clippy … --all-targets -- -D warnings` | 通过，exit 0 |

逐条核验两份日志：原先 ignored 的 terminal 两项、journal 一项、download 两项全部实际通过；每个 target 的 **14 项 SSH IO**、**5 项 OpenInApps** 也通过。相对历史 377，本次新增并实际执行 **7 项 Assistant 附件回归**：`attachments_tests.rs` 的五项（exact descriptor、坏 receipt/unknown 零重放、partial/late cancel/orphan、共享容量、窄 target/path），以及 `attachments_actor_tests.rs` 的两项（真实 HostChannel/QuickJS→原 actor→合成 Network 的 raw bytes/receipt/取消/换 lease，原 actor 路径/header 拒绝）。它们均包含在 384 中，不另加 owning worker 的 focused 数字，不把两 target 或 child lock probe 相加为独立覆盖。

复跑使用新建私有 `FIXTURE_ROOT`、空的私有 `ssh-io` 目录和上述三种实际构建的 fixture；以下为本次命令的共享环境/参数（不是 preparation 或产品 App 构建入口）：

```sh
export NSH_TERMINAL_CORE_BUNDLE="$FIXTURE_ROOT/terminal/bundle/bundle.js"
export NSH_FILE_JOURNAL_FIXTURE="$FIXTURE_ROOT/journal.js"
export NSH_FILE_DOWNLOAD_FIXTURE="$FIXTURE_ROOT/download.js"
export NSH_SSH_IO_FIXTURE_ROOT="$FIXTURE_ROOT/ssh-io"
export NSH_SSH_IO_NODE="$(node -p 'process.execPath')"
export TMPDIR="$FIXTURE_ROOT" CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=4
BUSINESS_HOST_ARGS=(--config packages/nsh/.nsh/desktop/cargo-source-patch.toml
  --offline --locked --manifest-path packages/nsh/desktop-host/Cargo.toml
  --target-dir "$FIXTURE_ROOT/cargo-target")
~/.cargo/bin/cargo test "${BUSINESS_HOST_ARGS[@]}" --bin yuri-nsh-desktop -- --include-ignored --test-threads=1
~/.cargo/bin/cargo test "${BUSINESS_HOST_ARGS[@]}" --example synthetic_smoke -- --include-ignored --test-threads=1
~/.cargo/bin/cargo clippy "${BUSINESS_HOST_ARGS[@]}" --all-targets -- -D warnings
```

本次只有合成内存 Vault/Network、自建短时 loopback fixtures 与专属临时磁盘；SSH IO 仅通过显式 Node 固定程序使用临时 HOME，不执行用户 SSH。没有真实用户凭据/Vault/网络、系统 chooser、真实 App/物理窗口或模型操作；未修改产品源码、manifest、lock、preparation 文件或其它文档。**没有重跑 Windows metadata frontend/geometry、产品 binary/example 普通 build、产品 bundle/capabilities、TS/整包 UI 或其它独立 examples 的执行**；all-target Clippy 的编译通过不替代这些运行证据。历史 Windows frontend 仍只属 Darwin metadata，不是 SDK/link/OS 验证；compat-patched CLI/devhost/Shift、cold resolver、第二生产窗及完整 Mac/Windows 1:1 功能与视觉验收均不在本轮签收范围。

Windows cfg 后端与原生 FFI **未完成 cross-target 编译、未实测**：历史离线 `cargo check --target x86_64-pc-windows-msvc` 被缺失的 byteorder-lite 缓存阻止，本次没有重试或安装 Rust Windows target、SDK、大工具链绕过限制。macOS 系统 Keychain 交互、新 AppKit UI owner 的实际窗口/字体效果、生产 HTTPS Host、Relay、release 构建、公证与桌面 UI parity 也未验收；本次没有启动应用读取真实连接，后续应使用独立 synthetic Host 做 UI 验收。
