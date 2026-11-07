# Picker 背景 AX 隔离：固定版本证据与 owner 合同

状态：`3f51bbee` 初次 Agent 展开已有 main 真实背景 AX 隔离／Build Plan 可达证据，但 Search 缺真实 ID／label、Agent 关闭后 Model 重开失败，**完整流程未通过**。当前最小 editor 注册与真实 UIKit completion 修复见 [PICKER-NATIVE-OWNERS.md](./PICKER-NATIVE-OWNERS.md)，其新唯一 fixture 仍须 main 重验。没有背景 AX gate、不支持的 props、全局窗口扫描或私有 UIKit 层级推断。完整 1:1 目标不缩减。

## 已有真实结果的边界

main 在独占设备上运行 `99e6cc77`，报告长标签 300ms hold 后拖真实垃圾桶仍停留新会话；审计 settingsWrites=1、configWrites=0、deniedSessionWrites=0、rejected=0，普通 Back 正常。本轮只读核对 `.scratch/nsh/chat-frames/new-session-trash-isolated-audit-1794044547.json` 的对应计数及移除后的真实 refs；不把该结果扩大成全部手势或背景隔离完成。

## 1. 当前 overlay 为什么不能靠 root 属性解决

以下依据实际编译器版本 `nsh 0.4.0 (e626a8d)`，不是浮动 main 文档：

- [`sheet.rs:122–205`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-base/src/sheet.rs#L122-L205)：iOS 是 backdrop 和 panel 两个 root overlay，只有 Web 分支包 `modal()`。
- 本地 `.nsh/types/nsh/types.d.ts:161–172`：Overlay 离开逻辑父节点的布局／裁剪，承载在 surface 或 dialog root；`ComponentHostProps`（Sheet 的基础 props）没有任意 AX 属性透传。
- `.nsh/types/nsh/types.d.ts:754–768` 支持 `accessible`、`role`、`accessibilityElementsHidden`、`importantForAccessibility`；没有 `ariaHidden` 或 `accessibilityViewIsModal`。Sheet 没有 `nativeModal`。不能加未知属性假装框架支持。
- [`native_view.rs:110–126,228–247`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-platform-ios/src/native_view.rs#L110-L126)：`role="group" accessible={false}` 只是取消单元素合并；hidden 则隐藏整个原生子树。给 surface／公共祖先隐藏会把仍在此 root 的 Sheet 一并隐藏。
- 同文件的 `accessibilityElementsHidden` getter 读 Rust 的 `props.accessibility.hidden`，所以也不能认为对任意 NSH 原生 UIView 调 UIKit setter 就已修改框架权威状态。普通 NSH 背景内容应由 TS 的支持属性控制，或用独立原生 presentation 下的已知 UIKit 容器，而非绕过该 getter。
- 当前新会话背景内容、系统 UINavigationBar、上层 Tab／shell 并非一个 TS 内容 View 的全部 children。只藏 composer／正文不能证明导航栏和其他 owner 已隔离；隐藏视觉、移除系统返回按钮均不符合要求。

## 2. 首选现有框架能力：透明 Dialog 承载原 Sheet

有一个真实公开 API 可以建立独立 presentation，优先于自建桥：

- `.nsh/types/nsh/base.d.ts:5853–5858,5950–5985` 暴露 `Dialog`，支持 `presentation="fullScreen"`、`animation="none"`、真实 `onClose`、关闭行为和原 children。
- [`navigation.rs:1355–1370,1389–1472`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-platform-ios/src/navigation.rs#L1355-L1472)：Dialog 创建独立 `ModalController`，将其 view 交给 UIKit presentation；`fullScreen` **映射到 `OverFullScreen`**，并显式设置 clear 背景。它不是移除／替换背后视觉的 `UIModalPresentationStyle.fullScreen`，也不是主 WebView。
- [`mount.rs:3431–3458`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-platform-ios/src/mount.rs#L3431-L3458)：modal 使用独立 root，由 UIKit 承载，不插入 presenter 的 NSH root。

已接入的承载结构：`Dialog(fullScreen, animation=none, 无第二层 backdrop) → 原 Sheet → 原 picker`。`new-session-modal.tsx` 只适配真实 callbacks，`new-session-modal-owner.ts` 是 import-free 的唯一 presentation authority；`new-session-page.tsx` 将 model／agent／project 和预设添加接入这一承载组件。不复制 picker，不新增行、不改 model/favorite/variant/Agent testIDs。Sheet 保持原面板高度计算、圆角、背景、唯一 scrim、`closeOnSwipe` 和滚动 handoff；Dialog 不添加系统 pageSheet/formSheet，也不叠加滑入动画。普通 NavPage 和系统 Back 的 owner 不变。

**不能从上述源码断言 UIKit 的 OverFullScreen 已自动完成 AX 背景隔离。** 固定源码没有显式设置 `accessibilityViewIsModal`，UIKit 的实际 AX 行为仍须 main 捕获。首先验证该公开承载能力，而不是默认需要自建 renderer 或桥。

### 必须保留的生命周期

由同一个 picker owner 管理 `native-opening → sheet-opening → open → sheet-closing → native-dismissing → closed`，不把“用户请求关闭”与“已消失”当成一个 boolean：

1. 按 generation keyed `Each` 挂载 Dialog；其真实 `onOpen` 后才挂载并打开原 Sheet。关闭态不构造 catalog rows。原生进入中取消时进入不可逆 `native-opening-cancelled`，等旧 Dialog 真实 onOpen 后直接 dismiss，不闪出已取消 picker；若原生未 onOpen 就关闭，真实 onClose 同样释放该代并接入最新 queued intent。
2. 所有关闭入口进入唯一 `requestClose`，先让 Sheet 的 `open=false`；关闭期间仍保留该代 Dialog 和原 picker 内容。原 owner 活跃状态／Host fence 仍可阻止 mutation。
3. Sheet 的真实 `onClose` 后才请求关闭透明 Dialog；[`popup.rs:99–118,457–495`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-base/src/popup.rs#L457-L495) 明确定义它覆盖退出 motion。由框架处理 reduced motion，不自行写估算时长的 timer。
4. **真实 native dismissal completion 才是最终释放边界**。首版只接 public Dialog.onClose，但新发现 `mount.rs:1085–1087` 的 Delete 分支不发 Dismiss，不能只看 `3457–3458` 的普通移除分支。当前保留该代 Dialog root 为 open=true，经 registered exact modal owner 的 UIKit completion 释放，并为下一代构造全新 root；public onClose 到达时同样幂等接纳。不是借 detach／视觉消失或 timer 提前释放。
5. 快速关闭／重开、页面隐藏、销毁、嵌套系统界面均要按 presentation generation 防止旧 onClose 释放新一代。不能 `If(open)` 立即删除整个 Dialog，也不能在 selection handler 清空内容后就恢复背景 AX。
6. Dialog 的原生 cancel／VoiceOver escape 只转发给这个 `requestClose`，不同时 pop NavPage；Sheet 仍拥有实际关闭 motion。是否存在双 cancel、键盘下的空壳、提前消失和 geometry 变化都须实测。

Sheet 进入中取消则记录不可逆 `sheet-opening-cancelled`，先保持其 open，等真实 `Sheet.onOpen` 才设为关闭；不猜测首帧、layout 或 motion 时长。这个顺序也避免 reduced-motion／未首布局时直接 open=false 不一定产生生命周期 Close 的边界。queued intent 不能复活旧代。所有控件 mutation 接收到捕获代际的 active fence，退出内容不依赖父级 `panel()` 再构造；预设添加在每次异步读取之后、写入之前再次核对 active，不能取消后继续写或关闭新弹层。cleanup 请求原生 dismiss；没有设置任何背景 AX hidden 属性，背景恢复依赖框架真正移除该独立 presentation，而非另一个 JS gate。

项目选择先捕获 choice 并请求关闭，仅真实 Dialog `onClose` 后才通过 adapter 的 `onDismiss` 通知切换草稿 partition；否则提前替换 Body 会跳过原 Sheet 退出。通知只对非 stale callback 发布一次，页面再次检查 active／Host 和最新 panel intent，不能让旧项目回调销毁新 picker。实际项目 flush／切换仍复用原 `changeProject` owner。

## 3. 若仍漏背景，给 main 的最小 native owner 合同

下列是**拟新增接口**，不是声称 NSH 已有这些方法。它不依赖 node ID 反查、未知类名、全局 UIView 扫描、UIApplication windows 或延时重试。

```swift
@MainActor protocol PickerAXPresentationOwner: AnyObject {
    var presentationID: UUID { get }
    var generation: UInt64 { get }
    var modalController: UIViewController { get }
    var presenterController: UIViewController { get }
    var backgroundRoots: [UIView] { get }
}
```

**注册前提**：main 的原生 presentation owner 必须提供实际 controller／view 引用和 will-present／did-dismiss／failure 生命周期；TS 只给白名单 scope 与代际，不能传任意 view identifier 让 bridge 全局查找。当前公开 Swift `NshAppView` 没有 `nodeID → UIView/controller` resolver；TS `ViewRef` 只有 focus／blur／measure，`Sheet.ref` 不等于公开 Swift UIView。所以若 main 只有现有 Sheet 和 NshAppView，**尚不满足注册前提**，不可编造可用 binding。现有 `NavigationBridge.find` 的全局递归搜索也不复用为 AX owner。

一个可供 main 实现的**公开注册入口**是 `NshAppView.register(component:)`（本机 Swift interface:113–128,146–148）配合 TS `nativeComponent`（本地 index.d.ts:853–880）：在透明 Dialog 内放一个零尺寸、无 AX、无交互的 scope registration leaf，不是按钮、不承载或复制 picker children。Swift factory 直接拥有自己的 UIView；从它的公开 `UIResponder.next` ancestry 取得 owning controller，再用该 controller 的 `view`／`presentingViewController.view` 建立引用，验证其确实是当前独立 Dialog，而不是先扫描全窗口猜哪块是 Sheet。此组件不支持包裹 TS children，不能误做为新的 renderer。找不到精确 owner、没有 presenter 或层级不匹配都应注册失败。

拟注册的 props 为 `scope`（上述白名单）、`presentationID`、`generation`；事件为 `registered({leaseID})`／`failure({code})`。这些名称是合同，不是现有 Yuri API。main 必须在同步原生 attachment／presentation 边界证明 gate 建立早于首个 AX 可见时刻；不能只因 `didMoveToWindow` 或 JS 回调被调用就跳过这一验证。关闭时以 captured lease 接真实 Dialog `onClose` 或 native did-dismiss；**registration leaf 先卸载不等于 modal 已关闭，不能因此提前解除 gate**。surface 真正销毁的恢复由 native owner 负责。此入口若获采用，需同时接主 Host 与独立 fixture 的同一注册实现。

原生接口语义（名称由 main 归入 owning 模块，不在本轮注册为 host capability）：

- `acquire(owner) → lease(presentationID, generation)`：仅接收已经注册且匹配当前 surface/scene 的 owner。先验证全部引用，再原子建立 gate；缺失引用或层级不一致返回明确失败，不能部分隐藏后假成功。
- `release(lease)`：精确匹配该代 native dismissal／失败回滚，幂等。不得接受一个全局 `enabled=false` 去解除其他弹层的 gate。
- scope 至少区分同一页面实例下的 `new-session/picker`（model/agent/project）、`new-session/presets`、`chat/picker`。page 实例身份不使用共享 directory 代替。

### 安全引用与覆盖范围

- 已切换到独立 Dialog 后，`modalController.view` 与 `presenterController.view` 是两棵不相包含的原生树；明确注册 presenter root 可覆盖原正文、composer、系统导航及其子树，不需要逐行找控件。若额外的 native shell owner 不在其中，由该 owner 显式注册自己的背景根。
- 为每个 background 验证：它不等于 modal root、不包含 modal root，也不在 modal root 内。任一失败则拒绝 acquisition。这尤其会拒绝在原 overlay 结构中隐藏整个 NshAppView 的错误方案。
- 只对 owner 管理的 UIKit 背景根设 `accessibilityElementsHidden=true`；不改 `isHidden`、alpha、layout、interaction 或数据。modal root 则可设 `accessibilityViewIsModal=true`，保留 `isAccessibilityElement=false`，让真实 rows 独立暴露。
- 不隐藏 UIWindow／scene／键盘／整应用；不改 NSH 控件的私有 getter 或祖先结构。UIKit 原生 SDK `UIAccessibility.h:156–167` 证明 hidden 控制 contained AX elements，而 modal 属性控制仅暴露接收 view 内的元素，默认都是 NO；它们不是视觉隐藏属性。

### 生命周期和恢复

- gate 必须在 modal 首次可能被 AX 暴露前由原生 owner 建立，而不是 JS `onOpen` 后才补（后者在 viewDidAppear 后，不能证明没有首帧漏出）。
- 保存各已知根的原始 AX 状态和 modal 状态。嵌套 lease 用 ledger／引用计数；只在最后一个有效 lease 结束后恢复 owner 的有效基线，不能一律写 false，也不能覆盖其他 modal 的 gate。
- 用户点选、下滑、外点和 cancel 都先走已有关闭流程；gate 覆盖全部退出阶段，到真实 native did-dismiss 才释放。失败回滚、页面卸载、surface 代际失效也必须由该 native owner 保证清理；不能依赖 JS timer、猜动画时长或用清除整 App 的 AX 状态作兜底。
- 未建立注册关系或 gate 失败必须暴露未完成状态，不允许悄悄降级后记作“已隔离”。

## 4. 验证边界

- 用当前本地 NSH 0.4 类型对 `Dialog → Sheet → children` 和 `nativeComponent` 注册合同做 tsc：通过。没有 mount、复制生产 UI 或实例化 renderer。探针只验证支持的 props，未证明 layout／AX 行为。
- 对上面的 owner 引用接口、局部 public responder ancestry、`viewIfLoaded`／`isDescendant(of:)` 校验及 UIKit AX 属性读写，用 iOS Simulator SDK 26.5、arm64 iOS 15 target、已安装 NativeShell framework 做 Swift typecheck：通过。没有运行 UIKit 对象或操作窗口。
- Apple Context7 查询达到配额后，改读 Apple 官方声明和本机 SDK header；NSH 依据始终固定 `e626a8d`。
- 新增 pure owner 与生产 wrapper 的 VM callback 红绿测试，并由 page VM 明确加载真实 wrapper／owner；未知 import 仍报错。覆盖旧代回调、首次进入取消、退出保留、native interruption、后台／Host 失效和 cleanup。VM 只观察真实控制表达式与回调，不模拟 UIKit motion／布局／AX。
- 独立构建脚本现在对生产 fixture 依赖闭包做 tsc，快照本合同及验收步骤，manifest 明确将 UIKit AX／视觉／键盘标为 false。新 bundleID 和唯一输出目录不覆盖 `99e6cc77` 或其它旧产物。
- 本轮未安装／启动 App，未运行设备、NSH engine、真实 Host 或 main build；未改 application／state／native main 或第三方依赖。新增的窄 Swift 注册 owner 由 fixture 先接入，production main 的注册接线交 main 完成。

## main 的真实验收门槛

每次留完整 AX，而不只取若干 ID：进入、搜索键盘打开、选择/收藏、关闭 motion、已关闭、快速重开、后台恢复；记录 presentation/owner 代际。

- 打开时真实 Search／Build／Plan、模型／收藏／variant 控件可达且语义和 selected 值正确；背景 composer、项目、预设、系统标题／Back、Tab／shell 均不可 AX 聚焦或激活。截图背景视觉不变。
- 收藏只写收藏，不切模型／variant／Agent；关闭不丢草稿，不 pop 底层 NavPage。退出动画期间不能提前重新暴露背景。
- 关闭后原背景 AX、系统 Back 和下一次 picker 均恢复；重开不继承旧 lease，旧 onClose 不解除新 gate；错误、取消与销毁不留背景永久不可达。
- VoiceOver／实际 AX helper 需要分别验证，源码属性和 SDK 编译不等于两者都已通过。

结论：首选透明 Dialog 承载已落地，交 main 用新独立 fixture 验证；若 UIKit 仍漏背景，才考虑上述具备直接引用和原生生命周期的 gate。本轮没有实现该 fallback，**不宣称背景隔离成功**。
