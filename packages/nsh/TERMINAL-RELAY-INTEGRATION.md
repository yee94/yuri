# Terminal Relay 接线现状

main 已在 `RelayTunnel.swift` 提供 exact `/api/terminal/ws` 和 `WebSocket.sendBinary(Data)`；本 owner 没有修改该文件。

生产 `RuntimeBridge.terminalTransport(expectedHost:)` **已直接接入**：

```swift
let socket = try await tunnel.openWebSocket(path: "/api/terminal/ws", urlToken: token, timeout: 15)
// receive保留NativeSocketInbox.Message text/binary/closed；
// TerminalWireMessage.binary → await socket.sendBinary(data)
// TerminalWireMessage.text   → await socket.send(text)
```

旧的临时 `terminalRelaySocket` 注入参数已移除；main 无需传 callback。`terminalIO` 只是 native-only 测试 seam，生产默认 nil。

短期 token 在同一个 captured tunnel 内通过 `POST /auth/url-token` 铸造，校验 status、JSON MIME、大小、未来 expiry、不是 bearer；不发 JS、不记录到日志。不支持 Relay→直连回退。

Host 端两个真实 allowlist 已有 `/api/terminal/ws`，本次未改 JS Host。测试使用真实生产 `createTunnelHost`、E2EE handshake 和 mux/fragment codec，只有终端 HTTP/WS server 是 loopback 合成 fixture，不存在 PTY。

## 当前 main 依赖

终端要求完整入站 text/binary **1 MiB**；终端实际发送遵循 Host terminal 64 KiB payload限制，控制帧按 type9、文本按type8，沿用原codec与MORE分片及singlewriter。

本次真实 mux 测试发现，在本 owner最后核对的版本中 `NativeSocketInbox.consume` 仍然为 **512 KiB 单帧 / 1 MiB 总budget / 2消息**，与需要的1MiB终端入站不符。测试保留1MiB，没有降标；修复归 main 所有。建议 terminal 专属 inbox 参数：1MiB单帧、至少2MiB总预算及有界消息数，desktop/dictation保持原策略。

实际状态以 `terminal-loopback.test.ts` 的 1MiB Relay roundtrip 测试为准；不能以 sendBinary API存在或policy测试通过代替。
