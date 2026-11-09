# Chat interaction fixture stable point

本轮只拥有 `goal-tasks-chat.test.ts`、`composer-references-chat.test.ts`、`chat-header-ui.test.ts`，它们的专属 fixture Apps/Hosts，以及 `chat-interaction-*` driver/纯回归。没有修改 application、state、Goal、Tasks、Header、References、Changes 的生产模块，也没有修改共享 `tests/host.js`。

## 已证实的合同缺口

- `App.tsx` 当前挂载 `NativeStartup`，后者等待真实 authorization-cache cleanup root 的 ready。Goal 专属 Host 原来拒绝全部 `authorization.cache.*`。纯回归调用生产 `authorizationCacheCleanupBridge` 和 `createAuthorizationCacheCleanupRoot`，修前 onReady 为 0 次；现在提供严格的 ready/空 tickets/list/retry，实际 onReady 为 1 次。不存在的 claim/ack 继续拒绝，不凭空确认清理。
- References 专属 Host 原 connection.list 缺少 runtimeScope，因此真实 `bindRequest` 的 prompt POST 在进入 Host 前报 scope_required。现在 snapshot 提供不透明 lease，专属 fixture 先 await 真实 loadConnections 再挂载 createChat，picker 使用捕获的请求函数。
- Header 专属 fixture 原本没有连接快照、没有 loadConnections，直接挂载依赖 createPageOperations 的生产 Header。现在先采用 mock selected connection/lease，再挂载原 NativeChatHeader/ChatHeaderActions；计数和 anchor 测试请求也捕获同一 scope。
- 三个旧 suite 都使用 stdin engine 路径，其中 header/references 直接传裸 Host JS。现在共用专属 driver：在 NSH 仓库 tests 下创建唯一临时目录，以显式 macOS、独立 storage/network 调用 open，保留 1200ms 初始化窗口、全部 steps 和原外层超时；每个专属 Host 都经过 Bun browser bundle 后才传给 web-host。没有改 nsh.json、application root 或共享 Host。

## 纯红绿与检查

新增初始 5 个合同回归先实际 **5 failed**，分别捕获 cache ready 缺失、references/header snapshot 缺失、Goal 未拒绝外来 scope，以及 references prompt 的 scope_required。

修后组合纯验证 **3 files / 26 passed / 8 skipped，4.43s**。8 个 skip 是过滤排除的 Goal 7 个和 Header 1 个引擎用例，不代表引擎验证通过；references 引擎 suite 未运行。

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/goal-tasks-chat.test.ts packages/nsh/chat-interaction-fixtures.test.ts packages/nsh/chat-header-ui.test.ts -t 'synthetic Host contract|real createChat state|dedicated|Goal production|references prompt|driver preserves|Chat delegates'
```

覆盖：三个 driver 的真实静态 bundle/动态加载、nsh.json 祖先与完整步骤、缺失/外来 lease 拒绝、生产 cleanup root 空票据握手、生产 metadata 的 branch/700 tokens/1000 limit/Account Alpha quota，以及真实 createChat 的五域引用 durable 保存、模块重挂恢复、唯一有 scope 的 prompt POST。恢复后的引用保留 document scope 与全部 durable 字段；candidate 上临时 scope 按现有序列化规则移除。Goal 原有 15 个纯合同与真实 createChat 测试保持通过。

完整 NSH TypeScript 检查与 12 个相关文件 Bun 语法转换通过。dead-code 已完成并检查，相关报告仅列出动态挂载的 Header/References fixture App unused，保留这些入口。未执行 NSH engine、device、真实 Host、Git、付费调用或依赖变更。原 typed-goal-not-prompt、queue 不改 selection、closed 零行、320/375/402 toolbar 可见与 enabled、五域引用重挂和所有原超时/断言均保留。

## 待 main 复跑

Header 菜单原文案断言未改。曾怀疑 `Remote Desktop` 的否定断言与生产菜单冲突，进一步核对实际英文翻译为 `Remote desktop`（小写 d），撤回该冲突判断；不能仅根据生产存在 remote-desktop 入口就宣称原字符串断言会失败。

本轮收到的 full-suite 信息只有 case 名称，最终失败详情由 main 后续提供。上述纯回归证明合同缺口与修正，不代替原始每个 engine failure 的最终归因或修后绿灯。

main 串行复跑：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/goal-tasks-chat.test.ts packages/nsh/composer-references-chat.test.ts packages/nsh/chat-header-ui.test.ts
```

## Workspace business-request-owner 纯测试恢复

全量结果补充为 17 files / 34 fail / 3371 pass / 69 skip；其中 Workspace 两个参数分支在执行生产 Workspace 初始化时缺少 `changesWriteJournal` 注入。focused 命令修前实际 2 failed / 5 skipped，修后 2 passed / 5 skipped（351ms）。new-session 的两个失败分支交其 owner，未修改。

仅补测试的真实依赖和 owner 合同：生产 journal/actions/generation/draft，真实 createChangesReader、独立新 reader 的 status revision，以及持久 journal 的内存 Storage 和恢复等待。每个 Workspace 仍只捕获一次 request。原 A→B / A→B→A 的 retained POST 拒绝与新 owner 可写断言保留；初始化增加的 remotes GET 另行精确断言，不混入写入计数。

明确区分测试边界的两类失败：旧请求在派发前被拦截，返回确定 400，不制造未知服务端结果；新请求已经派发但响应丢失时，则真实 journal 保存 pending marker 并设 unknown。测试进一步挂载拥有新 reader/status 的同 scope owner，确认 unknown 仍在、不再 POST、pending marker 未被清掉。没有 mock/清空 journal，也没有关闭旧 Host 拒绝保护。

同期 journal/generation/owner/callback 纯回归 4 files / 30 passed（654ms），测试文件 Bun 语法转换通过。本轮未修改生产模块，未执行 engine/device/Host/Git；main 可先完成 history UIKit 首验，再按自己的顺序复跑引擎。

## Goal Sheet 的最窄生产布局修正

main 五文件组合日志 `sh_1b70ad722001rqSJYTBixSmxcb`：32 pass / 2 fail。References/Header/Appearance/new-session 已通过；仅 Goal 的既有详情在 step 12 等 chat-goal-panel，以及 typed Goal 在 step 19 等 objective=1 的完整 audit receipt 失败。两次画面都已经显示正确的 Goal row/objective 与底部 Session Goal 标题，说明 Sheet 已打开、Goal authority 已采用，不能归为 root admission、命令未发或超时。

源码缺口：NativeGoalPanel 的 popup 只有 maxHeight，内部 View 和内容 Scroll 都是 flex-1，自动高度宿主不能给这条 flex 主轴确定的可分配高度，与 FeaturesHistory 修正的结构同类。此次唯一生产代码变化是 `chat-goal.tsx` 的 popupStyle：把 maxHeight 改为 `height: Math.max(0, windowSize().height - safeArea().top - keyboardFrame().height - 12)`。保留原键盘 margin、标题、Scroll、底部状态/动作、所有 callbacks 和 Goal 读取/命令合同。未修改 application/state/通用 NativeSheet 或引擎测试断言、audit 目标、timeout。

新增 `chat-goal-layout.test.ts` 用 TypeScript 编译并执行完整生产 Goal JSX/callback（未复制布局/Goal 算法），注入原生视图边界，生产 createNativeGoalOwner/controller/transport 通过严格专属 Host 读取和写入。修前实际 4 failed / 2 passed：四组宽度/高度/safe-area/键盘条件的 popup height 均为 undefined，而真实 pause/resume/clear callback 与 typed Goal audit 测试已通过。修后 6 项全通过，验证 finite height、真实正文及 audit 位于原 Scroll、原 toggle/clear 可用、准确三次 command（pause/resume/clear）、准确四次 RPC read、无 prompt/inbox/model/agent 请求，以及 closed/inactive 零正文。

检查 production systemSheetContentStyle 确认 iOS 仍过滤 height/marginBottom，未把非 iOS 的固定 popup 高度带入 UIKit。该回归验证生产发出的布局 props 与回调，不运行原生布局、不测量 Scroll 实际像素；能否消除原 engine 失败必须由 main focused 复跑确认，UIKit 结果也由 main 独占验证。

验证：Goal layout/model/state 共 **3 files / 87 passed（7.39s）**；Goal/Tasks 原 synthetic Host/真实 createChat 纯测试 **15 passed / 7 engine skipped（3.71s）**，继续覆盖 typed-goal-not-prompt、普通 queue 不改 selection 与严格 audit。完整 NSH TypeScript 与两文件 Bun 语法转换通过。dead-code 已完成并检查，报告包含动态 Goal fixture 与已有模块内使用的 exported functions，未因报告删除生产入口或更改导出。

main/oracle 可核查这一行生产变化和新测试，并复跑原 `goal-tasks-chat.test.ts`；本轮未执行 engine/device/真实 Host/Git/付费请求或变更依赖。
