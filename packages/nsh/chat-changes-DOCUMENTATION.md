# Shared Changes：reader/lane 与 retained presentation

## 本次范围与根因

本 slice 只修改 `chat-changes.tsx`、`chat-changes-workspace.tsx`、既有 Changes fixture 与新增 focused lifecycle test；不修改 application/state、桌面布局/Header/Panel、原生 Host、模型、reader/actions core 或 NativeSheet。

原命令已实际复现 **2 fail / 1 pass**：workspace 有 summary 却没有 `fixture-branch`/文件，history 只有目录列表而没有 `HISTORICAL_ONLY`。原断言未删除或放宽。

原因是 owner 在 PageOperation 恢复时替换 reader，Sheet 的加载 effect 却只跟 presentation 可见性，且在 untracked 中读新 reader；Content/Diff/Workspace 又缓存旧 reader。读取启动在无权 lane 上成为 no-op，恢复后没有正确的加载触发。Workspace 还捕获 mount 时的 request，不能随有效操作 lane 恢复。

## 所有权与身份

- `createOwner` 生命周期内只创建一个 `createChangesReader`、一个 actions controller；所有消费者可安全持有同一个 reader 引用，不增加第二 source/cache/polling。
- `lane` 是仅发布真实 PageOperation 身份的窄 signal；普通 status/diff revision 和 commit 输入不改变它。换 lane 先 cancel 原 reader/actions serial，再更新 assigned lane，旧结果不能进入恢复后的状态。
- GET 启动时捕获 assigned lane，await 后复验相同对象和 current；reader 自身保留 status/diff/full-context serial fence。失败保 prior，成功空集合才是真正空结果。
- Sheet 加载 effect 依赖 open/active/lifecycle/真实 lane；读取 state 与发起 refresh/select 放在 untracked 内。一次打开/lane 恢复只发对应读取，不因为每次 state 更新进入 refresh loop。
- Sheet key 使用连接 `id/url/authorizationID` 与真实 source kind/directory/path/staged/history identity/revision，不用会在同身份恢复时变化的 epoch 销毁表单。Host/origin/authorization 或 source 身份确实变化仍隔离。
- commit message、输入高度、tree/flat、目录/组折叠与 unknown gate 属于 retained owner，不属于可开关的表单 View。关闭 presentation 不清这些信号；真正 owner cleanup 才结束内存寿命。当前无 durable journal 或全局缓存。

## 冻结的生产入口 API（交 main）

`NativeChangesPresentation` 必须在 Chat/root 的稳定 owner 下**无条件挂载一次**，不能再外套 `If source` 或 source-keyed `Each`：

```tsx
<NativeChangesPresentation
  source={changesSource()}
  open={!!changesSource()}
  active={chat.active()}
  current={current}
  onHandle={handle => { changesGuard = handle; }}
  onBlocked={() => report(new Error(t('common.unavailable')))}
  onClose={() => changesSource.set(null)}
  onOpenPreview={(path, line, capturedSource) => {
    void run(async () => openResourceFile(path, capturedSource.directory, line));
  }}
/>
```

- `source: ChangesSource | null`；`open/active: boolean`；`current: () => boolean` 是所属 Host/route 的权威有效性，不可用 source 对象引用相等来表示。`active` 表示临时交互/demand；关闭、隐藏、后台均不建立后台 status/diff 读取。
- `onHandle?: (handle: NativeChangesPresentationHandle | null) => void` 在稳定 presenter mount/cleanup 调用，不随 Sheet 开关重新登记。handle 只暴露 `canLeave(): boolean`、`source(): ChangesSource | null`，不暴露第二 reader/actions。`canLeave()` 同步检查**原 owner** 的非空 commit 草稿、pending、未确认 dispatch 和 unknown；不会确认丢稿、清空锁或代替服务器 receipt。
- `onBlocked?: (retainedSource: ChangesSource) => void` 在另一 source/Host 试图替换受保护 owner 时报告拒绝，随后 `onClose` 清当前被拒的 presentation intent。旧稿/unknown 留在原 owner，旧请求立即 cancel；绝不创建新身份 writer。相同 source 可以重新打开。没有新增丢弃或未知写核销入口。
- `onOpenPreview?: (path, line: number | undefined, capturedSource: ChangesSource) => void` 使用此次点击的 retained source，Sheet 先关闭再回调；不能用回调时已变更的全局 source/当前 Chat 目录替代其目录。点击前还会复验 reader current；Host/owner/route 退休后不调用预览。源行号仍是一基。

`application.tsx` 已完成两处装配：Chat 原 `If changesSource` 和 root 原 `Each projectChangesSource` 均改为稳定挂载的 presenter；root 使用 `projectChangesSource` 与真实前台/Host/route getter。两处 preview 均使用 `capturedSource.directory`。`onHandle` 使用显式 lambda 调用 signal setter，避免脱离 receiver 的 `not a live signal`；root registration 捕获稳定 root route，不随无关导航重复登记。

**卸载前 guard 是必需接线，不是可选优化。** main 在任何销毁 Chat/root、切 Host、导航离开和窗口关闭的原业务准入中同步复验 `changesGuard?.canLeave() !== false`，失败保持旧页面/Host/owner 并反馈。不能先销毁再问，也不能因 Sheet 已关闭而跳过。内部 source 替换已有同一 guard；外层 owner 的销毁无法由子组件 veto。若外部 authority 已被强制退休，保留原受保护 owner/显式 unavailable，而不是把旧稿转移给新 Host。此 API 不提供“假成功离开”、额外缓存或自动草稿 Storage。

### 精确身份与导航

- authority：连接 `id + url + authorizationID`；lease/epoch 只替换 assigned operation，不作为业务 owner key。
- Workspace owner：`workspace + exact directory`。文件 path、staged、targetLine 都是同目录内的局部导航；换文件不清 commit 草稿、unknown、tree/flat 或折叠。
- 历史 owner：`turn + exact directory + sessionID + messageID + revision`。不能从当前 Chat/Git 推导历史 authority；调用方必须为真正更换的历史内容提高 revision。同一身份的新对象引用/新 loadFile 函数引用不重建 owner；内嵌 files 属于该 revision 的不可变快照。
- 历史 loader 在每次真实 select 时只捕获那一刻已接纳 source 的单个 `loadFile`，不在 await 中改借新 source；返回还须复验 current，并受原 reader diff serial/lane 取消约束。初始有 loader 的身份若后续失去 loader，显式 unavailable，不回退当前 Git。初始没有 loader 的历史保持原 exact historical HTTP 路径。
- null 只关闭 presentation，保留唯一 entry/owner。干净 owner 可以在真实身份更换时退休；dirty/pending/unknown 不允许被新 owner 替换。没有按 source 建 Map、第二 store、reader 或 actions。
- `matches/current` 与局部导航使用窄 computed；50 次 fresh-source Composer 输入只重算常量级身份，不更换 owner/lane、不 refresh。targetLine 更新只重新请求内置 DiffView 定位，不创建新 source owner。

## 写入、关闭与迟到结果

- 每个用户动作捕获 actionLane；status 必须已在该 lane 成功读过，且非 pending/error/unknown 才进入 actions。core 的路径准入、逐项 revert、partial failure 和 commit DTO 不变。
- cancel 先撤 actionLane/动作 ticket，再 cancel 原 actions serial；旧 finally 不能释放新动作。revert 确认还须复验原 View alive 与原 lane，关闭或恢复后不继续 dispatch。
- 未确认 POST 在关闭/暂停时置 unknown；没有明确 HTTP 否定回执的 transport/stale failure 也保 unknown。该锁跨当前 owner 的 presentation 开关保留，只允许显式只读 refresh，不自动重发，也不靠 status 看起来已变化就解除锁。
- 原明确 HTTP 错误仍保留原有用户显式重试能力（包括旧 fixture 的 stage/commit 503）；本次不改变这些已覆盖的协议语义。
- commit 草稿仅在该 action lane 仍有效、core 确认 committed、文本仍等于原提交草稿时清除。清除发生在 ACK 通知阶段，而不是等待后续 sync/status 后再清；旧 ACK 不会清新 lane 或新文本。
- 未确认写在关闭后出现晚到成功 ACK 时，既不采纳 committed，也不刷新新 lane，不清草稿、不解锁、不自动重放。显式刷新可以更新真实文件列表，但不是该写入的 receipt。

## 未改变的协议与 iOS 呈现

`ChangesReader` 的 `loadFullContext/cancelFullContext` 等 API、显式全文 GET DTO、baseline/状态复验与晚到 fence 完全保留。默认 patch 模式没有新增全文读取。

历史 source 仍只使用所属 session/message 的历史文件/正文；已有内嵌 patch、before/after、binary/显式空对直接消费，不回读当前 Git。缺正文按原历史读取路径报 unavailable，不借 workspace 内容填充。

iOS 继续使用既有 `NativeSheet` 的系统 pageSheet/detents；未改 UIKit bridge、safe area、手势、键盘与材质。非 iOS 的原高度控制也未重写。此次是共享生命周期修复，不是新的视觉方向。

## 实测账本

```sh
NSH_BIN=/path/to/nsh/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/chat-changes.test.ts \
  packages/nsh/chat-changes-lifecycle.test.ts \
  packages/nsh/chat-changes-model.test.ts \
  packages/nsh/chat-changes-actions.test.ts \
  packages/nsh/chat-changes-full-context.test.ts \
  packages/nsh/chat-header-ui.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
NSH_BIN=/path/to/nsh/bin/nsh bun run --cwd packages/nsh nsh:bundle
bun run dead-code
```

- 最终 **6 文件 44/44 通过**，包含原 Changes 3 项与 Header UI 2 项；没有删除原测试或放宽正文断言。
- 新 lifecycle 5 项运行真实 NSH 0.4 headless/QuickJS 与生产组件：关闭重开/active 暂停恢复保稿和 tree/flat；关闭期零 GET；每次真实打开的有界 status load；失败刷新保 prior 与草稿/禁止写；50 次真实 Input 编辑零额外 GET/POST、无循环；延迟 commit ACK→关闭→重开→编辑新稿→释放 ACK，零新 lane refresh/清稿/重发，unknown 保留；Composer 共用 reader 重开恢复写准入。
- 第 5 项通过隔离入口，在真实 `loadConnections` 完成后再加载未修改的 `tool-diff-fixture.tsx`；严格合成 Host 仅允许 `connection.list`、拒绝任何正文 runtime 请求。patch、历史多文件、文本对、删除/binary/空文件、2000 行虚拟 diff、preview 源行和 active fence 均通过。
- 新 fixture 使用独立临时 manifest/App/Host；控制能力只在该 manifest 授权，不加到产品 manifest。严格验证 expectedHost、目录、diff 和 commit DTO，只返回合成数据。计数 audit 不含用户内容或凭据。
- 整包 tsc 通过；release bundle 通过（7.1 MB JS / 6.5 MB bytecode / 5 assets）。固定本地 NSH 0.4 源码只读；未重试已耗尽的 Context7。
- `dead-code` 因既有 `packages/web/vite.config.ts` 缺 `vite-plugin-pwa` 加载失败（exit 2），未补装依赖。

## 必须交回的边界 / 未验证项

1. 原 `tool-diff-native.test.ts` 的初始化缺口已由 main 修复：独立临时 manifest/严格合成 Host 仅授权 `connection.list`，先等待真实 `loadConnections` 完成，再加载未修改的工具 fixture；所有 runtime 正文请求均拒绝。原两项测试（历史正文/文本对/删除/binary/empty/lifecycle，以及 2000 行 DiffView 虚拟化）现 **2 通过、1 UIKit skip**，未放宽正文或节点数断言。UIKit 未执行仍不能签收。
2. 本次保稿/unknown 是**同一 retained owner 的内存保证**。两处 presenter 已登记到根唯一 mounted guard collector，导航/Host 切换及原生关窗均复验 `canLeave()`；该 guard 不持 native claim，release 是无 I/O 的确认，不会解锁未知 Git 写。没有隐藏全局缓存，也不宣称进程退出后恢复。
3. 只验证 NSH headless 行为、请求计数、类型和 bundle；没有启动系统 UI、真实 Host/SSH/模型或 UIKit。系统 Sheet completion、键盘/手势、视觉、真实设备输入 median/P95/max 与 input-to-paint 均未验证。50 input 零请求是操作计数证据，不是帧预算通过声明。

## retained presenter 新证据

`chat-changes-presentation-native.test.ts` 在临时 manifest 下运行真实 NSH 0.4 QuickJS/headless，macOS、Windows、iOS **平台模型**各三项（9/9）：null 关闭/重开保稿、fresh-source 50 输入零 status/diff/POST、同目录 path 更换不洗稿、不同目录拒绝、Host/route 退休；unknown 写跨 null/reopen 不重发/不清稿；不同 session/message 的历史延迟 loader 被取消，零当前 Git 读取，preview 使用 captured 历史目录。另一个严格外置合成 Host 用例验证 pending commit → null → 重开 → 新稿 → 迟到 ACK，不清新稿、不刷新新 lane、不解除 unknown、POST 始终一次（1/1）。它们均先等待真实 `loadConnections` 完成，不访问真实 Host。

原 44 项测试不改不放宽；`tool-diff-native` 仍为 2 pass / 1 UIKit skip。整包 tsc、release bundle 通过。`dead-code` 仍因既有 `vite-plugin-pwa` 缺失 exit 2；未安装依赖。iOS 平台模型不是 UIKit 的系统 dismissal/键盘/手势验收。

最终 focused 命令在原命令集合追加 `chat-changes-presentation-native.test.ts`、`tool-diff-native.test.ts`，合计 **8 文件，48 pass / 1 UIKit skip**；新 presenter wrapper 内部为上述 9 个平台模型场景与 1 个迟到 ACK 场景。bundle 为 7.2 MB JS / 6.6 MB bytecode / 5 assets。

## 实际 application 根装配回归

`desktop-changes-application-native.test.ts` 挂载未注入测试 props/路由/控制按钮的真实 `YuriNativeApp`，macOS/Windows 共 **20/20 场景通过**；入口及严格 Host 范围见 `tests/desktop-changes-application/README.md`。正常项目/历史工具打开 panel，实际工作树跨目录 fallback 才打开 root Sheet，不伪造历史 Sheet 入口。覆盖关闭重开保提交稿、50 输入零额外 GET、pending/unknown 零重发、导航/Host/native-close veto 与 captured directory preview。与离页/原生关窗/Header/transcript/presenter 聚合重跑为 **7 文件、166 外层测试通过**；wrapper 内部场景不重复相加。这仍不是系统 Sheet、真实 Git 写入或完整单滚动视觉签收。
