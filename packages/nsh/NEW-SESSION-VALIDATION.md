# Native new-session 页面、handoff 与验收

首页 chips 拖拽专项的最新修后源图、红绿证据及 UIKit 待验收路径见 [NEW-SESSION-STARTERS-DRAG-VALIDATION.md](./NEW-SESSION-STARTERS-DRAG-VALIDATION.md)。该专项只改 Starters，不改变下述 durable/admission 合同；旧验证批次不覆盖新的原生手势结论。

## 2026-11-07：retained source / operation-only 恢复合同（本轮优先）

本轮只改 `new-session.ts`、`new-session-admission.ts`、`new-session-page.tsx`、`new-session-fixture.tsx` 及其测试和本文；未改 application、state、runtime、Swift、composer 或外部 input/selection 模块。application 由 Tour owner 独占，下面接线交 main 协调。下文历史记录中的“未知后再次 POST”不再适用：未知首次 admission 一经记账，只允许按原 target/inputID 只读核验。

### 保留对象与权限

`openNativeNewSession` 保留 source、durable draft、Storage lane、receipt、frozen submission、选择和 stable inputID。`operation()` / `replaceOperation(next)` / `captureOperation(requireActive?)` 将网络权限与这些对象分开。默认在新会话页内观察 root operation；admission 显式接管 operation 后，源页面自己的 observer 不再覆盖 Chat 的 operation。源页面 cleanup 会退休页面网络 lane，但不再通过该页面 lifetime 判定 transferred source 的存活。

source 独立比较最初的 Host id/origin/authorizationID；实际变化永久退休，包括 A→B→A。跨前后台只退休 operation，不退休 source。旧 action 捕获原 operation 对象、原 generation、原 scope 和原 sender；恢复不会将旧 continuation 转发给 latest sender。即使 lease 字符串重复，旧 token 和 readiness-gap token 仍失效。

receipt v1 向后兼容新增 `configuration.{model,agent}` 和 `admission`，值为 `unknown` / `acknowledged`。每次配置和首次 admission 在 dispatch 前先持久化 unknown，ACK 后再持久化 acknowledged。已有 unknown/ACK 项不重播。新的恢复 operation 对已知 target 只做 GET 核验；没有 dispatch 过 create、仍处于 draft 的首次显式提交可以完成首次 create/configure。创建已经发出而没有返回 ID 时，保留 creating/inputID，拒绝第二次 create；只允许用户选择具体 ID，再验证同目录、空历史、空 inbox、idle，不选择 latest 或自动认领 catalog 第一项。

admission 保留 sending/unconfirmed/ACK 及 source 清理进度。先等待旧 flight 结束，再用本次捕获的新 token 运行 `reconcile()`；等待期间再换 token，则该次 reconcile 不会借更新权限。GET 查不到、请求失败或命令无法证明完成时继续保留 installed source，不清理未知输入。Goal/command/shell 的 unknown 不以普通 inbox 命中冒充完成。ACK 后本地清理失败只重试清理；本地清理成功会先记录 sourceCleared，再检查旧 operation，因此 Storage 返回与前后台切换交错也可继续 release。

### main 的最窄 application admission 接线

1. 保留原 `createChat`、handoff、source 和 `createNewSessionAdmission` 实例。不要在 epoch 改变时重建它们。`handoff.owner.current()` 是源编辑 gate，transfer 后为 false，不能把它作为 Chat admission gate。
2. 向已有 factory 传 `operation: () => chatOperations.operation()`。该 getter 返回 Chat 已有的 `PageOperation | null`，不要传 source 创建时的固定 generation。`current` 使用稳定页面身份、Chat 当前 active 和当前 route gate，不能再固定 `receipt.generation === epoch()`。
3. 首次导航进入时仅调用一次 `admission.run()`。factory 自身会观察 operation getter 并 `replaceOperation`；main 也可显式调用同名接口，重复同一 token 是幂等的。初始 operation 为 null 时不要发送。
4. 后台/覆盖将 operation 设为 null；有效 replacement 到达后只调用 `admission.reconcile()`。显式 retry 也可调用 reconcile。不要在这个 effect 中重新调用 create、Chat.retrySend、session.command 或 source.submit。不要每次 draft 编辑都触发 reconcile。
5. replacement 到达前应先让既有 state owner 完成 Chat operation 重建，保证 `chat.messageScope.generation` 与 operation generation 一致；不一致只保留 unconfirmed，不借权限。重复 operation getter 不需要重建 admission。
6. 页面真正销毁调用既有 `admission.close()`；临时 cover/后台只替换 operation，不 close。close 等待旧 flight，未知结果持久化保留，不把它当成功清理。源页离开继续调用 `disposePage()`，transfer 已接管时不会丢 source；最终 release 保持幂等。

交付前只读核对当前 application：已有 `operation: operations.operation`、稳定 `current`、首次 `admissionAttempted/run`、`onRetire` 和 close。因此 main 实际只需协调其现有 effect：读取 operation token（而非只读 boolean current），首次仍 run，后续新 token 到达且 active 时调用 reconcile，null 不运行；不因 admissionState 或 draft 更新重复执行。unknown UI retry 建议明确调用 reconcile，现有 run 也已由 journal 限制为只读。独立 `new-session-fixture.tsx` 已改成相同 factory/operation/reconcile/close 路径，未运行其 engine。

该清单只要求 main 增补现有 operation replacement 回调，不要求新路由、重建 Chat、代理 request 或修改其他 owner。此 worker 未覆盖 Tour owner 的 application。

### 本轮验证边界

新增 `new-session-recovery.test.ts` 使用真实依赖追踪 signal/effect、真实 page-operations、新会话实现、drafts/Storage 和 admission，配合严格固定 token 的纯 Host 边界。14 项覆盖 repeated lease/readiness gap、Host/origin/auth 永久退休、create/配置/unknown/ACK/本地 cleanup 的延迟窗口、源页 cleanup 后继续 handoff、原 inputID/附件/引用/选择/后续草稿保留。同一 operation 下未 dispatch 的配置项可首次写入，而 replacement/reopen 不补写。该 fixture 的 Chat 是窄测试适配器；原 core/admission/page tests 仍执行真实 createChat，不把纯适配器称为实际 application 或原生引擎证据。

本轮已真实执行同当前模型 `magpie-remote-magpie%2Fcodex/codex/gpt-6.1-sol` 的独立 plan 只读审查及复核。首轮指出页面 lifetime、未 dispatch 配置和 sourceCleared 三个窗口；复审另指出同一 operation 下第二配置项的预写失败被整组只读冻结。四项均已修复并加入严格回归；最后一次定点独立复核确认配置修复成立，未发现该指定范围内额外问题。审查只读本地源码，没有让 reviewer 改文件或执行测试，不代表 application/engine 验收。

后续 page VM/AX 专项只修改 `new-session-page.test.ts`、`new-session-input-ax.test.ts` 和本文，未修改任何生产页面、controller 或 application。最新六文件 **88 项全部通过**：page 原 24 项、input AX 5 项、durable 32 项、admission 11 项、recovery 14 项及 sheet-presentation 2 项。durable/unknown/create 不重放的原断言保留。

page VM 按当前真实依赖加载 `native-sheet.tsx`、`sheet-presentation.ts`、`new-session-modal.tsx`、`new-session-modal-owner.ts` 和 model-picker presentation；仅原生注册、ref、ready/opened/dismissed 为叶子端口。没有将 NativeSheet 替换成字符串或假 controller。注册 props/events 名称逐字断言；ready 不自动冒充 opened，关闭意图只发 dismiss command，真实 dismissed 事件才释放旧 presentation。原 24 项继续覆盖 Agent→Model 四次切换、旧 generation/回调隔离、退出保留 picker 身份、inactive/background/Host/cleanup、目录切换等待真实 dismissal、延迟 preset 读取后的禁写、200 次编辑的零请求/零同步 Storage/零全局扫描、精确 200ms 长按与各取消恢复路径。

旧 iOS 自绘 Dialog+Sheet 的物理断言已按现有系统 pageSheet 接线转换：等待 opened 前内容为 inactive；关闭时 NativeSheet 意图为 false，但唯一 Dialog 保持 mounted，直到原生叶子的 dismissed。新断言精确检查 `presentation='pageSheet'`、系统 detents、dismissible、无额外 JS backdrop，以及旧事件不能关闭新页面。不伪造已被生产移除的公共 Dialog.onClose，也不使用假 Sheet 补回旧物理结构；这只验证纯回调语义，不证明 UIKit 图像、几何或动画效果。

AX 差异已只读核对真实 Web `packages/ui/src/components/model-picker/MobileModelPickerPanel.tsx` 的搜索与清空回调：两者都在 `onQueryChange` 后调用 `onExpandedModelKeyChange(null)`。当前 `new-session-models.tsx` 的 `search.set(...); effort.set('')` 与 Web 移动端及 DOCUMENTATION 的 effort 收起合同一致。原失败来自测试逐字期待旧的单一 `search.set`，不是生产文案或编辑器替换：placeholder/AX 仍使用 `chat.modelControls.searchProvidersOrModels` / `searchAgents`，清空按钮为 `clearSearch`。测试保持精确 onChange 字符串、class/value/AX 相等和无 replacement 的断言，并执行抽取的真实生产 onChange，验证输入及清空时 query 更新且 effort 精确清空，没有改成任意 contains。生产模型代码未修改。

最新全包 tsc 尚未通过：实际输出为 `chat-chrome-surfaces.tsx:13` 读取 `event.bounds.height` 不存在于 `Bounds`。该 chrome 生产模块不属此任务，未修改。此前 native-sheet loader 和模型搜索 AX 的失败已由本专项解除；此前 native-select 错误本次未再出现。application admission 最小接线由用户交 Tour owner，本专项没有改动或代验其生产装配。

没有运行 native/engine/device、main build、真实 Host、真实会话创建、Git、依赖安装或网络查询。`dead-code` 脚本需要未安装的 `knip@5.80.0`，没有使用 bunx 下载；未声称已执行该检查。

日期：2026-11-07。当前已提供真正的 `NativeNewSessionPage` 和可构建的独立原生 fixture，不再只有核心。下文 worker 记录保留其原验证边界；main 后续已接生产入口与 admission，验证状态见文末追记。**尚不能据此声称全量 Web parity 或生产入口验收完成。**

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `new-session.ts` | Host/目录本地分区、创建 receipt、配置冻结、完整 sidecar/附件 handoff、显式 ownership 转移/释放、未知创建重新绑定 |
| `new-session-page.tsx` | 系统 NavPage header/Back、欢迎态与六个 magic starter、项目/目录 Sheet、glass composer、附件、引用、听写、发送与恢复反馈 |
| `new-session-models.tsx` | 创建前的本地 model/Agent/variant 选择 Sheet，不给 synthetic draft 调真实 session API |
| `new-session-selection.ts` | 仅 present picker 持有的 GET catalog；保留旧快照、失败可重试、inactive/dispose fence |
| `new-session-copy.ts` | 新恢复文案的完整十语表及临时局部取词函数；待 main 合并到正式 locales |
| `new-session-fixture.tsx` / `tests/new-session-host.js` | 独立 NavStack 和 fake native bridge；创建、配置、首发、故障恢复与 owner 转移测试载体 |
| `new-session-ui-steps.ts` | 交 main 串行跑的 native UI steps；本任务未执行 |
| `new-session*.test.ts` | 真实核心/Chat 发送、catalog、生产 TSX 回调、十语完整性纯测试 |

`state.ts` 仍只有上一轮允许的 `isCurrentHostScope(captured, hostID)` 导出改动；后续实现没有改其余 state。参考 Web `session-ui-store.ts#openNewSessionDraft`、`input-draft-types.ts`，以及现有 NSH `drafts.ts`、`createSession/createChat.send/retrySend`。没有自己 POST 简化 prompt，没有新的凭据来源、依赖或服务端协议。

## Main：精确接线

### 页面 props

```tsx
import { NativeNewSessionPage } from './new-session-page'
import { sendNewSessionHandoff, type NativeNewSessionPageHandoff } from './new-session'

<NativeNewSessionPage
  project={project}          // 可选 Project
  directory={directory}      // 可选，优先于 project.path，保留 worktree
  projects={projects}        // 可选，默认 app.projects()；仅项目 Sheet 扫描
  active={isTopRoute}        // 必须随 NavStack 覆盖正确变 false
  onOpenChat={(target, handoff) => openChat(target, handoff)}
  onBack={() => { /* 可选通知；native NavStack 已 pop，不能再 pop 一次 */ }}
/>
```

- `onOpenChat` 是同步的导航接收回调；页面已完成 staging 才调用。Main 接收后可 push Chat，也可 replace draft route。不要提前挂空 Chat 与 staging 竞争同一个 Storage owner。
- `NavPage` 使用系统 header/Back、默认 native pop/swipe，无自绘返回按钮。`onBack` 是 **onDismiss 通知**，不是请求 main 执行 pop 的命令。
- Host 必须已选中。主路由换 Host/目标 props 时应重建页面；旧 owner 被 generation + `switching` fence 禁止编辑/请求，不能重用旧 page/receipt 当新 Host 的草稿。
- 两个目标参数都没有时是本地 unbound draft：可写文本、可打开项目 Sheet，不能创建 session。不猜当前目录。Web 的完整项目/会话默认优先级仍由 main 路由解析后传入。
- 项目切换先 flush 当前分区，再关闭旧 owner 并挂新分区。按 Host/目录恢复各自草稿，不跨目录暗中搬运文本/引用。

### Handoff 对象与所有权

```ts
type NativeNewSessionPageHandoff = {
  receipt: { target: ChatTarget; hostID: string; generation: number; inputID: string }
  owner: NativeNewSessionOwner
  release: () => Promise<void>
  released: () => boolean
}
```

没有 endpoint/token/authorization。`hostID`、generation 和 inputID 是分区/fence 标识。

Main 应在 Chat 路由保存整个 handoff；不是只存 target，也不要 serialize owner 到导航持久化中。冷启动应重新打开该 Host/目录 source 分区取得新 generation receipt。

```ts
const chat = createChat(target)
// 只在当前 Chat active/前台后启动一次；失败用明确重试动作，不能反复 Effect 自动投递。
const admitted = await sendNewSessionHandoff(chat, handoff.receipt)
if (admitted === true) await handoff.owner.complete(handoff.receipt)

// Chat 销毁/离开这份 navigation ownership 时调用，覆盖/临时 inactive 不释放。
await handoff.release()
```

- `createNativeNewSessionOwnership.transfer(receipt)` 转移 source 的 cleanup 权；页面 unmount 的 `disposePage()` **不会 close 已转交 owner**。只暂停页面输入/选择/引用/听写。
- 未转移的页面卸载会 flush/close；`release()` 幂等，才真正 close 已转移 owner。Main 不应在 first send 尚未完成时释放，也不应在只被另一 NavPage 覆盖时释放。
- 确认成功后先 `owner.complete(receipt)` 再 `release()`。失败离开可以只 release：source installed receipt 和目标 Chat pending 仍持久化，回来恢复同 target/inputID，不另建 session。
- 若 main push Chat 保留了底下 draft，Chat 释放后 draft 再 active 会重开原分区；已清理成功则是下一份草稿，失败则恢复同一个 installed target。
- 同步导航回调抛错时页面 reclaim owner，可显示错误并再试；main 不应在已接收 ownership 后异步丢弃它。

### Admission 的含义

`sendNewSessionHandoff` 复用 `chat.recoverPendingSend()` 的启动恢复 flight，然后交既有 `chat.retrySend`。若启动恢复已清 pending，会用 **相同 inputID 的权威 inbox 或 exact message** 核对成功；不会仅凭 pending 为空清源草稿，也不会重新装入已经消费的 command/prompt。

`false` 不是成功：可能 inactive、Host 改变、错误或未获确认。保持目标 Chat 的原错误/未知发送状态，使用 main Chat 的显式 retry UI；禁止 fallback 成新 createSession 或新的 message ID。重复调用在已获权威 admission 时可以返回 true，但不会重复 POST。

首条新会话输入为 `steer`；模型/Agent/variant 在 handoff 之前按冻结快照写入并 GET 验证。Installed 后 retry 不重新写选择。普通注册命令、Shell、magic 模板、五域引用编译和后续 queue/steer 均由现有 Chat 链路负责；Shell/command 未知不盲目重放。

## 页面行为与恢复

- 打开、普通输入、local selection 不创建真实 session。只有 send 调 `owner.submit`：保存原始文本/sidecar/附件与稳定 inputID → 创建 write-ahead receipt → 一次 createSession → 保存 target → 应用/验证选择 → 安装目标 durable draft → transfer。
- `draft → creating → created → installed` 持久化。创建开始后选择冻结，源文本仍可编辑，首发只用原始快照。Admission 只清捕获文本/附件，保留用户后续编辑。
- Source 沿用 `nsh:chat-draft:v1` 的本地 synthetic id `new-session-draft`；selection/receipt 使用独立 `nsh:new-session:v1:[Host,directory]`。保存 URI 元数据，不存文件正文、Host 凭据或编译器状态。输入 300ms 合并保存，send/close 显式 flush，receipt 有串行 lane/revision CAS。
- 损坏/失败存储不伪装空成功；输入保留，页面显示本地化错误和 `new-session-storage-retry`。Catalog 失败保留上次有效内容，在原生 Sheet 内重试。
- 创建结果未知会显示专门恢复区，而非只禁用 send：原因说明、稳定 inputID、候选会话刷新、手填 session ID、显式选择已有会话。不会提供危险的“再创建一次”。
- `recoverCreatedSession(id)` GET 验证 session ID/实际 location directory，并核对 message、inbox、active 权威结果：只接受 **同目录、空历史、空 inbox、idle** 的用户选择。失败不改旧 receipt；成功只绑定 target，用户再按 send 才继续配置/handoff，不重复 create。
- 已知创建响应后 receipt 写盘失败，当前 owner 保留内存 target，重试只补写。若进程在 target 写盘前终止则按未知创建恢复。Host 切换旧响应不得配置/发送到新 Host。
- Destination 已写入但 installed receipt 失败，可核对同 ID/相同快照后完成 receipt；不覆盖不相符的持久草稿。Main 仍须串行 staging → mount Chat，不支持其他 Chat owner 同时竞争这个新 target。
- 照片/文件按钮走现有 `runtime.pickAttachment`，等待 actionSheet/picker 后复核 current；引用复用 `NativeReferencePicker` + 原生 reference keyboard + 原有 compiler；听写结果只进入草稿，覆盖/后台/unmount abort。

## 新增 locale：完整十语表

十二个同构 key 已迁入十份正式词典的 `chat.newSessionDraft.<key>`，参数 `{id}` 全语一致。`new-session-copy.ts` 保留 `newSessionText` 调用接口，内部委托现有 `t`，不再持有平行翻译表。迁移定向测试35项、共享词典7项通过，不等于页面引擎或 UIKit 证据。

Keys：`unknownTitle`、`unknownBody`、`recoveryID`、`recoveryChoose`、`recoveryNotEmpty`、`recoveryMismatch`、`storageFailed`、`operationFailed`、`handedOff`、`reviewSessions`、`selectedSession`、`capturedInput`。全部使用正式 language/system-locale 规则；非英语字典没有英语占位。其余按钮/提示复用已有正式 t keys。

## C / F / H / S / D 与未完成项

C=生产接线，F=fixture/回归，H=真实 Host，S=模拟器，D=真机。构建/纯回调不等于原生 UI 执行。

| 能力 | C | F | H | S | D |
| --- | --- | --- | --- | --- | --- |
| Native 页面、系统 header Back、glass 输入、欢迎 starter | 独立组件已实现；main application 接线待验收 | fixture build、纯回调；UI 未运行 | 未做 | 未做 | 未做 |
| 项目选择/目录手填、分区草稿恢复 | 页面实现；完整默认目录解析属 main | 分区纯测；项目 Sheet 原生步骤待跑 | 未做 | 未做 | 未做 |
| 本地 model/Agent/variant、搜索、默认、favorite/recent 展示 | 原生 Sheet 实现，零 session selection 写入 | catalog/failure/fence 纯测、fixture build | 未做 | 未做 | 未做 |
| 附件、五域引用/键盘、听写、Shell/命令/magic | 复用现有 controls/compiler/bridge | 核心快照/发送纯测；原生交互未执行 | 未做 | 未做 | 未做 |
| 首发 create、稳定 ID、配置冻结、转移 owner、失败/冷启动恢复 | 核心+页面实现；main Chat 负责消费/释放 | 真实 core/state 链路 + 生产 TSX 回调 | 未做 | 未做 | 未做 |
| 创建未知恢复 UI/权威空闲空会话重新绑定 | 已实现；不重复 create | 匹配/拒绝/Host fence 纯测、UI steps 待 main | 未做 | 未做 | 未做 |

仍在完整 scope 的缺口（不能按 MVP 删掉）：

1. Web 的 parent/folder/synthetic parts、permission auto-accept、worktree establishing/clone、完整项目/当前会话默认优先级没有移植到本页面。
2. 手填目录不等于原生目录浏览器/worktree 拓扑；切换目录恢复独立分区，不迁移 unbound/其他目录已有草稿。未选择模型/Agent 时沿用服务端默认，未显示默认解析后的完整名称。
3. Favorite/recent 列表可读和选择，但本页面没有增删/重排收藏、选中后回写 Host recent 的动作；Agent 长按/短按循环及未知自定义头像全量 parity 未覆盖。
4. Shell 草稿的文本可持久化，首次发送 inputMode 快照可持久化，但未提交前的 normal/shell UI 模式还未单独持久化。动态 starter 管理、完整 slash 特殊命令菜单行为仍未全量迁移。
5. 恢复的 GET 空闲/空历史核验不是服务端 compare-and-bind 事务；另一个客户端在核验后同时修改该 session 的竞态尚无额外原子协议。创建错误也保守按未知处理，未细分所有确定拒绝错误。
6. 原生附件 picker、Reference overlay/caret/IME/外接键盘、听写权限与后台中断、长文本、键盘避让、Liquid Glass、Back/swipe、Sheet 转场尚无运行证据；不能以 build 宣称完成。
7. Main 需把模块所有权登记到 `DOCUMENTATION.md`、完成真实路由/Chat 错误反馈接线及正式 locales 合并；本任务未改这些其他归属文件。

## 验证记录

当前已跑：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/new-session.test.ts packages/nsh/new-session-selection.test.ts \
  packages/nsh/new-session-page.test.ts packages/nsh/new-session-copy.test.ts \
  packages/nsh/state.test.ts packages/nsh/drafts.test.ts packages/nsh/composer.test.ts
```

- 本轮较早扩大检查的快照为 7 文件共 113 条：112 通过，1 条既有 state 测试失败：`state.test.ts` 的 `catalog failures preserve command draft without marking an undispatched command uncertain`，`chat.command('goal','pause')` 预期 false 但返回 true。本任务未改 Goal/state 行为，不越权修它；此后补充的自有测试另列于下，不能称全套绿。
- 自有四文件 41 条通过；另与既有 drafts/composer 一起复跑为 6 文件 67 条通过。生产 TSX 回调测试直接执行页面 onChange/onPress，覆盖 200 次输入零请求/同步 Storage/全局目录扫描、首次 send 转移 owner、页面 unmount 后真实 Chat admission、inactive 阻断和系统 Back 合同。另有纯测试用自有 fake bridge 跑真实 create→未知恢复→配置→Chat admission，验证 fixture 协议，不启动 HTTP/引擎。**这些不是 NSH renderer/几何/手势模拟**。
- Fixture 使用 `node scripts/nsh.mjs build new-session-fixture.tsx --release --out .nsh/new-session-fixture` 成功，输出约 4.6 MB JS / 2.9 MB bytecode。`NSH_BIN` 从本机已有 distribution 指定，不写机器路径到仓库。
- `tsc --noEmit` 以临时 config 继承包配置、仅以 `new-session-fixture.tsx` 为根检查页面+真实依赖图：通过。全包 tsc 当次受 `application.tsx:458` 的 `changes` route 与 `features-cron.ts:28` 返回类型错误阻断，均非本任务文件；未改它们。
- `node --check packages/nsh/tests/new-session-host.js` 通过；`bun run dead-code` 非阻断完成，已检查本轮命中为 fixture/待执行 steps，另有仓库既有 unused/duplicate 与 entry 配置提示，没有删除其他模块。
- 未运行 NSH test/任何 UI engine、浏览器、设备、模拟器、生产/HTTP Host、Git/GitHub、付费服务或新增依赖。只运行编译，不干扰 main 的 UIKit 窗口。

Main 窗口可用后：`new-session-ui-steps.ts` 的三个场景分别提供草稿重开、model/Agent/variant 首发、未知创建恢复步骤；入口 `new-session-fixture.tsx`，fake bridge `tests/new-session-host.js`。请独立隔离 fixture 状态并串行跑，再补 C/F/H/S/D 的真实证据。P95/input-to-paint、IME 和关闭 picker 后输入仍未测。

## Main 生产接线追记

- `application.tsx` 已接 `new-session` route；Projects 的 `onNewSession`、`onWorktreeCreated`、目录主要添加、项目页与 Chat 菜单均进入未发送草稿，不调用 eager `createSession`。
- 页面先 staging/transfer，再 `nav.replace` 为携带 handoff 的 Chat，避免同时打开同目标 durable owner。首发由 `new-session-admission.ts` 负责 single flight、一次自动尝试及明确 retry；已确认 admission 与源 CAS 清理分开，清理失败只重试清理。
- Chat 销毁时等待进行中的 admission 再释放；覆盖、临时 inactive 不调用 release。首发未确认前允许继续编辑但不能另发一条，保留原 pending/新文本。
- 生产接线后的定向引擎、UIKit、真实 Host 与输入性能验收仍待执行；不触发付费模型调用来凑验收。原各项 full parity 缺口不因接线自动关闭。

## 隔离 UIKit 拖删除复验

2026-11-07，新建本会话独占的 iPhone 17 Pro / iOS 26.5 模拟器，安装独立包 `2026-11-07T09-34-55-724Z-99e6cc77`。使用真实 AX frame 定位、展开预设、按住可见行 300ms 后拖入实际出现的删除区。删除后仍在新会话页面，目标行消失；点击系统 Back 可返回根页。

- 触摸与即时 AX：`.scratch/nsh/chat-frames/new-session-drag-1794044524414.json`。
- 截图：`.scratch/nsh/chat-frames/new-session-trash-isolated.png`。
- 内存 Host 审计：`.scratch/nsh/chat-frames/new-session-trash-isolated-audit-1794044547.json`，`settingsWrites=1`、`configWrites=0`、`deniedSessionWrites=0`、`rejected=0`；保存后的预设列表没有被删除项。

这只证明隔离合成 Host 下这一条真实拖删除路径和普通系统返回。取消、多指、目录切换、模态背景 AX 隔离、生产最终包及真机尚未据此通过。此前共享模拟器出现未知 `NshDev` 前台，旧异常的全部因果不能归结为系统返回；此轮使用独占设备消除了该干扰源。
