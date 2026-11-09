# 主窗口 session / native geometry 独立 slice

> 已有真实磁盘与原生 OS API 实现，但**尚未装进生产入口**。本文件是 main / Hostowner 的安装合同，不是多窗口、全屏或 PC Native parity 的完成声明。本 slice 没有改 Cargo、main、native_ui、bridge、host_services 或 connection_actor。

## 代码与依据

- `src/window_state.rs`：单个进程级 storage Owner；全部主窗口共用，绝不每个 AppView 打开一把文件锁。
- `src/window_geometry.rs`：有限 outer bounds、平台坐标空间、有效 workarea clamp。
- `src/window_geometry_macos.rs`：真实 NSWindow frame / isZoomed / styleMask / NSScreen.visibleFrame，隐藏期 setFrame / zoom 与显示后的系统全屏请求。
- `src/window_geometry_windows.rs`：真实 HWND、GetWindowPlacement / GetWindowRect / monitor workarea / DPI、隐藏期 SetWindowPos、ShowWindow 与 OS 回读。不是 metadata getter 的模拟。
- 两个 `examples/window_*` 是独立 Cargo 自动发现 harness；main 惰性，不创建窗口、不加载 Vault、不找用户 home。

固定 NSH 0.4.0 revision：`e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`。重点依据：`nsh-platform-windows/src/window.rs` 240–313（全屏的私有 windowed placement）、`app.rs` 212–261（AppView/HWND/每 view channel）、`nsh-core/src/js/limits.rs`（默认 embedded VM heap 256 MiB）。Electron 的实际行为见 `packages/electron/main.mjs` 的 readWindowStates / clampWindowBoundsToVisibleWorkArea / writeWindowState / debounceWindowStatePersist；只存 main、normal bounds、300ms 合并、restore/quit freeze，不保存 Mini Chat。

Electron 这段代码**没有主窗口数量上限**，这里不假称继承了一个上限。NSH 每 AppView 独立 Engine，因此设置显式 **8 个主窗口** admission / 恢复 metadata 上限；第 9 个拒绝，不驱逐/截断已有窗口，也不偷偷合并 HostChannel。8 × 默认 256 MiB = 2 GiB 的 JS heap 理论额度，**不包含 native/GPU/网络内存，也不是实际内存测量**；这是数量护栏，不是“8 窗口性能已验收”。main 必须在创建第 9 个 Engine **之前**采用同一常量。产品若修改资源预算，应同步修改此常量及验收，不只改恢复 parser。

## Exact DTO（native only）

```text
Snapshot { revision: u64, windows: Vec<MainWindow> }
MainWindow {
  window_key: String, connection_id: String, runtime_key: String,
  geometry: Geometry {
    space: AppKitPoints | Win32Physical,
    normal: Rect { x:f64, y:f64, width:f64, height:f64 },
    maximized: bool, fullscreen: bool
  }
}
```

磁盘 JSON exact whitelist：

```json
{
  "schema": 1,
  "revision": 1,
  "windows": [{
    "windowKey": "main-stable-public-key",
    "connectionID": "saved-public-connection-id",
    "runtimeKey": "saved-public-runtime-key",
    "space": "appkit-points",
    "normalBounds": { "x": 100, "y": 100, "width": 1200, "height": 800 },
    "maximized": false,
    "fullscreen": false
  }]
}
```

- 最多 8 条、16 KiB 编码；revision 为 1..9007199254740000，首次缺文件的 CAS baseline 为 0。非空唯一 windowKey；三个 ID 各 ≤128 ASCII 字节，字符集为 `[A-Za-z0-9_.:-]`。未知字段、重复 windowKey、畸形/部分记录全拒绝，不 filter 后覆盖。
- 坐标有限、绝对值 ≤1,000,000，尺寸 1..65536。AppKit 是屏幕原生左下原点 points；Windows 是 per-monitor-aware **screen physical outer pixels**。两个 space 不混用。恢复 nominal 最小为 900×560 points/DIP，实际 workarea 更小时以实际可见面积为准；Windows 先把隐藏窗口移至目标屏再读取其 DPI。
- 数组首项是 primary；其他顺序由主窗口 registry 所有，不按随机 ID 排序。
- `windowKey` 是跨启动的产品主窗口 key，不是 services 的随机 native windowID。新建时由 native 生成，恢复时沿用，主窗口 registry 持有。HostChannel、Engine、journal namespace 仍必须每窗口独立装配。
- connectionID/runtimeKey 只能来自该窗口**原 actor 已提交的公开稳定身份**，不能是 runtimeScope/lease、authorizationID、origin URL、用户传入字符串或从首条连接猜测。若现有 native publisher 尚无稳定 runtimeKey，先由 owning publisher 完成真实投影，本模块不伪造可用身份。恢复记录只给连接 owner 提供 target，**不授予认证**；应重新读取原 registry、授权并建立本窗口 transport。
- 不保存 token/auth/nativeWindowID/URL/query/hash、消息、目录、正文、设置脏稿、通知 consent。这个 slice 不包含 route 恢复；既有产品 navigation owner 继续拥有 route。

## 安全目录：main 必须补的既有 grant 接口

本模块**不发现 home、不 chmod 陌生目录、不另造 DACL/ACL/原子 I/O**。两种入口：

```rust
Owner::in_private_directory(&verified_private_directory, pinned_native_grant)?
// 或既有 grant 已经创建并锁住真实 FileStore：
Owner::from_granted_store(&verified_private_directory, granted_store)?
```

目录必须是调用方已验证且保持祖先 handles 的绝对 appdata leaf **`window-state`**。macOS：复用现有 nofollow / uid / ACL grant，leaf 0700 无 ACL；Windows：复用现有 LocalAppData / 固定本地卷 / no-reparse / 当前用户 protected inheritable DACL grant。不要传 Vault、notification-receipts、native-preferences 或 file-journal 目录。

当前 `notification_store_grant.rs` 和 `private_directory_windows.rs` 的固定 leaf whitelist 只有原有名字，**不能直接用现有 native()/store_for("native-preferences") 代替**。Hostowner/main 后续需要在**原 grant 实现**允许独立 `window-state`，并把同一次验证的 path 与 pinned grant（或已经持有 grant 的 Store）一起移交。原 grant 当前只返回 Store 的平台，应从原函数导出同次验证的 path + Store；不要从 HOME/环境或拼接一个“应该相同”的路径。没有这个真实 grant 时不能安装成 available；失败必须显示保存/恢复不可用并保留原记录。

实际数据文件和锁名沿用既有 FileStore 的 `desktop-notification-receipts.json/.lock`，但在全新 `window-state/` 目录中，内容/锁与通知和 consent 完全分开；不复制一份安全 I/O 仅为改文件名。新增边界检查拒绝超 16 KiB、symlink/reparse、非普通记录；Mac 另拒绝非 owner-only mode / hardlink，lock 同样检查。复用 FileStore 的 create_new stage 0600、文件 sync_all、原子 rename（Windows MoveFileExW replace/write-through）、readback、Mac 父目录 fsync 与独占锁；Windows 新文件权限继承既有受保护 user-only directory DACL。调用方保持原 grant 的 ACL/祖先证明至 Store 关闭，不只传一份 metadata 检查结果。

## 精确生产接线顺序

入口归还后由 main 安装；本 slice 不修改他人入口。

1. Rust root 声明 `mod window_geometry; mod window_state;`，无需 Cargo 或新依赖。启动唯一 storage worker，在 worker 内取得原生 private-directory grant 并构造 Owner。Owner 有非 Send pinned-grant 容器，**不要先在 UI 上构造再跨线程搬运**。构造返回 Ok 不代表读取成功，必须检查 `snapshot()` **和** `failure()`；失败没有空集合 fallback。
2. 保存 readonly snapshot。Owner 初始处于 restoring；逐条创建真实主窗口，主窗口 registry 复用 windowKey，每 AppView 独立 HostChannel/Engine/services。恢复 target 的读取/连接失败保留该项与重试入口，不能变成 local 或从 snapshot 删除它。部分恢复期间不调用 `finish_restore`，不能把已打开子集 stage 回盘。
3. AppKit：真实 NSWindow 建立后、orderFront/center 前调用 `macos::restore_before_show(&window, saved.geometry)`。**有恢复记录时取消原 runner 无条件 center**。返回的 clamped normal Geometry 用作本窗口 sampler seed。随后显示窗口；若 fullscreen，调用一次 `enter_fullscreen_after_show`，继续冻结到真实 didEnterFullScreen 完成。系统原生全屏是异步 Space transition，不能在 hidden window 上伪造“全屏已完成”。zoom/frame 均有真实 getter 回读；失败明确返回，不冒充恢复。
4. Windows：现有 UI runner 先设置 DPI awareness；持 `view.hwnd()` 的真实值，`unsafe { windows::Window::borrow(&hwnd)? }` 只在其 owner UI 线程使用。调用 `restore_before_show`，native bounds 在 visible 之前已设置并回读。正常/最大化使用 `show_restored` **代替** AppView.show（避免无条件 SW_SHOW 丢最大化），保留后续既有环境/引擎事件循环。borrow 不能跨销毁/线程；内部会验证同进程、同线程、live top-level HWND。
5. **Windows 全屏尚有入口接线门槛**：NSH 0.4 `window.rs` 的 private `windowed: Option<WINDOWPLACEMENT>` 由公开 `nsh/desktop.Window.toggleFullScreen()` 唯一维护。入口必须在该窗口 engine 装载后，经本窗口受信任启动参数消费一次公开命令，pump 原 loop，并由 `capture(Some(seed))` 核验实际 style mask / monitor rect，然后 `show_restored`。本模块不会直接改 style 破坏 NSH 的退出全屏恢复；未执行该命令时返回 `window_fullscreen_requires_nsh_command`，不显示成假成功。**同时 saved maximized+fullscreen 的正确进入顺序及退出全屏后的 maximized 恢复仍须入口专门处理并实测**，不能把 normal frame 复制到 fullscreen rect 或只写 metadata 即签收。
6. 全部主窗口身份/几何及所需全屏 transition 成功后，worker `finish_restore()`；之后采样第一个完整 catalog，再 stage。用户已明确取消恢复时，须有 owning registry 的显式替代意图，不能因为连接 fetch 失败而自动“取消恢复”。

## Native watch / debounce / flush / Drop

- 原生 observer 和窗口 registry 归 main/native_ui；本模块没有偷偷安装第二 delegate、Win32 subclass、常驻 timer、Engine handler 或 HostChannel。AppKit 原 delegate 接 didMove/didResize/didEndLiveResize、will/didEnter/ExitFullScreen、全屏失败及 miniaturize/deminiaturize；Win32 **原** window_proc 接 WM_MOVE/WM_SIZE/WM_WINDOWPOSCHANGED/WM_EXITSIZEMOVE/WM_DPICHANGED/WM_DISPLAYCHANGE。Host committed identity 变化也是一次 dirty。
- 高频 native callback **只置对应窗口 dirty**；复用现有 UI loop/pump，最多一轮把 dirty 窗口 OS getter 采样成最新 native DTO，不在 setter/transition 中间或 RefCell 借用内做磁盘 I/O。初次进入特殊态前必须已有真实 normal seed；AppKit zoom/fullscreen/minimized 期间绝不把当前 frame 当 normal。fullscreen transition 期间保留 pre-transition normal/maximized，完成后再采样；失败保 prior 并显式重试。
- 一个 UI-native registry 维护至多 8 条最新有效快照；只在有变化时向 worker 发**完整** catalog（primary first）。任一 getter/身份未完成则保留该窗口 prior，报告失败并等待显式重采样；不能删这一项后宣布完整。worker 接收 FIFO 完整 capture；main 的 bounded mailbox 应只合并尚未派发的完整 capture，不丢 close/quit barrier 或错误。不要把 credential/publisher locks 跨 OS getter 或磁盘等待持有。
- `stage(expected_revision, windows, Instant)` 是纯 native metadata admission，expected revision 来自 worker 当前 snapshot。`deadline()` / `flush_due(now)` 是 **300ms trailing debounce**；重复相同 pending snapshot 不刷新截止时间。没有后台线程或自启动 timer；worker 复用拥有者 wake/deadline 调度，不让 UI 同步调用 flush。实际开始写才 reread disk baseline，并由独占 Store 锁 + exact revision/value CAS 防止 stale owner 覆盖。
- 已知 write failure 保 durable prior + 最新 pending；deadline 清除，后续 move/resize/计时器不自动重试。显式保存/close/quit retry 才调用 `flush()`。read/conflict 只显式 `retry_read()`，失败不改变 prior；成功会采用权威 disk revision 并放弃旧 queued capture，main 必须重新采样完整 live catalog 后才能写。
- 普通 close：原有 dirty/unknown 文件及设置 admission 完成后，native 再捕获完整最终 catalog，worker stage + `flush()` 成功，再复验原 close ticket 和所有窗口 owner，最后允许 teardown。取消保留全部 owner。若关闭其中一窗且应用继续运行，由 registry 的**明确 close commit** 更新 remaining catalog 并保存，不依赖渐进 teardown 事件；最后一窗不写空列表，以便下次启动恢复它。
- Quit：全部 close grants 取得后、第一窗销毁**之前** stage 完整 catalog，`freeze_quit()`，显式 `flush()`，等待结果再允许整体 teardown。freeze 后拒绝新 event stage，但允许已冻结 capture 的 flush。失败保 prior/pending，不先拆 Engine；取消退出调用 `cancel_quit()` 再重新采样，不自动重放错误写。多窗口 quit 不能逐窗各自覆写一个 shrinking catalog。
- `freeze_restore()` 禁止写入；中途重新恢复前应先显式结算 live pending，否则保持冻结，恢复成功后用完整新 native catalog 替换它。Drop **不 flush、不修复、不删除、不等待**；必须保持 storage Owner/grant 活到最后显式 barrier 结束。强杀/系统终止没有正常 flush 保证。
- unknown（原 Store `notification_store_unknown`）当前 Owner sticky；`inspect_unknown()` 只回读 Candidate/Prior/Other，不 ACK durability、不 rollback、不放行 flush。禁止自动销毁重建 Owner 来清错误，禁止重新发 commit。下次正常进程冷启动用原 Store 回读核验；该测试用显式 drop/reopen 模拟 owner 重建，不声称证明崩溃/断电 durability。

## 已运行的独立验证

使用已有固定 NSH source patch、offline Cargo，不安装依赖：

```sh
cargo --config packages/nsh/.nsh/desktop/cargo-source-patch.toml test --offline \
  --manifest-path packages/nsh/desktop-host/Cargo.toml \
  --target-dir packages/nsh/.nsh/desktop-target --example window_state_contract window_
cargo --config packages/nsh/.nsh/desktop/cargo-source-patch.toml test --offline \
  --manifest-path packages/nsh/desktop-host/Cargo.toml \
  --target-dir packages/nsh/.nsh/desktop-target --example window_geometry_windows_typecheck
```

第一项覆盖真实唯一 private 临时目录的双窗口冷读写、0600、独占锁、exact whitelist/容量/重复 ID、corruption/read failure 保 prior、真实 chmod stage denial 保 prior/显式重试、revision/disk conflict、unknown-after-real-commit 的只读核验/冷恢复、restore/quit freeze、last-close 不写空、Drop 零写、symlink/hardlink 拒绝及 8 窗口 10000 次重复事件恰好一次 commit。故障注入仅包裹真实 FileStore，不用内存假盘代替实际文件行为。

第二项编译**真实 Win32 source**并执行 44-byte WINDOWPLACEMENT / 40-byte MONITORINFO / offsets 断言及公共 clamp 测试。当前机器只有 `aarch64-apple-darwin` std：**这只是 Darwin Rust frontend + ABI 结构布局验证，不是 Windows target/SDK/DLL 链接/物理系统 ABI 或实机验证**。真实 HWND constructor 仍须在 Windows target 编译。没有执行任何真实窗口操作、通知、Vault/home 或用户文件操作。

本次最终结果：第一项 **12/12**（其中公共 geometry 1 项），第二项 **5/5**（含既有 policy 3 项）；两个 example 另分别通过 `cargo rustc --example <name> -- -D warnings`，包含真实 AppKit adapter 的 macOS 编译，但未执行窗口 API。新增文件通过限定文件、`skip_children=true` 的 rustfmt，未格式化既有模块。`bun run dead-code` 已尝试，被既有 `packages/web/vite.config.ts` 缺少 `vite-plugin-pwa` 阻断；未补装依赖或修改配置绕过。

## 尚未签收（main 必须保留在总账）

- 两个 Rust module 的生产声明、独立 window-state grant leaf/path 导出、唯一 worker、每主窗口 Engine/HostChannel、native observer/dirty mailbox、startup readiness 与 close/quit barrier 接线。
- Windows 受信任启动参数→公开 Window fullscreen 命令，尤其 maximized+fullscreen 的正确恢复/退出全屏；AppKit异步 fullscreen failure/完成与窗口恢复冻结的接线。
- 两个真实独立窗口分别切 Host、move/resize、最大化、全屏、minimize、关闭/取消/quit/relaunch，拔屏/负坐标/不同 DPI/任务栏位置，连续事件与 write failure UI/显式恢复。
- AppKit / Windows 物理快捷键（Cmd/Ctrl+N、Cmd/Ctrl+W、Cmd+Q、Alt+F4、全屏/zoom/menu）、焦点和截图对齐；Windows target/SDK/link/runtime；断电级持久性和原 grant 的真实 Windows DACL 验收。

因此不能把本模块存在、10k 操作数或 harness 全绿写成“多窗口恢复已完成”或“Windows 已支持且验收”。
