# Native speech voice catalogue seam

独立 review 集合仅包含：

- `ios/SpeechPlaybackBridge.swift`：初始化时注册 `speech.voices`；browserVoice 按当前目录的 exact 唯一名字解析并保留 unavailable 错误。
- `ios/SpeechVoiceCatalogPolicy.swift`：Foundation-only 精确 Host/lease、current、前台和取消准入；只读身份投影。
- `speech-voice-catalog-native.test.ts`：独立 Foundation 与 iOS SDK 回归，不运行 NSH 引擎或设备。
- 本说明。

稳定接口：`speech.voices({expectedHost:{hostID,lease}}) -> {voices:[{identifier,name,language}]}`。名字可重复，目录原样保留；选择和播放不允许用重复名字猜测声音。仅空 browserVoice 使用系统默认。say 仍走 Host `/api/tts/say/speak`。

## Main 装配

现有构造器仍可编译且自动注册 handler；未提供 `captureVoices` 时明确 `speech_unavailable`，不读取隐式最新 Host。主实现需在 `main.swift` 的现有构造器中接入：

```swift
let speech = SpeechPlaybackBridge(app: surface, captureVoices: { [weak bridge] expected in
    guard let bridge else { throw CancellationError() }
    let captured = try bridge.resourceTransport(expectedHost: expected)
    return NativeSpeechVoiceScope(expectedHost: expected, isCurrent: captured.isCurrent)
}, capture: { [weak bridge] in
    guard let bridge else { throw CancellationError() }
    return try bridge.resourceTransport()
})
```

现有 `resourceTransport(expectedHost:)` 已通过 `admit(..., required: true)` 与 captured connection/generation/current gate 验证精确 scope；构造本身不发送请求。新目录仅保留其 `isCurrent` closure，不调用 read/speech，不需 RuntimeBridge 扩权。主实现另需在 `nsh.json` 的 native method allowlist 增加唯一 `speech.voices` 条目；不新增麦克风或网络权限。两项装配不属于本独立修改集合。保留已有 `onInvalidate -> speech.invalidate()`。

页面失效后的迟到目录由现有 JS catalog owner 的页面/Host generation fence 丢弃；native 请求没有页面 owner 参数，不宣称能读取当前页面身份。native 在同一个 MainActor 同步事务内检查前台、精确捕获 scope、current、取消状态，投影后再次检查，不 await、不建立播放 owner。

## 验证边界

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/speech-voice-catalog-native.test.ts packages/nsh/speech-native.test.ts packages/nsh/speech-core.test.ts
```

SDK 测试只替换 NativeShell 的注册声明，AVFoundation/UIKit 使用真实 iOS SDK，transport 数据类型直接取生产声明。Foundation 测试验证真实生产策略，目录数据为无音频 fixture。目录 green 或 typecheck 不等于真实声音已安装、真实听音、完整 UIKit picker 或全量手机 1:1 验收完成。

本轮证据：上述三个测试文件共 19 项通过，包含 4 项专属目录/名字/SDK 测试。红灯验证曾临时将唯一匹配条件改成 `matches.count >= 1`，Swift 可执行测试在重复名字处以 `Expected unavailable` 失败；恢复 `== 1` 后全绿。另覆盖大小写、首尾空白、identifier 冒充名字、声音移除、目录更新及 Unicode 编码差异。`bun run dead-code` 退出 0，但报告仓库多处未使用代码和配置提示；本集合未出现命中，且 Knip 不验证 Swift 可达性。未运行 NSH engine、Simulator、设备或真实 Host，未调用付费语音。
