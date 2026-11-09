# 桌面匿名诊断 recorder / SaveDialog

诊断模块拥有 `src/diagnostics*.rs`、`examples/diagnostics_contract.rs` 与独立测试/本文档。**Host owner 已完成生产 main/原生 services/UI 接线及持久 consent 注入**；诊断四方法在通用 bridge fallback 后安装，不再把仅 fallback 的 disabled/unsupported 当作生产诊断能力。偏好 seam 与独立测试由本模块所有；具体安全 metadata store 和入口注入由 Host owner 所有。本次仅更新本文档，不修改诊断实现、main/host_services、Host README、iOS 或 documents。生产安装与存储测试不等于真实系统保存框／Windows 平台已验收。

## 已完成的生产接线与维持合同

1. 在 Rust runner 声明 `mod diagnostics;`。沿用现有四个 capability 名称，全部在通用 bridge fallback 安装**之后**注册，不增加 JS 授权／文件路径方法。
2. 主线程创建 `let (diagnostics_port, diagnostics_inbox) = diagnostics::channel();`。
3. `host_services::Reader::capture_diagnostics()` 已从同一原生连接 actor 的 committed publication 提供 native-only capture。当前生产装配通过 services owner 统一安装：

   ```rust,ignore
   owner.services().install_diagnostics_with_preference(
       &host, diagnostics_port, native_bundle_version, native_bundle_build,
       Some(Box::new(native_preferences::Consent::native())),
   )?;
   // install_diagnostics_with_preference 内部：
   let capture: diagnostics::Capture = Arc::new(move || reader.capture_diagnostics());
   // diagnostics::install_with_preference(...) 返回的 Owner 由 services State 强持有。
   ```

   `capture_diagnostics()` 在同一 publication 锁内核对 live、runtime suspension、selected scope、authorization 和 native window ID，再调用 `Scope::committed`；无有效窗口／Host／运行期授权时返回 None。`Port::window_id()` 提供单窗口原生随机身份，重复获取保持稳定，shutdown 后失效；不是 JS 参数。现有 `Reader.current(scope)` 本身不含 authorization/window，不能替代该 capture。`Scope` 无凭据、无 Debug/序列化接口；仅 Rust 持有 hostID/runtime lease/authorizationID/windowID，事件与报告不包含这些值。一个安装 owner 对应一个原生窗口，不能跨窗口共享录制租约。
4. `State.diagnostics` 已强持有 `Owner`；重复安装被拒绝。**在 actor 发布任何 Host/runtime lease/authorization/window 替换之前，同步 `owner.invalidate()`**；清空连接/quarantine、真实后台 suspension、shutdown 同理。当前 publish 在 scope／authorization／origin 变化前撤权；metadata-only rename 且 authority 不变保留 recordingLease 和事件，确定未提交的存储失败同样保留 prior。提交未知／冲突进入 quarantine 前撤权。shutdown 使 window 身份失效，并在释放 services 锁后 drop Owner；原生 view 停止前先退役 services，不只 drop UI inbox。
5. Capture 在 recorder 锁外执行。最终本地 commit 与 invalidate 共用 recorder gate；gate 内不再调用 actor reader，避免 publisher→recorder / recorder→publisher 反向锁序。epoch 拒绝 retire 竞态中的旧 capture。invalidate 清 ring 和 pending reply、标记 exact dialog cancellation；旧 job 真正结束前保留 export 槽，避免重复 worker/modal。
6. `main.rs` 已将 inbox 放入 `native_ui::Dialogs.diagnostics`。两平台 UI owner 在实际主线程、**借用 pump/RefCell 之外**，每轮最多从 diagnostics/documents/attachments 之一取一项：

   ```rust,ignore
   if !diagnostics::is_presenting()
       && !documents::is_presenting()
       && !attachments::is_presenting()
   {
       if let Some(job) = diagnostics_inbox.try_recv() {
           // 与 capture 使用同一原生 window ID；两个参数都不得来自 JS。
           unsafe { job.show(actual_nswindow_or_hwnd, &native_window_id) };
       }
   }
   ```

   三类 dialog admission 已双向检查各自的 `is_presenting()`，不能回退成只检查诊断一侧。它覆盖 scheduled + modal，不覆盖后台写入（写入不再占据系统 dialog）。Mac `show` 用 dispatch main queue 延后，退出当前借用再进入 nested modal；Windows 同步在 UI 线程调用。每次只允许一个 <=512 KiB export、一个 capacity=1 mailbox，无 append worker 队列。

## 不猜后台合同

依据 `ios/RuntimeBridge.swift:setForeground/retireResources`、`ios/main.swift`、`tests/settings-about-contract.md`：**真正 runtime suspension 会退役 scope，清空 ring，恢复时重新签发 recordingLease；enabled opt-in 不因此关闭**。系统 SaveDialog/分享导致的 `willResignActive`、Win32 owner 暂时失焦，不代表真正后台，不可直接 retire。生产接线方必须使用自身明确的 runtime suspension authority；capture 在真正后台返回 None，恢复时恢复 committed scope，再让既有 TS root refresh status。

当前桌面已接 `Port::set_runtime_suspended`：Mac 使用 NSWorkspace 系统 sleep/wake 通知；Windows 使用 `WM_POWERBROADCAST` 的 suspend/resume 消息。实际 suspension 状态转换先 invalidate，再更新 native admission；挂起期间 capture 返回 None，恢复后下一次 status 签发新 recordingLease。没有把 resign-active、遮挡、最小化或系统 dialog 临时焦点变化当成撤权信号，也没有因诊断挂起擅自轮换 Host runtime lease。

本模块不擅自按最小化/焦点猜测后台，也不主动轮换 Host runtime lease。Mac dialog admission 检查可见、未最小化、active、无其它 modal/sheet；Windows 检查 owning UI thread、enabled 和 foreground HWND。Host invalidation 后 Mac 对**自己保留的 NSSavePanel**发送 cancel，Windows OFN hook 50ms 检查自己的取消标志并向自己的 dialog 发 IDCANCEL；不全局 abortModal、不关闭其它窗口。该系统取消源码已编译/审阅，但尚无真实系统 dialog 操作证据。

## Wire / 容量 / 隐私

| 方法 | 精确输入 | 输出 |
|---|---|---|
| `native.diagnostics.status` | 无或 `{}` | schemaVersion=2、mode=event-recorder、enabled、recordingLease/null、eventCount、maxEntries=500、maxBytes=262144；新增安全 metadata `preferenceState` |
| `native.diagnostics.setEnabled` | `{enabled:boolean}` | 同 status；导出尚未退出拒绝开启；关闭立即撤权并取消导出。已开启再开启为 no-op；重复关闭可显式重试保存 false |
| `native.diagnostics.append` | `{hostID,lease,events,dropped}` | `{accepted:true}`；lease 是 Native 签发并绑定整个 native Scope 的 recordingLease，不是 JS runtime lease |
| `native.diagnostics.export` | `{hostID,snapshot}` | `{outcome:'shared'|'cancelled'|'failed',eventCount?,error?:stable_code}`；桌面 shared 表示 OS 选择后本地保存已确认 |

未注入偏好时 `install` 继续默认关闭、进程内保存，重启不恢复。注入后仅 load 一次安全 metadata，由已确认的 opt-in 恢复 enabled；不恢复旧 ring 或 recordingLease，不做旧 snapshot opt-in 迁移。load/status/append 不写偏好；只有显式 setEnabled 写入单个 bool。诊断 owner 不自行选择存储目录、不读 Vault、不请求 OS 权限、不写事件文件。只有显式 export 才排队系统保存框并在用户确认后保存报告。

### 当前生产持久 consent

`main.rs` 已通过 `install_diagnostics_with_preference` 注入 `native_preferences::Consent::native()`，不再以进程内 None wrapper 作为生产偏好。`native_preferences.rs` 的 Consent 复用 `notifications::store::FileStore` 事务实现，但使用独立的 **`native-preferences` 私有目录**，不与 `notification-receipts` 共用数据或锁，也不读取 credential Vault。

唯一写入 schema 为 **`{ "v": 1, "diagnosticsEnabled": boolean }`**。load 核对 exact 两字段、版本和 boolean 类型；没有文件才是默认 false，损坏／多余字段／错误类型／读取失败均拒绝。存储中不含事件、正文、Host/window/authorization、runtime/recording lease 或其它 authority。跨启动仅恢复用户已经确认的 bool；冷启动仍从空 ring、无 recordingLease 开始，获得当前 native authority 后才签发新 lease。

Host 使用 `notification_store_grant::store_for("native-preferences")` 的原生目录 grant：Mac owner-only 0700，Windows protected DACL／原生 owner 检查。目录授予／FileStore 初始化可创建应用私有目录和锁，这是原生 metadata 基础设施，不是默认开始录制或写事件日志；load 不提交 consent JSON，只有显式 setEnabled 才提交该两字段记录。Windows 保护源码不代表已经完成 Windows SDK／实机验收。

Consent 保留 store 构造失败，不降级到 None；因此安装后 load 失败显式停录并拒绝 enable。save 失败同样 fail-closed。**disable 的 save(false) 失败时，只保证当前进程／owner 立即停录；不能承诺磁盘旧 opt-in 已清除，也不能承诺重启后仍关闭。**下一进程若读到仍有效的旧 true，可恢复该磁盘 opt-in；只有确认 save(false) 成功才可声称关闭已跨启动保存。不把当前内存 false、取消导出或一次失败回执冒充持久撤销。

### Host 偏好注入精确 seam

```rust,ignore
pub trait Preference: Send {
    fn load(&mut self) -> Result<bool>;
    fn save(&mut self, enabled: bool) -> Result<()>;
}

// 既有前五参不变，最后一参是 Option<Box<dyn Preference>>。
let owner = diagnostics::install_with_preference(
    &host, capture, port, native_bundle_version, native_bundle_build,
    Some(Box::new(safe_metadata_preference)),
);
```

`Result<T>` 是现有 `policy::Result<T>`（`Result<T, String>`）。store 仅需 Send、不要求 Sync；由 recorder 独占持有并串行调用。现有 `install(...)` 是同一实现的 None wrapper，保留现有生产调用兼容，不冒充已注入持久化。

生产若不能构造安全 store，应拒绝该安装或注入 load 返回 Err 的 driver；**不能把 store 构造失败降级成 None／旧 install**，否则会绕过 load-failed 的 fail-closed 门禁。

- `load` 在 install 注册 handlers 前调用一次，不自动提交 consent：确认无记录由 Host driver 返回 `Ok(false)`；损坏、权限／读取失败、提交未知必须 Err，不能伪装默认值。load Err 安装 disabled owner，`preferenceState:'load-failed'`，不发 recordingLease；开启拒绝 `diagnostics_preference_load_failed`，不会用写 true 覆盖未读的 prior。
- 开启先准备私有 lease，再调用 `save(true)`；只有 save Ok 才发布 enabled/lease。save Err 返回固定 `diagnostics_preference_save_failed`，状态为 `save-failed`，仍 disabled、无 lease、无新增事件；不转发 driver 的路径或底层错误。后续必须显式重试，status 不重试读／写。
- **关闭先 enabled=false、清 ring/lease/dropped、取消 exact pending export，再调用 save(false)**，不依赖 Host capture、runtime lease、RNG 或导出退出。即使 save Err 仍立即停录，后续 append/export 拒绝；status 显示 disabled + `save-failed`，不重新 load 磁盘旧 true。重复显式关闭可重试保存；成功 false 也可修复 load-failed baseline，再允许以后显式开启。
- `preferenceState` 仅为 `process-local | ready | load-failed | save-failed`，属于状态 metadata，不写入事件或导出报告。原 schema 2 消费者可忽略此附加字段；setEnabled 失败后应刷新 status，不能用旧 UI true 推断仍录制。
- Host 负责 0700／protected DACL 的独立私有 tiny JSON metadata store、边界／事务／回读和未知提交处理；save Ok 必须证明 exact bool 已提交。driver 不得调用 actor/services/capture、诊断 Owner、网络或 GUI；调用处持有 recorder gate，必须有界，不能制造反向锁序。保存失败不自动回滚、重写或迁移其它 store。无法持久保存 false 时只能保证**本 owner**立即停录，不能谎称跨崩溃／重启已保存关闭；Host 对不确定记录应 quarantine 并使 load 返回 Err。
- invalidate/sleep/wake/shutdown 不写偏好、不撤销已经持久确认的 opt-in；下次进程只恢复 bool，实际 Host/window authority 和 recordingLease 始终重新获取。Host 的真实存储及入口接线测试与这里的内存注入测试分别记录，不互相替代。

Rust 独立再次拒绝额外字段、未知类型、原 sessionID、正文/路径/URL/凭据、错误 lease/Host。固定七字段、类型白名单与 TS/Swift 一致；匿名 ordinal 正则与 Swift 一致接受 `session-0..999`（TS 实际只生成 0..500），不接受 `session-01` 或任意 raw ID。at 为有限非负安全数；dropped 为 0..1,000,000 整数。每批 1..32 行、编码最多 16 KiB；整批验证后才修改 ring/dropped。ring 最多 500 条/256 KiB，丢旧保新计数；只保有匿名 JSON 字符串，无正文持久化。当前字段上界使单批/总 byte cap 是额外防线，绝非保留任意字段到达阈值才截断。

工作量合同：单批 `O(<=32 × 固定字段)`，ring 入/出队 `O(1)`；只在显式 export 做 `O(<=500)` 报告构造，无 catalog scan、token/delta 采样或周期 flush。唯一系统取消 timer 只在已打开的本模块 dialog 存活，每 50ms 一次。既有 TS 100,000 delta 回归验证 body reads=0/native append=0；未测真实桌面输入延迟/p95，不以容量测试冒充性能验收。

上下文使用 TS `aboutSafeSnapshot` 的 exact 嵌套键；未知字段/超长值直接失败，非法 version/enum/bool 投影 null，不 stringify 私密对象。native client version/build 由 install 的 native bundle metadata 投影，不能用 JS snapshot 或 Host version 冒充。报告保留 Swift 外层 `schema:'yuri.client-diagnostics.v1'`、events/count/dropped/context/coverage；JSON 最多 512 KiB。文件名固定 `yuri-native-diagnostics.json`，JS 不提供文件名/目录/本地路径，也永不收到路径或底层错误文本。

## 保存与未知结果

- 直接编译复用只读 `documents_files.rs` / `documents_windows_abi.rs` 的真实安全保存基础设施，没有另造旁路。仅系统确认后的 path 创建 Grant；不读 Vault、Host 或默认用户目录。
- 两份复用源码使用 owner 私有的 `pub(super)` 类型；诊断侧仅在这两个 `mod` 声明上精确豁免 `clippy::duplicate_mod`，不拓宽 documents 可见性、不复制实现、不全局关闭 lint。测试 driver 的 `choose` 方法及 FileDriver 对应实现均为 `cfg(test)`；生产 chooser 仍直接使用原生 UI adapter，不保留未使用的 trait 方法。
- Mac NSSavePanel、Windows `GetSaveFileNameW` 真系统 API，OS 拥有目标与覆盖确认。全量 stage + flush 后才进入共用 gate 的最终 rename；前置失败保留 prior，已观察的目标变化拒绝覆盖；link/reparse/非 regular/危险 parent 沿用 documents 拒绝规则。外部进程最终名称替换仍不是文件系统 CAS；Windows MoveFileEx/flush 的系统失败语义继承 documents，未经平台验收。
- 本地文件写入只发生一次；普通失败返回稳定 failed、保留 recorder 供再次**显式**导出。unknown commit 只对原 grant 做一次只读 verify，确认 exact bytes 才算 shared。verify false/失败保留 **`diagnostics_write_unknown` sticky 元数据 tombstone**，本 installed Owner 后续 export 全拒绝，status 不读文件、不重写、不重新开 dialog。invalidate/停录不清 unknown；不把未知当确定未写。没有假造 schema 2 中不存在的可重发 receipt。
- pending invalidation 先 settle cancelled，并取消 exact dialog；迟到结果最多 settle 一次，不污染新 scope。取消不能撤销已在 gate 内提交的文件。unknown 元数据仍保留；JS 无路径、无原 grant 可绕过。应用重启会丢失进程内 tombstone，用户只能通过新的显式导出重新授权系统目标；**不声称支持崩溃后 durable export receipt 恢复**。

## 独立验证（不打开系统 UI、不读取用户文件）

```sh
cargo --config packages/nsh/.nsh/desktop/cargo-source-patch.toml test --offline \
  --manifest-path packages/nsh/desktop-host/Cargo.toml \
  --target-dir packages/nsh/.nsh/desktop-target --example diagnostics_contract
cargo clippy --config packages/nsh/.nsh/desktop/cargo-source-patch.toml --offline \
  --manifest-path packages/nsh/desktop-host/Cargo.toml \
  --target-dir packages/nsh/.nsh/desktop-target --example diagnostics_contract --tests -- -D warnings
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/desktop-diagnostics-contract.test.ts
```

Rust example 使用真实 NSH 0.4 HostChannel/Engine/QuickJS 和合成 native authority；driver 将 prior/stage/commit/unknown 放在纯内存，不打开 UI/网络，不创建测试用户文件，也不调用 Vault read/write。只用系统随机函数签发 UUID。白名单测试、原子批、500 条 FIFO、匿名报告、原生 lease/authorization/window 换代、停录、14 种导出/退役/失败路径均实际执行；包含已 stage 尚未 commit 时退役后零 commit，以及 native capture 与 retire 的真实线程交错。共享 policy/Vault transaction/Windows ABI tests 也是合成元数据算法，不访问真实 Keychain/注册表。

验证计数与最终 clippy 结果见交付报告。TS parity/source tests 与既有 root tests 不是原生 chooser 实测。未启动任何真实 UI（锁屏环境）、没有解锁或权限弹窗。Windows cross-target check 实际尝试，被离线缺失 `byteorder-lite v0.1.0` 阻塞；未安装 target/SDK/依赖，**Windows DLL 链接、OFN hook/取消、真实保存均未验收**。`bun run dead-code` 实际尝试，被既有 `vite-plugin-pwa` 缺失阻塞，未安装依赖规避。

独立模块交付时执行：Rust example **19 passed / 0 failed / 0 ignored**（9 项诊断合同 + 10 项复用 policy/安全存储纯算法/ABI 测试）；TS **15 passed**（本模块 4 项 + 既有 root 11 项）；整包 `tsc --noEmit --project packages/nsh/tsconfig.json` 通过；example Mac build/link 与 example/tests clippy `-D warnings` 通过。该次验证没有执行生产 runner、真实 chooser、真实文件保存或任何 Windows binary。

### Host owner 后续生产接线证据

已核对 `main.rs`、`host_services.rs`、`native_ui.rs`、`native_ui_windows.rs` 及 `diagnostics_owner_tests.rs`：生产注册、committed native capture/window/authorization、metadata 保 lease、确定写失败保 prior、quarantine 撤权、sleep/wake 与 shutdown 已有接线和合成生命周期测试。`host_services` 自有测试同时覆盖稳定窗口身份、authorization 替换与 shutdown 后拒绝 capture；UI 三 dialog 已双向互斥。

Host owner 在基础接线阶段报告完整 scoped 结果为 **binary 99 passed / example 100 passed，各 0 failed / 0 ignored，包含真实 WS fixture**。这是该阶段 Host owner 执行的证据，本次文档更新未重复运行整套测试，也不与上方独立 example 19 项相加去重。真实 WS fixture 证明其所属 transport 路径，不证明诊断 NSSavePanel/Win32 chooser、系统 sleep/wake 通知投递或 Windows 编译／SDK／保存实机行为。本文保留这些未验边界，Host 总体构建与完整验证账本由 Host README 所有。

生产并装后的 focused lint 修复已实际验证：`cargo clippy` 使用上述 config/manifest/target-dir，加 `--bin yuri-nsh-desktop --example synthetic_smoke --tests -- -D warnings` **通过**，覆盖 non-test binary 与同 crate 的重复模块检查；独立 `diagnostics_contract --tests` clippy 也通过。修复后重跑独立 Rust **19 passed / 0 failed / 0 ignored**、TS **15 passed**。本次未重跑 Host 全套 99/100，不改变其证据归属；未修改 documents、生产入口或任何运行时合同。

新增 Preference seam 时独立 Rust **24 passed / 0 failed / 0 ignored**（新增 5 项：true/false 跨 owner 恢复、fresh lease/无事件恢复、load/save 失败、关闭失败先撤权/取消导出、Send 但非 Sync driver），TS **15 passed**，独立 example/tests clippy `-D warnings` 通过。该次 aggregate scoped clippy 的诊断部分无错误，但被另一 owner 当时进行中的 `notifications::Owner::activation/retire_authorization` 未使用阻塞，未越权修改通知源码；dead-code 被既有 `vite-plugin-pwa` 缺失阻塞。这是历史验证结果，不作为后续生产接线的当前失败结论。Host 报告 seam 前聚合 tests **117/118**、clippy/build 通过；不是该次 seam 后重跑的结果。

持久 consent 生产接线后，已只读核对 `main.rs`、`host_services.rs`、`native_preferences.rs` 与相应测试：Host owner 报告 `consent_uses_real_private_transactional_disk_and_rejects_corruption_without_empty_success` 已通过，在独立 synthetic 私有目录中实际执行 save(true) → drop/reopen 冷恢复 → save(false) → 读取 JSON 确认为 false，再重新打开并拒绝损坏 JSON。`consent_cold_restore_is_exact_metadata_and_missing_is_false` 验证缺失默认 false／额外 events 字段拒绝；`production_diagnostics_persist_only_opt_in_and_cold_start_never_restores_event_rows_or_authority` 通过实际 services 注入验证只恢复 consent、重新签发 lease、不恢复事件／authority。执行证据由 Host owner 提供；本次文档更新未运行这些测试、未读取真实用户 metadata 或 Vault，也未新增任何平台验收结论。

### Host owner 最终验证更新

Host owner 最终报告：聚合 **binary 181 / example 181，各 0 failed / 0 ignored**；诊断独立 **29 passed / 0 failed / 0 ignored**；consent 真实磁盘测试 **2/2 通过**；scoped 全部 examples/tests 的 clippy `-D warnings` 与 Mac build 通过。上述范围存在重复覆盖，不将各计数相加；精确执行账本与安全目录／持久 consent 边界由已更新的 Host README 所有，本次只同步结果，不冒称自行重跑。

当前整包 tsc 被并行 main 的 Chat tab shape 未适配阻塞，位置为 `packages/nsh/desktop-panel-tabs-renderers.ts:29`；此前独立模块交付时 tsc 通过是历史结果，不能据此声称当前整包通过。未修改该文件，未扩大诊断 owner 范围，也未改变 disable 保存失败只能保证当前进程停录的边界。

NSH API 证据来自本地精确 0.4 source `crates/nsh-engine/src/host_channel.rs`（handle/HostReply）与 `crates/nsh-platform-macos/src/lib.rs`（objc2/Foundation reexport），遵循用户要求不再消耗 Context7。没有修改上游 checkout，也没有 Git/GitHub 操作。
