# 桌面工作台标签：独立 strip 与 metadata owner

早先标签 scope 修改 `desktop-panel-model.ts` 并新增 `desktop-panel-tabs*.ts*`；本次事件切片仅继续修改这些独立 tabs 文件，新增 `desktop-host/src/desktop_tab*.rs`、独立 example/tests/docs。没有改 `desktop-panel.tsx`、application、Host main/bridge/native_ui/host_services/Cargo、sidebar、projects、drafts 或 state；本轮 model/editor/恢复策略由 main 独占。产品入口由 main/Host owner 装配，本线程的独立验证不证明入口装配完成，也不能称为完整 PC parity。

## Web authoritative union（不是 rail）

`packages/ui/src/stores/useUIStore.ts` 的 `ContextPanelMode` 精确为：

```ts
'diff' | 'file-diff' | 'file' | 'context' | 'chat' | 'preview' | 'browser' | 'btw'
```

| mode | Web 的真实内容与输入 | 当前 NSH / main 后续内容端口 |
| --- | --- | --- |
| `diff` | `ContextPanel` → `DiffView`；`diffScope: working/staged/turn`、targetPath/line、turnMessageId、所属 diffSessionId；同次工具 patches 单独放 `contextToolDiffByDirectory` | 已有 `diff {source: ChangesSource}` 保留 workspace/staged/精确历史快照；不将历史回读为当前 Git |
| `file-diff` | 同一 `DiffView`，但 `singleFileView` 和 `preloadFullFiles` 都为 true；与 `diff` 是两个独立 tab identity | 当前 NSH 未独立表达该 mode。main 需提供真实单文件 diff 内容与选择/加载合同，不能拿一个空 tab 补齐 |
| `file` | `FilesView mode="editor-only"`，targetPath；文件导航与关闭受现有文件 owner 保护 | 已有原生 editor/journal；strip 只调用 `requestClose`，dirty 点只读 `isDirty` |
| `context` | `ContextPanelContent` | 已有 `NativeDesktopPanelProps.context(scope, active)`，由现有 context owner 提供实际内容 |
| `chat` | `ContextPanelSessionTranscript`（或 legacy iframe）；`dedupeKey: session:<id>`、readOnly、label/sessionTitleFallback；每个 surface 独立导航栈和 bounded retained views | main 需提供 exact session/directory/readOnly/title 与独立 Chat surface/nav/lifetime slot；不能冒用主 Chat 的当前会话或另造消息源 |
| `preview` | `PreviewPane rawUrl=targetPath`；`openContextPreview` 按 URL 去重 | NSH 的同名 `preview {path}` 目前仅工作区 HTML，经既有 browser/Host 资源 owner；**不是** Web 任意 URL preview 的完整覆盖 |
| `browser` | DesktopBrowserPane / IframeBrowserPane；native/direct 与 Relay 分支明确。store 的 dedupeKey 是 `desktop-browser` | owning model 按 `desktop-browser` 单 tab 更新非空 URL，空入口只选中；兼容旧 URL-key metadata。生产 panel 已接响应式转发与已验证 native 导航 URL 回写；真实 panel headless/Engine 消费证据及 application/OS 未验边界见 [browser owner 合同](./desktop-panel-browser-DOCUMENTATION.md) |
| `btw` | `BtwPanel`，scope 为实际主 sessionId+directory；关闭 clear，隐藏整个 panel cancel；没有 session 时显示真实 required 状态 | main 需提供原生 BTW owner 的内容、cancel/clear、session authority；临时内容不从历史猜测，不持久化 |

`RightSidebarTabs.tsx` / `RightSidebarToolbar` 的 `git | files | browser` 是另一套 rail。Git 在主区已有 Git 时隐藏，browser 仅有真实 selected provider 才显示；不可把它们拼入上述 8 mode。

### Web 顺序、关闭和保存/restore

- `ContextPanel.tsx` 给 `SortableTabsStrip` 传 `onSelect/onClose/onReorder`，使用 scrollable compact strip。
- `sortable-tabs-strip.tsx` PointerSensor 距离阈值为 8；store 以 active/over 索引 splice 移动，不以 ID 排序。选中项滚入可见区域；DOM auxClick 的中键关闭是真实事件，不是 MouseMove 推断。
- Web 当前 strip 没有 close others/right/all 菜单。用户目标是 1:1，不新增该 UI；此前派发中的批量关闭要求不是用户对新增功能的授权。core 保留批量关闭能力，组件只有显式提供 `closeLabels` 才构造可选菜单，生产 main 不传。
- Web `closeContextPanelTab` 当前选择剩余 tail；NSH 已有 owner 选择左邻、再右邻，本轮保留 NSH 的既有关闭合同。
- store 每目录最多 12 tabs、20 roots；session switch 快照以 `[runtimeMemoryKey,sessionId]` 隔离（40 条内存快照），包含 rail、contextPanel 与 transient tool diff；不是单靠目录共享全部会话窗口。
- Zustand `partialize` 只保存白名单 UI metadata，`contextPanelByDirectory` 去掉 `btw` 和 compact `activeView`。恢复重新 sanitize、重建 identity、补有效 activeId；工具 patches 不属于持久化数据。上述事实依据 `useUIStore.ts` 的 create/sanitize/reorder/close helpers、session switch 和 partialize，不等同原生 Storage 的 durability。

## 本轮组件与唯一状态源

```tsx
// main 后续装配示意，不是在本 scope 修改入口。
<DesktopPanelTabs
  tabs={existingWindowTabsOwner}
  scope={capturedScope}
  current={isCurrentRouteAndAuthority}
  active={visibleAndNotExternallyOccluded}
  menuOwnedKeystrokes={menu.ownedKeystrokes()}
  railActions={existingGitAndFilesRailActions}
  expanded={layout.panelExpanded}
  onToggleExpanded={toggleExistingLayout}
  onClose={hideExistingPanel}
/>
```

- `tabs` 必须是同一个 `NativeDesktopPanelTabsOwner`，不能在组件内重新 create。`reorder/subscribe/metadata/restoreMetadata` 自动由已有 native owner 的 `...tabs` 暴露。
- `closeLabels?: Record<'close' | 'others' | 'right' | 'all', string>` 仅为显式启用的 integration/test 端口；省略时不构造 `ContextMenu`，不安装右键菜单触发器，也不占用菜单模态状态。main 不传这个 prop。将来若明确启用，标签由调用方本地化；组件没有英文 fallback。本 scope 不越界修改共享语言字典，fixture 英文仅为测试断言。
- 保留旧 strip 的 `file-code/globe/eye/pie-chart/file-edit` 真实图标映射、workspace staged 提示、`filesView.unsaved.title` dirty AX；dirty 仍只读原 editor owner。稳定 testID 为 `desktop-panel-tab-${id}`、`desktop-panel-close-${id}`、`desktop-tab-dirty-${id}`；面板操作沿用 `desktop-panel-toggle-expanded`、`desktop-panel-close-panel`。
- 新 readOnly chat variant 消费 owning model 的 `kind:'chat'; target:{sessionID,directory,title?,messageID?}`。strip 使用 Web 已有 `chat-thread` 图标，标题取 target.title，缺省为既有本地化 Chat 标签，不查询/冒用主 Chat 或 assistant。identity/normalization/codec/renderer 归嵌入会话 owner；strip 不拼 identity。title/messageID 更新仍保留同一个 sessionID+directory tab，messageID 是导航请求，不是第二个 tab。
- 密度依据用户提供的真实 Web 截图：1068×832 viewport，sidebar 260、主内容 396、panel 412；tablist 为 `{x:668,y:12,w:254,h:24}`，处于 48px panel 顶栏。组件使用同一条 48px 横向 header、24px Scroll 标签区；`railActions`、expand、close 同行，超宽标签滚动而不是挤成第二行。不沿旧 panel 的 next-row label 重复设计。main 负责替换旧 strip 与重复标题，不叠加两条 toolbar；截图中的选中 App.tsx 是既有 tab，不是新造占位内容。
- model 是唯一 live tab Map。interaction 只捕获关闭目标 ID、scope/lease 和手势 lifetime；没有第二套 tabs state。close/others/right/all 都逐项 await `requestClose`；返回 `{closed,retained,interrupted}`。某项取消/异常继续下一项；Host/route/lease 退役停止后续项，不撤销已完成关闭，也不把迟到结果写到新 scope。
- 一个批量 flight 中不再打开并行关闭或修改顺序；新开 tab 不加入已捕获的批量目标。已经执行中的原 guard 仍由既有 editor owner 决定，interaction 不伪造其取消。
- `active=false`、Host/route 失效、后台、销毁时撤掉菜单/键盘/手势。`onClose` 仅隐藏面板；展开仍交给既有 layout，不创建平行 hidden/expanded 状态。自己的 dirty dialog 不应由 main 当作外部 occlusion 改写 `current`。
- 在 NSH 支持普通 View focus 的平台，Tab/Shift+Tab 使用原生 focus；点击明确请求 focus。strip 获得焦点时绑定 Left/Right/Home/End、Alt+Shift+Left/Right 调整顺序、Mod+W 关闭。失焦后释放，输入框保留编辑按键。`menuOwnedKeystrokes?: readonly string[]` 由 main 经 panel 透传 `menu.ownedKeystrokes()`；绑定前用既有 `nativeShortcutKeystroke` 规范化，排除所有同 stroke（不限 Mod+W），包含平台 mod、大小写、modifier 顺序和方向键别名。没有原生菜单的独立 fixture 仍可绑定 Mod+W；root 菜单关闭直接走同一 `tabs.requestClose`，不绕 dirty guard。
- 水平 NSH Scroll 不压缩标签；选择、布局变化时用公开 ref.measure/scrollTo 将当前项滚入可见区。滚动或布局变化撤销已捕获的拖排几何。

## NSH 0.4 API 核对与中键缺口

依据用户指定的固定 NSH checkout（只读）中的：

- `crates/nsh-js/src/dom.rs`、`declarations.rs`：公开 ViewRef measure/focus、ScrollRef scrollTo。
- `crates/nsh-core/src/element/events.rs`：PanEvent translation/cancelled；NSH 生成声明的 PressEvent、MouseEvent、TouchProps。
- `crates/nsh-platform-macos/src/input.rs`：鼠标拖动交 pan，不通过拖内容滚动；左键 down/up 才发送 press；OtherMouseDown 仅 back 分支；取消必须同时捕获 touch cancel 和 pan cancelled。
- `crates/nsh-platform-windows/src/input.rs`：middle/right/side presses 不建立 pointer；MouseMove.pressedButton 仅说明鼠标移动时按住的按钮。
- Mac/Win 的 `scroll.rs`、`keymap.rs` 与 `nsh/test` 公开声明。

生产 strip 使用 NSH View/pan、可选 ContextMenu、Scroll、keymap，并新增零面积 `yuri.desktop.tab-events` native component；不用 DOM、RN 或 React。固定 NSH 0.4 checkout 是本轮 API 依据，Context7 已实际耗尽配额，未假称取得在线说明。

固定 NSH 0.4 普通 View 仍无 auxClick，**现已实现独立原生 observer 与 TS 消费，不再只有动作提案**：Mac local NSEvent monitor、Windows 供既有 window_proc 调用的真实消息 observer，只有同 tab down/up 才 emit；native component 严格 0×0/无 HWND，仅传递事件。TS closure 重验后调用原 `interaction.pointerClose(id,'middle')`。没有用 MouseMove 猜中键，没有新增 JS close command；Host owner 的入口接线与物理中键仍须独立验收。

Windows 普通 View focus 的上游缺口未改变；新增真实 native leftDown → `tabFocus/tabBlur` 路径。仅 Windows 在通过 scope/lease/geometry/active 门禁后调用普通 target.blur() 清 Input editing，再设置 focused；窗口失焦清除。Mac 继续已有 onFocus/onBlur，不抢 first responder。固定 Win32 `mount.rs` 对普通 View Blur 使用 `text_input::blur_all`，而 headless 的模拟不等价，故不把合成焦点或 metadata 检查称为 Win32/IME 验收。

### 给 Host owner 的已实现桥接接口

精确注册、set_scope、install_observer、UI loop、retire/drop 接口见 [desktop-host/DESKTOP-TAB-EVENTS.md](./desktop-host/DESKTOP-TAB-EVENTS.md) 与 `desktop-host/examples/desktop_tab_contract.rs` 顶部。Host owner 只需接入口，不需重写 observer。Mac 不使用可见 overlay；Windows 不新建 child HWND/subclass。完整 README 的 native authority/文件/平台边界不变。

## 20 scope metadata persistence

```ts
// 在窗口/root lifetime 创建一次，不随 strip 隐藏而 dispose。
const metadata = createDesktopPanelTabsPersistence(existingWindowTabsOwner, Storage, notify);
await metadata.restore();
// state(): hydrated/reading/writing/pending/error
// metadata.retry()：显式重试读/写；窗口实际销毁才 metadata.dispose()
```

原生生产绑定已实现为 `desktop-panel-tabs-native.tsx`，main 可直接使用，无需自己维护 notify/revision：

```tsx
const metadata = createNativeDesktopPanelTabsPersistence(existingWindowTabsOwner);
await metadata.ready;
// metadata.state() 是 NSH reactive；还有 retry()/flush()/restore()/dispose()。
// root cleanup 自动 dispose metadata lane，不 dispose tabs/editors。
<DesktopPanelTabsMetadataFeedback metadata={metadata} current={current} active={active} />
```

绑定先等待既有 editor journal 的启动恢复，让原 owner 的保护状态就位，再恢复 UI metadata；不会替换其 storage，不调用其 save 或 Host 写。已打开的 live tabs 即使早于 metadata binding 创建，也会合并持久化。反馈只在错误时占工作台内容区，不增加第二行 toolbar；普通读写失败可显式重试，conflict/rollback 不明时不提供盲目覆盖按钮。

八类真实内容的可执行 slot 合同见 `desktop-panel-tabs-renderers.ts`：`DesktopPanelRendererSlots` 的 key 与真实 Web union 一致，由 source 组件函数提供内容；`admitDesktopPanelContent` 必须在 main 创建对应种类 tab 前调用，未注册 renderer 返回 false、不会调用 commit。`renderDesktopPanelContent` 对缺失 renderer 明确抛出 unavailable，没有 null/空 View fallback。readOnly chat union/codec/实际 Chat source 由嵌入会话 owner 负责，本切片收束标题/icon 与 presentation request 适配。`file-diff/btw` 的 full-file diff、BTW cancel/clear 仍需真实 source，slot 合同本身不代表缺失内容已完成。

现已收束 chat presentation request：`desktopPanelContentRequest` 将新 target 显式映射为 `{kind:'chat',sessionID,directory,readOnly:true,titleFallback?,messageID?}`。readOnly 是 literal true 且运行时复验，不能接受 tab 自报 false；directory 必填且来自 target，可与工作台父 scope 不同，不从主会话/assistant 推断。renderer 的 `context.scope` 仍表示承载工作台的 authority/lifetime，内容请求必须使用 `request.directory`；messageID 只传导航请求，不参与 tab identity。model/codec 和实际 Chat source 仍由嵌入会话 owner 负责，没有在此重写。

- scope identity 为 `[hostID,authorityKey,sessionID,normalizedDirectory]`；authorityKey 来自 root 的稳定公开身份，禁止放 token。lease 不持久化，不因 renew 清空 tabs 或 editors。组件瞬态交互仍按 lease fence。
- 单一版本化 Storage key `desktop.panel-tabs.v1`，最多 20 scopes、每 scope 256 条 metadata、总 UTF-8 512 KiB、单字符串 8192 code units。超限停止 metadata 写入并报 capacity，**不截断/关闭 live tabs 或丢 dirty 文件**。
- model 的现有 20 scope LRU/dispose 继续使用 editor `scopeProtected`，不能淘汰 dirty/unknown 文档。main 已将 metadata 恢复准入分离为 `scopeRestoreProtected`（默认沿用 scopeProtected）；production 可允许未被 view/live action 采用的 cold recovered 文档填充 absent scope。existing live scopes 与晚到读的保护不变，恢复不 dispose editor、不重放 unknown 写。本事件切片不修改这些恢复模块与 pinned tests。
- 白名单只含文件/HTML 路径与行号、canonical browser URL、context、workspace/staged diff 参数、顺序/选择/rail。无 lease、正文、patch、callbacks、dirty 推断、凭据或未知写 receipt。
- 文件/HTML 现在可有严格 `source:{directory,sessionID}`；v1 旧无 source 记录保持旧 identity。parent 管标签，editor/preview 按 own scope 读取与保护，source 不可覆盖 Host/authority/lease。dirty/close/20-scope LRU 与冷/孤儿 journal 恢复的完整合同见 [DESKTOP-PANEL-CHAT.md](./DESKTOP-PANEL-CHAT.md#文件引用的-own-source-工作台合同)。source metadata 不构成 Chat session receipt，也不创建 Chat writer。
- **精确历史 turn diff 暂不跨进程恢复**：source 可能仅为内存 snapshot/loadFile closure，没有可重新获取精确快照的 authoritative resolver。活着的历史 tab 完全保留；metadata 不序列化正文，也不造空历史 tab 或读当前 Git 冒充。main 后续需提供带 exact message/tool/revision 的历史 resolver 再扩展 codec。这是明确未完成项，不是完整历史恢复签收。
- restore 严格验证版本、scope、kind、路径边界、canonical ID、重复项与容量；读失败不是成功空结果，也不允许覆盖未读 prior。保存 lane 合并最新 revision、串行读核验/写入；普通失败保留 live 状态和 prior Storage，显式 retry 保存最新意图；内存已更新却 reject 时只回滚自己的候选值。发现其他 writer 或回滚不明则 fail closed，retry 不盲目覆盖。
- 单窗口 owner，不提供跨窗口 Storage CAS。`Storage.setItem` 成功仅证明本次 metadata API 成功，**不证明 crash-safe file journal、fsync 或断电恢复**；文件正文与未知 Host 写仍完全属于原 file_journal。
- main 必须订阅 `state()` 的 read/write/capacity 错误，提供本地化显式重试；conflict/rollback 不明不能伪装普通 retry 已成功。反馈由 root 的现有错误承载区装配，不把原始错误/路径塞进 header，也不让 strip 多长出第二行标题。

## 性能与验证边界

拖动响应是目标交互：Web 常见上限 12 tabs，metadata 最多 256；手势开始只测量一轮，最多两条 measure 并发，移动不重新测量、不请求网络、不写 Storage。只有最终 release 更新 model 并触发一次 metadata lane。相同顺序/选择不发布。strip 不订阅 composer 输入/消息 token。

独立纯测试覆盖顺序/稳定引用、真实 owner 端口、逐项失败与部分关闭、stale scope/lease、20 scope/保护、metadata codec/延迟恢复/失败回滚/显式 retry。`desktop-panel-tabs-engine.test.tsx` 使用真正 NSH headless 输入、原生 pan、ContextMenu、公开 Storage 和现有 editor dirty dialog；fixture 只注入合成文本读取，不执行真实 Host 写。

headless 不代表 AppKit/Win32 实机或物理中键验收；本事件切片的真实 AppView/Components fixture 没有创建 NSWindow。产品入口装配、缺失内容 slots、历史 resolver，以及 native observer 的真实系统事件/Win32 IME 验收仍需各 owner 分别记录。

本事件切片最新验证：renderer/事件 gate/交互 core 加 native wrapper 的 Vitest **23/23**；wrapper 内为 NSH headless **16/16**（原有 14 项保留，新增合成 middle receipt 经真实 editor dirty guard cancel/discard/去重、chat title 与同 identity 导航更新）。renderer 另覆盖固定 readOnly、显式跨目录、messageID 和拒绝缺失 session/directory/可写请求；完整 `nsh:check` 通过。此前全组 model/metadata/renderer/editor/journal 聚焦回归 **79/79**；这些文件现由 main/嵌入会话 owner 继续改动，不把该次数当作后来改动的签收。独立 Rust example **11/11**（含 3 条既有 policy 测试），Mac clippy `-D warnings` 与独占文件 rustfmt check 通过；真实 QuickJS/Components fixture 与 Mac link 通过（linker 报 __eh_frame 体积警告，不是运行失败）。当前只有 Darwin target，未验 Windows target/metadata/物理 UI。标准 `bun run dead-code` 因 Web Vite 缺 `vite-plugin-pwa` 未完成，未添加依赖绕过。
