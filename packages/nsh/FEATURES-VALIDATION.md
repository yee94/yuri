# Native Bot / Task 编辑器：实现与证据

## 独立 Features UIKit 验收包（2026-11-08，构建完成，真实验收未完成）

main 已实际确认 features-write-ui 全链路 1 pass、receiver 独立 oracle closed；History 尺寸仍待独立 oracle。本节提供真实 UIKit 载体，不能用原 headless pass、SDK typecheck 或 App 构建成功替代 UIKit / 外部端 1:1 验收。

### 交付与隔离

- 新 `tests/features-uikit/fixture.tsx` 直接挂载生产 BotEditor / TaskEditor（包括本地 FeaturesTaskHistory），使用真实 NativeShell NavStack / AlertDialog / Select、生产 NativeSheetPresentation、NativeDatePicker、AppearanceBridge、ScheduleDateBridge。原 model / receipt / overflow 生产逻辑未复制或替换。
- 新 Foundation `SyntheticHost.swift` 只在进程内保存 Bot/Task/偏好/history；seed 由 `seed.mjs` 从既有 features-memory-host.js 提取，另增加足够长的纯合成 history，用于真滚动。注册严格 synthetic capabilities，connection.list 实际 adoption 之前禁止 runtime.request，每次请求检查完整 expectedHost hostID/lease；生产 loadConnections/captureHostOperation/refresh、assistant capability admission 全部照常执行。无 current=true 或手工 app.connection.set。
- `uikit-main.swift` 只安装所需原生桥，读取实际 native appearance supported font 结果；随包原始 JetBrains Mono，不伪造 unsupportedFonts。未加载 RuntimeBridge/ConnectionStore，不读写生产 Keychain、不创建网络、模型、语音或 Git 请求。UIKit 不使用 --web-host。
- 未知 ACK 控制和下一页失败控制只在 fixture 根提供入口；业务写入仍经原编辑器。audit 为单独只读页面，显示 create/run/PATCH 次数及完整 synthetic journal；刷新仅增加 auditSequence，同时原子输出沙箱 Documents/features-audit.json，不能增加业务写。
- 唯一 bundleID + 独立 App 沙箱 Storage。Host 是进程内存，unknown 恢复在同一启动的退出/重开 editor 验收；杀进程后的 Host 数据重置不冒充真实持久化。

### builder / 冻结 / 实际结果

新 `scripts/build-features-uikit.mjs` 复用 stage-native-application，未复制 Projects 的整套图谱框架。共享 helper 仅增加可选 entry（默认 packages/nsh/App.tsx 不变）及入口范围校验；纯回归覆盖自定义入口、原默认入口和路径越界拒绝。builder 使用 exact staged TS/Swift 源副本，记录 runtime import 图 / 已安装依赖 SHA、seed/profile SHA、原始 assets manifest、编译产物/字体/包资源与可执行 SHA、公有 Swift interface SHA 和 codesign strict 验证；不安装、不启动、不测试设备，不修改 distribution。

实际执行：stage-only passed；SDK-only Swift typecheck passed；完整 Simulator App 编译/签名 passed。产物：

- buildID `2026-11-07T17-07-57-765Z-ed33b479`
- bundleID `example.nsh.features-uikit.run-ed33b479`
- App `.nsh/features-uikit/2026-11-07T17-07-57-765Z-ed33b479/FeaturesUIKitFixture.app`
- manifest 同目录 `fixture-build.json`
- 复核 230 个 staged source、42 个原始资源、56 个包内资源 SHA，bytecode/executable SHA 一致；`signatureVerified=true`，`installed=false`、`launched=false`、`uiKitValidated=false`。

纯验证：8 文件 **111/111 passed**，包含真实 Foundation CLI 与 JS memory policy 的 admission / Bot lost ACK / Run / Pause / 读回逐项对照、Task unknown update 一次写入与 audit 不重播、缺失/过期 scope 与禁用能力拒绝、opaque cursor / 下一页失败保留、共享 stager 默认行为及原 editor / picker / receipt / schedules 回归。Foundation CLI 是纯合成策略测试进程，不是 NSH engine、UIKit 或真实 Host。另直接使用本机已缓存的 knip 5.80.0，按 package.json 的 dead-code 参数做离线只读检查，未安装依赖；报告包含仓库既有 unused files/exports，检查未列出本轮 features-uikit / stage-native-application 入口，不能把整仓报告说成零问题。

### main 验收入口

完整 build/install/AX/audit 命令、stable testIDs、72/98 detents / scroll / Done / 侧滑 / 返回草稿、Bot unknown create、Task Run/History/Pause/unknown update、DatePicker/Select、partial history retry 与最终写次数核对清单见 `tests/features-uikit/README.md`。main 必须使用新 manifest 的 bundleID / 真实 AX frames，记录外部端同条件 1:1 对照、截图/视频和 audit delta；未验项保持未完成。

本轮没有更改 production application/main/state/settings/engine/distribution，也未执行 install/launch/gesture、真实 Host、Git、付费或依赖安装。新增 review 范围为独立 UIKit 目录、builder、共享 stager 的可选 entry 及 `features-uikit.test.ts`，与 History 尺寸在审范围分开。

---

## History Sheet 布局边界修复（2026-11-08，新增独立生产复审范围）

main 的实际诊断记录 `sh_1b6e72478001E050CgWmk70pGN.out` 已确认 menu-enter/admitted、dialog answer index=1、choice-history、local branch、mounted/open=true、content-created/active、sheet-opened 全部发生，且没有 closed/disposed，画面仍只有编辑器。因此菜单、dirty navigation、Run busy 和未挂载假设已排除；本轮围绕 panel 尺寸链修复，不更改 identity/current 或菜单控制流。

### 可证布局差异与最小修复

- 本地生成 NSH `SheetProps` 合同明确 popupStyle 覆盖 popupClass、底边 panel 占满宽度，但没有默认高度约束；Sheet 自己拥有进出动画，opened completion 不等于子内容存在非零可见尺寸。
- 原 History 已有背景 `popupClass="bg-background"`，缺少主轴尺寸；FeaturesTaskHistory 根与 List 均为 flex-1，需要从外部获得有界可用高度。已通过的模型选择器使用 `createModelPickerSheet.height()`，其 collapsed 高度来自 `pickerSheetHeight`；Changes 同样显式限制 panel 到可用窗口高度。
- **生产只改 `features.tsx` 的 History NativeSheet 布局属性和所需 import**：popupStyle.height 复用现有 `pickerSheetHeight(windowSize().height, safeArea())`，即 `max(0, H-top-bottom)*.72+bottom`，与初始 .72 detent 一致，随窗口/安全区变化且不超过可用窗口；不是固定像素或超长内容高度。popupClass 增加 h-full：非 iOS 由显式 inline height 覆盖该类；iOS 现有 `systemSheetContentStyle` 剥离 inline height，h-full 让内容 wrapper 填满 UIKit 已分配的系统容器，detent 仍归 UIKit。
- 不修改 NativeSheet 默认行为、历史根/List 结构、任务身份、active/current、opaque cursor、partial failure、写次数或原历史断言。没有补假数据、拦截错误或重放任务动作。
- 四组真实生产 JSX 装配合同（窗口 568 / 844 / 430 / 1024，含安全区与横屏条件）修复前均因缺少 panel height 真实红，修复后转绿，验证高度正数、可用窗口上界、.72/.98 detents 和 iOS height 剥离。该纯合同不能证明真实 NSH flex layout 已有非零尺寸；需以下 main 几何记录确认。

### fixture 几何与 main 配置保留

- 只在临时诊断副本添加 onLayout：Sheet host、FeaturesTaskHistory root、header、List。日志格式 `[features-history-layout] part x y width height`，读取真实 NSH `event.bounds.origin/size`；没有用户内容、任务 ID、Host 配置或凭据。阶段 trace 与原 close / load-more 断言继续保留。
- main 已补的临时 engineProject `nsh.json` 及绝对 theme 路径装配完整保留。VM 装配检查补核对临时项目 capabilities 等于原独立 profile、theme 路径正确；JSON 单独解析，不送入 TSX transpile。所有临时 TSX 继续做语法检查。
- main 再跑 features-write-ui：History opened 后应看到 root/header/List 的非零 width/height，并能找到 `features-history-close`、加载 `features-history-more`、验证 `memory-history-3` 后关闭；随后仍需完成 Pause、Task receipt 与最终严格 audit。若仍不可见，以实际几何定位边界，不能以 opened 或纯测试代替可见性验收。

### 验证与新复审集合

六个纯测试文件 **99/99 passed**；专属 `tsc --noEmit -p packages/nsh/.nsh/features-complete-tsconfig.json` passed。未运行 engine/device/真实 Host/Git/付费。生产 import shape 有变化，按规范应跑 dead-code；本机无 `node_modules/.bin/knip`，未安装依赖或用 bunx 触发下载，因此本轮未跑该检查。

新增独立 review：`features.tsx` History NativeSheet 的 viewport height / h-full 及 import，`features.test.ts` 四组布局合同、`tests/features-fixture.ts` viewport/inset 装配；只读核对 `chat-models-helpers.ts` 的既有 pickerSheetHeight、`native-sheet.tsx` / `sheet-presentation.ts` 的 iOS style 剥离合同。fixture 几何探针与临时 profile 保留检查在 `features-write-ui.test.ts` / `features-memory-host.test.ts`。receiver 原在审范围没有再次改动；本轮独立复审与真实引擎可见性仍待 main 记录。

---

## History 实际选择 / 呈现诊断（2026-11-08，等待 main 引擎记录）

main 转述最新 `sh_1b6dc07c2001CeMVzMJtOjjEEV.out`：已出现 `run action settled; History menu next`，但 features-history-close 仍未出现。**因此前节将引擎失败归因为 Run busy 的结论不完整，不能作为根因 closed**。deferred 回归仅证明 notice→结算存在窗口；enabled 稳定点之后的实际 dialog choice 与本地 Sheet 状态仍需观测。本轮尝试读取该历史输出时文件已不可用，最新实跑结果以 main 提供的记录为依据。

已核当前源码：TaskEditor.menu 的本地 history 分支直接设 historyMounted/historyOpen，不走 dirty navigation；只有提供 onOpenHistory 的外部路由分支才经过 navigation.cancel。当前 memory app 无此回调。NSH test 声明 onDialog 用于“from now on”，公开签名没有返回取消注册方法；仅凭声明不能证明重复注册的内部优先级，也不能把旧 handler 吞答案当成既定根因。

### 本轮可审查差异

- `features-write-ui.test.ts` 只注册一次 dialog handler，后续通过同一闭包里的 dialogAnswer 切换目标。handler 严格核对当前 dialog 包含目标按钮，返回该按钮；只记录 answer 次数和 button index，不记录按钮文案、输入、ID 或配置。History 点击后立即核对新增 dialog=1、实际 handler 应答=1，再执行原关闭按钮 / opaque 分页等待与断言。
- 测试 runner 在自己创建的临时 engineDirectory 内生成 App、features、features-history 副本，依然位于独立 `tests/features-write/nsh.json` 下；相对导入重定位到真实 owning 模块，仅 app→features→history 两段使用临时副本。macOS、内存 Storage、空 network、严格 memory Host 与审计断言保持原样。
- 阶段探针只注入临时源码：menu-enter / admitted / rejected 及 busy、committed、restoring、uncertain、inactive、no-task 的固定拒绝标记；dialog-requested / returned；白名单 menu-choice-run/history/toggle/delete/cancel 或 other；history-local-requested、mounted/open 结果；History 内容实际 created / active / inactive / disposed；Sheet opened / close-request / closed，以及是否在仍 request-open 时收到 close。
- 原生产文件没有诊断 API、全局 observer、Host capability 或日志，本轮未修改 `features.tsx` / `features-history.tsx` / native-sheet / 共享路由。每个注入锚点必须唯一，源代码变化时测试 runner 明确失败，避免静默漏记。临时文件由 runner finally 删除，不覆盖原文件。探针不捕获或吞掉异常，不替代真实菜单和本地 Sheet，也没有新增 timeout 或重放写。
- VM 装配纯测试实际执行 authored runner，但 stub fs mutation / child process：捕获并解析所有生成的 TSX，核对单 handler、应答计数、探针、原生产文件无探针、入口在隔离根下和原严格写次数断言。该检查不导入 nsh/test、不启动引擎。

### main 下一条日志如何判定

| 最后证据 | 可缩小到的边界 |
| --- | --- |
| 没有 menu-enter，或 menu-rejected-* | press 未触发或实际生产准入拒绝；以明确拒绝标记判断，不能仅引用 enabled |
| dialog-requested / answer-index / returned，却没有 menu-choice-history | dialog 返回 action / assertCurrent 边界；没有应答增量则是测试 handler / dialog 生命周期 |
| menu-choice-history + local-requested + mounted/open=true，却无 content-created | 本地 Sheet children 构造边界 |
| content-created 但 inactive，或缺 sheet-opened | active owner / Sheet completion 边界 |
| closed-while-request-open 后 unmounted | close completion 清了仍请求打开的内容；记录完整先后顺序后修复 |
| sheet-opened + content-active，却无关闭按钮 | 转查呈现尺寸 / 可见树，不再归因为菜单或 Run busy |

本轮未证明上述任一候选已在真实引擎发生，尚不提交额外生产修复。六个纯测试文件 **95/95 passed**（包括 opaque cursor / partial failure / 原 deferred Run 回归）；专属 tsc passed。未运行 engine/device/真实 Host/Git/付费/依赖安装。新增 review 范围仅 `features-write-ui.test.ts`、`features-memory-host.test.ts` 及本文；receiver 独立 oracle 范围保持独立。main 再串行运行 features-write-ui 后，使用实际 trace 做下一步最窄修复。

---

## Run 后 History 测试稳定点修复（2026-11-08，无额外生产修改）

main 日志 `sh_1b6d772c0001skn0GxEnjyn03U.out` 已穿过现有 Bot save、首次 lost-ACK unknown、重开恢复与显式 ID 核验全部 phase，说明 receiver 修复已通过这条实际引擎链路；其独立 oracle 仍由 main 另行记录。本次失败在 `task actions and history next` 后等待 `features-history-more`，屏幕仍为 TaskEditor / Schedule started。

源码准入与 deferred 生产回调证据：`acceptAction` 在 state.confirm 后先设置 Schedule started notice，再 await `state.finish()`；finish 仍要 refresh 与 journal.clear，最后才执行 finishAction 清 committed，perform 的 finally 才清 busy。因此 notice 可见不代表下一个 overflow 已能交互。旧 engine steps 看到 notice 就点 History，此时 header disabled，menu/taskAction 的 disabled 准入正确拒绝操作。新增 deferred refresh 回归固定此窗口：notice=started、busy=true、committed=true 时调用实际 menu 不出现第二个 dialog / 不进入 history；release refresh 后 busy=false、committed=false，同一个 History callback 进入确切 `{projectId, taskId}` 的 onOpenHistory seam，Run POST 总数仍=1，无 PATCH。

编辑器并未漏接历史：TaskEditor.menu 的 history 分支有两条现存路径——提供 onOpenHistory 时经 navigation.cancel 交给外部详情路由；未提供时设置 historyMounted/historyOpen，使用本地 NativeSheet + FeaturesTaskHistory。当前 memory app 未传 onOpenHistory，按本地 fallback 打开；无需 main 增加共享路由。FeaturesTaskHistory 继续委托 createScheduledHistory 处理 opaque cursor、完整性检查、失败保留与重试，本轮没有修改它们。

修复仅限测试与专属 helper：`features-write-ui.test.ts` 在 Schedule started 后等待 features-task-more enabled 才点击 History；先等 features-history-close 确认挂载，再等 features-history-more enabled 并继续原分页与 memory-history-3 行断言。关闭后等 history-close 消失及 overflow enabled 再 Pause；Schedule saved 后也等动作完成再 Back。没有增大 timeout、删掉分页目标、补 Done 动作或改变原写次数。`features-memory-host.test.ts` 的真实生成脚本检查在修复前因缺少 Run→History enabled 等待而红，修复后转绿。

main 下一轮可按三条新增 fixture 日志区分阶段：

1. `run action settled; History menu next`：Run 已结算，overflow 真正 enabled。
2. `editor History mounted; first opaque page next`：已进入本地 History，接下来等待 load-more enabled。
3. `history older page verified and closed; Pause next`：原 memory-history-3 分页断言通过并且历史关闭。

本轮额外 review 范围只有 `features.test.ts`、`tests/features-fixture.ts`（透传现有 onOpenHistory seam）、`features-memory-host.test.ts`、`features-write-ui.test.ts` 与本记录；**无新增生产改动**，不与 receiver 的在审生产修改混在一起。验证为六个纯测试文件 **95/95 passed**，包括未改的 schedules-state 33 项中 opaque cursor、load-more 失败保留 / 同 cursor 重试及项目 partial failure；专属 tsc passed。worker 未执行 engine/device/真实 Host/Git。main 继续串行复跑 features-write-ui，直到 task receipt 与最终严格 audit 全部完成；此次稳定点纯回归不代表实际 History 引擎已通过。

---

## receipt 重开恢复 signal receiver 修复（2026-11-08，新增生产复审范围）

main 日志 `sh_1b6cd3586001OVg350AJ4ueTB1.out` 已到 memory authority ready 与 model picker dismissed，随后等待 `features-write-uncertain` 超时。屏幕显示新 Bot、Not selected 与反馈 `not a live signal`；不是初始化 loader 回归。旧两处等待使用同一 uncertain selector，日志本身尚不能区分首次未知创建与重开恢复，不能仅凭报错文案断定哪条旧 continuation 访问了已退役 signal。

代码中定位到精确恢复入口：BotEditor / TaskEditor 的 `state.initialize` restore callback 把 `signal.set` 裸取进 setter 表，随后执行 `setter(value[key])`，丢失 signal receiver。仓库 `drafts.ts` 保存恢复 setter 时已有 `source.set.bind(source)` 的先例；旧 feature callback fixture 的箭头 set 忽略 this，因而一直掩盖该缺陷。本轮令 callable signal mock 校验 receiver，在真实 Bot restore callback 延迟 journal.ready / 重开后复现同样 `not a live signal`；共 7 个恢复回归真实红。修复仅把表中 setter 改为 field 对象，调用 `field.set(value[key])` 保留 receiver；随后 39 项转绿。

进一步将该 Bot create 回归的原 POST 延迟到旧 editor 退役后才拒绝、新 editor 的 journal.ready 独立延迟：校验初次 POST=1、旧页面晚 continuation 的 retired UI signal accesses=0、ready 前点击 Save 不发请求、ready 后 uncertain=true、显式候选 ID 与第二次 GET 核验完成、重开 editor 不发 POST。另补 journal.ready 在旧 UI 退役后才返回的回归，确认其不更新旧 UI / 下一 editor / 导航。helper 的 UI signal retirement 与 journal durable resource 分开模拟；本次没有模拟真实 NSH 内部 owner 分配或修改实际 openDraft / Storage CAS。

### 新增独立复审集合（原 closed 结论不自动覆盖本轮）

- **生产**：`features.tsx` 中 BotEditor 与 TaskEditor 两个 restore callback 的字段表 / `field.set`，重点核对 receiver 保留、原字段校验与恢复字段集合完整；没有改 saved.phase、ACK warning、unknown 只读核验、picker owner / presentation 生命周期。
- **证据**：`tests/features-fixture.ts` 的 receiver 校验、可选 UI retirement、deferred receiptReady；`features.test.ts` 的 Bot create delayed POST / delayed journal-ready，以及 retired editor journal-ready 回归。
- **引擎诊断**：`features-write-ui.test.ts` 仅增加无内容的 fixture phase 标记，不改模型 / receipt / overflow 动作、selector、timeout、次数断言。原 unknown restore 和 ACK 核验仍全部执行。
- 本轮未派出或宣称完成独立复审；需 main 交独立 reviewer。没有更改 drafts / state / application / iOS / shared 字典等其他 owner 文件，也没有以吞异常或重放写修复。

### 实际验证与 main 稳定点

5 个纯测试文件 **61/61 passed**（features 40 项），专属 `tsc --noEmit -p packages/nsh/.nsh/features-complete-tsconfig.json` passed。未运行 engine/device/真实 Host/Git/付费/依赖安装；纯 callback receiver 回归不等于真实引擎复跑通过。

main 再跑 `features-write-ui.test.ts`，在原 model picker dismissed 之后依序应到：

1. `existing Bot save completed; lost-ACK create next`
2. `create receipt unknown observed; discard and reopen next`
3. `unknown create editor left; restoring persisted receipt next`
4. `reopened create receipt unknown restored; explicit ID verification next`
5. `explicit created Bot ID verified without replay`

若下一次仍在首次 unknown 或重开 unknown 前红，最后 phase 将明确区分。之后仍需通过 task actions/history 和最终 audit（Bot create POST=1、run POST=1、task PATCH=2、favorite=1、recent variant=high），不得仅凭 unknown 出现宣称整项成功。

---

## memory appearance 字体合同修复（2026-11-08，main 再次引擎验证前）

main 日志 `sh_1b6c7c146001CmWwByvSlGdyJk.out` 确认 write 已 bundle App 并进入测试，但约 5.5s 后仍未到 `features-memory-ready`，屏幕 `Host selected font is unsupported`。根因是 fixture 初始化手工传 `monoFont: 'system'`；真实 `CODE_FONT_OPTIONS` 要求 `system-mono`，`appearanceFromSettings` 的严格拒绝正确。原 fixture 还手工拼接 AppliedNativeAppearance 并填空 unsupportedFonts，memory Host/profile 没有 reset/apply 合同，不能只换一个字符串继续绕过 apply。

本轮仅修改 `features-write-ui-app.tsx`、`features-memory-host.js`、`features-memory-host.test.ts`、隔离 `tests/features-write/nsh.json` 及本记录。没有改生产 appearance core / sync、P1/P2 closed 的 editor / picker / receipt，或 main 的 app/settings 接线；模型 / receipt / overflow 原 engine steps 和全部严格 audit 次数不变。

- synthetic Host 明确选择 uiFont=system、monoFont=system-mono、jetbrains-light / jetbrains-dark、系统模式。真实投影为 UI=system-ui、mono=monospace、两种 assistant=JetBrains Mono。
- fixture 从捕获的 Host request 读取 canonical settings，经真实 `createNativeAppearanceSync` 执行 appearance.reset → projection → appearance.apply。apply 的返回值提供 AppliedNativeAppearance 字段，不再手工填充或 cast；只有无同步错误、有 applied snapshot 且 unsupportedFonts 为空才能 ready。
- 独立 profile 仅补 appearance.reset/apply。import-free memory Host 对确切 hostID、当前 revision、mode、字段集合和上述四个字体逐一校验，再回传对应 font families；无真实字体安装、系统变更或配置写入。Host 未获得这些操作的生产权限。
- 新纯回归先红：真实 sync 发现旧 memory Host 不支持 appearance.reset。修复后核对真实 settings → projection → apply 返回合同；另执行实际 `features-write-ui-app.tsx` 初始化回调（VM，仅替代 NSH 渲染器/桥）确认 ready 等待 reset/apply。原 monoFont=system 仍被生产投影拒绝，未安装字体、错误 Host、旧 revision 也被 memory apply 拒绝。
- 验证：5 个纯测试文件共 **60/60 passed**，含 memory-host **8/8**；专属 `tsc --noEmit -p packages/nsh/.nsh/features-complete-tsconfig.json` passed。未运行 engine/device/真实 Host/付费/Git，未安装依赖。纯 Node 合同不证明 UIKit 字体加载或 headless 引擎结果。

main 重跑 `features-write-ui.test.ts`：第一稳定点仍为 `features-memory-ready`，紧随日志 `[features-phase] memory authority ready; model preferences next`；现在它同时意味着 fixture 的 supported appearance apply 已成功返回。随后必须继续通过 model picker dismissed、Bot receipt recovery、task actions/history、最终 audit，才能宣称整项成功。create POST=1、run POST=1、task PATCH=2、favorite=1、recent variant=high 均保持原断言。

---

## 隔离 write 项目入口补齐（2026-11-08，main 再次复跑前）

main 已实跑确认 `features-ui` 通过，真实非 iOS dirty Back/Cancel 恢复；write 则在约 10ms、尚未进入 test/open 回调前被项目入口发现拒绝：`no App.tsx in packages/nsh/tests/features-write: add one or pass entry`。前轮 VM 检查仅验证生成脚本，未覆盖 CLI 对隔离项目默认 App 的发现；不能据此前轮纯绿宣称 write 已启动。

最小修复：新增 `tests/features-write/App.tsx`，仅 `import './fixture'`，继续委托原 `fixture.tsx` → `features-write-ui-app.tsx`；driver 显式 open 同一隔离根的 `App.tsx`。专属 nsh.json、cwd、严格 memory Host、macOS platform、内存 storage、空 network 与全部审计断言保持原样。此次没有修改任何生产、settings route 或已 closed 的 P1/P2 文件。

新增入口装配断言先红（原生成脚本仍 open fixture.tsx），修复后 `features-memory-host.test.ts` 6/6 通过，覆盖显式 App 路径、真实入口委托链及生成脚本语法。专属 `tsc --noEmit -p packages/nsh/.nsh/features-complete-tsconfig.json` 通过。没有运行 engine/device/真实 Host/Git；新入口尚待 main 的 CLI 发现与引擎验证。新增源入口按规则需 dead-code 检查，但本地无 `node_modules/.bin/knip`；仓库脚本使用 `bunx knip@5.80.0`，本轮禁止依赖安装，因此未执行该检查。

main 再跑 `features-write-ui.test.ts` 即可；第一稳定点为 `features-memory-ready`，随后日志 `[features-phase] memory authority ready; model preferences next`。若仍在该日志前失败，仍属入口/初始化阶段；后续 picker dismissed、Bot receipt、task actions 与严格 audit 必须逐项完成才算整项通过。原 create POST=1、run POST=1、task PATCH=2、favorite=1、recent variant=high 不变。

---

## main 两项引擎失败：fixture 修复交接（2026-11-08）

原 P1/P2 已由 oracle 静态 closed。本轮只改 `features-memory-host.js`、`features-memory-host.test.ts`、`features-ui.test.ts`、`features-write-ui.test.ts` 及本记录，**没有再次修改 closed 的 features / picker / receipt 生产范围**。新增 review 范围为上述 fixture authority、headless 装配、稳定等待点和测试断言；不以纯测试宣称引擎已通过。

### 准确失败阶段与 red / green

- main 日志 `sh_1b6b88a650014fR01KZYR2hX3m.out`：write 在第一步等待 `features-memory-ready` 时失败，屏幕 `Error: Session index unavailable`。memory Host 的 `/api/yuri/session-index` 返回 directories 却漏了 `available: true`，被生产 `sessionsFrom` 正确拒绝；尚未进入模型选择或任何编辑写入阶段。新增纯测试直接将该 Host 的响应交真实生产 adapter，修复前真实抛相同错误；fixture 补 authority 字段后返回合法空集合。没有放宽生产校验。
- read-only 在旧自动生成步骤第 20:52 的 dirty Back dialog 增量断言失败（0 vs 1）。旧第 11 行点模型关闭后未等待 dismissal，第 17 行直接 Back；失败屏幕仍显示模型 picker。CLI stdin 自动 wrapper 的 open 只有 `network: "live"`，未指定 platform，默认 iOS；当前 iOS NativeSheet 需要 UIKit 的 ready/opened/dismissed completion，headless 没有该 bridge。该证据不能归因为 dirty guard 已处理后丢失页面。
- 新装配纯回归修复前因缺少显式 macOS / 关闭稳定点而红。现在两项均生成独立 `nsh/test` 脚本，显式 `open(entry, { platform: 'macos', storage: {}, network: {} })`，沿用 transcript-native 的真实非 iOS Sheet 边界；`--web-host` 仍注入纯 fixture Host。write 脚本在其专属 `tests/features-write` profile 下生成和执行；storage 每次独立内存，不开放 live network。脚本 finally dispose，外层 finally 只删除自己创建的临时目录。
- 两处只读 picker 关闭后先等待 `!app.shows("id:features-model-sheet")`，再等 editor Save enabled，之后输入并核对新草稿，再记录 dialog baseline、执行 Back/Cancel。原 draft 保留、dialog count +1、显式 Discard 离页断言保留。write 在 variant 选择关闭后也等待 Save enabled，history 关闭后等待其内容消失再操作 task overflow。
- phase 日志分别标记 memory authority ready、picker dismissed / dirty guard next、Bot receipt recovery、task actions。main 若再红，可根据最后 phase 和等待点定位，不能把尚未到达的后续断言算通过。
- 原严格审计断言保留：Bot create POST=1、run POST=1、task PATCH=2；favoriteModels 长度=1、recent variant=high。新增 VM 装配纯测试只 stub child_process/fs，捕获真实 authored runner 生成的脚本并解析语法；不导入 nsh/test、不运行 open、不启动引擎或 Foundation capture。
- 日志还有 `clearTestID/onClear` unsupported prop warning，来源是共享 `sheet-search.tsx` 向 Input 展开附加 props。该文件归其它 owner，本轮未改；目前证据不支持将它当作两项失败的直接原因。

### 本轮实际验证

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/features-memory-host.test.ts packages/nsh/features.test.ts \
  packages/nsh/features-picker-lifecycle.test.ts packages/nsh/features-picker-core.test.ts \
  packages/nsh/features-receipt.test.ts
# 5 files / 58 tests passed（含 memory-host 6/6 与生成脚本 VM 语法检查）
./node_modules/.bin/tsc --noEmit -p packages/nsh/.nsh/features-complete-tsconfig.json
# passed；不是 engine / UIKit passed
```

worker 未运行 engine、设备、真实 Host、Git、付费服务、依赖安装或真实配置写入。

### main 串行复跑

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts --maxWorkers=1 \
  packages/nsh/features-ui.test.ts packages/nsh/features-write-ui.test.ts
```

read-only 测试保留 main 所有的 Foundation capture / date Host 生成入口；可继续通过 `FEATURES_DATE_HOST` 指定已经 capture 的 fixture。此轮 headless 只覆盖 macOS fallback 的模型呈现和编辑器逻辑，iOS 系统 Sheet completion / UIKit 交互仍须 main 独立验收。

---

## Oracle P1 / P2 修复与复审入口（2026-11-07）

独立同模型 oracle `ses_e495bb316ffe5f7PmYtfBZOlSO` 已确认两项缺陷；以下为 worker 的修复与真实 red/green，**不是修复后 oracle 复审通过**。本节优先于下面的旧快照。

### P1：普通 acknowledged 被错误恢复为 uncertain

- 原 `else uncertain.set(true)` 绑定到 schedulerSynced 的提示条件，导致普通 acknowledged（true / undefined）同时 committed=true、uncertain=true。Run/Toggle 的 Done 清 journal 后再次保存，错误进入旧 action reconcile 并报 `feature-receipt-missing`。
- 恢复状态现在明确只由 `saved.phase` 设置：acknowledged → committed=true、uncertain=false；unknown → committed=false、uncertain=true。只有 unknown 安装 reconcile closure；无 receipt 则清两种状态。schedulerSynced:false 的 warning 是独立条件，不参与操作阶段判断。
- 新增 Run/Toggle × schedulerSynced true/undefined 四组生产回调回归：有效 ACK → refresh 失败 → 退出/重开 → Done 只读 → 可再次明确保存；核对没有重放原动作、没有 receipt-missing、完整 execution 仍可保存。修复前四组全红，同时观察到上述错误；修复后 `features.test.ts` **39/39 passed**。原 schedulerSynced:false 回归保留。

### P2：Sheet 内容卸载丢失偏好操作

- `createFeaturePicker` 与 revision、pending/retryable 现在由外层 `FeaturesModelPicker` 持有，属于整个编辑器生命周期；`PickerContent` 只拥有搜索/展开/二级 variant 等呈现状态。构造 controller 不读目录，实际行仍仅在 Sheet 内容挂载时构造。
- controller 捕获创建时的 editor current fence、request 和 selection callback；Host/generation 退役后，即便新 props 换成另一份 current callback，也不能继续旧操作。Sheet 关闭不再改变该 operation owner 的 current。
- reopening 的 load 不替换 pending/retryable；写前读取失败可重试原偏好，PUT 未知只能核验原 patch，均不再次 select/toggle。界面关闭、swipe、backdrop、Escape 保持允许；没有通过锁住关闭来规避缺陷。
- 每次 presentation 和用户 retry/choose 分别绑定 generation。旧 presentation 的迟到 ACK 可以结算其原偏好，但不能关闭已重新打开的新 Sheet。旧内容的动作回调也有独立卸载 guard。
- `features-picker-lifecycle.test.ts` 通过生产 TSX 的父/子 teardown 回调边界验证：pre-read 失败关闭重开后 selection count=1、PUT count=1；favorite PUT 未知关闭重开保留原 high patch，错误 low 回读仍 pending，正确原 patch 仅 GET 核验且总 PUT=1；迟到 ACK 不关闭新 Sheet；captured generation 退役后不发旧 PUT。前三组修复前均真实红，修复后四组全绿。
- 新 helper `tests/features-picker-fixture.ts` 是纯 Node callback/DTO 装配，不是渲染器。仅为 TypeScript 的 eager JSX lowering 补回 NSH nullable variant branch 的 lazy guard；没有替代生产 controller、偏好算法或写请求。不能据此声称 UIKit 关闭/重开已验证。

### 本轮实际验证与边界

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/features.test.ts packages/nsh/features-picker-lifecycle.test.ts \
  packages/nsh/features-picker-core.test.ts packages/nsh/features-receipt.test.ts
# 4 files / 52 tests passed
./node_modules/.bin/tsc --noEmit -p packages/nsh/.nsh/features-complete-tsconfig.json
# passed；不是 NSH compiler / engine / UIKit passed
```

main 正在整包串行验证；worker没有追加 engine、设备、真实 Host、Git、付费服务或依赖操作。main 在模型 picker 上新增的打开时 reload 与搜索布局被保留；TaskEditor.onOpenSession 与 iOS DatePicker 的 main 装配/平台修改未被 worker覆盖。

### 交原 oracle 的最小复审集合

1. P1：`features.tsx` 的 editorState.initialize、TaskEditor 的 finishAction / acceptAction；`features.test.ts` 中普通 ACK 四组及原 false 组；只读参照 `features-receipt.ts` 的 confirm/clear 合同。
2. P2：`features-model-picker.tsx`、`features-picker-lifecycle.test.ts`、`tests/features-picker-fixture.ts`；只读参照未改的 `features-picker-core.ts` 与 `native-sheet.tsx`。重点检查 owner lifetime 与 presentation lifetime 分离、精确 patch、动作次数、captured fence 和 late ACK / close / reopen 顺序。
3. main 的实际引擎 / UIKit 串行复验仍独立记录；worker没有派出或声称完成修复后的独立子审。

---

## 最新实现与交接（2026-11-07，继续补齐）

**以本节为当前证据。以下各节均为先前快照；其中“模型 picker / 持久回执 / overflow 尚未实现”和旧测试失败数已经过时。** features 内的实现已继续完成，尚不能把纯测试与 tsc 等同于 NSH compiler、引擎或 UIKit 验收。application、state、iOS、Appearance owner、共享词典、Projects、Chat、新会话和 Relay 未被本 worker 修改。

### 当前生产行为

| 范围 | 当前实现与真实复用 |
| --- | --- |
| 模型 picker | `features-model-picker.tsx` 使用 `NativeSheet` 的 iOS 72%/98% detents 和非 iOS 的 `createModelPickerSheet`。品牌直接用 `NativeModelLogo` / `NativeProviderLogo`；搜索、隐藏模型、provider 顺序、收藏/最近、current 与 variant 使用 `chat-models-helpers.ts` 的真实规则，不另写品牌或匹配算法。Default + 七个 inline variant、More 完整二级列表及返回/关闭均使用 `model-picker-presentation.tsx`。关闭时不构造目录行。 |
| 本地选择与偏好 | 编辑器的 provider/model/variant 只改本地 draft，不调用 ChatModels 的 session/Bot 即时写入。`features-picker-core.ts` 仅写现有全局 favorite/recent preferences；选择后偏好失败只重试偏好，不重复选择或提交编辑器。写前读取失败/明确 4xx 可显式重试该偏好；PUT 结果未知只 GET 核验，不重复 toggle。失败刷新保留旧快照。 |
| 时间 / 周偏好 | TimeField 读取当前同 Host `nativeAppearance.current()` 的 timeFormatPreference，真实切换 h12/h23；weekday 保留真实 day ID 并按偏好排序。NativeAppearance 暂未投影 weekStartPreference 时，按 captured request 只读当前 Host 的真实 `/api/config/settings`；不是本地猜测或写回默认值。若 root 后续投影该字段，直接优先消费而不增加读取。 |
| locale 周数据 | NSH 官方文档明确 **整个 Intl.Locale 未实现**。`features-calendar.ts` / `features-week-data.ts` 已完全移除构造、weekInfo、getWeekInfo、maximize 及类型 augmentation。只用 NSH 明确支持的 `Intl.getCanonicalLocales`、真实 formatter 的 resolved locale 和捕获的 ICU 78.3 / CLDR 48.0 数据；覆盖十种语言、地区、周五/六/日/一和 fw/rg override，不猜固定周一。未收录的裸 language/script 使用实际 formatter / 设备 fallback locale，仍不可解析则明确失败。 |
| 日期 | 继续使用已有 NativeDatePicker；传入真实 firstDayOfWeek、disabledMatcher.before，显示应用 locale 的日期标签，并在回调拒绝过去日期。iOS wrapper 尚未转交这些已存在的公开 props，见下方平台交接，不能把 callback 校验当 UIKit 禁选已完成。 |
| task overflow | `features-task-more` 使用系统 ActionSheet，真实 Run now / History / Pause/Resume / Delete。Run/启停先 GET 精确项目与任务，核心阻止不满足运行条件的请求；写入有相同持久未知保护。已确认动作刷新失败不重放；Done 只读完成后保留编辑器。启停更新 enabled 的 pristine baseline，保留未保存 prompt。 |
| 任务历史 | `features-history.tsx` 复用 `createScheduledHistory` / `scheduledRunTarget`，保留 opaque 游标、部分失败、显式重试及加载更多；直接使用已有 runtime 事件，不另开 stream。只有 running 行订阅每秒时钟。默认在系统 Sheet 中呈现，也可通过真实 onOpenHistory callback 交给上层路由；历史会话链接需要 main 接真实 onOpenSession。 |
| Bot 字段 | 仍不读取/渲染 Agent，不写 agent/mode。模型目录仍是显式 workspace → Bot managedWorkspacePath → null；无首项目猜测。首名称、默认模型优先级、语言、revision 和头像入口保留。 |
| Goal / 时间规则 | execution.goalEnabled 明确 true/false；无虚构 budget 字段。Task times 初始化过滤/去重/排序，新增 noon，最后一项删除回到 morning；weekly 提交排序；cron 继续使用真实 parser + Foundation offset 数据和四次真实预览。 |

### 持久未知回执

`features-receipt.ts` **复用实际 `openDraft`** 的 per-key Storage 串行/CAS、owner transfer、恢复错误和 flush 合同，没有另造 Storage 写入队列，也不把失败读作空成功。每个 Host / Bot 或 Task 编辑入口保留独立分区。

1. 发出网络写入前，先 flush `unknown` receipt、原操作/稳定 task ID 和完整编辑快照。flush 失败不发写；恢复未完成或失败不允许保存，提供真实恢复重试。
2. 有效 ACK 先持久化 acknowledged receipt；刷新或清理失败保留 committed，Done 只读。退出/重挂载后仍恢复 acknowledged 与同步未完成提示；已确认启停恢复真实 enabled baseline，不把旧 draft.enabled 再写回。
3. 未知 receipt 重挂载后恢复原稿并锁住重复写，只允许原 header Refresh status 发 GET。Task 使用持久 task ID + 原 project endpoint / 编辑字段；Bot update 使用原 ID / revision / 字段。删除只接受完整、实体有效且 ID 不重复的列表证明原 ID 已消失。
4. Bot 创建协议不接受客户端创建 ID，因此不能把相似记录自动当此次成功。保存创建前的完整 ID 集合；用户必须在原 header 的系统确认中明确选择新出现且字段匹配的精确 Bot ID，选择后再 GET 核验，才能解除未知状态。不会重复 POST。
5. Run 协议也没有 durable invocation ID。未知 Run 只读取更晚的 lastRunAt / session 并要求用户明确确认；不自动归因并再次运行。普通回读不能证明 scheduler 已同步，不伪造同步成功/失败。
6. 仅原写请求的明确 4xx 拒绝（408 除外）解除写入未知；核验 GET 的 403/404 等失败不能解除。credentials-shaped metadata 在进入本地 receipt 前拒绝。

已获授权更新 `task-editor-defaults.test.ts`：保留“同目录/tuple/完整草稿，明确 400 后第二次 PUT”的强断言；另新增“无 status 网络异常后只一个 PUT，后续 GET 核验，草稿完整”的回归，未通过降低断言容忍盲目重播。

### 本 worker 最终实际验证

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/features.test.ts packages/nsh/features-bot-defaults.test.ts \
  packages/nsh/features-picker-core.test.ts packages/nsh/features-receipt.test.ts \
  packages/nsh/features-calendar.test.ts packages/nsh/features-memory-host.test.ts \
  packages/nsh/task-editor-defaults.test.ts packages/nsh/task-editor-navigation.test.ts
# 8 files / 68 tests passed，纯 Node；未启动 NSH。

./node_modules/.bin/tsc --noEmit -p packages/nsh/.nsh/features-complete-tsconfig.json
# passed，包含 features 生产模块与两个 UI 入口；不是 NSH compiler passed。
```

纯测试包含：真实 openDraft 的 owner/CAS 与 malformed receipt 保留、跨关闭恢复、丢 ACK 后精确读取、Bot 用户选定 ID 后第二次核验、ACK 启停基线和 sync warning 恢复、68 项现有/新增合同、独立 Host 拒绝外部 URL/错误 lease/付费能力，以及生成 engine steps 的语法检查。若只跑先前 `.nsh/features-tsconfig.json`，可能漏掉新增 write fixture；不能引用其结果代替完整入口检查。

main 曾回报实际 NSHcheck 的 calendar 类型错误已消失；后续 worker 又移除了官方运行时不支持的整个 Intl.Locale 依赖。main 回报的 write fixture AppliedNativeAppearance 缺字段也已实修：四个 applied 字段来自真实 appearance.fonts 的 synthetic 投影，并带 captured sourceHost，**没有 cast**。最新完整 NSHcheck 仍由 main 重跑确认，本 worker不声称通过。

只读文档依据：[NSH globals / Number and date formatting](https://github.com/longbridge/nsh/blob/main/website/modules/globals.md#number-and-date-formatting)。Context7 配额被拒后读取此官方原文，确认支持 getCanonicalLocales、未实现 Intl.Locale。

### 独立写入载体与 main 串行命令

新的载体为 `tests/features-write/fixture.tsx` → `features-write-ui-app.tsx`，配套自己的 `tests/features-write/nsh.json`（`example.yuri.features-memory`），不向生产 nsh.json 放开 fixture capability。配套 `features-memory-host.js` 无 import/fetch/网络能力，所有 Bot/Task/偏好/Run 只修改实例内合成集合；精确 lease、固定虚拟目录和路由白名单强制执行，未知调用失败。载体通过专属 identity gate 后才调用 connection.list / refresh；生产 Host 无该 capability。

```sh
# 由 main 独占执行；本 worker未跑 engine / UIKit。
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features-ui.test.ts
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features-write-ui.test.ts
# 新增 source/export 后，根规则的 dead-code 检查也交 main；本轮遵守“仅纯测/tsc”。
```

| 载体 / 入口 | 确切 IDs / 验证目标 |
| --- | --- |
| 既有 read-only fixture | `features-open-daily` / `features-open-once`，`features-daily-time` / `features-once-time` / `features-date` / `features-timezone`，native 键盘、系统日期、偏好、深浅色、大字号、十语言 |
| memory fixture root | `features-memory-ready`，`features-memory-open-bot` / `features-memory-open-new-bot` / `features-memory-open-task` / `features-memory-open-new-task` |
| 模型 | `features-model-picker` / `features-model-sheet` / `features-model-search` / `features-provider-fixture` / `features-model-all-fixture-model` / `features-favorite-all-fixture-model` / `features-effort-all-fixture-model` / `features-variant-all-fixture-model-more` / `features-variant-option-high`，及共享 `model-variant-back` |
| 未知 / 重挂载 | `features-memory-lose-bot` / `features-memory-lose-task` 制造已写入但丢 ACK；`features-write-uncertain`；Back → 明确 Discard → 重开原入口 → Refresh status；不能出现第二次写 |
| 任务动作 / 历史 | `features-task-more`，系统 action labels Run now / History / Pause/Resume / Delete；`features-history` / `features-history-more` / `features-history-retry` / `features-history-close` / `features-history-session-<runID>` |
| 严格审计 | `features-memory-audit` / `features-memory-audit-value`：POST create、POST run 和 PATCH 数量及偏好结果；脚本检查 unknown create 只一个 POST、run 只一次、toggle + unknown update 恰好两次 PATCH |

该 profile 是可由 main 的 NSH test harness 使用的隔离载体；worker没有编译/安装 UIKit app，也不把 page remount 的纯测试当实际杀进程/重启成功。真实 UIKit 应在相同合成 Host / Storage 生命周期下分别验证 sheet、导航和进程恢复，不能换成生产 Host 跑写入脚本。

### main 装配 / 平台 owner 必须承接

- application 的生产 TaskEditor 加 `onOpenSession={openChat}`；已有 active / syncPendingDescription 保留。否则历史列表可用但缺真实会话路由。BotEditor 新增可选 active，main 可同样传真实顶层 route active；业务写入和 picker 已有前后台 / Host 核心门。
- iOS `native-date-picker.tsx` / `ios/DatePicker.swift` 目前只转交 value。features 已按公开 DatePickerProps 传 `firstDayOfWeek` 和 `disabledMatcher.before`，平台 owner 必须把它们落实为真实 Calendar.firstWeekday / UIDatePicker.minimumDate，并承接应用 locale。当前“回调拒绝过去日期”不能替代真实 UIKit 不可选状态；这些文件未由本 worker越权修改。
- NativeAppearance owner 如补入真实 weekStartPreference 投影，features 自动优先使用；此前单次 captured GET 已提供真实功能，不用填空字段/假 disabled 控件代替。

### 交 main 立即派发的最小独立同模型 readonly review 集合

1. **picker / Web 交互层**：`features-model-picker.tsx`、`features-picker-core.ts`、对应纯测试与 `features.tsx` 的 CatalogFields。只读参照当前 Web ModelSelector / MobileModelPickerPanel、现有 chat-models-helpers / provider-logo / model-picker-presentation。检查 local selection 与 preferences 的动作次数、Default/remembered variant、搜索/分组/收藏/最近/关闭和 stale Host。
2. **mutation / durable / navigation 层**：`features.tsx`、`features-receipt.ts`、`features.test.ts`、`features-receipt.test.ts`、`task-editor-defaults.test.ts`；只读参照 drafts.ts / Web Bot 和任务编辑器 / 实际 Host routes。检查 prepare→write→ACK→refresh→clear 的每个中断点、跨 owner CAS、重挂载、用户取消、partial / duplicate IDs、sync warning 与 enabled baseline；禁止任何未知写重播。
3. **calendar / fixture / 平台边界层**：`features-calendar.ts`、`features-week-data.ts`、`features-history.tsx`、`features-write-ui-app.tsx`、`features-write-ui.test.ts`、`features-memory-host.js` 和两个 fixture profile 文件。检查 NSH 已实现的真实 API、不会调用付费/真实 Host、actual Applied shape、profile 权限、脚本断言与未验 UIKit 边界。

独立 reviewer 应同当前模型，由 main 派发；worker工具目录无下层派发能力。**独立子审尚未执行**，没有将自身第二遍复核写成子审通过。NSHcheck / engine / UIKit / 真实 Host / 真机和 main review 结论仍应分别记录。

---

## 当前源码再审计（2026-11-07，features 专属 worker）

**这节为当前结论，下面原记录为历史证据，不能将历史缺口或通过数直接当当前事实。完整 Web 手机端 1:1 尚未完成。** 本次只改 `features.tsx`、`features.test.ts`、`features-ui-test-app.tsx`、专属纯测试 helper `tests/features-fixture.ts` 和本文件。未改 application/state/iOS/共享词典、新会话、Projects、Chat 或其他 owner 的文件；未运行 engine、设备、真实 Host、付费服务、Git、依赖安装。

### 对照当前 Web 的结论

- `AssistantsSettingsPage.tsx:52` 的模型默认值优先级、首 Bot 名称 Yuri 已由 `features-bot-defaults.ts` 实现，生产 BotEditor 已接入；历史“空默认值待补”已经过时。实际 composer 上下文仍由 application 捕获，不能猜首项目。
- Web Bot 编辑不拥有 agent/mode（`AssistantsSettingsPage.tsx:101`），Native 仍不渲染/读取 Agent、不在创建或 PATCH body 写 agent/mode；目录严格采用显式 workspace → 当前 Bot managedWorkspacePath → null。
- Task 的真实控件有 Goal，execution 只有 `goalEnabled`，没有 token budget 控件。保留显式 false，Host 存储省略 false 时只读核验按 false 解释。
- 当前 application 已传 `syncPendingDescription`；历史“词典和生产接线尚未完成”的结论不再适用。本 worker 未修改共享文案。
- `ScheduledTaskEditorDialog.tsx:482/943/956` 的时间行为已补齐：初始化过滤无效值、去重排序，空值回到 09:00；添加 12:00；删除最后一项恢复 09:00。weekly 提交去重并按数字排序。
- Task 的无效 variant 仅在完整目录成功且当前模型已知时清除，与 Web `ScheduledTaskEditorDialog.tsx:903` 一致；目录失败、partial 或当前模型未知不能借机清掉草稿。

### 写入 ACK 与未知恢复

- 有效 ACK 后先标记 committed 再 refresh；刷新失败保留已确认状态，Save/Delete 核心拒绝重放，Done 仅重读。Bot 更新还核验 ACK 的精确 ID、递增的 safe-integer revision；删除核验精确 ID 和有限 tombstone。
- 丢失/畸形 ACK、网络异常和 5xx 后保留本页提交快照与只读恢复 closure，锁住字段/删除。**原有 header 保存位置改为 Refresh status，不新增按钮**，后续只 GET，禁止第二次 PUT/PATCH/POST/DELETE。
- Task 核验原 project endpoint、稳定 task ID 和已提交的编辑字段；删除需完整有效列表确认原 ID 消失。Bot 更新需完整有效 snapshot、原 ID、较新 revision 与提交字段相同；删除需完整 snapshot 确认原 ID 消失。partial、坏实体、失败、不同字段和旧 Host 均不能算成功。恢复 GET 的 403 等 4xx 也不能解除未知状态。
- 只有原写请求的明确 4xx 拒绝（408 除外）恢复可编辑状态，以便用户显式处理校验/冲突后提交。单独回归覆盖 409；没有把读取失败误当写拒绝。
- Bot 创建没有收到 ID 时，当前协议缺少客户端稳定创建回执；即使出现同名 Bot，也不能证明属于此次创建。页面持续显示未知并禁止再次 POST，Back/Cancel 仍要求明确 Discard。此处**没有**实现跨卸载/进程退出的持久未知 journal，也不能宣称完整恢复已完成。
- 任务 GET 只能确认当前持久配置，不能证明调度器已同步；不伪造 schedulerSynced 成功或失败。真实 `schedulerSynced:false` ACK 仍保留原先明确提示与 Done 行为。

### 本次实际验证

先运行旧纯测试，实际为 14 fail / 14 pass：专属 VM helper 尚未接入生产的 `NativeSelect` / `NativeDatePicker` 和 `captureHostRequest`。仅补测试边界后，新增用例在修复前确实复现了时间坏值不能保存、丢 ACK 后第二次 PATCH、Bot 接受其它 ID 的 ACK、失效 variant 未清等问题。

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features.test.ts packages/nsh/features-bot-defaults.test.ts
# 本轮最终：2 files / 40 tests passed，纯 Node，未启动 NSH。
./node_modules/.bin/tsc --noEmit -p packages/nsh/.nsh/features-tsconfig.json
# passed，纯 TypeScript；不是 NSH build 或 UIKit 验证。
```

另跑 `task-editor-defaults.test.ts`、`task-editor-navigation.test.ts`：navigation 两项通过；defaults 三项通过、一项失败。失败精确在 `task-editor-defaults.test.ts:52`：旧用例把无 status 的 `Error('write offline')` 当可安全重试，要求第二次 PUT。本轮安全合同要求此类结果先 GET 核验。该文件属于其他 owner，未修改；main 应将该用例改为“有明确 4xx 拒绝可重试”，另保留本 features 的丢 ACK 只读恢复用例，不能恢复盲目重放来让旧断言变绿。

本次工具目录未提供 spawn/delegate/session-message 能力，要求的“相同模型独立 readonly 子 review”未能执行；只做了本 worker 的第二遍只读复核，不将其冒充独立 review。Context7 查询遭月配额拒绝；平台合同采用当前仓库 wrapper、文档和已安装类型证据，没有编造已获取的远端文档。

### Main 的串行 engine / UIKit 交接

唯一入口 `packages/nsh/features-ui-test-app.tsx`；既有 `features-ui.test.ts` 仍由 main 独占执行，自动生成真实 Foundation capture 后加载只读 fixture Host。该 Host 拒绝全部真实写，**不能**用它验证保存/删除或未知写入的 UIKit 路径。

| Fixture 入口 | 确切生产控件 IDs | 待验行为 |
| --- | --- | --- |
| `features-open-bot` | `features-bot-name`, `features-bot-save`, `features-bot-cancel` | 单 NavPage header、dirty Back/Cancel 保稿与明确 Discard、managed 目录、无 Agent |
| `features-open-task` | `features-task-name`, `features-task-save`, `features-task-cancel`, `features-timezone`, `features-cron`, `features-cron-next-runs`, 四个 `features-cron-next-run` | 纽约 cron 真预览、原生导航和 dirty 保护 |
| `features-open-daily`（本次新增 fixture） | `features-daily-time`, `features-time-add`, `features-time-remove` | TimeField 分段键盘、添加 noon、最后一项回到 morning、布局/AX |
| `features-open-once`（本次新增 fixture） | `features-date`, `features-once-time`, `features-timezone` | 系统 DatePicker Sheet、选择/关闭/返回、TimeField 与键盘 |
| 保存/删除未知（纯测试已覆盖，须 main 另接隔离 UIKit Host） | 原 header `features-bot-save` / `features-task-save`, `features-write-uncertain` | 标题转 Refresh status、字段锁定、只 GET 恢复、明确离页；无付费请求 |

```sh
# main 独占，不由 worker 执行
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features-ui.test.ts
# UIKit 使用上面的真实入口/IDs；不要将 headless passed 记为 UIKit passed。
```

### 仍未完成的真实 1:1 范围

1. Native 当前 Provider/Model/Variant 三个搜索 Select 仍未达到 Web `ModelSelector` 的品牌、收藏/最近、模型 capability/cost、分组和完整 picker 交互；这属于功能差异，不能仅记作视觉待验。现有 ChatModels 有立即写 session/Bot 的语义，不能直接拿它替代编辑器本地 draft picker；新会话 picker 的必需目录也不能拿空字符串替代 Bot 的 null 全局目录。
2. Web 时间控件消费 12h/24h 与周起始偏好；Native 当前 TimeField 固定 h23、weekday 顺序固定周日。真实 root appearance 只有 timeFormatPreference，未投影 weekStartPreference；本 worker 未越权改根 contract。DatePicker 的“今天以前不可选”、locale 日期标签与当前 UIKit wrapper 合同仍需 owner 对齐。
3. 一次/每日/每周/cron、模型/Agent/variant、原生 Select/Sheet、深浅色、大字号、十语言、物理键盘、读屏、系统返回手势与 Liquid Glass 的实际 UIKit 验收未执行。编辑表单不额外仿制玻璃；材质/Tab/Sheet 归平台 owner。
4. 未知创建回执和跨退出恢复、模型目录 UI 全量对齐、真实 Host 冲突/调度同步、UIKit 保存删除仍未完成，未降为 MVP 或删除任何验收项。
5. Web 任务编辑器的 existing-task overflow 在 `task && onRun && onDelete` 时显示 Run now、Delete，并按 callback 显示 History/启停；`ScheduledTasksDialog.tsx:1685` 的实际移动端装配已传这些 callbacks。Native TaskEditor 当前只有保存、草稿 enabled 与底部删除；上层 schedules detail 的独立动作不能自动算作编辑器内同入口已还原。需 main 与 schedules owner 确认路由/dirty 保护合同后接入，不能凭字段新增另一套运行状态。

---

日期：2026-11-07。范围为 `features.tsx`、`features-cron*` / `features-schedule-date.ts`、features 专属 fixture/tests 和本记录；后续按 main 明确授权新增独占 `ios/ScheduleDateBridge.swift`。未修改 application、state、settings、assistants、schedules、其他 iOS 文件或共享词典；无依赖增补、git/GitHub、真实配置/Host/模型/语音操作。

## C / F / H / S / D

- **C**：下面所述生产代码已经实现；独立 NSH fixture bundle 构建通过。
- **F**：最新 18 项纯 Node Vitest 通过，专属tsc和Foundation-only Swift typecheck通过。它们**不是 NSH 渲染器**，不证明 reactive header、手势、UIKit 或 QuickJS Intl 的运行结果。12/13项早期运行与main的UI失败回报按时间保留在下面追记。
- **H**：真实 Host 未测。
- **S**：UIKit 模拟器未测，未运行任何 NSH engine test / UI Vitest、未安装或启动模拟器。唯一获 main 新增授权的 NSH 操作是独立入口 build，不是 production build。
- **D**：真机未测。
- 已先检索下层工具：当前工具目录只有模型查询等 OpenCode 工具，没有 spawn/delegate/explore/session-message；没有派出或口述冒充派出下层。

## 真实 Web 对照与当前实现

对照 `AssistantsSettingsPage.tsx`（settings draft 与 PATCH、catalogDirectory、默认模型与首名称）、`MobileAssistantSettingsPage.tsx`、`ScheduledTaskEditorDialog.tsx`（goalEnabled、日期/时间、cron）、`ScheduledTasksDialog.tsx`（dirty 离页）、`lib/cron.ts`、`lib/scheduledTasksApi.ts` 和 Host `scheduled-tasks/routes.js`。

| 能力 | C：本轮结果 | F | H/S/D |
| --- | --- | --- | --- |
| Bot 字段归属 | 创建/PATCH body 均不写 agent/mode；Bot 模型区不显示 Agent，也不额外 GET Agent | 确认保留后台字段的 PATCH body；保留 variant/workspace/expectedRevision | 未测 |
| Bot 模型上下文 | 使用草稿显式 workspace，否则原 Bot managedWorkspacePath，否则 null；null 时省略目录 query，绝不回落首项目/effectiveWorkspacePath | 托管/显式/null 三条路径通过 | 未测 |
| 模型目录失败 | 刷新开始不清 providers/agents/partial；失败和坏 envelope 保留旧有效快照，显示错误；成功空集合才清空；sequence/Host fence 拒绝旧响应 | 保留引用、部分状态、失败/畸形返回、较早完成、成功空集合通过 | 未测 |
| Task Goal | 真正 Switch 读取/修改 execution.goalEnabled；保存显式 true/false，关闭旧 true 不会被 spread 恢复 | 关闭 true → 保存 false 通过 | 未测 |
| 保存/删除 fencing | 确认响应 + Host fence 后、任何 refresh 前调用 noteScheduledCatalogWrite；保存核对任务 ID，删除核对剩余 tasks 不含被删除 ID | 保存/删除先 invalidate 再 refresh；取消删除不发写；旧 Host 不 commit 通过 | 未测 |
| 提交后同步失败 | schedulerSynced:false 仍 committed；锁住写按钮和核心重复写；Done 只重读，不重建/重删/重跑 | 重按 Save 不重复 PATCH，Done 只刷新通过 | 未测；精确说明需 main 接线，见下 |
| 原生 header | 两编辑器 headerBackTitle=""；每个编辑器只有一个 headerRight Save，移除长页末尾重复 Save，末尾保留 Cancel/Delete/反馈 | 回调测试通过；header实际可见/布局不由纯测试证明 | 未测 |
| dirty Back/Cancel | 比较实际可编辑 draft；busy/确认中/dirty 设置 popOnBack=false、popOnSwipe=false；Back/Cancel 原生确认，只在明确 Discard 后 onDone；已确认提交不再作为 dirty | 取消离页保留稿，随后保存仍发原稿；Task 明确丢弃才离页通过 | 未测；不宣称交互式返回手势可弹确认 |
| 日期/时间 | 一次日期采用 NSH DatePicker，时刻采用 TimeField minute/h23；新任务日期/时区采用系统本地值；多个时间、去重排序与 weekly 保留 | tsc/bundle通过；实际 picker 交互未测 | 未测 |
| 时区 | 同 Web 当前能力保留文本时区字段，不伪造 IANA picker；cron 使用输入时区计算、locale格式化 | UTC/纽约/上海纯解析结果对照 Web 通过 | 未测 |
| cron | 复用已安装 cron-parser 的真实 CronExpressionParser；与 Web 相同五个示例、完整语法校验、四次运行预览；进入 cron 时填 Web 默认 0 * * * * | 宏/命名星期/范围/L 与 Web 语法、纽约DST预览逐值一致；非法表达式不发写 | 未测，QuickJS Intl 必须由 main engine验证 |
| Token budget | 没有新增控件/字段。真实 Web 当前 execution 只有 goalEnabled，不因词典中有 budget 文案而虚构协议 | 代码对照 | 不适用 |

## cron barrel 故障与修复证据

main 首轮串行验证报告：直接从 Web `lib/cron.ts` 导入，会经 cron-parser 的 CommonJS barrel 装载 CronFileParser → fs，导致所有加载 features 的 App/Bot bundle 报 `nsh has no module fs`。该失败是真实故障，不计作通过。

现为：

```text
features.tsx → features-cron.ts → features-cron-parser.js
  → 已安装 packages/ui/node_modules/cron-parser/dist/CronExpressionParser.js
  → CronFieldCollection / CronExpression / CronDate / fields / random / Luxon
```

- `features-cron-parser.js` 是真实静态 re-export，不是动态 require、运行时兜底或 Node 模块 stub。
- 相邻 `.d.ts` 仅 re-export 同一实际 class 的 package canonical public types；没有 ambient declare、ts-ignore 或伪造 fs/native 模块。
- 因该依赖已由 UI 安装，桥接显式使用现有安装位置；未新增 NSH dependency，也未复制实现/自行发明 cron 算法。
- `features-cron.ts` 只封装与 Web 相同的 parse/options/next 与五个示例。Node 回归逐项对照 Web，防止方言/时区计算分叉。
- 独立 fixture build 已实际完成，无 fs 或 native missing；**build 不执行所有 Luxon/Intl 分支**，不能把它当作运行证明。
- `features-ui-test-app.tsx` 的 Task fixture 使用 `0 9 * * MON-FRI` + `America/New_York`；`features-ui.test.ts` 等待实际 Next runs，以便 main 在串行 engine 窗口捕获 Intl 缺口，不能只 mount daily 空表达式绕过。

## 实际运行

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features.test.ts
# 1 file, 12 tests passed；纯 Node，无 NSH engine

./node_modules/.bin/tsc --noEmit -p packages/nsh/.nsh/features-tsconfig.json
# passed；临时专属配置 include features.tsx / features-cron.ts / features-ui-test-app.tsx

# packages/nsh 工作目录，NSH_BIN 为 main 提供的已安装 0.4 工具
"$NSH_BIN" build features-ui-test-app.tsx --release --out .nsh/features-test-bundle
# passed；4.5 MB js / 2.9 MB bytecode；最后一次构建 280ms

bun run dead-code
# completed，非阻断；已查 report，features-ui-test-app.tsx 被标 unused（它是CLI test入口），不因此删除。
```

全包 `tsc --noEmit -p packages/nsh/tsconfig.json`：第一次通过；最新一次被并行工作的 `new-session.ts:157/174/180/182`（string|undefined 与 Receipt narrowing）阻塞。features 专属 tsc 此后通过；本 worker 未修改该文件，不将旧的全包通过冒充最新结果。

没有运行 `features-ui.test.ts`、其他 UI suite、`nsh test`、production App build、ios build、模拟器、浏览器或真实 Host。它们全部交 main 串行执行。

## main 的精确接线

### 明确显示 scheduler 同步未完成

TaskEditor 已接受可选 `syncPendingDescription: string`，成功写入但同步失败时追加显示；当前未传时仍是已有的 Saved + Schedule · Error 文案，**不能声称该降级文案已足够清晰**。共享词典只能由 main 修改，请添加：

`sessions.scheduledTasks.editor.toast.schedulerSyncPending`

并在所有生产 TaskEditor 调用传入：

```tsx
<TaskEditor
  item={route.item}
  onDone={() => nav.pop()}
  syncPendingDescription={t('sessions.scheduledTasks.editor.toast.schedulerSyncPending')}
/>
```

| locale | 完整翻译 |
| --- | --- |
| en | The change was saved, but scheduler synchronization did not complete. Do not submit it again. |
| zh-CN | 更改已保存，但调度器同步未完成。请勿重复提交。 |
| zh-TW | 變更已儲存，但排程器同步尚未完成。請勿重複提交。 |
| ja | 変更は保存されましたが、スケジューラーの同期は完了していません。再送信しないでください。 |
| ko | 변경 사항은 저장되었지만 스케줄러 동기화가 완료되지 않았습니다. 다시 제출하지 마세요. |
| fr | La modification a été enregistrée, mais la synchronisation du planificateur n’a pas abouti. Ne la soumettez pas à nouveau. |
| es | El cambio se guardó, pero no se completó la sincronización del programador. No lo vuelvas a enviar. |
| pl | Zmiana została zapisana, ale synchronizacja harmonogramu nie została ukończona. Nie przesyłaj jej ponownie. |
| pt-BR | A alteração foi salva, mas a sincronização do agendador não foi concluída. Não a envie novamente. |
| uk | Зміну збережено, але синхронізацію планувальника не завершено. Не надсилайте її повторно. |

不造 sync/retry endpoint。Done 只是刷新/离开，不表示 scheduler 已恢复；Host 当前没有独立公开的同步重试接口。

### main 串行 engine / UIKit

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features-ui.test.ts
```

该新 fixture 只验证 dirty Back/Cancel、托管目录/不读取 Agent，以及实际 cron Next runs；host fixture 禁止所有写请求。header Save 的布局/触区、实际保存删除与 scheduler 恢复仍需 main 的生产入口及 UIKit/Host 专项。不能以 worker 的回调测试代替这些检查。

## 全量剩余缺口（不删减范围）

1. **新建默认值尚未 1:1**：Web 首个 Bot 名称为 Yuri，模型优先 settingsDefaultModel、随后当前内存选择/OpenCode默认、最后首可用模型；Native 当前新建仍空名称/模型。已核对真实源码，但本轮未猜测 Web 的内存选择，也没有用首项目/首Bot列表空值冒充权威。需要 main/后续提供真实创建上下文及新任务模型/Agent默认值。
2. **明确同步失败文案待 main 接线**。Host 同步恢复、删除最后一个任务、网络未知结果、冲突后的权威恢复均需真实 H/S/D；本轮没有自动重放写。
3. **模型目录完整交互仍未同 Web 对帧**：Native 是 Provider/Model/Variant 多字段，尚非 Web ModelSelector 的品牌/搜索/分组完整呈现。切换目录失败时保留旧快照并显示错误，但尚未提供逐目录历史目录选择体验；服务端仍校验模型可用性。
4. **dirty 支持边界**：已实现 Native Back/Cancel 明确确认；dirty 时返回手势关闭，而不是伪称拦截手势弹确认。外部强制 nav reset、Host 切换、进程退出的草稿持久恢复不在这次编辑器本地 guard 的证明范围，仍需整体生命周期方案。
5. **日期/时间 picker 的 UIKit/大字号/键盘/读屏/深浅色/10语言视觉与触控未测**。cron 完整 parser 已无 fs闭包，但 QuickJS Intl 的 formatToParts/时区/DST 实际运行、预览渲染及解析异常呈现仍要 main 跑新 UI fixture，再做 UIKit专项。
6. **Web完整二级编辑交互与异常**仍需生产逐项验收：新建/更新/删除、409 revision对照与明确重试、刷新失败后的 Done、busy 时离页、嵌入渠道 children 的生命周期以及关联详情返回收敛。不能因纯测试、tsc 或独立bundle通过宣布全量完成。

## main 串行回报追记：features UI 第 13 行

main 实际运行报告：原始生成的 `.nsh/test/features-ui-test-app.tsx.steps.test.ts:13` 得到 expected false → true。已读原步骤：

```ts
await app.back();                                  // line 11
expect(app.shows('id:features-bot-name')).toBe(true); // line 12，已通过
expect(app.host.calls().some(call =>
  call.data?.path === '/api/config/catalog/providers?directory=%2Fmanaged'
)).toBe(true);                                     // line 13，实际失败处
```

因此**不能将这个失败归因于 dirty Back 弹走页面**。当时仍在 Bot editor 与第12行一致。尚未有证据区分外置 `--web-host` 调用未进入 `app.host.calls()`、其记录结构不符，或请求实际目录不符；先前直接依赖该审计数组的断言不足以定位。

核对安装版 `nsh/test.d.ts:297` 和当前 NSH 文档：`app.back()` 是用户返回路径，受 popOnBack 控制；被阻止时询问页面，触发 onBackPress。它不是强制 `nav.pop()`，也不证明 UIKit交互式 swipe。生产页保持 dirty/busy `popOnBack=false` / `popOnSwipe=false`，onBackPress 仅在 blocked 时走确认；本次没有无证据改动生产离页逻辑。

修订后的验收没有删除或弱化保稿：

1. 外置只读 fixture-host 只接受 `/managed`、`/first-project` 两个**完整精确**模型目录 URL，并在真实 catalog 响应 provider 名字中分别返回 `Managed directory verified` / `Task directory verified`；UI 等待实际选中 provider 的这些文字。错误路径不会得到同一个宽松成功 catalog。
2. Agent 只允许任务的 `/first-project` 精确 URL，Bot 托管目录 Agent 会明确报错；纯生产回调测试仍检查 Bot 不 GET Agent。所有非 GET 的 runtime.request 继续直接抛错，未开放任何真实写。
3. Back/Cancel 后除仍在编辑器，还断言输入值完全保留、原生确认 dialog 数量恰好增加一次；显式 Discard 才返回 root。不能以“返回被静默忽略但没有确认”混过。
4. 移除依赖不明外置 audit 数组的断言，改以上真实 Host响应契约；可选 `FEATURES_HOST_TRACE=1` 只输出一次中性 fixture 的审计记录，供 main 定位 records 是空还是形状不同，不影响验收结果。

main 下次串行命令：

```sh
FEATURES_HOST_TRACE=1 ./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features-ui.test.ts
```

若仍失败，精确 probe：请求标记未出现时保留 screen/error 与 `[features-host-probe]`；若保稿/确认计数失败，给出失败步骤、`app.value` 与 `app.dialogs()`，再区分真实 pop gate/onBackPress 问题。**本 worker未自跑 engine/设备。纽约 cron 的原运行尚未到达，明确仍未通过**；需本次走到 Task 的 Next runs 才有运行证据。

本次补充修订实际仅运行纯 `features.test.ts`：**13 tests passed**（包含外置 fixture-host 的精确目录响应与 POST/PATCH/PUT/DELETE 全拒绝）。没有运行修订后的 UI测试，不能写已修复通过。

## main 第二次串行回报：纽约 cron 没有 Next runs

实际回报：dirty/确认/目录已通过，Task 的 Cron、Examples、Provider 正常，但 `Next runs` 等待5秒失败。该轮已经到达纽约 runtime，**预览仍未通过**。原实现 `getNextRuns` 与 `formattedRuns` 两层 `catch → []` 会同时隐藏 parser/Luxon/Intl 异常。

### 目前知道什么、不知道什么

- 已核对安装的 cron-parser 5.5.0 `CronDate.js`：`tz` 交给 Luxon `DateTime.fromJSDate` / `setZone`。Luxon 3.7.2 `IANAZone.isValidZone` 通过 Intl 验证且会吞掉原始异常，随后 CronDate 只抛 generic unhandled timestamp。
- [NSH 官方 Intl 限制](https://github.com/longbridge/nsh/blob/main/website/modules/globals.md)：无时区数据库，只支持设备时区、UTC、固定 offset；其他 IANA 名称抛 RangeError。这是明确库能力差异，不能给纽约任务换成 UTC/固定全年offset。
- **当前引擎的完整实际异常尚待 main 跑下面 probe 捕获**。这里只能记录上面的实际症状及源码/文档证据，不编造一条实际运行的 RangeError 文案或堆栈。

### 已实现的异常闭环

`features-cron.ts` 增加 `CronPreview` success/failure union，失败包含 `stage/name/message/stack/previous`；parse、next[index]、format 分开。若 Luxon 在parse吞掉Intl异常，再直接检查同一时区的Intl，并同时保留原始CronDate外层异常。`getNextRuns` 不再把异常变成空成功。

TaskEditor 在预览加载时显示 Loading，最终失败把完整链渲染到 `features-cron-preview-error`；没有静默降级或虚构 None。只有得到四个真实结果才挂载 `features-cron-next-runs` 和四行 `features-cron-next-run`。UI验收仍等待成功标记并断言四行，不因标题/Loading出现就算通过。

### 最小无Host探针

`features-cron-probe.tsx` 固定时间 `2026-03-07T15:00:00Z`，分别记录 system.resolvedOptions、UTC/固定offset/纽约的 Intl.formatToParts、parser.parse、next、完整preview。每个步骤独立捕获完整异常，不因前面失败跳过后面；无Host/网络/用户配置操作。

main 在 `packages/nsh` 串行：

```sh
"$NSH_BIN" test features-cron-probe.tsx <<'EOF'
await app.waitFor("id:features-cron-probe-report");
console.log("[features-cron-probe]", app.texts().join("\n"));
EOF
```

注意 probe 的固定offset是分别检查 Intl 和 parser 的真实行为，不预设二者接受相同语法；Luxon固定区语法与Intl offset语法本身也可能不同。真实异常必须保留在报告，不以probe命令退出0冒充全部能力通过。

### 原生窄契约与生产接线

新增独占 `ios/ScheduleDateBridge.swift`，只读 `schedule.dateContext`：

```ts
// request，四个字段完全匹配；数字为整数epoch milliseconds
{ hostID: string, timeZone: string, startMs: number, endMs: number }
// response
{
  schemaVersion: 1, hostID: string, timeZone: string, startMs: number, endMs: number,
  transitions: Array<{ atMs: number, offsetSeconds: number }>,
  anchor: { timestampMs: number, era: number, year: number, month: number, day: number,
            hour: number, minute: number, second: number, weekday: number, offsetSeconds: number }
}
```

- 范围 `[startMs,endMs)`；首条 `atMs === startMs` 表示该瞬间真实offset，后续严格递增，不跨界猜offset。单次最大64×366天、最多1024条；无效字段/时区/范围/非递增transition/过期Host明确throw。
- Offset/transition来自 Foundation `TimeZone`，anchor来自 Gregorian `Calendar` + 同一时区；服务端不读或解析cron，不创建调度、网络或凭据。
- JS `features-schedule-date.ts` 校验scope/schema、完整转换表及Calendar anchor，将真实offset表作为 Luxon ZoneLike 交给**原cron-parser**；无自造cron方言或调度算法，无全局Intl/Settings修改。
- `features-cron-parser.js` 提供真实静态adapter函数 `parseWithDateZone`。cron-parser的TS tz类型只列string，但已审安装源码：tz原样进入Luxon的ZoneLike，`normalizeZone` 接受offset-bearing对象。该版本依赖路径用真实parser回归，不能在升级依赖时假定继续成立；没有ambient declare/native stub/TS强转掩盖缺失能力。
- NSH格式化按每次真实发生时刻的offset调用固定offset Intl，**不是用一个offset覆盖全年**；跨DST每次分别读取权威数据。覆盖不足会扩展native范围并从同一个currentDate重新计算，失败保留完整异常链，绝不猜范围外offset。遇到次分钟offset等格式能力缺口仍显式失败，不造成功。
- TaskEditor effect按输入/语言/Host重算，旧attempt/Host/卸载响应不提交；UTC/GMT固定零偏移且direct路径成功时无native调用。命名IANA始终使用Foundation，即使它恰好等于设备时区、direct暂时接受，也不把“未抛错”当完整tzdb/DST正确性证明；direct有异常时保留完整原始链，direct无异常则不伪造异常。

main 独占文件必须接两处：

1. `nsh.json` capabilities.host 加 **`schedule.dateContext`**。
2. `ios/main.swift` 保留 `private var scheduleDate: ScheduleDateBridge?`，在已创建RuntimeBridge的分支注册：

```swift
let scheduleDate = ScheduleDateBridge(app: surface, capture: { [weak bridge] in
    guard let bridge, let hostID = bridge.store.selected?.id else { throw CancellationError() }
    let transport = try bridge.resourceTransport()
    return ScheduleDateScope(hostID: hostID, isCurrent: transport.isCurrent)
})
self.scheduleDate = scheduleDate
```

桥接是无状态本地计算，调用前后检查capturedScope.isCurrent；没有待取消的网络/缓存，不需要额外onInvalidate副作用。`build-ios.mjs` 已动态收集ios/*.swift，无需手写来源列表。本worker未改main/nsh.json，未做iOS production build。

### Foundation真实capture → headless验证，不能手填DST

`tests/features-date-capture.swift` 只调用上述真实Foundation service。捕获纽约2020–2050规则；同时核对Kathmandu非DST政治offset、Apia跳日、Lord Howe半小时DST的表查值与Foundation直接查值。任何漏转换直接失败，不把方法名字里的daylightSaving当完整性的证明。

`tests/features-date-host.mjs` 由这个真实capture生成无import headless host：只对capture涵盖的请求切出精确转换表，未知范围失败。原fixture-host的全部写请求禁止保持不变。生成过程不计算cron、不手写纽约规则。

main 在仓库根执行（先加capability）：

```sh
swiftc packages/nsh/ios/ScheduleDateBridge.swift packages/nsh/tests/features-date-capture.swift -o packages/nsh/.nsh/features-date-capture
packages/nsh/.nsh/features-date-capture > packages/nsh/.nsh/features-date-capture.json
node packages/nsh/tests/features-date-host.mjs packages/nsh/.nsh/features-date-capture.json packages/nsh/.nsh/features-date-host.js
FEATURES_DATE_HOST=.nsh/features-date-host.js FEATURES_HOST_TRACE=1 ./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features-ui.test.ts
```

原 `tests/features-host.js` **不预置假的日期服务**；未提供capture/缺capability时生产会明确显示native-context失败，并附原始Intl/CronDate异常。不可用默认Host重跑失败后把它误诊成又一个算法故障。

### 本worker验证与剩余边界

- 18项纯Vitest通过：包含完整异常链、拒IANA Intl条件下真实parser+ZoneLike的DST结果/格式与Web逐值一致、遥远闰日覆盖扩展、坏context显式失败。这里的DTO seam数据明确是unit fixture，**不作为Foundation/QuickJS运行证据**。
- features专属tsc通过；Swift核心+capture的Foundation-only `swiftc -typecheck`通过，UIKit/NativeShell条件编译块不在此检查范围。
- 独立features UI fixture与原始cron probe bundle通过；仅build，不是engine运行。
- main还必须跑原始异常probe、真实Foundation capture、capture驱动UI，以及注册后的production iOS build/实际UIKit预览。完整纽约runtime本轮仍未绿，H/S/D不变。

## Main 引擎复验追记

- 原始 QuickJS probe 已实际执行，证据在 `.scratch/nsh/features-cron-probe.log`。纽约 Intl 明确抛 `RangeError: Invalid time zone specified: America/New_York`；直接 cron-parser 抛 `CronDate: unhandled timestamp`。UTC/固定offset成功不能替代纽约时区。
- 已编译并运行 `tests/features-date-capture.swift`，使用 Foundation 生成真实转换数据，再由 `features-date-host.mjs` 生成隔离 fixture；没有手填 DST 表或访问真实 Host。
- `schedule.dateContext` 已加入生产 capability 并在 `ios/main.swift` 注册 captured scope。
- 带 `FEATURES_DATE_HOST=.nsh/features-date-host.js` 串行执行 `features-ui.test.ts`、`appearance-settings.test.ts`、`settings-outer.test.ts`、`chat-header-ui.test.ts`：**4文件15项通过**，包含四个实际 Next runs、dirty 返回保稿及真实目录/model/variant/Agent选择。
- 此结果是 Foundation capture 驱动的真实 QuickJS 引擎，不是生产 UIKit/Host/真机证明；注册后的 iOS build 与 UIKit 运行仍需另验。

### 默认测试装配修正

`features-ui.test.ts` 未显式设置 `FEATURES_DATE_HOST` 时，现在会在独立临时目录编译现有 Foundation capture、运行捕获并生成 import-free Host，再运行原有四个 Next runs 和离页保稿断言。显式 Host 参数仍可覆盖；捕获、编译或生成失败会使测试失败，不退回缺日期服务的默认 Host，也不跳过用例。临时目录在测试结束后清理。

2026-11-07 此默认命令已实际执行：**1 file / 1 passed**。该变更只修复测试装配，没有修改生产日期、时区或 cron 算法。
