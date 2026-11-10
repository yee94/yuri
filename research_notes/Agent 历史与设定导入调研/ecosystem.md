# 跨 Coding Agent 历史与项目设定迁移：开源生态核实

## 一、调研范围、DSH 身份与能力分层是什么？

### Takeaway

核实日期：**2026-11-06**。本笔记深读四个公开项目：cass、CC Switch、Agent Connect、dsh-import-agents；发现可复用的搜索、原生会话转换和配置管理实现，但**未核实到一个同时覆盖 Codex、Cursor、Claude Code、DSH 的双向历史迁移及项目规则语义合并框架**。这里的“未核实到”只限定本次样本，不代表全网不存在。

### Cited Findings

- **DSH 身份已确认，不再只是推测**：先查看本机公开项目 `deepseek-harness/README.md` 与既有 `research_notes/DSH Kanban 插件能力调研/dsh.md` 获取线索，再用原仓库核实。DeepSeek Harness 的 README 自称由 DeepSeek AI 开发的开源 Agent Harness，命令名为 `dsh`，采用 everything-is-a-plugin 架构，仍是 developer preview。它是运行会话、工具、插件的应用框架，不是 DeepSeek 模型本身。[官方 README，固定提交](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/README.md)
- DeepSeek Harness 仓库的当前逻辑会话版本是 **4**；原始本机 checkout 搜到的版本值不同，因此**本机 checkout 只能作身份和路径线索，不能冒充当前公开版本**。本笔记版本判断采用联网固定提交。[types.ts，L78–100](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/types.ts#L78-L100)
- 已核对的三类实现明显不同：cass 把不同源规范化为可检索归档；CC Switch 展示历史并提供原工具的恢复命令；Agent Connect 创建目标工具的新原生会话。不能把三者都写成“已支持跨 Agent 续聊”。[cass README](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/475586015bb4fe75d5b981ba666c67b302d03e2c/README.md#-why-this-exists)；[CC Switch Session Manager](https://github.com/farion1231/cc-switch/blob/4e13413ff236860b445e6c7f3f7590e999de0eea/docs/user-manual/en/3-extensions/3.4-sessions.md)；[Agent Connect README](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/README.en.md)

本次使用以下术语分层；这是调研分类，不是上游统一标准：

| 层级 | 本笔记定义 | 能证明什么／不能证明什么 |
|---|---|---|
| 历史聚合 | 只读解析→统一索引／阅读／导出 | 能找回历史；不代表目标 Agent 可原生 resume |
| 原工具恢复 | 复制／执行原工具已有 session 的恢复命令 | 仍由原 Harness 接续；不是 A→B 转换 |
| 目标原生导入 | 生成 B 的会话记录或调用 B 的持久化服务 | B 有机会恢复；仍需核对版本、工具结果和模型兼容性 |
| 指令迁移 | 复制／转换 CLAUDE.md、AGENTS.md、rules、skills 等 | 迁移文本不等于迁移作用域、权限或执行语义 |
| 去重与合并 | 区分重复扫描、重复导入、分支合并、规则冲突消解 | 内容相同不一定是同一事件；列在同一列表不等于合并成一个会话 |

### Inferences

- 配置同一个 DeepSeek 模型到 Codex、Cursor 或 Claude Code，改变的是 provider/model，不会让这些 Harness 的本地历史变成 DSH 会话。DSH 的导入目标必须是其原生 session persistence，而非 DeepSeek API 请求日志。依据是 DSH 持久化接口与独立的目标 writer。[DSH persistence](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/persistence.md)；[DSH 插件 import-service](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/plugin/import-service.mjs)

### Gaps

- 只读调研：未安装、运行、克隆候选项目，没有验证真实产品内的显示或续聊成功率；未访问任何用户实际会话、私聊、认证文件、密钥或数据库。
- 使用网络只读 HTTP 工具及公开 GitHub REST/Raw 页面，没有运行 git 或 GitHub CLI。没有改产品源码或添加依赖。
- 已对 DSH 的持久化契约执行 Context7 resolve→query，再核对固定提交官方文档；Context7 的 master 链接只用于发现，不作为版本固定证据。

## 二、四个候选项目的已验证能力与限制是什么？

### Takeaway

**历史聚合看 cass；配置与指令库看 CC Switch；Cursor／Claude Code／Codex 原生互转看 Agent Connect；导入 DSH 看 dsh-import-agents。**它们更适合分别借鉴，不适合任选一个就宣称完成“全源全量无损迁移”。

### Cited Findings

#### 核实快照与能力矩阵

下表 SHA 通过公开 `commits/HEAD` 接口取得，再读取对应 SHA 的 Raw 源码；是调研快照，不表示已安装版本或最新发布版本。

| 项目与固定提交 | 许可证核实 | 本次目标源覆盖 | 写目标原生会话？ | 指令／去重／合并边界 |
|---|---|---|---|---|
| [cass](https://github.com/Dicklesworthstone/coding_agent_session_search/tree/475586015bb4fe75d5b981ba666c67b302d03e2c)，`475586015bb4fe75d5b981ba666c67b302d03e2c` | **MIT + OpenAI/Anthropic Rider，不是标准 MIT**；附加条款限制特定主体及其代理使用，复用前需法务确认。[LICENSE](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/475586015bb4fe75d5b981ba666c67b302d03e2c/LICENSE) | Codex、Cursor、Claude Code；本次 connector 清单未见 DSH。[README](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/475586015bb4fe75d5b981ba666c67b302d03e2c/README.md#-universal-connectors) | 定位是索引、检索、阅读、导出；没有在所核对资料中找到这三者之间的目标会话转换器 | 归档身份／消息去重，不是项目规则语义合并。[去重说明](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/475586015bb4fe75d5b981ba666c67b302d03e2c/README.md#-deduplication-strategy) |
| [CC Switch](https://github.com/farion1231/cc-switch/tree/4e13413ff236860b445e6c7f3f7590e999de0eea)，`4e13413ff236860b445e6c7f3f7590e999de0eea` | MIT。[LICENSE](https://github.com/farion1231/cc-switch/blob/4e13413ff236860b445e6c7f3f7590e999de0eea/LICENSE) | Claude Code、Codex、**DSH 源码已有 reader**；所核对 provider 注册清单无 Cursor。[providers](https://github.com/farion1231/cc-switch/blob/4e13413ff236860b445e6c7f3f7590e999de0eea/src-tauri/src/session_manager/providers/mod.rs) | Session Manager 主要是原工具恢复；Codex 专项会改原生 provider 标签，但不是跨 Harness 转换 | 有 prompt 文件管理／跨应用复制、MCP/Skills 同步；未见项目规则语义冲突消解。[README](https://github.com/farion1231/cc-switch/blob/4e13413ff236860b445e6c7f3f7590e999de0eea/README.md#MCP-Prompts--Skills) |
| [Agent Connect](https://github.com/1naruto-1/agent-connect/tree/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6)，`42287c14a8fd381bc7ef7a96076a5cba5b4d75f6` | MIT。[LICENSE](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/LICENSE) | Cursor、Claude Code、Codex CLI、Pi 四方，声明 12 个跨工具方向；无 DSH adapter。[README](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/README.en.md) | **是**；readSession→canonical events→target.writeSession，生成新目标 ID。[migrate.ts](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/src/migrate.ts) | 无批量模式、无重复导入检测；不迁移项目规则文件。[README 限制](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/README.en.md#notes) |
| [dsh-import-agents](https://github.com/Chang-Tong/dsh-import-agents/tree/d5ab27c96699f3b72c048304bb26c90be15f14ee)，`d5ab27c96699f3b72c048304bb26c90be15f14ee` | MIT。[LICENSE](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/LICENSE) | Pi、OpenCode、Codex、Claude Code→DSH；无 Cursor reader。[README](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/README.md) | **是**；插件走 DSH `sessionPersistence.create` 与写 handle；CLI 另有物理文件 writer | 稳定来源前缀 ID，重导跳过；Pi/OpenCode agents/prompts→skills，有文本相同跳过与同名后缀；不是四种工具的项目规则全量迁移。[import-service](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/plugin/import-service.mjs)；[agents](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/lib/agents.mjs) |

#### A. cass：归一化与检索参考，不是跨 Harness 会话 writer

- 源类型明确：Codex 的 sessions/archived_sessions 为 rollout JSONL（含 `.jsonl.zst`）；Claude Code 为 projects 下 JSONL，另可读取 macOS Desktop metadata sidecar；Cursor 为 User global/workspace storage 下 `state.vscdb` SQLite。sidecar 可能只有标题、项目、模型等元数据，正文被原工具清理后不能凭空恢复。[README connector inventory，L417 起](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/475586015bb4fe75d5b981ba666c67b302d03e2c/README.md#-universal-connectors)；[connector registry](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/475586015bb4fe75d5b981ba666c67b302d03e2c/src/connectors/mod.rs)
- 输出统一 `Conversation→Message→Snippet`；SQLite 是归档权威数据，搜索和向量索引可重建；HTML/Markdown 等导出是阅读／知识传递，不等于生成 Codex／Claude／Cursor 原生会话。[README](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/475586015bb4fe75d5b981ba666c67b302d03e2c/README.md)
- 去重键具体而非“AI 自动合并”：conversation 为 `UNIQUE(source_id, agent_id, external_id)`，message 为 `UNIQUE(conversation_id, idx)`；不同来源即使文本一致仍可作为独立结果。内容哈希参与内存对账，不是“跨工具语义相似就合并”。[Deduplication Strategy](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/475586015bb4fe75d5b981ba666c67b302d03e2c/README.md#-deduplication-strategy)
- **许可证是实质选型限制**：README badge 即写 MIT+Rider；LICENSE 还将特定主体的 testing/analyzing/indexing 等列入限制范围。只能把它作为公开实现的调研对象，不能按普通 MIT 直接复制进产品；法律适用由法务判断。[LICENSE 原文](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/475586015bb4fe75d5b981ba666c67b302d03e2c/LICENSE)

#### B. CC Switch：原工具恢复、配置库、Codex 标签统一，三者需分开

- Session Manager 的 resume 是在原项目目录启动原工具的命令，或复制命令；同时可 Markdown 导出。不能因为按钮名为 Resume，就推断 Claude 会话被转换成 Codex。[Session Manager 官方手册](https://github.com/farion1231/cc-switch/blob/4e13413ff236860b445e6c7f3f7590e999de0eea/docs/user-manual/en/3-extensions/3.4-sessions.md)
- **README/手册存在覆盖滞后**：源码 `providers/dsh.rs` 已是 DeepSeek Harness 只读浏览器，`session_roots` 指向 DSH data dir 下 sessions，`resume_command: None`；文件首句明确原生 Web UI owns resume/delete。因此 DSH 只能按已核实的只读能力写，不替它宣传可恢复／可删除。[dsh.rs，L1–20、L124–134](https://github.com/farion1231/cc-switch/blob/4e13413ff236860b445e6c7f3f7590e999de0eea/src-tauri/src/session_manager/providers/dsh.rs#L1-L20)
- “Unified Codex session history”是在 **Codex 内部**把 `openai`／`custom` provider 分类统一：备份后改 JSONL metadata 的 `model_provider` 和索引 DB 标签，提供按备份 ledger 恢复。不是合并两个会话的消息，也不是转成另一 Harness；文档明确跨后端 encrypted_content 可能导致无法继续。[官方专项指南](https://github.com/farion1231/cc-switch/blob/4e13413ff236860b445e6c7f3f7590e999de0eea/docs/guides/codex-unified-session-history-guide-en.md)
- Prompts 写入的是工具配置根下的文件：Claude→`CLAUDE.md`、Codex→`AGENTS.md`、DSH→`AGENTS.md` 等；代码从应用配置／数据目录确定路径，**不能表述为递归扫描仓库内所有层级规则**。[prompt_files.rs，L20–65](https://github.com/farion1231/cc-switch/blob/4e13413ff236860b445e6c7f3f7590e999de0eea/src-tauri/src/prompt_files.rs#L20-L65)
- 启用 prompt 前可把 live 文件回填备份到库，再把新 prompt 内容整份原子写入目标；不是段落级三方合并。跨应用复制对话框明确每个目标存成独立条目、不自动启用，检测的是同名而非规则矛盾。[PromptService.enable_prompt](https://github.com/farion1231/cc-switch/blob/4e13413ff236860b445e6c7f3f7590e999de0eea/src-tauri/src/services/prompt.rs#L150-L224)；[PromptCopyDialog，L26–62](https://github.com/farion1231/cc-switch/blob/4e13413ff236860b445e6c7f3f7590e999de0eea/src/components/prompts/PromptCopyDialog.tsx#L26-L62)

#### C. Agent Connect：真正目标原生写入，优先研究 Cursor 互转

- 三个关键 writer 均已查看：Claude 写新 UUID 的项目 JSONL，并建立 parentUuid 链；Codex 写新的 rollout JSONL；Cursor 向 SQLite `cursorDiskKV` 插入新 composer/bubble 行，使用 `BEGIN IMMEDIATE` 写事务。不是只导出 Markdown。[claude.ts](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/src/adapters/claude.ts#L181-L265)；[codex.ts](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/src/adapters/codex.ts#L257-L325)；[cursor-writer.ts](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/src/cursor-writer.ts#L187-L207)
- Cursor writer 要求完全退出 Cursor（含托盘），无法确认则拒绝；项目要曾由 Cursor 打开才能找到 workspace。只插入新会话，不改已有会话，这仍不等于零风险：它依赖未稳定承诺的原生内部布局。[assertCursorClosed/findWorkspaceId](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/src/cursor-writer.ts#L24-L63)
- README 明确没有批量模式或重复导入检测，每次新建目标 session；“同一源再迁一次”将产生另一会话，不能当成幂等 merge。[README Notes](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/README.en.md#notes)
- 已处理源树与回退语义：Claude 用活跃 parentUuid 链并处理 compact/snip，Codex 应用 thread_rolled_back 并对双轨记录去重；Pi 只跟随 active branch。注意其迁移保留 Codex 压缩前历史并添加摘要 marker，这**有意不同于原生 resume 的上下文替换**，不是精确运行状态克隆。[README What is preserved](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/README.en.md#what-is-preserved)
- 目标无对应工具时降级为正文；Codex reasoning 不能原生构造时转成带 `[思考过程]` 前缀的 assistant 文本。记录 MCP 调用不代表目标已配置对应 server，不能重放所有原工具能力。[README](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/README.en.md#notes)；[Claude writeNotes](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/src/adapters/claude.ts#L268-L272)
- Codex 目标配置会从最近一个真实 Codex session 取 model_provider/base_instructions/turn_context 模板；它不是把源项目设定迁移到 Codex 的功能，并可能让无关最近会话配置影响目标。落地前应改成明确选择目标配置的产品契约，此为基于代码的风险推断。[configTemplate](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/src/adapters/codex.ts#L241-L265)
- 上游自报的验证环境为 **Windows + Cursor 3.9、Claude Code 2.1、Codex CLI 0.144、Pi 0.82**。存在 macOS/Linux 发布包不等于这些平台的目标原生续聊已经验证。[README Notes](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/README.en.md#notes)

#### D. dsh-import-agents：DSH 的直接导入样例，但不是无损通用转换器

- 插件路径实际调用 `persistence.list`、`create({version:4,id,cwd,...})`、分批 `handle.append`、`flush`、`finally close`，再按源 cwd 附到 workspace。稳定 ID 为 `pi-`／`oc-`／`codex-`／`claude-` 前缀，已存在则 skip。[import-service.mjs](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/plugin/import-service.mjs)
- 这与当前 DSH 的 handle-based persistence seam 一致，当前宿主也为 format 4；**版本数字相同只是必要条件，不证明插件全部事件字段与当前宿主兼容**。插件常量是人工同步，而非运行时协商。[插件 SESSION_FORMAT_VERSION](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/plugin/import-service.mjs#L76-L84)；[宿主 format](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/types.ts#L78-L100)；[宿主 persistence](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/persistence.md)
- **CLI 与插件不是同一路径**：CLI 的 `lib/dsh-writer.mjs` 直接生成 checksummed zstd artifact，物理 header 标 `version:0`；插件则走当前逻辑 version 4 服务。不能只因数字不同断言 CLI 一定失效（可能有物理版本翻译），也不能只因 README 说“exact layout”就认定兼容。[dsh-writer](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/lib/dsh-writer.mjs)；[当前 SessionHeader 对历史物理头翻译的说明](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/types.ts#L94-L101)
- **“full context”不应照抄**：converter 为每个工具调用补 `TOOL_RESULT_PLACEHOLDER`；Claude reader 实际能读 `tool_result`，但把它改为最多 **2000 字符**的普通文本。README FAQ“源工具不存结果”的泛化表述与 reader 不一致，源码优先。[convert.mjs](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/lib/convert.mjs)；[claude-reader，L76–90](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/lib/claude-reader.mjs#L76-L90)；[README FAQ](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/README.md#faq)
- Codex reader 仅接受 `response_item` 中 `payload.type === 'message'` 的 user/assistant，故不能泛称覆盖所有 rollout 工具/结果事件；它依据最后一个 session_meta 当 root，合并该 root 的文件，以 role+blocks 的结构文本去重。这个行为是**插件自己的解释策略，不是本次已确认的所有 Codex 版本规范**。[codex-reader，L95–127、L143–193](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/lib/codex-reader.mjs#L95-L193)
- Claude reader 顺序收集所有 user/assistant，没有 Agent Connect 那套活跃 parentUuid 链消解；其 cwd 由编码项目目录反解（按 `-` 拆段），不能无条件恢复原始含连字符的真实路径。[claude-reader，L24–49、L112–150](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/lib/claude-reader.mjs)
- agents→skills 的真实来源是 Pi agents/prompts 和 OpenCode agents/skill Markdown；不是自动迁移 Claude 的 CLAUDE.md、Codex 的 AGENTS.md 或 Cursor rules。它保存 name/description/body 和来源 metadata，但没有保留原 agent 的权限/运行模式语义。重名加来源后缀、相同内容跳过或补齐缺少 SKILL.md 的 bundle，不是语义合并。[agents.mjs](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/lib/agents.mjs)

### Inferences

- **最可复用的转换结构是 adapter + 中间事件模型 + target writer + 损失报告**，而不是拼接原 JSON。Agent Connect 有显式转换和报告；DSH 插件展示了如何写入另一 Harness 的受控 persistence 服务。[Agent Connect migrate](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/src/migrate.ts)；[DSH import-service](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/plugin/import-service.mjs)
- DSH 插件的存在可证明“有可落地的 DSH 目标写入先例”，不能证明 Codex、Claude 的所有分支和工具事件已正确迁移。其重导 skip 也意味着**源会话新增内容不会自动增量追加**；这是由 existing ID 直接 continue 推导的限制。[importSessions](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/plugin/import-service.mjs)

### Gaps

- 本次未审计上述候选的全部安全面、发布二进制或 CI 结果；测试源码／README 自述不等于本次运行证据。
- cass 许可证不符合“可无条件按 MIT 采用”的预期；若必须只列标准开源许可证，应把它标为受限源码可见候选而非通常意义的无歧义开源依赖。
- `f/agentlytics` 作为发现阶段候选，公开描述和目录均偏 analytics，`package.json` 标 `ISC`，所见根目录无 LICENSE；未深审写入链路，因此**不列入本次四个已核实迁移／管理方案，也不凭名称断言能原生迁移**。[固定 package.json](https://github.com/f/agentlytics/blob/83c1ca176f7fa3c79e739aa66666b94c44faf409/package.json)；[固定目录](https://github.com/f/agentlytics/tree/83c1ca176f7fa3c79e739aa66666b94c44faf409)

## 三、对落地方案的直接建议与尚缺证据是什么？

### Takeaway

建议先交付**有来源可追溯、可重复导入、明确标损失的只读历史与设定预览**，再按目标 Harness 分开做“创建可继续的新会话”。项目指令迁移应是独立流程：保留作用域与来源，预览冲突后显式确认，不能把已有 prompt 库或简单文本去重当成规则合并引擎。

### Cited Findings

- 可借鉴的已存在机制：cass 的 source/agent/external_id 身份隔离；Agent Connect 的 typed event 中间层和迁移报告；DSH 插件的来源前缀 ID、官方 persistence handle 写入；CC Switch 的覆盖前回填旧 live 内容与备份 ledger。[cass dedup](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/475586015bb4fe75d5b981ba666c67b302d03e2c/README.md#-deduplication-strategy)；[Agent Connect types](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/src/types.ts)；[DSH writer service](https://github.com/Chang-Tong/dsh-import-agents/blob/d5ab27c96699f3b72c048304bb26c90be15f14ee/plugin/import-service.mjs)；[CC Switch backup/restore 指南](https://github.com/farion1231/cc-switch/blob/4e13413ff236860b445e6c7f3f7590e999de0eea/docs/guides/codex-unified-session-history-guide-en.md)

### Inferences

以下是由上述证据推导的落地建议，不是任何候选已完整提供的功能：

1. **分离“导入查看”与“导入继续”**：前者不触碰原工具，后者新建目标 session 并提供目标、版本、损失项的确认页。默认不改源会话、不把新上下文追加到已运行目标。
2. **统一模型保留身份而不抹平谱系**：至少保留 sourceHarness、sourceStore、sourceSessionId、nativeMessageId、原项目目录、父子／fork 关系、原时间与事件顺序、工具调用和结果对应关系。原始相对顺序不能被简单时间排序替代。
3. **去重分层**：扫描幂等键、导入映射键、源内容修订记录分别处理；不能用纯文本 Set 全局删除重复消息（“继续”出现两次可能是两个真实回合）。DSH reader 的 role+text 去重只能作样例，不能直接成为通用策略。
4. **设定独立迁移**：先列出文件、global/project/subdirectory 作用域、激活条件、原格式和来源；原文相同可去重，冲突项让用户选择保留／替换／并存。MCP 凭据、授权模式、provider key 不随提示词盲拷贝。
5. **优先次序**：如果目标是“统一阅读和搜索”，独立实现 MIT 许可 reader 或重新核对许可证，不直接依赖 cass；如果目标是“Cursor→Codex／Claude”，优先以 Agent Connect 为静态参考；如果目标是“来源→DSH”，优先研究服务级 writer，而非长期依赖物理 zstd 私有布局。
6. **验收使用人工构造样本**：覆盖工具结果丢失／过长、重复提示、Claude rewind/compact/snip、Codex rollback/compaction、子会话／fork、含连字符路径、重导增量、目标格式升级、写入中断。先在隔离数据根和备份下验证，不拿用户真实历史做首次实验。

### Gaps

- 尚缺覆盖四种 Harness 的统一项目指令语义模型；尤其 Cursor rules 的条件／路径作用域不能用“改文件名为 AGENTS.md”替代。
- 尚缺这四个项目到 Yuri/OpenCode 的端到端兼容证据。本笔记没有审计 Yuri 的导入 API，也不把 DSH/Claude/Codex 原生 writer 当成 Yuri 可直接调用的接口。
- 尚缺增量同步与双向修改冲突消解方案：现有 DSH 插件跳过已存在 session，Agent Connect 每次建新 session；两者都不能直接承担跨 Harness 双向同步。
- 因未运行目标产品，“可继续”在本笔记中表示**存在目标原生写入实现和相应上游恢复设计**，不表示本次已成功续聊，更不表示模型私有 reasoning、压缩状态、权限和全部工具能力均无损保留。
