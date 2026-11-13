# 移动 GUI 插件本地渲染：页面代理库与最小中继接入方案

研究日期：2026-11-06。范围：Hammerhead、Ultraviolet、Scramjet；只读产品代码，原型仅在获准临时目录执行。以下严格区分已发布包实测、源码事实与架构推论。

## 1. 三个候选库中，哪个最适合最小可实施方案？

### Takeaway

**建议首先实现固定版本 `@mercuryworkshop/scramjet@2.0.67-alpha.2` 的 core 接入 spike：`ScramjetFetchHandler` + `ScramjetClient` + Yuri transport + 本地资源网关。** 它不是三个候选中最成熟的库，却是现有公开接口最贴合“自定义传输、可配置 URL 前缀、脱离 Service Worker”的库。若要求“成熟稳定且零适配地满足所有条件”，本次没有找到这样的候选。

### Cited Findings

| 候选 | 核实的版本与授权 | 接入能力 | 对本需求的判断 |
|---|---|---|---|
| testcafe-hammerhead | npm `latest=31.7.9`，2026-10-29 发布，MIT，Node >=20 | 成熟服务端重写代理；HTTP/HTTPS、WebSocket、EventSource；Session cookie/state；公开 GET/POST 路由扩展 | 成熟度优先时可考虑，但双端口、根路径 URL 模型与 Yuri 单一 runtime API 路径不吻合。不能简单作为 Express middleware 挂到 `/api/plugin-proxy/`。 |
| Ultraviolet | npm `latest=3.2.10`，2024-10-27 发布，MIT | SW 拦截、JS/HTML/CSS 重写、bare-mux 可替换传输 | 官方 README 已明确不再积极维护、由 Scramjet 接替。SW 与浏览器全局耦合，不是最小 native gateway 接口。 |
| Scramjet | npm `latest/legacy=1.1.0`；`alpha=2.0.67-alpha.2`，2026-06-24 发布；2.x 标注 AGPL-3.0-only | 2.x core 公开 `ScramjetFetchHandler`、`ScramjetClient`、`ScramjetContext`、URL/HTML/CSS/JS 重写函数；独立 `ProxyTransport` | 接口最合适，但必须锁定 2.x alpha，不能用默认 latest 安装后套用新版文档；需要承担版本与适配维护。 |

表中版本、日期、license 与能力依据：[Hammerhead registry](https://registry.npmjs.org/testcafe-hammerhead)、[Hammerhead README](https://github.com/DevExpress/testcafe-hammerhead/blob/master/README.md)、[Ultraviolet registry](https://registry.npmjs.org/@titaniumnetwork-dev/ultraviolet)、[Ultraviolet README](https://github.com/titaniumnetwork-dev/Ultraviolet/blob/main/README.md)、[Scramjet registry](https://registry.npmjs.org/@mercuryworkshop/scramjet)、[Scramjet core package](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/package.json)。

- **Scramjet 1.1.0 存在授权元数据冲突**：registry 的 `license` 是 MIT，但下载的 1.1.0 tarball 内 `LICENSE` 正文是 GNU AGPL v3；2.0.67-alpha.2 的 metadata 则明确 AGPL-3.0-only。不要据 1.1.0 的 npm 标签把它认定为 MIT 备选。本次不作授权法律结论。——[1.1.0 metadata](https://registry.npmjs.org/@mercuryworkshop/scramjet/1.1.0)、[1.1.0 发布包](https://registry.npmjs.org/@mercuryworkshop/scramjet/-/scramjet-1.1.0.tgz)、[2.x package](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/package.json)
- **Hammerhead 路由可以扩展，但代理管线没有同等的公开挂载点。** 类型公开 `Proxy.GET(route, handler)`、`POST`、`unRegisterRoute`、`start`、`openSession`、`resolveRelativeServiceUrl`；将任意现有 HTTP 请求交给代理的 `_onRequest`、`_onUpgradeRequest` 是内部方法，不是该公开类型契约的一部分。——[公开类型](https://github.com/DevExpress/testcafe-hammerhead/blob/master/ts-defs/index.d.ts)、[Proxy 实现](https://github.com/DevExpress/testcafe-hammerhead/blob/master/src/proxy/index.ts)
- Hammerhead `start({hostname, port1, port2, ssl, ...})` 同时创建两个 HTTP(S) listener。`ServerInfo` 的两个记录分别包含 `port/crossDomainPort`；代理 URL 的构造明确为 `` `${protocol}//${hostname}:${port}/${descriptor}/${destination}` ``；内置服务路径包括 `/hammerhead.js`、`/task.js`、`/iframe-task.js`、`/messaging`。**未发现 `basePath`、两个独立 public origin、独立 advertised URL/listen address 的一等配置。**——[Proxy 实现](https://github.com/DevExpress/testcafe-hammerhead/blob/master/src/proxy/index.ts)、[URL 构造](https://github.com/DevExpress/testcafe-hammerhead/blob/master/src/utils/url.ts#L159-L182)、[服务路径](https://github.com/DevExpress/testcafe-hammerhead/blob/master/src/proxy/service-routes.ts)
- `server1Info/server2Info` 本身在类型中公开；不能笼统地说修改它们一定是“私有 API”。但这些字段没有提供前缀支持，且单改字段未证明所有注入、cookie、WS URL 都一致。`externalProxySettings` 是上游 HTTP 代理配置，不是 Yuri 的 browser-side transport 注入点。——[公开类型](https://github.com/DevExpress/testcafe-hammerhead/blob/master/ts-defs/index.d.ts)、[openSession 实现](https://github.com/DevExpress/testcafe-hammerhead/blob/master/src/proxy/index.ts)
- Ultraviolet 的 `UVServiceWorker.fetch({request})` 虽然看起来可以手调，内部仍访问 `location.origin`、`navigator.userAgent`、IndexedDB cookie DB 和 `self.clients.matchAll()`；不匹配 prefix 时直接调用原生 `fetch(request)`。constructor 默认创建 `BareClient`，并非注入一个独立 HTTP handler。它有 `request/beforemod/response` hook，不能据此宣称“去掉 SW 就能运行”。——[uv.sw.js](https://github.com/titaniumnetwork-dev/Ultraviolet/blob/main/src/uv.sw.js#L30-L302)
- Ultraviolet v3 的 bare-mux 确有 `BareTransport.request/connect` 和 `BareMuxConnection.setRemoteTransport`，说明可替换网络，不代表消除了 browser resource interception/SW 的依赖。——[bare-mux 2.1.9 发布包](https://registry.npmjs.org/@mercuryworkshop/bare-mux/-/bare-mux-2.1.9.tgz)、[Ultraviolet README](https://github.com/titaniumnetwork-dev/Ultraviolet/blob/main/README.md)
- Scramjet 2 的 `ScramjetFetchHandler` constructor 明确接收 `transport/context/sendSetCookie/fetchDataUrl/fetchBlobUrl`；`handleFetch(request)` 返回可转换为普通 HTTP response 的 `body/headers/status/statusText`。`ScramjetClient` 也接收相同 transport，而不是必须创建 BareMux SharedWorker。——[fetch core](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/fetch/index.ts)、[client core](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/client/client.ts)

### Inferences

- **统一 native + hosted H5 时，选 Scramjet core，而不是其现成 SW Controller 整套应用。** 自己的资源入口只有两种：native loopback HTTP gateway、H5 HTTPS Service Worker；重写和出网 transport 共用。
- Hammerhead 的可行 MIT 路线是把它当完整服务运行、保留两套根路径/端口，再做对应 browser-visible gateway。只要不动内部方法就要支付双 origin/port 与 H5 启动控制的复杂度；对本目标不如一个 prefix 的 Scramjet core 小。
- 不建议 fork Ultraviolet 把 `clients`、cookie、worker、transport 全拆掉；它等于重新完成 Scramjet 2 已经提供的模块分离。
- AGPL 与 alpha 状态是明确的选型成本；“用户允许增加依赖和原生更新”并不改变包本身的授权或成熟度。

### Gaps

- 三者均没有本次核实到的“任意网站、所有 Web API、iOS WKWebView、Android WebView 全覆盖”承诺。官方 supported-sites 列表不能替代目标端验证。
- 本次没有运行 Hammerhead 的双端口反向网关，因此不把任意 reverse-proxy/base-path 组合标为可用。
- Scramjet 2.0.67-alpha.2 发布包的 `dist/types/index.d.ts` 导出 `./fetch`，但 tarball 中缺少 `dist/types/fetch/index.d.ts`；`client.d.ts` 等还含 `@/...` 路径引用。运行时 exports 实测存在，TypeScript 集成可能需要本地薄声明/上游修复，不能把“运行时可 import”等同于类型可直接通过。

## 2. 不依赖 capacitor:// Service Worker，如何接入现有中继？

### Takeaway

**可以把 Scramjet 2 fetch handler 用作普通资源网关后的重写器；本次已在无 Service Worker 的 Node 24 环境验证这一点。** 但浏览器的原生图片、脚本、iframe 请求仍需要一个真实的 URL 接收入口；仅替换 `window.fetch` 不能满足要求。原生端用 loopback HTTP gateway，H5 用独立 HTTPS 渲染源下的 SW，所有上游出网交给未被重写的 Yuri broker。

### Cited Findings

- Capacitor iOS 默认 scheme 为 `capacitor`，官方配置明确 `iosScheme` **不能设成 WKWebView 自己处理的 http/https**；Android 非 http/https 自定义 scheme 从 WebView 117 起存在路径路由限制。给 `iosScheme` 换个名字不能得到标准 HTTP 资源拦截器。——[Capacitor 配置声明](https://github.com/ionic-team/capacitor/blob/main/cli/src/declarations.ts)、[Apple WKURLSchemeHandler 注册约束](https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/seturlschemehandler(_:forurlscheme:))
- Scramjet 的 context 显式包含 `prefix: URL`、`cookieJar`、codec 和注入脚本生成接口；URL 重写使用 `context.prefix.href + codecEncode(realUrl.href)`。这与 `/proxy/<session>/...` 本地资源路径天然匹配。——[ScramjetContext](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/shared/index.ts#L30-L57)、[URL 重写](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/shared/rewriters/url.ts)
- Scramjet 的普通 fetch/Request hook 主要是把 URL 改到代理 prefix，真正的请求仍由浏览器资源系统发出；WebSocket hook 则调用 `client.bare.createWebSocket(...)`，携带虚拟 Origin/Cookie 等字段。因此需要同时接上资源网关和 client transport，不能只做 fetch handler。——[fetch hook](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/client/shared/requests/fetch.ts)、[WebSocket hook](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/client/shared/requests/websocket.ts)
- `@mercuryworkshop/proxy-transports@1.0.2` 的实际发布类型如下，HTTP/WS 均有公开注入点，headers 为有序 pair 数组，可保留多条 `Set-Cookie`。——[1.0.2 发布包，dist/types.d.ts](https://registry.npmjs.org/@mercuryworkshop/proxy-transports/-/proxy-transports-1.0.2.tgz)

```ts
type RawHeaders = [string, string][];
interface ProxyTransport {
  ready: boolean;
  init(): Promise<void>;
  request(
    remote: URL,
    method: string,
    body: BodyInit | null,
    headers: RawHeaders,
    signal: AbortSignal | undefined,
  ): Promise<{
    body: ReadableStream | ArrayBuffer | Blob | string;
    headers: RawHeaders;
    status: number;
    statusText: string;
  }>;
  connect(
    url: URL,
    protocols: string[],
    requestHeaders: RawHeaders,
    onopen: (protocol: string, extensions: string) => void,
    onmessage: (data: Blob | ArrayBuffer | string) => void,
    onclose: (code: number, reason: string) => void,
    onerror: (error: string) => void,
  ): [send: (data: Blob | ArrayBuffer | string) => void,
      close: (code: number, reason: string) => void];
}
```

- 当前 Yuri `runtimeFetch` 只对识别为 runtime API 的路径走 relay；第三方绝对 URL 不会自动经 Host，而会进入原生 fetch 分支。`openRuntimeWebSocket` 在 relay 模式把 URL 转为 pathname/search 后开 Host 隧道，也不是任意第三方 URL 的正向代理。因此必须新增 Yuri 自有 proxy API，将真实目标放在加密应用协议的消息中。——[当前 runtime-fetch.ts](../../packages/ui/src/lib/runtime-fetch.ts#L381-L395)、[runtimeFetch 分支](../../packages/ui/src/lib/runtime-fetch.ts#L492-L545)、[runtime-socket.ts](../../packages/ui/src/lib/relay/runtime-socket.ts)、[tunnel-payloads.ts](../../packages/ui/src/lib/relay/tunnel-payloads.ts)
- 当前 CJS 插件通过 `new Function('require','module','exports',code)` 求值，`require('solid-js')` 等映射为当前 host 的共享模块实例。已经创建的 render callback 的全局对象不能靠移动 DOM 或把 callback 传入 iframe 来改变。——[当前 bundle.ts](../../packages/ui/src/lib/gui-plugins/bundle.ts#L16-L31)、[求值边界](../../packages/ui/src/lib/gui-plugins/bundle.ts#L49-L60)

#### 无 SW 的已执行原型

使用 **真实 npm tarball `2.0.67-alpha.2`** 的 `dist/scramjet_bundled.mjs`，Node `v24.18.0`，包内 `versionInfo.build=c26bfc6`。只设置 `globalThis.self=globalThis` 以满足 bundle 环境；没有启动浏览器、SW 或远程服务，没有安装产品依赖。fixture transport 返回受控 HTML/JS/CSS/JSON，并把原生 `globalThis.fetch` 改成抛错函数，确保测试没有隐藏网络 fallback。

实测使用的是以下公开运行时 API；此处省略 fixture 内容和断言，不是完整生产启动代码：

```js
globalThis.self = globalThis;
const sj = await import('./scramjet_bundled.mjs');
const context = {
  config: structuredClone(sj.defaultConfig),
  prefix: new URL('http://127.0.0.1:19387/proxy/session/'),
  cookieJar: new sj.CookieJar(),
  interface: {
    codecEncode: encodeURIComponent,
    codecDecode: decodeURIComponent,
    getInjectScripts: (_meta, _handler, _html, script) =>
      [script('/bootstrap.js')],
    getWorkerInjectScripts: (_meta, _module, script) =>
      script('/worker-bootstrap.js'),
  },
};
const handler = new sj.ScramjetFetchHandler({
  context,
  transport: fixtureTransport,
  sendSetCookie: async entries => recordCookieSync(entries),
  fetchDataUrl: async () => { throw Error('not exercised'); },
  fetchBlobUrl: async () => { throw Error('not exercised'); },
});
const response = await handler.handleFetch({
  rawUrl: new URL(context.prefix.href + encodeURIComponent('https://app.test/')),
  rawReferrer: null,
  rawDestination: 'document',
  mode: 'navigate',
  referrer: '',
  method: 'GET', body: null, cache: 'default',
  initialHeaders: sj.ScramjetHeaders.fromRawHeaders([]),
  clientId: 'fixture-client',
});
```

验证通过：runtime exports、任意 HTTP prefix、嵌套 iframe URL 重写、图片 URL、CSS URL、JS 重写、bootstrap 注入、仅调用注入 transport、多条 Set-Cookie、HttpOnly 对 JS 过滤、后续请求 cookie 回放。**没有验证**浏览器执行、真实嵌套 iframe、WS、WKWebView、Android、Yuri relay 或 postMessage 认证。

原型与完整输出位于获准临时目录中的 `mobile-proxy-research/probe.mjs` 和 `probe-output.json`；执行命令为在该目录运行 `node probe.mjs`。上述实验属于本次一手证据；相关公开包与 API 来源：[发布 tarball](https://registry.npmjs.org/@mercuryworkshop/scramjet/-/scramjet-2.0.67-alpha.2.tgz)、[fetch API 源码](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/fetch/index.ts)。

### Inferences

#### 推荐结构：一个重写/传输内核，两种浏览器资源入口

```text
手机上的隔离 renderer realm
  ├─ iframe 内 SDK + 单份 Solid + CJS Plugin.setup/global view
  ├─ ScramjetClient：DOM、JS、URL、fetch/XHR、WS 适配
  └─ 浏览器正常请求重写后的本地资源 URL
        │
        ├─ native：127.0.0.1 临时端口 HTTP gateway → JS 请求 broker
        └─ H5：专用 HTTPS renderer origin 的 SW → JS 请求 broker
                         │
                   ScramjetFetchHandler
                         │
                 Yuri ProxyTransport
                         │
            未被重写的外层 Yuri runtime broker
                         │
           runtimeFetch('/api/gui-proxy/...')
           openRuntimeWebSocket(runtime-owned proxy socket URL)
                         │
                 现有加密应用中继
                         │
                    Host proxy API
                         │
              目标站点 HTTP/HTTPS/WS/WSS
```

1. **renderer 独立 realm**：不能在 Yuri 主 window 安装全局 Scramjet hooks，否则 runtimeFetch、主 UI、主路由也被改写。手机端重新在 renderer 内求值插件 CJS；renderer 内 SDK/Solid 仍共用同一份实例。外层复用现有 registry/host 的契约，以序列化 metadata 和 RPC 暴露状态/动作。不能把旧 host 创建的 Solid callback 原样跨 realm 传入后声称隔离完成。
2. **native loopback gateway**：绑定 loopback，为 HTTP 方法、请求体、资源响应提供真实入口。它只把请求送往未被重写的 JS broker，不自行请求互联网。loopback 页面可以嵌入当前 native shell，但具体 WKWebView 导航/ATS 与 Android 网络策略要在 spike 中验证。它不依赖 capacitor:// SW，也不需要拦截 WKWebView 原生 http/https scheme。
3. **H5 HTTPS gateway**：专用 renderer origin 的 SW 只接管 proxy scope，通过 MessageChannel 把请求交给该 renderer 的可信 broker，再经 capability port 到外层 Yuri。保证 controller ready 后才加载页面。所有 nested origin 在浏览器物理 URL 层映射到该 renderer origin，虚拟 origin 交给 Scramjet；不需要多个真实第三方 origin 的 SW。
4. **HTTP transport**：`request(remote,...)` 只能调用 Yuri 自有 API。请求/响应使用应用层 envelope 保存真实目标、status、原始 header pairs 和 body；`Set-Cookie` 不能依靠浏览器 Response 暴露，也不能被 `Headers` 合并后丢失。Host 禁止自动跟随重定向，让重写内核处理其 Location/cookie 语义。
5. **WS transport**：打开 Yuri 的 proxy WS route，在加密通道内用首个协议消息传 `target/protocols/rawHeaders`，Host 再创建目标 WS；返回 upstream protocol/extensions、文本/二进制帧、close code/reason。`openRuntimeWebSocket` 没有任意 upstream header 参数，因此仅把远程 URL 换成 Yuri URL 不够。
6. **生命周期绑定**：proxy session 绑定 runtime/relay generation；runtime 切换或 relay 断开时关闭 WS、取消 HTTP、使旧 capability 和本地 URL 失效。若本功能要求强制 relay，broker 先检查绑定的 relay 仍有效，不能让通用 helper 自动回退到直连分支。
7. **无旁路**：在 renderer origin 上施加由 Yuri 控制的网络出口限制，允许 gateway/bootstrap，拒绝实际第三方网络目的地；native 可再用 WKWebView/Android 的网络限制能力兜底。失败显式失败，不能回退普通 `fetch(remote)` 或 `new WebSocket(remote)`。上述属于请求目标中的核心契约，不是仅在 UI 隐藏选项。

#### native gateway 的第一道技术门槛

`ScramjetFetchRequest` 需要 `rawDestination/mode/referrer/rawClientUrl/clientId`，不是只有 URL 和 body。core 的 `rewriteBody` 按 destination 决定 HTML、JS、CSS、worker 处理；普通 `fetch('/x.js')` 返回源码文本时不应被当 `<script>` 改写。HTML rules 并没有给所有 script/link URL 自动添加 destination，虽然 URL API 支持显式 destination 参数。——[fetch request 类型](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/fetch/index.ts)、[rewriteBody](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/fetch/body.ts)、[HTML rules](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/shared/htmlRules.ts)、[URL 参数](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/shared/rewriters/url.ts)

因此 native spike 必须先测目标 WKWebView/Android 是否在 loopback 请求中提供完整 `Sec-Fetch-Dest` 等元数据，并为 frame/client 建立稳定标识。缺失时需要明确的重写 URL/客户端元数据适配，不能用扩展名或 Content-Type 猜成权威 destination。H5 SW 能直接读取 FetchEvent/Request 元数据，原生 HTTP 网关不能默认等价。

### Gaps

- 仅凭 handler 可调用，不足以证明完整 native 支持。尚未实测 loopback iframe、Sec-Fetch 元数据、client/frame 标识、referrer policy、native 生命周期或 WebKit WASM/client hooks。
- 实验只验证 Node 侧重写；建议产品中重写 handler 与 cookie owner 放在同一个明确的 broker，避免两份 cookie authority。具体 worker/JS realm 的部署位置需根据 native IPC 和 H5 controller 实测确定。
- Worker、blob/data document、动态 import、sync XHR 都有额外入口；默认配置中 `syncxhr=false`。不能把原型中的四类响应验证扩写成“所有第三方资源已兼容”。——[默认 flags](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/index.ts)

## 3. 如何保留 cookie、虚拟 origin、postMessage 认证，并定义最小 E2E spike？

### Takeaway

Cookie 与页面虚拟 origin 应交给库处理并补齐每个 plugin/runtime session 的生命周期；**Yuri 特权桥不能信任库模拟出来的 `event.origin`**。最小 E2E spike 应先证明一个真实 CJS/Solid 页面、两层跨源 iframe、动态资源、HTTP/WS 全经现有 relay，并通过手机禁止第三方出网的反证测试；不先铺开插件市场或所有页面。

### Cited Findings

- Scramjet `CookieJar` 提供 `setCookies/getCookies/load/dump/clear`，`getCookies(url, fromJs, sameSiteContext)` 区分 JS 可见性和 SameSite 上下文；fetch handler 从原始 header pairs 逐条处理 Set-Cookie，再调用 `sendSetCookie`。本次 fixture 验证了 HttpOnly 对 JS 隐藏而网络请求仍发送。——[CookieJar](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/shared/cookie.ts)、[handleCookies](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/fetch/fetch.ts)
- Hammerhead 的 Session 拥有 cookie API 和 state snapshot；其 postMessage sandbox 对消息记录真实目的页面的 origin/target，并在接收端按 `targetUrl` 做虚拟同源检查，说明“只改 event.origin”不是完整语义。——[Session 类型](https://github.com/DevExpress/testcafe-hammerhead/blob/master/ts-defs/index.d.ts)、[Hammerhead message sandbox](https://github.com/DevExpress/testcafe-hammerhead/blob/master/src/client/sandbox/event/message.ts)
- Scramjet 当前 postMessage 实现把原消息包装为 `$scramjet$origin/$scramjet$data`，将物理 `targetOrigin` 改为 `*`；event listener wrapper 再从 payload 读回虚拟 origin/data。所读实现中没有看到与 Hammerhead 相同的完整 targetOrigin 接收过滤。不能据此声称保持了浏览器原生 origin 认证边界。——[postmessage.ts](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/client/shared/postmessage.ts)、[event.ts](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/client/shared/event.ts)
- ScramjetClient 公开 `shouldBlockMessageEvent` 与 `hookSubcontext`，可用于自己的消息过滤和 blank/srcdoc 子上下文挂钩；它们是集成入口，不会自动替 Yuri 证明发信者身份。——[ScramjetClientInit](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/client/client.ts#L70-L81)
- Scramjet HTML rules 会去掉 iframe `sandbox`、script/link 的 integrity 等属性，UV 会删除多种上游 CSP/frame headers。页面代理为了兼容会改变安全语义，不能把上游原有 iframe sandbox 当作仍在生效的宿主隔离。——[Scramjet HTML rules](https://github.com/MercuryWorkshop/scramjet/blob/main/packages/core/src/shared/htmlRules.ts)、[Ultraviolet headers](https://github.com/titaniumnetwork-dev/Ultraviolet/blob/main/src/uv.sw.js)

### Inferences

#### Cookie / origin / 身份边界

- Cookie jar 以 `(runtimeId, pluginId, proxySessionId)` 分区，按真实目标 URL 处理 domain/path/secure/httpOnly/sameSite；不把第三方 cookie 写成 Yuri 主域浏览器 cookie。renderer JS cookie 与 handler cookie 通过 `sendSetCookie` 做受控同步。
- 不把外层 Yuri bearer、relay pairing secret 或 RuntimeAPIs 对象传给普通子 frame。只给当前 renderer 顶层 bootstrap 一个限于该 proxy session 的 capability 通道。
- 初始握手由未被 Scramjet hook 的 broker 检查实际 `event.source === expectedFrame.contentWindow`、物理 renderer origin（若可用）、一次性 nonce，再转交专用 MessagePort；后续只认该 port 和 session generation。opaque/custom origin 场景不以字符串 `"null"` 当身份。
- 把库的虚拟 `event.origin` 当页面兼容层，不当 Yuri 认证。第三方 iframe 与顶层插件自己的 postMessage 登录协议需要单独测：正确 origin 成功，错误 targetOrigin 不投递，伪造包/兄弟 frame 不获得特权。
- 若实际插件依赖严格 targetOrigin 语义，Scramjet 当前实现需要一个有界的 upstream fix 或明确适配；不能用一份宿主 capability 检查来宣称第三方页面之间的浏览器语义已全部修复。
- native renderer 与主应用不同物理 origin；H5 也优先专用 renderer origin，而不是把所有第三方脚本变成 Yuri 主 UI 同源内容。URL 前缀隔离不等于浏览器 origin 隔离。

#### 最小端到端 spike：五个小模块、一组确定性 fixture

**模块 1：Host 出网 API**

- 建立仅供已认证 runtime 调用的 `POST /api/gui-proxy/session`、HTTP request route、WS route 和 session close。
- upstream 请求接收 URL、method、raw headers、body；返回原始 status/header pairs/body，不透传 Yuri 认证到第三方。
- spike 可对 body 设小的显式上限并使用 base64 envelope，以最少代码证明语义；超限报错。之后才扩成流式二进制、backpressure、Range/媒体。有限 body spike 不是“任意大小资源已支持”。

**模块 2：Yuri `ProxyTransport`**

- `request` 只走 `runtimeFetch('/api/gui-proxy/...')`。
- `connect` 只走 `openRuntimeWebSocket` 的 Yuri runtime route，首帧协商真实 upstream 目标与 headers。
- 同步实现 abort/close/runtime generation 检查；断 relay 必须失败，不尝试第三方直连。

**模块 3：隔离 renderer bootstrap**

- 先建立可信 broker 通道，再初始化 ScramjetClient 和 context；在加载插件代码前完成所有 hook。
- 使用 iframe 内的 `@opencode/plugin/gui@2.2.0` 与同一份 Solid modules 重新求值一份真实 CJS fixture，调用它注册的 global view。
- 外层只处理 view 尺寸、entry metadata、必要 host RPC；复用现有插件 host 契约，不把 React/Solid 实例跨 realm 混用。

**模块 4：H5 SW 资源入口**

- 固定 proxy scope；SW 接到 FetchEvent 后把 request metadata/body 发往可信 broker，broker 调用同一个 ScramjetFetchHandler。
- response 通过 MessagePort 返回，先确保 controller ready，再发起 document navigation；页面关闭时取消未完成请求。

**模块 5：native HTTP gateway**

- Swift/Kotlin loopback server 把 URL、headers、method、body 转入同一 broker 协议，回写 status/headers/body。
- 在做完整 host 集成前，先验证：document、iframe、script、style、fetch、XHR 的 destination 与 referrer/client 信息足够区分。
- 若缺失，停止宣称 native 支持，先解决显式 metadata adapter；不要为了演示临时对未知资源猜类型或开放第三方直连。

**验收 fixture（单页就足够覆盖主链路）**

1. 真实 CJS/Solid view，本地按钮和输入立即响应；HTML 在手机本地执行。
2. A 页面嵌套 B origin iframe，B 再嵌 C；正确/错误 targetOrigin 双向 postMessage。
3. A 的 CSS `@import/url()`、跨源图片/字体、动态 `<script>`、ES module dynamic import。
4. GET fetch、POST XHR、上传 body、30x redirect、多条 Set-Cookie、HttpOnly、不同 path/domain cookie。
5. WS 文本与二进制、subprotocol、Origin、cookie、close/error；如果目标使用 EventSource，再加一条 SSE。
6. `about:blank/srcdoc`、blob/data document 至少各一项，以确认新 realm 也先安装 hooks。
7. 手机/renderer 的测试网络只放行本地 gateway 与现有 relay，第三方站点仅 Host 可达；所有 fixture 仍通过。故意构造未改写 URL，必须被阻断而不是直连。
8. 断 relay、关闭 view、切换 runtime：请求取消、WS 关闭、旧 URL/capability 失效，不继续耗用旧 Host。

**建议顺序**：先跑 native gateway 元数据小探针与 H5 单页主链路；两者可复用上述 transport/core。随后跑 iOS 真机、Android WebView，再接入实际插件。只有 HTML URL rewrite 通过时，不进入完整产品接线。

#### 明确的能力边界

这是“可信 GUI 插件与已验证页面能力”的代理 renderer。WebRTC/WebTransport、DRM、WebAuthn/passkey、浏览器扩展能力、真实站点 SW 等不能因为 HTTP/WS hook 存在就自动视为支持。对于未支持的出网能力，保持失败关闭；这才符合无旁路条件。新增一条 API 适配应以真实插件需求与 fixture 为依据，避免承诺完全透明地重造浏览器网络栈。

### Gaps

- 本次没有移动端/浏览器 E2E，因此推荐的是**最小且有代码证据支持的实施方向**，不是已完成的三端方案。
- 严格 postMessage targetOrigin、虚拟跨源 DOM 访问隔离与 nested frame 启动顺序是决定能否承载具体第三方登录页的关键待验证项。
- 真实登录站点可能依赖 IP、设备绑定或原生浏览器安全特性；保留 cookie jar 与 Origin header 不保证其认证流程可代理。
- 未修改产品源码、package.json、lockfile 或 native 配置；未执行 git/GitHub 命令；仅增加本研究笔记，并在获准临时目录读取发布包、执行无网络 fallback 的有限原型。
