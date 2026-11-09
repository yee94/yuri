# GUI 手机能力：实现、装配合同与剩余验收

## SDK 重载修复：ed0b59c5 的 result-string 失败

main 的同次报告明确为 `fixture.root-bridge.result-string`，nativeRPCObserved=false、nativeStorageValueMatched=true。已用现 iOS SDK 红绿复现：旧 `in: .page` 实际返回 Void，编译器报告没有 async/throw 操作；async 重载要求 `contentWorld: .page`。fixture 三处 callAsyncJavaScript 全部修正，正向 bootstrap/device/Storage/RPC 严格类型、scope 和六 children 断言均保留，无生产 handler 改动。返回值 String 转换前记录 Swift 类型名和 resultPresent，不写原始值。新的真实 WK 结果仍由 main 独占取得。

`gui-plugin-bundle.test.ts` 的第八个输入为 preview 所需的纯 `gui-plugin-native-context.ts`，并非 device capability 或 SDK。测试改为精确具名依赖集合，仍拒绝 UI、node_modules、真实 browser entry/factory 和 RuntimeBridge 进入图，原生成物 guard 保留；没有仅将计数 7 改成 8。focused 三文件共 13 tests、真实 NativeShell +生产桥+UIKit SDK typecheck、builder syntax 通过；没有重跑全套或调用 engine/Host/设备。

## 真实 UIKit 根桥失败后的诊断包

main 对 sourceHash `5e4a59a8f989f2b182bd30eb26a81b4e7eabab775583c6972d3c4f53ef1e442c` 的旧包实际运行得到 `failed / fixture.root-bridge`，约两秒完成，非 timeout。原报告无 proof 细分，无法从该报告认定具体失败项；旧包不能计为 WK 边界通过。

本轮只改 fixture、UIKit runner、builder provenance 和纯测试，没有改任何生产 handler。核对真实生产回包后，正向 probe 明确区分裸 bootstrap、device ok/value、同步 Storage JSON envelope 和 buffered RPC；使用原 fixture admitted receipt 并严格校验 bootstrap/cached receipt 一致，不回避 scope 错误。通过显式 JSON 传回固定布尔 proof，保留严格真值/类型及 native callback/Storage sentinel 见证，新增 `result.json.rootProof` 和 root-bridge 失败后缀，不记录 scope、token、raw reply 或内容。

根桥四组 proof 全过后才启动六个子文档，原六场景全部断言保留；生产桥、生产 Storage/device/RPC 没有 stub。新增 probe wire 正反例和 Foundation/SDK **2 files / 10 tests 通过**，真实 NativeShell +生产桥+新 UIKit main 的 SDK typecheck 通过。新的冻结唯一包与同次 sourceHash 由交付消息给出，未 install/launch。原始真实失败是否消除仍需 main 新一次 UIKit 结果；纯 wire/SDK 不能替代。

## 后续 oracle 两项 P2 与独立 WK 包

在原 P1 静态 closed 后，追加的两项 P2 已修复并先红后绿：

- fetch 不再以 instanceof 或公开属性识别品牌；安装 wrapper 时捕获对应 realm 原生 URL.prototype.href 和 Request.prototype.url/method/headers/signal getter，通过 getter.call 的内部槽位校验读取。父/子 realm 的 prototype 伪造及真实实例自有 shadow 属性都有回归；伪造输入在 IO 前返回 GUI_RESOURCE_INVALID_INPUT，GET/omit/redirect/signal/恢复不变。
- 绝对 Host URL 改为 `/__gui/host/<encoded-origin>/api/fs/serve/<workspace-path>`。相对 classic/module/style/fetch 能保留目录，每次 native read 重建目标并核对 immutable captured Host predicate、canonical/workspace，仍无 base-uri 或额外网络 allowlist。真实 WK fixture 增加 absoluteHost 及其 srcdoc 后代，原四场景断言全部保留，共六场景；另要求至少五次 Host predicate 校验。

独立 builder `scripts/build-gui-wk-boundary.mjs` 和轻量 UIKit `tests/gui-wk-boundary/main.swift` 已实现。它只链接真实 NativeShell framework，不创建 NshAppView 或启动 NSH engine；冻结生产 Swift、fixture、main、browser 回归 provenance 和真实 framework，编译后复核 hash，生成唯一 run-8hex bundle ID、ad-hoc 签名、同次外部 manifest。main 验证包内 source manifest 后直接调用原真实 fixture，屏幕 PASS/FAIL，Documents/result.json 记录 success/failed/invalid、failureCase 和同次 sourceHash。Host/RPC 仍为原 fixture 内存 capture，生产 device/storage/RPC handler 没有替换；生产 Storage 使用原 fixture 的隔离临时目录，报告写 Documents，不访问 Keychain 或网络。

本轮最终 browser/artifact **3 files / 29 tests**、Foundation/真实 iOS SDK **2 tests**、browser tsc 与 UIKit main +真实 NativeShell 的 iOS 15 typecheck 均通过。实际独立 App build 仅执行一次并成功，签名校验通过，liveSourcesChanged 为空，状态为 built-not-run；没有 install/launch 或设备操作。同次 bundleID、完整 sourceHash、App 路径和 manifest 由交付消息提供；不能拿历史旧包算通过。main 独占安装/运行与 oracle 复审，具体命令见 `tests/gui-wk-boundary/README.md`。

## 最新稳定点：oracle iframe P1/P2 修复

oracle `ses_e49387016fferf3yKIDNZ57xhd` 指出原工作区/loopback HTML 与主 GUI 同 origin，能通过 parent.eval/Function 借主 frame 调用权限。原先仅凭 frameInfo.main 的边界描述不充分，本轮保留其防线并新增真正的原生响应隔离：

- `GuiPluginPreviewScope.responseHeaders` 是生产 scheme handler 的唯一响应 header 构造点。除受信 `/index.html` 主入口外，资源/资产响应均带 `sandbox allow-scripts allow-modals allow-downloads`，**不授予 allow-same-origin**。工作区 HTML、绝对 Host 文件、loopback HTML、proxy 重写子资源都经过这一点，不依赖 JS 设置 iframe 属性。
- 资源 policy 允许 inline/classic/module script 及 `yuri-plugin:` 的脚本、样式、图片、字体和 simple GET；native 仍验证每次 URL 的 exact owner、工作区或已准备 proxy target。资源响应只开放无凭据 CORS `*`，便于 opaque frame 读取自己的 scoped 资源；主 GUI entry 不开放 CORS。上游 CSP 仍以额外 policy 保留，不能放宽本地 sandbox。
- 子 frame 的 `about:srcdoc` 导航保留；资源文档的 sandbox 限制随其后代继承。没有以删除 iframe、禁脚本或关闭整个 native bridge 来通过安全检查。
- P2 的 fetch wrapper 以 wrapped window 自身的 URL/Request constructor 判别输入，并支持已知父 realm 的真实品牌；只接受 string/URL/Request，不再 duck-type `{url,method}`。保留 headers/AbortSignal、GET-only、credentials:omit、redirect:error、scope 和按 owner 恢复。

P2 的 child realm 回归已先红（确实向底层 fetch 传了 undefined）后绿。P1 的 Foundation response-policy 合同也先红后绿，但这只证明 header 构造，**不能证明 WK 的 SOP 隔离已经生效**。

真实可执行 fixture 位于 [tests/gui-wk-boundary/README.md](./tests/gui-wk-boundary/README.md)。它使用生产 bridge/scheme/headers，在真实 WK 下覆盖 workspace、loopback 和两者 srcdoc 后代：parent/top eval/Function 必须抛 SecurityError，直接 bootstrap/device/Storage/RPC 必须拒绝；同时主 frame 合法调用、子文档脚本、按钮、相对样式和 simple GET 必须成功。还检查 clipboard/storage 未变、RPC 只有主 frame 的合法一次调用，不能用页面未加载得到假绿。该 fixture 已编入真实 iOS SDK typecheck，**由 main 独占 UIKit 实际运行，随后回 oracle 复审；本 agent 未运行它，P1 不标为 WK 验收通过**。

当前验证：browser/artifact **3 files / 27 tests 通过**；受影响 GUI/native/resource/ASR SDK/speech Foundation focused **6 files / 17 tests 通过**；native/browser 两套 tsc 通过。terminal 与 GUI 两个生产 compile wrapper 各自的 iOS SDK typecheck + macOS harness 编译通过，runner 未执行。没有重跑历史 403 项，没有启动网络 fixture/NSH engine/设备/真实 Host，没有调用付费模型或执行 Git/依赖安装。

所有显式 Runtime compile lists 已补 `PasskeyPolicy.swift`（Foundation harness 不编入 PasskeyBridge）；SpeechPlayback 的显式清单已补 `SpeechVoiceCatalogPolicy.swift` 与其真实 `RuntimeHostScope.swift` 依赖。未改这些 policy、RuntimeBridge、Passkey owner、SpeechPlayback owner、main 或 build-ios 的生产实现。main 已回传 renderer 编译复用、Photos 十语 Info、Runtime predicate 字段与 main 转交已接；predicate 的实际 Runtime 实现仍归对应 owner，本节不冒领其结果。下方 main seams 保留为接口说明，不再将已接部分重复列为未装配。

本轮继续实现真实系统/资源能力，不把空 ViewExport 或 inactive Contract 当完成。既有 main 的 NSH check、整包 iOS build/签名和 browser typecheck 已由 main 回传通过；下列新增能力仍需 main 将真实 renderer 源文件编入新包并重跑，旧 build 不覆盖本轮。

## Web mobile 证据与实际实现

| 能力 | 当前 Web 来源 | 本轮实现与边界 |
| --- | --- | --- |
| copy | `ui/src/lib/gui-plugins/host.ts` 的 `navigator.clipboard.writeText` | 真实 SDK → 独立 device port → native `UIPasteboard`；按 UTF-8 限制，不访问 Host |
| openExternal | 同上，仅 HTTP/HTTPS/mailto | 真实 SDK 同步 prompt → native URL 校验 → `UIApplication.open`；拒绝 file/javascript/带用户密码 URL；localhost 不交手机 Safari |
| save | `gui-plugins/save.ts`，Capacitor Files picker、UTF-8、32 MiB、取消 false | 原文写私有临时文件 → `UIDocumentPickerViewController(forExporting:asCopy:)`；仅 provider 成功回调返回 true，取消 false，清理后才完成；不把 anchor 下载当保存 |
| toast | `gui-plugins/toast.ts`，纯文本、四 variant、duration/persistent/dismiss、plugin abort，mobile 顶部中央 | `GuiPluginDeviceBridge` 顶部原生堆叠，loading 活动状态、success/error 反馈、相同内容/类型/时长去重并重置 timer；输入校验先于 UI，逐 handle dismiss、超时和 document stop 清理；icon/actions 仍与 Web 一样 unsupported |
| PDF/长图 | `gui-plugins/view-export.ts`、`view-export/api.ts`、既有 iOS renderer | actual SDK 的两个独立 Contract 注入真实 `createViewExportAPI`，不再默认空 exports；WK reply 传快照、结构化 progress/cancel/result。复用原 `YuriViewExportRequest/Renderer`，保留静态 HTML、尺寸/像素、脚本/网络禁用、PDF 矢量分页和 PNG 2x 分块；PDF Files、PNG Photos |
| 工作区 iframe/image/font/CSS | Web runtime asset helper，Host fs serve | browser URL adapter → `GuiPluginResourceResolver` → 同 capture 的 `ResourceWebPreviewTransport.readFile`；仅 canonical 工作区内路径，支持 UTF-8，继续受原 limit/授权/撤销限制 |
| localhost iframe/子资源 | Web preview targets/proxy，原生已有 `prepareLoopback` | 原生复用 `ResourceWebPreviewTransport.authorized`，同 origin 的 preview target single-flight、短期缓存及 exact proxy 子资源；token 只在 captured native header。没有新增 Runtime URLSession/Relay、手机直连或 URL bearer |
| 绝对 Host fs URL | 原浏览器使用当前 runtime origin | 新 native-only `isHostResourceURL` identity seam；通过证明后转换成同工作区 fs serve，仍不放宽 transport allowlist |
| 字体/文件图标 | `fontOptions.ts/fontLoader.ts`、原 `file-types/sprite.svg` | stage 既有 JetBrains Mono 六份真实 TTF 和 OFL，核对原来源 manifest SHA-256；原 SVG sprite 原样进入 hash manifest。一般插件内联 SVG/data 图标、工作区字体及相对 CSS URL 走同 resolver |

shared host 仅增加可注入 `system` 和 per-plugin `toasts(ownerSignal)`。缺省仍完全沿用原 Web/Capacitor 实现，不替换共享全局 clipboard、system 或 toast。native browser-only adapters 位于 `gui-plugin-browser/`，只由独立 entry 引入，不成为原生 tsconfig 的编译根；App 不导入它们或 SDK/Query/browser relay。

## main 的最小接线

1. 在 iOS Swift 编译输入中包含 `ios/GuiPluginDeviceBridge.swift`、`ios/GuiPluginResourceResolver.swift`，并**直接复用** `packages/mobile/ios/App/App/YuriViewExportRenderer.swift`。不需要 Capacitor plugin 或新依赖，也不复制 renderer。GUI surface 自己创建、持有和 stop 两个 bridge，不需增加 NshAppView capability 或修改 application/main 的调用接口。
2. 主包 Info.plist 提供真实本地化 `NSPhotoLibraryAddUsageDescription`。没有配置时 native 返回 `GUI_PHOTOS_USAGE_DESCRIPTION_CORE_GAP`，不弹缺配置权限、不降级 PNG 到 Files。
3. 对于插件提供的绝对 Host fs URL，在构造 `GuiPluginPreviewCapture` 后设置 `capture.isHostResourceURL = { url in ... }`。该闭包必须捕获本次 Runtime admission 的 immutable scheme/host/effective port，检查当前原 lease，并只返回是否为该 Host origin；不能根据 JS URL 重新选 Host，不能接受任意外部 origin 或继承最新连接。实际读仍是已有 captured `resource.readFile`，不需新增 GET allowlist。相对 fs 和 localhost 不依赖此新 seam。
4. 更新 GUI staging，连 index/assets/manifest 一起复制；本轮字体和 sprite 已纳入真实 manifest hash，不能只复制旧 entry.js。

第 3 项的窄 Runtime 扩展可由 main 增加 `GuiPluginRuntimeCapture.isHostResourceURL: (URL) -> Bool`，由 `guiPluginPreviewCapture(expectedHost:)` 对本次已捕获 connection 生成：精确比较 scheme、host 与归一化的端口（HTTP 80/HTTPS 443），并要求原 `isCurrent()`。main 只把该 predicate 转交 `GuiPluginPreviewCapture.isHostResourceURL`，无需公开 Host URL 或 credential。当前返回值结构没有这项证明，本 agent 没有修改 RuntimeBridge 来补它，不能以 JS 传来的 origin 代替。

## 生命周期与安全

- device 只接受原 GUI main frame、精确 document owner 与 native-issued scope；iframe 只能取得内容资源，不能直接调用 system、Storage 或 export bridge。
- 原生 save/export 各 owner 只有一个 busy slot。异步取消捕获具体 taskID，迟到取消不能终止下一任务。picker/renderer 完全排空后释放临时文件和 slot。
- Photos 已提交事务不可物理中止：保留文件/slot 至 completion，已提交 saved 赢过迟到 cancel；未提交的授权等待用 exact taskID 拒绝旧回调。
- fetch adapter 仅改独立 GUI document：资源读取保留 headers/AbortSignal，拒绝 mutation、强制无浏览器凭据和 redirect:error；官方 SDK 继续走原 scoped SDK fetch。离页仅恢复自己仍持有的 wrapper。
- 子文档相对 URL 使用其真实已授权资源 baseURI；服务端重写的 `/api/preview/proxy/<id>/...` 只接受当前 resolver 已准备的 exact target。任务/准备数量和字节上限保留，不把失败变成空资源。
- 未访问真实 Host、未开启手机网络 fallback，未修改 RuntimeBridge/Relay、main/application/nsh.json 或其他 owner 的生产源码。

## 明确剩余项与 core gaps

| 项目 | 具体状态 |
| --- | --- |
| 绝对 Host URL 未装配 identity predicate | `GUI_RESOURCE_HOST_IDENTITY_CORE_GAP`；不能猜 origin |
| 现有 capture 没有 prepareLoopback | `GUI_RESOURCE_PREVIEW_TRANSPORT_CORE_GAP`；不能绕过 native 认证 |
| 任意公网 iframe/CDN/import、非 GET 资源请求、WebSocket | 分别为 `GUI_RESOURCE_EXTERNAL_ORIGIN_CORE_GAP`、`GUI_RESOURCE_METHOD_CORE_GAP`、`GUI_RESOURCE_WEBSOCKET_CORE_GAP`。已有 loopback preview 协议不提供这些授权通道；没有扩张 allowExternal/allowlist |
| 普通 UI/mono 字体 | 只交付仓库已有 JetBrains Mono。Inter、Geist Sans、Atkinson Hyperlegible、Source Sans 3、Roboto、Noto Sans、DM Sans、Manrope、Fira Code、Geist Mono、Commit Mono、Source Code Pro、Cascadia Code、Roboto Mono、Iosevka 的真实字体文件仍未 stage；完整字体一致性未完成。保留原字体栈，不以系统 fallback 声称相同字体，不安装依赖或自动联网抓字体 |
| localhost 的 system.openExternal | 不向手机 Safari 打开 Host-local 地址；当前返回 unsupported，外部浏览器打开动作与嵌入资源 resolver 是不同入口，尚未装配 Host-local 原生导航 |
| iframe/资源完整性 | 已接 URL 属性、srcset 各候选、原生 scheme、相对 stylesheet/字体和 GUI fetch；任意脚本运行时产生的 CSS、跨域 iframe 内部独立网络/HMR 不能据此宣称全覆盖 |
| 真机保存/Photos/渲染、字体字形、iframe 与真实 Eficy | 禁止 engine/device/真实 Host 下未运行；pure/Foundation/SDK/artifact 不能代替 |

## 编译 harness 修复与独立审查

已经检索全部引用 `GuiPluginPreviewBridge.swift` 的显式编译清单：terminal runtime（被 terminal-runtime/loopback 共用）、resource-web-preview SDK、ASR SDK/transport/relay、remote-desktop transport、check-native-bridge，以及 GUI runtime/native/ownership/context/capabilities 自有 harness。macOS Foundation inputs 带两个新 GUI source；iOS SDK inputs 还带真实 mobile renderer。没有 stub 新 GUI bridge，没有删断言或跳测试。旧的 NSH registration/Keychain 声明或存储 seam 原样保留。

独立 reviewer 请 main 派发：本轮禁止付费模型，本 agent 没有重用历史 reviewer 结论冒充新代码通过。建议只读核对 `gui-plugin-browser/device.ts`、`resource-urls.ts`、`ios/GuiPluginDeviceBridge.swift`、`GuiPluginResourceResolver.swift`、surface 的 main-frame/device/resource 接线，以及实际 artifact/Foundation 新断言。重点为跨 frame/跨 Host 资源授权、原生 modal 与 Photos commit/cancel、progress/late task、fetch owner 恢复、所有 compile list 的真实传递依赖及字体 provenance。

验证以本轮最终回传结果为准；`modified during build` 属于编译时源码被同时改写的中间失败，需冻结源码后重跑，不能直接归为产品缺陷。

最终实跑证据：

- 冻结源码后的扩大 focused：**11 files / 403 tests 通过**，涵盖 terminal loopback/runtime、resource preview Swift、ASR SDK/transport/relay、remote-desktop transport、GUI runtime regression/native/capabilities/ownership；未重现 cannot-find-type 或 modified-during-build。旧 7 files / 222 tests 是较早的清单修复证据，不与 403 重复累计。
- `bun run --cwd packages/nsh test:native` 通过：生产桥接源码配合独立声明/存储 seam，验证 synthetic direct/Relay/auth/resource 生命周期，不运行 NSH engine 或访问真实 Host。
- 收尾又修复 toast 跨插件同文案可能共用 native handle 的问题：每个 plugin owner 分配独立 toast identity，native 去重键保留原 title/description 边界；回归明确先红（两个 owner 均未传入 identity），修后 browser 全组 **3 files / 26 tests 通过**。包含真实 emitted bundle 的 SDK system/toast/两个 export Contract 的 saved、cancelled、EXPORT_SAVE_FAILED，以及 resource/fetch/srcset。
- toast identity 修后定向 Foundation/真实 iOS SDK/native 集成 **2 files / 4 tests 再次通过**；native 与独立 browser 两套 tsc 再次通过。这是 403 之后受改动影响的定向复验，不把四项再加进 403。
- context/appearance/native 依赖图守卫 **2 files / 45 tests 通过**。browser-only device/resource adapters 不进入原生编译根，无 Window 的 native context 回归保留。

这些检查没有运行 NSH engine/设备/真实 Host，也没有以 mock 保存结果替代 UIKit 保存验收。本轮没有执行 Git、安装依赖或启动付费 reviewer；本地没有 knip executable，未运行会尝试取得工具的 dead-code 脚本。独立 readonly review 仍待 main 派发，完整手机 1:1 仍按上面的实际缺口逐项验收。
