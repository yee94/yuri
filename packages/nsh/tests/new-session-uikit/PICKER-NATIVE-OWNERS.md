# 新会话实际 editor AX 与 presentation completion

## 真实红灯与范围

main 对 `3f51bbee` 的真实 650ms Agent 长按已确认初次展开时应用背景 composer／预设／Back／project 不在 AX，Build／Plan 的真实 ID 可达。这是初次 Agent 展开的证据，**不是完整流程已通过**。

- `.scratch/nsh/chat-frames/new-session-dialog-agent-expanded.json` 的实际 UITextField frame 是 x37/y315/w348/h36，AXValue 为 Search agents，但 AXUniqueId／AXLabel 均为 null；按 ID 的搜索／键盘验收失败。不得猜坐标继续。
- `.scratch/nsh/chat-frames/new-session-dialog-agent-selected.json` 显示选择 Build 后背景恢复；随后 `new-session-dialog-model-expanded.json`／`new-session-dialog-model-reopen.png` 仍是背景，没有模型 Sheet。不能只把它记为 AX 泄漏。
- 系统 breadcrumb 返回 Terminal 是系统状态栏，不属于应用背景，未做任何屏蔽。

## 固定 `e626a8d` 的 public API 核查

Context7 配额已耗尽，以下依据当前生成类型、本机 NativeShell Swift interface，以及只读固定 commit 源码；没有修改安装的 NSH／第三方源码。

### Input

- `base.d.ts:5989`：InputProps 是 CommonProps + InputHostProps；types.d.ts:991–1056 列出真实 Input／iOS props，**没有 inputProps 或 editor ref**。`nsh` index 未公开另一个 TextInput；Input 本身就是 host element，不是可另选更底层组件的包装器。
- [`input.rs:687–742`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-platform-ios/src/input.rs#L687-L742)：每个 Input 有 decoration UIView 和真正的 Field／Area editor；`editor_view()` 是真正 first responder。
- [`mount.rs:93–110`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-platform-ios/src/mount.rs#L93-L110)：Native::Input 不属于 `nsh()` 可返回的 NshView，不能走 `NshView.props` 的 AX getter 映射。
- [`input.rs:799–898`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-platform-ios/src/input.rs#L799-L898)：配置真正 editor 的 font／placeholder／traits／editable，但不设置 accessibilityIdentifier 或 accessibilityLabel。这与真实 AX 的双 null 一致。加未知 props、反复重设外层同名属性或新增假目标都不能解决。

### Dialog

- [`nsh-js/navigation.rs:1021–1028,1078–1079`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-js/src/navigation.rs#L1021-L1079)：public open=false 返回 null、移除实际 modal 节点；onClose 转发原生 Dismiss。
- [`dom.rs:837–869`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-js/src/dom.rs#L837-L869) 尝试保留已 finalize modal 的 Dismiss handler；这并不产生原生事件。
- [`mount.rs:1079–1088`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-platform-ios/src/mount.rs#L1079-L1088) 的 Delete 路径调用 `modal.dismiss(at_once, || {})`，**没有 Dismiss 事件**；相较之下 [`mount.rs:3452–3459`](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-platform-ios/src/mount.rs#L3452-L3459) 的普通移除路径才在 completion 派发 Dismiss。
- 上游 `removed_modal_hears_its_dismissal` 测试也由测试主动派发 EventKind::Dismiss，并非 UIKit mounter 的完成保证。因此先前仅手动调用 public onClose 的 VM 测试不能锁住本次真实红灯。

**可确认的是源码有丢通知路径；没有设备原生日志，不声称已证明本次一定命中 Delete 分支。** 本轮不再依赖 public onClose 必定到达，也不靠延时释放或在旧 root 上 false→true 复活。

## 最小 registered owner 实现

`ios/NewSessionPickerOwners.swift` 通过公开 `NshAppView.register(component:)` 注册真实 Input AX 的零尺寸 leaf；TS 声明位于 `new-session-native-owners.tsx`。呈现 completion 已迁移至通用 `ios/SheetPresentation.swift` / `native-sheet.tsx`，不再注册旧 `yuri.newSession.presentation`。不新增 host/network 权限、全局 patch、swizzle、未知类名、窗口遍历、私有 API 或生产计时器。

### 真实输入绑定

在原 Input 后、**同一个既有布局 parent** 内放一个绝对定位零尺寸 registration leaf；不新包容器、不插入 flex gap，不改变 Input 原 class／value／onChange／focus／selection 语义。marker 没有 testID，不能被拿来作为搜索目标。

- scope 白名单只有 selection／presets／directory；Swift 将它们映射为原 `new-session-selection-search`／`new-session-presets-search`／`new-session-directory`。
- 从自身 nativeComponent host 的已知直接 parent 出发，只看该 parent 的直接子容器的直接 UITextField；必须**恰好一个**、同 window、层级吻合、无冲突身份，否则 fail closed 并输出固定失败 code。不是全局或递归找 view。
- 只写这个真实 UITextField 的 accessibilityIdentifier／accessibilityLabel；label 与实际 Input 的现有本地化 placeholder／label 表达式一致。不会改 text、delegate、focus、enabled、AX role、frame 或其它背景属性。
- localized label 更新在原目标上更新。卸载时按原值及最后写入值做 CAS 恢复，不覆盖其它 owner 的新写入。没有用户输入值出现在日志中。

### 实际 modal completion 与新 generation root

在系统 `Dialog presentation="pageSheet"` 内放通用 registration leaf。通过自身 public UIResponder.next ancestry 捕获所属 UIViewController，验证其 root 确实包含此 leaf，dismiss 时核对 `presenter.presentedViewController === controller`。没有其它 controller resolver 或全局查找。

1. 不再保留透明 fullScreen 与窗口内 Sheet 两层。UIKit 系统 Sheet 唯一拥有 detents、grabber、圆角、背景及拖动；模型档位为 72%/98%，iOS 15 回退 medium/large。
2. TS 关闭 intent 对该代 ref 发 `dismiss({generation})`，若尚在原生进入动画中，等真实 transition completion 后再执行关闭。
3. **该代 public Dialog 始终 open=true 且保持 root，直到真实 UIKit `controller.dismiss(animated:completion:)` 完成**。减弱动画时不执行动画，仍依赖 completion，不让 NSH 的 Delete 路径提前移除来源。
4. 原生 completion 通过同一个 context 发 `dismissed({generation,interactive})`；TS 精确匹配 captured generation 后才释放，并 keyed 构造全新 root。不依赖 public Dialog.onClose；交互 dismiss 由系统 presentation delegate 完成。
5. native owner 对重复 command／completion 幂等；缺失 exact controller 或不匹配 generation 不操作其它 controller，不拿 detach、背景可见或猜测时间当完成。pending 使用 `isModalInPresentation` 与 delegate 阻止关闭。页面销毁还由框架移除 root，不设置全局背景 hidden 状态。

Input AX 日志仅含固定 field ID 或 failure code，呈现通过带 generation 的事件通信，不记录草稿／搜索词／模型／Agent 用户数据。

## main 的生产接入合同

独立 fixture 与 production `ios/main.swift` 均在 loadBundle 前注册同一实现：

```swift
NewSessionPickerOwners.install(on: surface)
NativeSheetPresentation.install(on: surface)
```

构建纳入 `ios/NewSessionPickerOwners.swift` 和 `ios/SheetPresentation.swift`。缺注册时 public nativeComponent 只渲染空 view，不能把未接入的包当作修复。不是要求升级／修改外部 NSH。

## 本轮验证与剩余验收

- 先复核 main 原始 AX 红灯；静态 Call-site 测试先红，再补三个真实 Input 的注册合同，检查 labels／IDs／原编辑样式与回调、无假 testID。
- wrapper／page VM 增加“完全没有 public Dialog.onClose”场景：只有 registered completion 才释放，真实 Agent 长按 callback→选择关闭→model intent→新 root 连续四轮；旧 event／错误 generation 不能释放新代。它验证生产适配器对 native 完成信号的处理，**不是模拟 UIKit 已完成**。
- 通用系统 Sheet 和生产新会话 modal adapter 的隔离 UIKit 载体已验证真实 detents、关闭保护及重开；不等于完整生产新会话页面。当前新会话 UIKit carrier 的实际前置禁用态及未验项见 `../../SYSTEM-SHEETS-VALIDATION.md`。
- 必须先按实际 TextField ID 找到它，确认 localized label，再真实 focus／输入／清空／键盘收起。Agent、model、预设和目录逐项测试；任何 ID／label 缺失或 failure code 出现即停，不猜坐标。
- 优先复跑 Agent→Build→系统 Sheet close→Model open，记录每代真实 completion 及完整 AX／截图；再 Model→Agent／预设／目录和快速开关、退出中重开、后台恢复。核对系统 detents、背景隔离和审计增量；未运行项仍未通过。
