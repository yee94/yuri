# Browser tab identity 与生产 panel 消费证据

## 当前 Web 权威

- `useUIStore.ts` 的 `openContextBrowser` 固定 `dedupeKey: 'desktop-browser'`；`upsertContextPanelTab` 原位更新并选中，不为另一个 URL 新建 tab；`targetPath: nextTab.targetPath || tab.targetPath` 保留空 Header 入口之前的目标。
- `ContextPanel.tsx` 的 Iframe/Desktop pane 分别跟随 `initialUrl`，仅在 `resolveBrowserPaneNavigation` 得到新目标时导航。地址 Input 是 pane-local 草稿，不是每字符 store 写；重复目标与 Header 空入口不抹草稿。
- 两种 pane 的实际导航通过 `setContextPanelTabTargetPath` 回写目标，不能让后续 Header 打开或冷恢复重新采用旧 URL。
- `RightSidebarTabs` 的 browser rail 与这个 content tab 不是同一集合。scope 与 Host 准入不从 rail 推断。

## 本切片已实现

`desktop-panel-model.ts` 保持原 Host/authority/session/directory 分区和 20-scope LRU：

- `desktopPanelTabKey(browser)` 固定 `desktop-browser`。Header 首次空地址、相同/不同 URL 共用一个 ID。不同的非空 URL 替换 intent，保留原位置、其它 tab 对象和文件 owner，并同步选中；空入口只选中，不清目标。语义相同的重复 open 不发布。
- `setBrowserURL(scope,id,url)` 是 **已校验、current native 导航回执** 的回写端口：原位更新 URL，不改变选择/rail/activeView，不创建 scope，不清空 URL，不接收未提交地址稿。调用者仍须提供原 pane 的 captured authority/current fence；此 UI owner 不代替 native receipt 校验。
- URL 仍走原 `desktopBrowserAddress` admission。非法非空 URL 不改变 prior/选择/通知，loopback 保留 Host proxy intent，不能外开客户端 localhost。没有修改 Host/native loader。
- `normalizeDesktopPanelMetadata` 和 codec 的最小兼容改动接受既有 v1 `JSON.stringify(['browser', canonicalURL])`，新写为稳定 ID。旧多 browser 优先保留 **selected browser**；若选中非 browser，则取保存顺序中的最后 browser。胜者留在自身原位置，其余 tab 的顺序、selection 与 own-source 文件 metadata 不变。没有 URL-key 时间排序或重放 open。
- 严格验证每个原始 ID、URL 和 selectedID 后才合并；伪造旧 URL key、重复同 ID、非法 URL 仍 fail closed。混合新旧格式和明确选中的旧空 browser 可恢复。读取不立刻重写旧 prior；下次本地修改才经原串行 lane 保存，失败回滚精确 prior，显式 retry 只存最新意图。
- `scopeRestoreProtected`、dirty/journal/unknown owner、容量和 metadata storage-key/version 不变。

## 已装配的生产 consumer

### 1. `desktop-panel.tsx` 的响应式 URL 转发

main 已修正 `DesktopPanelTabContent` 的 browser 分支：初始 `tab` 仅用于 kind 分流，child 收到响应式 `props.tab`（和已有 Chat 分支同样处理）：

```tsx
if (tab.kind === 'browser' || tab.kind === 'preview') return <DesktopPanelBrowserTab
  tabs={props.tabs} scope={props.scope}
  tab={props.tab.kind === 'browser' || props.tab.kind === 'preview' ? props.tab : tab}
  current={props.current}
  active={props.active && !props.browserOccluded && !props.tabs.modalOpen()}
/>;
```

`DesktopPanelBrowserTab` 已向 pane 传 `intent={props.tab}`，pane 已有 incoming-intent effect。不要改 tab key 来强制重挂，否则丢失地址草稿/历史和原 native owner；不要只从 application 调一次 request，隐藏 tab 的 active lane 可能尚未恢复。

### 2. `desktop-browser.tsx` 的已验证导航回写

main 已为 `NativeDesktopBrowserPaneProps` 增加可选 `onNavigate(url)`。生产 JSX 的 `onBrowser` 仅在原 `binding.event(value)` **成功接纳 native receipt** 后，取 `binding.snapshot().url` 的非空值回调；Input `onChange` 不回调，不回写 preview 文件路径，也不回传 proxy 私有 URL/凭据。

`DesktopPanelBrowserTab` 已只对 browser 传回调，复验 `current()` 后调用已有 native owner 暴露的 `props.tabs.setBrowserURL(props.scope,id,url)`；preview 不传。请求/事件 receipt 的 Host/lease/generation 校验继续由原 binding/native owner 所有。回写同 URL 为 no-op；若触发 incoming intent effect，binding 同 URL 也是 no-op，不产生第二次页面请求。地址栏点击 Go 仅发请求、更新 pane-local address；尚无被接纳的 native 导航回执时，metadata 保留上一个 URL。

这两个 consumer 已通过真正 `NativeDesktopPanel` 的合成 Engine/JSX 消费验证；不再只是独立 pane 手动传 props 的证据。本轮没有再修改这两个生产文件，沿用 main 的接线。`application.tsx`、真实 Chat 正文链接和终端 URL 到工作台的实际根入口由 main 独立验证，这里的 fixture 不冒充它们的签收。

### 3. 固定 NSH 0.4 的公开 native event 测试边界

固定源码 `crates/nsh-js/src/platform_modules.rs` 的 `render_native/native_event` 将 `EventKind::NativeEvent` 的 `{name,data}` 派发给 `on<Event>(data)`；生产 `BrowserViewport` 的 `onBrowser` 因而收到 data 本身，不应再拆一层 `event.data`。

该版本 `nsh/test` 的 TS `App` 类型没有任意 custom-component event 发送接口。`desktop-panel-browser-events.fixture.rs` 使用公开的 `EngineControl.dispatch_event(nodeID, EventKind::NativeEvent, EventPayload::Native { name: "browser", data })`，与上游 `crates/nsh-engine/tests/engine/native.rs` 同一路径，进入真实 JSX handler，**不直接调用 `binding.event` 或 `setBrowserURL`**。nodeID、owner、Host、lease、generation 全部取实际 mount batches 的 `ComponentProps`，不猜序号或造平行 owner；detached/removed 节点不被当作活着的 viewport。

这只是测试 harness：没有新增或注册 native browser 实现、capability、Host service、窗口或网络 loader。wrapper 仅用临时空 carrier 和 `cargo --offline` 解析既有 0.4 production crate graph，`rustc` 编译测试；不改项目依赖/锁文件或 NSH 上游。

## 验证与边界

- `desktop-panel-browser.test.ts`：identity/selection、invalid prior、Host/authority/session/directory、lease、真实 own-source dirty owner、20-scope LRU、loopback binding/旧 receipt、新旧 metadata 合并、失败回滚/retry 和晚到恢复。
- `desktop-panel-browser-native.test.ts`：真实 NSH headless 下 Mac/Windows 各 3 场景；fixture 现只挂生产 `NativeDesktopPanel`，不自行挂 pane/strip，也不手动转发 intent。覆盖空 browser、不同 URL 同 ID 的真实地址更新、非法 prior、模态/Host 切换、Context→browser 选择恢复、实际地址/主输入各 50 字符零额外通知/metadata I/O。未提交地址和只有 Go 请求、尚无 native 回执的 URL 均不进入 metadata。
- `desktop-panel-browser-events.test.ts`：两平台各 2 场景，共 4 条真实 Engine 测试。捕获真实 native node/owner，断言 A→B/Host loopback 不重挂；接纳 synthetic native receipt 后，地址、tab intent、`metadata()` 和已保存 envelope 全部回写同一 URL，generation 不增加、不产生重复导航请求。旧 generation/owner/Host/lease、旧 node、外部模态、内部模态、inactive browser 的回执均不改 snapshot/metadata/prior、不读写 metadata Storage、不发布 tab 通知。lease 更新后使用新 owner；preview 自身合法文件/HTTP 导航回执也不修改 browser URL、selection 或 metadata。
- application 的真实 Header、Chat 链接 A→B 和终端 localhost 入口测试由 main 所有；这些独立工作台测试不创建 Chat 主 writer，也不把 fixture 的控制动作称为 application/Header 入口证据。真实 native 导航生产端到端仍须独立验收，synthetic event 只能证明上述 TS consumer 边界。
- 纯测试和 headless 都不证明 WKWebView/WebView2、Host proxy 页面加载、cookie、真实凭据网络、AppKit/Win32 物理窗口或 OS 视觉。
- 本轮升级后执行结果：browser/model/codec/core 加既有 browser native 共 **8 文件 52 外层项通过**，其中工作台输入 wrapper 内部为 **6 场景**，native receipt wrapper 内部为 **4 条 Engine 测试**。完整 `tsc --noEmit` 与 `nsh:check` 重跑通过（较早一次 tsc 曾遇并行 Header navigation 的 nullable 错误，未越界修复，收尾重跑已消失）。`bun run dead-code` 再次被现有 Web 配置缺少 `vite-plugin-pwa` 阻断，没有补装依赖。此前 own-source/historical/renderer/editor/journal **6 文件 78 项**是上一轮独立回归结果，不当作 main 后续改动的签收。

从根重跑（`NSH_BIN` 指向既有 0.4.0 distribution）：

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/desktop-panel-browser.test.ts packages/nsh/desktop-panel-model.test.ts packages/nsh/desktop-panel-tabs-persistence.test.ts packages/nsh/desktop-browser-core.test.ts packages/nsh/desktop-panel-tabs-core.test.ts
NSH_BIN=/path/to/nsh/bin/nsh bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/desktop-panel-browser-native.test.ts packages/nsh/desktop-panel-browser-events.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
```
