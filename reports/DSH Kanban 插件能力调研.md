# Yuri 支持 Kanban，应补导航而非另建框架

**结论：Yuri 已具备桌面 Kanban 的主要插件底座，无需再造看板插槽、任务数据库或 Agent 执行框架。** DSH 依靠页面扩展、工作区上下文、服务端业务通道和工具注册支撑看板；复杂编排大多由插件实现。Yuri 已有全局页面、存储及注入客户端，最明确的宿主缺口是“点击任务，打开关联原生会话”。无会话时自动跟随当前项目、手机主页面、内嵌聊天和分屏应分别定范围，不能默认包含。建议先实现桌面/Web 桌面布局/VS Code 的协作板，再验证执行闭环；以下是静态研究结论，不是实现或运行时验收。

## DSH 的两个代表插件，依赖并不相同

DSH 是 DeepSeek 官方的 **DeepSeek Harness**；本次宿主基线为 `8bd0733`、版本 `0.2.2-alpha.3`。用户未指定插件链接，故区分两个第三方作者实现，不将其功能拼成一个“官方 Kanban”。宿主本身仍提示开发预览和兼容变化。([官方固定提交](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/README.md)、[版本](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/package.json#L1-L5))

**协作板 A**：`@alpacachen/dsh-kanban` 1.10.1 正式注册 `conversation.view`，按 workspace 查询插件后端，使用宿主 fs 写 JSON，并注册 19 个 Agent 工具。卡片进入聊天时**只填草稿，不自动发送**。其声明兼容旧 RC，不能据此认定已兼容上述宿主。([版本/兼容](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/package.json)、[功能清单](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/README.md)、[页面注册](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/plugin.ts#L11-L34)、[后端与工具](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L1087-L1188)、[聊天桥](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/lib/chat-bridge.ts#L3-L23))

**执行编排板 B**：`@goodandready/dsh-kanban` 0.2.39 进一步创建/恢复 Agent、派发任务、消费 session 事件。但它的 SQLite、浏览器 SSE、Git worktree 管理均为插件自建，主入口甚至依赖 DOM/CSS 接管，**不是 DSH 正式 API**。官方提供的是有作用域与生命周期的 slots 等基础契约。([版本](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/package.json)、[执行路径](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/launcher.js#L165-L296)、[自建数据库](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/store.js#L198-L244)、[SSE](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/events.js#L1-L101)、[Git](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/worktree.js#L14-L35)、[DOM 接管](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/client.js#L4960-L5114)、[官方 slots](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/docs/subsystems/slots.md#L54-L118))

## 能力对照：大部分可复用，缺口集中在原生整合

| 需求 | DSH 怎么做 | Yuri 当前 | 是否需新增 |
|---|---|---|---|
| 主区域看板、入口 | A 正式 view；B DOM 接管 | `yuri.page`、`yuri.pages`、`TitlebarItem` 已有 | 桌面不需要 |
| 每项目一板 | workspace props/registry | 有当前 session 目录、项目查询；无独立当前 workspace 契约 | 显式选项目可先做；自动跟随时再补 |
| 人机共同读写、持久化 | A HTTP/fs/tools；B SQLite/SSE/tools | 服务端插件、tool、RPC 已有；GUI store 也可持久化 | 插件实现任务数据服务，不新建宿主数据库 |
| 创建/发送/中断任务会话 | B agents create/resume/followup | `ctx.client.session` 已注入 | 先验证现有路径，不另建执行器 |
| 自动更新执行状态 | B session 事件→插件状态→自建 SSE | client 原生事件、RPC events 已有 | 插件补快照、重连与业务状态映射 |
| 点卡进入原生聊天 | B 消费 sessions.open | 内部 `goSession` 已有，GUI 未提供 `ctx.tabs` | 推荐补官方 `tabs.open` 子集 |
| 工作树、终端 | B 自行 Git；非看板基础条件 | client 有 worktree/PTY；Yuri 编排与原生组件未开放 | 原语不缺；深度整合按需补 |
| 手机、内嵌聊天、分屏 | 不可从上述样例外推 | 手机全局页禁用；无正式 ChatView/分屏契约 | 可选增强，另立范围 |

Yuri 证据：页面契约 [pages.ts:4–18](../packages/ui/src/lib/gui-plugins/pages.ts#L4)，上下文与支持子集 [host.ts:322–419](../packages/ui/src/lib/gui-plugins/host.ts#L322)，内部导航 [navigation.ts:95–112](../packages/ui/src/router/navigation.ts#L95)，服务端工具边界 [DOCUMENTATION.md:263](../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L263)，客户端方法 [client.d.ts:26–88](../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L26)、[194–245](../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L194)、[271–275](../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L271)。

## 客户端确已注入，但类型和传输不等于后端实测

`ctx.client` 实际是 **`OpenCode.make()` 返回的 Promise 风格 `@opencode/client@2.2.0` 客户端**，以 `@yuriai/opencode-gui-client` 别名单独锁版；不是 Yuri 的 `RuntimeAPIs`，也不是仅能下载插件的代理。已确认完整对象直接注入，普通请求经过 `runtimeFetch`，带运行时鉴权、取消和旧实例失效检查。session、event、RPC、worktree、PTY 都有安装版方法契约；但本次未对运行服务验证这些业务调用。现有传输测试主要覆盖 inventory/bundle/update，不能宣称“工作树或跨 Relay 终端已跑通”。PTY HTTP 方法尤其不等于原生终端视图或双向连接。([package.json:52–64](../packages/ui/package.json#L52)、[host.ts:335](../packages/ui/src/lib/gui-plugins/host.ts#L335)、[gui.ts:9–30](../packages/ui/src/lib/opencode/gui.ts#L9)、[gui.test.ts:225–290](../packages/ui/src/lib/opencode/gui.test.ts#L225))

上下文也不能高估：`ctx.sessions.list()` 只返回当前一个或空数组；有 session 时可取其 directory，无 session 时不能据此推断当前 UI 项目。`client.project.list`、显式目录的 `location.get` 可用于插件选项目，但服务默认目录不等于 UI 当前项目。**MVP 可先让插件明确选板/目录；若要求无会话自动跟随项目，再补上下文。**([host.ts:126–137](../packages/ui/src/lib/gui-plugins/host.ts#L126)、[408](../packages/ui/src/lib/gui-plugins/host.ts#L408)、[client.d.ts:12–14](../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L12)、[156–158](../packages/ui/node_modules/@yuriai/opencode-gui-client/dist/promise/client.d.ts#L156))

GUI store 后端是 `localStorage`，键含 transport、plugin、scope、key；**默认 global 不按项目隔离**，项目板须显式用 `{server,directory}` scope 或插件自行分区，session scope 则含 server、session ID 和 location。它不是跨窗口实时同步、跨设备共享的权威数据库。协作板应由目标 OpenCode 服务上的 server part 持久化任务，GUI 经已有 `client.rpc` 调用，模型工具复用同一处理逻辑；不必新增整套 Yuri Node 后端插件框架。RPC 请求须显式选 location，事件按 location 过滤，并在断线后重读快照。([Provider.tsx:211–214](../packages/ui/src/lib/gui-plugins/GuiPluginsProvider.tsx#L211)、[storage.ts:15–64](../packages/ui/src/lib/gui-plugins/storage.ts#L15)、[服务端部分边界:263](../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L263)、[官方 RPC](https://opencode.ai/v2/docs/build/plugins/rpc)、[客户端 location/订阅契约](https://opencode.ai/v2/docs/build/client))

## MVP 只补导航，其他能力按明确需求增加

**纯人工 Kanban 的 MVP 不要求新增宿主 API**：用现有页面画列/卡片/拖拽，插件负责数据与排序。人机协作 MVP 增加 server part、任务 tools/RPC、服务端持久化；自动执行型再使用原生 session/事件/权限，不能把 idle 或一轮成功直接解释为业务 Done。

对“任务→原生会话”的闭环，最小宿主建议是**实现尚不存在的 `ctx.tabs.open({server,id},{focus:true})` 子集**，优先对齐已安装官方 SDK，而非另造 `yuri.navigate`。桥接既有导航，并明确当前服务身份、目录解析、未知会话及返回看板行为；不能冒充已支持完整 tabs API，也不能悄悄改变官方后台打开语义。若确需无会话自动选板，可另提议窄契约 `yuri.workspace.current(): {server,directory,projectID?} | undefined`，明确响应式切换与未知状态；这同样是**提议，不是现有接口**。([官方 Tabs 签名:1430–1457](../packages/ui/node_modules/@opencode/plugin/dist/gui/host-apis.d.ts#L1430)、[导航实现:95–112](../packages/ui/src/router/navigation.ts#L95))

**进阶可选**是原生会话嵌入、split-pane、Yuri 工作树 bootstrap/队列整合和终端组件，不是纯 Kanban 的必要条件。移动端目前禁用全局页面；若纳入下一期，只建议先定“单列任务列表/详情、打开关联会话”的独立范围，不承诺桌面多列拖拽或分屏直接可用。([host.ts:324–333](../packages/ui/src/lib/gui-plugins/host.ts#L324)、[UI 边界:344–347](../packages/ui/src/lib/gui-plugins/host.ts#L344)、[Git 编排归属:139–144](../packages/web/server/lib/git/DOCUMENTATION.md#L139))

## 结论：宿主保证连接，插件拥有任务

宿主应拥有权威会话、权限、鉴权传输和挂载生命周期；**列状态机、WIP、任务队列、任务—会话映射、数据库 schema/迁移、Forge 同步不应进入宿主职责**。也不应为模仿 DSH 插件开放 DOM 接管或全平台任意 Node 权限；已有 GUI 共享 DOM 不是安全沙箱。([GUI/native 边界:84–116](../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#L84)、[DSH 官方安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/SAFETY.md#L5-L23))

下一步应验证最小插件闭环，而不是先扩大 API 面：选项目、读写任务、创建并发送会话、处理事件与权限、打开原生会话、返回看板，以及断线/切服务后的恢复。调研日期为 **2026-11-04**；本文综合两份研究笔记并只读核对当前代码，未修改产品源码，未执行 git/GitHub 命令，未安装运行 DSH 插件，未跑测试或各平台运行时验收。
