# Desktop WorkStatus：原生 presentation / 窄 projection

本 slice **未接实际 App 根**。只新增 `desktop-work-status*` 和自己的测试/本文；不修改 `application.tsx`、`state.ts`、`chat-tasks.tsx`、`desktop-chat-header*`。main 持有 header/window、原 Chat 和实际 source 接线。组件通过不等于完整 PC goal 或 actual-root 签收。

## 当前 Web 对照

依据 `packages/ui/src/components/chat/work-status/` 五个 consumer/hooks、`WorkStatusToggle.tsx`、纯 subagent helpers、TodoList 和 `ChatView.tsx`。

| Web 实际块 | 本 slice |
| --- | --- |
| Project | 单行、13px/20px、32px row，完整 path 提示；只展示，不伪造导航 |
| Branch | 单行、hover/focus copy，复制分支原文；成功 check 反馈 1500ms，失败交原错误出口 |
| Secondary Worktree | 展示真实 authority 已解析的 secondary name；复制完整路径，不把任意 catalog path 当 session attachment |
| Changes | changedFiles > 0 才显示，已知完整 diff stats 用 +/−，缺少 stats 用文件数；打开实际 Git 工作台 |
| Todos | 原 Chat 已投影 tasks，不另扫历史；默认展开，保留 cancelled 和全完成组，completed/total numerator 不含 cancelled、denominator 包含；finished=completed+cancelled。共享 task summary 保留 live busy 下首个 pending 的呈现语义；195px 有界原生 List、三行文本、原 glyph、进度环/完成标记、计数动效与 progress 定位 |
| Subagents | 默认折叠，最多三头像；working 优先、只堆 working 头像，否则展示前 3；按 working/done 分组，原生 avatar 按 sessionID/partID seed。无权威活动的未结束历史 task 用 Unavailable 分组，不冒充 working 或 done。重复 session 去重，child title > description > Agent；有 ID 才可打开 read-only child |
| GUI plugin | 用户明确排除 |

**当前 Web 此处没有 Goal 或 background-shell 独立 UI 块/按钮。** 不添加相应行、搜索、文件列表或额外 fallback。原 Chat `goal.state` / `goal.observe` 继续由原 owner 管理，本组件不 GET Goal、不 observe、不发 command。后台 shell 无已确认真实 aggregate 时传 `{phase:'unavailable'}` 或 `{phase:'unknown'}`，不传 0；projection 保留此状态供已有 consumer 使用，未另造 Web 不存在的 shell 计数区。若之后真实 Web 增加该块，需另补呈现与真实 source，而非宣称本轮已实现。

## 冻结 API

### 1. Window/header owner

`createNativeDesktopWorkStatusWindowOwner()`（`desktop-work-status.tsx`）创建一次，返回：

- `state(): {enabled:boolean; overlayOpen:boolean}`，初值 true/false。
- `toggle(fits:boolean)`：fits 时反转 enabled 并关闭 popup；不 fits 时 enable 后反转 popup。
- `closeOverlay()`、`setEnabled(boolean)`。

无 NSH 的纯版本：`createDesktopWorkStatusWindowOwner(changed?)`。

`desktopWorkStatusLayout(input, windowOwner.state())` 的 input 是：

```ts
{
  windowWidth, desktop, active, expandedInput,
  hasSession, draftConversation, previewOpen, rightSidebarOpen
}
```

`desktop` 对本 native App 是 Mac/Windows，Web 中的 mobile / VSCode 排除在调用端表示为 false。`draftConversation` 只指首条 prompt establishing/submitting，不是 idle welcome。`previewOpen` 指非 chat 的 context preview；只打开 child chat 不应压掉原列。`rightSidebarOpen` 按 Web 的有效 sidebar/context 状态传入，不能随意用任意 panel Boolean 替代。

输出 `{mountable,fits,inline,overlay,selected,reserve}`：

- fits 使用**整个窗口**宽度 ≥1440，不用 chat/sidebar 测量值；preview/right sidebar 压掉 inline 但不阻止手动 popup。
- inline 外宽 196，right 14、top 8，reserve=210。
- popup 外宽 264，right 14、top 12，padding 8，圆角 xl；reserve=0。
- selected=`(enabled && fits) || overlayOpen`，不使用“是否有 Todo”作为开关条件。

main 的现有 `NativeDesktopChatHeaderActions`：把 `status.workStatusSelected` 接 `layout.selected`，`actions['work-status']` 接 `windowOwner.toggle(layout.fits)`，仍由 header 自身 operation/current/active guard 准入。**不要再挂第二个 Toggle**。`NativeDesktopWorkStatusToggle` 是同一纯 owner 的可独立原生呈现（28×28，settings-2 icon），供没有 header action presenter 的 consumer；生产根已有 header 时不用它。

### 2. 一个 captured Chat 的 read-only owner

```ts
const owner = createNativeDesktopWorkStatusOwner({
  scope,       // DesktopWorkStatusScope，创建时捕获
  current,     // display identity 是否仍有效；不是 modal/foreground admission
  active,      // 原 Chat / 当前可呈现 surface 的 getter
  interactive, // modal 等临时屏蔽，不得据此重建 owner
  operation,   // () => PageOperation | null，main 的原 PageOperations lane
});
```

`scope = {host:{hostID,lease}, authorityKey, sessionID:string|null, directory:string|null}`。真正 host/lease/authorization/session/directory 变化由 main 更换 scope owner；不能把旧 scope 续命到新 Host。scope 副本被捕获，current=false 后不可恢复。临时 modal/后台只影响准入和 lane，不清快照/展开。

返回：

- `projection.commitChat(chat)`；`chat` 是 `DesktopWorkStatusChat`，只含 `tasks`、`activity:'working'|'idle'|'unknown'`、`taskFaces`、`liveTaskPartIDs`、`backgroundShell`。没有 draft、原 Chat 控制器、消息数组或 goal mutation。
- `projection.commitLocation(location)`；只含已解析的 `{project,secondaryWorktree,git}`。main 使用当前 Projects/worktree authority 与 Web `resolveProjectForSessionDirectory` 语义生成名称：项目 label 优先、否则 basename；secondary 判断按 normalizePath。pending worktree 的 Git 不可当 ready。
- `projection.commitChildren({phase,value?})`；有界、精确父会话和目录的 `DesktopWorkStatusChild[]`，每项 `{id,parentID,directory,title?,activity}`。成功空必须是 `{phase:'ready',value:[]}`；`unknown` / `unavailable` / `failed` 不等于成功空。
- `state()` 为 NSH computed，只在上述快照或 read lane 变化时失效；`todosExpanded`、`agentsExpanded` 是保留的 NSH signals（初值 true/false）。
- `readChildren(readPort)` 只在 main **明确调用**时读取；自动 mount、渲染、输入、展开列表、timer 均不发请求。它捕获当前 PageOperation、校验 hostID/lease，按同一 operation 合并在途读取；任何晚到/retired read/finally 不得覆盖新 lane。
- `capture()` 给当前有效 PageOperation 或 null；本组件的 copy/open-Git/open-child/展开操作均经此核验。`admitted()` 是显示交互准入，不取代 operation guard。

`WorkStatusAvailability<T>` 的 ready 必须带 value；Git 另有 `phase:'not-repository'`，它与 unknown、ready clean tree（changedFiles=0）、failed 保 prior 分开。failed refresh 保留此前 Git/children 数据；unknown 是明确没有 authority，不回填伪造空或零。`retireLane()` 清在途 admission，不清展示；native wrapper 监听 operation/current/lifecycle/active 做 lane fence，dispose 则彻底退休。

### 3. 原 Chat / child 接入位置

- `chat.tasks()` 已在 `state.ts` 的 `taskSnapshot` 按 tool/revert authority 维护。直接传这个 getter 的值；不重新创建 `createTasksProjection`，不在 input 或 text delta 上扫描 todos。
- `activity` 只能从原 Chat 已确认的 `busy()/retry()` live authority 得到；初次 active read 尚未确认时保持 unknown。`model.activeFrom` 和 `eventBusy` 是现有 live 判定依据，不能从 message.finish/tool.state 推父 working。
- `createDesktopWorkStatusTaskProjection()` 复用 Web 的 `projectTranscriptSubagents` / equality。输入为 `{messageOrder,partsByMessageID}`，接受已有 `nativeMessageEntry(message).parts` 适配结果；只由原消息 owner 的 **task/tool/revert/结构变更**调用。原 Chat 有 `observeMessageCommits` / `visibleMessages`，但 text patch 也会进入 commit；main 必须先按实际 tool/结构变更过滤，不能每条 text delta 扫全部历史。没有额外历史 GET、fill、第二 Chat 或 stream。
- shared faces 的 `running` 仅表示历史 tool 未结算；native merge 先清除此 live 含义，再由精确 `liveTaskPartIDs` / authoritative child activity 升为 working。原主 session 的 busy **不能**推广到所有历史 child。
- child port 类型 `DesktopWorkStatusChildRead = (operation:PageOperation, scope) => Promise<readonly DesktopWorkStatusChild[]>`。优先复用已有 Projects/child owner 的 exact-parent 快照与 live 状态。缺少数据时由 main 在可见 demand 下以 `page.capture()` 显式发一次 read；端口内部必须使用**传入的 operation.request**，不能重新 capture 或无 scope 原始请求。
- Web 查询是 scoped session.list `{directory,parentID:sessionID,limit:200}`。若从现有 `/api/session` SDK-gap adapter 提取，必须核对真实 `{data,cursor}`、父 ID、目录，missing data/失败要抛错；不能把 catalog 中“恰好没找到”当权威空，也不能用 persisted children 的 pending/running 当 live。现有 `projects-sidebar.ts` 的 exact-parent 读取与 `PageOperation` 是可复用边界；不自动枚举目录或另起 polling。
- child authority 与 task source 接通前，保留 unknown/unavailable；`backgroundShell` 同理。不要为了让 fixture 看起来完整而向 actual root 注入 synthetic 数据。

### 4. Panel/action props 与几何槽位

`NativeDesktopWorkStatusPanelProps`：

```ts
{
  owner, actions, visible, overlay,
  chatBounds,          // NSH Bounds：原 chat body（header 之下）的 root 坐标
  toggleBounds?,       // 原 header toggle 的 root 坐标，防 outside pointer-down 双重 toggle
  onCloseOverlay,     // windowOwner.closeOverlay
  reducedTransparency?
}
```

`visible = layout.inline || layout.overlay`，`overlay = layout.overlay`。Panel 挂在 **原 transcript/composer 共用的相对定位 body 容器内**，作为原内容的 sibling；不是 ResizablePanel，不放进侧栏，不创建第二 Chat。inline 由原生 View absolute right/top 定位；popup 无 anchor，用原生 Overlay 的 root-fixed 坐标 `x + body.width - 14 - 264` / `y+12`。不要锚到 header 按钮后任由 flip 更改 Web 的 chat 内几何。

根读取真实 onLayout/root bounds；其更新只影响 panel geometry，不拉数据。原 transcript Scroll/List 保持满宽以使滚动条在窗口边缘；正文 column 与 composer column 在 **扣除 reserve 的剩余空间内居中，maxWidth 也受剩余空间限制**。只给整个 scroller 施加 right padding/缩宽不等价。临时 modal 不卸载本 scope owner/展开值；外部 modal 通过 interactive=false 阻断动作。popup outside/Escape 在无 modal 时关闭，toggleBounds 排除 toggle 自身的 pointer-down。退出保留 200ms、交互禁用，reduceMotion 时无过渡；展开值不随 popup/inline 切换丢失。

`actions: NativeDesktopWorkStatusActions` 的全部端口必须由真实 consumer 提供：

```ts
{
  copyText(text, capturedScope): Promise<void>,
  openGit(capturedScope): void,
  openChild({scope,sessionID,label,readOnly:true}): void,
  onError('gitView.toast.copyFailed'): void,
}
```

copy 的原生 Clipboard 能力由 main 提供，失败沿原 toast/error consumer；组件没有全局 API 依赖。openGit 接现有 Git tab，openChild 接原只读 context-chat tab，不导航替换主会话。**Web 此处没有 open-file 入口**；不为了“有 action”凭空添加按钮，文件打开留给真正 Git/child consumer 的既有端口。

## NSH 0.4 共享 helper 闭包

`workStatusSubagents.ts` 的运行时 `@/components/.../taskToolModel` 别名会被 NSH 0.4 原样留到 QuickJS，运行时报 `could not load module ...`；加临时 tsconfig 并不能修复。为不越界修改共享文件，`desktop-work-status-helpers.generated.ts` 是当前 Web helper 的 Bun 纯预编译输出，只包 task parser 与三个 pure helpers。**不是手抄/另建算法**：focused test 对生成正文做 byte-exact 核验，source 变化立即红灯。类型仍从原 Web module 导入，无 Node/React/SDK/store 进入 production 闭包。

重新生成正文命令（前两行生成声明保留）：

```sh
bun build packages/ui/src/components/chat/work-status/workStatusSubagents.ts \
  --target=browser --format=esm --env=disable --minify
```

## 验证与未验

```sh
NSH_BIN=/path/to/nsh-0.4.0/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-work-status-core.test.ts \
  packages/nsh/desktop-work-status-native.test.ts
```

- 9 个 focused pure tests：窗口模型、todo cancelled/全完成/live、共享生成闭包、title/seed/dedup/history fence、50 no-op、Git unknown/empty/failure/not-repository、child 合并读取/失败/空、scope 与迟到、不可逆 display retirement。
- wrapper 在独立 OS temp 目录生成 config/entry/steps，不污染仓库 `.nsh/test`。真实生产 `NativeDesktopWorkStatusPanel/Compact/Todos/Toggle` 与 projection，Mac/Windows 每侧 4 项，共 8 项；synthetic PageOperation 和具名 audit Host，绝无真实网络、Host 写入、账号或模型。检查完整 Web 区块/原动作、copy/error/read-only child、modal/resize/preview/expanded/escape、失败保 prior、empty/unknown/retired lane、50 次原生 Input 事件零额外 read / **生产 state accessor 访问**，以及 2000 todos / children 的虚拟化。
- 这不是 actual-root、真实主 Chat composer 或原生 OS 像素证据。实际 root 仍由 main 接线后单独测 50 次真实 composer；本轮不替代 AppKit/Win32 实机、light/dark/高对比/读屏/IME、popup 材质和排版截图、窗口边缘及真实 Clipboard/child live/后台 shell source 联调。headless 不绘制 blur/shadow，不能因此宣布视觉 1:1 完成。
- 当前缺口：main header action 与 body reserve/Bounds 接线；原 Chat 的 tool-only task-face commit 和真实 live part-ID 集合；authoritative child title/activity 端口；project/worktree/Git 既有 snapshot 的窄适配；真实 Clipboard/Git/read-only child action；actual-root 验证。session-attached worktree 的跨启动 authoritative source 仍是已有缺口，不能从 catalog/path 猜出 attachment。

本轮最终记录：新增 9 个 pure 场景与真实 native Mac/Windows 8/8 GREEN；连同既有 `chat-tasks-model.test.ts` 的 focused 运行 3 files / 21 Vitest tests GREEN（native wrapper 内部另核验 8 passed）。`tsc --noEmit --project packages/nsh/tsconfig.json` GREEN。`bun run dead-code` 已执行，仍在加载既有 `packages/web/vite.config.ts` 时被缺少 `vite-plugin-pwa` 阻断；没有为此安装依赖或修改配置。并行 main 改动后仍需重跑。
