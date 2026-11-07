# NSH 与当前 Web 移动端逐功能对齐审计

> **后续实施状态**：本文以下保留最初只读审计快照，其旧行号及“缺/本次未运行”不能作为当前实现结论。Chat 后续接线、测试、真实 Host 与 UIKit 证据及未关闭差异见 [CHAT-VALIDATION.md](./CHAT-VALIDATION.md)。原 checklist 仍限定完整交付范围，新增代码或测试不自动勾选验收。

审计日期：2026-11-07。范围是**当前 Web 手机端全部实际行为及其二级页、弹层、Agent 交互**，并列出 Capacitor 原生增补；优先级只安排先后，不缩减 scope，不把缺失功能排为“非 MVP”。本次只读源码和指定截图，仅写本文；未读设备凭据、未运行真实对话、未执行 git/GitHub、未安装依赖。未操作主线程的 5180 服务。

## 证据口径（先读）

- **C：代码接线**：读到生产入口、处理函数或协议调用。不是功能通过验收。
- **F：fixture/单测定义**：读到测试及其模拟输入，**本次未运行**。测试名中的 real/native 不等于真实 Host。
- **H：真实 Host**：本次没有。必须由负责联调的主线程/其他执行者提供请求、事件、最终历史的脱敏证据。
- **S：模拟器**、**D：真机**：本次均没有。源码中的 UIKit/Glass/picker 不证明显示、手势、键盘正确。
- 下表“有/部分”一律是 C；“缺”指已读 NSH 路由、渲染、状态或原生方法没有对应入口/处理，不推断外部 NSH 引擎能力。验收步骤全部待执行，不是已完成清单。
- 环境后缀：`H` 需真实 Host；`S` 可先模拟器；`D` 必须物理设备；`W` 需当前 Web 手机布局作对照。网络项须分别测直连与已授权 Relay。

## Top blockers

1. **P0：没有本次真实 Host 对话证据**。fixture 的固定回复不能交付“真实会话/模型/流式完成”。先完成新会话→发送→持续文字/工具→结束→重开历史的完整证据链。
2. **P0：session 流式不是 Web 的 live overlay**。`state.ts:403-437` 对普通会话事件安排 GET；仅 contact bubble delta 在本地追加。`TextView options.streaming` 只是渲染选项。对照 Web `sync/transcript-event-reducer.ts:309-422` 的 part update/delta 与 V2 overlay 分派，必须验证当前 Host 流式事件的实际形状、首字和中间工具状态，而非只看终态。
3. **P0：用户交互语义缺口**：slash、@文件/Agent/skill/session、shell、session variant、queue 管理、消息编辑/回退/重开、Agent 子任务跳转不能用普通文本输入代替。
4. **P0：返回/重开时草稿没有持久化合同**。`createChat` 每次创建局部 draft/attachments/pendingSend；只见 appearance/language 存 Storage。未知发送的恢复仅限当前实例，进程退出不保证恢复。
5. **P1：项目首页不是截图功能对齐**。只有目录严格相等的会话列表，首页截 12 条；没有 pinned/in-progress、工作树分组、展开、侧滑、排序、完整搜索。
6. **P1：设置仅连接、明暗、语言、硬编码 About**。Web 手机可达的 21 个设置 slug 绝大部分缺失；聊天选模型不等于 Provider/Agent 设置。
7. **P1：Bot/计划/资源缺关键闭环**：Bot 未读/置顶/频道/分享/附件；计划历史/过滤；真实图像/媒体、HTML/localhost/插件预览；远程桌面均未对齐。

## 1. 指定截图对照

已实际读取 `site/assets/shots/` 下以下五张 WebP。截图只证明参考画面，不证明服务端功能运行；最新代码优先于旧截图。

| 截图 | 观察到的用户能力与布局 | NSH 代码现状 | 待验收 |
| --- | --- | --- | --- |
| `m-home.webp` | 大标题、搜索/＋、置顶/进行中卡、项目统计/时间/状态、折叠箭头、会话更多、四 Tab | `application.tsx:251-405,1443-1515` 只有 Yuri 标题、搜索输入、项目卡/新会话与列表 | W/S：同一 Host 同一数据逐区对照，不能仅核对 Tab 名称 |
| `m-swipe.webp` | 会话向左滑出置顶与归档，行主体随手指移动 | NSH Projects/ProjectPage 行只有 Button；没有滑动轨道或操作回调 | W/D：慢滑、取消、纵滚、切行收起、点置顶/归档、返回后同步 |
| `m-assistants.webp` | 助理大标题、＋、头像/摘要卡片、根 dock | `Bots` 有创建、静态头像/摘要与打开；没有同等顶部结构与滑动/长按 | W/S：三个 Bot、长名称/emoji、空/失败状态；D：触控 |
| `m-schedule.webp` | 任务/历史记录、全部/已启用/已暂停、＋、状态/时间/历史/更多 | `Schedules` 只有创建与名称/启停文字，详情有暂停/运行 | W/H：相同任务/运行记录逐条比较 |
| `m-asr-send.webp` | 新聊天欢迎/快捷建议、项目提示、附件/麦克风、Agent/模型、发送、顶部上下文/菜单 | `Chat` 有普通输入、系统 Speech、附件和发送，模型/Agent 独立二级页；无同等欢迎/上下文/快捷入口 | W/D/H：听写→校正→选模型→发送，中文 IME 与键盘遮挡 |

## 2. 证据索引

以下路径均相对仓库根；表内简称指这些实际读取过的生产文件/区段。

| 简称 | 文件 / 已核对区段 |
| --- | --- |
| N-App | `packages/nsh/application.tsx`：Route 69-80；Projects 251-405；Bots 407-454；Schedules/详情 456-616；Settings 618-753；Chat/工具/卡片 755-1208；Models 1210-1305；Files/Changes 1307-1441；根导航 1443 起 |
| N-State | `packages/nsh/state.ts`：连接/refresh 23-118；createSession 119-125；生命周期 126-177；createChat/load 182-303；send/reconcile/retry 304-374；stop/permission/form 375-402；事件/前后台 403-462 |
| N-Model | `packages/nsh/model.ts`：projects/sessions 18-28；消息投影 29-55；事件/活动/合并 68-112 |
| N-Edit | `packages/nsh/features.tsx`：catalog 141-319；BotEditor 342-593；TaskEditor 595-1043 |
| N-Block | `packages/nsh/blocking.tsx`：字段类型/条件/验证 25-193；PermissionRequest 461-589；BlockingRequests 591-643 |
| N-Native | `packages/nsh/ios/RuntimeBridge.swift`：方法注册 59-84、请求 101-180、上传 182-214、配对 215-311、SSE 312-370；`ios/main.swift:18-94`；`ios/AttachmentBridge.swift:19-103` |
| W-Home | `packages/ui/src/mobile/projects/MobileProjectsHome.tsx`；`MobileProjectCard.tsx`；`MobileSessionRow.tsx`；`MobileProjectsHomeContainer.tsx:76-240`；`mobile/sessionMenuModel.ts` |
| W-Nav | `packages/ui/src/mobile/MobilePhoneShell.tsx:123-344`；`MobileGlobalSearchHost.tsx`；`apps/MobileApp.tsx:2783-2910,2990-3314` |
| W-Chat | `packages/ui/src/components/chat/ChatInput.tsx`：selection/variant 1238-1803、slash/@目录 2076-2139、发送/dictation 4250-4355、IME 4385 起；`components/chat/DOCUMENTATION.md`；`composer/DOCUMENTATION.md`；`sync/session-prompt-api.ts`；`sync/session-projection-api.ts:1-260`；`sync/transcript-event-reducer.ts:250-434` |
| W-Bot | `packages/ui/src/mobile/assistant/MobileAssistantTab.tsx`；`components/assistants/AssistantView.tsx` 入口检索；`components/assistants/DOCUMENTATION.md:58-233`；`components/sections/assistants/AssistantsSettingsPage.tsx` 及 `AssistantChannelsGroup.tsx` 生产字段/入口检索 |
| W-Task | `packages/ui/src/components/session/ScheduledTasksDialog.tsx`：生产 history/filter/run/editor handlers 检索及 410-509；`mobile/scheduled/MobileScheduledTab.tsx` |
| W-Settings | `packages/ui/src/mobile/settings/MobileSettingsTab.tsx`；`lib/settings/metadata.ts:84-106`；`components/views/SettingsView.tsx:500-510,1020-1145`；各目标页见第 6 节 |
| W-Resource | `packages/ui/src/apps/MobileFilesSurface.tsx:1-200` 及实际 HTML/GuiFileLinkBridge 渲染检索；`mobile/RemoteDesktopPanel.tsx:1-220`；`lib/gui-plugins/DOCUMENTATION.md:1-180` |

## 3. 项目与会话目录 checklist

| ID / 优先级 | 入口→触发→应有结果 | NSH 现状 / 代码证据 | 具体验收步骤（均未执行） |
| --- | --- | --- | --- |
| P01 / P1 | 项目 Tab→项目头→原地折叠分组，显示数量/时间/活动 | 部分：N-App Projects 点头 push ProjectPage，不是原地展开；N-Model 只保存 id/name/path。W-Home 卡片有 expanded/sessionCount/activity | [ ] H/W/S：准备两项目各 >12 会话；折叠/展开后切 Tab 返回，核对统计与保留位置 |
| P02 / P1 | 置顶/进行中区→打开/取消置顶→同一实体归位 | 缺：N-Model Session 无 pinned/unread/live 指示；W-Home:619-663 有两个集合，容器有 pin mutation | [ ] H：A 置顶、B 运行；确认分区不重复、B 完成后迁移、另一客户端 pin 同步 |
| P03 / P1 | 搜索图标→搜索二级页→查会话/命令/项目等并导航 | 部分：N-App:303-312 只按当前已载 session.title 过滤且 slice(0,12)，不是 W-Nav CommandPalette 独立页 | [ ] H/W：搜第13条、项目名、已有命令；点结果再返回保留原页；逐域结果另核实 CommandPalette（见未检范围） |
| P04 / P1 | 会话左滑/长按/更多→置顶、归档、重命名、分享、刷新、删除 | 缺：N-App 行无动作；W-Home MobileSessionRow:123-126 轨道，sessionMenuModel:88-166 全菜单；容器有归档/撤销/刷新 | [ ] D/H：分别执行菜单项，验证归档撤销/失败保留；忙碌刷新禁用；删除仅测试数据 |
| P05 / P1 | 项目更多→新会话/新工作树/同步/编辑/关闭 | 部分：NSH 只有新会话；W sessionMenuModel:169-217 定义条件项目菜单 | [ ] H：在测试项目逐项操作并重开；核对非 Git 项目不提供工作树创建 |
| P06 / P1 | 工作树标签→展开/新会话/侧滑删除→目录隔离 | 缺：NSH 以 session.directory===project.path 过滤，无 topology。W-Home:213-513,716-748 有独立 worktree rail/groups | [ ] H/D：主树与两个工作树同名会话；各创建/切换/删除确认，不串目录 |
| P07 / P1 | 更多会话/拖排→展开完整目录与持久顺序 | 缺：首页固定12条，项目详情只展示已拉取会话；无排序。W 容器:90-100,169-178 有 reorder/showMore | [ ] H/D：>30条，展开更多/收回、拖排后重启核对顺序 |
| P08 / P0 | ＋新聊天→选择项目/草稿→首次发送实体化 | 部分：N-State createSession 立即 POST /api/session；没有 W-Nav openDraft 的无实体草稿路径 | [ ] H：取消空草稿不生成多余会话；首次发送只创建一次；项目默认模型/草稿恢复（待补） |
| P09 / P1 | 添加项目→Host 目录选择→登记后首页可见 | 有接线：N-App:263-274,1324-1335；/api/fs/home→list→POST /api/opencode/directory | [ ] H/S：选深层目录、取消、拒绝权限、重复添加；确认失败不假成功 |

## 4. 普通会话、Composer 与 Agent 交互 checklist

| ID / 优先级 | 入口→触发→应有结果 | NSH 当前真实实现/缺失（C） | 具体验收步骤 |
| --- | --- | --- | --- |
| C01 / P0 | 点已有会话→加载真实历史→角色/顺序一致 | 有分页接线：N-State:235-274 limit20/order desc/opaque cursor；N-Model:29-55 投影。不是实测 | [ ] H：已知 >45条历史连续加载三页，核对边界、重复/遗漏、role 与时间顺序 |
| C02 / P0 | 输入→发送→Host admit→同ID历史用户行/真实模型回复 | 有：N-State:317-359 用 stable id、steer/queue；admission 校验后清草稿。没有真实模型证据 | [ ] H：发送唯一标记；记录 admit ID、SSE、最终 projection 同ID；重开仍可见；无双用户行 |
| C03 / P0 | 模型/Agent→选目录有效模型与 Agent→后续生效 | 部分：N-App Models POST model/agent；无当前选中反馈、footer身份/Agent快捷循环，列表未按 editor catalog 的 hidden/subagent 过滤 | [ ] H/S：切两模型两Agent、返回/重开查权威选择；切后下轮确实使用；不可把列表显示视为生效 |
| C04 / P0 | variant/thinking selector→更改→发送保留 | 普通 session 缺：Models 无 variant；N-Edit catalog 仅 Bot/计划有 variant | [ ] H：同模型选两个 variant，验证 payload/权威 session 与重开恢复 |
| C05 / P0 | `/`→命令建议→选命令/参数→原生命令路由 | 缺：NSH draft 直接进 text；无 CommandAutocomplete/parser/command dispatch。W-Chat 有 knownSlashNames、parseSlashCommandInvocation | [ ] H/S：选已注册测试命令、带参数命令、未知 slash；验证不是把所有命令发成普通 prompt |
| C06 / P0 | `@`→文件/目录/Agent/skill/session 选择→引用可删除、发送语义正确 | 缺：N-App Input 无 autocomplete；N-State prompt 只有 text/files。W-Chat 与 composer 文档有 confirmed mentions、skills、session sidecars | [ ] H/D：逐类选引用，中文/空格路径，撤销/删除/重开；核对 Agent/skill 原生附加语义，不仅文本着色 |
| C07 / P0 | shell 模式→输入测试命令→shell记录/输出 | 缺：NSH 无 inputMode 或 shell dispatch；N-Model 仅能展示已有 shell command/output 文本；W-Chat 有 normal/shell 发送路径 | [ ] H：只用无副作用命令；验证执行路径/退出码/输出、退出shell后普通聊天 |
| C08 / P0 | ＋→照片/文件→上传→单附件或带文发送 | 部分：N-App session-only attach；N-Native picker单选、25MiB SHA256 PUT/校验、返回Host file URI。NSH不复用 Web 的非图像 synthetic reference 编译 | [ ] H/D：照片、PDF/文本、仅附件、取消、失败、重试、切Host中途返回；核对非图像不会被错误注入上下文 |
| C09 / P0 | 历史/回复图像→缩略图→全屏缩放/保存 | 缺：N-App:911-924 files 只显示名称/MIME；没有授权图片读取/图片preview/save。头像 Image 不证明消息图像支持 | [ ] H/D：模型返回/历史图片，直连与Relay显示、放大、保存、拒绝相册权限；切会话不串资源 |
| C10 / P0 | 实时回复→逐步文本/reasoning/工具状态→最终历史收敛 | 部分：普通会话事件120ms合并GET，4s safety poll；只有contact delta本地拼接。N-State:403-458；N-App TextView streaming | [ ] H/S：长回复跨多个网络包、工具 pending/running/completed/error；记录首字/增量/终态，必须在结束前看到多次增长 |
| C11 / P1 | Markdown→代码/表/数学/Mermaid/链接→相应交互 | 部分：N-App TextView markdown/selectable/code-copy/links=open；未读到数学/Mermaid、相对Host文件/localhost解析与图库 owner | [ ] H/S：同一Markdown用Web/NSH对照；不完整围栏→闭合、中文表格、公式、Mermaid、file/localhost链接；不把外部浏览器误当Host预览 |
| C12 / P0 | 工具行→展开→输入/输出/错误/文件diff/子Agent | 部分：N-App ToolRow仅 JSON dump；无 W 手机 Read/patch diff sheet 或子session导航；N-Model tools仅content.type=tool | [ ] H：触发安全Read、测试patch、子Agent；每行有可理解摘要/流状态；点文件/子任务进入准确目标并返回 |
| C13 / P0 | permission→once/always/reject+说明→等待Agent继续 | 有 session接线：N-Block:461-643；N-State:386-392。Bot目标不拉permission | [ ] H/D：分别授权/拒绝，核对资源、保存范围、双击防护、失败重试、另一端已处理收敛；busy不得锁死按钮 |
| C14 / P0 | form/question→条件字段/选择/自由输入/提交/取消 | 有类型/条件校验接线：N-Block；N-State:394-401；未证明覆盖所有 Web Agent 交互（委派等） | [ ] H/D：string/number/integer/bool/multiselect/external、eq/neq依赖、必填、未知schema、取消、提交失败；超长表可滚动且不遮输入 |
| C15 / P0 | 运行中Stop→interrupt→真实停止且状态归零 | 有：N-App busy显示Stop；N-State:375-384；Bot先取 sessionGeneration 再abort | [ ] H：长回复中停止，验证Host terminal状态与不再增量；断网Stop失败不得假idle；多session只停目标 |
| C16 / P0 | 运行中继续发送→queue卡→编辑/取消/立即steer | 部分：N-State busy自动queue；N-App:931-940只显示pending text，无编辑/删/PATCH delivery/去重复投影。Web session-prompt-api有这些mutation | [ ] H：运行时排2条；分别编辑/取消/steer；消费后只见同ID历史，当前实现不能勾选闭环 |
| C17 / P0 | 发送超时→保留输入→retry reconcile→不重复 | 有当前实例接线：N-State:304-374 保存相同ID/payload/delivery；确定4xx释放pending；未持久化 | [ ] H：Host已admit但丢响应、未admit断网、用户已改草稿三场景；重试不新ID、不清新编辑；杀进程恢复另记失败 |
| C18 / P0 | 关闭/重开/切session→恢复草稿、附件、发送未知状态 | 缺持久化：createChat局部signal；没有 DraftKey/Storage 草稿写入。Web composer文档有durable DraftRecord与CAS | [ ] S/D/H：A/B不同草稿、返回列表重开、进程杀死、上传中退出；确认独立恢复，不只测试页面仍留栈 |
| C19 / P0 | 消息操作→复制/编辑重发/回退/redo/fork/重开 | NSH仅selectable/代码copy；没有消息操作/restore接口。Web ChatInput:550-702有reverted dock与fork/restore，composer文档有sent-edit恢复 | [ ] H：在测试对话编辑一轮、回退/恢复、fork；核对文件与草稿回滚，不能只删除屏幕行 |
| C20 / P0 | 卡片/子任务→多级聊天→逐级返回原Bot/父session | 部分：N-App ResourceCard支持session/Bot/schedule push；NavStack保留前页；无子Agent工具跳转/authoritative parent修复。W-Nav显式returnTo、两页窗口、btw路由 | [ ] H/D：Bot→任务session→子session→返回三次；返回/取消边缘手势、不活跃页不得发送或持有采集 |
| C21 / P0 | 断网/切后台→恢复→补齐消息不伪造空闲 | 有scope fence、前台poll/stream清理、断线保留busy、重连拉取；补页最多5次，hasGap未见UI提示（N-State:243-259/N-App） | [ ] H/D：后台5分钟期间Host继续、断网跨>120条、切Host中途旧响应；恢复核对连续性/明确缺口，不把未知当空 |
| C22 / P1 | 滚动历史→持续流不抢阅读→跳最新/加载旧页锚点 | 部分：N-App inverted List；无明确阅读锚点/跳最新/未读控制代码 | [ ] D/H：>100消息与图片晚到，停在中间时流式/前插，位置不得跳；返回底部仍能跟随 |
| C23 / P1 | 麦克风/按住讲话→实时转写→编辑/取消/发送 | 部分：N-App:768-803系统Speech写draft，点第二次stop，不自动发；无Web provider配置/hold-to-talk目标/inline provisional合同 | [ ] D/H/W：中文说话、系统权限拒绝、校正、点停、后台、切页；分别验收Web现有按住与点击录音，不用系统听写替代全部 |
| C24 / P1 | 上下文圆环/菜单/自动朗读/Tasks/Changes/Goal→展开/动作 | 缺对应接线：NSH聊天header仅models/editor；W MobileChatScreen有context popover，MobileApp有files/changes/MCP/refresh/remote菜单，文档有auto-read/Tasks | [ ] H/D/W：逐项打开/互斥/返回，朗读停止/后台释放；Goal与Agent自动委派细项见未检范围，仍在scope |

## 5. Bot 与计划 checklist

| ID / 优先级 | 入口→触发→预期 | NSH实现/缺失与证据 | 验收步骤 |
| --- | --- | --- | --- |
| B01 / P1 | 助理Tab→能力/启用/空/失败→正确分支 | 部分：Bots直接渲染snapshot；无 capability/启用引导。W-Bot MobileAssistantTab:203-384区分unsupported/disabled/error/empty | [ ] H/W：旧Host、关功能、空联系人、读取失败各验一次，不能都显示空列表 |
| B02 / P1 | Bot列表→最新摘要/未读/工作头像/全部已读 | 部分：N-App名称/preview/model与working文字；无未读badge/mark-read/动画时钟。W-Bot有这些组件 | [ ] H/D：另一端新消息、全已读、同时两个工作头像；回来时不残留假未读 |
| B03 / P1 | 长按Bot→Pin/Unpin；侧滑→编辑/删除 | 部分：编辑仅聊天header，删除在editor；无pin/rail。W MobileAssistantTab:153-198,271及AssistantContactMenu | [ ] H/D：pin A再pin B，只剩一个；取消回消息顺序；失败不移动；滑动取消不误开 |
| B04 / P0 | Bot详情→发消息/历史/流式/停止 | 有独立contact接线：N-State contact/messages与messages POST admitted；delta仅bubble；abort generation；非普通session | [ ] H：唯一文本、连续气泡、出错/重试、重开历史、停止；对照Host ordinal/generation而不是fixture回复 |
| B05 / P1 | Bot设置→名称/头像/prompt/workspace/model/variant→保存返回 | 部分：N-Edit有名称prompt/workspace/model/Agent/variant/mode与revision；无头像编辑/关联计划等；额外Agent/mode不是证明Web一致（Web保存特意不拥有这两字段） | [ ] H/S：逐字段改后重开；另一端revision冲突、保存失败停留；核对不能覆盖Host-owned Agent/mode |
| B06 / P1 | Bot资源卡→session/task/Bot→准确目标/状态/返回 | 部分：N-App ResourceCard有三类导航/compaction；仅title/status，无完整专用卡片呈现 | [ ] H/D：真实三类卡片、目标已删除、缺directory；点后逐级返回原Bot并保留草稿 |
| B07 / P1 | Bot设置→消息频道→微信/企微/飞书/钉钉对话框 | 缺：N-Edit无AssistantChannelsGroup。Web生产group有2×2入口与dialog；频道细协议不可只凭文档视为已测 | [ ] H/W：逐频道打开/取消/连接/重试/解绑/disabled；使用授权测试账号，不在审计文档记录secret |
| B08 / P1 | 系统分享/建议联系人→选择Bot→持久草稿→确认发送 | 缺：N-Native方法只有连接、request/stream、picker、QR；无Share Inbox/extension/catalog。Capacitor README:316-328有独立合同 | [ ] D/H：文字、URL、多图片、指定Bot/普通分享、取消、进程重启；不得静默发给第一个Bot |
| B09 / P0 | Bot附件→descriptor upload→图像/文件预览/失败重试 | 缺且明确拒绝：N-State:319、N-Native AttachmentBridge:21；不能用session上传描述符冒充 | [ ] H/D：Bot文字+图、仅图、文件、重试、源文件不可用；确认正确Bot/Host隔离 |
| T01 / P1 | 计划Tab→任务/历史切换、全部/启用/暂停、搜索 | 缺filters/history/search：N-App Schedules仅Each；W-Task有WorkspaceFilter/WorkspaceView与filteredTasks | [ ] H/W：至少3类状态和重名任务，逐filter/搜索/清除；切Tab返回保持预期 |
| T02 / P1 | ＋/编辑→daily/weekly/once/cron/时区/模型→提交 | 有接线：N-Edit TaskEditor，稳定creationID、校验、PUT/PATCH、schedulerSynced:false区分提交/同步 | [ ] H/S：四schedule逐个保存、时区/多时间/weekday、非法cron、保存响应丢失、同步失败不重复创建 |
| T03 / P1 | 任务详情→暂停/恢复/立即执行→权威状态 | 有：N-App:544-589，暂停PATCH、run POST；当前run按钮在disabled task禁用，需对照Web实际规则 | [ ] H：暂停再恢复/运行；Host拒绝/失败不假成功；另一端更新及时收敛 |
| T04 / P1 | 历史/任务历史→20条游标分页→状态/耗时/触发/错误 | 缺：NSH无runs请求/页面；W-Task:436-495及history render检索有真实query/游标/去重/计时 | [ ] H：>40条runs含running/error/success，滚动三页、按任务过滤/清除，错误可重试不清已有行 |
| T05 / P1 | 运行记录→打开生成session→返回历史 | 缺：SchedulePage无run.session导航；Web handleOpenSession/历史按钮接线 | [ ] H/D：打开指定run不是task最新session；返回仍同filter/滚动位置；目标缺失给失败 |
| T06 / P1 | Bot设置关联计划/计划页Bot提示→跳准确Bot/task | 缺：N-Edit无关联计划group；Web AssistantsSettingsPage有AssistantScheduledTasksGroup，mobile/scheduled有hint模块（hint内部未全文审） | [ ] H/W：从Bot打开task再返回；计划hint只导航、不自动发送 |

## 6. 设置：全部实际手机可达页

入口证据是 `MobileSettingsTab` → `SettingsView forceMobile/flowMobile`，白名单为 `metadata.ts:84-106` 的以下 **21** 页；`instances` 还需 MobileApp 传入原生连接surface。桌面完整列表不能直接充当手机清单。`shortcuts / remote-instances / global-config / skills.catalog` **不在当前手机根白名单**；不能因此推断内部跳转绝不可达，二级入口仍待后续穷举。

共同验收：`W/S` 从设置根打开每页→集合→详情/弹层→保存或取消→逐级返回；`H` 服务端设置还需重新读取/另一客户端确认；`D` 原生权限/键盘/系统跳转必须真机。下面每行的步骤独立执行；所有NSH缺失页仍是交付scope，不以“非MVP”排除。

| slug / 优先级 | 当前Web可执行内容 / 实读代码证据 | NSH现状（N-App Settings 618-753） | 具体检查项 |
| --- | --- | --- | --- |
| instances / P0 | MobileApp:3018-3042传MobileInstancesSurface；mobile README说明history/rename/manual/pairing | 部分：选择/新增/删除；无rename/edit/history welcome优先级 | [ ] H/D：两Host切换，重命名不丢授权，取消/删除活跃连接，重启自动恢复 |
| appearance / P1 | `sections/yuri/YuriPage.tsx:151-175`实际visibleSettings：theme/brand/字体/间距/手机键盘模式/时间/周起点/iOS native UI等 | 仅system/light/dark+语言 | [ ] S/D：逐个可见控件改变后重进；字体/键盘安全区与Glass；Web条件隐藏控件单独记录 |
| chat / P1 | YuriPage:179-199 render mode/transport/diff/followup/Goal/委派/助理/reasoning/TPS/draft/spellcheck | 缺 | [ ] H/W：逐项切换并在对应会话观察实际行为；不能只保存开关 |
| notifications / P1 | `NotificationSettings.tsx:42-160` runtime权限、各事件开关与templates | 缺 | [ ] D/H：拒绝/授权、completion/error/question/permission/Bot/task/Goal、点通知导航；Web浏览器push与iOS APNs分开 |
| sessions / P1 | YuriPage:202-231组装 Defaults/OpenCodeCli/BrowserProvider/Retention/Passkey（内部可用性仍有门控） | 缺 | [ ] H/W：默认model/Agent新会话生效，保留策略/CLI/browser/passkey每个实际可见项分别验收；不读既有密钥 |
| archived-sessions / P1 | ArchivedSessionsPage挂ArchivedSessionsManager；实际有preview/restore操作检索 | 缺 | [ ] H：归档测试session→本页预览→恢复→首页可见；失败保留 |
| summary-ai / P1 | `SummarySettings.tsx:35-140`选择目录模型、保存commit/title prompt、测试接口 | 缺 | [ ] H：保存后重开、测试失败清楚；真实生成另有用户授权才执行 |
| projects / P1 | `ProjectsPage.tsx:9-57`label/icon/color/iconBackground/defaultModel→ProjectSettingsPanel | 缺编辑 | [ ] H/S：每字段修改，取消/保存/新session默认模型，重启保留 |
| git / P1 | `git-identities/GitPage.tsx:48-200`GitHubSettings、identity列表/默认/编辑/删除、GitSettings | 仅项目Changes只读，不是设置 | [ ] H/W：进入各组/弹层、测试profile设置默认；本次未读取任何实际credential |
| providers / P0 | `ProvidersPage.tsx`实际import/分支有OAuth/AuthFields/CustomProviderForm/ProviderModelEditor/ModelRow，非只读catalog | 缺；Models页不是Provider配置 | [ ] H/D：新增测试自定义provider、model加减/编辑、授权取消/回跳、失败不泄露输入；勿用真实secret做截图 |
| agents / P0 | `AgentsPage.tsx`实际AgentEditor/model/permission rules；rules allow/ask/deny与SavedPermissions | 缺；仅聊天选Agent | [ ] H：创建测试Agent、prompt/model/权限保存，聊天选它并触发ask；覆盖与保存范围另核完整页 |
| assistants / P1 | AssistantsSettingsPage集合/详情、Avatar/workspace/model、关联计划、Channels（W-Bot） | 部分独立BotEditor，缺频道/头像/关联等 | [ ] H/D：执行B05-B09与集合→详情返回链 |
| behavior / P1 | `BehaviorPage.tsx:31-120`AGENTS.md文本、responseStyle preset/custom、settings PUT | 缺 | [ ] H：只在专用测试Host改非敏感规则，保存重读、取消/失败；不得改用户现有规则做审计 |
| commands / P0 | `CommandsPage.tsx:25-150`name/scope/description/Agent/model/template保存 | 缺 | [ ] H：测试命令新建/编辑/删除与C05联动；scope与重名校验 |
| mcp / P0 | `McpPage.tsx`配置store/status/import/OAuth/command参数编辑；MobileApp:2787-2827也有创建入口 | 缺 | [ ] H/D：测试server启停/编辑/导入/OAuth取消、错误详情；回到会话工具目录收敛 |
| plugins / P1 | `PluginsPage.tsx:95-160`entry/file/选项/更新/删除/reload与GuiPluginsManager | 缺 | [ ] H/W：测试插件安装/启停/选项/失败诊断，二级settings sheet；不把GUI加载与Node权限混同 |
| magic-prompts / P1 | `MagicPromptsPage.tsx:1-150`按功能分组prompt/default/reset/save接线 | 缺 | [ ] H：改测试模板、重开、单项reset/全部reset取消；仅在测试Host |
| skills.installed / P0 | `SkillsPage.tsx:106-140`installed查询/detail/create/update/readOnly built-in、supporting files与编辑器入口 | 缺 | [ ] H/W：新建测试skill、支持文件、编辑/预览、内置只读、与C06联动；二级catalog入口待穷举 |
| usage / P1 | `UsagePage.tsx:37-140`provider配额、刷新、模型family/选择、dropdown偏好 | 缺 | [ ] H：有配额/未配置/失败三类，不把失败显示0；返回保留选择 |
| voice / P1 | `VoiceSettings.tsx`SpeechSettingsForm/Volcengine/browser/local，local model状态/下载删除；含平台门控 | 缺；系统Speech不是整页替代 | [ ] H/D/W：枚举手机实际显示provider/ASR/TTS控件，预览/错误/取消；后台录音清理 |
| about / P1 | `AboutSettings.tsx:48-140`client/build、Host/OpenCode版本、native update config/频道/diagnostics与更新store | 仅硬编码0.1.0/NSH0.4文字 | [ ] H/D：三版本分开、失败不伪版本、诊断保存系统picker、更新取消/回退；不要求本审计发布 |

设置细项审计边界：上表完整枚举**路由页**并核对实际组件/字段接线，不宣称每个巨大设置组件的所有条件分支已全文穷举；特别是Provider授权方式、Agent高级字段、voice平台门控、sessions内部项应从真实Web当前可见控件继续补逐控件用例。它们属于未检范围，不是已对齐。

## 7. 远程桌面、终端、文件、预览、插件、branding

| ID / 优先级 | 入口/触发/预期 | 现状与代码证据 | 验收 |
| --- | --- | --- | --- |
| R01 / P1 | 首页＋或chat更多→Remote Desktop全屏→触控/键盘/旋转/重试/返回 | Web MobileApp:2902-2907,3225-3230真实挂载；RemoteDesktopPanel:30-220有capability/webrtc+tunnel、gesture、text、rotation。NSH Route/N-Native均无 | [ ] H/D：直连/Relay画面与输入、双指缩放/拖/光标、旋转+键盘、断线重试、返回恢复原页；屏幕权限拒绝明确 |
| R02 / P1 | terminal→交互PTY/resize/输入/快捷键 | NSH无terminal route/桥。Web仓库有MainLayout→TerminalView→TerminalViewport，但本次在Dedicated MobileApp菜单/phone shell**未找到 terminal 用户入口**；不能拿桌面存在推定当前手机可达 | [ ] W：先穷举当前手机入口并记录是否实际可达；可达则H/D跑PTY会话/中文/断线/resize，不可达也保留用户要求的NSH terminal交付项并明确差异 |
| R03 / P1 | chat更多Files→sheet→目录/搜索/文件→返回 | NSH Files仅项目详情入口、list/read文本；无chat入口/搜索/sheet；Web MobileApp:3236-3280+MobileFilesSurface:118-200有route/目录/搜索/直接文件preview | [ ] H/D：深层目录、返回上级、搜索、文件不存在/拒绝、切项目不串目录，sheet关闭不关闭聊天 |
| R04 / P1 | Changes/工具patch→多文件/单文件精确diff→返回 | 部分：NSH Changes status+两个staged按钮→markdown diff；无tool patch exact snapshot/turn diff与定位。Web MobileApp:3133-3202,3283-3310 | [ ] H：测试文件两个相邻修改/多文件patch，点工具与当前working diff应区分，定位首改行 |
| R05 / P1 | Markdown/图片/视频/PDF/HTML→预览、源码、全屏/保存 | NSH统一fs/read→fenced文本，无格式分派；N-Native请求仅JSON或精确fs/read text/plain，不能获取任意二进制。Web MobileFilesSurface含图片owner/HTML source/iframe/GuiFileLinkBridge | [ ] H/D：各格式、中文名/空格、大小边界、取消保存；无支持须明确失败，不能显示乱码当预览 |
| R06 / P1 | localhost链接/Host HTML→在手机经Host/Relay访问，非手机localhost | NSH TextView links=open没有Host代理/路由；Web MobileFilesSurface的Relay分支读HTML srcDoc，chat文档规定origin/资源路径owner | [ ] H/D：Host测试HTTP服务+相对图片/脚本，在外网Relay打开；失败明确，不能向手机loopback误发 |
| R07 / P1 | 自定义后缀/Eficy→LinkHandler+Panel→手机inline/sheet | NSH无GUI bundle/registry/Solid挂载；Web GuiPluginsProvider挂MobileApp，MobileFilesSurface使用GuiFileLinkBridge，GUI文档:164-168定义inline owner | [ ] H/W：测试后缀预览/源码切换、关闭/切Host释放、插件失败不阻断其他文件 |
| R08 / P1 | 插件管理→独立settings/panel/commands→正常生命周期 | NSH无对应入口；Web PluginsPage GUI controls与GUI文档window-only host。**全局yuri.page在Web手机本来inactive**，不可假造手机Runmark入口要求 | [ ] H/W：每种当前手机可见贡献分别点开，返回/卸载/重载清理；明确native IPC unsupported |
| R09 / P1 | 启用外观插件→theme/logo自动应用，停用回退 | NSH仅静态theme.json/Georgia Yuri文字，不消费appearance registry。Web GUI文档:28-61有yuri.theme/branding自动资源owner | [ ] H/S：同插件切亮暗、停用/失败/切Host回退；CSS无法直接复用于NSH但行为不能省略；Dock为macOS能力，不冒充手机必需 |
| R10 / P1 | 原生媒体/导出/分享/通知/Live Activity→OS UI闭环 | NSH main只注册连接/请求/stream/picker/QR；Capacitor README有VirtualAsset/video/media/export/share/notifications/live activity独立合同 | [ ] D/H：只在当前手机有对应入口时逐项测PDF/长图保存、图像相册、视频seek、分享、锁屏/通知导航；Web无原生能力的对照项应标运行时差异 |

## 8. 二级页/弹层与导航专项

| 优先级 | 必须验收的用户动作 | 接线差异 / 证据 |
| --- | --- | --- |
| P0 | [ ] 手机从任意根页push聊天→工具/模型/permission/form/文件→逐级Back；D含交互返回取消 | W-Nav统一mobile back协调、modal优先与top-only interactive；NSH NavStack只路由列出的page，BlockingRequests在聊天底部Scroll而非同等Web弹层，不得用“系统返回”证明所有层 |
| P0 | [ ] Bot→资源session→nested Agent→Back返回原Bot草稿；后台页不可发送/采集 | N-App ResourceCard+chat.active/N-State chatOwners有前台owner；缺Agent工具跳转。W MobilePhoneShell returnTo与parent reconciliation是显式合同 |
| P1 | [ ] 设置root→split集合→detail→dialog；取消保留原始值、保存返回集合；搜索命中detail后返回 | Web SettingsView有flow-mobile sibling层和search/prepare target；NSH没有同等设置树 |
| P1 | [ ] 搜索/远程桌面/文件sheet覆盖聊天时输入框隐藏；关闭后键盘/焦点恢复；横竖屏恢复 | Web使用holdNativeComposerCover/RemoteDesktop orientation；NSH Chat.active只认nav top，系统picker与Alert展示期间具体焦点行为需S/D |
| P1 | [ ] 中文IME候选不触发发送、Return/换行、粘贴图、撤销/重做、长文本选区，50次输入同时流式不卡顿 | NSH Input multiline无专门IME/引用/selection处理证据；Web ChatInput IME guard与composer contract要求输入P95≤16ms且无≥50ms输入任务。NSH须提供独立原生量测，不能照搬Web测试结果 |

## 9. 测试/运行证据清单（不混淆等级）

| 来源 | 已读到什么 | 能证明 / 不能证明 |
| --- | --- | --- |
| `packages/nsh/ui-smoke.test.ts:9-29` + `tests/host.js:1-95` | NSH CLI headless，`--web-host tests/host.js`；send后布尔sent切固定回复；runtime.stream直接true | F测试定义：引擎能走fixture页面/输入/请求边界；**不是模型、SSE、生产UIKit、真实Host**。本次未运行 |
| `packages/nsh/state.test.ts` | mock事件/请求覆盖busy、scope、120ms合并、未知发送、contact delta、附件、前后台poll等测试定义 | F状态回归意图；不能证明Host实际wire或iOS生命周期。未运行 |
| `packages/nsh/relay-native.test.ts:68-129` | 编译生产RelayTunnel.swift，连接本地Bun fixture，multiplex/SSE/cancel/replay/tamper/auth六scenario | F本地生产协议实现的集成设计；不是公网Relay部署/真实Host/真实对话。未运行 |
| `packages/nsh/ios/README.md:77-86` | macOS production bridge probe使用NSH test double，持久化替换 | 文档描述的F入口；不能声称本次已通过，也不验证Keychain/相机/picker/签名 |
| `packages/nsh/README.md` / `DOCUMENTATION.md` | 先前MVP叙述与构建命令 | 只作为设计说明，不把“方向/已实现”当H/S/D验收证据 |
| 真实Host / 模拟器 / 真机 | 本次无请求记录、录屏、运行命令或产物验收 | H=未测，S=未测，D=未测；等待负责联调者补证，不继承上一轮宣称 |

## 10. 主线程可直接执行的收口顺序

1. [ ] **P0真实链路**：在主线程恢复的5180/指定Host环境确认健康与版本，使用用户授权的连接；先跑C01/C02/C10/C15/C17。保留脱敏session ID、admit ID、SSE类型/时序、重开截图；禁止保存token/pairing secret。
2. [ ] **P0输入/Agent矩阵**：C03-C08、C12-C14、C16、C18-C21。每项分别记“未接线 / fixture通过 / Host通过 / S通过 / D通过”，不以一个总chat smoke覆盖。
3. [ ] **P1截图与目录闭环**：P01-P09、B01-B09、T01-T06；以同Host同数据对照五截图与当前Web，缺失功能保持未勾选。
4. [ ] **设置与资源全scope**：逐行第6节21页与R01-R10；先补入口，再补mutation/error/recovery，再真实设备验证。不能因优先级低就结项为不做。
5. [ ] **最终验收**：每条记录构建/平台/Host版本、步骤、实际结果与证据位置；至少两个Host、直连/Relay、中文IME、网络中断、后台恢复；代码/类型检查通过不得代替运行。

## 11. 明确未检范围（仍在当前scope）

- 未启动/操作5180、浏览器、NSH headless、模拟器或真机；没有读取其他agent的测试结果。本文不评价其可能正在写入的代码，后续应按最新文件重核。
- 大型组件仅对相关入口/handler做定向读取：ChatInput全部8184行、SettingsView全部1903行、MobileApp全部4016行未逐行全文审阅；已经读到的区段列在索引，不声称全覆盖。
- Web `CommandPalette`内部各结果域/远端搜索、完整Agent配置高级字段、所有Provider OAuth方式、VoiceSettings所有平台分支、Settings搜索字段目录与内部catalog深链未穷举。
- Agent专属UI（subagent任务卡完整实现、Goal、question自动委派、btw、工具插件自定义交互、后台任务面板）只核入口或文档，未逐组件全文审；这些不是“不适用”，须补独立子清单。
- terminal在当前Dedicated手机入口未证实；仅定位仓库TerminalView/MainLayout，未声称当前Web手机用户可用，也未取消用户明确要求。
- GUI真实插件bundle/appearance生产执行、localhost gateway全实现、图片/视频/导出桥每个方法、APNs/Live Activity/Share Extension内部未逐行审。当前仅确认入口/合同与NSH方法缺口。
- 未读取Keychain内容、连接配置值、环境secret、证书或实际渠道/Provider凭据；所有配置验收须专用测试数据与用户授权。

**结论：当前可确认的是一组原生页面及部分协议接线，尚不能签收“完整当前Web移动端对齐”或“真实流式聊天已完成”。本文所有未勾选项都保留为待交付/待验证，不存在按MVP自动豁免。**
