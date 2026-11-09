# 真实 WK 资源子文档隔离回归

这是 oracle `ses_e49387016fferf3yKIDNZ57xhd` 的 P1 对应的**可执行 UIKit fixture**，不是 Foundation 的 SOP 模拟。仅 main 独占安装与 UIKit 运行；builder 可以编译并 ad-hoc 签名，但不会调用 nsh、simctl、install、launch、Keychain 或网络。

编译输入使用生产 `RuntimeHostScope.swift`、`ResourceWebPreviewBridge.swift`、`GuiPluginPreviewBridge.swift`、`GuiPluginResourceResolver.swift`、`GuiPluginDeviceBridge.swift`，以及现有 `packages/mobile/ios/App/App/YuriViewExportRenderer.swift`，再加 `GuiPluginWKBoundaryFixture.swift`。不需要 NSH engine 或 Capacitor，fixture 通过生产 bridge 的 present/capture 和真实 WK handler 运行。

## 独立构建入口

```sh
NSH_DIST="/path/to/nsh" node packages/nsh/scripts/build-gui-wk-boundary.mjs
```

只构建 arm64 simulator：iOS 26+ SDK、最低部署 iOS 15，匹配生产 NativeShell。`NSH_DIST` 或 `NSH_BIN` 只用于发现真实 `NativeShell.xcframework/ios-arm64-simulator`；不启动引擎，不构造 NshAppView，不以 stub 替换任何生产 bridge。真实静态 framework 用于链接；若发行包为动态 framework，则冻结、嵌入并单独签名。

每次构建生成唯一 `run-<8hex>` 和 `example.nsh.gui-wk-boundary.run-<8hex>`，输出在 `.nsh/gui-wk-boundary/run-<8hex>/`，没有可误指向旧包的 latest 别名。编译前将八个真实 Swift 输入和 framework 冻结到 `frozen/`，逐文件 SHA-256 校验，编译器只读取只读副本，编译后再次核对。source manifest 也冻结 getter adapter、对应 browser/Foundation 回归和 builder 源码，标明这些是 browser-regression/builder provenance，而不是冒称它们在此 WK App 内执行。外部 manifest 记录编译命令、SDK、签名验证、executable hash 及 live source 是否已变化。

独立 `main.swift` 是轻量 UIKit 入口，直接调用同一个 fixture，不改断言、不替换 device/Storage/RPC。成功必须保留主 frame 合法调用和**全部六个子文档**的安全/资源能力结果。App 在 Documents/result.json 原子写入 `success`、`failed` 或 `invalid`，含 buildID、bundleID、sourceHash、failureCase、runID 和 evidence；初始 `invalid/run.incomplete` 仅表示本次尚未完成，不能当通过。屏幕最终显示 PASS 或 FAIL。启动时会验证包内 source-manifest 的 hash 和 bundleID，错误为 invalid；崩溃或未完成也绝不写 success。

Host 读取/loopback/RPC capture 均为原 fixture 的内存 closure，无 sockets 或真实 Host。生产 Storage 仍按原断言使用隔离的 App 临时目录，report 写 Documents，clipboard 检查后恢复；没有将这些真实生产能力换成内存 fake，也不接 Keychain。

### 根桥 proof 与安全失败细分

main 对 `run-ed0b59c5` 实际运行返回 `fixture.root-bridge.result-string`、nativeRPCObserved=false。现 SDK 的签名已确认：`in: .page` 选中默认 completionHandler=nil 的同步 Void 重载，`try await` 不会使它变成异步；真正 async throws -> Any? 重载使用 `contentWorld: .page`。fixture 的 root probe、启动 children、最终 escape 检查三处均改为后者。原顶层 `return JSON.stringify(proof)` 保留，三处调用标签由真实 SDK 的 warnings-as-errors 编译回归约束；纯 wire 测试继续执行原样完整函数体，并检验缺少顶层 return 时只能得到 undefined。

报告另含 `rootResultType`（原返回值的 Swift 类型名，或固定 nil/not-observed）和 `rootProof.resultPresent`，在 String 转换前采样，避免将 Void、nil 或其他类型混为 JSON 解码失败。只记录类型名和固定布尔值，不记录对象描述或正文。

main 已独占安装并运行 `run-fd1ca671`，同次 manifest/result 的 buildID、bundleID、sourceHash 校验通过。真实 WK 返回 `status: success`，主桥全部 proof 为 true，六个 case 均完成，`rpcReads: 1`、`hostApprovals: 5`，clipboard/storage 均未被越权修改。源码 hash 为 `522ac85c731115b7e3b564f221c361ff4f70e9c3a5dc43e044de3387db5c2598`。原始报告及 manifest 保存在 `.scratch/nsh/gui-wk-boundary-fd1ca671/`。此结果仅证明该冻结包的边界用例；真实插件、网络字体、导出与 Photos 等能力仍需各自验收，后续源码变化不沿用本次通过。

main 对旧 `run-19fd5142` 的真实 UIKit 运行已返回 `failed / fixture.root-bridge`；旧报告没有 root proof 值，不能据此断定 device、Storage、bootstrap 哪项失败，也不是 timeout 或 WK 子文档权限已经验收通过。

当前 probe 严格按生产 wire 调用：bootstrap 是裸对象；device capabilities 是 `{ok:boolean,value:...}`；同步 Storage prompt 返回 JSON 字符串 `{ok:boolean,value:string}`；RPC 是 `{status,mime,headers,base64}`。使用本次 fixture 已 admit 的不可变 receipt，并要求 bootstrap 的 receipt、runtimeKey、preferenceKey 及原 cached scope 全部匹配；没有接受 scope 错误或切换到其他 scope 的 fallback。JSON 字符串只承载已经计算好的布尔 proof，避免把整个原始 JS reply 转成 Swift Bool 字典；原 reply 的布尔类型和值仍严格判定，不把 `1`、数组或错误 envelope 当成功。

`result.json.rootProof` 只保存固定布尔字段，包括 `resultString/resultDecoded`、bootstrap identity 是否匹配、device envelope/能力是否匹配、Storage prompt/JSON/envelope/sentinel 是否匹配、RPC 的 status/mime/body 是否匹配，以及实际 native callback 的 `nativeRPCObserved`、`nativeStorageValueMatched`。不记录 raw reply、scope/lease、token、Storage 内容或正文。failureCase 分为 `fixture.root-bridge.result-string/result-decode/bootstrap/device/storage/rpc`；之后的子文档失败仍有原 case 名，不会合并为根桥失败。

只有根桥 proof 四组（含 RPC）全部通过后才创建六个子文档。所有原子文档隔离、脚本、样式、fetch 和最终 clipboard/Storage/RPC 断言仍保留。`gui-wk-root-proof.test.ts` 只执行这段真实 probe 的 wire 解析正反例，不模拟 WK SOP，也不把纯测试当作真实 bridge 运行成功；新的真实 UIKit 结果仍由 main 独占取得。

main 独占执行以下命令，明确使用**本次 builder 输出的 manifest**：

```sh
fixture_manifest="<本次输出的 manifest.json 绝对路径>"
fixture_udid="<main 独占的 simulator UDID>"
fixture_app=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).app)' "$fixture_manifest")
fixture_bundle=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).bundleID)' "$fixture_manifest")
xcrun simctl install "$fixture_udid" "$fixture_app"
xcrun simctl launch "$fixture_udid" "$fixture_bundle"
fixture_container=$(xcrun simctl get_app_container "$fixture_udid" "$fixture_bundle" data)
# 等屏幕 PASS/FAIL 后读取；初始 run.incomplete、没有文件或 timeout 都不能计通过。
cat "$fixture_container/Documents/result.json"
node -e '
const fs=require("node:fs");
const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const r=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if(r.status!=="success"||r.buildID!==b.buildID||r.bundleID!==b.bundleID||r.sourceHash!==b.sourceHash) process.exit(1);
console.log("SAME_BUILD_GUI_WK_BOUNDARY_PASS",r.buildID,r.sourceHash);
' "$fixture_manifest" "$fixture_container/Documents/result.json"
```

## 嵌入既有测试 host

在已 attached、applicationState 为 active、没有其他 modal 的测试 UIViewController 上调用：

```swift
Task { @MainActor in
    do {
        let evidence = try await GuiPluginWKBoundaryFixture.run(in: controller)
        print("GUI_WK_BOUNDARY_PASS", evidence)
    } catch {
        print("GUI_WK_BOUNDARY_FAIL", error)
    }
}
```

内部使用确定性的临时 storage、私有内存 resource/loopback transport 和 test-only HTML，不接真实 Host、不联网。clipboard 仅用固定 sentinel 检查越权写入，结束恢复原 items，不记录内容。fixture 不注册假 device/storage/RPC handler：这些动作都走生产 `guiPluginPreview`；额外的 `guiBoundaryResult` handler 只接收无权限的测试结果。

验收必须同时满足：

1. 主 GUI frame 的真实 bootstrap、device capabilities、Storage read、RPC 均成功，排除“整个 bridge 被关掉”的假绿。
2. 工作区 HTML、loopback HTML、绝对 Host HTML 及三者的 srcdoc 后代，共六种实际 WK 子文档；每个的 `parent.eval`、`parent.Function`、`top.eval`、`top.Function` 都抛 `SecurityError`。payload 若执行，会设置主 frame 标记并尝试 device copy、Storage 写入、RPC；最终还检查主标记不存在、clipboard/storage 不变和 RPC 仅有一次合法主 frame 调用。
3. 子文档直接调用 bootstrap/device/RPC 被拒，直接 Storage prompt 返回 null。frameInfo 校验仍保留，作为独立防线；P1 修复依靠 native response CSP 的 opaque sandbox，而非单靠这些 frameInfo 断言。
4. 三个资源 HTML 的 inline/classic/module script、按钮事件、外部相对 stylesheet、简单 GET fetch 仍可工作；绝对 Host 页及相对资源的 captured Host predicate 至少成功校验五次。Host URL 采用 `/__gui/host/<encoded-origin>/api/fs/serve/<workspace-path>` 保留目录，每次 read 仍经过不可变 captured predicate、canonical/workspace 检查，没有 JS 猜 Host 或开放 base-uri。不能以禁脚本、禁 iframe 或页面未加载造成安全断言通过。
5. 整个过程经过生产 scheme handler 和生产 response-header helper。资源响应含 `sandbox allow-scripts allow-modals allow-downloads`，**没有 `allow-same-origin`**；资源 CORS 为无凭据 `*`，主应用入口不开放 CORS。原网络规则、native owner/workspace 以及 GET 限制仍生效。

main 请记录返回 evidence 或具体失败 case；`timeout` 也是失败，不能把没收到子文档结果当拒绝成功。旧响应策略下父 frame 攻击应失败验收，修复后仍需实际 WK 运行证明。当前 Foundation 检查只证明响应策略/上游 CSP/资源 CORS 的合成合同；browser artifact 只证明真实 JS adapters。两者都不能代替此 fixture。

P2 的独立 browser regression 位于 `gui-plugin-device.test.tsx`：iframe 自己的 URL constructor 与父 realm 不同，校验传到底层的确实是映射后的 scoped URL。getter 必须捕获对应 realm 的原生 URL.href 和 Request.url/method/headers/signal getter，直接 call 验证内部槽位；`Object.create(realm.URL.prototype)` 或 Request prototype 配自有属性的伪造输入均显式拒绝，真实实例的自有 shadow 属性不能覆盖内部值。POST、omit、redirect、signal 和 owner 恢复合同不变。
