# Chat Changes：当前源码合同与验收交接

尚未完成手机端 1:1 验收。本轮只执行纯 Vitest、静态检查与 dead-code；没有运行 NSH UI 引擎、UIKit、设备、真实 Host、Git 命令、Git 写入或模型请求。下文的请求验证全部为内存 mock。

## 本轮重新核对的 Web authority

- `packages/ui/src/apps/MobileChangesSurface.tsx`：workspace 列表/单文件路由、独立 staged/working、服务器 `oversized` 延迟加载、同步/还原/提交、生成 subject/highlights；MobileDiffDetail 使用 `/api/git/file-diff` 的 original/modified、固定 inline 和 `wrapLines=true`。binary 与 image 各自显示 unavailable，不能把这里的图片对照或 wrap 开关当成必需功能。
- `packages/ui/src/components/views/git/ChangesPanel.tsx`：目录树复用 `changesTree`；header 的全部折叠动作作用于当前分组的目录，不收起另一组，也不代替分组 header 的收起。工具栏使用 contract/expand-up-down、node-tree/list-unordered、arrow-go-back；目录使用 folder-open-fill/folder-3-fill。
- `CommitSection.tsx` / `AIHighlightsBox.tsx`：生成中禁止提交，生成标题填入 textarea，highlights 独立展示，显式点击一次插入全文并清除建议。手机端没有 gitmoji。
- `packages/ui/src/lib/gitApi.ts`：先读取 magic prompts，最多 30 个文件/120000 字符材料，`POST /api/small-model/generate`；只有 404 才允许 fallback 到当前会话的 `session.generate`。后者只发辅助生成 prompt，不发送 chat、不创建会话、不 steer/inbox。
- `packages/ui/src/components/views/DiffView.tsx`：turn 的文件与正文始终来自所属 session/message；wrap 可切换，历史正文不借当前 Git。非 turn 的 full-files 切换不能变成历史 current-Git 读取。历史图片若已有 data URI，可显示所属历史的两侧；binary 仍优先 unavailable。

## 当前 Native 实现

| 项目 | 当前合同 |
| --- | --- |
| 系统 Sheet | `chat-changes.tsx` 使用 `native-sheet.tsx`；iOS 是 `Dialog presentation="pageSheet"` + `yuri.sheet.presentation`，detents 为 42%/72%/100%。UIKit 拥有圆角、遮罩、拖动与 completion。旧自绘 responder 仅非 iOS 使用。`popupStyle` 高度/键盘 margin 不支配 iOS 系统容器。 |
| 关闭与资源预览 | Changes 先以本地 closing 请求系统关闭，内容保持到 completion；关闭中停止业务回调 admission。`Sheet.onClose` 到来后才通知父 owner 清 route，再执行捕获的 preview callback；Host/后台失效不打开资源。主线程不能在关闭请求时提前卸载 Sheet。 |
| Workspace authority | `createChangesReader` 读取 status；失败保留旧快照，只有额外 `/api/git/check` 明确 false 才清掉旧 authority 并展示非 Git 目录空态；check 也失败时仍保留原 status 错误。单文件改为 Web MobileDiffDetail 相同的 `/api/git/file-diff`，必须有两个 string side，空字符串是有效快照，缺失字段是错误。双侧全文让内置 separator 可以展开真实上下文。 |
| 历史 | 只有非空、hunk 计数完整且含变更行的 unified patch、完整字符串 before/after 对或明确 binary 才是正文 authority。空/空白/无效/截断 patch、仅一侧正文均按原 session/message/file 补全；补全仍不完整则报错。`before:''/after:''` 是有效空快照；无效 patch 不得优先覆盖完整文本对。L3 与窄 legacy fallback 保留，不调用 `/api/git/*` 来填历史。多个同次工具文件可逐个返回选择。 |
| Diff | 内置 `DiffView` 消费 nullable canonical diffLayoutPreference：inline→unified、side-by-side→split、dynamic 按 viewport 1100pt 阈值和新文件规则；未知/无效只作 unified 显示回退。单文件顶栏对齐 Web：图标按钮为打开预览（不带行号）、换行、行内/并排切换。换行对 workspace 与历史文本 diff 都可切换；workspace 默认开启，历史默认关闭并按 `changes-diff-wrap-v1` 保存，读取失败显式报告且不覆盖已操作的值。布局切换只覆盖当前 Sheet 会话，不写设置。刷新、跳到首个变更、复制 diff 不在顶栏；加载失败时错误行提供重试，打开时仍按 targetLine 定位 hunk。没有新增历史 full-files Git 按钮。 |
| 图片/binary | workspace 与 Web 手机端一致为 unavailable；历史只渲染该快照已提供的 `data:image/*;base64,` 两侧，不把外部 URL/当前文件当历史图片。isBinary 优先 unavailable。外部 URL 型历史图片仍未闭合。 |
| 源码定位 | 完整文本 hunk 使用真实一基源码行；patch ref 的 reconstructed-text offsets 经 `nativeSourceHunks` 还原。打开 diff 时 `targetLine` 只能调用 NSH 公开的 `goToHunk` 到对应/最近 hunk；当前公开 ref 没有逐源行 scroll API，超长 hunk 的精确行落点仍未闭合。顶栏不再提供「在首个变更行打开」按钮。预览对齐 Web `openDiffFilePreview`，只打开文件、不带首变更行。 |
| 列表/目录 | staged/working 独立路径排序与目录状态；分组折叠独立；每组批量目录展开/折叠只影响该组。使用现有 Web sprite 图标，不再用 ≡/▸/↶ 充当 toolbar 图标；加减仍按 Web 为文本。文件类型 artwork 尚需共享 Native primitive，当前文件行仍是通用 file-edit。 |
| 大列表 | 保留 status.oversized；用户点击 `changes-load-deferred` 前不去重/排序/建树，只做一次线性 staged/working 计数。输入稿不触发 status/diff 读取或目录重建；真实设备的耗时/帧预算未测。 |
| 同步 | remotes 为独立读取 authority，失败保 prior 并显示错误，刷新按钮可重试；无 remote、dirty+behind 时预先禁用同步并提供对应 AX label。操作内仍按 remotes→fetch→status→必要 pull(rebase)→status→必要 push 核验。 |
| 生成 | `chat-changes-generation.ts` 事件式接线现有 prompts/defaults、小模型协议、404 aside fallback、结构化解析与最多三项 highlights；fallback URL 包含捕获的 directory query，body 仍仅 prompt，不依赖 native Host lease 猜目录。两路 diff 读取最大并发 2，与 Web 同一材料预算并标记 omitted/truncated。无 staged/历史/隐藏 source 拒绝生成；失败保稿；用户编辑、暂存集合、目录、上下文或 Host 变化后迟到结果不覆盖当前草稿。 |
| 写动作 | 核心拒绝非 workspace、非显示态、加载失败或无 authority；确认还原；index-only commit 显式 `stageFiles:[]`。已确认 commit 后 sync 失败不会重提 commit。明确拒绝可显式重试；批量还原已知失败单独保留。 |
| 未知结果 | 每个 Host+目录的有界 journal 在每条 POST 之前写入 Storage marker，成功/明确拒绝后清除。丢响应、5xx、畸形 ACK、存储失败均 fail closed；未知批量项立即停止后续派发，不提供该未知项的重播 retry。Sheet 重挂、重连和进程恢复不自动解除；status 读取不能证明 commit/revert 是否完成。 |
| 写后 authority | 每条已派发 POST 的完成都推进共享 journal revision，即使发起者已关闭。status GET 在派发时捕获同一单调序列，只有成功采用、且派发序列晚于最新 write-completion revision 的 snapshot 才可恢复写 admission。B 的旧 snapshot、ACK 前发起而后返回的 GET、失败 GET 均不放行；刷新失败保 prior。`needsRefresh` 与 pending/unknown 分开，允许显式 GET；任何新 GET 都不解除 unknown。Workspace 状态读取同时订阅 reader revision，以便新 GET 后重新计算禁用态。淘汰已结算、无监听的 journal 时保留单调 revision 下限，不能让仍保留的旧 reader 因缓存淘汰重新变成有效 authority。 |

`native-sheet.tsx` 与 NSH 当前生成的 `base.d.ts` 已重新核对。`DiffViewProps.softWrap/contextLines/expandAll` 以及 `DiffViewRef.goToHunk` 是实际 API；未臆造 `goToLine` 或 `scrollToLine`。

## 字符选区阶段一：正文开关与冻结边界

`chat-changes.tsx` 的真实 `NativeDiffDocument` 仅在原 `DiffView.classes` 中增加 `content: 'select-text'`；此前没有 content class，其他 parts 原值全部保留。未改变 style、字体、word inline、contextLines、layout/wrap、源对象/Each key、ref、滚动/统计回调、gutter 行选区或 Sheet detents。没有增加扫描、订阅、缓存、请求或 JS 选区 owner；本轮不作性能改善声明。

`chat-changes-layout.test.ts` 直接编译执行生产 JSX，在 unified/split × wrap 开/关四种组合下核对真实 DiffView props：正文 part 开启字符选择，非正文 parts 与原配置完整保留；既有公开 Sheet/Composer 转发、2000 行 source reference/请求数量以及 ref/hunk/迟到回调用例持续保留。四个新增用例先因缺少 content class 实际失败，修后通过。全量 NSH TypeScript `tsc --noEmit -p packages/nsh/tsconfig.json` 通过；聚焦 layout/model/owner/actions/sheet-presentation 共 5 files / 65 tests passed。执行命令使用已安装的 `node_modules/.bin/tsc` 与 `node_modules/.bin/vitest`，没有安装依赖。

本阶段冻结交给主会话构建新 UIKit 包。当前 owner 没有执行 NSH engine、设备、Host、Git 或网络，也没有验证 runtime 选区或发布新包。主会话需从新包实时 AX 重取正文 Text，长按单词，观察手柄并移动端点，使用系统 Copy 核对同一视觉 Text 内的精确子串（包括空格/标点）；同时复验 separator 展开、gutter 行选区与系统 Sheet 拖动。静态绿不证明上述交互已通过；全文件复制按钮不计作字符选择证据。

跨 soft-wrap、跨源码行和 split 双侧隔离仍独立未完成。不添加通用 `View selectable`：本地 SDK 源快照的 `SelectionModel::text` 按不同 Text 的视觉 frame 插入换行/tab，而 DiffView 把 soft-wrap 段拆成 Text，不能以此证明复制保留原始源码。

### Source-offset 后续方案（只读提案，尚无公开接入点）

当前本机 SDK 公开合同：`DiffViewRef.selectedLines/setSelectedLines/selectedText` 与 `onLineSelectionChange` 只覆盖行号范围，未提供字符 anchor/head；`DiffViewClasses/Styles.content/line` 只能设置样式，没有逐正文节点 ref、renderLine、selection scope 或源码 offset 映射。`types.d.ts` 的 `selectedRange/onSelectionChange` 属于 Input；Editor 的 selections 属于 Editor，不能当成 DiffView 的能力。公开 View selectable 也没有暴露字符范围事件，因此应用层不能从这些 parts 或行号事件无损恢复真正选区，重复文字时更不能用选中字符串搜索猜起点。

可实施的下一步是请求 SDK 上游提供正式公共的 source-backed 文本选区合同，继续使用同一个 DiffView；本任务不修改 SDK 私有实现、不替换成 Web diff。建议合同与实现边界为：

1. 每个原生正文视觉段携带所属文件、old/new side、不可变文本 revision 和源文本 UTF-16 半开区间。soft-wrap 仅切分布局区间，不能改变原始字节或增加换行；patch 需映射到已知源片段，不将 reconstructed-text 偏移冒充文件绝对偏移。
2. 公开选择状态返回同一文件/side/revision 内的 anchor/head 源 offset（及边界单位合同），由 SDK 所有的原生手柄/命中测试把段内字符 offset 转换为源 offset。每侧独立 scope；unified 的 context 要有明确 side 映射，不能从删除侧连选到新增侧后拼接两份源码。
3. Copy 从该 revision 的原始 source 取精确半开子串；不按视觉行 join，不包含 gutter/indicators/separators，不复制另一侧。保留 CRLF、Unicode 与真正源码换行；缺失 patch context 不能伪造连续源文本，应先有明确的展开/完整 source authority 或拒绝该跨缺口选择。
4. 选区用源位置保持，虚拟行回收、wrap/宽度变化只重算几何；snapshot revision 替换、文件/side scope 切换时明确退役。需要公开生命周期与原生系统 Copy 合同，而不只是一个 JS onSelectionChange 回调。

上游具备上述公开合同后，Yuri 才能通过正式 props/ref 接线并覆盖跨软换行无额外换行、跨真源行、重复子串、Unicode/CRLF、回收/展开及 split 隔离测试。当前公开 API 下这一步是未完成能力，不能通过应用层开关宣称闭合。

## 主线程需要接的共享 seam

1. main 已在 application 的两处 Chat `NativeComposerChanges` / `NativeChangesSheet` 传入 `generationContext={changesGenerationContext()}`，本轮已只读核对。字段可选；未接 sessionID 时小模型仍可用，但 404 无 aside fallback，不能猜测其他会话或创建新会话。项目级入口没有真实 Chat 时不传 sessionID。
2. 系统 Sheet 的父 source/route 应保留到组件 `onClose`。Changes 内部已延迟该回调至真实 completion；preview 此后才发出。不要从预览按钮再提前清 route/另开 UIKit presentation。
3. 共享 Native 文件类型图标应复用 `fileTypeIcons.ts` 的 resolver、file-types sprite 与实际 Host 主题变体；GUI 自定义图标能力归 GUI owner。不要在 Changes 自建扩展名映射或假设通用 file-edit 已 1:1。
4. 未知 Git 写入尚无 Host durable receipt/reconciliation 协议，因此当前 scope 保持只读。没有“强制再试”解锁入口，也不能用相同工作树 status 自动推断操作未完成；若要解除，需 owning Host 提供可核验的操作回执合同。
5. 旧 Changes/tool-diff fixture 已补真实 mock readiness：通过 `prepareChangesFixture` 调用 root `loadConnections()`，采用 connection.list 的 selected connection/lease 后才挂载 page-operation owner。非 iOS driver 已迁移至仓库 tests 下唯一临时目录，显式 macOS。旧 mock 的明确拒绝保持 400，未知 503 仍由独立 callback 用例验证，不能互换来迁就测试。此次旧用例修复尚待 main focused 引擎复跑。

本次没有修改 application/state/chat.tsx/Swift/main/new-session/projects，未占用主线程的引擎或 UIKit lane。

## 验证记录与精确待跑入口

- 实际红：新增 workspace 全文读取 callback 测试时，收到 `/api/git/diff`，预期 `/api/git/file-diff`；未知 commit 测试缺少 unknown，未知批量还原继续派发了第二条。新增 generation 模块前测试因模块不存在失败。
- 实际绿：`bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/chat-changes-generation.test.ts packages/nsh/chat-changes-actions.test.ts packages/nsh/chat-changes-model.test.ts packages/nsh/chat-changes-callback-fixture.test.ts packages/nsh/chat-changes-callbacks.test.ts`：最新 4 passed / 1 skipped files；43 passed / 1 skipped tests，498ms。引擎文件默认 skip，绝不隐式启动。内容包括 prompts/wire、aside 窄 fallback 与非默认工作树目录、并发/预算、编辑及 selection fences、Storage-before-POST、未知禁止重播、明确失败重试、真实 A/B controllers 的旧 GET/失败 GET/新 GET admission 与 journal 淘汰、历史 authority 与真实工具空 patch 补全、binary/源行映射及非 Git authority，以及真实 callback mock 在 commit 503 后继续 GET 而不重 POST 的纯回归。
- 生产组件 fixture 的静态 check 前轮曾通过。此次新增独立 testcase 后，`nsh check chat-changes-callback-engine.test.tsx` 输出其他 owner 的 `chat-tasks.tsx:88`（bounds/layout）一处错误，未报告本次 Changes/fixture 文件错误；不能把这次 check 写成通过。mock host 的 `node --check` 通过。前一次对临时嵌套 testcase 路径执行 check 曾因该目录没有 tsconfig 失败，现已移到 NSH 包根的独立 testcase，不新增子项目配置。
- `bun run dead-code` 前轮首次 120 秒超时后重跑完成；本次新增 revision export/import 后也已后台重跑完成并检查 Changes 项，仍只有两个独立 fixture entry 提示，没有新增 revision export 的未使用报告。未据此删除 fixture 或其他 owner 文件。
- Context7 查询实际被月额度拒绝；请求合同改由仓库当前 Web/SDK wrapper/Host 路由及生成的 NSH declarations 核对。
- main 已实际派发同模型独立 oracle：`ses_e497ab265ffeJJeOB0SI2dlC10`，本轮依据 main 转来的三项 P2 修复。原文“未执行同模型 review”的陈述已撤回；修后尚待 main/该 oracle 复审，不能把当前 owner 自查算作复审完成。

## 独立 oracle 三项 P2 的红绿闭环

1. 历史 authority：红测试实际观察到六种不完整 snapshot 均未发所属 turn/file GET，另一个空 patch 被当作成功 diff。修后这些情况均补全或明确失败；新增测试直接消费 `nativeToolDetails` 的 apply_patch metadata.files 与 write 单侧输入，保证真实工具适配产出的空 patch 不能绕过读取。原有效空字符串对与 binary 用例持续通过。
2. 404 fallback 目录：红测试在 `/worktrees/non-default & review` 观察到 fallback URL 缺 query；修后为同一 captured directory 的 URL 编码 query，POST body keys 仍只有 prompt；目录在 404 返回中途变化时不再发 aside。
3. A/B 写后失效：最小红测试使用两组真实 reader/actions 和同一个 `changesWriteJournal`；A 写后关闭，B 先持旧 status 并发起 GET，A ACK 后该旧 GET 才返回，B 的 commit 实际错误返回 true。修后 B 必须显式发起新的 status GET 并成功采用才可写；失败仍保留 prior 并锁住，原 POST 不重发。另一个真实 A/B 用例确认新的成功 GET 不能解除 A 的 unknown；额外淘汰用例确认 journal 重新创建也不能放行旧 reader。

本轮未启动 engine/device/Host/Git/付费调用。修后复审交给 main，不宣称 1:1 已完成。

## main 引擎失败与待复验 stable point

main 已实际运行旧版 `NSH_CHANGES_ENGINE=1 … chat-changes-callbacks.test.ts`，失败 artifact 为主 shell `sh_1b695fa94001JCa8gc4MvUio34`。准确失败步骤是旧文件第 28 行、生成 steps 第 24 行：点击关闭后 `waitUntil(() => !app.shows('id:native-changes-sheet'))` 从未成立。commit 503 后 unknown marker 已出现、Commit 和 Stage 禁用断言均已通过；尚未执行重开步骤。

定位依据：NSH `crates/nsh-testing/src/module.rs` 的 `wait_until` 独占产生 `the condition never held in 5000 ms` 这句错误，旧 steps 只有上述一处 waitUntil。其 `OpenOptions.platform` 默认 ios，stdin 生成的 open 未指定 platform，因此进入生产 NativeSheet 的 iOS 分支；该分支必须收到 Swift `yuri.sheet.presentation` 的 ready/dismissed 事件才完成关闭。此次 headless mock 只有 runtime.request，未装载 Swift/UIKit 事件源，不能用它验收系统 pageSheet completion。

本次只修改 callback fixture、mock、独立 testcase、Vitest wrapper、纯 mock 回归和本文；没有修改 oracle 正在复审的 model/actions/generation/workspace/Sheet 生产代码。

待复验入口为 `chat-changes-callback-engine.test.tsx`，Vitest wrapper 命令保持下方不变。它显式 `open(..., { platform:'macos', width:390, height:844, storage:{}, network:{}, host:{handlers} })`，由同一内存 mock 接收全部请求。非 iOS 的生产 Sheet 提供真实 headless close completion；这不构成 UIKit completion 的证据。原 stdin 的 1200ms 初始 GC 窗口保留，默认 5000ms 等待与外层超时均未延长。

阶段日志为：

1. `01-directory-generation-highlights`：保留目录分组、生成、标题及 highlights 一次性插入断言。
2. `02-unknown-marker-and-write-lock`：唯一 commit 返回 503；保留非空原稿，marker 必须为 pending，Commit/Commit+Sync/Stage/Generate 禁用。
3. `03-successful-get-keeps-unknown`：显式 GET 成功、刷新按钮恢复可用，marker 与写锁仍保留，POST audit 不增加。
4. `04-sheet-dismiss-completion`：保留原关闭后 Sheet 必须消失的断言；关闭后 marker 仍为 pending。
5. `05-remount-and-get-keep-unknown`：重开后输入非空新稿，写锁仍生效；再 GET 成功也不解除 unknown。

结束 audit 必须只有一次 mock generation 和一次 mock commit，POST 路径严格为 small-model/generate、git/commit；GET 恢复仅代表读取成功，不代表写结果已核验。fixture 已删除启动时的 Storage.removeItem，不会在失败后、关闭或重开时清 marker；空 storage 只在 open 初始化一次。

main 随后已实际跑该显式 macOS callback stable point，反馈 **1 pass**；当前 owner 未自行运行 engine。main 后续重新 build 前，不把早于最终三项 P2 修复开始的 iOS build 当作新源码构建证据，也不声明新的 build hash。

## 旧 Changes/tool-diff fixture readiness 稳定点

main 反馈同一组合中旧 `chat-changes.test.ts` 为 3 fail、`tool-diff-native.test.ts` 为 2 fail / 1 skip；不能将这些红解释成上述已通过的 callback 用例失败。旧画面仅有 Neutral history/viewport、Workspace/History 按钮或只有 Sheet header，均与以下源码合同缺口对应：

- 三个旧 fixture 直接挂载组件，却没有执行 `loadConnections()`；`createPageOperations` 要求真实 `runtimeReady`、selected connection 与 captured lease，故 Composer 初次 status、workspace authority 和 turn body reader 未获 admission。
- 旧 read/actions host 根本不支持 connection.list；旧 layout host 在拦截 Git 前未核 expectedHost，且 remotes 沿用 root base 的对象包装，file-diff 缺完整文本对。
- 旧 stdin driver 默认为 iOS，无 Swift pageSheet completion；修好读取后仍会卡在关闭或预览，不能通过取消生产关闭保护来修 fixture。

本轮只改这些旧用例、独立 host、bootstrap/driver 与本文，未改 application/main/root base host 或生产 Changes 的 authority/unknown/Sheet 合同：

1. `chat-changes-fixture-bootstrap.ts` 经正规 `loadConnections()` 采用 mock connection snapshot 后才令 ready=true；各 fixture 的实际页面均放在 ready 的 If 内，避免先以空身份创建并永久退役 page owner。没有给 root runtimeReady 打补丁或手工伪造已经完成的读取。
2. read/actions/layout host 在返回 Git 数据前严格核对完整 expectedHost；新 `tool-diff-fixture-host.js` 只提供 connection.list，对任何 runtime HTTP（包括 Git diff/status/remotes）都报错，守住完整历史正文不能改读当前 Git。read/layout/actions 的 file-diff 为完整 original/modified 对；remotes 为数组。actions 的暂存前后文本对跟随其内存 index/working 状态，明确拒绝仍是 400。
3. `tests/chat-changes-engine-driver.ts` 每次 mkdtemp 在仓库 `packages/nsh/tests/.changes-engine-*` 创建 driver，保留真实 nsh.json 祖先。以 explicit macOS open 原 fixture，使用原 `--web-host`（layout 仍编译真实包内 wrapper），完整保留原 steps、1200ms GC 窗口、5000ms 默认等待与原 shell/test 超时；finally 清理自己的唯一目录。
4. viewport 用例仍等真实 300 files、点现有 `composer-changes`/`composer-change-neutral-0.txt`，读取真实 onLayout 的 viewport 文本，不硬编码 678；展开、失败和关闭前后必须相同，初始及关闭后均要求 Overlay/文件行不存在于可见查询。关闭时不构建文件行的生产 If/computed 源码合同未改，未把可见性断言单独冒称完整 mount trace 证据。
5. 保留失败提交留稿、明确拒绝显式重试、还原 Cancel/确认、working/staged 隔离、历史 thin-body 失败、历史多文件/预览行号/空 pair/binary/2000 行虚拟化与生命周期断言。补入每次关闭后的 completion 等待，再打开下一项；未删除原断言。iOS 仍只保留 main 的显式 opt-in，macOS 结果不能当 UIKit 证据。

纯红：新增 legacy fixture 合同测试实际 **6 fail / 1 pass**，复现 connection.list 缺失、外来 lease 被接受、layout 的 file-diff 无正文；另补 actions file-diff 用例实际再红，随后修为完整文本对。纯绿最终 **5 files / 54 tests passed，579ms**，包含原生产 authority/unknown 回归和 11 个 legacy fixture/driver 纯测试。`nsh check chat-changes-test-app.tsx`、`nsh check tool-diff-fixture.tsx` 均通过；两个旧 test 与 driver 的 Bun 静态语法转换通过，新增 host 的 node --check 通过，layout mock 的 browser bundle 静态构建通过。`bun run dead-code` 已完成并检查报告，fixture/间接装载的 bootstrap 仍列为未使用 entry 提示，没有据此删除。没有启动引擎或用假 runtime readiness 跑绿。

main focused 待复跑（默认非 iOS；当前 owner 未执行）：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/chat-changes.test.ts packages/nsh/tool-diff-native.test.ts
```

该命令仍含原 3 个 Changes 和 2 个非 iOS tool-diff 引擎用例；iOS 用例默认跳过。只有 main 实际复跑后才能记录其结果。

### 所有 web-host 的单文件 bundle 修正

main 最新复跑反馈：layout 视口用例 **1 pass**；其余 Changes 两例、tool-diff 两例在启动前 module-load fail，NSH web-host loader 无法解析裸 fixture host 对 `chat-changes-fixture-scope.js` 的相对依赖（主 shell `sh_1b6c7c146001CmWwByvSlGdyJk`）。共享 helper 文件确实存在；这是 loader 装载方式，不能以存在检测、删除 import 或手工内联重复 scope 校验修复。

此次 stable point 的共同 driver 已提供 `bundleHost(entry)`，对每个指定 host 执行 `bun build <absolute-entry> --target=browser --outfile <unique-driver-directory>/host.js`；两个 suite 的所有 `--web-host` 参数均只使用该返回路径，彻底移除“仅 layout 才 bundle”的开关。四个源 host 保留共享 helper import 与严格 lease 校验；生产代码、步骤、默认等待和外层超时均未改。

新增四个纯回归先因缺少统一 bundle 方法实际失败；修后分别真实编译 read/actions/layout/tool host，检查 bundle 无残留 import，动态加载 createHost 并验证外来 lease 仍被拒绝。最终 **5 files / 58 tests passed，442ms**，旧 driver 和共同 helper 的 Bun 语法检查通过。该结果包含真实静态 bundling，未启动 NSH 引擎，也未将 main 已通过的 callback/视口用例解释为失败。上述 focused 引擎命令保持不变，修后结果仍待 main 复跑。

### reader 更换时的 commit 草稿保护

独立 reader review 指出新增 reader identity 重挂会销毁 Workspace 的 generation，从而清空同 Host/目录下用户未提交的 message/highlights。此次以真实 `NativeWorkspaceChanges` 初始化/cleanup（仅替换最终 JSX return）配合生产 createChangesOwner/createPageOperations/createChangesGeneration 建立纯回归，修前实际 **3 failed / 6 passed**，分别复现手写稿、已生成稿及生成中的原稿在 lease 替换后变为空。

现在 Changes owner 在 reader identity 边界外持有 createChangesDraft，其 message/highlights/编辑 revision 不随 reader 更换销毁。Workspace 新 generation 绑定新 reader 与捕获的 request，共享 owner.draft；仅 pending/error/serial 留在 generation。cancel 退役旧控制器，禁止其 edit/clear/insert/generate；生成结果仍需 reader/current、serial 与共享 draft revision CAS 全部有效才可写回。不同 Host/目录的新 owner 不共享草稿；没有保留旧 read/write authority，没有改动 unknown journal、status authority 或初始化修复。

修后 **6 files / 68 tests passed（1.37s）**，覆盖生产 Workspace 的手写/生成稿保留、highlights 插入、旧结果迟到不覆盖或清除新 binding 的 pending、新生成期间编辑的 CAS、旧回调不可写，以及 Host/目录隔离。另一个共享 draft 的 generation 回归特意使 current 始终为 true，验证跨 binding 编辑 revision 本身足以拒绝迟到结果，未复制生成算法。完整 NSH TypeScript 检查初次发现 callback fixture 自定义 owner 缺少 draft，补齐后通过；六个相关文件 Bun 语法转换通过。dead-code 已完成并核对，相关报告仍为既有 fixture unused/NSH entry 提示。

本轮未运行 engine/device、真实 Host、Git 或付费请求。该 stable point 的纯红绿已完成，修后引擎与原独立 oracle 复审仍交 main 执行，不能用上述纯测试宣称已通过。

### 组合复跑后的 Changes owner 初始化修正

main 日志 `sh_1b6cd3586001OVg350AJ4ueTB1`：tool-diff **2 pass / 1 skip**，Changes layout **1 pass**；另两例已进入真实业务。workspace 在 step 2 等待 `fixture-branch` 时 Sheet 仅有 `/fixture`；historical 在 step 27 等待正文时停在 `history.ts` / `thin.ts` 列表。这些是修正前结果，不能记为修后引擎通过。

源码根因：`createPageOperations` 先发布新的 operation，owner 的 reader 替换 effect 随后才运行。原 Sheet 打开 effect 仅订阅 open/active/lifecycle，并在 `untracked` 中调用 reader.refresh/select；此时仍可能拿到关闭期的 reader（current=false），调用被拒绝。后续 reader 虽然 current=true，打开 effect 不会重跑。Composer 有独立 active owner，因此摘要已读到 2 files 不代表另一个 Sheet owner 已读取 branch。historical source 原本带 path，也会因同一时序丢失初始选择；不能仅把该现象归因于合法的列表交互。

将原 owner 提取为 `chat-changes-owner.ts`，首次 refresh/目标 select 在新 reader 创建并确认 lane.current 后执行。reader 身份使用独立 signal，内容按身份重新绑定，避免控件解构后持有退役 reader；普通状态通知不更换身份。原打开 effect 只保留呈现行为。历史列表 fixture 明确不指定初始 path，driver 真正点击 `history.ts` 后断言 HISTORICAL_ONLY，再 back 点击 thin.ts 检查正文缺失；另有纯回归继续验证 path-targeted history 的自动选择，防止以 fixture 调整掩盖生产问题。

纯回归直接执行生产 owner、createPageOperations 和 createChangesReader，仅替换 signal/原生请求边界；未复制 Git、历史 authority 或 journal 算法。修前实际 **3 failed / 1 passed**：branch 未读、目标历史 path 丢失、等待 readiness 后仍无 GET。修后连同 reader 身份/失败保 prior 回归，最终 **6 files / 63 tests passed（1.15s）**；完整 NSH TypeScript `bunx tsc --noEmit -p packages/nsh/tsconfig.json` 通过，五个修改文件的 Bun 语法转换通过。historical authority、unknown journal、completion 保护和原隔离断言/超时不变。未执行 NSH 引擎、device、真实 Host 或 Git；修后 focused 引擎结果仍待 main：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/chat-changes.test.ts packages/nsh/tool-diff-native.test.ts
```

本次新增 owner 模块后的 `bun run dead-code` 已完成并检查：相关报告仍为既有 fixture unused 与 NSH entry 配置提示，未报告新的 owner 导出 unused；没有据此删除 fixture。因生产 owner 初始化发生变化，main 也应按原 `NSH_CHANGES_ENGINE=1` 命令复验 callback 用例的 unknown/completion 保护；本轮未自行运行。

main 的纯 mock 引擎待跑命令（本轮未运行）：

```sh
NSH_CHANGES_ENGINE=1 NSH_BIN="$NSH_BIN" bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/chat-changes-callbacks.test.ts
```

生产组件 fixture 为 `packages/nsh/chat-changes-callback-fixture.tsx`，mock 为同目录 `chat-changes-callback-fixture-host.js`，独立 runner 为 `chat-changes-callback-engine.test.tsx`；它注入 fixture-only reader/lease，不启动主 App，不创建连接，不执行真实 Git 或模型，不在运行中清 Storage marker。

UIKit 待验 IDs：`native-changes-sheet`、`changes-close`、`changes-back`、`changes-native-diff`、`changes-diff-actions`、`changes-open-preview`（图标）、`changes-wrap`（文本 diff）、`changes-layout`（文本 diff）；失败重试 `changes-diff-refresh` 只出现在错误行。已移除顶栏 `changes-first-change` 与 `changes-copy-diff`。列表 `changes-collapse-directories-true/false`、`changes-directory-{staged}-{path}`、`changes-view-mode`、`changes-load-deferred`；提交 `changes-generate`、`changes-commit-message`、`changes-highlights`、`changes-insert-highlights`、`changes-generation-error`、`changes-write-unknown`。

UIKit 必须验证：原生三个 detents/拖关闭/真实 completion 后再预览、关闭中业务禁用、键盘和 IME/长路径/小屏 footer、workspace 长行固定 wrap、历史 wrap 切换及上下文展开、full-text 与稀疏 patch 的 targetLine、binary/图片分支、深浅色与 VoiceOver、oversized 加载前无文件构造、50 次草稿输入不读取 Git/重建目录。独立 mock 的绿色不代替生产 Chat 接线、Relay、真实 Host 或逐帧还原。

仍未闭合：共享文件类型/GUI 图标、历史外部 URL 图片、超长 hunk 内精确源行落点、未知写入的 Host 回执核验/解锁、全部 UIKit 与真实 Host/Relay 验收；没有以静态绿声明 1:1 完成。

### canonical diff layout 消费者 stable point

新增 `chat-changes-layout.ts` 与实际生产 JSX/ref/导航回归；消费者初始 6 红、修后转绿，另补历史按需读取丢失 status=added 的单独红绿。当前组合 **7 files / 81 passed，1.98s**，完整 NSH TypeScript、四文件语法与 dead-code 检查完成。owner.draft、reader/lease 生命周期与 unknown journal 未改，现有相关回归保持通过。

本轮没有修改 appearance.tsx/core、application、state 或 settings-preferences-core，没有新增 settings GET/store；main 仍需把成功 canonical snapshot 的 validated nullable 字段传入三处公共 Changes 入口，再独立 oracle 与 UIKit 验收。精确字段、缺省/失效合同、Web/NSH 本地证据、全部接线位置与纯测试局限见 `tests/chat-changes-layout-contract.md`。纯 props/ref 测试不证明原生 split selection、resize 性能或端到端 1:1 完成。

后续 main 已接入 appearance-core 的字段/解析和 application 三处 props（源代码已核对，main 报告 core 73 pass）。独立 oracle 随后发现工具适配丢 status 的 P2：仅修 transcript-tools-model.ts 的类型和两条 metadata 适配，保留 validated added/deleted/modified/renamed，不改 canonical parser。真实工具→历史 reader→布局判定新增红绿，修前 8 fail / 26 pass，修后组合 **8 files / 115 pass，1.82s**；完整 NSH TypeScript、两文件语法和 dead-code 检查完成。Settings 元数据仍归 preferences owner；该 P2 修后待原 oracle 复审及 main UIKit 验收，不以纯绿宣称 1:1 完成。
