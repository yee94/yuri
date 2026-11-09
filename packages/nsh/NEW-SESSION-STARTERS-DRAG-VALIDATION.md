# 新会话首页 chips 拖拽：修复与交接

## 范围与证据

本轮生产改动仅位于 `new-session-page.tsx` 的 `NativeNewSessionStarters`，没有改 application/main、Swift、state/runtime、共享 NativeSheet、GUI/Notification、durable draft、inputID、create/admission receipt 或未知发送恢复。没有增加产品入口、依赖或假拖拽按钮。`new-session-ui-helpers.ts` 的组内排序、二维 closest-center、translation-only shifts 保留。

main 已将修前源码依赖闭包固定并构建/签名/安装/启动 `2026-11-07T13-46-16-017Z-8c000e21`，page SHA256 为 `73072fddc6ba6fb841223a37c12ceb3c3c4e0b25bd4dd9fab5f44c84309335e2`。这之后用户才解锁生产修改。

修后稳定点：`new-session-page.tsx` SHA256 = `e959bfff011f5db0993fa6251c3b87dbce6a0fd6dc736f31d48386d1f8aea5a1`。helper 未改，SHA256 仍为 `3c3c17912215823bace9f87522b2bde9c25038070334cbbd6a7e5a568f32d701`。main 新构建的 manifest 应逐字节对应这份源图；这不是 worker 已构建/安装或已经 UIKit 验收的声明。

真实基线由 main 独占：旧包无 root adoption 时所有控件 disabled 的记录不能作为 drag 证据；修复 fixture admission 后，同排排序曾观察到真实顺序变化，不能称基础 sort 全坏。main 随后撤回“crossrow d1 跨行成功”：画面始终折叠首行，但 AX 中下行 enabled，隐藏 workspace-review 仍可参与 drop 并改变顺序。这是当前确定的折叠 visibility/hit/drop 缺陷。审计包含前次超时手势最终 release 的写入，不能将累计 settingsWrites 全算给最后一次手势。

worker 没有操作 UIKit/设备/helper/engine；本文纯测试红绿是生产回调和合成几何证据，不是原生验证。后续“main 实际 UIKit 执行”单独记录 main 回报的设备结果及 worker 对审计文件的只读核对，不能归为 worker 执行。

## 缺陷与生产处理

| 缺陷 | 修前位置（baseline page） | 处理 |
| --- | --- | --- |
| 折叠拖动项被 `maxHeight:28/overflow:hidden` 裁切 | Starters JSX，约 375 行 | drag 期间解除裁切，但保留 28pt 占位；不展开其他行、不拉伸 dragged chip |
| 折叠下行 chips 暴露 AX/可按/可 drop | 同一 JSX 与 339–343 行测量 | wrapper 本地 `onLayout` 的 origin/size 决定是否完整位于 28pt 可见行；未知先禁用。下行在 idle/drag 时均 AX hidden、pointerEvents none、opacity 0、Button disabled，且不能开始手势/submit；collision 排除下行。显式展开才恢复多行 |
| plus Sheet 打开仍保留 hold/drag | 370 行 effect、379 行 plus handler | 打开同步取消，所有 chips 动作检查当前页面/visible/!open；保留 callback 也不能在 Sheet 下提交 |
| 多指取消、迟到 pressDown 重新放行 | 376 行 Button pressDown | touchActive 记录当前 raw touch；触摸期间 pressDown 不重置 suppression，包括 200ms 后等待 measure 的窗口。新的非触摸 pressDown 仍可重新激活，避免永久阻断键盘/AX |
| A 的旧 onPress 借 B 新手势 admission | 同一 Button 回调与共享 suppression | pressedID 绑定所属 chip，press 再核对实际 items 成员及当前可见性；A 不借 B，删除项不提交 |
| reflow/catalog 到达后沿用旧几何 | 原 375 行 onLayout、293 行 catalog 设置 | 容器宽高、任一 wrapper 位置/大小、items 变化均退休旧 geometry/ticket；迟到 measure 不重新发布。重复完全相同 layout 不取消 |

当前源码定位：可见性在 `chipVisible`（269 行），碰撞过滤在 `beginDrag`（343 行），触摸结束与剩余手指处理在 `finishDrag`（368 行），布局失效在 `layoutChips/layoutChip`（379/384 行），绑定 chip 与成员核验在 `pressStarter`（390 行），JSX 的 AX/命中/禁用在 415–416 行。行号随其它 owner 工作可能变化，应同时核对上面的 hash。

局部布局坐标只用于裁切判定；碰撞仍用 `measure().pagePosition` 和 touch `pageX/pageY`，两者按 NSH 当前类型合同均为 surface points。没有把 page 坐标与 local bounds 混算。128 项每次 activation 各测量一次；move 只使用冻结 rects，目标不变沿用 shifts，不拉目录、不写配置。

## 实际纯验证

`new-session-starters-drag.test.ts` 的首次实际运行是 **1 绿 / 4 红**：普通短按对照绿，裁切、Sheet gate、多指重放行、宽度 reflow 红。按 main 的真实基线补出的 idle collapsed AX/hit 测试也已实际先红，再修复。

最终以 `--maxWorkers 1` 串行运行六文件 **126 项全部通过**，NSH 全包 tsc 通过。此前最后一次并行运行有 124 项通过、2 项在 page beforeEach 加载阶段触及原 10 秒 hook 限制，未进入行为断言；没有修改 timeout/断言，串行重跑全部通过。

- starters-drag：17 项；完整生产 Starters JSX/controller，只以 native widgets/measure 为端口。包含原四红、idle collapsed AX/hit、展开恢复、不同宽度跨行 shifts、project command/skill reorder/delete、跨组 no-op、100 move 零请求/零写入、128-chip 一次测量、native press、blur、迟到 pressDown/measure、retained A callback、迟到 catalog，以及多指中仅一指先结束不能重放行。
- 原 page：24 项，保留 NavPage popOnSwipe、200ms、取消/多指/keyboard/background/cleanup、目录与 shared native sheet 的强断言。
- 原 UI：28 项，包含 release 才持久化、fresh preference merge、项目根目录与无关字段保留、失败快照、50 move shifts 引用复用。
- durable/admission/recovery：57 项，仍验证未知/ACK 不重播、create 不重复、source/journal 保留。

纯测试端口新增真实 wrapper `onLayout` 的本地 bounds，没有删除旧断言或以测量 API 假设替代原生手势。原生几何、焦点/VoiceOver 是否投递具体 callback、UIControl 和 PanResponder 的交接、动画、实际滚动 handoff 仍须 main 测量。

本轮真实执行了同模型 `magpie-remote-magpie%2Fcodex/codex/gpt-6.1-sol` 的独立 plan 只读审查及复审；reviewer 未改文件、未运行测试/设备。首轮指出新 native press、迟到 pressDown、retained A 回调和同尺寸 catalog 布局失效，均已补修并覆盖回归。复审确认主要可见性/碰撞/ticket 路径，另发现删除项 refs 键未清理及部分触摸结束提前清 touchActive，已分别在 items 变化处清理旧键、按 event.touches 剩余手指保留取消状态。

复审还保留两个平台证据边界：blur 后如果原生没有任何 end/cancel/release/terminate，native-only 激活可能仍被 suppression 拦住；不能猜 timer 清状态而放行仍按住的触摸，main 必须检查实际事件终态。128-chip 纯回调预算不等于响应式桥接或真实帧率证据；初始 layout Map 更新和共享 drag 订阅的 UIKit 成本尚未实测。本轮不宣称这两项已平台验收。

## main 实际 UIKit 执行：3091937e / f1

执行者为 **main**，不是本 worker。main 已构建、签名、安装并启动 `2026-11-07T14-11-52-588Z-3091937e`，报告 manifest 的 page SHA256 与上述 `e959bfff…` 稳定点匹配；bundle SHA256 为 `b403d998056219786917712fbe234f715deec0a682383d7a7f2c2ea21f79c0e6`。以下画面/手势结论来自 main 的执行回报；本 worker 只读解析了保存的 audit AX 文件，没有复做手势或设备检查。

| main 已实际执行的场景 | 结果与证据边界 |
| --- | --- |
| 折叠 AX | 仅 Explore/Catchup，下行 workspaceReview 等隐藏项已从 AX 消失 |
| 同排排序 | Explore→Catchup 换位一次 |
| 展开后跨行 | 先点 Show more，截图确认全 9 项可见，再将 Explore→workspaceReview；顺序正确。与此前 d1 隐藏目标误命中的撤回记录明确区分 |
| 删除 | Weigh→起手前记录的 plus 固定槽位；held.png 显示 trash，最终删除 Weigh |
| 项目组内排序 | project command→project skill 顺序正确，项目无关字段保留 |
| 跨组悬停 | Catchup→project skill，没有搬组或额外写入 |

操作证据前缀为 `.scratch/nsh/home-drag-fixed-*-20261107-f1`；审计文件为 [home-drag-fixed-audit-20261107-f1/after.json](../../.scratch/nsh/home-drag-fixed-audit-20261107-f1/after.json)。worker 只读核对其 `new-session-uikit-snapshot` 的 AXLabel JSON：

- `settingsWrites=3`：journal sequence 2、3、4 均为 settings-write，对应 main 回报的同排、跨行、删除。
- `configWrites=1`：sequence 5 为 mkdir，sequence 6 为 config-write；项目配置 `fixtureRetain.version=7` 保留。
- `deniedSessionWrites=0`；journal 为 sequence 1 capture、2/3/4 settings-write、5 mkdir、6 config-write，没有额外跨组写。
- `syntheticOnly=true`、`networkEnabled=false`、`sessionWritesEnabled=false`，这些结果属于内存合成 fixture，不能扩为真实 Host/模型验收。

main 的一次 Back 探针 tool 超时，随后 AX 确认已经回到 root：该探针保留为 **invalid**，不能算 Back/取消/返回手势验收通过，也不能仅凭超时认定生产错误。多指、Sheet 交错、后台、取消、连续重排及 FPS 仍未完成，当前不是全量 1:1 验收。

## 现有取消入口与 main 下一步可测路径（仅静态建议，未执行）

所有取消场景都应在每个 case 前后保存空闲 AX/画面及 audit，以 `ΔsettingsWrites=0`、`ΔconfigWrites=0`、`ΔdeniedSessionWrites=0` 和内容顺序未变为取消预期；之后再做一个独立有效排序，预期恰好增加一次对应组写入，确认没有永久锁住。当前 Weigh 已删除，后续使用仍存在的 Explore/Catchup 等 ID，不复用旧 frame。

只读检查 `.scratch/nsh/home-drag-probe.mjs`：现脚本仅支持 `tap` / `drag`，drag 固定单指 begin → 300ms hold → 18 move → end，没有触点 identifier、显式 cancel、可调 hold、后台或 Sheet 中途插入参数。因此不能用它已经证明多指、<200ms swipe、原生 cancel 或生命周期交错；worker 未改该 probe、未调用它或 helper。

| 入口 | main 可行的实际步骤 | 当前驱动与结论边界 |
| --- | --- | --- |
| 无目标变化的 hold/release | 现有 probe 用仍可见的同一 chip 作为 source 和 target，原地 hold/release；再检查 audit 与无误发送 | 现有单指 drag 可直接驱动；这是无变更释放，不冒充 `touchCancel` / responderTerminate |
| plus Sheet 正常开关 | `new-session-presets-add` → 观察真实 Sheet / `new-session-presets-search`；不点 pin，用系统原生下拖/外点/escape 关闭；再展开 chips 做一次有效排序 | 开入口已有 tap；Sheet 关闭必须用真实系统手势。正常开关不写配置，但它不证明“持指时打开 Sheet”或后台旧回调已被原生取消 |
| 多指取消 | 在可见 chip hold 后加入第二触点，先抬一指再抬另一指；不得 submit/write；之后新单指能拖 | 需 main 使用已确认多触点能力的原生驱动/真实双指输入；不能用两次单指 begin/tap 假装两指 |
| 预激活滚动/取消 | 初始 hold 小于 200ms，先移动超过 6pt 再 release；检查页面滚动、没有 drag/write/send；新 hold 可拖 | 现 probe 固定 300ms 不覆盖。需 main 在自己的驱动中提供可核对的真实时序；不要声称 199/200ms 纯测试就是 UIKit 测量 |
| 后台与前台 | 已 hold 的触摸经真实系统 Home/切换使 app 进入后台，释放触点后回到同一 fixture；检查没有迟到写/发送，再做新手势 | 需 main 的系统生命周期操作和可靠终止触点清理；不以重建 JS 页面、注入 state 或重新安装替代恢复 |
| keyboard/失焦 | 实际聚焦 `new-session-composer` 或 Sheet search 出现系统键盘，chips 不可交互；收键盘/关 Sheet 后新手势恢复。持指中焦点变更须另测真实交错 | 入口 ID 已有；须确认 raw end/cancel/release/terminate 是否到达。不能手调 JS onBlur/onTouchCancel 当平台证据；review 的 blur 末事件边界仍保留 |
| reflow 与返回冲突 | 实际横竖屏/窗口宽度变化打断 hold；取消后新布局重新取 AX 目标。返回需单独测系统 Back/边缘返回，记录实际 route、草稿和手势终态 | 需要 main 控制系统输入；一次 BackButton 点击不等于边缘返回手势。已超时的 Back 探针不得补记通过 |
| 连续重排 | 在同一合法前台页，复用仍存在的同组 chips 做多轮排序，每轮结束后才取 AX；逐轮 audit 恰好增一、跨组零增量 | 现有 drag 可重复驱动。记录真实视觉稳定性与丢帧；host-send 间隔/脚本耗时/静态 screenshot 不作为 FPS 或 UIKit receive 时钟 |

持指期间继续遵守“不查询 AX、仅使用已核对的起手坐标与 held.png”的 main 工具链约束。无论取消成功与否，都不得调用未授权的真实 Host、模型、PTY 或导入；不为清理测试状态重放未知创建/发送。worker 本轮仅更新文档，不再修改生产代码或执行设备动作。

## main 修后真实手势路径

1. 新构建保留 fixture admission：真实合成 snapshot → `loadConnections()` → current root operation。记录 manifest、page/hash、实际前台 App/buildID；拒绝混入 NativeChromeQA 或旧 disabled fixture。入口仍为 `new-session-uikit-open-fixture-project`。
2. **先验折叠**：保存截图与空闲 AX，以画面实际可见首行为准。下行 `new-session-preset-workspace-review`、长 command、project skill 不可被 AX 激活；不要拿 AX 全表当视觉目标。长按首行 Explore，向下/向右上移动时 lifted chip 可见且自身宽度不变，其他下行不得露出。plus 原位置变 trash，释放仅一次组内写，无 deniedSessionWrites。
3. **再显式展开**：点 `new-session-presets-expand`（Web 的 Show more），确认多行在画面中可见，再选择真实可见目标跨行。全局目标：`new-session-preset-explore`、`new-session-preset-catch-up`、`new-session-preset-weigh`、`new-session-preset-workspace-review`、`new-session-preset-review-accessibility-and-keyboard-navigation`、`new-session-preset-compare-two-long-implementation-proposals`。按 release 后审计顺序核验，不凭移动动画认定落盘。
4. 项目 command `new-session-preset-inspect-project-specific-release-readiness`、项目 skill `new-session-preset-skill-review-variable-width-wrapping-and-touch-targets`：展开且目标真实可见时做组内 reorder/delete，configWrites 只增一次，settingsWrites 不变；跨 global/project hover 不搬组、不写入。
5. 删除目标 `new-session-presets-trash` 替换 `new-session-presets-add` 的固定槽位。持指时不要发 AX 请求（main 已确认会阻断后续 move）；可用起手前已记录的 plus 槽位中心和 held.png，先按 helper config/AX 同一 viewport 归一化。截图工具的显示缩放不作为事件坐标；记录 host-send 时间，不冒称 native receive 时间。
6. 多指加入、预激活滑动 >6pt、responder/滚动抢占、失焦、plus Sheet、keyboard、后台、返回及旋转/reflow：旧手势不写不 send，释放返回门恢复；下一次新的 200ms hold 可正常拖。原生 sensor 门槛仍为 200ms / tolerance6，不将工具 300ms 安全余量写成生产阈值。
7. 常规短按单独放最后或用独立新包测试：fixture 禁 session，短按只应产生一次 deniedSessionWrites，不能真调用模型。它可能让该目录 durable create 进入 unknown，之后不能继续拿同一目录当空白 drag 场景；不能为方便验收绕过 receipt 或自动重放。

主验收审计仍在独立根页 `new-session-uikit-open-audit` → `new-session-uikit-audit-refresh`，全局看 settingsWrites，项目看 configWrites/完整 projectFiles，drag 期间 deniedSessionWrites 必须无增量。失败要保留 AX/截图/触摸轨迹/最终 audit，与纯测试结果分开。
