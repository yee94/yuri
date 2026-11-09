# Sessions / device Chat preferences / voice directory

本组源码不修改 application、Swift、共享 Settings 路由、Git/Provider 或 collections 生产模块。`SettingsBasics` 已挂载独立 Sessions 与声音目录；以下 root/Swift 合同仍须 main 实装，不能把桥接未完成计为端到端完成。

## Review 集合与独立 oracle

| 生产 owner | Oracle / 回归 |
| --- | --- |
| `settings-sessions-core.ts` / `settings-sessions.tsx` | `settings-sessions-core.test.ts`：规范路径、一次 PUT/POST、ACK 后读失败只 GET、未知 reload 不伪装成功、browser membership、exact encoded passkey delete、取消晚到 ceremony、换 lane 不借新 sender、注册未知结果按 exact credential ID 回读 |
| `settings-preferences-device-core.ts` / `settings-preferences-device.ts` | `settings-preferences-device-core.test.ts`：缺键默认、false round-trip、串行合并、写失败保留 consumer、损坏数据不覆盖 prior |
| `settings-preferences.tsx` | `settings-preferences-production.test.ts` 运行实际字段与 Save 回调，验证三个本地字段都进入设备 Storage、零 Host PUT；既有 `settings-preferences-core.test.ts` 继续拒绝本地字段 Host patch |
| `settings-voice-catalog-core.ts` / `settings-voice-catalog.tsx` / `settings-basics-core.ts` | `settings-voice-catalog-core.test.ts`：真实 say route、原生 name→identifier 唯一映射、未知/重复名字拒绝；既有 Voice confirm production / operation recovery 继续验证真实原 scope、ACK/unknown journal 和音频取消 |

main 应用不同输入独立复核：先把 CLI 写 ACK 后的 GET 拒绝，再恢复，所有请求中必须仍只有一次 PUT、一次 reload POST；reload POST 丢 ACK 后，配置 GET 即使相等也不能证明 reload 已完成。Browser 空目录必须无选择器，HTTP/解析失败必须保 prior；不存在的 provider 不能写 selection。Passkey 列表读取不依赖系统注册是否可用；取消后迟到的 attestation 不能触发 verify。

这些是纯生产回调与协议测试，不是 UIKit/系统认证/真实网络证据。原有 Voice VM 只把新增的独立叶子作为 inert JSX 装载，原 controller、captureHostOperation、bindRequest、scope/ACK 断言不替换。raw fixture 仅补 `NativeSelect` 叶子装载。collections VM 装入真实 `settings-collection-operations` 与 `prepareCollectionSearchTarget`，其它新表单叶子保持 inert。Provider 生产代码归对应 owner；本 VM 保留严格 POST keys 并捕获稳定 providerId，同 ID 清 key、不同 ID 保 unknown/key 的两分支都执行。

本次 focused 验证：上述纯测试加两个 raw fixture、既有 Voice confirm 与 operation recovery，共 10 文件 / 117 测试通过；生产 Settings dependency graph 使用生成的 NSH declarations 进行 TypeScript noEmit，0 diagnostics；四个变更设置 TSX 的 settings design audit 通过。未运行 engine、device、真实 Host、系统认证、付费合成、Git 或依赖安装。整包串行测试和新增源文件的 `bun run dead-code` 由 main 的全包验证阶段统一执行。

## main：设备偏好 root 接线

从 `settings-preferences-device.ts` 导入 `deviceChatPreferences` 与 `deviceChatPreferenceStore`。真实应用 root 启动时调用一次 `load()`；失败保留 prior 并展示可重试错误，不能仅等打开设置页才初始化 Chat 消费。Storage 键为 `chat-preferences-v1`，设备全局，不按 Host、租约或目录重置。

| 字段 | 首次成功读取缺键默认 | root / consumer 合同 |
| --- | --- | --- |
| `allowPromptingSubagentSessions` | false | main 把实时 getter 注入 Chat 的 send/command 核心 admission；仅普通 child session（权威 parentID）受限，设置 true 才可发。UI 输入/发送禁用须来自同一 authority；不能仅隐藏按钮，也不能限制 Bot 或正常 parent session。未知时拒绝 child 发起新 prompt；恢复读取不重放任何 prompt。 |
| `collapsibleUserMessages` | true | `application` 的 `NativeTranscriptBody.collapsibleUserMessages` 改为 `deviceChatPreferences()?.collapsibleUserMessages`，替换现有 Host appearance 来源；未知时不猜 true。每次设备保存成功立即影响同一已挂载 Chat，不 remount、不改源正文或手写滚动补偿。 |
| `persistChatDraft` | true | main 向 draft owner 注入 getter。false 时普通可编辑草稿保持会话内存，不从旧普通草稿自动恢复、不写新的普通草稿；切回 true 以当前编辑内容重新建立 durable baseline。已有 durable 普通草稿由 owning draft lane 用 revision/CAS 显式处理，失败保留并提供重试。绝不可清除 pendingSend、queueEdit、new-session receipts、未知发送 journal 或附件引用；它们是恢复操作记录，不是普通可选草稿。 |

`null` 是尚未得到设备 authority，不是 false。只有 Storage 缺键才采用上表默认；损坏 JSON、非布尔值或 I/O 失败抛错并保留 prior，绝不偷偷覆写为默认。保存串行读取最新存储、合并本次字段、持久化成功后发布；失败 UI 草稿保留。三个字段继续 `local:true`，`settingsPreferencePatch` 继续拒绝它们，禁止 PUT Host。Host 切换不清设备偏好；根销毁不清已保存值。

## main：Swift Passkey bridge

生产 JS 已调用以下方法。`NativePasskeyRegistration` 是可注入的 typed seam；独立组件默认使用同名 native methods，不隐藏 Passkey 区块。

| 方法 | 输入 | 输出 / 行为 |
| --- | --- | --- |
| `passkey.authorizeManagement` | `{ expectedHost: RuntimeScope }` | 仅用户按 Passkey 错误中的 Retry 且此前真实 GET 收到 401 后调用。原生用该 Host 的安全登录流程取得完整 UI session（现有 passkey authenticate/options+verify，或显式密码登录 `/auth/session`），保留认证在 Swift/URLSession/Keychain，不返回 JS；成功后 JS 只重读列表。不能把 client bearer 当完整 session，也不能把一次授权扩成其它 Host。取消/失败明确 reject。 |
| `passkey.register` | `{ expectedHost: RuntimeScope, ceremonyID: string, optionsJSON: object }` | 用 `ASAuthorizationPlatformPublicKeyCredentialProvider` 呈现真实系统注册。读取 Host 给出的 rp.id、challenge、user.id/name、excludeCredentials、authenticatorSelection 等字段；二进制按 WebAuthn base64url 解码。返回 WebAuthn RegistrationResponseJSON：`{ id, rawId, type:'public-key', response:{clientDataJSON,attestationObject,transports?},clientExtensionResults,authenticatorAttachment? }`；id/rawId 为真实 credentialID base64url。JS 只把结果送给该 Host 的 verify。 |
| `passkey.cancel` | `{ ceremonyID }` | 仅取消确切系统 controller，幂等；承诺 completion 后该 owner 不再呈现。允许已退役 Host 的 cleanup，不借当前 Host。失败保留 cleanup，下一次注册先清理同一 ID，不能直接开第二个 controller。 |
| `passkey.authReset` | `{ expectedHost: RuntimeScope }` | 仅在 Host `/api/auth/reset` ACK 后运行；清除该 Host 的设备认证/缓存，退役当前 transport，回到重新授权入口。不能清其它 Host 或把 revoked bearer 继续用于当前 session。JS 的 native cleanup 失败可重试同一 cleanup，不重放 reset POST。 |

必须核对 expectedHost、前台与真实 presentation window；rpID/associated-domain/Origin 不满足时明确失败，不伪造 origin、不代用 relay 域名，也不以 WebView JavaScript 冒充系统认证。Swift 要按 Host/ceremony identity 隔离系统 controller，后台/Host 退役取消。此桥需要真实 iOS entitlement、Host RP 与注册 verify 验收，目前不声明已完成。

现有 Host HTTP 合同原样保留：GET `/auth/passkey/status`；enabled 才 GET `/api/passkeys`；POST `/auth/passkey/register/options` `{label:'Yuri iOS'}` 返回 `{requestId,optionsJSON}`；POST `/auth/passkey/register/verify` `{requestId,response}` 返回 `{verified:true,passkeyCount}`；DELETE `/api/passkeys/:encodedID`；POST `/api/auth/reset`。原生 transport 如尚未允许 `/auth/passkey/*`，main 必须补同一 captured Host 的窄允许列表与认证注入，不能发到当前最新 Host。

已核实的限制：`core-routes.js` 对 register/options、register/verify、list、delete、reset 均调用 `requireSessionAuth`；`ui-auth.js` 的该方法只认完整 session，不认普通 `authenticateClientRequest`。tunnel/unknown-public scope 明确拒绝管理/全登出，status 返回 `tunnelLocked:true`。Swift 仅补注册 UI 仍不足以打通这些能力，必须完成 native 管理授权与同 Host session Cookie 的隔离处理；不能放宽 Host 权限或在 Relay 上伪造 local/private scope。真实 scope 不允许时保留区块与准确失败，不能宣称列表/注册/全登出可用。

注册 verify 丢 ACK 后只按系统已生成的 exact credential ID GET 列表核验，不再 options/register/verify。删除丢 ACK 后只 GET 核验该 ID 缺席。全登出丢 ACK 无可用 durable receipt，明确未确认并禁止盲目重播。CLI reload 同样没有 durable operation receipt，未知状态不可仅凭 settings GET 宣称已重载。

## main：Swift voice 目录和映射

新增 native method `speech.voices({expectedHost:RuntimeScope}) -> { voices:Array<{identifier:string,name:string,language:string}> }`。直接投影 `AVSpeechSynthesisVoice.speechVoices()`，identifier 必须是该对象的真实 identifier，不是名字、locale 或手造 ID；只读、无音频/麦克风/付费调用，不创建播放 owner。Host/generation/页面失效后迟到目录不会被采用。

`browserVoice` 保持 Web 的名字合同；不会把 UIKit ID 写入该 Host 字段。JS picker 只提供目录中唯一同名的真实 voice，保存 `name`。Swift browser 播放须枚举当前目录，以名字作 exact 唯一映射后使用该对象/identifier；`resolveNativeBrowserVoice` 是匹配 oracle。当前 `SpeechPlaybackBridge.swift` 的 identifier-or-name `first` 逻辑需要 main 收紧：非空未知名字、重复名字必须明确 unavailable；空字符串才允许系统默认声音。不能把 browserVoice 名字直接传给 `AVSpeechSynthesisVoice(identifier:)` 或静默选另一个声音。Web 来源的名字不在本机目录时原值保持，可显式选择其它真实声音；不自动改写设置。

say 目录是 **GET `/api/tts/say/status`**，读取 `{available,voices:[{name,locale}],reason?}`。只有 available 且 voices 非空时提供真实选择；保存 `sayVoice` 为 Host 原始 name，播放仍走原有 Host `/api/tts/say/speak`，不能换用手机合成。新字段由现有 `createSettingsVoiceConfirmation` 统一编辑/PUT/权威 GET，沿用其 ACK/unknown journal、草稿 revision 和测试前确认；没有另起声音测试或绕过 cancel owner。

## Search 与 UIKit 验收

main 在共享 `settings-search-core.ts` 加 Sessions 静态条目：`sessions.opencode-binary`（CLI 路径）、`sessions.opencode-update-notifications`（升级通知）、`sessions.browser-provider`（仅实际目录非空才有控件）。Passkey 为动态列表，不把每个 credential 编入搜索；区块在 Sessions 保持可见。Voice `voice.sayVoice` / `voice.browserVoice` 已通过 `settingsBasicSections` 自动索引；对应 `SettingsTarget` 可展示 dormant provider 字段，不自动改变 voiceProvider。

可定位 UIKit IDs：

- `settings-sessions-cli-path`、`settings-sessions-cli-save`、`settings-sessions-update-notifications`。
- `settings-sessions-browser`（复用 NativeSelect 系统 Sheet）、`settings-sessions-retry-cli/browser/passkeys`。
- `settings-sessions-passkey-add`（注册中变取消）、`settings-sessions-passkey-delete-${id}`、`settings-sessions-auth-reset`（系统 destructive confirmation）。
- `settings-preference-allowPromptingSubagentSessions`、`settings-preference-collapsibleUserMessages`、`settings-preference-persistChatDraft`、`settings-preferences-save`。
- `settings-voice-catalog`、`settings-voice-catalog-retry`，以及原有 `settings-voice-preview` / recognition cancel controls。

UIKit 待验：长路径输入与键盘、长 credential label/时间及可滚动列表、NativeSelect 拖关与恢复、后台取消系统注册、真实 RP 注册/删除/全登出、重复/缺失/新增原生 voice、say 不可用与目录刷新失败、取消声音测试释放同一音频 owner、三个偏好的实时 Chat 行为与重启恢复。所有主动作复用中性原生 `settingsAction`；不增加自绘半浮层。
