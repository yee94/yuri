# NSH terminal：当前实现、owner 接线与验收边界

## 当前结论

终端模块已实现可挂载的原生控制器、专用 UIKit/WK surface 和生产 `RuntimeBridge.terminalTransport(expectedHost:)`；**主应用入口及设备全链仍待 main 验收，不能称已完成手机 Web 1:1 验收**。本 owner 后续修改了 RuntimeBridge，未修改 application/state/runtime/main/nsh.json/build 或其它 owner 文件。仅执行内存与合成 loopback/mux 测试，没有执行真实 PTY、Host、设备、NSH/Ghostty/WebKit 引擎或 main build。生产 transport、严格 stream/stop 和授权退休 hook 的最新证据见 [TERMINAL-RUNTIME-VALIDATION.md](./TERMINAL-RUNTIME-VALIDATION.md)。

本次延续已有 WIP，将旧 `{expectedHost:string,generation:number}` 删除，改为读取现有 `runtime-scope.ts` / `ios/RuntimeHostScope.swift` 的 native-issued `{hostID,lease}`。Feature 不定义或轮换 lease，不读 Keychain，不构造 endpoint/token，不自行直连。

## 已核对的产品依据

| 真实 owner | 当前合同 |
| --- | --- |
| `web/server/lib/terminal/DOCUMENTATION.md`、`runtime.js` | 真 PTY，create/resize/input/close/force-kill；v2 WS；HTTP text input 和 SSE output |
| `ui/src/components/views/TerminalView.tsx` | measured size 后 create；resize 不 rebind；已 bind 才输入；隐藏不杀 PTY；Ctrl/Cmd 与方向键合同 |
| `ui/src/stores/useTerminalStore.ts` | 工作目录拥有多个 Tab；持久化 ID/session receipt/label/icon/lifecycle，**不持久化 output**；最后页关闭后留 idle 页 |
| `ui/src/lib/terminalApi.ts` | `01 + JSON` binary control；text input；`b/bok/d/x/e/p/po`；显式非 WS capability 使用 SSE；恢复 receipt 无 capability 时默认 WS |
| `ui/src/lib/terminalPreview.ts` | 终端完整输出行扫描 loopback；`POST /api/system/probe-url` 后提供 preview |
| `ui/src/components/layout/ProjectActionsButton.tsx` | 配置 Action 复用 PTY、规范化 command 后发送一次；auto-discover；URL preview；Ctrl-C→1 秒→同一 PTY force-kill |
| `ui/src/lib/detectDevServer.ts` | 已配置 dev action→package script→packageManager/lockfile→index.html/static server/free-port |

当前 Web `TerminalViewport` 使用安装的 **ghostty-web 0.4.0**，不是 xterm。NSH 公开 SDK 没有 Terminal 组件；本地未发现可复用 xterm 资源，因此复用 Web 当前 Ghostty 离线 JS/WASM，不新增依赖，不手写 ANSI parser，不用文字输出冒充终端。

`TerminalView` 虽挂 `SortableTabsStrip`，**没有传 onReorder**，当前该终端没有启用 Web 拖排。Native 已按同一产品范围移除 drag/drop interaction、delegate 和页面 reorder 入口；Tab 继续使用 stable ID、原生横向 scroll 及既有 catalog 顺序，不删除或改排已保存的 journal。

已读 dedicated `MobileApp.tsx` / `MobilePhoneShell.tsx`：未找到 terminal 入口；现有入口在通用 Header/MainLayout。**不新增第五个主 Tab**。终端与 Action 的 workspace 菜单入口及产品全能力归属由 main 核实。

## 文件所有权

| 模块 | 职责 |
| --- | --- |
| `terminal-core.ts` | constructor 捕获 opaque scope；目录/Tab、receipt、创建/关闭/暂停/恢复、Action/preview orchestration |
| `terminal-catalog.ts` | Host 分区、metadata-only 序列化/校验；没有 lease、command、output、URL 持久化 |
| `terminal-actions.ts`、`terminal-discovery.ts` | 现有 Action 结构与命令规范化；只读发现算法，I/O 注入 |
| `terminal-preview.ts` | Web 纯扫描算法保留版；parity fixture 核对当前 Web owner；不导入浏览器 transport |
| `terminal-presentation.ts` | 一个已 ACK 输出批次在途，live 增量而非反复传全部 scrollback |
| `terminal.tsx` | root workspace 与 native route adapter；**无 NSH WebView**；原生页面消息、生命周期和所有操作接至相同 controller |
| `ios/TerminalBridge.swift` | Foundation PTY owner、scope admission、receipt journal、WS/SSE、串行输入、有限 route enum |
| `ios/NativeTerminalPreview.swift` | 唯一终端专用 WKWebView、固定离线文档、导航/弹窗/网络拦截、原生 Tab/keys/actions/status |
| `terminal-offline.mjs` | build owner 可调用的离线本地资源 staging；JS/WASM/license 与 SHA-256 manifest |

## 原生 opaque admission 与最窄 transport 注入

`TerminalBridge(capture:emit:catalog:)` 的 `capture` 参数是 **现有 RuntimeHostScope**。生产 closure 调用已实现的 `RuntimeBridge.terminalTransport(expectedHost:)`，内部统一同步 `admit(expectedHost)` 后返回 `TerminalTransport`。不能用 JS generation、hostID 相等或请求开始时的单次猜测替代 admission。

`TerminalTransport` 必须捕获该原生 scope，其 `isCurrent()` 由真实 native authority 判断 lease，覆盖 A→B→A、前后台 lease 轮换及 transport 切换。Feature 对每个非 cleanup handler 重做 capture/admission；await 后检查 captured transport。旧 root 失效后 root 从新 native snapshot **重建** workspace，不能把新 lease 填回旧 controller。

| 注入字段 | 必须实现的实际行为 |
| --- | --- |
| `expectedHost` | admitted 的 RuntimeHostScope，不能从 JS 重建/签发 lease |
| `isCurrent` | 同一个 native scope 的权威有效性判断 |
| `request(TerminalRequest)` | 复用认证 HTTP；使用 enum 的 method/path/body，input 使用 `text` 和 `contentType=text/plain`；其它 JSON；收包过程 ≤64 KiB、有限 deadline、redirect/同源策略 |
| `open()` | **仅** `/api/terminal/ws`；复用认证直连或已授权 pairedRelay E2EE mux；保留 text/binary 类型，每帧收包过程 ≤1 MiB；失败/关闭结束 receive |
| `stream(sessionID)` | 可选：**仅** `/api/terminal/:id/stream`，同一认证 transport；解析真实 SSE data JSON，忽略 comments；收包/事件有限；404 明确抛 sessionNotFound；取消真的释放流 |
| `optionalFile(directory,name)` | 可选：认证 `/api/fs/read?path=...&directory=...&optional=true`，name 由 feature 固定 allowlist；只在权威不存在时返回 nil，失败抛错；收包过程 ≤1 MiB |
| `freePort()` | 可选：认证 `GET /api/system/free-port`，验证 port 或权威 nil；不启动进程 |

`request` enum 只允许 create、resize、DELETE close、text input、**带确切 sessionId** 的 force-kill，以及 loopback probe。绝不提供无 ID 的全局 force-kill、任意 request route 或 shell-execute。

WS upgrade 无法携 header 时，短期 scoped URL token 仍由 RuntimeBridge 既有认证路径处理；不能传 JS、不能长期 token 入 URL。pairedRelay 必须使用已授权 E2EE 子流，不允许该 feature 以 direct fallback 绕过配对。SSE/HTTP fallback 仍在同一注入 transport 内，**不是 Relay→直连**。

`terminal.capabilities` 返回 `scope=native-opaque/wsVersion=2/durableMetadata/httpInput/sseOutput/actionDiscovery`，源自实际注入能力；缺 scope 或旧 native 不开放写入。`optionalFile/freePort` 缺失时 discovery 报 unsupported，不假装目录为空。

`terminal.detach {expectedHost,owner,attachment}` 对比 Session 原注册 scope 和严格正整数 attachment receipt，不要求新 Host admission、不发网络写入；缺失或非法 attachment 拒绝，旧 scope 即使 owner/attachment 相同也不能关闭新 lease 的流。workspace 之间 attachment 单调唯一，同一 Session 重复/倒退 attach receipt 拒绝。`terminal.preview.finish {owner}` 仍是独立唯一 surface owner cleanup。

### main 最小 Swift 接线（本次未修改或运行）

```swift
let terminal = TerminalBridge(capture: { expected in
    try runtime.terminalTransport(expectedHost: expected)
}) { [weak app] event in
    app?.send("terminal.event", event)
}
terminal.register(app: app)
let terminalPage = NativeTerminalPreview(presenter: controller, bridge: terminal) { [weak app] event in
    app?.send("terminal.preview.event", event)
}
terminalPage.register(app: app)
```

main 强持有两个 owner；现有 invalidation 链**追加**两个 `invalidate()`，不得替换其它 owner；原生 lifecycle 调 `terminal.setForeground(false/true)`，后台同时 `terminalPage.invalidate()` 释放 WK surface。页面 adapter 也根据真实顶层路由和 lifecycle 暂停。若 native lease 因 lifecycle 轮换，main 必须重新读取 scope 并重建 controller，不以 resume 事件续用旧 lease。

预览网页沿用既有 resource preview/external owner：TS 注入 `openPreview(scope,directory,url,mode)`，mode 是 preview 或 external；Swift 可用 `terminalPage.contentPresenter` 作为当前终端内资源预览的 presenter。localhost 指 **Host**，必须走既有认证 preview proxy/Relay；不能由手机 WKWebView/URLSession 直接访问手机 localhost。本模块只给目标、用途和捕获 scope，不重写资源预览系统。

## 固定离线 WK surface 与打包接线

main 后续已在 `scripts/build-ios.mjs` 的 NSH bundle staging 后调用 `stageTerminalOfflineResources(staging, workspaceRoot)`，仅从现有本地安装包复制资源。`terminal-offline.test.ts` 与主程序 SDK 检查共 3 项通过，构建脚本语法检查通过；随后 `ios:build` 成功，实际模拟器 App 内三个资源大小/SHA-256 与 manifest 一致，codesign strict/deep 验证通过。认证 transport、能力注册、页面入口和 lifecycle 尚未因此自动接通，打包成功不代表可运行真实 PTY。

生产 `NativeTerminalDocument` 只从 Bundle 读 `terminal-ghostty.js`、`terminal-ghostty.wasm`，不接收 JS 传入 HTML/JS/assets，不调用 `Ghostty.load` 的 fetch 回退。JS 只见终端消息 handler `window.webkit.messageHandlers.terminal`，没有 NSH/main `host.call` 桥。

WK scheme 仅允许唯一随机本地 entry 的 GET；导航 delegate 只接纳该初始顶层文档一次，之后所有导航、iframe、redirect、popup 均拒绝；UIDelegate 不创建 popup。WKContentRuleList 阻断 http(s)/ws(s)/file/ftp；CSP `connect-src/frame-src/worker-src/object-src/form-action/base-uri 'none'`；nonPersistent data store。纯 Foundation 测试执行实际导航 admission 函数，SDK 检查实际 delegate 声明，但未运行 WK。

固定 bootstrap 从本地 base64 WASM compile/instantiate，输出只送 Ghostty.write，不当 HTML；中文 composition 中间态不发，end 后提交一次。硬件 Meta 字母不转 control：有 selection 的 Command-C 复制且零 PTY，Command-V 保留系统 paste；软 Cmd modifier 仍走现有 quick-key 合同。paste 读取同一 Ghostty 实例的 `hasBracketedPaste()`，开启时对完整 clipboard text 包一次 `ESC[200~`/`ESC[201~`。硬键/软键 beforeinput/终端 query-response 同一受控 input lane；hide 不接受输入。Tab/keys/actions/status/关闭均由 UIKit 所有，不把主界面搬入 WebView。

输入 lane 以 UTF-8 字节计数：单次最多65,536 bytes，core 不再用16,384个字符静默截拒。bootstrap 只允许一个 native receipt 在途，含在途最多4项/262,144 bytes；`terminal.preview.render {inputResult:{key,receipt,status}}` 复用现有渲染 capability 返回 accepted/rejected/unknown。超限/满队列不清 textarea并发出明确 inputRejected 状态；已排队但未接纳的文本在拒绝或未知时恢复到相应 Tab 的 textarea。unknown 暂停整个 lane，尝试项和后续项均不自动重放，重复/迟到回执不能再次恢复文本。恢复文本可供复制；恢复交互流需显式重建 surface，不能把未知文本自动补发。本实现不分块输入，因此不拆 UTF-8/Unicode 边界或为粘贴重复加 bracket。

Tab切换或live=false时，先把所有尚未发送项按原key/顺序前置回其draft，再保存当前textarea与切换key；队列只保留已发送的精确receipt和当前Tab新接纳的待发送项。迟到accepted只结算原receipt，随后允许当前Tab发送；rejected仅冻结并恢复原Tab，不阻塞其它Tab。恢复文本前置于该Tab的新编辑，不覆盖新draft；同一旧回执不能结算新Tab的receipt。任何unknown仍冻结整个lane，将各Tab队列文本分别保留，不重播。关闭A切至B走同一key切换合同，A后缀不能留在B队首，也不会改成B输入。draft属于当前document内存，不写journal、不自动复活关闭的PTY；切回draft不自动发送。桥接字段与capability没有新增。

build owner 加入 `ios/NativeTerminalPreview.swift`、`ios/TerminalBridge.swift` 和 `ios/TerminalTransport.swift`，并从本地安装包 stage 资源。可选最小 hook：

```js
import { stageTerminalOfflineResources } from './terminal-offline.mjs';
await stageTerminalOfflineResources(appResourcesDirectory, repositoryRoot);
```

hook 仅读本地 `node_modules/ghostty-web` 0.4.0 的 UMD JS、WASM 和 MIT license；不 install/download/build/执行 shell。生成三个固定文件和 manifest（只含包相对路径、大小、SHA-256）。测试只 stage 到 OS 临时目录，**未改 main build、未生成应用包**。

host capability 精确加入 `TerminalBridge.register` 和 `NativeTerminalPreview.register` 中所需 handler 名称；不因此开启通用 NSH webview/mainbridge 或任意网络权限。本次没有修改 `nsh.json`。

## root/路由 TS 接线

```tsx
const terminal = await createNativeTerminalWorkspace(capturedNativeScope, openPreviewThroughExistingOwner);
// await 后 main 再核对该 scope 仍为当前 native snapshot；不采用迟到的旧 root。
<NativeTerminalPage workspace={terminal} scope={capturedNativeScope}
  directory={actualSessionOrWorktreeDirectory}
  active={isActualTopRoute && isForeground}
  palette={currentHostTerminalPalette} fontFamily={currentHostMonoFamily}
  fontSize={currentHostTerminalFontSize} actions={actualProjectActions}
  onClose={returnToRetainedSourceRoute} />
```

root lifetime 持有 workspace；菜单打开不重建 PTY；退出菜单路由只 detach；Host/lease 退役后 dispose，再用新 scope +同 Host journal 重建。actualProjectActions 来自现有项目配置 owner，不能把静态 demo actions 塞入生产。Native 模块提供 auto-discover，调用注入文件读/free-port，不新建 shell endpoint。配置编辑、primary action 的现有设置归配置 owner，本模块不复制其持久化系统。

## 已实现行为与错误语义

- **恢复**：native Application Support 原子 metadata journal 按 hostID 分区；create receipt 先记 native journal，再返回 JS；close 成功后删除确切 receipt；异步旧 metadata 写入不能盖掉 native 较新 receipt。进程重开只恢复元数据，buffer/cursor 从零；`terminal.restore` 必须在 native journal 找到 owner+目录+PTY 三者匹配，不接纳 JS 任意 PTY id。
- **创建未知**：create 前持久化 unknown marker，响应不确定不自动 create 第二份。Journal 写失败不启动新 PTY，显示失败并保留 marker。未知远端 ID 无法证明已关闭时不隐藏失败；不发全局 kill。
- **恢复过期 PTY**：只有权威 SESSION_NOT_FOUND/404 才为恢复页重建；瞬时失败不擦 receipt、不假空成功。退出保留 code/signal 与可见 buffer，不自动运行 Action 或重放命令。
- **WS/SSE fallback**：create 明确非 WS stream 时直接 SSE；否则默认 WS。未 bind、未写输入的 upgrade 失败可转 SSE。已经可能写入的 WS input 失败不经 HTTP 重发。SSE connected 后才能 HTTP input，content-type=text/plain，输入顺序串行且队列有界。
- **replay**：WS `r` 是 server replay cursor，UI chunk ID 是独立递增序列，SSE 不伪造 server cursor。SSE 无输出 replay 属于真实后端限制，connected 显示 replay_unavailable；WS 缺号显示 replay_gap，不制造补齐输出。
- **生命周期**：切 Tab/目录、隐藏、返回、后台关闭读流但不 DELETE；resize 合并未发送中间尺寸且不 rebind。Native 15 秒 connect/bind deadline、20 秒 p/po、60 秒 WS receive deadline；SSE 注入 owner 必须维护真实底层 heartbeat/liveness 与取消。
- **Action**：规范化按实际 Web owner；绑定成功后一次发送，armed/sending/running/waiting-for-preview/stopping/unknown 独立状态；未知输入不重跑。停止先 Ctrl-C，一秒后只 force-kill 同一 receipt；中途退出不再 kill。等待 URL 15 秒后结束 waiting 状态，但仍可稍后发现 URL。
- **发现**：已配置 dev action 优先→脚本 dev/start/preview/serve/develop→packageManager 或 lockfile→静态 index + free-port。只读失败抛错，不能把失败当无文件；最终命令仍仅在用户显式 Action 后走 PTY input。
- **preview**：普通终端完整行扫描/ANSI/Python 端口与 Web 纯 owner parity；probe 走真实 Host API。late probe 按 scope/attachment/session/Tab fence 丢弃。Action 输出 URL 使用实际 ProjectActionsButton 的 port/local/root 排序，普通 Action 交 external，auto-discover 交 preview，每次 run 只自动打开一次；custom HTTP(S) URL 同样交既有资源 owner，绝不在终端 WK 导航。凭据 URL 拒绝。
- **顺序**：沿用 catalog 与原有顺序操作合同；Native 不提供 Web 未开启的拖排 UI。
- **输出预算**：单 Tab 约 1,000,000 字符 bounded buffer；最多一个 ACK batch 在途，通常 ≤64 Ki 字符（大单 chunk 保持完整）；一个 live chunk 正常跨桥一次。10,000-event 计数回归不等于帧率测试。

## 实际验证与仍须闭环的事项

最新队列修复验证仅运行pure/DOM/Foundation/SDK：显式选取9个terminal feature测试文件，**9文件44项全部通过**，其中生产bootstrap DOM为14项。新增8项在修复前全部失败，修复后覆盖A→B/关闭A的accepted/rejected/unknown迟到、新编辑/回执隔离和4项/UTF-8边界预算。没有运行runtime或loopback测试、真实Host或网络，也未修改RuntimeBridge或Relay。

上一批完整命令：`node node_modules/vitest/vitest.mjs run --config packages/nsh/vitest.config.ts packages/nsh/terminal`，**11 个文件、113 项中 112 项通过、1 项失败**。当时失败为真实 Relay mux 的 1MiB 入站在 main 所有 `NativeSocketInbox` 的 512KiB 单帧限制触发 overflow，未降低验收尺寸。该批证据不作为本轮Relay状态的新结论。覆盖真实 iOS SDK typecheck（声明式 NativeShell stub，不是 engine）、真实 NSH public TypeScript SDK、纯控制器、DOM/Ghostty fake 上的 IME/keys/paste/输入接纳/ACK/触摸滚屏、纯 preview parity 和离线 staging；生产 transport 测试使用 URLSession 与真实 Host E2EE mux，后端为合成 loopback，不运行 PTY。

**当前未接入/未验证，继续属于完整交付范围，不裁 MVP：**

1. main 的 capabilities 注册、lifecycle/invalidation、workspace 菜单路由、scope snapshot 采用和精确 host capability。认证 `TerminalTransport` 已实现并完成下述 loopback 验证，Bundle staging 由 main 报告构建证据；主应用实际接线仍须 main 闭环。
2. Relay 完整 1MiB 入站阻塞；部署环境 direct/pairedRelay WS/SSE/HTTP，真实 PTY create/input/resize/exit/close、真实进程重启恢复、后台 lease 轮换及 Host A→B→A 全链。已通过的合成 loopback 和原生 admission 测试不能替代这些证据。
3. 真 UIKit 原生 Tab/滚动/触摸取消、native modal 与 resource preview 叠层/返回；中文/emoji、多段粘贴、软硬键盘、旋转/IME resize、系统剪贴板、选择复制、等宽字体和 ANSI 颜色逐帧对齐；大量输出的帧率/背压与长时保活。DOM fake验证了生产bootstrap事件与core接纳行为，不能替代WK/UIKit真实剪贴板或终端引擎模式验证。
4. 外网 Action 自动打开与自定义 URL 的 external/preview 回调已经实现，但真实资源 owner 的外链策略/手机 presenter 仍须 main 接通和验收。桌面 SSH forwarding 是 desktop-only，不给手机编造该能力。
5. 当前 Native Tab 原生控件的真实 icon artwork/选中材质与 Web 同状态视觉还未核验；项目 Action primary-selection/编辑入口仍由现有配置 owner/main 装配，未用 terminal 新造设置页替代。
6. build staging 生成 SHA manifest，但 Native 当前验证固定 Bundle 文件名、内容上限/WASM header，未在加载时额外校验 manifest SHA；资源完整性仍依赖实际签名 Bundle 与 main 打包检查。

Context7 查询配额不可用；按当前本地真实 d.ts/源码和 Apple SDK核对。当前工具发现没有可用下派接口，因此**无独立 readonly subagent 审查**；仅自查与可复现测试，不能宣称多层审查完成。未运行 `bun run dead-code`：脚本使用 bunx 下载路径，本任务禁止网络/新依赖；且当前入口仍待 main 挂载。
