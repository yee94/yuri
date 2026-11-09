# Desktop Header OpenInApps producer（冻结 v1）

## 范围与依据

- Web 来源：`packages/ui/src/components/desktop/OpenInAppButton.tsx`、`stores/useOpenInAppsStore.ts`、`lib/openInApps.ts`，以及 Electron `main.mjs` 的真实 installed-app provider。保持同一 25 项候选顺序、Finder 默认、已选项 → Finder → 第一项 fallback、菜单选中后先选择再尝试打开。空集合主按钮的 copy-path 语义保留在既有 action 中。
- 没有添加设置、应用 picker、shell、SSH handoff 或 Relay 猜测。现有 Header split button / Menu 是唯一产品消费位置；本模块没有第二 UI。
- 固定 NSH 0.4.0（审计基准 `e626a8dd`）的 `nsh/desktop` 只提供窗口、菜单、快捷键等，没有 installed-app 或 Host-directory mapping API。当前 Rust connection actor 只有 direct/SSH/remote authority，没有可验证本机 service/directory producer。native `connection_actor_http_port::Port::local_service()` 也明确 unavailable。
- **因此 v1 交付真实设备应用发现与只读 producer，不声称目录打开完成。** 即使 Host ID 为 `local`、URL 为 loopback、路径恰好存在，也不会被授予本机目录权限。

## Owner 与数据

`desktop-open-in-apps.ts` 是窗口根唯一 TS producer；`desktop-open-in-apps-native.ts` 仅通过现有 `runtime.native` 发窄方法。没有新增 HTTP、网络 transport、Storage 或 timer。

`desktop-host/src/open_in_apps*.rs` 持有进程唯一 catalog/选择和最多一个 discovery flight。scan 使用单独短期 worker，不阻塞 Engine 或共享 connection actor，不重写 Process。native read、capabilities、select 均不访问 Vault、Host 或 OS 扫描器。

选择是 **process-memory**，原生明确声明 `persistence:"process"`。当前 NSH 没有现成 `openInAppId` Store 字段，不借 Web 的 localStorage 或 Host 设置跨机器同步应用路径，也没有新增持久化 preference owner。重启恢复选择仍是缺项，不能把本合同说成已持久化。

所有 app ID、label、version 来自原生完整快照；JS 不根据平台或文件名猜已安装。native 不向 JS 返回应用/可执行文件路径。候选 ID/顺序测试直接对照 Web；没有无条件插入 Finder/Terminal 冒充已安装。偏好指向已卸载/未知项时保留原 ID，fallback 仅用于呈现，不回写偏好。

### 平台发现

- Mac：公开 `NSWorkspace.fullPathForApplication:` 的 LaunchServices 结果，读取实际 `NSBundle` 标识存在性与版本。不枚举 `/Applications`、用户目录、不运行 `mdfind`/`sips`、不使用 shell。该 selector 已 deprecated、仍由当前 SDK 提供；没有以名称拼出的路径冒充查找到应用。
- Windows：只读 HKCU/HKLM App Paths，分别查询 64/32 位 registry view，Explorer 路径取 OS `GetWindowsDirectoryW`，并确认实际文件。只接受 REG_SZ 的绝对 `.exe` 路径；不运行 `where`、PowerShell、不遍历 WindowsApps、不默认宣称 Terminal 已安装。未注册到 App Paths 的程序不属于本发现源，REG_EXPAND_SZ / 不可读 / 坏记录会明确失败并保 prior，不吞错转空成功。
- 图标提取未实现，现有 Header 使用其原始文字 initial fallback；不能称作 Web 图标视觉已对齐。Windows target / SDK / 注册表与系统 shell 均未实机验证。

## 原生 wire

manifest 精确授予以下五项，不增加 filesystem/network/shell grant。原 actor callback 沿用既有有界 mailbox；没有第二连接引擎。

| 方法 | 输入 | 输出 / 行为 |
| --- | --- | --- |
| `desktop.openInApps.capabilities` | `{}` | `{version:1,platform:"macos"|"windows",discovery:{supported:true,source:"workspace"|"app-paths"},selection:{supported:true,persistence:"process"},open:{supported:false,reason:"local_directory_mapping_unavailable"}}` |
| `desktop.openInApps.read` | `{}` | 当前完整快照，不启动发现；初始空列表、stale=true |
| `desktop.openInApps.scan` | `{}` | 唯一显式发现 trigger；忙时 reject，不另起扫描；成功返回完整快照 |
| `desktop.openInApps.select` | `{appID}` | 只接受当前已发现项；成功返回快照；未知项拒绝且保原偏好 |
| `desktop.openInApps.open` | `{appID,directory,expectedHost:{hostID,lease},intent:"open-current-directory"}` | exact native scope、参数、路径语法和 app 校验后，仍返回 `{status:"unsupported",reason:"local_directory_mapping_unavailable"}`；没有任何 launcher |

快照为 `{version:1,revision,apps:[{id,label,version?}],selectedID,scanning,stale,error:null|"discovery_failed"}`。revision 是 JS-safe 原生进程单调序号；迟到 read/scan 不覆盖更新的 selection。扫描失败保 apps/selectedID 并标 stale/error；成功空集合清 apps，但保 selectedID。错误不包含用户路径或系统错误原文。

open 无当前 native scope、错误 Host/lease、非显式 intent、未知 app、相对路径、`.`/`..` traversal、控制字符、UNC 或额外参数均拒绝。不读取 JS directory 对应文件、不做 SSH 命令、Relay 映射或 `openUrl(file:)` fallback。**合法路径字符串与匹配 lease 同样不足以授权。** v1 没有成功打开分支；未来必须先有原生签发、绑定真实本机 Host/目录/窗口/intent、可撤销的 mapping producer，再新增有测试的版本合同，不能把 v1 的 supported 改成 JS bool。

## Main 最小装配（本线程未改 main 消费文件）

1. 窗口根创建一次 `createNativeDesktopOpenInApps({current,target,copyPath,changed})`，不在 Header 弹层或输入 effect 中创建。`current` 是该根的生命周期；`target()` 返回**当前真实页面**的 `{scope,expectedHost,directory}`，没有目录、后台/模态/关窗 admission 关闭时返回 null。不能拿 panel 旧标签、首项目、hostID 命名或 OS 当前工作目录补目录。
2. `scope` 必须与既有 `DesktopChatHeaderIntent.scope` 是同一个窗口/route 身份；`expectedHost` 来自已有 captured native lease。该投影不是本机目录授权。
3. 根显式调用一次 `read()`，仅 capability + cached read，**不会 scan**。`changed` 更新独立 NSH signal，再向现有 Header 传 `owner.project()` 与 `owner.actions`；它返回既有 `DesktopChatHeaderResult`，不更改 Header action 协议。根需自行合并其它 actions。
4. `copyPath(directory,current)` 委托现有复制 owner；在真正 clipboard 调用前检查传入 current，不新增文件访问。scan 只由既有 `scan-apps` 显式动作触发，不在菜单 mount、时钟或 50 次输入更新中发现。主根销毁调用 `dispose()`，不自动重试/重放。
5. `project().selectedID` 已处理 Web 的 primary fallback。`select-app` 更新选择后返回 unsupported：选择已确认，但 Web 的后续 open 没有安全 native mapping；不能把它报告为 opened/accepted。
6. **当前 `project().applicable` 固定 false，`actions['open-app'].available` 固定 false。** 与 Web remote-without-handoff 分支一致，主根不得把目录非空、catalog 已读或 manifest grant 当成 applicable=true。只读 producer 可以先接线，不能为了展示 scan 菜单额外添加设置入口。实际产品打开能力依旧阻塞。

`read()` 同飞合并；同窗 scan 同飞合并、native 再做进程级互斥。动作在派发前/await 后复验 captured scope/Host/lease/实际目录/调用方 current；迟到结果不发布到新页面。设备扫描本身可完成并更新 native 设备 catalog，它不持有 Host 目录权限。`project()` 对 50 次无关更新返回同一对象与 app 数组，不做 I/O。

## 验证与缺项

- TS focused 14 项：原生 schema、Web 候选/manifest、零自动扫描与 50 次稳定投影、scan 单飞、失败 prior、空成功、未知偏好、selection revision 乱序/未知回执不重放、Host/lease/route/目录退休、copy exact directory、同步失败后可显式重试。
- Rust focused 5 项：真实 HostReply / QuickJS 的 worker 单飞与扫描期间只读、产品 manifest → 原 installed actor / capability / read、零 Vault/Network、失败 prior、空成功、选择及所有 open fail-closed 路径。均为 synthetic scanner/路径，无真实发现、Applaunch、用户目录/账号网络/凭据访问。
- macOS `desktop:check` 与 package TypeScript `tsc --noEmit` 通过。NSH CLI 不在 PATH，本轮没有生成新 bundle 或运行 UI。
- `bun run dead-code` 已尝试，因既有 `packages/web/vite.config.ts` 缺少 `vite-plugin-pwa` 无法加载而中止；未安装依赖、未修无关配置。
- 未验：实际已安装 catalog、系统打开、原生图标、选择跨重启、Main 装配、Windows target/SDK/OS、Mac/Win 同状态截图与完整 1:1。不能据此签收 Header OpenInApps 完成功能或整桌面 parity。
