# DSH Kanban 插件与宿主扩展能力调研

## 一、DSH 是谁、具体有哪些 Kanban 插件？

### Takeaway

可靠的一手来源已确认：DSH 指 **DeepSeek Harness**，宿主为 `deepseek-ai/deepseek-harness`。但“dsh kanban”不是唯一插件名：至少存在多个不同作者、功能边界不同的实现，用户没有提供链接，因此不能断言用户指的是其中哪一个；下文深读两个具有代表性的作者原仓库，而不是把它们拼成一个插件。

### Cited Findings

- 宿主 README 明确写“DeepSeek Harness (`dsh`) is an open-source agent harness developed by DeepSeek AI”，以 Cordis 实现 everything-is-a-plugin，并链接官方文档。宿主源码：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)；文档站：[deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/)；身份原文：[固定提交 README](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/README.md#deepseek-harness)。
- **协作看板 A：**作者原仓库 [`alpacachen/dsh-kanban`](https://github.com/alpacachen/dsh-kanban)，包名 `@alpacachen/dsh-kanban`，本次读取版本 **1.10.1**、提交 **`69fda067f262fe242ff6390542beef229104fc5c`**。功能为人和 Agent 共享 workspace 看板、19 个工具、图片、评论、截止日期；声明兼容 DSH `0.2.0-rc.2 || 0.2.1-rc.3`，Web/Desktop。[package.json](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/package.json)；[README](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/README.md)。
- **执行编排看板 B：**作者原仓库 [`GooDAnDReaDY/dsh-kanban`](https://github.com/GooDAnDReaDY/dsh-kanban)，包名 `@goodandready/dsh-kanban`，本次读取版本 **0.2.39**、提交 **`099a6957b5aac1cd7d854aca2ea3755783cdc9e4`**。包含任务专属 Agent session、代码托管平台集成、worktree 隔离及工作流。[package.json](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/package.json)；[README](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/README.md)。
- **其他真实线索，未进行实现级审计：**[`thomasvvugt/dsh-kanban-flow`](https://github.com/thomasvvugt/dsh-kanban-flow) 自述为按 workspace 分板、按任务创建 session、有人机权限约束；[`StruggleYang/dsh-project-kanban`](https://github.com/StruggleYang/dsh-project-kanban) 自述使用 bundle、host tools、HTTP API、conversation 看板；[`af2000-tech/dsh-taskboard-plugin`](https://github.com/af2000-tech/dsh-taskboard-plugin) 自述为主区域看板、Agent 工具及托管本地服务。它们不能作为 A/B 已验证调用链的替代证据。
- 本次宿主固定提交为 **`8bd073392eef6f54e921a093b95076248eb08cbb`**，根 package 版本 **0.2.2-alpha.3**；README 同时明确提示开发预览和破坏性兼容变更。[package.json L1–5](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/package.json#L1-L5)；[README](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/README.md)。

### Inferences

- 若用户指的是“拖任务卡直接启动不同 Agent、worktree 并行开发”，B 更贴近这个目标；若只是“让当前聊天的计划变成可拖动看板”，A 已足够。不能用 B 的执行能力倒推所有 Kanban 都必需具备同样权限。
- “作者原仓库”不等于“DeepSeek 官方开发插件”。本次没有发现 A/B 由 DeepSeek 官方团队维护的证据。

### Gaps

- 未知用户原本看到的具体插件。建议最终方案保留此不确定性，必要时让用户提供截图或链接。
- 调研日期 **2026-11-04**。提交 SHA 通过只读 GitHub tree 页面嵌入的 `currentOid` 获取；所有深读 raw 源码均固定 SHA。GitHub REST API 返回匿名限流 403，未取得 commit 的服务器时间；**提交时间未知，不推测**。
- 未运行、安装这些插件，未验证它们与当前宿主 0.2.2-alpha.3 的实际兼容性。A 的兼容声明仅覆盖其列出的 RC 版本。这里的版本是仓库 package 字段，不冒充 npm 最新发布版本。

## 二、插件实际调用了哪些宿主能力，哪些不是宿主提供的？

### Takeaway

A 的核心是“正式视图插槽 + workspace 上下文 + 鉴权 HTTP 扩展 + 可持久化后端 + Agent 工具”；它不会因为卡片点击就自主运行 Agent，聊天桥只填草稿。B 才进一步调用 Agent 创建/恢复、事件、权限、workspace 注册；但它的主入口/全屏区域是 DOM 注入，worktree 和 SQLite 则由插件自行实现，不能把这些统称为 DSH 原生 Kanban API。

### Cited Findings

#### A：`@alpacachen/dsh-kanban` 的实际调用矩阵

| 能力 | 实际调用、路径与证据 | 必需性与归属 |
|---|---|---|
| 安装与双端装载 | `dsh.bundle.patch` 指向 `cordis.patch.yml`；patch 插入 host 插件；`dsh.client` 声明 Web 平台及要注入的 client 模块。[manifest](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/package.json)；[patch L1–6](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/cordis.patch.yml#L1-L6) | 在 DSH 内安装和提供前后端能力必需；不是 Kanban 数据模型。 |
| 正式看板视图 | `slots.inject('conversation.view')` → `slots.register({name:'conversation.view',id:'kanban',order:20,label:...}, KanbanView)`。[plugin.ts L11–27](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/plugin.ts#L11-L27) | A 的入口/展示必需；是对话区 Tab，不是独立 OS 全屏窗口或全局 app 页面。 |
| 当前会话与项目上下文 | `PropsRuntime<'conversation.view'>` 取得 `sessionId/useWorkspaces/inputActions`；从 workspace 的 `sessionIds` 找对应 `workspaceId`。[KanbanView.tsx L73–83](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/KanbanView.tsx#L73-L83) | workspace 隔离必需；数据查询 Hook 是宿主提供，关联选择逻辑属于插件。 |
| 浏览器到 host 数据通道 | 同源 `fetch('/api/kanban', POST)`，body 为 `{method,args:{...args,workspaceId}}`。[api.ts L3–13](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/lib/api.ts#L3-L13)；host 以 `ctx.inject(['connection'])`、`connection.fetch.register` 注册路由，采用宿主鉴权扩展，并额外检查 Origin/Host、请求大小、合法 workspace。[index.js L1141–1188](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L1141-L1188) | 共享数据读写必需；宿主提供通道和认证接入，CRUD/输入校验是插件实现。 |
| 持久化 | `ctx.get('fs')` → `fs.resolve/readText/writeText`，每 workspace `.dsh-kanban.json`；`workspaceRegistry.resolveByPath/get/list` 用于工具执行上下文及浏览器 workspaceId 解析。[index.js L383–462](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L383-L462)；[L1087–1107](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L1087-L1107) | 对“重启不丢板”必需；不是通用 `storage` 服务，插件自定 JSON/schema/迁移/备份。 |
| 写入权限 | `sandboxPolicy.resolve({session})` 或 deployment 默认，强制 `workspaceRoot=workspace.path`，传给 `fs.writeText`；图片写入额外拒绝 read-only。[index.js L422–428](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L422-L428)；[L1036–1052](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L1036-L1052) | 持久化写操作的权限约束；不等于整个第三方 Node 插件已被安全沙箱隔离。 |
| Agent 操作看板 | `ctx.tools.register` 暴露 `kanban_*` 19 个工具；`exec.agent.session.header.cwd` 解析当前 workspace；工具和 HTTP 共用 dispatch。[index.js L1087–1138](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L1087-L1138)；[L1337–1758](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L1337-L1758) | 人机共同维护板时必需；纯人工拖拽看板可不需要 Agent 工具。 |
| 卡片送回当前聊天 | `inputActions.setDraft(text)`；带图片时 `conversation.createDrafts`、`input.addAttachments`，失败 `releaseDraftAttachments`。[chat-bridge.ts L3–23](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/lib/chat-bridge.ts#L3-L23) | 可选增强；**只写可编辑草稿，不发送、不启动 Agent**。 |
| 卡片送到新聊天 | `uiWorkspace.openWorkspace(workspaceId, callback)`，callback 记录新 session 待填草稿；在 `conversation.input.dock` 挂 `ChatDraftInjector`，待 composer 就绪填入。[KanbanView.tsx L406–437](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/KanbanView.tsx#L406-L437)；[plugin.ts L29–34](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/plugin.ts#L29-L34)；[ChatDraftInjector](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/components/ChatDraftInjector.tsx) | 可选；队列和跨挂载草稿交接是插件自己的 Map/订阅逻辑。 |
| 原生图片 | host `attachments.imageLimits/saveImage/readImage`；从当前 session 导入已有附件走 `sessionController.attachment({sessionId,attachmentId})`；本地图片先检查 fs.contains。宿主 connection 注册上传/读取路由。[index.js L1031–1084](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L1031-L1084)；[L1260–1270](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L1260-L1270) | 可选；复用宿主对象存储与附件授权，卡片只保存引用。 |
| UI 基础设施 | locale 注册及宿主 UI renderer/primitives 等模块注入在 manifest/client 中声明；CSS 由插件运行时注入。[package.json](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/package.json)；[entry.tsx L1–14](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/entry.tsx#L1-L14) | 本地化/视觉整合可选；manifest 注入声明不等于每项都是核心 Kanban 业务依赖。 |

- A 的排序、拖拽、列/卡片/标签/评论/日期、活动记录、搜索过滤、迁移、串行 mutation 队列及失败回滚，都在插件内实现；宿主没有替它提供 Kanban 状态机。[KanbanView.tsx](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/KanbanView.tsx)；[index.js L687–1028](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L687-L1028)。
- 对完整读取的 A `index.js`、`plugin.ts`、`KanbanView.tsx` 及聊天桥，未看到订阅宿主 session 事件、创建工作树、终端调用或直接 Agent followup；加载/手动刷新/写操作响应更新看板见 `KanbanView.tsx L138–189`。因此不能仅凭 README“shared board”断言它具备事件驱动实时刷新。[相关源码](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/KanbanView.tsx#L138-L189)。

#### B：`@goodandready/dsh-kanban` 的实际调用矩阵

| 能力 | 实际调用、路径与证据 | 必需性与归属 |
|---|---|---|
| Host 依赖与生命周期 | `inject=['settings','webServer','agents','agentDefaultModel','credentials','llm','tools','connection']`；`ctx.effect` 注册与清理服务。[index.js L41–48](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/index.js#L41-L48)；[L241–247](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/index.js#L241-L247) | 当前 B 装载要求；其中凭据等并非所有纯本地看板的产品必需。 |
| 主入口/“全屏”看板 | `querySelector('button[class*="newSession"]')` 克隆按钮，`MutationObserver` 守候侧栏；查询 `[data-pane=conversation], [class*=centerCol]`，追加容器 `ReactDOM.createRoot`，切换 document data 属性。[client.js L4960–5114](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/client.js#L4960-L5114) | **非正式 app-view/全屏 API，是插件 DOM/CSS 接管**；不应作为 Yuri 插槽设计范例照搬。 |
| 真正使用的正式 slots | 设置尝试注册 `plugins.row.config`、`plugins.item`、`settings.plugin.item`，会话任务 chip 注册 `conversation.session.header.utilities`。[client.js L5156–5222](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/client.js#L5156-L5222) | 设置和会话中任务入口的可选整合；不同 slot 是兼容尝试，不意味着所有名字在当前宿主都存在。 |
| 打开关联 session | `ctx.get('sessions')?.open(sessionId)`，缺失返回 false。[client.js L362–372](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/client.js#L362-L372) | 卡片跳聊天可选；属于该插件消费的接口，不应宣称当前宿主版本必然保持兼容。 |
| 执行/恢复 Agent | `agents.get(existingId)` → `agents.resume({resumeSessionId,agentOptions})` → 必要时 `agents.create({sessionId,meta,agentOptions})`；model/provider/reasoningEffort 进入 options；`meta` 含 cwd/projectRoot/worktreePath/branch/workspaceId/agentPreset。[launcher.js L165–296](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/launcher.js#L165-L296) | 自动执行型看板必需；“一任务一 session”、关联表、并发队列/容量预留由插件负责。 |
| 派发指令 | `await agent.whenIdle()` 后 `agent.followup(createUserMessage({content:[{type:'text',text}],source:...}))`；成功后才保存任务执行关联/移动列。[launcher.js L340–469](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/launcher.js#L340-L469) | 自动执行必需；任务提示词模板是插件逻辑，不是宿主 Kanban 执行器。 |
| 执行权限 | 选择权限时调用 `permissionPresets.set(agent.session,name)`；服务不存在或拒绝即中止，不静默采用更宽默认权限；额外 `verifyPermissionGate` 检查人工确认后才排队/执行。[launcher.js L150–162](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/launcher.js#L150-L162)；[L340–349](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/launcher.js#L340-L349)；[services.js L163–174](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/server/services.js#L163-L174) | 权限 API 技术上可选，**一旦用户选定权限则必须成功落实**；人工门禁状态是插件逻辑。 |
| 会话事件 | `ctx.on('session/event',(session,event)=>...)`，处理 turn/start、turn/end/completed/error、session/error 等；按 sessionId 关联任务，过滤 subagent，自动更新列/等待状态/执行结果，结束后调度队列。[services.js L99–179](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/server/services.js#L99-L179)；[lifecycle.js L17–59](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/lifecycle.js#L17-L59) | 自动同步任务状态必需；事件由宿主发，卡片状态映射由插件决定，非“宿主 turn/end 就代表工作 Done”。 |
| 浏览器更新事件 | 自建 `KanbanEventHub`，Node response 写 SSE `event: task:change` 等和心跳；`webServer.register` 接 HTTP。[events.js L1–101](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/events.js#L1-L101)；[index.js L350–428](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/index.js#L350-L428) | 不是直接把宿主事件 stream 给 client；**宿主 session 事件→插件状态→插件 SSE**是两层。 |
| 持久化 | `node:sqlite` 的 `DatabaseSync`，`node:fs` 创建目录/备份/权限；`kanban.db`。[store.js L12–17](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/store.js#L12-L17)；[L198–244](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/store.js#L198-L244) | **插件自管数据库，不是 DSH 通用 storage API**；目录默认从 DSH_HOME/环境变量解析。[index.js L71–74](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/index.js#L71-L74)。 |
| worktree | 插件 `node:child_process.execFile('git',args,...)`；自身创建 task worktree、分支、状态检查和清理；宿主仅 `workspaceRegistry.create(worktreePath,title)` / `.delete(workspaceId)` 让 UI/目录域认识它。[worktree.js L14–35](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/worktree.js#L14-L35)；[L371–390](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/worktree.js#L371-L390)；[launcher.js L210–277](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/launcher.js#L210-L277) | worktree 可通过 `worktreeIsolation=false` 关闭；**不是插件调用 DSH worktrees 服务创建的**，也不是终端 GUI API。 |
| 凭据/配置 | `ctx.credentials.resolve(credentialRef(name))` 仅在 host 解析 token；`settings.describe()` 及 config/settings/volatile-update 事件更新配置；schema 的 token 字段为 `credential-ref`。[index.js L58–67](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/index.js#L58-L67)；[L147–233](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/index.js#L147-L233) | Forge 联动可选；GitHub/Gitea 客户端/同步逻辑由插件自己实现，不是宿主已有 Kanban 同步。 |
| Agent 工具与系统提示段 | `ctx.tools.register(defineTool(...))` 注册 move/plan/checklist/report/comment/decompose 等；可按 `boardToolEnabled` 关闭；`systemPrompt.section({name,order,text})` 追加工作流规则。[services.js L72–97](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/server/services.js#L72-L97)；[L181–207](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/server/services.js#L181-L207) | Agent 主动维护任务时有用；只从 UI 启动任务则不是最低必需。 |

#### 宿主公开契约与插件实现的交叉核对

- 宿主官方 slots 文档明确区分 `root/session-maybe/session` scope；`ctx.slots.inject` 随目标 owner 声明生命周期注册和清理，`PropsRuntime<K>` 合成 owner props、scope props、注入 props；标准 props 包含 session/workspace 查询 Hook。[docs/subsystems/slots.md L21–27](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/docs/subsystems/slots.md#L21-L27)；[L54–118](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/docs/subsystems/slots.md#L54-L118)。
- 当前宿主源码确实声明 `conversation.view` 是 `kind:'list', scope:'session'`；`conversation.input.dock` 同样是 session list；`GlobalStandardProps` 提供 `useWorkspaces`，`SessionStandardProps` 提供 `useInput/inputActions`。这为 A 使用正式扩展契约提供直接证据。[contract/slots.ts L278–296](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/client/ui-conversation/src/client/contract/slots.ts#L278-L296)；[L380–400](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/client/ui-conversation/src/client/contract/slots.ts#L380-L400)。
- 当前宿主的 `sessionController` 负责 Session 命令、冷读取、durable event follow、live control、模型目录、workspace 打开和 Agent activation；源码有 `create`、`attachment`、`follow`、`control`。这属于可用宿主能力，不表示 A/B 都调用了完整 Session API。[capability-seams.md L682](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/docs/capability-seams.md#L682)；[session-controller L304–305](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/api/session-controller/src/index.ts#L304-L305)；[L497–498](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/api/session-controller/src/index.ts#L497-L498)；[L607–629](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/api/session-controller/src/index.ts#L607-L629)。
- 当前宿主另有实验性 `ctx.worktrees`，其文档强调 pinned commit、本地工作树和既有写权限；但 B 上面核对的创建路径走的是插件直接 Git，不走该 seam。区分“宿主今天有此能力”与“插件实际使用此能力”。[capability-seams.md L666](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/docs/capability-seams.md#L666)。
- 官方 SAFETY 明确：第三方插件可接触进程/文件/凭据/网络，未经过安全审计，sandbox/approval/permission 不保证隔离。不能把 B 的权限下拉或 A 的 fs policy 当成“插件本体零信任沙箱”。[SAFETY.md L5–23](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/SAFETY.md#L5-L23)。

### Inferences

- DSH 真正使 Kanban 成立的是：UI 可组合挂载、可获得会话/工作区上下文、host 可持有持久化状态并向 UI/Agent 暴露相同业务操作；自动执行型才进一步依赖 session lifecycle 与权限控制。
- “宿主提供终端”并不是这两个样例的 Kanban 必要条件。B 的 worktree 管理使用 Node child process；Agent 执行代码时可能使用它自己的工具，但不能从这一点推导 Kanban UI 直接消费终端控制 API。
- B 的业务状态机、queue/WIP、task-session 映射、Git/Forge 同步、提示词、SSE、存储都不适合作为宿主必须内置的 Kanban 专用对象；它们可以归插件所有。

### Gaps

- 没有运行时验证，不能把 README 功能描述或源码的预期路径当成已经成功执行的行为。
- **静态代码质量警告：**B 固定提交的 `server/services.js` 在 `if (autoSyncSessions...)` 块中 `let existingTask`（L112），随后在该块外 `if(existingTask)`（L144）引用；外层 catch 会捕获此 ReferenceError。这可能使后续 lifecycle/排队调度路径无法执行。这里只标注静态发现，不把其预期事件能力宣传为已验证可运行。[源码 L99–179](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/server/services.js#L99-L179)。
- 尚未逐一审计 B 所有可选集成、远程执行、workflow engine、暂停/终止的完整契约和安全边界。已核对的核心实际调用足以支撑“展示型”和“执行型”的分层，但不能据此给出整个插件完整安全评估。

## 三、据此应向 Yuri 插件开放哪些通用能力？

### Takeaway

以下是**由 DSH 样例推导的能力清单，不是对 Yuri 当前缺口的既定结论**。先提供通用“主区域页面 + workspace/session 上下文 + host 业务桥/持久化 + Agent 工具”，再按执行型需求补“会话控制/事件/权限/工作树”；不应照搬 B 的 DOM 接管、插件任意 Node 执行或新增一套 Kanban 专用 Agent 后端。

### Cited Findings

- 最小展示/协作实现的实证组合：A 的正式 `conversation.view` 与 `input.dock`、workspace props、host connection 路由、fs 持久化及 `tools.register`。[plugin.ts L11–34](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/src/client/plugin.ts#L11-L34)；[host 核心](https://github.com/alpacachen/dsh-kanban/blob/69fda067f262fe242ff6390542beef229104fc5c/index.js#L1087-L1188)。
- 执行型新增能力的实证组合：B 的 `agents.create/resume/get`、`whenIdle/followup`、session event、permission preset、workspace registry。[launcher.js L165–296](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/launcher.js#L165-L296)；[L404–409](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/launcher.js#L404-L409)；[services.js L99–179](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/server/services.js#L99-L179)。
- 必须避免的反例：B 主区域通过 DOM/className 查找和 MutationObserver 接管；宿主正式 slots 已具备作用域、生命周期、注入规则，更应由宿主提供稳定页面承载位。[B client.js L4960–5114](https://github.com/GooDAnDReaDY/dsh-kanban/blob/099a6957b5aac1cd7d854aca2ea3755783cdc9e4/lib/client.js#L4960-L5114)；[宿主 slots 文档](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/docs/subsystems/slots.md)。

### Inferences

#### 建议以能力分层做 Yuri 缺口比对

| 层级 | 给插件的通用契约 | Kanban 所需场景 | 是否最低必需 |
|---|---|---|---|
| P0 页面承载 | 稳定的主区域/global/workspace 页面注册与导航；可选 sidebar/header action；显式 title/icon/active/close/dispose；不依赖当前必须存在 session | 点入口打开完整看板；无会话也能规划 | 是；具体入口位置可任选其一，OS 全屏窗口不是必需 |
| P0 上下文 | runtimeId、workspaceId、project/worktree directory、选中 session、可订阅 selector；切换 runtime/workspace 后使旧请求失效 | 每项目一板、避免跨 runtime 数据串用 | 是 |
| P0 host 业务桥 | 已认证、按插件命名空间隔离的 RPC/route/command；浏览器和 Agent 工具调用同一业务处理函数；取消/错误/生命周期契约 | 卡片 CRUD、共享状态、人机一致 | 对前后端分离插件是；并非必须开放任意 HTTP handler |
| P0 持久化 | plugin/runtime/workspace 命名空间 storage 或受限 workspace 文件访问；有版本、事务/原子写、失败语义 | 重启恢复、并发/回滚 | 对持久化看板是；不必让浏览器直接访问本机文件/SQLite |
| P0/1 Agent tools | 允许插件注册 schema 化工具，得到可信 session/workspace/signal；定义 scoped exposure 与权限 | Agent 写卡、查卡、更新状态 | 人机协作是，纯人工板不是 |
| P1 会话导航/草稿 | open/create session、设置输入草稿、附件 draft 生命周期；明确不自动发送 | 点卡回聊天、用户审查后派发 | 可选；不要把“填草稿”和“立即执行”混成一个 API |
| P1 执行控制 | 复用宿主/OpenCode 原生 create/resume/send/steer/abort；传 agent/model/worktree；返回正式 session/run 标识 | 拖到 Doing 自动启动、继续/取消 | 自动执行型必需；不要另起插件 Agent 循环 |
| P1 live events | scoped session/run 状态、waiting/approval/question/error/completed，含重连/快照；任务工具变更后 UI invalidation | 自动进度、等待人工、状态恢复 | 自动同步必需；仅 UI CRUD 可先不用 |
| P1 权限 | capability 授权、服务端执行门禁、指定权限 fail-closed；用户拒绝/缺失权限不得启动 | 读写项目、执行 shell、升级权限 | 自动执行型必须明确；不靠按钮是否可见保证安全 |
| P2 工作树 | 通用 create/list/inspect/remove worktree、绑定目录和 session、dirty-check/清理保护；返回权威 workspace identity | 并行任务隔离开发 | 可选；不要为此默认开放插件任意 child_process |
| P2 图片/资源 | 复用已有附件对象、限额、授权读取、引用与 draft 交接 | 截图任务/图像上下文 | 可选 |
| P2 凭据/外部系统 | host-only credential refs、受授权网络出口、插件设置与事件 | GitHub/Gitea/Jira 同步 | 可选；不要把凭据传进前端或 URL |
| 非最低项 | 终端 GUI、独立 native 全屏窗口、宿主内建 Kanban schema、宿主内建任务 WIP/队列策略 | 特殊高级体验 | 两个样例都不支持把这些认定为 Kanban 基础要求 |

- 建议先明确要做 **A 型协作板** 还是 **B 型执行编排板**；两个产品目标的最小 API 面差别很大。以上 P0/P1/P2 是建议优先级，不是 DSH 官方术语。
- 状态归属建议：插件 owns board/card/column/order/checklist/task-session 映射；宿主 owns runtime/workspace/session 的权威身份、执行生命周期、权限、鉴权 transport、资源访问和页面挂载生命周期。通过事件和能力接口连接，不复制 session 执行状态。
- 对 Yuri 的真实缺口应由另一份本仓库能力审计逐项标“已开放／内部已有但未开放／完全缺失”，不能把本表全部列为新增需求。

### Gaps

- 本笔记严格聚焦 DSH 外部研究，**未审计 Yuri 当前 Registry、slots、RuntimeAPIs、OpenCode SDK 或插件桥**，因此未知上述每项 Yuri 是否已经具备。
- 未验证移动端/VS Code/远程 runtime 的这些 API 行为；设计时需分别明确可用、禁用或 host 代理，不能从 DSH Web/桌面声明外推。
- Context7 已按要求先 resolve `DeepSeek Harness`，再 query `/deepseek-ai/deepseek-harness` 的 slots/runtime props 文档；检索结果用于发现路径，最终证据均优先引用上述固定 commit 原源码。未运行 git、GitHub CLI 或产品代码；未修改产品源码、未创建 issue。
