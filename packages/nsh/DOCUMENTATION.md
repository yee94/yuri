# NSH native client

## Ownership

| 模块 | 职责 |
| --- | --- |
| `App.tsx` | 挂载原生应用 |
| `application.tsx` | 四 Tab、原生导航、项目/会话、聊天、连接、文件和设置页面 |
| `features.tsx` | Bot 与计划任务编辑、模型目录、校验与提交反馈 |
| `projects*.ts*` | 项目/工作树与会话目录、目录注册/克隆、全局搜索及独立失败恢复 |
| `assistants*.ts*` | Bot 联系人、真实设置集合、详情、渠道配置与清空历史确认 |
| `schedules*.ts*` | 计划目录、详情、opaque 游标历史、按项目隔离的写入与部分失败恢复 |
| `settings*.ts*` | 设置目录及各自拥有的表单/集合；导航由 application 装配 |
| `settings-github*.ts*` / `settings-git-credentials*.ts*` | GitHub 多账户、Host 设备授权/取消、exact OAuth 删除与 discovered 身份 metadata 导入；状态机及验证边界见 `tests/settings-github/README.md` |
| `settings-about*.ts*` / `ios/DiagnosticsBridge.swift` | 三版本、Host 更新确认/执行/进度/恢复、默认关闭的有界安全 runtime 事件日志与分享；客户端更新仍缺签名渠道与安装生命周期 |
| `connection-editor*.ts*` / `ios/connection-editor.swift` | 连接元数据编辑、版本冲突检查和唯一脏稿离页保护；凭据与重新授权仍归原生连接 owner |
| `blocking.tsx` | 原生权限确认、条件表单、输入校验和答案提交 |
| `Icon.tsx` | 将现有 Yuri 图标路径绘制为 NSH 原生 SVG 图片 |
| `state.ts` | 按 Host 与页面生命周期隔离的服务端快照、聊天同步、发送与重试 |
| `model.ts` | OpenCode projection / contact / inbox / event 的纯数据适配 |
| `runtime.ts` | NSH 到 Swift Host 的窄请求边界 |
| `drafts.ts` | Host/草稿范围的文本、附件、引用与未知发送快照持久化及恢复 CAS |
| `new-session*.ts*` | 未发送的新会话页面、本地选择与恢复、首次创建 receipt、Chat admission 及导航所有权转移 |
| `composer*.ts*` | 原生命令、magic 模板、五域引用搜索、范围重定位与发送编译 |
| `composer-send.tsx` | 手机端单一发送/停止触区、语义反色圆盘与提交中反馈 |
| `chat-composer-selection.tsx` / `chat-models*.ts*` | 独立 Agent/模型按钮、原生 Sheet、最近/收藏、variant 与权威选择 |
| `model-picker-presentation.tsx` / `provider-logo.tsx` / `model-variant-memory.ts` | Chat/新会话共用的 variant 选项与二级页、非 iOS 高度手势 fallback、Provider 原始 artwork、设备内按 Host/目录/会话/Agent/model 隔离的 variant 偏好 |
| `native-sheet.tsx` / `sheet-presentation.ts` / `ios/SheetPresentation.swift` | iOS 系统 pageSheet、detents、关闭保护与真实 completion；非 iOS 使用 NSH Sheet |
| `native-select.tsx` / `select-keyboard.ts` / `native-date-picker.tsx` / `ios/DatePicker.swift` | 系统 Sheet 承载的搜索选择器、键盘导航与系统单日期控件 |
| `chat-chrome*.ts*` / `ios/ChatHeaderCollapse.swift` | 复用 Web 纯规则的 Header/Composer 滚动缩小与恢复，仅拥有 transform/opacity |
| `chat-header*.ts*` | 聊天标题、返回、workspace 菜单与有界上下文 metadata |
| `context-usage*.ts*` | 独立完整上下文 overview、生产只读 route/commit observer 消费、retained-wire adapter、增量统计和原始 JSON；不替代 header metadata |
| `chat-queue.tsx` / `chat-changes.tsx` | 队列操作/恢复与延迟构造的 workspace 变更列表 |
| `chat-goal*.ts*` / `chat-tasks*.ts*` | Goal 原生命令/状态呈现、任务窄投影与 Tasks/Changes 的唯一浮层 owner；实时生命周期仍归 state |
| `transcript-actions*.ts*` / `transcript-tools*.ts*` | 消息操作、历史恢复、工具详情和历史模型身份/耗时投影 |
| `transcript-body*.ts*` / `transcript-time.tsx` | 原始 content 顺序、Activity/工具组折叠及共享消息时间格式 |
| `transcript-materialization.ts` | Chat 所有的精简 Activity 双并发 exact-fill、失败状态与显式重试；虚拟行不拥有请求队列 |
| `speech*.ts*` / `ios/SpeechPlaybackBridge.swift` | Chat 单一朗读生命周期、消息操作、Host provider 路由及原生播放 |
| `native-auto-read*.ts*` | 设备偏好、权威正文完成 admission 与同一个 Chat 音频 owner 的自动串行朗读 |
| `history-*.ts` | 分页数据合并、唯一行投影、手势请求预算及显式消息定位；不补偿滚动 offset |
| `remote-desktop*.ts*` / `ios/RemoteDesktopBridge.swift` | 全屏原生桌面、手势/输入、JPEG 解码后 ACK 与恢复；认证传输仍归 RuntimeBridge |
| `appearance*.ts*` / `ios/AppearanceBridge.swift` | 单根 Host 外观同步、字体支持与版本隔离、原生 token 应用 |
| `transcript-body*.ts*` | 原始 content 顺序、真实 head/tail 的 assistant 行投影、Activity 与内部 process 工具两层折叠 |
| `ios/ConnectionStore.swift` | 原子 Keychain 连接存储 |
| `ios/RuntimeBridge.swift` | 同源请求、配对、凭据、事件流与连接生命周期 |
| `ios/RelayTunnel.swift` | P-256 / HKDF / AES-GCM 与 Relay HTTP/SSE/WebSocket 多路复用 |
| `ios/main.swift` | UIKit 生命周期及 NshAppView 装配 |
| `features-schedule-date.ts` / `ios/ScheduleDateBridge.swift` | Foundation 的 IANA 转换数据与验证；cron-parser 仍拥有 cron 解析和迭代 |
| `resource-web-preview*.ts` / `ios/ResourceWebPreviewBridge.swift` | 独立资源 HTML 内容预览；不承载 NSH 主界面，不注入主应用桥 |
| `scripts/build-ios.mjs` | NSH 字节码、Swift Host、原生 bundle 和开发签名 |

## Native design

- 与现有 `packages/ui/src/mobile/mobileTabs.ts` 一致：项目 → 助理 → 计划 → 设置。
- 聊天由原生 `NavStack` / `NavPage` 管理，UIKit 拥有标题、返回键和返回手势；右侧 slot 只承载操作。`NativeChatHeader` 仅用于 desktop/headless fallback。UIKit slot 有独立坐标根，`navigation.anchor` 提供真实 surface bounds，浮层不使用局部槽位坐标。原生 `List` 启用 `inverted`：只将分组完成的 body rows 复制后反序供布局消费，authoritative messages、各 turn 的 head/tail 与内部 content 顺序不变。屏幕上旧消息仍在上、新消息在下，初始停在最新端，短对话也贴底。移除正序 `maintainVisibleContentPosition`，由倒序 List 唯一拥有滚动；必须保留 `onLoadMoreAtStart`，在返回最新端时刷新 messages 域并启用原生离底阅读锚点。`history-scroll` 只授权每个向旧端手势最多一页；失败后手动重试，不因布局或请求结束重新授权。
- 四 Tab 使用 `nsh/mobile` 的系统 `TabBar`，聊天输入区域使用系统 Liquid Glass；代码不仿制玻璃的折射图层。
- Chat 与新会话的编辑器、`@`/`/` 候选各自只保留一个原生材质 owner（`composer-surface.ts`），编辑器和 List 透明，不以卡片底色遮盖玻璃。两种候选都位于输入框上方的 Overlay，不参与 transcript 布局。触发、模糊排序、图标和候选文本复用 Web 纯逻辑；`composer-reference-keyboard` 共用范围/Host CAS 与单一键盘 admission，Tab 仅插入、Enter/点击仅执行已接线的本地动作，IME/选区/失焦/后台释放候选与快捷键。
- slash 目录只在浮层挂载时派生，不截取前八条；读取失败保留现有候选且仅显式重试。当前本地目录仅有七个 magic prompts 与 `/model`，再合并 Host metadata 并排除 skill-source；Web 的完整本地命令清单仍未接齐，不能将同名 Host 命令当本地动作自动执行。`/model` 点击/Enter 即时打开模型选择器，Tab 只插入，之后按发送也只打开选择器且保留尾部草稿，不创建会话或发送模型请求。
- 原生主题读取当前 Host 的 canonical appearance，复用 Yuri 主题与基础文字亮度规则，映射 surface、interactive 和 status 色。旧本地 Storage `appearance` 不覆盖 Host；设置颜色模式写入 Host 后回读。失败保留有效快照并提供本地化重试；Host 切换清除旧覆盖。主动作保持中性实体按钮。
- `i18n.ts` 直接消费 Yuri 已有的十种语言字典；系统语言由 NSH `locale()` 提供。普通偏好使用 NSH Storage，连接凭据留在 Keychain。
- Bot 静态头像调用现有纯 `assistantAvatarSvg` 导出，保留已保存 recipe 的造型与颜色。TS 配置包含 DOM 类型以检查该共享模块的其他函数签名；客户端不调用它的浏览器渲染器。
- 系统听写使用 NSH `Speech`，结果留在草稿中，用户确认后发送；覆盖页面、后台及销毁会终止识别。它与现有客户端的自定义语音提供商配置是独立能力。
- 每个 Chat 创建一个 `createNativeSpeech`，全部 assistant 操作条共用，不逐消息读取语音设置。隐藏/后台停止播放，销毁释放 owner，开始听写前先停止朗读。Swift 持有认证与音频；browser 使用 iOS 合成，其余 provider 保留 Host 路由，不静默降级。恢复会重播当前段，豆包使用 Host MP3 而非 Web 直连流，逐词高亮尚未实现；真实合成/听音仍待验收。
- 自动朗读复用该 owner；设备偏好与当前运行状态分离，基于实际渲染的 body plan、`messagesResolved`、`historyGeneration` 和单消息 streaming authority 接纳未来完成的回复，不重播加载历史，不用 busy/SSE 状态猜流式。隐藏手动按钮不等于禁止显式开启的自动朗读。`speech.awake` 当前明确返回 unsupported，未更改 UIKit 全局 idle timer，不能宣称已支持常亮。
- 普通 Chat 不显示 Yuri 品牌头像或署名。模型标题归属整个 turn，不因后续 assistant 的模型/Agent/variant 变化重复显示；用户 shell turn 不画普通模型标题。模型依次取完整 assistant identity、完整 user identity、仅 pending/active 可用的 composer selection、session selection，不拼接两个来源的 provider/model。目录名称（数组或字典）与未知 ID 的人类可读格式复用 Web formatter；variant、Agent 优先级及已挂载 identity 保留同样区分。pending 标题一旦显示，跨 busy/idle 间隙保留，收到 assistant 后移交，不能借当前 composer 覆盖已知历史身份。
- 模型与 Agent 使用独立按钮及原生底部 Sheet；关闭的 picker 不构造目录行。默认 Agent 图像构建期生成，QuickJS 不加载 DiceBear 浏览器依赖树。
- 两入口 Provider 图标共享 Web `providerBrand.ts` 的 alias/Magpie 候选解析，Native 显式导入同一批 SVG 并按 Web 单色呈现，未知/失败回退 stack。variant 内联为 Default + 前七项，其余进入带返回/关闭的完整列表；标签共用格式化，搜索修改/清空撤销已展开的 effort。iOS 模型 Sheet 用系统 72%/98% detents，Diff 用 42%/72%/100%；grabber、拖关闭和滚动交接由 UIKit 所有，不再构造自定义 resize responder。iOS 15 回退系统 medium/large；非 iOS 保留原高度 controller 与纯 `heightSnapPhysics`。
- 当前行显示权威 variant（包括 Default），收藏/最近点击才优先仍有效的 remembered variant；普通 Provider 行不能借用收藏 variant。非当前模型读取本会话 Agent/model 偏好，新会话读取 Host `defaultVariant`。设备内偏好以 Host 为存储域、目录/会话为 MRU（最多 150）、Agent/model 为键，Default 删除该条，不替代 session authority；同域写入串行合并最新存储。新会话先保存本地 receipt，再写最近使用，始终不创建远端 session；本地/会话选择成功后偏好失败仅重试偏好，禁止重放选择或通过其它按钮丢失待重试操作。
- Agent 短按循环、长按打开 Sheet，长按松手不再次循环；四个已知 seed 的头像模板只替换当前 Host 的受控调色板。其它 seed 使用从同一共享 renderer 离线打包的真实 artwork，复用 128 项 / 1 MiB 有界缓存；局部 plain-data clone 在构建期绑定，不写全局 shim，也不把未知 seed 替换成其它 Agent。构建与边界见 `AGENT-ARTWORK.md`。
- JetBrains Mono 原始字体、OFL 和来源/校验清单位于 `assets/fonts/jetbrains-mono`；构建离线校验后注册 `UIAppFonts`。其他未安装字体明确报告 unsupported，不宣称等宽替代字体相同。
- 完整消息时间算法由 `packages/ui/src/lib/time-format-core.ts` 共享；Native 复用根同步的时间偏好，不为每条消息单独读取设置。QuickJS 与 UIKit 的实际格式仍单独验收。
- `transcript-body-model.ts` 将保留 nativeType/clientRole/parentID 的消息适配为纯 `ChatMessageEntry`，直接消费 Web `projectTurnRecords` / `projectTurnActivity`。相邻 assistant steps 不再按模型或恢复中的错误拆行；可见 notice/checkpoint 保留原序并分段，隐藏 synthetic instruction 透明。head/tail 和操作 source 仍是真实消息。原始 content 不改写，Activity 与 inline 的展示位置跟随外部投影；无 raw content 的旧联系人记录才使用旧字段 fallback。
- 整轮 Activity、内部 process/Skill 组和 Thought 分别折叠。所有同 turn 的可见 Activity 分段共用 Chat 所有的显式选择；live 普通 Activity 锁定展开且不画 header/rail。排队 user 不是前轮完成证据，后轮出现 assistant 才可将旧 active turn 结算；step 的 completed 也不是终态。已确认最终正文优先于滞后的 busy，让 footer/TPS/耗时及时出现。只将最后 assistant 的单个 trailing body 留在 Activity 外；结构化 inline 内容不吞入 Activity。`/compact` 隐藏命令 bubble，summary 即使没有工具也由可折叠 Activity 所有。
- 外层 Activity 与 Web 共用 `activityHeaderModel.ts` 的子会话去重，最多显示两个头像，计数包含全部去重身份；增删汇总读取所属分段工具快照。active compaction 保留禁用 header、锁定展开，结算后恢复折叠与耗时；普通 live Activity 仍不画 header。
- 仅已展开且结算的 Activity 自动读取精简正文，关闭/active 不触发补全。Chat owner 限制两条实际读取、去重并让用户展开/重试优先；失败跨行 remount 保留，不自动重试。隐藏/后台/Host 或 revert 边界使排队和结果失效，原生 HTTP 已发出的读取不宣称物理中止。正文以源对象 CAS 原位替换，不改变顺序/身份/终态；同状态/时钟的后续 slim 页面保留完整 input/output/metadata，变化则重新等待补全。正文 token 与草稿更新不启动全历史补全扫描。
- process/Skill 合并直接复用共享 helpers，Skill 名称优先级、最多三个名称与溢出计数相同。sorted 跨 display-adjacent assistant 合并，live 保留每条消息自己的工具组边界。Thought 的清理、纯文本摘要、自动展开与用户选择使用共享 `reasoningPresentation.ts`；历史默认收起，live 可自动展开，settle 不撤销已有展开，用户选择不被后续 streaming 覆盖；非 streaming 展开正文使用最多 320pt 的局部 Scroll。
- Host 的 `chatRenderMode`、`activityRenderMode`、`showReasoningTraces` 随根 appearance 快照下发，不逐行读取、不回写默认值。首个成功空配置的默认值分别为 sorted、collapsed、true。`NativeComposerSelection.onSelection` 只发布它已经读取的 selection authority，供标题 fallback 使用，不新增每行或输入时请求。
- 正文与工具输入输出使用 appearance role/code 样式。正文 `TextView` 保留 selectable、links 和 code-copy；shell 内联详情使用原生 selectable literal text，紧凑显示命令/结果，不把输出解释为 Markdown，不重复字段、状态标题与大复制区。不删截长正文 source，不用临时 skeleton 替换已收到的正文。尚未证明能跨不同 content part 连选。
- 工具 artwork/13–14pt 尺寸复用共享 `toolIconModel.ts`；16pt leading slot 内的 active 状态使用 12pt 九点波纹（与 Web 相同的 2400ms/delay），后台/失效/减弱动画停止原生 motion。只有 active Shell 维护耗时计时器，其它工具不显示计时器或重复 Running/Completed 标签。工具 title/description/icon 色由根 appearance 快照按 Web `cssGenerator` 的颜色混合规则解析，保存在 JS-only `toolTokens`，不扩张 Swift cssVars 白名单。
- 用户长正文仅在 `collapsibleUserMessages === true` 时按当前 appearance 的 10 倍 lineHeight 作 viewport 裁剪；内部 TextView 仍持有完整 source，以自然高度判断溢出，不按字符数删截。溢出时隐藏同消息附件；展开恢复附件并提供右上收起。展开、测量和附件隐藏按当前 row/part 身份隔离，替换 part 不继承旧 clamp。生产消费 appearance 单 root 快照的同名字段；快照未知时不猜偏好，也不逐消息发请求。
- NSH 0.4 的 `TextViewStyles` 没有 `document/listIndent` 字段；`transcript-body-markdown.ts` 使用支持的 list parts：有序/无序 gutter 19/18pt、item inset 1pt、marker intrinsic width、6pt gap 和 `.72em` 字号，不给整个正文补 inset，不改源编号。headless mount-frame 回归及 UIKit 确认 9–16 编号完整；marker tint、字重和精确密度仍待同状态对帧。

## Chat 浮层、历史锚点与发送反馈

- 所有直接半浮层入口统一使用 `NativeSheet`；iOS 以公开 `Dialog presentation="pageSheet"` 呈现，registration 只通过自身 responder ancestry 配置确切 controller。`isModalInPresentation` 与 delegate 在 UIKit 执行 pending 关闭保护。每代 root 一直保留到真实 dismiss completion，关闭中重开必须排队，迟到 generation 不得释放新代。系统容器不再采用旧 `popupStyle` 的固定高度、键盘 margin 或圆角；内容装饰仍保留。`AlertDialog` 继续使用系统 Alert/ActionSheet；`@`/`/`、Tasks/Changes summary 等锚定内容仍为 Overlay，不宣称已迁移成系统菜单。
- 新会话只保留一个系统 Sheet，不再外套透明 fullScreen Dialog 和窗口内 Sheet。业务 intent owner 保留 Agent/模型/项目切换、退出期内容与 active fence；通用 `NativeSheet` 拥有实际 UIKit 生命周期。三个真实 Input 的 AX registration 仍归 `NewSessionPickerOwners`，旧专用 presentation owner 已删除。系统 Select 保留搜索、分组、清除和自绘行；仅真实呈现完成后接纳键盘/点击，支持上下、首尾、翻页、Enter/Space、typeahead 和 Escape，IME composition 时释放导航绑定。
- `chat-chrome.ts` 复用 Web `mobileComposerSwap.ts` 的意图/返回区/pin 规则；滚动事件 O(1)，相同帧不发布。Header 与唯一 expanded Input 仅做 transform/opacity；compact 胶囊恢复同一编辑器，不复制草稿。输入 focus/键盘、录音、附件与已打开业务面板 pin expanded。Composer 是底部 overlay，倒序 List 的 header 保留实测 expanded 占位；收起不缩放 List 视口、不写补偿 offset。返回最新通过唯一 List ref 的 `scrollToIndex({index:0, viewPosition:1})`，不使用会到旧端的 `scrollToEnd`，也不再重复扣除占位。UIKit 载体证据与未验项见 `SYSTEM-SHEETS-VALIDATION.md`。
- Composer Changes 用锚定 summary 的原生 `Overlay`，不参与 transcript/composer 的父布局。文件行只在展开时构建；刷新失败保留快照和浮层内重试，已有快照时关闭不另插错误行改变视口。外点和取消均关闭；具体 diff 继续交给独立 `NativeChangesSheet`，不能把尚未打开的共享 Sheet 初始化当作取消 workspace 初始读取。
- `history-rows.ts` 为每个 Chat 持有有界的上一轮投影，`nativeBodyRows` 跨更早页扩展 assistant run 时保留已挂载 key，head/tail 仍是真实消息；未变行复用引用，权威边界拆行不得产生重复 key。HTTP no-op 也保留数组/记录引用。旧历史加载/失败/恢复入口放在倒序 List 的 footer 内，不因分页完成改变列表视口。`history-scroll.ts` 仅管理分页意图，原生 List 仍是唯一滚动 writer。
- 发送与停止复用手机端单一 32pt 触区：可发送时为 24pt foreground 实底圆盘，background 箭头占 56%；提交中仍保留圆盘、50% 加载图标。可停止且草稿/附件为空时同位置改为实底圆盘与 38% 实心圆角方块；有跟进内容时恢复发送。空白且空闲时才显示 16pt 禁用 ghost 纸飞机，不改变既有发送、队列和停止协议。
- `history-layout.test.ts` 必须显式 `NSH_HISTORY_IOS=1` 在 UIKit 运行：真实拖动触发第一页，再连续采用八个延迟页面，每页测量 30 次阅读行位置，限制 1.1pt。NSH 0.4 headless `measure()` 与 UIKit 倒序补偿几何不同，不能拿 headless 的该测量代替设备结果。此 fixture 使用变高文本行和生产投影/意图模块，不等于真实 Host 全量 Markdown、晚到图片或持指中分页的验收。
- 独立 `history-uikit-fixture.tsx` 无连接/Keychain/业务桥。录像逐帧结果见 `HISTORY-VIDEO-VALIDATION.md`；合成数据通过不代替生产 Host。搜索结果携带 exact messageID 到 Chat，`history-focus` 串行读取 opaque 页并对所属真实 row 发一次 List 命令；失败显式重试、回退隐藏和 exhausted-not-found 分离，不能跳 tail 假装找到。超高 grouped row 内部精确文字落点仍需 UIKit 验证。
- workspace、项目入口与历史工具 diff 共用 `NativeChangesSheet`，不再保留项目专用 Markdown diff 页面。历史 source 带所属 session/message 与工具快照，绝不改读当前 Git；打开安全资源预览前关闭 Sheet，targetLine 使用原生源码行 List。暂存/还原/提交等写动作只在用户明确选择和确认后执行。
- Sheet 的代码差异直接使用 `nsh/base` 的 `DiffView`（unified、词级高亮、源行号、3 行 context）；不再为 patch 建手写逐行 List，也不把 before/after 画为两个代码块。diffing/可见行构造/横向滚动/context 由内置组件所有；JS 仅在 diff snapshot 更换时解析导航行号，不在滚动事件反复扫描 patch。NSH 0.4 patch ref 的 reconstructed-text 偏移需通过 `nativeSourceHunks` 还原为源行号，预览仍使用一基源行。初始 targetLine 定位到内置组件提供的对应或最近 hunk，不保证超长 hunk 内的精确目标行；此处仍是与原行级跳转的已知差异。
- 工具 patch 别名归一为 apply_patch；多文件工具把全部同次历史文件带到 Sheet，back 后可逐文件切换，不回读当前 Git。显式空 before/after 是有效干净快照，不能冒充缺失历史而查询 Host。刷新失败保留现有 diff；异步原生 ref 受 snapshot/页面 fence 约束。
- Projects 的目录注册、全局搜索、归档入口与新工作树路由由 application 接入；设置中的 Bots 进入 `AssistantSettings` 而非聊天列表。Bot/计划页面收到实际 nav 顶层 active，覆盖页和后台不继续刷新；已确认写入的 `schedulerSynced:false` 不能重放创建或删除。
- Projects 的待回答/待授权由唯一根 `observeRuntime` 聚合读取 live Location 的 form/permission，初次激活及重连先读权威快照，按 Host/generation、目录和 request/session 身份处理事件；失败保留 prior 并标记未知，不把失败当空集合。查看会话只清未读，不解除实际阻塞；行沿用 Web 的 question → permission → running → unread 优先级，不拥有请求或新流。
- Projects、项目、工作树和 Chat 菜单的新会话入口打开 `NativeNewSessionPage`，不能在打开页面时创建服务端 session。目录注册的主要添加动作进入该草稿页，快捷添加留在注册页。首次发送先持久化稳定 inputID、创建 receipt 和完整附件/引用/选择快照，完成 staging 后再 replace 为 Chat。`new-session-admission` 在 Chat 活跃后只自动尝试一次；未确认需显式重试，源清理失败不得重放已 admission 的命令。销毁等待发送 flight 后释放 source owner，临时覆盖不释放。创建结果未知只能显式绑定已核验的空闲空会话，不重复 create；详见 `NEW-SESSION-VALIDATION.md`。
- 新建 Bot 的目录、模型、variant 与 Agent 上下文仅由实际活跃 Chat/新会话 composer 发布；根装配持有一份 generation-scoped 只读投影，打开编辑器时捕获副本。没有发布过选择时保持未知，不能从首项目、recent 或消息历史猜测。Host 代际变化后旧投影不可用；Bot 默认值仍由 `features-bot-defaults` 按 Host 配置与实际选择优先级解析。
- 设置中的项目页直接由 `SettingsProjectsPage` 所有唯一 `NavPage` 与 dirty 返回保护，不外套第二个导航页。其它 Settings 收到真实顶层 route active，并传给 Voice 模型 manager；覆盖页/后台停止状态轮询，恢复只重读，不重放已确认的下载或删除。
- 设置路由携带打开动作捕获的实际目录；Chat、项目、工作树及搜索进入的二、三级设置持续继承同一上下文，不猜首项目或最近目录。搜索中的设置首页使用独立原生导航页且不重复内容标题；全局 Tab 没有上下文时保留全局语义。归档预览携带该条会话自己的目录；恢复走 Host `PUT /api/yuri/sessions/:id/archive`、`archivedAt:0` 并验证返回身份/目录/归档状态。写入确认或结果未知后读取失败只重新读取，不盲目重放恢复。
- 连接列表的重命名/编辑通过独立原生导航页打开；成功的元数据保存只替换 `app.connections`，不写当前 transport authority，不触发重连。跨 origin/Relay 的改变必须显式重新授权，提交携带原 ID/version；仅原生返回 `runtimeInvalidated:true` 才重建当前 Host。编辑器与重新授权共用系统导航，不保留已失效的旧 version 表单。
- About 只挂载 `SettingsAbout`，版本各有独立 authority，未知不拿另一个版本补位。Host 更新必须重新读取精确 plan 并显式确认，未知 POST 只 GET 核验、不重放。唯一根 runtime sink 同时交给通知与诊断；诊断默认关闭，只保存有界匿名结构事件，JS 与 Swift 双重白名单，不存正文、目录或凭据。Host 失效取消并清理分享租约。NSH 签名发布、可信客户端更新渠道、验签与安装/回退仍未完成；具体合同见 `tests/settings-about-contract.md`。
- Sessions 清理设置复用 Web 的候选策略，并由唯一 Host-generation 根持有偏好、候选扫描与恢复记录。当前上游删除会中断运行并递归处理 child，未提供覆盖全部 OpenCode 客户端的原子资格检查或持久操作回执，因此核心阻止自动、手动和失败重试清理，scheduler 不启动 timer；偏好保存、扫描和已确认结果的只读核验仍可用。此安全门不是清理完成，不能以用户确认、Host capability 声称或本地锁解锁。
- Goal 的唯一 authority 是 `createChat().goal`，UI 只 observe/present，不再创建 controller；typed/armed Goal 先于普通 queue 分流到原生命令，不画普通 authored/inbox 项。命令未知结果保留 journal 且不重播，ACK 后 GET 失败只刷新读取。`chat.tasks()` 在 tool/权威历史边界更新，正文 token 与输入不扫描历史；busy 仅影响 live glyph。Tasks/Changes 展开共用一个 Chat 本地 owner，隐藏关闭两者。
- QuickJS 的 Intl 没有完整 IANA 数据。`schedule.dateContext` 从 captured Host scope 取得 Foundation 真实 offset/transition 表，JS 校验后将其作为 Luxon ZoneLike 交回现有 cron-parser；不切 UTC、不手写 cron 算法，也不猜范围外 offset。运行预览只在四个真实结果和格式化均成功后显示，失败保留完整异常链。该桥是只读本地计算，不创建或修改真实计划。
- 远程桌面使用独立全屏原生路由，关闭回到原 Chat/Tab。Swift 使用 captured Host/generation 的认证直连或同一授权 E2EE Relay WS 子流；JS 不持有 URL 凭据。JPEG 在真实 Image 解码后 ACK；此兼容路径不等于 Native WebRTC 完整能力已还原，真实 direct/Relay-only 和设备输入仍须分别验收。

## Wire contracts

完整 context overview 的生产接线合同与验证边界见 `CONTEXT-USAGE-VALIDATION.md`。`model.ts` 的 `contextRaw` 保留实际接收记录，`contextContent` 只保留初始 content 引用以识别后续正文覆盖，`contextOrigin/contextLive` 区分 GET 与部分 stream authority。统计复用共享纯 normalizer，不从瘦 `Message.tokens` 补 input/cache/cost。source adapter 在打开和结构变化时读取当前已加载窗口；`createChat.observeMessageCommits` 从原 writer 发送 snapshot 或单批已采用的 touched rows，不增加消息请求、SSE、polling 或逐输入历史扫描。未收到的指标为未知，失败保 prior；raw JSON 保留实际字段，stream/exact-fill 覆盖以明确的 `received/currentContent` 结构展示，不冒充完整上游 wire。

`ContextUsageRoute` 校验实际 Chat 的只读 `messageScope`，只在 overview 前台订阅；暂停取消订阅并 fence metadata 结果，恢复先重建一次 loaded-window snapshot。route 直接只读 session/catalog，显式 Retry 如遇消息读取失败，只委托原 Chat 的 `load(false, ['messages'])` GET lane；不新建消息 transport。统计 owner 同步处理全部 commit，UI 只消费 revision，不会因 signal batch 丢掉前一个 patch。

`chat.active` 仍是显示/交互 authority；`chat.syncActive` 仅为实际导航栈保留的同一个 Chat，在搜索、所属会话切换器与 overview 顶部时保活，不搜索其它历史路由或启动另一 Chat。main 在一次 batch 内更新两者，原同步 owner 仅订阅稳定的合并 demand；搜索→overview→Back 不重开 stream/poll。原 composer/Goal/audio 的 `active` 消费不变；send/command/stop/inbox mutation 与 Goal 核心也拒绝非显示态操作。observer 的 GET 通知晚于 resolved 更新，失败保留 prior，`hasGap` 未采用的新行不会作为 patch 发布；零监听不构造 patch 数组，销毁/Host 退役清除监听，回调异常隔离。快捷键按 Web 默认 `mod+p` 搜索、`mod+b` 会话切换；iOS 上需要外接键盘，不能宣称为触屏入口，也不增添 Web 没有的 header 按钮。

overview 颜色由同一根 `appearanceFromSettings` 解析出的 JS-only `contextUsageTokens` 提供，包含真实当前 Host（含自定义主题）的 `primary.base/status.warning`；不把 NSH 中性按钮 primary 当图表强调色，也不读取默认另一个主题兜底。没有扩张 Swift override 白名单；根 authority 未知时不虚构调色板。

NSH QuickJS 不运行 React runtime，也不能直接挂载现有浏览器 SDK transport。`runtime.ts` 是明确的 native SDK gap：逐条保留当前 Host shallow proxy 的 method/path/query/body，由 Swift 注入 Authorization。后端无需新增或重解释这些协议。

协议依据：

- 会话目录：`packages/ui/src/lib/session-index-api.ts`。
- 会话历史：`packages/ui/src/sync/session-projection-api.ts`，20 条 newest-first 页面，`cursor.next` 保持 opaque。
- Activity exact-fill：`GET /api/session/:sessionID/message/:messageID?directory=…`，Swift 统一认证；支持 native content 和 legacy info/parts，核对 message/session 身份，仍 slim 或缺失 parts 明确失败，空 parts 才是成功空输出。`slimActivityPart.ts` 是 import-free 共享判定，不把 task/render 依赖带入 Chat/picker。
- 工具正文/时钟：复用 `packages/ui/src/sync/session-tool-content.ts` 的纯映射；OpenCode 2 `state.content` 文本叶优先于 legacy output，顶层 `time.ran/completed` 是执行耗时 authority。NSH 只在没有顶层 time 时保留旧 state.time 兼容。
- 发送/队列/停止：`packages/ui/src/sync/session-prompt-api.ts`，`POST prompt` 使用稳定 ID 与 steer/queue；inbox 不伪装历史消息。
- 权限/表单：`packages/ui/src/sync/session-permission-api.ts` 与 `session-form-api.ts`。
- Bot 使用 `/api/yuri/assistants` 及独立 contact messages，不能按普通 session 读取或发送。
- 计划任务使用 Host `/api/projects/:projectId/scheduled-tasks`；`schedulerSynced:false` 是已写入但同步未完成。
- 文件读取使用 `/api/fs/read` 的文本响应；Git diff 使用指定文件的 `/api/git/diff`。

## Lifetimes and failures

连接切换使用 generation fence；旧连接响应不得写入新页面。请求和事件的凭据在 Swift 解析当前选中连接后注入，不在 JS 缓存 endpoint/token。失败刷新保留上一份有效快照，失败项目的计划任务保持可见。

只有前台、当前聊天运行 4 秒 safety poll。SSE 合并相关事件、按资源刷新，输入草稿不触发请求或全局列表派生。隐藏聊天通过 `active` 停止同步；切换 Host 或进入后台时释放事件流。

发送未知结果保留相同 message ID、文本、delivery 与附件快照，先 reconcile 再重试。失败不丢草稿；后续用户编辑不会被较早请求清空。联系人 generation 变化时清除旧历史，不跨 reset 合并。

引用与文本由 `createChat.setDraftText` 原子编辑，`insertReference` 确认后才具有结构化语义。草稿和未知发送各持有独立的 scope/sidecar 快照；失败重试不得借用当前新草稿。Bot/Shell 不支持的引用在核心明确拒绝，不能静默丢弃。输入不触发网络读取；候选查询只在 picker 存在时运行。

队列取消未获权威确认前，不允许将编辑项重新发送。草稿恢复失败与写入失败分开重试，保留当前输入。Git status 失败不等于干净仓库；展开刷新失败保留前次列表，关闭时不构造每文件行。

原生凭据只存于当前设备 Keychain；扫码/深链只填充待确认连接，不自动兑换。HTTP redirect 不转发 Authorization。配对兑换的一次性 secret 不写普通 Storage、日志或仓库。

## 完整验收范围与当前缺口

| 能力 | 当前实现方向 |
| --- | --- |
| 四主 Tab、原生导航、深浅色、多语言 | NSH 原生控件 |
| 连接与配对 | 原生网络、Keychain、相机 |
| 项目/会话、真实历史、消息、队列与停止 | 现有 Host/OpenCode 2 协议 |
| 模型/Agent、权限与问答 | 原生选择和交互控件 |
| Bot、计划任务 | 独立 contact 协议、原生编辑器 |
| 文件目录与文本、Git 文件 diff | 原生列表、TextView 与内置 DiffView |
| 会话照片/文件附件 | 原生 picker、摘要校验与原生上传；Bot 附件尚未开放 |
| 第三方 Solid/DOM GUI 插件、Eficy 执行 | 尚未原生迁移，不能声明兼容 |
| 远程桌面、交互终端、自定义语音提供商、APNs、Widget、Share Extension、OTA | 尚未与现有移动客户端对齐 |

表中尚未对齐的能力仍属于交付范围，不是可删减项。只有检查过的测试、构建和设备行为可以作为验收证据；headless 通过不代表 UIKit 布局、真实 Relay 部署、生产 Host 或相机/通知验证完成。Chat 的逐轮证据与视觉差异见 `CHAT-VALIDATION.md`。
