# Projects / Session 持续验收矩阵

本矩阵承接 `PARITY.md` 的 P01–P09 / C01–C24 / R01–R10 与 `CHAT-FRAMES.md` 的 F01–F27，不替换或缩减原范围。建立日期：2026-11-08。当前 **0 项全平台完整验收**；既有实现和局部证据不能自动升级为通过。

## 判定与执行规则

- C=当前源码接线；F=fixture；H=真实 Host；S=完整 App 的 UIKit 模拟器；D=真机；W=当前 Web 手机端。历史报告只作线索，必须核对当下实现。
- 每行都检查入口、二级页、弹层、取消/返回、状态变化、失败与恢复；有写入的流程仅用隔离测试实体。无现成安全实体时保持未完成，不拿用户会话制造故障。
- W/S 必须同 Host、同目录/会话/消息与展开位置；记录尺寸、触摸 class、主题/字体。构建、API 成功、截图相似都不代替交互验收。
- 不重复付费模型/语音调用；生产 List 仍为唯一滚动 writer，不为视觉修复加第二套 offset 补偿。并行修改不覆盖。
- `未完成` 表示仍有任何必要证据或功能缺口，绝不等于没有实现。具体证据与后续差异记录在下方批次日志。

## Projects 全链路

| ID | 当前 owner（相对 packages/nsh） | 实际验收动作 / 必须观察的结果 | 证据与剩余项 | 判定 |
| --- | --- | --- | --- | --- |
| P01 | projects.tsx / projects-summary.ts / projects-presentation.ts | 首页卡片统计/活动/折叠；切 Tab 返回保留状态 | 批次 E 同 Host 主目录5/工作树12条 ID 集合一致，刷新/局部重试/跨 Tab 保持17+及局部提示；真实恢复、同主题完整对帧/真机仍未通过 | 未完成 |
| P02 | projects-attention* / projects.tsx | pin/unpin、running/unread/question/permission、他端更新；同实体不重复 | C/F；真实状态迁移/重开待测 | 未完成 |
| P03 | projects-search* / application.tsx | 标题/正文/命令/设置/项目/当前 Focus 文件；逐域更多/失败重试/返回 | 见 PROJECTS-SEARCH-VALIDATION；exact anchor 与所有导航当前包待验 | 未完成 |
| P04 | projects.tsx / projects-delete* | 横滑取消/纵滚、菜单重命名/智能标题/pin/刷新/停止/归档/撤销/删除 | 批次 R Native：置顶、重命名、删除、智能标题、停止、左滑置顶已验。空闲会话菜单为「同步消息」，消息 GET 200 后显示「已同步消息」。左滑露出置顶/归档后，改向下滑不收回；再点可见标题才收回且不进入会话。完整纵滚取消未单独成立 | 未完成 |
| P05 | projects-home-sheet.tsx / projects.tsx | 项目菜单所有项；Git/非 Git；编辑 dirty/busy 与关闭取消 | 批次 R：Web dirty 关闭无确认。Native 保存响应挂起时点关闭，未出现未保存确认，直接回首页；放行后重开选中 code，权威 icon=code。非 Git 仍是旧缓存，不能签收 | 未完成 |
| P06 | projects-worktrees* / projects.tsx / projects-worktree-form.ts / projects-worktree-picker.tsx | 主树/两工作树同名会话；展开/新建/删除确认/返回；目录隔离 | 批次 R Native：展开 form-01 后箭头向下且无会话行，但审计没有该目录的 session 查询。工作树菜单为新建聊天/移除；移除确认含本地/远程分支选项，取消后工作树仍在且无 DELETE。新建表单默认 merry-iguana，取消后无 POST。同名会话/真实创建/目录隔离未验 | 未完成 |
| P07 | projects-order* / projects.tsx | >30 会话分页/更多/收回；正文长按排序/取消/重启保持 | 批次 R Native：session-index 返回 9 条后首页先显示 Paged 08–06 和「更多」；点更多展开至 01 与 Queue Goal，无新分页请求；点「更少」回到 3 条，权威仍为 9。>30、游标分页、长按排序和重启未验 | 未完成 |
| P08 | new-session* / application.tsx | 所有新聊天入口；无实体草稿；首次提交一次；取消/重启/未知结果恢复 | 批次 R Native：首页加号菜单含新建对话/项目/扫码/实例/远程桌面。新建对话打开「新建聊天」草稿，提示先选择项目，输入框可见；返回后回首页且无 POST /session。项目内入口、首次提交、重启和失败恢复未验 | 未完成 |
| P09 | projects-directory* | 浏览深目录/父级/搜索、注册/克隆/mkdir、取消/409/权限失败/重试 | 批次 R Native：新建项目先显示 /api/fs/list 404 与重试。补只读列表后重试显示 /isolated 下 queue-goal，隐藏项默认不显示；进入后路径为 /isolated/queue-goal/，只显示 nested-fixture，不显示 notes.txt。上级回到 /isolated/。关闭后回首页且无 fs/project 写入。搜索、注册、克隆、409 未验 | 未完成 |
| P10 | projects.tsx / projects-home-sheet.tsx | 首页＋、实例列表当前项/禁用、扫码取消、远程桌面进入返回 | 批次 R Native：切换实例只列出 127.0.0.1 并带勾；点该行不关闭、无切换请求，关闭后仍在首页。远程桌面进入后显示连接失败和重新连接，返回回首页。扫一扫先出系统相机权限，不允许后回首页，未进入扫码页。多实例禁用、允许后的扫码取消未验 | 未完成 |
| P11 | settings-projects* / settings-archive* | 项目名称/图标/颜色/默认模型；归档预览/恢复；关闭后重开 | 批次 R Native 设置归档页：未归档时显示「暂无已归档会话」。归档后按 /isolated/queue-goal 分组，进入后可见 Queue Goal Conversation、预览、恢复。恢复第二次 PUT 200，页面提示已恢复并变空，项目首页会话重现。颜色/图标背景/关闭重开未全验 | 未完成 |

## Session 功能闭环

| ID | 当前 owner | 实际验收动作 / 必须观察的结果 | 证据与剩余项 | 判定 |
| --- | --- | --- | --- | --- |
| C01 | state / history-* / transcript-body* | >45 条连续三页，边界无漏重、角色/顺序正确 | 批次 R Native：合成 45 条，最新页 45→26，第二页从 26 接上，最早页到 01 user 且无下一游标。界面可见 01–09 与 24–32，用户右、助手左，边界没有重复行。严格 45 条逐条对账和 Web 未验 | 未完成 |
| C02 | state / drafts / new-session-admission | 唯一输入→admit ID→SSE→终态→重开，同 ID 一行 | 既有真实 marker 可复用；不为验收重复模型请求 | 未完成 |
| C03 | chat-composer-selection / chat-models* | 模型/Agent 切换、当前标记/过滤、重开/后续请求生效 | 批次 R Native：点模型打开列表，最近和 Fixture 当前下的 Fixture Model 都有勾，20万 ctx。长按 Agent 只列出带勾的 Build，无 /agent POST。过滤、切换写入、重开和后续请求未验 | 未完成 |
| C04 | model-picker-presentation / model-variant-memory | Default/variant/收藏最近偏好；重开权威状态 | 批次 R Native：点收藏星后 PUT 200，权威 favoriteModels 为 fixture/fixture-model。关闭再打开，分组从「最近」变为「收藏」，星标变为「从收藏中移除」。该模型无 Default/variant 行。失败恢复和重启未验 | 未完成 |
| C05 | composer-command* | 注册 slash、magic、本地动作、参数/未知命令/失败保稿 | 批次 R Native：工作区菜单只有新建聊天/文件/更改/MCP/同步消息/远程桌面/自动朗读，不是 slash。Host 注册 fixture-note 后重开会话，Native 未读 /api/command，面板未出现。命令面板依赖在污染草稿中输入 /，未改草稿。未知命令和失败保稿未验 | 未完成 |
| C06 | composer-reference* | 文件/目录/Agent/skill/session，选中/删除/置中/重开/发送语义 | 批次 R Native：@ 引用面板依赖污染草稿，未输入。工作区文件页 GET /api/fs/list 200，同时列出目录 nested-fixture 与文件 notes.txt；展开目录后路径变为子目录并显示「此目录为空」。Agent/skill/session 引用、选中 chip、删除和发送未验 | 未完成 |
| C07 | state / composer | shell 安全命令、退出码/历史、退出模式不吞附件引用 | 批次 R Native：工作区菜单无 shell 入口。代码只在空草稿开头输入 ! 切换；当前污染草稿非空，没有 ! ×，也没有 /shell POST。安全命令、退出码和退出模式未验 | 未完成 |
| C08 | AttachmentBridge / application | 图/文件/仅附件、取消/失败/重试、切 Host | 批次 R Native：点添加附件弹出「附加照片」「附加文件」，无独立取消按钮。点空白关闭后仍回会话，无上传请求。照片/文件选择、失败重试、仅附件发送和切 Host 未验 | 未完成 |
| C09 | resource-media* / Resource*Bridge | 历史图/回复图、缩放/保存/权限拒绝、直连/Relay | 批次 R Native：打开 notes.txt 先因 /api/fs/stat 404 显示「文件读取失败，原有预览保留」。补 stat/read 后再刷新，审计已有 read 200，但页面仍留旧 404，没有正文或图片。缩放、保存、权限和 Relay 未验 | 未完成 |
| C10 | state / stream* / transcript* | streaming 多次增长、reasoning/tool 中间态、终态收敛 | 批次 R Native：会话连上 /api/global/event/ws 后，一次注入 started、两段 text.delta、ended 和 succeeded。界面最终只见到一条 Stream one / two / three，没有截到逐段增长。reasoning/tool 中间态未验 | 未完成 |
| C11 | transcript-body* / resource-* | 代码/表格/数学/Mermaid/链接/晚到图、折叠与复制 | 批次 R Native：历史消息渲染出带下划线的 fixture 链接、Name/Value 表（alpha=1）和 js 代码 const answer = 1，代码块有 copy。链接在无障碍里只是整句 StaticText，未能单独点开。复制后的剪贴板、折叠、数学、Mermaid 和晚到图未验 | 未完成 |
| C12 | transcript-tools* / chat-changes* | Read/patch/error/子 Agent，精确快照、工具详情与返回 | 批次 R Native：历史工具先显示「运行了 1 次读取」，展开为「读取文件 notes.txt」。再点开后显示完整路径 /isolated/queue-goal/notes.txt 和结果 Isolated fixture note.。patch、error、子 Agent 和返回后的滚动未验 | 未完成 |
| C13 | blocking / state | once/always/reject、说明/双击/他端已处理、失败恢复 | 批次 R Native：权限卡显示「需要权限：read」、路径 /isolated/queue-goal/notes.txt，以及一次/始终/拒绝。三个按钮固定在 y=802，被 320 字草稿和输入栏挡住，只露出顶部，点击没有 reply POST。说明、双击、他端处理和失败恢复未验 | 未完成 |
| C14 | blocking / state | 全类型/条件字段/必填/未知 schema/取消/失败；长表键盘 | 批次 R Native：短表单显示标题 Fixture form、必填 note，以及提交/取消。按钮同样固定在 y=802，被污染草稿和输入栏挡住，点取消没有 form cancel POST。其他字段类型、未知 schema、长表和键盘未验 | 未完成 |
| C15 | state | Stop 仅目标 session，真实 terminal，断网不能假 idle | 批次 R Native：运行中会话菜单显示「停止 Queue Goal Conversation」，点击一次 POST /interrupt 204，路径只含 ses_queue_goal_fixture。随后 /api/session/active 为空，首页不再显示进行中。会话内停止被污染草稿挡住，断网后是否假 idle 未验 | 未完成 |
| C16 | chat-queue / state / drafts | 多项 queue＋Goal、编辑/删除/steer/消费去重/失败/重开 | 批次 Q 同源UIKit/Web完整重建，隔离HTTP各一次DELETE/一次prompt；真实软键盘/拼音提交与删除、Native键盘中发送及两端Goal暂停/继续已验；布局/附件UX差异、真实runner和完整恢复仍未验 | 未完成 |
| C17 | state / drafts | admit 丢响应/未 admit/新草稿三场景；同 ID reconcile | C/F；真实故障注入只可隔离实体，尚未验 | 未完成 |
| C18 | drafts / history-cache | A/B 草稿/附件/未知发送、覆盖/后台/杀进程/Host 隔离 | C/F；完整包重启/上传中退出待验 | 未完成 |
| C19 | transcript-actions* | copy/edit/revert/redo/fork；文件、历史、草稿一起正确 | 批次 R Native：点 history-copy-msg_history_34 后，模拟器剪贴板为 History 34 assistant，页面未离开会话。编辑、回退、重做、分叉及文件/草稿联动未验 | 未完成 |
| C20 | application / history-focus | 父→子→孙/资源卡→逐级返回，边缘取消与非活跃写保护 | 批次 R Native：父会话点 tool-session-ses_queue_child_fixture，GET 子会话 200 后标题变为 Child Fixture；再点孙入口进入 Grandchild Fixture，正文为 Grandchild fixture marker。返回先落到 Child Fixture，再落到 Queue Goal Conversation。子/孙无非 GET 写入。资源卡、边缘取消、非活跃写保护和原滚动未验 | 未完成 |
| C21 | state / runtime-lifecycle | 断网/后台5分钟/跨120条/切 Host；未知/缺页/重试 | 批次 R Native：父会话历史先 503 后立即重读 200，界面未留错误。再让下一页 503，无障碍短暂出现 unavailable，继续上翻后仍显示 History 01，没有可点重试。后台 5 分钟、跨 120 条和切 Host 未验 | 未完成 |
| C22 | history-* / chat-chrome* | 100+、持指分页、晚到图/Markdown、读中间不抢、跳最新 | 批次 R Native：停在 History 22–29 时点「滚动到底部」，视图回到代码、读取和 Open child fixture，并显示晚到的 Late fixture marker。事件通道当时未连接，不能证明阅读中途不被拉走。100+、持指分页和晚到图片未验 | 未完成 |
| C23 | speech* / Speech*Bridge | 点击/hold、转写/校正/取消、权限/后台/切页 | 批次 R Native：点麦克风弹出「Yuri Native 想访问语音识别」，说明语音会发给 Apple。点不允许后回到会话，按钮仍是开始语音输入，没有失败文案，草稿仍是 320 字，prompt 为 0。长按、转写、校正、后台和切页未验 | 未完成 |
| C24 | chat-header* / chat-goal* / chat-tasks* / chat-mcp* | metadata/workspace/MCP/自动朗读/Goal/Tasks/Changes 全入口 | 批次 R Native：元数据弹出分支 main、上下文不可用、用量「未上报速率限制」。MCP 打开后显示 Invalid MCP list response 和 /api/config/mcp 404。更改显示 main 且「工作区干净」。Goal 详情显示目标全文、进行中 2/20、暂停和移除，未点击。自动朗读按钮禁用，Tasks 未单独打开 | 未完成 |

## 同状态逐帧与交互（不能被上表替代）

| 帧 | 内容 / 必须验收 | 关联功能 | 当前缺口 | 判定 |
| --- | --- | --- | --- | --- |
| F01 | 短历史、角色/模型/时间/TPS/操作条 | C01/C02 | 旧截图不证明当前全样式同尺寸 | 未完成 |
| F02 | context ring/branch/quota/失败刷新 | C24 | 批次 R Native：元数据分支 main、上下文不可用。额度刷新先 200，文案仍是未上报速率限制。再让 magpie 503 后刷新，红字变为 HTTP 503: isolated quota unavailable，分支未变。长数据和主题对帧未验 | 未完成 |
| F03 | workspace 各项打开/关闭/返回 | C24/R01/R03/R04 | 批次 R Native：文件打开后点返回回到 Queue Goal Conversation；更改关闭后回到同一会话；远程桌面返回后也回到同一会话。自动朗读点按只关闭菜单，没有错误。MCP 此前打开后关闭。字体/材质对帧和条件更新未验 | 未完成 |
| F04 | 空输入/焦点/软键盘/安全区 | P08/C18 | 批次 Q 独立Web 402×812画布、UIKit窗口/安全区实测；软键盘/收起已采，Web焦点时顶栏滚出与辅助条重叠有阶段差异，连续动画/所有状态待验 | 未完成 |
| F05 | 输入/删除/多行/IME/选区/撤销/外接键盘 | C05/C06/C18 | 批次 Q 两端真实拼音n→候选你→删除还原，组合中无prompt；多行/选区/撤销/外接键盘及50次时延仍未验 | 未完成 |
| F06 | 模型搜索/清空/分组/最近/收藏/空失败 | C03 | 已有局部 S；mutation/所有状态未验 | 未完成 |
| F07 | variant→选择→关闭→重开 | C04 | 真实写入待验 | 未完成 |
| F08 | Agent 短按/长按/过滤/恢复 | C03 | 新样式重采及切换待验 | 未完成 |
| F09 | @五域候选/排序/错误/键盘 | C06 | 软键盘与物理 IME 待验 | 未完成 |
| F10 | 引用插入/删除/中间光标/尾文 | C06 | UIKit 五域逐项待验 | 未完成 |
| F11 | slash/magic/参数/错误保稿 | C05 | 全集与同状态帧待补 | 未完成 |
| F12 | shell/退出/历史输出 | C07 | 当前对帧待补 | 未完成 |
| F13 | 附件菜单/picker/chip/错误 | C08 | 完整 UIKit/D 链路待补 | 未完成 |
| F14 | streaming/reasoning 中间帧 | C10 | 不重复付费流量，当前自然运行采集待补 | 未完成 |
| F15 | tool pending/running/completed/error | C12 | 批次 R Native：最新历史同时有 pending 的 printf fixture-pending 和 error 的 printf fixture-error。展开后分组为「运行中 2 次命令」，失败行是红色，详情含「错误：isolated shell failed」；等待行是普通色。独立 running 与 completed 同屏未再验 | 未完成 |
| F16 | Read/patch/diff/子 Agent | C12/R04 | 批次 R Native：点「批量修改」直接打开 /isolated/queue-goal/notes.txt 的上一轮 diff，第 1 行删除 old note、新增 Isolated fixture note.。关闭后回到 Queue Goal Conversation，历史 changes GET 200，无写入。多文件、行定位和子 Agent 多级返回未在本项再验 | 未完成 |
| F17 | 各角色操作/复制/编辑/朗读/fork | C19/C23 | 批次 R Native：打开朗读按钮后，History 44 assistant 下有复制、朗读、分叉；History 45 user 下有回退、编辑、分叉、复制。点朗读后仍停在会话，按钮仍是朗读，无失败文案，草稿仍 320 字，无 tts 请求。编辑会覆盖草稿，分叉会 POST 新会话，均未点 | 未完成 |
| F18 | revert dock/发送/失败/redo | C19 | 批次 R Native：空闲后点 History 45 回退，确认框为「从此处回退 / 将改动的文件」，取消无 revert 请求。再点撤回时先 GET message/msg_history_45 得到 404，界面红字 HTTP 404: not found，确认框仍在，没有 stage POST，也没有重做栏。运行中时回退按钮禁用 | 未完成 |
| F19 | 多 queue＋Goal/edit/steer/失败 | C16 | 批次 R Native：三条队列同时可见。点 Steer queued input 的引导先 PATCH 503，红字 isolated steer unavailable，该项仍显示引导。再点一次 PATCH 204，权威 delivery 变为 steer，界面变为「引导中」，另外两条仍是引导。编辑未点，Goal 暂停未点 | 未完成 |
| F20 | permission 三动作/失败 | C13 | 批次 R Native：权限卡再次显示一次/始终/拒绝，坐标仍是 y=802、高 44。向下滑内容后按钮不移动，点露出的顶部没有 reply POST。503 失败分支因此未触发。说明和双击未验 | 未完成 |
| F21 | question/form/长表/键盘 | C14 | 批次 R Native：短表单标题 Fixture choices，字段为必填 Confirm fixture 的开启/关闭，以及 Fixture mode 的 Review。按钮坐标分别在 y=650 和 y=790，提交/取消在 y=850。截图里都被 320 字草稿挡住，点开启和 Review 后 selected 仍为空，无 form POST。长表和键盘未验 | 未完成 |
| F22 | 百条历史/分页/晚到内容/最新 | C22 | 批次 R Native：120 条分 6 页，边界各重一条，最后一页到 History 006。打开后按住上翻，期间可见 History 114–120，松开后停在 110–118，没有回到 001，读取均为 200。120 条逐条对账、持指期间的精确保位和晚到内容未验 | 未完成 |
| F23 | 多媒体/预览/保存/链接/Relay | C09/C11/R05/R06 | 所有资源分支未验 | 未完成 |
| F24 | 听写/hold/取消/后台 | C23 | Web provider 差异未关闭 | 未完成 |
| F25 | 断网/后台/重连/切 Host | C21 | 真机网络/恢复全链路待验 | 未完成 |
| F26 | 空会话/新草稿/欢迎建议 | P08 | 批次 A 引擎已绿，真实全部入口/键盘/帧仍待验 | 未完成 |
| F27 | Goal/Tasks/Changes/后台任务进度 | C24/C16 | 前序局部 UIKit 通过，真实 queue/所有任务异常未验 | 未完成 |

## 相关资源与扩展页面

| ID | 验收动作 | 当前证据/缺口 | 判定 |
| --- | --- | --- | --- |
| R01 | 远程桌面直连/Relay/触控/键盘/旋转/断线/返回 | JPEG ACK 桥已有，非完整 WebRTC 等价；见 REMOTE-DESKTOP-VALIDATION | 未完成 |
| R02 | 终端入口、PTY/resize/中文/恢复 | 当前 Web Dedicated Mobile 可达入口未确认；用户要求仍保留 | 未完成 |
| R03 | 文件 Sheet/深层/搜索/文件不存在/返回 | Native 目前独立文件 route，呈现/返回行为待对齐 | 未完成 |
| R04 | workspace diff 与历史 patch/多文件/行定位/返回 | 精确行内定位仍有差异；真实安全改动待验 | 未完成 |
| R05 | Markdown/图/视频/PDF/HTML/源码/全屏/保存 | 见 RESOURCE-MEDIA-VALIDATION；格式全集与原生保存待验 | 未完成 |
| R06 | Host localhost/相对资源/Relay/失败返回 | 见 resource-web-preview*；真实外网Relay待验 | 未完成 |
| R07 | GUI/Eficy/插件资源/授权/关闭清理 | 见 GUI-CAPABILITIES-HANDOFF；不能将资源 WebView 冒充原生执行 | 未完成 |
| R08 | 插件 settings/panel/commands 全生命周期 | 逐个手机实际可见贡献；不虚构 Web 手机隐藏的全局 yuri.page 入口 | 未完成 |
| R09 | 外观插件启用/停用/主题/Logo/失败回退 | CSS 不能直接复用也不能省略行为；macOS Dock 不冒充手机需求 | 未完成 |
| R10 | 原生媒体/导出/分享/通知/Live Activity | 真实 OS UI、权限及锁屏导航；原生/Web 差异明确记录 | 未完成 |
| R11 | 从 Projects/session 进入的全部设置二级页 | 目录继承/取消/dirty/busy/返回与实际效果；沿 PARITY §6 不删项 | 未完成 |

## 批次日志

### 2026-11-08 / A：建立清单及当前入口基准

- 已重新读取 ProjectsHome/SessionRow/ChatHeaderActions、Web sessionMenuModel 与 MobileApp overflow/MCP 实际装配。不把 `SESSION_SHARING_AVAILABLE=false` 下隐藏分享项计作当前可见入口。
- 本轮浏览器 task space 7：viewport 402×778、DPR 3、5 touch points，根为 `device-mobile mobile-pointer dark`，从实际 `/mobile.html` 首页开始；不是仅缩窄桌面页面。
- 已确认当前 Web MCP 由 `MobileResizableSheet`→`McpDropdownContent` 所有，含状态/连接开关/刷新/新增；Native `openOptions('mcp')` 直接 push Settings，两者交互不等价。保持未完成，修复后须完整包 UIKit 打开/刷新/关闭/返回，以及隔离开关失败回归。

### 批次 A / 实施与可复核结果

- MCP 已新增 `chat-mcp.tsx` / `chat-mcp-model.ts`，接入生产 Chat，不再直接跳设置。菜单顺序也按当前 Web 将同步消息放在远程桌面前。保留系统 pageSheet，不用自绘 resize 手势；配置/状态独立读取，关闭零读取、50 次无关输入零新增读取。
- 连接开关只接受完整 status authority；配置失败不阻塞已经完整的 status 行。未知写入、ACK 后读取失败与确定拒绝分开处理：未知只 GET 核验、不自动重 POST，确定 4xx（408 除外）保留错误并允许显式重试。前台 lease 更换/同 Chat 关闭重开保留待核验操作；杀进程或销毁 Chat 后尚无持久 journal，仍未完成。
- 新增通过真实关闭 completion 才 push 同目录的现有 MCP `create:true` 编辑器。未新建平行配置表单，未新增依赖、未改原生认证门。
- 最终 5 文件 **28 passed**：`.scratch/nsh/projects-session-batch-a-final-tests.log`。其中 MCP 状态与十语文案 11 项、生产 MCP 组件及装配 2 项、header 2 项、历史定位 5 项、新会话 8 项。初跑新会话的旧菜单 driver/呈现 ready 红灯在并行更新后重跑转绿；本线程未覆盖其修改，也不将这部分修复归为本线程实现。
- `nsh:check` 通过：`projects-session-mcp-final-check.log`。完整 arm64 构建通过：`projects-session-batch-a-build.log`，已安装原模拟器并启动。包内 source map 对 application/chat-header/chat-mcp/chat-mcp-model 四文件与当时当前源码一致。`dead-code` 已执行并检查，新增 MCP 文件/导出未列为 unused，既有报告未清除。
- 真实完整 UIKit + 同一 Host/主会话：MCP 读到 `context7 · 已连接`，开关 AX 为 enabled；打开/刷新/关闭/重开均可用，未点击开关。浅/深截图为 `projects-session-mcp-final-light.png` / `projects-session-mcp-final-dark.png`。新增进入空编辑器，返回触发其既有脏稿保护，明确放弃本次空表单后返回 Chat；未提交服务配置，未发送模型/语音请求，系统外观最终恢复 light。
- 当前 Web 手机只读基准：`projects-session-mcp-web-dark.png`，采集同一轮实读 width=402、height=778、DPR=3、touch=5、`device-mobile mobile-pointer dark`，字体 system，`--dpt:1px`。浏览器跨调用会恢复窗口 metrics，先前 1336px 的截图不算精确对帧证据；有效帧在同一调用设置/确认 metrics 后采集。
- **仍非完整验收**：Web MCP Sheet 为透明材质，原生为系统 pageSheet 内容材质；标题字级、系统 safe-area/detent 与实际连续动画未作一致性结论。真实开关/连接失败/OAuth/Relay/长列表/长名称/真机尚未验，不能拿 synthetic POST 结果替代。新增编辑器出现通用 Agent 描述 placeholder，且空新建页会触发 dirty 提示，这属于后续 R11 设置对照项，不掩盖为当前全链路已绿。

批次 A 的范围只关闭“点 MCP 错误进入设置页”这一已复现路径，不关闭整行 C24/F03，更不关闭 Projects/session 总目标。

### 下一批已复现：P01 项目统计不包含工作树

- 同一 Host、同一 yuri 项目，Web 首页显示 **17 个会话 / 16m**，其工作树为 **12 个会话**；完整原生 App 卡片显示 **5 个会话 / 1d**，同一工作树也为 **12 个会话**。截图 `projects-session-project-count-web.png` / `projects-session-project-count-before.png`；原生 AX 同时确认卡片 label 和工作树 label，不是截图猜数。
- 当前 `projects.tsx` 的 header 直接用 `byDirectory().get(project.path)` 的数量与首项时间；Web `useMobileProjectsHomeModel` 使用归属项目的所有 bucket 的 `totalSessions` 与 `latestActivity`。除漏算工作树外，原生首项可能被持久排序改变，也不能作为最新活动时间 authority。
- 修复必须从项目/工作树 ownership 汇总一次，保留目录分页完整性/部分失败，不为每个 header 发请求，也不能只把两个截图数字相加硬编码。初次取证时尚未修改；后续结果见批次 B，P01 仍不整行勾选。

### 批次 B / 项目头汇总修复

- 新增 `projects-summary.ts`，直接复用 Web `createSessionOwnershipIndex` 的主目录/注册工作树/嵌套目录/项目碰撞优先级。共享函数仅泛化输入 record 类型并保留返回类型，不改 runtime 归属算法，不为 Native 伪造 SDK `Session` 字段。原生项目头一次 computed 汇总已加载的可见 root catalog，不使用排序后的首项，也不增加网络读取或输入订阅。
- 总数包括所有归属项目的可见根会话；最新时间取这些记录的最大有限 `updated`；任一已知目录分页未尽保留 `+`。未知拓扑、尚未拉取的页面不声称完整；原 controller 的失败保留与 filter 不变。
- 定向原生 **6 文件 / 84 passed**：`.scratch/nsh/projects-summary-delivery-tests.log`。覆盖共享 ownership 的原生 summary、主树/工作树/嵌套项目、重复 worktree 元数据不重复计数、持久顺序不影响 max、Windows 规范路径与独立分页 partial；保留原 Projects 删除/归档/重试/目录/拖排回归。首次 56 项红灯来自 controller VM 未登记新增真实 import，补 `projects-summary` 的真实模块映射后全部通过，未 stub 新逻辑或 skip。
- 共享 Web ownership / 手机首页模型 **12 passed**：`projects-summary-web-tests.log`。保留测试初始化中的未 mock fetch 警告及既有 Vite 配置警告，未访问真实外部服务。UI `tsc --noEmit` 通过（`projects-summary-ui-typecheck.log`）；Native check 通过（`projects-summary-check.log`）。`dead-code` 已检查，新 summary 未报告 unused。
- 完整 arm64 模拟器包 `projects-summary-build.log` 构建成功，覆盖安装原模拟器并启动；已核对包内 projects/projects-summary/chat-mcp/shared sessionOwnership 四文件 source map 与当前源码一致。
- 真实 UIKit AX：`yuri 17 个会话 · 3m · Code/selfs`；同一时刻 Web 手机 snapshot 也为 **17 个会话 / 3m**，工作树 **12 个会话**。原生图 `projects-session-project-count-after.png`。折叠后仍是17/3m且工作树卸载，展开恢复；只改本地展开状态，不修改用户目录、会话或工作树。
- 保留未验：不同加载完整度/未知拓扑的真实分页、断网失败、百项目规模实测、跨 Tab 滚动保持、真机。已有单例真实结果与纯回归不能替代这些场景，也不等于整个 P01/F01 视觉一致性已通过。

批次 A+B 最终合跑：**11 个原生文件 / 112 passed**（`projects-session-combined-final-tests.log`），加共享 Web 的 12 项为本轮 124 项定向通过；无新增 skip。最终 Native check：`projects-session-final-check.log`。这只是当前触及范围的回归数字，不是全范围验收通过率。

### 批次 C / P01、P05 状态连续性与菜单逐入口

#### 本轮真实复现及修复

- 原包：项目折叠→助理 Tab→项目，工作树重新出现；主目录点更多显示5条→折叠→展开，退回3条。原始脱敏 AX 在 `.scratch/nsh/p01-p05-native.jsonl` 的 `collapsed-tab-return-settled` / `main-expanded-five` / `paged-project-reopened`。较早的 `after-*` 抓到了动画中重复节点，不用于稳定几何结论。
- Web 同 Host 手机基准：402×778、DPR3、5 touch points、`device-mobile mobile-pointer dark`。折叠后助理/计划/设置往返仍折叠，项目头 y=311.9453125；主目录更多显示5条，折叠重开保留“更少”。展开状态跨三个 Tab 往返，marker y=393.3046875，分页保持；滚动稳定后往返 marker y=243.3046875。几何必须等动画结束，未把一次 wheel 的中间帧当滚动跳动。
- `Home` 保留同连接 Projects surface 和原生 Scroll，显式 active fence 不变；不是新增 offset 补偿。`DirectoryRows` 的显示条数移到原 controller 按目录持有，折叠卸载行不丢条数。完整 index 的缓存展开不再误发列表 GET，按钮文案复用 Web 的更多/更少。工作树已读取后再次展开不自动请求下一页。
- 范围/代价：只保留当前连接已有 Projects owner；没有新全局 store、timer、磁盘缓存或依赖。目录显示条数是本地 UI 状态，不是服务端分页 authority。隐藏仍退役原请求 lane；Host 更换释放旧状态。并未宣称百项目性能或其它 Tab 的保位已验收。

#### 最终完整 App 的局部复验

- 脱敏 AX：同文件 `fixed-collapsed` / `fixed-assistant-return` / `fixed-schedule-return` / `fixed-settings-return` 均保持折叠，项目头 y=536；`fixed-scrolled`→`fixed-scroll-tab-return` 均 y=42.666666666666686。此时 Host partial 横幅占据上方区域，不能拿该 y 与旧正常环境的344作像素对齐。
- 最终包：`final-main-five`→`final-paged-reopen`→`final-paged-tab-return` 保留5条与主目录 fewer，marker y=613、fewer y=817不变；`final-collapsed-settings-return` 仍折叠。新聊天、工作树表单和关闭确认取消返回后，分页仍保留。
- 工作树 `final-worktree-more`→`final-worktree-reopen`→`final-worktree-tab-return`：10条显示、fewer y=819 / more y=863保留，项目头 y=31不变；显式更少恢复3条，保留更多入口（`final-worktree-fewer`）。没有把项目 summary 的 `+` 去掉伪造全量加载。
- 结束时已返回 Projects 顶部，无弹层；系统外观未改动。无模型/语音调用，无新建或关闭真实项目/工作树，无暂存/还原/提交，无编辑用户字段。

#### P05 实际菜单及返回结果

| 入口 | 当前 Web 手机端 | 最终原生包 | 仍有差异/未验 |
| --- | --- | --- | --- |
| 新建会话/聊天 | 打开空草稿，返回 Projects；未发送 | 打开新会话页，Back 返回且首页分页保留 | 新草稿全集仍依 P08；一次过早点击仍停留在菜单，已等待稳定后重做，不计首次为成功 |
| 新建工作树 | 表单→取消返回，未创建 | 系统 Sheet→`projects-worktree-cancel` 返回，未创建 | Web 有 GitHub Issue/PR 开始、源分支默认值/重置与说明；原生对应字段/布局未完成逐项对齐，不能标绿 |
| 同步会话 | 实际调用后菜单关闭回 Projects | 实际调用后回 Projects，主目录重新读到5条 | 失败/恢复、多工作树完整度未验；不等于全部同步成功 |
| 编辑 | 编辑表单→未修改关闭 | 复用项目编辑器→关闭返回，无提交 | 图标/颜色/dirty/busy 各分支仍未验 |
| 关闭项目 | 确认文案→取消，项目保留 | 同样确认文案→取消，项目保留 | 没有执行真实关闭/恢复；非 Git 条件未验 |
| 工作树管理 | 项目菜单没有此项 | 工作树列表 Sheet→关闭 | 额外入口归属差异保留，未删能力以凑一致 |
| 文件 | 项目菜单没有此项 | 文件导航页→Back，返回首页 | 额外入口；文件内容全集另归 R03 |
| 更改 | 项目菜单没有此项 | workspace Changes Sheet 有刷新/文件组/关闭→返回 | 额外入口；没有点击任何 Git 写动作，diff 全功能另归 R04 |

原生8项无图标，Web5项有图标；原生默认半高菜单需系统扩展/滚动才能到最后几项。上述仅证明可达和取消/返回，不代表菜单视觉一致、所有权限状态或完整异常恢复通过。

#### 验证与环境边界

- **6文件 / 88 passed**：`.scratch/nsh/p01-p05-delivery-final-tests.log`，无新增 skip。新增 controller 回归覆盖目录隔离、完整缓存展开零GET、50次读取零GET、分页失败保留、Host退休拒绝修改；生产组件引擎覆盖折叠/重挂、隐藏Tab、更多/更少，并用隔离Host实际读计数验证工作树重开不增加请求、显式更多才读取下一页。fixture 是 F，不冒充上述真实 H/S。
- 新 fixture 首次因 headless Host 没有浏览器 `URL` 构造器失败，改为解析既有明确 query 后重跑通过；未绕过生产逻辑。最终 `nsh:check`：`p01-p05-delivery-check.log`。`dead-code` 已检查，仍报告既有 controller 测试入口和 fixture 为 unused，未据此删掉它们。
- 完整 arm64 包：`p01-p05-final-build.log`，已安装启动。常规构建两次因并行修改 AttachmentBridge.swift 被 Swift 拒绝；随后用只读复制的39个Swift输入执行同一构建脚本，退出0，副本与结束时源文件hash全部一致（`p01-p05-swift-snapshot.json`）。没有改发布脚本或覆盖并行源码。
- source map：最终 `projects.tsx` 以及 `application.tsx` 的 `Home` 块与当前对应源码一致；application 的其它区块之后有并行修改，**不能宣称整个最新工作区都已进入此包**。
- 当前真实 Host `session-index` 返回 available=true，但 sync 有1个失败目录，completed=1/total=2，主目录标失败、工作树5条且hasMore；根级新完整App同时出现通知读取失败与 `Incomplete sessions catalog` 横幅（`p01-fixed-home.png`）。本轮没有修改该并行根逻辑，也没有把失败当成功空列表；显式同步/更多用于恢复所需目录读取，但全目录/root错误未消失。旧 Web 已加载17条与新App部分目录不是同一完整度，故本轮**没有再次作17条全量一致性或精确对帧结论**。
- 保留未完成：上述root失败/局部失败隔离与恢复、非Git、dirty/busy/权限失败、长列表/真机、工作树字段与图标/入口差异。P01/P05、所有 session 未验项及总计0项全平台完整验收均保持不变。

### 批次 D / 单目录失败隔离、通知门禁与显式恢复

#### 原始反馈环与修复

- `.scratch/nsh/root-partial-live-check.py` 在旧完整 App 上实际红灯：`incompleteCatalogError:true`，而项目、marker 和四个 Tab 已存在。真实 Host 证据 `root-partial-host-before.json`：HTTP 200、available=true、43 目录，42 个未标失败；sync completed=1/total=2、failedCount=1，主目录失败但保存5条，工作树未失败并保存5条。没有操作用户 Host 以制造故障。
- 原因：根 reader 在全目录完整性检查处直接抛错，尚未采用成功目录；连接状态又把所有域成功当作可达条件。通知恢复把 `notification_catalog_incomplete` 错误展示为设置读取失败。修改前的实际 root/notification 回归 **3 failed / 40 passed**（`root-partial-red-tests.log`）。
- `session-catalog.ts` 只负责一次 root snapshot 的逐目录采用，不建 HTTP reader/轮询/全局状态。成功目录可更新和清空；失败、pending 或全局部分状态下未证明完成的目录保留 prior，冷启动可用 index 保存行作 display seed。分页 head 只保留既有边界后的 tail；全局完成数不足却未说明失败目录时，不能清空未知目录。重复/无目录身份的 wire 仍失败，不把无效数据伪装成成功。
- 根 receipt 增加可选 `sessionIssues`；局部结果不再作为全根加载异常抛出，但 sessions 域保持 failed/unknown、complete=false。其它已成功域可证明 Host 可达，`online` 不成为完整性凭证。Projects 只把 `sessionIssues` 用于项目头 `+` 与保留 prior 行，不再展示页面级局部提示或重试（与 Web 手机端一致）；真实整体失败仍走原 refresh。
- 通知只对明确的 `notification_catalog_incomplete` 保持 waitingReady；settings 成功状态不被误报为失败。peek/claim、完整 receipt、Host/authorization/lease/generation 和严格 resolver 校验全部保留。原 live admission 队列保留待处理事件；既有根收到完整 receipt 或显式 recover 时重试，消费去重不变。没有新增通知发送、OS 权限操作或安全门豁免。

#### 真实完整 App / 持续失败时的可用性

- 首次新完整包 `root-partial-live-after.json`：根目录错误=false、通知设置读取失败=false、局部提示=true、18 个项目、4 Tab、显式重试可用。点击 `projects-catalog-retry` 后 `root-partial-live-retry.json`：仍保留18个项目和11个可用会话行、局部提示及四Tab，不假报目录恢复。
- 从未失败的工作树打开真实已有会话，原生 Back/Chat 控件可达，截图目视确认已保存正文、Activity 和 composer 已渲染；未发送、停止或修改 Goal。AX 不公开正文行 testID，不能用其零 bodyParts 推断空会话。证据摘要 `root-partial-healthy-session.json` 同时保留限制：页面仍有“正在同步消息…重试”，本轮**没有证明实时追平或完整历史已恢复**。返回并跨助理/计划/设置再回 Projects 可用（`p01-p05-native.jsonl` 的 `partial-all-tab-returns`）。
- 同一真实 Host 的 Web 手机对照仍使用402×778、DPR3、5触点、`device-mobile mobile-pointer`。Web 显式展开工作树更多后取得12条，加主目录5条，项目头17；原生显式取余页后也为17（`root-partial-native-comparison.json`）。这里只恢复已加载数据数量的对照，**不冒充完整度/视觉一致**：原生保留 `+`，Web 当时未显示 `+`，Host 本身仍报告失败目录。没有清 Web 缓存或篡改 Host 同步结果以凑一致。
- 最终包重装及后续 index 更新后再次取证，Web 与原生当时均为 bounded index 的10条（`root-partial-web-comparison.json` / `root-partial-final-native-comparison.json`），不是把早先17条截图当作最新状态。原生继续显示 `+` 和局部未完成提示；Web 未显示 `+`。加载/刷新完整度的持续保持与两端提示差异仍须跟进，不能将数字暂时相同视为全面对齐。
- 收紧“未解释完成数不足不得清空”的边界后再次完整构建、安装启动，`root-partial-final-live.json`：局部提示=true，根目录错误=false，通知读取失败=false，retryEnabled=true，18项目、marker、四Tab均保留。`root-partial-live-check.py` 在最终包再次通过；最终包上的显式重试仍保留局部失败信号。

#### 隔离恢复与回归，不替代真实端到端

- `root-catalog-native.test.ts` 用生产 root writer 与生产 Projects 组件、独立合成 Host/存储，在真实 NSH 引擎覆盖：部分失败保保存行、健康行可点击、持续失败重试、显式切为健康完整空目录、receipt 确认、局部提示/保存行清除。它没有生产连接或凭据；这是 **F/引擎**，不是生产 App 的 UIKit/真实 Host 恢复。
- 根状态回归覆盖 partial→healthy、冷 display seed、失败保 prior、成功空目录、未知路径/畸形目录、pending/active/完成数不足与分页边界。通知回归覆盖等待时零 peek/claim、真实设置错误仍报错、待处理 live 事件恢复且只消费一次，以及原有 Host/授权/租约与迟到结果隔离。
- 最终 **7文件 / 126 passed**：`.scratch/nsh/root-partial-delivery-final-tests.log`；扩展 **5文件 / 175 passed**：`root-partial-broader-final.log`。合计12个不重叠文件301项，无新增 skip。这不是73行完整验收通过率。
- 过程曾有49项扩展失败，没有直接归为无关。只在测试转换层恢复旧 root catalog 算法、保持当前 stream admission 不动的隔离对照，baseline/current 均相同17项失败、158项通过（`root-partial-differential.json`，`.scratch/nsh/catalog-baseline.config.ts`，没有回退源码）。测试夹具/stream owner 在并行更新后，最终上述5文件175项已重跑通过。不能把中途49或17失败的旧日志当最终通过证据，也不能把别的 owner 的修复归为本轮成果。
- Native `nsh:check` 最终通过（`root-partial-native-delivery-check.log`）；此前 `resources.tsx` 文案 key 和 state stream 分支类型错误没有由本轮覆盖/绕过。共享 UI type-check 通过（`root-partial-ui-check.log`）。`dead-code` 已跑并检查（`root-partial-dead-code.log`），新引擎 fixture 同其它动态测试入口被报告 unused；未据此删掉运行中的夹具。
- 最终完整 arm64 模拟器包构建通过（`root-partial-final-build.log`），41个Swift只读编译输入在结束时全部匹配源码。`root-partial-final-freshness.json` 核对最终包 source map 的 state/session-catalog/notification-root-core/notification-global-admission/projects 五个完整源码均与当时工作区一致。后续并行改动不自动获得该包证据。

#### 仍未完成

真实 Host 失败目录尚未修复，不能声称已经观察到真实 partial→healthy 或 OS 通知恢复投递；本轮没有为验收改动其索引数据库/配置。仍保留菜单图标/入口/工作树表单差异、同步提示与实时追平、真实多项queue＋Goal、严格连续三页保位、IME/外接键盘、晚到资源及真机/Relay 全分支。73行矩阵仍全部未完成，**0 项全平台完整验收**不变。

### 批次 E / 固定分页窗口的刷新保持与完整性展示

#### 红灯及合同

- Web 原先用超过固定20条推断客户端已翻页。真实 Host 的 head 仅5条，客户端读到12条后，新 head 刷新会退回5条；失败目录的空 snapshot 也能抹掉 prior。`window-web-red.log` 两项实际红灯。Native 相反：已加载12条后，即使新 head 明确 `hasMore:false`、只有5条，仍保留旧尾页；`window-native-red.log` 实际红灯。
- Web 改用成功 load-more 后的显式 `loadedMore`，保留较深/已终结的客户端分页与 head 边界以后的 tail。完整成功 head 仍可替换和清空。没有用“比 head 多”替代原20条猜测：中途冷缓存 ghost 回归确实失败，最终显式 marker 已让该回归通过（`window-web-regression.log` 为中间失败日志，不是最终结果）。Native bucket 只在新 index `hasMore:true` 时保留尾页；完整 head 清除旧 tail/cursor，失败保留分支不放宽。
- Web `incomplete` 元数据区分 failed/pending，保留 prior 行与终结分页；项目 `+` 同时反映远端余页和目录未完成。Native summary 也接收原根 `sessionIssues`，客户端末页不等于失败目录已恢复。两端都不在首页显示局部失败提示：Web 的 `catalogIncomplete` 保留在模型层但未接入容器，Native 同样不展示；`+` 是唯一可见呈现。
- 追加边界：失败/pending 路径不在 `directories` 行内也必须发布元数据；明确 completed 后清标记，但缺行不当作空目录。`window-absent-metadata-red.log` 两项红灯后修复；最终87项包含其恢复测试。GET失败保 prior、旧 runtime 响应隔离、成功空目录、冷缓存 ghost、2000会话/301 pending目录的操作数与引用保持均包含在最终 Web 回归中。未据此宣称输入时延或帧率已实测通过。

#### 同 Host、同 ID 集合的 H/W/S 实测

- 使用原 Host，无新后端、无索引/用户配置篡改。Web 是当前源码 Vite 手机入口，代理原 Host；不是把旧已部署界面当作新实现。主目录固定5条，工作树显式读到12条。只存排序去重 ID 的 SHA-256、数量、分页和状态，不存标题或原 ID。

| 范围 | 条数 | Web / Native 共同 ID SHA-256 |
| --- | --- | --- |
| 主目录 | 5 | `bcd6b57fb3acdbb3141bc872be4536694a85930a8c5674b5aa94a96a34723e89` |
| 工作树 | 12 | `b565152649754a66efcbeb5f3089f605c72a3186649f71bdca65841b15f6158d` |

- `window-web-evidence.jsonl`：`loaded-before-refresh` revision74 → `after-project-sync` revision86，集合不变；`after-local-retry` revision87 仍不变。主目录 `incomplete:failed`，工作树 `hasMore:false,loadedMore:true`；项目始终 `17 个会话+`、局部提示=true。真实操作包括项目菜单“同步会话”和局部重试，没有发模型/语音请求或执行 Git 写操作。
- `window-native-evidence.jsonl`：完整已安装 App 的 `loaded-before-refresh` → `after-local-retry` → `after-all-tab-returns`，两目录 hash与上表一致；项目17+、局部提示、四Tab保留，根目录错误=false。AX 确认各目录已无更多控件；这证明当前全部行可见，不冒称读到了内部 controller cursor。滚动按实际几何定位，未点击 offscreen 控件。原生执行了显式更多直至末页，不要求其请求次数与 Web 相同。
- 元数据边界修改触发开发 HMR 后，重新从 bounded head 建立17条窗口，而非声称热重载/冷启动也保留内存分页。最终 Web `final-loaded-before-retry` → `final-after-retry-and-tabs` 再次确认两集合不变、17+、局部提示和终结分页保留。Web 跨助理/计划/设置返回均已操作。
- 常规 Web 条件为402×778、DPR3、5触点、`device-mobile mobile-pointer`。Native AX window 为402×874；额外的 Web `same-size-402x874-after-retry` 记录同尺寸状态及相同 hash，主目录/工作树均已展开到全部行。临时截图已目视核对：两端17+、局部文案及重试一致，但当时 Web 为暗色、Native 为亮色，导航/系统安全区和字体仍不同。**本批只关闭数量/集合/完整性展示的上述状态边界，不宣称同主题逐像素对齐。**截图含用户内容，仅留系统临时目录，不加入仓库。

#### 构建与回归证据

- 最终 Web **5文件87 passed**：`window-web-final-regression.log`；Native **5文件79 passed**：`window-native-delivery-tests.log`；Vite合同 **8 passed**：`window-vite-contract-tests.log`。无新增 skip。早期 Web85项是新增缺行元数据边界前的结果，不能替代最终87项。
- UI、Web、Native 类型检查通过：`window-ui-final-check.log`、`window-web-check.log`、`window-native-check.log`。生产 Web build 通过（`window-web-build.log`，含PWA构建）；仍有CSS highlight、字体解析、动态导入/大chunk及plugin耗时警告，不宣称零告警或生产包已跑端到端。
- 完整 arm64 Native 构建已安装并用于上述 S 实测。`window-native-freshness.json` 核对包内 projects/projects-summary 与当前源码一致，构建时41个Swift输入在结束时全部匹配；不把其它并行改动自动算入此包证据。
- Web 开发启动曾被 browser graph filter 阻塞；只放行现有无 import 的 `server/lib/notifications/admission-event.js` 纯 wire validator，其它 server实现仍隔离。8项Vite合同覆盖此例外及原开发/生产编译边界。没有引入新依赖或开放通知发送/凭据代码。
- `dead-code` 已运行并检查（`window-dead-code.log`）：报告131个unused files、797个unused exports，属于仓库整体诊断而非本批全部新增；未用其非阻塞退出码宣称全仓无死代码，也未删其它owner文件。

#### 未关闭的范围

Host仍报告1个失败目录；真实 partial→healthy、通知恢复投递及会话“正在同步消息”实时追平未验。本批的 Projects 局部提示不代表 Chat 同步提示已修复。菜单图标/额外入口、工作树表单、真实多项queue＋Goal、连续三页历史保位、IME/外接键盘、晚到资源和真机/Relay继续保留。矩阵仍73行、**0项全平台完整验收**，未因本批174项回归或局部实测升级整行判定。

### 批次 F / 同 Host、同暗色的项目菜单与工作树表单

#### 条件、原始红灯与修复范围

- Web 当前源码手机入口与完整已安装 Native App 连接同一真实 Host、同一项目；两端402×874，Web DPR3、5触点、`device-mobile mobile-pointer dark`。模拟器系统外观从 light 改为 dark，未写 Host 外观配置；字体/系统材质仍有差异，不能只凭暗色一致声称主题呈现完全对齐。
- 旧完整 App：新分支输入本轮受控文本后切现有分支，仍继承该文本，未点创建。`menu-form-mode-live-red.json` 的 `existingModeInheritedTypedNewBranch:true` 是实际产品红灯。最初 `menu-form-red-tests.log` 则因 fixture 缺 NavStack、生产页未挂载而失败，不能冒称同一产品回归红灯；补齐载体后才获得下面的引擎结果。
- Native 菜单复用 Web 的 `buildProjectMenuItems`，前五项顺序/字典/图标一致，三项额外能力移到后面而非删除。工作树表单拆开两模式草稿，增加随机初始名称、持久字段标签、目录跟随/重置、搜索分组分支选择器、提交禁用和共享名称规范化；系统 pageSheet、pending 关闭保护与真实 completion 不变。
- Web 表单实测停止编辑后仍重复预校验：`menu-form-web-live.json` 记录121次校验、创建0次。真实 React 组件回归 `menu-form-validation-red.log` 为预期1次却51次；根因是取消句柄 state 成为自身校验依赖。改为 ref + `useEvent`，effect 只响应真实表单依赖，关闭/换稿使旧响应不可采用，**不宣称 HTTP 已物理取消**。

#### 菜单、字段、退出与失败恢复对照

| 项目 | Web / 最终 Native 局部证据 | 未关闭的差异与分支 |
| --- | --- | --- |
| 标准项目菜单 | 新建会话 `add` → 新建工作树 `node-tree` → 同步会话 `refresh` → 编辑 `pencil-ai` → 关闭项目 `close`；共享模型/引擎验证图标，完整 App AX 与 Web DOM 确认相同顺序和文案 | Native 额外工作树/文件/更改仍保留，半高菜单需滚动；非 Git、探测失败、布局/字体/动画未全验 |
| 菜单退出/关闭项目 | Web 菜单 X 关闭；两端关闭项目确认→取消后项目保留，未确认有损操作 | 真实关闭/重开、编辑 dirty/busy 仍未全验 |
| 新分支默认/标签 | Native 随机默认分支与目录一致，分支/目录/源分支持久标签可见，复用 Web 纯名称规则 | Native 未避让已存在随机名称；Web 额外 GitHub 起步入口、说明与字段密度不同 |
| 模式切换与目录 | 完整 Native 输入后切现有分支不继承新分支；选 main 后目录=main，创建可用但未点击；切回新模式保留草稿，重置目录恢复 slug，再切现有模式保留选择 | 远端分支排名、长列表/搜索无结果、分支刷新失败/恢复尚未逐项实测 |
| 源分支 | 完整 Native 打开真实 picker，选 main 并等关闭完成后返回表单 | Web 有默认/记忆、碰撞处理及说明，Native 初始仍为空；不能把手动选 main 当默认值已对齐 |
| 表单取消/返回 | Web 两模式草稿/重置及取消返回；Native 取消回 Projects、重开不恢复已取消稿、标题 X 返回，均未点真实创建 | Native 底部纵排主次动作与 Web 排列不同；交互拖关、键盘/IME、真机全分支未验 |
| 预校验/拒绝恢复 | Web 最终停止编辑后1500ms 校验 POST **1→1**、创建0；Native 隔离生产表单引擎：校验拒绝保稿→显式重试，校验2次、创建1次 | Native 只有创建前校验，没有 Web 字段级 touched/debounce 提示；真实拒绝/创建、未知 POST 结果核验/重启恢复均未验 |

#### 完整 App 与 Web 的最终证据

- `.scratch/nsh/menu-form-native-live.jsonl` 七阶段：`final-complete-app-switch-existing`、`existing-select`、`return-new`、`cancel`、`reopen`、`final-close-project-confirmation-cancel`、`final-header-close`。分别验证独立草稿/选择与可创建状态/重置/返回/丢弃已取消稿/项目保留/标题关闭；所有创建阶段 `createPressed:false`，有损确认 `destructiveConfirmPressed:false`。AX 不公开原生 Input 的 testID/label，输入按已观察的 TextField 几何定位；禁用创建动作可能仅暴露 StaticText，不能把缺少 Button ID 当控件消失。
- 菜单最终记录 `menu-form-native-menu.json` / `menu-form-web-menu-final.json`；Web 记录五项图标、关闭确认取消、菜单 X 和项目保留，Native 记录标准五项及额外三项。
- `menu-form-web-live.json` 的两模式草稿、重置、取消布尔值均为 true，但121次校验属于**修复前**观察，不是最终请求预算。最终以 `menu-form-web-budget-final.json` 为准：`validationBudgetBefore:1`、`validationBudgetAfter:1`、`validationQuiescent:true`、`validationPosts:1`、`creates:0`、`cancelReturned:true`。最初把 GET 也算入预算的7→15观察已纠正，不能误报为 POST 修复失败。
- 最终同尺寸暗色截图已目视核对，仍有 GitHub 入口、源分支说明、字体、字段密度与底部动作差异；只保留临时截图，不入仓库存用户内容。Native 截图等待实际 picker 关闭完成后采集，关闭动画中抓到的 picker 帧不作稳定表单证据。
- 本轮未发模型/语音请求，未在真实项目执行创建、删除或 Git 写操作。Vite 代理中途挂起，只在确认是本轮自建进程后重启开发服务；真实 Host 未重启，恢复后 `/health` 200、Git 菜单正常。未改用户凭据或数据库来制造成功结果。

#### 回归、构建与证据边界

- Native **5文件75 passed**：`menu-form-native-final-tests.log`，覆盖 controller、共享菜单、生产表单引擎、首页 Sheet 与 Select 合同；Web **4文件15 passed**：`menu-form-web-final-tests.log`，包含名称规则6项、表单项目解析3项、菜单3项及真实 React 校验3项。合计90项，无新增 skip，不是73行全平台验收通过率。
- Web 校验回归覆盖成功/失败各50次无关父级重渲染只校验一次，以及关闭重开后旧拒绝响应不污染新稿。Native 隔离 fixture 合成校验拒绝与创建计数，不访问真实 Git；headless 不发送 UIKit Sheet opened/dismissed，不能宣称它覆盖了实际 picker 选择或菜单关闭 completion，这些局部行为由上述完整 App 补验。
- 过程中的菜单 fixture 错用 Git probe 字段、测试文案大小写及 headless 等待系统事件等失败已修正；最终日志才是通过证据。初始新 import 引入 React 类型链的 Native check 失败通过把菜单模型 I18nKey 指向纯字典类型解决，未放宽类型检查。
- Native/UI 类型检查通过：`menu-form-native-final-check.log`、`menu-form-ui-final-check.log`；完整 arm64 Native build 与生产 Web build 通过：`menu-form-native-build.log`、`menu-form-web-final-build.log`。Web 仍含 CSS/字体/大 chunk 等警告及测试未 mock fetch 警告，不宣称零告警或生产 Web 包已端到端跑通。
- 最新完整 Native 包已安装启动；`menu-form-freshness.json` 核对 projects、projects-home-sheet、共享 sessionMenuModel/worktreeNames source map 与当前源码一致，41个Swift输入在构建结束时匹配。该结果不自动覆盖其后并行改动。
- `menu-form-final-dead-code.log` 已检查：132个unused files、797个unused exports；新动态工作树 fixture 与同类测试入口被报告 unused，未因此删掉夹具或其它 owner 文件。未新增依赖，未提交/推送。

#### 仍未完成与下一步

P05/P06仍未完成：优先补 Native GitHub Issue/PR 起步、源分支默认/记忆与碰撞处理、字段级预校验、远端排名及布局/字体/底部动作，再以隔离实体覆盖创建/未知结果/失败恢复。真实 Host 的失败目录、Chat 实时追平、真实多项queue＋Goal、连续三页保位、IME/外接键盘、晚到资源及真机/Relay继续保留；不重复已完成的17条窗口验收。矩阵仍73行，**0项全平台完整验收**。

### 批次 G / 源分支默认、成功偏好、碰撞与字段预校验

#### 本批实际合同与差异

- 新 `projects-worktree-form.ts` 由单个打开表单所有；复用 Web `worktreeSourceBranchPreference`，以当前目录完整分支集验证偏好，再按成功偏好→主工作树当前分支→main/master→首项选择。primary-root/status 与 branches 用捕获的 page-operation 请求；迟到默认不覆盖手动选择，读取失败显式报错/重读，不伪装成空目录或创建许可。与 Web 在 root 读取失败后允许 fallback 不同，Native 首次上下文未就绪时核心 submit 拒绝创建，保留为有意的失败行为差异。
- 成功偏好按连接 ID/URL/授权身份隔离，取消不存；保存时机与 Web 一样在创建确认后，新模式记 source、现有模式记 selected branch。使用新设备 Storage 命名空间，不修改真实 Host 配置。偏好保存失败保留本表单内 confirmed path，显式重试不再次创建；它不是跨进程 journal，不能据此宣称未知 POST 已恢复。
- 只对未编辑的随机默认值避让已知工作树名与分支名；目录/分支手工输入不被目录迟到响应改写。十次随机碰撞后检查数字后缀，服务端创建前校验仍不可省略。Web 当前只用已有工作树名避让，Native 额外检查已知分支名；没有把随机数或时间戳当唯一性 authority。
- touched 后300ms预校验，等待期间禁用创建、显示加载；分支/目录错误贴字段展示，未知或网络错误单列，显式重试保稿。每个表单最多一条网络校验与一个最新待检稿，无关状态不轮询；关闭/覆盖/换稿与 operation 更换均使旧响应不可采用，不宣称物理取消 HTTP。最终提交仍由原 controller 再校验再创建，UI 校验不授予写许可。

#### 当前源码与隔离恢复证据（F，不冒充真实 Git）

- `projects-worktree-native.test.ts` 使用生产 ProjectDetail 表单与独立合成 Host：touched 校验拒绝→分支/目录草稿保持→显式校验重试→提交前再校验→创建一次，最终 **validations:3 creates:1**。批次 F 的“提交后拒绝再提交”测试已改为覆盖新增字段预校验路径，不沿用旧的两次校验计数。
- 同文件的生产 form-owner 引擎载体验证：默认 main；只选择后关闭/重开不记忆；合成创建确认后重开记住选择；一条校验悬挂时后续编辑合并为最新稿，迟到的旧冲突不展示；50次无关状态更新不新增校验；迟到碰撞目录只替换未编辑默认值、保留用户输入。这是状态/操作数合同，不是 UIKit 帧率或真机输入延迟测量。
- `projects-worktree-form.test.ts` 覆盖十次碰撞与已占后缀、首次上下文未知时核心拒绝 submit、创建确认后的偏好保存失败重试不重放 create。该文件用轻量 signal/mock Storage 隔离测试提交阶段，不用其结果证明真实 Storage/Sheet 生命周期；默认/记忆与迟到响应的响应式流程由前项真实 NSH 引擎覆盖。
- 最终 Native **6文件82 passed**：`worktree-validation-delivery-tests.log`；共享 Web 纯偏好/名称及真实 React 预校验 **3文件15 passed**：`worktree-validation-web-tests.log`。合计97项，未用其升级P06整行判定。
- Native check：`worktree-validation-delivery-check.log` 通过。初轮59个 controller 失败来自并行新增 appearance import 未登记到 VM 测试映射，不是59个产品行为失效；补齐原生展示叶子映射后回归通过。首轮新的请求计数测试发现 debounce等待期创建按钮可短暂点击，已把等待期纳入校验中禁用并重跑，不再用抢先提交得到的两次校验充当预校验重试成功。
- Context7 已实际返回月额度耗尽；本批 API/纯规则核对本地安装类型、现有 runtime 边界及 Web owner，未新增依赖或执行 Git 命令。

#### 同 Host/暗色 Web 的真实只读对照

- `worktree-validation-web-default.json`：402×874、dark，稳定默认源分支 main；取消无提交。`worktree-validation-web-live.json`：输入现有 main 分支后字段冲突显示、草稿保留、创建禁用、未点击创建；实际关闭 completion 后确认返回。早期在默认读取或关闭动画尚未完成时得到的 false 不是稳定帧，已等待实际条件后重采。
- Web 代理再次挂起时真实 Host health仍200；仅确认并重启本轮自建Vite，未重启 Host 或变更其数据。恢复后继续同一 browser space/page，不新建环境绕过问题。

#### 最终完整 Native App 与相同状态复验

- `worktree-validation-native-live.json`：完整已安装 App、同 Host/项目、dark、402×874。默认源分支 main 已在真实 AX 的说明中显示，无需手选；切现有模式→真实 picker选 main 后，目录稿为main、`branch-error`显示、创建禁用。点显式重试后等待校验结束，冲突及目录稿仍保留；取消等待系统关闭 completion 后回 Projects，`createPressed:false`。
- `worktree-validation-web-existing.json` 是相同现有模式/main分支/目录main状态：同尺寸暗色、冲突显示、草稿保留、创建禁用、取消返回，未点击创建。不能把前面的新分支main冲突与Native现有模式冲突混作同状态对照。
- 两张稳定截图已目视核对，仅留系统临时目录。状态一致，但 Web 当前把该冲突放在底部动作区，Native 放在分支字段后；标题/输入字号、Sheet高度、按钮方向和错误区空间仍不同。本批关闭上述状态缺口，不声称完整视觉一致。
- CLI 不支持退格字符，直接替换新分支输入的尝试被工具拒绝；没有据此宣称完成该原生输入场景。改为实际选择器选择现有main得到同状态校验证据，未触发任何真实创建/删除/Git写操作。成功创建后的偏好记忆和目录冲突恢复只在隔离实体中验证，未拿用户工作树做写入验收。
- 最终完整 arm64包：`worktree-validation-delivery-build.log`；构建使用41个Swift只读输入，结束时匹配由 `worktree-validation-delivery-swift.json` 记录。最终打包前曾发现 form owner source map 与末次修订不符，已重构建再安装启动，不使用旧包冒称最新代码。最终 source map 核验与本批证据摘要见 `worktree-validation-final-verification.json`。
- `dead-code` 已运行检查（`worktree-validation-dead-code.log`，130个unused files/797个unused exports）；未删除并行或动态测试入口。Native check及97项定向回归通过，没有重跑无改动的生产Web构建/全仓测试，也没有据此宣称全仓通过。

P06仍未完成：GitHub Issue/PR起步、远端分支排名/搜索全分支、真实Git创建删除、未知POST与跨进程恢复、权限/断网/真机及完整布局字体继续保留。Chat实时追平、真实队列＋Goal、连续三页保位、IME和Relay未在本批验证。73行全部保持未完成，**0项全平台完整验收**。

### 批次 H / 分支搜索排序与目录读取恢复

#### 共享规则、读取合同与隔离证据

- `projects-worktree-branches.ts` 直接消费 Web `rankBranchesForQuery`，只适配本地化分组。匹配按既有模糊相关度置顶，保留其他本地/远端分支，不再把搜索当子串过滤；远端行显示去前缀名，选择值保留 `remotes/`，表单 trigger 与 Web 一样保留完整值。共享 scorer import 改为相对路径，未引入第二套评分规则或依赖。
- `WorktreeBranchPicker` 同时装配源/现有分支，系统 picker 内提供加载、读取错误、刷新与显式重试；搜索无匹配显示提示且保留目录，成功空目录显示“未找到分支”，失败不伪装成空成功。列表头和排名由 `NativeSelect` 可选扩展承载，普通 Select 的子串语义不变，原 List/ref/primitive value key 和并行 density 改动保留；非 iOS 定制调用走同一内容+NativeSheet fallback。
- 表单 `prepare` 增加当前活跃上下文 single-flight 门，同一读取中50次刷新只发一轮 branches 读取；失败保留已知分支、草稿及 canonical 远端选择，首次失败仍阻止创建。只有用户显式刷新/重试才再次读取，无关状态不重读；成功空集合才替换目录。关闭/退役后旧空响应不得抹掉现有目录，且不会继续下一步 status 请求；不宣称已发 HTTP 物理取消。这里“拉取分支”仍使用原 GET 目录读取，不额外执行 Git remote fetch。
- `projects-worktree-native.test.ts` 新增隔离引擎链：已知3条→选择 `remotes/origin/release`/目录 `origin-release`、编辑草稿→HTTP503→保留目录和选择/稿件→无关50次更新不重读→显式重试成功空目录→再次显式重试恢复3条；所有这些路径创建计数0。另覆盖首次读取失败保持 unknown、显式恢复，以及一条悬挂读期间50次点击合并、隐藏后迟到空响应不清目录。夹具不访问真实 Git。
- `native-select-contract.test.ts` 运行生产 picker+Select 的回调/JSX载体：加载/失败时不显示成功空态，成功空态与搜索无匹配分开，重试才调用 prepare，远端模糊匹配选择保持 canonical 值；iOS/非 iOS 都覆盖定制排名不被子串二次过滤、关闭不排名、重开清查询。该载体用 VM/native叶子 stub，不证明 UIKit 呈现或键盘时序。
- `projects-worktree-branches.test.ts` 覆盖精确远端置顶、错字模糊匹配、无匹配保留分组、真正空目录、默认排序不改权威数组。初次失败只有测试错误文案预期漏了实际 `HTTP 503:` 前缀，日志 `branch-picker-tests.log` 为1 failed/93 passed；修正断言，不改生产错误或吞503来换绿。

#### Web 实际只读对照

- `branch-picker-web-live.json`：继续复用同 Host/项目与原 browser space/page，dark、402×874、DPR3、5触点并确认 mobile-pointer。查询 `origin/main` 时精确远端第一，其他本地/远端分组保留；查询 `zzzzzzzzzzzz` 显示无匹配但仍有其他分支；选远端后表单保持 canonical 值和目录 `origin-main`，关闭重开清查询，取消回 Projects，未点创建。
- Web 稳定排名截图已目视核对，暂存系统临时目录，不入仓库；只读对照没有执行 remote fetch、创建/删除或模型/语音调用。

#### 完整 App 发现的额外红灯

- 初次完整 App 搜索 `origin/main` 时 AX 中匹配排序正确，但截图中旧高亮仍停在“其他本地分支”，原生列表自动滚动使匹配首行退出视口；因此 `branch-picker-native-ranked.json` 的初次 AX 顺序记录不能当作可见排名通过。
- 已增加查询变化时的键盘定位重置：只在定制查询变化时调用 `keyboard.sync(true)`，一次聚焦第一可用匹配，不先滚动旧高亮再滚回；普通 Select 的保留选中/高亮语义不变。生产组件 VM 回归检查末次 List 命令 index=0，键盘纯合同验证一次 focus；这仍须由下方最终完整 App 截图补验。

#### 最终完整 App 与验证边界

- 最终 `branch-picker-native-ranked-final.json` 和 `branch-picker-native-live.json`：完整 App 同 Host/项目、dark、402×874；查询 `origin/main` 后首条精确远端实际可见（行 y=690.92，搜索区底部 y=593.94），不再只依据离屏 AX 顺序。最终匹配区截图已目视核对；源分支入口也实际搜索并选择相同远端，说明使用完整 `remotes/origin/main`。
- 现有分支选择后目录 `origin-main` 保留、picker关闭完成；trigger 的文字未由 AX 公开，canonical值通过稳定截图目视确认，不能把第一次 AX断言失败误报成选择丢失。重开清空查询；输入无匹配词后提示与其他本地分支实际可见，AX确认其他远端仍保留；关闭不改目录稿，取消回四Tab，未点创建。截图只留系统临时目录。
- Web 与 Native 的现有分支真实对照覆盖同一个查询/远端选择/无匹配/取消，不把静态纯排序测试冒充交互。Native 的读取503/成功空目录/重试仍以隔离 Host 引擎和生产组件 VM 为证据，**未在完整 UIKit App 制造真实读取故障或空仓库**；不能把该恢复分支称作全端端到端完成。
- 最终 Native **8文件100 passed**（`branch-picker-delivery-tests.log`），Web **3文件13 passed**（`branch-picker-web-tests.log`），合计113项。新增生产选择器回归与原有form/controller/menu、键盘合同一起运行；无新增skip。初轮定向结果及构建不能替代最终运行日志。
- 最终 `branch-picker-latest-check.log` 通过。此前 `branch-picker-delivery-check.log` 曾因并行 `resource-html-viewer*` 类型/字典键错误失败；未覆盖或代修该owner，后续当前源码复跑通过，不掩盖这次中间红灯。Context7本轮仍实际返回月额度耗尽，沿用本地类型和现有实现核对；未新增依赖。
- 补测Web源分支时菜单临时缺少Git动作：真实Host health=200，而自建Vite代理health超时。确认进程归本轮后，仅重启该开发代理，保留同一browser space/page；恢复后真实源分支也成功选择 `remotes/origin/main` 并取消，结果补入 `branch-picker-web-live.json`。没有重启真实Host或修改其Git状态来使菜单出现。
- 完整 arm64构建、安装启动完成（`branch-picker-delivery-build.log`）；本次44个Swift输入在构建结束时匹配（`branch-picker-delivery-swift.json`）。最终 source map 与源码及73行矩阵核对摘要见 `branch-picker-final-verification.json`。`dead-code` 已检查（`branch-picker-dead-code.log`：130个unused files/797个unused exports）；动态fixture报告unused未据此删除。
- 排名可见性已关闭本批具体缺口，仍有系统Sheet高度、字号/行距、额外刷新行、键盘高亮底色与Web布局差异；未验证light/高对比、外接键盘/IME、真实remote fetch、跨端故障恢复、真机/Relay，也未做帧率/输入延迟测量或全仓测试。GitHub起步、真实Git写入/未知结果及其余Projects/Session全链路仍在矩阵保留。**73行仍全部未完成，0项全平台完整验收**。

### 批次 I / 完整 UIKit 与 Web 同隔离 Host 的分支读取恢复

#### 环境、安全与真实红灯

- 在完整 `YuriNative.app` 上通过正常“已保存的连接→添加实例→手动连接”入口接入独立 loopback HTTP Host，未注入 Native JS、修改 Keychain 文件或读取原连接凭据。测试连接 `Branch Recovery Fixture`，独立项目 `/isolated/branch-recovery`；两端暗色、402×874，Web DPR3/5触点并等待 mobile-pointer。固定现有分支 `remotes/origin/release` 和目录稿 `origin-release-draft`，未点创建。
- `.scratch/nsh/branch-recovery-host.py` 只提供合成数据与受路径约束的生产 dist 静态读取；没有 Git、上游、模型或语音调用。仅 POST validate 返回合成成功，所有其它写请求405；初始化 settings/push等被阻断请求不等于已执行写入。真实 Host 保持只读，不在用户项目创建测试实体。
- 实测503：Native表单/picker显示错误和重试，保留已知三条目录、远端选择和稿；Web保留稿和旧目录，却没有错误/重试。真实红灯 `branch-recovery-web-failure-red.json`；组件红灯 `branch-recovery-web-red-tests.log` 为 **1 failed / 3 passed**，确认不是环境假红。
- 后续 Web 空目录等待超时来自本轮自建 Vite 代理：代理 health超时、隔离Host未收到目标GET，不能记作产品恢复失败。已停止该代理，给合成Host补最小合法启动目录并直接提供本次生产构建；受限静态服务只读 dist，不代理真实Host。重启前audit保存在 `branch-recovery-audit-pre-static.json`，最终目标链在新audit中完整保留。

#### 最小 Web 修复与逐状态完整 App 实测

- `NewWorktreeDialog` 直接使用现有 `useGitBranchesQuery` 统一目录/加载/错误，不新增错误 store或第二个缓存；显式刷新/重试走 `refetch({ cancelRefetch: false })`，表单、两种手机picker、两种桌面dropdown均显示错误/重试，错误不显示成功空态。草稿与canonical选择继续归组件，创建校验/命令未改。组件回归覆盖失败保稿、50次无关render不重读、显式refetch和成功空态；未把手机实测冒充桌面运行时验收。

| 状态/动作 | 完整 UIKit App | 修复后实际 Web 生产页面 |
| --- | --- | --- |
| 正常基线/选择 | 三条分支；选择远端；目录稿固定 | 同一合成目录/选择/稿 |
| 显式读取503 | 表单与picker错误/重试；旧行和选择保留；不显示成功空态 | 错误/重试可见；同样保留旧行/选择/稿；不显示成功空态 |
| 点击重试，200空目录 | 旧行移除、错误清除、显示“未找到分支” | 旧行移除、错误清除、显示“未找到分支”，稿与canonical选择仍保留 |
| 显式刷新恢复正常 | 三条恢复；错误/空态清除 | 三条恢复；错误/空态清除 |
| 关闭picker/取消 | 最终完整值和目录稿经AX/截图核验；取消回Projects | 同一完整值/稿；取消回Projects |

- Native证据：`branch-recovery-native-failure.json`、`branch-recovery-native-picker-failure.json`、`branch-recovery-native-empty.json`、`branch-recovery-native-restored.json`。恢复后完整值未由trigger AX公开，使用稳定截图目视确认，不能只凭自动目录推断选择正确。
- Web证据：`branch-recovery-web-failure-green.json`、`branch-recovery-web-empty.json`、`branch-recovery-web-restored.json`。Query原有窗口聚焦刷新在浏览器自动化重新取焦时可先于点击发生，不能把那次自动空成功冒充显式重试；另一次在同一页面求值中等待按钮可用、切测试Host模式并调用真实重试按钮的DOM click，确认显式路径（JSON标注 `retryViaDOMClick`）。没有直接改Query缓存/业务状态；不宣称这一步验证了物理触屏命中区。
- 最终两端失败、成功空目录、恢复目录与恢复表单截图均已目视读取，暂存系统临时目录。当前仍有：Native系统Sheet更高、字号/行距更大、错误细节文案不同、额外picker刷新行、选中高亮和列表滚动位置不同、Native空态在底部而Web居中；表单创建/取消的排列与底部固定行为也不同。**本批仅关闭已知分支读取恢复的功能缺口，不签收完整UI一致性。**

#### 验证、请求审计与清理

- Web **4文件19 passed**（`branch-recovery-web-tests.log`），包含原有校验预算/迟到拒绝、共享排序及Query回归；`branch-recovery-ui-check.log` 类型检查通过，`branch-recovery-web-build.log` 生产构建通过。构建保留现有CSS highlight、KaTeX字体与chunk警告，不宣称无警告。`branch-recovery-dead-code.log` 已检查：130个unused files/797个unused exports，未据此删除动态fixture或其它owner代码。
- Native沿用批次H最终完整包，本轮未更改Native源码，不伪称新构建。六个相关Native源码与包内source map当前匹配；生产Web页面来自本轮构建而非旧Vite。总核验记录 `branch-recovery-final-verification.json`。
- `branch-recovery-request-summary.json` / `branch-recovery-audit-final.json` 确认两端均实际收到fail/503、empty/200和normal/200。最终audit中Native分别1/1/2次、Web分别11/4/2次；Web包含原有Query失败重试/聚焦刷新及重测，不当作单击请求预算证据。此前audit另外保留，无拼接去重伪造。POST `/api/git/worktrees` **0次**，非校验写入均405，没有真实Git写入。
- 通过正常UI切回原连接并确认原ID仍在、已连接，只确认删除新增 `Branch Recovery Fixture`；Native回Projects、Web回原页面，41831合成Host及5182测试代理均已停止（`branch-recovery-cleanup.json`）。未重启真实Host或删除原连接。
- 首次加载unknown、light/高对比、IME/外接键盘、桌面各runtime、真机/Relay、真实Git创建删除/权限拒绝/未知POST/跨进程恢复未在本批完整App实测；原有引擎测试不替代这些证据。Chat实时追平、队列/Goal、连续三页阅读锚点也未因此通过。**73行仍全部未完成，0项全平台完整验收。** 下一轮优先对照修正P06完整布局/字体/底部动作，再继续其余Projects与Session缺口。

### 批次 J / P06 表单布局、语义字体与固定动作

#### 改动合同与最终产物

- `ProjectDetail.creationForm` 改为字段 Scroll 与独立、不收缩的 footer；取消在左、创建在右、等宽横排。字段组间距、36pt 控制、padding 使用 `worktreeFormLayout` 的有限映射，标签/按钮、输入、辅助文字复用 canonical uiLabel/markdown/micro；输入用 surface.elevated、动作用 surface.muted，按钮500字重。源分支外部刷新行移除，picker 内刷新/重试保留；现有分支外部刷新保留。未改变草稿、预校验、pending/关闭保护或创建 owner。
- 首页新工作树初始72%窗口高度、可展开98%，`NativeSheet.viewportDetents` 为 opt-in；其它消费者默认仍按可用高度比例。UIKit继续拥有系统pageSheet、grabber、键盘避让与真实关闭completion，无自绘backdrop、无额外滚动offset补偿。合同见 `DOCUMENTATION.md`，本批不签收其它Sheet消费者或非iOS运行时。
- 最终 `worktree-layout-delivery-build.log` 构建成功，Swift快照48文件构建期间未变；已安装并启动这份完整 `YuriNative.app`。5个目标TSX/TS与包内source map匹配，SheetPresentation.swift当前hash与编译快照一致（`worktree-layout-delivery-artifact-audit.json`）。较早的 `*-final-*` 截图属于上一包，不作为最终delivery实测证据。
- Context7额度耗尽，本轮以本地类型、实现与完整App核对；不声称在线文档验证通过。

#### 同 Host / 同主题 / 同稿与交互复验

- 匿名隔离HTTP Host与生产Web dist沿用批次I夹具，只读合成项目，不触达真实Git/模型/语音。测试连接为本轮新增 `Worktree Layout Fixture`。先前Web实际为Cursor，Native为JetBrains，已通过Web正常“设置→外观”选择JetBrains后重拍；两端最终主题为JetBrains dark，Host字号/padding均100。Web确认background `#1E1F22`，402×874、DPR3、5触点、mobile-pointer；仅“都是暗色”不算同主题证据。
- 最终新分支两端均 `happy-iguana` / `happy-iguana`、源 `main`；现有分支均 `remotes/origin/release` / `origin-release`。Native完整选择值由最终截图目视确认，目录值由AX确认。Web另补未聚焦输入截图，避免把焦点ring混入静态布局对比。

| 最终delivery逐状态 | 完整UIKit App | 同Host Web生产页面 |
| --- | --- | --- |
| 竖屏新分支 | 取消左/创建右、等宽；动作y819.91pt | 相同排列/等宽；动作y818px |
| 切现有分支并选远端 | 保留完整值与目录；两动作y819.91pt不变 | 完整值/目录一致；两动作y818px不变 |
| 切回新分支 | 独立新分支稿仍为happy-iguana | 独立新分支稿一致 |
| 横屏874×402实际触摸滚动字段 | 源提示移动186.33pt且可见于footer上方，创建y354pt不变 | CDP touch scroll移动200.5px，创建y346px不变 |
| 取消/返回 | 取消返回Projects，未执行创建 | 取消关闭表单，未执行创建 |

- 逐状态JSON为 `.scratch/nsh/worktree-layout-delivery-{native,web}-{new,existing,scroll}.json`。最终截图在系统临时目录，文件名同前缀；新分支Web静态比较用 `worktree-layout-delivery-web-new-unfocused.png`。七张最终截图均已目视读取。Web触摸模拟下mouse wheel未推动字段，改用真实CDP触摸手势，不直接设置scrollTop；Native横屏raw helper按物理portrait坐标转换，不将错误坐标的初次失败记成产品滚动失败。
- 早一包的error→normal固定footer证据仍保留在 `worktree-layout-native-error.json`：旋转/滚动后系统已展开，两状态y826pt不变，不能与旋转前折叠y819.91pt混比；它不冒充最终包的错误态复验，也不重复批次I全套读取恢复。

#### 回归、安全与剩余缺口

- 最终定向 **7文件101 passed**：presentation、home-sheet、worktree-native、native-select-contract、native-density、sheet-presentation、projects（`worktree-layout-delivery-tests.log`）。包含footer不在Scroll中、取消先于创建、50/100/200密度及初始detent合同；`worktree-layout-delivery-check.log` 检查通过，完整iOS模拟器构建通过。较早check曾被并行resource-navigation的retirementOwner类型错误阻塞，未修改该owner；最终check已通过。不宣称全仓/真机/非iOS验收。
- `worktree-layout-delivery-dead-code.log` 已检查：131 unused files / 797 unused exports；未据此清理其它owner或动态fixture。最终audit创建POST **0次**，189次其它非校验写请求全部405，只有合成validate允许；无真实Git写入、无付费调用。新fixture曾返回错误的分页形状导致Invalid session page，已修正夹具，非产品修复；最终截图无该伪错误。
- 原Native连接通过正常UI恢复并确认原ID仍在且已连接，只确认删除本轮Layout连接；恢复竖屏Projects。Web原5178页面一度超时，重试后已恢复并确认项目菜单存在、无fixture及弹层；未重启原服务。41831与5182已停止，见 `worktree-layout-cleanup.json`。最终汇总 `worktree-layout-final-verification.json`。
- **仍未完成**：系统Sheet左右边距/整体缩放、标题及字段纵向位置、横屏宽度（Native与Web最大宽度不同）、输入边框/焦点和完整字体像素级对齐；软件键盘伸缩、IME/外接键盘、light/高对比、其它P06入口与所有异常状态的最终包视觉。横屏短视口滚动不能替代键盘证据。GitHub起步、真实创建删除/权限/未知POST/跨进程恢复、真机/Relay，以及Session实时追平、队列/Goal、连续三页保位仍保留。**73行全部未完成，0项全平台完整验收。** 下一步先补P06软件键盘/IME与剩余Sheet几何的同状态证据，再继续其余Projects/Session矩阵，不把本批局部关闭升级为整体完成。

### 批次 K / P06 真实软件键盘、拼音与焦点边界

#### 复现与修复

- 使用同一402×874竖屏iOS模拟器的完整UIKit App和真实Safari页面，不用桌面触摸模拟/缩视口代替软件键盘。两端通过正常入口访问匿名隔离Host，JetBrains dark、字号/padding 100、源main；基础稿同为 `keyboard-verify`。Safari通过正常外观设置选中JetBrains。请求不转发真实Git、模型或语音。
- 修复前完整Native创建按钮底部862pt、首排按键590pt，`worktree-keyboard-ui.py assert-footer` 实际退出1；截图 `worktree-keyboard-native-keyboard-open.png` 确认遮挡。Safari同样被真实键盘遮挡，证据 `worktree-keyboard-safari-software-keyboard.{json,png}`。软件键盘通过现有serve-sim协议切换，未改系统defaults。
- Native只在iOS `NativeSheet` 的Dialog根消费一次 `env(keyboard-inset-height)`，保留系统pageSheet/关闭completion及pending保护，不订阅全局keyboardFrame、不补滚动offset。Web仅栈顶browser Motion浮层以 `visualViewport.offsetTop/height` 限定门户边界，`useEventListener`管理监听；Capacitor继续独占原native inset CSS，不双重避让。工作树表单移除装饰性scroll fade，避免键盘约束下文字/光标被渐隐。未改变草稿、提交owner或新增依赖。
- 红灯回归分别为viewport **1 failed/11 passed**、Native结构合同 **1 failed/3 passed**、表单渐隐 **1 failed/4 passed**，日志 `worktree-keyboard-{web-red,native-red,field-fade-red}-tests.log`。Context7返回Monthly quota reached，未声称在线文档通过。

#### 最终包与生产页面逐状态证据

| 状态 | 完整UIKit App | 真实iOS Safari生产页面 |
| --- | --- | --- |
| 键盘展开、固定动作 | 创建底部526pt，在538pt候选栏上方；遮挡断言通过 | 创建底部418pt，在Safari地址/输入附件栏及候选栏上方 |
| 分支真实拼音 | 实际触摸n、i，出现“你”候选并点选提交 | 同样真实按键与候选提交，不直接注入Unicode |
| 分支提交后目录 | 分支keyboard-verify你；目录按共享slug回keyboard-verify | 同行为，不把拼音marked阶段临时ni当最终提交 |
| 再独立编辑目录拼音 | 两字段均keyboard-verify你 | 最终生产构建两字段均keyboard-verify你 |
| 软键盘隐藏/显示保稿 | 三次完整循环，创建底部854.48→526pt | 初版修复三次循环；最终去渐隐构建另一次完整循环656→418pt |
| 实际blur | Return收起键盘，两稿保留，创建底部854.48pt | “完成”收起键盘，两稿保留，创建底部756pt |
| 焦点边缘与触摸滚动 | 已目视输入/候选截图；不因此签收全部几何 | 自动聚焦仍有轻微底边裁切；实际触摸滚动64pt，目录y332→268后完整可见，键盘保持 |

- 局部JSON均位于 `.scratch/nsh/`：`worktree-keyboard-native-{ime-marked-summary,ime-commit-summary,folder-ime-summary,cycles,return-observation}.json`、`worktree-keyboard-final-safari-{ime-summary,cycle,focus-scroll,blur-summary}.json`。最终Safari截图为 `worktree-keyboard-final-safari-{folder-ime,focus-scroll,done-closed}-green.png`；Native为 `worktree-keyboard-native-{keyboard,ime-marked,folder-ime,return-closed}-green.png`，保存在系统临时目录并核对hash。最终focus-scroll及done截图已目视读取。
- Safari浏览器chrome/输入附件栏真实占用高度，与Native系统Sheet不同；不能把418pt与526pt或blur后的756pt与854.48pt直接判成同可用高度的布局偏差。软件toggle隐藏仍可保留焦点及附件栏，不能冒充真正blur。Native“现有分支”点击尝试未成功切换，不能计作键盘模式切换通过。

#### 回归、产物边界与安全清理

- 最终Web **8文件67 passed**（`worktree-keyboard-final-web-tests.log`），Native **7文件102 passed**（`worktree-keyboard-final-native-tests.log`）。viewport回归含50次事件不重渲染输入子树、保焦点/稿及Capacitor单writer；表单原校验预算/迟到拒绝/失败保稿回归保留。UI类型检查、NSH检查、完整模拟器构建及最终Web生产构建通过，日志同 `worktree-keyboard-*` 前缀；构建原有警告不等于无警告。dead-code为132 unused files/797 unused exports，未清无关代码。
- 完整K包已安装实测，6个目标TS/TSX与包内source map一致；48个Swift源在构建期间均未变化，当前SheetPresentation.swift仍与快照一致。收尾时发现无关 `ResourceHTMLComponents.swift` 在构建后已变化（47/48当前hash匹配），未覆盖或重建其工作，不宣称本包包含该后续修改。最终dist的38个入口JS/CSS与服务返回hash一致且有Web请求audit；结合本轮Safari刷新记录确认交付边界，未获取Safari远程调试resource hash。见 `worktree-keyboard-artifact-audit.json`。
- 最终audit创建POST **0次**；151次其它非validate写请求均405，仅合成validate允许。已恢复English (US)键盘（globe下一项简体拼音）；Safari取消表单并只关闭本轮fixture标签，最终0张标签卡；原桌面Web未操作。Native原连接已通过正常UI恢复并确认保留，只删除本轮Keyboard连接，回到竖屏Projects；41831隔离服务已停止。见 `worktree-keyboard-audit-final.json`、`worktree-keyboard-cleanup.json`。
- **新增未关闭缺口**：收键盘并切回Native后，按AX坐标点击取消及右上关闭未关闭表单；系统grabber下拉可以关闭并返回Projects。已保存 `worktree-keyboard-native-cleanup-form.png`，未将点击尝试当通过，也不凭此认定一定是业务handler故障（命中区/焦点/生命周期仍待定位）。下一批优先建立该路径的稳定复现与回归，再继续Sheet几何/焦点边缘。
- **验收仍未完成**：自动焦点完整露出、系统Sheet边距/缩放/标题/横屏宽度/字体像素差、所有入口及异常状态、其它Sheet消费者、拼音取消/全部语言与外接/横屏/浮动键盘、pinch zoom、PWA/Capacitor真机、真实创建删除/权限/未知POST/跨进程恢复、GitHub起步、真机/Relay；Session实时追平、队列/Goal、连续三页保位未因此通过。**73行全部未完成，0项全平台完整验收。** 总核验文件为 `worktree-keyboard-final-verification.json`，本批只关闭已实测的键盘footer遮挡、拼音提交/保稿及装饰渐隐局部缺口。

### 批次 L / P06 收键盘、切回 App 后取消与关闭

#### 稳定复现与定位

- 沿用匿名只读合成Host、同一402×874模拟器。本轮新增连接 `Worktree Dismiss Fixture`；真实Host不写入，不调用模型或语音。原完整K包上运行 `python3 .scratch/nsh/worktree-dismiss-ui.py repro cancel`：实际软键盘→Return收起→启动Safari→返回Native→按AX中心点点击取消，**退出1且表单仍在**。随后右上关闭也失败；两按钮AX enabled=true，稿不变。
- 最小化对照：新表单直接取消成功；只打开/Return收起软键盘、不切App，取消成功；**从未开键盘，只切App再返回，取消仍失败**。因此不是IME特有故障。状态保存在 `worktree-dismiss-red-states.json`，命令脚本等待实际前台App与目标几何稳定，不把初次前台切换未settle或菜单早点击当产品故障。
- LLDB只读检查取消坐标的UIKit hitTest路径，命中 `projects-worktree-cancel`，不存在遮挡命中别的视图；结果 `worktree-dismiss-lldb-hit-red.log`。检查后已detach；未改原生对象、未添加生产debug日志。此前K批的“命中区/焦点/生命周期未知”在本批定位为操作代际门禁。
- `runtimeLifecycle` 挂起调用 `retireRuntimeAuthority('suspend')` 递增epoch；同Host恢复有意保留connection身份。`ProjectsHomeSheet` 捕获打开时epoch，旧 `close()` 要求 `current()` 才关闭，恢复后该条件永久false；epoch本身不是响应式signal，原effect也不能仅靠epoch变动保证关闭。实际触摸到达仍被本地close的Host门禁挡掉，不是pageSheet原生关闭completion卡住。

#### 最小修复与回归

- 只修改 `projects-home-sheet.tsx` 的 `close()`：本地关闭只要求仍open；接纳 `afterClose` 时仍要求current，执行completion后的continuation再次要求current。原dirty/pending guard、真实UIKit关闭completion、替换/导航/创建的Host权限不放宽；不修改state epoch、不为同Host恢复复活旧操作，不新增监听或缓存。
- `projects-home-sheet.test.ts` 执行生产函数边界，新增退役epoch后header/取消均关闭、旧完成回调不能接纳新导航continuation三项。先跑 **3 failed/6 passed**（`worktree-dismiss-red-tests.log`）；修复后相关 **7文件105 passed**（`worktree-dismiss-tests.log`）。dirty/busy back guard和旧Host/hidden continuation拒绝回归保留。本测试模拟presentation completion，不冒充UIKit证据。
- `worktree-dismiss-check.log` 的NSH检查通过，`worktree-dismiss-build.log` 完整模拟器构建通过。完整新包已安装：6个目标TS/TSX与source map匹配，48个Swift构建期间无变化且收尾hash均匹配，已安装的可执行文件、bytecode及source map与交付包逐字节一致，见 `worktree-dismiss-artifact-audit.json`。本轮Web源码未改，使用批次K已有生产dist，不伪称新Web构建或重复Web测试。

#### 同 Host / 同主题 / 同稿逐状态复验

- 完整UIKit与真实iOS Safari都经正常UI打开同合成项目/源main，JetBrains dark、字号/padding 100；Safari正常“外观”确认JetBrains，`worktree-dismiss-web-theme.json`。每次两字段稿均为 `dismiss-verify`，ASCII由真实HID选中/输入，不注入业务状态。每次关闭前AX确认稿保留，关闭后确认字段/创建动作消失；反复从项目菜单重开新表单，重新填同稿。

| 实际动作 | 完整UIKit最终包 | 同Host真实Safari |
| --- | --- | --- |
| 软键盘→Return/完成收起→切App返回→取消 | 2次通过，回Projects | 2次通过，回Projects |
| 同路径→右上关闭 | 2次通过，回Projects | 2次通过，回Projects |
| 不开键盘，仅切App返回→取消/关闭 | 各1次通过 | 各1次通过 |
| 仅软键盘收起，不切App→取消/关闭 | 各1次通过 | 各1次通过 |

- 两端各 **8次**，共16次；逐次结果为 `.scratch/nsh/worktree-dismiss-{native,web}-results.jsonl`，复验日志同前缀。Safari的App切换为Safari→Native→Safari，Native为Native→Safari→Native；均确认实际前台App，不用DOM visibility模拟。每端取消/关闭的最终before/after四张截图已目视读取，共8张；文件名 `worktree-dismiss-{native,safari}-{cancel,close}-{before,after}.png`，临时目录截图hash纳入最终核验。

#### 安全、清理与剩余范围

- `worktree-dismiss-audit-final.json`：创建POST **0次**，100次其它非validate写请求全部405，只有合成validate允许；无真实Git、模型/语音请求。38个Web入口JS/CSS与服务返回hash一致且有本轮Web读取audit；未获取Safari远程调试resource hash。
- 本轮Safari表单均已关闭，只关闭本轮fixture标签（最终0张标签卡），原桌面Ego Web未操作；键盘设置未改。正常连接UI恢复原Native连接并确认保留，只删除本轮Dismiss连接，恢复竖屏Projects；41831隔离服务停止。LLDB已detach且未加入生产debug埋点。见 `worktree-dismiss-cleanup.json`、总核验 `worktree-dismiss-final-verification.json`。
- **局部关闭**：批次K新增的“收键盘/切回App后取消和关闭不生效”已修复并复验。预防原则是本地清理不依赖已退役的网络操作授权；后续导航/写入继续使用原权限门禁，不需要扩大架构或新增状态源。
- **仍未完成**：Safari自动焦点底边裁切、系统Sheet边距/缩放/标题/横屏宽度/字体差、其它P06入口及错误态、后台挂起时实际pending/dirty写入与未知结果恢复、恢复后继续使用旧表单的其它操作、所有IME组合/真机/Relay及真实Git创建删除。Session实时追平、队列/Goal、连续三页保位没有本批证据。**73行全部未完成，0项全平台完整验收。** 下一步补P06自动焦点完整露出与剩余Sheet几何，随后继续Projects/Session未完成矩阵；本批16次关闭验证不升级任何整行为全平台通过。

### 批次 M / P06 聚焦字段完整露出

#### 红灯、实验与局部合同

- 同一402×874模拟器、匿名隔离Host、JetBrains dark、字号/padding 100、源main、两字段 `focus-verify`；真实Safari与完整UIKit对照，不以桌面缩视口代替键盘。Safari实际拼音软键盘下先聚焦分支、再点目录，连续两次重开复现：输入框top270/bottom306px，实际字段scroller bottom303px，**下沿裁切3px、bottomHit=false**。`worktree-focus-ui.py repro …` 退出1，红灯截图已目视；只读观察器不改焦点、布局、输入值或滚动。
- 隔离页分别启用 `focusExperiment=margin` 的input scroll-margin-block:12px、`padding` 的scroller scroll-padding-block:12px，均仍裁切3px，不将无效CSS作为修复。最终验证URL去掉这两个实验参数。Context7仍为Monthly quota reached，不声称在线文档核验通过。
- 仅新增工作树表单私有 `MobileWorktreeFields`，保留原ScrollableOverlay、原生输入及草稿/提交owner。open且stack-top时，focusCapture、ResizeObserver及visualViewport resize/scroll合并到一帧；只读当前input与该scroller两份边界，超出上下8px留白才调用原生 `scrollIntoView({ block:'nearest', inline:'nearest', behavior:'instant' })`，input用scroll-my-2。未写scrollTop、未重聚焦、未订阅input或手动scroller scroll，关闭/覆盖/卸载取消待执行帧。只保证当前聚焦框露出，不要求所有未聚焦字段同时装进视口，不扩展全局Motion或其它Sheet消费者。

#### 最终生产构建逐状态复验

| 状态 | 真实Safari最终生产dist | 完整UIKit L包对照 |
| --- | --- | --- |
| 拼音键盘展开、点分支/目录 | 目录bottom295px，scroller bottom303px，原生scrollTop11px；上下边缘命中均true | 分支/目录实点后框完整，header底130pt、footer顶490pt；目录y319/h36pt |
| 两字段反复切换 | 4次切换及最终再聚焦目录，聚焦框全部几何断言通过；两稿不变 | 初始两字段及切回分支/再次目录，稿不变；截图见光标及完整框 |
| 软键盘隐藏/重开 | 2轮、4个状态均完整露出且保稿；系统重开有时选回分支，以实际focused index记录，不声称保持同一字段 | 2轮、4个状态保稿，重开后重新点目录在header/footer内 |
| 真正blur | 完成收起后保留两稿，无键盘截图 | Return收起后保稿 |
| 无观察器普通生产页 | `/mobile.html`，无query注入；分支/目录反复实点4状态、另1轮键盘隐藏/重开，AX及截图复验聚焦框完整 | 使用同一Host/主题/稿；本批未修改或重建Native |

- 带只读probe的最终状态文件为 `.scratch/nsh/worktree-focus-safari-*-green.json`，字段边界、实际clip、topHit/bottomHit、焦点index及稿分别记录。1.2秒idle窗口无新增几何事件、scrollTop11px不变（`worktree-focus-safari-idle.json`）；不把该短窗口冒充性能压测或全平台不抖证明。Safari视觉视口offset会随系统焦点平移，不将其变化误记为字段scroller反复回拉。
- 无probe文件 `worktree-focus-safari-plain-*.json/png`；普通HTML逐字节等于dist，不含观察器/实验。AX只证明frame与footer关系，完整框由截图目视确认，不冒充DOM裁切测量。分支聚焦时未聚焦目录仍可能部分裁切，这是字段滚动而非整表单fit合同；目录聚焦后完整露出。重开截图中的系统编辑菜单未改变稿，不当成新产品浮层。
- Native证据 `worktree-focus-native-{branch,folder,branch-return,folder-reopened}.json/png`、`native-cycles.json`及`native-blur.json`。AX不暴露原生focus flag或嵌套scroll clip，因此仅报告实际点选、header/footer边界和已目视截图，不声称拥有原生DOM级几何证据。原生系统pageSheet/关闭completion、阅读锚点、分页和正文补全优化均未改。

#### 回归、产物与安全清理

- 新回归先 **1 failed/5 passed**（`worktree-focus-red-tests.log`），最终相关 **8文件69 passed**（`worktree-focus-tests.log`）。覆盖聚焦裁切后原生露出、50个viewport事件最多1待处理帧、已可见不滚动、容器resize、手动滚动/input不触发、blur后不露出、关闭取消帧及covered不工作，原校验请求预算/迟到拒绝保留。UI类型检查和Web生产构建通过；dead-code132 unused files/797 unused exports，未清无关代码。本批未重跑Native测试/构建，105项通过是批次L历史，不混写成本批结果。
- `worktree-focus-artifact-audit.json`：最终mobile入口 `/assets/mobile-BJQB96ND.js` 在带probe和普通页各有一次读取；38个入口JS/CSS服务返回hash与dist一致，36个未改公共资源可能沿用Safari缓存，**不声称浏览器全部重新请求**；读取证据截在审计脚本自身GET之前，未捕获Safari远程调试resource hash。已安装Native executable/bytecode/source map与L交付包逐字节一致，48个Swift当前hash与L构建快照一致。
- 收尾发现当前 `projects.tsx`、`projects-presentation.ts` 已有L包之后的inputHitSlop改动；本批未覆盖或重建这些变动，故UIKit证据明确属于已安装L包，不宣称当前所有Native源都已编译验收；其它4个目标source map仍匹配。
- 隔离Host重启前后两段审计均保留：创建POST **0次**；其它非validate写请求前段27次、后段134次、共 **161次全部405**。仅合成validate允许，无Git/模型/语音转发。恢复English (US)，正常UI恢复并保留原Native连接，仅删除本轮Focus连接；Safari取消表单并只关闭本轮唯一fixture标签，最终0张标签卡；回竖屏Projects，41831服务已停止，原桌面Web未操作。见 `worktree-focus-cleanup.json`、`worktree-focus-final-verification.json`。
- **局部关闭**：本批关闭已复现的“新分支模式、当前聚焦框的Safari下沿3px裁切”；不签收系统Sheet边距/缩放/标题/横屏宽度/字体像素差、现有分支及其它入口/错误态、首次unknown/pending/dirty/未知写入恢复、全部IME取消/组合、外接/浮动键盘、PWA/Capacitor真机/Relay或真实Git。Session实时追平、队列/Goal、连续三页阅读保位仍无本批完整证据。**73行全部未完成，0项全平台完整验收。** 下一步针对剩余Sheet几何与未验入口继续同状态对照，再推进Projects/Session矩阵，不用本次局部露出验证替代全量验收。

### 批次 N / 当前 hitSlop 构建、触摸与 Sheet 几何（交付因并行源码冲突暂停）

#### 已运行的完整包与触摸红绿灯

- 先构建并安装含原有 `Input hitSlop={formLayout().inputHitSlop}` 的当前完整UIKit包；原7文件105测试及检查、完整构建通过。真实402×874模拟器、匿名隔离Host、JetBrains dark、字号/padding100、main、两字段 `geometry-verify`。不改真实项目、不调用Git/模型/语音。
- `python3 .scratch/nsh/worktree-geometry-touch.py 1 -2 native-folder-top-red <pid>` 实点目录框top外2pt，随后LLDB只读确认 firstResponder 仍属分支，**退出1**；展开系统Sheet重测仍失败。命中路径显示Input由普通UIView包装，父组在该点范围内但hit落入普通背景；中心点可用。不能用36+4+4=44的数值测试证明UIKit的实际44pt命中。
- 候选修复将边缘命中放到原有字段组View，通过受 `!worktreeEditingDisabled()` 保护的InputRef.focus转交；原Input保持原生可编辑，不改36pt可见高度、间距、草稿、提交owner或系统Sheet。候选的生产接线回归先 **1 failed/10 passed**，相关 **7文件106 passed**，NSH检查及完整模拟器构建通过（`worktree-geometry-{touch-red-tests,final-tests,final-check,final-build}.log`）。dead-code132 unused files/795 unused exports，未清无关代码。该结构测试不替代下面的UIKit证据。
- 安装候选完整包后，紧凑/展开两态、分支/目录上下边缘各实点一次，**8次通过**，每次由不同字段的firstResponder转移验证；现有分支模式另一次目录top外2pt在已验证blur后通过，共 **9次边缘聚焦**。结果 `worktree-geometry-*-touch.json`。Input框内左右实点，原生selectedTextRange分别[0,0]、[15,15]，证明内部光标定位仍由输入控件所有（`native-caret.json`）；不是只看hitTest返回UITextField。调试器检查后detach，无生产埋点。
- Context7本轮已恢复可用，读取 `/longbridge/nsh` 的hitSlop/原生输入focus文档，明确hitSlop不改布局、受父命中边界约束；当前发布文档不能替代已安装NSH0.4实际UIKit差异。未修改独立NSH/OpenCode仓库或新增依赖。

#### 同状态几何与功能证据（不等于像素级签收）

- 真实Safari使用批次M未改生产dist及仅隔离页开启的只读geometryProbe，正常项目菜单打开；候选UIKit同Host/主题/稿。两端完成紧凑、实际handle拖至展开、真实English软键盘、新/现有模式选择main、现有模式目录独立填稿、切回新模式恢复两稿。Safari另有4次框内上/下边缘实际点击及新DOM focus receipt；不将Web36px内的点击等同于Native框外扩展命中。
- `worktree-geometry-comparison.json` 将screen AX、UIKit window与CSS document坐标分开，不能直接相减。归一到Sheet局部后，两端分支输入top **168**、两字段top距离 **102**、输入font size **15**一致；Native紧凑系统scale约 **0.960199**，pageSheet window box为x8/y229.068/w386/h636.932。展开Native为x0/y62/w402/h812；Safari展开surface在CSS document y14.28125，仍有浏览器安全区/工具栏，不能把该值当screen y14.28。
- **残差保留**：Native可见输入宽370pt、Web368px（16与17的局部inline inset），紧凑系统缩放、最大detent、标题小数像素/边框及整体footer位置未像素级对齐。Keyboard状态Native会原生滚动内容（本轮可隐藏模式/分支picker），不将不同scroll offset的截图当同一未滚动布局。保留系统pageSheet/材质/关闭completion，不加backdrop、transform重置或scroll-offset补偿来伪造对齐。
- 隔离观察器初版没有观察style/class变化，曾给展开态返回过时样本；已补只读属性观察，capture新增AX与DOM输入坐标一致性门，再重录最终compact/expanded文件。最终参与比较的展开surface为y14.28125，而不是旧compact y199.921875。最终8张两端紧凑/展开/新模式键盘/现有模式键盘截图已目视。证据均在 `.scratch/nsh/worktree-geometry-*`，截图在系统临时目录。

#### 源码冲突、产物边界与安全清理

- **交付暂停**：产物核对时发现 `packages/nsh/projects.tsx` 在候选构建/实测后被其它改动替换：字段组hitSlop/onPress、两个InputRef被移除，hitSlop重新传给Input；`projects-presentation.test.ts` 同时改成禁止父组焦点转交的相反合同。当前该文件11项测试通过（`source-conflict-tests.log`），但它验证的是新合同，**不能把候选106通过与9次触摸结果记到当前源码上**。未重新覆盖未知工作；需要用户确认并行修改归属/实现方向后继续。
- `worktree-geometry-source-conflict.json` 保存候选source-map正文、当前源码及双方hash。已安装executable/bytecode/source map仍与本轮候选包逐字节一致；6个目标源中当前5个匹配、projects.tsx不匹配。48个Swift在候选构建期间未变；收尾当前只有42个hash仍匹配，后续变动涉及AppearanceBridge、AttachmentBridge、AttachmentUploadPolicy、ConnectionStore、RuntimeBridge、main，未覆盖或重建这些并行工作。38个Web服务资源hash与dist一致；没有新Web构建/测试，不声称Safari重新请求缓存资源。见 `worktree-geometry-artifact-audit.json`，`currentSourceDeliveryAccepted:false`。
- 三段隔离Host审计均保留：创建POST **0次**，其它非validate写分别31/77/40、共 **148次全部405**。仅合成validate允许，绝不转发到真实Host。原连接已用正常UI恢复并确认保留，仅删本轮Geometry连接；只关闭本轮唯一Safari标签，最终0张标签卡，英文键盘设置未改，回竖屏Projects，41831服务停止、调试器detach。清理切回Native时曾观察到空白新会话页，已Back且未输入或发送，原因未稳定定位，取消尝试不计通过；不凭自动化过渡现象声明新产品故障。见 `worktree-geometry-cleanup.json`。
- 最终核验 `worktree-geometry-final-verification.json` 明确是 **候选运行证据已保存、当前源码交付阻塞**，不是P06完成。系统几何/横屏/字体像素差、其它入口/错误态、pending/dirty实际写入恢复、全部IME/真机/Relay/真实Git，以及Session实时追平、队列/Goal和三页阅读保位继续保留。**73行全部未完成，0项全平台完整验收。** 下一步先确认同文件并行改动归属，再针对选定的当前实现重建、重跑同一物理触摸红绿灯，不能盲目覆盖或用相反的源码测试代替UIKit验收。

### 批次 O / 队列编辑丢响应恢复与三队列＋Goal组合（非 UIKit 验收）

- 已按用户引用只读核对 fork 会话：首页非对称留白、错误通知、直接 Input/SDK 命中、历史、Changes 与附件由对方继续处理。批次 N 的消费者/测试替换来源已明确，不再恢复父组转发、不将候选包触摸通过移植到当前源码；本批未占模拟器或覆盖上述实现。
- 红灯：服务端已删除 inbox 项但 DELETE 响应丢失，原 UI 重试再次 DELETE 后收到404，`queueEdit`持续阻塞发送。新增生产 state 回归实跑得到 `expected false to be true`。修复仅在 `state.ts` 的既有 `editInbox` 重试分支先执行原权威核对；已取消走 GET-only 完成，已消费不能重发，读取失败仍未知；确认仍 pending 时必须先 flush 持久记录才可重试 DELETE。未改持久格式、发送协议、输入布局或 Goal owner。
- 最终命令与逐项边界见 `tests/queue-goal-recovery-contract.md`。**6文件170 passed，零skip**：state、Goal state/model、queue/Goal恢复、queue UI、queue presentation。覆盖丢响应、消费/后续编辑、两类读取失败、仍pending、持久失败、旧lease及冷模块/Storage恢复，不把模块重建当作真实杀进程。
- 生产 App 在真实 NSH headless 引擎下挂三队列＋既有Goal：恢复原文本/附件，重试前后 `delete=1 prompt=0`，手动发送后 `delete=1 prompt=1` 且替代行仅一条。另一链完成Goal暂停/恢复/清除、steer一项、另一项删除失败后成功，保留无关稿和其它项；回执 `delete=0 remove=2 steer=1 prompt=0`。fixture严格核验原scope及wire，不执行真实网络/模型/语音/Git或用户目录写入。
- 生产 state 及其依赖的聚焦TypeScript检查通过；本次全包 `nsh:check` 失败在并行Changes的 `Clipboard.writeText` TS2339与回调参数TS7006，未覆盖对方代码以取绿。Context7查询再次返回Monthly quota reached，本批按当前仓库API/测试先例实施，不声称在线文档核验通过。
- `bun run dead-code` 已完成并检查：132 unused files、795 unused exports、613 unused exported types、12 namespace types与6组duplicate exports；新增恢复fixture未被报unused，未清理其它owner条目。矩阵脚本核对实际73行且全部为未完成，批次O仅一份。
- **仍未验**：完整当前UIKit新包、同Host/主题/尺寸的Safari对帧、真实inbox消费/重连、系统键盘/IME、steer回queue、拖排、实际进程重启、Relay/真机。消费后又编辑的稿仍需明确UI处置出口，本批只验证不会重复发送。**73行全部未完成，0项全平台完整验收**，不以170项测试替代完整UI/交互签收。

### 批次 P / 冻结完整 UIKit 与真实 Safari 的队列/Goal 实点

- 完整生产包 `2026-11-08T01-33-19-349Z-78eaed1d`：53个冻结Swift、正常RuntimeBridge/连接UI及全部App资源，无业务override，构建退出0；仅有FeedbackLayoutBridge既有MainActor警告。独立402×874模拟器，不占fork现场。实际安装可执行文件与bytecode SHA均匹配清单。
- 本轮先补齐fixture只读permission/voice、raw session、provider catalog `partial:false`、native-inbox-only Host的Yuri queue 501语义。原有404/无模型/冻结按钮图不作为正常基线。最终两端使用同Host/目录/队列ID/Goal/Fixture Model/暗色，以及同一合法 `file:///isolated/queue-goal/queued.txt` 引用，不以仅Native支持的 `attachment://` 合成URI卡住Web后判产品缺陷。
- 最终实点：UIKit编辑→DELETE已提交但503→显式重试仍 `editDelete=1,prompt=0`，文本/文件名保留→手动发送后 `editDelete=1,prompt=1`；Safari编辑503后保留稿→手动发送也仅一次DELETE/一次成功prompt。各有且仅有一个替代行，另两原队列与active Goal保留。Web `.txt` 由现有编译器转Host文件引用说明，Native传URI/name；已按两种真实表示核验，不能把Web无files字段误报丢附件，也不宣称真实消费等价。Web额外message-sent被fixture405拒绝，不是第二次prompt。
- 两端另分别实点Goal暂停/继续/移除、steer一项、删除另一项首次503/二次成功；审计 `goal=3,steer=1,removeDelete=2`，不改变无关队列。UIKit在最终入队后实际terminate/launch并从Projects重新进入，仍一次prompt、未重复DELETE。未测取消未知状态中途杀进程或已消费后重发。
- 证据/断言：`.scratch/nsh/queue-goal-platform-evidence/verification-summary.json`、`build-install-verification.json`，以及 `native-final-*` / `safari-final-*` / 两端Goal和remove分阶段AX/审计JSON；截图按capture basename保留OS临时证据目录。详见 `tests/queue-goal-recovery-contract.md` 后续节。HTTP权威纯内存、无上游/模型/用户项目写入；不是真实OpenCode runner消费证据。
- 差异/未签收：Safari工具栏使两端**同402×874屏幕、不等内容viewport**；Native有附件计数/文件名与未知恢复按钮，Safari捕获compact视图并非同表现；字号/动作位置/空态也未像素对齐。最终聚焦未证明软键盘出现，不算IME验收。Web dist未重建，仅记录HTML hash，不宣称与当前Web源码一致。
- 最新全包 `nsh:check` 再次退出0。队列/Goal/state/drafts哈希仍等于冻结输入；但FeedbackLayoutBridge/ResourceBridge/SheetPresentation、error-notice、Changes与transcript-tools已有并行漂移，本批不签收当前整包/当前Sheet。不得把局部队列源码一致扩展为当前所有页面通过。**73行仍全部未完成，0项全平台完整验收**；后续需新冻结包、等内容视口/键盘、真实runner恢复及其余Projects入口逐项补验。
- 清理已核实：仅本轮HTTP/3240 helper端口关闭，独立模拟器Shutdown但保留证据与数据；fork模拟器仍Booted且未控制。fixture Python语法/矩阵脚本通过，批次P仅一份；未重复运行170项headless测试，不把旧测试次数计入本轮新增平台证据。

### 批次 Q / 同源完整重建、独立 Web、真实软键盘与 Projects 编辑取消

- **冻结与构建**：同一快照 `queue-platforms-6g6hsuum`，6419个输入，manifest SHA `e0e1c4b2a1b67e7a9e13ba3a4b7a44c0eb16a7d4220742e6375b633b903174dd`；快照内漂移0。既有依赖本地克隆，无安装/新依赖。补齐原有PostCSS/electron tsconfig及NSH生成配置后，UIKit完整生产包 `2026-11-08T02-24-31-769Z-ec7076cf` 和Web生产构建均退出0；53 Swift、无业务override，安装exe/bytecode哈希均匹配。最终CSS为457818字节并包含flex/px-5/gap-2；早期缺PostCSS的239977字节产物明确排除。快照 `nsh:check` 通过。没有以修改业务源码绕过构建。
- **视口不是猜测**：正常Safari共享→添加主屏幕→网页App。`mobile.html`安装后进入session会出现浏览器外框，排除该组；从根地址安装后，session的 `standalone=true`、scale=1、root/visualViewport均402×812，无浏览器工具栏。只读LLDB实测UIKit窗口/root402×874，安全区top62/bottom34；扣顶部后的同坐标画布402×812，完全安全区402×778。比较时明确底部34pt仍要单独核对，**不能把同画布升级为安全区/全部内容等价**；未加CSS/transform/offset伪造一致。
- **同权威静态对照**：`q-native-goal-resumed`与`q-web-ready-baseline`的完整items数组及Goal对象相等，Web加载字节与最终产物哈希相等。Native首行y582/文本高20，Web首行y630/文本高15，仍差48pt；输入区/底部避让、附件计数/文件名、空态、Goal面板高度/材质也不相同。Web Goal面板截图有关闭X，但本轮AX未提供对应关闭按钮，实际按截图X关闭，不能当作无障碍通过。
- **恢复与键盘**：两端各自从初始三项＋active Goal执行编辑，DELETE已提交但返回503，各仅一次DELETE、一次成功prompt，另两项保留。Native显式重试后附件名/文本保留，软键盘中发送成功；Web先保留稿，收键盘后发送成功（额外message-sent 405仍是fixture缺路由）。两端真实键盘按n→点中文候选你→删除还原，组合/提交中文时prompt均为0，不用粘贴/硬件焦点代替IME。Goal暂停/继续均有实际触摸与权威状态。
- **键盘差异要按阶段判断**：恢复稿首次聚焦时，Web发送AX框 `(351,487,32,32)` 与系统“完成” `(341,486,40,38)` 重叠，顶栏滚出；Native发送区与标题仍可见并成功发送。补齐只读 `/api/info` 后，Web初始化错误消失；在ready空稿实际拼音提交一个你后，输入区进一步上移，发送区不再和辅助条重叠。因此记录为**恢复/焦点阶段的候选差异**，不是持续遮挡定论；需连续录屏/重新聚焦复现，不能因后续帧正常就抹掉前帧，也不能把早期fixture初始化错误算产品缺陷。探针字已删除，未额外发送。
- **推进Projects**：重新打开两端项目菜单，共享五项顺序为新建会话→新建工作树→同步会话→编辑→关闭项目；Native额外工作树/文件/更改入口保留。Native进入编辑→选rocket图标（仅草稿）→关闭显示未保存确认→取消保留编辑页→再次关闭/放弃返回。未保存、未发项目写请求。Web对应dirty/busy、Native长表滚动/保存/输入AX及所有二级入口仍未验，P05/P11不签收。
- **证据与断言**：`.scratch/nsh/queue-goal-platform-evidence/q-*.json`；`q-build-install.json`、`q-native-viewport.json`、`q-verification-summary.json`及对应截图。`python3 .scratch/nsh/verify-frozen-queue.py`核验来源/安装/服务字节、同权威数组、IME、次数、菜单、dirty取消及73行未完成。41张本轮截图已复制到该目录的`q-screenshots/`，`q-image-index.json`记录哈希；不会将Native capture里附带的后台Web observer误当Native视口。
- **边界与下一项**：HTTP Host仍纯隔离内存，无真实runner、无消费证明、无模型/语音付费调用、无用户项目/Git操作。Goal移除/steer/删除失败重试沿用P轮，不伪装Q轮重新覆盖；Q只补上述动作。实时源仍有并行实现漂移及本轮验收文档变更，完整清单/数量动态保留报告，Q仅签上述冻结包的局部证据。接下来先闭合P05/P11的Web编辑dirty对照、两端长表/保存失败，再推进其余矩阵；F04/F05继续追踪动态视口与IME完整分支。**73行仍全部未完成，0项全平台完整验收。**
- **收尾**：`q-cleanup.json`确认41839/3240均关闭，仅独立模拟器Shutdown，fork模拟器仍Booted且未控制。保留快照、截图、审计、独立模拟器和两个测试网页图标，不删除用户现场。背景Web自动settings/auth/push/index请求未实现者由fixture拒绝；编辑dirty区间另断言Native无任何非GET请求，不能把整个Host描述成完全无后台写入尝试。
