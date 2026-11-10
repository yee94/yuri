# 为 Yuri 引入可追溯的历史迁移

**建议做，但不是直接接入 Magpie：采用“本地源只读 → 统一中间格式 → OpenCode 官方导入 → 项目注册与索引刷新”。**先支持项目归并、重复跳过及新修订补导，暂不自动拼接不同会话。Magpie 最有价值的是格式解析与测试，其历史互转尚不能写入 OpenCode，设定导入还会移动源内容。历史可查看、可搜索、可继续对话应分别验收，不能承诺恢复原 Agent 运行状态。步序建议为“模型 → 工具 → 导入 → 语音”，第四步保留导入入口；这是待确认方案，不是用户已确认的设计。

调研基准：2026-11-06，综合三份研究笔记及本地源码复核；本次未额外联网、未读取真实私有历史、未执行迁移。公开链接保留笔记中的固定提交，能力不等于本机端到端验证通过。

## Magpie 能借鉴解析器，不能直接充当 Yuri 迁移器

本机 `../magpie` 的历史互转仅有 **Claude Code ↔ Codex**，另有 Pi → oh-my-pi 原生 fork；OpenCode 是读取源，不是转换目标。Cursor 可浏览，但没有跨格式 writer；DSH 能列摘要、用量和调用记录，却不在完整 transcript 白名单。GUI transcript 还存在 400,000 字符截断，不能当全量导出接口。([carry_convert.go:78](../../magpie/internal/sessions/carry_convert.go#L78-L79)、[transcript.go:16](../../magpie/internal/sessions/transcript.go#L16-L38))

其转换保留文字、部分图片及 shell 调用，其他工具转文本，丢弃 thinking，单项工具输出限 64 KiB；这更接近重建续聊上下文，而非无损审计归档。重复转换缓存仅在进程内，以路径、目标、大小、mtime 判定，重启后不保证幂等。([carry_convert.go:9](../../magpie/internal/sessions/carry_convert.go#L9-L20)、[carry_convert.go:65](../../magpie/internal/sessions/carry_convert.go#L65-L67)、[carry_convert.go:114](../../magpie/internal/sessions/carry_convert.go#L114-L179))

**Library 是接管式管理，不是只读复制**：指令导入会备份后移除源自有内容，可能删除原指令文件；普通 skills 目录会移动进 Library，再向原 Agent 分发。Cursor target 也没有 rules 导入能力。不要直接调用这套流程实现“不影响旧工具”的 onboarding。代码位于 Go `internal` 包并耦合内部设置，不是现成 npm SDK。根许可证为 MIT，复制实质代码须保留版权与许可；若分发完整二进制，还须审查第三方声明。([instructions.go:470](../../magpie/internal/library/instructions.go#L470-L524)、[skills.go:2283](../../magpie/internal/library/skills.go#L2283-L2383)、[targets.go:181](../../magpie/internal/library/targets.go#L181-L191)、[LICENSE:1](../../magpie/LICENSE#L1-L21)、[THIRD_PARTY_NOTICES:4](../../magpie/THIRD_PARTY_NOTICES#L4-L29))

## 四类来源不能按同一种聊天文件处理

| 来源 | 格式与保真边界 |
|---|---|
| Claude Code | `projects/…/*.jsonl`；须解析 parentUuid 主链、子 Agent、压缩和分支，不能顺序拼所有 user/assistant。([解析证据](../../magpie/internal/sessions/carry_convert.go#L281-L388)) |
| Codex | `sessions/`、`archived_sessions/` rollout JSONL，含压缩文件；须区分事件/响应双轨及 compaction/rollback，不能只提取 message。([本地 reader](../../magpie/internal/sessions/codex.go#L15-L19)、[互转边界](https://github.com/1naruto-1/agent-connect/blob/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6/README.en.md#what-is-preserved)) |
| Cursor CLI | `chats/<cwd哈希>/<id>/store.db`，包含 SQLite、protobuf 与 JSON blob；与编辑器数据源分开适配。([cursor.go:21](../../magpie/internal/sessions/cursor.go#L21-L57)) |
| Cursor 编辑器 | 项目 agent-transcripts JSONL，以及 `state.vscdb` composer/bubble；Magpie 标记只读，不能拿 ID 交给 cursor-agent 续聊。运行中 SQLite 须一致性快照，不能只复制 `.db` 忽略 WAL。([cursor_editor.go:12](../../magpie/internal/sessions/cursor_editor.go#L12-L69)) |
| DeepSeek Harness | **DSH 是 Harness 应用，不是 DeepSeek 模型或网页聊天**；本地为 session 事件 JSONL/版本化压缩文件，须独立全文适配。公开快照逻辑格式为 v4，不能套用旧 checkout。([官方身份](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/README.md)、[格式](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/types.ts#L78-L100)) |

其他工具必须按真实能力选型，而不是笼统写“支持迁移”：

| 项目 | 索引／导出／互转／写入续聊的区别 |
|---|---|
| [cass](https://github.com/Dicklesworthstone/coding_agent_session_search/tree/475586015bb4fe75d5b981ba666c67b302d03e2c) | 聚合检索、阅读、HTML/Markdown 导出；未核实目标原生会话 writer，无 DSH connector。**MIT + Rider，并非标准 MIT**，复用需法律审查。 |
| [CC Switch](https://github.com/farion1231/cc-switch/tree/4e13413ff236860b445e6c7f3f7590e999de0eea) | Markdown 导出及原工具恢复；DSH reader 只读、无 resume。Codex provider 标签统一不是跨 Harness 互转，也不是消息合并。MIT。 |
| [Agent Connect](https://github.com/1naruto-1/agent-connect/tree/42287c14a8fd381bc7ef7a96076a5cba5b4d75f6) | Cursor 编辑器、Claude、Codex、Pi 之间实际生成目标原生记录；无 OpenCode/DSH adapter、批量和重导去重，工具仍有降级。MIT。 |
| [dsh-import-agents](https://github.com/Chang-Tong/dsh-import-agents/tree/d5ab27c96699f3b72c048304bb26c90be15f14ee) | Pi/OpenCode/Codex/Claude → DSH，插件调用 persistence 服务；不是 DSH → Yuri。稳定 ID 重导跳过，不补增量，工具结果有占位/截断。MIT。 |

因此优先借鉴 Magpie 的源解析、Agent Connect 的中间事件层、DSH 插件的服务级写入；**不采用其直接修改私有数据库的目标 writer**。上述项目均未在本次验证四源到 Yuri 的真实续聊。

## OpenCode 已有官方导入，但合同是新建而非追加

当前安装的 `@opencode/client` 确有 `session.import/export`，对应 experimental import/export API；不是让旧消息经过 prompt 执行。**`info` 必填**，需提供原生会话字段；`messages: JsonValue[]` 不意味着可直接塞入其他产品 JSON，服务端仍按原生 schema 解码。([client.d.ts:34](../node_modules/@opencode/client/dist/promise/generated/client.d.ts#L34-L38)、[types.d.ts:3976](../node_modules/@opencode/client/dist/promise/generated/types.d.ts#L3976-L4045)、[协议 session.ts:188](../../opencode/packages/protocol/src/groups/session.ts#L188-L215)、[官方 API](https://opencode.ai/v2/docs/api))

**重复 session ID 返回 409，不覆盖、不追加，也不证明内容相同。**父会话须先存在；目标 projectID/subpath 按 location 重算。消息依输入次序保存，仅导入已结束记录；保留 created，updated 改为导入时刻。附件须携带实际 bytes，外来 hash 不代表可读取目标 blob。远端版本仍须能力探测，不能拿本机客户端类型推断全部 Host 可用。([transfer.ts:60](../../opencode/packages/core/src/session/transfer.ts#L60-L175)、[transfer.ts:202](../../opencode/packages/core/src/session/transfer.ts#L202-L205)、[HTTP 409 映射](../../opencode/packages/server/src/handlers/session.ts#L121-L140))

**导入可打开 ≠ 全文可检索**：session-index 是有界摘要，每目录最多 20 个 root；全文索引默认近 30 天、root 的用户/已完成助手文本，不覆盖子会话、工具、reasoning 和附件。旧消息不会因导入而改变原始时间。应分别报告会话写入、项目登记、摘要发现、全文覆盖。([session-index/DOCUMENTATION.md:55](../packages/web/server/lib/session-index/DOCUMENTATION.md#L55-L74)、[content-search/DOCUMENTATION.md:3](../packages/web/server/lib/content-search/DOCUMENTATION.md#L3-L22))

## 合并先做项目归并与去重，设定必须经过安全预览

推荐 Host 管理导入任务：授权只读探测源，经一致性快照/流式解析进入统一模型，保留来源安装身份、原会话/消息 ID、时间顺序、父子与 fork、工具配对、附件及损失清单；预览路径映射后调用官方 import，再复用项目注册与定向索引刷新。**不直接修改 OpenCode、Yuri 索引或源数据库。**现有项目注册只登记已有目录，不负责 clone。([registry.js:11](../packages/web/server/lib/projects/registry.js#L11-L32))

三种“合并”应明确分开：**项目归并**让多来源会话映射同一项目，保留工作树差异；**去重补导**用目标 runtime、来源命名空间、原 ID、内容哈希建立持久账本，相同修订跳过，更新默认导为新修订；**跨会话拼接**须核对共同前缀、分支和工具引用，离线构造新会话，不能给已有会话直接 append。先交付前两种。不能迁移原 Agent 的进程内存、私有推理状态或工具权限；运行中调用不可伪造成功，fork/revert 也不能仅凭字段存在宣称无损恢复。

设定白名单先限于用户选中的项目路径、说明/规则文本及可审阅的 skills 内容，保留 global/project/subdirectory 和条件作用域。目标优先，冲突预览提供跳过、另名、明确替换；不得简单把 Cursor rules 改名 AGENTS.md。**凭据、自动批准、hooks、插件和 MCP 执行配置默认排除，不自动迁移密钥、安装或执行命令。**后续若开放可执行配置，应独立审查确认；apply 前重验目标与输入哈希、备份并记录部分成功。([config-sync/DOCUMENTATION.md:43](../packages/web/server/lib/config-sync/DOCUMENTATION.md#L43-L87))

跨 runtime 必须标明“源在哪台机器、数据传给哪个 Host”。Web 文件 API 看的是服务器，不是浏览器设备 home；Electron 当前原生文件授权仅本机连接可用，远程上传需另做授权入口；VS Code Extension Host 不保证与目标同机；手机只带 UI，不能扫描电脑或其他 app 私有历史。([files.ts:57](../packages/web/src/api/files.ts#L57-L79)、[desktop.ts:647](../packages/ui/src/lib/desktop.ts#L647-L708)、[vscode README:49](../packages/vscode/README.md#L49-L52)、[mobile README:63](../packages/mobile/README.md#L63-L72))

## 四步引导只负责选择，迁移应后台分阶段完成

现状确为“模型 → 工具 → 语音”。推荐改为 **模型 → 工具 → 导入 → 语音**，第四步附“导入历史与设定”返回/补做入口，每项可跳过，之后设置中仍可重开。若要求第四步同时容纳导入与语音，可做两个独立区块，但必须先确认第三步内容，不能为凑步数发明页面。旧持久化 index 2 指语音，还须迁移步义、完成判断和豆包保存回调，不只是改标题。([SetupTourDialog.tsx:33](../packages/ui/src/components/onboarding/SetupTourDialog.tsx#L33)、[useSetupTourStore.ts:6](../packages/ui/src/stores/useSetupTourStore.ts#L6-L44))

第一阶段用人工 fixture 打通 Claude/Codex → 官方 import，验证显示与下一轮续聊、重导 409、附件、压缩、子会话及中断恢复；只读预览项目设定。第二阶段加入 Cursor CLI/编辑器双适配和 DSH 全文 reader，开放项目归并、持久去重及白名单设定复制。第三阶段再评估用户显式选择的跨会话拼接、复杂规则转换和全文检索扩展。批次按会话提交，失败只阻塞相关子树，收据区分已写/失败；不承诺跨会话与配置文件的全局事务。

## 结论

这项能力的产品承诺应是“把既有工作带进来，并知道保留了什么”，而不是“克隆另一个 Agent”。先用小范围可验证导入建立信任，再扩展格式和合并深度；onboarding 不应等待全库迁移完成，也不应把读取旧资料的授权等同于运行外来扩展的授权。
