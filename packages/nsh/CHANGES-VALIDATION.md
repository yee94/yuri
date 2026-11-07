# Chat Changes：证据、实现与未闭合验收

本页仅覆盖 Changes 与关联文件 diff。**尚未完成 1:1 验收**；headless、类型检查不能替代 UIKit/真实 Host。本轮未启动生产 App、浏览器、模拟器或服务器，未在用户工作树执行任何 Git 写操作。当前工具目录未提供下层代理派发工具，故没有声称完成 explore 子代理；以下源码证据由当前代理只读核对。

## Web 证据

- 本轮主线程提供真实手机布局截图：`.scratch/nsh/chat-frames/F03-web-changes-native-parity.png`。截图可见 Changes 标题/branch、关闭/调整高度、同步、分组计数/树形目录、文件状态/统计和批量/单文件动作。底部提交区需结合 owning 实现核对，不能从被截图裁出的区域推断不存在。
- `packages/ui/src/components/chat/DOCUMENTATION.md:3-13`：composer Tasks/Changes 互斥、全列宽、外部点击关闭、关闭时不构造逐文件行；`:15-22`：workspace、session、turn 数据链独立。
- `packages/ui/src/components/chat/PendingChangesBar.tsx:63-78`：点击摘要文件进入移动 Changes diff；仅当 staged 且没有 working 时默认 staged。`:101-109`：打开列表静默刷新并保留旧摘要。
- `packages/ui/src/apps/MobileApp.tsx:3283-3375`：turn/direct-file/workspace 是独立 sheet；turn 明确 `diffScope="turn"`，携带所属 session/message；直接打开文件的标题/关闭由外层拥有。
- `packages/ui/src/apps/MobileChangesSurface.tsx:86-100`：list/diff 路由与指定文件更新；`:124-143`：去重、路径排序、staged/unstaged 独立分组；`:319-379`：同步和暂存/取消暂存；`:399-435`：还原；`:468-518`：提交与提交后同步；`:522-558`：分组动作；`:618-690`：header、滚动文件区和固定提交 footer；`:713-798`：错误/重试、loading、missing、binary/image 与 inline/wrap/targetLine diff。
- `packages/ui/src/components/views/git/ChangesPanel.tsx:29-65,100-149`：文件/目录/全组动作，树形/平铺，分组与目录折叠；`changesTree.ts:47-119` 为实际纯树算法。
- `packages/ui/src/components/views/git/CommitSection.tsx:45-81,82-164`：已暂存和消息共同控制提交、未暂存说明、textarea、生成按钮。生成还包括 highlights（本 Native 尚未实现）。
- `packages/ui/src/components/views/DiffView.tsx:1158-1233`：所属 user turn 的 thin files 为列表 authority；已有 patch/before/after 才视为有正文，不以空字符串掩盖未加载。`:666-713`：按文件补取历史正文。
- `packages/ui/src/queries/sessionTurnChangesQueries.ts:66-104,123-140`：历史 L3 路径与仅 404/405/501 或旧 L2 payload 的 legacy fallback；`packages/ui/src/lib/opencode/client.ts:1203-1243`：legacy `session/:id/diff` 仍带 messageID，失败不为空成功。
- `packages/web/server/lib/git/routes.js:422-449,483-545,575-604,679-709,844-867`：本 Native 复用的既有 diff、revert、stage、unstage、fetch/pull/push/remotes、commit 请求。

## 当前实现

| 项目 | 当前行为 / 证据边界 |
| --- | --- |
| Composer 摘要 | 原有纯计数规则；逐文件对象只在展开时构造；原生 List；保留后续合入的 Overlay/anchor 外点关闭与布局回归。失败保留 authority、显式 retry。 |
| Sheet | `NativeChangesSheet`，真实 `nsh/base` Sheet，关闭按钮/遮罩/Escape/swipe；打开先 dismiss keyboard。safe-area 左右/底部；键盘出现时缩短并上移 popup。handle 有 responder 拖动，按 42%/72%/100% 收敛；这些手势/尺寸仍待 UIKit。 |
| Workspace 分组 | 路径去重排序；staged 和 working 各自列出同一文件的不同层。树/平铺、组/目录折叠、分组数、路径、状态、增删数。复用 Web `changesTree` 纯算法；`chat-changes-tree.js`/`.d.ts` 仅隔离其浏览器 API 类型图，不复制算法。 |
| 显式写动作 | 单文件、目录、全组 stage/unstage；还原需要原生 destructive 确认；批量逐项有界派发，失败路径保留，不清掉无关完整实体。retry 还原只选失败路径且再次确认。历史 source 在核心拒绝全部写动作。 |
| 提交 | 固定 footer、未暂存说明、可调整高度的 multiline 原生输入；提交和提交后同步。失败保留当前文本；确认提交成功后才清空。请求显式 `stageFiles: []`，防止同文件未暂存内容被一起加入（服务端 `service.js:3159-3187` 的 index-only 合约）。同步失败不会要求重新提交。 |
| 同步 | 与 Web 同序：remotes→fetch→authority status→必要 pull(rebase)→status→必要 push；behind 且 dirty 时核心拒绝 rebase。仅用户点击后执行，不后台写、不自动重试写。 |
| 当前文件 diff | 原有 `/api/git/diff`，原生 List 行显示 patch/行号/增删色；不是 Markdown fenced preview。按 staged 和文件隔离；刷新失败保留相同文件正文。成功空 diff 与失败不同。 |
| 历史 diff | 独立 `turn` source；真实快照 patch 或 before/after；thin file 按真实 session/message/file 从 Host L3 补取，按 Web 的窄条件 fallback 到该 turn 的 legacy diff。**任何时候都不回退当前 Git diff**。无正文失败可重试。 |
| 定位/预览 | 有 patch 时解析 hunk 行号，可跳首变更/请求 targetLine；preview callback 带路径和首变更行。只有 before/after、无 patch 时显示完整两侧原生 code 文本，首变更按钮明确 unavailable，不冒充精确定位。 |
| 生命周期 | 关闭/隐藏/Host/较新选择的 serial/generation fences；旧响应不得覆盖新路径。Sheet 按 Host、scope、session/message、初始 path/staged/targetLine/revision 分隔 lifetime。 |

## 主线程接线

```tsx
<NativeChangesSheet
  source={{ kind: 'workspace', directory: target.directory }}
  open={changesOpen()}
  active={chat.active()}
  onClose={() => changesOpen.set(false)}
  onOpenPreview={(path, line) => openExistingNativeResourcePreview(path, line)}
/>
```

上例 `openExistingNativeResourcePreview` 是接线示意，不是新增请求接口；使用现有 ResourcePreview/native resources。若资源预览没有行定位，不能静默声称支持 line。

- 顶部 workspace Changes 应打开此统一 Sheet，不 push 旧 Changes 页面。
- `NativeComposerChanges` 已自行把选中 diff 打开在 Sheet；旧 `onOpenFile(path,staged)` 仅为编译兼容保留，**不会再执行旧 Markdown 导航**。可删除生产端这段旧 fetch/nav 回调。真正普通预览改用 `onOpenPreview`。
- 历史工具入口不要再 push fenced diff preview。使用 `source: { kind:'turn', directory, sessionID, messageID, files:[{path,patch,before,after}], path }`。session/message 必须来自所属真实 turn，不能用当前选择覆盖历史身份。若同一 turn 的权威快照更新，递增 `revision` 使正文 lifetime 更新。
- `files` 是已取得的真实 thin 列表，不用假数据，不把未知列表传空数组冒充无变更。L3 `loadFile` 是可选注入，默认已复用 Host 正规历史 route。
- `NativeChangesSheet` 的 `owner` 是 composer 内部复用 reader 的接口；普通主线程调用不传。顶部和 composer 当前分别持有 page-owned reader，非全局 cache；成功写后由原有 Git 事件/显式 refresh 让其他摘要恢复。是否收敛为 Chat 共享 controller 属主线程接线项，不能把两者误报为同一缓存。
- 主线程应保持 Models/Agent/Changes 等覆盖层互斥，避免两个 Sheet 同时打开。父 Chat 离开/切 Host 后 `active=false` 或销毁该 owner。

## 未闭合项（仍在 1:1 范围内）

1. **真实 Host / Relay / UIKit 的所有动作均未验收**。本轮 stage/revert/commit/sync 仅调用内存 mock，不证明真实服务端语义或平台正确。
2. Web 精确排版/密度、文件类型图标、工具按钮图形/rail、header 单一材质、暗/亮色逐帧、长路径和小屏 footer 仍需对图。本 Native 部分按钮用文本符号，不等于官方图标 1:1。
3. Sheet 的 drag/swipe 手势竞争、velocity/spring、键盘交互、横屏/分屏、VoiceOver 调整大小尚未验证；当前 snap 不宣称复刻 Web 高度算法/惯性。
4. 提交信息生成/highlights 尚未接通，按钮明确 unavailable。本轮禁止调用付费模型，未用假生成结果充数。
5. Diff 不是 Pierre 渲染器：语法高亮、完整上下文切换、wrap 开关、多文件展开策略、inline comments、hunk actions、图片对照、跨行原生选择仍未闭合；before/after 目前是两侧 literal code，不宣称已重建精确 inline hunks。
6. 首变更/targetLine 的实际滚动落点与普通资源预览的 line 参数需要 UIKit/资源接线核验；不存在可定位 hunk 时明确 unavailable。
7. Web no-remote/dirty-behind 的预先 disabled/tooltip、成功 toast、超大 changes 的 server oversized 延迟 UI、跨入口共用缓存与所有 Git 事件刷新细节仍未逐项对齐。当前核心仍会在动作时检查，失败不当成功。
8. 原有其他 Git 页面/文件树/commit 历史入口不归本模块改写；不能据此声明整个 Native Git 功能全部还原。

## UIKit / 真实 Host 验收步骤（主线程执行）

1. 在单独、可丢弃的测试仓库准备 staged-only、working-only、同文件部分暂存、untracked、delete、rename、binary、嵌套目录，使用真实连接；**不要在用户当前工作树测试写操作**。
2. 与 Web 同目录/同状态对帧：打开顶部 Changes、返回/关闭/遮罩/下拉；确认不重复 header/close；拖动三个高度、目录和分组折叠、树/平铺，长列表滚动，footer 固定。
3. 展开 composer 后点文件：默认 staged 选择规则正确，直接进 diff；返回为同组列表；关闭恢复原草稿、输入光标与 transcript viewport。
4. 打开旧轮次/旧工具 diff，再修改当前文件：历史内容不变。L3 offline/旧 Host fallback/Host 切换中途返回都不注入 current Git 内容。
5. mock/测试 Host 注入读失败和成功空：旧列表/正文保留、错误可见可 retry；切文件、切 staged、关闭后旧响应不得覆盖新选择。
6. 在测试仓库逐个确认 stage/unstage、目录/全组操作、还原 Cancel/确认/部分失败再试；暂存/未暂存同文件不互相混淆。核验提交 index-only，失败保留输入，commit 已成功但 sync 失败时不重复 commit。
7. 键盘显示时打开 Sheet，应先 dismiss；再次编辑提交信息，footer/关闭/resize 不被遮挡。试中文 IME、粘贴/撤销、横竖屏、Dynamic Type、VoiceOver、浅深色。
8. 测 300 与真实大列表；关闭后输入至少 50 个事件，确认无逐文件行构造/新增 status 请求；实际输入 median/P95/max 与 UIKit 帧耗时尚需设备记录。

## 自动验证记录

- 红：新增 reader/actions 模块前，Vitest 因模块不存在失败；新增历史 L3 行为前，2 个断言实际失败。
- 绿：`NSH_BIN=… bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/chat-changes-model.test.ts packages/nsh/chat-changes-actions.test.ts packages/nsh/chat-changes.test.ts`，收尾结果 **3 files / 16 tests passed，9.13s，退出 0**。包含纯 reader、Web tree bridge、写动作 mock、真实 NSH headless Sheet/失败恢复/确认以及既有布局 fixture；不运行生产 App。
- `nsh check chat-changes-test-app.tsx`：类型检查已通过（只 check，不运行生产入口）。直接导入 Web tree 曾带入浏览器类型图；改为窄 JS/declaration bridge 后已无该错误。
- 根 `bunx vitest run --project @yuriai/nsh …`（包括显式 `--root`）实际输出 **No test files found**；未擅改主线程/全局 runner config。使用 package 已有 `vitest.config.ts` 的同名 `@yuriai/nsh` 项目运行成功，不冒称根 projects 发现已修复。
- `bun run dead-code` 已执行、退出 0；报告含现有 fixture unused 提示以及尚待外部接线的 `NativeChangesSheet` export 提示，未据此删除其他文件。
- 未运行完整 NSH package suite（其中仍有生产 App 型 fixture，存在共享生成文件竞态）；未运行 production App、UIKit、Host 写操作或付费模型/语音。
