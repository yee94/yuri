# Chat 原生拼写检查：SDK 可行性核验

后续固定开启阶段：经批准的独立 `NativeComposerSpellcheck` 现已为原 Chat/新会话 multiline editor 接入 `.yes` 配置 consumer，不依赖 Host 开关，也不修改 AX-only owner。其 editor-lifetime/IME 弱恢复合同与验证边界见 [native-composer-spellcheck/README.md](./native-composer-spellcheck/README.md)。这不是通用 SDK trait resolver，也不代表真实错拼标记或 IME 已验收。下文保留此前 SDK 通用可配置 seam 的历史阻塞分析。

2026-11-08 核验结论：**blocked / 未实现、未验收**。本轮没有新增 Swift 或 TSX consumer，不能将 `autoCorrect` 当作 `spellCheckingType`，也不能宣称 Chat 的 `inputSpellcheckEnabled` 已生效。

后续 AX-only 阶段已新增独立 `NativeInputMetadataOwner`，仅按经批准的固定 multiline paired-local 合同为原 Chat/新会话编辑器写 AX label/id；不提供 editor trait seam，不解除本文的 spellcheck 阻塞。生产/fixture 安装及未保证的 silent replacement 边界见 [native-input-metadata/README.md](./native-input-metadata/README.md)。下文保留当时的 trait 可行性核验记录。

## 本机可复核证据

核验的是 README 要求的本机 NSH 0.4 distribution 公开接口；没有运行引擎、设备或真实 Host，没有修改 SDK。

| 证据 | 公开能力与缺口 |
| --- | --- |
| `.nsh/types/nsh/types.d.ts:991–1046` | `InputHostProps` 有 `autoCorrect?: boolean`，没有 `spellCheck`、`spellCheckingType` 或 editor/native trait callback。 |
| 同文件 `1049–1056` | `IOSInputHostProps` 只有 keyboardAppearance、inputAccessoryViewID、textContentType。 |
| 同文件 `739–743` | `nativeID` 被声明为视图名称（示例是 accessory 引用）；不承诺它映射到 UIKit accessibilityIdentifier 或提供 Swift lookup。 |
| 同文件 `1340–1353` | InputRef 只公开 focus、blur、measure、setSelection；不公开可传至 Swift 的 node token 或 UIView。 |
| distribution `embed/ios/NativeShell.xcframework/ios-arm64-simulator/NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface:113–129` | NshComponent 提供自己创建的 UIView 和 props/command；NshComponentContext 仅 emit、setSize，不能取得既有 Input。 |
| 同接口 `46–94`、`136–148` | NshAppView 公开主题、bundle、消息/handler、自定义组件注册；无 node/nativeID → UIView/editor resolver、内置组件工厂装饰器或 Input lifecycle hook。 |
| `ios/ChatHeaderCollapse.swift:46–56` | 通过自身 responder ancestry 取得公开 UINavigationController；这个公开关系没有提供任意兄弟 Input 的编辑器身份。 |
| `ios/NewSessionPickerOwners.swift:60–72` | AX helper 使用“两层父级 + 兄弟直接子 UITextField + 唯一候选”并在冲突时失败。它没有 node resolver，也没有多行编辑器重建或 IME trait 生命周期合同，不能作为 Chat UITextView 稳定绑定的证明。 |
| `tests/history-production-uikit/Observer.swift:93–139` | observer 遍历 UIKit 子树读取 accessibilityIdentifier/几何。这是测试观测，不是 SDK adoption identity，也不是生产精确绑定入口。 |
| `application.tsx` 的唯一 `Input testID="composer"` | 当前使用原生 multiline Input，既有 ref/选区/composition/submit/readonly 接线完整。本轮不替换或修改它。 |

核验文件 SHA-256（不依赖机器绝对路径）：

- `types.d.ts`: `f5d787f0e84ee6f60185ca2c9b06348fe496cc9f426f05bd42191a6e10fc82a3`
- simulator `NativeShell.swiftinterface`: `a21792cd19d05bb2a96b27bebd1bc9e4f1f0b5c1a20be1c0f16920fe16b0e074`

Context7 查找 NSH 文档返回 quota reached；以上判断来自实际本机类型及 Swift interface，不依赖查找结果，也没有运行 NSH CLI 来推断实现。

## 为什么本轮不能安全补 consumer

自定义 component registration 允许新增一个 UIView，但不会把同级 NSH Input 的真实编辑器传入。以兄弟/后代数量唯一、首个 UITextView、类名或 AX 标记来推断目标，没有 SDK 合同保证创建顺序、replacement 及 readonly 切换后的真实编辑器身份。仅靠 registration 的 layout/didMove 回调，也不能证明能在编辑器首次编辑前收到稳定引用。

增加窗口扫描、文本通知中的遍历、timer、delegate 替换或自制 UITextView 会绕开约束。仅设置 autoCorrect 则没有实现用户可见的独立拼写检查开关。因此没有增加无法接通或无法证明安全的生产组件。

## 最小必要 seam（供 main 决策，不是已存在 API）

优先由 SDK 的**现有 Input owner**增加独立的可选 `spellCheck` prop，并在其真实 UITextField/UITextView 上映射 `.yes` / `.no`；未提供保持现有系统行为。让原 owner 同时处理 mount、原生编辑器 replacement、markedText 与 trait 应用时机。这比新增完整输入组件小，且不需要业务层 UIKit lookup。

若必须由独立 Swift consumer 设置，则 SDK 至少要提供受当前 surface/owner 约束的公开 editor registration：

1. JS 真实 Input ref 可产生不可混淆的注册身份，Swift 接收该 Input 的准确编辑器引用；不接受任意字符串跨窗口查找。
2. 明确 mount、replacement、unmount 和编辑状态边界，旧 registration 的 cleanup 不能清掉新代。SDK 原 owner 仍拥有 delegate、IME、selection、undo、focus、发送和键盘布局。
3. trait 变更在无 markedText 的安全生命周期应用；composition 中只保留最新目标值，不主动 reloadInputViews 或 resign/becomeFirstResponder。安全时机必须来自原 owner 的明确事件，不能 timer 猜测。

上面两种 seam 当前都不存在；本轮未修改外部 SDK，也未编造可编译可用的 props/install 调用。main 现在没有可安装的 Swift consumer，compile inputs 无新增项。

## seam 可用后的接线与验收边界

- main 根读取 Host canonical `inputSpellcheckEnabled`；读取失败保 prior/unknown，不默认写回，也不逐输入读取。Host 切换按 generation 隔离旧值。
- Chat 和新会话各自将同一 nullable authority 传给它们原有的唯一 Input。unknown 不强制覆盖系统 trait；不把开关值传给 autoCorrect。
- 不在 onChange、selection、正文 token 或键盘 offset writer 上增加绑定/扫描工作。目标预算：每次文本输入新增 JS/native 遍历、请求、timer、focus 调用均为 0；只在设置值或 editor 生命周期变化时处理该单一编辑器。
- 纯 callback 测试需覆盖失败保 prior、跨代迟到响应、no-op、unmount/replacement、composition 延迟、hidden/readonly/background 不 focus，以及连续输入不触发 trait 应用或 lookup。
- UIKit 仍需验证原 Input 实例/选区/undo/IME 不变、两个开关独立生效、玻璃材质与发送/键盘几何不变。静态检查不能替代这些结果。

本轮验证仅为实际公开接口与现有源码读取、文件哈希和文档内容检查。没有运行 runtime/build/test；无生产行为变更，无新增输入热路径负担。拼写检查效果继续列为未完成。
