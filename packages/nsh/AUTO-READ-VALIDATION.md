# Native 自动朗读：证据与接线合同

日期：2026-11-07。首轮 scope 只新增 `native-auto-read*` 及窄改 `speech-core.ts` / `speech.tsx`。后续用户明确授权续工增加 `ios/SpeechPlaybackBridge.swift` 的 source-aware gate 与 guarded awake 合同；仍未改 `application.tsx`、`state.ts`、`chat-header*`、`nsh.json`、`main.swift`、正文或公共 DOC/CHAT/PARITY。

## 明确续工：source-aware gate 与常亮边界（后于下方首轮记录）

- `speech-core.play(id, text, restart, 'auto-read')` 在 settings.visible=false 时仍播放，segment 显式携带 `source:'auto-read'`。默认/手动仍受 visible 限制；Swift 同样以真实 source 选择 visible gate。未知 source、错误 owner、非递增/布尔 revision、失效 Host、非前台、非法 provider/audio 仍拒绝。旧无 source 请求按 manual 处理。
- `SpeechPlaybackBridge.swift` 增加 willResignActive 失活通知，并保留已有 background/音频中断/Host invalidate/release 清理；每个 segment 的 await 后 current fence 也明确校验 foreground。JS 回归修复了 native background invalidation 后自动运行永远 halt 的问题；恢复只对之后的新 rendered reply 生效。
- 新增同 owner 的 **`messageSpeech.awake(enabled): Promise<boolean>`**，使用独立递增 awake revision，不推进/取消音频 revision。原生 route 是 **`speech.awake`**，body 严格为 `{owner, revision, enabled}`。enable 必须匹配已 prepare 的 owner、当前 captured Host 与前台；disable 仍严格匹配 owner/revision，但允许失活后的释放请求。
- **常亮依然明确 unsupported，而非已实现。** UIKit 官方 `UIApplication.isIdleTimerDisabled` 是应用级 Bool，没有独立 acquire/release token。仅保存旧值再恢复，无法知道期间其他 feature/embedded runtime 是否新增了同值 true 的持有；目前没有已证实的统一 idle-timer owner。按用户“无可靠边界就保持缺口”的要求，原生返回 `{supported:false, enabled:false}`，不写 idle timer，故不会破坏原值或其他持有者，也不另建全局 owner。未借用 background task 冒充 screen wake lock。
- Adapter 只根据 running / foreground / current / scope 的窄生命周期变化调用同一个 speech.awake；100 次同 scope 更新只 acquire 一次。disable、scope 切换、销毁提交 release；晚到结果不会复活旧 scope。unsupported/transport failure 只提示一次，不停自动朗读、不循环重试。
- Adapter 新增 **`awakeState()`**：`idle | requesting | held | unsupported | error`。实际当前 Swift 不会返回 held。新增可选 **`onWarning(key: 'mobile.menu.autoReadAwakeFailed')`**；未提供时回退到 `onError`，因此 onError key 类型扩为该 key 与 `mobile.menu.autoReadFailed` 的 union。主线程应接可见的 warning，不能忽略后声称常亮已生效。capability `speech.awake` 由 main 添加，本 scope 没改生产配置。
- `native-auto-read-host.js` / 独立 fixture 已适配合成 unsupported 返回和独立 warning 展示；**未重跑任何 UI fixture**，留 main 统一验证。

续工验证（仅纯 TS 与 macOS Swift contract，不启动 NSH Host）：

```sh
bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/speech-core.test.ts packages/nsh/speech-native.test.ts \
  packages/nsh/native-auto-read-core.test.ts packages/nsh/native-auto-read-reply.test.ts \
  packages/nsh/native-auto-read-awake.test.ts
```

结果：**5 files / 40 tests passed**（14:06:59）。`speech-native.test.ts` 用 macOS swiftc 编译 Foundation-only contract 并做桥接 shape guard，不编译/运行 UIKit 分支，不是 iOS build 或听音证据。`bunx tsc --noEmit -p packages/nsh/tsconfig.json` 未全过：scope 外 `assistants-details.tsx` task/accessibilityRole 和共享 `runtime-url.ts` DOM iterable 类型报错；没有改这些模块。续工未运行 NSH CLI、engine UI Vitest、浏览器、模拟器或设备，没有真实配置/凭据/语音调用。

续工 `bun run dead-code` 已重跑并检查：现有全仓告警仍在，字符串启动的 `native-auto-read-fixture.tsx` 与尚待 main 生产接线的 `native-auto-read.tsx` 继续列为 unused；未删文件，未声明零告警。

依据：Context7 查询 UIKit 官方 [isIdleTimerDisabled](https://developer.apple.com/documentation/uikit/uiapplication/isidletimerdisabled) 与 NSH effect/cleanup 语义；没有将 macOS contract 通过等同于 UIKit runtime 已验收。

## C / F / H / S / D

| 证据 | 本轮状态 |
| --- | --- |
| C：生产接线 | 既有单 Chat speech owner 已补明确播放结果与操作通知；自动朗读 controller/NSH observer 已实现。生产 Chat/header/body 接线尚由主线程完成，不能标为功能已上线。 |
| F：fixture | 纯 controller、真实 speech-core、正文 plan 投影、独立 NSH headless fixture 通过。fixture 只用内存偏好、合成 Host 和无声 segment Promise。 |
| H：真实 Host | 未运行；没有读取/写入真实配置、连接凭据，没有模型或语音调用。 |
| S：模拟器 | 未做本功能 UIKit 验收；NSH fixture CLI 后经 main 的 SpringBoard 日志确认会把 `com.longbridge.nsh.host` 拉到前台，不能当作无 UI 副作用的纯引擎测试。其结果不计为 S，也不证明 UIKit commit、音频焦点或锁屏行为。 |
| D：真机 | 未运行；不宣称真实 TTS、后台恢复、识别或听音已验收。 |

## Web 依据

- `packages/ui/src/mobile/chat/MobileAutoRead.tsx`：17–23 持久偏好与运行状态分离；27–55 停止、generation fence、串行队列与失败通知；56–80 baseline floor / seen / observed、rendered / streaming admission；82–109 scope/Host/可见性；111–122 screen awake。
- `auto-read-context.ts`：9–20 只在 committed body 完成后以两次 RAF 报 rendered，卸载取消；流式只报告 observed，不逐 token 朗读。
- `MessageBody.tsx`：1459–1474 根据 `ttsInputMode` 选择 final trailing body 或有序 text；排除错误和尚在 streaming/cooldown 的完成回调。不是拿 `message.text` 聚合全部工具/思考。
- `MobileAutoRead.test.tsx`：历史/前插不重播、完成只读一次、真实音频结束才 drain、停止持久禁用、切 scope 保留偏好、hydration gate。
- `useMessageTTS.ts`：126 speech capture 互斥；138 起共用当前消息播放权；169–196 输入模式及 summarize/raw 策略。Web 自动朗读与“显示消息朗读按钮”不是同一个偏好。

## 已实现的行为边界

- 设备级 `yuri.auto-read`，序列化值为 `true` / `false`；只接受 literal true，旧/损坏值不升级为开启。共享偏好对象供多个 Chat 使用，但不会共享或新建音频 owner。NSH Storage 与浏览器 localStorage 是各自设备容器，不声称跨应用同步。
- Storage read/write 错误保留已确认值并显示错误状态；只有显式操作/`retryPreference()` 重试，不靠 render 或 poll 重试。开关操作串行；禁用先停止自动队列，再提交偏好。
- `messages` 仅在启用/恢复/换 scope 时建 floor 与 seen；100 次普通 snapshot 更新不再扫描历史。只由真实 body 的 settled callback 入队，已观察流式可以越过较早 created floor，其他旧页不行。queue 顺序是 committed callback 顺序，不按 ID 或时钟重排。
- 一次只调用既有 speech 的一个 play；只接受 `completed` 才 drain 下条。`failed` / `unavailable` 明显报错并停止当前运行，偏好保留；`cancelled` 不伪装完成。晚到成功/失败受 generation fence 约束，不再推进旧队列。
- 后台/隐藏清空正在播放及 pending；恢复重新对当前成功快照建 baseline，不重播离开时的消息。Host/session/directory/reset 使用不同 scope；这些变化不清除持久偏好。
- 正在自动播放时，从原有消息操作条 `speech.stop()` 会停用并持久禁用自动朗读；手动 play 同样夺取唯一 owner，丢弃旧自动队列。空闲时手动 play 暂停本轮自动运行，不叠加第二 owner。
- `beginRecognition()` 同步设互斥 guard，再 await 同一 speech 的 stop；stop 失败时 reject，调用方必须不启动识别。结束或启动失败时 `endRecognition()`，只接收之后的新回复。`recognizing` snapshot 另覆盖已在录音的状态。
- identity 集合只存当前 scope 的消息 ID，不保存音频/凭据；scope 重建及 dispose 清理，pending 文本在取消/失败/完成时释放。没有为避免重复而截断正文或丢弃正常排队回复。

## 主线程接线：精确接口及 Hook 位置

入口：`native-auto-read.tsx` 的 `createNativeAutoRead` / `NativeAutoReadBody`。

### Chat owner（在 `recording` signal 创建之后）

```tsx
const autoRead = createNativeAutoRead({
  speech: messageSpeech, // 已存在的同一个 createNativeSpeech，不再创建另一个
  snapshot: () => ({
    scope: autoReadScope(),
    sessionID: props.target.id,
    active: current() && chat.active(),
    resolved: messagesResolved(),
    recognizing: recording(),
    messages: chat.messages(),
  }),
  onError: key => chat.error.set(t(key)),
});
```

`autoReadScope()` 必须包含 Host identity + epoch、directory、target kind/id、权威 history/contact reset generation。不要放 token。`foreground` 由 adapter 的 `lifecycle()` 自己接入；销毁取消自动队列但不 release 别人的 speech，原 Chat speech cleanup 仍唯一持有 release。

**当前 `state.ts` 的 `messagesLoaded` / `contactGeneration` 是局部变量，不是可直接读取的公开信号。** 主线程需暴露权威 `messagesResolved` 和 reset generation（或等价结构化通知）。不能用 `!chat.loading()`、`messages.length`、`streamState === 'live'` 或首次请求 finally 猜 hydration 成功；初始失败不等于成功空会话。普通 safety refresh/加载旧页不能把 resolved 暂时改回 false。切换到新 scope 时，snapshot.messages 必须已属于新 scope，否则先传 `resolved:false`。

### Header 开关

- checked/enabled 偏好：`autoRead.state().preferred`，不是 `running`。
- available：`autoRead.state().available`；toggle：`() => { void autoRead.toggle(); }`。
- label 复用 `t('mobile.menu.autoRead')`。故障后偏好仍为 true，但 running=false；用户 off/on 可重新启用，只读未来回复。
- `state().error` 为 `preference-read` / `preference-write` / `playback` / null，`onError` 只给已有本地化 key，不泄漏原始错误。持久读失败可显式调用 `retryPreference()`。保留已有单一 `NativeSpeechSettingsError`。

### 实际渲染 body（不是 Chat 的 messages effect）

在 `NativeTranscriptBody` 已创建 `plan = computed(() => nativeBodyPlan(...))` 的生命周期内，跟实际正文一起挂：

```tsx
<NativeAutoReadBody autoRead={autoRead}
  scope={autoReadScope()} sessionID={sessionID}
  row={props.row} plan={plan()} streaming={actuallyStreamingThisTail} />
```

`plan` 必须是本行真正用来渲染的同一份 plan，不重跑第二套正文推断，也不能放在未挂载正文的全量列表循环里。组件无视觉节点；两帧 callback 及 cleanup 对齐 Web admission。`nativeAutoReadBody` 导出为纯投影，final 选真实 tail 的 inline trailing model part；其他模式保持 tail text 的原始顺序，不读工具/思考。

`actuallyStreamingThisTail` 来自该消息的真实内容流生命周期。**当前 `chat.streamState()` 是 SSE 连接状态，不是单消息 streaming 证据**，不能把它当 observed；若需要旧 created 的 live 例外，主线程应提供 message-level stream 证据。在无证据时传 false，不能拿 persisted busy/缺 completed 猜流式。

### 开始/结束听写

在 `dictate()` 的 `Speech.available()` 和 `Speech.start()` **之前** `await autoRead.beginRecognition()`，替代单独 `await messageSpeech.stop()`。开始失败/取消/识别 end/abort 的所有路径均调用 `autoRead.endRecognition()`；实际录音期间 snapshot 仍传 recording=true。只在 stop 成功后允许启动识别。

## 实际验证

- 红→绿：首次缺失 core/reply 模块；playback failure 未显式报错；手动 stop 未持久禁用；beginRecognition 缺失；快速开关未串行；Native lifecycle stop 导致永久 halt。均保留回归并修复。
- NSH fixture 初次失败是 `fixture.*` 未获 capability；没有改生产 capability。测试 Host 改用已授权 `runtime.request` 的纯合成 `/fixture/*` 路由，无真实请求，重跑通过。
- `bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts` 加精确文件过滤：`native-auto-read-core.test.ts`、`native-auto-read-reply.test.ts`、`native-auto-read-native.test.ts`、`speech-core.test.ts`、`speech-ui.test.ts`：**5 files / 30 tests passed**（13:50）。NSH_BIN 使用任务提供的 0.4 CLI。未运行 production `App.tsx` headless，也未跑会启动它的全包测试。
- `bunx vitest run --project @yuriai/ui packages/ui/src/mobile/chat/MobileAutoRead.test.tsx`：**1 file / 11 tests passed**。现有 Vite native-loader 与 React act 环境 warning 保留，没有隐藏。
- `bun run --cwd packages/nsh nsh:check`：通过（两次，最后 13:51）。这是静态检查，不是 iOS build。
- `bun run dead-code`：运行两次并检查报告。仓库已有大量告警；新增 fixture 被字符串 CLI 启动，adapter 生产接线未完成，两者列为 unused；没有删除未知文件或声称零告警。
- main 后续通知进入设备验收窗口：已暂停所有 NSH CLI test / engine UI Vitest，不再重跑上述 fixture 或旧 speech UI；后续统一由 main 运行。此前 CLI 的 NSH Host 前台副作用不能表述为“完全未影响模拟器”。没有主动操作浏览器或执行 simctl。

## 未闭合项（不能算完整 Web parity）

1. C 生产 header / Chat / body 接线及权威 hydration、reset、单消息 stream 信号需主线程完成；仍须生产集成回归。
2. 首轮 visible gate 缺口已由上方明确续工的 source-aware JS/Swift contract 补齐 C/F；真实 Host/设备播放仍未验收。
3. Web screen-awake 已有 guarded 同 owner lifecycle 请求与 unsupported 提示；没有可靠的跨持有者 idle timer 边界，原生尚不取得物理常亮锁，不能声称屏幕常亮或锁屏后持续朗读。
4. 原 speech owner 继承的差异仍在：server/raw 文本清理与切段、豆包 Host MP3 非 Web 流、恢复以当前 segment 为边界、无逐词高亮；没有用本轮测试冒充修复。
5. 真实 Host provider 路由、真声音频结束/中断、iOS 后台/前台/音频会话/麦克风权限、UIKit 两帧与虚拟化复用，均待 H/S/D。没有付费调用，没有真实 TTS 验收。
6. 当前工具目录未提供 spawn/delegate，无法按要求实际启动 explore；本轮直接核对上列 Web 源码/测试证据，没有额外模型调用。
