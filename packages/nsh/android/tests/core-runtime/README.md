# core-runtime JVM 测试

纯 JVM、无 Android/Host/网络/Keychain 的核心逻辑证据。只用 JDK 的 `javac` + `java`，不引入 JUnit。

```sh
# 仓库根目录
rm -rf /tmp/core-runtime-test && mkdir -p /tmp/core-runtime-test
javac -Xlint:-options -d /tmp/core-runtime-test \
  packages/nsh/android/tests/core-runtime/*.java \
  packages/nsh/android/src/com/yee94/yuri/nsh/{HostLease,RuntimeBridgeAttachments,RuntimeBridgeJson,RuntimeBridgeFailure,\
RuntimeHostText,RuntimeHostUri,RuntimeHostScope,RuntimeHostScopeFailure,RuntimeHostAuthority,\
ConnectionEditorFailure,ConnectionEditorInput,ConnectionEditorRelay,ConnectionEditorRetirement,\
ConnectionEditorTransport,ConnectionEditorConnection,ConnectionEditorPartition,ConnectionEditorRecords,\
RelayTunnelFailure,RelayTunnelFrame,RelayTunnelCrypto,SessionMessageStream}.java
java -cp /tmp/core-runtime-test CoreRuntimeTest
java -cp /tmp/core-runtime-test com.yee94.yuri.nsh.RuntimeBridgeAttachmentsTest
```

当前结果：`CoreRuntimeTest 107 passed, 0 failed`；`RuntimeBridgeAttachmentsTest 10 passed, 0 failed`。

覆盖范围：

| 域 | 断言内容 |
| --- | --- |
| `RuntimeBridgeJson` | 严格解析（尾随垃圾、控制字符、非法转义、截断）、Long/Double/指数、转义、stringify 往返、非有限数拒绝 |
| `RuntimeHostUri` / `ConnectionEditorRecords.origin` | origin 规范化、默认端口、路径/查询/片段/凭据/反斜杠/空格的拒绝、Relay `ws(s)` 规范化、wire 编码与百分号解码 |
| `RuntimeHostScope` + `RuntimeHostAuthority` | 严格 `{hostID, lease}` 信封、UUID/控制字符拒绝、foreground 转换幂等、`background/required/stale/unavailable` 码 |
| `ConnectionEditorRecords` | transport partition 迁移与复用、重命名不改授权、改 origin 需要重新配对、stale/missing、授权轮换记账、ACK 精确移除与幂等、普通变更不丢 pending、替换候选校验、重复 transport、快照排序与凭据不外泄、编码往返与损坏拒绝 |
| `SessionMessageStream.SSEEvents` | CRLF/CR/LF 边界、多行 `data` 合并、`id` 空值重置、注释忽略、BOM、跨块 UTF-8、2 MB 上限 |
| `SessionMessageStream` | `validCursor`、`ready/backpressure/event` 帧解码（含信封 `{payload, directory}`）、WS 尝试→断开→SSE 回退的真实状态机 |
| `RelayTunnelFrame` | type/more/streamID 编解码、非法 type、越界 payload、响应头状态校验 |
| `RelayTunnelCrypto` | P-256 ECDH + HKDF-SHA256 方向拆分、hello 结构、AES-GCM 双向往返与重放/篡改/版本/短帧拒绝 |
| `RuntimeBridgeAttachmentsTest` | 附件 Host 路径只接受 POSIX 绝对路径/Windows 盘符路径；`file:///` 三斜杠与空格、非 ASCII、`#?` 百分号编码 |

未覆盖（必须真机/真 Host/真实 Relay 才能验证）：HTTP/1.1 与 WebSocket 客户端、凭据签发与配对、SSE 重连退避的真实时序、Relay 与 TS `lib/relay` 的逐字节互操作、Android Keystore 存储、Camera2 扫码。
