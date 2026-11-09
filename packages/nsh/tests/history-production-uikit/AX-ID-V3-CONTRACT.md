# v3 synthetic diagnostic AX-ID instrumentation

这是一套**显式写 accessibilityIdentifier 的合成诊断 instrumentation**，不能再称完全 readonly。只有新独立 test artifact 启用；不是生产修复、strict PASS、SDK adoption ACK 或真实 −53pt 的关闭证据。旧 artifact、strict recorder/checker、SyntheticHost payload、生产布局/offset/inset/delegate/selection 均未修改。原 v2 文档及其冻结 hash 记录保留为历史，不用新 hash 覆盖。

## 两套 metadata 的边界

main 已在 builder 的 swiftSources 中加入 `ios/NativeInputMetadataBinding.swift` 与 `ios/NativeInputMetadataOwner.swift`，本轮保留这两个输入，不修改其内容或注册。它们只拥有 Composer 内部 editor；v3 只发现当前 outer transcript 中经真实 body 父链核验的合成正文 AX 元素。

v3 token 固定使用独立 `hpdiag-ax-<随机 runNonce>-<递增 token>` 前缀。原非空 ID 一律不可覆盖，包括 Composer metadata ID、生产 body ID 和任何其他 app ID。即使完全相同文案，只要不在唯一真实 body→outer transcript 链内，也不能登记。

## 原生显式阶段

ClockClient 新增两个有 fresh nonce 的文件控制命令，不新增网络、Host route 或生产能力：

| 命令 | 实际行为 |
| --- | --- |
| prepare-ax | 唯一可能写/恢复诊断 AX ID 的阶段；返回 prepared 或明确拒绝，不延迟 history |
| read-ax | 只读取已登记 weak binding 的当前状态/geometry/header，不注入、不恢复 ID、不 hash 全树 |

`prepare-ax` 首先检查 sampler 未失败/overflow，最近 periodic read 仍在50ms内；现有实际样本需有至少250ms、连续 gap≤50ms 的静止窗口，window/surface、outer transcript 实例/frame/offset 和 header signature 不变，无 presented controller、tracking/dragging/decelerating。再读取当前唯一所属公开导航栏，要求无 transition/transform/animation/mask，并检查当前 window 所有 Scroll 的真实 pan/运动状态。此时不满足便拒绝，不进行正文 proof discovery 或 ID 写入。

发现只使用当前 `surface.window`、公开 UIView/UIScrollView 对象、公开 accessibility 属性及 NSH 已有 synthetic body/transcript ID。上限为8192个 window view、256个公开文本发现项、64个当次 eligible binding、256个进程生命周期 token；超过限额即 fail closed，不能挑前64个伪装完整成功。只考虑实际 modelVisible 的正文文本对象，避免给整个离屏预取区打 ID；这不是正文裁剪，也不等于已通过 header/composer 的完整可见性。

绑定前必须同时成立：

1. 当前唯一 outer transcript 是真实 UIScrollView，业务 ID 恰为 transcript；文本的真实 superview 链中只有一个合法 synthetic body ID，该 body 确实在该 outer 下。
2. 文本**已经**是 AX 元素且带 public staticText trait。UILabel/UITextView 类型本身不授予资格；自绘 NSH UIView 通过公开 AX 属性识别，不匹配私有 class 字符串。
3. accessibilityLabel 精确匹配既有合成白名单，message index 只允许0000…0499。系统时间、任意真实文本、合成前缀后追加内容均不匹配；不输出未知文本或其 hash。
4. 原 ID 为 nil 或空字符串；已有非空 app ID 不可写。已登记且当前仍是 ours 的 ID 只可在新的显式 prepare 中恢复原 nil/empty 后重新登记。
5. 文本至 outer 的链上没有任何内层 UIScrollView。UITextView 自身也是 UIScrollView，当前合同保守视为 nested，不因 scrollEnabled 或几何看似不能滚而放开。

**唯一 UIKit 写操作**是 `text.accessibilityIdentifier = token`，以及显式 prepare 中在当前 ID 仍等于对应 token 时恢复原 nil/empty。不改 isAccessibilityElement、traits、label、内容、布局、offset、inset、delegate 或 selection，不发送 AX 通知来迫使树重建。

## 生命周期与测量隔离

登记保存 weak text/body/outer 与逐层 weak ancestor chain、随机 runNonce、不可复用 token、单调 generation、body ID、允许合成文案的指纹、原 nil/empty 及 assignedSequence。指纹只在 prepare 计算；periodic/read-ax 对最多有限登记对象直接比较原合成 label，不 hash 全树。

对象死亡或替换、祖先 wrapper/body/outer 链变化、脱树、label/AX trait/nested 状态变化或 app 写入新 ID，会永久退役旧 binding。weak ancestor 对象也参与比较，避免中间 wrapper 指针重用造成 ABA。token 不以指针命名、不复用、不从已退役条目恢复有效状态；新的显式 prepare 只能签发新 token/generation。

退役是 registry 状态变化，**sampler/read 不清理 UIView ID**。后续显式 prepare 才可恢复仍是 ours 的 ID；app 新 ID 保留，绝不抢回。容量/重复候选预检查失败没有 ID 写；若写入阶段发生意外 app ID 变化则停止后续写并返回 prepared=false/partial/实际 assignedCount，不将部分绑定签为成功。

事前 mark 将 registry sealed，之后 prepare 均拒绝；测量窗口不注入、不恢复，不在 finish 中做 metadata cleanup。探索手势中 prepare 也会因实际 pan/运动状态拒绝。每次新 prepare 后必须重新建立稳定窗口，不能沿用 prepare 前的250ms基线。

Observer 的最近非空 scroll owner 查找显式忽略登记 token，使诊断 metadata 不替换原业务 body/composer owner；另存 diagnosticIdentifier。当前两个 metadata owner 不互相识别/改写前缀。

## 读口与 driver admission

新 manifest 为 `instrumented-v3; synthetic-ax-id-v3; ...`，capture 顶层也明确 instrumented-v3 和非 readonly instrumentation。原 v1 路径仍拒绝 unknown-header generic text；v2 manifest 不被偷偷当 v3 接受。

同一次 periodic sample 记录 `diagnosticIdentity` 和 `windowObservation`；绑定表包含 token/generation/viewInstance/bodyInstance/bodyID/outerTranscriptInstance、完整 ancestorInstancesToOuterTranscript、指纹、assignedSequence、valid/retirementReason、AX frame、native text geometry、nested/isAX 状态。控制 read 另有真实 native 读窗、lastPeriodicSequence/lastPeriodicReadEndNativeMs。`observationKind=control-read` 与 periodic 明确分开，控制读不是伪造的新 periodic 帧或 SDK ACK。

driver snapshot 的 v3 顺序为：

```text
显式 prepare-ax（仅未 sealed）
→ 给 sampler 观测机会，再验证实际 post-prepare 250ms 窗口
→ read-ax before → 原样读取/保存真实 helper AX → read-ax after
→ ACK flush 保存原始 capture
→ 另存 *-v3-evidence.json，不改写原始 AX/capture
→ 逐候选 native/AX/token/header/geometry admission
→ pan 前再 read-ax，拒绝 flush 后的对象/窗口/geometry 变化或 stale sampler
```

时间等待本身不证明稳定，准入仍检查保存的实际 native 样本。每次独立 prepare 的 generation 会改变，不能把手动准备得到的旧 AX 树拿来配对后来一代 token。

driver 要求真实 AXUniqueId 恰好出现一次，且 before/after/current periodic 及整个 native 读区间只有一个 valid native binding。token、generation、text/body/outer 对象实例、完整父链、指纹及 assignedSequence 必须一致；AXLabel 指纹、AX 完整 range、公开 accessibilityFrame 与原生 text rect 也必须吻合。AX missing、merged、duplicate 均拒绝，不合成或修改 helper AX 树。

同 sequence 的 window/surface 坐标、当前唯一所属 UINavigationBar、safeAreaInsets、transform/clip/animation/presentation、现有 header/composer 控件和 viewport 必须满足完整文字可见。未知 header、系统时间无 token、部分文字被 clip/cover、内层 code Scroll 一律拒绝；不裁 paragraph 或 marker 来制造起点。隐藏导航栏仅在公开 hidden 状态及有效 hidden 观察一致时采用实际 safe-area 边界，否则仍 unknown。

导航 admission 不要求整个 body 完整，所以真实 a3 中 hp0488 的独立完整列表文字可成为候选；它不把 y≈−10/h≈701 的 partial body 签为完整。`choose_anchors/stable_before` 仍要求三个完整独立旧 body、250ms、1.1pt及原 clock/gap 条件；无三个 body只能探索/inconclusive。没有 PASS 分支，不能关闭原真实 −53pt。

flush 仍同步序列化/写文件，旧约500ms gap 的观察事实不变。新字段的 CPU/数据量可能继续扩大 gap；不挑帧、补帧、延迟 history 或修改采样阈值。新的原始 capture 与 ACK 必须留存全部 gap；pre-touch revalidation 也不会把 gap 变成严格测量通过。

## 验证边界

纯测试包含原合成白名单18条断言与 token 生命周期16条断言，覆盖 nil/empty、应用 ID、weak ABA、祖先替换、永久退役、容量/lifetime、nested、sealed/不稳定拒绝。v3 Python 用真实 a3 的缩减坐标/label，**额外 v3 native/token/header 字段明确为模拟校准 witness**：y≈525/h25 的 Preserve identity 有匹配 token时导航可用，但三完整 body仍失败；同 body 的 y≈26/h488 段落、0489底边越 composer、无 token系统时间、AX重复/合并/缺失、实例/父链/label变化、clip/transform/presentation/gap及 stale read 均拒绝。

SDK test 冻结临时源副本，前后核对字节，使用真实 iOS Simulator SDK/NativeShell：完整 builder Swift 输入 typecheck（包含两个 NativeInputMetadata 文件），以及 Observer、ClockClient、UIKit probe 的 object compile；不运行 UIKit probe、不启动 engine/device。SyntheticHost 由其 owner 提供稳定版本，本轮未改。v2 历史报告中的 Host 编译阻塞不沿用为本轮当前状态。

聚焦验证命令：

```sh
NSH_DIST="$NSH_DIST" bunx --offline vitest run \
  --config packages/nsh/tests/history-production-uikit/vitest.config.ts \
  packages/nsh/tests/history-production-uikit/observer.test.ts \
  packages/nsh/tests/history-production-uikit/native-diagnostic-v3.test.ts \
  packages/nsh/tests/history-production-uikit/native-diagnostic.test.ts \
  packages/nsh/tests/history-production-uikit/build.test.ts \
  packages/nsh/tests/history-production-uikit/feedback.test.ts
```

未设 NSH_DIST 的 SDK test 会明确 skip，不能当 SDK 已编译。旧 a3 文件与 v2 hash 文档均不改。

## main 新包与可验路线

以下仅由 main 执行，本轮 worker 未构建 NSH 包、未安装/启动设备：

```sh
NSH_BIN="${NSH_DIST:?set existing NSH distribution}/bin/nsh" \
  node packages/nsh/scripts/build-history-production-uikit.mjs --scenario normal
```

输出为全新随机 build/bundle 身份，experiment 默认 OFF。核对 manifest 为 instrumented-v3、synthetic=true、original53ptSameScenario=false，且包含 main 的两个 NativeInputMetadata 输入。按既有 README 安装/冷启并进入真实 production Chat，再给新包创建配置：build/clockClient/data 都必须指向**新包与新 sandbox**，不能只替换旧 config 的 build 字段。

main 可先在稳定 Chat 单独确认 prepare 与只读表：

```sh
"$HP_BUILD/tools/clock-client" "$HP_DATA" prepare-ax
"$HP_BUILD/tools/clock-client" "$HP_DATA" read-ax
```

prepare=false 就保留拒绝和原始 native/header 信息停止，不猜坐标。prepare=true 后用已有 helper 读取真实 AX，确认 hpdiag-ax token 实际出现、恰一次且 native valid；missing/merged/duplicate 保持阻断，不通过 AX 树补救。准备/标记不会证明 source adoption。

driver 使用仓库当前脚本，自己执行新的显式 prepare 和 read-AX-read；必须使用新的输出目录：

```sh
python3 packages/nsh/tests/history-production-uikit/native-diagnostic.py \
  --config "$HP_CONFIG" --output "$HP_NEW_OUTPUT" \
  --modes pagination --max-navigation 12 --pan-distance 0.5 \
  --execute-main-only
```

`*-prepare-ax.json`、前后 `*-read-ax-*.json`、原 AX/capture、`*-v3-evidence.json`、候选排除表和 pre-touch read 都需保留。首次主验只回答真实 token 传播、准入是否可达及首个 older 事件；实际采样超过5ms、连续 gap、AX 丢失或 native生命周期变化仍可使尝试 inconclusive。最终严格验收和真实 −53pt回归仍未完成。

## 本次冻结记录

最终5个 focused Vitest 文件共10项通过，包含34条 Swift 纯策略/生命周期断言、51项 Python 回归。真实 iOS Simulator26.5 SDK / arm64-apple-ios15.0-simulator 上，当前 builder 的完整 Swift 输入集 typecheck 成功（含 main 新增两个 NativeInputMetadata 输入）；Observer、ClockClient、UIKit probe 的 object compile 成功，未执行它们。最后追加 prepare assignment 时序保护后，三份 Python 回归入口再次通过。Python AST 与 builder 的 node --check 均通过。

`bun run dead-code` 已完成并审阅，无 history-production-uikit 条目；全仓仍有其他 unused/duplicate 报告及 packages/nsh 72个 unused files 配置提示。只读哈希核对确认旧 cec5b612 App双hash、tools源/二进制、冻结native源与当前 strict smoke/moving/stationary 源均保持一致。本轮未改 SyntheticHost、NativeInputMetadata源、旧 a3、旧 v2 hash 文档或任何旧 artifact。

以下仅是本轮新源码冻结值，不替换旧记录：

| 文件 | SHA256 |
| --- | --- |
| Observer.swift | `efec3a9fee7f436c4ebeb78fe03e35a8e5af28c875ee83c10015b323bdfcc62d` |
| ClockClient.swift | `5ab457bcdc927737fccdbb6a421ebfb98ba374ca95b75452a928a0035abe998a` |
| build.mjs（含 main 两个新增输入） | `36cbcedf68126a2bdb77d24786ef84fc42dd011d31043539d53ef42d322ca760` |
| native-diagnostic.py | `774119b9bb0309f5fb500f20ee206b363de8c90e6db995e3501b11e62146f582` |
| native_diagnostic_v3.py | `5d2893d2d6b1123d78486d0aee6af29356c07acf3fc3d75c84b45c1cdd4ace76` |
| observer.test.ts | `eb1b3983272c2dd5f95f60c9a87c36516ead20ff18d85993427d2345d36efe6c` |
| native_diagnostic_v3_test.py | `e5f9432c0163e69999bf5aeea4009a2e3dd3fec5874beb0b5c0be482e995e3ce` |
| native-diagnostic-v3.test.ts | `60eda0d3ba06f3322de4c15a794cd9d13a5aefe41f59be96bc948bd2992a6bef` |

冻结范围是实现、纯测及编译证据。真实 helper 是否传播 token、实际绑定数量、是否触发 bounded refusal、设备读窗成本及 older 分页仍待 main 在新包独占验证；未签原53pt修复或 strict PASS。
