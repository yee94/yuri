# Native Passkey management handoff

本目录只用合成内存传输验证原生合同。运行 `node packages/nsh/scripts/check-passkey.mjs`：编译并执行 Foundation policy/真实 RuntimeBridge 内存测试，再针对本机 iPhoneOS SDK、iOS 15 deployment target 类型检查 UIKit/AuthenticationServices 和 RuntimeBridge。callback 测试用本目录的最小 UIKit/AuthenticationServices SDK doubles 编译实际 `PasskeyBridge.swift`，由测试显式完成 dismiss/delegate；十语标签测试用 Bun 执行纯 TS 断言，不调用 NSH。NativeShell 只替换 handle/send 注册，ConnectionStore 只替换 Keychain 初始化与持久化；没有网络 listener、URLProtocol、真实 Host、Keychain 写入、系统认证、NSH engine 或设备操作。

## main 装配

main 保留一个 `PasskeyBridge` 属性，surface 与 `RuntimeBridge` 就绪后创建：

```swift
let passkeys = PasskeyBridge(
    app: surface,
    presenter: self,
    associatedDomains: signedBuildWebcredentialsEntries,
    capture: { [weak bridge] expectedHost in
        guard let bridge else { throw CancellationError() }
        return try bridge.passkeyTransport(expectedHost: expectedHost)
    }
)
self.passkeys = passkeys
```

`signedBuildWebcredentialsEntries: Set<String>` 必须来自该安装包实际声明的 `webcredentials:<RP>` 构建能力，不能由 JS、用户输入 URL 或 Relay 域名动态扩展。没有受信任的构建输入就传空集合，返回 `passkey_associated_domain_required`。iOS 没有公开可用的 SecTask entitlement 读取 API；此参数只是提前失败检查，真正的签名 entitlement、RP 的 AASA 与系统凭据关联仍由 AuthenticationServices 强制校验。不能将 plist 字符串当作系统 entitlement 已验证证据。

现有 `RuntimeBridge.setForeground`/`stop` 的调用必须继续覆盖真实前后台、Host/授权切换与 controller 退出。它们退役所有被捕获的 session owner，取消 URLSession task、密码 alert 和正在进行的系统注册。main 不需要再接四个 `app.handle`，bridge 初始化已注册。

退出时 main 的 `shutdownTask` 必须持有该 Bridge，调用 `await passkeys.close()`，完成后才释放。`close()` 幂等且永久关闭 admission，取消 status/login native task、密码窗和系统注册；等待密码窗 `dismiss` completion、系统 delegate/cancel waiter 以及原 operation 的 exact reservation defer 全部排空。等待期间不接纳新的 authorize/register/reset；cancel cleanup 仍可完成。不要先置空唯一持有属性再 fire-and-forget 调用 close。

Swift 编译清单需包含 `PasskeyPolicy.swift`、`PasskeyBridge.swift`；生产 build 当前按 `ios/*.swift` 收集。手写 RuntimeBridge harness 的显式清单也要追加 `PasskeyPolicy.swift`（如 `scripts/check-native-bridge.mjs`、`gui-plugin-runtime-fixture.mjs`、`terminal-runtime-fixture.mjs` 和直接 Swift 编译的测试）；本 agent 未修改其它 owner 的 harness 清单。

## API 与安全边界

| API | 合同 |
| --- | --- |
| `passkey.authorizeManagement({expectedHost,labels})` | 首 await 前 reserve 与 register 共用的唯一 UUID，defer 只释放该 UUID；先由捕获的 Host GET status 检查 scope，再原生安全密码输入，POST `/auth/session`，明确 `trustDevice:false`、`issueClientToken:false`。每次 await 后重验 reservation/current/scene foreground。要求 `authenticated:true` 和精确 Host 的 `yuri_ui_session` Cookie；普通 bearer/client scope 永远不成立。仅返回 `true`。没有 passkey authenticate assertion 登录分支；本实现采用合同允许的显式密码登录。 |
| `passkey.register({expectedHost,ceremonyID,optionsJSON})` | Host options 必须与此前该 native session 的 register/options 回包逐字段一致。iOS 17.4 起才呈现，以便忠实执行 excludeCredentials 和可靠 cancel。rp.id 必须精确匹配 HTTPS captured Host；只接受包含 ES256、platform/默认 attachment、无扩展且 `attestation:none` 的真实 options。challenge/user/exclude 均严格 base64url。返回真实 credentialID、rawClientDataJSON、rawAttestationObject，二进制重新编码为 base64url；不自行合成 credential。 |
| `passkey.cancel({ceremonyID})` | 不要求当前 Host，幂等，只取消该 ID。取消前置 tombstone，阻止晚调度的同 ID 注册；active owner 保留到系统 delegate completion 后才 resolve cancel。晚到成功结果被丢弃，原生 verify permit 同时失效。 |
| `passkey.authReset({expectedHost})` | 必须先由同一 session owner 观察 `/api/auth/reset` 的 200、`cleared:true`、`signedOutEverywhere:true`。持久化删除该连接/授权，退役当前 transport/session，并仅重试同一授权的 cleanup receipt。失败保留原生 cleanup closure；旧 scope 的同次 retry 不删除新 Host，也不重新 POST。 |

Runtime 只为精确 status、register options/verify、list、exact base64url credential DELETE 和 reset 分流到独立 session owner。没有扩大普通 `makeRequest` allowlist，没有允许任意 `/auth` 路由。Cookie 不进入 JS、URL、全局 cookie jar、普通 SDK 请求、Relay 或日志；UI session 只在 Swift 内存中，前后台/Host 退役即清除，设备 bearer 仍仅归 ConnectionStore/Keychain。

`labels` 严格仅含 `title/cancel/submit/passwordPlaceholder` 四个非空字符串，每个最多 512 UTF-8 bytes，拒绝控制字符、额外字段和非字符串。默认 `settings-sessions.tsx` glue 在每次 authorize 动作时调用 `passkeyManagementLabels(t)`，复用 `sessionAuth.locked.unlockTitle`、`settings.common.actions.cancel`、`sessionAuth.actions.unlockAria`、`sessionAuth.password.placeholder`；十语均已有真实翻译，没有新增 key 或原生英文 fallback。labels 不携带密码、Cookie 或自由 URL；原有 settings-core 合同不变。

管理通道禁止 Relay；direct tunnel/unknown-public 仍由 Host 返回 `tunnelLocked` 并原样拒绝，不伪造 Origin、Host、forwarded/local scope 或 Relay domain。管理密码只允许 HTTPS 或明确 loopback HTTP，非 loopback 明文 HTTP 准确拒绝；注册总是要求 HTTPS RP。

注册 options 与系统结果绑定在同一 Host/session/ceremony；只有该 exact credential ID 才能 POST verify。permit 在第一次 verify I/O 前消耗，即使响应未知也不能重复 verify。reset 在第一次尝试前置 attempt fence，即使丢 ACK 也不能自动重发；确认缺失不能清凭据。Host 代际变化后迟到回包不能发布 ACK。

## reset/cache 的 main 责任与剩余验收

原生 reset 已物理清除 ConnectionStore 中该连接的设备凭据、内存 UI session、运行中的认证请求及 captured transport，并使用既有 durable `AuthorizationRetirement` 清理链。`onAuthorizationRetired(connectionID, authorizationID)` 必须完成该 exact 授权所拥有的缓存/外部注册清理后才返回；失败时 bridge 返回 `passkey_authorization_cleanup_pending`，只重试该 receipt，不能处理其它 Host 的 pending 清理。

当前 main 的此 callback 仅调用 NotificationBridge。JS history-cache 的旧授权盘缓存受 authorizationID 隔离，删除连接后不再可读取，但这不等于已物理删除历史缓存。main 若要求 reset 物理擦除这些 JS-owned 持久缓存，仍需把相应 exact 授权清理 owner 接入此合同；本 agent 未修改 application/settings/history-cache，也未声称该物理擦除已完成。根 runtime 退役仍需如常失效 JS 内存快照与回到重新授权入口。

本轮没有 main 装配、签名、Associated Domains entitlement/AASA、真实 RP 的 origin verification、iCloud Keychain/设备解锁、系统注册 UI 或密码登录验收。iOS 15–17.3 注册明确失败，不丢弃 excludeCredentials 兼容。系统错误返回稳定的取消、不可呈现或 `passkey_system_authorization_failed_<ASAuthorizationError code>`，不将所有系统失败猜成缺 entitlement。不能由 SDK 静态通过宣称设备可用。真实 ASAuthorization delegate 到系统视图完全消失的时序仍须 UIKit 设备验证。

## GUI identity 附加 seam

`guiPluginPreviewCapture(expectedHost:)` 新传入 `isHostResourceURL: (URL) -> Bool`，捕获该次 admission 的 immutable scheme/host/effective port（HTTP 80、HTTPS 443），要求原 `current()`，拒绝 URL user/password、不同协议/Host/端口。它只证明 origin，不进行 I/O、不根据 URL 重选连接，不更改 `resource.readFile` allowlist。main 将该字段直接交给 `GuiPluginPreviewCapture.isHostResourceURL`。

## 独立复核集合

- `ios/PasskeyPolicy.swift`：options/base64url、full-session owner、Cookie 隔离、single-attempt verify/reset、I/O 取消。
- `ios/PasskeyBridge.swift`：四个 typed handler、系统 controller/alert 生命周期、cancel completion、晚到 attestation。
- `settings-passkey-native.ts` / `settings-sessions.tsx`：默认 bridge 的固定 i18n 标签输入，不改 settings-core 业务合同。
- `ios/RuntimeBridge.swift`：`RuntimeHostIO.managementJSON` 测试 seam、session 退役、精确路由、captured transport、同授权 reset cleanup，以及 GUI origin predicate。
- `tests/passkey/{main.swift,runtime.swift,NativeShell.swift}`、`scripts/check-passkey.mjs`：纯内存安全反例与 SDK 编译。
- main 尚需单独复核：signed domains 输入、桥的唯一持有、生命周期、exact 缓存 cleanup、JS reset 后导航，以及其它 harness 编译清单。

本机未安装 knip；`bun run dead-code` 会通过 bunx 获取依赖，与本轮禁止 dependencies 的要求冲突，因此未运行。没有运行 NSH engine、Git、真实认证或设备命令。

## 本次 oracle 回归证据

修改前对真实旧 `PasskeyBridge.swift` 运行 callback baseline：第一个 status 悬挂时第二次 authorize 发出了第二条 status，触发 `second authorization must be rejected while first status is pending`，进程以 SIGTRAP 失败。baseline 的临时 close shim 只为隔离观察旧 admission race，已从测试删除。

修复后的 callback 集合覆盖 status 等待期间 authorize/register 都拒绝、strict schema 与真实传入标签、transport 仍 current 时 scene 后台拒绝、成功密码登录只在 dismiss completion 后 POST，以及 close 等待 status/password-dismiss/login-request/system-ceremony 的每个悬挂边界；迟到提交或 attestation 不能重新登录或 verify。Foundation 另外验证错误/旧 UUID 不可释放新 reservation，取消不提前腾 slot，close 等待 exact owner 释放。SDK doubles 只证明我们对 callback 的处理，不证明 UIKit/AuthenticationServices 在设备上的真实呈现时序。
