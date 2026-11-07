# Resource Web Preview：独立实现与接线验收

## main UIKit 实跑追记

- 真实 WKContentRuleList 首次运行报 `WKErrorDomain/6`，原因是规则不支持 disjunction；拆成等价独立规则后通过，没有放宽 CSP/导航/外域限制。fixture 的 UTF-8 HTML/CSS/JS 补了真实 charset 声明；生产直连/Relay 保留完整 Content-Type 和字节，非 UTF-8 response 保真有独立测试。
- `html-uikit-1794038849293.json` 记录真实中文 CSS/JS/PNG 与 DOM 点击、三次 Done 释放、合成授权 proxy、Host 失效取消慢资源及目录越界拒绝。最终捕获/释放 6/6、在途 0。此处是生产 WebKit bridge + 合成传输，不是实际部署 localhost/Relay 联调，也不证明无 DNS 泄漏。
- 主资源预览已接独立 WKWebView；它不承载主应用，也不安装 NativeShell 脚本桥。手动慢加载→Done、后台取消以及真实生产入口仍须独立补证据；Eficy/Solid GUI、大媒体流式和非 UTF-8 dev-server proxy 仍未完整验收。

## 结论

已有独立资源 WKWebView bridge、纯 TS intent 和安全路由测试；本轮补上 RuntimeBridge 当前 Host capture、Native bearer-only 创建/读取协议与隔离 UIKit fixture。**本轮未改生产入口，也未做平台运行验收。** WKWebView 只承载资源内容，不加载 NSH 主界面，不携带 NativeShell/主应用脚本桥。main 的其他生产接线进度须由其自行确认。

HTML 与 Host localhost 均已有可接线的受限 transport；main 只需以 `try runtime.resourceWebPreviewTransport()` 替换旧的 readFile-only capture，且实际 Host 必须包含本轮 server 协议扩展。**Eficy、动态 Solid GUI 插件执行仍未完成，不得展示可执行预览的假按钮。** 下列剩余项全部属于完整交付范围，不是删除范围。

## 只读对照依据

- `resources.tsx`：`ResourcePreview` 只调用 `resources.read`，HTML/Eficy 显示不可预览；`resolveResourceLink` 拒绝带 scheme 的链接。
- `ios/ResourceBridge.swift`：文本源码、图片/PDF QuickLook、导出/分享；明确不执行 HTML/Eficy。`ios/RuntimeBridge.swift` 的 `ResourceTransport.read` 仅准入 `/api/fs/stat` 与 `/api/fs/serve/`，已拥有收包限额、取消、直连/Relay 和 generation。
- `../ui/src/apps/MobileFilesSurface.tsx`：Web 手机 HTML 的源码/预览与全屏；Relay 分支读取 HTML 作为 srcDoc，不能据此推定所有相对子资源已正确过 Relay。
- `../ui/src/lib/preview/relay-preview-gateway-client.ts`：桌面 gateway 用 runtimeFetch/Runtime WebSocket 接当前 tunnel，不是可直接移植到 iOS 的本机 HTTP 服务。
- `../web/server/lib/preview/proxy-runtime.js`：真实 `POST /api/preview/targets`、`/api/preview/proxy/<id>/...`；仅回环 target 可用默认路径。已有 CSS/HTML/JS 重写、CSP nonce、redirect 重写；向 dev server 转发前移除 Authorization/Cookie 与 Yuri URL token。
- `../ui/src/lib/opencode/gui.ts`、`../ui/src/lib/gui-plugins/DOCUMENTATION.md`：`GET /api/plugin/gui?id=…` 返回 CJS bundle/revision/options，不是 HTML 页面；Solid host/module 单实例及官方 context 由浏览器宿主拥有。
- 已读 root guide、NSH DOC/README、shared GUI/FS/Relay 文档、注入 customization skill 的 file-previews/GUI 参考，以及 browser-assets-and-auth 安全参考。Eficy 是插件拥有的 iframe TSX runtime，服务端 authoring/validate 工具不等于独立 render route。对照代码未发现可直接复用的独立 GUI/Eficy HTML 执行 route。

## 新增文件与职责

| 文件 | 职责 |
| --- | --- |
| `resource-web-preview.ts` | QuickJS 可用的纯 intent 分类与注入式 native 调用；不 import NSH/DOM/React/Solid，不发网络 |
| `ios/ResourceWebPreviewBridge.swift` | Foundation 路径 authority、捕获 transport 协议、独立 WKWebView modal、取消/关闭 |
| `resource-web-preview.test.ts` | 纯 TS 意图/非法输入/unsupported/失败透传 |
| `resource-web-preview-swift.test.ts` | 执行 Foundation 契约及 iOS SDK typecheck；不运行 NSH |
| `tests/resource-web-preview-contract.swift` | 编译生产 Foundation scope，覆盖文件/子资源/proxy/auth/错误/大小/过期 owner |
| `tests/resource-web-preview-fixture.ts` | 只含合成 HTML/CSS/JS 与 intent 的独立 bundle fixture；不是运行验收 |

本轮仅扩 `RuntimeBridge.swift.resourceWebPreviewTransport()` 窄 seam、`ResourceWebPreviewBridge.swift`/纯 intent/测试、Host `preview/proxy-runtime.js`/测试/拥有者文档及独立 fixture；未改 resources/application/main/state/nsh.json/Relay/其他 owner，未加依赖。

## Main 接线协议

### JS 入口

```ts
import { presentResourceWebPreview } from './resource-web-preview';

// native 为现有 runtime.ts 的 native；调用方保留当前源码/错误与重试。
await presentResourceWebPreview(native, { directory, path });
// 用户显式点击的 Host localhost 链接：
await presentResourceWebPreview(native, { directory, href });
```

- native method：`resources.web.present`。参数为 `{kind:'html',directory,path}` 或 `{kind:'loopback',url}`，无 endpoint/凭据/代码/options。
- 成功返回 `{closed:true}`，只表示用户关闭原生窗口，**不表示脚本内容、编译或交互验收成功**。
- `resources.web.close` 供页面卸载或失去 active 时取消；Host 切换、后台和 teardown 应直接调用 Swift `invalidate()`。取消不是空内容成功。
- intent 的 `supported` 仅表示路径类别受理，不能替代 transport capability。未实现 `prepareLoopback` 时会明确 throw `unsupported`；main 不应把 intent 当作“已可用”的 UI 探测。
- Eficy/CJS/TSX 一律 `format-runtime-required`，保留现有源码/保存/分享；不添加假 preview action。
- main 负责把错误映射到现有本地化反馈、保留源文件和关闭/重试入口；桥内系统 Done 自带系统语言。

### Swift 安装与文件 adapter

由 main 保有 `ResourceWebPreviewBridge(controller:capture:)`，调用 `install(on:)`，并将 `invalidate()` **加入**现有失效回调链，不能覆盖其他 resource/speech/desktop owner。

生产 capture 现在应使用（文件与 localhost 共用同一次 Host/generation 捕获）：

```swift
return try runtime.resourceWebPreviewTransport()
```

bridge 对入口 HTML 先读 `/api/fs/stat?path=…`（64 KiB），确认 JSON/isFile/大小，再读 `/api/fs/serve/<encoded absolute path>`。单独的缺路由 SPA HTML stat fallback 会失败，不当成文件。每次捕获仍须由 RuntimeBridge 选择当前授权 Host，不能缓存上一次 transport 到另一连接。

虚拟文档地址为 `yuri-resource://<每次随机 owner>/<Host absolute file path>`。相对子资源通过同一 owner、同一目录的 `/api/fs/serve` 回到该 capture。普通文件 cache query 留在 WebKit URL 身份中，但不进入 Host 文件 route；fragment 不出网。目录限制是**词法范围**，不是新增的 Host 文件沙箱；symlink/真实路径授权仍归 Host FS policy，不能声称此层实现 symlink confinement。

### Host localhost 授权窄 seam（本轮已实现，待 main 切换 capture）

`ResourceWebPreviewTransport.prepareLoopback: (String) async throws -> ResourceWebPreviewProxy`。

1. 从同一次 capture 保留连接身份/generation；原生校验只接受精确 HTTP(S) localhost/127.0.0.1/[::1]/0.0.0.0，拒绝 userinfo/异常 port/凭据 query。**不能对传入 URL 开 URLSession，也不能解析成手机 localhost。**
2. 通过当前已授权 RuntimeBridge 的直连或现有 E2EE Relay，发 `POST /api/preview/targets`，JSON `{url, ttlMs:300000, allowExternal:false}`，私有 `X-Yuri-Native-Preview:1` 与正常设备 bearer。没有 Origin/Referer/Cookie/浏览器 Fetch Metadata。不改变 Relay 配对 gate，不做 SSH/密码凭据到 Relay 的 fallback。
3. 只接受成功 JSON、合法 `proxyBasePath=/api/preview/proxy/<16–64 hex>`、匹配 id、有限且短期的 `expiresAt`、合法 `previewToken`。previewToken 仅由 Swift closure 持有，不进入 NSH 普通 Storage、日志或回传参数。
4. 返回 `ResourceWebPreviewProxy(basePath:expiresAt:read:)`。`read` 只允许这个 target prefix 的 GET；不接收页面请求头，移除旧 `yuri_preview_token` query，私下加 `X-Yuri-Preview-Token` 与 RuntimeBridge bearer。Host 仅为 Native target 接受该私有 token header，并逐次用真实设备认证复验创建 client ID；cookie/query-only、其他设备、撤销/过期 credential 均不能读 Native target。用户 bearer/client token **永不进入 URL**。Host 重写子资源内的短期 preview token 可见但不持久化，不可越 target/外域。Native token headers 同样在 upstream 前剥离。
5. 原始 response 只回 `{status,mime,data,contentSecurityPolicy?}`。保留 Host 给出的 CSP（bridge 会额外收紧，不会放宽）。不传 Cookie/Set-Cookie/Authorization/Location 给 WebView。redirect 不跟随，所有非 2xx 失败。收包时执行 limit（包括无 Content-Length 的 chunked），沿用 current resource 取消/Relay stream owner，不能另起 tunnel。`read` 完成前后都检查 captured generation。
6. target 过期时拒绝后续读；重试是用户重新打开/prepare，不能自动用旧 token 续开。当前 Host 没有 target 删除 API，关闭时释放 closure，服务端条目按 TTL 回收；不要伪造 DELETE。

**来源阻点已用最小 server/native 协议解决：** marker 不属于可信 Web Origin；native 请求拒绝任意 Origin/Cookie/Referer/浏览器 Fetch Metadata，强制已有 `resolveAuthContext(...allowUrlToken:false)` 返回真实设备记录，即使 UI password 未启用也不能匿名创建。唯一传输例外是 Host dispatcher 的 Node fetch 自动加的精确 `Sec-Fetch-Mode:cors`，仅有 Relay marker 且现有 `authorizeRelayRequest` 实际配对校验成功时准入；所有 Relay-marked native 请求均复验，不能靠 marker 冒充配对。Native TTL 固定五分钟、仅精确 loopback、不新增外域 opt-in；target 绑定创建 client，Native WebSocket（含 proxy 自动 upgrade 路径）明确拒绝。Web 原有 Origin 校验和 SSRF、Relay 配对 gate 未改变。详见 `../web/server/lib/preview/DOCUMENTATION.md`。旧 Host 不支持时可见失败；绝不伪造手机 localhost/Capacitor/relay.invalid Origin，也不降级重试成 Web。

## 已实现的安全与失败策略

- 独立 nonpersistent WKWebView；没有 NativeShell、script message handler、凭据、options、应用 IPC 或插件 native main。
- 页面网络仅自定义 scheme；CSP 与 content rule list 阻断 HTTP(S)、WS、file、外部 frame/worker/object/form；同 scheme 也只映射 captured 文件目录或单个 proxy target。scheme handler 不转发页面请求头。
- 拒绝跨 owner/Host、目录穿越、反斜杠、NUL/控制字符、双层百分号逃逸、带客户端凭据的 query、外域导航、window.open 和非 GET。拒绝 phone loopback 原始请求，没有 Safari fallback。
- CSP 只收紧、响应固定 no-store/no-referrer/nosniff；入口先确认文件 stat、HTML MIME 与限额。任何子资源读取失败会结束预览并返回失败，原生源文件仍由外层持有，可重试。
- 每响应最多 8 MiB、每次 preview 最多交付 32 MiB、最多 256 次 scheme 请求/8 个并发；并发 buffer 可最多占 8×8 MiB，不把 32 MiB 交付上限误称为峰值内存。不能截断后宣称完整成功。
- stop 移除 task 后 cancel，不再回调已被 WebKit stop 的 WKURLSchemeTask；scheme handler 弱持有 surface，避免 configuration→handler→surface→web 的强引用环。
- present 任务同时拥有 prepare/预取与 modal 的取消；桥接给 NSH 前将未分类底层异常统一为 response failure，不透传可能含 Host URL/短期 target token 的网络错误描述。
- 预取、prepare、rule-list compile、每个 scheme response 均经过 generation/revision fence；app 后台/Host 切换仍需 main 同步调用 invalidate，不能只靠 WebView UI 消失。
- 安全拒绝不是无损全功能还原。被外网策略、额度或缺失 transport 拦截的能力均列入 remaining scope。

## 本次验证证据

运行：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/resource-web-preview.test.ts packages/nsh/resource-web-preview-swift.test.ts
```

结果：2 files / **8 tests passed**；另 `bunx vitest run --project @yuriai/web packages/web/server/lib/preview/proxy-runtime.test.js` 为 **37 tests passed**（含 5 个新增 Native API 安全测试）。

- Foundation fixture 编译并执行生产 scope：中文/空格/# 编码、相对 CSS、cache query、fragment、本 target prefix、根路径、穿越/外域/错误 owner、token query、坏 metadata/SPA/redirect/status/MIME/大小、捕获 isCurrent 与缺少 prepare 明确失败。
- 真实 iOS 26 simulator SDK 下 typecheck **完整 WKWebView、RuntimeBridge/ConnectionStore/RelayTunnel 与独立 UIKit fixture**，仅 NshAppView/桌面 transport 值类型是本地签名替身；不运行 simulator/NSH。通过不代表真实 scheme callback 或 iOS 行为已验收。
- `tests/resource-web-preview-fixture.ts` 经 Bun `target:browser` 独立 bundle：1 artifact / 2687 bytes，无 NSH/React/Solid runtime。输出只在 OS 临时目录生成并清理。

新增 Foundation authorized adapter 测试覆盖固定 POST/native headers、严格 metadata/TTL/Token、CSP 保留、旧 token query 剥离、越 target/穿越/客户端凭据拒绝、失败/收包限额、前后 generation fence。API 测试使用真实 UI auth、Origin gate 和临时 synthetic remote-client store，直接调用真实注册 handlers，不监听端口；覆盖匿名/伪造/cookie/URL token/浏览器来源/另一设备/撤销/过期、SSRF、upstream credential stripping 与 Native upgrade 拒绝。`node --check` 通过 Host proxy 和 fixture build script。

**main 需同步的共享验证源列表**：`scripts/check-native-bridge.mjs:259` 目前只编 RuntimeBridge/RelayTunnel；RuntimeBridge 现在依赖 ResourceWebPreview 值类型，main 合并时必须在该 `swiftc` 参数列表加入 `path.join(root,'ios/ResourceWebPreviewBridge.swift')`。该脚本非本轮独占文件，未改动/未运行；本轮定向 Swift contract 已显式包含这些生产源码并 typecheck 成功。

独立 UIKit fixture 已以真实 NativeShell distribution 静态链接构建并签名：`packages/nsh/.nsh/resource-web-preview-uikit/2026-11-07T07-31-33-425Z-b0318b3f/ResourceWebPreviewUIKitFixture.app`。Bundle ID `example.yuri.resource-web-preview-uikit`，仅链接生产 ResourceWebPreviewBridge 与合成 Swift fixture，不启动 NSH engine。初次默认构建因 PATH 无 nsh 报错；显式 NSH_DIST 后成功，无依赖下载。构建/操作/AX/释放计数说明见 `tests/resource-web-preview/README.md`；main 在 engine 窗口后串行安装与运行。

未运行：真实 Host/模型/语音/桌面、browser、NSH engine、生产 iOS App build、模拟器安装/启动、Relay 网络、UIKit 截图/交互与外域 DNS 验证；未读取真实凭据、未运行 git、未新增依赖。仅构建独立 fixture。任务限制为 pure tests/Swift contract/ownfixture，故没有运行仓库级 dead-code 或广域脚本；新增 fixture 源码/入口的仓库死代码审计交 main，不能把静态通过当平台验收。

## 完整 remaining scope（不得缩减）

1. **生产入口与生命周期**：main 将 HTML preview/source、关闭/刷新/分享与现有资源 lease 联动；消息、Markdown、工具、文件链接里的 localhost 分派；Host/页/active/后台/销毁的同步 invalidate；Swift build source capture、真实 NativeShell 编译与桥接错误本地化。
2. **授权 localhost 联调**：代码层 native POST 来源协议、captured raw bytes/CSP、短期 token 生命周期已补；main 替换旧 readFile-only capture，并确保实际 Host 发布同版协议。直连、Relay-only、未授权/撤销/过期、断线/切 Host 在途、响应已被代理后再撤销的行为均须真实验证，不宣称所有在途撤销都已可取消。
3. **HTML 全交互**：现实现仅受限同目录/单 target GET。外域图片/字体/脚本/API、绝对根资源、跨端口 localhost 链接、iframe、form POST、WebSocket/HMR、SSE、worker/service-worker、下载/Range/大资源、重定向、popup、跨文档前进后退、页面交互持久性均未还原；不能为“能打开 HTML”而删除要求。自定义 scheme 的 ES module/CORS/fetch、CSP/规则生效、错误可见性、外域 DNS/泄漏及 WebKit stop 重入必须平台验收；没有测试即未知，不作支持声明。
4. **源码/全屏与无损更新**：当前仅原生 modal；Web 手机 inline/detail/fullscreen/source 逐态对齐、滚动与缩放/安全区/键盘/暗色、后台更新保留交互、刷新失败保留旧内容、主动重试/取消/返回路径尚待 main 与平台联调。超过安全额度明确失败，不截断替代，也不宣称完全兼容。
5. **Eficy 执行**：没有独立 Host HTML compile/render route。必须设计并复用已有 browser GUI host/插件自己的运行时资产与 context/options/session/file model（不是把 CJS API 塞进 WKWebView，也不是从零复制 Solid/Eficy 编译框架）。TSX compile、dependency allowlist、iframe sandbox、source revision/frame 身份、ready/content-commit、失败保留旧视图、两实例隔离与销毁均仍缺失。
6. **动态 GUI 插件**：inventory/启停/revision/options 的当前授权加载、共享 SDK/Solid 单实例、PluginContext、LinkHandler/Panel/PanelTab.file、手机独立面板/设置、样式 tokens、RPC、取消及清理、导出 action/系统保存完整链路均未接入 NSH；不从文件后缀猜装好的插件，不把桌面 global page 擅自搬到手机，不开放 Node/Electron main。Host 如日后提供受支持的独立内容 route，再扩此窄 seam；不能借此加载整个 Web 主界面冒充原生。
7. **完整验收**：真实 direct/Relay 请求与子资源、安全门拒绝/配对撤销、前后台/切 Host/关闭在途、相同文件两实例、图片/CSS/JS/fonts/认证、资源限制、坏响应、设备视觉与可访问性，以及所有 Web 手机 preview/export/plugin 入口的逐项证据。当前静态/纯 fixture 不能替代。

## C / F / H / S / D 摘要

- **C（完成）**：文件 HTML WKWebView、Native localhost capture/授权协议、单 target GET/token/CSP、pure/API/Swift 契约；独立 UIKit fixture 只构建完成。
- **F（文件）**：resource-web-preview 纯 adapter/测试、Swift bridge/RuntimeBridge 窄 seam、Host preview runtime/测试/文档、独立 fixture 脚本与 Swift/README；未触碰其他 owner。
- **H（交接）**：main 将 capture 替换为 `try runtime.resourceWebPreviewTransport()`，保留安装/失效链，并串行验收 fixture/真实 Host。
- **S（安全）**：无真实服务/凭据操作，未改 request-security、ui-auth、Relay；WebView 无 bearer/native bridge；Native target 强制现有设备 auth 并绑定 client，Web Origin/SSRF/配对不放宽。
- **D（缺口）**：完整 remaining scope 1–7 均保留，尤其真实直连/Relay 平台证据、全交互和 Eficy/动态 GUI 执行。
