# Yuri 移动 GUI 插件入口、端侧渲染与全流量 Relay：本地集成接缝

调研日期：2026-11-06。只读取当前工作树和平台文档；未修改产品源码，未执行 git、构建、测试或设备操作。以下 `file:line` 均对应调研时的工作树；“建议”与“缺口”不代表现有实现。

## 1. 移动首页入口、插件页面和生命周期由哪些模块拥有？

### Takeaway

入口和导航可以直接复用已有 `yuri.page`、插件快照及手机二级页面栈。真正的改造量在网络执行边界：现在的 CJS、Solid render 和第三方 DOM 全在 Yuri 主文档运行，没有现成的独立网络上下文；仅放开移动端判断无法满足“所有视图网络经过 Relay”。

### Cited Findings

#### 精确代码地图

| 接缝 | 当前事实与位置 |
|---|---|
| Projects 顶部 | `MobileProjectsHome.tsx:92-117` 是纯展示 props；`:549-617` 渲染标题和 trailing 搜索/加号菜单；`:619` 开始置顶/进行中列表。在标题 trailing 增加一个有入口才出现的市场按钮，或标题后增加入口卡，是最小 UI 接点。[源码](../../packages/ui/src/mobile/projects/MobileProjectsHome.tsx#L549) |
| Projects 数据装配 | `MobileProjectsHomeContainer.tsx:59-85` 收到打开页面的 callbacks；`:87-118` 装配现有模型和导航 actions。GUI 入口宜用叶子组件订阅，不把 GUI 快照并入会话目录模型。[源码](../../packages/ui/src/mobile/projects/MobileProjectsHomeContainer.tsx#L59) |
| 已有重复入口来源 | **当前移动页标题已直接展示所有 TitlebarItem**：`MobileTabPageHeader.tsx:106-108`；聊天标题还有 `MobileChatHeader.tsx:44`，移动会话抽屉还有 `SessionSidebar.tsx:2349`。新增 Projects 市场前应明确这些原入口的迁移，不能误以为手机尚无任何插件按钮。[根页标题](../../packages/ui/src/mobile/MobileTabPageHeader.tsx#L106)、[聊天标题](../../packages/ui/src/mobile/chat/MobileChatHeader.tsx#L44)、[抽屉](../../packages/ui/src/components/session/SessionSidebar.tsx#L2349) |
| 根页面装配 | `MobilePhoneShell.tsx:233-251` 装配 Projects/Bots/任务/Settings；`:253-334` 投影二级页面。现有 Assistant → Settings 是“列表父页 + 详情子页”的直接先例（`:269-282`）。[源码](../../packages/ui/src/mobile/MobilePhoneShell.tsx#L233) |
| 手机导航模型 | `mobileNavigation.ts:21-45` 的 `MobileSecondaryState` 当前只有 chat/draft/assistant/instances；`:4-8` 明确手机不使用桌面 MainTab/URL router。`useMobileNavigationStore.ts:37-77` 定义 actions，`:255-257` 是最小 `openInstances` 实例。[模型](../../packages/ui/src/mobile/mobileNavigation.ts#L21)、[store](../../packages/ui/src/mobile/useMobileNavigationStore.ts#L37) |
| 返回链 | `MobilePhoneShell.tsx:159-188`：先 nested page，后 close secondary，并向 MobileApp 注册统一 back handler。新市场页 depth 1、插件详情 depth 2 可接同一机制。[源码](../../packages/ui/src/mobile/MobilePhoneShell.tsx#L159) |
| 栈呈现/手势/焦点 | `MobileTabsRoot.tsx:20-29` 的 `MobileSecondaryPage` 有 key/content/onBack/depth；`:60-66` 仅保留顶层和直接前驱；`:92-112` 接 back coordinator；`:114-139` 恢复入口焦点；`:167-176` 自动隐藏 native dock；`:246-268` 让下层 inert。无需另建手机 modal/手势系统。[源码](../../packages/ui/src/mobile/MobileTabsRoot.tsx#L20) |
| Provider 已包住手机 | `MobileApp.tsx:3988-4012` 在 Sync/RuntimeAPI 内挂唯一 `GuiPluginsProvider ready={isInitialized}`；无需给 Projects 再装一套 inventory/provider。[源码](../../packages/ui/src/apps/MobileApp.tsx#L3988) |
| 页面契约 | `pages.ts:4-30`：registry `yuri.page`、contract `yuri.pages`；页面仅 `{id,title,icon?,render()}`，身份 `JSON.stringify([pluginId,pageId])`，没有 URL、包名或 market metadata。[源码](../../packages/ui/src/lib/gui-plugins/pages.ts#L4) |
| 页面快照 | `host.ts:31-40` 提供 pages/titlebarItems/panels；`:444-447` 验证页面；`:475-493` 仅发布 active 插件贡献。页面快照不含 options 或 render 函数。[源码](../../packages/ui/src/lib/gui-plugins/host.ts#L475) |
| 页面移动禁用点 1 | `host.ts:322-333`：`pages.open` 与 contract live 都按 `appearance.narrow` 拒绝；`:676-682` 的 `mountPage` 同样拒绝 narrow。[源码](../../packages/ui/src/lib/gui-plugins/host.ts#L322)、[mount](../../packages/ui/src/lib/gui-plugins/host.ts#L676) |
| 页面移动禁用点 2 | `GuiPluginsProvider.tsx:205-206` 的 openPage 只接受非 mobile，且调桌面 `useUIStore.openGuiPage`；`:224-237` 在 narrow 时关桌面页面并从桌面 store 同步 current page。[源码](../../packages/ui/src/lib/gui-plugins/GuiPluginsProvider.tsx#L205) |
| 页面移动禁用点 3 | `GuiPluginPage.tsx:14-27` 从桌面 activeGuiPage 取选择，mobile 直接 null；`:28-34` 是桌面 WorkspaceSurface，不是手机导航容器。[源码](../../packages/ui/src/components/gui-plugins/GuiPluginPage.tsx#L14) |
| 桌面选择 | `useUIStore.ts:1946-1955` 打开 main tab=`plugin`；`:1967-1969` runtime restore 清 activeGuiPage。手机应接 mobile-owned selection，而不是扩大此桌面 store 职责。[源码](../../packages/ui/src/stores/useUIStore.ts#L1946) |
| Titlebar 不是页面 | `host.ts:451-453` 记录的是任意 run action；`:506-510` 执行当下最新 run 并检查 busy。没有 pageId 关系；不能通过 key/label 猜目标 URL或页面。[源码](../../packages/ui/src/lib/gui-plugins/host.ts#L451)、[约束文档](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md#L23) |
| 图标 | `GuiPluginTitlebarItems.tsx:8,16-21` 现有 IconName→sprite alias 和未知图标 fallback；`:24-31` 区分 actionable/passive。Package artwork 与 GUI IconName 是两套概念，当前 GUI 入口不查询 package icon。[源码](../../packages/ui/src/components/gui-plugins/GuiPluginTitlebarItems.tsx#L8)、[文档](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md#L12) |
| React/Solid 挂载 | `GuiPluginMount.tsx:31-70` 按 host/key/kind/revision 创建并清理 foreign mount；`host.ts:684-695` 用官方 PluginContext 包裹 Solid render、归属错误并 dispose。`mountPanel` 还注入 PanelContext、文件 watch 和 actions（`:633-667`）。[React bridge](../../packages/ui/src/components/gui-plugins/GuiPluginMount.tsx#L31)、[Solid host](../../packages/ui/src/lib/gui-plugins/host.ts#L633) |
| 同文档执行 | `bundle.ts:49-58` 用 `new Function` 在当前 realm 求值 CJS；`host.ts:367-372` 直接向当前 document.head 加 Style；`:335-337` 注入 options/client/app；`:414` openExternal 直接 window.open。它不是隔离 iframe runtime。[求值](../../packages/ui/src/lib/gui-plugins/bundle.ts#L49)、[样式](../../packages/ui/src/lib/gui-plugins/host.ts#L367)、[context](../../packages/ui/src/lib/gui-plugins/host.ts#L335) |

#### 启动、切换、卸载必须沿用的现有约束

- Provider 在主界面 ready 后双 rAF 才开 inventory，idle 预加载最迟 2 秒（无 idle API 为 1 秒）；explicit demand 仅跳过 idle，不能越过初始绘制。已有成功 bundle 同 revision 不重复 setup；bundle 下载并发最多 2。市场隐藏条件应基于实际已注册页面，不以 `features.gui` 或 inventory 非空当作可打开视图。[Provider:97-119、166-190](../../packages/ui/src/lib/gui-plugins/GuiPluginsProvider.tsx#L97)、[activation:35-58](../../packages/ui/src/lib/gui-plugins/GuiPluginsProvider.tsx#L35)、[Query:8-29](../../packages/ui/src/queries/guiPluginQueries.ts#L8)
- inventory Query key 按 transport；请求前后检查 generation；刷新失败不应变成成功空列表。bundle-not-found 会重新核验 inventory 后取消旧请求，不让单个插件失败阻断其他插件。[Query:31-104](../../packages/ui/src/queries/guiPluginQueries.ts#L31)
- Provider 在 transport 改变时立即隐藏旧 host、重置 demand，effect cleanup abort client/dispose host。新资源应复用此 owner，而不是 module-global “当前插件 URL”。[Provider:100-129、192-216](../../packages/ui/src/lib/gui-plugins/GuiPluginsProvider.tsx#L100)
- GUI client 同时捕获 runtimeKey、transportIdentity、generation，调用前/异步后检查。新网络 lease 也需要这个三元 fence，单比 serverId 不足以阻止 A→B→A 的迟到提交。[gui client:10-38](../../packages/ui/src/lib/opencode/gui.ts#L10)
- `host.release` abort 插件 controller、清 native 和 cleanups、dispose Solid roots、撤销贡献；host.dispose 释放全部实例、files/storage/catalog。视图 mount 则有独立 disposer；关页不能等同于停插件。[host:215-252](../../packages/ui/src/lib/gui-plugins/host.ts#L215)、[mount:684-695](../../packages/ui/src/lib/gui-plugins/host.ts#L684)
- MobileApp 对同设备 LAN↔Relay 仅 reconnect、不 reset mobile navigation；不同 runtime 才 reset。Provider 却按 transport 重建，因此插件页若保留选中 key，需要新 host readiness 后恢复或明确收起，不能保留旧 tunnel/frame lease。[MobileApp:3730-3752](../../packages/ui/src/apps/MobileApp.tsx#L3730)
- `GuiPluginsContextValue.host` 当前是具体 `GuiPluginHost` 类型；新增跨 realm 实现需收窄为宿主接口，不能假装另一个 iframe 的 render closure/HTMLElement 可以 structured-clone。[react.ts:1-20](../../packages/ui/src/lib/gui-plugins/react.ts#L1)、[pages.ts:8-13](../../packages/ui/src/lib/gui-plugins/pages.ts#L8)

### Inferences

1. **最小入口改造**：增加一个 leaf 市场入口和一个 icon-grid 页面，数据取 `snapshot.pages`（真正可渲染的 app 入口）；点击以现有 page key 打开 depth 2。passive TitlebarItem 不算应用。已有 Titlebar action 若要保留为卡片，仍只能执行原 action，不能保证其会打开页面；不要把它与 page 强行去重/配对，因为当前契约没有这种关系。
2. 增加 `MobileSecondaryState` 的插件市场状态（可带 activePageKey），store actions 和 `MobilePhoneShell` projection；直接复用两层渲染和 back coordinator。Projects header 专属入口优先于改公共 header，否则所有 tabs 又会出现市场按钮。
3. 放开 narrow 的前提应是**移动页面承载能力 ready**。以明确 host option/capability 驱动 `yuri.pages` live；不能先把 narrow 判断删除、让插件在代理准备好前跑网络。
4. `pages.current()` 应来自当前移动页面选择；同一个页面可复用原 mount 生命周期和错误 canvas，手机外层单独负责返回栏/safe area。
5. “端侧渲染”本身已有：Solid 在客户端执行。要实现完整网络路由，必须把第三方执行与网络 context 一起纳入受控边界；仅给 render 返回的 DOM 外套一个 div/iframe 不能搬走创建它的 realm、闭包或先前 setup 的网络行为。

### Gaps

- 当前 page 不声明标题栏 entry 关联、外部 origin 集合、网络能力或 mobile 可用性。可按 page 注册直接做卡片；“所有 Titlebar 都必须能打开视图”无法由现有 schema 推导。
- iPad 不是 `MobilePhoneShell` 的同一布局分支：MobileApp 单独保留 iPad chat。手机 Projects 市场路径可以精确落地，但 iPad 的 placement 还需实施时核对，不应把 `isMobile`/`narrow` 与所有 mobile native 形态等同。[MobileApp:2652-2654](../../packages/ui/src/apps/MobileApp.tsx#L2652)
- `lib/gui-plugins/DOCUMENTATION.md:249` 仍声称 LoadErrors toast，与当前 Provider 和 UI 文档的静默加载不一致；以代码和本次目标为准，修改时顺带修正这处过时描述，不复活全局 loading/error 弹层。[过时段](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L249)、[当前 UI 契约](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md#L85)

## 2. 现有 Relay、Host proxy、Electron/native 资源桥能复用到什么程度？

### Takeaway

现有加密 Relay 已经能承载 HTTP body stream、SSE 和双向 WS，通常无需修改 relay-server 或 wire codec。缺失的是浏览器请求捕获/虚拟 origin、Host 上真正访问外部目标的 egress API，以及按视图隔离的本地资源服务；已有 preview 网关是受限先例，不能直接当作完整网页代理。

### Cited Findings

#### 现有 transport 与认证

| 接缝 | 能力、限制与源码 |
|---|---|
| active tunnel | `runtime-tunnel.ts:24-46` 暴露当前隧道并复用相同 descriptor；`:62-65` 关闭/清空。不是任意外部网址代理。[源码](../../packages/ui/src/lib/relay/runtime-tunnel.ts#L24) |
| runtimeFetch | `runtime-fetch.ts:11-13` 只识别 `/api`、`/auth`、`/health`；`:341-347` 明确外部 URL走真实网络；`:492-545` 实际分流。给 `runtimeFetch('https://外部域名')` 不会通过 Host。[源码](../../packages/ui/src/lib/runtime-fetch.ts#L341) |
| 旧全局 fetch bridge | `runtime-fetch.ts:576-647` 已有全局 window.fetch bridge，但它也只处理 runtime URL；不会拦 `<iframe src>`、`<script src>`、CSS 或其他文档。不能扩大它成全局外部网络 monkeypatch。[源码](../../packages/ui/src/lib/runtime-fetch.ts#L576) |
| runtime socket | `runtime-socket.ts:14-19` 根据 active tunnel 选 tunnel/open browser WS；`tunnel-payloads.ts:33-38` 丢弃绝对 URL 的 origin，只留 path+query。因此不能把外部 wss URL 直接塞给此函数期待 Host 连接该外部域名。[socket](../../packages/ui/src/lib/relay/runtime-socket.ts#L14)、[path](../../packages/ui/src/lib/relay/tunnel-payloads.ts#L33) |
| wire 已有能力 | `protocol.ts:37-49` 有 HttpRequest/Body/Response、StreamEnd/Abort、WsOpen/Opened/Text/Binary/Close；`:59-88` HTTP head 是 method/path/query/headers，WS head 支持 protocols/headers，没有外部 target/TCP frame。[源码](../../packages/ui/src/lib/relay/protocol.ts#L37) |
| body 格式 | `tunnel-payloads.ts:79-143` 支持字符串/bytes/ReadableStream，FormData/Blob 借 Response 序列化（目前整包 arrayBuffer）。原始 API 上传可以沿用通道，捕获层必须真的提供 body。[源码](../../packages/ui/src/lib/relay/tunnel-payloads.ts#L79) |
| client stream 生命周期 | `tunnel-client.ts:693-848` 通过 StreamAbort 传取消，Response body 流式 enqueue；请求体切块。`:780-786` 直接 enqueue，未用 desiredSize/pull 向 Host 做消费级流控，不能声称大网页多资源具备全链路有界内存。[源码](../../packages/ui/src/lib/relay/tunnel-client.ts#L693) |
| Host HTTP allowlist | `tunnel-host.js:24-29` `/api/*` 通用允许，新普通 HTTP egress 放 `/api/...` 不需改此 allowlist。[源码](../../packages/web/server/lib/relay/tunnel-host.js#L24) |
| Host WS allowlist | `tunnel-host.js:31-57` app sockets exact match，preview proxy 特例 prefix。新专用 WS egress 需加精确路径；还需同步 `ui-auth.js:316-324` URL-token WS 路径。[tunnel](../../packages/web/server/lib/relay/tunnel-host.js#L31)、[auth](../../packages/web/server/lib/ui-auth/ui-auth.js#L316) |
| Host 始终先本机服务 | `tunnel-host.js:239-248` 只 fetch `127.0.0.1:getLocalPort()`；`:190-200` 转请求 header、加 relay-connection 标记；`:257-261` 用单值 record 回传 headers，剥去 length/encoding。外部目标必须由独立 owning Host API 执行，而不是把 tunnel dispatcher 改成任意拨号器。[源码](../../packages/web/server/lib/relay/tunnel-host.js#L190) |
| redirect 重要陷阱 | Host loopback fetch `:242-248` 没设 `redirect:'manual'`；client tunnel normalization 不传 redirect mode，wire head 也无此字段。renderer 设置 manual 不等于 Host 保留上游 3xx！完整网页代理必须自行封装原始 status/location 或有针对性处理，不能盲信现有 preview client 的 manual。[Host](../../packages/web/server/lib/relay/tunnel-host.js#L242)、[normalizer](../../packages/ui/src/lib/relay/tunnel-payloads.ts#L127) |
| API auth | `core-routes.js:651-679` 选择 tunnel/UI auth；preview 带自己的 capability token 时先放至 preview 的更严格 target/TTL 检查。这个特例不能直接挪给通用外部代理。[源码](../../packages/web/server/lib/opencode/core-routes.js#L651) |
| relay 与直连切换 | `runtime-switch.ts:175-235` 在切直连时关闭 active relay；mobile saved connection 有 ordered direct/relay candidates，默认优先 LAN。**仅调用 runtimeFetch 无法保证“即使 LAN 可用也必须经 Relay”。**[switch](../../packages/ui/src/lib/runtime-switch.ts#L175)、[候选元数据](../../packages/ui/src/apps/mobileConnections.ts#L79) |

#### Host preview：可借鉴 target lease，不能拿来兜所有网站

- 唯一 owning 实现 `packages/web/server/lib/preview/proxy-runtime.js`，由 `server/index.js:1953-1959` 挂载；`POST /api/preview/targets` 创建 id/token/TTL，`/api/preview/proxy/<id>` 验证 target 和 token。适合借鉴有界 target capability 概念。[挂载](../../packages/web/server/index.js#L1953)、[lease:1215-1253](../../packages/web/server/lib/preview/proxy-runtime.js#L1215)、[routes:1351-1395](../../packages/web/server/lib/preview/proxy-runtime.js#L1351)
- 已支持 `allowExternal:true`，但是 `normalizeProxyTargetUrl:983-1016` 只保留 origin；`:946-952` 明确指出仅阻止 IP literal，未做 DNS 解析 pinning。不能把这个函数视为完整 Host egress 目的地策略。[源码](../../packages/web/server/lib/preview/proxy-runtime.js#L946)
- `rewritePreviewBody:1040-1127` 只改 root-relative、同 target/同端口 loopback、少量 HTML/CSS/module 文本；其他外部资源 URL原样返回（`:1064-1072`）。外部 CDN、嵌套 iframe、运行时动态 URL 没有完整覆盖。[源码](../../packages/web/server/lib/preview/proxy-runtime.js#L1040)
- `rewritePreviewRedirectLocation:1169-1183` 主要改同端口 loopback，跨外部 origin location 原样保留；不会自动建立第二个 origin target。[源码](../../packages/web/server/lib/preview/proxy-runtime.js#L1169)
- proxy upstream 请求删除 cookie、authorization、x-yuri-ui-session（`:1445-1451`），响应通过 `responseInterceptor` 收完整 responseBuffer（`:1453-1515`）。它保护 Yuri 凭据，但无法透明保存插件网站 Authorization/cookie 或 SSE 的按事件 flush 语义。[源码](../../packages/web/server/lib/preview/proxy-runtime.js#L1445)

#### Electron 网关：传输桥先例，而非 mobile 已有实现

- `preview-loopback-gateway.mjs:56-79` 只允许 GET/HEAD 和 `/api/preview/proxy/`；`:164-168` request payload 仅 id/method/path，没有 body 或浏览器 request headers。POST/PUT/PATCH API、表单与上传不能直接经过它。[源码](../../packages/electron/preview-loopback-gateway.mjs#L56)
- `:609-624` 绑定 IPv4 loopback ephemeral port；`:703-735` await response drain；`:357-444` WS upgrade 和 owner 转发；`:631-663` stop/owner gone 取消全部在途流。适合借鉴本地 bridge 的 streaming/cancel/ownership。[源码](../../packages/electron/preview-loopback-gateway.mjs#L609)
- `relay-preview-gateway-client.ts:231-338` renderer 调 runtimeFetch 后逐块 IPC push；`:351-424` mint URL token 后 openRuntimeWebSocket；main 没有 Relay keys。`:85-88` 和 gateway `:34-50` 丢 Set-Cookie/length/encoding。[UI bridge](../../packages/ui/src/lib/preview/relay-preview-gateway-client.ts#L231)、[header](../../packages/electron/preview-loopback-gateway.mjs#L34)
- 此 UI client 通过 `window.__YURI_DESKTOP__.previewGateway` 探测（`:53-79`），mobile 无该实现；其 map/ensure/listener 是模块 singleton（`:171-180`），没有按 view/plugin/revision 的 lease；cleanup 只见 reset test helper 和 detach，不可直接复用成新生产 view 生命周期。[源码](../../packages/ui/src/lib/preview/relay-preview-gateway-client.ts#L53)、[singleton](../../packages/ui/src/lib/preview/relay-preview-gateway-client.ts#L171)、[末尾](../../packages/ui/src/lib/preview/relay-preview-gateway-client.ts#L599)
- main 同时只有一个 preview owner（`main.mjs:1324-1397`）；IPC 检查本地 app sender/owner（`:5821-5848`）。新移动能力不应导入 Electron main，也不应恢复插件 native main 权限。[owner](../../packages/electron/main.mjs#L1324)、[IPC](../../packages/electron/main.mjs#L5821)

#### Native opaque image/video：限制和可借鉴点

| 资源桥 | 精确边界 |
|---|---|
| TS image contract | `mobile/src/yuri-virtual-asset.ts:61-70` 只有 create/append/finish/cancel；`:84-95` 仅 image MIME；URL 是 opaque id，没有 remote request 查询协议。不能只把 MIME 改 text/html 就成为网页代理。[源码](../../packages/mobile/src/yuri-virtual-asset.ts#L61) |
| iOS image | `YuriVirtualAssetHandler.swift:12-29` 只从已创建 assetId beginRead，`:37-52` 固定资源 headers，`:53-90` 逐块读和 stop；没有外部 URL、HTTP method、request body、redirect、cookie 或 WS 语义。[源码](../../packages/mobile/ios/App/App/YuriVirtualAssetHandler.swift#L12) |
| image 资源限制 | iOS store `:10-19` 为 120s TTL、16 并发、32MiB/asset、4MiB unread queue、image-only；native image URL 一次读。多个脚本/图片反复读和文档相对路径均非此契约。[源码](../../packages/mobile/ios/App/App/YuriVirtualAssetStore.swift#L10)、[契约](../../packages/mobile/src/yuri-virtual-asset.ts#L27) |
| Android image | `YuriVirtualAssetPlugin.java:34-45` 安装 BridgeWebViewClient subclass；`:147-156` 只拦 yuri-asset，其余交 super。新增 WebViewClient 时须合并这个既有 adapter，不能覆盖后让现有图片失效。[源码](../../packages/mobile/android/app/src/main/java/com/yuri/app/YuriVirtualAssetPlugin.java#L34) |
| iOS registration | `YuriBridgeViewController.swift:142-146` 在创建 WKWebView 配置时注册 custom scheme；`:180-189` 注册 native plugins。当前 native schema 是应用文档之外的图片能力。[源码](../../packages/mobile/ios/App/App/YuriBridgeViewController.swift#L142) |
| Android registration | `MainActivity.java:25-38` 在 super.onCreate 前 registerPlugin。[源码](../../packages/mobile/android/app/src/main/java/com/yuri/app/MainActivity.java#L25) |
| iOS 已有 HTTP listener | **`YuriVideoServer.swift` 比 image 更接近所需承载**：`:21-45` 用 NWListener 绑定 loopback；`:78-95` 只允许一个 opaque asset GET/HEAD/Range；`:106-133` 最多 1MiB response，并 connection-close；`:143-149` stop 所有流。可借原生 loopback/lifecycle，不可声称它已支持网页请求/WS/keepalive。[源码](../../packages/mobile/ios/App/App/YuriVideoServer.swift#L21) |
| iOS video UI/native 责任 | `YuriVideoPlugin.swift:16-43` 最多 2 leases、request event；`:46-69` 根据 requestId 回 bytes/release。native 不拿 Host path/Relay creds 的模式可沿用。[源码](../../packages/mobile/ios/App/App/YuriVideoPlugin.swift#L16) |

#### Service Worker 机会与明确边界

- 现有 web SW 仅 install/activate/push/notificationclick，**没有 fetch handler**；Vite 用 injectManifest 单独构建。可以增加专门的 scoped view SW，但不是“仓库已经有全网代理 SW”。[sw.ts:29-72](../../packages/web/src/sw.ts#L29)、[vite:129-147](../../packages/web/vite.config.ts#L129)
- `web/src/main.tsx:45-55` 只允许 secure HTTP(S) 注册；`:98-102` dev 会注销已有 SW。独立 `mobile-main.tsx:1-17` 没有调用这套注册函数。新 frame worker 的生产/开发注册入口要显式拥有，不能指望 PWA 主入口自动覆盖 native mobile。[main](../../packages/web/src/main.tsx#L45)、[mobile-main](../../packages/web/src/mobile-main.tsx#L1)
- 当前 Capacitor Android scheme=https；iOS 未覆盖，遵循默认 capacitor。官方说明 iOS iosScheme 不能配置为 WebKit 自己处理的 http/https，不能靠改一行 config 把 WKURLSchemeHandler 变成 HTTPS 拦截器。[本地 config:20-29](../../packages/mobile/capacitor.config.ts#L20)、[官方 Capacitor config](https://github.com/ionic-team/capacitor/blob/main/cli/src/declarations.ts)
- MDN 指出 SW scriptURL/scope 只能 HTTP(S)、same origin/trustworthy；fetch handler 可拦受控文档引用的跨域资源，例如外部 image。这为 hosted HTTPS/本地 loopback runtime 提供入口，但不能让本地 SW 控制另一个外部 origin 的 iframe 文档。[SW 注册](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register)、[受控资源](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers#custom_responses_to_requests)
- CapacitorHttp 的官方开关是 patch fetch/XHR，且直接使用设备 native HTTP；即使打开也既不自动覆盖 DOM 子资源，也不等于流量经 Relay。[官方实现与说明](https://github.com/ionic-team/capacitor/blob/main/core/http.md)、[native bridge](https://github.com/ionic-team/capacitor/blob/main/core/native-bridge.ts)

### Inferences

1. **不需要新 Relay 服务**。保留 v1 crypto、framing、现有单条连接的 multiplexing。在 Host 新增专用 authenticated egress owner，再让 client 把目标请求发到这个 `/api/...`；由 Host 访问目标。外部 URL绝不能被误当作 runtimeFetch 的“外部直接 fetch”分支。
2. 上游站点 headers/auth 与 Yuri 本身 auth 必须分层：外层 Yuri bearer 只授权 egress；内层才是目标 URL/method/headers/body/cookie。不能把当前 runtime Authorization 自动转发给网站，也不能像 preview 那样无条件删掉网站自己的 Authorization 后声称完整兼容。
3. 最省 codec 修改的 HTTP adapter 是原始 upstream status/多值 headers 作为 egress response metadata，外层保持不触发 loopback fetch redirect 的正常响应；正文仍逐块输送。必要的 header envelope/framed response 归 GUI egress contract，不改通用 tunnel schema。Cookie 应由 scoped upstream session/jar 或虚拟浏览器拥有，不能依赖 Fetch Response 的 Set-Cookie 被浏览器自动应用。
4. WS 使用新的精确 owning endpoint（示例 `/api/gui-views/ws`），同步两处 allowlist 和 auth；不得借 preview prefix 给任意目标“蹭权限”。可沿用现有 WsText/WsBinary/Close，不改 Relay infrastructure。
5. 新 view transport 必须持有明确的 `runtimeKey + transport identity/generation + pluginId + revision + viewId`，captured abort signal 和在途集合。close/reload/uninstall/switch 统一 abort HTTP、close WS、关 MessagePort、撤销本地资源和 Host lease，迟到 response 不得被新的 requestId 接收。
6. 仅 SW 不是完整方案：外部文档需要先被映射到受控本地 origin，且 WebSocket 等非普通 Fetch 通路要由 frame-local 浏览器适配层/原生代理拥有。用严格出网限制验证遗漏时失败关闭，不能让未重写资源偷偷设备直连。自建几个正则/MutationObserver 不能达到这一覆盖。

### Gaps

- 尚未运行 iOS WKWebView 的 loopback SW probe：localhost 是注册的必要条件之一，不等于当前最低 iOS、app-bound-domain 配置、iframe 场景和多 origin 都已验证支持。
- 尚未验证 Android request interception 能力对 POST body、worker、重定向、WS 的完整覆盖；当前本地代码只证明 opaque image GET。不能据它声称 `shouldInterceptRequest` 一处就能透明代理所有网页流量。
- 现有 Relay 没有 raw TCP/CONNECT 专用 API。若平台研究选择 native per-WebView HTTP CONNECT/SOCKS 代理，仍需 Host owning TCP-over-existing-WS endpoint 和 native loopback proxy；不能当作零后端工作。浏览器 hosted mobile 无平台 proxy 配置能力，须另有明确行为。
- “强制 Relay”与当前 LAN-first 流程不相同。已有 saved Relay candidate 可用于视图专属、引用计数的现有 client lease；若无有效 Relay candidate/Host egress 能力，应明确不可用，不能默认改成设备直连。是否复用 active tunnel、或 direct runtime 下 acquire 同实现的 scoped tunnel，需要 runtime owner 实现决定；不要由组件全局切换实例。

## 3. 最少 owning 改动、推荐完整路线与验证/原生构建要求是什么？

### Takeaway

最低返工成本的完整架构是：保留现有插件 discovery/生命周期与 Relay，把“本地受控插件视图运行环境”和“Host egress”作为两个新 owner；手机列表、详情和返回仍用现有 mobile shell。对跨 native/hosted 的统一实现，优先评估成熟的 frame-scoped 网页虚拟化/重写引擎加自定义现有 Relay adapter；纯原生透明代理可以作为平台研究的替代执行方式，但当前代码本身无法证明哪一种已经全兼容。

### Cited Findings

#### 最小 owning 变更清单（建议落点；新文件名称为示意）

| owner | 必要变更 | 依据 |
|---|---|---|
| mobile Projects UI | 新增 leaf 市场入口（仅真实可打开 page 非空），icon grid 和 full-height 详情；迁移现有公共 header 的散列 Titlebar 按钮，保留正常图标 alias/aria/busy 语义 | [Projects:549](../../packages/ui/src/mobile/projects/MobileProjectsHome.tsx#L549)、[公共 header:106](../../packages/ui/src/mobile/MobileTabPageHeader.tsx#L106)、[icons:8](../../packages/ui/src/components/gui-plugins/GuiPluginTitlebarItems.tsx#L8) |
| mobile navigation | `mobileNavigation.ts` 增市场/页面选择，`useMobileNavigationStore.ts` 增 open/back actions，`MobilePhoneShell.tsx` 生成 depth 1/2 pages | [模型:21](../../packages/ui/src/mobile/mobileNavigation.ts#L21)、[projection:253](../../packages/ui/src/mobile/MobilePhoneShell.tsx#L253) |
| GUI host/provider | page capability/open/current 改为承载注入；ready 前不暴露可执行网络视图；realm/transport lease 与 host/revision 生命周期绑定 | [Provider:192](../../packages/ui/src/lib/gui-plugins/GuiPluginsProvider.tsx#L192)、[host:322](../../packages/ui/src/lib/gui-plugins/host.ts#L322)、[mount:676](../../packages/ui/src/lib/gui-plugins/host.ts#L676) |
| GUI execution boundary | 若采用受控 iframe：新增本地 runtime bootstrap，复用同份 host/bundle/SDK/Solid；parent 只收序列化快照和动作，不传 render closure/DOM；`react.ts` 从具体 class 收窄接口 | [bundle:16-31、49-58](../../packages/ui/src/lib/gui-plugins/bundle.ts#L16)、[context 类型](../../packages/ui/src/lib/gui-plugins/react.ts#L10) |
| UI transport owner | 新 `lib/gui-plugins/...transport` 捕获上述 lease，承接 worker/本地网关 HTTP+WS，转现有 authenticated runtime/tunnel；无 module-global 外部 URL fetch patch | [现有 relay adapter](../../packages/ui/src/lib/preview/relay-preview-gateway-client.ts#L231)、[identity](../../packages/ui/src/lib/runtime-switch.ts#L145) |
| Host web domain | 新 `server/lib/gui-views/`（名称建议），负责 egress session/目标策略/上游 HTTP和WS/取消/cookie隔离/限额；index 或 runtime wiring 仅注册 | [preview owning 先例](../../packages/web/server/lib/preview/proxy-runtime.js#L1186)、[Host 注册先例](../../packages/web/server/index.js#L1953) |
| Host auth / transport gate | HTTP 使用现有 `/api` auth；WS 新精确 endpoint 同步 tunnel-host 和 ui-auth，避免修改 relay-server/core/crypto | [HTTP allowlist](../../packages/web/server/lib/relay/tunnel-host.js#L24)、[WS](../../packages/web/server/lib/ui-auth/ui-auth.js#L316) |
| local native resource owner | iOS/Android 新独立网页网关/视图 bridge，不扩坏 image-only MIME/one-shot contract。沿用 opaque lease+bytes、request cancellation；loopback 实现优先复用 video/desktop 的设计而非 Node 代码 | [iOS HTTP listener](../../packages/mobile/ios/App/App/YuriVideoServer.swift#L21)、[image contract](../../packages/mobile/contracts/yuri-virtual-asset.mjs#L1) |
| build/assets | 本地 runtime bootstrap/worker/引擎资产进入 web Vite build；mobile 已全量复制 web dist 后把 mobile.html 写成 index。不要第二次复制整套 UI | [vite inputs](../../packages/web/vite.config.ts#L210)、[prepare assets:34-37、61-64](../../packages/mobile/scripts/prepare-web-assets.mjs#L34) |
| docs/contracts | 更新 GUI lib/UI 文档的“mobile inactive”与网络责任段，mobile README、Host owner DOCUMENTATION、新 native contract registry和 shellApi 版本 | [原边界](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L66)、[native registry](../../packages/mobile/contracts/index.mjs#L12)、[shellApi 注释](../../packages/mobile/capacitor.config.ts#L31) |

#### 原生构建现状与命令

- 当前 mobile 依赖 `@capacitor/core/android/ios/cli ^8.4.1`、Capgo `^8.51.14`；UI 自己也依赖 Capacitor core，因此依赖升级需核对两个 package 及 lockfile，不能只改 mobile 造成 bridge ABI 分叉。[mobile package:37-53](../../packages/mobile/package.json#L37)、[ui package:17-23](../../packages/ui/package.json#L17)
- 当前 iOS deployment floor 15.5；Android minSdk=24、compileSdk=36、targetSdk=35、androidxWebkit=1.12.1。若用更高平台 proxy API，需要能力探测和已安装 shell 行为，不能把 native package upgrade 等同于 OS API 可用。[Podfile:3、28-35](../../packages/mobile/ios/App/Podfile#L3)、[Android variables](../../packages/mobile/android/variables.gradle#L2)
- 当前 `shellApiVersion=3`；config 明确自定义 plugin method surface 变化需 bump，与 `src/yuri-ota.ts` 同步，OTA manifest 用 minShellApiVersion，旧壳安装原生版。[config:3-4、31-38](../../packages/mobile/capacitor.config.ts#L31)
- `mobile/contracts/index.mjs` 枚举 custom bridge；新 bridge 必须加 declarative methods/events/sources。`scripts/mobile-release-plan.mjs:199-230` 对 Swift/Java surface 做核对，`:278-302` 按 native paths/contract 判 native mode。该脚本内部执行 git，**本次禁 git 因而没有运行，也不应把它列为当前可直接执行的无 git 检查**。[contracts](../../packages/mobile/contracts/index.mjs#L12)、[plan](../../scripts/mobile-release-plan.mjs#L199)
- `bun run mobile:build` → mobile build → web build+prepare；`bun run mobile:sync` → build+cap sync；`bun run mobile:build:android:debug` → sync+Gradle assembleDebug；`bun run mobile:build:ios:simulator` → 专用 simulator script。[根 scripts:65-70](../../package.json#L65)、[mobile scripts:8-19](../../packages/mobile/package.json#L8)
- iOS simulator build 特别处理 MLKit：临时从 Podfile 去 scanner、pod install、构建 arm64 simulator，finally 恢复 Podfile+Pods；它使用 cap copy 而不是 cap sync。增加 native dependency 后需要先做正式 sync，不应以 simulator script 替代依赖集成。[脚本:31-65](../../packages/mobile/scripts/ios-sim-build.mjs#L31)
- 环境 wrapper 尊重 `DEVELOPER_DIR` / xcode-select，设 JDK21/Android SDK；真实设备构建有 `build:ios:device`。研究阶段没有调用这些会改生成物的命令。[wrapper:14-36](../../packages/mobile/scripts/with-mobile-env.mjs#L14)、[mobile scripts:18-23](../../packages/mobile/package.json#L18)

#### 已有测试路径与应补的有效场景

| 层 | 现有精确入口 | 本次实现应验证的增量 |
|---|---|---|
| host/page/context | `packages/ui/src/lib/gui-plugins/host.test.ts`、`react.test.tsx` | mobile capability；无 session page；当前页面同步；revision 替换/卸载；快照可序列化与 owner 清理 |
| React/Solid UI | `packages/ui/src/components/gui-plugins/GuiPluginIntegration.test.tsx`、`GuiPluginLazyLoading.test.tsx`、`GuiPluginHost.perf-evidence.test.tsx` | 空列表无入口、首个 ready 即出现；不等全部插件；grid→page→grid→Projects；无重复 setup/重挂；不挡首屏 |
| 手机导航 | `packages/ui/src/mobile/useMobileNavigationStore.test.ts`、`mobileBackNavigation.test.ts`、`MobilePhoneShell.assistant-settings.test.tsx` | 新 depth 1/2 返回、native/H5 back、inert predecessor、焦点恢复、切 runtime 清选中 |
| Projects | `packages/ui/src/mobile/projects/MobileProjectsHome.test.tsx`、`MobileProjectsHome.menu.test.tsx`、`MobileProjectsHomeContainer.test.ts` | 唯一顶部入口，0/1/N/停用/failed/动态卸载，原加号菜单正常 |
| Relay | `packages/ui/src/lib/relay/tunnel-client.test.ts`、`tunnel-codec.test.ts`；`packages/web/server/lib/relay/tunnel-host.test.js`、`cross-compat.test.js`、`relay-server.e2e.test.ts` | 新 egress through real dispatcher、HTTP/WS/body cancel、multipart、binary、禁止未知 path、旧 peers兼容 |
| Host auth | `packages/web/server/lib/ui-auth/ui-auth.test.js`、`lib/opencode/core-routes.test.js` | URL-token exact WS、过期/撤销 view lease、外层 bearer 不泄漏到外部、跨 Host 隔离 |
| 现有网关先例 | `packages/electron/preview-loopback-gateway.test.mjs`、`packages/ui/src/lib/preview/relay-preview-frame-src.test.ts`、`packages/web/server/lib/preview/proxy-runtime.test.js` | 保持原 preview 行为；新网页 bridge单独测 methods/body/stream/WS，不把旧受限测试当全网覆盖 |
| native bridge | `packages/mobile/test/virtual-asset-bridge-contract.test.mjs`、`virtual-asset-store-behavior.test.mjs`、`video-server.test.mjs` | 保持原 image/video；新网页 bridge native生产代码的并发/取消/超限/ownership/HTTP动态资源测试 |

上述测试家族由模块文档和 Vitest projects 配置定位；本次只定位，未运行。[GUI 验证清单](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L291)、[导航测试](../../packages/ui/src/mobile/mobileBackNavigation.test.ts)、[gateway 测试](../../packages/electron/preview-loopback-gateway.test.mjs)、[native 测试](../../packages/mobile/test/virtual-asset-bridge-contract.test.mjs)、[workspace runner](../../vitest.config.ts#L3)

可以据实现范围选择的无 git 检查命令（**以下均未执行**）：

```sh
bun run type-check:ui
bun run type-check:mobile
bunx vitest run --project @yuriai/ui packages/ui/src/lib/gui-plugins/host.test.ts packages/ui/src/lib/gui-plugins/react.test.tsx
bunx vitest run --project @yuriai/ui packages/ui/src/components/gui-plugins/GuiPluginIntegration.test.tsx packages/ui/src/mobile/useMobileNavigationStore.test.ts packages/ui/src/mobile/mobileBackNavigation.test.ts
bunx vitest run --project @yuriai/web packages/web/server/lib/relay/tunnel-host.test.js packages/web/server/lib/relay/cross-compat.test.js
bunx vitest run --project @yuriai/mobile packages/mobile/test/virtual-asset-bridge-contract.test.mjs packages/mobile/test/virtual-asset-store-behavior.test.mjs packages/mobile/test/video-server.test.mjs
bun run dead-code
bun run mobile:build
bun run mobile:build:android:debug
bun run mobile:build:ios:simulator
```

命令源：根 `package.json:34-38,47-49,65-70,85` 与各 package test/build scripts。需要 SQLite 的 web 测试先确保 Node24 ABI；通用 `test:vitest` script已有 ensure hook。[根命令](../../package.json#L34)、[mobile runner](../../packages/mobile/vitest.config.ts#L5)

### Inferences

#### 推荐实施顺序及完整数据路径

1. **先做能力探针，再承诺引擎选择**：在真实 iOS/Android 壳测试“本地受控文档 → 外部 iframe → 脚本/图片 → POST API → WS/SSE”的全链路。限定只允许设备连接现有 Relay 和本地资源 origin，外部测试服务仅 Host 可达。此验证直接证明是 Host 出网、本地渲染，而非“看起来打开了页面”。
2. **推荐跨端主线**：本地独立受控 frame/runtime + 成熟网页重写/虚拟浏览器依赖 + scoped worker/network adapter → 原有 Relay HTTP/WS → 新 Host egress → 外部网站。保留 CSS/JS/DOM 渲染在手机。native 只提供受控本地 origin/opaque bytes 的薄能力；hosted HTTPS使用专属 scope；不新增 Relay infrastructure，不改 Yuri 主 window.fetch/XHR/WebSocket/DOM prototypes。
3. **依赖需由平台研究核实后选定**：本地仓库没有这种引擎，不能以现有 preview 正则替代。选择必须覆盖嵌套 iframe、动态 import、CSS imports/fonts、fetch/XHR/form upload、redirect、worker、WS/SSE及 cookie/origin；不支持的通道应明确失败且不得直连。如果成熟引擎依赖新增另一种 relay server，只实现它的 transport adapter 对接 Yuri，不能因此部署第二 Relay。
4. **GUI realm 是独立的真实工作项**：标准插件返回 `render()` closures，无法在 parent setup 后只把 callback 跨 realm 发过去。复用相同 host实现，但受控 runtime 内 setup一次并拥有实例；parent拿 entry快照并下发 action。避免 parent+frame各跑一次 setup 导致双监听、双RPC、双 Style 和双配置状态。所有要求全 Relay 的 page/panel/settings必须走同样的受控边界，否则仍有旁路。
5. **transport 封装要 fail-closed**：视图开前 acquire 对应 Host/Relay 和 egress lease；请求不允许 runtimeFetch 外部直连 fallback；切 runtime/generation立即拒绝新请求并撤销旧 lease；保留 shell其他网络行为。原生接口只传必要本地请求metadata/bytes，不放入配对 secret/Relay key。
6. **不是一次小 UI patch**：市场+手机页面只需少量现有 owner 编辑；完整任意网页网络需要上述 runtime、egress和native origin三个边界。没有证据支持“直接复用 Electron gateway/放宽image MIME即可完成”的低估。

#### 必须以集成测试证明的完成标准

- 页面嵌套跨域 iframe、脚本、CSS、字体、图片、动态请求全部在 Host 留可核验的非敏感计数；设备抓包无对外部源连接。渲染节点和交互在手机 WebView，而非远程截图/桌面串流。
- 验证 GET/HEAD/POST/PUT/PATCH/DELETE、JSON/表单/multipart/二进制 body、302/307跨 origin、404/500、Range、gzip解码后headers、SSE首事件时效和WS二进制/关闭/重连。
- 同时打开/连续切换视图、关页面、停插件、换 revision、同机 LAN↔Relay、A→B→A、断网/后台/恢复；无迟到响应跨视图、泄漏listener/port、残留native server或自动回落直连。
- 出网策略不是随便抹 CSP/CORS/X-Frame-Options。引擎应有明确虚拟 origin、cookie和credential语义；透明度不够时有确定失败，而不是损坏鉴权或假装成功。

### Gaps

- **尚无已验证的“最便宜完整实现”**：本次确认的是本地最少所有权边界；成熟引擎兼容矩阵、native per-WebView proxy最低OS和真实SW支持需与平台调研合并后定案。不可把上面的架构推荐写成已完成能力。
- 现有 plugin app API 没有 view网络会话 contract。跨realm RPC、主题CSS变量同步、session/files/client、options内存注入、导出动作的bridge如何最小化，需要实现前形成窄内部协议；不能让options/AK进URL或持久缓存。
- 现有通道下行 response只enqueue，上传部分类型全buffer，大页并发可能积压；需要 bounded adapter 和压力证据，不应泛化出“复用 streaming所以内存已安全”。
- 尚未执行任何上述测试/构建，也未证明签名安装包、真实Relay WAN、iOS/Android设备或hosted browser效果。上述结论是代码和文档证据，不是运行验收。
