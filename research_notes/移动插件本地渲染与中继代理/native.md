# 原生本地 WebView + 现有 Yuri Relay：可实施传输与严格隔离缺口

调研日期：2026-11-06。仅阅读当前工作树、官方文档和上游源码；未修改产品、安装依赖、执行 git、运行真机验证。下文“建议”是待实现设计；上游 `main` 源码不能当成每个已发布 iOS/Android WebView 版本的行为证明。

## 1. 原生代理能否免改写页面，并复用现有加密 Relay？

### Takeaway

**能作为 HTTP(S)/WS(S) 的具体传输方案：手机原生 loopback SOCKS5/CONNECT gateway → 当前 Relay 的 WebSocket 子流 → Host 内新增 TCP 出口。页面、JS、布局和 TLS 均在手机运行，不需要重写 HTML/JS，不新增公网 Relay 服务。** 但现有 Yuri tunnel 不是任意 TCP 代理，必须补 Host 出口与有界流控；“代理已设置”尚不等于满足 ALL network，见第二节。[Apple API](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/proxyconfigurations-cdc1) · [Chromium proxy](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md) · [当前 Host dispatcher](../../packages/web/server/lib/relay/tunnel-host.js#L347)

### Cited Findings

| 平台/API | 已核实支持与最低版本 | 对 Yuri 的直接含义 |
|---|---|---|
| `WKWebsiteDataStore.proxyConfigurations: [Network.ProxyConfiguration]` | **iOS/iPadOS 17.0、macOS 14.0**；作用于使用同一 data store 的全部 WKWebView。官方头文件要求在 page load 前设置。[Apple](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/proxyconfigurations-cdc1) · [WebKit header L125–132](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebsiteDataStore.h#L125-L132) | 能隔离到插件专用 data store；不是 OS 全局代理，也不能单独配置同一 WebView 中的一个 iframe。 |
| `ProxyConfiguration(httpCONNECTProxy:tlsOptions:)` | iOS 17；HTTP/1.1 CONNECT；`tlsOptions: nil` 表示到代理为明文 HTTP；官方明确 **只处理 TCP**，UDP 另属 `relayHops`。[Apple](https://developer.apple.com/documentation/network/proxyconfiguration/init(httpconnectproxy:tlsoptions:)) | loopback HTTP CONNECT 不需要证书/MITM；`relayHops` 是 Apple 代理协议配置，不是 Yuri 已有 WS Relay 的开关。 |
| `ProxyConfiguration(socksv5Proxy:)` | iOS 17 的公开 SOCKSv5 API。[Apple](https://developer.apple.com/documentation/network/proxyconfiguration/init(socksv5proxy:)) | 可统一两端的本地 SOCKS5 CONNECT 实现；iOS 是否始终传域名而非先解析，要实测。 |
| `allowFailover` | iOS 17；明确控制是否回退非代理连接，**默认 false**。[Apple](https://developer.apple.com/documentation/network/proxyconfiguration/allowfailover) | 仍显式设 false；不能把它解释为所有 WebRTC/系统网络的防火墙。 |
| AndroidX `ProxyController.setProxyOverride(ProxyConfig, Executor, Runnable)` | **AndroidX WebKit 1.1.0 起**；process-specific，覆盖该进程的 WebView；必须检查 `WebViewFeature.PROXY_OVERRIDE`，等待 callback 再 load。[官方 API](https://developer.android.com/reference/androidx/webkit/ProxyController) · [源码](https://github.com/androidx/androidx/blob/androidx-main/webkit/webkit/src/main/java/androidx/webkit/ProxyController.java) | **不是 per-WebView API**；两个同进程 WebView 不能分别保留原始 Relay WS 直连、插件页全代理。不能只看 Android API level 判支持。 |
| Android `ProxyConfig.Builder` | `addProxyRule`、`removeImplicitRules`、`addDirect` 都从 1.1.0 提供。默认 loopback/link-local 绕过；空配置会直连。[官方 API](https://developer.android.com/reference/androidx/webkit/ProxyConfig.Builder) · [源码](https://github.com/androidx/androidx/blob/androidx-main/webkit/webkit/src/main/java/androidx/webkit/ProxyConfig.java) | 使用单个所有 scheme 的代理，调用 `removeImplicitRules()`；禁止 `addDirect()`、普通 bypass、失败时 clear。 |
| Android WebView 多进程数据目录 | `WebView.setDataDirectorySuffix` 从 **API 28** 提供；必须在本进程任何 WebView/android.webkit 初始化前调用，不同进程不能共用数据目录。[官方 API](https://developer.android.com/reference/android/webkit/WebView#setDataDirectorySuffix(java.lang.String)) | 专用 `:gui` 进程可隔离代理。保守直接采用 Android 9/API 28 的插件功能最低线；低于此可另探测 AndroidX startup feature，不能默认可用。 |

补充源码证据：

- WebKit 将 data store 的 proxy 配置应用到 `NSURLSessionConfiguration`，WebSocket 也由相同 session wrapper 的 `webSocketTaskWithRequest` 创建。因此 WS/WSS 不是必须 JS monkey-patch 的遗漏路径。[`NetworkSessionCocoa.mm` L1116、1733–1741、2106–2115](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/cocoa/NetworkSessionCocoa.mm)
- Chromium HTTP proxy 支持 `http://`、`https://`、`ws://`、`wss://`，目标域名交给代理解析；SOCKSv5 也在代理端解析，但只用于 TCP URL 请求、不支持 UDP，且 Chromium SOCKSv5 不提供代理认证。[Chromium proxy schemes](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md#proxy-server-schemes)
- 当前 app iOS target 为 **15.5**，因此不能对现有全部设备直接启用上述 iOS 17 API；Android minSdk **24**、compileSdk **36**、targetSdk **35**、配置的 AndroidX WebKit **1.12.1**。Capacitor 8.4.1 的 Gradle 本就引用 AndroidX WebKit；若 app 源码直接使用该 API，建议在 app 声明显式依赖，而非依赖 implementation 的传递可见性。[Podfile](../../packages/mobile/ios/App/Podfile#L1-L13) · [variables.gradle](../../packages/mobile/android/variables.gradle) · [Capacitor 8.4.1 Gradle](https://github.com/ionic-team/capacitor/blob/8.4.1/android/capacitor/build.gradle#L80-L90)
- 现有 `YuriBridgeViewController.webViewConfiguration(for:)` 已提供正确的配置注入点，但只注册 `yuri-asset` 和刷新率设置，没有网络代理。[当前 Swift L135–149](../../packages/mobile/ios/App/App/YuriBridgeViewController.swift#L135-L149) · [Capacitor 8.4.1 调用顺序 L295–300](https://github.com/ionic-team/capacitor/blob/8.4.1/ios/Capacitor/Capacitor/CAPBridgeViewController.swift#L295-L300)
- 现有 iOS `YuriVideoServer` 用 `NWListener`，明确绑定 `127.0.0.1` ephemeral port，可参考其 listener/lifecycle。它只是 Range HTTP 视频适配器，不能把现有类型直接改名当 SOCKS 服务。[源码 L21–45](../../packages/mobile/ios/App/App/YuriVideoServer.swift#L21-L45)
- Android `YuriVirtualAssetPlugin` 安装的是 `BridgeWebViewClient` 子类，只处理 `yuri-asset://`；不是任意网页的网络隔离器；再次替换 MainActivity 的 WebViewClient 会覆盖这个能力。[源码 L29–46、142–155](../../packages/mobile/android/app/src/main/java/com/yuri/app/YuriVirtualAssetPlugin.java)
- GUI 目前直接在共享 React/Solid 文档求值、挂载，不是隔离 WebView；所有 URL 的自动网络访问并没有经过 `runtimeFetch`。后者保留普通外部绝对 URL 的 origin 语义。[GUI ownership](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#所有权与运行时) · [`runtime-fetch.ts` L66–79](../../packages/ui/src/lib/runtime-fetch.ts#L66-L79)
- 当前 Layer 1 Relay 只转发 ciphertext；Layer 3 的 `WsBinary` 可以载任意二进制消息，但 Host 只允许固定 `/api/...` WS，并总是 dial **Host 自己的 loopback Yuri port**，不是客户端指定的外部地址。[relay layers](../../packages/web/server/lib/relay/DOCUMENTATION.md#the-three-layers) · [protocol.ts L37–50](../../packages/ui/src/lib/relay/protocol.ts#L37-L50) · [tunnel-host L31–59、365–382](../../packages/web/server/lib/relay/tunnel-host.js)

### Inferences

**建议确定为一个传输设计：SOCKS5 TCP → existing tunneled WS → Host TCP bridge。** 优先 SOCKS5 是为了每条浏览器 TCP 连接只解析一个握手，后续字节原样转发；HTTP CONNECT 也可做，但 Android 普通 HTTP/WS 还要正确处理 forward-proxy absolute-form/Upgrade，工作面更大。这里不是要求修改网站。[协议选择依据](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)

```text
手机本地插件 DOM / iframe / script / fetch / WebSocket
  ↓ WebKit/Chromium 原生网络代理（原 URL、Cookie、SNI、TLS 校验保留）
手机 127.0.0.1:ephemeral SOCKS5 gateway（只 CONNECT，UDP ASSOCIATE 明确拒绝）
  ↓ native IPC：stream id、hostname:port、bytes、credit、FIN/RESET
Yuri 当前连接 owner：getActiveRelayTunnel().openWebSocket(scopedPathWithUrlToken)
  ↓ 现有同一 E2EE channel 的 WsBinary，现有同一公网 Relay
Host /api/gui-network/tcp/ws（新增、认证、授权）
  ↓ Host DNS + net.connect；TLS bytes 不解密、不改写
目标服务器
```

**Host bridge 的可实施最小协议（建议）：**

1. 一条 TCP 连接使用一个现有 WS 子流。WS 建立后首消息 `{v:1,type:'open',hostname,port,leaseId}`；Host 鉴权、校验 lease 后解析 DNS，连接成功再回 `opened`。本地 gateway 收到 opened 后才回复 SOCKS success。
2. binary message 是有界 data chunk；text control 至少含 `credit`、`fin`、`reset`。不能仅用 WS close 表示 TCP EOF，因为 TCP 有半关闭而 WS close 没有。首版建议每块 ≤32 KiB、每流未 ACK ≤256 KiB、总计 ≤4 MiB、并发 ≤32；这些是初始设计值，不是现有系统保证。
3. credit 只有在下一跳实际消费/写回调后归还；Native→JS→Relay、Relay→Host TCP 两方向都做。现有 `RelayTunnelWebSocket.send()` 返回 void、没有 drain/bufferedAmount，不能把它宣传为现成的背压 byte stream。[当前接口 L95–106](../../packages/ui/src/lib/relay/tunnel-client.ts#L95-L106)
4. `getActiveRelayTunnel()` 不存在/不是绑定的 runtime generation/未 connected 就拒绝，**不用**可能转 direct 的 `openRuntimeWebSocket` 当最终兜底；现有 helper 的确会在无 active tunnel 时创建普通 WebSocket。[runtime-tunnel](../../packages/ui/src/lib/relay/runtime-tunnel.ts) · [runtime-socket L14–19](../../packages/ui/src/lib/relay/runtime-socket.ts#L14-L19)
5. 新 WS 路径同时加入 `tunnel-host.isTunnelWsPathAllowed` 与 `ui-auth.isUrlAuthWebSocketPath`；由现有 URL-scoped token 体系授权。不能传一个普通 bearer 到 `openWebSocket(..., headers)` 就认为已认证：当前 Host `handleWsOpen` 没转发 `open.headers`，只设置自身 Origin 和 relay connection header。[Host L374–382](../../packages/web/server/lib/relay/tunnel-host.js#L374-L382) · [auth L316–324](../../packages/web/server/lib/ui-auth/ui-auth.js#L316-L324)
6. 两个 tunnel sender 对新 TCP WS 路径使用现有 immediate flush 机制，否则默认 **150ms batch window** 会叠加到 TLS 握手和每轮网络交互。当前仅 remote-desktop exact path immediate；必须双向改，不需要新增 Layer 1/2 协议。[client L858–890](../../packages/ui/src/lib/relay/tunnel-client.ts#L858-L890) · [Host L395–404](../../packages/web/server/lib/relay/tunnel-host.js#L395-L404) · [batch option](../../packages/ui/src/lib/relay/tunnel-client.ts#L149-L163)
7. Host 连接外部站点时不附加 Yuri bearer、GUI options、Host Cookie；目标 TLS 由手机 WebView 校验。业务允许的 localhost/private address 是 **Host 的地址**，须由 Host lease 的目标策略明确允许，不能落到手机 LAN，也不能让公网未认证连接获得通用 TCP 出口。现有 remote-desktop upgrade gate 的 authenticated client/origin/lifecycle 模式可复用为参考。[当前 gate L85–100](../../packages/web/server/lib/remote-desktop/runtime.js#L85-L100)

**原生代理设置示意（传输 API 已核实；不代表 ALL-network 验收通过）：**

```swift
// iOS 17+，gateway 已完成 loopback bind，创建/加载插件 WebView 之前。
let dataStore = WKWebsiteDataStore.nonPersistent()
var proxy = ProxyConfiguration(
    socksv5Proxy: .hostPort(host: "127.0.0.1", port: proxyPort)
)
proxy.allowFailover = false
proxy.excludedDomains = []
// 保持默认全域配置，不指定局部 matchDomains。
dataStore.proxyConfigurations = [proxy]
configuration.websiteDataStore = dataStore
```

```java
if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
    // 返回明确 unsupported，不加载插件文档。
    return;
}
ProxyConfig config = new ProxyConfig.Builder()
    .addProxyRule("socks://127.0.0.1:" + proxyPort)
    .removeImplicitRules()
    .build();
ProxyController.getInstance().setProxyOverride(config, executor, () -> {
    // 仅在所有隔离门槛通过后加载本地插件入口。
});
```

### Gaps

- **API 最低版本不等于已验证最低系统**：未实测 iOS 17.x/当前 iOS 26.x 的 SOCKS domain ATYP、IPv6、HTTP/WS、代理不可用、localhost bypass；Android 应按真实 WebView provider feature 判定，不能给一个未经核实的 Chromium M 号当保障。[feature detection 原理](https://github.com/androidx/androidx/blob/androidx-main/webkit/webkit/docs/feature_checking.md)
- Apple `matchDomains`/`excludedDomains` 文档说明有限；不把“空 excludedDomains”当成苹果所有 implicit-local bypass 已被取消的证明。需要数值 IP、localhost、`.local`、link-local 的设备抓包。
- SOCKS5 的代理侧解析在 Chromium 文档有明确保证；本次未找到同等级 Apple 文档保证所有目标域名都不先在手机解析。必须先测这个条件，再决定 iOS SOCKS5 或 HTTP CONNECT。

## 2. HTTP、DNS、WebRTC 等旁路能否严格 fail closed？

### Takeaway

**当前可公开核实的 stock WKWebView/Android WebView 代理 API，足以实现所列 HTTP(S)/WS(S) 的路由，但不足以证明“任意插件全部网络严格经过 Host”。核心缺口是 WebRTC 的独立 TCP/UDP/DNS 路径，以及原生桥和外部浏览器逃逸。** 没有可靠引擎级封锁就必须返回 unsupported，不能把 document-start 删除 API 或 CSP 当成完整隔离。[WebKit RTC provider](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/webrtc/NetworkRTCProvider.cpp) · [WebKit RTC UDP](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/webrtc/NetworkRTCUDPSocketCocoa.mm) · [AndroidX public API](https://github.com/androidx/androidx/blob/androidx-main/webkit/webkit/src/main/java/androidx/webkit/WebSettingsCompat.java)

### Cited Findings

| 路径 | 核实事实 | 对 fail-closed 的含义 |
|---|---|---|
| HTTP(S)、iframe、图片、script、fetch/XHR、WS(S) | 原生 proxy 覆盖 URL loader；WebKit WS 使用配置过的 NSURLSession；Chromium明确支持四种 URL scheme。[WebKit](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/cocoa/NetworkSessionCocoa.mm) · [Chromium](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md) | 这是免重写的主要收益；跨域 iframe 不需要父页面读取其 DOM。CORS/X-Frame-Options/CSP 等网站限制仍然存在。 |
| 常规 DNS prefetch | 当前 WebKit `canPrefetchDNS()` 在 `m_nwProxyConfigs` 非空时返回 false。[源码 L2118–2124](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/cocoa/NetworkSessionCocoa.mm#L2118-L2124) | 是正面证据，但不能外推到老系统或 RTC resolver。 |
| WebRTC DNS | `NetworkRTCProvider::createResolver` 直接调用 `WebCore::resolveDNS`，并单独处理 mDNS。[源码 L197–245](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/webrtc/NetworkRTCProvider.cpp#L197-L245) | 页面即使不获取摄像头，也不能用拒绝媒体权限代替封锁 ICE/data channel。 |
| WebRTC UDP/TCP | Cocoa RTC 直接建立 NW UDP/TCP connection；所检查的参数配置路径没有采用 data store 的 proxyConfigurations。[UDP L313–328、387–408](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/webrtc/NetworkRTCUDPSocketCocoa.mm) · [TCP L90–106](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/webrtc/NetworkRTCTCPSocketCocoa.mm#L90-L106) | 源码足以否定“看到 proxy API 就认为 RTC 一定走它”；具体系统直连行为仍需抓包，不能声称本次已复现泄漏。 |
| iOS 禁用 RTC | 当前 `WKPreferences.h` 没有公开 RTC 开关；`_peerConnectionEnabled` / `_setPeerConnectionEnabled:` 在 **Private.h**，标 iOS 11.3 起。[public header](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKPreferences.h) · [private header L125](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKPreferencesPrivate.h#L125) | 有具体 SPI 技术路线，但不能写成 App Store 稳定公开 API；已有 shell 使用刷新率 SPI 不代表用户已接受新的发布约束。[当前刷新率 SPI](../../packages/mobile/ios/App/App/YuriBridgeViewController.swift#L151-L175) |
| Android WebRTC | Chromium有独立 `WebRtcIpHandlingPolicy`，包含 `kDisableNonProxiedUdp`；AndroidX `WebSettingsCompat`/`WebViewFeature` 当前公开表未暴露对应开关。[enum](https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/public/mojom/peerconnection/webrtc_ip_handling_policy.mojom) · [prefs](https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/public/mojom/renderer_preferences.mojom) · [AndroidX](https://github.com/androidx/androidx/blob/androidx-main/webkit/webkit/src/main/java/androidx/webkit/WebViewFeature.java) | 不能把 Chrome extension policy、Electron switch 或 Chromium内部 pref 当 Android WebView 的公开能力。并且只禁 UDP 仍不自动覆盖全部 RTC DNS/TCP。 |
| Android loopback/link-local | 默认 bypass 包含 localhost、`*.localhost`、127/8、`::1`、169.254/16、IPv6 FE80；`removeImplicitRules()` 正是为强制代理这些 URL。[官方 Builder](https://developer.android.com/reference/androidx/webkit/ProxyConfig.Builder#removeImplicitRules()) | 必须调用；不能只设置一个代理地址。 |
| Android direct fallback | Chromium单代理不可达时返回 `ERR_PROXY_CONNECTION_FAILED`；只有加入 DIRECT 才可回退；Android空配置会直连。[Chromium](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md#manual-proxy-settings) · [ProxyConfig](https://github.com/androidx/androidx/blob/androidx-main/webkit/webkit/src/main/java/androidx/webkit/ProxyConfig.java) | 不调用 addDirect，不在出错时 clearProxyOverride，也不写空配置。 |
| 已存在连接/worker | Apple要求 page load 前设置；当前实现替换 session 时会让旧 session 已有任务继续完成；Android也要求等待配置 callback。[WebKit L2036–2060](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/cocoa/NetworkSessionCocoa.mm#L2036-L2060) · [Android API](https://developer.android.com/reference/androidx/webkit/ProxyController) | 在已加载任意插件的现有 WebView 上“热切代理”不能证明没有旧直连；应创建干净的受控容器。 |
| 原生/外部入口 | 主 WebView 注册了 Media/Share/Video 等多个 native plugin，GUI代码同文档并非安全沙箱；Android另有系统浏览器桥。[注册表](../../packages/mobile/ios/App/App/YuriBridgeViewController.swift#L180-L196) · [MainActivity](../../packages/mobile/android/app/src/main/java/com/yuri/app/MainActivity.java#L25-L38) · [GUI边界](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#yuri-全局主内容页面) | 页面代理不会自动管控 URLSession/OkHttp/native plugin、外部浏览器、Intent、下载管理器。 |

### Inferences

**必须采用的失败语义（建议）：**

- 先 bind gateway → 设置 proxy → 等平台完成 → 确认绑定 Host 的当前 Relay/lease → 再加载任何插件代码。能力缺失、Host旧版本、Relay断开、原生进程崩溃、切 Host：停止接受新流、reset所有已开流、使该插件容器不可继续联网。**不清除代理、不返回原URL重试、不切LAN直连。**依据平台初始化和现有 runtime generation 边界。[Apple header](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebsiteDataStore.h#L125-L132) · [runtime singleton](../../packages/ui/src/lib/relay/runtime-tunnel.ts)
- 本地 gateway 从不对目标调用手机 DNS/connect；只把 SOCKS hostname/port 交给 Host。IP literal 也交 Host；只允许手机 gateway 自己的 loopback socket和既有 Relay 承载连接。手机要先连接 Relay 本身，这个传输引导连接不可能再递归经过同一条未建立的 Relay。
- 不允许普通页面获得可直连的 native HTTP、浏览器打开、任意 URLSession/OkHttp、URL scheme/Intent 入口。弹窗要继承同一代理/隔离设置或拒绝；下载经过 Host流或拒绝；plugin外部 iframe不挂 Capacitor bridge。主文档内任意JS目前不是沙箱，因此只过滤一次 `iframe.src` 不够。[现有宿主边界](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#yuri-全局主内容页面)
- WebRTC、WebTransport/QUIC、speculation/preconnect、DNS/mDNS、service/shared worker必须进入验证表。TCP代理可让普通HTTP回退TCP，但没有证据时不能假设所有新型API都会回退代理TCP。**未经引擎级禁止的能力不能以“页面不用它”作保证。**Apple CONNECT官方仅TCP、Chromium SOCKS官方无UDP，足以说明承载边界。[Apple](https://developer.apple.com/documentation/network/proxyconfiguration/init(httpconnectproxy:tlsoptions:)) · [Chromium](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)
- document-start脚本、覆写 `RTCPeerConnection`、CSP、Permissions-Policy、拒绝camera/mic可以减少意外使用，**不作为严格网络隔离证明**：原生API未承诺这些机制封锁全部RTC/所有realm/worker；同文档任意JS也有现有native桥。若设计依赖这些，只能标为协作型插件模式，不能按本任务ALL network验收。

**因此实现门槛应拆开：** `tcpProxyAvailable` 与 `strictNetworkIsolationAvailable`。前者当前API可做；后者在stock iOS/Android尚无本次核实的完整公开API方案。iOS SPI禁PeerConnection可做单独技术验证；Android若必须任意不可信页面+硬保证，需要进一步验证可控制网络policy的嵌入引擎/系统能力，不能凭用户允许加依赖就把未验证方案记为已解决。**目前满足“不静默直连”的正确产品行为，是严格能力未通过时不运行该类页面。**

### Gaps

- 未找到同时满足“stock iOS + stock Android WebView、全JS兼容、公开稳定API、不用OS代理/VPN、任意页面零旁路”的完整实现证据；这不是对所有可能引擎的数学不可能性证明。
- 本次没有测试RTC攻击夹具、网络抓包、DNS权威日志、TLS/QUIC降级。不能写“已证明零泄漏”。上游WebKit main的RTC路径不等同于具体发布版本漏洞报告。
- 浏览器内部流量（安全浏览、证书检查、引擎遥测）是否全部受该代理约束没有核实。若ALL字面含这些，也必须明确定义设备抓包边界；`WKWebsiteDataStore`不是全进程防火墙。

## 3. Yuri具体落点、容器选择与跨native/H5改写路线

### Takeaway

**建议采用专用本地插件容器：iOS独立WKWebsiteDataStore，Android独立`:gui`进程；主应用继续持有现有加密Relay。** 它避免代理把承载Relay本身的WebSocket递归吸进去，也避免把插件不受控网络与主Capacitor native权限混在一起。传输不需要重写页面；但新容器不是把现有React里的Solid DOM搬过去，必须增加本地入口与窄RPC适配。[当前GUI宿主](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#所有权与运行时) · [Android process scope](https://developer.android.com/reference/androidx/webkit/ProxyController)

### Cited Findings

- GUI当前共用 `bundle.ts`、`host.ts`、`GuiPluginsProvider.tsx` 和 `GuiPluginMount` 的同文档Solid生命周期；options只放所属context内存。新容器应复用这套bundle/context语义，不把插件页面变成远端截图。[GUI owner](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#所有权与运行时) · [Mount](../../packages/ui/src/components/gui-plugins/DOCUMENTATION.md#gui-plugin-ui-boundary)
- `getActiveRelayTunnel()`/`adoptRelayTunnel()`已有现成当前连接所有权；`createRelayTunnelClient`另有 `createWireSocket`注入点。[runtime-tunnel](../../packages/ui/src/lib/relay/runtime-tunnel.ts) · [wire interface L46–79、149–155](../../packages/ui/src/lib/relay/tunnel-client.ts)
- Android已有 `NotificationConnection`/`NotificationRelayCrypto` 的原生E2EE实现，但它仅订阅notification SSE、独立建连接、`batch:false`、只接受stream 1；不是可直接复用的通用TCP tunnel客户端。[代码 L113–169](../../packages/mobile/android/app/src/main/java/com/yuri/app/NotificationConnection.java#L113-L169) · [README native notifications](../../packages/mobile/README.md#native-android-background-notifications)
- 当前 mobile `shellApiVersion` 为3；原生bridge变化需更新shell契约/发行下限，OTA不能增加新native插件。[capacitor config](../../packages/mobile/capacitor.config.ts#L31-L38) · [mobile runtime docs](../../packages/mobile/README.md#yuri-native-identity-migration-shell-api-2)
- Scramjet官方自称 **experimental interception-based web proxy**，采用interception/rewriting/sandboxing；不是一个官方保证iOS/Android全页面兼容和零旁路的成熟内核替代品。Context7所检索bootstrap使用service worker及transport `request`/`connect`适配，不能据此假定现有Yuri tunnel已与其transport兼容。[官方 README](https://github.com/MercuryWorkshop/scramjet) · [Context7所引用仓库](https://github.com/mercuryworkshop/scramjet)

### Inferences

**选定的隔离容器设计（建议；先过第二节strict capability门槛）：**

1. iOS `YuriGuiWebViewController`创建专用store、专用SOCKS listener、本地bundled入口；Android `GuiPluginActivity`声明 `android:process=":gui"`、`exported=false`，该进程最早初始化WebView data suffix，再设置proxy、load本地入口。**独立进程只隔离WebView代理设置，不是OS网络沙箱，也不会自行解决WebRTC。**[Android目录约束](https://developer.android.com/reference/android/webkit/WebView#setDataDirectorySuffix(java.lang.String))
2. 新入口只挂载现有GUI host需要的renderer/context，主应用传当前session/主题/locale/选中contribution和内存options；Host API调用经窄RPC回现有runtime owner。不能向插件WebView注入整个主Capacitor桥，也不能将Host credentials放URL/持久化。[现有options及context契约](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md#yuri-全局主内容页面)
3. gateway的stream事件通过原生owner送主应用Relay adapter；Android跨进程用有界Binder消息/FD通道，iOS本进程回调，JS bridge首版可沿用现有base64块模式，但必须credit限额。Base64/native IPC有拷贝成本，不宣传零拷贝。[现有native byte bridge限制](../../packages/mobile/README.md#native-virtual-image-asset-bridge)
4. 主应用隐藏/后台、renderer被挂起时，不准native gateway自行拨外网；流超时并关闭。若主WebView在插件容器可见时被系统挂起导致可用性差，后续把**同一个Relay connection owner**迁移到native，而非复用通知服务偷偷另开一条通用连接。是否有此问题先做真机生命周期测试。[当前通知连接是独立且窄用途](../../packages/mobile/README.md#native-android-background-notifications)
5. 系统最低线：iOS插件功能17.0+；Android隔离进程首版API28+且`PROXY_OVERRIDE`支持。整个app是否抬最低版本不是传输必需，可保留原min target，只让老设备明确unsupported。[当前targets](../../packages/mobile/android/variables.gradle) · [Podfile](../../packages/mobile/ios/App/Podfile)

**预计文件落点：约25–35个生产/配置文件 + 6–10个测试/文档文件；为范围估计，不是已实施清单。** 其中最不确定的是把同文档GUI context桥到第二WebView的适配规模，不能按“加几行代理设置”估工。下表新增文件名为建议；已存在文件已在本次阅读/定位。[现有ownership依据](../../packages/ui/src/lib/gui-plugins/DOCUMENTATION.md) · [Relay结构](../../packages/web/server/lib/relay/DOCUMENTATION.md#entrypoints-and-structure)

| 模块 | 具体预计文件 | 职责 |
|---|---|---|
| Host新模块 | **新增** `packages/web/server/lib/gui-network/{runtime.js,tcp-bridge.js,protocol.js,DOCUMENTATION.md}` | authenticated WS upgrade、lease、目标/DNS策略、TCP lifecycle/credit/half-close |
| Host注册/鉴权 | **修改** `packages/web/server/index.js`、`packages/web/server/lib/relay/tunnel-host.js`、`packages/web/server/lib/ui-auth/ui-auth.js` | attach/stop新模块、新exact WS allowlist、URL-token、双向immediate |
| UI连接适配 | **新增** `packages/ui/src/lib/gui-plugins/network-bridge.ts`、`mobile-container.ts`；**修改** `packages/ui/src/lib/relay/tunnel-client.ts` | 复用active tunnel，绑定runtime generation，native streams↔WS，取消、credit |
| 本地GUI入口 | **新增** `packages/ui/src/apps/GuiPluginApp.tsx`、`packages/web/gui-plugin.html`、`packages/web/src/gui-plugin-main.tsx`；**修改** `packages/web/vite.config.ts` | app内本地render entry；共享host/context。现有`packages/mobile/scripts/prepare-web-assets.mjs`整目录复制web dist，可带上新入口，无需为复制单独改它。[复制源码](../../packages/mobile/scripts/prepare-web-assets.mjs#L29-L37) |
| GUI context接缝 | **修改/拆分** `packages/ui/src/lib/gui-plugins/{GuiPluginsProvider.tsx,host.ts,react.ts}`，按实际依赖增`container-rpc.ts`；页面入口处调用native容器 | 把当前会话/配置/文件/SDK等窄能力接入新owner，不fork整个插件系统 |
| iOS | **新增** `YuriGuiNetworkPlugin.swift`、`YuriGuiWebViewController.swift`、`YuriSocksGateway.swift`；**修改** `YuriBridgeViewController.swift`、Xcode project文件 | 专用store、proxy、local assets、只读/窄native bridge、bounded stream IPC、清理 |
| Android | **新增** `YuriGuiNetworkPlugin.java`、`GuiPluginActivity.java`、`GuiNetworkService.java`、`GuiSocksGateway.java`、进程bootstrap类；**修改** `MainActivity.java`、`AndroidManifest.xml`、`app/build.gradle` | :gui初始化/后缀、ProxyController、owner IPC、有界SOCKS、生命周期 |
| Native契约/版本 | **新增** `packages/mobile/src/yuri-gui-network.ts`、`packages/mobile/contracts/yuri-gui-network.mjs`；**修改** `packages/mobile/contracts/index.mjs`、`packages/mobile/capacitor.config.ts`、`packages/mobile/src/yuri-ota.ts`、mobile README | capability探测、shell API/OTA门槛、旧壳明确unsupported |
| 测试 | Host真实TCP桥测试、Relay E2EE集成测试、iOS SOCKS/native容器测试、Android instrumentation、runtime切换/取消UI测试 | 对准真正网络字节、失败与生命周期，不只snapshot/mock |

**较少文件的替代落点（不作为本次首选）：** 直接对现有主Capacitor WebView设置proxy，保留当前GUI DOM；借现有 `createWireSocket` seam，把承载Relay的物理WS换成native URLSessionWebSocketTask/OkHttp，TS E2EE/mux仍复用。这样不会递归代理Relay，但影响整个移动app的LAN连接、全部WebView请求、启动前连接选择和native权限边界；必须强制清洁的Relay-only启动/重建，不能热切代理后宣称隔离完成。它节省新GUI context bridge，却扩大产品行为面。[wire seam](../../packages/ui/src/lib/relay/tunnel-client.ts#L149-L155) · [当前mobile连接模型](../../packages/mobile/README.md#runtime-model)

**本地HTTP resource gateway +成熟改写器，是否更适合跨native/H5？**

- 可复用上述Host出口/现有Relay，给改写器提供transport adapter；native用loopback HTTP资源入口，H5使用同源受控入口/service worker。它是浏览器内重新定义URL/网络API语义的另一条产品路线，**不是把SOCKS API抽成跨端hook即可复用**。当前原生`yuri-asset`是image-only，而视频HTTP gateway是Range-only，都不能原样承载任意网页。[native bridges](../../packages/mobile/README.md#native-virtual-image-asset-bridge) · [video](../../packages/mobile/README.md#native-video-range-bridge)
- 不建议为已有原生系统代理再加全面HTML/JS改写层。原生proxy可保留原始origin/TLS/Cookie；重写路线另需解决动态URL、modules/import、worker、嵌套iframe、Cookie/origin、CSP/SRI、WS、页面自身导航。Scramjet是可评估候选，不能按官方README称其“成熟已保证”。[Scramjet](https://github.com/MercuryWorkshop/scramjet)
- H5无本次核实的网页级系统代理配置API；不能把native的proxyConfigurations/ProxyController保证推广到普通Safari/Chrome页面。改写器可以提高覆盖率，但在本任务ALL network标准下仍须给出WebRTC等旁路封锁证据；否则H5严格模式必须明确unsupported，不静默加载原始外链。

**最先做的验证，不应先做市场UI（建议验收顺序）：**

1. 无产品接入的native probe：代理不可达时，HTTP/HTTPS/ws/wss/iframe/redirect、localhost/IPv6/link-local、worker、WebRTC STUN/TURN/datachannel、WebTransport分别是否有手机直连/DNS包。所有目标使用自控canary域名并看权威DNS/目标服务日志；切断Host/Relay重复。未过则停止宣布strict可用。
2. 现有真实Relay同连接：32并发TCP、TLS握手、大文件、Range、上传、WS、半关闭、IPv6、断开/重连、Host切换；验证既有chat/SSE不会被TCP数据饿死，150ms窗口已在两端消除。
3. 原生生命周期：打开插件容器后主WebView是否被挂起；旋转/退后台/进程杀死/恢复/换Host后是否有旧流、旧凭据、旧Cookie跨runtime复活。
4. 最终“全部流量”证据：手机可见目的地址只有当前Relay连接及本地loopback；所有插件目标请求来自Host。允许缓存命中，但不能以“页面成功打开”代替此项证明。

### Gaps

- 没有运行上述probe；本报告支持“确定传输接缝、实施最小TCP链路”，不支持“已找到可直接上线的跨端零旁路方案”。
- 专用GUI入口所需的session/files/layout/SDK桥接详细接口尚未逐成员设计；应沿现有host依赖注入拆分，而不是拷贝完整Provider/store。
- Scramjet在Capacitor custom scheme、loopback HTTP、iOS service worker和所需网站上的完整兼容性未验证；Context7摘要出现不同bootstrap/transport实现，不能据此锁定版本或写死导出名。相邻改写器研究应核对具体发行版源码。
- **交给总报告的明确决策句：选native SOCKS/CONNECT→现有加密WS子流→Host TCP作为原生传输；把WebRTC/其他非URL网络硬封锁列为先决实验。未经证明则拒绝严格模式，不能用“已设置代理”或“有成熟rewriter”跳过这一条件。**
