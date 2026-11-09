# P1/P2 安全修正与989身份读回证据

复审目标为原 oracle `ses_e4860d236ffe3ahTpjWqNNbxE4`。本轮只修改 test Observer、v3 driver/专项测试及新合同标记；保留 main 已加入的 NativeInputMetadata/Spellcheck 构建输入，不改它们、SyntheticHost、生产布局、SDK、旧 artifact 或 strict 工具。没有运行 engine/device/真实 Host/Git，也没有复制或整包解析2.42GB capture。

## P1：pre-pan 不能仅用旧 header/token signature

原 pre-touch read 只有 binding/header，缺少当前 Composer、modal、outer motion。现 control-read 在**自己的同一 native start/end 读窗**内补充 `windowObservation.liveProtection`：

- 当前实际 `chat-composer-expanded/compact` 根与可见 header 控件的 window/surface 几何、hidden/alpha、祖先 clip/transform/presentation。缺 Composer 根、多个 active 根或不确定 geometry 均拒绝。
- 遍历当前公开 controller 图得到 presented controller、present/dismiss/transition 状态；记录可见 accessibility-modal view、同屏其他可见 window。window 枚举/前台/当前 key window 无法确证时 coverageKnown=false，不用 empty success 冒充无覆盖。
- 唯一 outer UIScrollView 的当前实例、window/surface frame、可见 clip、offsetX/Y、tracking/dragging/decelerating、pan state/translation，直接读取当前 UIKit 对象，不从下一 periodic sample 推断。
- 每个绑定文本的当前 public sibling/z-order bounds 与 hit route。上层 sibling 覆盖、hit 不归唯一 outer、内层 Scroll 或无法判定时 liveCoverage 拒绝；这是保守的 public geometry/hit 证据，不是 coded-pixel 遮挡 ACK。

driver before/after AX 和 pre-touch 都执行 current protection/idle/range 检查，保留原 token、weak object、完整 ancestor chain 与 text clip 校验。pre-pan 除完整文字外还验证**原计划 source/end 整条直线 corridor**位于当前 header/composer/viewport/safe-area 保护范围；保护范围改变要求新 admission。pre-mark 同样先读当前状态、核验选中 body 对应文本；若接下来是 pan，先验证计划 corridor，再允许发 mark 命令。

故 Composer 在 flush 期间上移（即使仅截住原计划终点）、出现新 modal/未知覆盖、outer 开始 pan/减速或 offset/frame 改变，均在 touch begin 与 mark 命令之前停止。未知保护字段也拒绝，不改三完整 body、250ms、1.1pt、gap 或 clock 门槛。

## P2：每个 control read 自身也必须≤5ms

统一检查 before、after、pre-touch/pre-mark 的 `readStartNativeMs/readEndNativeMs`：类型必须是有限数值、非负，且 `0 <= end-start <= 5ms`。缺结束时间、NaN/Infinity、倒序、负数或超过5ms全部拒绝。不是只检查 periodic exposure 或 read-start 新鲜度。

原 ACK 先落盘，再检查读窗；超限证据保留。源码没有放宽阈值，没有删 gap 或挑帧。新 manifest/capture 明确带 `control-safety-v1; identifier-immediate-readback-v1`；自动 runner 在任何 clock/control/touch 前拒绝旧989合同。989仍只可供 main 已授权的手动 prepare/AX 取证，不能拿它跑修后自动输入。

## 989真实 token 证据：已证与缺口

只读材料：`.scratch/nsh/uikit-989dfdee-identity-first/{native-before.json,ax.json,native-after.json,proof.json}`。

已证事实：prepare 的 assignedSequence=1839；首次保存 read 为seq2867，后次为2966，9个 binding 都是 valid=false、reason=application identifier changed。两次读取仍是相同 live UIView 指针，当前链存在，isAXText=true、nested=false；运行类型均为 `nsh_platform_ios::text_view::TextView0.4.0`。两次 control exposure 为约2.871ms/2.381ms，实际 native read-start 间隔约1720.855ms。helper 中 hpdiag token=0；Composer 的 TextArea `yuri-input-editor-1` 确实存在。这些事实不说明17秒内某次 render 必定覆盖了 ID。

**已证的诊断缺陷**是旧 prepare 只观察 setter 调用完成，未立即验证 public getter，便返回 prepared=true/assigned9。因此 `application identifier changed` 也可能表示 token 从未能被 public getter 读回，而不一定是“赋值成功后丢失”。

现有 NSH 源证据：`crates/nsh-platform-ios/src/native_view.rs` 的 accessibilityIdentifier getter（124–127）直接返回 Rust `props.test_id`；TextView 继承该 NshView。`mount.rs`（3666–3676）对 Nsh view 走 set_props，对非 Nsh 的 UIKit Scroll/Input 才直接 setAccessibilityIdentifier。这使**getter 不读 UIKit setter 存储**成为比“每 render 重设 nil”更直接的候选解释；Composer 的普通 UIKit editor 能用原 metadata owner 成功，不证明自绘 TextView 同样可写。

但本轮没有反汇编/修改已安装 SDK，也没有旧 prepare 同调用栈的 getter 值或首次退役时点，故不把源码候选机制签成已安装二进制的完整根因。三个可证伪分支是：

1. setter 返回后立即是 nil/empty/other：public setter/getter 路径不满足绑定合同；不用等250ms，prepared=false，不能导航。
2. 立即是 ours，随后第一次 periodic/control 变成 nil/other：证明后续写入或 owner 更新导致 yield，但具体写入者仍需独立证据，不能直接归因 mount/render。
3. weak object/父链/label 同时改变：对象/业务 owner 退休，按原生命周期退役，不解释为单纯 ID 覆盖。

新增字段只为区分这些分支：prepare setter 后同栈立即读 public ID，返回 assignmentReadbacks（ours/nil/empty/other 与 nativeMs）、writeAttemptCount/readbackConfirmedCount。任一读回失败便 prepared=false；不重试、不强抢、不写 props/isAX/traits。binding 另外保留首次退役的 nativeMs/sequence/origin/identifierKind/reason；不是每帧注入或无限日志，不输出 app 新 ID 的内容。

## main 一次有限验证

新字段需要 main 重包，旧989 App/tools保持 immutable。自动 pan 继续暂停。新包进入稳定 Chat 后，main 可在一个短脚本中连续做 prepare→read→原样 AX→read，保存全部 receipt 后终止自有 App；不要再等待17秒，也不要在长时 UI 测试中保留本版 Observer。

prepare=false/readback非ours 时，记录事实并停止，不改 SDK、不反复 prepare 抢 ID、不缩短250ms门槛。若立即ours，再用首次退役记录界定何时丢失；仍不因此允许 pan。P1/P2 的修复不等于 identity 路径已在设备通过。

长时采样/flush 的独立阻塞与最窄分阶段方案见 [LOSSLESS-EXPORT-V4-DESIGN.md](LOSSLESS-EXPORT-V4-DESIGN.md)。**本轮没有实施 v4 存储管线，也没有把仍有整包 flush 风险的 v3 标成可长跑 UI。** main 长时 UI 验收须另用显式关闭 Observer、无历史证据的 viewer-only profile；本版只交付安全护栏、短程读回诊断及编译/纯测证据。

## 本轮冻结与原 oracle 交接

以下是本轮最终工作区源码 SHA-256，独立于 `AX-ID-V3-CONTRACT.md` 的历史冻结；没有覆盖旧 hash，也没有生成新 App/build artifact。收尾重新读取这8个源文件计算 hash，与最后验证时一致。`build.mjs:13` 仍保留 main 的 `NativeInputMetadataBinding.swift`、`NativeInputMetadataOwner.swift`、`NativeComposerSpellcheckLease.swift` 与 `NativeComposerSpellcheck.swift` 构建输入。

| 文件（相对此目录） | SHA-256 |
| --- | --- |
| Observer.swift | `66ac9a5adff3029f67c10eecf014a71b1454fd5e7b6c5dc96ccabbcead9d94a4` |
| native-diagnostic.py | `16b5213df6947c75a1fa21543095f8298d67767c26ca246c86964abfbd059959` |
| native_diagnostic_v3.py | `ac0163d72611863044c79514d13693a95cf11e1ba225ad74557801895874a8f6` |
| native_diagnostic_v3_test.py | `fd531a1187009c4a9d49e76f9b5d546df65ac3d24f1a0a57320fa788142915e5` |
| observer.test.ts | `1f933fbebcafa1cce0e34579b94017ad31518b0cb7cee06997976bce22bf4afd` |
| native-diagnostic-v3.test.ts | `5f3620635d63719f155e3e5ded854486c6f0947a6d508bb5c672bd40786f6b0d` |
| build.mjs | `a6f9b0b7462020a636df3cf3fade3969e74212ac9fa5946309a9dfdc50307106` |
| EncodingProfile.swift | `a32dcbad0723e450a50eb881b1f74339d2714fa5cc2eb7a9c8899f65866f4312` |

最终验证记录：

- focused Vitest：observer、native-diagnostic-v3、native-diagnostic、build、feedback，共5文件10项通过；内部包含35条 Swift 纯断言及55项 Python 回归。Observer 测试同时通过完整 builder Swift 输入的 SDK typecheck，以及 Observer/ClockClient/probe object compile。这些不是 App 构建、安装或设备运行。
- focused TypeScript `tsc --noEmit` 通过；driver/helper/Python回归文件共3份 AST 检查通过。
- 最终 EncodingProfile 源码重新编译通过；真实小型深层输入的同seq引用精确展开通过，4MiB单输入及32MiB输入×帧数两个读取前预算 guard 通过。大 capture 只查 stat。设计文档的1/16/64帧测量来自此前校准，收尾未重复规模测试。
- `bun run dead-code` 退出0，专项路径条目0；全仓仍报告130 unused files、797 unused exports及NSH 72 unused files配置提示，不能描述为全仓无告警。

原 oracle 复审请检查：P1是否覆盖同次当前保护/outer状态与原pan corridor，P2是否覆盖全部control读窗及先保全ACK，token立即读回是否失败即拒绝且无重试/抢ID，以及旧989自动输入门禁是否在任何control之前。当前没有跨session发送接口；材料由 main 转交 `ses_e4860d236ffe3ahTpjWqNNbxE4`，**尚未获得原 oracle 复审结论**。

仍未完成：设备上的 token 立即读回确认、v4 writer/reader与有限队列、observer-disabled viewer-only构建入口、长时UI及严格历史验收。自动pan继续暂停；没有 strict PASS 或原始−53pt关闭结论。所有修改仍在工作区，未执行Git、commit或push。
