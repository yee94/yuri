# 原生资源读取 admission 交付合同

## 已实现的生产行为

`resources.tsx` 的每个 Browser/Preview owner 在构造时固定真实原生 `runtimeScope`，通过 `resources-request.ts` 的 `bindResourceRead` 复制/冻结 receipt。点击刷新、异步完成及 cleanup 均不会重新读取最新 scope 给旧 owner 授权。

Browser → Preview → Markdown inline image → Preview 显式继承父 receipt，晚挂载子组件不借当前 Host。根资源边界用 NSH `Each` 的 `{hostID,lease}` key 构造新 owner，使同 Host 后台/前台的新 lease 能恢复；旧回调仍保留旧 scope 并被拒绝。Browser 的目录、搜索词和预览路径由外层保留，不因新 lease 重置。单纯导航隐藏仍交给 owner 的 `active` 处理，不为它换 scope。

`resources.read` 的生产 payload 为：

```ts
{ path, requestId, expectedHost: { hostID, lease } }
```

`ResourceBridge.startRead` 首先调用同一 Foundation 生产 `ResourceReadRequest.admit(input,capture:)`：严格解析 path/requestId/expectedHost，再同步调用 typed capture。它位于任务创建、stat、serve 和文件副作用之前。缺 scope、非法 scope、A→B→A 的旧 lease、后台都拒绝，未实现旧字段缺失时的放行。ResourceBridge 的临时根目录改为首次成功 admission 后落盘时才创建，构造器不提前创建目录。

transport 内已有 I/O 前/await 后 generation fence；Native startRead 在返回结果前再次核对，若 lease 失效则释放刚生成的文件租约。JS 结果也检查当前 scope，即便 effect 尚未执行，旧结果仍只按旧 resource lease 释放。

`resources.cancel {requestId}`、`resources.close {lease}`、`resources.release {lease}` 不要求最新 Host scope，继续清理旧资源，不重新捕获 Host。未改变它们的生产 handler。

## main 生产接线

main 已采用以下 typed capture，并同步 `notification-swift.test.ts` 的声明 stub。主程序 Apple SDK typecheck 已通过，随后 iOS 模拟器整包编译/签名通过；这不替代真实资源展示与系统文件生命周期验收。

只改 main 的 ResourceBridge capture 参数，不修改其它 owner 的 contract：

```swift
let resources = try ResourceBridge(controller: self, capture: { [weak bridge] expectedHost in
    guard let bridge else { throw CancellationError() }
    return try bridge.resourceTransport(expectedHost: expectedHost)
})
```

当前构造器为 `init(controller: UIViewController, capture: @escaping (RuntimeHostScope) throws -> ResourceTransport) throws`。没有无参 capture 兼容重载；忘记接线应编译失败，不能默默捕获最新 Host。

`notification-swift.test.ts` 的 main compile stub 也由 main 同步：ResourceBridge init 的 capture 改为 `(RuntimeHostScope) throws -> ResourceTransport`，RuntimeBridge stub 的 `resourceTransport` 增加 `expectedHost: RuntimeHostScope? = nil`，供其它 native 只读 owner 保留无参编译。本 owner 未修改这两个 main-owned 文件。

资源专属 fixture 已同步 synthetic UUID scope：`tests/resource-media/uikit-main.swift` 的 typed capture 校验同一 generation 的 receipt，JS fixture 将同一 synthetic scope 发布到 app；资源构建脚本包含 `RuntimeHostScope.swift`。没有使用真实连接或 Keychain。

## HTML / loopback 追加授权与 main 接线

追加授权已修复该缺口。`ResourcePreviewOwner` 构造时调用 `bindResourceWebPreview(expectedHost, native, id)`，复制冻结 receipt；HTML 按钮与资源 Markdown 中通过既有白名单的 loopback 链接共用它。相对文件链接仍交原有文件导航；inline image 仍显式继承父 receipt。全仓检索没有其它生产 `resources.web.present` 调用者；`tests/resource-web-preview-fixture.ts` 只是纯分类器，不发起请求。普通外域不增加打开 fallback。

每个 presentation 使用独立 caller owner，intent 为 `{kind, directory, path, expectedHost, owner}` 或 `{kind, url, expectedHost, owner}`。`ResourceWebPreviewRequest` 严格解析字段集合、路径/URL、owner 与原生 receipt；`ResourceWebPreviewOwnership.begin` 同步调用 `(RuntimeHostScope) throws -> ResourceWebPreviewTransport`，然后才创建异步工作。缺 scope 无兼容降级。`RuntimeBridge.swift` / `RelayTunnel.swift` 未在本轮修改，继续使用现有 `resourceWebPreviewTransport(expectedHost:)` 和 Host proxy；没有手机直连。

main 接线必须改为：

```swift
let webPreview = ResourceWebPreviewBridge(controller: self, capture: { [weak bridge] expectedHost in
    guard let bridge else { throw CancellationError() }
    return try bridge.resourceWebPreviewTransport(expectedHost: expectedHost)
})
```

保留现有 install、Host/background/teardown invalidate 接线。`notification-swift.test.ts` 的对应 ResourceWebPreviewBridge stub capture 同步改为 `(RuntimeHostScope) throws -> ResourceWebPreviewTransport`；main 若有 RuntimeBridge stub，也需暴露 `resourceWebPreviewTransport(expectedHost: RuntimeHostScope? = nil)`。这些 main-owned 文件未在本轮修改。

当前通知 SDK harness 用 `ResourceTransport` 作为 preview 的声明替身，可保留该占位返回类型，只把两处参数补齐：

```swift
func resourceWebPreviewTransport(expectedHost: RuntimeHostScope? = nil) throws -> ResourceTransport {
    try resourceTransport(expectedHost: expectedHost)
}
// ResourceWebPreviewBridge stub 的 init 参数：
capture: @escaping (RuntimeHostScope) throws -> ResourceTransport
```

`resources.web.close` 必须提供 `{expectedHost, owner}`，不使用无 scope capture。匹配现有 Ticket 时，旧 scope 即使已失效也可直接清理；未匹配时，只用请求自带 expectedHost 做 typed capture/current 同步验证，不发 HTTP、不取最新 scope。失效 receipt 的未知 close 直接忽略，不能污染新周期的关闭配额。异步工作、defer、取消、surface close/failure/diagnostic 与 dismiss delegate 均检查原 Ticket/navigation 身份。取消先同步取消子 Task。关闭时立即 fence，等待 UIKit dismissal completion 后才兑现 closed/close acknowledgement、释放占用；旧 completion 不能退役新 Ticket。

close 可先于同 scope 的 present 被原生处理；原生保存 scope/owner 关闭记录，在 capture 前拒绝对应迟到请求。关闭记录最多 4096 条，超过后 fail closed，不淘汰旧记录重新放行；Host/lifecycle invalidate 随 native receipt 轮换清空记录。JS 只有收到 `true` 关闭确认后移除待清理 owner；失败保留记录，后续 cleanup 或 present.finally 可重试；同 owner 并发 close 合并。

资源 preview 专属 Swift fixture 在发起 Task 前捕获固定 synthetic scope，typed capture 核对 generation。专属构建脚本与 SDK 测试加入 `RuntimeHostScope.swift`；RuntimeBridge 组合 SDK 输入加入并行终端 owner 新增的 TerminalBridge/TerminalTransport 依赖，没有改终端生产代码。

## NativeShell 返回生命周期调查与未验收

本地生成声明 `.nsh/types/nsh/index.d.ts:84–87、250–253` 说明 host.call 默认 30000ms 超时并拒绝 ETIMEDOUT，timeout=0 可无限等待。`runtime.ts` 当前未传 options。声明没有说明超时是否取消 Swift handler Task。现有 `.nsh/out/YuriNative.app/YuriNative` 的只读 strings 只证实链接了 `NativeShell/NativeShell.swift`，不包含可据以核实返回确认、丢弃响应或 Task 取消的源码；本地定向搜索未找到 `NshAppView.swift` / NativeShell 源码。未访问网络寻找实现。

本轮只对 JS 收到超时/拒绝时追加精确 close；不把这当作 NSH 已物理取消，更不把 web surface 清理当作 ResourceBridge 文件租约的交付确认。**文件返回值完全丢弃的物理回收仍未证明、未修复**；没有添加猜测性 timer。长时间预览仍受当前 native wrapper 默认 30 秒等待限制，超时后本轮 helper 会尝试精确 close；是否需要允许无超时 host.call 由 runtime owner/main 单独接线并验收。

NSH `Each` 的真实重建/清理调度、UIKit 解码/展示、OS 文件分享和调用返回值彻底丢失时的物理文件回收未在本次执行验证。NativeShell 超时/丢弃响应语义仍需 main 验证；本次只证明已返回 JS 的晚结果与 Native 已知取消/失效的回收路径，不把纯内存检查当端到端或完整 1:1。

## Core oracle 的两项追加修复

本轮保留资源工作，同时修复 `VoiceRecognitionCore`：

- start 在 capture/TTS/recorder 等同步副作用前检查调用任务取消；等待非结构化 prepare 时，取消 handler 先同步 `work.cancel()`，再按精确 Lease 对象退役并清理。晚到旧 continuation 不得取消新租约。
- finish 在原生拒绝 `starting != nil`，不能在 settings/permission pending 时发送空 WAV，再由晚权限启动录音。

fakeAudio 追加实际 `Task.cancel()` 回归：预取消零副作用、settings pending 取消及晚响应不影响新 owner、permission pending 取消、取消后立即 resume permission 的竞态、permission pending 并发 finish 零上传/WS、完成 start 后只录音一次再 finish。未重放 unknown 请求。

## 独立审查与验证边界

实际通过 OpenCode CLI 委派独立只读会话 `ses_e4a27a036ffex1j3m27ToZSKK0`，指定并由模型目录核实 `magpie-remote-magpie%2Fcodex/codex/gpt-6.1-sol`。首轮 reviewer 报告前后台 owner 未重建与媒体 fixture 旧 owner 两项；第二轮指出 Core 取消仍须同步 `work.cancel()`、普通 hide 不应销毁 owner、fixture 应保持同 Host ID。已修复并完成第三轮实际复审：reviewer 重新读取当前源码后确认这三处已在源码层面关闭，该轮范围内无新阻塞。HTML/loopback 无 scope 缺口仍明确保留。三轮 review 仅 read/grep，没有执行测试，不能算运行证据。

验证命令使用已安装依赖，不获取新依赖、不运行 engine：

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/resources-request.test.ts packages/nsh/resource-media-swift.test.ts packages/nsh/settings-voice-recognition-transport.test.ts packages/nsh/settings-voice-recognition-native.test.ts packages/nsh/settings-voice-recognition-sdk.test.ts
./node_modules/.bin/tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
```

最终实际执行 **6 文件 / 129 项测试全部通过**（上述五文件另加 `resources-model.test.ts`），项目 `tsc --noEmit` 通过；资源 fixture 构建脚本 `node --check` 通过。Native admission 测试包括真实生产 `ResourceReadRequest.admit` + RuntimeBridge 的 A-B-A/后台/缺 scope/非法 scope 拒绝零下游计数和当前 scope 正控；JS 构造器测试覆盖 inherited Browser child、晚挂载 Markdown image、晚结果和旧 cleanup。iOS SDK 同时 typecheck 生产 ResourceBridge 和已更新的 synthetic UIKit fixture，不执行应用。

### HTML / loopback 追加验证

追加任务实际执行 3 文件、20 项通过，1 项 macOS WebKit 规则 probe 在最终回归中显式跳过；`tsc --noEmit` 与 preview 专属构建脚本 `node --check` 通过：

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/resource-web-preview.test.ts packages/nsh/resources-request.test.ts packages/nsh/resource-web-preview-swift.test.ts -t '^(?!compiles the exact production network-block)'
./node_modules/.bin/tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
node --check packages/nsh/scripts/build-resource-web-preview-uikit.mjs
```

Foundation 执行生产 parser/Ownership/RuntimeHostAuthority：缺 scope、非法字段、A-B-A、后台、close-first、旧 callback/close、新 receipt 正控、真实预取消 Task、closing acknowledgement 及 4100 条旧 close 不污染新周期。JS 执行生产 helper 和 ResourcePreview 构造器/HTML/Markdown 链接回调，保留既有白名单与失败强断言。iOS SDK typecheck 包含生产 bridge、现有 RuntimeBridge 及其依赖、synthetic UIKit fixture；不执行应用。真实 UIKit dismiss completion 时序仍需 main 后续运行验收。

实际续同模型 `magpie-remote-magpie%2Fcodex/codex/gpt-6.1-sol` / 会话 `ses_e4a27a036ffex1j3m27ToZSKK0` 完成三轮独立只读审查。首轮指出 close-first、close 失败丢记录和提前确认 dismissal；第二轮指出旧 scope 污染关闭配额；均已修复，第三轮重新读取当前源码确认闭合、未发现该范围新阻塞。review 未执行测试。

执行偏差已向 main 说明：首轮测试筛选意外匹配并运行了一次既有 macOS WebKit 规则 probe；随后所有回归显式跳过它。没有启动 NSH engine、设备或真实 Host。未运行 main build / Git / 安装依赖。`dead-code` 的脚本使用 bunx knip，本地未安装 knip；为遵守禁网络/依赖约束未运行，未用其它静态检查冒充它。

Native transport 测试只编译内存 ConnectionStore（initializer/persist 中 Security 与 SecItem 均被替换并静态核对不存在），资源 admission 复用真实生产 parser 与 RuntimeBridge，仅下游文件/HTTP 用计数器；Swift media/Foundation 测试及真实 iOS SDK typecheck 不执行 UIKit。JS 测试执行生产构造器和事件处理器，NSH JSX/signals 仅声明替身；不运行 NSH engine。未运行真实 Host、网络、设备、录音、Keychain、付费 ASR 或 main build。
