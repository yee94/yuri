# Desktop BTW 产品视图与 Host 接线

## 产品入口（不是测试页）

### 当前 application 装配

- 根创建一次 `createDesktopBtwWorkbench`，消费 `loadNativeDesktopHttpGrant`，不用 JS bool 或普通 `runtime.request` 冒充可取消 HTTP。registry 通过动态 getter 读取实际 action，未 ready 保持 unbound。
- coordinator 只维护一个 active-target port 和一个 opening ticket；先登记 ticket 再打开真实工作台 tab，由产品 `onHandle` 结算。关闭、Host/route/runtime 退休和模态撤销会结算为 rejected，不使用轮询或虚拟 handle。
- product 的所有 turns/quotes/selection 仍在原 store，根只发布原 Chat 的 selection 只读 getter。侧聊不会构造另一 Chat/主输入/主消息流，也不会消费主附件。
- `desktop-btw-speech` 复用原 Chat 音频 owner，按 exact session/turn 命名空间区分音频；resume/restart 确认后复验 controller，旧 panel 不得停止新主消息音频。该适配不读取第二份语音配置或自建音频队列。
- `desktop-commands-application-native.test.ts` 当前合成主根已覆盖两平台实际打开、model→Agent→generate、跟进 history、bare 零 generate、主 writer/附件/stream 隔离、Settings/Search/Help 保留两份草稿并禁用侧聊动作；内部合计 44 场景。coordinator/runtime 两文件 27 项通过，新增 speech 单测 5 项通过；不代表真实模型、系统音频、OS 网络取消或视觉签收。
- 当前 Web `BtwComposer` 的模型栏只读，没有模型/Agent picker。生产根使用 `NativeDesktopBtwSelection` 显示同一快照的 `NativeModelLogo` 和模型名；名称只消费主 Chat 已有 catalog owner 的双 ID 窄投影，不新增读取。引用文本的真实选区入口仍受 NSH 0.4 公共 API 限制，不能由 generate 通路通过推定全部 BTW UX 已完成。

`desktop-btw-panel.tsx` 导出 `NativeDesktopBtwPanel`，直接显示唯一的 `createNativeBtwStore`。`desktop-btw-panel-core.ts` 只有准入 handle 和 registry action，没有第二份 turn store、sender、模型目录、音频或 transport。iOS 原路由不变。

逐区参考 `ui/src/components/layout/BtwPanel.tsx`：

| Web 区块 | Native 产品消费 |
| --- | --- |
| 用户问题、已提交 quotes | 右侧 elevated bubble；问题用 literal `TextViewDocument`，不把问题解释成 Markdown，保留换行与可选择文本 |
| Markdown 回复 | NSH 0.4 `TextView`、现有 transcript typography；CommonMark/GFM、原生可选择正文、横向代码区及内置 code-copy/check 反馈 |
| footer | 24pt 操作、14pt glyph；全文复制、注入的朗读/停止、最后一轮 retry；直接共享 `turnDurationFormat.ts`，同一绝对时间格式、桌面 hover 显示 timestamp |
| 空、pending、失败、取消 | 真实 owner turns；通用错误翻译、原始可用错误说明、最后一轮原位 retry；无 generate 显示 unavailable，保留问题/quotes 且不制造 turn |
| quote chips | 单行折叠空白预览、独立删除；发送仍使用完整原文；10 个去重 quote 上限归原 store |
| 编辑器 | NSH multiline `Input`，Enter 提交、Shift/Alt+Enter 换行；IME composition 不提交，paste 保留换行；pending 时仍能编辑下一份草稿 |
| 模型栏 | 与 Web 一样，只读模型 logo/名称，不显示 Agent/variant，不构造 picker；内部 selection 仍是完整发送快照 |
| panel/page | 同一产品正文/编辑器，不重新创建 owner；无自制窗口、WebView 或手机 sheet 路径 |

原生 List 的 `maintainVisibleContentPosition={{autoscrollToBottomThreshold:48}}` 是唯一几何 owner：底部附近跟随回答，离底保阅读位置。不添加 timer、offset 补偿或第二个 JS scroll writer。隐藏保留 List/草稿/owner；真实 AppKit/Win32 的阅读几何、字体、连选和高亮仍需逐帧验收。NSH selectable 的合同是每个 block，不能宣称支持跨不同 block 连选。

## Exact props / handle

必填 props：

```ts
{
  store: NativeBtwStore;
  scope: NativeBtwScope; // sessionId, directory，runtime 可由 store 捕获
  authority: string;    // 实际 Host/page 操作身份
  current: () => boolean; // 当前 captured Host/lease/target 是否仍有效
  active: boolean;      // 仍属于实际 session；不是“是否选中了 BTW tab”
  interactive: boolean; // 前台且没有 Settings/Search/Help/关窗等拦截
  visible: boolean;     // 当前确实显示 BTW 内容
  onClose: (capturedScope: NativeBtwScope) => void;
}
```

可选：`foot: 'panel'|'page'`、`onHandle`、`renderSelection`、`modelLabel`、`onChooseModel`、`onChooseAgent`、`speech`、`copy`、`onOpenLink`。所有具体类型以 `desktop-btw-panel.tsx` 为准。链接只报告给 owning preview/browser router，不偷偷以客户端 localhost 打开 Host 服务。

调用方在真实 scope 下挂一次，**不要**用 `{visible && <NativeDesktopBtwPanel/>}` 或把 `active` 绑定到 tab-selected。scope/authority 改变才换子 owner；切 tab 只改 visible 并保留侧聊；模态只改 interactive；关闭面板或 BTW tab 清除该侧聊。关闭面板时保留同一 mounted handle/port，重开不沿用旧 turns/quotes。离开 session/后台/current 退役取消当前回答，保留已完成 turns。cleanup 取消但不 clear；根 owner 在 runtime reset/dispose 时释放整个 store。

`onHandle` 发布：

```ts
onHandle={next => {
  btwHandle = next;
  return () => { if (btwHandle === next) btwHandle = null; };
}}
```

不能由旧 owner cleanup 无条件写 null：NSH keyed replacement 可能先发布新 handle，再清旧 owner。

handle 提供 `scope/current/ask/retry/cancel/addQuote/setSelection/close`。ask/retry 返回**是否同步接纳**，不是模型成功 receipt；结果只从同一 store 观察。所有 mutation 在 core 复验 current/active/interactive；ask/retry 还要求 visible、非 pending、真实 generate。close 即使 tab 隐藏也能清该 exact scope 的 turns/quotes/side selection，再通知 owning tab controller；旧 handle 无权关新 tab。captureScope 固定 transport/generation，迟到 cleanup 不取消新代请求或清新 Host entry。

`createNativeDesktopBtwAction({open(invocation)})` 的 `open` 返回 `NativeDesktopBtwHandle | null | Promise<NativeDesktopBtwHandle | null>`，`run` 统一异步。main 激活相同 session/目录的真实 BTW tab；首次挂载时等待 `NativeDesktopBtwPanel.onHandle`，不能同步造 handle，也不要求提前挂载隐藏的产品。action 在 await 之后重新检查 invocation.current、handle.current 和 exact session/目录，然后仅有非空 tail 才调用该实际 mounted handle.ask。裸 `/btw` 只打开、零 generate；open 抛错/reject/null、关闭/退休/错目标/迟到 handle 都 rejected。registry 的原文 CAS 在 open 前完成，await 不再消费文本，新稿不被晚到结果覆盖；registry writer/current 语义未改变。

main 每 window/scope 只持有一个有界 opening ticket，在真实 onHandle 发布时结算；Host/route 退休、tab close 或挂载失败须 reject/释放该 ticket，不使用 timeout 轮询、虚拟 handle 或默认 available。同步 `open`、少参 callback 仍兼容。未具备真实 grant/runtime 的 consumer 仍保持 unbound；即使 tab 已打开，空面板也不能冒充已接纳的问题。action 只等待 mounted admission，不 await generate，不持有主 chat writer 长 lane。

## 选择与朗读 slot

`NativeBtwSelectionSlot` 是 `{selection:()=>NativeBtwSelection|null,pending:()=>boolean,current:()=>boolean,setSelection(value):boolean}`。这是内部完整快照的窄合同，不意味着产品提供 picker。`NativeDesktopBtwSelection` 只读它，不加载目录或调用 setSelection；精确匹配 `{providerID,modelID}` 的名称投影才可采用，否则用共享 formatter。provider/model/variant/Agent 为**一个完整快照**；generate 前 await applySelection，失败不继续 generate。不得从 UI Agent、全局 model、另一个 session 的 variant 各取一段拼接。

`speech` 是 `{state(messageID),speak(messageID,text),stop(messageID)}`，state 返回 idle/loading/playing/error。main 将已有 Chat speech owner 按 exact messageID 适配，仍由它管理 resume/restart、设置可见性、错误和真实音频。只在允许显示朗读时提供该 prop。Panel 不 import/createNativeSpeech，不读取语音设置或自建音频请求；隐藏/退役停止它自己正在播放的 BTW message，不停止其它会话。未注入时不画假的 disabled 朗读按钮。

## 官方 SDK / wire 证据

本次读取的安装包为 `@opencode/client@2.2.0`（`node_modules/@opencode/client/package.json`）。UI 的 `generateSessionAside` 在 `ui/src/lib/opencode/client.ts:811` 调用官方 `client.session.generate({sessionID,prompt},{signal})`；此版本不是 generic plugin RPC 调用。

直接执行安装的官方 `OpenCode.make`，只替换 fetch 的 `desktop-btw-wire.test.ts` 固定了以下事实，不访问网络：

```text
SDK: client.session.generate({ sessionID, prompt }, { signal })
HTTP: POST /api/session/${encodeURIComponent(sessionID)}/generate
JSON request: { "prompt": "..." }
200 JSON response: { "data": { "text": "..." } }
SDK resolved value: { text: "..." }
```

源证据：`dist/chunks/service-timing-wcsbjfhx.js:527-534` 的 generated Promise method；`:16-45` 保留 headers、JSON content type 与原 signal；`:58-70` 校验 status。`dist/chunks/service-timing-rxd7awy0.js:181` 的 Effect 方法映射 raw `session.generate`，path param=sessionID、payload=prompt。不要把 SDK input 的 sessionID 再塞进 HTTP body，也不要包成 `{input:...}`；通用 `/api/rpc/{rpcID}/{method}` 是另一种插件合同。

UI `applySendSelection`（同文件 `:839-849`）按 model → Agent 顺序操作，失败不 generate。安装的 generated methods `service-timing-wcsbjfhx.js:323-338` 为：

```text
POST /api/session/<encoded-id>/model   body: { model: <captured complete model ref> } -> 204
POST /api/session/<encoded-id>/agent   body: { agent: <captured agent> } -> 204
POST /api/session/<encoded-id>/generate body: { prompt } -> 200 { data: { text } }
```

directory 不在 generate body/query 中；它只用于 captured target fence，不改变全局 currentDirectory。Native port `generate(scope,{sessionID,prompt},{signal})` 是 SDK 形状；`desktop-btw-runtime.ts` 负责一次 wire 转换，并解包一次 `data`。安装 SDK 的执行测试同时覆盖 switchModel/switchAgent/generate，`SessionSwitchModelInput.model` 的实际结构是 `{providerID,id,variant?:string}`，不是 `{modelID}`。网络/认证/actor 仍归原 Host，不增加 sender。

官方在线 client guide `https://opencode.ai/docs/build/client` 亦明确 final request options 的 AbortSignal。Context7 本次配额耗尽，未用其返回内容猜 route；最终 wire 依据当前安装包执行证据。

## Rust 同 actor 的可取消 HTTP（已实现 seam）

`desktop-host/src/http_jobs.rs` 已由 main 接入原 `bridge.rs` Actor。**原先“普通 HTTP exact-request cancel 尚待 Host 提供”的阻塞已解除**，不是新增网络引擎或独立 sender。只读核对了 capabilities/request/cancel、`Completion::HttpReceipt`、bind-before-fetch、finish/fail/invalidate 的当前源码。

具体 Host API：

```ts
host.call('runtime.http.capabilities', {})
// => { version: 1, request: true, cancel: true, windowID,
//      maxRequests: 4096, maxConcurrent: 8, timeoutMs: 30000 }

host.call('runtime.http.request', {
  ownerID, requestID, windowID, expectedHost,
  path, method: 'POST', body: { prompt }, // method/body 可省略；此处示例为 generate
})
// => 原 { status, body }，不额外解包 body.data

host.call('runtime.http.cancel', {
  ownerID, requestID, windowID, expectedHost,
})
// => { ok: true }
```

- capabilities 只接受空对象；windowID 来自真实 native window，不由 TS 猜测。request 必填四身份字段和 path，只额外允许 method/body；cancel 仅允许四身份字段。三项 ID 非空、最多 128 个 ASCII 字母/数字/`_`/`-`，window 必须 native exact；expectedHost 使用 `policy::scope` 并由原 actor 校验当前 committed lease。额外字段（包括 headers、URL、signal）不能穿入该 envelope。
- method 默认 GET；允许集合仍由原 actor 的 METHODS 决定。path/认证/同源/redirect/JSON response policy 复用原 `make_request` 和响应处理。generate 使用上节已证实的 POST route、HTTP body `{prompt}`；成功从 `{status:200,body:{data:{text}}}` 校验/解包一次得到 store port 的 `{text}`。
- `Actor::start_job` 在 `Network::fetch` **之前** `Book::bind`；`Completion::HttpReceipt` 保存 exact Key/ticket，复用原 8-job 槽、30 秒 deadline 和原 64-message actor queue，不创建第二套容量或队列。
- cancel 在同 actor 校验全部身份，`Book::cancel` 先使 running receipt 不再 current，再按该 ticket remove 对应 job、`fail_job`/task.cancel、结算原 reply。`finish`、`fail_job`、scope `invalidate` 都保留 Book 的生命周期 tombstone；旧/重复 cancel、晚到 End 不能取得另一个 job。`runtime.stop` 仍只取消 SSE，`resources.cancel` 仍只取消资源读取，不挪用它们或主 session abort。
- `{ok:true}` 是该 exact receipt 的取消处理 ACK；可能只是记录 pre-cancel，或请求已终态。它不代表已有业务效果回滚，更不保证服务端模型停止计算。actor 调用 task.cancel 与 JS 丢弃迟到结果是不同层；实际 OS 网络和模型端行为仍须实测。

### Final helper 合同

`http_receipts.rs` 的 `Key/Book` 已 final，源码合同不变：Key Clone/Eq、严格 envelope/native window/规范化 scope；Book 只有 reserve/bind/cancel/finish/current，无 Vault/Network/task/HostReply 或 capability 注册。requestID 全生命周期至多 4096 个且不淘汰；已绑定 ticket 亦不复用。scope retire 逐 job finish/cancel，**不清空/重建 Book**。

新 reserve 为 true；匹配 pre-cancel 的首次 reserve 为 false 且消费该 tombstone，之后 reserve 拒绝 reused。bind 为 false 或 error 均不得 fetch。cancel 仅返回一次 exact running ticket；cancel 后 current=false，迟到 finish=None。错误为稳定的 `http_receipt_invalid/stale/reused/capacity`。独立 `examples/http_receipts_contract.rs` 执行生产 helper 和真实 policy，16 项通过（13 helper + 3 policy）；没有修改 main 的 http_jobs/bridge/main。

### 已冻结的 HTTP / BTW factory API

`desktop-http.ts` 是唯一生产 NSH loader，调用真实 `host.available()` 和 `host.call('runtime.http.capabilities',{})`；grant 只由成功的实际调用签发。`desktop-http-core.ts` 的 WeakMap 保留原 source/current，复制或伪造 capability 对象不能创建 client。无 manifest grant、unsupported、loader 失败、畸形能力或等待期间 source/current 退休均返回 undefined。capability 只证明 native 支持，不替代 expectedHost 的原生授权与 main 的真实窗口/页面 current；iOS 未实现该能力时明确不可用，不回退 legacy 请求。

冻结入口：

```ts
// Production: import from './desktop-http'
declare function loadNativeDesktopHttpGrant(options: {
  current: () => boolean;
}): Promise<DesktopHttpGrant | undefined>;

// Pure seam, for strict Host tests: import from './desktop-http-core'
declare function loadDesktopHttpGrant(options: {
  source: () => DesktopHttpSource | undefined;
  current: () => boolean;
}): Promise<DesktopHttpGrant | undefined>;
declare function createDesktopHttpClient(options: {
  grant: DesktopHttpGrant | undefined;
  expectedHost: RuntimeScope;
  current: () => boolean;
  onIssue: (error: DesktopHttpError) => void;
}): DesktopHttpClient | undefined;
// client: { windowID, current(), request({path,method?,body?},{signal?}?), retire():Promise<void> }

// import from './desktop-btw-runtime'
declare function createDesktopBtwRuntime(options: {
  grant: DesktopHttpGrant | undefined;
  expectedHost: RuntimeScope;
  scope: NativeBtwScope;
  runtime: () => NativeBtwRuntime;
  runtimeScope: () => RuntimeScope | null;
  current: () => boolean;
  onIssue: (error: DesktopHttpError | DesktopBtwResponseError) => void;
}): DesktopBtwRuntime | undefined;
// port: { current(), dispose():Promise<void>, applySelection, generate }
```

`DesktopHttpSource` 只有 `available()` 与 `call(name,input,{timeout})`，不接受 endpoint/auth/header/fetch。生产入口不接受注入 fake source；测试才使用纯 core loader。native call options 分别为 capabilities 5000ms、request 40000ms、cancel 10000ms：request 比 actor 的 30 秒留出回执传递余量；不改变 `runtime.ts` 或全局默认 timeout。

grant/client 一旦观察到所属 source/current 退休即永久失效；旧 callback/source 再出现也不能复活。current 表达真实操作 lifetime，不拿 visible/interactive 的暂时隐藏冒充退休；新窗口/新 lease 的 operation 使用新准入，不能复用旧 client。

main 在 exact grant ready 后，把 `{applySelection:port.applySelection,generate:port.generate}` 交给**既有唯一** `createNativeBtwStore` 的 options，并以 `port.current` 参与对应 Panel/current 准入，不创建第二 store。跨 target 的既有 store 由 main 的 scoped port 装配处理，不能把某一 target 的 port 用作其它 session 的默认 sender。能力未 ready/失效时不发布可执行 registry action。离开 owner 时先撤销 opening ticket/action 并触发原 store.cancel，再 `await port.dispose()`（保留错误处理）；dispose 只取消该 client 的未结算 exact slots，已完成请求不重发 cancel。

`applySelection(scope,selection,{signal})` 与 `generate(scope,{sessionID,prompt},{signal})` 共用 store 原 slot.signal；旧少参 applySelection callback 仍兼容。model 与可选 Agent 串行 204 成功后才继续 generate；variant Default/缺省不造字符串或 Agent。await 后逐阶段复验 Host lease、transport/generation、目录/session 和 signal；取消 model/Agent 等待不会晚到继续下一阶段。已收到的配置 ACK 不做假 rollback/补偿请求，generate 的返回值只进原 store slot。

legacy bindRawRequest/bindRequest 没有 signal 合同，不能仅把 AbortSignal 当额外参数传入便声称已采用新 seam。获得 main 的 grant 后，BTW captured generate adapter 使用同一 native window、captured expectedHost、唯一 ownerID/每请求唯一 requestID 调用上述 request；每次显式 retry 使用新 requestID，不复用终态 ID。非 2xx response 仍保留原 `{status,body}`，由适配器按 generate 的成功合同判断，不能转成空成功或丢失服务端错误 body。

ID 使用 NSH 0.4 实际支持的 `crypto.randomUUID()` namespace 加模块单调序号，不以时间/Math.random 回退，不复位或重放；跨 owner/window/lease 都产生新 requestID。原 native process 4096 lifetime tombstone 仍是最终不复用/容量权威，adapter 不淘汰或试图绕过。

发 request 前注册 AbortSignal listener；若已 aborted 则不派发。已派发后的 abort 只调用同一 captured 四身份字段的 cancel，处理完结注销 listener；不能在 await 后重新取当前 Host/窗口/selection 来构造 cancel。cancel-before-request 的跨队列顺序由 pre-cancel tombstone 兜底。queue-full/超时/取消 ACK 失败必须保留真实失败信号；即使本地 store 已撤销结果发布，也不能当作 Host 取消已确认，更不能自动重发 generate。

`DesktopHttpError` 保留 code、outcome、原 identity/original，不打印原 payload：`native_host_busy` request 是 `native/not-dispatched`；一般 native/timeout 为 `native/unknown`；cancel 失败或无效 ACK 是 `cancel-failed/unknown`；真实 ACK 仅给出 `aborted|stale/cancel-acknowledged`。`DesktopBtwResponseError` 保留 phase 和原 `{status,body}`，坏 envelope 不伪装空成功。必填 `onIssue` 仍接收退休 store slot 已不再消费的 cancel failure；main 不应因本地 pending=false 而宣称 OS/模型停止，也不得把原始敏感 body 直接写日志。已知错误和 unknown 只作结算/呈现，不自动 retry。

Host/helper 实现及下述生产回归已收口；剩余主 consumer 的 BTW TS/tab/selection/lifecycle 精确 grant 装配归 main，以及系统平台和实际模型验收，不再列作 Host API 或 helper 的未完成项。controller identity/signal/迟到结果 fence 继续保留，不因有 cancel ACK 而删除。`runtime.http.{capabilities,request,cancel}` 及上列 exact payload 不变。

## 验证边界

### 当前 HTTP/runtime slice 的执行结果

- Native focused 10 文件 **78 passed**：HTTP core、真实 store/runtime、installed SDK wire、异步 registry admission、Panel/core 与原 commands/timeline-model 回归。两个 native wrapper 内另实际运行 runtime **8 场景**及 Panel **8 场景**（macOS/Windows 各半），不是 78 个系统窗口测试。
- runtime 8 场景使用独立临时 `nsh.json`、真实 `loadNativeDesktopHttpGrant`/NSH 0.4/UUID/Host channel，包含实际 manifest denial、unsupported loader、首次延迟产品挂载后 onHandle 才 ask、裸命令零请求、保留新稿、model 阶段取消及退休 opening；未改生产 manifest。
- strict fake Host + 实际 store 覆盖 capability failure/bad caps/伪造 grant、SDK ModelRef/variant/Agent 完整捕获、model→Agent→generate 的逐阶段失败/取消、pre-start cancel、late End、busy/cancel failure unknown、exact old source/window/lease、同/跨 owner 与窗口的新 ID、原 signal listener 清理及非 2xx status/body。没有主 prompt/SSE/PTY/abort fallback。
- Web `useSessionBtwStore.test.ts` 与 `opencode/client.test.ts`：**64 passed**，包含 Native/Web store prompts 对照。未重跑此前七文件全套。
- 本线程只运行既有 Rust 测试、未改 Host 源码：精确 `bridge::tests::http_job_contract::` **5/0/0**；独立 helper example **16/0/0**。第一次误用较宽 `receipt_` filter 得到 16 pass/2 fail，两个失败均为其它 SSH IO fixture 未设置其专用临时 root；未放宽测试或读取真实 SSH 数据，随后改用 HTTP 精确 filter，不能把该宽筛选算作全部通过。本轮未重跑整个 binary/example 或 Clippy。
- `nsh:check` 在 adapter/native fixture 完成后曾通过，最后整包复验被并行工作树的 `composer-send-test-app.tsx:18`（frame possibly null）阻断；未改该其它 owner 文件。隔离 tsconfig 对本 slice 全部生产 source/fixture 的 `tsc --noEmit` **通过**。`dead-code` 已执行，但因 Web 配置缺 `vite-plugin-pwa` 加载失败；未加依赖绕过。

NSH 测试器串行 await Host handler，故 native fixture 的 wire response 立即结算，取消在实际 selection 等待 slot 内同步触发；人为延迟 ACK/End 和 cancel-failed 的交错由 strict fake Host + 生产 adapter/store 测试覆盖，不能声称 native headless 已验证 OS 网络中止。

`desktop-btw-panel-native.test.ts` 驱动真实生产 Panel，NSH 0.4 macOS/Windows headless 各运行产品场景；验证 50 次输入不重算模型 label、不发 generate/apply，quote 删除、literal paste、多行提交、编辑 pending 草稿、模型/Agent callback、代码区真实 Clipboard、footer/copy/speech、panel/page 切换、隐藏保留、错误/retry/cancel、active/current/background、旧 scope/Host handle 及无 generate。

`composer-local-commands.test.ts` 已通过真实 async history action 验证 immediate CAS 后 current 在 await 前后仍有效；实际实现不检查旧 revision 相等，**不存在所疑的 revision bug，未修改 registry writer/current 语义**。另用实际 BTW action+handle 验证 CAS 之后能调用，而无 generate 不能 accepted 生成。

既有 `ui/src/stores/useSessionBtwStore.test.ts` 同时执行真实 Web store 与 Native owner，逐字比较 quote、失败回合、12 回合 history prompts；40 entries / 50 turns / 10 quotes / LRU、captured generation、空响应与选择失败由 Native focused tests 覆盖。

此前产品视图轮次的验证快照：Native 13 文件 62 passed / 1 skipped（产品 wrapper 内包含 macOS/Windows 各四个场景），Web 7 文件 55 passed；最终样式及 close-stop 补充后 Panel 单独复验通过。该轮 UI type-check 通过；nsh:check 整组时曾通过，随后复验遇到并行 main 的 `application.tsx:1748` localCommands/catalog 接线诊断。此为历史执行记录，不据此断言当前 main 仍有该阻塞；本次 adapter 的实际执行结果以上节为准。

Host owner 的最新生产回归报告已完成（通过/失败/忽略）：

| 验证 | 结果 |
| --- | --- |
| HTTP focused | 5 / 0 / 0 |
| helper 独立 example | 16 / 0 / 0 |
| binary | 240 / 0 / 0 |
| example | 240 / 0 / 0 |
| all-targets Clippy | `-D warnings` 通过 |

HTTP focused 已覆盖真实原 64-message queue full 时 request/cancel 在 dispatch 前返回 busy、scope 退休、坏 JSON、redirect、late End，以及非 2xx 原 status/body；此前 exact receipt/pre-cancel/旧 lease 隔离、共用 8-job/30 秒、终态 ID 不复用和 capability 无 Vault/关闭失效证据保留。故不再把这些场景标作补验中。上表完整生产数字由 main 报告；本次只对原 Host 做 HTTP focused/helper 复验，没有修改原 actor。

headless 不证明真实 AppKit/Win32/IME、视觉 1:1、系统 Clipboard、音频播放、OS 网络取消效果或服务端模型停止；未启动原生窗口、没有访问真实 Host/模型/凭据。完整 PC 交付仍待 main BTW 消费已实现的 request/cancel seam 与系统平台验收。
