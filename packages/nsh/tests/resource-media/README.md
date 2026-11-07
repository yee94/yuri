# Resource media UIKit 验收载体

## main 实跑追记

- `media-uikit-1794038644285.json`：真实 AVKit decode/play、Done 保留 lease、失败刷新保旧、Hide/Show 不重读、源关闭文件归零、慢读取消、真实 decoder 拒绝不支持格式。
- `media-controls-1794039148399.json`：使用系统 slider 实际前后 seek；只读时间/rate 序列证实暂停、约 0.70→3.30→0.70 秒及恢复播放；scoped close 与 Host fence 后 player 清空。
- `media-background-1794040004496.json`：WAV 的真实 ready/rate=1/time>0 样本先于 Home；后台/恢复后停止并清空 item、lease 保留可重开，源关闭归零，慢读后台取消。
- `NSH_RESOURCE_MEDIA_UI_TESTS=1` 的 4 个引擎场景已实跑全绿。以上均为中性合成文件与生产播放器，不代表真实 Host/Relay、大文件 Range 或真机全链通过。证据在仓库 `.scratch/nsh/chat-frames/`，不能把旧产物当后续源码证据。

**真实生产 `ResourcePreview` + `ResourceBridge`，不复制播放器。** iOS app 只替换窄 `ResourceTransport` 类型和捕获 closure；不编译 RuntimeBridge/ConnectionStore，不连接网络、Relay、Keychain、麦克风或 TTS 服务。NativeShell 的静态链接依赖包含 Security/WebKit/Network 等系统框架，不代表本载体调用了这些权限或开了网络。

独立 bundleID：`example.yuri.resource-media-uikit`。产物每次使用新时间戳/UUID，永不覆盖主 App、其他 fixture 或已有构建。

### 本轮可交接产物（已构建，未安装/启动）

- App：`packages/nsh/.nsh/resource-media-uikit/2026-11-07T08-08-42-274Z-ac521bbf/ResourceMediaUIKitFixture.app`
- Manifest：`packages/nsh/.nsh/resource-media-uikit/2026-11-07T08-08-42-274Z-ac521bbf/fixture-build.json`
- 媒体：app 内 `media/silent.wav` **256,044 bytes**；`media/neutral.mp4` **8,513 bytes**。完整 SHA-256 与编译时生产源码 hash 见 manifest。后续生产源码变动需要重建，不能把旧产物当作新代码证据。
- 本轮连续采样产物已完成完整字节码/Swift 链接、`codesign --verify --strict`、fixture transitive TS 检查及 engine 测试文件 TS 检查；未安装、启动或运行 engine。上轮构建脚本语法检查和默认禁用的 engine 用例收集（4 skipped）是历史记录，不是本轮媒体运行证据。
- dead-code 已运行并检查报告，仍有仓库未用文件/导出与 entry 配置提示；未据此删除其他文件。

## 构建（不会安装或启动）

```sh
NSH_BIN="/path/to/nsh/bin/nsh" node packages/nsh/scripts/build-resource-media-uikit.mjs
# 只编译独立字节码，不生成媒体或链接 iOS：
NSH_BIN="/path/to/nsh/bin/nsh" node packages/nsh/scripts/build-resource-media-uikit.mjs --bundle-only
```

NSH build 仅运行编译器；**不运行 `nsh test/run` 或 NSH engine**。完整构建在 macOS 用系统 AVAssetWriter 创建 320×180 H.264、12 fps、8 秒、无音轨 MP4：灰底、移动灰块和进度条便于看出时间变化；WAV 为 16 kHz mono PCM16、8 秒全零静音。二者各自 ≤1 MB，保留生产 25 MiB 上限。没有预先下载的媒体、ffmpeg 依赖、付费调用或真实用户内容。

输出：`packages/nsh/.nsh/resource-media-uikit/<buildID>/`：

- `ResourceMediaUIKitFixture.app`：arm64 simulator、iOS 15 minimum、ad-hoc signed。
- `bundle/`：独立 NSH 字节码；`project/nsh.json` 仅开放 resources 五项和 `fixture.media.control`。
- `fixture-build.json`：确切 app/bundle 相对路径、生产源码 SHA-256、媒体大小/SHA-256、`installed:false`/`launched:false` 等边界。
- `GenerateMedia.swift`、`generate-media`：只在构建 Mac 上运行的合成编码器。编码器会检查 MP4 `.isPlayable`，这不等于 iOS 已播放。

## 实现边界

- `fixture.tsx` import 生产 `../../resources`；`ResourcePreview` 的 gate、刷新、active、requestId、cleanup 全部未经替换。无主 application/App/navigation/本地化改动。
- JS 对 `host.call` 作**透明计数观察**，所有参数（包括 options）、结果和失败原样交给真实已安装 Swift handler。没有截断、伪造 `resources.read`/present 结果，也不把播放器交给 JS。它是验收 instrumentation，不是播放器实现。
- `uikit-main.swift` 将**原始生产 `ios/ResourceBridge.swift`** 与 NativeShell 静态框架链接，只 mock 同名的两字段 `ResourceTransport` 类型。固定合成 stat/serve 路径返回 bundle 内小文件，模拟按 64 KiB chunk 检查 limit，支持 Task cancellation/current generation；没有 URLSession/自建 tunnel。
- 原生窗口仍由生产 bridge 的 AVKit、Done、系统播放/seek controls 和 UIImage/PDF QuickLook 分支拥有。本载体没有额外创建 AVPlayer 或替换关闭/后台行为。
- `unsupported.mp4` 是真实无效容器，交给生产 AVURLAsset 探测，不硬编码 decoder unsupported。`slow.mp4` 在 serve 前等 8 秒，取消会中止 sleep 并计数。失败刷新是下一次 serve 显式抛错。
- Host fence 先增加 synthetic current generation，再调用生产 `bridge.invalidate()`，然后给页面新 scope；生产页面按新 scope 重新读取，不能复用旧 lease。后台完全依赖生产 bridge 的 `willResignActiveNotification` 和 NSH lifecycle，不手工伪造后台事件。

## AX 标识和计数语义

| AX/testID | 用途 |
| --- | --- |
| `media-open-audio` / `media-open-video` | 打开 WAV / MP4 的生产 ResourcePreview |
| `resource-media-preview` | **生产**预览按钮；只有 read 返回可用 native decoder capability 才存在 |
| `media-open-unsupported` / `resource-preview-unavailable` | 真无效容器及生产 unsupported 说明；不能有 preview 按钮 |
| `media-open-slow` | 8 秒慢 serve，用于 Close/Host/后台取消 |
| `media-fail-refresh` | 下一次 serve 抛错；随后点生产 `Refresh files` |
| `media-hide` / `media-show` | 翻转生产 `active` prop，不卸载；有效 lease 不应被释放 |
| `media-host` | 立即 Host invalidation |
| `media-arm-host` | 3.5 秒后 Host invalidation，可在 modal 出现时触发 |
| `media-arm-close` | 捕获当前 lease，3.5 秒后 scoped `resources.close`；用于 modal 中的显式取消 |
| `media-arm-sample` | 3.5 秒后只读采样真实 AVPlayer status/time/rate；不调用 play/seek |
| `media-arm-sequence` | `sample-sequence`：8 秒内每 0.5 秒只读连续采样，独立于旧 3.5 秒定时器 |
| `media-player-sequence` | 完整 AX label 为 `{sequenceRun,sequenceActive,playerSequence:[…]}`，最多 20 项 |
| `media-inspect` | 主动读取最新原生/文件计数；无网络 |
| `media-js-counters` | 完整 AX label 为 JS 观察 JSON |
| `media-native-counters` | 完整 AX label 为原生 JSON（含 `playerNow` / `lastPlayerSample`） |
| `media-source-state` / `media-source-closed` | 当前 source/path/active/scope，以及返回源选择页 |
| `media-fixture-error` / `resource-media-uikit-native-error` | fixture 控制或 bundle/native 安装错误，正常验收不能出现 |

两个 JSON 文本为保留播放入口空间而有固定视觉高度；**AX label 始终保留完整 JSON**，不把视觉可见首几行当成完整计数。

JS 字段：`reads/successes/failures`、`previewCalls/cancelCalls/closeCalls/releaseCalls`、最后 read `lease/kind/preview`、`lastPreviewLease`、`currentLeaseReleased`、`scope`。**previewCalls 是调用次数，不是窗口展示/成功播放；releaseCalls 是调用次数，不证明文件已删除。**

原生字段：`captures/statReads/serveReads/pending/cancelled/currentInvalidations/readFailures/rejected`、`failNextServe`、`temporaryResourceFiles` 与启动时 `initialTemporaryResourceFiles`。临时文件数只查本 fixture 沙箱 `resources-*` 的 regular files，不枚举用户目录或输出文件名。若上次被系统强杀留了文件，以启动 baseline 比较，不假称本次 cleanup 已删除历史残留。

`playerNow` 和定时 `lastPlayerSample` 包含 `nativePresentations/avkitPresentations/hasItem/itemStatus/time/rate`：窗口计数在 UIKit `present` completion 后确认真实 AVPlayerViewController 后代；time/rate 直接读其 player。`itemStatus=1` 对应 readyToPlay。**实际播放/seek仍要观察系统控件、画面和时间变化，不能靠 opens 或单个 ready 标志代替。**

原生 `media-arm-host` / `media-arm-sample` 共用单个定时器，后一次会取消前一次；按独立场景分别操作，不同时 arm 两者。JS scoped-close 定时器独立，必须先有当前 lease 才有可关闭的目标。

### 只读连续采样：seek / pause / Host / background

新增 `fixture.media.control({action:'sample-sequence'})` 与按钮 `media-arm-sequence`。**不修改旧 `sample-after`：仍在 3.5 秒更新 `samples` 和 `lastPlayerSample` 一次。** 连续采样使用另一条有界 Task，不取消旧 timer，因而可以与 `media-arm-host` 或旧 `media-arm-sample` 一起使用。

- 每次新 arm 取消前次 sequence，增加 `sequenceRun`，清空 `playerSequence`，置 `sequenceActive:true`。结果也保留在旧 `media-native-counters` 中；新增 `media-player-sequence` 便于单独解析，结束后保留最后一次序列直到下次 arm。
- `ContinuousClock`（iOS 16+）以 arm 时刻为起点，目标 tick 为 0、0.5、1…8 秒；只接纳实际采样时刻仍在 8 秒窗口内的结果，硬上限 20 项。正常最多 17 项；调度延迟可使截止处样本缺失，不伪造精确 500ms 间隔或补齐样本。fixture 的其他原有能力仍支持原 minimum；iOS 15 调用新 action 明确报不支持，不静默换时钟。
- 每项保留真实 `hasItem/itemStatus/time/rate/nativePresentations/avkitPresentations`，新增 `elapsedMs`（相对起点的真实连续时钟毫秒）、`generation`、`applicationState`（UIKit rawValue：0 active、1 inactive、2 background）。不调用 play/pause/seek，不创建、替换或持有其他播放器，不因 Host 失效清空序列。
- pause 证据：同 generation / 同 avkitPresentations / hasItem=true / itemStatus=1 的多个样本中，rate 从 1 变 0，time 停住，再手动 play 后继续。seek 回退证据：elapsedMs 递增但 time 明显减小，同时 hasItem=true、generation/avkitPresentations 未变；窗口消失后的 time=0 不能算 seek 成功。
- Host 证据：先 arm sequence，再 arm Host fence，立刻进入真实播放器手动播放。3.5 秒失效前后应有旧 generation 的播放样本，以及新 generation 下 hasItem=false / rate=0 的后续样本；不把新 source read 的成功当成播放器仍活着。
- background 证据：arm sequence 后手动进入后台并在 8 秒内返回，观察真实系统动作及前后样本/Inspect。系统挂起时可能完全没有采样；返回已超过 8 秒则停止，不补写“后台 rate=0”的假证据。此时用返回后的 `playerNow` 和实际声音/画面/控件状态补证，不能声称数组证明了挂起期间发生的一切。
- main 已发现 AVKit controls 会自动隐藏；需要 tap 视频后在同一 QA shell 中立即读 AX 再操作系统控件。序列只读，不负责唤醒 controls。

main 已报告先前载体的真实 controls、MP4 ready/rate/time、Done、失败刷新、Hide/Show、Close 文件清理、slow 取消和真实 unsupported gate 通过，证据位于 `.scratch/nsh/chat-frames/media-uikit-1794038644285.json`。本分工未复跑该设备证据；新增 sequence 尚待 main 对新产物验收。

## Main 串行 UIKit QA 清单（本分工未执行）

1. **初始**：打开 app，检查无 native/fixture error；先 Inspect 记录 native baseline。source closed，不能预加载资源或出现系统播放器。
2. **WAV**：点 WAV，等待生产 `resource-media-preview`。JS kind=audio、preview=avkit；点预览出现真实 AVKit 系统 controls 和 Done。手动 play/pause/seek；静音 WAV 不应以“没声音”误判没有播放，实际看时间推进/暂停与 seek 回退。可先 arm sample 再预览/播放，Done 后读原生 sample 的 rate/time。Done 只返回源页，不能释放有效 lease；再次预览应重开。
3. **MP4**：点 MP4；先 arm sample，再点生产 preview，手动 play。移动灰块和进度条随帧变化；拖系统 seek 前后各一次，确认画面/时间一起变化，无 WebView。Done 后 Inspect：avkitPresentations 增加；lease 保留、文件数量 baseline+1。不要将 JS previewCalls 当成播放证据。
4. **无效媒体**：切 Unsupported，等真实 decoder probe。生产 unavailable 存在且 preview 按钮不存在；Save/Share 仍存在，可进入真实系统 picker/share 并取消，不应产生 AVKit window。旧 MP4 lease 的 releaseCalls 增加；不以一个模拟 disabled 按钮充数。
5. **失败刷新**：切 MP4 正常读完，记 lease。点 Fail next refresh，再点生产 Refresh files。readFailures/failures 增加、错误显现，但旧 lease 不变、currentLeaseReleased=false、preview 仍能打开。随后刷新成功才换新 lease；检查文件数没有累积。
6. **Back/取消**：点生产 Close，回到 source closed；Inspect 后当前资源文件数回 baseline。再点 Slow，pending=1 时立即生产 Close；cancelCalls/cancelled 增加，pending 回 0；不应有迟到 preview 或新增资源文件。
7. **Hide/Show**：正常读 MP4 后 Hide：closeCalls 增加但不释放 current lease；Show 后仍是同 lease、无需重读且可再次 preview。若 native Host 确已 invalidated，则不能把上述同 lease预期套到 Host 切换。
8. **modal 中 scoped close**：正常 MP4 source 下先点 Stop modal in 3.5s，然后进生产 preview 并播放；3.5 秒后窗口应关闭、播放停止、present 请求取消，lease 可重开。迟到 close 不能关其他 lease 的新窗口。
9. **Host fence**：先点 Host fence in 3.5s，再进 preview/play。定时失效应停止并清空播放器，currentInvalidations/scope 增加；新 scope 只能从新 read 得到新 lease。再对 Slow 执行立即 Host fence，确认旧 scope pending 被取消、不能发布旧 lease，最后可正常重开 MP4。
10. **后台/前台**：真实系统 home/切应用/锁屏（由 main 操作），不发送伪通知。视频/音频不得继续播放；前台无旧 AVPlayerItem 运行，可显式重开有效 lease。pending Slow 后台会被取消；回前台是否自动重新 load 由生产 active/lifecycle 契约决定，不能把新 foreground read 算成旧请求未取消。
11. **保存/分享**：真实 picker/share 取消及保存确认分别检查。用户明确选择目标后才允许导出；fixture 不自动点击确认/写用户目录。保存下来的媒体应与 bundle 中校验值一致；完成状态不是已播放的证明。

## Headless gate/cleanup 测试（只准备，不在本分工运行）

`packages/nsh/resources-media-ui.test.ts` 默认 skip，main 获得独占 engine 窗口后显式运行：

```sh
NSH_RESOURCE_MEDIA_UI_TESTS=1 NSH_BIN="/path/to/nsh/bin/nsh" \
  bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/resources-media-ui.test.ts
```

每个场景生成自己独立 temporary project、capabilities、Host mock 与 `.nsh/test` 目录，不覆盖 root/别的 fixture。覆盖 supported/unsupported/missing-preview button gate、exact lease、刷新失败保旧、成功替换释放、Back cancel、Hide/Show、Host scope。这里明确 mock `resources.*` 返回以测试生产 JSX，**与 UIKit 载体中真实 Swift 路径不同**；不输出或声明媒体实际播放/seek通过。

main 已报告首轮联合 focused 结果 27 passed / 2 failed；两处失败为把 JSON 子串当 NSH 精确 text selector。现已把 owned test 中 failNextServe/pending/cancelled 的全部 JSON 子串等待改为 `app.waitUntil(() => app.texts().some(text => text.includes(...)))`，错误提示也按完整目标短语作子串等待，避免 `Error:` 前缀影响。未删验收、未改 production；TS 检查通过，engine 复跑仍归 main，不能提前标绿。

## 交接证据

- C：载体直接 import/link 当前生产源码；main 已接的资源 UI/授权/25 MiB 限制未被更改。
- F：独立字节码、合成媒体和 arm64 iOS app 构建成功；脚本/engine 测试 TS 静态检查通过。headless engine 新用例未运行。
- H/S/D：本分工全部未运行；main 所述既有 direct/Relay harness 通过，不等于这个 fixture 的播放验收。
- 当前没有可调用的下层 agent 派发工具，未派发、未冒称完成多层独立复核。请 main 按上述逐项留下 UIKit AX、截图/录像和失败记录。
- **大于 25 MiB 的流式播放/Range/导出仍是完整缺口**；该载体只验小文件，不降低原有验收范围。
