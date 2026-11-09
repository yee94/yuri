# 原生嵌入会话 transcript

## 当前交付边界

`desktop-panel-chat.tsx` 提供真正的原生容器，不使用 iframe，也不挂主 Chat/Composer。它复用 `createChat` 的读模型、`createNativeHistoryRows`、`NativeTranscriptBody`、turn presentation、Activity exact-fill 和 history-focus。`NativeDesktopPanel` 已实际承载 chat 和固定历史 file-diff tab；model/metadata codec 定义真实准入，不止交付独立组件。application/ResourceCard 入口及 native Host 仍由各自 owner 装配，不以本 fixture 代替其集成验收。

**独立实时源必须显式注入真实能力**：desktop Host 的命名空间现由 `desktop-host/src/runtime_stream.rs` 定义，带有独立能力声明和四流容量；此切片未运行该 native actor/桥端到端验证。iOS 不因 desktop 接线获得新能力。`/api/yuri/events` 不是普通会话的正文流，不能以第二个 `chat` 覆盖主流，也不能把合成 Host 接受独立 key 当作真实能力。没有可复用主源且没有注入真实支持的 `stream` 端口时，只读 GET/分页保持可用、显式显示实时不可用，绝不请求未支持的 key。

application 现已调用 `loadDesktopPanelChatNativeStream(native)` 并消费严格核验后的端口。实际主根覆盖 supported/capacity、foreign-key 隔离、独立实时正文、模态保流、关 child 只停 child；单独的原生 reader fixture 覆盖 late-port 注入保留同一挂载与搜索。discovery 纯测试验证迟到返回前零 speculative stream。未结算 fake Host capability Promise 会阻塞 NSH 测试 Host 的串行启动，因此不把该 fixture 死锁当作生产 stream 失败，也不声称它证明真实异步 Host 调度。最新相关三文件回归通过，主根当时内部为 Mac/Windows 合计 42 场景；后续 BTW 根已扩到 44 场景。以上为 synthetic Host 的真实 NSH headless 引擎，不等于 AppKit/Win32、生产 SSE 或断网恢复签收。

## Web 依据

- `ContextPanelSessionTranscript.tsx` 明确使用 `STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES`，不使用可写 `ChatContainer` 的默认能力。
- `SessionSurfaceContext.tsx` 允许 nested navigation，禁用 compose、mutateSession、answerRequests、openTimeline、textSelectionActions 和 forkSession。原生保留复制、系统正文选择/code-copy、工具/思考展开、文件/历史 diff 和本 surface 内子会话导航；不构造可写 `NativeMessageActions`/history owner、Goal、队列或权限 UI。
- `ChatContainer.readOnly` 的 prompt 可用性不是面板的授权边界。面板没有 `readOnly=false` 分支；不能为了获得 composer 而给 display consumer 传 `false`。`createChat` 默认仍为主 Chat/iOS writer，`displayConsumer` 必须显式配合 `readOnly:true`。
- Web 面板只在明确 older 操作时读历史；原生保留按钮，不因布局、请求完成或 List footer 出现自动继续分页。搜索为用户明确操作，通过同一 opaque history lane 串行读取历史后查正文/思考，不把全局 content-search 的前 30 条伪装为完整会话搜索。
- 已确认 child 的只读提示和 execution metadata 复用 Web `resolveContextPanelSessionExecution`，本页 latch 不因轻量 metadata 临时遗漏 parentID 而消失。历史模型名称使用现有 native formatter，不借主 composer 当前模型补历史身份。

## main 接线 API

### 真实工作台入口

```ts
tabs.open(parentScope, {
  kind: 'chat', target: { sessionID, directory, title, messageID },
});
```

`parentScope` 始终是调用工作台的真实 Host/authority/session/directory，不能由目标反推。target 的 directory 必须为显式绝对路径，经 `resourcePath` 规范化；sessionID/directory 必填，title/messageID 可选。空白、控制字符、超长字段、assistant 形状和额外字段都拒绝。identity 为 `JSON.stringify(['chat', directory, sessionID])`，不含 title/messageID；更新 title 或定位只替换原 tab metadata，不新造 tab/surface。定位更新通过公开 handle 的验证后私有 navigate 完成，不操作产品 NavStack。

```tsx
<NativeDesktopPanel
  scope={parentScope}
  tabs={tabs}
  current={realRouteAndHostCurrent}
  active={layout.panelOpen}
  modalOpen={desktopInteractionBlocked() || gitDialogOpen}
  panelChat={{
    enabled: true,
    renderCard,
    stream: verifiedDesktopStream,
    onOpenFile: input => {
      if (!input.current()) return;
       const id = tabs.openFileReference(input.scope,
         { directory: input.target.directory, sessionID: input.target.id }, input.path, input.targetLine);
       if (id) tabs.setRail(input.scope, null);
    },
    onOpenDiff: input => {
      if (!input.current() || !input.source.path) return;
      tabs.open(input.scope, {
        kind: 'file-diff', source: { ...input.source, path: input.source.path },
      });
    },
    onOwner: (context, owner) => {
      // 按 context.scope + context.tabID 保存/撤销，不能全局单变量覆盖。
    },
  }}
/>
```

`panelChat.enabled` 是明确准入，不能从 renderCard 的存在性推断。窄端口的精确字段：

```ts
type NativeDesktopPanelChatContext = Readonly<{
  scope: DesktopPanelScope; tabID: string; current: () => boolean;
}>;
type NativeDesktopPanelChatPort = {
  enabled: boolean;
  renderCard: DesktopPanelChatProps['renderCard'];
  stream?: DesktopPanelChatProps['stream'];
  onOpenFile(input: NativeDesktopPanelChatContext & {
    path: string; target: ChatTarget; targetLine?: number;
  }): void;
  onOpenDiff(input: NativeDesktopPanelChatContext & {
    source: Extract<ChangesSource, { kind: 'turn' }>;
  }): void;
  onOwner?(context: NativeDesktopPanelChatContext, owner: DesktopPanelChatHandle | null): void;
};
```

文件回调只发布 session target；历史回调复制完整 `directory/sessionID/messageID/path/files`。main 在实际执行异步动作时仍须检查 `current()` 和 captured Host，不得 catch 后改开主 Chat。文件引用现在沿下面的 own-source 工作台入口打开，不替换主 Chat；未带 source 的旧 `file` intent 仍受 parent workspace containment 限制。

### 文件引用的 own-source 工作台合同

```ts
// 只在 exact 来源仍为 current 时调用；source 不能直接透传 ChatTarget 的其它字段。
const id = tabs.openFileReference(parentScope, { directory, sessionID }, path, targetLine);
if (id) tabs.setRail(parentScope, null); // Web closeFileTree:true，仅正文/引用入口收 rail
// 纯入口：createSourceFileIntent(parentScope, {directory, sessionID}, path, targetLine)
// 内容 scope：desktopPanelFileScope(parentScope, fileOrPreviewTab)
```

- `openFileReference` 返回真实 tab ID，失败返回 `''` 并保留原 tabs。它自身不导航、不收 rail；文件树继续 `tabs.open(parentScope,{kind:'file',path})` 并保留 rail。
- `file` 和 HTML `preview` 仅新增 optional `source:{directory,sessionID}`。source 严格两个字段、绝对 directory、非空 session；额外 Host/authority/lease/任意 scope 字段拒绝。路径只在显式 source 内解析，不从 path 猜目录，也不放宽旧 parent file/diff containment。
- parent scope 继续拥有 tab、选择、rail 与 navigation metadata。editor stat/read/write、非文本 `ResourcePreview` 和 HTML browser 则派生 own scope；Host、authority、lease 原样继承 parent。文档相对链接继续 own directory/source 打开另一个工作台 tab，不回落 parent。只读 transcript 不意味着产品文件编辑器也只读；文件权限继续由真实 Host 的 fs 路由/realpath 校验，不借 Chat writer、猜 canon attach 或增加 session transport。冷 metadata 不是 session receipt，也不被当作该 receipt 使用。
- identity 为 kind + own directory/session/path；targetLine 原位更新，不重建 doc。source 与 parent 完全相同会规范化为旧无 source 形状，继续使用旧 path ID，避免同一个文档双 tab。HTML 转换保留 source，既有不支持 HTML 源行定位的限制不变。
- v1 metadata codec 兼容旧无 source 记录，仅白名单保存新 source，禁止正文、receipt、lease 和 credentials。editor journal 仍是原 v1 own-scope 文档记录，不迁移、不重放 unknown。默认 editor storage 现在只用 `createDesktopFileJournalStorage(native)`；native 不可用时 fail closed，不再落到 NSH 明文 Storage。显式注入 storage/false 只供调用方/合成 fixture 使用。
- dirty 点、单 tab close、window close、冷恢复/孤儿恢复入口都查 own document。parent 20-scope LRU 会 pin 含 dirty/unknown own 文件的 tab；底层文档仍遵守原 20 documents/字节容量，拒绝容量不足而不删稿。同 Host/authority 的同绝对路径 writer 与文件 mutation 锁不按 directory 别名分裂；Host/authority 退休后旧文档仍可复制，不能借新身份写入。
- `panelChat.onOpenLink` 的原透传保持不变。此切片没有修改 application、state、Host、SSH 或 `desktop-panel-changes.tsx`；主根接入与 AppKit/Win32 实机仍由 main 另验，不以合成工作台结果冒充完整 PC parity。

own-source 切片验证：固定 NSH **0.4.0 (e626a8d)**，只读本地同版本源码的 Editor/测试 Dialog 合同。新增 `desktop-panel-file-source-native.test.ts` 在独立临时 config 中驱动生产 `NativeDesktopPanel` / Editor / ResourcePreview / 默认 native journal adapter，共 **9 场景**，覆盖 Mac/Windows 平台分支、50 次 locator 复用、引用收 rail/文件树保 rail、真实 Markdown 相对链接、dirty 点、单 tab/窗口取消、discard、close-save、无 metadata 的孤儿恢复、冷 dirty/unknown、401/404/旧正文零 POST 重放、modal/Host 撤权与 native journal 失败零明文降级。journal Host 仅为合成的私有 snapshot/CAS/sync backend，不把它冒充 Rust 磁盘或真实 fsync 验收。

本次相关纯回归 **12 文件 / 132 项**通过；既有 panel、file-journal、embedded-workbench、tabs 加新增 source 的 NSH wrapper 回归 **5 文件 / 21 项**通过。`bunx tsc --noEmit -p packages/nsh/desktop-panel.tsconfig.json` 通过。标准 `bun run dead-code` 仍因既有 Web Vite 缺 `vite-plugin-pwa` 无法产生报告；没有加依赖。没有执行真实 Host 文件写入、系统窗口/物理键盘或完整 PC 视觉验收。

### active 与 interactive

根传 `active={panelOpen}`，不得合入 Settings/Search/Help/closing 的交互遮挡。`modalOpen` 只传 shell 外部遮挡，**不传 `tabs.modalOpen()`**：

- chat 的读取 demand 为实际 Host/route + panelOpen + filesReady + 前台 + 选中 tab/preview；modal 只撤销 interactive，不重建 reader/stream。
- header、rail 动作、context、browser、file editor 和 diff 另受外部 modal 门禁。editor 的 bound operation.current 同步撤销外部模态下的程序 save，而非只隐藏按钮。
- 内部 file form/dirty confirmation 的原 owner 保留业务 authority，不能因自己的 modalCount 反锁 submit/save/close；底层 header/editor/chat/browser 交互仍关闭。
- 真隐藏/后台停止 chat 读取并保留私有页、query 和 List；关闭 tab 才释放 reader/stream，不调用主 Chat 或 PTY stop。

### 精确目标的固定历史 tab

新增 `{kind:'file-diff', source: turnSource & {path:string}}`，仅接纳显式 target directory/sessionID/messageID、非空 files 与选中的 path；每项必须有非空 patch、完整 before/after（包括显式空字符串）或 binary snapshot。路径在 source.directory 内规范化、拒绝重复/逃逸；snapshot 被复制，不保留调用方 closure。`NativeDesktopChanges` 直接消费该 source，读取身份仍使用 parent scope.host，不借用 parent session/directory。

identity 包含 source directory/session/message/path/revision；同快照复用，targetLine 原位更新，异快照另开 tab。旧 workspace/diff/file 的 scope 校验不变。同目录 child session 的历史也必须用该新分支，不能冒充 parent 历史。文件预览回调从固定 source 报告 directory/session/path/targetLine。

v1 metadata 仍只保存 chat 的 target 白名单。历史 diff/file-diff snapshot **仅同进程保留**；没有 durable historical resolver 时，不写入 patch/before/after，也不恢复缺失正文的假 tab，不改读 current Git。这一冷恢复缺口仍未闭合。恶意持久化的 file-diff 分支被 codec 拒绝，既有 version 1、容量/LRU、失败回滚与 late-cold/live 优先级保持不变。

### 独立容器 API

```tsx
import { DesktopPanelChat } from './desktop-panel-chat';

<DesktopPanelChat
  surfaceID={tab.id}
  target={{ sessionID, directory, title, messageID }}
  authority={{ hostID, authorityKey }}
  active={selectedTab && windowForeground}
  interactive={!coveredByModal && !closingWindow}
  stream={supportedIndependentStream}
  renderCard={(card, surface) => /* 原生只读卡片：使用 surface.current/navigate/target */}
  onOpenFile={(path, target) => /* captured target.directory 的资源预览 */}
  onOpenDiff={(file, target, messageID, files) => /* 完整历史 snapshot，不查询当前 Git */}
  onOwner={owner => /* 保存/撤销本 surface 的公开 handle */}
/>
```

`authorityKey` 必须由真实连接的 `desktopGitDraftAuthority(connection)` 提供；`hostID` 来自实际 adopted Host。不可用 tab metadata 猜 Host、授权或目录。target 的 session/directory 与 authority 改变会创建新的 keyed surface；lease 改变不改变稳定 surface 身份。调用方应保留隐藏的 surface JSX，不以 `active=false` 代替销毁；实际 close 才卸载。

`DesktopPanelChatHandle`：

```ts
{
  navigate(target: DesktopPanelChatTarget): Promise<boolean>;
  back(): boolean;
  focus(messageID: string): Promise<NativeHistoryFocusState | false>;
  search(query: string): Promise<readonly string[]>;
  retry(): Promise<void>;
  loadOlder(): Promise<void>;
  latest(): boolean;
  copy(messageID: string): Promise<boolean>;
}
```

所有 handle 动作都检查当前 foreground/interactive authority。navigate 先以 captured operation GET 验证真实 session ID 和 directory，再 push 此 surface 私有 NavStack；不打开主 Chat。Back 保留父页 List、query、阅读位置和 Activity 选择。`renderCard` 只拿只读 surface 能力；实现方必须使用这些 fenced 回调，不另取全局 writer 或产品 nav。文件/diff callback 已在容器准入，但 root 仍须在真正执行其异步动作时检查自身 operation。

### 独立 stream 端口

`DesktopPanelChatStream` 位于 `desktop-panel-chat-source.ts`：

```ts
type DesktopPanelChatStream = {
  start(input: { path: string; key: string; expectedHost: RuntimeScope }): Promise<unknown>;
  stop(input: { key: string; expectedHost: RuntimeScope }): Promise<unknown>;
};
```

事件通过既有 `host.on('runtime.event')` / `runtime.disconnected` 发布，必须保留捕获的消费者 key 与原始 SSE data。start 只允许所给 `/api/event?directory=…` 与真实 captured scope；不得另建全局 controller。key 为有界 `panel-chat:<owner>:<activation>`，每次 activation 独立，迟到 start completion 只能释放自己的旧 key。stop 必须按 key **和 lease** 精确匹配，不能停止当前主 `chat` 或 PTY。main 仅在 desktop Host 的真实能力成立后注入 native adapter；省略端口时必须保持 unsupported，不因存在 JSX 而默认注入。

## 所有权与生命周期

- `createChat({readOnly:true,…})` 不加入 `chatOwners`，不调用 `openDraft`，不接管 durable CAS lane，不恢复/清除/重播 pending send，不观察 Goal。草稿相关公开信号为不可写空读面。
- core 在 draft/context/reference/CAS、command/send/retry/stop、inbox/恢复、permission/form、Goal/history gate 等入口拒绝 mutation；operation request 另拒绝非 GET 与 GET body。不能只靠 UI 隐藏。
- `desktop-panel-chat-source.ts` registry 仅登记真实主 Chat 的精确 Host + origin/authorization + lease + session + directory 读端口，不含 draft/composer/selection。匹配且主源同步时复用它的 snapshot、stream delta、opaque cursor、分页 flight 和 Activity materializer。草稿更新不会成为 display dependency。
- 主读源隐藏后，display 转交自己的读 lane；主源回来则撤销自己的独立流，只读其 snapshot。不更改主源 active/syncActive 或 writer authority。registry 登记随真实 owner cleanup，lease 重建时更新。
- `active=false` 停止 display 读取和动作，保留已收 snapshot；临时 `interactive=false` 仅撤销交互，读取沿现有 syncActive 保活，不重开源。后台释放读取/流并 fence 迟到结果。相同稳定身份的新 operation lane 可恢复；origin/authorization/Host 改变永久退役原 surface。
- 外层 keyed native List row 是唯一滚动 owner；inverted + `onLoadMoreAtStart` 采用 NSH 本身的阅读锚点，不写补偿 offset。message jump 只走原 history-focus 的一次 scrollToIndex。实体/Host 变化、隐藏、覆盖与 cleanup 取消待定位。真正的 operation generation 更换只重挂 body 的 captured tool GET，不重建外层 List row 或伪造阅读坐标。
- panel 按 List 的有效 onLayout 宽度减去 24pt 横向内距、再限制到 780pt，传给 body 的可选 `contentWidth`；隐藏的零尺寸事件不覆盖已测量内容宽度。用户 bubble 和 Activity 头像区只按所属 surface 计算上限，不依赖全局 windowSize。NSH headless 在后台恢复后可能报告零 windowSize，不能因此把已有正文压到零宽。主 Chat/iOS 不传此参数，默认行为不变。tab 仍使用普通 display:none；没有透明叠层、强制重挂或第二滚动 writer。
- 历史/分页失败保 prior，显式重试；missing/hidden/error 分开，不跳最新冒充找到。完整空结果与失败分开呈现。独立 tab close 仅释放自己的 owner/source/stream，不调用主 Chat/PTY stop。

## 主 Composer 的真实 durable CAS

这两个端口与面板无派发关系，由 main 的本地命令 registry 在已校验 ReferenceScope/page-operation 的动作内调用：

```ts
chat.composerRevision(): number; // 直接 durable.revision，无平行 effect 计数
chat.compareAndSetDraftText(expectedRevision: number, text: string): boolean;
```

CAS 同步检查 readOnly=false、active、实际 current/foreground operation lane 与完整 durable revision。成功仅调用既有 `durable.setDraftText`，让引用按原编辑逻辑重定位；不清 attachments/queue/pending，不发送命令。revision 覆盖 text/references/attachments/context/queue/pending 等真实 durable 更新，拒绝文本或资源 ABA。display reader 的 composerRevision 为自己的空只读面 revision 0，不订阅或暴露主 composer revision。失败返回 false，调用方不能改用文本相等或直接 `.draft.set` 绕过 CAS。

## 验证边界

- 本轮核心回归：`desktop-panel-chat-integration`、`desktop-panel-historical-target`、model、tabs persistence、chat state、editor model/owner、journal/storage/operation journal、tabs renderer/core，共 **12 文件 / 135 项通过**。
- 本轮 NSH 0.4 headless：`desktop-panel-chat-workbench-native`、`desktop-panel-chat-native`、`transcript-body-native`、`desktop-panel-native`、`desktop-files-journal-native`，共 **5 文件 / 27 项 Vitest 通过**。其中工作台 wrapper 内 **15 场景**、独立容器 wrapper 内 **12 场景**；wrapper 不应当成只有一个浅 smoke。覆盖 parent-scope 的真实 chat/file-diff tab、v1 恢复、title/locator 原位更新、own-directory snapshot/文件预览、嵌套 Back、隐藏/后台保留 query/已定位历史页、关闭 reader 释放、无端口/disabled 准入、50 次 writer 编辑的零额外 embedded 请求、modal 零额外 GET/SSE/owner 重建，以及外部模态下 UI/程序 save 拒绝和内部确认保存。
- 后台空白修复前，保留 parent 的最小场景及完整跨目录场景在两平台分支共四处正文断言失败；源消息、行投影和 List 视口保持有效，trace 显示 user TextView 宽度归零。独立最小探针将原因缩至全局 windowSize 后台零值。修复后保留原正文断言，移除透明叠层试验；没有放松断言或通过跳最新换取通过。
- 当前 `bunx tsc --noEmit -p packages/nsh/tsconfig.json` 通过。`bun run dead-code` 因 Web Vite 配置缺少 `vite-plugin-pwa` 无法加载，未生成可检查的报告；没有为此安装依赖。
- `desktop-panel-tabs-renderers.ts` 的 turn file-diff 现委托 `normalizeDesktopPanelIntent(scope, {kind:'file-diff', source})`；workspace 内容请求继续原 containment/diff 规则。strip 将 file-diff 映射为 diff 图标，聚焦测试验证不放宽 parent diff 与 workspace 准入。main 已改为 panelOpen 读取 demand、外部 modal 单独撤销 interactive，并将真实历史回调改接固定 file-diff。
- main 实际 App 根在两平台验证 readonly child 复制/私有 card 导航、Help/Search/Settings 下零 child 读取增量和保留 query，以及跨目录工具 snapshot 打开原生 DiffView、复制完整 before/after、不读父 Git、不新增 writer、不将正文持久化到 tab metadata。它仍是合成 Host，不替代真实 native stream 联调。
- `desktop-panel-chat-state.test.ts` 使用真实 `createChat` 与合成 native/storage，覆盖两 owner、全部 writer 入口、独立 key cleanup、缺少 stream port、wrong directory、迟到 GET、durable CAS 资源保留/ABA/隐藏。
- `desktop-panel-chat-native.test.ts` 用真实 NSH 0.4 headless、实际原生容器及真实主 createChat，Host 仅合成。覆盖 50 次真实主草稿编辑的零 embedded 历史工作/额外目录与 stream 计划、同 target 主源复用、显式分页/focus/search/copy、私有导航与父页保留、临时覆盖/隐藏/Host 退役、背景恢复、共享/独立 source 转交、原始 stream 事件及缺少原生能力的安全失败。
- 独立 stream 正向场景注入明确支持新 key 的**合成端口**，不能作为 Rust/Swift Host 实现证据。默认无端口场景另断言绝不发送未支持 key。
- Windows headless 只是 Windows 平台分支，不是 Win32 窗口。未在这里运行真实 Host、模型、Git/权限写、AppKit/Win32 窗口、物理键盘或真实阅读锚点几何；不得据此宣称完整平台/滚动视觉或生产实时闭环验收。
