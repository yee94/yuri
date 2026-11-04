# Yuri 当前 GUI 插件能力与 Kanban 差距（独立代码核对）

核对日期：2026-11-04。只读检查当前工作目录源码、已安装 GUI SDK/client 及现有测试；未修改产品源码，未运行 git/GitHub 命令，未读取实际凭据，未运行测试或连接运行中服务。下文“可直接用”表示当前代码实际注入或实现的契约，不代表所有部署版本与平台均已实测。SDK 实际版本证据见 [packages/ui/package.json:52-64](../../packages/ui/package.json#L52)。

## 1. GUI 承载与导航：已有主区域页面，缺的不是泛化新插槽

### Takeaway

桌面/Web 桌面布局和 VS Code 已有正式的全局主内容页面 `yuri.page`、页面导航 `yuri.pages`，可复用 `TitlebarItem` 生成入口。**缺的是插件到任意原生 session 的正式导航、原生聊天视图复用等契约，不是看板主页面本身。** [pages.ts:4-18](../../packages/ui/src/lib/gui-plugins/pages.ts#L4)、[host.ts:322-333](../../packages/ui/src/lib/gui-plugins/host.ts#L322)、[host.ts:334-419](../../packages/ui/src/lib/gui-plugins/host.ts#L334)。

### Cited Findings

#### 现有注册点与显示位置

| 能力 | 当前实际实现与限制 | 证据 |
|---|---|---|
| 自定义 Registry | `ctx.add` 保存同一窗口的贡献，`ctx.list` 跨 active 插件读取同 registry；自定义 registry **必须有消费者**，`Registry.define('随意名称')` 不会自动新增宿主界面。 | [host.ts:275-285](../../packages/ui/src/lib/gui-plugins/host.ts#L275)、[host.ts:344-384](../../packages/ui/src/lib/gui-plugins/host.ts#L344)、[host.ts:435-469](../../packages/ui/src/lib/gui-plugins/host.ts#L435) |
| 全局主页面 | `Registry.define('yuri.page')` 接受 `{id,title,icon?,render()}`，Solid JSX 可返回 DOM；`Contract.define('yuri.pages')` 提供 `open(id):boolean`、`current()`，仅打开调用插件自身页面。 | [pages.ts:4-30](../../packages/ui/src/lib/gui-plugins/pages.ts#L4)、[host.ts:322-333](../../packages/ui/src/lib/gui-plugins/host.ts#L322) |
| 真正主区域挂载 | MainLayout 的 exclusive primary 分支挂载 `GuiPluginPage`，不是外部浏览器或 panel 弹窗；VS Code 有相同分支。页面使用 `WorkspaceSurface` 和 `GuiPluginMount(kind='page')`。 | [MainLayout.tsx:532-545](../../packages/ui/src/components/layout/MainLayout.tsx#L532)、[VSCodeLayout.tsx:532-535](../../packages/ui/src/components/layout/VSCodeLayout.tsx#L532)、[GuiPluginPage.tsx:27-34](../../packages/ui/src/components/gui-plugins/GuiPluginPage.tsx#L27) |
| 侧栏/标题栏入口 | 正式注册点是官方 `TitlebarItem`；Web/桌面把它显示为 Bots 下方的侧栏导航行，VS Code 保留 header，移动端使用紧凑入口/抽屉行。它是动作或状态入口，不是独立的任意 sidebar 内容插槽。 | [组件 owning doc:3-26](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md#L3)、[SessionSidebar.tsx:2349](../../packages/ui/src/components/session/SessionSidebar.tsx#L2349)、[host.ts:451-453](../../packages/ui/src/lib/gui-plugins/host.ts#L451) |
| Session Panel | 官方 `Panel` 仅在当前 session 存在时调用 `list` 并产生 tab；独立 panel 使用宿主 Dialog/移动 Sheet；带 `PanelTab.file` 的内容可内联进既有文件预览。不是完整原生拖拽分屏系统。 | [host.ts:454-458](../../packages/ui/src/lib/gui-plugins/host.ts#L454)、[组件 owning doc:28-45](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md#L28)、[host owning doc:157-161](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L157) |
| Settings | 支持独立 `SettingsPage`；向宿主设置页注入 `page/section` 会明确 unsupported。 | [host.ts:459-462](../../packages/ui/src/lib/gui-plugins/host.ts#L459) |
| Menu | 仅 `session.panel`，其他 menu 明确 unsupported。 | [host.ts:464-467](../../packages/ui/src/lib/gui-plugins/host.ts#L464) |
| Command | 发布插件命令，支持 enabled/hidden；命令面板/管理页可执行，`ctx.commands.run` 只查找 GUI host 中注册的命令；没有把 Yuri 全部内置动作自动映射进来。快捷键和 slash autocomplete 未安装。 | [host.ts:417](../../packages/ui/src/lib/gui-plugins/host.ts#L417)、[host.ts:448-450](../../packages/ui/src/lib/gui-plugins/host.ts#L448)、[host.ts:504-505](../../packages/ui/src/lib/gui-plugins/host.ts#L504)、[组件 owning doc:115-117](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md#L115) |
| Style、外观、文件图标 | 支持生命周期 Style；自定义 registry 的宿主消费者还有 `yuri.theme`、`yuri.branding`、`yuri.file-icon`。与业务看板数据契约无关。 | [host.ts:367-372](../../packages/ui/src/lib/gui-plugins/host.ts#L367)、[host owning doc:27-60](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L27)、[host owning doc:209-231](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L209) |
| 官方 Slot / composer / FileViewer 等 | `server`、`composer-pill`、`slot`、`file.viewer`、`menubar-item` 注册被明确拒绝；因此上游文档里的 session.header/location.menu 等不能当成 Yuri 已实现能力。 | [host.ts:344-347](../../packages/ui/src/lib/gui-plugins/host.ts#L344) |

#### Session 导航特别核对

- **宿主内部已有 session 导航。** `AppNavigation.goSession(sessionId, opts)` 能定位会话及 git/files/terminal 等 tab；实现调用路径构建与 router.navigate。这证明 Yuri 自己有导航能力，不证明 GUI 插件已被授权访问。 [navigation.ts:43-54](../../packages/ui/src/router/navigation.ts#L43)、[navigation.ts:95-112](../../packages/ui/src/router/navigation.ts#L95)。
- **GUI context 没有实现 `ctx.tabs`、`ctx.router`、`ctx.servers`、`ctx.workspaces`。** 注入对象的完整定义只有 sessions/screen/layout/appearance/locale/system/commands/links 等；缺失顶层成员由 `partial` proxy 抛 `GUI_PLUGIN_UNSUPPORTED`。不是“还没发现名字”，而是这个构造处未提供。 [host.ts:57-60](../../packages/ui/src/lib/gui-plugins/host.ts#L57)、[host.ts:334-419](../../packages/ui/src/lib/gui-plugins/host.ts#L334)。
- **已安装官方 SDK 2.2.0 本来有 `Tabs.open({server,id},{focus:true})`。** 因此若要补最小 session 打开能力，应优先评估实现此已有标准子集，而不是直接宣称必须另造 `yuri.navigate`；是否完整实现 tabs/list/focus 等需要单独定范围。 [SDK host-apis.d.ts:1430-1457](../../packages/ui/node_modules/@opencode/plugin/dist/gui/host-apis.d.ts#L1430)。
- SDK 的 `Router` 本身只有 routing/path 读取，不能凭名称推测有 `router.navigate`；那是其他 API/平台的概念。 [SDK host-apis.d.ts:1066-1071](../../packages/ui/node_modules/@opencode/plugin/dist/gui/host-apis.d.ts#L1066)。
- `ctx.sessions.current()` 是当前被 Provider 选择并且目录已解析的 session；`ctx.sessions.list()` 实际只返回当前一个或空数组，**不是全量 session catalog，也不是官方全部 shell tabs 清单**。 [GuiPluginsProvider.tsx:145-147](../../packages/ui/src/lib/gui-plugins/GuiPluginsProvider.tsx#L145)、[GuiPluginsProvider.tsx:230-232](../../packages/ui/src/lib/gui-plugins/GuiPluginsProvider.tsx#L230)、[host.ts:408-409](../../packages/ui/src/lib/gui-plugins/host.ts#L408)。
- `ctx.layout.open` 的 key 是插件 panel tab，它写 session-scoped panel 布局，**不是选择/切换 session**。`ctx.links.open` 的内建导航只把文件交给 `focusFile`，显式非当前 session 的文件引用被拒绝；其他链接只分派插件 LinkHandler。 [host.ts:297-317](../../packages/ui/src/lib/gui-plugins/host.ts#L297)、[host.ts:522-541](../../packages/ui/src/lib/gui-plugins/host.ts#L522)、[host.ts:595-604](../../packages/ui/src/lib/gui-plugins/host.ts#L595)。
- `ctx.system.openExternal` 仅接受 HTTP(S)/mailto 并 `window.open`，不是主区域导航 API；手写 `/session/$id` 锚点或改 history 可自绘实现某些浏览器行为，但不构成 Electron/VS Code/移动端跨 runtime 的正式 session-open 契约。 [host.ts:412-418](../../packages/ui/src/lib/gui-plugins/host.ts#L412)、[router owning doc:9-14](../../packages/ui/src/router/DOCUMENTATION.md#L9)。
- 全局页面路由已有 `/plugins/$pluginId/$pageId`；主页面与 chat 互斥。Back 可以恢复此前主 tab，但页面的内层详情/iframe history 仍由插件拥有。 [router owning doc:28-33](../../packages/ui/src/router/DOCUMENTATION.md#L28)、[组件 owning doc:76-84](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md#L76)。

#### Solid 渲染上下文与 Session view 边界

- CJS 依赖映射共享宿主 `@opencode/plugin/gui`、Solid、Solid web/store、Effect、官方 client/schema；第三方 GUI 包是单文件 CJS，不能把 Node 模块占位误当真实 Node 权限。 [bundle.ts:16-31](../../packages/ui/src/lib/gui-plugins/bundle.ts#L16)、[bundle.ts:33-58](../../packages/ui/src/lib/gui-plugins/bundle.ts#L33)。
- setup 在真实 `PluginContext.Provider` 与 Solid root 中同步执行；page/settings/panel 都走 `mount` 的真实 PluginContext 和 Solid `render`，因此 `usePlugin()` 获得所属插件 options/client/storage 等，同一全局页不需要 session。 [host.ts:163-175](../../packages/ui/src/lib/gui-plugins/host.ts#L163)、[host.ts:669-695](../../packages/ui/src/lib/gui-plugins/host.ts#L669)。
- Panel 另外提供 `PanelContext`，placement 是 side/mobile，`PanelSidebar` 当前空能力代理；`props.session/tab` 是 getter，screen 仅实现 `.file`。没有正式“把 Yuri ChatView / session timeline / composer 挂进看板卡片”的 registry 或组件契约。 [host.ts:111-114](../../packages/ui/src/lib/gui-plugins/host.ts#L111)、[host.ts:620-631](../../packages/ui/src/lib/gui-plugins/host.ts#L620)、[host.ts:655-664](../../packages/ui/src/lib/gui-plugins/host.ts#L655)、[host.ts:344-347](../../packages/ui/src/lib/gui-plugins/host.ts#L344)。
- 跨插件 Contract 可传 Solid 组件，`bindPlugin` 保持提供方 context；这不是 Yuri 自动导出自身 React 组件。React 只拥有空容器，不调和 Solid 后代。 [host.test.ts:737-745](../../packages/ui/src/lib/gui-plugins/host.test.ts#L737)、[组件 owning doc:59-70](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md#L59)。

### Inferences

- 普通列/卡片/拖拽/筛选/详情页属于插件自己画 Solid/DOM，即可放进已存在主区域；不需要先补 Kanban 专用页面插槽。能自绘拖拽不等于已经复用 Yuri 的排序组件或快捷键系统，需插件自行打包适合 Solid 的实现。依据是正式全局页 render 契约及共享模块列表。 [pages.ts:8-18](../../packages/ui/src/lib/gui-plugins/pages.ts#L8)、[bundle.ts:16-31](../../packages/ui/src/lib/gui-plugins/bundle.ts#L16)。
- “点击任务→进入原生 session→返回看板”是最直接的宿主缺口；可优先补官方 `ctx.tabs.open` 的受控子集并接既有导航 owner。是否需要“看板内嵌完整聊天”是更大的独立产品要求，不应默认一起建设。 [SDK host-apis.d.ts:1430-1457](../../packages/ui/node_modules/@opencode/plugin/dist/gui/host-apis.d.ts#L1430)、[navigation.ts:95-112](../../packages/ui/src/router/navigation.ts#L95)、[host.ts:334-419](../../packages/ui/src/lib/gui-plugins/host.ts#L334)。

### Gaps

- 未实际运行看板插件；全局页面可挂载有测试源码佐证，Kanban 的拖拽、键盘与无障碍交互没有现成专用验收。
- 当前正式主页面**移动端明确不可用**，不是自动响应式就能上线；仅移动端文件 Panel/独立 Panel 可用。若需求包含移动 Kanban，须另定主页面移动承载/导航契约。 [host.ts:324-333](../../packages/ui/src/lib/gui-plugins/host.ts#L324)、[host.ts:676-680](../../packages/ui/src/lib/gui-plugins/host.ts#L676)、[GuiPluginPage.tsx:27](../../packages/ui/src/components/gui-plugins/GuiPluginPage.tsx#L27)。

## 2. 数据、工具、持久化、工作树与终端：哪些真正在插件上下文

### Takeaway

`ctx.client` 是直接注入的完整官方 GUI client，不是只准取 bundle 的窄代理，所以 session CRUD/prompt/interrupt、事件、RPC、worktree/PTY 等已经有正式访问路径；但 Yuri 自有 RuntimeAPIs、会话同步索引、Git/终端 UI 没有整体注入。Kanban 可复用底层服务能力，**不能据此声称已有任务域、共享看板数据库或原生组件 SDK**。 [host.ts:335](../../packages/ui/src/lib/gui-plugins/host.ts#L335)、[gui.ts:15-30](../../packages/ui/src/lib/opencode/gui.ts#L15)、[RuntimeAPIs:1280-1300](../../packages/ui/src/lib/api/types.ts#L1280)。

### Cited Findings

#### 三层能力分级（特别避免“后端有 API = 插件已集成”）

| 领域 | 后端/官方原有 API | 插件上下文可直接用 | 自绘可行但未形成正式宿主契约 |
|---|---|---|---|
| Session 数据与执行 | 官方 client 有 list/create/get/update/fork/move/prompt/command/skill/shell/interrupt/inbox/log、message.list。 | 同一个 client 直接放在 `ctx.client` 和当前 session.server.client。列表支持 limit/cursor/project/directory/parentID 等。 | UI 导航、Yuri session index 和完整同步 store 没有暴露；插件需自己取数、处理分页与状态。 |
| 事件 | client 有 `event.subscribe` 和 typed RPC events。 | `ctx.client.event.subscribe`、`ctx.client.rpc(token).events` 可使用；无需再新增通用 event slot。 | 宿主并未把自己的同步 reducer/cache 或自动重连策略接进插件数据模型。 |
| Worktree/Git | 官方 `worktree.list/create/remove/refresh`、vcs.status/diff 等；Yuri 自有 `/api/git/worktrees` 及 queue-activation/bootstrap 等更丰富编排。 | 官方 worktree/vcs 在 `ctx.client`；不依赖 Electron main。 | Yuri `RuntimeAPIs.git`、GitView、worktree UI/队列修复编排没有直接注入 ctx。 |
| 终端与 Shell | 官方 pty CRUD/token、persistentPty、shell create/output；Yuri 另有 `/api/terminal/*` 与 WS/SSE。 | 官方 client 的 HTTP 方法可直接调用。 | 未提供 URI/鉴权/Relay 兼容的插件 terminal viewer 或 `ctx.terminal`。PTY token 不等于已接通跨 runtime 双向终端。 |
| 工具/命令 | 服务端插件注册 skill/tool；官方 session.command 执行服务端命令。 | GUI Command 注册 UI 动作；client.rpc 调服务端插件自定义方法；client.command.list/session.command 等可调用。 | GUI `ctx.add(Command)` 不是给模型注册 tool，也不自动变成服务端 slash command。 |
| 存储 | client.file.write/read 与 session metadata 是服务端能力；GUI 自身另有 storage。 | `ctx.storage`、声明式 `ctx.stores`；server RPC 可承载插件自己定义的数据服务。 | 没有由 `yuri.page` 自动附送的共享事务数据库、协作冲突控制、任务 schema。 |

以上表格直接证据：session 方法 [已安装 client.d.ts:26-88](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L26)，查询参数 [types.d.ts:3929-3939](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/generated/types.d.ts#L3929)，文件/命令 [client.d.ts:180-192](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L180)，PTY/shell/worktree/vcs [client.d.ts:194-245](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L194)，RPC/事件 [client.d.ts:271-275](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L271)，RPC listener [rpc.d.ts:16](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/rpc.d.ts#L16)，Yuri worktree 路由 [routes.js:1072-1146](../../packages/web/server/lib/git/routes.js#L1072)，终端路由 [runtime.js:521](../../packages/web/server/lib/terminal/runtime.js#L521)、[runtime.js:575](../../packages/web/server/lib/terminal/runtime.js#L575)、[runtime.js:677](../../packages/web/server/lib/terminal/runtime.js#L677)，RuntimeAPIs 定义 [types.ts:1280-1300](../../packages/ui/src/lib/api/types.ts#L1280)，实际 ctx 构造 [host.ts:334-419](../../packages/ui/src/lib/gui-plugins/host.ts#L334)，服务端工具边界 [host owning doc:263](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L263)。

#### Client 传输、事件、状态权威性

- GUI client 固定使用 `@opencode/client@2.2.0` alias，与应用自己升级的 client 分开；创建时套 `runtimeFetch`，所有普通请求（不只是 GUI bundle）都走此路径，合并取消信号并拒绝 runtime identity/generation 已变化的旧 client。 [package.json:52-64](../../packages/ui/package.json#L52)、[gui.ts:9-30](../../packages/ui/src/lib/opencode/gui.ts#L9)。
- `runtimeFetch` 有当前 runtime URL 与鉴权目标判断，不应在插件手写裸 fetch 到相对 `/api/git` 后就宣称与所有运行时等价。即使同源 Web 技术上可请求，ctx 没公开 Yuri 专有 fetch/RuntimeAPIs；优先官方 client 或服务端 RPC，确需 Yuri API 时应补受控、可测的窄桥接。 [runtime-fetch.ts:43-52](../../packages/ui/src/lib/runtime-fetch.ts#L43)、[runtime-fetch.ts:91-109](../../packages/ui/src/lib/runtime-fetch.ts#L91)、[host.ts:334-419](../../packages/ui/src/lib/gui-plugins/host.ts#L334)。
- 已安装 client 的 event union 含 session.created/deleted/metadata.updated/status、execution.started/succeeded/failed/interrupted、permission.asked/replied、worktree/PTY 等，因此无需凭空再补一套“监听 session 变化”的通用入口；是否能收到某部署发出的各事件仍取决于运行服务版本。 [client.d.ts:275](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L275)。
- 订阅实现 lazy-start、每 client 共享源，最后一个 subscriber 退出会取消连接；异常结束 subscribers，没有在此实现里自动重连或历史回放；当前安装版每订阅队列容量 4096，溢出会失败。看板应自行建立“初始快照+事件更新+断线恢复后重读”的数据 owner，而不是把订阅返回当已提供 durable sync。 [shared-events 实现:11-48](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/chunks/service-timing-gecjxyvt.js#L11)、[实现:59-113](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/chunks/service-timing-gecjxyvt.js#L59)。
- **不把业务 Done 等同于 session idle。** 当前 SessionInfo 有 outcome、time、metadata 等，client 同时有 active、inbox、execution 事件；这些是执行状态，不是 Kanban 业务列的现成语义。插件必须定义自己的列状态映射。 [client.d.ts:32-34](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L32)、[types.d.ts:2989-3015](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/generated/types.d.ts#L2989)、[client.d.ts:56-59](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L56)。

#### 存储细节与文件上下文

- Provider 给 GUI host 注入的是 `window.localStorage`；存储键包括 transport、plugin ID、scope、key。支持 global、session，以及显式 server/directory scope；session 必须有 location。memory 在同 host 的插件替换中保留，host/runtime 销毁时清空。 [GuiPluginsProvider.tsx:211-214](../../packages/ui/src/lib/gui-plugins/GuiPluginsProvider.tsx#L211)、[storage.ts:10-29](../../packages/ui/src/lib/gui-plugins/storage.ts#L10)、[storage.ts:78-113](../../packages/ui/src/lib/gui-plugins/storage.ts#L78)。
- 持久 store 使用 Effect schema encode/decode，先写 backend 成功才更新信号；每个 persisted handle 集合上限 256、每份编码体 2 MiB；不支持 `from` 迁移，未见存储跨窗口同步实现。它适合当前客户端偏好/轻量单人板，不等同于服务端跨设备共享主数据。 [storage.ts:6-7](../../packages/ui/src/lib/gui-plugins/storage.ts#L6)、[storage.ts:27-64](../../packages/ui/src/lib/gui-plugins/storage.ts#L27)、[host owning doc:101](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L101)。
- 声明式 `Store.global` / `Store.session` 已桥接到同一 storage，不能误判没有任何持久化。 [host.ts:287-291](../../packages/ui/src/lib/gui-plugins/host.ts#L287)。
- 服务端 session.create/update 已允许 JSON metadata，可表达命名空间内的 task/session 关联；但代码不因此提供跨任务排序事务、并发 revision/CAS 或板级 ACL，需要根据真正的数据需求决定用 metadata、项目文件还是 server RPC，不应无条件新增 Yuri 数据库。 [types.d.ts:3951-3971](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/generated/types.d.ts#L3951)、[types.d.ts:4093-4105](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/generated/types.d.ts#L4093)。
- 当前 screen.file 的 sync/get/unwatch/search 是宿主会话工作区模型；tree 操作明确 unsupported，screen 不含 composer/comment。文件模型是 128 KiB UTF-8/64 项、2 秒前台 stat 观察的预览子集，不应当无限容量、实时共享任务数据库。官方 `ctx.client.file.write/read` 是另一条服务 API，与此只读预览模型不能混为一谈。 [files.ts:43-99](../../packages/ui/src/lib/gui-plugins/files.ts#L43)、[host.ts:111-114](../../packages/ui/src/lib/gui-plugins/host.ts#L111)、[host owning doc:265-277](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L265)、[client.d.ts:180-186](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L180)。

#### 权限、原生边界与 runtime 差异

- GUI inventory 来自当前服务的全局插件列表，非扫描所有项目；服务端 `.` 和 `./gui-experimental` 是独立部件，GUI 启停不自动注册远端工具。若 Kanban 需要模型可调用的 task CRUD tool，服务端插件要安装在执行任务的那个服务上。 [host owning doc:233-263](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L233)。
- GUI 窗口是共享 DOM/JS 主线程，**不是 JS/CSS 安全沙箱**。options 留在所属 context，page snapshot 不携带 options；这是数据流约束，不是恶意同文档代码的强隔离。嵌入 iframe 的认证/source/origin/CSP 由插件负责。 [bundle.ts:49-58](../../packages/ui/src/lib/gui-plugins/bundle.ts#L49)、[host.ts:488](../../packages/ui/src/lib/gui-plugins/host.ts#L488)、[host owning doc:84-86](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L84)。
- 普通窗口插件不直接获得 Node/FS/child_process。只有可信本机 Electron、经过来源/revision/native lease 验证的 main 才能 require Node/Electron；其他 runtime/远端/Relay/window-only 的 `ctx.main` 请求明确拒绝，不应为看板“开一个全平台 Node 逃生口”。 [bundle.ts:33-55](../../packages/ui/src/lib/gui-plugins/bundle.ts#L33)、[host.ts:403-406](../../packages/ui/src/lib/gui-plugins/host.ts#L403)、[electron main host:20-33](../../packages/electron/gui-plugin-host.mjs#L20)、[host owning doc:110-116](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L110)。
- 当前 `ctx.app.platform` 依据 native activation 判断而非仅 Electron 外壳；远程 Electron window-only 仍是 web/desktop undefined。main 可通过现有 IPC schema/state/event/cancel 管理本机原生资源，但不是跨 runtime 通用持久化后端。 [host.ts:337-338](../../packages/ui/src/lib/gui-plugins/host.ts#L337)、[host owning doc:106-116](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L106)。
- Session 执行权限与 GUI native 权限是两层。client 本来可 request/list/reply permission，session.create/update 可传 permissions；这些请求仍走服务认证与 server policy，不能以“按钮隐藏”代替后端规则。Yuri owning doc 明确 runtime execution gate 在 pending/false 时也拒绝执行写入。 [client.d.ts:163-178](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L163)、[types.d.ts:3967-3971](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/generated/types.d.ts#L3967)、[opencode owning doc:247-250](../../packages/web/server/lib/opencode/DOCUMENTATION.md#L247)。
- Web/Electron/VS Code/hosted mobile/Capacitor 共用窗口 host，但全局主页面只面向桌面布局/VS Code；移动文件预览不等于移动主区域看板已支持。远端数据操作应以连接 Host 为 owner，不使用当前客户端本机路径兜底。 [host owning doc:13-17](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L13)、[host owning doc:66-86](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L66)。

### Inferences

- **最小单人 Kanban** 可由插件独立完成：现有 page+TitlebarItem；本地 store 保存列/顺序；官方 session client 创建与执行任务、events 更新状态。该组合只欠“打开任意原生 session”的宿主导航桥，前提是不要求手机主页面、不要求共享数据库或嵌入原生聊天。 [pages.ts:8-18](../../packages/ui/src/lib/gui-plugins/pages.ts#L8)、[storage.ts:32-64](../../packages/ui/src/lib/gui-plugins/storage.ts#L32)、[client.d.ts:26-88](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L26)、[host.ts:334-419](../../packages/ui/src/lib/gui-plugins/host.ts#L334)。
- **工作树隔离执行** 已有官方 client 原语，不必先新增 `ctx.worktree` 才能开始；但如果产品要求与 Yuri 的工作树 ready/bootstrap/消息队列激活/删除回滚保持完全一致，需要明确复用/适配 owner 的窄 contract，而非让插件手抄内部实现。 [client.d.ts:231-245](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L231)、[Git owning doc:139-144](../../packages/web/server/lib/git/DOCUMENTATION.md#L139)。
- **多窗口、多设备、模型工具可更新的 Kanban** 应把 task/board 状态放在共同服务端 owner，GUI 只是客户端；可利用已有 plugin RPC/事件，不必把所有任务域加进 Yuri 核心。需要定义 task-session-worktree 关联、原子拖动排序/冲突、重试、权限、恢复，这些是插件业务契约与验收，不是页面 Slot。 [host.ts:335](../../packages/ui/src/lib/gui-plugins/host.ts#L335)、[client.d.ts:271-275](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L271)、[storage.ts:15-25](../../packages/ui/src/lib/gui-plugins/storage.ts#L15)。

### Gaps

- 只确认安装版 API 类型及 Yuri 传输注入，不代表已向当前运行中的 OpenCode 发请求验证。worktree/PTY/session/event 的 live backend 兼容、Relay 长连接恢复、取消行为没有本次实测。
- 未找到正式 GUI terminal renderer/ChatView 挂载契约；PTY HTTP 方法是否足够实现目标终端，需要下一步针对 token/WebSocket/Relay 和各 runtime 实测，不能仅凭 client.d.ts 得出“完整终端支持”。 [client.d.ts:194-215](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L194)、[host.ts:334-419](../../packages/ui/src/lib/gui-plugins/host.ts#L334)。
- 在 `packages` 的 `*.ts/tsx/js/mjs` 中搜索 `kanban|Kanban` 无匹配；这仅表明本次检索未发现产品内 Kanban 实现，不是证明外部插件或未纳入范围的文件也不存在。

## 3. Kanban 到底还缺什么、谁拥有，以及现有测试证明到哪

### Takeaway

建议最小宿主补齐集中于 **官方 session-open 子集**；移动主页面、原生聊天嵌入、Yuri 工作树/终端编排等只按产品明确需求追加。看板数据域、拖拽、任务执行状态机及服务端 tools/RPC 应由插件拥有，现有测试证明通用 host 生命周期和传输边界，不证明 Kanban 业务闭环。 [SDK Tabs:1430-1457](../../packages/ui/node_modules/@opencode/plugin/dist/gui/host-apis.d.ts#L1430)、[host owning doc:283-295](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L283)。

### Cited Findings

#### 差距清单（不预设 DSH 的实现）

| 优先级/条件 | 真正差距 | 建议 owner 与最小范围 | 不应误写成 |
|---|---|---|---|
| P0：点击任务进入原生会话 | GUI ctx 缺 `tabs.open`，虽然 Yuri 内部有 goSession。 | GUI host 实现官方 `Tabs.open` 受控子集，桥接 router/session navigation；定义 runtime 身份、未知 session、目录解析、返回看板行为，并测试。 | “没有主区域页面，必须新增看板 slot”。 |
| 插件 MVP 必做 | board/task/column/order、task-session 关联、执行生命周期与 UI。 | 插件自己的 Solid 页面与数据服务。单客户端可用现有 storage；跨设备用 server RPC/存储。 | “Yuri 必须内建所有 Kanban API”。 |
| 跨设备/多窗口/工具共写时 | 本地 storage 无共享权威性、事务冲突/迁移契约。 | 插件服务端 schema、revision/幂等/冲突与事件恢复，复用 RPC。 | “已有持久化”=“有共享看板数据库”。 |
| 要手机主页面时 | narrow 下 pages contract inactive、mountPage 不挂载。 | 宿主移动产品导航/页面承载；不能仅在插件 CSS 上修。 | “有移动 Sheet 所以手机看板也完成”。 |
| 要看板内直接聊/审查时 | 没有原生 ChatView/timeline/composer 组件契约；官方 Slot 也未支持。 | 先判断能否“打开原生 session”满足；确需嵌入再定义单独、窄且跨 runtime 的 session-view contract。 | “page.render 可用”=“可直接 import Yuri ChatView”。 |
| 要与 Yuri 资源编排完全一致时 | 官方 worktree/PTY API 不含 Yuri 全套 UI 和生命周期编排。 | Git/terminal/runtime owner 提供受控动作/组件契约或 server RPC adapter，明确支持矩阵。 | “后端有 /api/git 与 /api/terminal”=“GUI ctx 直接可用 RuntimeAPIs”。 |
| 要模型管理任务时 | GUI Command 不注册模型 tool。 | 同包 server part 的 tool/skill/RPC + GUI client；安装在目标服务。 | “GUI Command 就是 agent tool”。 |

表格依据：导航实现与缺口 [navigation.ts:95-112](../../packages/ui/src/router/navigation.ts#L95)、[host.ts:334-419](../../packages/ui/src/lib/gui-plugins/host.ts#L334)；持久化 [storage.ts:15-64](../../packages/ui/src/lib/gui-plugins/storage.ts#L15)；移动门槛 [host.ts:322-333](../../packages/ui/src/lib/gui-plugins/host.ts#L322)、[host.ts:676-680](../../packages/ui/src/lib/gui-plugins/host.ts#L676)；UI/Slot 缺口 [host.ts:344-347](../../packages/ui/src/lib/gui-plugins/host.ts#L344)；worktree/terminal 归属 [RuntimeAPIs:1280-1300](../../packages/ui/src/lib/api/types.ts#L1280)、[Git owning doc:139-144](../../packages/web/server/lib/git/DOCUMENTATION.md#L139)；server tool 边界 [host owning doc:263](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L263)。

#### Owning docs

- GUI host/窗口兼容子集、native 权限、全局页、storage、SDK 固定版本、生命周期与测试边界：[`packages/ui/src/lib/gui-plugins/DOCUMENTATION.md`](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md)。
- React 页面/入口/文件 Panel/移动 Sheet UI 承载：[`packages/ui/src/components/gui-plugins/DOCUMENTATION.md`](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md)。
- 全局页面与 session tools 的路由边界：[`packages/ui/src/router/DOCUMENTATION.md`](../../packages/ui/src/router/DOCUMENTATION.md)。
- 插件作者随应用提供的能力参考：[`gui-customization/DOCUMENTATION.md:10-14`](../../packages/web/server/lib/gui-customization/DOCUMENTATION.md#L10)、[`skill/references/gui-api.md`](../../packages/web/server/lib/gui-customization/skill/references/gui-api.md)、[`global-pages.md`](../../packages/web/server/lib/gui-customization/skill/references/global-pages.md)。
- 后端工作树、终端、代理/执行 gate：[`git/DOCUMENTATION.md`](../../packages/web/server/lib/git/DOCUMENTATION.md)、[`terminal/DOCUMENTATION.md`](../../packages/web/server/lib/terminal/DOCUMENTATION.md)、[`opencode/DOCUMENTATION.md:621-628`](../../packages/web/server/lib/opencode/DOCUMENTATION.md#L621)。

#### 现有 tests 的确切覆盖（本次仅读，未执行）

| 测试 | 能证明的源码覆盖范围 | 不能推出的结论 |
|---|---|---|
| `lib/gui-plugins/host.test.ts:62-153` | 真实官方 SDK/Solid host；无 session 全局页；所属 options 不进入 snapshot；TitlebarItem 打开自己的 page；50 次 session 变化保留 DOM；卸载/replace cleanup；跨插件 ID 隔离；mobile inactive；保留 Contract 拒绝；render 失败只影响本插件。 | 实际路由、真实浏览器、网络服务、Kanban 拖拽。 |
| `host.test.ts:681-713`、`:737-745` | 非当前 session 的 layout 写入隔离；ctx.dialogs unsupported；window-only native IPC 明确拒绝；同步 setup；跨插件 bindPlugin context。 | 任意 session 的 UI 导航、正式 dialogs API、真实 native main 行为。 |
| `components/gui-plugins/GuiPluginIntegration.test.tsx:107-195` | React DOM 边界、page 失败 canvas、无多余 header、50 次无关 render 不重挂、revision replacement；侧栏官方图标/状态/动作及不触发早加载。 | host/provider 在这些测试中是 fixture；不证明真实 Solid、live SDK 或移动手势。 |
| `lib/gui-plugins/skill-examples.test.ts:13-54` | 从随应用 reference 提取 TS 编译，真实 host 上运行全局页/Titlebar/context 和 custom-file Panel/read/cleanup。 | file I/O、client、导航都是 fixture，不是已连接服务的端到端任务管理。 |
| `lib/gui-plugins/storage.test.ts:6-53` | schema codec、reload memory、runtime 隔离、持久写失败不改变已显示值、from 拒绝、坏数据/default、remove reset。 | 跨窗口/设备同步、服务端事务、协作冲突。 |
| `lib/opencode/gui.test.ts:225-290` | bundle 经过 Relay 的多种 URL 来源、auth/全局 scope/query、runtime switch/dispose 拒绝旧 client、mutation payload/header/cancel 合并。 | 测试主要使用 plugin inventory/bundle/update 路由；不证明 session/worktree/PTY/live event 的业务集成已通过。 |
| GUI host/files/provider/native 等其他测试 | owning doc 记载文件刷新/错误/会话隔离、懒加载与 transport 迟到隔离、IPC codec/state/event/cancel；Electron host 测试另测多窗口共享 main、来源、revision、导航取消。 | 不能将此概括为“所有平台、所有官方 GUI API 完全兼容”。 |

对应来源：[host.test.ts:62-153](../../packages/ui/src/lib/gui-plugins/host.test.ts#L62)、[host.test.ts:681-713](../../packages/ui/src/lib/gui-plugins/host.test.ts#L681)、[host.test.ts:737-745](../../packages/ui/src/lib/gui-plugins/host.test.ts#L737)、[Integration.test.tsx:107-195](../../packages/ui/src/components/gui-plugins/GuiPluginIntegration.test.tsx#L107)、[skill-examples.test.ts:13-54](../../packages/ui/src/lib/gui-plugins/skill-examples.test.ts#L13)、[storage.test.ts:6-53](../../packages/ui/src/lib/gui-plugins/storage.test.ts#L6)、[gui.test.ts:225-290](../../packages/ui/src/lib/opencode/gui.test.ts#L225)、[host owning doc:283-293](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L283)、[组件 owning doc:197-207](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md#L197)。

- **文档与源码局部不一致，不能照文档一概断言。** 组件文档说加载失败不弹全局 toast；当前 Provider 仍有 `LoadErrors` 调用 toast.error 并被挂载。该矛盾不改变看板能力判断，但说明当前 checkout 应以实现为准，本次没有修复。 [组件 doc:88-90](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md#L88)、[GuiPluginsProvider.tsx:35-44](../../packages/ui/src/lib/gui-plugins/GuiPluginsProvider.tsx#L35)、[GuiPluginsProvider.tsx:273](../../packages/ui/src/lib/gui-plugins/GuiPluginsProvider.tsx#L273)。

### Inferences

- 下一步最有价值的契约验收不是再建 demo page，而是一个最小插件夹具：打开现有主页面 → 分页读取 sessions → 创建并发送任务 → 监听 execution/permission → 打开该 session → 回看板；然后测试断线恢复、切 runtime、停用/升级、权限拒绝。其每一步都有既有 API 基础，唯一明确缺少的常规宿主动作是正式 session-open；其他复杂视图/终端能力只在需求真的需要时追加。 [host.ts:322-419](../../packages/ui/src/lib/gui-plugins/host.ts#L322)、[client.d.ts:26-88](../../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L26)、[SDK Tabs:1430-1457](../../packages/ui/node_modules/@opencode/plugin/dist/gui/host-apis.d.ts#L1430)。

### Gaps

- 本笔记不依赖 DSH 的调研结果，也不声称目标 Kanban 是“session 列表视图”还是“独立 task 实体”。需要上层确定后，才能最终选择 metadata/local store/server RPC。
- 未执行 Vitest、浏览器、Electron、VS Code、iOS/Android 或真实远端/Relay 验收；本文所有测试结论是对现有测试源码范围的描述，不是本次跑测通过声明。
- 外部资料仅帮助核对官方 API 概念，不覆盖当前 Yuri 子集：已读取 [官方 GUI 文档](https://opencode.ai/v2/docs/build/plugins/gui)、[官方 client 文档](https://opencode.ai/v2/docs/build/client)，并通过 Context7 检索 `/anomalyco/opencode`。Context7 命中包含服务端/CLI API，未将这些命中当作 Yuri GUI 已支持证据；具体 2.2.0 签名以本地安装版为准。
