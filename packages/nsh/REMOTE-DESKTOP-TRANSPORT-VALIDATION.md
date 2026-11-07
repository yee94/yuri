# Native remote desktop transport

## 结论（2026-11-07）

`RuntimeBridge.remoteDesktopTransport()` 已实现真实 direct 与同一 E2EE Relay tunnel 的原生传输。macOS Swift contract/native fixture 与既有 HTTP/SSE/Relay 回归通过。**这不等于 iOS 页面、真实配对部署或真实桌面已经验收。**

本线没有改 `main.swift`、`RemoteDesktopBridge.swift`、`ConnectionStore`、speech/resources 实现或 JS 页面/header；没有运行 NSH CLI/engine UI、iOS build、模拟器或浏览器，没有访问真实 Host、凭据、桌面、模型、系统权限或设置。仅启动并清理本线随机 loopback 端口的无真实凭据 fixture；未操作已有服务器。未执行 git/GitHub 或增加依赖。

## main 可直接消费的 API

```swift
@MainActor
func remoteDesktopTransport() throws -> RemoteDesktopTransport
```

返回既有 `RemoteDesktopBridge.swift` 定义的 seam，类型没有改动：

- `capability()`：当前捕获连接认证的 exact `GET /api/remote-desktop`，返回 `(status, body)`，失败抛错，不把 HTML/空响应/取消伪装为能力成功。
- `open()`：exact `/api/remote-desktop/ws`，返回保留 text/binary/close 消息边界的 `RemoteDesktopSocket`。
- `isCurrent()`：同时校验 captured selected Host ID 与 RuntimeBridge generation。切换离开又回到同一 ID 仍不能复用旧 owner。
- `receive()` / `send(String)` / `close()`：有界、取消感知、关闭幂等。`close()` 立即标记本地 lease 失效，不允许 Relay 异步 EOF 的调度间隙再发输入。

main 负责在 `ios/main.swift` 创建 `RemoteDesktopBridge(app:capture:)` 并链式调用 `invalidate()`，注册五个 capabilities，完成 JS 入口/全屏 route。末次只读检查已看到 main 的 capture/invalidate 接线；本线不核定其余并行工作的最终完成状态，也不代替 main 验收，没有扩宽 `ResourceTransport.read` 的 fs allowlist。

## 安全、协议与生命周期

| 边界 | 实现 |
| --- | --- |
| direct | 使用现有 `makeRequest` 的同源/凭据校验与 Authorization header；Origin 是所选 HTTP(S) Host origin，非 JS/WebView origin；URL 无 bearer，也不需要 URL token |
| direct URLSession | ephemeral、无 cookies/cache、系统默认 TLS 验证；delegate 拒绝 redirect；`didOpenWithProtocol` 后才完成 open；保留 URLSession logical message boundaries |
| Relay 连接所有权 | capability、URL-token mint、WS 共享现有 `tunnel(for:)`；不新建 feature-owned Relay 连接，不回退 direct，不改 Host、TS/JS codec、crypto 或 handshake 协议 |
| Relay 准入 | `POST /auth/url-token` 经相同认证 tunnel；拒绝过期/错误形状/控制字符及返回原 bearer 的 token；只允许 exact desktop WS 路径。Host 现有 `authorizeRequest` pairing grant 与 WS allowlist 仍是 authority，未添加本地信任旁路 |
| Relay wire | 6=`WsOpen {path,query}`；7=`WsOpened {protocol?}`；8/9=text/binary；10=`WsClose {code,reason}`；5=`StreamAbort {reason}`。没有猜测或新增 `status`、`source` 等字段 |
| fragmentation | 仅 8/9 允许 `0x80` continuation；按 stream+type 重组，UTF-8 完整后才解码；发送大 text 同样按现有 65,526-byte payload 预算分片；仍广告 `batch:false`，不擅自开启 batching |
| 排序 | 继续共用一个串行 encrypt+send drain，AES counter 与发送顺序不变；同一 WS 不允许并发 writer 交织分片；不同子流可并行；无 intentional batch-window delay |
| 大小/队列 | incoming logical message ≤512 KiB，outgoing ≤96 KiB；每个 native inbox 至多2个完整消息，完整消息+未完成 fragments 共≤1 MiB；Relay 至多4个 WS，HTTP+WS 合计≤32个流，继承原有2 MiB write queue。溢出明确失败/关流，不静默丢帧 |
| 超时 | capability/auth mint 10s，direct/Relay upgrade 20s，send 20s；Relay 继续原有 handshake/keepalive。receive liveness 与 startup/frame deadline 由既有 `RemoteDesktopBridge` 负责，静态 JPEG 不作为传输掉线依据 |
| cancel/stop | cancel upgrade、mint、pending receive/send 及 queued writes；Host/generation 改变主动释放 socket 与挂起 HTTP。已经交给 URLSession 的 bytes 不可撤回，调用方先结束，EOF 按原 wire 顺序排在其后；不重放输入或 mutation |
| 迟到结果 | stream ID 在同一 RelayTunnel 对象生命周期内不复用；旧 handle/异步 close 不能关闭 fresh-key reconnect 后的新子流。迟到 open 由 RuntimeBridge 丢弃并关闭 |
| 错误投影 | WS 401/4001、Relay pairing rejection 与 mint 401/403 → `authentication_required`；WS 501→`unsupported`、403→`disabled`、409→`occupied`；其他→`connection_failed`。只识别 Host 当前 status-only abort reason，不向 JS 转发可能带 URL/token 的错误文本 |

结构性性能预算是单 active desktop 的 ≤512 KiB 消息、有限 mailbox 与已有 decode ACK，不是物理手机吞吐/延迟/电量实测。未减少画面、删除消息或改变协议语义以获取性能。

## 实际 red / green 与 Swift 编译

先写 native contract runner，首次执行已 red：

```text
error: value of type 'RuntimeBridge' has no member 'remoteDesktopTransport'
Test Files  1 failed (1)
```

完成实现后运行：

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/remote-desktop-transport-native.test.ts packages/nsh/relay-native.test.ts --silent=false --reporter=verbose
bun run --cwd packages/nsh test:native
node --check packages/nsh/tests/remote-desktop-transport/fixture.mjs
node --check packages/nsh/scripts/check-native-bridge.mjs
bunx --no-install tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --types node --skipLibCheck packages/nsh/remote-desktop-transport-native.test.ts
bun run dead-code
```

末次限定测试输出：

```text
Swift 5 macOS contract compile: PASS (RuntimeBridge.swift + RelayTunnel.swift; -warnings-as-errors)
Test Files  2 passed (2)
     Tests  62 passed (62)
Start at   14:30:56
Duration   9.68s
```

Swift 编译使用 `xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors`。编译真实 `RuntimeBridge.swift`、`RelayTunnel.swift`，直接提取当前 `RemoteDesktopBridge.swift` 的纯 seam 声明作 consumer contract；只有 NativeShell 和 Keychain persistence 是 test double，没有 UIKit、NSH engine 或 iOS link。不能把它称为整个 `RemoteDesktopBridge` / App 已通过 iOS 编译。

既有 `test:native` 输出并退出0：

```text
Native bridge passed: direct auth/security/stale scopes/attachments/SSE; bounded authenticated resources, redirects, declared/chunked byte limits and Host invalidation on direct + Relay; real JS Relay candidate fallback, one-time redemption, encrypted HTTP/upload, chunked UTF-8 SSE and reconnect
```

`check-native-bridge.mjs` 仅补入同一份纯 seam 类型提取，使原有非 UIKit harness 继续能编译 RuntimeBridge；未改变原有 resource/speech 生产实现或测试语义。两个 JS syntax check 与新增 test 文件的独立 TypeScript check 均退出0。

`dead-code` 退出0（其脚本本身 non-blocking），报告86个 unused files、788个 unused exports、606个 unused exported types 等全库提示，包括尚待 main 接线的 `packages/nsh/remote-desktop.tsx`。已检查报告，未删除任何其他工作；Knip 不分析 Swift，不能将其作为 native reachability 证明。

## 全部传输测试清单

新增文件 `remote-desktop-transport-native.test.ts` 共56项：

1. **direct 与 Relay 各17项**：`messages`、`cancel`、`close`、`oversize`、`outgoing`、`flood`、`unauthorized`、`disabled`、`unsupported`、`occupied`、`redirect`、`stale`、`cancel-upgrade`、`runtime-close`、`selected-host`、`multiplex`、`local-close`。
   - 300,000-byte synthetic binary、72,000-byte UTF-8 text 跨 wire frame 后逐字节一致；四个同时存在的 WS 子流80,000-byte消息不串流，HTTP/WS 使用同一 Relay carrier。
   - pending receive 与 upgrade 取消；取消一个 WS 后 HTTP 仍存活；4001撤销；Host/generation/stale capability fencing；幂等 close 后立即禁止 send/receive。
   - incoming 512 KiB+1、outgoing 96 KiB+1、消息洪流明确失败；401/403/409/501 分类；redirect 不跟随。
2. **Relay 额外16项**：`unpaired`、`upgrade-timeout`、`invalid-path`、`carrier-redirect`、`old-socket`、`bad-open`、`bad-close`、`bad-abort`、`bad-text`、`control-fragment`、`cancel-mint`、`switch-mint`、`bearer-url`、`expired-url`、`bad-mint`、`mint-denied`。
   - pairing gate拒绝、exact path、20s生产超时的同一可注入deadline机制（测试用50ms）、外层carrier redirect、fresh-key reconnect后旧close不能误伤新流。
   - strict `protocol/code/reason` 源字段、非UTF-8、control frame不能带fragment flag；错误不能以伪造status字段绕过解析；失败后后续HTTP可恢复。
   - mint中取消或切Host；expired/CRLF/原bearer token拒绝；mint 403归为认证失败，不误报desktop disabled。
3. **纯 native inbox 6项**：`fragments`、`invalid-utf8`、`fragment-overflow`、`queue-limit`、`closed-pending`、`duplicate-open`。覆盖按text/binary分别重组与UTF-8跨字节、总大小、队列上限、挂起receive终止及重复open。

另有既有 `relay-native.test.ts` 6项：八路300 KB HTTP复用、SSE UTF-8/head顺序、SSE cancel不影响其他request、ciphertext replay拒绝/重新建钥、fresh-counter GCM tag tamper拒绝、bearer仅在E2EE内且缺失时拒绝。全部保持 green。

新增 fixture 使用**生产 JS `createTunnelHost`、E2EE 和 codec**；认证由显式 test-only grant callback、synthetic bearer/scoped token 与 Origin gate构成，没有读真实配对store或系统凭据。它证明协议与授权拒绝不被 native 绕过，**不证明生产授权存储/部署已验收**。

## 剩余真实 Relay / 平台缺口

- main 接线的全 App iOS 编译及串行验收：五个 capabilities、JS route/入口、UIKit decoder/ACK/input/back/background/rotation/gesture 等；本线不以 macOS seam 编译替代该验收。
- 真实已配对 Host/Relay-only 端到端，包括 production pairing store的direct-only/owner/SSH credential拒绝、grant撤销与过期、URL-token refresh、禁用/占用/权限恢复；本线未触碰这些真实资源。
- 物理手机 weak WAN、TLS部署、长连接切网、持续多路SSE/HTTP/WS、峰值内存、帧耗时、电量与长时间循环；结构性bounded buffers和本机fixture不替代实测。
- direct 的实际20s socket/send deadline、真实网络阻塞中的send取消与迟到EOF、内核/URLSession内部buffer；当前验证了production代码编译、取消路径与Relay可注入upgrade deadline，没有人为挂起真实网络写入。
- Native WebRTC/硬件媒体接收仍未实现；此传输承载既有真实 compatibility JPEG/signaling/control，不宣称完成WebRTC scope。

官方API依据已通过 Context7 resolve `/websites/developer_apple_foundation` 并读取 Apple `webSocketTask(with: URLRequest)`、`maximumMessageSize`、`URLSessionWebSocketDelegate.didOpenWithProtocol` 与 `cancel(with:reason:)`。其中 maximumMessageSize明确包含WebSocket continuation frames 的合计大小；native mailbox另外限制应用层排队。
