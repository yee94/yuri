# 开发 Bundle 单帧上限候选补丁（冻结）

本候选只解除真实 native 截图之前的开发 WS 传包阻塞，不包含 UI 改动，也不表示 PC 1:1 像素对比已完成。风险归类为开发期平台传输行为；实际 Rust socket 集成验证不能替代 CLI/runtime 配套构建或系统窗口验证。

## 交付与接管

- [补丁](../../patches/nsh-0.4.0/dev-bundle-frame-limit.patch)
- [完整 before/after hashes](../../patches/nsh-0.4.0/dev-bundle-frame-limit.hashes.json)
- [验证账本及原始日志 hash](../../patches/nsh-0.4.0/dev-bundle-frame-limit.verification.json)
- patch SHA-256：`86eee6d37cd33a8c74a469a25e72b4a1114b2502f5867b20c1c0c1d3655946af`。
- 基线：NSH 0.4.0，`e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`。
- 当前主线 preparation：`f7dedc80f52dec12c4055a93b6c9cbdc437d038727f5120817e33db9a6eb0a1d`（Shift→Diff→List）。

仅涉及 `crates/nsh-dev/src/client.rs` 和已有 `crates/nsh-dev/tests/roundtrip.rs`。已逐文件核实：两者均未被上述三项补丁触碰，f7ded 的实际文件 hash 与 e626 before hash 相同。用现有严格 applier 分别对 e626 和 f7ded **仅在内存中**重放，通过精确 context、全部 before/after hash 和 scratch 输出比对，没有创建 preparation。

候选现已冻结，交唯一 preparer 审核、登记和构建。未修改 manifest/preparer、外部 NSH 源码、任何既有 prepared tree 或 CLI/runtime 二进制；未启动 physical macOS，也未改变实体数据。

## 根因与 API 核实

基线源码证据：

1. `crates/nsh-dev/src/server.rs:543–550` 的开发 WS upgrade 设置 `max_message_size(64 << 20)`。
2. `server.rs:862–915` 先发 Bundle 文本公告，再把完整 bytecode/source 作为单个 `Message::Binary(payload)` 发送；source map 另一个 Binary。这里没有分片实现。服务端的 message 设置约束其**接收**方向，不是对发送 Bundle 大小的校验；客户端仍须独立保留接收界限。
3. `client.rs:162` 使用 `tungstenite::connect`。本机缓存的 **tungstenite 0.30.0** `src/protocol/mod.rs:95–104` 默认 message 为 64 MiB、frame 为 16 MiB，因此约 20.4 MB 的开发 bundle 会在单帧接收处被拒绝。
4. `client.rs:257–265` 对容量错误走既有 `Disconnected` 路径，外部表现为重连／host 离开。候选不改变该错误处理、事件协议或重试节奏。

0.30.0 的 `src/client.rs:43–47,124–128` 表明正确 API 为：

```rust
tungstenite::client::connect_with_config(request, Some(config), 3)
```

第三个参数是 `max_redirects: u8`；`connect` 原来就是 `connect_with_config(request, None, 3)`，故保留 `3`，不改变重定向额度。该函数没有在 crate 根重新导出。`WebSocketConfig` 是 non-exhaustive，使用其 builder，不能猜测结构体初始化 API。Context7 查询因月度配额耗尽未能返回文档，以上以实际缓存 0.30.0 源码及成功编译为证。

## 唯一运行逻辑变更

```rust
let config = WebSocketConfig::default().max_frame_size(Some(64 << 20));
match tungstenite::client::connect_with_config(url.as_str(), Some(config), 3) {
```

- frame 接收界限明确为 `Some(67_108_864)`，不是 `None`。
- `max_message_size` 保留默认 `Some(67_108_864)`；其他配置不变。
- 公共 API、持久化、协议字段、bundle 内容、编译模式和数据 owner 不变，不新增依赖。
- 当前用途限定于**同 PC、可信开发服务器**的 NSH 开发 WS。代码沿用既有 URL 接口，并未新增 localhost 强制校验，不能把它当成新的认证或信任边界。
- 生产 HTTP、Yuri Host 网络桥、Relay、鉴权和原生业务网络没有放宽。所有复用该 `DevClient` 的开发 host 会消费此配置；这里只验证了本地 Rust 传输，没有宣称各平台 runtime 已验。

## 真实本地 WS 回归

使用现有 `nsh-dev/tests/roundtrip.rs` seam：实际 `DevServer`／Axum、实际 TCP loopback 随机端口、实际 `DevClient`／tungstenite，不是 mock，也不读取用户 bundle 或实体数据。新增三项：

| 回归 | 结果 |
| --- | --- |
| `the_default_socket_rejects_a_bundle_above_16_mib` | 17 MiB（17,825,792 bytes）真实传输；未配置的 socket 明确产生 `Capacity::MessageTooLong { size: 17825792, max_size: 16777216 }` |
| `a_large_bundle_round_trips_through_a_redirect` | 同一测试先用原版 client 跑红：收到 `Disconnected` 而非 Bundle，exit 101；只替换客户端连接配置后跑绿，完整验证 17 MiB 每个 byte、source map、版本、格式及一次真实 HTTP 307 重定向 |
| `the_64_mib_limit_accepts_its_boundary_rejects_overflow_and_recovers` | 64 MiB 恰好通过且逐 byte 校验；64 MiB＋1 byte 不发布 Bundle、发生 `Disconnected`；原重连收到下一版 `[1,2,3]` 小包 |

既有小 bytecode、source fallback、patch/source map、日志、错误、测试步骤和 session 回归均保留。

## 执行环境与结果边界

独立 ignored 工作目录为 `packages/nsh/.nsh/compat-dev-frame-work`，没有使用已有 patched 树作为可写工作区。只复制 `nsh-dev` crate 和必要的根 manifest/lock/说明文件；为避免复制或构建无关平台，scratch 的 workspace members/default-members 缩为 `nsh-dev`。

因此原全 workspace lock 的首次 `--locked` 尝试按预期拒绝了 workspace 缩减。仅 scratch lock 随后离线裁剪；全部 **86** 个保留 package 的 name/version/source/checksum 逐项与原 lock 匹配，没有引入依赖或升级。此后绿测与 client-only check 均使用 `--offline --locked`。原始 `Cargo.lock` SHA-256 始终为 `3e613f0b6940be5d83676f48771b461b122e0732f652ce4de20b4978b2015d34`。这不是完整原 workspace 的构建证据，preparer 仍须使用正式原锁验证。

使用已安装的 Rust/Cargo 1.97.1，debug/test profile，没有 release 绕过。涉及日志的测试运行在专用、完成即退出的 tmux window；未启动应用窗口或常驻开发服务。

```sh
# 在独立 scratch workspace 中：
cargo test --offline --locked -p nsh-dev -- --test-threads=1
cargo check --offline --locked -p nsh-dev --lib --no-default-features --features client
rustfmt --check --edition 2024 crates/nsh-dev/src/client.rs crates/nsh-dev/tests/roundtrip.rs
```

- 完整 `nsh-dev`：**7 unit + 9 roundtrip = 16 通过，0 失败**；doc tests 为 0。
- 9 项 roundtrip 再串行重复三次，全部通过；client-only 编译、rustfmt 通过。
- `bun run dead-code` 已尝试，但仓库既有 `packages/web/vite.config.ts` 缺少 `vite-plugin-pwa` 导致加载失败，没有得到完整报告，没有为此加依赖。
- 最终重新核验外部完整 1,740 文件源码指纹为 `5764bf7d27dd530634a007ec2ca2df8d37b63903584f9b47401a1238e875b4d1`；manifest hash 未变。
- 原始红／绿／三次复跑／client check 日志保留在同一 ignored 工作目录，hash 见验证账本。

**尚未验证**：正式登记后的完整 preparation 与原 workspace 测试、同源 paired CLI/runtime 构建、真实主 App 约 20.4 MB bundle 截图、AppKit/Win32 窗口和 PC 像素对比。未运行 `nsh test`，未改其 `compile=false`，不得把本传输回归当作上述验收已通过。
