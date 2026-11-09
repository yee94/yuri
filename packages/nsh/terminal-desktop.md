# Desktop terminal 切片与宿主接线

## 当前交付边界

- `desktop-terminal.tsx` 是原生 bottom dock：Tab、新建、关闭、重启、展开/隐藏与 focus；高度和展开几何归 workspace，不由终端写入。
- `desktop-terminal-core.ts` 只拥有呈现/握手/receipt 与已授权链接事件转交。PTY、目录、Tab、恢复与 transport 状态复用 `terminal-core.ts` / `terminal.tsx`。
- `terminal-path.ts` 复用资源模块的共享路径归一化，支持 drive/UNC；原严格 POSIX admission 保留。Rust 只校验已归一化路径，不解析客户端文件。
- Mac 的 `yuri.terminal.viewport` 是独立 WKWebView 原生叶子，ephemeral store、固定 CSP、离线内嵌现有 Ghostty 0.4.0 JS/WASM。没有通用 Host bridge、任意 HTML/JS/URL 入参或主应用 WebView。
- `terminal_host.rs` / `terminal_transport.rs` 使用原生捕获的同一 committed actor authority。Host direct WS-v2 最小切片已实现，Mac 使用真实 `NSURLSessionWebSocketTask`；只有 prebind 失败才允许 SSE fallback，不允许已绑定或未知输入回退 HTTP 重放。当前 capability 为 `wsAvailable:true`，availability 不等于 socket 或 renderer ready；SSE 路径仍明确 `replayUnavailable:true`。renderer ACK 始终独立于 server replay cursor，loopback 测试不代替真实 PTY／跨平台产品验收。
- Windows 的 `terminal_desktop_windows.rs` 已通过公开 `Components` / `NativeComponent::window()` 注册真实 child HWND 与 WebView2 controller，不再返回空 registration。使用强制 InPrivate、每 owner 独立 profile、单次固定离线内存文档；仅以 `PostWebMessageAsJson` 向固定 allowlist 传数据，没有 ExecuteScript、Host objects 或导航命令。除这一份原生内存文档外，所有资源、frame、popup、权限均拒绝。每条命令/消息及异步 callback 校验原 owner/generation/Host lease；失效、隐藏和销毁分别停止输入、交还 focus、移除事件 token、关闭 controller。**Windows target/SDK 链接与实机仍未验证，不能宣称完整 PC parity。**

Windows 不使用 `NavigateToString`：完整 Ghostty/WASM 文档按 UTF-16 已超过其 2 MiB 上限。原生只导航到编译期固定的 `https://terminal.invalid/viewport`，该地址不是远程服务；先安装全资源拦截器、创建拒绝响应和 `SHCreateMemStream` / `CreateWebResourceResponse` 内存文档，才允许一次主文档 GET。URI、方法、document context、当前 scope 和一次性 admission 均匹配才消费该响应；其它请求先设置预分配 403，无磁盘 HTML、虚拟目录映射、任意 URL 或网络 fallback。响应设置失败立即 Stop/Close。文档 UTF-8 上限 8 MiB，CSP 同时写入响应头和 meta，`connect-src 'none'` 不变。`WebMessageReceived.Source` 必须精确等于该固定地址；Mac 继续使用 `loadHTMLString` / `about:blank`。

## TS 生命周期合同

```ts
NativeDesktopTerminalDock({
  scope, directory, current, active, expanded, onToggleExpanded, onClose, onDesktopShortcuts, onOpenPreview,
});
```

按 `hostID + lease` 在 workspace terminal slot 持久挂载。`current()` 只判断 scope authority，不能拿页面可见性代替。页面/应用可见性通过 `active` 传入；没有有效目录的隐藏期可传 `directory:'' active:false`，先暂停，保留最后有效目录与 tabs。恢复有效目录后才执行 `setDirectory`。

workspace 的 `terminalAvailable` 必须独立于保存的 `terminalExpanded`，无有效 scope/目录时不能把主内容隐藏为空白。manifest 的 `terminal.desktop.capabilities` 声明归主装配所有。

renderer capability 只准许挂载；实际 Ghostty/WASM 的 ready 才准许恢复 workspace，实测列行才准许 create。失败保 prior、显式 retry，不自动重建未知 create/input。关闭 dock 只 detach；只有确认关闭 Tab 才关闭远端 PTY。

输入 receipt 为单调递增单 flight；`accepted/rejected/unknown` 都匹配 exact key+receipt。hide/tab-switch 前已发出、但未派发的输入用 `suspended` 结算并保为原 Tab draft，不占住队头，不自动重放。未知已派发输入只允许明确关闭/重启原 PTY 后解除，不通过 renderer remount 丢弃。

输出 ACK 表示 **VT commit**：Ghostty 0.4 的 WASM write 同步完成，不把会被遮挡节流的 rAF 当作提交。它不是 pixel-paint 证明。尺寸来自同一 FitAddon 的 `proposeDimensions()`；不可测量时不发布 resize，原生 layout 命令触发测量，不使用估算 cell 或默认 80×24 创建。Windows 在导航前应用真实 child HWND bounds，controller 初始隐藏。

### 单一 root 快捷键 registry

终端不再调用 `keymap.bind`，也不复用 composer owner。`onDesktopShortcuts` 发布 `{type:'register'|'retire', owner: NativeDesktopTerminalShortcutOwner}`；按 owner 身份 CAS 清理，不让旧 retire 清掉新 owner。

- `owner.actions` 提供 `toggle_terminal_expanded`、`new_terminal_tab`、`previous_terminal_tab`、`next_terminal_tab`，使用已有全局 action IDs。`mod+shift+j` 是展开而非私有 focus。新建/切换只在真实 terminal focused、非 composing 且 ready 时启用；所有执行时再次检查生命周期。隐藏/settings/palette/closeBlocked 由 main 的 active 传入，迟到 descriptor 无效。
- `owner.focus()` 是给 root 的显式 focus callback；根的打开/隐藏终端动作仍由 workspace 所有。终端不注册成 composer，不能覆盖 submit/model/Agent 等 composer actions。
- child HWND/WKWebView 持键盘 focus 时，root 可调用 `owner.setKeyboardRouting(bindings, dispatch)`，传**同一 registry 经 overrides、modal/IME/focus admission 与 menu-owned 排除后的有效 `NativeShortcutBinding[]`**。终端只把这些物理键转换为 `{actionId,keystroke}` 事件；回调中 root 再次核验并分发，不重新解析另一套默认快捷键。改键/上下文变化立即重发完整列表；不接此方法就不拦截 WebView 内的应用快捷键，不暗中使用硬编码 fallback。终端按 exact pair 白名单再次检查，旧 owner/IME/退役不分发。

`desktop-terminal-signals.ts` 将 `focused`、`composing`、ready 布尔值及 renderer generation 拆成窄 signals；`changed` adapter 先比较前后普通字段，实际变化才 set。root 暴露的 getters / action enabled 只读取这些窄字段和低频 active/current，绝不读取整体 `state()`、workspace output 或 input receipt revision。整体 state 的 ACK 通知仍留在局部 presentation，不能为了性能删掉输出推进。keyboard routing 的配置 effect 同样只订阅窄 generation/ready，不因 ACK 重发绑定。

### Browser preview 与链接转交

Dock 的可选 callback 精确签名：

```ts
onOpenPreview?: (
  scope: RuntimeScope, directory: string, url: string,
  mode: 'preview' | 'external',
) => void | Promise<void>;
```

该 callback 直接传入原 `createNativeTerminalWorkspace`，不再使用永久 throw 的占位实现。调用前重验 Dock active/current 与 captured scope。main 拥有 browser tabs、external 安全 openUrl、localhost 的 Host proxy 与最终授权；TerminalWebView 不接收远程 URL 导航命令。callback 未接或失败仍由原 controller 保留 Tab 并发布 `preview_failed`，不回退到终端页面导航。

main 已报告在 application 挂载 `desktop-terminal-preview.ts` 的生产 `createDesktopTerminalPreview`：exact scope／normalized directory／foreground／terminalOpen／modal／close gate；preview 进入 panel browser，公共 external 进入安全 openUrl，loopback 即使 external 也进入 Host browser proxy。此模块只读复用该 factory，不修改它或 application。

固定文档保留 Ghostty 0.4 的 OSC8／regex link detector 和 Ctrl/Command-click，只替换 activation 为 `{type:'openPreview',key,url,mode}` 窄事件。真实点击捕获原 key，异步检测后重验；隐藏、旧 Tab、无可信点击与非 HTTP(S) 不派发。loopback 点击用 preview，外链用 external；native 再校验消息边界，binding 再校验 owner/generation/lease/active/key，最后调用同一 `controller.openPreview(id,url,mode)`，由原 URL admission 规范化并拒绝危险 scheme、userinfo 与敏感参数。`window.open` 仍禁用，终端页面从不加载外链。LinkDetector 是另一个显式锁定 Ghostty 0.4 的内部 seam，升级必须重验。

输出 URL discovery 继续复用原 scanner 和 `terminal.probe`，成功后使用与 Web 相同的现有预览按钮／文案，经同一 callback 打开。当前 Host `actionDiscovery:false`，且 `terminal.probe` / discovery 尚无实际 dispatch 分支，因此生产输出自动发现尚未完成；不把合成 probe 的成功当成生产能力，也不在 renderer 加客户端直连探测。

`desktop-terminal-dock-preview.test.ts` 另运行真实 QuickJS／NSH 核心／基础 UI 组件的完整 Dock 载体：生产 Dock + 原 controller + 输出 URL scanner + 合成 probe + 生产 preview factory + panel tabs + NativeDesktopBrowserPane。使用公开 EngineControl 给实际 viewport node 注入 ready／实测尺寸／ACK，派发实际 Dock 预览 Button 的 Press，断言最终 `yuri.desktop.browser` 的 native component binding 为 loopback intent；公共 external 只产生 `OpenUrl` command，external localhost 仍产生 loopback browser intent，旧 generation／credentials／IP alias／隐藏事件不产生 external 命令。系统 OpenUrl 由测试回答成功，不打开本机浏览器；没有替换生产 JSX 或把测试 hook 加到产品代码。native 事件和 Host 为合成，因此不声称真实 WKWebView／WebView2／网络 proxy 已验。

该载体复用 production Cargo graph 的既有 `nsh-base` artifact，不添加 crate／依赖／工具链。测试暴露并修复：controller 原地更新 Tab 时不得缓存同一个 Tab 对象，否则 previewUrl／phase／error 不更新；共享 theme converter 对已有 alpha 的 selection 再追加 `50` 会生成非法十位 hex，terminal adapter 保留原意的 inactive alpha，生产 configuration 校验必须先成功才注入 ready。

### 与当前 Web 的行为对照

| 能力 | 当前实现与验收边界 |
| --- | --- |
| 分栏／bottom dock | Web `BottomTerminalDock` 的主内容分区、拖高、展开／恢复由 NativeDesktopWorkspace 所有；renderer 只消费真实布局尺寸。当前 `TerminalView`／`useTerminalStore` 是多 Tab、单 active viewport，没有独立 terminal split-pane 合同；不凭名称新增假的分屏控件或平行 PTY 状态。 |
| URL discovery／打开 | 原 scanner／probe → `previewUrl` → 原 controller → main callback；显式链接点击已贯通，生产 probe／Action discovery 仍归 Host owner。 |
| 选择／复制 | Ghostty 保留真实 canvas selection。与 Web `TerminalViewport` 一样，拖动 mouseup 自动复制、Cmd-C／Ctrl-Shift-C 有选区时复制而不发 PTY Ctrl-C；无选区 Ctrl-C 仍为输入。原生 copy 事件写入 text/plain，退出后的可见历史仍可复制，隐藏终端不接管 clipboard。点击有选区时不抢回隐藏 textarea focus。 |
| 粘贴／输入 | 使用系统 paste 事件，不从 Host 偷读 clipboard。Ctrl/Command-V 留给系统，不误发 Ctrl-V；bracketed paste 保留多行／Unicode 与 receipt；补齐与 Web 相同的 Alt-letter ESC 前缀。拒绝／unknown／suspended 的保文与不重放语义不变。 |

上述 clipboard／selection 合同由实际交付 JS 的 DOM fixture 验证；尚非系统 clipboard、鼠标几何连选或真实 IME 实机验收，没有新增复制／粘贴 fake 控件。

### 字号、字体与实际行高

消费 `nativeAppearance` 的实际 mono 与设备 `nativeCodeFontSize/nativeCodeFontUnconfirmed`，使用 `nativeChatTextStyle('code')` 同一 desktop code 字号/line-height；不固定 13，不把暂未接通的 `terminalFontSize` 表单当 authority。未知/未确认 code 偏好不制造默认值。

Ghostty 0.4 的公开 Terminal options 实际忽略 lineHeight。固定文档对**精确锁定版本**的 `CanvasRenderer.measureFont` 测量 seam 加入真实行高及居中 baseline，paint/selection/scroll/FitAddon 共用同一 metrics；字体/字号/行高变更重新测量，不仅改 CSS。版本/生产 bootstrap admission 失败明确报错。该 JS-private seam 是显式版本耦合，升级 Ghostty 必须重验，不能宣称库原生支持了 lineHeight。

## Rust 接线（由宿主 owner 完成）

本切片未修改宿主的 main/runtime/Cargo。需要宿主声明以下模块；`terminal_document.rs` 已由 viewport 的 `#[path]` 引入，不重复声明：

```rust
mod terminal_viewport;
mod terminal_transport;
mod terminal_host;
```

`terminal_transport.rs` 通过 `#[path]` 内嵌 focused `socket`／`ws` 子模块；main 无需新增 root mod，renderer／TS 合同也无需为 direct WS 改动。每个 active attachment 持有一条原生 physical socket，与 iOS 结构相同，不新建共享 mux 框架。

1. 在 UI 主线程、创建 AppView/load bundle 前调用 `terminal_viewport::register(&components)?`，把同一 `components` 放入 `AppOptions`；保留返回的 `Registration`。两平台均完成注册，capability 不替代实际页面 ready。Windows 使用宿主同一 STA/OLE UI 线程及 NSH/WebView2 的 `WebView2LoaderStatic`，不新增 Cargo 依赖；若运行时缺失、InPrivate 不支持、HWND/COM 创建失败，则真实 ready 失败，不能降级到主 WebView或普通用户 profile。
2. **先**安装现有通用 `bridge::install`，**后**安装 `registration.install_capability(&host)` 和 `terminal_host::install(&host, network, capture, catalog_path)`。否则通用 bridge 的 unsupported handler 会覆盖终端 handler。
3. `Capture = Arc<dyn Fn(&Value) -> Result<Captured> + Send + Sync>` 只从原 runtime actor 的 authority 获取凭据，禁止独立读 Vault、从 JS 或环境变量取 token。返回 `Captured::direct(scope, origin, token, loopback, current)`；`current` 必须持续校验 exact lease 与 authorization，不能只比 hostID。
4. 不支持的 Relay 捕获必须明确拒绝，不能去掉 Relay 信息转直连。Relay 接入原 E2EE tunnel 尚未完成。
5. 连接完成并被原 actor 接纳后才 `registration.set_scope(Some(&scope))?`。失效时清除 registration scope、撤销 capture authority，并调用持有的 `Owner.retire_scope(&old_scope)`；它 detach，不杀 PTY。销毁时保留并最终 drop Owner，取消其逻辑 jobs。
6. `catalog_path` 来自宿主的私有应用数据目录，独立 metadata-only JSON；只存 Host/目录/Tab/session 身份与 lifecycle，不存 token、输入、输出。不要从 JS 接受路径或把 Host cwd 当本机文件路径。catalog 损坏不能视作空成功；写失败保 prior。

`Registration` 当前不导出、也不要求宿主调用 `poll`。Mac 由 WK delegate 事件驱动；Windows 由组件自己持有的 child HWND timer 与 WebView2 COM callbacks 驱动，组件 Drop 清理 timer/事件/controller。宿主只需保留 registration 至 shutdown，按以上顺序撤销 capture/registration、retire terminal owner，再停止 AppView；capability 的 prepared 不等于页面 ready。TS `onDesktopShortcuts` publisher 也是事件/响应式合同，不增加 Rust pump。若将来需要宿主驱动，必须由 renderer 模块先提供明确接口，不由入口补猜测性的 poll。

Host owner 已报告完成生产 Components/register、同一 Network 与 committed actor authority 接线，以及无 UI 的真实 NSH Network create/SSE/input/resize 集成测试；新增 Mac 真实 `NSURLSessionWebSocketTask` loopback + committed actor／HostChannel／QuickJS 测试覆盖 direct WS-v2、cursor replay、gap、duplicate suppression、prebind-only fallback 与未知输入保护。该证据包含真实 Mac 原生 socket，但 backend 为合成 loopback，不包含真实 PTY、窗口／Ghostty 显示、Windows target／runtime 或 Relay 验收。

### 已核对的 PTY / mux wire（Host Agent 所有）

renderer 不持有 URL/token/socket，也不新增凭据存储。`terminal.tsx` 的 native-opaque、wsVersion=2、durableMetadata admission 沿用；WS 的实现不能搬进 WebView。现有 `terminal-core.ts` 通过 `terminal.attach` 传 `attachment` 及 **server replay cursor**，`terminal.event` 归原 actor 规范化后交回 core。

对照 `packages/ui/src/lib/terminalApi.ts` 与 iOS `TerminalBridge.swift`：mux control 为 byte `0x01` + JSON，bind `{t:'b',s:sessionId,r:cursor,v:2}`、`bok` 确认、`d` 的 `i` 为 server cursor、`x` 退出、`e` 失败，keepalive `p/po`。direct WS-v2 已按此实现；native 转换为 renderer 的递增 presentation `id` 与独立 wire `cursor/replayGap`，抑制重复 cursor 并显式标记 gap，不能把二者混用。renderer ACK 的 key/serial/cursor 只确认本批 presentation IDs，不推进 socket replay cursor、不重发输入。

SSE fallback 只在 prebind 失败时进入，继续标记 `replayUnavailable:true`；旧 SSE fixture 显式 advertise SSE／HTTP，不能把它当作 WS ready。`WRITE_FAIL`／未知输入触发 native latch，后续输入保持 unknown，禁止 HTTP 重放。lease retire 仅关闭 socket／detach，不 kill PTY。Windows WinHTTP socket 源码已写，Host owner 正在做 metadata 检查；源码或 metadata 检查均不代表 Windows target 链接／runtime 验证。Relay 接入原 E2EE tunnel 仍未完成。

## 验证与仍缺的验收

自动化入口：

```sh
NSH_BIN=/path/to/nsh/bin/nsh bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/desktop-terminal-host.test.ts
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/desktop-terminal-windows.test.ts packages/nsh/desktop-terminal-actions.test.ts packages/nsh/desktop-terminal-core.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/nsh/desktop-terminal.tsconfig.json
```

Host wrapper 在临时目录复用生产 Cargo 依赖、离线构建真实 QuickJS fixture，并明确 `--include-ignored` 运行 Rust 的真实 Network 集成，未配置 fixture 的 ignored 测试不算通过。覆盖 Windows Unicode cwd、SSE、包含 NUL/CRLF 的 raw text input、resize、失败关闭保 prior与显式重试、旧 lease、未知 create 不重放，以及 catalog corruption/额外字段/已退出 session 不复活。

`terminal_viewport_fixture.rs` 与 `desktop-terminal-macos.fixture.tsx` 是独立 AppKit renderer 载体；通过临时 Rust bin 从进程主线程调用 `run(bundle_path)`，按仓库规则在已有 tmux 的终端验证窗口 upsert 运行。实际成功标记为 `REAL_WK_GHOSTTY_ACK_FOCUS_INPUT_RESIZE_OK`：真实 WKWebView/Ghostty 的 VT ACK、原生 first responder、Cocoa insertText receipt 与布局后实测列数变化。不安装业务桥、不读 Vault、不启动 shell/PTY；不是完整系统应用生命周期或人工硬件键盘验证。

`desktop-terminal-windows.test.ts` 在 Mac 编译**实际 Windows renderer 源码**，仅以公开 NSH `Components/NativeComponent/HWND/ComponentContext` 签名 shim 代替平台壳；其 COM ABI tests 实际执行本地 IUnknown refcount/query/系统 ABI callback，并检查 GUID/RECT/首指针布局。合成 COM 验证迟到 controller completion 必须 Close、接管不能提前/双重 Close、清理先移除 token 再 Close；独立 admission 测试覆盖离线文档只消费一次、跨 URL/方法/context/退休均拒绝。清理的 COM 调用在释放 State 借用后执行，允许同步回调观察已退役状态。不链接或调用 Windows DLL，不代替 Windows target、SDK 或硬件。ABI 依据为 WebView2 generated bindings 的 `ICoreWebView2{,Controller,Environment10,ControllerOptions,WebMessageReceivedEventArgs,WebResourceRequestedEventArgs,WebResourceRequest}` vtables/IIDs，并只读参考同仓 `browser_view_windows.rs`，未修改浏览器文件。

同一测试由 Rust 输出实际交付文档，在 Node VM 执行精确内嵌 Ghostty bundle、真实 WASM 与 CanvasRenderer 度量；DOM/Terminal I/O/FitAddon 为 fixtures，验证实际行高、改字号后行数、固定消息 allowlist、scope/generation 拒绝、改键后旧键不生效、未知输入不跨 Tab 重放、suspended draft 不自动重发。它不产生窗口，不是 Windows 显示/IME/像素验收。新增 TS 回归还覆盖晚到旧 Tab/旧 renderer ACK 不能结算当前 flight，未知 receipt 不能通过 retry/remount 重发。

renderer 侧上一轮源码合并重跑：14 个 terminal / desktop-terminal / browser-core Vitest 文件共 72 项全部通过（同一次运行，43.34s），不是先前分次结果相加；Windows wrapper 内另执行 10 项 Rust tests、clippy `-D warnings` 和实际交付文档 fixture；当时 Host wrapper 的 11 项 Rust tests 包含 Host owner 新增的原生 WS fragmented output／input／gap／reconnect replay／retire／redirect denial／oversize 合成回归。独立 terminal tsc 通过。新增 NSH engine wrapper 在 Mac／Windows 两个 headless 分支各执行真实 Input typing：50 次输入 receipt 产生 100 次 changed 通知、50 次 output/ACK 再产生 50 次 changed，root registry plan 均零重建；IME／隐藏变化仍重建并解除准入。载体复用生产 changed adapter、owner、binding 和 `createNativeTerminalWorkspace`，native renderer 事件／Host 为合成，另检查生产 JSX 确实消费相同窄 adapter；不能将此称为系统窗口 typing／真实 Host 性能验收。输出扫描→合成 Host probe→原 controller preview callback 同样在该引擎测试中贯通。

Host owner 后续报告完整 scoped 运行分别为 86／87 项，均 0 failed、0 ignored，包含上述 Mac 原生 socket／committed actor／HostChannel／QuickJS 验证。这是 Host owner 的运行记录，不与 renderer 侧 72 项相加，也不标作本文档更新时重新运行。此次仅核对当前源码合同并更新文档，未改 Host 目录 README、renderer 或 TS。

全包 tsc 同次复验仍失败：当前为 `desktop-help.tsx:50` 的 `role="dialog"` 不属于 `AccessibilityRole`，未修改该文件；此前 `settings-controls.tsx` 翻译 key 错误已不在本次输出中。`bun run dead-code` 最近一次仍被现有 `vite-plugin-pwa` 缺失阻塞，未安装依赖绕过。上述 headless 结果不能沿用早期 Mac 窗口标记作为当前系统窗口证据。

尚未验收/实现：root actions／browser callback 的整应用与真实 PTY 验收、Windows target/SDK/实机、真实 PTY 的 WS-v2 replay、Relay、生产 probe 与完整 actions/discovery、独立 terminalFontSize 设置、长时高吞吐性能，以及真实 IME/剪贴板/选择/物理键盘端到端。生产 Host 接线及合成 Network 集成证据按上面的 Host owner 报告单独记录，不重复标为未实现，也不扩张为真实 PTY 验收。当前使用已接通的 code 字号而不是未接通 terminal 设置。当前 locked=1 不启动 AppKit 抢焦点；既有 Mac 成功证据仅适用于此前版本，新行高/快捷键需图形会话解锁后复验。所有缺项仍属完整 parity 范围。
