# NSH GUI plugin content：prepared 合同与未完成项

资源 resolver、设备 system/toast、真实 iOS ViewExport renderer 接线与字体/图标 staging 已在后续轮次继续实现，最新完成清单、main seams、编译 harness 修复和具体 core gaps 见 [GUI-CAPABILITIES-HANDOFF.md](./GUI-CAPABILITIES-HANDOFF.md)。main 已回传入口版本的实际 NSH check、完整 iOS build/签名及 browser typecheck 成功；新能力仍需按 handoff 编入 renderer 后重建，不能用旧包代替。以下分阶段 prepared 记录不能覆盖最新状态，也不表示完整 1:1 已验收。

## 真实文件入口：最新实现与验证

NSH browser factory 使用已安装 `@yuriai/opencode-gui-client/dist/promise` 的 generated Promise client；其运行时直接返回响应 JSON。NSH 两条读取合同分别为 `plugin.list` 的原始 inventory 数组、`plugin.gui` 的 `{code,revision,options}`，不含 `.data` envelope。已安装 generated 声明仍将这两项写成 Location/data 包装，因此局部边界显式接收 unknown：inventory 经 `readGuiPluginInventory` 严格校验，bundle 明确校验 code/revision 字符串和 options JSON object，不采用 raw/data 自动猜测。坏结构或真实请求异常保持 failed，合法空数组经真实 registry 得到 unmatched。真实 emitted GUI bundle 回归使用相同 raw HTTP 响应，覆盖非空插件安装/渲染、options、RPC、Storage、权限与清理，以及 malformed/throw 的失败分支。独立资源页构建每次在新目录生成 adapter，并以实际 bundle 的 empty-inventory → unmatched 合同放行；这不替代真实 UIKit/WK 验收。此前 ef12 设备 GUI failed 的 audit 与新门槛证据见 `tests/resource-page-uikit/README.md`。

`resources.tsx` 已接 `bindNativeGuiPluginPreview` 和 `resources-gui.ts`，按任意文件调用实际 registry：`registerFileView → openLink({exact:true}) → filePanel`。移除 `.eficy` unavailable 特判；图片、PDF、HTML、源码仍由原资源 lane 读取。显式 targetLine 跳过自动 GUI，Markdown 内联图片用 `guiPreview={false}` 避免递归探测。页面只在准备、匹配或失败时提供原 Web 对应的源码/预览切换，没有新增插件专属动作。

application/main 由 main 所有，已回传可选 sessionId 装配与 12 项合同测试通过。资源入口只继承显式 source session，不猜首个或最近会话。TS/Swift 均允许缺省 sessionId，仍拒绝空串/null；无 session 时真实 Web provider 使用 `setSession(undefined)`，当前 host 不派生 session Panel，因此未匹配时回到原生预览，不造 ID。

Swift `GuiPluginPreviewMatch` 在离屏 WK prepare 后等待真实 `mounted` 才 present，`unmatched` 返回 `{closed:true,matched:false}`，未匹配不会先弹空白 modal。entry 对刷新期间的中间 `error/unmatched` 仅向 native 报 `loading`，刷新结算后如实报告终态；已有真实 mounted 可直接放行。`resources-gui` 同步捕获 frozen scope/context 后才等待关闭，memoize 每个 owner 的 close，并保留完整 retirement barrier；A→B→C、中间显式 close 或 context 捕获失败均不能绕过 A 的关闭。迟到结果只按自己的 ticket 清理。

当前 shared key 算法位于 import-free `packages/ui/src/lib/instanceScopedStorageKey.ts`，官方 preferences 与 native factory 共用既有算法；cssGenerator 只读轻量 registry，不再导入 desktop。共享纯化改动由其他 owner 写入，本文件入口工作未覆盖它们，也未为类型错修改 Relay。新增 native context/resource GUI 的实际 tsconfig 解析依赖图守卫，包括 type imports，拒绝 SDK、Query、browser host、Relay、desktop、runtime-switch、浏览器 instance storage 及未解析 alias。此前单独 factory 图分析为 all/value 76/63 modules、禁用项零命中；守卫不锁定模块数。

最新实跑：资源 helper/真实组件 callback/model **3 files / 32 tests**；实际 SDK browser/emitted artifact **2 files / 17 tests**；context/appearance **2 files / 45 tests**。两套 `resources-gui.tsconfig.json`、`gui-plugin-browser.tsconfig.json` 的 tsc 通过。新增三条关闭链测试和实际 emitted bundle 的“失败插件先返回、匹配插件延迟返回”测试均先红后绿。纯 context bundle 在不提供 Window、DOM、storage、fetch、crypto、EventTarget、AbortController 的 VM 中加载并捕获成功，替代此前依赖 WebCrypto 的旧图证据。

独立只读 reviewer `ses_e49b4153bffeAoLgEIke32dLMY` 最终静态关闭上述两条时序风险，限定范围内无新增 P1/P2/P3；reviewer 未跑测试。**实际 NSH check 仍须由 main 重跑并回传**，不能把独立 tsc 或图守卫当成实际检查通过。UIKit 离屏 WK prepare/呈现/关闭、真实 Host/插件、Eficy、真实字体与系统导出仍未验收；未运行 engine/device/main build、未访问真实 Host、未执行 Git 或依赖安装。本地没有可用 knip executable，因此未运行会尝试取得工具的 dead-code 脚本。

以下分阶段记录保留各自当时的验证范围；入口是否接线、当前图边界与最新测试结果以上述本节为准。

## 当前结论

这是现有手机 GUI 能力的迁移准备，不是安装插件，也**不是已完成的 1:1 兼容**。
独立 browser **可执行产物已构建**：实际 SDK、GuiPluginHost、FilesAPI、QueryClient、官方 storage/preferences、同 scope fetch/channel 和当前 themeCSS 已由真实 factory/entry 组装，生成 index/assets/带 hash 的 manifest，并用这份实际 bundle 执行 synthetic CJS。main 已将 staging 接入 build-ios；最新 GUI 源码仍由下一次主 build 刷新 staging，不将旧产物 hash 当作新补丁证据。生产 Runtime reader、真实 presentation context、完整 CSS 工厂及私有 storage/资产 helper 已实现；**main 已完成 native bridge/resources/install/lifecycle 的代码装配和 present/close capability 授权**。真实 TS 文件入口及实际插件、主题、exports 链路仍未验收。本 agent 未修改 main/nsh.json，未验证真实 Runtime 插件运行。全量 1:1 目标已恢复，没有暂停项。

main 最新回传的装配证据：ios/main.swift 已有 property、lazyGuiResources、精确 scope capture、readGui/openGui、install，以及 onInvalidate/background/shutdown/deinit 撤销；nsh.json 已授予 plugins.preview.present/close，并通过 JSON 唯一性核验。main 执行全 ios/*.swift 真实 SDK typecheck 通过、notification **3 files / 22 tests** 通过；独立 oracle `ses_e49abf1c3ffeuJw2ZaerOLtXMq` 静态 review 无 P1/P2 blocking，**未运行 runtime**；ios/README 已记录装配。本节结果来源为 main 回传，本 agent 本次只更新合同，不重跑这些检查，也不将其计入自己的 62 项 focused 测试。
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
| `gui-plugin-native-context.ts` | 六字段 presentation context、十语标签 key、UTF-8 大小/字段/注入校验与不可变快照；不把 browser runtime 带进 binder |
| `gui-plugin-native-context-factory.ts` | 使用真实 canonical appearance + CSSVariableGenerator + guiPreferencesKey；强制 context 的文件入口 owner 绑定器 |
| `appearance-core.ts` / `appearance.tsx` 只读投影 | 保留原始 light/dark Themes、完整字体栈和 sourceHost provenance；只读 full CSS 导出，不改 Host 写入/同步时序 |

原 `gui-plugin-browser` 生产图只有它自己、preview 与 framework-neutral `runtime-scope.ts`。新增 composition/transport/channel/exports 也不运行或导入 React、SDK、共享 desktop globals、runtime loader；exports 只复用 framework-neutral 的官方 owning `view-export/types`。
`gui-plugin-entry/factory` 是另一条明确的 **browser-only 构建图**，导入实际共享 SDK/host/QueryClient；它们不能被 App/QuickJS 导入。factory 的 QueryClient 复用真实 owning `queryRuntime` 单例，该独立 document 只有这一份 host；不是新的 Query shim。现有 `createWebFilesAPI` 硬绑定 Web `runtimeFetch/opencodeClient/runtime-file-resource`，没有 backend 注入入口，因此本地 adapter 按实际 owning route 实现 FilesAPI 的读取/列表/stat，并通过官方 GUI client 的 `file.find` 搜索。GUI Files 没有创建目录入口，required FilesAPI.createDirectory 明确 unsupported，不返回假成功。
Runtime 阶段仅在 RuntimeBridge 增加 GUI capture/read/open 与必要 registry/retirement hook；没有修改现有 terminal/ASR/strict stream/授权撤销实现或相关注释。后续 resources 入口实现与共享纯化边界见最新实现节；application/main/nsh.json 仍由 main 所有。

## 配置、资产与认证

1. 原生入口接收真实 `directory/path`、可选 `sessionId`、constructor 捕获的 `expectedHost:{hostID,lease}` 和每次打开独立的 `owner`。owner 只含字母/数字/`_-`、1–128 字符，同 lease 不得复用；不猜首项目、最近会话或后缀。路径仍由现有 host 决定。
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

1. **Runtime capture 已实现，main native 装配已接**：`runtime.guiPluginPreviewCapture(expectedHost:) throws -> GuiPluginRuntimeCapture` 同步 admit，返回 expectedHost/resource/isCurrent/readGui/openGui；resource 由同 expectedHost 的 resourceWebPreviewTransport 构造。各请求使用捕获的 connection/generation/lease、原 makeRequest/session/tunnel，await 前后检查 native admission。POST RPC 不新增自动重试；保留原资源 allowlist，不在 send 时读取最新 Host，不把凭据传回 TS。
2. **browser factory 已实现，无需 main 重写**：index 调用 `startGuiPluginPreview`，通过 `captureGuiPluginFactory` 构造实际 SDK/GuiPluginHost/QueryClient/FilesAPI/官方偏好与 native Storage。origin 使用当前 custom scheme owner，不是 Host URL；所有 HTTP 只走同 scope channel/fetch。main 只需填写原生 bootstrap 和存储 backend，不需要注入 fake client/files。
3. **browser ↔ Swift 已实现**：entry 绑定真实 WK main-frame reply port，使用 bootstrap 的原始 scope；changed 转发 state，teardown 清理 composition/channel。JS signal 发送精确 cancel ID；Swift 取消交 Runtime sender。Runtime pending open/read、主动 cancel 与 retire 的 direct/真实 mux loopback 已验证；WK/设备到真实 Host 的整链仍待验证。
4. **资产 staging**：运行下方离线命令后，将整个输出目录（index/assets/manifest）复制到 app 的 `gui-plugin-preview/`；用 `GuiPluginPreviewAssets(stagedDirectory:)` 创建快照，`readAsset` 返回 `assets.read(path,limit:)`。这是实际 host entry，不需要 main Web App。bootstrap.themeCSS 必须来自当前 Host 的真实完整 CSS；字体/图标/iframe assetresolver 仍需接线。
5. **Swift main 装配**：使用下方 `GuiPluginPreviewResources`，capture 只注入同一 Runtime IO。labels/bootstrap 初始为 nil，真实 context 经 production begin 验证后才填入，不能补假值。Host 切换/后台/shutdown 等 Native 全局生命周期调用 bridge.invalidate，并保留 Runtime 原撤销/onInvalidate；**单个 owner 的异步清理不得调用全局 invalidate，必须 exact owner close**。
6. **文件入口/API 变化**：优先使用下方 `bindNativeGuiPluginPreview(input)`；它要求真实 context 数据源。底层 `bindGuiPluginPreview(..., context?)`/`presentGuiPluginPreview(..., owner, context?)` 保留纯旧测试的无 context 形式，但**Swift production present 缺 context 必须拒绝**，不是兼容默认主题。close body 仍是 `{expectedHost, owner}`，Swift close 为 async 并等待 exact ticket retirement。本 agent 未改共享文件入口 owner。
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
| 认证 GUI GET | 生产 Runtime capture/read/open 已实现，direct/paired E2EE mux loopback 验证；main native bridge 已接，**真实 TS 入口与实际插件未验收** |
| 官方 GUI browser host bundle / registry | 实际 factory/entry/IIFE/index/manifest 已生成并验证；main 的 build-ios staging、native presentation capture/install 已接；最新源码仍需随主 build 刷新产物，真实 TS 文件路由仍待接/验收 |
| plugin context storage 持久化与偏好 authority | `GuiPluginPreviewResources` 管 native namespace/storage/真实 manifest reader；context 在 Swift 验证 exact identity/storage。main 已接 lazy resources、私有 storage 与 bridge；无 JS 路径输入，不自动存 options；设备持久化行为仍未实测 |
| file watch 的真实 2 秒刷新/缺失/恢复 | 已复用原 host 文件模型；仅 synthetic read/清理验证，尚无真实 transport 证据 |
| plugin iframe、外部依赖、localhost、Host assetresolver/Relay | **未完成**，当前 fail-closed；不据此删除任何手机能力 |
| 官方 SDK RPC / 其他写请求 | 实际 SDK RPC POST prepared；生产 Runtime direct/真实 mux 验证原始 body/header、422 和单次请求；main native 装配已接，实际插件 RPC 链路未测，其余请求仍明确 unsupported |
| system copy/save/openExternal、toast | **未完成**，现有 host 的客户端能力依赖浏览器/Capacitor，NSH 设备桥尚未接；不以浏览器 anchor 下载冒充已保存 |
| preview-actions / PDF / 长图 / snapshot | action 注册/清理/signal abort、真实 export capability adapter prepared；原生导出/系统保存/实际 iframe snapshot 未接线/未验收 |
| 主题/样式/font/icon 动态同步 | canonical Themes → 原 cssGenerator 的完整变量/slots/字体栈及 mobile typography、十语 labels、DOM mode/lang 已实现并测试；main 文件入口待接。真实字体文件交付、已打开 document 的连续主题/locale 更新、font/icon/iframe resolver 仍未验收，不能把初始快照称为动态同步完成 |
| GUI CJS 容量与 native reply | 生产 Runtime openGui direct/真实 mux 均完整读取 33.0625 MiB，返回 chunk ≤64 KiB；JS/Foundation 原有 529×64 KiB 回归保留。main 已接 readGui 与 openGui；仅提供旧 buffered readGui 的实现仍有 32 MiB 差异。SDK 最终 JSON/JS heap 与真实设备内存未验收 |
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
// main 可 lazy 构造，资产缺失/存储失败只阻止 GUI preview，不阻塞其他功能启动。
let resources = try GuiPluginPreviewResources(
    stagedDirectory: stagedURL, storageDirectory: appPrivateGUIURL
)
let bridge = GuiPluginPreviewBridge(controller: controller, capture: { expectedHost in
    let io = try runtime.guiPluginPreviewCapture(expectedHost: expectedHost)
    return try resources.capture(
        expectedHost: io.expectedHost,
        isCurrent: { expected in expected == io.expectedHost && io.isCurrent() },
        resource: io.resource, readGui: io.readGui, openGui: io.openGui
    )
})
bridge.install(on: app)
// main 需强持有 bridge/resources；后台/Host invalidation/shutdown 调 bridge.invalidate()。
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

该 Runtime 阶段没有重跑 browser/main build；后续 context 阶段的 browser 14 项实跑证据见后文。Runtime 独立 oracle `ses_e49d85323ffeZSSSx0tMl4aRrn` 发现下面 P1/P2 后，main 已回传原 P1/P2 静态 closed；不将该结论扩张为 early EOF/ticket 等未确认项或真实插件验收。

## Runtime 独立 oracle P1/P2 修复与复核

| 发现 | 实现与新增回归 |
| --- | --- |
| P1：GUI rendezvous 阻塞 RelayTunnel 唯一 receive，连 global/chat/WS/pong 都无法前进 | GUI reader 各自独立、同授权的 native-managed lane，上限八个；保持单 chunk 背压，取消/完成只关闭 exact lane。新增生产 RuntimeBridge + 真实 E2EE mux isolation executable：两个 GUI reader 各消费 1 byte 后停拉，另一个 GUI HTTP 仍能读取，原 shared tunnel 的 global/chat SSE、terminal echo、resource HTTP、freePort 与加密 ping/pong 连续前进；检查它们仍是同一个 shared lane、无 runtime.disconnected。实际运行超过原 30s+15s heartbeat 阈值，不改 Relay clock；每秒执行真实请求，没有长 sleep |
| P2：direct 一次 read 中 source.next 抛错丢掉已收集 20 KiB；Relay finish(error) 丢掉半个 frame 尾段 | direct owning reader 改为泛型 AsyncIterator，生产仍为原 URLSession.AsyncBytes.Iterator；synthetic iterator 精确产出 20 KiB 后抛错，断言先得到完整 ordered bytes，再得到 terminal error。上游错误恰为 CancellationError 也不能冒充 ownership 撤销。Relay 单 frame 先读 20 KiB，再 upstream fail，余下 bytes 精确读回，下一 read 才抛原 error；另测 explicit cancel 覆盖 terminal error 并立即丢弃未读尾段。原 Task cancel/retirement/unknown RPC 单次请求回归继续保留 |

修后最终实跑：上述 focused 命令 **4 files / 12 tests 全通过**（Runtime 文件新增 isolation 后为三项），旧 owner 原 harness 包装回归 **134/134 通过**，合计 **146 项**；编译包含生产源 Apple iOS SDK typecheck 与 macOS warnings-as-errors。47s isolation 真实运行跨过旧 heartbeat 阈值，没有修改 RelayTunnel 源码或注入替代时钟。测试服务器显式 idleTimeout=0，以便由 native 生命周期控制故意暂停的 source；stderr 仍要求为空，没有过滤 timeout warning。八 reader 预算用已完成网络响应、但未消费的八个 logical reader 验证，不把 URLSession 默认连接池容量误当作 GUI registry 容量。

中间一轮回归因本 agent 在 Swift 编译时编辑 source，被编译器拒绝，134 项没有执行；生产代码冻结后完整重跑通过。旧 145 项不是新 P1/P2 的通过证据，采用上面修后结果。main 已回传同一独立 oracle `ses_e49d85323ffeZSSSx0tMl4aRrn` 静态关闭原 Runtime P1/P2；仅记录这两项，不扩张其结论。

bootstrap/context 数据桥已按本会话明确指令恢复并完成 GUI owning 范围，实现及 main 合同见后文；它不是暂停项。main 正在持有主装配/设备/engine 与真实文件入口，本 agent 不占用这些文件或环境。当前 context 阶段没有修改 RuntimeBridge/RelayTunnel/codec/握手/main/application/build/nsh.json/资源入口，也没有访问真实 Host/插件/设备/engine、执行 main build、Git 或依赖安装。

文件入口优先使用 `bindNativeGuiPluginPreview`；直接调用低层 present 也必须带新 owner 和真实 context。entry 源码按钮仍读真实文件并释放/重建同一 Panel owner，Retry 读取原生偏好后 refresh，不会自动安装插件。

## 真实 presentation context 与 main 最小合同

没有独立 context 注册 API。一次 `plugins.preview.present` 的 strict top-level 字段是 `sessionId/directory/path/expectedHost/owner/context`；context 为以下六项，**不含 scope、owner、存储路径、Host URL、options 或 capabilities**：

| 字段 | 来源/校验 |
| --- | --- |
| runtimeKey | `nsh:` + 本次 native-issued `expectedHost.hostID`（真实 SavedConnection ID），不取 URL、标签、lease 或 JS epoch；Swift 独立重算并比较 |
| preferenceKey | 实际 `guiPreferencesKey(runtimeKey)`；Swift 用同一 UTF-8/base64url 算法重算，并核对 storage 的 runtimeKey/preferenceKey |
| locale | 与 NSH i18n 相同的十语归一化；不能是 system 或不支持的值 |
| mode | canonical appearance 的 fixed mode，或捕获时 system colorScheme；只接受 light/dark |
| themeCSS | 原 Themes 经真实 CSSVariableGenerator.generate 的全部声明，加 Web UI/mono 字体栈及 mobile semantic typography；UTF-8 ≤512 KiB、非空，拒绝 NUL 和 script/style 结束标签注入 |
| labels | exact loading/failed/back/close/retry/source/preview 七项，每项非空且 UTF-8 ≤2048 bytes；来自原十语 t(keys)，不硬编码 English 或错误码 |

labels key 映射：loading=`guiPlugins.preview.loadingTitle`，failed=`guiPlugins.error`，back=`filesView.editor.back`，close=`guiPlugins.close`，retry=`contextPanel.preview.actions.retry`，source=`guiPlugins.preview.viewSource`，preview=`filesView.editor.switchToPreviewMode`。

TS 文件入口 owner 最小装配（下列值均由 main 现有状态/操作捕获提供，不是默认值）：

```ts
const preview = bindNativeGuiPluginPreview({
  expectedHost: capturedScope,
  appearance: nativeAppearance.current(),
  appearanceScope: { hostID: capturedHostID, generation: capturedEpoch, url: capturedHostURL },
  systemMode: colorScheme(),
  locale: language() === 'system' ? locale() : language(),
  t, call: native, identify: () => crypto.randomUUID(), isCurrent: capturedIsCurrent,
});
await preview.present({ sessionId, directory, path });
// 离页、放弃本操作、失败恢复的收尾：
await preview.close();
```

`appearanceScope` 是同一操作 owner 的 app connection/epoch/url 快照，不传进 presentation context 或浏览器。`createNativeAppearanceSync` 在成功 apply/rebind 后附加只读 `sourceHost` provenance；工厂要求 hostID/generation/url 全部匹配。它只增加只读来源信息及原始 Themes 投影，不修改 Host GET/PUT、timer、apply/reset 顺序或 Swift appearance schema；不能从 UIKit 少量 colors 反向拟合 CSS。缺 canonical snapshot/webTheme/provenance、来源不匹配、翻译失败均在调用 native present 之前失败，不发新请求、不补默认主题。

`bindNativeGuiPluginPreview` 在构造时完成 context 复制冻结；之后 locale/theme/Host 的 latest 变化不能改写该操作。需要新外观时，主 owner 必须先结束旧操作，再以当前真实 scope/snapshot 构造新 owner。main 的真实 session/path/link-handler 路由仍待接，不能在 GUI helper 内猜首会话、项目或后缀。`nativeGuiThemeCSS(generate)` 另提供只读 CSS 导出；生产绑定器已经使用原生成器，无须 main 自己拼变量。

Swift resources helper 一次读取真实 staged manifest、大小及 SHA-256；创建失败就不安装 GUI preview，不回退静态 demo。storageDirectory 只由 main 提供 app 私有 file URL；helper 使用 `GuiPluginPreviewStorage(directory:connectionID:)`，身份和文件名由 native ID 推导，仅复用当前 Host 的 store；切回其他 Host 从该私有 namespace 加载。context 没有任何路径/持久化 options 字段。所有 storage 失败在采用新值前抛错；Main 保留真实 intent，展示 `t('guiPlugins.error')` 并允许显式重试，不以空数据覆盖原值。单 owner close 仍要求 exact scope/owner；全局 invalidate 只用于 native 生命周期，前台恢复重新获取新 native scope。

CSS 经 native 结构化 reply 到既有 `style.textContent`；不使用 unsafeHTML 或拼 script/style 标签。browser factory 设置 document 的 light/dark class、data-theme、lang、colorScheme，按 active owner 恢复；不会在 QuickJS 工厂里访问 DOM。共享纯化后的无 Window context bundle 不再需要 crypto/EventTarget/AbortController；当前无这些 API 的 VM 回归通过，仍不代表 engine 已运行。

当前 context 阶段 focused 证据：`gui-plugin-context.vitest.config.mts` **2 files / 42 tests**，覆盖原 appearance-core、十语字典、全部真实 generator 声明、字体栈/mobile scale、provenance 不匹配、冻结快照、实际 factory JSON→Foundation、真实 manifest/assets/storage helper、无 Window bundle、真实双 factory 的 query/appearance 交错清理；原 browser/artifact **2 files / 14 tests**、preview/Foundation/iOS SDK/owner **3 files / 6 tests**，合计 **62 项通过**，独立 browser tsconfig 的 tsc 通过。GUI runtime fixture 仅补 `.d.mts` 类型声明以消除 wildcard 类型检查中的缺声明问题；未重跑 main 正在执行的 Runtime/terminal/ASR/desktop 组合，也未改 RuntimeBridge。

独立只读审查：同当前模型 reviewer `ses_e49b4153bffeAoLgEIke32dLMY` 初次发现 factory P2（旧 factory 清空新查询）和 P3（交错清理残留外观）；修复使用 active factory lifetime 管理原 QueryClient、document base+active layers，新增 cache+pending-query 和两种关闭顺序回归。该 reviewer 第二次只读复核明确静态关闭原 P2/P3，未发现新增 context/factory 缺陷；它未运行测试，其当时读到的 main 未接状态已由前文最新装配回传更新，字体/真实插件/导出等边界仍保持未验收。最初无 Window VM 缺 crypto 的失败已核对为测试环境遗漏 NSH 已声明的标准 API，使用真实 Node WebCrypto/EventTarget 等后通过；未加生产 shim、未修改共享 cssGenerator/preferences 文件。

**字体/完整 1:1 的真实界限：**CSS 中完整保留原 generator slots 和 UI/mono/theme 字体栈，但当前 GUI manifest 只有 HTML/JS/CSS，未交付 @font-face/WOFF 字体文件。Inter、Geist Sans、Atkinson Hyperlegible、Source Sans 3、Roboto、Noto Sans、DM Sans、Manrope 及 JetBrains Mono/Fira Code/Geist Mono/Commit Mono/Source Code Pro/Cascadia Code/Roboto Mono/Iosevka 的真实字形不能据变量存在判定通过；theme 自定义字体同样未验收，不自动联网补字体。Host 没有浏览器本地 codeFontSize 字段，沿用既有 canonical 默认 code scale=1，不能声称恢复了其他 Web 客户端的 localStorage 字号。原 native appearance 已拒绝的非法 palette/不支持字体仍明确失败，不新增假主题。Eficy、系统导出、iframe/Host assetresolver、设备字体与动态更新继续列为未完成。

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

main 已回传：原三项 P2 与后续 body-cancel P2 均经同一 oracle 静态复核 closed。body-cancel 复核确认测试首块为非 EOF，并在最终 teardown 之前检查精确 cancel 和槽位释放；该次 review 仅只读，未重跑测试。该结论不覆盖后来新增的 Runtime reader；本阶段 Runtime 已有生产 loopback/真实 E2EE mux 证据，未运行 UIKit/真实 Host/设备，不能冒充完整插件验收。main native 装配/capability 已接；真实 TS 入口及 bootstrap 数据进入生产链、实际主题/插件/导出和其余兼容缺口继续保留。
