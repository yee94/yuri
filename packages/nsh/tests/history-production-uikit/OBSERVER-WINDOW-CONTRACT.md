# 独立 window/header Observer 合同

实现位于 `Observer.swift`；builder 只为未来新 artifact 把 `observerContract` 升级到 `pan-read-v2; window-header-v1; ...`。旧 artifact、hash、strict recorder/checker、生产布局、SyntheticHost payload 和三 body 门槛均不修改。本轮不构建/运行 NSH，不启动设备或 engine，不连接真实 Host，不执行 Git，也没有 offset writer。

本文落实 [NATIVE-A3-FINDINGS.md](NATIVE-A3-FINDINGS.md) 中的新 observer 方案。a3 是旧 observer 的只读证据，不能假定已经带有这些字段。

## 每个 periodic sample 的新字段

唯一接线 seam 是 **`frame.windowObservation`**。它和原 `nodes/scrolls/controlAncestors` 在同一次 `CADisplayLink` 回调采样；原 frame 的 `readEndNativeMs` 覆盖这些新增读取。字段不代表原子 UIKit transaction，也不声称 SDK adoption、AX 接收或显示 exposure ACK。

| 字段 | 实际来源/未知规则 |
| --- | --- |
| contract / sequence / readStartNativeMs / readEndNativeMs | `window-header-v1`，同 frame.sequence，真实 native uptime 读窗 |
| windowInstance / surfaceInstance / windowBounds / surfaceInWindow | 当前 `surface.window` 的实例及公开 UIView 坐标转换；没有 window 时明确 null/unknown，不查其他 scene/window 替补 |
| windowSafeAreaInsets | 当前 window 实际 `safeAreaInsets`；不把它单独命名为 headerBottom |
| navigationBars / navigationBarCount | 遍历当前 UIWindow 子树，以 `as? UINavigationBar` 发现所有 bar，包括隐藏 bar；class 字符串仅保留实际类型，不用于识别 |
| transcriptInstances | 当前 surface 子树中真实 `UIScrollView` 且已有 accessibilityIdentifier 恰为 transcript 的实例；0或多个保持 unknown，不靠几何或相邻 AX 挑选 |
| selectedNavigationBarInstance / navigationOwnership | 必须只有一个发现的 bar、一个 transcript、一个确切 controller owner 才提供选择；这是对象归属选择，仍不是导航输入准入 |
| nativeTextOwners / unsupportedSyntheticTextCount | 公开文本对象到真实 body→outer transcript 的父链及合成文案证明；无法证明或不在白名单的情况不补造 AX 绑定 |

controller 归属只从当前 window.rootViewController 的公开 children/presentedViewController 图读取；不加载额外 controller view。只有已经加载的 `UINavigationController.navigationBar === bar`，且唯一 transcript 同时属于该 nav 已加载 view 与 topViewController 已加载 view 时，才记录 current owner。bar 的 owner、current owner实例分别保存；`isNavigationBarHidden` 只在 owner 唯一时有布尔值，否则 null，另存 `navigationTransitionInProgress`。多 bar 即使只有一个当前 owner，也保守 unknown，留给主会话用新实际证据决定是否需要更细合同。

每个 bar 和 text UIView 的 geometry 包含：

- 自身实例/真实 runtimeClass/windowInstance、bounds、frameInWindow、frameInSurface、sameWindow。
- 自身 hidden/alpha 和从自身直至当前 window 的完整 ancestorVisibility：实例、class、window frame、hidden/alpha、clipsToBounds、layer mask、UIView transform、CALayer transform/sublayerTransform、layer opacity、animationCount、presentationAvailable/presentationDiffers。
- window.bounds 与每个实际 clipsToBounds ancestor 转换后矩形的交集，以及文本/bar 自身的交集。`clippedRectInWindow` 是几何交集，`visibleRectInWindow` 另外要求实际 attached、hidden=false、effectiveAlpha>0.01；**它仍不证明没有 sibling/系统覆盖或透明材质遮挡**。
- presentationFrameInWindow/presentationFrameInSurface 仅在两个 presentation layer 都可得且实际共同 root 相同时转换，否则 null；绝不以 model frame 冒充 presentation。modelGeometryUnambiguous 要求 attached 且无 transform、animation、mask；并不授权忽略导航 transition 或其他遮挡。

CGRect.null/infinite/nonfinite 统一编码 null，不输出 Infinity/NaN。transform 或 layer mask 存在时，即使已记录矩形交集，消费者也不能把它当可靠的轴向 safe boundary。此合同没有推测 status-bar 私有 view 类、常见设备坐标或系统时间高度。

## 公开文本类型与 AX 绑定边界

观测支持公开 `UILabel`、`UITextView`，以及 `isAccessibilityElement && accessibilityTraits.contains(.staticText)` 的实际 UIView。查阅现有 NSH 源证据 `crates/nsh-platform-ios/src/text_view.rs` 的公开属性实现可见：TextView 直接继承 NshView/UIView，绘制 CTFrame，公开暴露 accessibilityLabel 与 staticText trait；因此只枚举 UILabel/UITextView 会漏掉自绘正文。该源证据是解释依据，不代替新 artifact 的运行类型实测；实现完全不匹配 NSH 私有 class 字符串，不用 KVC/私有 selector。

只有文本 UIView 的实际 superview 链中存在唯一既有 `body-part-hp-NNNN:text:N` ID，且 body 确实位于唯一 outer transcript 下面，才记录 nativeTextOwners。保存 bodyID/bodyInstance、outerTranscriptInstance、到 outer 的全部祖先实例、outer 之前的 nestedScrollInstances。内层 code Scroll 的对象归属可以成立，但仍必须禁止它驱动 outer pan。body 是否完整可见仍归原 nodes/fullyVisible，文本观测不把 partial body 改成完整 body。

只读公开 accessibilityLabel，不调用 NSH 内部布局，也不读/导出任意 UILabel.text、UITextView.text、value/hint。精确白名单限定500条 fixture message ID 范围内的 marker、该消息 code marker、固定合成 question、对应 index%7 次数的完整 prose、三个列表编号及固定列表项。完整匹配后才对 trim 两端 whitespace/newline 的 UTF-8 计算 SHA256；既不输出原文，也不为不匹配文本生成摘要。状态栏03:32、真实用户文本、加在合成前缀后的额外内容、不同消息 marker 和越出500条的 ID 均不获指纹。白名单只在 observer 作为诊断证明使用，没有修改或裁剪 SyntheticHost 源文。

记录公开 accessibilityFrame 的 screen/window 转换，但外部 helper AX 树没有可与 UIView 指针共享的公开对象身份。当前 **`axIdentityBinding` 始终明确 unavailable**；`syntheticTextSHA256` 和 frame 是可核对的对应证据，不能伪称 AX identity ACK，不能仅据二者自动放行旧 driver 的 generic partial text。若没有真实 shared ID 或主会话另行验证的公开对象关联合同，a3 的 partialtext 导航仍阻断。native header 观测可以独立使用和核验，不依赖这条受阻链路。

## driver 由主会话后接

本轮没有改冻结 `native-diagnostic.py`。它目前要求 manifest `pan-read-v1;`，所以会在设备命令前拒绝新 `pan-read-v2` 包；这是假设升级的显式 seam，不修改旧 manifest 来绕过。

后续接线须单独实现/评审：

1. 明确接受新 v2，同时按 contract/sequence/真实读窗校验 windowObservation，核对 window/surface 实例、bounds/坐标转换与同帧原字段一致；不把另一时刻 AX 和 native frame 当同步原子快照。
2. 独立验证 bar 唯一归属和 visibility；有 transition、transform、mask、presentation/model差异、隐藏/不在window或未知边界则不准入。safe-area、实际 bar 和现有 header 控件范围分别保留，不能取一个较低边界绕过其他保护。
3. 继续保存所有候选和排除原因。text-owner 链、合成指纹和 AX 绑定状态分别报告；现阶段不能放开 generic partial text。native model 的 fullyVisible 也不能单独签视觉无遮挡。
4. 允许导航不等于三个完整旧 body 验收；三 body、250ms、1.1pt、clock、连续 gap 与 strict unsupported 均保持。

采样上限18000、事件上限20000、flush主线程同步 JSON序列化/写文件的时序没有修改。此前约500ms的 flush gap 必须原样保留；新增读取/数据量可能增大观测扰动和 capture 大小，当前没有设备成本或连续采样率证据。不得挑帧、补帧或放宽 gap 来接收新数据。

## 验证与主会话构建

`observer.test.ts` 的 macOS Swift 纯执行覆盖18项唯一归属/精确合成白名单条件；另有公开 API、无 writer、无原文导出与新合同版本源约束。`observer-sdk.swift` 只作为真实 UIKit SDK 编译 probe：包含 window/navigation/UILabel/UITextView/自绘 staticText UIView/nested Scroll/脱窗对象与 null CGRect 分支的调用，但本轮不在 UIKit 运行任何断言。

复现纯测及真实 SDK 对象编译（NSH_DIST 指向已有完整 distribution；没有安装依赖、没有运行 NSH）：

```sh
NSH_DIST="$NSH_DIST" bunx --offline vitest run \
  --config packages/nsh/tests/history-production-uikit/vitest.config.ts \
  packages/nsh/tests/history-production-uikit/observer.test.ts \
  packages/nsh/tests/history-production-uikit/build.test.ts
```

SDK test 在未设 NSH_DIST 时会明确 skip；本轮实际设置并运行，不能把默认 skip 说成 SDK 编译通过。当前真实 iOS Simulator26.5 SDK / arm64-apple-ios15.0-simulator 的 Observer 与 probe 均已 `swiftc -frontend -emit-object` 成功。使用真实 NativeShell framework 和真实 Host/Clock 声明，没有 stub；每个 primary file 单独输出 object，没有执行它们。

**整组 SDK typecheck 的已知阻塞**：当前 `SyntheticHost.swift:239` 的 `return ok(scenario == "normal" ? ["assistants": bots, "revision": 3, "enabled": true] : ["assistants": []])` 触发 Swift `failed to produce diagnostic for expression`。这不属于本次 ownership，未修改；primary-file 编译成功不代表该 Host 函数或完整 App 构建已通过。Host owner 需先处理此阻塞，主会话再运行下面新 build 命令。

主会话的 exact build invocation（已有 NSH_DIST，默认 experiment OFF，自动生成全新随机目录/包身份；本轮未执行）：

```sh
NSH_BIN="${NSH_DIST:?set existing NSH distribution}/bin/nsh" \
  node packages/nsh/scripts/build-history-production-uikit.mjs --scenario normal
```

新 manifest 必须为 pan-read-v2/window-header-v1，旧 cec5b612 等目录不可覆盖。构建成功后仍由主会话独占安装、冷启动、取 AX/native 配对、接线 driver 和审查实际采样。新字段从未在设备上验收，不代表 partialtext 已可用、原53pt已复现或 strict PASS。

## 冻结验证记录

最终三个 focused Vitest 文件 `observer.test.ts`、`build.test.ts`、`native-diagnostic.test.ts` 共7项通过，SDK test 已实际启用而非 skip；内部包括18条 Swift 纯策略断言及冻结 driver 的28项 Python 回归。builder 的 `node --check` 通过。`bun run dead-code` 已完成并审阅，无本专项条目；全仓仍有其他 unused/duplicate 报告，含 packages/nsh 的72个 unused files 配置提示。没有将这些检查解释为完整 App、采样性能或 UIKit 运行通过。

本轮新源码 SHA256（供主会话核对新 stage，未修改任何旧 artifact/hash）：

| 文件 | SHA256 |
| --- | --- |
| Observer.swift | `1818388e1525d740bcb9ffad879ba09aca20ed839234df70500a1a457cb23138` |
| build.mjs | `6dcd311b5e988807584427b1c5342a33509898c82064157e08cee7ade4992966` |
| observer.test.ts | `d4b50e5ef6af88dd777b9ed62bff935abe2a43fd8f2e900c28b270802909ee36` |
| observer-sdk.swift | `0ccb2f4e8c8913e7a0b3497d4f7552f85b5fbcb760aa4c6ebddafd1c67e72db1` |
