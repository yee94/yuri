# Yuri onboarding、历史与项目设定导入边界调研

调研日期：2026-11-06。只读检查仓库代码、相邻模块文档、已安装客户端类型，以及必要的相邻 OpenCode 仓库源码；没有读取用户聊天、数据库或凭据，没有运行 git/GitHub 命令，没有修改产品源码或执行导入。以下“建议/推断”不是已实现功能。证据链接使用仓库相对路径；显示文字保留 `file:line` 方便复核。

## 一、现在到底有几步？“语音挪到第 4 步、在第 4 步导入”如何理解？

### Takeaway

当前配置向导只有 **模型 → 扩展工具 → 语音** 三步。用户的两句“第 4 步”存在语义歧义，不能擅自选一种实现；导入可作为独立第 3 步，也可与语音合成末步，但后者仍需确认第 3 步是什么。

### Cited Findings

- 真实导航数组是 `['tour.models', 'tour.plugins', 'tour.voice']`，渲染序号为数组下标加一；语音读配置和主体条件是 `step === 2`。证据：[SetupTourDialog.tsx:33](../../packages/ui/src/components/onboarding/SetupTourDialog.tsx#L33)、[SetupTourDialog.tsx:111-125](../../packages/ui/src/components/onboarding/SetupTourDialog.tsx#L111)、[SetupTourDialog.tsx:162-165](../../packages/ui/src/components/onboarding/SetupTourDialog.tsx#L162)、[SetupTourDialog.tsx:199-225](../../packages/ui/src/components/onboarding/SetupTourDialog.tsx#L199)。
- 第 1 步 Magpie 写插件配置后继续，不等安装/模型可用；其他 Provider 复用 `ProvidersPage`，前进前检查权威模型目录。第 2 步是推荐插件 Eficy、yee-profile，保存后继续，不等待后台激活。证据：[onboarding/DOCUMENTATION.md:34-53](../../packages/ui/src/components/onboarding/DOCUMENTATION.md#L34)、[SetupTourDialog.tsx:126-144](../../packages/ui/src/components/onboarding/SetupTourDialog.tsx#L126)。
- 第 3 步包含独立 ASR 输入、TTS 朗读编辑器和豆包合并快捷配置；豆包提交成功目前直接 `finish()`，页脚和“稍后”也把 `step === 2` 当最终步。并非只改导航文案即可插入新步。证据：[SetupTourDialog.tsx:69-88](../../packages/ui/src/components/onboarding/SetupTourDialog.tsx#L69)、[SetupTourDialog.tsx:123-125](../../packages/ui/src/components/onboarding/SetupTourDialog.tsx#L123)、[SetupTourDialog.tsx:169-171](../../packages/ui/src/components/onboarding/SetupTourDialog.tsx#L169)、[SetupTourDialog.tsx:231-236](../../packages/ui/src/components/onboarding/SetupTourDialog.tsx#L231)。
- 持久化类型是 `0 | 1 | 2`，反序列化只接受 `[0,1,2]`；按连接实例存 step/dismissed，不存语音密钥。证据：[useSetupTourStore.ts:6-7](../../packages/ui/src/stores/useSetupTourStore.ts#L6)、[useSetupTourStore.ts:30-44](../../packages/ui/src/stores/useSetupTourStore.ts#L30)、[onboarding/DOCUMENTATION.md:59-65](../../packages/ui/src/components/onboarding/DOCUMENTATION.md#L59)。
- 配置向导在连接后挂载：桌面/Web 自动，Host-backed 手机仅手动，独立 VS Code、Mini Chat、embedded 不挂载。首次资格依赖 settings hydration 和成功的 Yuri 项目列表；已存在项目会抑制自动向导。证据：[SetupTourHost.tsx:28-48](../../packages/ui/src/components/onboarding/SetupTourHost.tsx#L28)、[onboarding/DOCUMENTATION.md:9-30](../../packages/ui/src/components/onboarding/DOCUMENTATION.md#L9)。
- 另有连接前/恢复/全文索引的全屏 `OnboardingScreen`，其 mode 不是配置向导的第 1/2/3 步。全文索引屏不能当作当前缺失的第 4 步。证据：[OnboardingScreen.tsx:9](../../packages/ui/src/components/onboarding/OnboardingScreen.tsx#L9)、[OnboardingScreen.tsx:59-63](../../packages/ui/src/components/onboarding/OnboardingScreen.tsx#L59)、[onboarding/DOCUMENTATION.md:3-5](../../packages/ui/src/components/onboarding/DOCUMENTATION.md#L3)。

### Inferences

- **解释 A（满足“语音从 3 移 4”）**：1 模型、2 工具、3 导入历史与项目设定、4 语音。此处“在第 4 步增加导入”被理解为“增加一个步骤后的引导”，不是字面上的同一第 4 步，需要用户确认。
- **解释 B（满足“第 4 步增加导入，最好合并”）**：第 4 步合并“导入与语音”两个可独立跳过的区块；但当前不存在可自然保留的第 3 步，必须追问是要另加项目初始化作为第 3 步，还是其实希望保持三步并合并末步。不能为凑四步擅自发明一页。
- “最好合并”还可能仅指**把导入对话和导入项目设定合成同一导入页**，而不是把语音与导入合页。建议确认这句话的对象。
- 步数调整必须迁移持久化语义（旧 index 2 是语音），并修改终步判断、豆包保存回调和读配置触发条件；否则旧进度会跳错页。依据上述 store 和终步分支。

### Gaps

- 尚未得到用户对两种步序及“合并”对象的确认。本次不改变步骤。

## 二、已有导入与 SDK 写入能力能复用到什么程度？

### Takeaway

本次针对产品入口的检索未发现 Codex/Cursor/Claude Code/DeepSeek Harness 的历史转换器或会话导入 UI。**但已安装官方 V2 客户端确实具有 `client.session.import/export`**；应复用其历史写入边界，而不是把旧消息逐条发给 `prompt`。官方导入是“创建一个完整新会话”，不是给已有会话追加消息。

### Cited Findings

- 当前真实依赖已经是 `@opencode/client`、`@opencode/schema`，并非一些旧模块文档写的 `@opencode-ai/sdk/v2`。共享客户端和 conversations service 都从 `@opencode/client` 导入 `OpenCode`。证据：[ui/package.json:52-54](../../packages/ui/package.json#L52)、[client.ts:1-2](../../packages/ui/src/lib/opencode/client.ts#L1)、[conversations/service.js:1](../../packages/web/server/lib/conversations/service.js#L1)；相较之下，[conversations/DOCUMENTATION.md:4](../../packages/web/server/lib/conversations/DOCUMENTATION.md#L4) 的旧包名已滞后。
- 已安装客户端声明 `session.import(input): Promise<SessionInfo>` 与 `session.export(input): Promise<SessionTransferData>`。证据：[client.d.ts:34-38](../../node_modules/@opencode/client/dist/promise/generated/client.d.ts#L34)。这是本地安装包证据，不是假设上游未发布源码可用。
- 官方文档列出 `POST /api/experimental/session/import` 和 `GET /api/experimental/session/{sessionID}/export`；导入父会话须先存在。已通过 Context7 先 resolve，再 query `/websites/opencode_ai/v2` 获取此文档。证据：[官方 V2 API](https://opencode.ai/v2/docs/api)、[本地上游协议 session.ts:188-215](../../../opencode/packages/protocol/src/groups/session.ts#L188)。
- 本地客户端 `SessionImportInput.info` 是必填，包含 id、projectID、cost、tokens、time、location 等；`messages` 的生成输入类型虽为 `JsonValue[]`，不表示服务器接受任意其他产品 JSON。上游协议会以原生消息 schema/兼容转换解码。证据：[types.d.ts:3976-4014](../../node_modules/@opencode/client/dist/promise/generated/types.d.ts#L3976)、[types.d.ts:4015-4045](../../node_modules/@opencode/client/dist/promise/generated/types.d.ts#L4015)、[上游协议 session.ts:50-53](../../../opencode/packages/protocol/src/groups/session.ts#L50)、[上游协议 session.ts:188-193](../../../opencode/packages/protocol/src/groups/session.ts#L188)。**Context7 摘要把 info 标为 optional，与本地生成类型/协议不一致，应以实际契约为准。**
- 上游导入检查目标 session ID 是否已存在，存在即冲突；HTTP 映射为 409。然后验证 parentID 存在，根据目标 location 重新解析 projectID/subpath。证据：[transfer.ts:67-82](../../../opencode/packages/core/src/session/transfer.ts#L67)、[handlers/session.ts:121-140](../../../opencode/packages/server/src/handlers/session.ts#L121)。
- 消息按导入数组次序写 seq，保留消息 id 和 created 时间；仅 settled 消息进入导入/导出：assistant 必须有 completed 时间，shell/compaction 不能 running。会话 created 保留原值，updated 改为导入时刻。证据：[transfer.ts:60-65](../../../opencode/packages/core/src/session/transfer.ts#L60)、[transfer.ts:83-93](../../../opencode/packages/core/src/session/transfer.ts#L83)、[transfer.ts:149-175](../../../opencode/packages/core/src/session/transfer.ts#L149)、[transfer.ts:202-205](../../../opencode/packages/core/src/session/transfer.ts#L202)。
- 导入发布原生 `SessionEvent.Created`，创建数据含 parentID/location/projectID/title/agent/model/metadata/permissions，并在提交回调存消息；内联媒体只有实际随包携带的 bytes 才可能建立 blob 引用，不能凭外部 hash 引用目标原有媒体。证据：[transfer.ts:95-144](../../../opencode/packages/core/src/session/transfer.ts#L95)。
- 原生 assistant 不是 Yuri UI 的旧式 `{info,parts}`：它要求 `type:'assistant'`、agent、model、content，以及时间等；SessionInfo 又包含 fork/revert 等字段。证据：[types.d.ts:3473-3498](../../node_modules/@opencode/client/dist/promise/generated/types.d.ts#L3473)、[types.d.ts:2989-3014](../../node_modules/@opencode/client/dist/promise/generated/types.d.ts#L2989)。
- 现有 `/api/yuri/conversations` 服务创建会话后提交首个 prompt，`delivery:'steer'`；这会进入正常执行流程，不是历史存档。真实 create 调用只传 location/title/agent/model，**没有转发文档中声称支持的 parentID/metadata**。不能把该服务当作保存导入父子图的既成能力。证据：[service.js:36-61](../../packages/web/server/lib/conversations/service.js#L36)、[service.js:152-169](../../packages/web/server/lib/conversations/service.js#L152)、[service.js:201-202](../../packages/web/server/lib/conversations/service.js#L201)；对比[模块文档:35-54](../../packages/web/server/lib/conversations/DOCUMENTATION.md#L35)。
- conversations 幂等 registry 是进程内、完成结果仅保留五分钟，不是跨重启导入账本。证据：[conversations/DOCUMENTATION.md:15-24](../../packages/web/server/lib/conversations/DOCUMENTATION.md#L15)。
- 现有 Markdown 导出提取 text parts 并按人类阅读形式输出，支持子会话章节，但不是原生 SessionTransfer 备份。证据：[exportSession.ts:9-14](../../packages/ui/src/lib/exportSession.ts#L9)、[exportSession.ts:50-84](../../packages/ui/src/lib/exportSession.ts#L50)。
- 当前 RuntimeAPIs 提供 files/settings/conversations 等，没有专门历史导入能力；本次对 `packages/**/*.{ts,tsx,js,mjs}` 检索 `session/import|importSession|session.import|experimental.session.import|claude.*import|codex.*import|conversation.*import` 仅命中 Magpie 的 Codex **授权**导入调用，不应误认作历史导入。证据：[api/types.ts:1280-1301](../../packages/ui/src/lib/api/types.ts#L1280)、[config-sync/DOCUMENTATION.md:95-99](../../packages/web/server/lib/config-sync/DOCUMENTATION.md#L95)。检索结论仅限这些关键词与范围。

### Inferences

- 推荐 Host-owned 导入领域模块：来源适配器 → 统一中间模型 → 预览/选择/路径映射 → 原生 schema 校验 → 官方 `session.import` → 收据/索引校验。共享 UI 只负责任务交互；不写 OpenCode SQLite，不把外部日志伪装成执行事件。
- 字段映射至少覆盖 role/type、时间、agent/model 标识、工具调用和结果、附件、父子图。来源缺失 cost/tokens 或模型身份时，要使用明确、可追溯的未知/占位策略并在预览披露，不能假装真实计费/可用模型。只导入文本可作为降级，不可宣称无损。
- 不能自动“补 completed”把未完成调用冒充成功；应预览未完成记录的跳过/只读文本降级。未知原生 provider payload、工具可执行命令、目标不存在的文件 URI 要隔离，不能执行或暗中读取。
- 上游 transfer 的 Created payload/最终列更新未覆盖所有 Info 字段（例如 fork/revert 未见对应写回）；**不能仅凭输入类型含 fork/revert 就宣称分叉边界、快照、回滚可无损恢复**。应先用隔离 fixture 验证；否则原始身份留在来源 metadata/导入清单，UI 告知是历史记录，不是可重放工作树。
- 当前兼容运行底线是 2.0.20，而本地 client 较新，不能推断每台远端都有 import endpoint。应能力探测并区分 unsupported 与 auth/network/error，而非静默落到 prompt。底线证据：[opencode/DOCUMENTATION.md:48](../../packages/web/server/lib/opencode/DOCUMENTATION.md#L48)。

### Gaps

- 本次没有向运行实例发请求，所以未验证目标 Host 的具体 import 能力、导入后的继续对话和跨供应商工具投影。
- 四种来源的实际存储协议、版本差异和 DeepSeek Harness 的具体产品身份属于来源研究；本笔记不凭名称推定其目录、数据库格式或可恢复程度。
- 无历史写入/追加接口的“绝对不存在”证明：已核实公开导入为 create-only，不能把它当 append；如需 append，仍须另核官方契约，不能自行直写数据库。

## 三、项目/工作树/父子身份如何保留？重复导入与“合并”有哪些层次？

### Takeaway

必须分开 **来源身份、目标项目路径、目标 OpenCode 会话 ID**。最安全的“合并”是多个来源归到同一个项目、保持各自会话/父子关系；不是按标题或相似文本把不同对话拼成同一消息流。

### Cited Findings

- Yuri 已有注册现有目录的 owner：验证/规范化路径、按路径找已有项目、用确定性 path-derived ID，新项目 append，已有项目不覆盖；持久化在 settings 独占读改写中完成。证据：[projects/registry.js:11-32](../../packages/web/server/lib/projects/registry.js#L11)。
- 注册不创建文件夹、不 clone；已有顺序、标签、元数据和暂不可用目录需保留。项目注册与 OpenCode 自动发现的 project 目录不是同一份 catalog。证据：[projects/DOCUMENTATION.md:3-24](../../packages/web/server/lib/projects/DOCUMENTATION.md#L3)、[onboarding/DOCUMENTATION.md:14-17](../../packages/ui/src/components/onboarding/DOCUMENTATION.md#L14)。
- WorktreeMetadata 区分 `path`、`projectDirectory`、branch，以及 worktreeRoot、状态、existing/created-for-session 来源。证据：[types/worktree.ts:1-50](../../packages/ui/src/types/worktree.ts#L1)。
- 本地 OpenCode 的物理路径/符号链接可由 Host 规范化；缺失目录保留词法身份，远程 upstream 不使用 Host 文件系统猜路径；显式目录分页不能混入兄弟工作树。证据：[session-index/DOCUMENTATION.md:25-46](../../packages/web/server/lib/session-index/DOCUMENTATION.md#L25)。
- 导入 parentID 只验证父已存在；不负责一批树状导入，也不会替调用方重新映射外来 ID。目标 projectID/subpath 根据显式 location 计算。证据：[transfer.ts:68-93](../../../opencode/packages/core/src/session/transfer.ts#L68)、[官方 API](https://opencode.ai/v2/docs/api)。
- 元数据最终权威在 OpenCode session record。原生 PATCH 是整体替换 metadata；Yuri 的 owner 提供序列化 JSON Merge Patch、提交后发布、失败保持旧状态。证据：[session-metadata/DOCUMENTATION.md:3-19](../../packages/web/server/lib/session-metadata/DOCUMENTATION.md#L3)、[session-metadata/DOCUMENTATION.md:56-69](../../packages/web/server/lib/session-metadata/DOCUMENTATION.md#L56)。

### Inferences

- 建议导入映射表至少有：`targetRuntimeIdentity + sourceKind + sourceInstallation/exportNamespace + sourceProjectID/sourceRoot + sourceSessionID → targetProjectPath/targetWorktreePath/targetSessionID`，消息另有 sourceMessageID → targetMessageID。来源命名空间必须包含实例/导出源，避免两个客户端安装产生同 ID 冲突。不要把文件路径当唯一跨机器身份，也不要把 git remote URL 当唯一项目身份。
- 路径映射让用户确认：来源 repo root → 目标 root；每个工作树/子目录单独映射；不能把所有 cwd 都压到当前目录。目标目录缺失时选择重新定位/显式创建或跳过，不把“登记历史路径”伪装成“已 clone 项目”。Git 内容/branch/commit/worktree 的重建是额外能力，不是聊天导入的副作用。
- 根会话先导入、子会话拓扑排序后导入；缺父/环要显式报错或用户选择独立根降级。重写 parentID、工具中的子会话引用、消息引用时使用完整 ID 映射，不只重写顶层会话 ID。
- 原生 `parentID` 的子 Agent 关系与 `fork.sessionID/boundary` 的分叉关系不同；来源 UUID、分支/快照信息可保留来源 metadata，不得把 fork 一律当 child。
- 推荐合并层次：
  1. **UI 合并**：对话与项目设定在一个导入页勾选，分别报告成功/失败。
  2. **项目归并**：多个来源映射同一个已验证目标项目目录；会话仍独立，目录/工作树身份不丢。
  3. **配置归并**：按作用域、实体/文件逐项合并并预览冲突。
  4. **同源重复跳过**：相同稳定来源 identity + 相同规范化内容哈希 → 返回之前收据，不再次导入。
  5. **同源更新**：同 identity 但哈希变化 → 提示“来源更新”，默认保留目标并允许导入新修订，不能假称官方 import 可 append。
  6. **跨来源消息流合并**：仅在用户明确选择并确认共同前缀/顺序/分叉/工具引用后，离线构造一个新的目标会话；保留原来源并列可审计。按同标题、近似文本、时间接近自动合并不可取。
- 持久导入账本应与目标 runtime 分区，存来源标识、摘要哈希、映射与状态，不存凭据/原始聊天副本；跨重启、超时后重试先查收据并核验目标。官方 409 只能证明 ID 冲突，不能证明内容相同、导入已成功或允许覆盖。
- 一个会话为提交单位，批次允许部分成功；父失败阻塞其子，不阻塞其他家族。不承诺聊天、项目注册、配置文件、跨会话树的全局事务。回滚只针对本次新建且核验未被用户继续修改的资源。

### Gaps

- 当前没有历史导入账本与四类来源映射策略的实现证据；以上是设计建议。
- 未验证源模型 ID 在目标 Provider 上是否存在，也未验证跨项目 child 的 UI/执行语义；应隔离测试，不靠字符串相同推断兼容。

## 四、历史索引与各 runtime 的文件可用性有什么硬边界？

### Takeaway

**把历史写入 OpenCode，不等于全部历史都进入搜索。** 所有客户端可共享 Host 导入结果，但来源文件发现取决于文件究竟在浏览器设备、Electron 本机、Extension Host，还是远程 OpenCode 主机上；不能混淆“当前客户端本机”和“当前连接 Host”。

### Cited Findings

- session-index 是 runtime/目录分区的 SQLite **摘要**，每目录最多 20 个 root，独立 pin 和 child membership，不存消息/附件/权限配置。冷启动默认做一趟近 30 天的 global backfill，完成后不再启动全目录扫描；后续依靠事件/显式刷新。证据：[session-index/DOCUMENTATION.md:55-74](../../packages/web/server/lib/session-index/DOCUMENTATION.md#L55)、[session-index/DOCUMENTATION.md:123-166](../../packages/web/server/lib/session-index/DOCUMENTATION.md#L123)。
- content-search 独立于浏览器 cache，默认近 30 天、root session，只索引 user 文本/已完成 assistant 文本，assistant 摘要最多 2048 字符；不含 child、reasoning、工具、附件、synthetic 等。证据：[content-search/DOCUMENTATION.md:3-22](../../packages/web/server/lib/content-search/DOCUMENTATION.md#L3)。
- content-search 完成初始化后从持久 dirty queue 增量刷新，失败保留旧结果；全屏索引 onboarding 不是外部聊天导入，不需要 UI 转换 OpenCode 数据库。独立 VS Code 没有 Host FTS，也不挂这个屏。证据：[content-search/DOCUMENTATION.md:30-44](../../packages/web/server/lib/content-search/DOCUMENTATION.md#L30)、[content-search/DOCUMENTATION.md:73-107](../../packages/web/server/lib/content-search/DOCUMENTATION.md#L73)。
- transcript SQLite 只是可删可重建的 opt-in 本地加速缓存，不是权威；浏览器 durable transcript 同样 runtime/directory/session 分区并受 LRU 预算。证据：[transcript-cache/DOCUMENTATION.md:3-19](../../packages/web/server/lib/transcript-cache/DOCUMENTATION.md#L3)、[sync/DOCUMENTATION.md:67-71](../../packages/ui/src/sync/DOCUMENTATION.md#L67)。
- Web FilesAPI 的 list/read/stat 调 `runtimeFetch('/api/fs/...')`，也就是所连接服务的文件空间；FS 写入有 workspace 边界，不能因为导入页能列目录就直接获得任意位置写权限。证据：[web/api/files.ts:57-79](../../packages/web/src/api/files.ts#L57)、[web/api/files.ts:118-173](../../packages/web/src/api/files.ts#L118)、[fs/DOCUMENTATION.md:29](../../packages/web/server/lib/fs/DOCUMENTATION.md#L29)。
- Electron 后端与 main 同进程，renderer 通过 preload 使用受权能力；现有 `requestFileAccess`/`requestExistingFileAccess` 仅在 **desktop local origin active** 才提供原生文件授权，远程连接时直接 unavailable。证据：[electron/README.md:18-32](../../packages/electron/README.md#L18)、[desktop.ts:647-684](../../packages/ui/src/lib/desktop.ts#L647)、[desktop.ts:687-708](../../packages/ui/src/lib/desktop.ts#L687)。
- VS Code FilesAPI 在 webview 通过 `api:fs:*` bridge 与 Extension Host 通信；独立扩展允许连接外部 OpenCode，而它的项目 registry 和语音/FTS 能力与 Host-backed UI 不同。证据：[vscode/webview/api/files.ts:15-25](../../packages/vscode/webview/api/files.ts#L15)、[vscode/README.md:49-52](../../packages/vscode/README.md#L49)、[onboarding/DOCUMENTATION.md:27-30](../../packages/ui/src/components/onboarding/DOCUMENTATION.md#L27)、[content-search/DOCUMENTATION.md:93-94](../../packages/web/server/lib/content-search/DOCUMENTATION.md#L93)。
- 手机只打包 UI，不嵌 Yuri/OpenCode server；iOS/Android sandbox 无法读取其他应用旧沙盒，Host 历史随重连恢复。证据：[mobile/README.md:63-72](../../packages/mobile/README.md#L63)、[mobile/README.md:106-119](../../packages/mobile/README.md#L106)。
- 原生 import 路由不在 Yuri 普通 JSON parser allowlist，当前 `/api` 其余路径保留给 generic proxy；现有自有 conversations 路由现在实际限制是 **72 MiB**，而模块文档写 50 MB 已滞后。证据：[core-routes.js:1203-1211](../../packages/web/server/lib/opencode/core-routes.js#L1203)、[core-routes.js:1239-1240](../../packages/web/server/lib/opencode/core-routes.js#L1239)、[conversations/DOCUMENTATION.md:9](../../packages/web/server/lib/conversations/DOCUMENTATION.md#L9)。不能据此推断大批历史可无限透传。

### Inferences

推荐来源能力矩阵（下表是基于上述实现边界的产品建议，不是已有导入入口）：

| 客户端 / 目标 | 可作为来源的文件 | 建议入口 / 限制 |
| --- | --- | --- |
| Web（本地/远端 Host） | Host 可读目录；浏览器用户明确选择的导出文件 bytes | 分开“从当前服务器发现”与“上传此设备导出”；不能后台扫描浏览器设备 home。浏览器目录/SQLite 选择和转换能力仍需实现。 |
| Electron 本机连接 | 本机受权文件 / Host 文件 | 可复用原生选文件授权与 Host parser；不能借普通文件预览绕过二进制 SQLite 的安全/一致性读取。 |
| Electron 远程/SSH/Relay | 远程 Host 文件；本机来源若要传远端，需要独立明确授权的 source owner | 当前本机 picker helper 在远程禁用，不能声称现成可用；设计上需明确“本机读取 → 传给哪个 Host”，与远端路径分离。 |
| hosted mobile / Capacitor | Host 上的来源；手机手选的可导出文件 | 手机不应自动发现电脑的 Codex/Cursor 历史，也不能读取其他 app 私有数据库。可复用 Host 导入服务，但手选/上传入口不是已实现能力。 |
| 独立 VS Code | Extension Host 可访问的文件；不保证与所连 OpenCode 同机 | 没有现成 tour；如未来开放导入，增加独立命令/设置入口，并显式校验 Extension Host 与目标 Location 命名空间，不能复用 Host-only 路由假装支持。 |

- 导入成功应明确区分：原生会话可打开、项目登记成功、索引摘要可发现、全文搜索覆盖。旧于 30 天的消息即使所属 session.updated 刚变成导入时刻，也不会自动变成近 30 天消息；child/tool/reasoning 仍不在现有全文检索覆盖中。
- import 发布 created 事件可复用现有事件链，但必须在隔离 fixture 检查最终历史时间与摘要一致，防止只看到事件创建时间。批次结束可触发**有界且只针对已导入目录/会话**的权威刷新，不能清空/伪造本地 index/cache 以制造“已导入”效果。
- 需要对大文件/批量任务提供 Host 后台 job、分会话提交、进度/取消/重连恢复、大小/条数/深度预算；Relay 的现有传输不等于已经验证大历史导入、sqlite 快照或断点续传。

### Gaps

- 未执行 web/desktop/mobile/VS Code 的平台测试；上述矩阵不是平台端到端验收结果。
- 未核实 Cursor 等来源运行中 SQLite 的锁/WAL 快照策略；不能直接 copy 单个 `.db` 作为一致完整历史。
- 未验证 import 事件触发现有 FTS dirty 流的具体时序和超大请求路径；应实现前补 fixture/协议测试。

## 五、项目设定如何安全导入、避免凭据泄露与配置冲突？

### Takeaway

配置导入应是**显式选择的、作用域清晰的转换计划**，不是复制另一产品整个 home。可复用 Yuri 现有 JSONC physical-source writer、项目注册、配置同步的 allowlist/预览/备份理念；不能直接把跨 OpenCode 实例 config-sync 当作四种外部客户端的兼容转换器。

### Cited Findings

- 现有 config-files 解析 JSONC（允许尾逗号），错误抛出；区分 user/custom/祖先 project/`.opencode` 文档，保留物理来源并计算 merged snapshot。证据：[config-files.js:13-35](../../packages/web/server/lib/opencode/config-files.js#L13)、[config-files.js:50-85](../../packages/web/server/lib/opencode/config-files.js#L50)。
- Web/VS Code 共同复用 physical-source 配置 owner，结构化写入保留无关注释、备份、验证与原子替换；不能把合并快照盲写为全局配置。证据：[vscode/DOCUMENTATION.md:42-55](../../packages/vscode/src/DOCUMENTATION.md#L42)、[opencode/DOCUMENTATION.md:171-179](../../packages/web/server/lib/opencode/DOCUMENTATION.md#L171)。
- config-sync 是 OpenCode 实例间的 source plan / target executor 合同，allowlist 明确排除 plugin 私有状态；SSH 插件只同步 NPM 条目，保留版本/options/JSONC；preview 与 apply 要使用同一选择快照，目标变化废弃计划。证据：[config-sync/DOCUMENTATION.md:5](../../packages/web/server/lib/config-sync/DOCUMENTATION.md#L5)、[config-sync/DOCUMENTATION.md:28-34](../../packages/web/server/lib/config-sync/DOCUMENTATION.md#L28)、[config-sync/DOCUMENTATION.md:43-61](../../packages/web/server/lib/config-sync/DOCUMENTATION.md#L43)。
- 配置同步已有分代备份、部分成功/失败语义；凭据默认不勾选，经官方 V2 credential API 显式传输，不复制 auth.json/数据库，不进入预览/日志；目前发起 wizard 仍 desktop-only，web/mobile 是接收 Host。证据：[config-sync/DOCUMENTATION.md:57-61](../../packages/web/server/lib/config-sync/DOCUMENTATION.md#L57)、[config-sync/DOCUMENTATION.md:63-87](../../packages/web/server/lib/config-sync/DOCUMENTATION.md#L63)。
- 普通 Web proxy 和 VS Code bridge 阻止原始 secret-bearing credential list/create 返回 renderer；配置信息只曝光存在性/来源。证据：[opencode/DOCUMENTATION.md:112-118](../../packages/web/server/lib/opencode/DOCUMENTATION.md#L112)。
- metadata.yuri 中 assistant/scheduledTask/smallModel/llm 等字段会影响列表隐藏和系统会话归属，不能把外来元数据当无害标签随意塞进这些字段。证据：[session-index/DOCUMENTATION.md:75-103](../../packages/web/server/lib/session-index/DOCUMENTATION.md#L75)、[session-metadata/DOCUMENTATION.md:27-29](../../packages/web/server/lib/session-metadata/DOCUMENTATION.md#L27)。

### Inferences

- 项目设定最小建议分栏：①项目/工作树映射；②说明/规则/技能/命令；③模型、MCP、插件、运行环境；④凭据。前三者也应按文件/实体预览，凭据与可执行项默认排除。MCP command、hooks、插件、本地文件引用、shell 脚本属于可执行配置，导入不应自动运行或安装。
- 说明文件保留来源与适用范围；外部规则不是本会话或目标 Agent 的高优先级指令。若来源规则已被 OpenCode 原生发现，不重复生成同义 AGENTS.md；需另查实际发现规则再转换，不能盲目合并。
- 冲突策略：目标优先默认；允许“跳过 / 另名导入 / 明确替换”。禁止无提示覆盖已有 AGENTS.md、JSONC、skills 同名目录、Provider/MCP 同名实体；相同名字不代表相同语义。导入计划绑定目标 runtime、generation、路径映射和输入内容 hash，apply 前重验。
- 新建/修改多文件不是全局事务：写前备份，失败收据标明已写项/未写项/需处理冲突；重试不能重复创建会话/插件或抹掉后续用户编辑。可借用现有 backup 与 serialize 原则，但不能承诺现有 config-sync 对外部格式提供自动 semantic merge。
- 只在 Host 内解析潜在含密钥的配置，输出脱敏计划与字段存在性；不把源 authorization、完整 env/header、URL token 写入 metadata、localStorage、Query key、诊断日志或导入收据。历史文本本身也可能含密钥，应告知上传/保留边界，不在调研或诊断中读取真实内容。
- 不沿用来源“always allow”、持久权限、自动批准作为目标安全策略；原生 import 能携带 permissions，因此 importer 应默认剥离/要求独立确认，不能因原生 schema 允许就全盘信任。

### Gaps

- 尚未定义四种来源到 OpenCode V2 的配置字段兼容表、不可迁移项和冲突 UI；不能承诺完整导入所有设置。
- 本次没有实现、测试或迁移任何用户数据。下一阶段先确认步序/合并含义，再确定目标支持范围和 fixture 验证，不能以本调研代替运行时验收。
