# 应用内错误通知的独立 UIKit 验收

`error-feedback.ts` 只拥有错误展示、关闭与显式重试 admission；domain failure、catalog receipt、写入结果未知状态始终归原 owner。`state.run` 捕获原 Host generation、原生 lease 与页面代际，只有调用方显式提供的原恢复函数才出现 Retry。普通未知写入没有 replay。关闭保留 `app.error` 和失败记录；重试成功只清同一条通知，迟到成功/失败均不能修改更新的通知。

附件退休失败由 `attachment-pick` 的第三个 failure 参数提供原 cleanup owner、原 native lease 与确切 `cancelExact` 重试，Chat/新会话两实际 callback 都通过 `reportOwnedError` 发布新安全提示，不再直接写 `app.error`。页面退休不丢清理票据，失败时也不捕获当前新 Host；已关闭旧提示不阻挡新失败。该回调装配不改变 contact ACK、文件采用或 receipt journal。

APNs 控制器的失败另外按 `settings`、`live:eventID`、`launch:receipt` 保存来源；成功只 resolved 同来源。保留原 `refresh/recover` 控制器入口，不使用此应用内错误模块重放 APNs 或任意业务写入。回归覆盖 live A ambiguous → launch B 成功、两个 live event 交错、settings read 失败 → B 成功，均保留 A 的提示与重试，直到 A 自己恢复。

`error-notice.tsx` 是 NSH 原生 `Overlay`，无 anchor 时使用公开接口的 root-fixed 语义，不参与 NavStack/body 的布局。不注册 outside-press/cancel 或全屏 backdrop；overlay 根 `pointerEvents: box-none`，只有有界 Scroll/通知卡片命中触摸。顶部取 `max(safeArea().top, feedback.layout 的真实可见 UIKit 导航栏底缘) + 16`。`FeedbackLayoutBridge.swift` 只读 UIKit 几何，根页面/窗口/安全区变化重新读取，迟到回复按展示代际丢弃；首次测量前透明且不接收触摸，保留 children 挂载与关闭记录。非 iOS/headless 无 UIKit bridge 时只使用其实际 root safeArea，不发业务重试。左右按两侧较大安全 inset 对称居中，宽度最多 560pt。正文不设行数/缩字，系统字号无倍率上限，按钮可换行，长内容由最高剩余安全高度 60% 的 Scroll 承载。

可直接构建，不安装/启动、不访问真实 Host、模型或 Keychain：

```sh
NSH_BIN=/existing/nsh/bin/nsh node packages/nsh/scripts/build-error-feedback-uikit.mjs
```

产物是独立 bundleID 的 `ErrorFeedbackFixture.app`，`evidence.json` 保存源图 SHA、字节码 SHA、Swift SHA、exact grants。仅授予 `connection.list`、只读 `feedback.layout`、原 appearance owner 的 `appearance.fonts.retry` 与三个 fixture 控制方法；`connection.unknown` 刻意不在列表、也没有 Swift handler，用真实 NSH 拒绝测试，不伪造空成功。生产 `nsh.json` 已声明 `connection.list`、`runtime.request`、`runtime.stream`、`runtime.stop`，本轮只为新只读几何桥增加 `feedback.layout`；History UIKit 原生装配、冻结 Swift 列表及 exact grants 同步增加这一项，不因截图文字不全猜测额外授权。

Swift `feedback.fixture.read` 校验捕获的 exact Host/lease，持续失败时返回与截图同类型、同量级长度的原始 capability diagnostic，包含虚构 path/token/stack 哨兵。产品只显示本地化分型摘要；`允许原读取恢复` 只改变合成 reader 的失败条件，之后点击原通知 Retry 才恢复。负权限按钮通过真实 `host.call('connection.unknown')` 验证权限拒绝仍存在。

运行由主会话独占。载体使用真实 UINavigationController、原生 Back 控件及 NSH 系统 TabBar。App 每 0.5 秒及显式记录动作输出实际 UIKit frame 到 Documents/feedback-probes/*.json，包含 safeArea、navigationBar、window、contentSizeCategory、body 首行、body viewport、bottomTab、通知/正文/按钮、读取次数、原 reader failure 与是否发生 raw 哨兵泄漏。Probe 只有观察权，不修改产品 frame 或错误状态。

主会话逐项签收，不能把构建或状态测试当作 UIKit 通过：

1. before → 注入错误：通知 top ≥ safeArea.top+16，左右对称、宽≤560，通知内容与 status/system back 不重叠；body 首行和 bottomTab frame 不能因通知出现变化。
2. 持续失败 Retry：原 reader 计数只加一，通知保留且按钮可继续使用，不自动轮询或自动重发。
3. 关闭：通知消失，failureRetained 仍为 true，原 reader failure 仍 true；body/Tab frame 与 before 相同。没有通过关闭授予任何写入。
4. 再注入 → 允许读取恢复 → Retry：只恢复原 reader，通知清除，没有目录刷新或任意 Host 写入。
5. 系统字号 200% 与横屏分别重做 before/注入/关闭/重试/恢复，保留每项 JSON 与截图；核正文多行、按钮 frame 可见且可点击、长内容 Scroll 可达。直接 label 的 fontSize 缺失时，必须从独立截图/布局观察验证实际字形，不能用 trait category 代替字号生效证据。
6. 通知出现时操作返回及正文滚动/触摸，检查 back/touch 计数与实际 Scroll 位置；通知外不能存在全屏触摸屏障。
7. A→B→A、同 Host 新 lease、页面关闭重开与关闭中 retry 迟到回调由生产 `state.test.ts` 和 `error-feedback.test.ts` 的确定性回归覆盖；这不冒充 UIKit 多 Host 联调。
8. `显示原 appearance warning` 挂载真正 `NativeAppearanceFeedback`，仅 seed 合成投影、不启动字体下载/注册。它与根错误共用同一个 Overlay，根错误存在时只 suppress warning UI，保留 warning owner 与关闭记录；字体 unsupported 使用普通语义文字/summary，不画成红色错误。Retry 返回同一 synthetic unsupported 状态的新 ticket，不能伪造字体加载成功。独立检查 root 出现/关闭时只有一条通知，appearance 的关闭不清投影。

截图中的 app 名为 `Yuri NSH Isolated e4ec5fe5`，并非生产 bundle identity。当前生产源和已有 `.nsh/out/YuriNative.app/nsh/capabilities.json` 都包含 `connection.list`；History fixture 源 methods 也包含它。截图遮挡了被拒绝的确切 method，原 e4ec5fe5 artifact 的运行时 grants/bytecode 与调用 resource 尚待主会话读取后判定。此处不能声称已经证明或修复其具体缺项，也没有放宽 production grants。
