# New Session UIKit 独立验收载体

## 当前 baseline 准备：仅 fixture admission 修复，尚无本轮 dragfix

**后续状态更新：**main 已固定并安装 baseline `2026-11-07T13-46-16-017Z-8c000e21` 后正式解锁生产。当前已有 starters dragfix；修后 hash、原四红及 collapsed AX/hit 真缺陷、126 项纯验证、独立 review 和待 main 的真实手势步骤，统一见 [NEW-SESSION-STARTERS-DRAG-VALIDATION.md](../../NEW-SESSION-STARTERS-DRAG-VALIDATION.md)。本节后续内容保留为 baseline admission 准备记录，不能再用“尚无 dragfix”描述当前源图。

**main 实测更新：**修后包 `2026-11-07T14-11-52-588Z-3091937e` 已由 main 构建/签名/安装/启动，f1 批次确认折叠 AX、同排、显式展开后的跨行、删除、项目内排序和跨组 no-op。审计 settingsWrites=3、configWrites=1、deniedSessionWrites=0，无额外跨组写，fixtureRetain.version7 保留。一次 Back tool 超时仅在后来 AX 中看到已回 root，仍是 invalid；多指/Sheet/后台/取消/连续重排/FPS 尚未验收。执行归 main，本 worker 只读核对 audit 文件；完整 hashes、证据与现有 probe 的取消能力边界见上述专项文档。

生产 `new-session-page.tsx` 和 `new-session-ui-helpers.ts` 在 main 复制 baseline 依赖闭包前保持冻结。本轮只给合成载体补入真实 `connection.list` snapshot；fixture 在 active lifecycle 时通过生产 `loadConnections()`，并检查 `captureHostOperation().current()` 确认 root adoption 后才挂载导航。inactive 启动或等待期间退到后台不放行，下次 active 再读合成 snapshot；不再手动 `app.connection.set` 冒充 readiness。新增的 native grant 仅为只读 `connection.list`，未授予 select/connect/stream/PTY 或真实网络权限。

合成 snapshot 使用固定 Host `new-session-uikit-synthetic`、authorizationID `fixture-memory-authorization` 和 runtime lease `new-session-uikit-memory-lease`。所有 runtime.request（包括读取）必须携带逐字段完全匹配的 `expectedHost`；缺省、旧 lease、其他 Host、附加字段均失败关闭。它们是公开合成身份，不是外部 Host 或凭据。配置写入仍只在内存；session create/prompt/command/shell/model/agent 路由仍拒绝，误短按会留 deniedSessionWrites 而不会调用模型。

Foundation-only 测试已观察 connection.list 在修复前红灯，修复后 28 项通过；另有 3 项实际 fixture bootstrap 纯测试覆盖 inactive/adopted readiness、await 期间失活、快照失败不冒充成功，共 **31 项通过**。fixture 入口的完整 TypeScript 依赖闭包检查通过；构建脚本执行 `node --check` 语法检查通过。worker 未构建 UIKit App、未启动 engine/device，实际 build/install/gesture baseline 全由 main 串行执行。构建 manifest 的 `fixtureAdmission` 标明此修复，不能把本次准备当作生产拖拽修复。

当前 `NativeSheet` 真实调用 `yuri.sheet.presentation`，已在 fixture `uikit-main.swift` 注册 `NativeSheetPresentation.install(on: surface)`，构建 Swift 清单含 `ios/SheetPresentation.swift`。只读源依赖检查未发现本 fixture 的 new-session/picker 路径引用 NativeSelect/DatePicker，未加入不需要的 native registration。

独立 `new-session-starters-drag.test.ts` 只执行完整生产 Starters JSX/控制器及原回调，native widget/measure 为纯端口；当前 **1 绿、4 红**，尚无生产修复。main 可按以下真实手势观察 baseline，不能用纯几何结果代替 UIKit：

| 场景 | 真实控件/路径 | 纯回调红灯 | main 待核验 |
| --- | --- | --- | --- |
| 普通短按 | 根页 `new-session-uikit-open-fixture-project` → `new-session-preset-explore` | 对照绿：一次 onSubmit、零 preset 写 | 由于禁止 session，短按应被合成 Host 拒绝一次，不能调用模型；此场景用独立新包/清洁草稿与拖拽审计分开 |
| 折叠单行向下拖 | 不点 `new-session-presets-expand`，在 Explore 真长按后向下跨行/向右上 `new-session-presets-trash` 移动 | 拖动项祖先仍 `maxHeight:28/overflow:hidden` | 保存轨迹录像，观察 chip 是否被裁切及是否保持宽度；preset 写仅 release 时允许一次 |
| plus Sheet 与 hold | `new-session-presets-add` 开 Sheet 前后验证旧 chip 触摸取消、关闭后再次拖动 | plus Sheet 打开仍留 hold/drag gate | 系统 Sheet 应隔离背景；尝试多指/保留触点交错，记录 NavPage 返回手势恢复；不能用假按钮调用 controller |
| 多指取消 | Explore 上第二触点加入，然后释放 | 取消可被后续 native pressDown 清掉，onPress 进入 submit | 真实双触点序列；期望 settingsWrites/configWrites/deniedSessionWrites 均无增量 |
| 宽度/行数变化 | hold 后旋转或改变窗口使 chips 换行 | geometry 未退休，仍可按旧 target 写入 | 记录 reflow 前后 AX/画面及审计，期望旧 gesture 不 commit，下一次新手势使用新几何 |

全局长 command：`new-session-preset-review-accessibility-and-keyboard-navigation`、`new-session-preset-compare-two-long-implementation-proposals`；项目 command：`new-session-preset-inspect-project-specific-release-readiness`；项目 skill：`new-session-preset-skill-review-variable-width-wrapping-and-touch-targets`。全局 release 只允许 settingsWrites，项目 release 只允许 configWrites（可能先有合成 mkdir），两者不得相互搬组，草稿/inputID/unknown journal 不属于 drag 写入范围。

## 边界与产物

- 原样挂载 `NativeNewSessionPage`，模型／Agent／项目及预设 Sheet 均由生产组件拥有；当前呈现使用 `NativeSheet` 的系统 pageSheet 与真实 UIKit completion。没有 WebView、替代 UI 或测试拖动按钮。
- 本机 NSH 0.4 的公开 `NshAppView` Swift 接口有 `loadBundle`、`handle`、`grantCapabilities`，没有 webHost JS loader。因此使用 `SyntheticHost.swift` 的 Foundation-only 内存映射。
- 只注册及授权 `connection.list`、`runtime.request`、`fixture.newSession.capture`、`fixture.newSession.audit`。connection.list 仅返回内存合成 snapshot，不编译生产 `RuntimeBridge`、连接存储或 Keychain 源码；不授予 network/WebView/openUrl/speech/picker。静态 NativeShell 的系统链接依赖不代表授权这些能力。
- 配置读写都在 Swift 内存中，**不接触 Host 文件系统**；只有生产草稿的 NSH Storage 使用本测试 App 的独立 sandbox。所有 session 创建、prompt、command、shell/model/agent 写入均失败关闭，不能调用模型。误点预设也只会被拒绝，不应得到假成功。
- `seed.json` 含 2 个项目、7 个全局预设、2 个项目固定项、长 command/skill 标签、3 个 primary/all Agent（另有应被排除的 subagent）、2 个长名 Provider、3 个模型及 variants。测试数据是合成内容，不是真实提供商能力。
- 每次构建独立 bundleID `example.nsh.new-session-uikit.run-<随机值>`，输出到 `.nsh/new-session-uikit/<timestamp>-<随机值>/`，不覆盖主 App 或其他 fixture。

构建（仓库根目录；只编译，不安装/启动）：

```sh
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/scripts/build-new-session-uikit.mjs
```

`fixture-build.json` 记录确切 App、bundleID、SDK/target、源文件 SHA256、原始图标资源、能力和构建/签名验证结果；先运行生产 fixture 依赖闭包 tsc。`AX-STEPS.md`、`AX-ISOLATION.md` 与 `PICKER-NATIVE-OWNERS.md` 是构建时快照，UIKit AX／视觉／键盘字段均默认 false，不能把编译当验收通过。脚本将源依赖逐字节暂存到中性目录，解决 NSH 对 root 外图片生成绝对 asset URL/漏拷贝的问题；它不是维护第二份 UI。沿用已安装的生产依赖，实际版本及逐文件哈希以 manifest 为准，不安装或改依赖。

## main 串行安装与验收

### 当前优先红灯：Search AX 与 Agent 关闭后 Model 重开

`3f51bbee` 的真实 Agent 初开已隔离应用背景且 Build／Plan ID 可达，但其真实 TextField 没有 testID／label；选择 Build 后再点 Model 也未展开。两项均未通过，不能用初开成功覆盖。系统返回 Terminal breadcrumb 不处理。

fixture 和 production native main 均注册 `ios/NewSessionPickerOwners.swift` 与 `ios/SheetPresentation.swift`：前者只给三个实际 UITextField 写原 testID／本地化 label，后者配置确切系统 Sheet。没有替代输入或假 AX 控件。关闭后通过真实 UIKit completion 释放 root，再 keyed 构造新 generation，**不依赖 public Dialog.onClose 必定送达，不设 delay**。完整接线见 `PICKER-NATIVE-OWNERS.md`，当前验收边界见 `../../SYSTEM-SHEETS-VALIDATION.md`。

新包优先验收：

1. Agent 长按后，按 `new-session-selection-search` 找到实际 TextField（不是 Group／marker），localized label=Search agents。真实 focus、输入 Build／清空、中文输入、键盘收起；不能猜旧 frame 坐标。
2. 点真正 `new-session-agent-build`，等待真实 Sheet 退出和 native completion；再点 `new-session-model`，必须出现 model Sheet 和同 ID 的真实 TextField，label=Search providers or models。循环 Agent→Model→Agent，不只首次展开。
3. 预设 `new-session-presets-search` 和项目目录 `new-session-directory` 同样须为实际 TextField、带相应本地化 label，可聚焦／编辑；Input 原视觉、value／onChange／输入法行为不变。
4. 同时核对 single scrim／panel 几何、背景 AX、选择／收藏与关闭恢复。native 日志仅含 `[new-session-presentation] <generation> ready/dismiss-requested/dismissed`、固定 input ID 或 failure code，不含输入内容；有 failure 即停。记录每代真实 completion，拒绝用等待数秒当修复。
5. 任何 native owner 未注册、ID／label 仍缺失、键盘不可达、第二次打不开均保留红灯。下面的其它手势／审计仍全部保留，不缩减验收范围。

### 系统 pageSheet 承载：迁移后必须重验

`NativeNewSessionModels` 的实际 picker 根 View 使用 `role="group" accessible={false}`，保留原有动态 label、布局、元数据和子控件 testIDs。NSH `e626a8d` 的 `native_view.rs:228–236,457–467` 会把有 label、未指定 accessible 且非容器 role 的 View 默认作为单个 AX 元素；原始失败 AX 因此只剩 Sheet 尺寸的 `Select agent`，没有 Search/Build/Plan。focused source props 合同测试覆盖 model/agent 两种模式及真实 Input/Button IDs，**不是 UIKit AX 运行结果**。

main 安装本次新 manifest 对应 App 后，先重新做真实 650ms Agent 长按并捕获 AX：必须能找到 `new-session-selection-search`、`new-session-agent-build`、`new-session-agent-plan`，再通过真实控件继续选择、释放和关闭验收。模型 Sheet 同样须检查真实搜索、模型行、收藏和展开后的 variant ID。任何 ID 缺失即停下，不猜坐标，也不用背景伪控件代替。

**当前使用 `NativeSheet → Dialog presentation="pageSheet"`，不再嵌套窗口内 Sheet。** UIKit 唯一拥有 scrim／panel／grabber／拖关闭与滚动 handoff；模型采用系统 72%/98% detents。根 `accessible={false}` 仍只负责取消内容 AX 合并，不替代系统模态隔离的设备验收。

业务 intent owner 保留不可逆的进入中取消和该代 active fence，通用 `NativeSheet` 管实际 controller。真实呈现完成后才激活内容；退出保留旧模式／内容，真实 UIKit dismiss completion 才释放该代并启动最新 queued intent；重复／迟到事件幂等。后台／Host 失效关闭 intent，cleanup 请求确切原生 owner dismiss；没有新增全局背景 AX gate。

Chat 与新会话保留各自业务内容，但系统容器共用 `NativeSheet`；不是把新会话业务状态移入 Chat。

main 必须先分别打开 Agent／模型／项目／预设四种 Sheet，保存进入前、展开、键盘出现、退出中与关闭后的完整 AX 和截图：

1. 展开时真实 Search／Build／Plan、模型行／收藏／variant、项目目录和预设 search／pin 均可达；背景 composer／预设／项目按钮、系统标题／Back、Tab／shell 不可 AX 聚焦或激活。只看缺少少数背景 IDs 不够。
2. 同 viewport／safe area 核对系统 detents、圆角、grabber 和底部 inset，只有一个系统 scrim；旧手绘几何是历史参考，不是本轮系统拖动的证明。
3. 真实聚焦搜索、系统键盘展开／收起、VoiceOver escape、外点、下拖、选择后关闭：退出期间内容不先清空，真实 dismiss completion 后才释放 root；关闭弹层不能 pop 唯一 NavPage，关闭后系统 Back／swipe、草稿及下一次 picker 恢复。
4. 快速开关／取消后马上重开、进入中后台再恢复、退出中后台再恢复都记录完整 AX；旧 callback 不得关新 Sheet，背景不得永久不可达。fixture 不接真实 Host，Host 代际失效目前只有生产 page VM 回归，不能声称已 UIKit 实测。
5. 任一背景泄漏、透明空壳、键盘布局变化、重复 scrim／系统返回或错误均保留失败原文与画面，不以静态绿灯抹去。

原有 `new-session-native.test.ts` 的七个 `newSessionUIScenarios` 加一个 production Projects 场景（共八个）和 `new-session-ui-steps.ts` 保持不变，供 main 串行复跑；本轮不执行 engine。原先八场景通过是修复前历史证据，不能充当本轮重新运行结果。

只有 main 在 UIKit 空闲后，使用 manifest 内的实际路径和 bundleID 安装/启动。该包是 **arm64 iOS Simulator** 开发验收包，不是已签名真机包；最低 iOS 15，Liquid Glass 需要 iOS 26。

```sh
# 以下是 main 的操作说明，本构建脚本不执行：
xcrun simctl install booted <manifest.app 对应路径>
xcrun simctl launch booted <manifest.bundleID>
```

开测前记录设备、系统、viewport、字体缩放与深浅色。至少用一个窄屏和一个宽屏/横屏，**用真实触摸长按和拖动**。源码阈值为 200ms/500ms；自动化可用 300ms/650ms 的安全余量，不把余量误称为阈值测试。精确阈值另测 150/250ms、450/550ms 并记录实际触摸时序。

### AX 审计合同（不侵入被测页面布局）

根页入口：`new-session-uikit-open-fixture-project`、`new-session-uikit-open-other-project`、`new-session-uikit-open-audit`。审计只在独立根页/审计页出现，生产页面与 Sheet 保持完整 viewport。

审计页 `new-session-uikit-audit-refresh` 只读取内存快照。AX identifiers：

| ID | 真实含义 |
| --- | --- |
| `new-session-uikit-count-captures` | 成功收到生产 `onSelection(directory, model?, agent?)` 通知的次数，不是按键次数 |
| `new-session-uikit-count-settingsWrites` | 已通过合同校验并写入内存的 settings PUT 次数 |
| `new-session-uikit-count-configWrites` | 已通过合同校验并写入内存的项目 fs/write 次数 |
| `new-session-uikit-count-mkdirCalls` | 成功的合成 mkdir 请求次数，不是配置写入次数 |
| `new-session-uikit-count-rejected` | 真正失败的 native/request 调用次数，不算空成功 |
| `new-session-uikit-count-deniedSessionWrites` | 被拒绝的 session 写入尝试次数，正常手势验收应为 0 |
| `new-session-uikit-lastCapture` | 最新真实目录/模型/variant/Agent；无模型为 null |
| `new-session-uikit-settings` | 当前内存 settings：全局排序/收藏/无关字段均可核对 |
| `new-session-uikit-projectFiles` | 当前内存配置的完整文本：项目排序/删除及无关字段可核对 |
| `new-session-uikit-journal` | 递增 sequence 的 capture/settings-write/config-write/mkdir/rejected 记录 |
| `new-session-uikit-snapshot` | 完整 JSON，含 reads/requests/auditReads、策略与 journalDropped |

审计 Text 的 `accessibilityLabel` 是完整 JSON，不靠视觉截断后的片段。journal 保留最近 128 项，计数不回退；丢弃数单独报告。读取审计不会增加 captures/settingsWrites/configWrites。新页面初始化、恢复、重开本身可能发送空值/恢复值通知：**不要把跨导航 captures 增量等同于手势增量**；按 journal 中实际值和最后 capture 验证。Agent 已接第三参数，因此 Agent 变化也应留下 capture。

`new-session-uikit-fixture-error`、`new-session-uikit-audit-error`、`new-session-uikit-native-error` 任一出现均保留原文并标记失败。生产 `new-session-presets-retry`/`new-session-catalog-retry` 不应在正常合成场景出现；不可靠忽略错误完成验收。

### 1. 真实 200ms 拖排序/删除

#### iOS 26 右上拖删除与系统返回手势：本轮重验

main 的旧包 `a9ffec45` 已真实确认 AX Search/Build/Plan 可达、Agent 长按释放不 cycle、Explore→Weigh 写入一次且 Back/重开保留排序；这不是本轮新包的 UIKit 运行结果。随后展开长标签后，Review-accessibility→垃圾桶的右上拖动返回了 fixture 根页。记录中 touch 起点约 `(175,489)`、终点约 `(366,397)`（402×874 viewport），begin 到首个 move 约 631ms，尽管脚本 requestedHoldMs=300；中间等待垃圾桶 AX 查询。因此它证明一次真实拖动失败，不证明精确 300ms 时序。

现有 Starters 手势通过 boolean callback 上报到唯一 `NativeNewSessionPage` 的 `popOnSwipe`：touch-down/hold 与已激活 drag 期间为 false，release/cancel/终止/多指/隐藏/失活/测量失败/销毁后恢复 true。仍在原有 200ms timer 后激活拖动；未替换系统 Back、未设置 `popOnBack=false`、未新增 recognizer 或删除权限。main 在旧包 `99e6cc77` 已确认一次真实长标签右上拖删除留在新会话，审计 settingsWrites=1/configWrites=0/denied=0/rejected=0，普通 Back 正常；这不是全部手势已通过，也不是本轮 Dialog 包运行结果。

纯 VM 回归调用真实 JSX 的 touch/responder callbacks，经过生产 Page→Body→Starters 的 callback 链观察实际 NavPage `popOnSwipe` 表达式；仅用合成 `measure()` 几何，不模拟 UIKit recognizer。覆盖 199/200ms、drag publish、右上删除一次且不 submit、重复 release 幂等、touch cancel、responder terminate、多指 move/start、active/keyboard/background 隐藏、销毁、缺失/失败/迟到测量及恢复后普通原生 dismiss/reopen 保草稿。通过这些测试不能替代实际返回手势验收。

main 用新 manifest 对应 App，重新执行完整“排序→Back→audit→重开→Expand→长标签右上拖删除”链路，不跳过导致旧红灯的导航顺序。每次手势保存：

- begin 前源控件完整 AX node/frame、viewport/方向；trash 出现后目标完整 AX node/frame；均由真实 testID 定位。
- 请求 hold、begin/每个 move/end 或 cancel 的实际时间戳、首个 move 的实测间隔、AX 查询耗时；旧脚本未保存前置 frame，本轮补齐，不能从最终根页 AX 倒推源 frame。
- 结束后的完整 AX、截图、所在路由、fixtureerror，以及随后 audit 的 writes/captures/journal。成功删除须仍在新会话页，只产生预期单次 settings/config write，不能触发 session 写入或模型调用。
- 分别验证取消、多指、隐藏后重开、普通系统 Back 按钮和下一次正常 swipe；导航应恢复、草稿仍在。旧红灯与新包结果分开保存，不覆盖旧记录或旧 App。

背景 AX 模态隔离仍是上节明确列出的待验收项，手势门控本身不证明隔离成功。

1. 点 `new-session-uikit-open-fixture-project`；等待 `new-session-composer` 与可用的 `new-session-presets-add`。如折叠，点 `new-session-presets-expand`，确认长标签跨行且拖动不拉伸。
2. 对 `new-session-preset-explore` 实际按住约 300ms，然后拖到 `new-session-preset-weigh` 中心并释放。仅 `global` 同组排序；指下元素平移，其他元素让位。不能点击预设（点击会提交并被 Host 拒绝）。
3. 系统 Back 回根页 → `new-session-uikit-open-audit`：`settingsWrites` 应比此前增加 1；settings.draftStarters 开头由 `explore,catch-up,weigh` 变为 `catch-up,weigh,explore`，其余原序，无关字段保留。
4. 返回根页、重开并展开。按住 `new-session-preset-review-accessibility-and-keyboard-navigation`，拖到按住后出现的 `new-session-presets-trash`（原 `＋` 的真实位置）中心并释放。
5. 审计确认再增加 1 次 settings 写，仅该固定项消失；不是删除 command catalog。跨组拖到项目项不得写入/换组。
6. 项目项 `new-session-preset-inspect-project-specific-release-readiness` 与 `new-session-preset-skill-review-variable-width-wrapping-and-touch-targets` 同组拖换；审计应只增加 configWrites（mkdirCalls 可增加），settingsWrites 不变，配置的 `fixtureRetain.version=7` 保留。
7. 单独验证短划/不足 200ms、取消、多指、松手后重按不误触提交；失败/误触必须体现在 rejected/deniedSessionWrites，而不能被吞掉。真实手势抢占、落点、过渡是否等同 Web 必须由画面/录像判断。

### 2. ＋ Sheet 与持久化

1. 真实点 `new-session-presets-add`；等待 `new-session-presets-search`。查找长命令及技能，确认 loading/error/空搜索结果区分正常。
2. 点 `new-session-pin-skill-fixture-review`：项目配置写 1 次，Sheet 关闭。Back/重开后该项固定，`＋` 搜索中不再提供。
3. 全局可选 `new-session-pin-command-craft-goal`，只增加 settingsWrites；切第二项目不应继承第一个项目的固定项，但应共享全局固定项。

### 3. 500ms Agent 长按、释放及取消

1. 真实按住 `new-session-agent` 约 650ms；等待 `new-session-selection-search` 和 `new-session-agent-build`。选 Build 后关闭。
2. 再长按；等待 Sheet 就绪后释放，不选任何 Agent，向下滑关 Sheet。按钮仍应是 Build；审计 lastCapture.agent 仍为 build，journal 不得出现释放引起的 plan。
3. 短按按钮，应按真实 primary 目录顺序 `Build → Plan → 长名称 Agent → Build` 循环；不得进入 subagent Explore，短按不能打开 Sheet。每个实际 Agent 改变应有对应 capture。
4. 长名称 Agent 的头像若没有预生成模板，保留生产的未知 seed 行为，不能用其他 Agent 冒充。分别记录长名、说明断行和循环标签动画表现。

### 4. 收藏不切模型/variant/Agent

1. 点 `new-session-model`，等 `new-session-effort-favorite-fixture-gpt-model`；展开并选 `new-session-variant-favorite-fixture-gpt-model-low`。长按 Agent 选择 Plan。
2. 重新打开模型 Sheet；点 `new-session-favorite-recent-fixture-claude-model`。Claude 应进入收藏，Sheet 不关闭，不能选中 Claude。
3. 点 `new-session-favorite-favorite-fixture-gpt-model` 取消收藏；等该行消失，再点 `new-session-favorite-all-fixture-gpt-model` 加回。必要时展开 `new-session-provider-fixture`，不点模型行。Sheet 始终保持。
4. 向下滑关闭，Back → 审计：本组三次星标操作严格增加 3 次 settingsWrites，窄 patch 只含 favoriteModels；最后 capture 必须仍为 fixture/gpt-model/low + plan。GPT 加回的 variant=low，recentModels 与其他 settings 不被覆盖。

### 5. 返回保草稿与目录隔离

1. 在 `new-session-composer` 输入中性文本 `UIKit draft survives Back`，系统 Back 回根页。
2. 重开同项目，文本完整恢复，模型/variant/Agent 恢复结果在 capture 中可查。不要点击 send。
3. 第二项目初始草稿不得继承第一项目；其空模型 capture 保留 `/fixture/other`，不得带前项目模型。

## 失败处理与证据边界

配置与收藏仅当前进程内存持久；Back/重开会保留，**重启进程会重新播 seed**。草稿 Storage 则保留在该独立 App sandbox。因此冷启动验收优先使用新的构建 bundleID；不要通过卸载主 App 来清数据。

已编译/纯协议测试不等于 UIKit 验收。此载体不证明生产网络、真实模型、Relay、凭据、输入法时延或真机签名。main 需留存实际截图/录像、AX JSON 和上述每项结果，未运行项保持未验证。
