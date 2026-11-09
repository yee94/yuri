# Files 第一批：SVG 与 stat watcher

本批 owner：`resources-model.ts`、`resources-request.ts`、`resources-watcher.ts`、`resource-svg.tsx`、`resources.tsx` 的 SVG/watcher 分支，以及 `ios/ResourceBridge.swift`、`ResourceWebPreviewBridge.swift` 的独立 SVG image mode 和 `ResourceSVGImageComponent.swift`。保持 dedicated Mobile Files 只读，不增加编辑器、Vim 或 Terminal。

## Web 来源及真实请求

- `packages/ui/src/apps/MobileFilesSurface.tsx` 的 `needsFileStat`：非位图或 SVG 启 watcher。
- `packages/ui/src/queries/fileQueries.ts` 的 `useFileStatWatcher`：2 秒比较 size/mtimeMs/isBinary，后台不轮询。
- `packages/web/server/lib/fs/routes.js` 的 `GET /api/fs/stat?path=…`：成功为 `{ path, isFile: true, size, mtimeMs, isBinary, mimeType, filename }`。NSH 使用构造时捕获 scope 的现有 `bindRequest`，不猜路由、不建立新 transport；optional-empty 或格式错误不是 stat 成功。

## Native owner 与竞态

仅 `kind=file` 构造 watcher，contact descriptor 不创建 watcher、不制造 FS path。位图不启动时钟。每 owner 至多一个 timeout 和一条实际 stat/read lane，周期为前一条完成后 2 秒；多次手动刷新合并为最多一个待刷新。系统预览/save/share busy 时不 stat、不替换其 lease。stat await 返回后必须再次检查 available，busy 则跳过读取且保留 baseline；`readContent` 也拒绝 busy。生产 callback 回归覆盖 deferred stat→pending save/share/preview→changed stat 期间零 read/close/release，系统呈现完成后的下一 tick 才刷新。

下载前 Swift 已读取的 metadata 随 `ResourceContent.stat` 返回，只有正文成功采用才更新 watcher baseline。初次下载期间的修改不会被一个较晚 stat 静默盖过：下一轮与下载前 baseline 比较。旧/缺失 baseline 强制一次读取；失败不更新 baseline，下一轮继续核验。它与 Web 一样只能观察 size/mtimeMs/isBinary：同一三元组内改写无法检测，不声称原子 stat+download 快照。

隐藏、后台、lease/epoch 变化、source 变化和销毁清 timeout、退役 pending adoption；旧 stat 返回不得触发 ghost read。已发出的原生 stat 请求不宣称物理取消，结果受 scope/lifecycle/source fence 拒绝。read cancellation、迟到 lease release、替换后的旧 lease close/release 和联系人校验沿用已有 owner。刷新失败保留旧正文/lease并显示错误，不清空为成功空内容。

## SVG 独立 WK 图片模式

SVG 按扩展名或 MIME 分类为独立 `svg`。Swift 保留经既有大小与联系人 SHA-256/MIME/size 检验的完整本地原件，响应只返回 opaque lease、size、stat、`preview: svg-image`，不把原文或 base64 复制到 QuickJS，也不为预览重读 Host。原有 1 MB 预览上限保留。

`ResourceSVGImageDocument` 从私有本地 lease 读取有界原件，完整 bytes 转 base64 放入固定 HTML wrapper 的 `<img src="data:image/svg+xml;base64,…">`。SVG 始终处于图片解码上下文，不作顶层 SVG 或 HTML markup；没有元素/属性白名单，不裁 CSS/class/style、SMIL、filter 或嵌入 data 图片。

独立 `WKWebViewConfiguration` 使用 `defaultWebpagePreferences.allowsContentJavaScript = false`、全新无脚本/handler 的 userContentController、nonPersistent storage。CSP default-src none，仅允许 data 图片/字体与 wrapper 所需 inline style；content blocker 默认阻断所有 URL，仅放行 data 和固定 about:blank；delegate 只接纳一次初始 about:blank，拒绝其它导航，不装 Host scheme handler/请求能力。完整 SVG 的实际解码兼容性仍以真实 WK fixture 为准。

wrapper `didFinish` 只进入 decoding，绝不直接发布 loaded。native 只在私有 `WKContentWorld.world(name: "yuri.resource.svgImage.decode")` 执行固定 `ResourceSVGImageDecodeProbe.script`：核验 wrapper 唯一直属 `<img>` 与固定 data MIME 前缀，等待 `image.decode()`，确认 complete 与非零 naturalWidth/naturalHeight，只把布尔值交回 Swift。脚本无参数、无原文插值、不进入 SVG DOM、不返回 SVG 原文、不访问网络或注入 page world；不安装任何 script message bridge，页面 JavaScript 仍禁用。安全测试约束这一个固定私有调用，不再用“出现任何 callAsyncJavaScript 都禁止”的宽泛正则。

共用 `ResourceSVGImageView` 自行呈现 loading、error/expired 与 Retry，所以 inline 和全屏不依赖外部订阅 failed 事件来显示错误。wrapper/图片未就绪时显示可访问的加载反馈；仅真实图片 decode 成功才显示图片并赋予本地化 AX label。无效 SVG、规则/本地 bytes 准备、导航和内容进程失败会移除旧 WK 并展示错误/Retry；每次准备与解码有同一个 10 秒失败截止。UIKit 控件按系统语言提供十种现有应用语言的文案，不显示原始错误、路径或用户内容。

Retry 保留同一 `ResourceSVGImageRequest` 的 opaque lease 与 expectedHost，只更新本地 attempt fence 以拒绝旧回调，并重新核验/读取本地 lease；没有新 Host 捕获、FS path fallback 或 Host 重读。失败时保留原件与退休观察，lease 随后失效会变为明确 expired；重试旧 lease 仍显示 expired，不退回空白。隐藏/后台/销毁会取消当前准备与截止任务，并拒绝迟到 decode 回调。文件 save/share 所有权不由预览错误状态修改。

inline 原生组件和系统导航全屏共用 `ResourceSVGImageView`，不再把 SVG 放行给 QuickLook。保存/分享继续用同一个原件 lease。`resources.close/release`、原生后台/Host invalidate、组件 inactive/unmount 与全屏关闭停止 WK 并移除旧 view，异步规则编译/本地 bytes 返回受 generation/原 scope fence 约束。lease close 后相同迟到 config 不能重新开启；显式 inactive→active 的新呈现周期才重新核验原件。没有改写原件或以图片导出替代原始 SVG。

## 安装与构建输入

- `ios/main.swift` 在既有 ResourceBridge 安装后建立唯一 `svgResolve`，严格按 `(lease, expectedHost)` 调用 `resources.svgAsset`；同一 resolver 用于 inline registration 与 `resources.makeSVGPreview`。没有新 transport/store。
- `ios/ResourceSVGImageComponent.swift` 只注册 `yuri.resource.svgImage`，接收严格的 `{ lease, expectedHost, active }`，不接收 FS path/URL/source。TS 声明在 `resource-svg.tsx`。
- 正式 `scripts/build-ios.mjs` 已按 `ios/*.swift` 动态收集，无须加静态清单；WebKit 已在原 framework 集合中。旧 HTML/native transport fixture 不必引入新 component 文件；新增 SVG SDK 测试显式包含并核验 registration。

## 验证边界与主会话交接

本批运行 pure callback/虚拟计时器、生产 TSX constructor callback、Foundation SVG image lifetime/document state、真实 iOS SDK 的 WK/ResourceBridge/component/fixture typecheck；不运行设备、NSH engine 或真实 Host。不能把 data img wrapper 或 setter 接线当作真实 WK 解码已验。

上一轮冻结结果为八个 Vitest 文件共 80 项通过、tsc/脚本语法通过。本轮 decode/反馈修复的 focused 结果：`resource-svg-swift`、`resources-watcher`、`resources-model` 21 项通过，`resources-request` 中 SVG、watcher 和 presentation busy 的 6 项通过；SVG SDK 测试包含真实 iOS SDK 下的共用 UIView、组件与完整待运行 WK fixture typecheck。fixture 构建脚本 `node --check` 通过。联合四文件曾有 49/50 通过，唯一失败是并行 HTML owner 移除旧预览按钮后的旧 HTML callback 用例；本轮全量 tsc 曾被另一区域 5 个 `settings.preferences.native.*Description` 文案 key 阻塞，未修改这些所有者的代码。现有 dead-code 仓库报告不是本批清理目标。

主会话运行 `node packages/nsh/scripts/build-resource-web-preview-uikit.mjs --svg` 可独立构建新的 `.nsh/resource-svg-image-uikit/<unique>/ResourceSVGImageUIKitFixture.app`（本批仅准备并 typecheck，未执行该 build/安装/启动）。安装与启动由主会话执行；app sandbox Documents 下的 `svg-image-result.json` 是实际运行结果。此 fixture 不加载 NSH engine、不访问真实 Host/Keychain；合成 loopback listener 只计数意外外部连接，正常结果为 0。

fixture 实际调用生产 ResourceBridge 读取内存合成文件与 SHA 校验的 contact descriptor，使用生产 WK 图片 mode。它读取解码后 canvas 像素，分别核验 CSS class、style、filter、嵌入 PNG、合法 nested data SVG 与两帧 SMIL/CSS animation 差异；nested SVG 保留可见 CSS 图形，同时包含 script/events、外部 image/CSS/font 探针，要求脚本/事件不能改图且 listener 连接为 0。检查 script/top navigation 不生效、原生发起的外部导航被拒、opaque-only 响应、原件逐字节一致、contact 不 stat/FS、lease close/release 移除旧 WK 与准备期间 close 拒绝迟到 view。

新增失败回归使用无效 SVG 的真实 WK decode，检查 wrapperLoaded 不等于 loaded、inline/全屏可见/可访问错误与 Retry；准备错误通过生产 prepare 入口注入一次失败后重试，内容进程终止通过生产 delegate 回调注入（并不声称真的杀死过 WebKit 进程）。检查所有重试只读本地 lease、失败后原件不变、lease 随后失效时错误明确且再次 Retry 不创建 WK/Host 请求。只有主会话实际运行通过并保留 JSON 才能关闭这些 runtime 条目。真实 direct/Relay/auth、复杂 SVG/WebKit 的全部兼容性仍未由该合成 fixture 证明。

### 首次真实 WK 红结果与请求归因补丁

主会话已实际 build/install/launch `d9ad2423`，发布结果保存在 `.scratch/nsh/svg-image-d9ad2423/svg-image-result.json`。CSS/style、SMIL/CSS animation、filter、data PNG、nested data SVG 像素及 script inert 对应字段为 true；`externalConnections = 1`、`externalNavigationAndSubresourceConnectionsZero = false`、`passed = false`。失败位于主动 `web.load(.../native-navigation-probe)` 后的零连接检查，后续 failure cases 尚未跑到。这是已发布的真实红结果，不是本地 watcher AbortError 或 timeout。

旧 listener 只在 TCP accept 时计数并立即 cancel，没有 HTTP 请求行或分阶段计数，因此旧 JSON 不能区分 native 主动导航、SVG 子资源与未发送 HTTP 的预连接。归因补丁不改生产 SVG policy、不裁 SVG、不删除任何探针，也不排除任何 TCP accept：

- 独立 `svg-subresources` 与 `native-navigation` 两个 loopback listener。所有 SVG 外部 image/CSS/font/script/event URL 留在前者；唯一主动导航探针使用后者。即使没有 HTTP 请求行，也能由接收端口所属类别区分来源。JSON 不记录端口或 endpoint。
- `probeConnections` 最多 32 项，记录 connection 序号、listener、acceptedPhase、固定允许列表内的 method/path/kind，以及 request-line/peer-closed/receive-error/deadline/read-limit 等结束状态。每连接最多读 2 KiB、最多 500 ms；不保存 headers/body/query，未知路径只写 unknown。空预连接也完整计入 `externalConnections`，不能据此变绿。
- `probePhaseSnapshots`、`connectionsBeforeNativeNavigation` 与 `nativeNavigationBlocked` 分开记录图片解码/像素完成前后、主动导航前后的计数与 delegate 结果。原有 `blocked > 0 && connections == 0` 断言保留；发布结果前有界收敛 pending 请求行捕获，并再次以实际 TCP accept 数否决通过。

本次仅完成诊断补丁和本地验证：三个 focused 文件 21 项通过（含请求行分类的 Foundation 契约与真实 iOS SDK fixture typecheck），tsc、脚本语法和 dead-code 检查已运行并完成；未运行新的 WK App、设备或 Host。需主会话全新 build/run 后按 listener/path/phase 证据决定最窄修复。在归因结果到达前，外部零连接项与后续失败处理 runtime 验收保持未通过。

### 第二轮真实归因与进入 WK 前的 native request guard

主会话第二轮 `.scratch/nsh/svg-image-0bbda870/svg-image-result.json` 已确认：`connectionsBeforeNativeNavigation = 0`，SVG preparing/decoded/pixels-verified 阶段为 0；唯一 accept 属于 `native-navigation` listener，结束为 500 ms deadline、没有 HTTP 请求行；同时 `nativeNavigationBlocked = true`。因此该红结果是主动 WK URLRequest 在 delegate 拒绝前已经预连接，不能用重复 delegate cancel 或排除空连接解决。

最窄修复仅在 SVG concrete view 使用 `ResourceSVGImageWebView: WKWebView`。其覆写公有 `load(_ request: URLRequest) -> WKNavigation?`，所有 native URLRequest 都直接拒绝、返回 nil，完全不调用 `super.load`。SVG 的唯一 document 仍由独立的 `loadHTMLString(wrapper, baseURL: nil)` 入口加载；没有覆写或改变该 API，原初始 about:blank 的一次 delegate admission 保留。私有 decode world、page JavaScript false、无 bridge、CSP/content blocker 及后续用户/脚本导航 delegate 防线均保留。HTML mode 继续使用其原 concrete view，不采用此子类。

guard 发布原 observer 的通用 navigationBlocked，同时以 nativeLoadBlocked 标明来源；delegate 仅在真实 delegate 拒绝时另发 delegateNavigationBlocked，不从 guard 伪造 delegate 调用。fixture 原有 probe 继续经 `let nativeBase: WKWebView = web; nativeBase.load(URLRequest(...))` 调用，既没有删 probe，也没有绕过真实 API。新增断言要求返回 nil、native guard 事件为 1、delegate 事件为 0、decoded wrapper 保持 ready/about:blank；原 `blocked > 0 && connections == 0` 与每个实际 TCP accept 的计数不变。

本地 21 项 focused 检查与 tsc 通过；真实 iOS SDK 验证公有 override 声明及完整 fixture，额外 SIL 检查确认通过 WKWebView 基类调用 load 使用 Objective-C 动态派发。没有运行设备或 WK App，不能以编译/SIL 结果宣称零 TCP 与后续失败用例已通过。主会话需新 build/run，检查 `nativeRequestRejectedBeforeWebKitThroughBaseType`、`nativeLoadGuardPreservesDecodedWrapper`、`externalConnections = 0`，并继续跑完全部 failure cases 后才关闭 runtime 条目。

没有改 HTML 默认打开流程或 GUI embedding。HTML source 的本地正文可以刷新，但本批不调用 `resources.web.present` 来重载已呈现 iframe。完整 HTML/GUI 对齐没有 closed；现有页面几何、材质密度及原生预览控制器实际材质也不在本批验证范围。
