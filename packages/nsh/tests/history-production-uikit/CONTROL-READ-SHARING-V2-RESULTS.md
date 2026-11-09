# control-read-sharing-v2：同轮完整事实共享

真实十 binding control 是否达到 ≤5ms 仍未验收。f37195ff 的两次完整读窗为 9.518333315849304 / 12.050625085830688ms；13 个 baseline frame 为 2.9684582948684692–4.211666703224182ms。旧红证据、原 −53pt、SDK adoption / 权威 row-key adoption / 独立文字锚点 unknown 均保留，自动 pan 继续暂停。

## 成本与保持的语义

f371 第一次 window 2.515625ms，binding geometry 合计 1.424791ms、coverage 与 metadata 合计 3.889334ms、pure freeze 1.206125ms；第二次对应 3.205708 / 2.028958 / 4.758958 / 1.409625ms。完整输入包含 **425** 份祖先审计、87 个唯一实例；旧 409 计数漏掉 outerTranscript.geometry，不能继续作为完整数量。

v2 在一个同步 read 内共享 UIView/layer state、identifier、父链、above-sibling roots、geometry、原始祖先审计及 typed 祖先值。425 份审计在 wire 中仍完整展开，仅 typed 转换减少为 87 份，另 338 次复用。canonical 集合只来自本轮实际捕获的不可变审计；未捕获条目仍完整转换。容量限制只约束缓存，不能截断检查。父链保留最多 8192 个链接。

每个目标仍独立执行 scan/cap/clip/blocker/hit，浮点计算仍按 leaf→root 顺序。public subviews 遍历的 surface 前缀关系替代本轮重复 descendant 查询；本机 UIKit UIView.h 明确 isDescendantOfView 对 self 为 YES，v3 保持原路径。read 间不共享动态 UIKit 数据。

最终总 wall 包含 window、全部 binding、安全判定、诊断、typed shadow、完整 pure freeze 和本轮 owned cache cleanup。新增 typedShadowEndNativeMs / contextReleaseEndNativeMs 与 AX frame / coverage 分界帮助定位成本，不扣除这些成本；context.finishRead 显式清空 UIView/CALayer、父链、geometry、审计及 memo。

## 最终离线证据

目录 `.scratch/nsh/control-read-sharing-v2-final/` 保存最终四份 Swift 输入、probe、完整 160 个 paired 样本、TLV、编译/运行 stderr 与 hashes.json。每 variant 80 次，交替执行顺序，每轮新 plan；canonical set 构造和 pure cache cleanup 均计时。输入是 f371 的完整 219273-byte native-before.json，未读取巨型 capture.json。

| 纯值转换指标 | 原路径 | v2 |
| --- | ---: | ---: |
| wall median ms | 3.8792500272393227 | 1.3987916754558682 |
| wall p95 ms | 7.095000008121133 | 4.215499968267977 |
| wall max ms | 14.5378332817927 | 6.3902916153892875 |
| thread CPU median ms | 3.271250000000009 | 1.227040999999872 |

每次输出与完整原路径 TLV 逐字节相同：354272 bytes，SHA-256 `84d3f435a7215b53eaecf8933c8e2e7769b561dfab830ff3a2acb1b1b36b9e73`。全部 outlier 保留。这是已捕获输入的纯值实验，未执行 UIKit，不能签收真实总读窗、首次真实 frame 或遮挡安全运行一致性；初轮探索数字不再作为最终代码性能。

## 编译与验证边界

最终 Observer/control-read/control-value/native-snapshot 4 文件 9 项通过，包含完整 SDK typecheck/object 编译、新 geometry/coverage parity 函数编译、完整字段位模式、634 节点谓词/成员关系、每轮鲜度与未知引用拒绝。parity 函数尚未在 UIKit 执行。builder 去重后的 build/identity/insets 3 文件 7 项通过。

fbb58872 在 typecheck 前因 FeedbackLayoutBridge.swift 重复输入失败，未进入优化链接，partial 与 manifest 保留。规范数组只留一份该输入，staging 前断言输入唯一；保留其它 owner 的 feedback.layout 及实现。完整 Swift 输入与 -O 保留，只有优化链接看门狗为 600000ms，其它阶段为 240000ms。新隔离包另交机器索引，旧 CONTROL-READ-ARTIFACT.json 不覆盖。

最终专项 TypeScript noEmit 和 build.mjs 语法检查通过。dead-code 已执行，专项命中 0；全仓报告 132 unused files、795 unused exports、613 unused exported types、6 duplicate exports 与 5 configuration hints，未修改其它 owner 的发现。完整报告保存在上述离线证据目录。

## main 唯一复验

main 独占设备，新包只运行一次 prepare→read→AX→read，保全三个 fence 的全部 prefix，不因 prepared=false、0 binding 或超时重复 prepare。必须核对真实十 binding/full geometry/coverage 规模、完整审计、安全 unknown/blocker、同轮计数及两次总 wall ≤5ms。若仍红，保完整 phase 并停止。正常 public setter backing 由独立 SDK owner 所有，manifest 的 nativeShellFrameworkSHA256 用于对齐确切产物；本 worker 不改 SDK，不把 public AX setter 成功视为 adoption。

原 18000 typed 压力的 core、输入及门槛不变，19218 records、216 坏帧、185 gap 均保留；32 pool 高 RSS 旧限制未解决。旧压力结果不能签新 frame 性能，18000/250ms/5ms/1.1pt/三完整 body 门槛不变。worker 没有设备/真实 Host 操作、Git 操作或安装依赖。
