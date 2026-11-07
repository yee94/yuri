# Native Chat Goal / Tasks：独立实现与接线合同

日期：2026-11-07。C/F/H/S/D 分别是**生产接线 / fixture / 真实 Host / 模拟器 / 真机**。追加授权后，本分工已修改 `state.ts` 的 Goal 发送/authority 与 Tasks 投影，并调整关联纯测试；没有修改新会话/Host fence helper、application、chat-header、chat-changes、features、iOS 或语言字典。Chat JSX 整合、NSH 引擎交互与设备验收归 main，以下未完成项仍全部属于 scope，不是 MVP 删减。

## 真实 Web 手机证据

这是源码证据，不冒充手机截图或浏览器交互证据。工具目录检索过下层派发能力，仅发现 session 管理、models、worktree 和资源接口，没有 general/task/spawn 工具，因此未能派发下一层 general，直接读取了下列源码。

| 来源 | 已确认的真实行为 |
| --- | --- |
| `packages/ui/src/components/chat/SessionGoalButton.tsx:18–109` | 仅 armed 或已有 Goal 时显示 chip；armed 删除仅取消本地 arm，已有 Goal 删除调用 native clear；4000 字符 counter，不截断目标 |
| `packages/ui/src/components/chat/SessionGoalRow.tsx` | 目标单行、原生 status、rounds/maxRounds；目标打开详情；非 complete 才有 pause/resume |
| `packages/ui/src/components/chat/SessionGoalDialog.tsx:15–43` | 手机使用 MobileOverlayPanel；显示完整 objective、status、rounds/maxRounds、reason；暂停/恢复/移除成功后关闭，失败保留可操作状态 |
| `packages/ui/src/components/chat/ChatInput.tsx:3097–3133` 和 `DOCUMENTATION.md:911–925` | typed `/goal` 和 armed 发送在普通队列之前路由，忙时也直接执行 command；不能创建普通队列 chip 或 authored 消息；composer queue/steer 仍要透传；queue 不切模型/Agent，steer 使用现有选择应用流程 |
| `packages/ui/src/lib/sessionGoalActions.ts` | panel pause/resume/clear 只传 `session.command({sessionID,name:'goal',text})`，不带 composer delivery，不 interrupt，不 dismiss question |
| `packages/ui/src/queries/sessionGoalQueries.ts` | `rpc(Goal.Definition).get`，`rpc.opencode.goal.changed` 更新权威快照并取消旧 GET；重连回读；失败保留旧值；没有第二个 socket/Goal 定时器 |
| `packages/ui/node_modules/@opencode/schema/dist/goal.{js,d.ts}` | 官方状态只有 active/paused/complete；id/objective/status/rounds/maxRounds/boot/updatedAt，optional reason/stalls；不是旧版 blocked/evaluating/budgetLimited |
| 安装的 `@opencode/client/dist/chunks/mcp-yn2a71yh.js`、`mcp-kdshn947.js` | raw RPC：`POST /api/rpc/opencode.goal/get?location[directory]=…`，body `{input:{sessionID}}`，响应 `{output}`；command：`POST /api/session/:id/command`，204，body name/text/files/agents/skills/delivery，没有 message ID |
| `packages/ui/src/components/chat/StatusRow.tsx:80–141,179–255,320–351` | Tasks 非计划任务。transcript → 非空 legacy live → persisted fallback；cancelled 不显示；保留原顺序；入口有未完成项才显示；手机标签 Tasks；completed/total、active/left；展开时定位首个 in_progress，否则首个 pending；手机 Tasks/Changes 同一互斥 owner |
| `packages/ui/src/sync/session-todo-projection.ts:128–190` | 新版本没有 todo 服务端状态/todo.updated。取已加载且已按 revert 截断的最新可用 todowrite **input.todos**，running 也可用，显式 [] 清空；跳过失败/aborted 等调用；todoread/output 不是最新清单的 authority |
| `packages/ui/src/components/chat/todo/{todoStatus.ts,TodoList.tsx}`、`packages/ui/src/index.css:2065–2098` | glyph、状态标签、3 行 clamp、2.4s 虚线环、已完成份额 pie、240ms 行入场/count tick、260ms glyph pop；只有外部 liveWorking 能使图标工作/让首个 pending 显示为进行中，不改服务器任务状态 |

NSH 官方文档：Context7 `/longbridge/nsh`，查询 Overlay anchor/outside/cancel 与原生 motion/reduceMotion。Overlay 脱离父布局；外点、Escape、Android back、VoiceOver escape 应关闭。当前安装的 NSH 0.4 声明同时用于 API 类型验证。没有借用 WebView、React runtime、新依赖或新 Host 路由。

## 新增模块

| 文件 | 职责 |
| --- | --- |
| `chat-goal-model.ts` | Goal wire decoder、注入式 transport、发送前分流 planner、scope owner；读写/事件/arm CAS/取消 fence；无 runtime 请求副作用 |
| `chat-goal.tsx` | signals owner、Goal chip/counter/row/原生 Sheet；复用现有状态 label mapping 和全部已有翻译 |
| `chat-tasks-model.ts` | 原始 Native todowrite 输入投影、Web source precedence、只读 summary 和手机互斥浮层 owner |
| `chat-tasks.tsx` | 原生 Tasks trigger、锚定 Overlay、仅展开才构造 List 行、居中当前项、SVG glyph/pie 与原生动画；没有请求或历史工作状态猜测 |
| `chat-goal-fixture.tsx` | 离线合成 Goal + 300 Tasks；不 import application/state/runtime；Changes 按钮仅演示互斥 owner，**不是**生产 Changes 测试 |
| `chat-goal-model.test.ts` / `chat-tasks-model.test.ts` | Vitest 纯协议/状态/计数回归；不运行 nsh test，不发 Host/模型/语音请求 |
| `state.ts` / `chat-goal-state.test.ts` | 单一生产 Goal owner、durable 发送与真实工具域 Tasks 投影；mock NSH/Storage/transport 的纯状态回归 |

共享：复用 `SESSION_GOAL_OBJECTIVE_CHAR_LIMIT`、`SessionGoalStatus`、`sessionGoalStatusLabelKey`、`toTodoStatus`、现有模型/事件适配及字典。Web 的最新清单 projector 虽是纯函数，其**所在模块**静态导入持久 store/repository，不能安全带入 QuickJS。因此这里只做 Native 原始 input string → object 的小型对应投影，不复制浏览器 store 或新建第二套同步系统；单 owner 只保留最后一个 input 的结果，不缓存历史数组。

## main 必须接入的合同

### Follow-up：可选 getter 与 durable delivery authority

精确新增签名（返回对象与既有 API 保持不变）：

```ts
createChat(target: ChatTarget, dependencies: {
  followUpBehavior?: () => 'queue' | 'steer' | null;
} = {})
```

main 从已有单 root appearance snapshot 注入，不让 state import appearance：

```ts
const chat = createChat(target, {
  followUpBehavior: () => nativeAppearance.current()?.followUpBehavior ?? null,
});
```

- 只在**新建 composer Submission 且 busy**时读取 getter 一次；idle 固定 steer。省略 getter、null 或无效运行时值均默认 queue。普通输入、文本/status 事件、Goal panel 控制、既有 pending/retry/recovery 不读取 getter，也不请求设置。
- delivery 在异步编译/网络之前写入原 journal；偏好或 busy 随后变化不能改变这一条发送。unknown 普通 prompt 保留稳定 ID、delivery 与 compiled resources，重启后也一样；unknown typed/armed Goal 不 reconcile/replay。初次新会话已安装的 steer payload 不被当前 queue 偏好覆盖。
- queue 不发模型/Agent/variant selection mutation 或顶层 override，让原生 inbox runner 消费时继承 session authority；steer 继续走既有选择流程，本改动不增加或改写 selection owner。纯测试证明 wire 无 selection 写入，真实消费时的模型继承仍归 main Host/设备验收。
- `settings-preferences-core.ts` 只改 follow-up 的 initial 为 queue，保留其他字段消费者。legacy `immediate → steer` / `queueModeEnabled === false → steer` 的 root snapshot 归一化由 appearance owner 接入；state getter 接收规范值，不导入 Web 持久 store，也不在重试时重新归一化。
- main 已反馈 Goal/Tasks UI 与受 `sessionGoalEnabled` 控制的 observe 接线完成；本分工未改其 JSX 或扩大 observer gate。

### Goal：state 已经接管唯一 authority 与生命周期

```tsx
const chat = createChat(target); // 沿用现有实例，不再为 Goal 新建 Chat
cleanup(chat.goal.observe()); // 普通 session 的 UI 挂载时一次；返回幂等 disposer
const goalOpen = signal(false);
<NativeGoalRow owner={chat.goal} enabled={goalEnabled} active={chat.active()}
  open={goalOpen()} onOpenChange={value => goalOpen.set(value)} />
<NativeGoalChip owner={chat.goal} enabled={goalEnabled} />
<NativeGoalObjectiveCounter armed={chat.goal.state().armed} length={chat.draft().length} />
```

1. **不要在生产 Chat 再调用 `createNativeGoalOwner`，也不要自行转发 SSE 或建第二份 Goal signal/controller**。此 factory 仅供离线独立 fixture；生产 UI 的 `NativeGoalOwner` 已改为结构化只读接口，直接兼容 `chat.goal`。
2. state 在首个 observer、活跃恢复、现有 scheduler 合并的 reconnected/server.connected/global.disposed 和 command ACK 后读取 RPC。Goal 不在 `allChatDomains`，4 秒 safety poll 不读 Goal。observer 最后释放时 fence read；没有新 socket/定时器。
3. state 的现有 runtime.event listener 接收 changed：带目录的 global/chat 事件均按目录/session 校验；仅已按目录订阅的 chat channel 可补其已知目录，global 缺目录不能猜。changed 取消旧 GET authority，不触发 transcript GET。
4. 现有 active/前后台清理调用 controller.cancel；Host generation retirement 清空 Goal/arm 和 Tasks。main 继续维护 `chat.active` 与浮层关闭即可，不另外管理 Goal 请求生命周期。取消只作本地 fence，不声称底层 HTTP 已物理 abort。
5. `goalEnabled` 只控制显示，不暂停执行。目标完整文案、counter、reason、原生 status/rounds 保留；complete 只有移除。UI 不能从历史/busy 猜 Goal 状态。
6. 精确 API：`chat.goal.state()`；`chat.goal.controller.{scope,refresh,setArmed,captureArm,toggle,clear}`；`observe()` 返回 disposer。pause/resume/clear 通过 state.send 共用 history/send lane 与 pending gate，**不能**绕过 state 直接调用 raw transport。

### Goal：发送分流已经在 state，main 仍调用原 send

```ts
chat.goal.controller.setArmed(true, optionalObjectiveOverride);
const goalArm = chat.goal.controller.captureArm(); // 可选；send 默认捕获当前本 owner arm
const ok = await chat.send({
  inputMode, goalArm,
  ...(existingPrepare ? { prepare: existingPrepare } : {}),
});
```

- `SendOptions.goalArm` 在第一处 await 前复制；既有会话可省略，typed `/goal` 不需 arm。主 UI 不再自行调用 planner/raw command、不再重复 clear 草稿/arm；state 已在普通 prompt 分支之前用 `planGoalSubmission` 分流。
- Goal 不读/不依赖 command catalog。即使目录未注册 Goal、目录为空或 catalog 请求失败，也走原生 Goal。其他注册 slash 命令的 catalog 校验保持不变。
- 只有原始已捕获 Goal 意图才会解释编译正文；普通 prepare 输出即使以 `/goal` 开头也仍是普通 prompt。引用安全验证及 command token provenance 保留。4000 raw/compiled limit 均不截断、不 distill。
- Goal preparation 继续接收原始 `SendPreparationInput`（完整 text/files/scoped references）；命令发送真实 compiled files/agents/skills，metadata 不伪装为 SDK 不支持的 command 字段。raw/compiled 字符长度超限或 prepare 失败保留草稿、附件、引用与 arm。
- busy 时仍立即 native command，delivery 保留提交时 queue/steer，不二次 enqueue，不产生 authored/inbox optimistic 行，不触发 interrupt/question cancel/第二次 kickoff。state 没有增加模型/Agent 切换；任何现有选择应用流程仍须遵循 queue 不切换、steer 使用权威选择。
- Goal 使用原 durable Submission 格式：`command:{name:'goal',text}` 冻结类型，compiled 冻结资源/最终正文；`preparedText` 在 Goal 下也可先冻结显式 objectiveOverride。journal 不保存 transient arm owner/revision。未修改 model/drafts schema、Host fence helper 或新会话模块。
- panel pause/resume/clear journal 拥有**空 text/files/references 文档**（持久化的明确 panel contract），因此 ACK 只清该 pending，不清 composer；body 不带 delivery、文件或模型配置。它共用 history lane，但不隐式 commit 用户 staged revert。composer Goal 仍沿用已有 revert commit→write-ahead→command 顺序。
- ACK 只对匹配 draft revision/document/附件作原 CAS 消费。arm 使用 controller owner identity + revision CAS，不消费准备期间的新 arm；别的 controller/新 draft 的 arm snapshot 不能误清当前 arm。新 draft materialize/转移由现有代理处理，state 仅消费给定真实 session 的 Goal，不能对空 session 发请求。
- command ACK 后 RPC 回读是异步只读；GET 失败只设置 readError，已消费的 pending 不恢复/不重发。失败 transport 原始 HTTP status 保留原 pending 4xx/unknown 策略。unknown command 不做 inbox/message-ID reconcile，`retrySend/recoverPendingSend` 都不能重放，重启后也保持该约束。later 普通 pending 不受后来新 arm 劫持。
- main 的既有 pending retry UI 应区分 `chat.pendingSend()?.command?.name === 'goal' && uncertain`：显示未知结果并提供 `chat.goal.controller.refresh()` 人工核对，而不是暗示稳定-ID重试。GET 无法证明某次 command 的交付 ID，因此不能仅凭 objective 相同自动清除未知记录。恢复/显式放弃的 UX 仍需 main 验收；state 不自动重试或丢弃。

### Tasks：单一已加载清单投影与共享浮层 owner

```tsx
const statusPopovers = createNativeChatStatusPopovers();
<NativeComposerTasks
  todos={chat.tasks()}
  liveWorking={chat.busy()}
  active={chat.active()}
  expanded={statusPopovers.opened() === 'tasks'}
  onExpandedChange={statusPopovers.tasks}
/>
```

- **不要在 main 用 computed/projectTasks(chat.messages())**。`chat.tasks()` 是 state 已投影的只读数组；投影只接成功 messages hydration、已有工具事件发布批次、真实 revert boundary/reset。100 个 text delta、200 次输入、busy-only 和无变化 status safety read 都零额外任务扫描/发布。
- state 复用 `createTasksProjection`，不复制算法、不开全局 store、不读额外历史。保留原始 message/content 顺序与真实 revert 边界；失败 history read 保留已显示任务，成功空 authority/显式空 todowrite 清空；Host retirement/reset 清理。
- `liveWorking` 只用已有实时执行 authority。历史/persisted in_progress 可描述清单，但不能推导全局 working/spinner，也不能改变 send/stop/queue admission。
- **必须让生产 NativeComposerChanges 同时受同一个 owner 控制**：传入 `expanded = opened()==='changes'` 与 `onExpandedChange=statusPopovers.changes`。Changes controlled 接口与 Chat JSX 由 main 完成，本分工不修改它。禁止只在 Tasks 打开时通知一次而让 Changes 保留平行状态。
- Tasks 没有单独 Tasks CRUD、计划任务路由或手动推进按钮；当前 Web 只读清单。打开/关闭 Overlay 不得改变 transcript/composer 父布局；outside/cancel、切换 Changes、隐藏/背景均关闭。所有任务完成时与 Web 一致隐藏入口/浮层；不额外造完成卡片。

## C/F/H/S/D 与完整缺口

| 能力 | C | F | H | S | D |
| --- | --- | --- | --- | --- | --- |
| Goal raw RPC shape / schema / null vs failure | 已接 state 单 owner；main 需 observe/UI | 生产 state 纯测试覆盖 | 未请求 | 未验收 | 未验收 |
| Goal changed 压过旧 GET、重连/隐藏/换 Host fence | 已接既有 state SSE/active/scheduler | state 回归含 50 reconnect 合并/失败/Host fence | 未验收 | 未验收 | 未验收 |
| Goal row、chip、counter、完整目标/reason、pause/resume/clear、complete | 可复用组件，未接主 Chat | 离线 fixture + 静态构建；未跑引擎交互 | 未请求 | 未验收 | 未验收 |
| `/goal` / armed 忙时直达 command，queue/steer、资源保留与 4000 限制 | 已接 state.send 原有 lane/journal/CAS/revert | state 回归含 compiled 资源、失败/重启/unknown/ACK读失败 | 禁止在本分工触发 | 未验收 | 未验收 |
| 新 draft、plan/fork arm 生命周期与 draft→session 消费 | main 的 materialization/CAS 接线待完成 | 只覆盖空 ID 无 IO、override、arm 保护 | 未验收 | 未验收 | 未验收 |
| Tasks 最新 todowrite、running/失败/空清单/revert/raw JSON/source precedence | 已接 state.tasks/tool/hydration/revert/reset | state 回归：100 delta/200输入/busy 0 扫描发布；失败保留/空成功清空 | 未请求 | 未验收 | 未验收 |
| Tasks 原序/cancelled 过滤/count/当前项/只由 live 动画 | 组件已实现，未接主 Chat | 纯数据语义覆盖；300 项 fixture 构建 | 未请求 | 未验收 | 未验收 |
| Tasks/Changes 互斥、outside/cancel、生命周期关闭 | 共用 owner 已实现；Changes controlled 接口与主接线待 main | 纯 owner 同步互斥/迟到关闭覆盖；fixture 不含真实 Changes | 未验收 | 未验收 | 未验收 |
| Tasks Overlay 不推挤 transcript、长列表滚动/当前项居中 | Overlay + List/onLayout scrollToIndex 已实现 | 构建不是几何证据；未跑 engine | 未验收 | 未验收 | 未验收 |
| 动画/视觉/字体/颜色/无障碍/十语 | glyph/pie/ring/行入场/count tick/pop 与现有翻译已接组件 | 静态构建而非视觉证明 | 未验收 | 未验收 | 未验收 |

尚未关闭的具体视觉/行为差异（全部保留为 scope）：

- Goal active/paused/complete 的 target tint 尚未完整复现：当前共用 Icon 仅能用 foreground/background，chip 只对 complete 文案用了 success。main 应从单 root Host 主题映射 semantic info/muted/success，不用硬编码蓝色或新建主题读取。
- Tasks in_progress Web 文字 shimmer 尚未实现原生等价；原生 motion 代码存在不等于动画曲线/中间帧/Reduce Motion 已通过。count 数字 tick、glyph pop、行入场、2.4s 环都仍须真实帧对齐。
- `List.scrollToIndex(viewPosition:.5)` 对 300 条变高任务的居中、长文本 3 行、开始/尾端可达、任务更新后不反复抢滚动尚无 engine/UIKit 证据。List 的合成 height 是上限估计，不代表测量过真实行高。
- `pathLength`/SVG dash 在原生 SVG 后端的精确虚线密度/线宽、pie、主题亮暗、长标题/目标/错误、Sheet 安全区/软键盘/屏幕旋转需验证。Goal Sheet 不改主 Chat 滚动 owner。
- base Button 的 0.4 类型没有 accessibilityState；Tasks expanded 放在 anchor View，VoiceOver 是否正确关联到内部 Button、current step 使用 selected 的原生语义都须设备校验，不能将类型通过当 AX 通过。
- 初始 GET、重连丢事件、Host 切换、传输失败保留、command ACK 后读失败、未知 command 人工核对、panel 清除后关闭、complete 行行为与十语切换均待主界面联调。所有用户可见 copy 复用现有字典，**本轮无新增 key，因而无需新增十语翻译表**。
- 主 Chat 生产输入预算、50 次事件的 P95/最大值、IME/undo/paste、普通队列与 Goals 同屏、键盘/焦点恢复仍须 main 按 composer 合同测量；本轮零 IO 的纯测试不替代性能验收。

## Follow-up 追加验证记录

- **15 files / 256 tests passed**：在原 14 个纯回归文件上追加 settings-preferences-core；其中新 follow-up state 回归 20 项，覆盖 100 组 text/status 事件及输入零 getter/设置读取、两种 busy 偏好、idle/default/无效值、编译中偏好变化、准备失败、unknown 重试/重启资源快照、typed/armed Goal 不重播、queue 无 selection 写入、installed steer 保留及 panel 不读偏好。
- `bunx tsc --noEmit -p packages/nsh/tsconfig.json` 于 15:36 最新快照通过；此前全包阻塞不是本轮修改其文件修复的结果。
- `bun run dead-code` 已执行并检查：仍报告仓库 unused files/exports/types 与配置提示，包括离线 Goal fixture 和 `createNativeGoalOwner` 等；没有为消告警删除代码。
- 仅 pure/mock/static 验证；没有运行 NSH engine、构建、模拟器/真机、真实 Host、模型或语音。未改 application/appearance/iOS/main/locales/new-session 或 Host fence helper；不运行 git，不加依赖。

## 上轮 state 追加验证记录（历史快照）

- **14 files / 215 tests passed**：state、Goal state/model、Tasks model、drafts、composer、references/mixed、history state/messages、transcript actions/state、model、projection dependency boundary。全部是 Vitest pure/mock/static 测试，未启动 NSH 引擎、设备、Host 或付费模型/语音。
- `bunx tsc --noEmit -p packages/nsh/tsconfig.json` 在 15:14 快照通过；15:19 最新全包检查被其他分工 `transcript-tools.tsx:139,145` 的 unknown Element / Text selectable 类型错误阻塞。未修改该文件。仅 include 本轮 state、Goal/Tasks 源与 offline fixture、继承 NSH 配置/globals 的独立依赖闭包 tsc 通过，不宣称最新全包绿。
- 原 generic catalog failure 回归已改测 `explore`：Goal 现在刻意不依赖 catalog；新增 state 用例同时覆盖 Goal catalog 缺失、普通 command 仍校验 catalog、普通 unknown prompt 不被新 arm 劫持。
- Tasks state 用例在 **2000 条普通历史 + 首尾测试消息**上对生产 `createTasksProjection` spy 与实际 signal publication 作操作计数；100 text delta + 200 input + busy-only + 无变化 status read 均零额外扫描/发布。不靠耗时断言，也不靠 UI render 次数。busy 仅改变 summary 的 live glyph 输入，tasks 数组保持同一引用。
- 本轮重新执行并检查 `bun run dead-code`：Goal/Tasks UI 和字符串 fixture 仍因 main JSX 尚未接入而列 unused，另有仓库既有 files/types/duplicate 告警；未为消告警删除其他分工代码。
- 此追加阶段没有运行 fixture build、`nsh test`、NSH engine/模拟器/真机测试或真实网络调用。前一阶段的离线 bundle 不代表当前 state 的原生运行结果。

### 前一阶段独立模块验证（历史，不替代本轮 state 验证）

- 最终 Vitest：**2 files / 29 tests passed**。仅两个独立 pure test 文件；不执行 `nsh test`，不运行全包 engine/UI 测试。命令：`bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts packages/nsh/chat-goal-model.test.ts packages/nsh/chat-tasks-model.test.ts`。包括 command ACK 不复用在 ACK 前发起的 reconnect GET。
- 独立 TypeScript 检查只 include 新增五个源/fixture 文件，继承 NSH tsconfig 与其 globals：通过。完整 NSH tsconfig 检查曾因其他分工的 `transcript-body.tsx` `ScrollView`/Part.time 错误失败；未修改该文件，也不声称全包绿。
- 首次 fixture build 因 `nsh` 不在 PATH 未启动；随后定位已有 NSH distribution，仅构建到 `.nsh/goal-fixture-bundle`。首次成功构建发现不支持的 `text-muted-foreground/60`，已换成受支持的 semantic 文本色 + opacity；最终 build 成功且无该 warning（4.3 MB JS / 2.6 MB bytecode）。
- fixture source map 检查：34 个源，未包含 React、Zustand、Effect/OpenCode runtime 或 application/state/runtime。该构建是离线编译证据，不是 runtime/Host/设备证据。
- `bun run dead-code` 已执行并检查：新增尚未生产引用的 `chat-goal.tsx`、`chat-tasks.tsx` 与字符串入口 fixture 被列为 unused；同时有大量仓库既有 unused/type/duplicate 告警。未删除其他分工或用户代码，未声明零告警。
- 本分工没有 Host 请求、付费模型/语音调用、Host 设置变更、iOS 构建/安装/启动、浏览器或设备操作。

## main：生产 App 接线、toolbar 溢出定位与回归

以下是 main 在 2026-11-07 反馈的实际 headless 结果，不是独立测试分工自行执行的 engine 记录；更新前文历史快照里对应的“未接主 Chat / 未跑 engine”状态，不扩展为真实 Host 或 UIKit/真机验收。

### 已定位的精确原因与 main 修复

- 三个生产 `App.tsx` 场景均已到达 Goal row、Native test model、Active、Tasks/Changes，但窄屏查询得到 `send=0 stop=0`。main 将同一实例 viewport 改为 `app.setViewport(1000, 874)` 后，`stop` 立即变为 1。
- 根因是 **Goal chip 与模型/Agent selection 的 intrinsic 宽度将右侧 send/stop 挤出可见范围**，不是 `/api/session/active` 协议错误，也不是 busy、Storage 或 reactivity 故障。纯状态检查不能发现这个原生布局问题。
- main 仅在 `chat-composer-selection.tsx` 的 selection 根 View、model Button 和 model Text 补入 `flexShrink: 1` / `minWidth: 0`，允许模型显示区域收缩；未删除 Goal、模型、variant、Agent 或发送/停止能力。本测试分工未重做该生产修复。
- 修复后 main 串行运行 `goal-tasks-chat.test.ts` 与 `composer-send.test.ts`，反馈 **2 files / 14 tests passed**，其中原三个生产 App engine 场景全部通过。这是新增下述长标签窄屏参数化场景**之前**的快照，不能当作新增场景已通过。

### 已准备的生产回归边界

- 原场景继续覆盖已有 Goal details → pause/resume/clear、busy typed `/goal` 原生命令（不产生普通 prompt/inbox）、普通 queue 不切 selection、Tasks/Changes 互斥及关闭后的零挂载行。
- 已移除临时 `[DEBUG-goal-stop]` 日志，保留明确的 `waitFor('id:stop')`、composer 空值断言，并在发送消费草稿后再次等待 stop；不删除 busy/stop 验收绕开窄屏问题。
- 新增 **320 / 375 / 402pt，高 874pt** 三个生产 `App.tsx` toolbar 场景。synthetic Host 可配置完整长模型名 `Synthetic exceptionally long reasoning model display name` 与 variant `extended-reasoning-high`，不改变生产配置或请求真实 Host。
- 每个宽度检查 Goal chip、Agent 入口与标签、完整模型＋variant accessibility label、variant 文字仍可访问；busy 空输入时 stop 可见可用，输入后 send 可见可用，并实际点击 send。随后确认普通 queue 出现、草稿清空、stop 恢复，receipt 仍为 `selection=0 faults=0`。最后实际打开模型 picker，检查完整模型名和 variant 保留，没有靠删字段缩小验收范围。
- 每个场景仍使用独立临时 Host bundle 与独立 fixture Host ID，既有草稿/附件不会跨场景继承。所有 mock 请求采用 exact method/path 白名单；没有真实网络、付费模型/语音、Git 命令或设备操作。

### 最新独立 pure 检查与待 main 执行项

- `bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/goal-tasks-chat.test.ts -t 'no NSH engine'`：**11 passed / 6 skipped**。跳过的六项包括原三个生产 engine 场景和新增三个窄屏场景；本分工没有启动 NSH。
- `node --check packages/nsh/tests/goal-tasks-chat-host.js`：通过。pure real-state 保留 fresh busy/empty、恢复草稿/附件、跨 Host draft 隔离、历史 Tasks 不推导 busy、native Goal 与普通 queue receipt 回归；新增长模型/variant 的完整 authority/catalog 校验。
- 新增三宽度 engine 场景交 main 串行运行，尚无执行结果。headless `shows` / accessibility label 查询不是 VoiceOver 验收，也不是 UIKit 字体截断、真实软键盘、安全区或设备触达的几何证明；这些缺口继续保留。
