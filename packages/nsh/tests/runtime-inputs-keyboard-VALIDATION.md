# Runtime 编译输入与键盘 fixture 验证边界

本轮只修改测试、独立 fixture/Host/runner 和原生测试脚本的输入清单。未修改 Swift、RuntimeBridge、state、model、cache、prefs 或其他生产模块；未运行 NSH engine、设备、真实 Host、Swift 编译或 SDK typecheck。

## RuntimeBridge 的真实 Swift 依赖

以下九个实际输入清单均包含一次真实 `ios/AttachmentUploadPolicy.swift`，没有替代该类型的 stub：

- `terminal-runtime-fixture.mjs`
- `gui-plugin-runtime-fixture.mjs`
- `resource-web-preview-swift.test.ts`
- `settings-voice-recognition-sdk.test.ts`
- `settings-voice-recognition-transport.test.ts`
- `settings-voice-recognition-relay.test.ts`
- `remote-desktop-transport-native.test.ts`
- `scripts/check-native-bridge.mjs`
- `scripts/check-passkey.mjs`

GUI runtime fixture 复用 terminal 的执行函数，但保留独立输入数组，因此两处均需维护。`runtime-bridge-compile-inputs.test.ts` 静态扫描真实数组、检查 policy 的路径和唯一性，不 import 或执行上述编译入口。实际 macOS/iOS 编译结果须等待 source owners 冻结后，由 main 串行验证。

## Reference keyboard

`composer-reference-keyboard.test.ts` 的五个 engine case 保留原步骤和 60 秒进程／75 秒测试 timeout。专属 runner 复用 `prepareInteractionEngineDriver`，为每次测试创建独立 `App.tsx`、`nsh.json` 和 tsconfig，显式 macOS、空 storage/network；Host 经 Bun browser build 后独立加载并清理。

fixture 在真实 `connection.list → loadConnections` 确认后才创建 Chat/keyboard，查询逐次捕获生产 Host operation。专属 Host 拒绝未签发、畸形、stale 和跨 Host scope，校验目录与查询字段；任何 mutation/prompt 都拒绝并计数。每个原有 engine case 结束时通过仅限 fixture 的 native audit 验证 mutation 和 send 均为零，包含后台 case；此审计不借用后台已退役的 runtime request。

## Bot context

Node/VM fixture 先调用真实 synthetic `connection.list`，再执行生产 `runtime.ts` 的 `bindRequest`／`bindRawRequest`。只读 metadata POST 携带实际签发 scope；缺失和 stale scope 仍拒绝。原 Bot/config/session/prompt/fs 写入拒绝及五次尝试计数保留。

## 可执行的纯检查

```sh
NSH_BOT_CONTEXT_PRODUCTION_BUNDLE=0 NSH_BOT_CONTEXT_PRODUCTION_ENGINE=0 \
bunx --offline vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/runtime-bridge-compile-inputs.test.ts \
  packages/nsh/composer-reference-keyboard-fixture.test.ts \
  packages/nsh/bot-context-production.test.ts

bunx --offline vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/composer-reference-keyboard.test.ts \
  --testNamePattern='^query reset, identity retention'
```

第一条覆盖清单、独立 bundle、scope、只读 metadata 和真实 default reader；两个显式 opt-in 的 NSH bundle/engine case 跳过。第二条仅运行键盘纯 core，五个 engine case 跳过。脚本 `node --check` 和 TypeScript 检查也不证明 SDK 或实际键盘行为。

main 获得独占 engine 窗口后复跑键盘完整六项：

```sh
bunx --offline vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/composer-reference-keyboard.test.ts
```

Swift source owner 冻结前，不运行上述九处入口或任何导入它们并触发编译的测试。串行 SDK、原生 transport 和 GUI/terminal 消费者的实际结果由 main 记录。
