# R05/R10：原生资源媒体预览

日期：2026-11-07。本分工只修改 `ios/ResourceBridge.swift`、`resources-model.ts` 及纯测试，新增本记录。**媒体 bridge 已实现，生产媒体 UI 接线仍归 main；未运行 NSH engine、设备、真实 Host 或网络 fixture。大文件流式媒体仍是完整交付缺口，不是删除验收项。**

## 当前 Web 源码与 Apple API

- `../ui/src/apps/MobileFilesSurface.tsx:713`：当前普通文件目录中的非图片二进制仍走 `BinaryFileFallback`，不能声称该组件已有通用音视频播放器。其 GUI/plugin preview 优先于 fallback。
- 实际 Web 视频 owner：`../ui/src/components/chat/video.ts` 接受 `video/*`、`data:video/`、`mp4/m4v/webm/mov/ogv/ogg`；`message/ToolOutputDialog.tsx` 分派到 `message/VideoPreviewDialog.tsx`。后者使用 `<video controls playsInline preload="metadata">` 和 `MediaSaveButton`，保留播放/暂停/seek/保存及错误。普通文件路径、`/api` 路径、外部/data URL 的分派并不相同。
- `../ui/src/lib/native-video.ts`：Capacitor iOS 视频桥已有 **1 MiB 分段、206/Content-Range/长度验证、取消和 runtime/auth-generation 失效**。这不是 NSH 已实现的功能。本轮不移植带 JS 字节回传的 Capacitor 插件，也不开放远程 URL 给 AVPlayer。
- 只读检查未发现 MobileFilesSurface 通用 audio preview owner；本轮仍按任务要求接纳原生音频，不以这个差异缩减 scope。
- 已先做 Context7 `resolve-library-id`，使用 `/websites/developer_apple_avkit`、`/websites/developer_apple_avfoundation` 的 `query-docs`。QuickLook resolve 没有得到正确库，改读 Apple 官方文档 JSON，而非拿 Apple Support 充当 API 文档。
- [QuickLook QLPreviewController](https://developer.apple.com/documentation/quicklook/qlpreviewcontroller)：官方列举图片/PDF/文档等，明确支持格式会随 OS 变化；运行时调用 `canPreview(_:)`，不硬编码保证所有编码可用。
- [AVPlayerViewController](https://developer.apple.com/documentation/avkit/avplayerviewcontroller/player)、[showsPlaybackControls](https://developer.apple.com/documentation/avkit/avplayerviewcontroller/showsplaybackcontrols)：复用系统播放器和原生播放/seek 控件，不继承 AVPlayerViewController，不创建 WebView。没有采用 Context7 结果中 iOS 27 才有的新 seek UI API。
- [AVURLAssetReferenceRestrictionsKey](https://developer.apple.com/documentation/avfoundation/avurlassetreferencerestrictionskey)、[forbidAll](https://developer.apple.com/documentation/avfoundation/avassetreferencerestrictions/forbidall)：禁止容器引用其自身以外的任何媒体。即使本地 MOV 也可能携带引用；只给 AVPlayer 本地 URL 本身不足以证明不出网。

继续保留 image/PDF 的 QuickLook。媒体改用 AVKit 是为了在已验证的本地文件上强制 reference restriction、监测播放失败并确定性停止播放器；不能把不透明的 QuickLook 内部播放生命周期当成已满足相同限制。

## Main 的精确 bridge/UI 契约

现有 ResourceBridge 安装与 captured ResourceTransport 无需改签名。新增字段兼容旧 image/PDF fixture；真实 Swift 每次返回 `preview`。

```ts
type ResourceKind = 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'binary';
type ResourcePreview = 'quicklook' | 'avkit' | 'unsupported';
type ResourceContent = {
  kind: ResourceKind;
  preview?: ResourcePreview;
  previewError?: string;
  lease: string; size: number;
  text?: string; thumbnail?: string;
};

// requestId 为调用方每次新建的唯一 opaque ID，非凭据；可选以兼容旧调用。
await native<ResourceContent>('resources.read', { path, requestId });
await native('resources.cancel', { requestId });
await native('resources.present', { lease, action: 'preview' });
await native('resources.present', { lease, action: 'save' });
await native('resources.present', { lease, action: 'share' });
await native('resources.close', { lease });
await native('resources.release', { lease });
```

- `kind` 是类别，不是 codec support。`resourceKind` 只作无网络的类别判断；**UI 必须使用返回的 `preview` 或 `resourceCanPreview(content)`**，不能因后缀支持就画能播放的假按钮。新 video/audio 没有 `preview` 时 helper 返回 false；仅为旧 fixture 保留 image/PDF 缺字段行为。
- 已知 Web 六种 video 后缀及 `video/*` 进入 video；`mp3/m4a/aac/wav/wave/aif/aiff/caf/flac/oga/opus` 及 `audio/*` 进入 audio。歧义 Ogg 优先按响应 MIME 判定。实际 codec 依本机 `AVURLAsset.load(.isPlayable)`；不承诺所有 WebM/Ogg/Opus 均能原生解码。
- `m3u/m3u8/pls/mpd` 和 HLS/DASH MIME 明确返回 binary/unsupported，不请求 segment、密钥或外部引用。其他未知媒体失败也不使用 WebView/网络 URL fallback。
- 无法解码：仍返回原文件 lease 与 `kind:'video'|'audio', preview:'unsupported', previewError`，可真实保存/分享；不能显示可点击的播放假能力。动态播放失败同时观察 item.status 与 `failedToPlayToEndTimeNotification`（已查 Apple 官方 API）；拒绝 `resources.present`，保留原 lease，关闭时移除观察。
- `preview:'avkit'`：原生 UINavigationController + 内嵌 AVPlayerViewController；系统 Done，用户手动播放，系统控件拥有播放/暂停/seek。关闭再开从头开始，不承诺恢复时间点。不开放 PiP/AirPlay 后台播放，不修改全局 AVAudioSession。
- `preview:'quicklook'`：原 image/PDF 原生预览。文本继续由已有源码/Markdown UI 持有，HTML/Eficy 执行归另一 owner。
- `resources.present` 等待窗口完成，Done/手势关闭/取消返回 `{completed:false}`；保存确认返回 `{completed:true}`，分享使用系统 completed 值。**preview 的 completed 不是媒体播放成功或播完的证明。**
- `resources.close({lease})` 只关闭同 lease 的当前系统窗口；过时页面 cleanup 不能关闭另一资源。`resources.cancel({requestId})` 只取消该请求，未知/已完成 ID 为幂等 no-op；不释放已返回 lease。调用方仍要 fence 迟到成功并 release。
- 页面失去 active/卸载：cancel 在途 requestId，close 当前 lease，然后 release；取消自身会让仍等待的 present 拒绝 CancellationError。`release` 若发生在窗口使用中，延迟到 finish 删除文件，不丢弃清理意图。
- main 仍须在当前资源区域加入 audio/video 的 preview 入口、不可播放说明/重试和已有真实 save/share；本分工未改 `resources.tsx`。错误 UI 使用现有本地化键或 main 持有的映射；桥内错误目前与原 bridge 一样为中文，不能据此声称十语言错误均对齐。

### 生命周期接线与框架

- `ios/main.swift` 现已安装 ResourceBridge，且 `RuntimeBridge.onInvalidate` 链调用 `resources.invalidate()`。main 必须保留这条链，不替换其他 resource-web/speech/desktop owner。
- Host 失效/teardown：`invalidate()` 同步增加读 generation、cancel 所有读取、pause/清空当前 AVPlayerItem、关闭窗口、拒绝当前 continuation、删除全部 leases。新 Host 必须重新 read；旧 lease 不可重开。
- 失活/后台：bridge 自己观察 `UIApplication.willResignActiveNotification`，cancel 读取并关闭/停止播放；**不删除仍 current 的已完成 lease**，回前台可显式重开。若 RuntimeBridge 同时 invalidate，则必须重新 read，而不是使用旧 Host lease。
- 用户关闭/播放失败不释放有效 lease，便于重试；只有调用方确认成功换新后再释放旧 lease。读取失败不触碰已有 lease；取消中写出的临时目录被清理。
- 构建 owner 检查 `scripts/build-ios.mjs` 的 framework 清单：需要 **AVKit、QuickLook、AVFoundation、UIKit、Foundation、ImageIO**。当前清单已有其他项，显式列表缺 **AVKit/QuickLook**；本分工按要求未改 build-script，也未做完整链接验收。Swift 自动链接不能替代 main 的最终链接证据。

## 安全与大小边界

- 全部 stat/serve 仍调用 **同一次捕获的 ResourceTransport.read**；在启动 owned Task 之前同步 capture，Task 入口再次校验 generation/current，避免旧动作排队后误捕获新 Host。只传相对 Host 路由，不传 endpoint/认证或播放器网络 URL 给 JS；不创建 URLSession/tunnel，不新增 Relay 配对授权 fallback。
- 已只读核实 RuntimeBridge 原实现：直连按 bytes 接收、Relay 按 chunk 接收时执行传入限额，支持 unknown Content-Length，取消向下传递；generation 变更后拒绝旧响应。现有 session 的 redirect 拒绝仍归 RuntimeBridge；ResourceBridge 还要求 serve **HTTP 200 完整响应**，不接受 206/3xx 作为完整下载。
- 保持 **文本 1,000,000 bytes、其他资源 25 MiB**；stat 已知超限在 serve 前拒绝，实际传输也有上限，保存前二次检查。未知类型若 stat 未声明 binary，采用更保守的文本限额，不靠 MIME 扩大正在进行的读取。
- 每 bridge 最多两条在途 read，每条最多 25 MiB payload；最多 32 个已完成 lease，并在 publish 时再次校验数量，避免 async 重入穿透上限。不是零复制或已测峰值：transport Data、AVFoundation 解码及图片缩略图还有额外开销。大视频不转 base64/JS，不加无限 buffer；完成文件在受保护的原生临时目录中。
- AVURLAsset 的 `forbidAll` 和 playlist admission 双重约束不跟随外部/其他本地文件引用；播放器只持有该受控文件及 asset。未给它 bearer、Cookie、HTTP header 或远程 Host URL。
- 超限不能 preview、save 或 share；保持明确错误和重试，不把失败报成空内容成功。不能把此限制当作“完整支持大视频”的验收结果。

## C / F / H / S / D

C = 生产接线；F = fixture/纯测试；H = 真实 Host；S = 模拟器；D = 真机。

| 能力 | C | F | H | S | D |
| --- | --- | --- | --- | --- | --- |
| 原 image/PDF QuickLook 与导出 | 已保留，新增 canPreview gate | Swift SDK typecheck；非运行 UI | 未测 | 未测 | 未测 |
| 小型 video/audio 原生播放/seek | bridge 完成；媒体 UI 入口待 main | 类别测试 + 完整 iOS 15 SDK typecheck | 未测 | 未测 | 未测 |
| 不支持 codec 的真实原文件保存/分享 | bridge 完成；说明 UI 待 main | 类型/准入覆盖；未运行系统 picker | 未测 | 未测 | 未测 |
| captured 直连/Relay、限额/无 redirect | 复用现有 transport，无新绕行 | 本轮仅源码边界断言，不等于传输运行证据 | 未测 | 未测 | 未测 |
| 失败保旧 lease、取消/后台/Host stop | bridge 已接；页面 cleanup 待 main | 源码边界断言/Swift typecheck，非生命周期运行证明 | 未测 | 未测 | 未测 |
| >25 MiB 媒体、Range/大文件导出 | **未实现，仍在全量 scope** | 未测 | 未测 | 未测 | 未测 |

本轮执行：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/resources-model.test.ts packages/nsh/resource-media-swift.test.ts
bunx tsc --noEmit --strict --target ES2022 --module preserve --moduleResolution bundler --skipLibCheck packages/nsh/resources-model.ts
bun run dead-code
```

- 两个文件 **12/12** 测试通过；包含 production Foundation 格式准入的实际 macOS 编译/执行、完整 ResourceBridge + 当前生产 ResourceTransport 声明的 **iOS 15 simulator target SDK typecheck**、TS 分类/限额/legacy fixture 及静态安全边界断言。
- 首次测试因禁止 WebView 的正则误匹配原有说明注释失败，改为检测构造调用后重跑通过；未改该原有注释。
- focused TS typecheck 通过。dead-code 已运行并检查报告；有跨仓库存量告警与 NSH fixture entry 配置提示，未删除不熟悉文件。没有把非阻断脚本退出 0 当成零告警。
- **未运行** NSH engine、整包 check/bundle/build、模拟器 UI/播放、真实直连/Relay、网络 fixture、系统保存/分享或真机；未运行 git/GitHub，未加依赖。没有派出其他 agent，不声称多层检查已完成。

## Main 的必要后续（全部保留在验收范围）

1. 按返回 `preview` 接媒体 UI，携带 requestId 并接 scoped close/cancel/release，保留失败快照和重试；校验最终 framework 链接。
2. 同一实际媒体分别测直连、Relay-only：播放/暂停、向前/向后 seek、播完、Done/手势关闭、再开、保存/分享取消与确认、播放中 codec failure、后台/锁屏与 Host 切换无声音且不可跨 Host 重开。试验失效 lease 和迟到 cancel 不影响新资源。
3. 安全 fixture：206/redirect 拒绝、stat 已知超限无 serve、chunked unknown-length 超限即时停止、取消中不留下文件、失败刷新不释放旧 lease；恶意 MOV 外部引用、HLS/DASH/playlist 不发任何额外请求。现有静态断言不足以替代这些动态证据。
4. 原生 **Range 或流式落盘** 必须由 RuntimeBridge 的同一授权直连/Relay owner 提供，收包/并发/磁盘配额、Content-Range/总长度、backpressure、seek 取消、Host fence、失败清理和可重试完整设计后再实现；不能只提高 25 MiB 或让 AVPlayer 直连 Host。参照 Web 1 MiB Range 的真实能力，但不把其 JS payload 桥当成 NSH 原生方案。
5. 完成大资源保存/分享、Web 支持而系统 codec 不支持的明确兼容方案与实际格式矩阵。当前“不支持”是未完成项的诚实报告，不是宣告可放弃 Web 已有能力。
