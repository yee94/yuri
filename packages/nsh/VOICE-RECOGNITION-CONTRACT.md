# Settings configured-provider ASR — main 接线合同

## 所有权

- `ios/VoiceRecognitionCore.swift`：生产录音/停止/取消/重试状态机及 Host 字节协议；Foundation-only fakeAudio 测试直接运行它。
- `ios/VoiceRecognitionBridge.swift`：真实 `AVAudioSession` + `AVAudioRecorder`、受保护临时 WAV、原生权限、NSH 事件注册。
- `ios/RuntimeBridge.swift` 的 `voiceRecognitionTransport(expectedHost:)`：生产认证 HTTP / 原生 direct Socket / 已配对 Relay 适配；同步 admission 捕获 Host、generation、origin、token 和 Relay grant，不绕开原有网络 owner。
- `ios/RuntimeHostScope.swift`：进程内 UUID lease authority；默认关闭，只有 native foreground admission 开启，不持久化，不由 GET preflight 代替。
- `ios/ConnectionStore.swift` / `ios/connection-editor.swift`：非机密 `authorizationID` 持久授权代际，成功授权创建/替换后生成，legacy 缺字段保留 nil。
- `ios/VoiceRecognitionRuntime.swift`：有界 wire 校验、取消/截止时间与 Socket 租约；纯内存测试 I/O 接缝不替代生产请求构造或鉴权。
- `settings-voice-recognition.ts`：适配现有 `VoiceTestAsrAdapter`。不调用 `Speech.start`，不传 URL、key、音频或 provider 覆盖。
- UI/controller、`SpeechPlaybackBridge`、`main.swift`、通知及终端仍由对应 owner 接线；本模块未修改这些文件。`runtime.request` 的写入 admission 已实现，旧无 scope Native 仅保留前台 GET 兼容。

## main 必须接入

生产 transport 已实现。精确签名：`VoiceRecognitionBridge.init(app: NshAppView, capture: @escaping (RuntimeHostScope) throws -> VoiceRecognitionTransport, beforeCapture: @escaping () -> Void)`；capture 使用 `{ expectedHost in try bridge.voiceRecognitionTransport(expectedHost: expectedHost) }`，不得读取最新 snapshot 给旧 owner 自动补 scope。`beforeCapture` 停止现有 speech owner；该回调已移动到 core 的同步 admission **之后**，先于 recorder 工厂/GET/权限。`onInvalidate` 链及 native teardown 仍调用 recognition bridge 的 `invalidate()`。

`RelayTunnel.swift` 的 main owner 现已增加精确 `/api/dictation/ws` 白名单（本 owner 未修改该文件）；实际 Relay 仍未在本次纯内存验证中运行，不能以路径静态检查宣称端到端可用。

## Runtime admission 与持久授权代际

- RuntimeBridge 的 `snapshot` 及 `connection.list/select/remove/rename/edit/connect` 返回 `{connections, selected, runtimeScope: {hostID,lease}|null}`；scope 由 RuntimeBridge 包装，ConnectionStore 的 snapshot/编码不含 runtimeScope。
- `setForeground(_ active: Bool)` 默认 false。main 初始化及前后台必须同步提供真实状态。false 先关闭 admission、撤销 lease，再同步取消所有 runtime requests/语音/资源/socket 并通过 `onInvalidate` 退役 owner；true 签发全新 lease，JS 重新 list、重建 owner。重复 true 不重复轮换；不能只靠 JS `runtime.stop`。
- 成功 select（包括选择同一 ID）、当前重新授权、current remove、runtime.stop 轮换 lease；A→B→A 不复用旧 lease。rename/同 origin metadata/lastUsedAt 不轮换。select/remove/重授权的持久化失败不先 stop，也不改变原 scope/authorizationID。
- `runtime.request` 非 GET 必须有 `expectedHost:{hostID,lease}`；带 scope GET 同样严格核对，缺 scope GET 仅为旧只读兼容且仍拒绝后台。显式 null/多余 scope 字段/伪 UUID 拒绝，不把 editorVersion 或 authorizationID 当 lease。校验与复制 SavedConnection + generation 在同一个 MainActor 同步段；`scopedJSON` 在 child I/O 前及返回时再核对。进程内 scope 不发送给 Host，不追加到 URL/header。
- `authorizationID: String? = nil` 位于 `SavedConnection` 的最后默认参数，保留旧 memberwise initializer fixtures。成功 `save` 或已核验 `replace` 生成新 UUID（即使 token 字节相同），包括非当前连接；metadata/选择/lastUsedAt 保留。通过原 commit 先持久化，失败不采用新代际。
- legacy 缺字段按 Codable 解码为 nil，不自动迁移、不在启动时重写 Keychain。nil 不支持通知冷恢复；明确重新授权后才有 durable proof。新 public connection 行可带 `authorizationID`；它不能混入严格 `RuntimeHostScope`。
- 通知 owner 的 `NotificationHostScope.authorizationID` 由 main 从 `bridge.store.selected?.authorizationID` 捕获；必须独立完成 notification proof/TTL/CAS 与撤销检查。绝不以 runtime lease/editorVersion 代替跨进程授权。本 owner 未修改 NotificationBridge，也未验证通知冷恢复闭环。

## 资源 admission 最小接线与现存缺口

已提供 `resourceTransport(expectedHost: RuntimeHostScope? = nil)`、`resourceWebPreviewTransport(expectedHost: RuntimeHostScope? = nil)`。传入 scope 会同步严格 admit；每个读取/预览/朗读 child 在真实 I/O 前再次 fence，后台/前台轮换和同 ID 授权替换后旧 transport 失效。保留无参 native 兼容给现有只读/播放 owner，但它**不能**证明 queued JS 操作属于当前 Host。

后续追加授权已完成 `ResourceBridge.startRead` 与 `ResourceWebPreviewBridge` 的 typed capture，以及 JS 构造时 scope。main 已确认资源读取接线组合通过；HTML/loopback 的精确 main 接线、owner-scoped close、fixture 与验证边界见 `RESOURCE-READ-ADMISSION.md`。两种资源入口均不允许缺 scope，不能给 queued 旧操作自动补最新 receipt。NativeShell 完全丢弃返回值的文件回收仍未闭环。

1. `capture` 返回 `VoiceRecognitionTransport`，捕获与 `resourceTransport()` 相同的连接及 generation，额外比较当前 origin/token/Relay，避免同 ID 的授权替换复用旧凭据；普通重命名不失效。
2. `settings`：**GET `/api/voice/settings`**，复用 RuntimeBridge `makeRequest`、`boundedBytes` / `ResourceBytesBuffer`，JSON 最多 64 KiB。
3. `transcribe(Data)`：**POST `/api/stt/transcribe`**，`Content-Type: audio/wav`，`Accept: application/json`，body 是原始 WAV；请求最多 1,920,044 bytes，响应最多 128 KiB，绝无配置覆盖头。已走 RuntimeBridge 的认证 `makeRequest`、直连 bounded bytes 或既有授权 Relay HTTP；请求和整个 operation 的截止时间均为 90 秒。HTTP/MIME/超限失败不转为空成功，不泄露 Host/native 错误中的 URL/凭据。
4. `open`：**`/api/dictation/ws`**。复用已存在的原生 direct WebSocket / `RelayTunnel.openWebSocket`，不是另建 provider 网络。直连仍携带 native Authorization/Origin 且禁止重定向；Relay 必须通过当前已配对 E2EE tunnel mint 新 `/auth/url-token`，禁止未授权 fallback。现有 Host tunnel 与 URL-auth 两处 allowlist 均已包含此路由。原生 mailbox 有界，text ≤128 KiB，outgoing chunk ≤16 KiB；socket `receive/send/open` 必须响应 Task cancellation，`close` 必须唤醒 pending receive/open。映射 `text` → `.text`，binary/close → `.closed`。初始 open timeout ≤20 秒；receive 必须允许 Host `finish_accepted.timeoutMs` 的最长 300 秒处理预算（core 另加 5 秒传输余量），不能复用文件请求的 90 秒超时截断有效识别。Host/generation 变化立即取消请求/关闭 socket；晚到 socket 必须关闭。
5. `isCurrent` 与 captured Host/generation 同时匹配。`RuntimeBridge.stop()` 已同步取消 ASR pending HTTP/upgrade/read/send，关闭 Socket 并唤醒等待者；晚到 upgrade 自行关闭，不能杀死新租约；单次取消不关闭同 tunnel 的其它租约。main 的 `onInvalidate` 链仍需调用 recognition bridge 的 `invalidate()` 立即终止麦克风/清理音频。桥自己还监听前后台、音频中断、media reset、route change；core 的 200 ms fence watchdog 不是 transport 物理取消的替代品。
6. `beforeCapture` 仅停止/释放现有共享 TTS owner，避免抢占音频 session；可由 main 调现有 `speech.invalidate()`。不要修改原朗读注册，不要接系统 Speech。
7. 构建现有 Swift source glob 会收录新增文件。旧 harness 的手写 Swift source list 需含 `RuntimeHostScope.swift`、`VoiceRecognitionCore.swift`、`VoiceRecognitionRuntime.swift`，并显式 `setForeground(true)`、写请求携带捕获 scope。main 已在其 owned harness 推进，本 owner 不改旧清单。凡执行 store 测试必须只编译已移除 Security/Keychain initializer/persist 的内存替身；本 owner 的 fixture 仅提供 `ConnectionStore(memoryData:)`，故错误调用无参 initializer 会编译失败。

## JS / Voice owner

异步构造一次（页面/Host scope）并等待实际原生 capability 成功：

```ts
const adapter = await createSettingsVoiceRecognitionAdapter({
  call: native,
  on: (name, callback) => host.on(name, callback),
  current: () => actualPageActive && capturedHostStillCurrent,
  invalidated: () => { void controller.closeAsr(); },
});
// 成功后才把 adapter 交给 SettingsVoiceTests.asrAdapter。
// 页面销毁/Host 失效：先 controller.dispose()，再 adapter.dispose()。
```

`invalidated` 需连到 controller 的关闭/失效动作，不能只丢弃事件而让 UI 永久停在 recording。UI 应继续使用现有 active/lifecycle、dirty、draftRevision fence；关闭弹层、覆盖页面、后台和销毁都必须触发 controller cleanup。

Capability 异步返回后也要检查页面/Host scope；若已失效，立即 `adapter.dispose()`，不要把晚到 adapter 安装到新表单。

注册名：

| 调用 | 严格字段 | 响应 |
| --- | --- | --- |
| `voiceRecognition.capabilities` | `{}` | `{providers:['local','openai-compatible','volcengine'], maximumSeconds:60, maximumBytes:1920000}` |
| `voiceRecognition.start` | `{owner,revision,provider,expectedHost:{hostID,lease}}` | `{owner,revision,provider}` |
| `voiceRecognition.finish` | `{owner,revision}` | `{text:string}`，空字符串是成功静音 |
| `voiceRecognition.cancel` | `{owner,revision}` | `null`，幂等且只取消该 lease |

事件：`voiceRecognition.partial` `{owner,revision,text}`、`voiceRecognition.invalidated` `{owner,revision}`。

`revision` 是现有 controller 的**capture sequence**，不是 `draftRevision`。`expectedHost` 来自打开动作捕获的原生 receipt；旧 start 缺失该字段直接拒绝，不影响 TTS、HTTP、permission 或 recorder。JS adapter/runtime 的 scope 传递由对应 owner 接线，本次没有自动补入最新 lease。Controller 仍负责 save + authoritative GET，并核对保存回执的 draftRevision；Swift start 再读 Host 并只把 JS provider 当预期身份检查。Swift finish/retry 再比较捕获时的非机密 ASR settings authority（URL/model/language/local model/resource/context/configured flags，只留 Swift）；不接受 draft 配置。finish/cancel 不要求新 scope，按原 owner/revision 清理；retired finish 清理后抛取消，不切换 Host 重试。

## 真实路由与限制

- `local` / `volcengine`：Host `/api/dictation/ws`。200 ms 16 kHz mono PCM16LE，`start` / `chunk(seq,audio)` / `finish(finalSeq)`，等待 `ready`、`ack(-1)` 和显式 `final`；partial 可实时显示。Host `service.js` 读取已保存 provider、key、资源及语境。网络失败后仅显式 retry 用保留的同一 PCM 重建会话，不重新录音。
- `openai-compatible`：受限 WAV 文件接口；不伪造实时 partial。
- 豆包 **不**调用文件接口：当前 `/api/stt/transcribe` 的豆包分支是 Flash `volc.bigasr.auc_turbo`，不能验证用户配置的流式资源权限。设置测试只走实际 Host streaming service；不同于当前 Web 客户端的 direct JWT 路径，但仍使用 Host 保存的流式 provider/resource/context，凭据不离开 Swift/Host。
- 60 秒 / 1,920,000 PCM bytes 录音上限；越界、中断、Host 失效销毁音频，不把未知 transcript 当成功。识别遵循 Host `finish_accepted` 的实际有界处理预算，不缩短有效本地 ASR 工作。`finish` 立即停录、flush、识别；`cancel` 不识别、清理 pending tasks/socket/临时文件/PCM，删除/音频清理失败保留精确 lease 供重试且阻止新录音。成功文本被缓存到 cancel，以免 cleanup 重试重复计费。
- Host 目前**没有 ASR settings revision/CAS 或 streaming-ready provider echo**；GET 校验与 Host 接纳 start/POST 间仍有配置竞争窗口，secret 轮换也不能从 redacted GET 检出。若要求跨设备配置变更严格原子一致，需要 Host 新增 opaque settingsRevision，并由 POST/start 条件检查及 ready 回传确认。不可把 JS 的 draftRevision 当 Host revision，也不能宣称已解决此 API 缺口。
- Host openai-compatible 文件处理当前未把 disconnect signal 传给上游；native 可物理取消本地任务/请求，但不能保证 Host 端已发出的付费请求停止。此为既有 Host API 限制，不应自动重试。

## 已验证边界

本次最终执行 **4 文件 / 111 项测试通过**：其中 native transport/admission/durable authority **101 项**；另含 TS adapter/controller、Foundation fakeAudio 与 iOS SDK 编译检查。生产 RuntimeBridge + 实际 RelayTunnel 使用 Swift 5 `-warnings-as-errors` 编译成仅内存 I/O runner；生产 AVAudioRecorder/Runtime/Store 又通过真实 iOS SDK 静态 typecheck（NativeShell 仅声明 stub）。检查覆盖请求/授权构造、有界响应、取消 pending mint/open/read/send/file、后台退役/恢复、A-B-A、同 ID 凭据替换、rename、失败持久化回滚、legacy nil、授权创建/替换/移除、拒绝 ASR 零 TTS/permission/audio/HTTP/WS，以及资源读取退役。它们不启动端口、网络或实际 Relay。

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-voice-recognition.test.ts packages/nsh/settings-voice-recognition-native.test.ts packages/nsh/settings-voice-recognition-sdk.test.ts packages/nsh/settings-voice-recognition-transport.test.ts
```

已检查旧 `check-native-bridge.mjs`：它会启动本机 HTTP/WS fixture，并访问一个 loopback 失败候选，非纯内存；本次未运行。也未运行真实录音、权限请求、Keychain、Host、凭据、付费 ASR、NSH engine、UIKit/设备、main build 或全仓 dead-code（该脚本使用依赖获取入口，本次禁止 deps）。AVAudioRecorder 实际 WAV flush/增量文件可见性、麦克风采样质量、真实 URLSession 直连/Relay、crypto/mux/auth gates 及 provider 权限必须由 main 后续串行验收；静态 SDK 与注入 I/O 检查不证明这些行为。跨设备 STT revision/CAS、scope-less queued 资源 owner、通知 proof/TTL/CAS 等边界仍按正文明确保留。未运行独立下层 review：工具发现未提供实际 spawn/delegate 能力，不能声称多层审查。
