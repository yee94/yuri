# RuntimeBridge 终端 transport、严格流 scope 与授权退休 hook

## 跨 Tab 输入队列复验

后续新增的“旧 Tab 未发送项堵住新 Tab”问题已修复。同一只读 oracle `ses_e4a288cadffeCCyLBV7aZKQ52t` 已逐项复核为静态实现层 closed：切换/隐藏回存未发送文本，仅保留精确在途 receipt；迟到 accepted/rejected/unknown 按原 key/receipt 隔离，预算保持。main 随后实际执行 `terminal-renderer-behavior.test.ts`，14 项全部通过。该 DOM 回归覆盖 `live:false` 后切换，并未执行真实 Tab 销毁、系统剪贴板或 PTY 关闭；设备边界继续未验收。

## 本次 owning 改动

仅修改 `ios/RuntimeBridge.swift` 的终端 transport、必要 lifecycle registry、严格 stream/stop admission 和成功持久化后的授权退休 hook；保留原 ASR/资源/ConnectionStore 实现与注释/WIP。新增 `ios/TerminalTransport.swift` 及终端专属测试。未修改 main/application/state/build/nsh.json、RelayTunnel、NotificationBridge 或旧 harness。

用户/main 已报告 stageTerminalOfflineResources 接入、整包编译签名和资源 SHA/codesign 检查成功。本次不重跑 main build；该证据不能代替新 transport 的编译/网络测试。

## 生产终端 transport

`RuntimeBridge.terminalTransport(expectedHost: RuntimeHostScope)` 在 MainActor **同步 admit** 后捕获 SavedConnection、native generation 和 opaque scope；任何 I/O前后使用既有 checkHost完整核对连接、origin、token、Relay、authorizationID 和 lease。不会借用latest lease。

HTTP只接收有限 `TerminalRequest` enum，验证sessionID/目录/尺寸/loopbackURL，保真text/plain UTF-8输入（包含NUL/CRLF，≤64KiB）。复用原RuntimeBridge ephemeral无Cookie/no-cache/NoRedirect session，或同一captured pairedRelay tunnel；不增加feature URLSession或任意URL路由。响应收包中限64KiB；optionalFile限1MiB；15秒总deadline、取消立即settle，未知input不自动重试。

WS固定 `/api/terminal/ws`：直连复用makeRequest认证并设置真实同源Origin；Relay先经同一tunnel铸造scopedURLtoken，使用main已提供的openWebSocket/sendBinary。text/binary边界保留，完整入站≤1MiB，出站≤64KiB；lease在pendingopen前登记，取消/Host retirement/后台立即关闭，late socket实际close。桌面/ASR direct socket类和限额未修改，终端有独立direct mailbox。

SSE固定 `/api/terminal/:id/stream`，同transport认证，不做directfallback；status/MIME先验，404是权威sessionNotFound，其它失败不伪空。真实SSE parser覆盖splitUTF-8、CRLF、注释heartbeat、多行data与1MiB事件上限；2MiB/64条有界队列溢出显式失败。EOF保留已收完整事件再报告断流。取消结束producer与pendingreceive；heartbeat维持liveness，不制造connected/data。

optionalFile严格固定7种项目文件名、指定目录、`optional=true`，按当前后端 `200 text/plain + X-Yuri-File-Exists:false` 才判不存在；200空内容且true保留空字符串，500/redirect/HTML/transport错误抛错。freePort要求真实200JSON和有效port，失败不返回默认空。

## main 最小接线

```swift
// RuntimeBridge 原init保持兼容；生产不要传terminalIO。
let terminal = TerminalBridge(capture: { expected in
    try runtime.terminalTransport(expectedHost: expected)
}, emit: { [weak app] event in app?.send("terminal.event", event) })
terminal.register(app: app)
```

main保持现有原生foreground初始化、stop/invalidation链，追加terminal/native terminal page清理；TS从native snapshot取得runtimeScope再constructor捕获。终端capabilities来自实际transport，SSE/discovery都有生产实现。路由、workspace入口、native terminal modal和resource preview presenter仍按TERMINAL-CONTRACT接线，不新增第五Tab。

## runtime.stream/stop 新严格协议

```ts
native('runtime.stream', { path, key, expectedHost: capturedRuntimeScope });
native('runtime.stop', { key, expectedHost: capturedRuntimeScope });
```

- stream精确3个key，stop精确2个key；只允许global/chat，不接受缺scope/extra字段/无参stop。
- stream的parse→同步admit→路径/请求验证全部在取消同key旧流或发网络**之前**。每次重连、Task启动、await前后和data/reconnected/disconnected投递都fence捕获scope，不重取latest。事件附捕获expectedHost。
- stop是精确(scope,key)cleanup，不adopt新scope、不rotate。旧scope只会释放其旧key资源，不能停止新Host或新lease的同key流；不存在资源时幂等成功。
- Native `runtime.stop()` / `setForeground`仍是原生生命周期，照常rotate/retire。JS不再有无参native生命周期入口。

### main持有旧harness的必要更新清单

所有显式编译`RuntimeBridge.swift`的source list，追加 **TerminalBridge.swift、TerminalTransport.swift**；无需为了transport加入NativeTerminalPreview.swift。

当前搜索到的清单位置（未由本owner修改）：

- `scripts/check-native-bridge.mjs` Swift编译列表；其中3次runtime.stream调用（old/new/unicode）都需附实时snapshot捕获的expectedHost。
- `remote-desktop-transport-native.test.ts`。
- `settings-voice-recognition-transport.test.ts`。
- `settings-voice-recognition-relay.test.ts`。
- `settings-voice-recognition-sdk.test.ts`。
- `resource-web-preview-swift.test.ts`：main并行WIP中已看到追加两文件，保留其当前改动。

若旧harness有JS `runtime.stop {}`，改为native `bridge.stop()` teardown，或带确切scope/key的streamcleanup；不能为旧测试恢复后门。

main 已将 `scripts/check-native-bridge.mjs` 的三处 stream 调用改为从 `bridge.snapshot` 解析实际 `RuntimeHostScope`，直连替换流与 Relay Unicode 流各捕获所属 scope；teardown 保持原生 `bridge.stop()`。随后实际执行 `bun run --cwd packages/nsh test:native` 成功，覆盖认证、旧 scope、附件、SSE 替换、直连/Relay 有界资源、配对一次兑换、加密上传、分块 UTF-8 与重连。该结果属于本地合成 Host 的生产桥集成验证，不代表真实 PTY 或设备验收。

## 授权退休 hook（main接NotificationBridge，不由本owner修改）

```swift
runtime.onAuthorizationRetired = { connectionID, authorizationID in
    try notifications.retireAuthorization(connectionID: connectionID,
                                          authorizationID: authorizationID)
}
```

准确类型：`((String, String) async throws -> Void)?`，native-only，传入旧connectionID与旧authorizationID。同步快照差异仅在**成功store持久化之后**记录；先使liveauthority失效，再await清理。覆盖成功remove、成功显式重新授权replace及save覆盖同ID；legacy nil不伪造。

rename/select/stop/background不会触发；失败授权、失败持久化均0次。callback失败不回滚/复活已撤销authority，也不把已确认remove/replace报成需重放的mutation失败。

失败/未安装callback保留native待重试项，`snapshot.authorizationCleanup`与`runtime.authorizationRetirement`事件公开只有pending/failed计数，**不公开ID、凭据或callback错误正文**。main据此给UI/diagnostics明确失败状态。`await runtime.retryAuthorizationRetirements()`只重试这些旧精确pair的清理，绝不重放remove/replace。当前ledger是RuntimeBridge进程内状态、跨stop/Host切换保留；进程退出后的待清理恢复还需要Notification owner自己的durable retirement journal，本模块没有假称已支持。

## 测试内容与边界

### 独立审查后修复的终端 feature 边界

最新新增队列P2已修：Tab切换或隐藏时将尚未发送项按原key/顺序移回draft，只保留精确在途receipt；当前Tab的新输入继续使用原4项/262,144 bytes、单次65,536 UTF-8 bytes预算。旧accepted移除原receipt后允许新Tab继续，旧rejected只冻结/恢复其原Tab，unknown冻结整个surface输入lane并保留各自文本。恢复文本前置到原Tab的现有draft/新编辑，不覆盖其它Tab内容，重复或key/receipt不匹配的回执无操作。关闭A切到B同样不会让A后缀卡住队首或被发给B；切回保留draft不会自动发送。draft仍限当前document内存生命周期，不新增PTY恢复或journal写入。

接口变化：**无新增桥接字段、handler或capability**，仍使用 `terminal.preview.render {inputResult:{key,receipt,status}}`。本轮生产代码只修改 `ios/NativeTerminalPreview.swift` 内的bootstrap，未修改RuntimeBridge、terminal core、application/main/build或Relay。

新增8项生产bootstrap DOM测试修复前8项全部失败，修复后连同原6项共**14项通过**：A→B与关闭A分别覆盖accepted/rejected/unknown；旧rejected不覆盖新A编辑/B draft；完整4项预算、65,536-byte Unicode边界与迁移后草稿完整性。accepted/rejected后B可继续输入；unknown有意停止整个lane而不是绕过未知发送。

本轮最终显式运行 `terminal-core.test.ts terminal-features.test.ts terminal-renderer-behavior.test.ts terminal-native.test.ts terminal-static.test.ts terminal-presentation.test.ts terminal-offline.test.ts terminal-preview-parity.test.ts terminal-discovery.test.ts`：**9文件44项全部通过**，包含Foundation控制器、iOS SDK与NSH public TypeScript SDK检查。未运行runtime/loopback、engine/device、真实PTY/Host、网络、Git、依赖下载或main build；下面完整回归数字是此前批次的历史证据，不是本轮重新验证。

- detach 携带原始 expectedHost，并对比原生 Session 注册 scope；attachment 必须是正整数且匹配当前 attach receipt。workspace receipt 跨实例单调唯一，重复或倒退 attach 拒绝。Foundation真实TerminalBridge测试覆盖旧lease A迟cleanup、新lease B同Tab/同数字attachment的socket不关闭且仍可输入；缺失/null/bool/负数/0/string attachment均拒绝，合法精确cleanup实际关闭。
- 硬件Command字母不映射control；Command-C有selection时仅复制，Command-V保留系统paste；软Cmd与硬Meta分开。生产bootstrap DOM测试检查clipboard内容及零PTY调用。
- clipboard paste查询同Ghostty实例hasBracketedPaste，中文/emoji/多行整体包一次；DOM验证后续input与IME不会重复发送。
- core使用65,536 UTF-8 bytes上限，20k ASCII实际到达call；单个core input在途时明确拒绝额外输入。bootstrap队列最多4项/262,144 bytes、单receipt在途；用现有preview.render返回接纳结果。超限/背压保留textarea、显示输入拒绝原因；unknown停止队列、保留可恢复文本、不重放尝试项或后续项。DOM→生产core→合成bridge测试观察真实调用、正文和返回状态；不是只检查source文本。
- 移除UIKit drag/drop安装、delegate实现与terminal.tsx的reorder入口，保留catalog顺序与journal。UIKit手势和系统剪贴板的设备验收未运行。

这些变更没有修改RuntimeBridge或main持有的RelayTunnel；原严格stream/stop、terminalTransport、授权退休hook继续保留。Context7本轮仍返回配额不足，Ghostty API按当前已安装0.4.0的真实index.d.ts与WebTerminalViewport核对，没有下载依赖。最终focused重跑 `terminal-core.test.ts terminal-features.test.ts terminal-renderer-behavior.test.ts terminal-native.test.ts terminal-static.test.ts`：**5文件29项全部通过**，包含最后的retained draft编辑行为、rejected/unknown重复回执以及SDK检查。

- `terminal-runtime.test.ts` 编译**生产RuntimeBridge/Relay/ASR/资源代码**，只替换ConnectionStore的Security I/O为内存；包含terminal request/auth/body、限额、取消/lateclose、A-B-A/background/authorizationchange、旧ASR/resource/admission回归，以及授权退休成功/失败/legacy行为。
- `terminal-loopback.test.ts` 使用真实URLSession direct、真实RelayTunnel、JS生产Host mux/E2EE，仅HTTP/WS backend是loopback合成；测试text/binary（含65,536字节MORE分片）、1MiB入站、认证拒绝/redirect/no-directfallback、真实SSE/HTTPfallback、原ASR/desktop text往返，以及严格runtime.stream/stop的A-B-A与旧stop隔离。
- 同一生产RuntimeBridge还对真实Apple iOS SDK做typecheck；NativeShell是声明式stub，未启动NSH/UIKit/设备。无Keychain访问、真实PTY、shell、真实Host、外部网络、收费或main build。

上一批完整重跑：`OPENCODE_TMP_DIR=<approved-temp> node node_modules/vitest/vitest.mjs run --config packages/nsh/vitest.config.ts packages/nsh/terminal`，**11文件、113项中112项通过、1项失败**。生产内存/旧owner回归/退休hook **63项**、终端feature模块 **35项** 全部通过；loopback **15项中14项通过**，包括strict stream/stop直连/Relay 2项、fallback 4项、WS认证/redirect 5项、原ASR/desktop text往返2项、direct terminal roundtrip 1项。当时唯一失败为Relay完整1MiB入站在main所有NativeSocketInbox512KiB限制触发 **TerminalFailure.overflow**；新错误映射已实测，未降低测试尺寸。此批次包含生产桥真实iOS SDK typecheck和macOS warnings-as-errors编译。随后补充的显式rejected回执与retained draft编辑测试随focused feature批次验证，完整批次计数不混入该后续用例。

未运行 `bun run dead-code`：当前脚本使用 `bunx knip@5.80.0`，本任务禁止依赖下载及外网，未启动该下载路径。未运行main build、设备或真实PTY验收。

没有可用独立subagent派发工具，未伪称独立review；没有修改main持有的Relay/旧harness。旧测试编译清单与main实际terminal/notification接线仍须main闭环。
