# Desktop composer local-command 接线合同

## 当前状态（不是完整 parity 签收）

`composer-local-commands.ts` 直接消费 `ui/src/lib/composer-local-commands-core.ts` 的 classifier 和 canonical metadata，`composer-commands-model.ts` 的第五参数接其 catalog。`composer-controls.tsx` 的生产 `NativeCommandSuggestions` 已透传可选 catalog。没有另一份 Native classifier 名单。默认四参数路径和 iOS `/model` 行为不变。

`application.tsx` 的实际 desktop Chat 已一次性装配 registry、真实 snapshot/revision CAS、suggestions catalog、choose 与发送前分流；已接 new/model/magic/compact、Timeline 和 history undo/redoStep/fork-current。magic/compact 使用原 writer 的资源保留准入，不复用普通资源消费发送。`new-session-page.tsx` 已接 registry 与原 ownership transfer/handoff，独立页面验证不替代完整 App 根验证。缺失的本地动作仍 claim 并明确拒绝，不降级同名 Host 命令。BTW 现已接实际 tab、verified native grant、单一 store、captured 可取消 transport 与真实 mounted handle；局部真实主根通过不代表全部引用/picker/平台 UX 已闭合，详见 BTW 产品合同。

Web `localCommandClassifier.ts` 是 runtime wrapper，动态计算 VS Code 的 reloadEnabled 并注入纯 core；原导出和默认分类不变。`CommandAutocomplete.tsx` 的正常与 fallback 路径共用提取后的 metadata，保留原顺序、文案 key、session/draft/init 与动态 VS Code 条件。测试直接导入共享纯模块，不再通过替换 runtime detection 的测试打包器绕过依赖。

## 最小接线

每个实际 Chat/draft owner 创建一次 `createNativeLocalCommands`，不能放到逐输入 computed 中：

```ts
const local = createNativeLocalCommands({
  t,
  read: readActualComposerSnapshot,
  replaceText: compareAndReplaceDocumentText,
  actions: actualLocalActions,
  onBlocked: reportLocalCommandAdmission,
  onConflict: reportExactWebConsumptionPlanToPageOwner,
  onOutcome: reconcileLocalOperationReceipt,
});
// 挂到既有 keyboard chooseCommand；返回 boolean，不另装 keymap。
// chooseCommand: local.choose
// 原 send 最前面（普通 queue / chat.send / prepare 之前）：
if (local.submit().kind !== 'pass') return;
// 仅 desktop：给生产 NativeCommandSuggestions 传 catalog={local.catalog}。
// 页面真正销毁时 local.dispose()，覆盖页不能销毁 durable draft owner。
```

`read` 必须来自实际页面，而非 sidebar selection：

- `scope` 使用当前 durable ReferenceScope；`authority` 使用 Host/页面 operation generation，不能只有连接 ID。两者用途不同，不含凭据。
- `target` 区分 session/draft/assistant；目录必须与 scope 相同。assistant 不是 OpenCode session，当前所有 session-local 分支明确阻止。
- `revision` 是文本、附件、引用变更的单调版本，防止文字编辑后又改回原值的 ABA。
- `active/ready` 必须包含真实页面、前台、模态和草稿 readiness；`pending/unknown/sending/queueEditing/hasReferences` 使用实际 writer authority，不能从历史或 busy 图标猜测。
- `hasMessages` 来自实际目标的消息 authority，仅供共享 metadata 的 init/session 条件使用，不读 sidebar/global history。
- `selection` 捕获实际 model/variant/Agent（未解析为 null），不能在异步 prepare 后重读当前选择代替；invocation 对 scope/target/selection 作独立快照。
- `replaceText(expected, text)` 同步复验 authority、scope、revision，并只修改文档文本、重定位引用；不修改 attachments、不清 queue、不先清资源再恢复。

共享 metadata 携带 `source: 'yuri'` 和 `id: yuri:<name>`；动作缺失仍保留该本地 row。Host rows 永远标记 opencode，不携带 localAutoRun。`localAutoRun` 只为既有 keyboard 提供 focus 提示；实际执行始终重新准入。

## 动作与消费矩阵

| 命令族 | target | 选择 | typed send / 文本消费 |
| --- | --- | --- | --- |
| new | session/draft | 绑定后 Enter/click；Tab 插入 | 首个 await/导航之前清命令文本 |
| fork/undo/redo/compact | session | 绑定后 Enter/click；Tab 插入 | Web 在首个 await 之前清全文；有尾文时先把冲突交回 main |
| model | session/draft | 绑定后 Enter/click；Tab 插入 | 按 Web desktop 保留全文；不沿用 iOS 去 token 的特例 |
| timeline | session | 只插入 | 打开真实 timeline，保留文本 |
| btw | session | 绑定后 Enter/click；Tab 插入 | 完整 tail 交给 side-question consumer；清主输入文本；bare 命令只打开 |
| magic | summary 仅 session；其他 session/draft | 只插入 | 原命令文本和附件保留，发送编译产物时不携带附件/引用 |
| goal / shell / 普通 Host 命令 | 原发送 owner | 不由本 registry 自动执行 | 返回 pass，保留原 Goal / queue / unknown-recovery 语义 |

所有本地分支先 claim；无 consumer、引用未能证明 authored、非法 target、unknown、queue-edit 等均明确 blocked，不降级 Host。`/btw` 在主 flight 之前分流，但未知回执仍锁定。其他命令不进入普通 queue。compact 的本地 flight 不占主发送 flight，后续普通文本仍返回 pass。

Web immediate 分支会清整段 plain document；选择通常替换整段 plain document，只有 btw 按 token range 插入，但 Enter/click 仍以 bare preset 提交。这些操作会丢掉既有尾文或结构引用时，registry 返回/回调 `conflict`，不改输入、不自动执行、不发 Host。`snapshot`、`phase`、`webText`、可选 `presetText` 原样交给 main，明确展示 Web 的两阶段计划（包括 btw bare preset 丢失问题的冲突）。**没有自行设计更严格的尾文 UX，也不把未解决冲突算作 parity 完成。** main 决定保真消费/确认接点后才能签收该项。

action `run(invocation)` 必须返回明确 `{ status: 'accepted' | 'rejected' | 'unknown' }`，不能用 resolved void、打开无 consumer 的布尔值或 `chat.command(name)` 冒充真实动作。即时清文后失败不会恢复并覆盖后续编辑。迟到结果不清文、不导航新 owner；consumer 在每次 await 后也必须检查 `invocation.current()`。

unknown 锁定本 owner，不自动重放；主 writer 必须保存真实 journal，供跨页面/重启恢复。`resolveUnknown(originalInvocation, authoritativeOutcome)` 只接受相同 invocation 对象，回报核验结果但绝不再次执行动作；不是通用“重试”按钮。

临时覆盖期间返回 unknown 仍锁定原 owner，恢复显示后不能重放；隐藏时不发布 UI outcome。跨 owner 销毁的恢复仍由真实操作 journal 负责，不能依赖该内存锁。

## 已提供的业务适配

- `createNativeLocalMagicAction` 使用生产 `compileNativePrompt`，捕获命令正文，读取真实 override 格式，显式 `files: []`，不调用 `chat.send()`。prepare 失败是尚未 dispatch 的 rejected；dispatch 异常由 registry 视作 unknown。main 仍需提供**不消费原文档/附件/queue**的实际 admission 端口，现有 `state.send` 不能直接冒充该端口。
- `createNativeLocalHistoryActions` 直接复用 Web `resolveRevertUndoTarget` / `resolveRevertRedoTarget`，不按 ID 排序。redo 有下一条 user 时 stage 下一 marker，只有完整已知历史的末端才 clear。主 transcript owner 提供带备份、idle 检查、captured lane 的 stage/clear；不能直接把现有全量 `redo()` 绑定成 slash redo。历史不完整目前明确 rejected，完整的按需补页 consumer 仍待实现。

### Timeline 原生组件

`composer-timeline.tsx` 的 `NativeComposerTimeline` 是独立原生 Dialog，按 Web TimelineDialog 的真实结构提供用户消息、所有 text parts 的搜索、80 字 preview/30 字上下文 snippet、日期分组、时间列、选中/hover、上下键与 Enter、加载更早、jump/revert/fork、previous/latest。不是临时菜单。

主页面只提供已有 owner 的端口，不创建第二个 Chat/history/transport：

- `messages={chat.messages}`；`canLoadEarlier={chat.more()}`；`isLoadingEarlier={chat.olderLoading()}`。
- `onLoadEarlier={async () => { await chat.loadOlder(); return !chat.historyError(); }}`，不能把吞掉读取错误的 resolved void 当成功。
- `onScrollToMessage={async id => (await messageFocus.focus(id)).status === 'revealed'}`。hidden/not-found/读取失败保持浮层，不假跳到底。
- `onRevertMessage/onForkMessage` 委托已有 transcript owner，回传明确 outcome；`canRevert/canFork` 来自同一 authority。scope 必须含实际 Host 代际/session/目录。
- `onScrollByTurnOffset`/`onResumeToLatest` 委托已有主 transcript List 动作；未接的能力不伪造执行。
- pending gate 留在 shell，关闭/重开不会解除。unknown 回传 `onUnknown` 且锁定；main 核验后用 `onOwner` 给出的 `settleUnknown(originalOperation, outcome)` 解除，不重放 mutation。旧 scope 结果不会关新 Dialog。

timeline 按 Web 保持正序，短列表在顶部；不能照搬主聊天 inverted 的短列表底部布局。Native `List maintainVisibleContentPosition` 是唯一几何 owner，使用 NSH 已声明的 prepend 保持可见内容契约。初开定位最新 row，搜索/键盘只在所选 row 不完全可见时请求 nearest reveal。历史扩展不发 JS offset 补偿、不因 prepend 重置选中到 latest。组件关闭时不读消息、不构造 rows。真实平台阅读锚点与视觉验收仍待完成，不能用 headless 代替。

### BTW session.generate owner

`desktop-btw.ts` 的 `createNativeBtwStore` 已实现 Web store 的单次 generate、40 entries/50 turns/12 answered prompt-history turns/10 去重 quotes、独立 selection、ask/retry/cancel/clear、receipt 时钟、bounded eviction、controller identity/runtime generation fence。只由显式 ask/retry 调用 generate；打开/observe/quote 无模型请求，不读主历史、不 create session、不 prompt/tool-loop。

端口只有实际 `runtime`、`resolveSelection`、`rememberSelection`、`applySelection`、`generate`。generate **SDK input** 为 `{ sessionID, prompt }`，AbortSignal 在 request options；HTTP body 为 `{prompt}`，不带 model/agent/tools。model/variant/Agent 在 await 前捕获，再先交 applySelection。`desktop-http.ts` 的真实 native loader 与 `desktop-btw-runtime.ts` 已实现该 seam，factory API 已冻结于 [BTW 产品合同](./desktop-btw-DOCUMENTATION.md)。applySelection 第三参数 `{signal}` 与 generate 共用原 slot.signal，取消选择等待后不进入下一阶段，旧少参 callback 兼容。安装的官方 `@opencode/client@2.2.0` 执行测试确认 ModelRef 是 `{providerID,id,variant?}`、model/Agent 的 204 wire、generate 的 prompt-only body/200 envelope 与原 AbortSignal；无 directory query/body，不再把 legacy bindRequest 当作支持取消。

main 的 BTW consumer 仅在真实 grant/runtime ready 后接 `createNativeDesktopBtwAction`。`open` 兼容同步 handle/null 或 Promise，首次打开实际 tab 后等待真实 `NativeDesktopBtwPanel.onHandle`；action await 后重新验证 invocation/current/target，有 question 才调实际 handle.ask，bare 零 generate，reject/迟到 handle 不动新稿。每 window/scope 一个有界 opening ticket 的发布/退休/关闭归 main，不轮询或伪造 handle。root 在运行时切换 reset、真正离开 session 时 cancel/dispose、显式关闭 panel/tab 时 clear；切 tab 只隐藏保留侧聊。生产 tab/model/registry 的最终装配仍需 main 验收，不等于 adapter 未实现。

`desktop-btw-panel.tsx` 已提供真实产品展示：Markdown/原生代码复制、footer/全文复制/注入朗读 callback、quote chips、编辑器、模型/Agent picker callbacks 或 selection slot、空/错误/retry/cancel、panel/page；直接复用原 store，不创建第二套 transport。actual current/interactive/active/visible 分离，隐藏保留 owner/List/草稿，close 清 exact entry。缺 generate 的 store 和 handle 拒绝 ask/retry，不消费问题/quotes、不制造成功回合。iOS sheet 原路径未改。exact props、handle 注销、生命周期、原生限制与接线示例见上述产品合同。

已经以真实异步 history action 和实际 BTW action+handle 验证 registry 的 document CAS 后 `invocation.current()` 在 await 前后仍有效。当前实现只以 alive/owner/scope/target/active fence，不要求 revision 等于消费前值；未发现所疑 revision bug，未更改主 writer/current 语义。

## 尚未完成，不能隐藏

1. 新会话 registry/handoff 已有独立生产页面场景；仍需完整 App 根、真实 Host 与物理输入验证。compact 已绑定实际 Chat writer，精确 inbox ACK、unknown 与 barrier 合同见 `tests/local-compact-writer/README.md`。
2. Chat 尾文冲突已复用 `desktop-local-command-conflict.ts` 原生确认；确认后按 scope/authority/target/text/revision CAS，仅改变 document。其它入口必须消费同一 helper；引用/附件仍不得静默丢弃。
3. fork/revert 上游没有可核验因果 receipt；unknown durable intent 保锁，普通快照、404 或空集合不能解除。ACK 后刷新失败仍为 accepted，禁止重放。
4. Timeline 已接实际主页面 messages/loadOlder/messageFocus/history owner，以及共用 Web 纯规则的 Previous Turn/Latest；自身模态保留原 Chat sync 和 operation，仅开放精确 history 准入。稳定 scope 不含会被成功 stage 改变的 historyGeneration。AppKit/Win32 可见 turn、定位几何、阅读锚点和视觉仍未验证。
5. BTW 产品 Panel 已实现；主 consumer 的工作台 tab/selection 持久化/生命周期和真实 generate/cancel 端口由 main 精确 grant 装配，不自定义另一套 grant。Host 已在原 actor 实现 `runtime.http.capabilities({})`（version 1、真实 windowID、4096 lifetime IDs、共用 8 jobs/30 秒）及 exact 四身份的 `runtime.http.request/cancel`，API/payload 不变，helper final。main 最新报告 HTTP focused 5/0/0、helper 独立 16/0/0、binary/example 各 240/0/0、all-targets Clippy `-D warnings` 通过；真实 64 队列满的 request/cancel dispatch 前 busy、scope retire/redirect/坏 JSON/lateEnd/非 2xx status/body 已完成，不再列作补验中。cancel `{ok:true}` 只确认确切 receipt 处理，不保证服务端模型停止。禁止用普通 session.prompt、runtime.stop/resources.cancel 或测试回调代替 main grant 下的生产 seam；系统平台/实际模型仍未验收。

本模块没有以占位 UI 或假成功替代以上功能。缺失动作会被拦截，而不是删除目录 row；完整目标仍未完成。

## 验证边界

HTTP/runtime slice 的最新复验：Native focused 10 文件 78 passed（wrapper 内 runtime 与 Panel 各 8 个 macOS/Windows headless 场景），Web store/client 2 文件 64 passed，Rust HTTP 精确合同 5/0/0、helper 16/0/0。实际 native loader/manifest 拒绝、异步 mounted handle、新稿保留、选择阶段取消及 unknown 证据和精确 factory API 见 [BTW 产品合同](./desktop-btw-DOCUMENTATION.md#当前-httpruntime-slice-的执行结果)。本 slice 隔离 source/fixture 类型检查通过；整包 nsh:check 最后遇其它 owner 的 `composer-send-test-app.tsx:18` frame null 诊断，dead-code 仍因缺失 `vite-plugin-pwa` 加载失败。该组未执行真实模型/系统窗口，不能替代 main 的 tab/registry 装配验收。

focused Vitest 使用实际共享 classifier / Web wrapper / Web CommandAutocomplete 正常与 fallback / Native row builder / magic compiler / Web conversation-order。BTW 对照测试同时执行实际 Web store 与 Native owner，逐字比较包含 quote、失败回合与 history 窗口的 prompts。NSH headless 执行生产 suggestions/Input/keymap、Native TimelineDialog、BTW owner 与真实 NativeDesktopBtwPanel；Panel 在 macOS/Windows 两平台 headless 各执行产品场景，实际使用 TextView 代码复制到 headless Clipboard；所有 mutation/generate consumer 均为合成 callbacks，不访问真实 Host/模型/凭据、不启原生窗口。

`desktop-commands-application-native.test.ts` 在独立临时配置中挂实际 `YuriNativeApp`，两平台共 32 个场景通过：magic 源稿/附件保留、compiled wire 不带 files、unknown 原 receipt GET-only 核验、真实模型选择器、未绑定 BTW 的 Host 同名拦截；compact 精确控制 ACK、unknown checkpoint-only 和尾文 Cancel/Discard；嵌入 child 正文复制/私有 nested card 导航且无第二 writer、三种外部模态零额外 child GET、跨目录固定历史 diff/复制且不读父 Git；Timeline 开关/全文搜索/jump/原 Chat 分页与零 stream 重开、stage、逐步 undo/redo 顺序、fork-current ACK 后导航、unknown Escape/模态后仍保锁、Previous Turn/Latest 入口返回原 writer。该证据是合成 Host 的真实根，不是实际模型、系统 UI 或 Windows 实机验证。

headless 的 300 Host metadata fixture 通过真实 NativeCommandSuggestions，在初始关闭及开关后各做 50 次普通输入，断言目录构造/扫描/命令读取零增量。timeline 关闭/再关闭后各 50 次普通输入，消息 source 读取零增量。它们不证明整个 application 的 network/shortcut plan 预算，也不代表 AppKit/Win32/UIKit、IME 真机或时延预算已验收。

此前 BTW 产品视图轮次的 focused 验证快照：Web 七文件 55 passed；Native 十三文件 62 passed / 1 skipped（UIKit opt-in），其中产品 Panel wrapper 内实际执行 macOS/Windows 各四个场景，共八个 headless 产品场景，最终样式/close-stop 补充后 Panel 再次通过。该轮 UI `type-check` 通过；`nsh:check` 整组时曾通过，后续复验遇到并行 main 的 `application.tsx:1748` localCommands/catalog 接线诊断；`dead-code` 遇到缺失 `vite-plugin-pwa`。这是历史执行记录，不据此断言当前 main 仍有这些阻塞；本次文档收口未重跑 TS/knip 或修改其它 owner 的源码/依赖。最新 Host/helper 生产回归结果见 BTW 产品合同及上文第 5 项；默认 iOS 目录与旧 `/model` 合同由原测试保护，真实系统平台/模型及 main 主 consumer 精确 grant 装配仍未在本线程验收。
