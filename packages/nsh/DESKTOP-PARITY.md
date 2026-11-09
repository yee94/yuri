# NSH 桌面对齐账本

> 实施中，不是完整验收或可发布声明。代码存在、headless 通过、AppKit 专项通过、生产 Host 联调和 Windows 实机验证是不同证据，不可互相替代。

## 目标与依据

- Mac / Windows 主界面使用 NSH 原生后端，完整对齐主工作区 Web 桌面的能力、UI、UX、异常与恢复，不按 MVP 删减。GUI 插件本轮暂不纳入；独立浏览器/终端内容容器不等于主界面 WebView。
- iOS 行为继续保留。`HANDOFF.md` 的移动阶段缺口不能被桌面构建或新测试自动关闭。
- NSH 基线为 0.4.0，源码 revision `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`。依据 `website/modules/nsh-desktop.md`、`website/elements/resizable.md`、Input/Editor/DiffView 以及对应 Rust 实现；不猜较新版本 API。
- Web 权威来自 `packages/ui/src/components/layout/{MainLayout,Header,TitlebarLeftControls,ContextPanel,RightSidebarTabs,BottomTerminalDock}.tsx`、`components/session/sidebar/DOCUMENTATION.md`、`components/views/{FilesView,DiffView,GitView}.tsx`、`components/sections/SettingsView.tsx` 和 `lib/shortcuts.ts`。旧审计行号不替代当前源码。

## 当前最高优先级：真实 PC 像素对比

用户已明确否定现有设计的还原程度。此前功能/headless 证据不能作为视觉完成声明；暂停自拟界面扩展，以同尺寸、同状态真实 Web 与原生窗口的并排/叠图逐区纠偏。当前 Web 参考和精确几何已取得，整个 App 的开发 WS 大包阻塞已解除，但 macOS 确认处于锁屏，真实窗口未激活，尚无有效的新会话原生对照图。不得绕过生命周期或用连接页/headless 替代。具体证据、fixture 限制和接续门槛见 [桌面像素对齐账本](./tests/desktop-pixel-parity/README.md)。Mac/Windows 视觉均未签收。

## 对齐范围

| 区域 | 当前代码与证据 | 尚须完成 / 验收 |
| --- | --- | --- |
| 窗口与 chrome | `desktop*` 原生窗口、控件预留、拖动区、应用菜单、编辑 role；独立 headless 合同 | 标题栏逐项布局、真实菜单优先级、拖动/双击/全屏、Windows snap/读屏；多窗口、Mini Chat、固定、路由/bounds/Host 恢复、深链、托盘、缩放、客户端更新 |
| 主工作区 | 原生 `ResizablePanelGroup` 三栏；260–500 侧栏、300–1400 工作台、350 主内容最小宽；失败保有效布局 | 同状态视觉、拖宽/焦点、减弱动画、展开/恢复；底部 dock 与完整窗口恢复 |
| 无目录页面 | `panelAvailable` 与保存的 panelOpen 分离；窄窗口连接页生产 App 回归 | 所有无目录一级/二级页与窗口 resize 实测 |
| 项目/会话侧栏 | 复用 Projects controller；分组、折叠、置顶/进行中、More、重命名、归档/撤销、失败保留、Host fence；根/AssistantHome/index/attention/live execution 权威投影已接；树缩进、hover reveal、文件夹直接动作、完整分页归档删除已实现；模态不卸载 controller/rename 草稿 | 批选/完整拖排、分享/导出、统一后台任务/设备区的所有状态组合与真实系统验收；真实后台 shell aggregate 缺源时保持未知 |
| 新会话 | 780px 桌面 composer、welcome、明确项目/工作树/模型/Agent 选择、原 durable/admission；canonical GET→verified native ACK 后才构造 source；同目录重复打开保可写草稿；resolve/acquire 等待期接根 mounted guard，ACK 后原 source 接手；鼠标距离激活、折叠 AX 准入、组内拖排/悬停删除和移动长按分流已接实际根 | Folder 最新已知为 8/10：旧 Engine 仍持 writer 时第二 Engine 重开被正确拒绝，尚无 crash/unknown durable resolver，不能宣称冷恢复成功；上游无 CAS/operation receipt，unknown membership 不自动解除或重放；Windows 触屏来源、真实附件/听写、同状态 Web 对帧 |
| Host/草稿隔离 | 首页按 Host 身份重挂；稳定 JSX owner 修复首次激活失活；同身份续 lease 保稿、同 ID 换 origin/授权隔离；切换和 direct connect 收尾走 system reset，不覆写新 Host 记录 | 真实重新授权、断网/休眠/恢复、原生存储失败、多个窗口并发 authority；headless 不证明真实安全存储 |
| Chat | 复用原消息/Activity/history/queue/Goal；桌面布局 slots 保留唯一 Input/List/handler；正式 native writer ACK 后才构造原 Chat，state/transcript 共用 grant，同身份 renew 保稿；本地 commands/Timeline/compact 已接原 owner，unknown 只读核验不恢复写权；嵌入 read-only Chat、独立 verified stream、完整 Context 与 BTW 已接实际根；正文 exact-target 文件引用留在 parent 工作台；retained Header 接 bounded metadata、显式 quota family/pace、visible MCP、唯一 GitHub status 与 committed Instance/根导航 ticket；WorkStatus 接原 Chat 窄源和 exact child live observer，有失败 prior/resize/50 输入证据 | 全量视觉/hover/快捷键/选区；OpenInApps 无可信本机目录 mapping，仍不允许打开；MiniChat/SSH Connect/更新真实 admission、quota-mode mutator、WorkStatus attachment/后台 shell authority、滚动/晚到内容/大历史；NSH 无公开选区读取/custom action，不能伪造 quote；原 HANDOFF 未签收项仍未签收 |
| 输入键盘 | plain Enter 发送、候选优先、IME/失活门禁；AppKit 专项证明 Shift/Alt Return 只换行 | 真实输入法与读屏、Windows 原生物理键盘、clear/autocomplete 整体 AppKit 回归。NSH 0.4 headless 丢弃 Return modifiers 的驱动差异不能用生产补丁迎合 |
| 工作台标签 | Host＋稳定授权身份＋会话＋目录隔离、去重/选中/关闭邻居回退、20 scope LRU；原生单行 strip/拖排、唯一 dirty guard、metadata 恢复/显式失败重试已装配；关窗 flush，冷恢复先于空 scope 初始化；冷 buffer 可恢复 absent metadata，live owner 优先 | 物理中键、Windows 普通 View 焦点、8 类 tab、历史 diff durable resolver、嵌入会话导航/任意 URL Preview/BTW；完整窗口视觉/拖宽/焦点仍未签收。metadata 不等于文件 journal durability |
| 文件树/编辑 | 原生 Editor、Host 保存、dirty/unknown 关闭保护；native private journal 已装配，缺 capability fail closed；启动等待 snapshot、保留 dirty/unknown owner 的导航与关窗销毁分离；同身份 lease 续期保稿、新授权分区；stat/read 失败不重放未知 POST；Windows drive/UNC/根目录合同 | 真实崩溃/安全磁盘恢复与 Windows 持久性、文件右键 CRUD/复制/下载/Reveal、隐藏/ignored/search/展开全部、完整状态点、真实大文件与媒体。Host 无 CAS，前后读不等于原子冲突保护 |
| Diff | 原生 `DiffView`；workspace/staged/历史 source 隔离；1100 dynamic 阈值、inline/split、wrap、原生选行、复制、打开编辑器、错误/重试与失活门禁已实现；多文件真实 panel adapter、唯一 reader、M/M 正文失效、隐藏 scope 延迟读取与逐文件偏好已有生产回归；单一设备偏好 owner 接 root Settings/工作台及 Storage API 关窗屏障，显式 single-engine 才可写；Chat/项目 Changes presenter 接同一 mounted guard。版本锚定上游补丁已提供 `viewport:'parent'`、自然高度和祖先可见窗口，consumer 接线及最终验证进行中 | 原 180–720pt 内滚的替代方案尚未完成产品验收；须以最终 prepared digest 重跑完整 source、400/12,000 行预算、单外层滚动、wrap/resize/hunk/选区及真实滚轮。完整写操作/图片 diff/selection comments、缓存字节上限/选区回收/长时内存和 Windows 绘制仍未签收 |
| Git | 已接真实原生 Git rail：stage/unstage/restore、提交、分支、同步、stash、历史/图、冲突/操作状态；串行写 lane、未知只读核验 | 目录/批量/hunk、AI 文案/Gitmoji、身份/PR/worktree repair/integration/冲突交 Agent 等继续补齐；生产 Host 与真实 Git 写入未验 |
| 设置 | 原生 Dialog、私有导航、真实 dirty/pending/picker owner；Provider/Agent/Command/MCP/Plugin/Skill/Projects/Magic 共用列表＋详情 split；Usage 使用真实 Web 专用偏好/Magpie/Provider 响应式网格、实际 App 8场景；通知 mode 与同身份恢复、防迟到 ACK 已接；根保留稳定 SSH loader/Retry/唯一 connection-only controller，六个 native grants 已入 manifest；Diff 本地字段不写 Host | Bots、全部字段搜索准备/高亮与配置 consumer 继续核对；SSH 真实系统行为与同步尚未签收，sync unsupported 保留入口但禁止派发；Diff 的 Storage API ACK 不等于 fsync/跨 Engine 协调；通知模板、同状态视觉仍未签收，不得隐藏入口 |
| 终端 | 独立原生叶子承载离线 Ghostty renderer；dock、controller、多 tab 与窄 shortcut owner；Host direct WS-v2/replay/未知输入不重放已有合成网络证据；URL callback 已装配 | 真实认证 PTY、完整 actions/分栏/选择/剪贴板、物理焦点、系统字体/拖高/展开/关闭与恢复；Windows target/runtime 与 Relay。详细合同见 `terminal-desktop.md`，不拿合成网络替代生产 PTY |
| 浏览器/资源 | 原生 browser pane、单一 desktop-browser identity 与旧 URL-key metadata 合并；不同 URL 原位更新，空 Header 入口保目标/地址稿；verified native receipt 经真实 JSX 回写 metadata，旧 owner/lease/模态拒绝；实际 Chat 链接 A→B 和 Header 重开已验；终端 preview factory 复用 URL admission，Host loopback 留在 Host proxy tab | 真实 Host proxy/同 tab 导航/cookie 与系统效果；下载、媒体及全部资源呈现，Windows target/实机；不能将 tab 打开成功当作页面已加载 |
| Rust Host | 产品已迁入唯一 Process/原 Vault lane/单 SSH dispatcher；HostChannel＋安全凭据＋HTTP/SSE/stop、direct 编辑/version CAS/重新授权、appearance/resources/附件、private journal、PTY WS-v2；window kernel/geometry/close-Quit barriers、stable journal/catalog namespace、native writer acquire/release/renew 与双 HTTP gate 已装；TS Chat/新会话已消费正式 writer，同身份续租实际根保稿；Quit 等真实 Process stopped | 第二个生产可写窗口、assistant backing-session alias、全局 Store process-singleton 与完整 final-close/cold recovery 仍未闭合；MiniChat/tray/deep-link/恢复失败 UI、配对/Relay、语音、Windows target/SDK/实机、真实下载/SSH/HTTPS、睡眠/唤醒、签名/更新/回退未验。以 Host owning 文档为准，不把双 Engine harness 当生产多窗 |
| 快捷键/命令面板 | 共享 registry/覆盖/设置页、菜单有效 accelerator/单物理键、原生 Dialog 五域搜索；独立帮助 Dialog 共用 Web catalog，保留 aliases/leader remap/不可用项；搜索/设置/帮助不 pop 产品路由 | 完整本地命令目录与真实 consumer 接线、composer/terminal 全动作、真实改键/冲突/leader、IME/焦点与 AppKit/Win32 物理键；headless 不证明系统菜单键行为 |

表中未完成项仍属于原始范围。GUI 插件之外，没有因实现困难而缩减功能。

助理/计划主页已选择各自 desktop presentation；助理对话 slot 已装配实际 contact Chat，计划列表/历史已装配唯一 TaskEditor 右面板。非空 Bot 的逐联系人草稿及模态保稿已有两平台真实 App 根验证；计划根新增同任务不重挂、切任务/History/侧栏/新会话的 Cancel/Discard、模态保稿、pending/unknown、unsynced 确认写，以及过期 native ticket 与异步 flush 后再编辑的最终 veto。它们是合成 Host 下的真实 NSH headless 根，不等于 AppKit/Win32 系统窗口、真实 Host 或视觉签收。

现有 Web `session-worktree-store` 只在显式创建流程写入进程内 attachment，没有跨启动的 session→worktree 只读 authority。目录 catalog、session location 和 `/api/worktree` membership 均不足以拼造 canonical attachment；`canonicalize-worktree-state` POST 还可能写 `.git/opencode`，不得自动调用。当前缺源继续记为缺口，不用假 null/loading 或按路径猜测解锁门禁。

## 当前可重跑验证

从仓库根执行，`NSH_BIN` 与 `NSH_RUNTIME` 必须指向同一 verified prepared digest 的 patched CLI/runtime（详见 `patches/nsh-0.4.0/README.md`）：

```sh
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
NSH_BIN=/path/to/prepared/tools/bin/nsh NSH_RUNTIME=/path/to/prepared/tools/runtime bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-application-native.test.ts \
  packages/nsh/desktop-layout-core.test.ts \
  packages/nsh/desktop-workspace-ui.test.ts \
  packages/nsh/desktop-keyboard-native.test.ts \
  packages/nsh/resources-model.test.ts \
  packages/nsh/desktop-window-close-core.test.ts \
  packages/nsh/desktop-settings-root-core.test.ts
bun run --cwd packages/nsh desktop:check
bun run --cwd packages/nsh desktop:test
```

`desktop-application-native.test.ts` 是包装测试，内部执行生产 `App.tsx` 的 Mac/Windows headless 场景，不是真实 OS 场景。覆盖桌面分支、同目录草稿 owner、窄窗口连接表单、搜索目录、Host 切换、设置保稿、跨目录归档预览、搜索模态保产品 owner、原生关闭 ticket 的取消/批准。所有记录合成，不接真实凭据或发送模型请求。并行新增代码期间必须重跑；之前通过不能给后续源码背书。

正文链接/BTW/文件夹 checkpoint 接线批次：五文件 126 项通过，其中 commands wrapper 内部为两平台 50 场景；覆盖实际文件打开/复制、跨目录 embedded own-target、Host loopback 内置 tab、BTW 只读模型名与关闭/重开清侧聊、原 writer/附件/主流隔离。另一个同轮广回归 App/Navigation/Git/commands 四文件 28 外层项通过（发生在新增六个链接场景前）。整包 tsc 与生产 `nsh:bundle` 通过；这些数字不可相加，也不证明 OS 浏览器代理真的加载了页面、实际 SSH 或 AppKit/Win32 视觉交互。

该批次后继续核对 Web `fileReferenceActions.ts:271–306`，确认跨目录文件应在工作台预览并收起文件树，而非离开主 Chat。现已完成 own-source file/preview tab 并在实际 root 消费：保持主 Chat/输入/附件，内容和 journal 使用显式来源目录，Host/authority/lease 不变；文件树原点击路径不收 rail。后续 commands/source-file/folder/starters 四文件 **29 外层项通过**，其中 commands 内部两平台 50 场景的跨目录断言已升级为保留主会话及真实 tab metadata，不再验资源导航 fallback。独立 source-file 的 dirty/unknown/close/冷恢复证据见 `DESKTOP-PANEL-CHAT.md`，不以 headless 代替真实 Host/系统窗口。

首页快捷项已分开桌面鼠标 distance >8pt 与移动触屏 200ms/6pt；拖动期间不读取目录或保存，释放使用真实最终位置/原生 PanEnd translation、异步测量归属于单次 gesture，只在 end 写一次。折叠行外项通过真实 layout 位置退出 AX/输入，展开恢复；桌面按 Web 保留加号和悬停删除，移动保留拖到垃圾桶。生产回调回归 **26 项**，实际 App root 的 Mac/Windows 四场景 wrapper 与该回归同轮 **2 文件/27 外层项通过**；覆盖拖排、悬停删除、50 次输入零附加读取与 Settings 保稿。尚无真实物理鼠标/读屏/窗口对帧证据；NSH 原始 touch payload 不区分桌面触屏与鼠标，Windows 触屏 delay sensor 仍需原生来源合同，不据此宣称所有输入设备已对齐。

真实 AppKit modified Return 专项：`nsh test tests/desktop-workspace/Keyboard.macos.test.tsx --target macos`（在 `packages/nsh` 运行；遵循 tmux 启动和复用规则）。本地专项日志不随仓库分发，也不证明完整 AppKit App 可用。

系统菜单 accelerator 专项：`nsh test tests/desktop-workspace/AppKitMenuAccelerators.test.tsx --target macos`。原 NSH 0.4 的 **2 pass / 1 fail** 保留为历史红反例：backend 小写 key equivalent 与 Shift 大写事件不匹配。项目内版本锚定补丁后，paired digest `7834…0f97e0` 的真实 AppKit **5/5** 通过，覆盖物理 `Cmd+Shift+K`、菜单优先级、改键/撤销、capture 与 Shift/Alt+Return；binary hash 前后核对一致，详见 `tests/desktop-workspace/AppKitMenuAccelerators.md`。headless、TS 重绑或菜单点击不能替代这些物理证据，后续 digest 仍须重跑。独立 synthetic Rust smoke 覆盖实际 AppKit 关闭拒绝/重试批准和原生外观/文本资源，不加载真实凭据。完整 App bundle 截图被 foreground gate 阻断；后续只读系统检查已确认锁屏，见上方像素对齐账本，不绕过 gate。Windows 实机仍无证据。

`bun run dead-code` 目前被主工作区现有依赖缺少 `vite-plugin-pwa` 阻断；没有补装依赖绕过。并行改动期间的 tsc 结果需在收敛后重跑，不能使用较早一次通过背书晚到源码。Windows headless 环境只验证 TS 逻辑分支，不能证明 Windows Rust/系统 API 编译或运行。

Header/Diff/WorkStatus 本轮生产根三 wrapper 同批通过；WorkStatus 内部是 Mac/Windows 各四场景，覆盖真实 retained Chat 的 tasks/只读 child、模态迟到、失败 prior 与 inline-overlay resize。Header 新增实际 provider family 的展开跨弹层/Settings 保留、marker/pace/成功时间与 50 输入零读取。整包 tsc 同轮通过；dead-code 重跑仍在 `vite-plugin-pwa` 缺失处退出 2。全部仅是合成 Host 下 NSH 生产树与操作数证据，不构成原生系统输入/帧率/材质、生产网络或全范围签收。

### writer / Changes 接线后的检查点

- 根唯一 mounted collector 已组合 Chat、retained new-session、pre-source 等待期与 Changes。普通导航按实际移除子集 release→ACK→commit；覆盖页/模态保 owner；Header Host switch 释放全体，Add 不 release。native close 仅 prepare/其他 flush/最终复验，不提前 TS release；拒绝后原稿继续编辑。
- Header/Git 根在修复 signal setter receiver 后 **2 文件、11 外层项通过**。完整 Commands wrapper 内部两平台 **50/50**；Navigation 旧的无目录直接编辑 fixture 已改为真实显式选项目，保留晚到恢复/401/换授权/flush 的原断言，内部 **56/56**（含新增等待期 4 场景）通过。
- Changes 两平台真实根 **20/20**；与 writer/page departure、native close、Header navigation、transcript 与 presenter 聚合 **7 文件、166 外层项通过**。独立多文件 Diff adapter 两平台 14 场景通过；tool-diff 为 **2 pass / 1 UIKit skip**。不同批次与 wrapper 内部计数不相加。
- 最新 Mac `desktop:build:debug` 完成 Rust 编译、链接、bundle 和 ad-hoc signing，保留 `__eh_frame section too large` warning；不是系统运行或发布签名证明。全包 tsc 通过；dead-code 仍缺依赖而中止，不报告零 unused。
- Rust 隔离重跑 binary 与 synthetic example **各 377/0/0**，显式 include-ignored 执行全部五项 bundle fixture，并为 SSH IO 使用专属临时根；两个 target 不相加。全 target Clippy、Mac binary/example build、Windows 三项 metadata frontend 与 geometry 5/5 通过，仍非 Windows SDK/link/OS 证据。完整环境见 `desktop-host/README.md`；后续 native 附件与 NSH 兼容补丁尚须再跑，旧数字不背书晚到代码。
- Assistant 主根 removal/disable/directory × clean/held-release/pending/unknown 的 **24 场景**保留。桌面 contact 已切专用单行 composer、逐消息 user/assistant/peer、真实 createdAt/头像分组/日期分隔；仍由原 Chat/draft/verified writer/唯一 inverted List 所有，Session/iOS 不启用。附件-only、原 ID optimistic、消息级错误与精确 retry、Settings 保稿、50 输入零附加读取均已接实际主根。卡片、可见已读正向、历史附件预览/下载、缩略图/粘贴/拖放、send-flight 和完整视觉尚未闭合。

### Assistant / 统一兼容工具检查点

- 同 digest `86fb08a597f2a5b0389f61cac1831a0f3bd55f46a54f35e006ab26269ff1cfe7` 的 CLI 与 runtime 五文件批次 **258 外层项通过**：`desktop-application-native.test.ts`、`state.test.ts`、`drafts.test.ts`、`desktop-assistant-conversation-native.test.ts`、`desktop-assistant-read-marker.test.ts`。其中主根内部 **78/78**；不与外层数字相加。已读 controller 的通过不是实际 App 发出已读 POST 的正向证据，后者独立验证中。
- Assistant lost-ACK 只读核验拒绝同 ID peer/assistant/wrong-assistant，exact proof 后 journal 失败保原 pending；不重放消息 POST、不清 native sticky unknown。明确 not-dispatched 才可用原 ID/附件快照重试，并保后来草稿；admission ACK 后 journal 失败保持 admitted、uncertain pending 和全局恢复，而不是可重投 failed 行。
- strict preparation 支持精确新增文件和 Shift→Diff 有序补丁、零 fuzz、完整 hash 链。合法 `src/image/cache/tests.rs` 漏复制问题已修；baseline **1,740 文件**、patched **1,741 文件**，新 paired digest `7834beffee6dc6dd588bee99f717366a37dca2282ceb53544b80734e800f97e0` 的 strict **66**、core **1,013**、base **930**、AppKit **80** 通过，14 项既定 ignored；parent viewport 新增 **8 项**通过，typegen/整包 tsc/缓存复验通过。旧 digest 未改写，后续 List/Windows 补丁尚未登记，不算本次工具已包含。
- 当前 digest 的真实 Shift/Menu 专项 **5/5** 通过；旧 CLI＋runtime 配对仍在原 `calls:3` 断言失败，保留红反例。Windows 通用按钮 Tab/ShiftTab/Enter/Space 缺口在原生层处理，独立卡片 Windows 键盘 skip 未解除。
- 当前 digest 的 Assistant 聚合 **11 文件、346 外层项通过**，含实际 App **84/84**，早于后续 scoped catalog 与 Web 对齐卡片导航改动。最新目录授权/state/model 三文件 **199 项**及整包 tsc 通过；新导航实际根尚待复验，旧数字不背书新导航。
- ContactRead 实际 App 两平台 **12/12** 中，10 项为 exact 已读 POST/原 grant/离底/迟到 measure/unknown 行为，另 2 项仅诊断短内容缺初始真实 frame，不能算短对话验收。Contact-only 16/32 横向、20/28 old-edge、48 latest-edge 真实几何断言通过；正向已读仍不替代原生 List 初始 frame 修复。
- SSH root 已共用 mutation/guard/snapshot/subscribe/refresh，Connect 仍 fail closed。native 正在分离后台连接 Ready 与显式 selected Host/authority；在同 ID credential 恢复与 health recovery 都不再暗中切换 authority 前不开放。最终选 Host 仍须原 writer release ACK 与 `connection.select` 事务，不以 Ready 取代选择确认。
- dead-code 最近重跑仍因缺少 `vite-plugin-pwa` 退出 2；未补依赖。Windows target/SDK/link/实机及整体 Mac/Windows UI/UX 签收均未完成，未提交、push 或发布。

### 锁屏期间的既有状态准确性收紧

- 原生 canonical 附件下载复用原 owner，实际桌面文件行已装配系统 chooser 的根模态保护。`ContactAttachment` 的两平台 headless **12/12** 覆盖显式下载前零 I/O、五十次输入、选择位置期间拒绝导航/关闭、unknown 只读核验、缺 capability 不降级、坏 descriptor、切联系人清理和换 Host 后迟到 status；细节见 `tests/desktop-application/ContactAttachment.md`。未打开系统 SaveDialog，不代表真实下载或视觉验收。
- 对照真实 Web 的 pending-send 抑制规则，只将原 contact processing 条件从 `busy || sending` 改为 `busy && !sending`，不装配暂停中的反馈 presenter，不移动 List header。四个真实根场景旧红新绿；完整 card **32/32** 和 App **88/88** 同轮通过。原 List header 与 Web overlay slot 的位置差异、send-flight/morph 和物理对帧仍未完成。
- 同一原生 ID/文件名/MIME 校验已收敛为 crate root 唯一模块，上传/下载只导入，main 与三个 owning examples 各声明一次；七文件 rustfmt check 通过，完整 native/clippy 复验另行记账。
- DevFrame 已解除整个 App 的大包加载阻塞；第五项 List 契约修复已严格登记。末文件定位和全文收起的滚动原因已有候选修复并通过独立树的 core pin 18/18 与 headless shrink 1/1，但补丁未登记、没有新 digest，两个 Yuri consumer 红灯仍在。详情见 `desktop-diff-DOCUMENTATION.md`。
- 这些改动不关闭真实 PC 新会话叠图、Mac/Windows 物理交互与原始全范围缺口；锁屏期间没有继续自拟布局。
