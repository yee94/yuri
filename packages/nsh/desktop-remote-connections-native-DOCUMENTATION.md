# Native SSH loader / root handoff

## 真实生产端口

`desktop-remote-connections-native.ts` 的 `loadNativeDesktopRemoteConnections({ current, runtimeReady })` 返回
`Promise<NativeDesktopRemoteConnectionsPort | undefined>`。只调用真实 `nsh.host.available()` 和
`host.call('desktop.ssh.capabilities', {}, { timeout: 5000 })`；不读取 registry、Vault 或凭据，不发起 SSH。
`current` 必须代表这个窗口的本机 Host/source owner，而不是当前选中远端 Host、设置页 active 或模态状态。
`runtimeReady` 是可恢复的 bootstrap/运行准入；缺失或 false 都 fail closed。不要把它合入单调退休的 current。

返回值严格要求 Rust `native_ssh_bridge.rs` 的完整 exact DTO：

```ts
{ version: 1, connections: { supported: true, phase: 'ready', maxPending: 16 }, sync: { supported: false } }
```

拒绝、缺失/额外字段、其它版本、starting/stopping/stopped/failed/unsupported、sync:true 均不给端口。
不根据 manifest、平台、窗口 API 或成功编译猜可用。Host owner 负责真实 manifest grant 与 Windows unsupported。
loader 自身没有 timer，也不重新安装 controller；controller 在已有只读 refresh lane 复验 capability。
bootstrap/available 暂停只撤销 ready 并保留 prior、dirty/pending；恢复必须重新读取 capability，不沿用旧 supported。
首次启动未就绪时返回 undefined，由主根保留原 unavailable fallback。

## 每窗口创建一次

```ts
import { loadNativeDesktopRemoteConnections } from './desktop-remote-connections-native';
import type { NativeDesktopRemoteConnectionsPort } from './desktop-remote-connections-native-core';
import { createDesktopConnectionOnlyRemoteConnections } from './desktop-remote-connections';

let nativePort: NativeDesktopRemoteConnectionsPort | undefined;
let remote: ReturnType<typeof createDesktopConnectionOnlyRemoteConnections> | undefined;
let alive = true;
cleanup(() => {
  alive = false;
  remote?.dispose();
  nativePort?.dispose(); // 幂等；wrapper.dispose 已同时释放 controller 与 port。
});
void loadNativeDesktopRemoteConnections({ current: () => alive, runtimeReady: () => bootstrapReady() }).then(port => {
  if (!alive) { port?.dispose(); return; }
  if (!port) return; // Keep existing Settings unavailable fallback; don't hide the feature.
  nativePort = port;
  remote = createDesktopConnectionOnlyRemoteConnections(port);
  remoteConnectionsSlot.set(remote.slot); // Existing narrow root-owned signal/slot.
});
```

`SettingsRoot.remoteConnections` 消费上述唯一 `remote.slot`，不在 render/effect/route 回调重建 owner。
设置隐藏/切页仅改变现有 slot context.active；dirty/pending 继续交原 Settings publisher/guard，
不能把 current 绑定页面需求。完整根 teardown 同时 dispose controller 与 port；此处不增加 native shutdown API。
wrapper 的 `refreshCapabilities(): Promise<boolean>` 委托同一个 controller；端口另提供 `ready(): boolean`、
`refreshCapabilities(): Promise<void>`，都不重建 controller 或清掉已有表单。
原生 SSH 服务和最终关闭屏障仍由 Host owner 持有。application 已在窗口根进行一次真实 loader discovery、创建唯一 controller，并以响应式 getter 将 slot 交 SettingsRoot；loader 不支持时仍保留原 unavailable fallback。窗口 lifetime 是 current，前台生命周期/最终关闭状态是可恢复 runtimeReady；不使用当前远端 Host 或 Settings 是否打开作为 source 身份。实际 SSH、凭据和系统窗口仍未验。

## 冻结 DTO 与安全语义

- `read({})`；`save({requestID,revision,instance})`；`remove({requestID,revision,id})`；
  `start({requestID,id,intent:'connect'|'restore'|'check'})`；`cancel({id,attempt})`，实际方法均为 `desktop.ssh.*`。
  不注入 windowID、Host scope、path、credential 或未知字段；输入先校验，响应复用现有 exact snapshot validator。
- 本冻结 capability 不签发 native windowID。因此每个 JS/window owner 使用 CSPRNG UUID namespace + 单调计数，
  标识符不含机器路径/secret，不以猜测的 native window 身份授权。没有 crypto 时不签发端口。
- 捕获实际 source 对象及 call/available 方法，调用前后复验 current/source/runtimeReady/available。
  source/owner 退休永久失效；bootstrap/available 撤销单独的 operation epoch，恢复新 grant 后也不采用旧 ACK。
- 仅 SDK `ERR_NSH_HOST_ERROR` 的精确 `ssh_invalid/stale/busy/storage/authentication`（service 已确认 Denied）
  及原 actor mailbox `native_host_busy` 可转换 `DesktopSshDenied`。
  桥把 `Outcome::Denied/Unknown` 压平，`ssh_cancelled/unavailable` 在不同阶段含义不唯一，不能当作未提交。
  timeout、掉 ACK、坏/缺 receipt、未知错误都保 unknown；read 失败不返回空 snapshot，未知 mutation 只读核验原 receipt。
- 返回端口只有 `syncSupported:false`，**没有任何 sync 方法或虚构 HTTP seam**。
  controller 核心拒绝 preview/apply/status/history；UI 保留 Web 同步方向、范围与历史入口，禁用并显示现有十语「不可用」。
  旧显式注入的完整测试端口仍使用原 seam，不代表生产 sync 已支持。

## 验证边界

`desktop-remote-connections-native.test.ts` 用严格、只含 metadata 的 fake 校验真实 Rust DTO、cap 拒绝/partial/late、
source/owner 永久退休、五个连接动作、Denied/Unknown mapping、坏回执、失败读取保留 prior、receipt 只读恢复与 ID 隔离。

`desktop-remote-connections-native-engine.test.ts` 需 `NSH_REMOTE_CONNECTIONS_NATIVE_ENGINE=1` 与真实 `NSH_BIN`。
每场景创建独立临时 `nsh.json`/入口/Host/test 目录，不使用项目 `.nsh/test`。
真实 NSH loader + controller + Settings publisher + slot 在 macOS/Windows headless 覆盖连接-only、dirty/pending 隐藏保留、
sync 禁用/零派发、unknown 回执、失败读取和只读恢复；另覆盖原生 cap 拒绝、partial 与 root 退休后晚到 cap。

这不是 Rust HostChannel 垂直回归、真实 SSH、Vault/系统凭据、真实 Host 写入、AppKit/Win32 窗口、物理键盘、
Windows OpenSSH provenance 或完整同步验收。本 slice 不接触这些真实资源。
