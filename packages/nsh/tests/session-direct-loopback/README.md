# Session Direct：本机 network adapter 集成入口

这是 `URLSessionWebSocketTask` + 生产 `SessionMessageStreamDirect` 对本机合成 WebSocket server 的 adapter 集成测试。它不连接真实 Yuri Host、模型、生产 Relay endpoint，不执行 Keychain、RuntimeBridge 的凭据查找或完整产品装配，也不证明真实 direct／Relay 产品联调通过。

## main 冻结后独占运行

默认入口跳过；普通全量 Vitest 不会启动 server、Swift 编译或 runner。source owners 冻结后，由 main 明确运行：

```sh
NSH_SESSION_DIRECT_LOOPBACK=1 bunx --offline vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/session-message-stream-direct-loopback.test.ts
```

要求本机 macOS、已有 Xcode Command Line Tools、已有 Bun。没有新增依赖。

编排使用异步 `spawn`。Bun server 是独立子进程，Swift runner 也是异步子进程；不存在 `spawnSync` 阻塞同进程 server event loop。server 自身也要求相同 opt-in 才允许 bind，且仅绑定 IPv4 `127.0.0.1` 的两个随机端口。

## 实际编译内容

测试复制三个完整生产文件并逐一记录 SHA-256：

- `ios/SessionMessageStreamDirect.swift`：被测 adapter，完整真实类。
- `ios/SessionMessageStream.swift`：完整真实 `SessionStreamSocket`、`SessionStreamFailure` 和 frame decoder。
- `ios/RelayTunnel.swift`：完整真实 `NativeSocketInbox` 及其所依赖的 Relay failure 声明；不创建 RelayTunnel 连接。

这些源已覆盖 Direct 当前所需依赖，因此无需提取声明、替代 Direct/inbox/socket 类，或引入 RuntimeBridge、ConnectionStore、NativeShell stub。编译命令只传入冻结副本及本目录的 Swift runner。复制后、编译后、实际运行后均核对原文件与副本 hash；任一变化导致失败，不能把混合 owner 版本当作稳定结果。

source owner 正式冻结后，已在独立临时目录对上述三个完整生产副本及自有 runner 完成 `-swift-version 5 -warnings-as-errors` 的 macOS 编译。没有执行生成的 binary，没有启动 server 或实际 socket；编译前后 hash 一致，临时产物已清理。fixture 实现自此冻结，交 main 显式运行网络部分。

此次 compile-only 对应的源 hash：

```text
RelayTunnel.swift                 8f66e516bb03a03f6c8a66e2f20e9864778aaa103500c418401ab03ef6cd0043
SessionMessageStream.swift        659e5dfce4006bbb9b2c22e04b6c97ef431239e65b7c7f32b70668f237936473
SessionMessageStreamDirect.swift  caa8211095572209824f87bac3583e304d3bf96243b2b21996719dc9699eaf98
```

## 实际网络断言

1. raw Foundation URLSession control probe 先确认此 macOS 支持 loopback `ws://`；它不替代后续生产 adapter。
2. 所有 handshake 的 `Authorization` 与 `Origin` 必须与调用者给定值完全一致，Origin 为对应 HTTP loopback origin。
3. Bun 的 open callback 连续发送 128 个真实 WS text message 和 ready；Swift 在开始消费前暂停 100ms，再经生产 adapter 和生产 frame decoder 验证顺序及 ready barrier。
4. 已打开 socket 的本地 close、接收 Task cancel、远端 close 必须唤醒 pending receive；握手尚未完成时的 close 和 open Task cancel 也必须结束等待。
5. HTTP 401 不得建立 socket，且须保留 adapter 的 HTTP rejection 分类。
6. 同 origin 和跨 loopback-port redirect 均不得打开 socket；目标 server/目标 path 的总请求数和携带 Authorization 的请求数都必须为零。

128 个 replay event 是此 fixture 的传输顺序探针，不替代 production replay 大小、全局 admission、inbox 总预算、token clock、SSE fallback 或产品同步验收。

## 凭据与产物

每次生成一个仅供本机 fixture 的随机 synthetic authorization，经 server stdin 和权限 `0600` 的临时 runner config 传入，不进入参数或仓库。server 只记录字段相等布尔值，不保存或输出 header 值；测试日志再按该值脱敏。临时源副本、hash manifest、config 和 binary 在结束后清理；server 在成功、失败或 skip 时都终止。

## Skip 与失败边界

- 未显式 opt-in，或当前平台不是 macOS：测试名记录具体原因并 skip。
- 真正运行后的唯一能力 skip：raw URLSession capability probe 报 `NSURLErrorDomain/NSURLErrorUnsupportedURL`；Swift 输出固定的具体原因并返回 77，Vitest 使用该原因标记 skip。
- Swift 编译失败、hash 变化、未知 platform 错误、HTTP/headers/replay/redirect 断言、adapter 运行错误、任何 deadline 均失败。尤其不因 adapter 自身失败或 401/302 行为不符而 skip。

## 纯检查

```sh
NSH_SESSION_DIRECT_LOOPBACK=0 bunx --offline vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/session-message-stream-direct-loopback-fixture.test.ts \
  packages/nsh/session-message-stream-direct-loopback.test.ts

node --check packages/nsh/tests/session-direct-loopback/server.mjs
node --check packages/nsh/tests/session-direct-loopback/fixture.mjs
xcrun swiftc -frontend -parse packages/nsh/tests/session-direct-loopback/Runner.swift
```

纯测试不 bind、不 spawn server、不调用 Swift 编译；hash 测试只在独立临时副本上验证变更拒绝。最后一条仅解析自有 fixture runner 的语法，不加载三份生产依赖，不等于实际编译通过。实际 adapter 结果必须由 main 的 opt-in 运行记录。
