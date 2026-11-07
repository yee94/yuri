# Chat 还原证据与差异

日期：2026-11-07。目标是还原当前 Web 手机 Chat，不重新设计。下列 C/F/H/S/D 分别指生产接线、fixture 回归、真实 Host、模拟器、真机；一种证据不能替代另一种。

## 基准与环境

逐帧状态矩阵见 [CHAT-FRAMES.md](./CHAT-FRAMES.md)。旧窄屏但无 Touch 的截图曾落在 `device-desktop` 分支，已降级为历史参考；当前精确基准须确认 `device-mobile mobile-pointer`。

- 同一已存在的 marker 会话：`ses_e4e4289d0ffeX7PWbCuieTEJHr`，一问一答，模型 GPT-6.1 Sol / High / Build。本轮只重开与读取，不再次调用付费模型。
- Web：当前对照 app 内容区 402×778 CSS px，DPR 3、5 touch points；截图时重新设置 metrics 与 touch，确认根 class。Native 原图保留，归一副本只排除系统 status 62pt/home safe area 34pt。实际主题 JetBrains 深色，不以 localStorage 中过时的主题 ID 推断颜色。
- UIKit：iPhone 17 Pro，iOS 26.5，402×874 pt；NSH 0.4.0，纯原生主界面。
- 精确静态基准位于 `.scratch/nsh/chat-frames/`：`F01-web-final-dark.png`、`F01-web-final-geometry.json`、F03/F06/F08/F09/F15/F16 对照帧。旧 `.scratch/nsh/web-chat-*` 保留历史用途，不作当前手机尺寸基准。

## 已核对的合同

| 区域 | 已有证据 | 尚不能据此声称 |
| --- | --- | --- |
| 消息身份 | C/F；S 确认普通 Chat 无额外 Yuri 头像/署名，历史模型 header 已显示 | 全部历史行/虚拟化复用正确 |
| 顶栏 | C/F；自定义返回、标题、上下文与 workspace 入口 | UIKit 自动材质、标题截断与位置已全部还原 |
| Composer | C/F；S 确认附件/麦克风、独立 Agent/模型、发送及 Liquid Glass | 字体、IME、软键盘、安全区与 Web 等同 |
| 模型选择 | C/F；S 打开真实目录 Sheet，关闭不修改选择 | variant/收藏等真实配置 mutation 已验收 |
| 引用 | C/F；H/S 查询真实 Host 文件，不发送；生产 App 回归验证文件 sidecar 进入 prompt | 五域 UIKit 视觉、撤销/重开均已验收 |
| 队列/草稿 | C/F 覆盖编辑、steer、移除、未知结果、持久恢复与重试 | 真实 Host 故障/杀进程已逐项实测 |
| 工具/消息操作 | C/F 有紧凑行、详情、回退/redo/fork | 真实历史有损操作已执行 |

## 2026-11-07 集成检查

### 系统 Sheet 与滚动缩小/恢复

- iOS 直接半浮层已统一为系统 pageSheet：UIKit 所有 detents/grabber/拖关闭/滚动交接及 pending guard，真实 completion/generation owner 串行处理关闭中重开。新会话不再使用透明 fullScreen Dialog 外套窗口内 Sheet；下面 20:33 的手绘两档手势与旧双层承载仅是历史证据，不能验证本轮实现。
- Header 与 Composer 共用 Web 的滚动意图/返回区/pin 规则，只改变显示层；唯一 Input 留在原 owner，compact 恢复同一草稿。Composer overlay + 倒序 List header 实测占位，缩小时不改变列表视口或写 offset。最新按钮已由错误的 `scrollToEnd` 改成反序第 0 行，并通过 AX 几何确认未被 expanded editor 遮挡。
- 隔离 UIKit 载体验证系统 controller、42%→72% 拖动、关闭保护/重开，Header 0/-86→1/0 和保稿编辑；系统 Select/日期显示与选择也有独立证据。不能据此宣称完整真实新会话业务、输入法或生产历史验收通过。定向测试/最终构建和未关闭项统一见 [SYSTEM-SHEETS-VALIDATION.md](./SYSTEM-SHEETS-VALIDATION.md)。

### 模型选择对齐修复（20:33 专项）

- Chat/新会话均接入原始 Provider SVG，以及同一份 Web alias/Magpie 品牌候选解析；未知品牌仍用 stack。共用 variant 标签、Default + 前七项内联、More 完整二级列表及返回/关闭；新会话补搜索清空、搜索时撤销 effort、本地化 context 和关闭自动大写/自动更正。
- 当前行保持 live variant，收藏/最近点击可用有效 remembered variant；普通 Provider 行不借收藏值。新增设备内 Host/目录/会话/Agent/model variant 偏好，Default 删除、150 会话 MRU、串行最新存储合并与失败保留；新会话普通 Provider 行用 Host `defaultVariant`。新会话选模型先保存本地 receipt，再更新 shared recent/favorite variant；失败只重试偏好，不重放选择，也不提前创建 session。
- 两入口接同一 72%/98% 高度 controller；只有 grabber 取得 responder，列表保持原生滚动/Sheet 下拉关闭。速度采样及 flick snap 使用 Web `heightSnapPhysics`。生产新会话仍通过原有独立 Dialog/Sheet/native completion 生命周期，不增加第二个材质或绕过原生关闭。
- 最终 focused **13 files / 144 passed**：模型目录/真实 headless 控件、二级页/返回、搜索清空、最近写入失败恢复、模型/Agent 独立选择、默认值/记忆、持久化隔离/并发/失败、Sheet controller、modal callback adapter、Host scope 安全门和无 React/browser 依赖闭包。模型 fixtures 补齐 synthetic `connection.list/runtimeScope` 和 readiness；未放宽生产 `scope_required`。新会话 fake Host 仅增加真实最近使用 narrow patch，不接受任意成功。
- Web 两批回归分别 **3 files / 8 passed**（品牌核心/closed-picker）与 **3 files / 24 passed**（品牌核心/Hook/高度物理，品牌核心两项重复）；仍有既有 React act 环境警告。UI type-check 通过。`dead-code` 再次执行并检查，没有新增模型模块 unused 报告；CLI 字符串入口 fixtures 等既有报告保留，不删除其它工作。
- UIKit 使用独立无网络 QA 包，直接挂生产 `ChatModels` / `NativeNewSessionModels`；新会话使用生产 `NativeNewSessionModal` 和真正注册的 `NewSessionPickerOwners`。iPhone 17 Pro / iOS 26.5，402×874pt：两个入口 grabber 上拖均从 **y=280pt → 77.67pt**，下拖恢复 **280pt**，继续下拖关闭；确认二级页完整选项、返回、关闭，以及连续重开。真实触摸执行新会话“选择 High → 关闭 → 重开 → 选 Default → 关闭 → 重开”，当前项与 Default 均正确。所有配置写入仅落 QA 内存/设备测试存储，没有模型/语音请求或真实 Host 配置变更。
- 已查看 `.scratch/nsh/chat-frames/model-picker-{chat-light,chat-dark,new-light,new-dark,variants-light,new-variants-light,new-selected-default,expanded-uikit}.png`。OpenAI/OpenCode 品牌在深浅色均可见；新会话搜索实际输入及清空可用。搜索截图没有显示软键盘，不能算软键盘/中文 IME 验收；Chat 的 NSH Input 在 UIKit AX 中没有公开 `model-search` ID，本次用真实 placeholder TextField 核对返回后的搜索，不伪称该 ID 已接入。
- 最终完整 `ios:build` **成功**，产物 `.nsh/out/YuriNative.app`；未将 QA 包冒称最终生产包安装。`nsh:check` 仍被未修改的 `history-import-core.ts:125` narrowing 与 `ui/src/lib/relay/tunnel-client.ts:65/124` BufferSource 类型错误阻断，本专项文件未报告类型错误。
- 扩展运行 `new-session-native.test.ts` 最后为 **4 passed / 4 failed**：失败均在 headless 的再次打开/返回阶段（modelAgentVariant、agentLongPressRelease、favoritePreservesSelection、presetCatalog），该引擎不提供注册 UIKit completion；未删断言、未改 skip。生产 modal 的 VM 生命周期八项通过，上述 UIKit 真正 native completion 的连续重开也已通过，但不据此把这四项标绿。完整真实 Host/Relay、软键盘/中文 IME、50 次输入延迟/下一帧预算及全应用 1:1 验收仍未完成。

### 输入框原生玻璃与 `@` / `/`（19:13 专项）

- Chat 与新会话的编辑器/两种候选均由 `composer-surface.ts` 提供原生 `glassEffect: regular`；透明 Input/List 不覆盖材质，旧平台显式 blur fallback。`/` 从卡片内部移至与 `@` 同样的上方 Overlay，不挤压 transcript。触发、排序、图标和行元数据直接使用 Web 纯函数。
- 共享键盘核心覆盖范围/Host CAS、上下循环和滚动 reveal、Tab 仅插入、Enter/点击、无匹配不发送、Escape、尾部保留及 IME/选区/失焦/后台/Host 失效。新会话的实际发送 callback 验证 typed/Tab 插入的 `/model` 只打开模型选择器，保留尾部且零 session create/模型请求。未知 Host 保留名称不能冒充本地动作自动执行。
- 最终 focused **7 files / 55 passed / 1 skipped**；skip 是默认关闭的 UIKit runner。包含 300 条命令、打开/关闭前后各 50 次普通输入的零目录枚举、失败不自动重试与显式恢复。Web 共享触发/排序/selection/closed-picker **4 files / 27 passed**，伴随既有 React act 环境警告；UI type-check 通过。Bun emitted 依赖闭包检查没有 React/浏览器 transport；`dead-code` 已执行并检查，字符串 CLI 入口 fixture 仍被报告 unused，未删除其它代码。
- UIKit CLI runner 实跑两次超时（dev client 断开、30s 步骤未完成），**不记通过**。改用独立 `NshAppView` 原生包、同一生产 Input/adapter/picker，在 iPhone 17 Pro / iOS 26.5 手动验证并读取 AX：模型选择为 `action:model`，文件点击后为 `refs:1`、值 `@src/neutral.ts `。已查看 `.scratch/nsh/chat-frames/composer-slash-uikit.png`、`composer-mention-uikit.png`、`composer-mention-dark-uikit.png`，可见材质边缘和背景透射，候选位于输入框上方。这是无 Host 的隔离 fixture，不是生产同状态对帧；截图未显示软键盘，不能作为软键盘/真实中文 IME 验收。
- 19:10 的 `ios:build` 成功，但最终 19:12 重建被并行改动的 `captureHostRequest` 缺失 export 阻断（`chat-models`/`chat-header` 等消费者），没有覆盖该模块或用旧包冒称最终安装。最近 `nsh:check` 仍被其它整合模块的 GUI inventory、setup accessibility、desktop Window 类型及 Relay BufferSource 错误阻断；本专项文件没有报告类型错误。成功构建仍有 NotificationBridge 的既有 Sendable 警告。
- **未完成**：Web 的完整本地 slash 目录与即时动作（new/init/btw/undo/redo/fork/timeline/compact 等）、inline command/reference chip 的原生视觉与撤销、真实软键盘/中文 IME、50 次输入延迟/下一帧预算、真机和同状态 Web 对帧。当前只接七个 magic prompts、`/model` 与 Host metadata，不能宣称所有 slash 功能已对齐；真实历史 53pt 与其它原有缺口仍保持未关闭。

### 18:49 后的生产导航与安全接线

- 实跑生产 Context 导航先捕获搜索覆盖时 Chat 被暂停、进入 overview 重开流的问题。同步 demand 改为实际导航栈中保留的同一个 Chat；隐藏输入/Goal/audio 仍禁用。复跑 `NSH_CONTEXT_PRODUCTION_ENGINE=1` 的 `context-usage-production.test.ts`：**13 passed**，包含两个真实 App 入口（`mod+p` 与 `mod+b→搜索`）、单流/无额外消息读取、stream patch、raw JSON/copy、失败 prior 与 Back 草稿断言。仅为严格合成 Host/headless，不是 UIKit 或真实网络验收。
- 同批额度生产导航文件通过，覆盖三个 Provider 的独立凭据表单、非首工作树继承和 Host-global 请求无 directory；Settings 导航另三个 MCP 场景仍捕获完整输入只保存首字符 `h`，尚在修复，不能将这一批报告为整体绿。
- 唯一根 runtime sink 已接诊断，Chat 与 global 的结构事件共用原 observer，无第二 SSE。先以真实 sink 回归实红（缺 Chat），修正后连通知/Context 的 **4 files / 40 passed**；诊断默认关闭，丢弃正文/token/路径等敏感内容。完整事件与分享设备行为仍待验。
- Usage 的 Host sanitizer 与 Web 默认选择已收口：显式 `provider: []` 不再被过滤或自动重填。Native/实际 Host-Web-VSCode 集成门禁 **3 files / 43 passed**，Web quota store **2 files / 12 passed**。新增真实磁盘 round-trip 与写失败回滚，Web settings 两文件 **58 passed / 1 skipped**；无真实配置写入。
- Swift 朗读接受显式 `settings-preview`，不再受聊天朗读按钮显示偏好影响，但仍要求当前 Host/前台/owner。先实红再修，连 Voice controller/ASR adapter/离线 Swift 与 SDK 定向 **5 files / 49 passed**；未调用真实合成、麦克风或付费 ASR，生产 transport 整合尚在进行。
- 清理核心已阻止无原子 admission 的破坏性执行。偏好、候选及历史核验保留；这一安全阻塞明确未完成，不能称为功能已还原。完整测试、最终构建及真实历史 **53pt** 问题仍未通过。新同步 footer 包开始独占设备复验，旧录像的缺帧与诊断等待问题不被覆盖。

### 18:14 集成与 footer 三轮矩阵

- `footer-matrix-1794045774/results.json`：三轮 OFF 控制均约 **35.9998pt red**；三轮 ON commit 均 **0pt**，release 均约 **0.000244pt**。每个窗口有 237–239（commit）/236–239（release）原生事后采样，三个同身份 marker，未把 invalid 判为通过。录像保存在同目录六个 `round-*.mp4`。这些是独立 footer 因果场景的采样结果；视频连续覆盖审计、诊断 capture 对释放时序的影响、生产同 batch 接线与真实53pt场景仍待验收。
- 归档恢复协议与计划状态专项：**2 files / 46 passed**。共享 Web/Native 计划耗时与 Web 历史列表：**2 files / 16 passed**。Web fixture 启动期间仍打印既有未配置 filesystem/persistence 请求警告，未把警告伪装成真实 Host 验收。
- `bunx tsc --noEmit -p packages/nsh/tsconfig.json` 与 `bun run --cwd packages/ui type-check` 本轮实际通过，覆盖当时已落盘的 context/归档/目录/计划改动，不覆盖之后的 observer/新模块接线。
- Goal 六项引擎发现新 Projects blocking bootstrap 的严格 fixture 漏项（`/api/debug/location` 及两条实际 location 查询），精确补齐真实空集合而非忽略 fault 后，连同通知设置公开保存/权限流程 **2 files / 31 passed**。原 Goal/queue/selection/宽度及互斥断言完整保留。
- 通知设置不再查找无效的 native focused 控件；实际路径覆盖权限拒绝时可关闭已启用偏好、拒绝时不能重新启用、显式模拟系统设置授权后保存启用，以及两次保存均保留 Web `hidden-only` 和模板。此为严格内存 Host，不调用真实系统权限或发送通知。
- 通知/source/overview/Apple SDK 定向 **9 files / 69 passed**。question、permission、Goal 与具公开气泡证据的助理分支已接；schedule、catalog 外 child、静默助理歧义、APNs 和冷启动恢复仍见 `notification-INTEGRATION.md`，不能宣称八类全完成。
- 最近完整测试快照仍是 **1627 passed / 8 failed / 29 skipped**；上述定向修复不等于已重新跑完整包或构建最终生产包。全部能力1:1仍未签收。

### 17:48 后的复验记录

- 原三项定向红灯已逐个定位并复验：日期测试默认缺 Foundation Host；content-search 旧 fixture 缺必填 `createdAt`；transcript 旧 fixture 拒绝 `appearance.reset/apply`，导致未取得 showTPS authority。均修正测试装配/协议，不改 cron 算法、不放宽身份校验、不修改历史 TPS 计算。连同连接公开路由复验为 **4 files / 31 passed / 1 skipped**，skip 为未开启的独立字节码检查。
- 连接公开路由已通过 metadata 保存零重连、dirty Back 保稿/放弃、跨 origin 失败保稿、明确重新授权成功后 pop2，重新打开编辑器没有旧 version baseline。使用严格内存 Host；不代表真实 Keychain 或跨网络认证验收。
- 头像修复后的 Chat/picker/正文/Activity/工具 diff/朗读相关 **12 files 通过**，该批包括通知权限合成引擎；会话切换 fixture 的脚本转义与以 `/` 开头文本被当正则的问题修正后，独立 **1 file / 1 passed**。合成执行不等于真实语音合成、背景通知或 UIKit 转场。
- `bun run --cwd packages/nsh test:native` 通过：包含 metadata 编辑零网络/零失效、跨 origin/version 拒绝、授权原子替换及写失败回滚、直连/Relay 鉴权、资源限额/失效、附件与 UTF-8 SSE。只访问本地 synthetic fixture，不写真实 Keychain。
- 通知生产已使用唯一 `observeRuntime` 的 parsed-global callback，根 Feedback 已装配。普通完成/失败事件仍只覆盖明确支持的权威类别；APNs、冷启动点击恢复和其他类别端到端适配未完成，不能称完整通知还原。
- 独占模拟器下，新会话真实拖删除已成功且留在页面；系统 Back 仍可返回。详见 `NEW-SESSION-VALIDATION.md` 的审计记录。模态背景 AX 隔离与其余复杂手势未据此通过。
- 新 footer 候选的默认 OFF 负控制仍复现 −36pt。显式 ON 首次实跑没有建立实际高度（首次 layout 早于 active，且开启后没有新 layout），仍为 −36pt：`.scratch/nsh/chat-frames/terminal-hold-1794044412170/`。候选未进入生产，真实 Host 的 53pt 故障继续未通过。
- 完整测试集已重新启动，尚无本轮最终全包/构建结论。不得用以上定向通过覆盖完整范围。

### Activity 汇总、压缩与精简历史补全（17:34 专项）

- Native/Web 共用 Activity 子会话去重与 slim 判定。外层汇总最多显示两个真实 seed 头像，计数包含全部参与者；同一子会话恢复调用不重复计数。增删统计保持所属历史分段。普通 live 无 header，active compaction 保留禁用 header 并锁定展开，结算后才恢复折叠。
- `transcript-materialization.ts` 由 Chat 所有，双并发、去重、FIFO 与用户优先（包括已排队的自动读取提权）。仅展开且结算的 Activity 自动读取；失败跨 remount 保留，只允许显式展开/重试，不以失败冒充空输出。后续权威完整正文可清除错误而不追加 exact GET。
- exact GET 验证 message/session 身份并接纳 native content、legacy info/parts；仍 slim/缺失 parts 明确失败。源对象 CAS、隐藏/后台/Host/revert fence 防止旧结果回写。重复精简轮询保留相同时钟/状态下的完整 input/output/metadata；50 次生产 `chat.load` 后数组引用不变、exact GET 仍只有一次。失败不影响其它消息，状态/时钟变化不沿用旧正文。
- 最终 Native 纯逻辑/生产 state/依赖闭包专项 **8 files / 117 passed**；生产组件 headless + UIKit 专项 **1 file / 10 passed**（含两个 UIKit 用例）。覆盖跨轮独立选择、分段共享选择、压缩 streaming→settled、头像最多两个、正文补全失败→remount 不重试→显式恢复。无付费模型/语音请求，没有写入真实历史。
- 已查看 UIKit fixture 原图：`.scratch/nsh/chat-frames/activity-agents-uikit.png`、`activity-compacting-uikit.png`、`activity-fill-error-uikit.png`、`activity-fill-ready-uikit.png`。可见两个不同子会话 artwork、三个参与者计数、压缩正文及重试反馈；不是生产 Host 对帧或滚动稳定证明。
- Web 受影响专项 **4 files / 54 passed**，UI type-check 通过。共享文件 ESLint 无 error，`ProgressiveGroup.tsx` 保留既有 exhaustive-deps warning。`dead-code` 已运行并检查，parity fixture 仍因 CLI 字符串入口被报 unused，未删未知代码。
- 最后 `ios:build` 成功，已对指定模拟器重装并启动。构建仍提示 Wafer SVG 内嵌 image 与 NotificationBridge 的 Sendable 警告。`nsh:check` 17:28 曾通过，17:34 最后复跑被并行整合中的 `context-usage-core.ts(26,151)` 对 `Part.tokens` 的类型读取阻断；本轮未覆盖该模块。
- **未关闭**：真实历史已记录的 53pt 跳动、展开/补全过程的 UIKit 阅读锚点、shimmer/FlipUpText/延迟卸载与同状态 Web 逐帧比较。上述合成组件测试不能替代真实 Host、真机和公网 Relay 的完整验收，也不能报告全包绿或完整 1:1。

### 17:00 后的外层接线与当前阻断

- 六组定向引擎复验：Bot 公开创建上下文、Task 默认四元组/命令与引用辅助及离页保护、Projects 删除撤销/到期部分失败/实时未读、五域搜索、About 合成权限分享。**6 files / 18 passed / 1 skipped**；skip 为未开启的独立 bundle 检查，不是设备验收。全部使用合成内存 Host，没有保存真实 Bot/计划或执行真实删除。
- 项目设置另有两个引擎场景已绿。setup 原红灯是输入时行身份变化及保存期禁用/旧回读覆盖后稿；稳定行 ID、保留输入及回读版本检查后，真实 `app.type` 的完整文本断言通过，没有用 setValue 绕过。
- 连接编辑与 About 已进入生产路由，当前接线后的最终 iOS 构建尚未完成。先前成功的构建不覆盖后续连接/通知/类型 seam 改动；最终全包结果以之后独立记录为准。
- **真实历史仍不通过**：`.scratch/nsh/production-history-review-1794040314/` 解码 304 个实际帧，三个静止旧内容块在 303 帧同时额外上移 159px（53pt）。不能用原合成历史的 0px 结果覆盖；该录像缺完整 adoption authority，且最大实际帧间隔 10.22s，不冒称连续全程稳定。
- 独立新会话 UIKit 包已实际启动，650ms 真实长按 Agent 的视觉 Sheet 已出现；但 AX 没有 Sheet 内控件节点，只有底下页面。该项正区分 native accessibility 与采集工具边界，未靠猜坐标宣称后续选择/释放/拖拽已通过。
- 独立终页诊断载体首次启动发现 `terminal.record` 没有获得 capability。该版本无有效原生观测，不算红绿回路建立完成；需要修复授权后重新安装、复现并留存原生几何与逐帧证据。

### 工具样式与内置 DiffView（15:29 专项）

- `NativeToolRow` 复用 Web 的纯 icon/尺寸映射；标题 medium、20pt 行高、16pt leading slot，非 Shell 不额外显示耗时/Running，保留单行路径与增删统计。九点波纹直接使用 native motion，Used/Skill 的 active 图标也接入同一组件。工具颜色由 Host appearance 的 JS-only palette 按外部公式生成；没有新增依赖，也没有把 React 引入 QuickJS。
- `NativeChangesSheet` 的 patch 与 before/after 已替换为 `nsh/base` 内置 `DiffView`，保留统一视图、词级高亮、上下文、源行号、复制/预览/重试、失败保留快照与二进制分支。多文件工具 source 带完整历史文件；不会替换成当前 Git。NSH patch ref 的内部索引与 gutter 源行不相同，回归捕获第 9 行误变第 2 行后加入映射，UIKit 已确认 preview 源行为 9。
- **8 files / 54 passed / 1 skipped**（15:38 重跑，含新的 UIKit tool/diff 专项；skip 是另一个未开启的 parity UIKit gate）。覆盖工具开关、literal 原始输出、历史 patch、before/after、多文件 back/切换并预览第 4 行、删除、二进制、空快照、关闭/失效和历史/暂存/工作区隔离；2000 行全替换的 headless 可见 text 节点 <500。该计数不是 UIKit 帧率、输入 P95 或最坏耗时证明。
- 共享 Web 受影响专项 **3 files / 82 tests passed**；`nsh:check` 与 UI `type-check` 通过，触及共享文件 ESLint 无输出。`dead-code` 已执行并检查：CLI 字符串入口 `tool-diff-fixture.tsx` / `chat-changes-test-app.tsx` 仍报 unused，既有 NativeToolField 类型与其它仓库告警保留，未删未知代码。
- 无 Host/模型/语音调用的 UIKit 截图：`.scratch/nsh/chat-frames/tools-chrome-uikit.png`、`tools-expanded-uikit.png`、`tool-patch-diff-uikit.png`、`tool-pair-diff-uikit.png`。截图由测试 host 的窗口截图 API 生成，是生产组件隔离 fixture，不冒充真实会话或新的 Web 同帧。
- 已知差异仍保留：NSH 0.4 可能把无相邻 context 的 patch 变更合为同一 native hunk；初始 targetLine 只能定位到该 hunk，不保证很长 hunk 内精确源行。自定义 Todo 标记、文件类型副图标、task shimmer/FlipUpText、200ms 卸载与各工具专门详情尚未全量逐帧还原。没有据本轮通过声明工具全量 1:1，也未重复付费请求。
- 后续 NSH 全包（15:32 启动）为 **105 files passed / 5 failed / 5 skipped；980 tests passed / 6 failed / 65 skipped**。另含远程桌面套件 setup 因未纳入 `ResourceWebPreview*` Swift 类型失败，56 项因此未执行；其余失败涉及计划 Cron/Intl fixture、Goal `stop` 入口、history-focus Goal 入口与 transcript TPS。此快照不能报全包通过，未为本轮工具样式修改其它模块的断言或 Swift 文件。
- 最后 UI `type-check` 再次通过；包含本轮源码的 `ios:build` 构建成功，模拟器已重装并启动。Wafer logo 的 SVG image 兼容提示仍保留。生产真实会话中的所有工具类型、真机/公网 Relay 及新的 Web 同帧仍未验收。

### Changes / 历史跳动 / 发送键专项（本轮）

- Changes 300 文件布局回归先捕获 `650pt → 297pt` 的 transcript 视口缩水，修为原生锚定 Overlay 后通过；展开刷新失败与关闭均不再改变视口。真实 Host marker 会话三轮打开/关闭，每轮两个消息操作锚点的位移均为 **0pt**；`changes-overlay-production-probe.json` 与 `changes-overlay-production-{0,1,2}.png`。真实仓库当时只有一个变更文件，不能用这三帧声称已实测 UIKit 300 文件滚动。
- 历史投影复用未变行/数组，跨页扩展 assistant run 保持旧 key，拆行保持唯一；含 200 条已完成行与 50 次流更新的引用稳定回归。分页按钮/错误与同步恢复位于 List 内；分页意图模块不写滚动位置。
- 新 UIKit 隔离 fixture 直接使用生产 `history-rows` / `history-scroll` 与倒序 List：三轮，每轮 **8 次真实页面采用、240 次阅读锚点测量，均满足 ≤1.1pt**。首轮另采的单页精确结果为 0pt。后两轮录像为 `history-eight-adoptions-run-{2,3}.mp4`；这些采用的是变高合成行，不是新增付费请求，也不能代替真实 Host Markdown/图片专项。未经逐帧分析，不声称录像已经证明所有中间帧无跳动。
- 早期 `history-before-1.json` 误含 metadata 浮层，`history-after-1.json` 追踪了屏外节点；均为无效诊断，不作历史采用或锚点验收证据。NSH 0.4 headless 的同 fixture `measure()` 不反映 UIKit 倒序补偿，专项仅在 `NSH_HISTORY_IOS=1` 执行，默认跳过有明确原因。
- `composer-send.tsx` 接生产：32pt 触区 / 24pt 实底圆盘 / 56% 反色箭头 / 50% spinner；生成中空稿同位置显示 38% 实心停止方块，有跟进内容才换回发送，移除裸停止图标与旁边重复的 ghost 发送。隔离 UIKit 驱动已实际输入、点击模拟提交、切换生成/跟进/停止，浅色与深色截图 `send-{ready,inflight}-uikit.png`、`send-{ready,inflight,stop}-dark-uikit.png`。没有向真实会话发送或调用模型。
- 最终专项（14:03 启动）**13 files、104 tests passed**，包含 Changes、发送/停止、生产队列/引用/发送 smoke、历史 state/rows/intent 与依赖闭包。UIKit 历史专项三轮单独通过，不计入这 104 项。
- 全包快照（13:58 启动）**538 passed、6 failed、3 skipped**。失败涉及测试编译时 ScheduleAssistant 尚未接完、项目 mutation 合同、计划历史目录与语音 awake；其中队列两项在后续 104 项专项中已复验通过。不得将这轮说成全包绿。最后 `nsh:check` 仍报告 assistants-details 与 relay 类型错误；先前静态检查通过不覆盖持续整合中的其他改动。
- 含本轮发送/停止、浮层与历史接线的 iOS 构建最终成功并重装启动；此前一次构建因 RemoteDesktopBridge.swift 在编译期间被修改而中断，重跑后成功。生产 marker 临时只输入一个 `a` 用来采圆盘箭头，随后原生 Select All/Cut 清除，AX 确认草稿为空、箭头不再显示；没有点击真实发送。帧为 `send-ready-production.png`。
- `dead-code-latest.log` 已检查：字符串启动的 CLI fixtures 仍被列为 unused，另有其他模块整合中的 unused/export 告警；未据此删未知代码。Wafer SVG 内嵌 image 的原生限制依旧保留。两段历史录像实际为可变帧率，分别 401/445 帧，不能写成 60fps 逐帧证明。

### 最后整合状态（以下旧快照不覆盖本节）

- 工具 raw 协议修复后的 NSH 全包为 **62 files passed、453 tests passed、2 skipped**；正序跟随中间版为 **454 passed、2 skipped**。用户随后明确要求开启倒序 List，最终倒序版 focused **3 files、16 tests** 通过，最终全包 **62 files passed、454 tests passed、2 skipped**（13:19启动，155.55s）。共享受影响 projection/content/time **3 files、30 tests** 通过；`nsh:check`、最新 iOS 构建/安装/启动通过。
- `bun run dead-code` 最后重跑并检查：NSH 18 个字符串启动的 fixture 仍被列为未用，另有仓库既有导出/类型告警；没有删未知代码，也不声称零告警。构建继续提示 Wafer SVG 内嵌 image 不受原生 SVG 支持。
- F01 安装版已显示 `0:48`，并读取真实 Host 豆包配置显示「朗读」；`F01-native-speech-clock-full/content.png`。没有调用付费模型或语音合成；按钮出现不等于听音成功。
- Chat 内唯一 `messageSpeech` 传给 assistant 操作条，设置失败仅挂一处；开始听写前停止朗读。Swift 持有音频和认证，隐藏/后台停止、销毁释放。恢复重播当前段、豆包 Host MP3 非 Web 直连流、缺逐词高亮/活跃脉冲等差异尚在。
- 真实 OpenCode 2 shell 的结果位于 `state.content`，耗时位于顶层 `time`。已抽取 Web 的纯叶映射供 Native 共用，并以相同协议形状回归；UIKit 已显示 `printf NSH_LIVE_TOOL_OK`、`NSH_LIVE_TOOL_OK` 与 `11.4s`，见 `F16-native-tool-geometry.json`、`F16-native-verified-output-full/content.png`。Web对应帧 `F16-web-current-output.png`，两者未锁定相同滚动锚点，不能宣称像素一致。
- F16 新 `F16-native-hit-toggle-capture.mp4` 为12s/60fps/721帧，六次点按覆盖中央文字、两端和标题，AX均确认单工具开关；抽帧 `F16-native-hit-toggle-overview/` 与 `-tail/` 确认实际展开/关闭，不是静止录像。先前 `F16-native-pre-action.mp4` 全程展开，失败的 `F16-native-verified-toggle.mp4` 没有有效动作断言，均不作动画证据。旧点击失败本轮未稳定复现，未归因或加入点击fallback；新录像仍不证明与Web动画一致。
- 正序中间版曾因空闲bottom-follow把收起按钮卷出屏幕；限定为busy后3轮通过。该策略后被用户明确要求的 **`inverted`** 替代，不再当最终合同：`bodyRows`只在展示端反序，旧消息仍在上、新消息在下，内部content不反序；删除正序follow配置，返回最新端刷新messages并使用原生倒序owner。`F01-native-inverted-full.png` 已确认短对话从底部开始且问答顺序正确，因此旧F01顶部几何是历史参考。仍在最新端展开长消息会保留底距，不以旧“收起按钮必须留在顶部”的probe判为倒序失败；向上阅读/前插的锚点仍需专项，不能把开关视为完整验收。
- 列表第二轮修正为19/18pt gutter、1pt row inset、intrinsic marker width与6pt gap；`F15-native-list-gutter-full.png` 确认9–16完整。长用户偏好已接入根 appearance 快照，成功读取的缺省值沿用Web true，失败/非法值不冒充有效偏好。引用键盘生产接线和fixture已有，但最终高亮版本的UIKit物理键盘/IME专项仍未完成。
- 本轮恢复时浏览器 TaskSpace 4 已不存在，无法补采新的Web帧；未另建空间绕过、未读取其他用户页面，也未撤销桌面授权。Native草稿AX为空，未发送新请求。全量范围仍见 `PARITY.md`，远程桌面、Goal/Tasks、HTML/Eficy/插件执行、完整语音及真机/公网Relay仍未关闭。

- 早期整合快照：55 files passed、2 skipped；425 tests passed、2 skipped。中途 appearance fixture 原始错误泄漏断言和新增纯模块依赖白名单曾失败，已修复并重跑全包，未降低错误脱敏或禁止 React 的断言。
- 新增生产 Chat 引用与发送 smoke：2 files、3 tests passed。
- iOS 原生构建、模拟器安装和启动成功；无新增依赖，未提交/推送。
- `test:native` 通过：直连鉴权/资源/SSE，Relay 加密 HTTP、上传、分块 UTF-8 SSE、重连，redirect/大小上限/Host 失效。当前真实 Host 未部署本轮 Relay redirect 改动，不能将本地桥测试当部署证明。
- `bun run dead-code` 已执行并检查报告：大量仓库既有未用项；NSH 的 CLI 测试入口由字符串路径启动，被静态分析列为未用，未据此删除。未声明 dead-code 零告警。
- 生产 `setDraftText` 200 次输入的计数回归：网络零增量，300ms 合并一次持久化；未测设备输入 P95/输入到绘制延迟。
- UIKit 实际完成：打开/关闭真实模型目录 Sheet；输入 `@native` 查询真实 Host，选择 `packages/ui/src/lib/gui-plugins/native.ts` 后原输入替换为已确认引用；未发送该草稿、未改模型/收藏等 Host 配置。
- 临时 Native 草稿已通过原生全选/剪切清除，AX 确认 `TextArea` 为空且 placeholder 可见；没有发送模型请求。浏览器测试草稿保持为空，现有桌面授权不撤销。
- 结束本轮采集时，任务浏览器已关闭、内存授权随页面释放；最终 AX 再次确认 Native 草稿为空、Agent 仍为 Build，模型 Sheet 已关闭。
- 软件英文键盘展开截图 `native-chat-software-keyboard.png` 中输入区未被键盘遮住；这不覆盖中文 IME、连续输入时延或所有机型。
- 共享纯函数及关闭 picker 回归：5 files、38 tests passed；测试输出有已有 React `act(...)` 环境警告，未将其隐藏或报告为无告警。

## UIKit 已发现、尚待关闭的问题

1. 双返回、普通消息额外 Yuri 署名、F01 user/assistant 操作条角色错配已在最终安装版关闭；标题完整显示。虚拟化复用仍不能仅凭 F01 判定所有历史正确。
2. F01 最终原生正文坐标为 x80.667/y101.667（扣除系统 status 后），Web 为 x81.195/y101.719；原生操作条 y184.667，Web y184.641。`width: max-content` 配合数值 maxWidth 修正了约 23pt 的气泡偏窄，并保留短文本 hug；不能靠固定全宽掩盖差异。
3. F01 时间 `00:48` 与缺朗读入口已在后续安装版修正（见最后整合状态）；位置与图标间距、composer 材质、placeholder、语音交互和发送反馈仍不等同 Web。原生 Liquid Glass 是当前明确保留的原生材质，不据整体像素差值声称完成。
4. F09 已用 UIKit 验证混合建议与原生 Overlay，不挤压 transcript、没有旧五域 Tab/重复搜索框。中文 IME 未确认时不打开建议，确认候选后才查询；这是一个真实组合输入场景，不覆盖完整中文输入、撤销/重做与键盘导航。最后的高亮与行密度代码有 focused 回归，尚待最终 UIKit 同帧复验。
5. Host JetBrains 主题、assistant JetBrains Mono、正文 15.75/25.59375 已在 UIKit 生效；Agent 颜色也来自当前主题。任意 Agent/子会话 seed 的真实 artwork 已在后续 Activity 专项验证；未安装字体仍不能用其它字体冒充。
6. F02 最终 metadata 从内容区约65.6pt开始，总高约560pt，不再翻到顶栏或透明穿透。非默认上下文显示权威 28.9K/400.0K、7.2%，真实配额包含标准 provider 与 Magpie。账号/金额帧后脱敏，仅在实际可见面板范围内遮罩，私有原图已删除。
7. F02 Web 先前只等待 Magpie 缓存而采到了部分加载状态；`F02-web-metadata-stable-dark.png` 才是同时含标准 Codex/Grok 的稳定帧。没有为了贴合旧中间帧隐藏标准 provider。
8. F06 最终模型 Sheet 已按扣除系统安全区的内容高度计算，搜索框 y252 与 Web 基准对齐。最近行与能力槽已收紧；Provider/model 目录内容与排序仍须对照当前真实响应，不能以布局代码或截图替代全部选择/variant/收藏交互验收。
9. 长历史滚动/前插/晚到图片、完整 IME、软键盘、真机与公网 Relay 仍需专项验收。TTS、远程桌面、Goal/Tasks 和全量能力缺口仍保留在 scope。

最终静态帧：`F01-native-final-full/content.png`、`F01-native-final-geometry.json`、`F02-native-final-full/content.png`、`F06-native-final-full/content.png`。`full/content` 是文件命名简写，实际分别为 `-full.png` 与 `-content.png`。

已录原生 F06 打开过程：`F06-native-model-open.mp4`，1206×2622、60fps、421帧。`F06-native-transition-frames/` 保留15个相邻原始帧及精确时间戳（5.550–5.783s）。这段录像早于最后一次 Sheet 高度修正，且尚无同步 Web 动画帧；只证明采到了真实中间态，不作为最终动画一致性验收。

共享受影响回归：time-format-core、generatedAvatar、AgentAvatar、mobileControlsUtils 共4文件20项通过。原生构建及安装/启动通过；构建仍提示 Wafer SVG 的嵌入 image 不受 Native SVG 支持，未隐藏该限制。

截图只是本次状态记录，不是完成声明。未列出的全量能力仍按 `PARITY.md` 的完整范围逐项推进。

## Transcript body：F15/F16 接线与剩余差异

- 本轮已读取可靠 Touch 的 F15 collapsed/expanded、F16 工具组展开帧，以及 F01 同主题 Native/Web 对照；没有另开浏览器、模拟器、调用模型或操作真实历史。
- `transcript-body-model.ts` 与生产 `NativeTranscriptBody` 按原始 messages/content 顺序显示 text/tool/text，复用 Web lifecycle、expansion、process grouping 纯逻辑。List 使用真实 head/tail 投影，不制造合并消息 ID；正文与工具 I/O 读取当前 accessor。Activity、process group、单工具详情均能展开后再关闭。
- F16 单工具行已收紧为标题、权威耗时、命令摘要和一个展开箭头；只有导航型工具另保留详情按钮。`11.4s` 最终来自 raw tool 顶层 time，旧 fixture 的 state.time 仅为兼容，不借用整个 turn 的耗时。正文/code 样式来自 appearance；shell详情用selectable literal text，其余TextView保留links/code-copy。
- F01 移除旧右下角 4pt 覆盖；user bubble 使用原生 `max-content` 首选宽度和随窗口变化的 `maxWidth = max(0, width - 24) * .85`，保留短文本 hug。仅 maxWidth 仍会按换行后的最长行再次收窄，已通过最后一轮 UIKit 实测修正，见上面的最终几何数据。
- 最终 focused：11 files、122 tests passed；`nsh:check` 通过。共享 partUtils/lifecycle/activity expansion/process grouping/projectTurnRecords：5 files、104 tests passed。`dead-code` 已运行；静态分析仍将字符串 CLI 启动的 body fixture 列为未用，不据此删除。

尚未关闭的差异（本块不能据测试通过宣称逐帧还原）：

1. 最初body子任务仅用合成fixture；主线程后续已核对真实shell的raw字段、UIKit输出与折叠录像（见最后整合状态）。其他真实工具类型与长历史仍未完整实测。
2. Native Markdown 的段落、列表编号、代码块与选择几何、rail 颜色/透明度、触区及折叠后的阅读锚点未逐帧测量。不同 content part 是不同 TextView，未证明能跨 part 连选。
3. Web 的 LatticeOrb、shimmer、FlipUpText 和 sorted reveal 动画未迁移；当前活动图标是静态原生图标。F15 collapsed 的临时 skeleton 不作静态仿制，已收到的最终正文保持可见。
4. 本块当时仍按结构化边界保守放弃 Activity，且历史身份改变会拆行；已由下文「消息整理与模型身份共享合同」替换。未知结构化 part 的专用 renderer 仍不在已完成范围内。
5. 本块当时固定使用 sorted/collapsed/showReasoning=true；下文已接入 Host 的同名偏好。该接线不能证明每一种工具/未知结构化 part 都已完整支持。

### F15 长用户正文、列表与箭头专项

已对照 `F15-native-initial-full.png`、`F15-web-current-collapsed.png`、`F16-web-current-output.png` 和本机 UserTextPart/mobile.css。新增三个明确失败的 production headless 场景后修复：长用户正文的自然高度测量/10 行显示裁剪/附件隐藏/展开与右上收起；ordered 9–16 小 marker；Activity 两种状态的显式箭头。原始 source 始终完整，不截固定字符、不修改列表编号；同 row 更换 part 后不继承旧附件隐藏状态。

最初子任务仅运行 own fixture：`transcript-body-model.test.ts` + `transcript-body-native.test.ts`，18/18；没有运行App/构建/模拟器。后续主线程的marker二次修复把18pt固定框改为intrinsic width及6pt gap，mount-frame回归与UIKit均已复验（见最后整合状态）。单工具开/关后明确断言group与outer Activity保持展开；这不能单独反证真实UIKit命中问题。

此轮仍需关闭的边界：

- 生产折叠已读取appearance根快照同名字段（主线程整合完成）；未知快照不猜偏好。自然高度、链接与selection边界仍需更多真实内容覆盖。
- 本地0.4没有`styles.document/listIndent`；当前使用19/18pt list parts与intrinsic marker。完整9–16编号已实测，marker色、字重及UIKit精确密度仍待同状态对帧。
- 用显式“展开查看更多”保留正文 selection/link/code-copy 的事件边界；未给整个 TextView 额外加 tap handler。本机 TextView 不提供 selection-change 通知，尚未复刻 Web“选区存在时不处理正文点击”的完整守卫，不能宣称点击正文展开已对齐。
- 折叠用户代码块仍使用原生 TextView 的文档布局，并非 Web 的 CSS inline code-block 呈现。跨 block/part 连选仍不是已验证合同。
- 本轮不增加第二个 scroll writer，保留 List 自带 maintain-visible owner；真实触摸收放的命中矩形、阅读锚点及 F01 不倒退仍由主线程 UIKit 取证，不能以 headless 通过关闭。

### 消息整理与模型身份共享合同

本轮不再为 Native 维护一份简化 turn 算法：

- `nativeBodyRows` 直接使用 Web 的 `projectTurnRecords`（包括 `projectTurnActivity`），`nativeBodyPlan` 消费其活动成员、终态、最终正文与耗时。raw adaptation 保留 nativeType/clientRole/parentID、错误类型、mode 和用户发送身份；`projectionInfo` 只保留需要的字段，不重复持久化整份 content/files。legacy compaction 的 clientRole 同样决定显示角色，原 source record 不改写。
- 模型/variant/Agent 变化不再拆 assistant run 或重复 header；错误重试由同 turn 的最终 assistant 决定反馈。可见 notice/checkpoint 分段，隐藏 synthetic instruction 不拆 Activity。保留真实 head/tail、前页补齐后的稳定 key 和倒序 List。
- 排队 user 不触发前轮结算，后轮开始回答才结算旧 active；tool-step completed 不算终态。已确认最终正文可以越过滞后 busy 展示完成信息，失败与中止保留各自的反馈规则。
- Activity、Used、连续 Skill、Thought 各自拥有折叠层级。同 turn 的 Activity 分段共用显式选择；sorted 跨相邻 assistant 合并工具，live 只在每条消息内部合并。Thought 的清理、80 字符摘要、初始展开及自动展开 reconciliation 与 Web 共享；动画和延迟卸载尚未迁移。
- `/compact` 命令不画 user bubble/操作条，summary 即使没有 tools 也由 Activity 折叠。Host 的 render mode、activity mode、reasoning 开关已接根 appearance 快照；测试也覆盖 summary 默认展开与显式选择不被偏好更新覆盖。
- Header 使用共享身份优先级：完整 assistant → 完整 user → 仅 pending/active 的 composer → session selection；不把两个来源拼成一个 provider/model。目录数组/字典、未知 ID 格式化、非 default variant、mode/agent 优先级、shell 排除和已挂载 identity 保留都有回归。pending header 跨 busy/idle 间隙保留，首个无 identity 的 assistant 仍使用该轮 user identity。selection 由现有 composer authority 读取发布，不逐消息新增请求。

验证：

- 先确认 5 项原生旧行为红测：身份变化重复 header、step-completed 过早结算、最终正文被滞后 busy 压住、排队/后轮结算以及身份变化拆行；随后修复。
- Web 共享专项：16 files / 186 tests passed，含 11 项 raw-message prefix 差分、ReasoningPart 及共享摘要/状态、原 projection/Activity/header/delivery 回归。另一次真实 React renderer 专项 4 files / 55 tests passed（有重复项，不相加）。
- UIKit + 原生交互专项：`NSH_PARITY_IOS=1 NSH_HISTORY_IOS=1`，2 files / 8 tests passed。包括 6 项 headless 生产组件行为、1 项 UIKit 分段/整理/pending-header 交互，以及八页历史 / 240 次阅读锚点测量。没有模型、语音或连接配置写入。
- 200 个已结算历史 turn 经 50 次当前 turn 更新，旧行引用与 key 保持稳定；原先只有 user 的合成列表不再被误称为「200 个已结算 turn」。新增纯投影依赖闭包 type-check，禁止 React、browser store、transport 与 Node runtime 依赖。
- 最后 Native 专项 12 files / 88 tests passed（包含 UIKit）；全包中途快照为 857 passed / 5 failed / 8 skipped。失败位于 `settings-outer` 的 Summary AI picker、`appearance-settings`、`features` 的 Intl mock、`features-ui` 的 Cron 预览和 `chat-header-ui` 的旧 remote-desktop 断言；本轮未修改这些模块，不以本轮专项代替它们的验收。
- UI `type-check` 通过；`nsh:check` 本轮曾通过，最终仅被 `application.tsx` 另一处项目 Changes 导航仍使用已经移除的 `kind: 'changes'` 阻断，不能报最终全包 type-check 通过。最新 iOS simulator app 已成功构建。触及的共享文件 ESLint 无 error，两个既有手动路径转换 warning 保留。`dead-code` 已运行并检查：CLI 字符串入口的 parity fixture 被列为未用，不删除；compaction 常量保留原 API re-export。

后续 Activity 专项已补齐外层任务头像/汇总与 slim 自动完整化/失败重试，九点波纹亦已有工具专项；仍不能宣称完整 1:1。shimmer/FlipUpText、200ms 动画卸载、未知结构化 part 仍需继续对齐。UIKit 使用无付费请求的合成 source；没有同状态 Web 新实帧，不能用上述测试替代真实 Host 的逐帧视觉、触摸命中和展开后的阅读锚点验收。
