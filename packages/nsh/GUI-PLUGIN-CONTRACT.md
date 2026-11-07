# NSH GUI plugin content：prepared 合同与未完成项

## 当前结论

这是现有手机 GUI 能力的迁移准备，不是安装插件，也**不是已完成的 1:1 兼容**。
独立 browser **可执行产物已构建**：实际 SDK、GuiPluginHost、FilesAPI、QueryClient、官方 storage/preferences、同 scope fetch/channel 和当前 themeCSS 已由真实 factory/entry 组装，生成 index/assets/带 hash 的 manifest，并用这份实际 bundle 执行 synthetic CJS。main 已将 staging 接入 build-ios；新增 body-cancel 源码补丁由下一次主 build 重新生成并 staging，不将已有产物 hash 当作新补丁证据。生产 Runtime reader 现已实现，direct/真实 E2EE mux 的 loopback 都读过 33.0625 MiB；main bootstrap/文件入口尚待 owner 接线，未验证真实 Runtime 插件运行。
没有静态示例页、内置 Eficy/Runmark runtime、按包名分支、未知插件下载或新依赖。

## 真实协议来源

- `packages/ui/src/lib/gui-plugins/DOCUMENTATION.md`：GUI ABI 固定 2.2.0、共享 SDK/Solid 实例、window-only、inventory、配置与清理。
- `packages/ui/src/lib/opencode/gui.ts`、`queries/guiPluginQueries.ts`：当前 Host 全局 inventory 与官方 `client.plugin.list(undefined, { signal })` / `client.plugin.gui({ id }, { signal })`。
- 已安装官方 SDK 的 `PluginInfo.id` 可缺省；插件 owner 无法采用这种记录。`readGuiPluginInventory` 对缺失/重复 ID 和非法结构明确失败，**保留原实例**，不滤掉记录冒充成功空集合。`features.gui` 可缺省，表示非 GUI 插件。
- `components/gui-plugins/GuiFileLinkBridge.tsx`：先申请 `registerFileView(path, base)`，再 `openLink({ href, base, exact: true })`；按完整 `PanelTab.file` 匹配 `filePanel`。
- `components/gui-plugins/GuiPluginMount.tsx`、`lib/gui-plugins/host.ts`：React/Native 只拥有容器，`host.mountPanel(key, content, actions)` 唯一拥有后代、官方 PluginContext/PanelContext、真实 `usePlugin().options`、Solid owner 与 preview-actions 清理。
- `lib/gui-plugins/files.ts`：`sync/get/unwatch`、128 KiB UTF-8、64 模型项、持有 lease 的 2 秒前台 stat，失败保 prior。这里不另写文件模型、后缀解析器或 Eficy 编译器。
- `lib/gui-plugins/pages.ts` 与 host 的 `pagesLive/mountPage`：手机 `narrow:true` 时全局 `yuri.pages` inactive、不挂载 `yuri.page`。不能为了原生迁移给手机添加 Runmark 全局页。

## 新模块边界

| 文件 | 已准备内容 |
| --- | --- |
| `gui-plugin-preview.ts` | framework-neutral 的结构契约、输入/inventory 校验、两个下载 lane、逐插件采用、失败保留、同 revision 保持 DOM、源码切换/关闭/代际取消 |
| `gui-plugin-browser.ts` | 注入实际 host 和官方 client 的局部内容 adapter；强制 mobile appearance；pagehide 清理。**没有导入共享 Web loader** |
| `gui-plugin-composition.ts` | 单一 scope/lifetime 构造 browser-only dependencies、fetch、真实主题 CSS；关闭清理 owner，错误清理工厂资源 |
| `gui-plugin-transport.ts` | 官方 GUI GET + 实际 RPC POST 的 method/query/headers/body 保真 fetch；错误状态保留、redirect/凭据 query/任意写路由拒绝 |
| `gui-plugin-channel.ts` | 注入真实 WK reply port；请求 ID、同 scope 的 cancel、迟到结果拒绝，无主应用 bridge/global lookup |
| `gui-plugin-exports.ts` | 注入真实 ViewExportAPI，能力缺省不激活；保留取消/进度与 Host fence，不假造 PDF/长图保存成功 |
| `gui-plugin-factory.ts` | 构造实际 2.2.0 SDK、原 GuiPluginHost、原 QueryClient 和真实文件请求 adapter；复用官方 preferences/storage 契约 |
| `gui-plugin-storage.ts` | official synchronous Storage 的 scoped native transaction adapter；写失败必须在 adoption 前抛错 |
| `gui-plugin-entry.ts` | 实际 WK bootstrap、factory、source/retry、native Storage、文件读取与清理入口 |
| `scripts/build-gui-plugin-preview.mjs` | 现存 Vite 离线构建；断言无主 App/NSH runtime/state 入图；生成 index/assets/manifest |
| `ios/GuiPluginPreviewBridge.swift` | 独立 ephemeral WKWebView、原生 Back/Close/Error/Retry、主 frame 消息、captured GET/RPC lease 与 manifest 资产 reader；不承载主 UI |
| `ios/GuiPluginRuntime.swift` | typed runtime capture、HTTP metadata 校验、独立 actor pull reader、Relay 单 chunk rendezvous 与显式 legacy buffer |
| `ios/RuntimeBridge.swift` GUI 方法/registry | 同步 admission、既有 session/paired tunnel/认证、readGui/openGui、按 UUID 精确取消与 retireResources 撤销 |

原 `gui-plugin-browser` 生产图只有它自己、preview 与 framework-neutral `runtime-scope.ts`。新增 composition/transport/channel/exports 也不运行或导入 React、SDK、共享 desktop globals、runtime loader；exports 只复用 framework-neutral 的官方 owning `view-export/types`。
`gui-plugin-entry/factory` 是另一条明确的 **browser-only 构建图**，导入实际共享 SDK/host/QueryClient；它们不能被 App/QuickJS 导入。factory 的 QueryClient 复用真实 owning `queryRuntime` 单例，该独立 document 只有这一份 host；不是新的 Query shim。现有 `createWebFilesAPI` 硬绑定 Web `runtimeFetch/opencodeClient/runtime-file-resource`，没有 backend 注入入口，因此本地 adapter 按实际 owning route 实现 FilesAPI 的读取/列表/stat，并通过官方 GUI client 的 `file.find` 搜索。GUI Files 没有创建目录入口，required FilesAPI.createDirectory 明确 unsupported，不返回假成功。
本阶段仅在 RuntimeBridge 增加 GUI capture/read/open 与必要 registry/retirement hook；没有修改现有 terminal/ASR/strict stream/授权撤销实现或相关注释。application/resources/state/runtime.ts/main/nsh.json/共享 Web/Relay 源码均未修改。

## 配置、资产与认证

1. 原生入口接收真实 `sessionId/directory/path`、constructor 捕获的 `expectedHost:{hostID,lease}` 和每次打开独立的 `owner`。owner 只含字母/数字/`_-`、1–128 字符，同 lease 不得复用；不猜首项目、最近会话或后缀。路径仍由现有 host 决定。
2. Native capture 必须来自同一个已授权 Host/generation；认证直连/Relay 由 RuntimeBridge owner 决定。GUI/JS 层不创建 URLSession、RelayTunnel 或手机 localhost 连接。RuntimeBridge 为每个 GUI reader 管理独立 RelayTunnel，使用该 admission 已捕获的同一配对信息及 HTTP 凭据；不借用实时共享 tunnel。
3. `GuiPluginPreviewCapture.resource` 复用 `ResourceWebPreviewTransport` 的 fence/生命周期。**当前** `RuntimeBridge.resourceTransport().read` 仅允许 `/api/fs/stat`、`/api/fs/serve/*`；它无法读 `/api/plugin`、`/api/plugin/gui`、`/api/fs/read`。不能直接将其当 GUI transport。
4. `readGui(expectedHost, request: GuiPluginPreviewRequest, limit)` 的参数不变，**返回值改为 `GuiPluginPreviewResponse`**：status/mime/data + headers（默认空）。request 仍保留 method/route/headers/body Data。openGui 的 `GuiPluginPreviewByteStream` 也新增 headers（默认空）。Native reader 只提取白名单 metadata，不能把整份 upstream headers 传入；无 header 的 stat 仍可复用原 resource reader。无 reader 时 unsupported，不扩张原资源 allowlist。
5. 窄消息 `guiPluginPreview` 仅接受本次 `yuri-plugin://<ephemeral-owner>/index.html` 的 main frame。`bootstrap` 返回真实 intent/scope/runtimeKey/preferenceKey/locale/mode/themeCSS/labels；后续 `request/state/cancel/chunk` 必须带同一 expectedHost。request/cancel/chunk 使用同一递增 ID。旧 owner/子 frame/额外 wire 字段/凭据 query/其他 API/任意写路由均拒绝。Event/SSE、其余 SDK 请求未实现。
6. 响应走 buffered status/mime/headers/base64，或 pull stream 的 status/mime/headers + 每次至多 64 KiB base64。headers 白名单仅为 `x-yuri-file-exists`（true/false）、`x-yuri-gui-revision`（64 位小写 hex）、`x-yuri-gui-code`（cached/full）；大小写归一，重复、未知/额外字段或非法值在 Swift/channel/fetch 均拒绝。fetch 自行设置 Content-Type/Cache-Control。optional read 的 true+空正文表示空文件，false+空正文表示不存在；缺 header 时，factory 必须先 `await response.body?.cancel()` 释放未消费 reader，再抛出 `GUI_INVALID_FILE_EXISTENCE`，不得留下 stream 槽位或返回空成功。Host Bearer 不交 JS；options 只留真实 plugin context 内存。
7. `GuiPluginPreviewAssets(stagedDirectory:)` 读取构建器输出 manifest，核对每项 bytes/SHA-256 后生成 immutable 快照；单项 8 MiB、总 32 MiB、256 项。拒绝缺失条目、symlink 越界和路径绕过。只接受 `/index.html` 和 `/assets/*`，缺少真实产物即失败。响应保留 MIME/CSP，附加 no-store/no-referrer/nosniff。
8. WK `websiteDataStore.nonPersistent`，无主应用/Node/IPC bridge，直接 HTTP/WS/file/FTP 被现有资源网络规则阻止；插件不是同文档 JS 沙箱，不能据此声称恶意插件隔离。宿主不自动持久化 options；插件自行泄露配置不在可信 GUI 插件模型的保护保证内。
9. localhost 始终指 Host。当前没有为插件 iframe/依赖/图片/fetch 建成授权 assetresolver 与 Relay 完整适配；禁止放开手机直连或把 Bearer/AK 塞进 URL 作为“修复”。外部资源/CSP 不兼容必须暴露，而不是降级假装成功。
10. 官方 GUI Store 是同步 API：不能把异步 postMessage 的写入当作已保存。entry 用精确 main-frame、同 scope 的 `window.prompt('yuri.gui.storage.v1', requestJSON)` 进入 WKUIDelegate **同步原生事务**；无交互弹窗，不开放通用 prompt/native bridge。`GuiPluginPreviewStorage` 原子写入应用私有目录、成功后才采用内存值；iOS 加 completeFileProtection，macOS Foundation fixture 仅 atomic。仅允许当前 runtimeKey 的 `yuri.gui-plugin.*` 与 exact official preferenceKey。它保存插件主动 Store 值和 disabled 偏好，不自动保存 bundle/options；浏览器 localStorage 不承载这些数据。

## 最小接线提案（由拥有相应文件的 main/transport owner 执行）

1. **Runtime capture 已实现，main 装配待接**：`runtime.guiPluginPreviewCapture(expectedHost:) throws -> GuiPluginRuntimeCapture` 同步 admit，返回 expectedHost/resource/isCurrent/readGui/openGui；resource 由同 expectedHost 的 resourceWebPreviewTransport 构造。各请求使用捕获的 connection/generation/lease、原 makeRequest/session/tunnel，await 前后检查 native admission。POST RPC 不新增自动重试；保留原资源 allowlist，不在 send 时读取最新 Host，不把凭据传回 TS。
2. **browser factory 已实现，无需 main 重写**：index 调用 `startGuiPluginPreview`，通过 `captureGuiPluginFactory` 构造实际 SDK/GuiPluginHost/QueryClient/FilesAPI/官方偏好与 native Storage。origin 使用当前 custom scheme owner，不是 Host URL；所有 HTTP 只走同 scope channel/fetch。main 只需填写原生 bootstrap 和存储 backend，不需要注入 fake client/files。
3. **browser ↔ Swift 已实现**：entry 绑定真实 WK main-frame reply port，使用 bootstrap 的原始 scope；changed 转发 state，teardown 清理 composition/channel。JS signal 发送精确 cancel ID；Swift 取消交 Runtime sender。Runtime pending open/read、主动 cancel 与 retire 的 direct/真实 mux loopback 已验证；WK/设备到真实 Host 的整链仍待验证。
4. **资产 staging**：运行下方离线命令后，将整个输出目录（index/assets/manifest）复制到 app 的 `gui-plugin-preview/`；用 `GuiPluginPreviewAssets(stagedDirectory:)` 创建快照，`readAsset` 返回 `assets.read(path,limit:)`。这是实际 host entry，不需要 main Web App。bootstrap.themeCSS 必须来自当前 Host 的真实完整 CSS；字体/图标/iframe assetresolver 仍需接线。
5. **Swift main 装配**：capture 仍提供 expectedHost/isCurrent/resource/readGui 或 openGui/readAsset/labels/bootstrap/storage。bootstrap 的稳定 runtimeKey、official preferenceKey、locale/mode/themeCSS 必须来自当前 Host；storage 为同 Host 私有持久 backend。labels 源码可复用 guiPlugins.preview.viewSource，预览可复用 filesView.editor.switchToPreviewMode。Host 切换/后台等 Native 全局生命周期才调 invalidate；**每次打开的异步清理不得调全局 invalidate，必须 exact owner close**。
6. **文件入口/API 变化**：constructor 创建 `bindGuiPluginPreview(capturedScope, call, identify, isCurrent)`，identify 每次生成不同 owner。调用 bound.present(intent) / bound.close()；绑定器始终传同 scope + 本次 owner，并对 rejected/timeout 结果做 exact cleanup。底层 `presentGuiPluginPreview` 现需第五参数 owner；JS `plugins.preview.close` 的 body 为 `{expectedHost, owner}`，旧的仅 scope body 被拒绝。Swift `close(input)` 现为 async，等待该 ticket 的 dismissal/retirement。此任务未修改资源入口 owner。
7. **代码更新/停用**：前台真实 plugin/config/reconnect authority 接原同步 owner，调用 refresh；关闭/Host 退役调用 close。当前准备层只有显式 refresh，尚未接上共享 Provider 的 paint/idle、Query cache、事件与偏好写入管线，不能宣称窗口级加载策略已对齐。
8. **PDF/长图**：用 `captureGuiPluginExports({scope, signal, isCurrent, capture})` 包装**实际设备容器** ViewExportAPI，并传给原 GuiPluginHost 的 `viewExport`。不存在原生实现时返回 undefined，两契约保持 inactive；不能将 Host RPC、浏览器下载或虚构 saved 当作系统导出。插件本身仍拥有 preview-actions/capture，宿主不添加 Eficy 专用按钮。

## 逐项验收与真实缺口

`prepared` = 有隔离实现/测试，不等于产品接线或设备验收。

| 项目 | 状态 / 证据或缺口 |
| --- | --- |
| 真实 SDK + Solid owner / context / 本插件 options | prepared：synthetic CJS 经现有 host；检查 options 只在 context、状态无配置 |
| 自定义完整后缀 / 文件 root / 实际文件读取 | prepared：`.report.json` synthetic；未写真实 Eficy 特例；source 模式释放观察 |
| mobile 全局页 inactive | prepared：实际 SDK 合同 inactive，不执行 page.render |
| 相同 revision 与 50 次无关刷新保留 DOM | prepared：真实宿主测试，不等于第三方插件性能验收 |
| source、replacement、disable、空 inventory、双实例、pagehide | prepared：实际 cleanup/Style/action abort；未知结果不跨 Host 采用 |
| inventory/bundle 错误保 prior、invalid inventory | prepared：明确区分失败和成功空集合；旧 mount 不丢失 |
| 两 lane、逐插件失败隔离 | prepared；启动调度、Query/invalidation、持久代码校验尚未接线 |
| WK 原生 Back/Close/Error/Retry、进程终止/迟到 fence | SDK 静态检查 + Foundation 测试；未运行 UIKit，不能确认视觉/手势/后台行为 |
| 认证 GUI GET | 生产 Runtime capture/read/open 已实现，direct/paired E2EE mux loopback 验证；**main/UI 接线与真实插件未验收** |
| 官方 GUI browser host bundle / registry | 实际 factory/entry/IIFE/index/manifest 已生成并验证；**main 的 build-ios staging 已接入**，本轮变更需重新生成/stage；Native 文件路由/presentation capture 装配仍待 main 接入 |
| plugin context storage 持久化与偏好 authority | 官方 storage/preferences + scoped synchronous native backend 已实现；实际 bundle 验证写失败不采用、disabled 不下载，Foundation 验证落盘重开/跨 Host 拒绝。**main 私有目录/稳定 runtimeKey/preferenceKey 注入未接线** |
| file watch 的真实 2 秒刷新/缺失/恢复 | 已复用原 host 文件模型；仅 synthetic read/清理验证，尚无真实 transport 证据 |
| plugin iframe、外部依赖、localhost、Host assetresolver/Relay | **未完成**，当前 fail-closed；不据此删除任何手机能力 |
| 官方 SDK RPC / 其他写请求 | 实际 SDK RPC POST prepared；生产 Runtime direct/真实 mux 验证原始 body/header、422 和单次请求；main 装配待接，其余请求仍明确 unsupported |
| system copy/save/openExternal、toast | **未完成**，现有 host 的客户端能力依赖浏览器/Capacitor，NSH 设备桥尚未接；不以浏览器 anchor 下载冒充已保存 |
| preview-actions / PDF / 长图 / snapshot | action 注册/清理/signal abort、真实 export capability adapter prepared；原生导出/系统保存/实际 iframe snapshot 未接线/未验收 |
| 主题/样式/font/icon 动态同步 | Style、composition theme 撤销 tested；当前 Host 的 themeCSS 数据源/字体/图标同步未接线 |
| GUI CJS 容量与 native reply | 生产 Runtime openGui direct/真实 mux 均完整读取 33.0625 MiB，返回 chunk ≤64 KiB；JS/Foundation 原有 529×64 KiB 回归保留。**main 必须传 openGui**，仅提供旧 buffered readGui 仍有 32 MiB 差异。SDK 最终 JSON/JS heap 与真实设备内存未验收 |
| Eficy TSX iframe 编译/运行/提交/更新/报错/导出 | **未完成**，未下载/执行其插件；不能由 synthetic data viewer 推定 |
| 其他第三方插件与真实 direct/Relay-only | **未完成**，没有真实 Host/插件/设备验证；本阶段 synthetic loopback 不能替代，保留全部原手机 scope |

## 可执行离线构建与 main staging

```sh
node packages/nsh/scripts/build-gui-plugin-preview.mjs
# 或直接构建到主构建准备复制的独立目录：
node packages/nsh/scripts/build-gui-plugin-preview.mjs --out /path/to/staging/gui-plugin-preview
```

默认产物：

```text
packages/nsh/.nsh/gui-plugin-preview/
  index.html
  assets/entry.js       # 约 1.37 MB，实际 SDK/Solid/host/factory
  assets/surface.css
  manifest.json         # version/entry + 每项 mime/bytes/sha256
```

index 实际调用 exported `startGuiPluginPreview`；没有 embedded 示例报告或第三方插件代码。
build 使用已存在的 Vite，不执行依赖安装/下载；额外断言主 Web App、NSH App/application/runtime/state 没有进入该 browser bundle。
main 已在 `scripts/build-ios.mjs` 接入构建与目录 staging；此处不再标为未接线。本 agent 未修改该主脚本，也未运行 main build；main 新增 body-cancel 补丁后尚未重新构建/stage，下一次主 build 会刷新产物。先前 main 核对过的真实 out hash 不覆盖该新补丁，也不代表真实 Runtime 插件已运行。

Swift owning capture 内实际可用的装配点：

```swift
let assets = try GuiPluginPreviewAssets(stagedDirectory: stagedURL)
let io = try runtime.guiPluginPreviewCapture(expectedHost: expectedHost)
var captured = GuiPluginPreviewCapture(
    expectedHost: io.expectedHost,
    isCurrent: { expected in expected == io.expectedHost && io.isCurrent() },
    resource: io.resource,
    readAsset: { path, limit in try assets.read(path, limit: limit) },
    labels: labels
)
captured.bootstrap = GuiPluginPreviewBootstrap(
    runtimeKey: runtimeKey, locale: locale, mode: mode,
    themeCSS: themeCSS, preferenceKey: preferenceKey
)
captured.storage = hostStorage // GuiPluginPreviewStorage，稳定 Host 命名空间
captured.readGui = io.readGui  // 返回 GuiPluginPreviewResponse，含白名单 headers
captured.openGui = io.openGui  // 完整大响应需此 pull lane
```

`GuiPluginPreviewByteStream` 有 status/mime/headers、`read(limit)` 与幂等 `cancel()`；read 每次最多 65536 bytes，EOF 返回 nil。SDK 最终只消费正常 Response/JSON，通道不截断源码、不修改 Unicode、不把数据写 URL。Native/JS 对所有 pull 前后检查同 scope；取消/关闭撤销 reader。Runtime openGui 已接生产 direct/Relay，main 仍须把它传给 presentation capture；提供旧 readGui 时仍为原 32 MiB buffered lane。

## Runtime reader 实现与边界

- `GuiPluginRuntimeCapture` 的字段是 expectedHost、resource、无参数 isCurrent()，以及与 presentation capture 同签名的 readGui/openGui。同步 capture 不创建请求，不依赖 main bootstrap。
- direct 复用 RuntimeBridge 原 URLSession 的 bytes(for:)；独立 actor 持有 AsyncBytes iterator，按需求在 MainActor 外组装至多 64 KiB。没有全响应 Data、base64 或 app callback queue。原 delegate + suspend 试验在真实 loopback 中出现已排队 callback 积压，已删除该实现；当前不使用原 boundedBytes，也不在 MainActor 逐字节遍历。Foundation 自身的网络缓冲仍由系统管理，不宣称已证明所有系统缓冲的精确内存上限。
- Relay 复用原 stream 的 onResponse/onData，但每个 GUI reader 使用 **RuntimeBridge 管理的独立配对 lane**。同一 captured relayUrl/serverId/hostEncPubJwk 与 makeRequest 生成的凭据进入既有 RelayTunnel，不改 codec/握手/原实时共享 tunnel。一个 wire chunk 通过 actor rendezvous 持有，消费完才释放 producer，返回值仍每次至多 64 KiB。Accept 原样保留，缺省仍为 makeRequest 的 application/json。GUI 慢消费只能阻塞它自己的 lane，不能阻塞其他 GUI reader 或 shared global/chat/WS/HTTP/pong；此前“公平性未验收”的描述不足以覆盖实际共享 receive 阻塞，已按 oracle P1 修复。
- Runtime 的 GUI registry 上限与原生 surface 相同为八个 active request/reader；超限明确 busy，不创建无限连接或排队 Task。每个 lane 的 producer 在成功/失败结束时 close，显式 cancel 和 retire 也精确关闭该 lane；source cancel 幂等。独立 GUI lane 自身仍遵守原 RelayTunnel 的 heartbeat 与 request timeout：如果它发生终态失败，按下述 error-drain 契约处理，不能将超时扩大为 shared realtime 连接失败。
- direct 在一次 read 已收集非空 bytes 后遇到上游错误时，先返回该 chunk，再由下一次 read 抛 terminal error；不会读成 EOF 或自动重试。Relay upstream finish(error) 保留当前 wire chunk 未消费的尾段及 offset，排空后再抛同一个 terminal error。**只有明确 cancel/Task 取消/lease 退役才立即清空尾段**；错误的类型名称本身不作为撤销 authority。
- 每次 open 在第一个 await 前注册 UUID cancel；关闭只清自己的 UUID。pending header、pending read、主动取消、后台/stop/Host retirement 都撤销原 source。retireResources 先移除全部 GUI 注册项并取消，再保留既有其余资源撤销与 onInvalidate 通知。late reader 返回前再次核对 stopped 与原 admission；不能删除或采用新 reader。
- buffered readGui 是明确 limit 的旧接口，最多 replyLimit；用独立 actor 累积，到 limit 失败并取消。大 CJS 应始终走 openGui，不能用增大 aggregate limit 替代。
- 仅提取存在性/revision/code 白名单；upstream Cookie 等不透传。非 2xx 原样保留，3xx 拒绝；没有 Content-Type 时保留空 MIME（含合法 204），不伪造响应 metadata。

所有直接编译 RuntimeBridge.swift 的 native harness 需要 **GuiPluginPreviewBridge.swift + GuiPluginRuntime.swift** 两个 source；前者依赖原 RuntimeHostScope/ResourceWebPreviewBridge。main 已回传补完七处旧清单，并在跑自己的组合回归；本 agent 未修改这些清单。自有 gui-plugin-runtime-fixture 同样包含这些依赖，并对生产源执行 Apple iOS SDK typecheck 与 macOS warnings-as-errors 编译。

Runtime 本轮实跑命令：

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/gui-plugin-runtime.test.ts packages/nsh/gui-plugin-native.test.ts packages/nsh/gui-plugin-ownership.test.ts packages/nsh/gui-plugin-transport.test.ts
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/gui-plugin-runtime-regression.test.ts
```

P1/P2 修复前第一组 **4 files / 11 tests 通过**，其中新 Runtime direct/Relay 两个可执行 fixture 各自验证：生产源读取 33.0625 MiB、chunk ≤64 KiB 且内容逐字节一致、暂停消费 100 ms 不会让 source 发完整份响应、rendezvous 半块消费不释放 producer、legacy limit 错误与取消、空文件/缺失文件、无 Content-Type 的 204、RPC 原 body/header/422 和单次请求、redirect 拒绝、wrong scope、pending header/read Task 取消、Retry 时 pending old read 晚返回不影响新 reader、后台/stop/Host 凭据更换撤销。随后补入 queued Task 运行前 cancel 不访问 source 的断言，新 Runtime 两项再次通过；未重复累加测试数。这些历史绿没有覆盖下面 oracle 发现的共享 receive 阻塞与 partial-error 丢失。

P1/P2 修复前第二组 **134 tests 通过**：自有 compilation wrapper 给既有 owner harness 加 GUI 依赖，原 harness 代码原样执行。包含 terminal/ASR/授权撤销 63 项、remote desktop 56 项、terminal synthetic 真 mux loopback 15 项（含原 1 MiB 场景）。未改旧 owner 的测试文件、清单或断言。这不是重新宣称历史 main/SDK 120 项全量已经由本 agent 重跑。

本阶段未重跑 browser/main build；main 已报告的 browser 14 passed 仍是其原结果。新增 Runtime 独立 oracle `ses_e49d85323ffeZSSSx0tMl4aRrn` 已发现下面 P1/P2，修复后最终复审待 main 续跑；原三 P2 + body-cancel 的 closed 结论不自动延伸至 Runtime。

## Runtime 独立 oracle P1/P2 修复与复核

| 发现 | 实现与新增回归 |
| --- | --- |
| P1：GUI rendezvous 阻塞 RelayTunnel 唯一 receive，连 global/chat/WS/pong 都无法前进 | GUI reader 各自独立、同授权的 native-managed lane，上限八个；保持单 chunk 背压，取消/完成只关闭 exact lane。新增生产 RuntimeBridge + 真实 E2EE mux isolation executable：两个 GUI reader 各消费 1 byte 后停拉，另一个 GUI HTTP 仍能读取，原 shared tunnel 的 global/chat SSE、terminal echo、resource HTTP、freePort 与加密 ping/pong 连续前进；检查它们仍是同一个 shared lane、无 runtime.disconnected。实际运行超过原 30s+15s heartbeat 阈值，不改 Relay clock；每秒执行真实请求，没有长 sleep |
| P2：direct 一次 read 中 source.next 抛错丢掉已收集 20 KiB；Relay finish(error) 丢掉半个 frame 尾段 | direct owning reader 改为泛型 AsyncIterator，生产仍为原 URLSession.AsyncBytes.Iterator；synthetic iterator 精确产出 20 KiB 后抛错，断言先得到完整 ordered bytes，再得到 terminal error。上游错误恰为 CancellationError 也不能冒充 ownership 撤销。Relay 单 frame 先读 20 KiB，再 upstream fail，余下 bytes 精确读回，下一 read 才抛原 error；另测 explicit cancel 覆盖 terminal error 并立即丢弃未读尾段。原 Task cancel/retirement/unknown RPC 单次请求回归继续保留 |

修后最终实跑：上述 focused 命令 **4 files / 12 tests 全通过**（Runtime 文件新增 isolation 后为三项），旧 owner 原 harness 包装回归 **134/134 通过**，合计 **146 项**；编译包含生产源 Apple iOS SDK typecheck 与 macOS warnings-as-errors。47s isolation 真实运行跨过旧 heartbeat 阈值，没有修改 RelayTunnel 源码或注入替代时钟。测试服务器显式 idleTimeout=0，以便由 native 生命周期控制故意暂停的 source；stderr 仍要求为空，没有过滤 timeout warning。八 reader 预算用已完成网络响应、但未消费的八个 logical reader 验证，不把 URLSession 默认连接池容量误当作 GUI registry 容量。

中间一轮回归因本 agent 在 Swift 编译时编辑 source，被编译器拒绝，134 项没有执行；生产代码冻结后完整重跑通过。旧 145 项不是本次新 P1/P2 的通过证据，采用上面修后结果。独立 oracle `ses_e49d85323ffeZSSSx0tMl4aRrn` 的修后最终结论仍待 main 续只读复审，不提前标为 closed。

bootstrap/context 数据桥按用户最新指令暂停，尚未改 appearance-core/appearance、展示 context schema 或 main；待用户恢复该任务。此次没有改 RelayTunnel/codec/握手、main/application/build/nsh.json/资源入口，也没有真实 Host/插件/设备/engine/main build、Git 或依赖安装。

文件入口优先使用 `bindGuiPluginPreview`；直接调用低层 present 也必须带新 owner。entry 源码按钮仍读真实文件并释放/重建同一 Panel owner，Retry 读取原生偏好后 refresh，不会自动安装插件。

## 本次离线验证

```sh
./node_modules/.bin/vitest run --config packages/nsh/gui-plugin-browser.vitest.config.mts
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/gui-plugin-preview.test.ts packages/nsh/gui-plugin-native.test.ts packages/nsh/gui-plugin-ownership.test.ts packages/nsh/gui-plugin-transport.test.ts packages/nsh/gui-plugin-bundle.test.ts
./node_modules/.bin/tsc --noEmit -p packages/nsh/gui-plugin-browser.tsconfig.json
```

前一轮本 agent 验证：browser **13/13**（含实际 artifact 3 项，以及 buffered/stream 两条真实 factory/channel optional-read 用例）；pure preview/transport **9/9**；Foundation lifecycle **1/1**；Foundation exact-owner/chunk-race **1/1**；iOS SDK **1/1**；另有 focused bundle 图检查 1 项，独立 browser 类型检查通过。
后续 main 补充 body-cancel 修复与回归，报告 browser **2 files / 14 tests 全通过**：actual factory/channel 的 missing-header 响应首块非 EOF、仅 1 个 reader 槽位；断言精确 cancel id=1、open readers=0，随后仍可读取 empty existing file。本次仅按 main 提供的实跑结果更新文档，未修改其代码补丁，未重跑测试或构建；未重新汇总为本 agent 实跑总数，也不以此替代 main 全包或设备结果。
实际 artifact 测试会先运行正式 build script，然后求值这份 emitted IIFE；所有 Host 回复/插件源码均 synthetic，默认浏览器/原生网络从未使用。Foundation 读取同一正式产物并核对 manifest bytes/hash、资产路径、原生存储重开与分块字节。UIKit 只 typecheck、不执行。
本 Runtime 阶段只使用 loopback HTTP/WebSocket 与真实生产 E2EE mux，Keychain 仅用内存替身；未访问真实 Host、执行插件/PTY、安装、设备、engine/main build、发布或 Git。
`dead-code` 脚本依赖 `bunx knip@5.80.0`，本地没有该可执行文件；在禁止网络/安装下未运行，不触发下载。

## 三层复核记录

以下仅是本 agent 的分层复核；未完成独立 agent review，不将其标记为独立审查。

1. **类型/模块层**：已修 test fixture 的 required option value；复用 owning UI QueryClient/client，避免相对 node_modules 的类型依赖丢失。之前隐 any 原因：TS 从 `../ui/node_modules/@tanstack/react-query/build/modern` 相对路径解析时未找到传递 `@tanstack/query-core`，不是共享 files.ts 业务类型缺陷；无需改共享文件。Window 字段由现有 `packages/ui/src/types/desktop.d.ts` 所有，main 已纳入 tsconfig；本 agent 未改 tsconfig/desktop/files。
2. **scope/生命周期层**：constructor immutable scope、同 Host lease 续发拒绝、await 前后 fence、请求取消 ID、双实例、source/replace/disable/pagehide 检查；修复 opening 资产预读期间 close 不能取消的问题。opening 分支只做真实 SDK typecheck，未运行 UIKit，不能声称该原生交互已经实测。
3. **协议/能力层**：本地实际 2.2.0 SDK 执行 GUI GET/RPC，method/route/body 与安装版本核对；asset symlink/缺失、非 2xx 保留、export stale result 检查。完整 Eficy runtime/外部 iframe 依赖/assetresolver/真实 Relay/system 能力仍未验收，全部保留在上表范围。

## 独立 oracle 三项 P2 的闭环证据

审查来源：只读 oracle session `ses_e4a288cadffeCCyLBV7aZKQ52t`，不是本 agent 自我审查结论。

| 发现 | 修复与证据 |
| --- | --- |
| Retry 后旧 pending chunk 抛错会删除新同 ID stream | catch/EOF 始终退役 captured stream，仅 document generation + read task ID + 注册实例同时匹配才删除。Foundation 使用生产退役代码执行 old pending read → Retry → 新 ID=1 stream → old throw，验证新流仍可读取 |
| 同 lease 的 A 晚 close/cancel 能清掉 B | 原 bridge 的 ownership 状态移到同文件 Foundation 可测 ticket gate；所有 prepare/cancel/native close/dismiss callback 捕获 exact ticket。关闭过程完成前不准入 B；unknown close 先验证 expected scope 并记录 tombstone，close-before-present 不能重新准入。Foundation 验证同 scope A close → B → late A cleanup 与 opening/预先 close，TS 验证 close payload 精确 owner |
| optional read 丢失 exists metadata | Swift buffered/stream → channel → fetch 贯通上述白名单 headers。真实 factory 的 buffered/stream 两种测试均验证 true+空、false+空、缺 header 失败和 extra header 拒绝；Foundation 验证 metadata 验证/传递；RPC fidelity 和 33 MiB pull 回归保留 |
| 后续发现：缺 header 抛错前未取消未消费 stream | main 已在 factory.readFile 缺 header 分支增加 await body.cancel，再抛错；新增 actual factory/channel 的非 EOF 首块、单槽位回归，验证 exact cancel id=1 / open=0，之后 empty existing file 仍可读。main 实跑 browser 2 files / 14 tests 通过；同一 oracle 已复核为静态实现层 closed，无 remaining |

main 已回传：原三项 P2 与后续 body-cancel P2 均经同一 oracle 静态复核 closed。body-cancel 复核确认测试首块为非 EOF，并在最终 teardown 之前检查精确 cancel 和槽位释放；该次 review 仅只读，未重跑测试。该结论不覆盖后来新增的 Runtime reader；本阶段 Runtime 已有生产 loopback/真实 E2EE mux 证据，未运行 UIKit/真实 Host/设备，不能冒充完整插件验收。main bootstrap/路由等接线与其余兼容缺口继续保留。
