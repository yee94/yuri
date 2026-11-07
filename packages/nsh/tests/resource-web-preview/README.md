# 独立 UIKit / WKWebView 资源验收载体

仅合成 transport，真实生产 `ResourceWebPreviewBridge`、scheme handler、WKWebView 与安全策略。没有 RuntimeBridge、ConnectionStore、Keychain、真实 Host、URLSession/Relay 或 NSH engine；不往资源页面安装 NativeShell/应用脚本桥。测试控件和计数不是产品 UI。

## 中文乱码：编码声明与保真

main 已确认修复规则后的旧产物正常保持打开，真实 CSS/JS/PNG 工作，但 HTML 中文 AX 是乱码。旧 synthetic transport 使用 `Data(...utf8)`，HTML/CSS/JS 的 Content-Type 却均不声明 charset，HTML 也无 meta。新增声明回归测试先红后绿；现在仅给这三种合成 UTF-8 文本补 `charset=utf-8`，PNG 不变，不加 meta 或脚本纠正内容，借此继续验证 WebKit 真正消费响应编码。

**最新已签名独立产物**：`packages/nsh/.nsh/resource-web-preview-uikit/2026-11-07T08-01-06-135Z-878ce5ff/ResourceWebPreviewUIKitFixture.app`。未安装、未启动。main 在当前旧 modal 完成 DOM 点击和 Done/counter 取证后退出旧进程，再安装/运行新产物，复验中文标题“资源 WKWebView 验收”、CSS 中文后缀、“相对 JS 已执行”和“点击改变 DOM”→“点击次数：1”。仍须确认捕获=释放、在途=0、首次失败=无。

生产链路核对与覆盖（没有改 RuntimeBridge）：

- `ios/RuntimeBridge.swift:361,365,403,449`：preview/file 的 Relay 分支取完整 `content-type` header value，直连取 `value(forHTTPHeaderField:"Content-Type")`，没有用会丢参数的 `mimeType` 属性；转成 `ResourceWebPreviewResponse` 仍保留原值和原 Data。
- Host `../web/server/lib/fs/routes.js` 的 `/api/fs/serve` 在原授权/realpath 后调用真实 `res.type(mimeType).sendFile(...)`；当前 Express 5.2.1 的 header 设置会给 text/html/text/css/application/javascript 附 `charset=utf-8`，二进制保持 application/octet-stream。新增 `resource-web-preview-encoding.test.ts` 直接运行真实 route、文件授权和真实 Express header 方法，仅将 sendFile 的最终传输替换为捕获；全部是临时合成文件，没有监听端口/Host 请求。这不是对任意文件字节的编码识别能力声明。
- Bridge 原本已将完整 `response.mime` 写入 HTTPURLResponse。本轮把相同构造移到生产使用的 Foundation-only `webResponse(for:)`，使测试可实际检查同一输出，未改变字节或改成丢 CSP 的普通 URLResponse。`validate` 中按分号拆分只用于 MIME 准入，不用于输出头。
- Foundation 测试检查 UTF-8 与 ISO-8859-1 HTML 的完整头/`textEncodingName`、原始 Data，缺少 charset 的 HTML/PNG/octet-stream 不被猜成 UTF-8；authorized proxy adapter 也保留非 UTF-8 header+bytes。HTTPURLResponse 仍包含 CSP/no-store/no-referrer/nosniff，WK callback 使用该生产 helper 并交付原 Data。

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/resource-web-preview.test.ts packages/nsh/resource-web-preview-swift.test.ts packages/nsh/resource-web-preview-encoding.test.ts
```

结果 **3 files / 11 tests passed**，含真实 WebKit 规则编译与完整 iOS typecheck。当前 RuntimeBridge 不需要 charset 修法；不要把 full Content-Type 改为 `mimeType`/只取分号前段，也不要为全部响应追加 UTF-8。

**仍需区分的服务端边界**：现有 Host preview proxy 的 HTML/CSS/JS rewrite 使用 `responseBuffer.toString('utf8')`，本轮无权修改该服务端。Native head/raw-byte 保真测试不能证明该已有重写管线兼容任意非 UTF-8 dev-server HTML。若要验收该情况，须 main 在拥有的 Host proxy 范围单独处理编码/重写契约；这里不以 fixture 的 UTF-8 修正掩盖它。

## 正常 HTML 即刻退出：规则编译红绿回路

main 实测旧产物：`拒绝：response`、捕获/释放 `1/1`、读取 `2`、CSS/JS/图片 `0/0/0`。已用独立 macOS WebKit 规则编译器复现同一生产规则（只调用规则编译，不创建 WebView/NSH engine/网络，不启动 Simulator）：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/resource-web-preview-swift.test.ts -t 'exact production network-block rules'
```

- **红**：原 `^(https?|wss?|ftp|file):` 报 `rules.compile WKErrorDomain 6`，WebKit 明确 `Disjunctions are not supported yet`。正好发生在 stat/entry 两次读取后、modal 和子资源之前。
- **最小修复**：改成 `^https?:`、`^wss?:`、`^ftp:`、`^file:` 四条等价 block rules。保留相同阻断集合及 CSP/导航策略；nil compiled rules 同样失败关闭，不跳过规则。
- **绿**：上面同一命令通过；完整 resource-web-preview pure/Swift 文件 `2 files / 9 tests passed`，含真实规则编译、六种协议阻断语义、诊断字段脱敏、完整 iOS SDK typecheck。

新的独立已签名构建为 `packages/nsh/.nsh/resource-web-preview-uikit/2026-11-07T07-51-14-204Z-6a7658e8/ResourceWebPreviewUIKitFixture.app`。未安装、未启动；main 先退出旧 fixture，再安装/启动新二进制，避免仍运行旧版本。

`ResourceWebPreviewBridge` 新增默认 nil 的 native-only `diagnostic:` 回调；fixture 将当前阶段与首次失败写入同一个 `resource-preview-counters` AX label。只含枚举阶段、允许名单内的 NSError domain/code；不包含 localizedDescription、userInfo、URL、query、token、响应内容，也不向资源 JS 暴露接口。未知 NSError domain 归为 `OtherErrorDomain`，避免其自身携带数据。

main 首轮仍点“打开 HTML”，检查 CSS/JS/PNG 与 DOM 按钮；点 Done 后读 AX，应为 CSS/JS/图片各至少 `1`、`首次失败：无`、捕获=释放、在途=0。若仍退出，请回传 AX 中的 **阶段 / 首次失败 domain+code / 原有计数**：

| 阶段 | 定位 |
| --- | --- |
| `stat.read` / `stat.validate` / `entry.read` / `entry.validate` | 原生 transport 或入口校验 |
| `rules.compile` | 真正的 WKContentRuleList 编译/空结果，旧缺陷对应 `WKErrorDomain 6` |
| `response.construct` | custom-scheme HTTPURLResponse 构造；没有改成缺失 CSP 的普通 URLResponse |
| `response.deliver` | 向 WKURLSchemeTask 交付响应/bytes |
| `scheme.admission` / `scheme.route` / `subresource.read` / `response.validate` | 资源准入/映射/合成读取/响应校验 |
| `navigation.policy` / `navigation.provisional` / `navigation.committed` | 原有导航策略或 WebKit 导航回调 |
| `content.process` | Web content process 终止 |

UIKit 同一入口的实际修复结果仍待 main 复验。HTTPURLResponse/WebKit 导航没有因推测被替换或放宽；若存在第二故障，以上阶段会继续定位。正常内容确认后，再执行下方越界/外域/关闭/失效释放场景。

## 只构建

```sh
NSH_DIST="/path/to/nsh" node packages/nsh/scripts/build-resource-web-preview-uikit.mjs
```

需要 Xcode iOS 26+ SDK、arm64 Simulator NativeShell distribution；也可用 `NSH_BIN` 定位 distribution，但不会执行 NSH。只编译两份 Swift 源码并 ad-hoc 签名。Bundle ID 为 `example.yuri.resource-web-preview-uikit`，每次输出到 `.nsh/resource-web-preview-uikit/<timestamp-uuid>/`，清单为 `fixture-build.json`；绝不覆盖 `.nsh/out`、`.nsh/bundle`、原 App 或过去 fixture，不安装、不启动、不操作 simulator。外域测试的 `.invalid` 地址仅用于验证生产阻断策略，不承载服务；所有正常资源均为内存合成，未实际运行前不能据此声称 DNS/外域无泄漏。

## 交 main 串行设备验收

由 main 在 engine 窗口结束后选择目标 UDID，并使用构建清单中的实际 APP 路径：

```sh
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" example.yuri.resource-web-preview-uikit
```

本次子任务只构建，未执行以上命令。不得把成功构建写成以下项目通过。

| 场景 | 操作与预期 |
| --- | --- |
| HTML 相对子资源 | `resource-preview-open-html`。页面出现绿色边框与“相对 CSS 已加载”“相对 JS 已执行”“相对 PNG 已解码”；点击“点击改变 DOM”，次数逐次增加。没有 Swift evaluateJavaScript 或假 load 回调 |
| 合成 Host proxy | `resource-preview-open-proxy`。复用真实 authorized adapter 的 POST metadata/固定 TTL/私有 token header 与单 target GET，同样检查 CSS/JS/PNG/DOM。它不是网络/配对联调 |
| 外域拒绝 | 页面“尝试外域图片”，应显示“外域图片已阻断”，不能出现“失败：外域竟然加载”。结合 WebKit/网络取证确认没有外域 DNS/请求，不能仅靠图片 onerror 宣称无泄漏 |
| 越界拒绝 | 页面“尝试目录越界”或根页 `resource-preview-open-outside`；生产 scheme authority 应结束预览，根页结果“拒绝：response”；synthetic transport 不应收到 private 资源 |
| Done / dismiss 释放 | 页面点系统 Done（或真实 swipe dismiss）。根页结果“用户关闭”；待 dismiss animation 结束，`捕获=释放` 且 `在途=0`。连续重复 3 次，每次新捕获只释放一次 |
| 关闭取消在途 | 页面“开始慢图片”，立即 Done；合成慢读取 8 秒尚未结束即应取消，`取消` +1，最终 `在途=0`、`捕获=释放`；不等待慢资源后伪称取消 |
| Host 失效 | 根页 `resource-preview-open-invalidate`，打开慢资源，Swift 在 2 秒后改变 captured generation 并调用真实 `invalidate()`；预览退出、结果“已取消/Host 失效”、取消 +1、在途=0、捕获=释放。再开正常 HTML 不继承旧 owner |
| 后台 | 打开后进入后台，fixture delegate 同步 invalidate；恢复后没有旧预览，重开正常 |

根页 `resource-preview-counters` 的 AX label/text 可取观察计数；其他根页 AX 为 `resource-preview-open-html` / `resource-preview-open-proxy` / `resource-preview-open-outside` / `resource-preview-open-invalidate` / `resource-preview-invalidate`。页面按钮为真实 DOM/AX 文本，原生关闭为系统 Done。fixture 不提供页面到 Swift 的测试 IPC，也不自动点击或宣布成功。

仍缺真实 direct/Relay-only Host、配对/撤销/过期在途、WebKit custom scheme fetch/module/CORS、浏览器全部交互（POST/WS/HMR/SSE/worker/下载等）、生产入口状态/视觉与 Eficy/Solid runtime；完整范围见 `../../RESOURCE-WEB-PREVIEW-VALIDATION.md`。
