# Yuri 微信 AI 分身通道接入：现有助理管线与最小边界调研

调研日期：2026-11-03。仅阅读当前工作区代码、包 README 和最近 DOCUMENTATION；未执行 git 命令、未修改源代码、未启动服务或测试，唯一写入为本笔记。本文不验证 WorkBuddy/OpenClaw/ilink/ClawBot 的外部协议，也不假定它们与微信客服共享身份、接口或凭据。下文代码链接相对仓库根目录，`file:line` 行号对应本次读取版本，不代表固定提交。

## 1. 可以直接复用哪个消息入口，哪些“Assistant”路径不能复用？

### Takeaway

**可行，而且应直接复用 Yuri 自有 contact 管线：新渠道收消息 → 身份/绑定校验与入站去重 → `assistantService.send(assistantID, input)` → 每 Bot 串行 lane → `runContactTurn` → 公共消息/最终结果投递。不要把微信会话映射为普通 OpenCode Session，也不要因名称含 Assistant 就复用现有 durable message queue 的 assistant target：后者实际仍进入旧的 `session.prompt` 路径。**

### Cited Findings

- **真正的当前消息入口**：HTTP `POST /api/yuri/assistants/:assistantID/messages` 调用 `service.send()` 并返回 202，注释明确只接收用户消息，回复通过 SSE 到达。`registerAssistantRoutes()` 创建并返回同一个 service，适合 Host 内直接注入新通道，而非 loopback HTTP 自调。证据：[`packages/web/server/lib/assistants/routes.js:24-48`](../../packages/web/server/lib/assistants/routes.js#L24)、[`routes.js:109-112`](../../packages/web/server/lib/assistants/routes.js#L109)。
- **send 的实际契约**：要求对象、非空 `messageID`（上限 256）、可提取的非空用户文字，可选 `parts`、`language`；读取真实 Bot 配置并物化附件、项目目录。相同 messageID + 同一 parts 指纹只重放 admission、不重新启动 turn；同 ID 异内容报 `idempotency_conflict`，跨 Bot 或非 user 行报验证错误。证据：[`packages/web/server/lib/assistants/service.js:3369-3405`](../../packages/web/server/lib/assistants/service.js#L3369)。
- **先落库、再异步执行**：`admitContactUser` 在 SQLite immediate transaction 中插入 user、增加 ordinal 和 revision；`send` 随后调用 `enqueueContactTurn`；执行用 `setImmediate` 延后，让调用方先观察到 admission。证据：[`service.js:1612-1632`](../../packages/web/server/lib/assistants/service.js#L1612)、[`service.js:3406-3442`](../../packages/web/server/lib/assistants/service.js#L3406)、[`service.js:3693-3700`](../../packages/web/server/lib/assistants/service.js#L3693)。
- **会话主键不是微信会话，更不是 current_session_id**：contact 表按 `assistant_id` 保存消息、上下文清除边界、摘要、generation、已读状态；消息 ID 是全表主键，没有外部账号、peer、channel、conversation 字段。Bot DTO 中同时保留旧 `sessionID/sessionGeneration/mode` 以及当前 contact activity，不能把两种概念混为一谈。证据：[`packages/web/server/lib/assistants/contact-store.js:11-81`](../../packages/web/server/lib/assistants/contact-store.js#L11)、[`service.js:395-446`](../../packages/web/server/lib/assistants/service.js#L395)。
- **当前 contact 执行器**：`enqueueContactTurn` 调 `runContactTurn`，传 Bot 快照、历史、当前 userParts、语言、工具及 bubble callback。harness 创建独立 pi Agent，`toolExecution: 'sequential'`、`thinkingLevel: 'off'`，以实际工具 schema 和 progressive loader 执行。证据：[`service.js:3577-3595`](../../packages/web/server/lib/assistants/service.js#L3577)、[`packages/web/server/lib/assistants/harness.js:484-538`](../../packages/web/server/lib/assistants/harness.js#L484)、[`harness.js:567-595`](../../packages/web/server/lib/assistants/harness.js#L567)。
- **OpenCode 只供推理，不是助理会话引擎**：LLM gateway 文档明确只输入显式 system/messages/tools，不带 OpenCode session history、Agent hooks/native tools，不创建或写 Session；实际工具执行仍归 Yuri/pi。远程外部 OpenCode 须能读到 Host staging 的 bridge 目录，否则失败，不自动安装到另一台机器。证据：[`packages/web/server/lib/llm/DOCUMENTATION.md:24-54`](../../packages/web/server/lib/llm/DOCUMENTATION.md#L24)、[`llm/DOCUMENTATION.md:76-81`](../../packages/web/server/lib/llm/DOCUMENTATION.md#L76)。
- **工作委派可以保留**：contact 的 `assign_session` 是明确需要实现工作时才进入已有 OpenCode worker 的路径，主对话仍属 contact；普通 Session 不应继承助理专属 loader/工具。证据：[`packages/web/server/lib/assistants/DOCUMENTATION.md:254-259`](../../packages/web/server/lib/assistants/DOCUMENTATION.md#L254)、[`assistants/DOCUMENTATION.md:446-460`](../../packages/web/server/lib/assistants/DOCUMENTATION.md#L446)。
- **重要反例：durable message queue 的 assistant target 不能直接拿来接 contact**。worker 调 `service.sendAssistantDelivery`，queue service 再转 `assistantDeliveryService.sendWithCapturedConfig`；该函数验证捕获的旧 session binding、在 stateless 模式创建 execution binding，最终调用 `sendWithConfig`；后者明确 `api.session.prompt(...)`。证据：[`packages/web/server/lib/message-queue/worker.js:29-58`](../../packages/web/server/lib/message-queue/worker.js#L29)、[`packages/web/server/lib/message-queue/service.js:843-846`](../../packages/web/server/lib/message-queue/service.js#L843)、[`assistants/service.js:3944-3961`](../../packages/web/server/lib/assistants/service.js#L3944)、[`assistants/service.js:1528-1534`](../../packages/web/server/lib/assistants/service.js#L1528)。
- **share、session/new、ensure 也不是新 contact 入口**：share 最终走 `submitClaim → sendWithConfig`；contact reset/clear-memory 则明确不调用 OpenCode session/new。证据：[`assistants/service.js:3985-4005`](../../packages/web/server/lib/assistants/service.js#L3985)、[`assistants/service.js:3730-3762`](../../packages/web/server/lib/assistants/service.js#L3730)。
- **不要冒用 peer DM**：DM 对应 Bot 间消息，后续 `enqueueContactTurn(... peer: true)` 进入 `readOnly: peer`；它不是外部真实用户入口。证据：[`assistants/service.js:3577-3580`](../../packages/web/server/lib/assistants/service.js#L3577)、[`assistants/service.js:3870-3941`](../../packages/web/server/lib/assistants/service.js#L3870)。

### Inferences

- **最小合理 mapping** 建议为 `(channelType, channelAccountID, externalPeerID / externalConversationID) → assistantID`，加稳定 binding ID、授权 owner、启用状态及绑定 revision；这些是新增设计，不是现有表。外部消息 ID 应 hash/命名空间化为不超 256 的全局唯一 messageID，例如对账号、peer、外部 ID 组成键做摘要，防止不同渠道/账号碰撞。依据是全局 message_id 主键与当前 send 的幂等行为（见上文 `contact-store.js:12-23`、`service.js:3372,3389-3404`）。
- **第一版应限定为单用户/单已授权 peer 绑定专用 Bot**。当前所有上下文、工具、摘要、记忆召回、lane 都按 assistantID，而不是 peer 分区。若同一 Bot 同时接多个不互相信任的联系人，历史与能力会混用；若同一 Bot 同时在 App 和微信使用，也意味着默认共享上下文。要做独立多人会话，需要新 conversation owner 或分别创建 Bot，不应在 channel adapter 临时过滤历史来伪造隔离。
- **channel 是 I/O 边界，不是新 Agent 引擎**：不复制 persona、工具注册、历史窗口、summary、assign/watch 或 LLM gateway；外部 transport 只应负责登录/接收/发送/媒体协议，映射适配器负责身份、路由、去重、投递状态。
- **不要直接套现有 queue assistant target**。最省事的 PoC 可以在同一进程调用 `send`；需要 durable admission 时，应新增具体 contact delivery target 并改 owning contract，或先由窄小 channel inbox 持有外部 receipt，仍调用同一 `send`。现有 message-queue 的 lease/fencing 思路可借鉴，但直接复用执行器会错误切换引擎。是否改通用 queue 应取决于第二个真实调用方，不能为单个新通道先搭通用框架。

### Gaps

- 外部协议是否允许多个 peer、群聊、原始消息 ID 是否稳定且唯一、context token 是否每次更新，本文不确定；需要协议研究者确认，不能依据微信客服经验填空。
- 没有运行任何集成测试；本节证明的是代码接缝，不证明外部真实收发成功。

## 2. 队列、流式输出、结果收尾与恢复的最小新增责任是什么？

### Takeaway

**当前执行与排队可复用，但可靠消息投递不可零改动复用：contact lane 和生命周期事件均为进程内，202 只代表持久化了 user，并不代表生成任务或外部回复可恢复。现有输出是完整公共 bubble 的增量事件，而不是 provider token streaming；应从已提交的公开消息生成 durable outbox，不能把 SSE 或通知 callback 当可靠出站队列。**

### Cited Findings

- **每 Bot 串行、跨 Bot 独立**：`contactTurnLanes` 是 `Map`，以 assistantID 维护 Promise 链，出错后仍推进；lane 清空才调 summary（3 秒 debounce，一 Bot 一 job）。运行时再读取历史，以 user ordinal 排除后来排入的用户消息，避免 queued turn 混入未来消息。证据：[`assistants/service.js:1867-1934`](../../packages/web/server/lib/assistants/service.js#L1867)、[`assistants/service.js:3453-3466`](../../packages/web/server/lib/assistants/service.js#L3453)。
- **执行/排队没有 durable run 状态**：contact activity 明确是 process-local；controllers、settlement promises 也在 Map 内。相同已持久化 user message 的重复 send 只重放 admission，不会重启 lane。现有 reconcile 只调 share operations 和 worker watches，没有扫描未完成 contact 用户消息重新执行。证据：[`assistants/service.js:259-262`](../../packages/web/server/lib/assistants/service.js#L259)、[`assistants/service.js:1936-1950`](../../packages/web/server/lib/assistants/service.js#L1936)、[`assistants/service.js:3397-3404`](../../packages/web/server/lib/assistants/service.js#L3397)、[`assistants/service.js:3991-3999`](../../packages/web/server/lib/assistants/service.js#L3991)。文档明确 Host restart 不恢复此内存 turn：[`assistants/DOCUMENTATION.md:24-34`](../../packages/web/server/lib/assistants/DOCUMENTATION.md#L24)。
- **当前不是 token 流式推理**：gateway 拒绝 `stream:true`；harness 对 `notify_user` 和最终回复切 bubble，调用 `onBubbleDelta(index, bubble, true)`。`notify_user` 是唯一公开工具期文本，工具旁的 narration 保持私有。证据：[`llm/DOCUMENTATION.md:92-108`](../../packages/web/server/lib/llm/DOCUMENTATION.md#L92)、[`assistants/harness.js:239-247`](../../packages/web/server/lib/assistants/harness.js#L239)、[`assistants/harness.js:408`](../../packages/web/server/lib/assistants/harness.js#L408)、[`assistants/DOCUMENTATION.md:423-427`](../../packages/web/server/lib/assistants/DOCUMENTATION.md#L423)。
- **bubble 稳定标识和持久化已经具备**：ID 为 `${userMessageID}:bubble:${index+1}`，card 为 `${userMessageID}:card:${index+1}`。done bubble 尝试事务插入 complete message，随后最终 `persistContactAssistantReply` 补齐剩余消息和卡片，并按 ID 去重。证据：[`assistants/service.js:1634-1635`](../../packages/web/server/lib/assistants/service.js#L1634)、[`assistants/service.js:1658-1686`](../../packages/web/server/lib/assistants/service.js#L1658)、[`assistants/service.js:1734-1757`](../../packages/web/server/lib/assistants/service.js#L1734)、[`assistants/service.js:1774-1838`](../../packages/web/server/lib/assistants/service.js#L1774)。
- **SSE/notification 没有 durable delivery ack**：`emitContactTurnEvent` 用 microtask fanout，异常被吞掉；`notifyContactTurn` 同步/异步 callback 失败均不影响 turn。现有 Host 装配只把 event 接到 broadcaster，complete 接到通知。证据：[`assistants/service.js:1841-1865`](../../packages/web/server/lib/assistants/service.js#L1841)、[`opencode/feature-routes-runtime.js:294-302`](../../packages/web/server/lib/opencode/feature-routes-runtime.js#L294)、[`feature-routes-runtime.js:353-359`](../../packages/web/server/lib/opencode/feature-routes-runtime.js#L353)。
- **最终成功顺序**：持久化 replies/cards → 清理 active turn → emit `yuri:contact-turn-end complete` → 通知 callback → resolve settlement；通知 body 仅最后一条 spoken bubble 或第一张 card title，不是完整输出。异常路径持久化 error row 再 emit error。证据：[`assistants/service.js:3647-3692`](../../packages/web/server/lib/assistants/service.js#L3647)。
- **错误不是普通 assistant 说话**：持久化 `${messageID}:error`、`status:error`；文档明确它不进入 preview、unread 和 LLM memory，并在下一 contact 更新时清除。证据：[`assistants/service.js:1637-1655`](../../packages/web/server/lib/assistants/service.js#L1637)、[`assistants/DOCUMENTATION.md:42-55`](../../packages/web/server/lib/assistants/DOCUMENTATION.md#L42)。
- **后台结果并非原 user turn 的同步尾巴**：worker settle 和 scheduled results 通过新的 read-only contact continuation，生成新的稳定 resume ID；silent completion 没有 bubble/notification，普通 completion 仍持久化并通知。证据：[`assistants/service.js:3024-3066`](../../packages/web/server/lib/assistants/service.js#L3024)、[`assistants/service.js:3251-3256`](../../packages/web/server/lib/assistants/service.js#L3251)、[`assistants/service.js:3287-3309`](../../packages/web/server/lib/assistants/service.js#L3287)、[`assistants/DOCUMENTATION.md:458-462`](../../packages/web/server/lib/assistants/DOCUMENTATION.md#L458)。
- **读取与清理语义**：`contactMessages` 支持按 cursor 或精确 messageID 获取，返回 generation；reset 删除 transcript 并增加 generation；直接 API wipe 可删除已 admission 用户行，之后同 ID send 可能再次视作新消息。证据：[`assistants/service.js:3702-3728`](../../packages/web/server/lib/assistants/service.js#L3702)、[`assistants/service.js:3753-3773`](../../packages/web/server/lib/assistants/service.js#L3753)。
- **停止影响整个 Bot**：abort 校验旧 binding，随后取消该 Bot 全部 controllers 和 automatic resumes，并将 watches resume_allowed 关掉；没有 channel/peer/turn 专属外部 stop 参数。证据：[`assistants/service.js:3963-3983`](../../packages/web/server/lib/assistants/service.js#L3963)。

### Inferences

- 建议入站 ledger 至少保存 `accountID / peerID / externalMessageID / bindingRevision / contactMessageID / payloadHash / receiveState / admittedAt / outcome`，并把外部拉取 cursor、需要回复的协议 context 单独按账号/peer 持久化（字段是否必需由协议确认）。外部消息确认、cursor 推进与 receipt 写入须有明确顺序，不能收到网络包就永久确认。
- **contact admission ≠ 生成成功 ≠ 外部发送成功**。崩溃窗口至少有：收到但未 admission；user 已落库但 lane 未执行/已中断；工具副作用已完成但 final 未持久化；bubble 已提交但外部未发；外部已发但本地未记 ack。receipt 必须区分这些状态。
- **不要在重启后无脑重放 send**：相同 ID 将被幂等挡住，换新 ID 又可能重复执行工具副作用。第一版可以显式将“已 admission 但未完成”的 turn 标记 interrupted/unknown，提示用户重试；若要求自动续跑，是对 contact turn ownership/恢复契约的额外改造，不是通道 adapter 能独自保证的。
- 建议 outbox 按 `(bindingID, contactMessageID, segmentIndex)` 幂等，正文/卡片转换、分段、重试、错误分类与发送状态归 channel owner。应增加一个**已持久化公共输出**的窄 hook/读取接缝，或基于持久消息游标回补；不能只监听易失的 bubble event。若要数据库原子性，可让 assistant 输出事务同步登记轻量 delivery 事件，再由 channel 生成 outbox；避免在 DB 事务里 await 外部网络。
- 第一版可在 turn-end 后从该 turn 的已提交 rows 发最终输出；需新增按 turnID 的读取/输出接缝，避免只拿 `onContactTurnComplete.body` 丢掉前面的 bubble、卡片和错误类型。若支持即时进度，则每个 done bubble 入 outbox，final reconciliation 不得重发已发进度。
- 完成回调适合唤醒 dispatcher，不适合承担可靠投递本身。`whenContactTurnSettled` 在源码中标记为 in-process test hook，返回状态不返回完整 replies，且其 Map 不持久；生产 channel 应获得显式 lifecycle contract，而非将测试 hook 当长期队列。
- **后台异步通知路由必须设计**：worker resume 没有原始微信 user turn，不能靠“最近收到消息的 peer”回信，否则误投；绑定专用 Bot 可先把可见后台回复投给该唯一 peer。多渠道共享 Bot 时，应该持久化 worker/task 的订阅来源或明确选定一个通知目标，不能把 App 消息和所有 Bot 间 DM 无条件广播到微信。
- 卡片最小降级为安全纯文本摘要；只有产品有可访问地址、且接收者已授权时才附链接，不发送本机绝对路径或未经授权的 session deep-link。error 另走固定、安全的失败提示，不直接转发未知上游错误原文。外部消息送达/已读不能直接等同于 App 共享 read watermark。
- 清空历史后 inbound receipt 应继续去重，否则平台重投会重演已删除操作；outbox 需要 generation/binding fencing，清理/解绑后不能发送旧内容。
- 新通道不应自行引入 latest-wins；当前用户 turn 按 Bot 串行，新用户会取消后台通知但不自动中止之前的用户 turn。若外部希望打断/替换，应作为明确产品契约，在 contact owner 增加 turn 级控制，不把客服系统的抢占模型移植过来。

### Gaps

- 外部平台的主动消息时效、可发送条数、消息长度、幂等/ack 接口、富媒体能力尚未验证。若没有服务端幂等，网络超时后的 exactly-once 无法仅由 Yuri 保证，必须显式保留 delivery_unknown。
- 所读源码没有可靠 contact run 自动恢复机制；没有在此研究中测量长任务、多 Bot 并发或账户限流。

## 3. 已有微信客服/relay、配置凭据、生命周期与推荐改动范围如何划分？

### Takeaway

**当前仓库没有可确认的微信客服消息通道实现，也没有现成的 ilink/ClawBot adapter。现有 Yuri private relay 是客户端到 Host 的 E2EE 应用隧道，不是微信客服 relay。新增微信 AI 分身应作为 `packages/web` 中独立、显式启用的 Host-owned channel runtime，复用助理 service，不污染 OpenCode/global Skill，不把账号 token 暴露给 UI/模型或挪用 Yuri pairing 凭据。**

### Cited Findings

- 全仓 `wechat|weixin|WeChat|微信客服|ilink|ClawBot` 搜索未发现运行时微信通道代码，命中主要为 UI 交互比喻和架构比较文档。该比较文档明确区分 `Y:` yi-agent 仓库与 `O:` Yuri，并把 `plugins/wechat/*`、`wire/wechat/*` 等列为另一仓库实现，而非 Yuri。**这只是当前搜索范围的负面证据，不能推断其他机器/部署无客服服务。** 证据：[`docs/customer-service-background-assistant-design.md:59-73`](../../docs/customer-service-background-assistant-design.md#L59)、[`docs/customer-service-background-assistant-design.md:494-500`](../../docs/customer-service-background-assistant-design.md#L494)、[`docs/customer-service-background-assistant-design.md:571-579`](../../docs/customer-service-background-assistant-design.md#L571)。
- **private relay 的职责**：Yuri Host 主动出站连接，为移动端/浏览器/其他桌面传 HTTP/SSE/WS；relay 看不到明文，Host/Client 才是端到端。Host runtime 限 desktop 或 ssh-remote；普通 web/CLI/HMR 不应抢 host socket。证据：[`packages/web/server/lib/relay/DOCUMENTATION.md:3-24`](../../packages/web/server/lib/relay/DOCUMENTATION.md#L3)。
- **relay 不授予业务身份**：隧道不注入 credentials，服务端仍用普通 bearer/session 认证；配对是 Yuri client 的 pairing-v2，并不是外部微信登录。证据：[`relay/DOCUMENTATION.md:47-55`](../../packages/web/server/lib/relay/DOCUMENTATION.md#L47)、[`relay/DOCUMENTATION.md:71-85`](../../packages/web/server/lib/relay/DOCUMENTATION.md#L71)。
- **多进程争用已有教训**：relay 每数据目录共享身份，需要 host claim；`host-lock.js` 说明该 claim 只是 cooperative，不是可依赖的原子 OS lock，relay worker 才执行单 host slot 仲裁。证据：[`packages/web/server/lib/relay/host-lock.js:1-19`](../../packages/web/server/lib/relay/host-lock.js#L1)。
- **助理服务装配位置**：`feature-routes-runtime` 用 Host `yuriDataDir/assistants.sqlite` 创建 service，绑定项目 registry、scheduler、global event hub、通知，并向 message queue 注入 service；该 runtime 的 close 关闭 assistant routes。证据：[`packages/web/server/lib/opencode/feature-routes-runtime.js:280-311`](../../packages/web/server/lib/opencode/feature-routes-runtime.js#L280)、[`feature-routes-runtime.js:345-360`](../../packages/web/server/lib/opencode/feature-routes-runtime.js#L345)、[`feature-routes-runtime.js:561`](../../packages/web/server/lib/opencode/feature-routes-runtime.js#L561)。
- **Bot 自身配置不是凭据存储**：`assistant_v2` 存 name/prompt/workspace/provider/model/agent/variant/mode/binding，create/update 有字段 allowlist，不含渠道账号/token；DTO 返回这些公开设置。证据：[`assistants/service.js:263-264`](../../packages/web/server/lib/assistants/service.js#L263)、[`assistants/service.js:1429-1433`](../../packages/web/server/lib/assistants/service.js#L1429)、[`assistants/service.js:1487-1500`](../../packages/web/server/lib/assistants/service.js#L1487)、[`assistants/service.js:408-443`](../../packages/web/server/lib/assistants/service.js#L408)。
- **现有一般设置文件并非通用 secret vault**：settings 原子临时文件写入再 rename，process-local 持久写锁（可被 Electron 注入独占 runner）；这段 writer 没显式设置 0600。lenient reader 将错误转 `{}`，strict reader 才区分真实缺失与损坏/权限故障。relay 私钥目前就在 settings 的专属字段。证据：[`packages/web/server/lib/opencode/settings-runtime.js:67-88`](../../packages/web/server/lib/opencode/settings-runtime.js#L67)、[`settings-runtime.js:468-506`](../../packages/web/server/lib/opencode/settings-runtime.js#L468)、[`settings-runtime.js:547-563`](../../packages/web/server/lib/opencode/settings-runtime.js#L547)、[`packages/web/server/lib/relay/signing-key.js:17-47`](../../packages/web/server/lib/relay/signing-key.js#L17)。
- **已有凭据类别不能混用**：Yuri remote client bearer 服务端仅存 SHA-256 hash（用来校验客户端入站），不适合存需要出站使用的微信账号 token。OpenCode provider credentials 由外部 OpenCode resolver 持有，不跨推理 RPC；config-sync 仅在显式选择的认证传输里迁移 provider credentials，不是微信账号通用存储。证据：[`packages/web/server/lib/client-auth/remote-clients.js:53-57`](../../packages/web/server/lib/client-auth/remote-clients.js#L53)、[`remote-clients.js:79-93`](../../packages/web/server/lib/client-auth/remote-clients.js#L79)、[`packages/web/server/lib/ui-auth/DOCUMENTATION.md:4-8`](../../packages/web/server/lib/ui-auth/DOCUMENTATION.md#L4)、[`llm/DOCUMENTATION.md:33-39`](../../packages/web/server/lib/llm/DOCUMENTATION.md#L33)、[`config-sync/DOCUMENTATION.md:57-58`](../../packages/web/server/lib/config-sync/DOCUMENTATION.md#L57)。
- **现有私有存储写法可借鉴而非视为现成通用库**：Magpie auth 使用 private atomic replacement、0600 staging、0700 目录。证据：[`packages/web/server/lib/config-sync/magpie-auth.js:60`](../../packages/web/server/lib/config-sync/magpie-auth.js#L60)、[`magpie-auth.js:82`](../../packages/web/server/lib/config-sync/magpie-auth.js#L82)。
- **Host 不依赖打开 UI 执行后台结果**：文档明确 scheduler/worker review 为运行 Host 持有。Electron 同一主进程启动 Yuri server，无 sidecar；退出会停 Host，但共享 OpenCode 服务可以继续运行。证据：[`assistants/DOCUMENTATION.md:168-170`](../../packages/web/server/lib/assistants/DOCUMENTATION.md#L168)、[`packages/electron/README.md:7-17`](../../packages/electron/README.md#L7)、[`electron/README.md:64-66`](../../packages/electron/README.md#L64)。
- **关机顺序需接入**：graceful shutdown 停 scheduler 后调用 `closeFeatureRoutes`，但当前未 await 该 close；assistant close 会 abort controllers、清摘要/定时器、unsubscribe、关 SQLite。新 channel 如果需要等待长轮询/dispatcher settle，不能只在现有同步 close 中随手 fire-and-forget。证据：[`packages/web/server/lib/opencode/shutdown-runtime.js:45-54`](../../packages/web/server/lib/opencode/shutdown-runtime.js#L45)、[`assistants/service.js:4089-4104`](../../packages/web/server/lib/assistants/service.js#L4089)。
- **部署可用已有常驻形态**：web README 提供 CLI startup service、daemon、headless/API-only、systemd 前台运行和 data 持久化；HMR 隔离同时分开 OpenCode 数据与 Yuri 助理状态，文档禁止不同 OpenCode DB 的 Host 共享 assistant watches。证据：[`packages/web/README.md:48-58`](../../packages/web/README.md#L48)、[`web/README.md:78-97`](../../packages/web/README.md#L78)、[`web/README.md:142-150`](../../packages/web/README.md#L142)、[`web/README.md:205-239`](../../packages/web/README.md#L205)。
- **新增外部入口权限风险真实存在**：普通 interactive contact 会创建 pi coding runtime，附 coding tools、Host skills 与 Bot prompt；readOnly 才剔除 coding tools。助理专属工具隔离并非文件系统/命令沙箱。证据：[`assistants/harness.js:503-538`](../../packages/web/server/lib/assistants/harness.js#L503)、[`assistants/DOCUMENTATION.md:297-309`](../../packages/web/server/lib/assistants/DOCUMENTATION.md#L297)、[`assistants/DOCUMENTATION.md:369-373`](../../packages/web/server/lib/assistants/DOCUMENTATION.md#L369)。

### Inferences

#### 推荐最小模块边界（提议，尚未实现）

```text
微信 AI 分身服务（协议待验证）
        ⇅ 专属 transport：登录、拉取/回调、发送、媒体
packages/web/server/lib/assistant-channels/
  wechat-ai/transport.js  只处理已验证的微信 AI 分身协议
  store.js               账号元数据、绑定、inbox receipt、cursor、outbox
  runtime.js             启停、单账号消费 ownership、去重、路由、退避
  routes.js              认证的设置/绑定/状态接口，回调入口仅在确有需要时单独校验
        ↓ 注入 assistant service，不向普通 Session 注册工具
assistants/service.js send()
        ↓ 每 Bot lane
assistants/harness.js / pi + existing LLM gateway
        ↓ 已提交公共输出接缝
channel outbox → wechat-ai transport
```

- 目录名是建议，不要求先造 channel provider registry/plugin framework。只有这一种通道时，优先少量具体模块；未来第二种通道共享的只是 receipt/mapping/outbox 和 runtime contract，不能提前把客服/AI 分身协议硬合并。
- **必要触点**：`assistants/service.js` 增加已提交输出/终态的窄接口，覆盖 user turn 和后台 continuation；`assistants/routes.js` / `opencode/feature-routes-runtime.js` 注入同一 service 并装配 channel；`opencode/shutdown-runtime.js` 允许 await channel 停止，先停入站再处理/冻结出站，最后关闭 assistant/store。不应把 transport 网络逻辑继续堆进已有 4,100 行 service。
- **配置/凭据**：Bot 设置只增加绑定的安全摘要或用独立 channel settings API，账号凭据由 Host 专属可恢复 secret store 保存（私有目录、0600、原子写、strict read、明确撤销与清理），不进入 Bot prompt、contact history、snapshot、通用 config response 或日志。不要声称现有 settings 已有 OS 级加密；如果要求系统钥匙串，需额外设计跨平台与 headless fallback。与本机运行身份绑定的凭据不应自动随 provider config-sync 跨 Host 迁移。
- **账号唯一消费者**：默认只由用户明确启用的一个 Host 持有 account poll/receive ownership，避免 Desktop/HMR/CLI 同时消费一个账号。不能直接复制 relay 的 cooperative PID claim 就宣称多进程正确，应有 OS/SQLite 原子 lease 与 fencing，或平台有可验证的唯一消费者仲裁；跨机器共享账户还需产品明确处理。
- **授权必须在 channel runtime/service 边界执行**：绑定/解绑仅 owner，入站 peer allowlist 校验、被盗/过期账号立即冻结、媒体大小/MIME/来源约束、主动通知目标约束；不能靠“只给自己发微信”的 prompt 当安全边界。外部通道获得的是 Host 用户身份下的 read/write/bash 和委派能力，不只是聊天模型。
- **部署**：最小可运行于现有 Desktop Host 或常驻 CLI/SSH-managed Yuri Host。后台需要 Host 与外部 OpenCode 可用；Desktop 退出/机器睡眠就不可依靠它持续接单，24h 应选择常驻服务器。若外部协议支持纯出站拉取，不需要 Yuri private relay；若需平台 callback，则另行部署/校验公网入口，不能扩大现有 `/api` 匿名权限或借用 pairing secret。
- **移动端/VS Code**：手机只是连接同一 Host 的 UI，不在 WebView 内轮询微信；extension-only VS Code 目前不是 assistant Host，不应为首版新增单独执行器。设置 UI 若建设，应沿用 RuntimeAPIs/query/auth 边界，独立于原生 shell；不要为通道功能修改 Electron 主进程协议，除非真的引入钥匙串/扫码窗口等原生能力。

#### 大致工作量（分析估算，不是事实或承诺）

假设外部协议已由另一研究者证实可用、登录态可获取、先做单账号/单授权 peer、纯文本、不新增原生依赖：

| 范围 | 估算 | 说明 |
| --- | --- | --- |
| 受控 PoC | 2–4 人日 | transport + 专用 Bot 绑定 + `send()` + 终态读回发送；只证明闭环，不声称重启/断网可靠 |
| 可日常使用的最小版本 | 7–12 人日总量 | 私有凭据、inbox/outbox、超时未知态、账号唯一消费者、重连/撤销、后台结果路由、安全设置/状态、真实 Host 测试 |
| 多账号/多联系人隔离、媒体、完整工具交互、自动 contact run 恢复 | 另计约 1–3 周或更高 | 多人模型可能需要新的 conversation owner；自动恢复涉及副作用与执行归属，不是 transport 工作 |

上述范围不含平台资质审批、风控、二维码授权交互未知项与所有协议逆向成本。工作量主要在**可靠投递、权限和恢复**，不在重新实现 Agent。

#### 建议验证矩阵（未执行）

1. 入站重复、相同外部 ID 异内容、跨账号 ID 碰撞、未授权 peer、解绑后旧消息重投。
2. 同 Bot App/微信连续消息保持 lane 顺序，不混入后排 user；不同 Bot 不相互阻塞。
3. `notify_user`、最终多 bubble、card-only 成功、error、cancel、silent review 不漏发不重复，不暴露推理/工具返回原文。
4. worker/task 在原微信请求结束后返回，仍投给正确 binding；App 发起的无关消息不泄漏给微信。
5. 五个崩溃窗口、外部发送超时的 unknown、账号失效、cursor 提前确认、retry/backoff、Host 重启/关闭、两 Host 争用。
6. clear history/generation、删除 Bot、更换绑定、附件释放和撤销清理；旧 receipt 保持去重，旧 outbox 不晚到误发。
7. 真实常驻 Host + 外部 OpenCode inference bridge，以及真实微信账号端到端验收。源码与 mock 测试不能代替此项。

### Gaps

- 用户提到的微信客服 relay 恢复流程可能位于其他仓库/公网部署或技能里；本次只读 Yuri 当前仓库，没有访问容器/线上服务，也没有把历史记忆或技能示例当作当前实现证据。
- 未穷举全仓所有 secret storage；结论只是所读 assistant/settings/relay/client-auth/LLM 模块没有可直接拿来存微信出站凭据的通用 vault。具体实现前还应复核安全 owner 和 UI 设置的最近文档。
- WorkBuddy/OpenClaw 与微信 AI 分身的登录、消息 context、配额、限流、媒体、主动发送和合规限制，由外部协议研究者补齐；不能混用企业微信客服的 AppSecret/CorpID/open_kfid 等概念。
