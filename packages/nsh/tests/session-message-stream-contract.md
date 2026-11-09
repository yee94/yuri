# Session message stream 实施与交接

本改动仅拥有 RuntimeBridge 的 stream 注册、捕获、registry 与旧 SSE parser 迁移；RelayTunnel 的 session 专用开口；state 的 createChat mode option、stream start/stop 和事件准入/ready 调度。不修改附件、发送、seed/cache、voice 或其他 domain transport。

## 主装配端口

- `runtime.ts` 导出 `NativeMessageStreamTransport = 'auto' | 'ws' | 'sse'`。
- `createChat` option：`messageStreamTransport?: () => NativeMessageStreamTransport | null`。已装配 getter 返回 `nativeAppearance.current()?.messageStreamTransport ?? null`。null 仅不启动流，独立初始历史 GET 和 safety poll 仍运行；省略 option 的历史调用保持 SSE。确认空 Host settings 的 auto 默认由现有 canonical root 解析，不由 Chat 猜测。Chat 本地仅对 primitive mode 发布变化，50 次无关 appearance 更新不重开流、不新增 GET。
- 不新增 capability：沿用 `runtime.stream` / `runtime.stop`。global envelope 完全不变。Chat start 严格收 `{path,key:'chat',expectedHost,ownerID,mode}`；stop 严格收 `{key:'chat',expectedHost,ownerID}`。
- Native Chat 事件为 `runtime.event` 的 `{key:'chat',expectedHost,ownerID,data}` 或 `{...,type:'reconnected'}`；断线发同票据 `runtime.disconnected`。data 是保留 payload/directory 的 JSON，不把 transport eventId 伪造成 domain event.id。
- `main.swift` 无需挂第二个 bridge 或 lifecycle owner。controller Task 就在原 `streams['chat']` registry；现有 `setForeground`、`stop`、`retireResources` 负责取消和 fence。
- 正式 `build-ios.mjs` 动态发现 `ios/*.swift`，无需改入口。显式 compile-input lists 已补 `SessionMessageStream.swift` 和 `SessionMessageStreamDirect.swift`，未执行这些网络/SDK/engine suites。

## 真实 wire 与身份边界

WS 固定 Yuri Host `/api/global/event/ws`，握手 query 仅可带真实 `lastEventId`；无需发送 subscribe JSON。Direct URLSession 用原生 captured bearer header 和真实 Origin，禁止 redirect。Relay 在同一 captured tunnel 用 bearer POST `/auth/url-token`，核验 token/expiry 后开专用 WS 子流；长期 credential 不放 URL，token 不返回 JS、不持久化。Host 现有两道 allowlist 已包含路径，不新增 server endpoint。

`ready(scope:'global')`、`event(payload,directory?,eventId?)`、`backpressure(bufferedBytes,maxBytes)` 是消费的 frame。error、错误 JSON/类型、binary、close 都是显式连接失败。全局 WS replay 先于 ready，且同 socket 上游恢复可再次 ready；每次 barrier 都触发权威 GET。server 的 replay 缺失没有完整性证明，必须保留补偿。SSE 解析支持逐字节 UTF-8、BOM、CR/LF/CRLF、多 data 行、空 id 重置、NUL id 忽略、不提交未终结 block；游标仅在已交付事件/显式 ID block 后更新。

## 已运行验证与限制

- `session-message-stream-native.test.ts`：Foundation-only 生产 controller + Deferred synthetic transport。首个 red 是 pending open 取消后迟到 socket 未 close 的运行期断言失败，随后 green。包含六种 mode、replay→重复 ready、SSE ID/reset、WS→SSE→WS cursor、无效 frame/token。
- `session-message-stream-runtime.test.ts`：真实 RuntimeBridge/RelayTunnel/URLSession adapter 源码以 Swift 5、warnings-as-errors 编译；ConnectionStore 使用明确内存 fixture，I/O 全部 synthetic。检查 direct/Relay 六组合的真实 request/auth、Relay fresh mint、无效输入不替换、same-lease 旧 stop、后台与旧 lease。
- state/Goal/history/overview focused Vitest 以及 context Host pure-VM 检查；事件 helper 在 start 时保存签发票据，mockClear 不改变票据，迟到 frame 不从当前 state 补签。
- `context-usage-route.test.ts` 的真实依赖追踪 signal fixture 覆盖 mode→单流替换、old owner event/ready/disconnect 负例、ready 前 replay 无补偿 GET、ready 同步 publish、失败 GET 保正文/busy、null 退休。
- 未运行 NSH engine、UIKit、设备、真实 Host、真实 direct/Relay 网络或模型。Synthetic I/O 不证明真实 WS upgrade、认证 gate、Relay 字节互通或手机 1:1 验收。

主 arch oracle 应复核旧票据与旧 scope 在 start/stop/event 三处的负例、没有 parallel session stream owner，以及附件/voice/seed/cache 冻结区未变；SDK/engine 最终验证由主独占。

## 本轮三个 P2 修复与回归

- Relay session 子流唯一使用 `NativeSocketInbox.sessionStream()`：单消息仍限 1 MiB，排队最多 4096 条，完整消息和未完成 fragments 合计限 8 MiB。其它 socket 的两条消息、1 MiB 总预算默认不变。消费者暂停时先接收与 Host 上限一致的 2048 条合成 replay 和 ready，再通过真实 mailbox/controller 按原顺序消费并逐项核验 ordinal；count/bytes 两类 overflow 都明确失败、断开并在显式 WS 下重连，不静默丢帧、不假回 SSE。最初 red 为第三条消息触发生产 mailbox `limit`。
- Chat 对 global/chat 一律先验证非空、格式正确且与 operation lane 相同的 `expectedHost`，再分流；global 不需要 chat ownerID。A→B→A 回归保留三个真实 start 的签发票据，旧 global status、ready、Goal 和缺失/畸形 scope 都不能作用于当前 Chat；同 scope global 无 ownerID 仍可工作。Goal/Bot 正例 fixture 显式创建 global start 后保存其票据，不在 emit 时补当前 scope。最初 red 为旧 global idle 将当前 busy 清空。
- session Relay mint 独立保留真正 Host HTTP response 的 `Date` 与 body `expiresAt`。`tunnel-host.js` 的响应头循环只剥 framing/hop-by-hop 字段，Date 跨 tunnel 原样进入 Swift；pure dispatcher 回归用 synthetic fetch 验证实际 wire header/body。HTTP Date 秒精度按上界 `Date + 1s` 求保守 remaining TTL，再从本机请求开始的 monotonic 时钟计时，包含整个请求/Relay 延迟；open 和 carrier 建立后的 WsOpen 发送前都复核 monotonic deadline。没有 Host Date、已过期或不确定剩余时间均拒绝，不拿手机 Date 或盲固定 TTL 兜底。最初 red 为 fresh 2020 Host receipt 被当前手机 wall clock 拒绝；green 覆盖正负 100 年偏差、0/500/999ms、真实 expiry 边界和耗尽 TTL 的延迟。

本轮获准并运行真实 iOS SDK typecheck（declaration-only NSH stub，不启动 engine/app），以及 focused Foundation/VM、tsc。仍未运行 engine、设备、真实 Host 或真实网络；三个 finding 的最终 closed 判定交原 arch oracle。
