# Native remote desktop：协议、接线与验收

> 更新：文末“fixture bundle alias 修复”记录后续 main 联调与验证。前部是本线初次交付快照；main 已报告完成页面/入口/capabilities 接线，Swift transport 由另一线负责，不能把前部待接事项视为当前全局进度。

## 结论（2026-11-07）

已新增独立 NSH 原生页面、page-owner 状态边界、Swift JPEG 接收/解码/ACK/输入/重连实现，以及独占 synthetic fixture。**尚未端到端可用，不能标记完整 Native 还原完成**：main 尚需接入 Swift transport、handle capabilities、workspace/Projects 入口与全屏路由；当前 Native Relay 只有 HTTP/SSE，没有可复用的 WS 子流；Native WebRTC 也尚未接入。所有缺口仍在全量 scope，不以删入口或 WebView 替代。

遵从 main 的设备验收窗口：本线没有运行任何 NSH CLI、engine/headless UI 测试、生产 App 构建、iOS 构建、模拟器、浏览器、服务或真实桌面操作；没有读取凭据、请求系统权限或更改 Host 设置。没有执行 git/GitHub、增加依赖或调用付费 CLI。工具检索未发现子代理派发接口，因此未能再派下层 explore，协议核对由本线只读完成。

## 只读协议证据

| 事项 | 当前源码依据及行为 |
| --- | --- |
| 入口/页面 | `packages/ui/src/mobile/RemoteDesktopPanel.tsx`：Projects 加号菜单与聊天 workspace 菜单使用同一当前 runtime 的独立全屏页面；返回保留源 Tab/Chat，不是 sheet |
| 能力 | `packages/web/server/lib/remote-desktop/runtime.js`：`GET /api/remote-desktop` → `{supported,enabled}`；仅真正支持的 Electron Host 可捕获；本地设置默认关闭 |
| 认证 | 同文件 upgrade：exact `/api/remote-desktop/ws`，paired client 或启用密码认证的 owner；origin 仍校验；disabled=403、unsupported=501、occupied=409；无 loopback 信任旁路 |
| Relay | `packages/web/server/lib/relay/tunnel-host.js`：exact WS allowlist，先校验当前 Relay pairing grant，再 loopback upgrade；dial origin 由 Host 决定。不能以原生 SSH/owner/direct-only 凭据冒充 Relay pairing |
| URL auth | `packages/ui/src/lib/runtime-auth.ts`：通过当前认证 transport `POST /auth/url-token`；浏览器/Relay WS 使用短时 scoped `yuri_url_token`。Host WS dial 不转发任意客户端 Authorization，不可把长效 bearer 放进 URL |
| 信令 | `packages/ui/src/lib/remote-desktop/connection.ts`：`ready`/`offer`/`ice`/`rtc-failed`/`error`，客户端 `answer`/`ice`；WebRTC 不可用时发 `fallback` |
| JPEG | 二进制 JPEG ≤512 KiB，只有一个 outstanding frame，接收端**图像解码后**发 `{type:'ack'}`；默认最高约 12fps、1440×900，zoom profile 最高 2560×1440/4fps。静态帧可被 Host 完全抑制，不能以“长时间没有新 JPEG”单独判掉线 |
| 输入 | `packages/web/server/lib/remote-desktop/protocol.js`：unit pointer 坐标；move/down/up/click/right；scroll ±1000；text ≤1024 UTF-16 units；固定 navigation key；release；没有任意 shell/keycode/file/clipboard 协议 |
| Zoom | 仅 `ready.zoomQuality === true` 后发送 `{type:'view',zoomed:boolean}`；1.05/1.01 hysteresis，只发状态变化，旧 Host 不发 |
| 生命周期 | client ping 5s，Host 20s ping timeout，revocation 每5s复查；一个 Host 只有一个 pending/active session；最长1h；关闭/后台/切 Host 必须释放 |
| 重连 | `connection.ts`：1–30s 指数退避；仅解码帧恢复健康；permission_required 60s、offline 60s；disabled/unsupported/helper_unavailable/authentication_required/permission_denied/runtime_changed 停止自动恢复；输入不重播 |
| 手势 | `packages/ui/src/lib/remote-desktop/gestures.ts`：Drag 默认只本地平移、双击缩放/Fit；Cursor 点击/双击原生点击、拖动按住鼠标、长按右键；双指只本地缩放/平移，打断 remote drag 时 release，letterbox 不映射成输入 |
| 旋转 | `orientation.ts`/`useDesktopOrientation.ts`：仅页面手动方向、逆向坐标与 safe-area 映射；不监听设备方向、不修改全局 orientation、不因键盘/resize重连 |

最近 owning docs 已读：root `AGENTS.md`、`packages/nsh/README.md` / `DOCUMENTATION.md`、`packages/web/README.md`、Web `remote-desktop/DOCUMENTATION.md` / `relay/DOCUMENTATION.md`、shared sync 文档与匹配 skills/reference。

Context7 已 resolve `/longbridge/nsh` 并查官方 Image/host/touch/transform/transition/testing 文档。当前安装的 NSH 0.4 声明是最终 API 依据：

- `onLayout` 使用 `event.bounds.size`，不是新版示例的扁平 width/height。
- `pointerEvents` 位于 `style`，不是当前 `ViewProps` 顶层字段。
- `Image.onLoad`、`host.on`、原始 touch、`ViewRef.measure`、transform、transition、根导出的 `reduceMotion()` 均在本地声明中可用。
- 本地 `packages/nsh/.nsh/types/nsh/*.d.ts` 未发现 WebRTC / RTCPeerConnection / RTCVideo / MediaStream / PeerConnection 导出。不能据此生成假的原生 peer；没有添加 WebRTC 依赖，也没有使用 WebView。

## 新增文件与所有权

| 文件 | 职责 |
| --- | --- |
| `remote-desktop.tsx` | `NativeRemoteDesktopPage`，NSH View/Image/Button/Input、五个浮动玻璃按钮、键盘 footer、原生触控与页面手动旋转 |
| `remote-desktop-core.ts` | owner/scope fence、可见性、frame/ACK、输入结果与失败边界；不持有地址/凭据/socket |
| `remote-desktop-geometry.ts` | 页面旋转的逆坐标、逻辑尺寸和 safe-area 纯函数 |
| `ios/RemoteDesktopBridge.swift` | 注入式原生 transport、受限消息词汇、JPEG 校验和解码、ACK门控、串行输入、ping/超时/重连/后台清理 |
| `remote-desktop-core.test.ts` | 纯 TS 协议与生命周期测试，不导入 NSH runtime |
| `tests/remote-desktop/*` | 独立 capability 配置和纯 synthetic 原生页面 fixture，无真实 Host/屏幕/输入 |
| `remote-desktop-ui.test.ts` | 显式 opt-in 的 engine UI 测试，**本线未运行** |
| `tests/remote-desktop-types.tsconfig.json` | 只检查本线 TSX/core/geometry/fixture 的 TypeScript 配置 |

没有修改 application/state/chat-header/settings/projects/assistants/schedules/speech/resources、已有 iOS 文件或全局 DOC/PARITY。

NSH 手势直接调用既有 Web `createDesktopGestures`，没有复制一套阈值/算法。触点以 surface page coordinates 进入 page-local 逆旋转；每个合并 move 一次 `moveMany`，不在 move 中 measure。手势只更新页面局部 signals，不订阅全局 chat/catalog。Fit/double-tap 使用原生180ms transform transition，reduceMotion 时关闭。

## main 接线：JS

```tsx
import { NativeRemoteDesktopPage } from './remote-desktop';

// route 必须在源 Tab/Chat 之上全屏承载，覆盖 dock/composer。
// scopeKey 必须包含 Host + transport/generation；不能仅使用稳定 connection.id。
<NativeRemoteDesktopPage
  scopeKey={capturedTransportScopeKey}
  active={isRemoteDesktopRouteVisible}
  onClose={returnToUnchangedSourceRoute}
/>
```

要求：

1. 保留/实现 workspace 菜单的真实远程桌面入口，同时接 Projects 的同一入口；不能删入口“对齐”。
2. route push/pop、系统 Back/返回手势由 main 的原生导航协调。卸载触发 session.dispose；不能使源 Chat/draft 重新创建。
3. 关闭/后台传 `active=false`，切 Host/transport 变更 `scopeKey`。一旦范围变化，此页终止并显示 runtimeChanged，必须关闭重开，不悄悄连到另一 Host。
4. 页面只读能力并显示本地开启/权限指导，不远程修改 Host enable 或触发 macOS 权限请求。
5. `packages/nsh/tsconfig.json` 当前 lib 缺 `DOM.Iterable`；直接复用共享 gestures 的 type-only connection 依赖会使 `runtime-url.ts` 的 `URLSearchParams.entries()` 在 package tsc 下报错。本线的独占 types 配置已加 `DOM.Iterable`，main 做生产接线时需同步该 compiler lib（不是新依赖），或统一处理该静态类型边界。

## main 接线：Swift / native transport

新增文件在现有 build-ios 脚本的 `ios/*.swift` 扫描范围内，无需新增依赖。main 保持实例强引用：

```swift
let remoteDesktop = RemoteDesktopBridge(app: surface, capture: { [weak bridge] in
    guard let bridge else { throw CancellationError() }
    return try bridge.remoteDesktopTransport() // main 在 RuntimeBridge 内实现此 captured seam
})
self.remoteDesktop = remoteDesktop
// 加入已有 onInvalidate 链，不能覆盖 resources/appearance/speech 等释放：
// remoteDesktop.invalidate()
```

`remoteDesktopTransport()` 是**待 main 实现**的 RuntimeBridge seam；本线未伪造它存在。其返回类型和职责已由新增 Swift 文件定义：

```swift
@MainActor struct RemoteDesktopTransport {
    let capability: () async throws -> (status: Int, body: [String: Any])
    let open: () async throws -> RemoteDesktopSocket
    let isCurrent: () -> Bool
}
@MainActor struct RemoteDesktopSocket {
    let receive: () async throws -> RemoteDesktopWireMessage
    let send: (String) async throws -> Void
    let close: () -> Void
}
enum RemoteDesktopWireMessage {
    case text(String), binary(Data), closed(Int)
}
```

- 在 RuntimeBridge 内捕获 `selected connection + generation`，用现有 makeRequest/scopedJSON/resource owner 认证边界完成 exact GET 能力；`isCurrent` 同时检查 Host 和 generation。
- `open` 每次创建新 WS attempt，遵守已存在的认证、origin 和 redirect 拒绝策略；短时 URL auth 经当前 runtime/Relay 的 `POST /auth/url-token` 获得。不得将长效 bearer 返回 JS、写 URL、日志或普通 Storage。
- **Relay 必须复用同一既有 E2EE tunnel**。当前 `RelayTunnel.swift` 的 `request/stream` 只有 HTTP/SSE，`handle` 明确不开放 tunneled WS；需要由 main 补真实 WsOpen/WsOpened/WsMessage/WsClose 及既有 fragmentation/reassembly。不能新开 feature-owned Relay 连接、改加密/帧协议或绕到 direct Host。
- `ResourceTransport.read` 当前只 allowlist fs stat/serve，不能把桌面 WS 或 auth 路由塞进文件读取路径。
- transport 限制：incoming message ≤512 KiB，outgoing ≤96 KiB；有界队列；保留 text/binary 消息边界；断连/错误必须 reject 或返回 closed，不能装空成功。cancel/close 必须中止 pending receive 和 upgrade；迟到 socket 由桥关闭。
- Relay WS upgrade 的拒绝/revocation须保留：401/4001映射 `RemoteDesktopBridgeFailure(code:"authentication_required")`；501→unsupported；disabled→disabled。409/网络中断可重试。不要将认证失败伪装成无限快速重试。

### 注册名与消息

构造 `RemoteDesktopBridge` 即注册五个 handle。main 在生产 `nsh.json.capabilities.host` 增加：

```text
remoteDesktop.open
remoteDesktop.close
remoteDesktop.input
remoteDesktop.view
remoteDesktop.ack
```

共 **5 个 handle**（open/close/input/view/ack），不是额外通用 socket API；`remoteDesktop.event` 是 Host → JS event，不是 call capability。不要开放任意路径/URL/credential 参数。

| call/event | shape |
| --- | --- |
| open | `{owner:"desktop-N",zoomed:boolean}` → true，后续状态由 event 发出 |
| close | `{owner}` → true，陈旧 owner 不能关掉新 owner |
| input | `{owner,input:{type,...}}` → true 仅表示已交给本次 socket；不保证远端原生事件执行，不自动重播 |
| view | `{owner,zoomed:boolean}`，Swift 在 ready 协商后才发送 Host view 消息，重连只恢复最新状态 |
| ack | `{owner,frame:number}`，NSH Image.onLoad 后调用；错误/旧帧不 ACK |
| event state | `remoteDesktop.event` `{owner,type:"state",phase:"connecting"\|"live"\|"closed"\|"paused",code?}` |
| event frame | `{owner,type:"frame",frame,source:"data:image/jpeg;base64,...",width,height}`；无凭据/远端 URL |

### 当前 Swift 行为

- capability 10s，socket/startup 60s，fallback 首帧/待 ACK 帧15s，接收 liveness30s，ping5s。
- 失败1/2/4/8/16/30s退避；permission_required/offline60s；NWPathMonitor 恢复在线可打断 retry wait；后台立即关闭且没有 retry traffic。
- 仅成功呈现 JPEG 的 ACK 重置 failure history；pong/open/ready 都不算恢复健康。永久权限拒绝/认证失败/禁用/不支持停自动恢复。
- ImageIO 只接受 JPEG，decode 前限制 dimensions≤2560、pixels≤2560×1440，源帧≤512KiB；不写图片文件；最多一帧待 ACK。NSH Image 再次加载本地内联 bytes，直到 onLoad 才 ACK Host。
- 输入白名单、unit coordinates、UTF-16 text上限、固定 keys、每秒128个 input、32个串行待发送命令；无 shell/clipboard/远端设置。切换/关闭/失败不重播输入，Host EOF负责释放 held mouse。
- Native WebRTC 无现有依赖支持，明确请求 Host 已有 compatibility stream。**这是真实 JPEG 路径，不等于已对齐 WebRTC 媒体能力**。

## 实际验证输出

仅执行以下纯 TS 命令（未调用 NSH_BIN）：

```sh
bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts packages/nsh/remote-desktop-core.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tests/remote-desktop-types.tsconfig.json
```

末次纯 TS 输出：

```text
Test Files  1 passed (1)
     Tests  29 passed (29)
Start at   14:13:23
Duration   169ms (transform 22ms, setup 0ms, import 31ms, tests 6ms, environment 0ms)
```

TypeScript（包括本线真实 TSX、共享手势调用和独立 fixture）退出0，无诊断。早期 tsc 发现并修正了 NSH 0.4 `bounds.size` / `style.pointerEvents` API 差异；独占 types 配置明确包含 DOM.Iterable。

单测覆盖：构造/隐藏零网络、单 owner、decode后单次ACK、旧帧/坏帧/过大帧、后台关闭与恢复新owner、transport切换终止、迟到open/input/close结果、永久错误不因前后台切换自动重试、失败不伪装成功、重连清理屏幕且不重放输入、120次相同zoom零额外view写入、输入边界及UTF-16、页面旋转/偏移/safe edges。

### main 的串行 UI fixture（未运行）

只有 main 结束设备独占窗口并显式允许后执行：

```sh
NSH_REMOTE_DESKTOP_UI_TESTS=1 bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts packages/nsh/remote-desktop-ui.test.ts
```

它只调用独立 `tests/remote-desktop/fixture.tsx` 和临时 synthetic Host，使用算法生成的16×9灰色JPEG；不加载生产 App.tsx，不捕获真实桌面、不发真实输入或模型/语音请求。默认 opt-in 关闭，因为 `nsh test` 也可能把 NshDev 拉到前台。

该 fixture 的3项 engine 测试仍待 main 运行并按实际失败修复：图像解码后控件可用，键盘/模式/旋转不重连；隐藏恢复/Host fence；输入失败保留文本、Back返回源页面。不能把写好测试称为已通过。

## 未完成 / 不得据静态测试声称通过

- [ ] main 的 authenticated direct + E2EE Relay WS transport 和注册接线。
- [ ] workspace 与 Projects 入口、真实全屏 native route、保留 Chat/draft、dock/composer遮盖、系统 Back。
- [ ] Swift 编译/typecheck、原生 bridge synthetic socket/解码/ACK/超时/退避/取消专项；本线没有运行 Swift 编译或 iOS build。
- [ ] 上述3项独占 engine fixture；真实 UIKit 的 Image加载、glass、键盘inset、手动旋转/安全区/触点逆映射、两指pinch、long press、拖动中断释放。
- [ ] 生产 Host 的本地禁用/拒绝/授权撤销、single-owner、权限重授、capture/display失败及真实 direct/Relay-only JPEG联调。不得在未经允许时操作真实桌面/权限/设置。
- [ ] Native WebRTC 媒体接收/硬件解码与能力对齐；不能以 compatibility stream 的可用性删掉此 scope。
- [ ] physical phone 帧耗时、双解码成本、峰值内存、长时间图片缓存、弱网/带宽/电量/延迟；当前仅有一帧/消息大小/命令数量的结构性上限，不是实测性能证据。
- [ ] main 串行 package/build/dead-code 验证。本线遵从“只纯 TS unit/tsc”窗口，没有跑全局 dead-code 或生产 build。

## 后续：fixture bundle alias 修复

main 首次串行运行3项 UI fixture，均在加载 `@/lib/touch-gestures/tap` 时失败。另线已把 `DesktopInput` 提取到 `remote-desktop/input.ts`，本线没有修改其 connection/input split。

最小改动仅一行：

```diff
--- packages/ui/src/lib/remote-desktop/gestures.ts
-import { LONG_PRESS_MS, TAP_MAX_MS, isDoubleTap } from '@/lib/touch-gestures/tap';
+import { LONG_PRESS_MS, TAP_MAX_MS, isDoubleTap } from '../touch-gestures/tap';
```

`tap.ts` 本身没有运行时 import 或顶层 DOM 操作，无需复制算法、修改阈值或再拆纯模块。这里修正的是 NSH 跨 package 不解析 `@/` 的实际打包边界，而非仅补 TypeScript paths。

按 main 追加授权，只构建独立 fixture（**不运行**）：在 `packages/nsh/tests/remote-desktop` 目录执行：

```sh
"$NSH_BIN" build fixture.tsx --out ../../.nsh/remote-ui-bundle
```

- 修改前实际退出1：`could not load module '@/lib/touch-gestures/tap' (only registered native modules and bundle chunks can be imported at run time)`。
- 修改后退出0：`built fixture.tsx into ../../.nsh/remote-ui-bundle (4.5 MB js, 2.7 MB bytecode, 101ms)`。
- TypeScript AST 检查真实产物 `packages/nsh/.nsh/remote-ui-bundle/bundle.js` 的静态 import/export 和动态 import，结果：

```json
{
  "runtimeImports": ["nsh:rt", "nsh", "nsh/base"],
  "unresolvedRuntimeImports": []
}
```

附加回归：

```sh
./node_modules/.bin/vitest run --project @yuriai/ui packages/ui/src/lib/remote-desktop/gestures.test.ts packages/ui/src/lib/touch-gestures/tap.test.ts
# Test Files 2 passed (2); Tests 23 passed (23); Duration 381ms

bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts packages/nsh/remote-desktop-core.test.ts
# Test Files 1 passed (1); Tests 29 passed (29); Duration 116ms

bunx --no-install tsc --noEmit --project packages/nsh/tests/remote-desktop-types.tsconfig.json
# exit 0，无诊断
```

最初用 bunx 隔离缓存运行 Web 回归时，runner 找不到仓库已有的 happy-dom、没有开始测试；改为仓库本地 `node_modules/.bin/vitest` 后23项全通过，没有安装任何依赖。

仍未重跑那3项 engine UI fixture；没有启动 engine test、iOS build、浏览器、模拟器或设备，也没有修改 main 独占的 RuntimeBridge/Relay。fixture-only bundle 无 unresolved imports 证明加载边界修复，不证明 UIKit 交互或真实 Relay 已通过；UI 重跑仍由 main 串行负责。

## 后续：frame 已挂载但始终 Connecting 的诊断与最小 probe

main 随后串行运行原3项 fixture，报告 frame 已 `shows`、但 keyboard 一直 disabled，界面停留 Connecting。这3项**仍未通过**，没有删除断言、手动注入 Image.onLoad/ACK 或把 frame mount 当作 decode。

### 直接框架证据

官方源码 `crates/nsh-testing/src/headless/mod.rs`：

> Images are not loaded: no `onLoad` comes, and `Image.getSize` / `Image.prefetch` fail.

- [headless 图像能力说明，274–276行](https://github.com/longbridge/nsh/blob/main/crates/nsh-testing/src/headless/mod.rs#L274-L276)
- [ImageInfo 的实际失败响应，874–882行](https://github.com/longbridge/nsh/blob/main/crates/nsh-testing/src/headless/mod.rs#L874-L882)：`headless runs load no images`。
- 静态读取用户指定的已安装 NSH 可执行文件，确认该诊断字面量确实存在：`headlessImageDiagnosticInInstalledNSH: true`。没有执行该二进制的 test/run 命令。
- Context7 官方 Image/图像实现文档区分了原生后台读取/ImageIO decode 与成功 `onLoad`；当前本地0.4声明的 payload 是 `event.size`，不是文档新版本示例的扁平 width/height。

这与 main 的现象一致：headless 保留 Image shadow node，所以 `shows(frame)` 成立；它没有真正加载图片，既不代表解码成功，也不能期待稍后产生 onLoad。增加固定等待不能补齐该能力。此处不能把 ACK 改成收到 frame/渲染节点/ready 后自动发送。

以上源码为当前官方主线，安装版本的**实际事件行为仍由 main 跑下面 probe 确认**；静态字面量存在不是已经执行成功的证据。Synthetic JPEG 是否同时存在原生兼容问题也未据此断言排除。

### main 先跑的最小 headless probe

新增文件：

- `tests/remote-desktop/image-probe.tsx`：只用真正的 NSH Image；并排 JPEG、经纯 TS 验证的1×1 PNG、故意坏掉的 JPEG，分别记录 onLoadStart/onLoad/onError/onLoadEnd、解码尺寸；另外调用 Image.getSize。
- `tests/remote-desktop/image-probe.steps.js`：输出全部事件计数，断言 load/error 均未派发且 Image.getSize 明确报告 headless 缺图像能力。
- `remote-desktop-image-probe.test.ts`：显式 opt-in 的独占 runner，没有生产 App、Host、桌面捕获、模型/语音、网络来源或任何 ACK。

main 从仓库根单独串行运行（本线没有执行）：

```sh
NSH_REMOTE_DESKTOP_IMAGE_PROBE=1 bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts packages/nsh/remote-desktop-image-probe.test.ts
```

也可在 `packages/nsh/tests/remote-desktop` 目录直接执行同一个 probe：

```sh
"$NSH_BIN" test image-probe.tsx < image-probe.steps.js
```

可观测 ID：`probe-jpeg-events/detail`、`probe-png-events/detail`、`probe-broken-events/detail`、`probe-get-size-result`。脚本先输出 `[remote-image-probe-before-size-result]`，再输出 `[remote-image-probe]`；没有 catch/忽略失败断言。这个诊断即使通过，也**不是原3项功能验收变绿**。

解释结果：

| 结果 | 下一步 |
| --- | --- |
| 三张图无 load/error；getSize 报 headless 无 images | 确认当前 headless 缺解码，不能在这个 renderer 上验收 decode→ACK→live |
| PNG 成功而 JPEG 报 error | 原生 JPEG fixture 兼容问题仍需修；不可放宽 ACK |
| JPEG/PNG 均真实 onLoad，但生产页面仍 pending | 再查帧 owner/object identity、ACK bridge 与 live event；不能预先归因于等待时间 |

后续 main **明确允许真实 native renderer** 时，提供了不依赖自定义 Host 的 `image-probe-native.steps.js`：等待 PNG/JPEG 实际 onLoad、校验 source size，要求坏图真实 onError，并要求 getSize 成功。只能由 main 显式使用原生 target 后执行；本线未运行，不是当前窗口的自动动作。

### 测试修正边界

- 原3项验收保留全部功能断言。将“frame mount + 固定100ms”替换为等待 `remote-desktop-controls-live`；隐藏恢复也等待真实 live，而不是固定200ms。headless 缺解码时应继续明确失败，不能伪绿。
- 生产页面只新增了 controls 的 `remote-desktop-controls-live/pending` testID；Image.onLoad→session.decoded→Swift ACK→live 合约完全未改。
- JPEG bytes 提取到 fixture-only `remote-desktop-fixture-images.ts`，与原算法生成的字节逐字节相等；没有把换图片当作已修复。
- PNG control 的每个 chunk CRC、完整RGBA scanline 由纯 TS 校验。它证明控制样本结构有效，不证明 UIKit/JPEG 已经解码。

### 本线实际运行的检查

```text
Pure Vitest: Test Files 2 passed (2), Tests 32 passed (32), Duration 559ms
TypeScript: exit 0，无诊断
image-probe.tsx build: 5.1 KB js, 11.2 KB bytecode, 29ms
fixture.tsx build: 4.5 MB js, 2.7 MB bytecode, 73ms
两份真实 bundle AST: imports=[nsh:rt,nsh,nsh/base], unresolved=[]
```

没有执行 Image probe、原3项 engine test、真实 native target、iOS build、浏览器、模拟器或设备。原3项仍待具有真实 Image decoder 的正确验收 seam；不能拿32项 pure test、bundle 成功或 headless 诊断结果代替。

## 后续：独立、无网络 UIKit 夹具 app（已构建，未安装/运行）

main 确认 headless 图像能力限制后，明确授权构建独立 UIKit app。本线新增：

- `tests/remote-desktop/uikit-main.swift`：仅 UIKit + NativeShell 的 synthetic Host。
- `scripts/build-remote-desktop-uikit.mjs`：参考 history fixture，**只编译这个新增 Swift 文件**；不扫描生产 `ios/`，不导入 RuntimeBridge/Relay/ConnectionStore/Keychain。
- 继续复用 `tests/remote-desktop/fixture.tsx` 和真实 `NativeRemoteDesktopPage`。fixture 顶部新增 UIKit-only 的 `Fail next input` / `Reopen page`，计数使用 JS Text 的 AX label 显示。

### 构建命令与隔离

预先设置现有 `NSH_BIN`（可选 `NSH_DIST`），从仓库根运行：

```sh
node packages/nsh/scripts/build-remote-desktop-uikit.mjs
node packages/nsh/scripts/build-remote-desktop-uikit.mjs --image-probe
# 如只需字节码，不编译 Swift：追加 --bundle-only。
```

每次构建新建 `.nsh/remote-desktop-uikit/<timestamp-UUID>/`，没有 rm/覆盖旧 app、生产产物或 history 产物。构建使用此目录内生成的 **project/App.tsx 包装入口**，导入对应 fixture；不是生产 `packages/nsh/App.tsx`。不执行 simctl、安装、启动、录像或设备命令。

已生成以下实际产物，路径均以 `packages/nsh/` 为基准：

| 模式 / bundle ID | 已构建的 app |
| --- | --- |
| 远程桌面 / `example.yuri.remote-desktop-uikit` | `.nsh/remote-desktop-uikit/2026-11-07T07-01-14-776Z-1ebbdd36/RemoteDesktopUIKitFixture.app` |
| 图像 primitive probe / `example.yuri.remote-desktop-image-probe` | `.nsh/remote-desktop-uikit/2026-11-07T07-01-29-269Z-05f39ec9/RemoteImageUIKitProbe.app` |

app 与 history/生产应用使用不同 bundle ID。各目录的 `fixture-build.json` 明确记录 entry、唯一 Swift source、capabilities、`installed:false` / `launched:false`。这些 app 是 arm64 simulator、ad-hoc QA 产物，不是发布/真机安装包。

### synthetic Swift Host 的实际行为

- 构造时由 UIKit 将固定320×180中性灰 bitmap 编成 JPEG，最多512KiB。不读屏、不读取图片/凭据/连接、不加载外部 URL、不发送 OS 输入、不调用语音或模型。
- 注册 `remoteDesktop.open/close/input/view/ack` 与 fixture-only `runtime.request`。
- `open` 创建 owner，发 connecting；80ms后仍属同一 owner 才发送单张真实 JPEG frame。
- **发送 frame、生成 JPEG、计时结束、收到 view/input 都不能变 live。** 唯一 live 分支位于 `remoteDesktop.ack`，且检查当前 owner、pending frame=1、尚未 ACK。
- JS 使用生产 Image 组件，只有真实 `Image.onLoad` 才走 `session.decoded → remoteDesktop.ack`。没有手动发 Image event，没有定时 ACK、没有用 Swift 已编码成功代替 JS Image 解码。
- `close` 取消 pending frame 并清 owner。旧 owner 不能结束新 owner。
- 输入只计数，完全不注入桌面；`Fail next input` 使下一条 input 显式失败，随后由生产 session 逻辑处理关闭/草稿保留。
- `runtime.request` 仅识别本地 fixture 路由：`GET /api/fixture/desktop` 读计数，`POST /api/fixture/desktop/fail-next-input` 设置一次失败。名称不是一个 HTTP transport，没有转发逻辑。
- 真正构建产物的 network/fs/process capabilities 全为空。脚本链接的 Security/Network/WebKit 等是 NativeShell 所需链接依赖，fixture 没有调用其凭据/网络/WebView API。

### main 的 AX 接口

主夹具会自动订阅 `fixture.desktop.counters`；无需轮询真实服务。以下 Text 都有同名 testID，label 为完整内容：

| AX ID | 内容 |
| --- | --- |
| `fixture-snapshot` | JSON：`synthetic, opens, closes, frames, acks, inputs, views, live, pendingFrame, owner, inputFailures, pointers, releases, textUnits, lastInput, failNextInput, zoomed, width, height` |
| `fixture-source-state` | `fixture active=true/false closed=true/false scope=fixture:host:N` |
| `remote-desktop-uikit-native-error` | 仅 native/bundle 故障时出现；出现即失败，不是正常断连提示 |

计数解释：`frames` 只代表已发图，不代表已解码。`acks` 只在真实 JS ACK 被 Host 接受时增加；`live:true` 必须伴随当前 owner 的成功 ACK。`inputs` 包含失败尝试，`inputFailures` 标记注入失败；只记录 UTF-16 `textUnits`，不显示/记录输入正文。默认第一次正常就绪应为 opens=frames=acks=1、live=true、pendingFrame=null、inputs=views=0。

fixture 操作 ID：

| AX ID | 操作 |
| --- | --- |
| `fixture-hide` / `fixture-show` | 页面 active false/true，覆盖关闭/新 owner 恢复 |
| `fixture-host` | 改 scope 为 `fixture:host:2`；当前页面必须终止，不自动 open 下一 Host |
| `fixture-inspect` | 从 synthetic Swift Host 读取当前 JSON 计数 |
| `fixture-fail-input` | 设置下一条 input 失败，JSON 的 failNextInput=true |
| `fixture-reopen` | 真正卸载原页，50ms后重新挂载新 page-owner；用于 Host fence/Back 后继续独立验收 |

生产控件 ID 保持原样：`remote-desktop-back/rotate/drag/cursor/keyboard/text/send/key-Enter` 等。`remote-desktop-controls-live/pending` 是 View 状态标记；AX 若不列普通容器，使用 `fixture-snapshot.live` + `remote-desktop-keyboard` enabled 共同判断，不能仅用 frame 节点是否存在。

### 建议 main 在独立 QA 模拟器串行检查的步骤（未执行）

1. 安装/启动远程桌面 QA app 后，等 `acks=1,live=true`、keyboard enabled。若只有 frames=1/acks=0，保持失败并检查真实 Image callback，不补假 ACK。
2. Cursor → Keyboard → 点 text 并输入固定测试文字 → Send → Enter：输入清空、inputs依次增加；Keyboard/模式/Rotate不能增加 opens。旋转应关闭 footer，不能重连或改其他页面/系统方向。
3. Hide 后 closes+1、live=false；Show 后 opens/frames/acks各+1且换 owner。Host fence 后 closes+1，opens不能增加；页面显示 runtimeChanged。Reopen 才可创建新 owner。
4. Fail next input → 开键盘输入 → Send：inputFailures+1、failNextInput=false、页面失败但文字保留；仅重连不能重播 input。实际再次手动 Send 才能再增加 inputs。Back 返回 `Source page retained`。
5. Drag 双击/Pinch的本地缩放只在阈值变化时增加 views；Cursor/Drag切换不能重连。断开/隐藏拖动时可由 releases/pointers计数辅助检查；固定灰色图不代表真实桌面动作。

此 Host 不负责窗口键盘避让或特殊 orientation 修补：UIKit embed 与生产同为全尺寸 surface，不能为了夹具通过而隐藏真实布局问题。fixture 顶部有额外 QA chrome，不作为生产页面像素/安全区还原证据。

图像 probe app 的 AX 同上节：JPEG/PNG/坏图的 `probe-*-events/detail` 和 `probe-get-size-result`，`probe-get-size` 触发真实 Image.getSize。它不需要 web-hostJS，也不调用 remoteDesktop handles。main 可依照 `image-probe-native.steps.js` 的原生断言逐项验收，但这些步骤尚未运行。

### 本次实际检查与保留边界

```text
远程桌面 fixture: NSH release bundle + 独立 Swift simulator compile + ad-hoc codesign 成功
image probe: NSH release bundle + 同一独立 Swift simulator compile + ad-hoc codesign 成功
两份 app: codesign --verify --deep --strict 退出0
build script: node --check 退出0
TypeScript: 退出0
Pure Vitest: 2 files / 32 tests passed，264ms
两份真实 bundle AST: imports=[nsh:rt,nsh,nsh/base]，无 unresolved imports
两份真实 capabilities: network.hosts=[]，network.http=[]，fs.read/write=[]，process.execute=[]
installed=false，launched=false
```

**headless 原3项 decoded 功能断言未删、未绕过；在无 decoder 的 headless seam 上失败是合理边界。** 正确的 UIKit app 已构建，但 main 尚需实际安装/启动、AX交互、验证 JPEG→onLoad→ACK→live。构建成功不证明这些交互已通过，更不证明生产 RuntimeBridge/Relay、真实桌面、吞吐/内存/延迟或平台权限已验收。
