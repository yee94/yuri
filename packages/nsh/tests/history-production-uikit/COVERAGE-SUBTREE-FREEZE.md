# 独立 coverage 子树修正冻结

本修正供原 oracle 单独复核，先于 v4 接线冻结。此前已关闭的 Composer/modal/outer/corridor 与 control-read ≤5ms 合同、driver、build 均不改。旧 `P1-P2-989-FINDINGS.md` 的历史 SHA 保留。

修复原 `liveCoverage` 只检查上层 sibling 自身 bounds 的漏洞：现遍历上层 sibling 的子树，使用每个节点真实祖先 clip chain 与全文 target rect。clipsToBounds=true 且有效裁剪范围与 target 不交时才剪枝；不裁剪的可见节点无法通过 public bounds 排除任意越界绘制，明确 unknown。未知 transform/mask/animation、枚举/子树容量耗尽也 unknown。中心 hitTest 仅为附加拒绝条件，不能覆盖 subtree unknown 或角落 blocker；没有 known=true fallback。

发现层共用 `HistoryCoverageTraversal`，节点发现加扫描总预算8192。Swift macOS可执行回归覆盖：sibling自身不相交而 child盖住文字角落且不含中心、clip开关、实际上游clip裁掉child、未知geometry、无child仍有unclipped drawing风险及cap耗尽。`observer-sdk.swift` 另构造真实 public UIWindow/UIView/UIScrollView，验证无touch child/中心hit仍outer/角落blocker、clip true/false、cap耗尽。该真实UIView夹具已随SDK typecheck/object compile通过，**未在UIKit执行**；main需调用 `historyProductionSiblingOverflowUIKitRegression()` 才取得该项运行证据。

验证：focused observer + native-diagnostic-v3 共2文件7项通过，含共享算法可执行回归、原35条Swift身份断言、Python v3回归及完整builder SDK typecheck/Observer与probe object compile。第一次回归因macOS提取源码未import CoreGraphics编译失败，补齐测试import后上述最终运行通过。未运行设备、engine、Host或Git。

| 文件 | 独立修正 SHA-256 |
| --- | --- |
| Observer.swift | `1a4ba78caf7f81640382d67aba0b9b8258d3f742c76985ebb7e2c091260203ec` |
| observer-sdk.swift | `34c23d0ce8b46db3d8768e8d3352c7773340e412ca8005d5559d9a2116af4597` |
| observer.test.ts | `e7c71adbeb3ea96bf3c777ad11ba4483e2f2b886c6b118f5c51c099c71d4dc59` |
| native_diagnostic_v3.py（未改） | `ac0163d72611863044c79514d13693a95cf11e1ba225ad74557801895874a8f6` |
| native-diagnostic.py（未改） | `16b5213df6947c75a1fa21543095f8298d67767c26ca246c86964abfbd059959` |
| build.mjs（未改） | `a6f9b0b7462020a636df3cf3fade3969e74212ac9fa5946309a9dfdc50307106` |

原oracle结论待main转交。此修正仍是保守public geometry证据，不是pixel遮挡ACK；不授权自动pan、不代表v4存储或原−53pt验收通过。后续v4接线SHA另记，不覆盖本冻结。

## v4接线后的独立复核锚点

v4增加Observer存储接线，故整文件SHA会变化；上述历史整文件SHA不更新。coverage算法与public sibling扫描实现保持本修正内容，可独立核对以下UTF-8源码片段SHA-256：

- `Observer.swift` 从 `enum HistoryCoverageTraversal {` 到 `/// Bounded synthetic AX metadata` 之前：`2bc3baa814cd9385f81eaf8697b3e814ed2daa731426240cb813825f1fd50342`。
- `Observer.swift` 从带4空格缩进的 `static func siblingCoverage(` 到 `/// UIKit diagnostic sampler;` 之前（含WindowObservation结束括号）：`7ad1f4603295649d823646c3e79f669d357862edb286fb93d8eaf79537d18eec`。

真实UIView夹具进一步补了**子树内部**容量耗尽：所有节点clips=true时全量扫描unknown=false，预算比完整实际inspected少1时必须unknown=true。它与原capacity=3的发现阶段耗尽分开。`observer-sdk.swift` 从 `@MainActor func historyProductionSiblingOverflowUIKitRegression()` 到下一 `@MainActor func historyProductionSnapshotRejectsUIKitRegression()` 之前的当前片段SHA为 `0d685b0a473d1dbbf1d6aa32f924e44cef1b884dcd3aa658a6ae2b4927015cb5`。新SDK编译结果见本轮v4交接；该夹具依旧待main实际UIKit执行，不能把编译或纯算法回归写成设备PASS。

## main 实际 UIKit 执行

上述“待运行”为早期阶段记录。main 已安装并启动独立 `example.nsh.coverage-regression.run-b1fe65f6`，在真实模拟器 UIKit、`-Onone -assert-config Debug` 下依次执行三个原函数：`historyProductionSiblingOverflowUIKitRegression`、`historyProductionSnapshotRejectsUIKitRegression`、`historyProductionTypedGeometryFieldParityRegression`。它们全部正常返回后写出的 `Documents/result.json` 已读回到 `.scratch/nsh/coverage-uikit-b1fe65f6/result.json`，报告 `status=pass`、`assertionsEnabled=true`，`sourceHash=9a7cf30b3471f17ffcb8490ddb7d71aa46e8a9913a51bf29608e269b2e635b3b` 与本次构建冻结一致。

该载体没有启动 engine、Observer 采样器、writer、Host、网络或手势。结果只证明三个真实 UIKit 夹具执行通过，不证明 v4 长时成本、SDK adoption、原 −53pt 修复或历史每帧稳定性；不据此恢复自动 pan。
