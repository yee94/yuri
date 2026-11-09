# Desktop Diff 切片合同

本切片拥有 `desktop-panel-changes.tsx`、`desktop-diff-*`、原 `chat-changes-model.ts` 的显式全文 operation 与独立 focused 测试。不表示完整 Mac/Windows Web 1:1 已完成。

## 权威与边界

- NSH 固定 0.4.0（`e626a8d`）。对照只读 NSH `website/elements/diff-view.md`、`crates/nsh-base/src/diff/{review,controller,patch}.rs` 及本包生成的公开类型；没有修改 NSH 源码或依赖。
- Web 对照 `components/views/{FilesView,DiffView,PierreDiffViewer}.tsx`、`views/diffPatchUtils.ts`、`chat/message/DiffViewToggle.tsx`、`layout/ContextPanel.tsx` 与 `stores/useUIStore.ts`。打开编辑器的首个真实变化行直接复用 Web 纯 `getFirstChangedModifiedLineFromPatch`。
- `NativeDesktopChanges` 每个 captured source 仍只创建原 `createChangesReader`，沿用 captured `bindRequest(scope.host)`、`current()`、active/lifecycle 和 reader serial。普通 Diff 已实际接入 `NativeDesktopDiffList`，由 list 独占正文 select/full demand；file-diff 保留原单文件 document consumer。显式全文 GET 归属同一 reader，没有第二 transport、inventory/status reader、流或凭据边界；历史 never current Git。
- 完整文本始终保留；空 patch 不遮住已持有的 before/after。复制非空 patch，否则复制完整 before + 两个换行 + after；不因视口/大文件限制截断 source。

## 主线程装配：精确新增 props

`NativeDesktopChanges` 的原 `scope/source/current/active/onOpenDiff/onOpenFile` 合同不变。以下全部可选，没有自行读取或持久化偏好：

```ts
preferences?: Readonly<{
  layoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  fileLayout?: 'inline' | 'side-by-side'; // 当前 path 的既有 override
  wrapLines: boolean;
}>;
onLayoutChange?: (paths: readonly string[], layout: 'inline' | 'side-by-side') => void;
onWrapLinesChange?: (wrap: boolean) => void;
onOpenEditor?: (path: string, line: number) => void;
onFocusStatus?: (focus: DesktopDiffFocus) => void;
files?: readonly { path: string; staged: boolean; status: string; isNew?: boolean }[];
showFileSidebar?: boolean;
singleFileView?: boolean;
filePreferences?: (path: string) => DesktopDiffPreferences | undefined;
refreshRevision?: string | number;
```

- `preferences` 必须是 root 已有设置 owner 的窄只读投影；layout/wrap 回调交回同一个 owner。没有 callback 就不画可改变该偏好的控件，不创建本地 setting/storage。无投影时使用 Web store 的真实默认 `inline` / `wrapLines:false`，不是擅自选择 dynamic。
- 优先级：当前 `fileLayout` → 显式全局 inline/side-by-side → dynamic。仅 dynamic 使用**窗口**宽度 1100pt 阈值；新文件 dynamic 为 unified。不是根据工作台局部宽度猜阈值。new metadata 由 `files` 提供；没有 metadata 时只接受 patch 的 `/dev/null` 明确信息，不把空 before 当作新文件。
- `files` 只能来自同一 captured source/catalog，并保持 staged 语义；它优先于原 reader inventory。普通 workspace Diff 缺少该投影时（包括已有 source.path）通过同一个 reader.refresh 获取完整 catalog，不把 source.path 猜成全目录。历史直接使用 source.files。Working/Staged 只改变受控 scope，不替换 source/reader；没有 exact turn source 时 Turn 不可选。换成 exact turn source 才创建对应 reader，绝不改成 workspace。
- `showFileSidebar` 默认 false：当前 Web ContextPanel 明确 `hideStackedFileSidebar`，不向工作台偷加侧栏。只有 standalone Diff surface 可显式开启，宽度 ≥1024pt 时用 Web 288pt 列表。该列表是显式文件导航，不是新增远端读取。
- root 的 `tab.kind === 'file-diff'` 已传 `singleFileView:true`；与 Web 相同隐藏全局 toolbar，但继续消费已保存偏好，并保留原 `DesktopDiffDocument` 单文件体验。普通 `diff` 显式传 false，真实 consumer 消费原 `diffPreferences.preferences()` 和逐文件 `preferences(path)` getter，不建立第二偏好 owner。
- standalone 显式打开的文件侧栏按真实 Web `handleSelectFileAndScroll` 展开并定位同一 stack 文件，不创建新 Diff tab；文件 header 的 preview 仍调用原 `onOpenFile`。`onOpenDiff` 端口保留兼容原调用方，但不拿旧侧栏测试断言制造新的导航。历史 source 的 session/message/directory 不变。
- `onOpenEditor` 只画在 workspace，调用已有文件 editor/nav owner，目标是一基真实首变化行，不是 hunk context 起点。历史保留原 preview 回调，不画编辑动作。所有导航/复制/偏好/重试/完整上下文动作同步复验 current，隐藏、后台与外部模态不得经回调绕过。
- 字号/字体/行高直接消费现有 `nativeChatTextStyle('code')`。色彩使用根已映射的语义 token；不创建新主题或字体设置。

## 定位与高亮的真实能力

NSH 公开 `goToHunk(index)` 只能将 hunk 首行带入视口；不能精确滚动到超长 hunk 内任意 targetLine，也不能对未在 patch 中的上下文凭空定位。没有使用 `setScrollOffset`、line-height 乘法或 DOM/私有 API 猜位置。

当前实现将 targetLine 映射到 native reconstructed-new-text 索引，调用公开 `setSelectedLines`；patch 缺少该行则不伪造 selection。可选 `onFocusStatus` 在 `selectedLines()` 实际读回后才发布：

```ts
type DesktopDiffFocus = Readonly<{
  requestedLine?: number;
  viewport: 'hunk-only' | 'unavailable';
  hunkIndex?: number;
  selection?: { side: 'new'; start: number; end: number };
}>;
```

精确选行不等于精确视口落点。异步 native ref/hunk/selection 回读受 mounted、current、ref 和正文 snapshot fence 保护。初始化后字号、换行和窗口 resize 不再重发定位；没有给滚动热路径增加 patch 扫描。显式全文/patch 转换捕获真实 `selectedLines()` 与 `currentHunk()`，通过源行映射恢复选区、用公开 `goToHunk` 恢复所属 hunk；不承诺 hunk 内像素锚点。NSH 的 text-change 会清 selection，必须等实际 native prop adoption/read acknowledgement 后恢复，不能只保留 JS 索引。已删除原独立“first-change”滚动按钮：Web 文件 header 没有这个按钮，不能把它标成精确行导航。

## 完整上下文与剩余阻塞

- workspace 的 full-files 按钮显式调用原 reader 的 `loadFullContext()`。成功前仍显示原 patch，只有两个真实全文字段通过验证后才以 oldValue/newValue + `expandAll` 消费。整个 operation 不替换 `state.diff`，因此原 `Each key=diff`、`DesktopDiffDocument` 与原生 DiffView 不重挂。关闭全文回到同一原 patch；已读全文仅在同 reader 当前 selection 中保留，显式重新开启不重复 GET。
- 历史保留 NSH 原生 separator 展开，不额外添加 Web turn toolbar 没有的 full-files 按钮；即使直接调用 reader 的全文方法，turn source 也不发 workspace 请求。
- binary 使用独立 unavailable 提示，保留文件 header/preview；无文本时 copy disabled。双空 before/after 是有效已加载空结果，不能触发历史回读。刷新失败保留旧正文并通过原 refresh 重试；复制与 native metadata 错误各自重试，不把复制失败错当成重新读取正文。
- 多文件 list/stacked、每文件折叠、整组展开和 scope selector 已接入真实 `NativeDesktopChanges` / `NativeDesktopPanel`；装配与合成证据见下节。完整 file mutation/hunk operation、图片 diff 与 selection comments 仍未完成；未为它们创建第二 reader 或仿制按钮。这些是完整 1:1 的欠项，不是删减验收范围。
- 真实 AppKit/Win32 绘制、系统剪贴板/物理键盘、真实 Host/Relay、超大原生 diff 的帧率/内存和完整同状态视觉均未验；headless 不证明这些行为。

## 正式全文 DTO、分类与冻结 operation

只读依据：`packages/ui/src/lib/gitApiHttp.ts#getGitFileDiff`、`lib/api/types.ts#GitFileDiffResponse`、`packages/web/server/lib/git/routes.js` 的 `/api/git/file-diff` handler、`service.js#getFileDiff` / `getDiff` / `createRepositoryGitContext` / `resolveGitFileContext`。

正式调用为 `GET /api/git/file-diff?directory=...&path=...`，仅 staged=true 时追加 `&staged=true`，返回 `{original:string, modified:string, path:string, isBinary:boolean}`。Native 严格校验返回 path，使用字段原样映射 before/after，绝不自己读取 `/api/fs` 或拼造 Git blob。服务端会规范化 CRLF→LF；本端不裁剪、不再改写文本，也不将此 DTO 宣称为 byte-exact Git blobs。

**重要：该 route 的 original 总是 HEAD，而不是 index。** staged modified 读取 `:repoPath`；working modified 读取工作树。Native 在同一个 explicit operation 中前后各 GET `/api/git/status?directory=...&mode=light`（无 since，不复用缓存，不取 diffStats），校验所选文件完整 status 及其身份未改变；其他无关文件不参与失效判断。

| 类别 | 当前行为 / 精确限制 |
| --- | --- |
| staged M/A | 正式 HEAD→index DTO；即使 working 也有改动，绝不拿当前 fs 替代 index |
| working，index 无改动 | 正式 HEAD→fs 与 index→fs 基线一致，才允许升级 |
| working，index 有 staged 改动 | `full_context_index_baseline_unsupported`，正式接口没有 index→fs 全文，保原 patch |
| 新增 / untracked | status 必须明确 A/?；original 必须真实返回空，不能用状态主动构造它 |
| working deleted | 必须真实返回 modified 空；不构造缺失正文 |
| staged deleted | 当前 server `git.show(:path)` 缺失往往抛非 ENOENT，正式 route 500；保 patch/错误，明确是 server 缺口，不拿 fs 或 fake empty 兜底 |
| rename / copy | status R/C 或 patch rename/copy header 直接拒绝。正式 DTO 没有旧路径，服务端用 HEAD 的目的路径，不能冒充 rename 原文 |
| binary | 必须与原 patch 的 binary 分类一致；不将新 binary/失败当作双空 clean。当前文件变为 binary 时须先显式刷新 patch |
| 图片 | 正式 route 会返回 data URL，而 native 此处没有图片 diff renderer；明确 `full_context_image_unsupported`，不把 base64 当代码全文 |
| tracked 的空 original | server 会吞掉任何 HEAD 读取失败；只有标准 patch 明确 `-0,0` 的空基线才接纳，否则 `full_context_empty_original_unproven`。非空旧 patch 的已知行也必须逐行匹配 |
| unknown / conflict / partial / 无法精确匹配 status path | 失败保 patch。status path 为 repo-relative，若 captured directory 并非实际 repo root，且绝对源路径无法与它精确对应，目前缺 repoPath/root DTO；不按后缀、basename 或 sibling 猜测 |

真实 original/modified 必须覆盖原 patch 的已知源行并匹配内容；错 path、字段缺失、binary 改类、空值冒充失败、post-status 改变均拒绝。前后 GET 只是窄校验，不是 Git 原子快照/CAS；server 没有提供 HEAD/index/blob revision，不能声称排除了中间 ABA 或跨读时刻的所有变化。

`ChangesReader` 冻结 API（旧方法/默认请求不变）：

```ts
loadFullContext(): Promise<void>; // 仅当前 workspace、已采用 patch、显式 demand
cancelFullContext(): void;       // 撤销在途全文，保已完成同 selection 快照
state(): {
  // 原 snapshot/loading/error/path/staged/diff/diffLoading/diffError 不变
  fullContext: HistoricalChange | null;
  fullContextLoading: boolean;
  fullContextError: string;
};
```

每个 await 同时复验 captured directory/path/staged、原 diff 对象、diff/full serial 和 `current()`；request 仍是构造 reader 时的同一个 bound lease。新 path/staged、patch refresh、back、cancel、Host/lifecycle 退休使旧 operation 失效；重复 pending demand 合并，不在后台、恢复或输入时自动读取全文。cancel 撤销结果准入及后续请求，不宣称物理中止已发出的 native GET。失败/unknown GET 保留已有 patch/有效全文，Retry 仅再执行这些 GET，不涉及写入回执或重放 mutation。

Desktop root 不需要新增任何 props。`NativeDesktopChanges` 已内部装配唯一 reader。仅叶子 `DesktopDiffDocument` 有如下 owning-operation 端口，供同一 reader 消费，不能另建 loader：

```ts
fullContext?: {
  snapshot: HistoricalChange | null;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  cancel: () => void;
};
```

加载中可用同一个 full-files 按钮卸载/取消；失败有原 operation 的本地化 Retry。移动端原 `select/retryDiff/refresh` 不会自动调用这些新方法，原请求合同不增加 status/full-file GET。

## 回归与证据

```sh
NSH_BIN=/path/to/0.4.0/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-diff-model.test.ts \
  packages/nsh/desktop-diff-native.test.ts \
  packages/nsh/desktop-panel-native.test.ts \
  packages/nsh/desktop-panel-chat-workbench-native.test.ts \
  packages/nsh/chat-changes-model.test.ts \
  packages/nsh/chat-changes-full-context.test.ts \
  packages/nsh/desktop-diff-server-contract.test.ts \
  packages/nsh/desktop-diff-full-context-native.test.ts \
  packages/nsh/chat-changes-actions.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
```

独立 `desktop-diff-native.test.ts` 使用唯一临时 nsh.json/App/runner，加载**生产** NativeDesktopChanges/DesktopDiffDocument，不启动生产 App/Host，不共享 `.nsh/test` 生成入口，不改生产 active 或平台行为迎合驱动。

覆盖 macOS/Windows 模型的 1100 阈值与 override、真实 native 选行回读、完整 before/after 复制、字体比例/亮暗主题、50 次真实 Input 输入零请求、历史目录与 session、失活/后台/authority 撤销门禁、唯一 expectedHost/lease GET reader、失败保留/显式重试与不同正文的迟到读拒绝、完整上下文展开、双空/binary/single-file、8000 行历史全文复制及 50 次输入零请求和超长 hunk 的明确缺口。大型 fixture 不代表真实设备性能预算已测量。

`bun run dead-code` 被当前工作区既有 `vite-plugin-pwa` 缺失阻断；没有补装依赖绕过。首次 broader 回归曾因未提供 preferences 时误用 dynamic 导致既有统一布局几何断言失败；核对 Web store 的默认 inline 后修正 fallback，保留了原测试和生产行高，未将 native 布局改成迎合 headless。

上一阶段 broader 回归为 5 文件 / 33 项通过；加强的大文件/不同迟到正文回归为 2 文件 / 7 项（原 native runner 内含两平台共 10 个生产组件场景）。

本轮补完正式全文 operation 后，最终上述 **9 文件 / 62 项通过**；独立临时 tsconfig 与最后全包 tsc 均通过。新增 native 全文 runner 内含 Mac/Windows 各 4 个生产场景，以及 1 个按真实 `loadConnections` 确认准入后打开 Composer Changes→原 NativeChangesSheet 的 iOS 模型场景。覆盖同 mounted document、实际选区从 patch 的 1→全文 100→patch 1、公开 hunk 锚定、9000 行上下文完整复制与 50 次输入零请求、失败/unknown 只读 Retry、staged DTO、基线不一致拒绝、后台/Host/卸载取消、恢复不自动读全文。iOS 模型场景严格拒绝新增 file-diff/light status GET，验证原移动消费者默认合同未变；不证明 UIKit Sheet 生命周期或真实系统渲染。

`desktop-diff-server-contract.test.ts` 从实际 owning 文件 AST 取正式 route handler 和 `getFileDiff` 函数，在隔离 I/O seam 上执行，验证真实 HEAD/index/fs 分支、DTO、吞 HEAD 错误、staged deletion、binary sniff 与 CRLF 合同；不执行 Git/真实 Host 或文件操作。

额外执行的既有 `chat-changes.test.ts` **3 项未通过**：原 fixtures 未调用 `loadConnections`，停在当前生产 confirmed-readiness/current 门禁前，首个 status/branch 就没有出现。没有修改旧 fixture、关闭生产门禁或改测试预期来迎合绿灯；上述新增 admitted 移动消费者回归单独通过。独立打开的新 Sheet 在旧 fixture 路径的初始化/operation 采用也不属于本次 full-context 修复，不能据此声称已签收。

并行集成期间全包 tsc 曾被外部 header 文件类型阻断，本切片未改它们；最终重跑已通过。`dead-code` 仍被既有 `vite-plugin-pwa` 缺失阻断，未添加项目依赖。

## 多文件 list / stacked 生产接线

`desktop-diff-list.tsx#NativeDesktopDiffList` 已由真实 `NativeDesktopChanges` 普通 Diff 分支消费；`desktop-diff-list-core.ts` 只协调原 `ChangesReader` 的串行需求和已采用正文的源内保留。没有自行构造 reader、transport、inventory、设备偏好 owner 或文件写入。`desktop-panel.tsx` 仅改 Diff props/consumer，application、mobile Changes、state 与 Host/Rust 未修改。file-diff 不强行迁移到 list。

### 冻结输入

```ts
source: ChangesSource;
reader: ChangesReader;                  // 原 owner 的同一个 reader，reader.source === source
scope: 'working' | 'staged' | 'turn';
snapshot?: ChangesSnapshot | null;      // 原 inventory 的成功快照，不自行请求
files?: readonly DesktopDiffListFile[]; // 可选原 catalog 投影，完整原序，不截前 N 个
refreshRevision?: string | number;      // 原 owner 确认失效时推进；不是输入/render 次数
current: () => boolean;                 // captured authority / target fence
active: boolean;                        // 原 lane/modal 的交互准入；组件另外复验 lifecycle
targetPath?: string;
targetLine?: number;
singleFileView?: boolean;
stackedDefaultCollapsedAll?: boolean;
turnIsToolSnapshot?: boolean;
showFileSidebar?: boolean;              // 默认不显示；与原 panel 的 hidden-sidebar 合同一致
scopeChoices?: readonly {
  scope: 'working' | 'staged' | 'turn'; count?: number; available: boolean;
}[];
onScopeChange?: (scope: 'working' | 'staged' | 'turn') => void;
preferences?: DesktopDiffPreferences;
filePreferences?: (path: string) => DesktopDiffPreferences | undefined;
onFocusStatus?: (focus: DesktopDiffFocus) => void;
onLayoutChange?: (paths: readonly string[], layout: DesktopDiffLayout) => void;
onWrapLinesChange?: (wrap: boolean) => void;
onOpenFile: (path: string, line?: number) => void;
onOpenEditor?: (path: string, line: number) => void;
```

生产装配合同：

1. 继续由现有 Changes owner 创建唯一 reader、绑定 captured request 和维护 inventory；将 reader/source、成功 catalog、原偏好投影和 navigation callbacks 传入 list。list 拥有文件正文 select/full demand 后，旧单文件 `reader.select` / 自动全文 consumer 不得同时竞争这个 reader；inventory refresh 仍留在原 owner。
2. working/staged 切换只提交 controlled `scope`；两者复用同一个 workspace source/reader，调用真实 `reader.select(path, staged)`。它们拥有隔离的正文、全文、展开状态和错误缓存。scope 变动只更换原生 List 展示实例，**不会**重建 reader；窗口 resize / composer 输入不更换 List 或 document。
3. turn 必须由原 exact session/message/directory 的 source 提供，切入时原子提交 source/reader/scope；source/revision 变更应换新的 captured reader。缺 exact source 时将 turn choice 标为 unavailable；thin file 的 exact durable resolver 缺失仍显式失败，绝不读 current Git。无 scope callback 时 selector 禁用，不假装已切换。
4. 原 owner 确认 workspace patch 失效时推进 `refreshRevision`，不能仅凭同样的 M/M metadata 推断正文未变。新 revision 标记两个已缓存 workspace scope；只对当前可见展开文件刷新，保留 prior，隐藏 scope 在以后实际 demand 时再读。相同 revision、输入及 resize 不做 GET。应先提交 authoritative catalog，再推进 revision；失败 inventory 保留旧 snapshot/error，不冒充成功空目录。
5. 普通 diff 传 `singleFileView:false`；file-diff 传 true 和精确 targetPath。standalone 才按需求开启 288pt 文件侧栏；工作台继续默认隐藏。写入、pending/unknown guard、restore/stage/hunk mutation 全部仍归原 owner，不能因新 list 而放宽，也不能并行发写请求。

原 inventory 的 polling/event 仅在 active、current、前台的普通 workspace surface 运行。缺 `files` 时成功 refresh 在采用 catalog 后推进 patchRevision，即使 status 仍是相同 M/M；失败保留 snapshot/error，不变成空成功。明确 runtime invalidate 即使 inventory GET 失败也使 prior catalog 的正文失效；供应原 catalog 时不额外 GET status，外部 owner 可用 refreshRevision 明确失效。输入、resize、正文 notify 不推进 revision。两个 workspace scope 都失效，但只刷新实际可见展开文件；隐藏 scope 等再次 demand。暂停撤销在途 full-files intent，恢复不自动重试被取消的全文 operation；已完成的全文展示/完整正文仍保留在同 source。

### 原生列表与读取合同

- 按本次要求保留 **source/catalog 原序**，不同于 Web 目前在内部按 path 排序；不截断所有文件。初始展开与 Web 同阈值：≤6 全部、≤12 为 6、≤25 为 4、更多为 2。非 tool 的 turn 默认折叠，目标文件展开。
- 文件侧栏与 stack 使用稳定 metadata item；正文/loading/error 更新不替换 List 的 item 对象。NSH List 会**回收 cell**，因此 cell 内再按文件 key 绑定 document，不能在可回收 accessor 外永久捕获第一次文件的 key。scope 改变撤销旧 List 的 viewability 回执。
- 只有原生 viewability 中真实可见且展开的文件参与 demand；每个 reader 同时只有一项 select/full operation。折叠/集中定位先撤销旧 demand，再在下一帧合并实际 native viewability，不使用估算行高或 offset 定位，不把中间估算视口读成全仓库预加载。
- 每个展开文件给原生 DiffView 一个有界高度的 box（视口 75%，180–720pt），**整个正文都交给原生 DiffView 内部滚动**。loading 预留同样高度，避免正文到达后将集中定位目标挤走。此实现不是 Web 的自然全文高度/单一外层滚动，不能签收为完整 stacked 视觉和滚轮行为一致；没有删正文或将 hunk 截短。
- 固定 NSH 0.4.0 的源码核验：`nsh-base/src/diff/view.rs` 内部 absolute Scroll 的 layout/scroll 独占虚拟化 viewport，`controller.rs#visible_rows` / `window.rs#RowWindow` 不采用祖先 clip；`DiffViewProps` 没有外部 viewport/offset 或关闭内部滚动的端口。将 `onScroll.contentSize.height` 直接设为视图高度会把全部行视为可见，违反下述 12,000 行节点预算，并使内部 offset clamp 到 0，破坏拖选和 hunk 导航。此项为 **上游能力阻塞**，不是 Yuri-only 接线可无损完成；需要 NSH DiffView 新增外部 window/scrollable，或将行虚拟化接到已有 core `ListViewport::Parent`（仍须处理 overlay、选区和定位）。本轮未修改上游源码，不用拆 hunk、截正文或 WebView 替代。
- 正文缓存仅随同一个 source/reader 存活，按 scope/path 隔离；删除当前 catalog 文件会清掉该 scope 对应项，source 退休释放全部。已访问正文不会因 List 回收或 50 次无关输入而重读；缓存总字节数随真实访问文件增长，目前没有字节上限/驱逐，尚未证明长时超大仓库内存预算。
- 全文开关只调用同一 reader 的 `loadFullContext()`。若 reader 当前 selection 在另一个文件，先显式 `select` 对齐，再执行原正式 operation；没有后台预读所有文件。已完成全文按文件保留，关/开不重复 GET。原基线、status 前后核验、binary/rename/image/unavailable 限制不变。
- `DesktopDiffDocument` 新增可选 `headerLeading`、`retainedView/onRetainView` 和 controlled `fullContextExpanded`，默认单文件消费者不变。retained 只采用原生已回读确认的 selection/currentHunk，并核对正文对象及 targetLine；异步回读尚未完成就回收的边界未签收，不承诺任意像素锚点或任意长 hunk 的精确滚动。

### 本切片证据与剩余验收

新增 `desktop-diff-list-core.test.ts` 覆盖 1000 项完整目录、原序/default expansion、scope 隔离、可见需求、失败 prior/重试、catalog/authority/visibility 退休、历史无 Git、正式全文和跨 scope 失效。`desktop-diff-list-native.test.ts` 在两平台模型中实际挂载 list/document，覆盖 source 顺序、List 远端文件定位、折叠/整组展开、1099/1100 resize、原生 scope picker→真实 staged select→exact turn、失败重试、模态/后台/目标/来源退役、正式全文开关和 50 次实际 Input 输入。

`desktop-diff-list-performance.test.ts` 使用 native `--trace` 对照 400 与 12,000 行历史全文（400 行已超过原生可见窗口），两平台均验证复制包含完整末尾；原生 Create 总数 <2000，长文件相对短文件 Create 增量 ≤12、初始 mount items 增量 ≤64；完整复制后 50 次实际输入不新增任何 Create，且 mount items 数不随文件行数增长。Input 的 native 自更新可能没有 mount batch，因此同时复验最终输入值，不拿“零事件”冒充性能通过。这是合成 native 操作数预算，不是实际 OS 的帧率、耗时或内存测量。

真实系统绘制、双层滚轮/触控板体验、任意长 hunk 精确行滚动、异步回收前的完整 selection/hunk 保留和长时缓存内存仍需验收；没有用纯测试或 trace 代替这些项目。生产 panel 接线已有独立合成 consumer 测试，不等于完整桌面 1:1 签收。

独立 list 阶段最终 focused 验证 **10 文件 / 58 项通过**（包含既有 document/native/full-context/reader/actions 回归；list native runner 内另含两平台共 12 场景，性能 runner 对两平台分别运行短/长两组）。独立临时 tsconfig 校验本切片及递归依赖通过。该阶段全包 tsc / `nsh:check` 早先通过，最终重跑被并行的 `desktop-chat-writer-fixture.tsx` 给 Input 传不存在的 `enabled` prop 阻断；未修改该外部文件。`dead-code` 仍被既有 `vite-plugin-pwa` 缺失阻断，未新增项目依赖或修改 lockfile。

### 生产 adapter 补充证据

`desktop-diff-production-adapter-native.test.ts` 使用独立临时 manifest/入口，实际挂载 `NativeDesktopPanel` → `NativeDesktopChanges` → list/document，而不是以独立 list fixture 代替产品入口。两平台模型各 7 场景覆盖：source.path 仍发现完整原序 catalog、同 reader/Host lease 的 Working/Staged 正文与失效隔离、逐文件原偏好投影、同 M/M 刷新正文、status/patch 失败保 prior、单行 GET 重试、50 次实际输入和 resize 零额外 GET、supplied catalog 优先、runtime invalidate、隐藏 10 秒跨 polling 周期零请求、modal/background/authority/source 迟到拒绝、真实 file-diff 单文件分支与 thin exact turn 不读 Git。

既有文档/全文 fixture 只按真实结构变化改成统一 toolbar 的控件定位；standalone 侧栏改验 Web 的同 stack 定位及原 preview 回调，而不是要求旧 onOpenDiff 造 tab。旧偏好集成 fixture 补普通 Diff 所需的 authoritative status catalog，不放宽正文、原生节点数、权限或输入 operation-count 断言。没有修改 application、state、Chat writer、移动 Changes、Host 或 `desktop-diff-list-core.ts`。

本次生产接线最终 focused 验证 **14 文件 / 75 项通过**：上述 10 文件，加 production-adapter、Diff preferences、desktop-panel、desktop-panel-chat-workbench native 回归。随后再次单独运行 production-adapter 通过（wrapper 1 项，内部两平台合计 14 场景）。全包 `tsc --noEmit --project packages/nsh/tsconfig.json` 及包含新 Adapter.tsx 的独立临时 tsconfig 均通过。`dead-code` 重跑仍因缺少 `vite-plugin-pwa` 退出 2，没有补依赖；本次未运行真实 AppKit/Win32、Host/Git/model/网络或发布构建，也未重跑 `nsh:check`。真实视觉、滚轮、缓存内存及本节列明的其余缺项仍未签收。

## 上游 parent viewport 垂直 slice（补丁已交付，产品仍未签收）

本节追加上游能力证据，不改写以上生产现状和未签收账本。交付物为 `patches/nsh-0.4.0/diff-parent-viewport.patch`，基线按本轮指定的 `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`；只读上游的必要源码完整复制到 ignored `.nsh/compat-diff-work/source` 后开发。没有修改外部 checkout、application、任何 `desktop-diff*.ts*`、构建脚本、产品 manifest 或仓库 Cargo.lock，也没有接真实 Host、下载工具链或新增项目依赖。

### 实现合同

- 正式公开 `DiffView.viewport?: DiffViewport`，生成的 `DiffViewport = "own" | "parent"`；默认 `own`，挂载时固定。声明和 JS prop decoder 均来自 Rust `Props` / `PropEnum`，没有手写 Yuri `.d.ts`。
- 逐行改成 List 会拆散现有 gutter / 横向 text pane 共用的连续坐标面，迫使 separator、hunk action、annotation 和选区重做坐标所有权。因此保留 Diff 原 `Geometry` / `RowWindow` / split 横向同步和 overlay，而不是另造逐行渲染器。新增真实 Rust fixture 已证明：**Diff 可以作为现有 List 的自然高度 cell，由该 List 唯一拥有纵向滚动**。
- core 抽出 `find_outer_axis` / `viewport_input`，原 parent List 继续使用同一实现；Rust `watch_parent_viewport` 在现有 commit watch 机制内提供有符号 local offset、真实祖先 viewport 与可达范围。`ElementRef.scroll_parent_to` 通过 core 的既有 `ask_outer`、pending replay 和命令汇总路由到 Scroll / own List，根边界不越过。没有第二套 ancestor 算法、平台协议或 TS 每帧 offset 同步。
- `parent` 的自然高度直接来自 Rust 行几何，纵向 native Scroll 被普通 content View 替代；可见范围来自祖先，仍由原 RowWindow 有界构造。`goToHunk`、`scrollToFile`、`setScrollOffset` 和 gutter 拖选 autoscroll 共用真实祖先；文件定位采用含 wrap / annotation 的几何，不以行高乘行号估计。末尾目标服从真实祖先上限，不添假底部空间。
- `own` 保留原内部 Scroll、视口下限、导航和 iOS 默认路径，不安装 parent watch。split / unified、inline spans、soft wrap、separator、完整 source、selection / selectedText、annotation 和横向 Scroll 保留原 owner；本补丁不包含文件写入或 hunk mutation 接线。

### 已运行验证与边界

在 ignored 验证副本使用本机现有 Rust stable、缓存 normalized crate manifests 和 `cargo --offline`；上游 workspace 离线解析缺 `oxc`，没有联网补装或修改 workspace 清单绕过。仅隔离验证副本的临时 lock 解析到现有缓存版本；待补丁 core/base 源码逐字节相同，缓存 `nsh-macros` 源码亦与只读基线相同。

- `nsh-core --lib --no-default-features`：**985 passed / 0 failed / 9 既有 ignored**。
- `nsh-base --lib --no-default-features`：**913 passed / 0 failed / 1 既有 ignored**；随后含新增绝对 Create 上限断言的最终默认 highlight 构建运行 `nsh-base --lib`：**925 passed / 0 failed / 3 既有 ignored**。
- 新增 **8 个 Rust tests 全部实际执行、无 ignored**：core 的 pending 旧回执、重挂祖先、释放撤销、横向祖先跳过与 root 边界；Diff 的公开生成类型、真实 List cell、Mac/Windows 模型下 split/unified 的 400 vs 12,000 行、完整末尾选区复制、祖先 offset→实际行 range、resize/wrap、separator 展开、文件折叠、目标 hunk、annotation 几何、横向 follower 和 selection 保留；另含 Windows gutter autoscroll step 的真实祖先命令与 iOS own 隔离。
- 节点预算没有调低：初始 native Create **<2000**、live nodes **<2000**，12,000 相对 400 行的 Create 增量 **≤12**、mount items 增量 **≤64**；末尾滚动后 live nodes 仍 **<2000**。完整 `selectedText()` 校验包含最后一行，不拿可见行拼接冒充完整复制。
- 默认 highlight 的 `cargo check --offline --locked` 通过。补丁在第二份干净副本执行 `patch --batch -F 0 -p 1`，16 个目标文件 apply 后逐字节、SHA-256 全部与已验证源码一致。

本切片未启动 AppKit/Win32、真实剪贴板或持续物理拖选，未测 OS 帧率/内存，也未构建 patched CLI/devhost 或运行 Yuri consumer。上游能力不再只有 blocked 结论，但仍需 prepworker 把此补丁登记到统一 source digest，以同一 patched CLI/platform devhost 接入 Yuri List、移除原固定双滚 box，再执行产品既有 400/12,000 与输入 operation-count 回归；本节不提前签收这些工作，也不取消其它 Web 1:1 欠项。

### 确定补丁及 preimage / postimage

统一 strict preparation 登记后的最终补丁 **55,949 bytes**；SHA-256：`202591f994247fc2eb5ab5c560a0c31a2ccaa3998ea8ce1d9aa0e9c1f480e258`，以 `patches/nsh-0.4.0/manifest.json` 当前记录为准。最终文件只移除 `diff --git` 前导，16 个源码文件的 before/after 均未变；ignored `.nsh/compat-diff-work/final/hashes.json` 的源码证据仍适用，但其中原交付 envelope 的 patch 摘要不是当前文件摘要。下表路径均相对 NSH source 根；新增文件的 before 为空字节 SHA，`beforeExists:false`，不是覆盖同名文件的许可。

| 文件 | before SHA-256 | after SHA-256 |
| --- | --- | --- |
| `crates/nsh-base/src/diff/controller.rs` | `eb807451b5bc17a92fa91319eb6dd17fd95c885bd0b2a1597dc2d16459687a97` | `8c3d02547cae823babda1d1de473fad032f88b0830940e67e41b39b0c8d0386c` |
| `crates/nsh-base/src/diff/mod.rs` | `6d81a96cfc22ff5d7d9cfc969d717134c27b6a239b93e581b5db8ca1d9630349` | `c43bdffe19ced2b7303346a1ac5166a2b721bf95cb5e95a29692f1aadcf41d3d` |
| `crates/nsh-base/src/diff/parent_tests.rs`（新增） | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | `e91c4fc5bcf89d51e21b35ef51d99dc0b801cdc874f95f188c5e869dcf50fce5` |
| `crates/nsh-base/src/diff/review.rs` | `e7ccfdfa168f13539fbf6703d26b4c3aa711abf7f8bd98a4adf5835b53418af4` | `49365d3cd8720c60e106cf133c60440fc3f42402aeed2b89665fdcf85e168225` |
| `crates/nsh-base/src/diff/view.rs` | `2da19fd75999f8c90903a85f51d9fa071c2f1b65e280860a05f2290ff554ad3b` | `a0825a69fe0cf7dbbd0d01877e79d237682a729446bea2484bdd6d59edf62671` |
| `crates/nsh-base/src/lib.rs` | `7cdcf7dfc8b5be4dd1c992911c59bba3d83fda4d76b318aa970d0e01efc8bc2a` | `aa07132ef47a39f8e66bd22c5801de08137acf333dda83abacd66b03df4548f8` |
| `crates/nsh-core/src/core/components.rs` | `e3f5bb1053940efab843d8d5e0b5169907dec2d9f7d82612d65dac6cc456080e` | `397d26e778061aa530da4acce90034dd016513b80e150fe0958abbae74c47374` |
| `crates/nsh-core/src/core/mod.rs` | `b28c31c11f803ea27c1e4355100f10efcb248c7881ac46536f704449097f28a0` | `3e0b302d162073982eda271ef51a0a295e95b00f14c68067839e96105ecfac64` |
| `crates/nsh-core/src/core/parent_viewport.rs` | `968cefd5117ef42b61c12e76920ad20ee52c58682a548e102381f4041c3b6dbc` | `79bb2f95f67e788305dfe60459b1675a8ff7ac0ddabe86f03b62ec79267527c6` |
| `crates/nsh-core/src/core/tests.rs` | `aecf927aa3e544c2766cdddea35dd16ade992b2e845ecb4a0cacd2669f8b6359` | `196f4e3b7add4de8af4ad50c1544bcec228aff384b63410d2acfbc6c77d5c08b` |
| `crates/nsh-core/src/core/watch.rs` | `55ee26c70da4083e119cdf8299bdae930facf16e8334c2db82e571cfe2e7379d` | `602a9df323f762cb68720378a983c1545dac8928768734b616d2d3bca01da5b3` |
| `crates/nsh-core/src/element/ambient.rs` | `bf11e6356c59804db89f027618b74f325b13a0ce09b51637b06f78f1c6b56e2d` | `7938ff20c8ae618e81052e78a18726181a356e81fa155684ef11b510b2c1a991` |
| `crates/nsh-core/src/element/element_ref.rs` | `525887176fc058b7106220aaa70c82841ee79b6ff1a4c98422a020c95d747b0e` | `777b8f872d5f7d50d549113b920a9ccfc2d73827153da3e0202abce768ed3aec` |
| `crates/nsh-core/src/element/mod.rs` | `ef589bb141062985995677d140fac2776a03f734df825104e25dda3e35c13e37` | `ec7971018b2f9efa7dfa6e89f6cecc2d41ee6cae9dbae9d3c28abb8c203743f4` |
| `crates/nsh-core/src/element/task.rs` | `0a8bd5a053b96a858d23314527cdc50b669119ea4468ccf0c075306af655c63b` | `a109b671624aeaaad062518f8cfad94a2c5fd94b59bd7ac21fe9bdc1486389a8` |
| `crates/nsh-core/src/element/watch.rs` | `ba2633101b17d6244b0cd7f58190dd91901475c68bde4bedc48e6031882ffe46` | `ffc7369082746a5e073c35aa64942e7ebd8beb1f64d5abdcf9799edb35453931` |

## Yuri parent viewport consumer（接线已写，patched runtime 待验）

本节接续上节，不覆盖之前各阶段的历史证据。上文 180–720pt box / 双滚动描述是 consumer 接线前的现状，不再是当前 TS 实现；也不能因此将新实现记作原生已签收。

### 滚动、布局与 demand

- `NativeDesktopDiffList` 的普通多文件分支向 `DesktopDiffDocument` 传生成声明中的 `viewport="parent"`；document 和原生 DiffView 使用 `flex-none`，不再以 75% 视口或 180–720pt 的 TS box 限高，也不从 `onScroll.contentSize` 反推正文高度。完整 source 继续交给 Rust 自然行几何与 RowWindow；真实 stack List 是唯一纵向滚动 owner。横向 split 同步、overlay、separator 和拖选继续归原生 DiffView。
- 尚无正文的展开文件（含唯一 reader 的等待队列）只显示文件 header 和一行至少 32pt 的 loading 文字占位，不猜最终正文高度；刷新已有正文时不额外插 loading 行。没有添加假底部 padding、每帧 offset 回写、逐行 TS List、正文截断或全文件预读。
- 移除 `itemVisibleThreshold:.01`，消费 NSH 0.4 的默认 **实际相交像素 > 0** 语义。对 12,000 行的单个自然高度文件，即使可见部分不足文件高度 1%，它仍是可见需求。这里使用当前生成声明和冻结源码口径；网上新版文档的 `*PercentThreshold` 命名不是此版本的 API。
- 原 `visible + expanded + active/current/lifecycle` 门禁、下一帧合并 viewability、唯一原 reader、按 source/scope/path 的缓存和失败 prior 不变。未改 list core、reader、inventory 或 transport。
- 独立单文件 `DesktopDiffDocument` 不传 viewport，仍走默认 own；原 iOS consumer 未改。list 的可选 singleFileView 分支也不启用 parent，own 的可用高度只取真实 List viewport。viewport 挂载时固定，调用方不能在同一原生实例上动态切换。

### 选区、hunk 与被动跳跃

- 核对上游实现：`setSelectedLines` 仅更新选区；parent 的 `goToHunk` 会通过真实祖先发滚动命令。因此不能把 own 的 retained hunk 恢复无条件搬到 List cell 重挂路径。
- parent 重挂仍恢复已确认且同正文/targetLine 的选区，但不重放 retained `goToHunk`。此时当前 hunk 由真实祖先 viewport 派生，而不是拿旧导航命令重新定位整个 List。无显式 targetLine 的文件也不在首次进入可见范围时自动跳首 hunk。
- List 以 source 生命周期内的 target revision 记录显式定位是否已消费，避免异步 retained receipt 尚未返回就回收时重复定位。新的 target 请求重新准入；own 原有首变化/retained hunk 路径保持。
- 普通 patch 刷新只映射并恢复选区，不在 parent 中强制回到当前 hunk 的首行；显式全文/patch 模式转换仍沿用源行映射和公开 hunk 锚定。不承诺同 hunk 内像素锚点或任意 targetLine 的精确视口落点。
- 模式转换的 pending selection / 源行 hunk anchor 留在 document，不因一次 viewability 丢失丢弃。prop 切换后只等待一次 frame + 公开 hunks read acknowledgement，才准入选区恢复；恢复后再原生读回选区。重新变可见时可继续尚未确认的恢复。它是正文采用的有限生命周期屏障，不是每帧滚动同步，也不回写任何 offset；下述 headless shrink 失败仍保留，不能拿源级测试签收平台行为。

### 本次已验 / 待验

- 纯模型/源级准入：`desktop-diff-document-navigation.test.ts` 加既有 list core / model / reader / full-context / actions / server-contract，共 **7 文件 / 60 项通过**。新增 6 项执行真实 `DesktopDiffDocument.position`、`readHunks`、`restoreSelection` 的 AST 提取函数、隔离 native-ref seam，覆盖隐式首 hunk、retained 重挂、无 retained receipt 的一次 target 准入、own 兼容、authority 门禁及延迟恢复 selection / hunk；它不是原生几何测试。临时撤回两个导航保护后其中 **3 项失败**，恢复后重新运行。
- 当前正式 consumer 验证全部同时设置 `NSH_BIN` / `NSH_RUNTIME`，来自 strict preparation digest **`7834beffee6dc6dd588bee99f717366a37dca2282ceb53544b80734e800f97e0`**。实际复算 CLI SHA-256 为 `5fcc770349635e237df43fdfa072426af0375084dc006374bf2c376f06a81d5b`，runtime/macos host 为 `0ac82f67e63258d4438231b5baabee9f9226704c611c6a3b05594722de4a3197`，与该 digest receipt 一致。更早 `86fb08…` 仅为历史诊断，不计入本节最终结果；后续若新增第三补丁换 digest，仍须由 main 最终重跑，不能沿用这里的工具证明。
- 最终整批 **16 文件：14 passed / 2 failed；82 项 Vitest：80 passed / 2 failed**。包含本节 7 个纯测试文件，加 list native / performance / full-context native / production-adapter / actual application root / 原 native Diff / preferences native / desktop-panel native / panel-chat-workbench native。失败 wrapper 内分别是两平台各 1 场景，即共 **4 个 native 内层失败场景**，详见下节；不是 16 文件全绿。完整输出保存在本次会话临时产物 `diff-consumer-7834-all-final.log`。
- 通过的真实 consumer 场景包括：两平台 12,000 行文件从外层 List 到末尾并保留末尾 demand、刷新不回首 hunk、50 次输入零 GET、resize；240 文件真实回收后从尾部重新进入长文档，不重放旧 target。production adapter 的 **16 个内层场景全部通过**，实际 `YuriNativeApp` 根的 **10 个内层场景全部通过**，覆盖生产 adapter、真实 panel metadata 恢复、唯一 Composer、同源 reader/Host fence 和原偏好 owner。原单文件 native、移动 iOS-model patch-only、偏好与 panel 回归亦已实际运行；full-context wrapper 中其余 **7/9** 场景通过。
- 最终 budget 四组（Mac/Windows × 400/12,000 行）均为 **Create 1681、初始 mount items 6574、输入新 Create 0、copy 后 input mount items 1**；长短 Create 增量 **0**、初始 mount 增量 **0**。完整末尾复制和最终 50 字输入值均断言，GET 为零；**<2000 / ≤12 / ≤64** 原预算未放宽。性能 fixture 使用公开手动 clock 排除 caret 定时器的实时相位差；否则曾出现 input items 205/206 的单项抖动，未删除相等断言。长文件 adapter 同样用手动 clock 将输入因果与原 10 秒 inventory polling 分离，原独立 hidden/poll 场景照常保留。
- 自然高度下一个视口可真实容纳十余个短文件，因此原依赖 180–720pt box 的绝对 `<8/<10` 请求数断言不再有效。现改为逐项核对读取对应的生产 Copy 按钮确实处于 `live(key)` 准入；最终 expand-all 阶段该检查及最远文件未预读断言通过。导航后同类检查因目标正文等待失败尚未执行到，不能计绿；没有把目录全部预读来满足测试。远端导航本身的红灯仍保留。
- 最终全包 `tsc --noEmit --project packages/nsh/tsconfig.json` **通过**；另以 compiler API 复用本包原 config、所有原 `.d.ts`，只收窄 executable roots 为 list / document / list fixture，对递归依赖检查通过；10 个修改过的 TS/TSX/JS 文件 transpile 语法检查通过。生成声明更新及并行模块类型修复由 main/其它 owner 完成，本切片没有手写 `.d.ts`、改外部模块或用类型断言绕过。
- `bun run dead-code` 再次因已有 `vite-plugin-pwa` 缺失退出 2；没有添加项目依赖或修改 lock 来绕过。
- 未执行 `nsh:check` 或发布构建。main 的 strict preparation、补丁登记、构建清单和类型生成不属于本次修改范围。
- AppKit/Win32 物理窗口、连续拖选、系统剪贴板、真实 Host/Relay、帧率/内存、同状态视觉，以及自然行异步增长时的实际阅读锚点仍未验。TS 接线、源级准入测试和上节 Rust 证据不能替代这些验收。

### 保留的两个红灯（不得签收）

1. `desktop-diff-list-native.test.ts` 的 40 文件 expand-all → 侧栏跳末文件：两平台都等不到 `WORKING_file-39.ts`。自然行异步采用正文后仍会增长，原 List 的一次 index 定位最终没有维持目标落点。没有截文件、预读不可见文件、反复发 index/offset 或加永久 TS scroll writer 掩盖。
2. `desktop-diff-full-context-native.test.ts` 的全文 → 短 patch：两平台都未完成 100→1 的 native selection 确认。切换前 patch→全文已确认 1→100；字号采用、完整复制、50 输入均已执行。收起后旧 List offset 高于短内容的上限，viewability 变空。NSH headless `MountItem::ScrollContent` 原来只记录新尺寸，不像真实平台把超出的 offset 夹回并回报 core。

### 候选滚动合同（已编译，未登记，不签收）

两处原因都对应 NSH 0.4.0 的滚动 owner，不是 Yuri 再加一个 scroll writer能修的。候选修改只在独立临时源码树编译，没有改外部 checkout，也没有改已发布 digest `9b0dad8e…c9f6c3f` 的 source。两个文件的已发布副本哈希仍为 `e3c3d9a9…c7074c` 和 `0636bf5c…a5c9`。

- `list.rs`：非动画 `scrollToIndex` 在视口内行已量完后，还要确认请求的对齐位置已经落在当前滚动范围内，并且目标行已有真实尺寸。被短内容夹住、只是擦到视口边缘，不算到达；后面正文变高时继续跟随同一个 pin。`scrollToEnd` 仍在视口量完后结束。用户离开和 splice 仍然立即结束 pin。
- `screen.rs`：headless 收到更短的 `ScrollContent` 时，按真实平台把超出的 offset 夹到新上限，并通过原 `scrolled` 通道回报。内容变长或没有超出时不回报。`ScrollBy` 仍不夹，core 自己知道要保持的锚点。

独立树用原完整锁 `--offline --locked`、关掉 incremental 编译：

- `nsh-core` 过滤 `pin`：**18/18**，含新增的夹住后继续跟随、短末行仍保持 pin，以及原有的落地/离开/splice/parent 移动回归。
- `nsh-testing` 过滤 `shrinking_content_clamps_the_offset_and_reports_it`：**1/1**。4000 的 offset 在内容收到 500、视口 400 后夹到 100 并回报；再变长到 800 不改 offset、不回报。

严格 unified applier 能把候选补丁零 fuzz 套回已发布两文件，套用结果与编译树逐字节一致。补丁 SHA-256 为 `b1383f6332d20836d18a52aab7ea25d8d8b93d2a1a58f48e57ee9da907bbdc33`，after 分别为 `1951fc13…9cd2d3`、`7f4f7723…a24877`。它还在临时目录，没有写入 `patches/nsh-0.4.0/manifest.json`，没有新 digest，也没有新的 paired CLI/runtime。

所以上面两个 Yuri consumer 红灯仍然开着。要关闭它们，必须先由 preparation owner 审核并按 Shift→Diff→List→DevFrame→ListContract 之后登记，再用新 digest 的同源 CLI/runtime 重跑 40 文件导航和全文收起。本次 Rust 单元结果不能替代这两个真实 NSH consumer、AppKit/Win32 或像素对帧。
