# 独立 UIKit 只读读回 fixture

目标是取得真实配对 `UITextView.spellCheckingType` / `markedTextRange` 读回，先证实 `.yes` 配置，再由 main 继续验真实错拼标记和中文 IME。a881 上硬件输入出现系统 autocorrect 不是 spellcheck 证明。本 fixture 的 SDK 编译、纯状态测试也不是设备读回或效果验收。

## 独立性与读取合同

- 只新增本目录 fixture/diagnostic/build 和聚焦测试，不修改生产 main、任何 frozen AX/trait setter、旧 history Observer、history build 或它们的 SDK 编译输入。
- 每次构建生成新 `example.nsh.composer-probe.<runID>`、独立 URL scheme 和 `.nsh/composer-spellcheck-probe/<runID>`；不自动 install/launch/boot，不触碰 Simulator 设置。诊断默认 off，只有明确 `--diagnostics` 的新 App 才安装 diagnostic component。
- fixture 使用真实 `NshAppView` + `nsh/base Input multiline` + 原 `NativeInputMetadataOwner` / `NativeComposerSpellcheck` install 和原两个 TS helper；Glass 直接复用生产 `nativeComposerSurface`。这是独立真实 NSH Input 载体，不是 a881 已安装生产 Chat 的原对象，也不是完整 Chat/Host 场景的替代验收。
- diagnostic registration 只用生产公开 `NativeComposerSpellcheckTree<UIView>.resolve` 做同一精确两级 paired-local lookup。冻结 AX 的 `NativeInputMetadataBinding.resolve` 是 private，未为诊断改变其可见性或复制其 active 规则。
- 只读取公开 trait enum/rawValue、`markedTextRange != nil`、window 附着和 `isFirstResponder`。不读或记录正文、长度、选区、AX label、credentials、路径、对象地址。不写 trait/editor/text/selection/delegate/firstResponder/keyboard/style，不做全 window 或子树扫描。
- exact editor begin/change/end 通知在 main queue 接收，先核对弱 editor 身份和完整生产 resolver，再记录一次；下一次 main-queue 检查相同 generation/对象仍有效才记录 `afterNotification`。没有 timer/poll/强持有 editor。记录不导出正文。诊断会影响测试时序，不能用它测无观测开销的输入性能。
- 内存最多保留 128 个 metadata sample；显式 readback、真实进入后台和恢复前台才导出 `Documents/composer-readback.json`。不逐字符写文件、不写日志。导出失败不会产生成功证明；空 samples 或 `paired=false` 都是未取得证据。

## 构建：main 独占运行

从仓库根执行，使用已有 NSH distribution，不安装依赖：

```sh
# SDK 对象编译：不启动 App/engine/设备；不调用 NSH compiler。
NSH_DIST=/existing/nsh node packages/nsh/tests/native-composer-spellcheck/build-probe.mjs --sdk-only

# main 执行：构建新的 simulator App，并显式开启 readback。
NSH_DIST=/existing/nsh node packages/nsh/tests/native-composer-spellcheck/build-probe.mjs --diagnostics

# main 若要回到 a881：独立 device unsigned App，之后自行按新 bundle ID 做开发签名。
NSH_DIST=/existing/nsh node packages/nsh/tests/native-composer-spellcheck/build-probe.mjs --device --diagnostics
```

脚本 stdout 为 JSON：`artifact`、`manifest`、`identifier`、`scheme` 和 `diagnosticsEnabled`。SDK-only artifact 是 `.o`，不能安装为 App。完整构建才运行 NSH **compiler** 并链接 App，脚本本身不执行 App。所有 Swift/TS 输入复制到独立 source pack，manifest 记录相对路径与 SHA-256，构建结束再次检查原输入未改变。NativeShell 如为动态 framework 则单独嵌入并设置 rpath；simulator ad-hoc 签名，device 明确保持 unsigned。

device 如需已注册的新测试 App ID，可显式设置 `COMPOSER_PROBE_BUNDLE_ID`；必须是**全新 fixture 身份**，禁止复用生产、旧 history 或其它现有 App。脚本拒绝两个正式产品 ID。签名/Provisioning/安装均由 main 完成，不修改本机证书、profile 或既有 App。唯一 URL scheme 始终按本次 runID 生成，避免旧 App 抢收命令。`--json`/`--quiet` 都保留同一 JSON 输出及校验，无交互提示。

## 第一步：main 获取真正的 `.yes` 读回

以下命令只供 main 执行。`PROBE_APP`、`PROBE_ID`、`PROBE_SCHEME` 从本次构建 stdout/manifest 读取；`PROBE_UDID` 由 main 指定，不自动选择/启动设备。

```sh
xcrun simctl install "$PROBE_UDID" "$PROBE_APP"
xcrun simctl launch "$PROBE_UDID" "$PROBE_ID"

# 等界面实际出现后，明确请求当前 paired editor 读回；本命令不设置 focus/text/traits。
xcrun simctl openurl "$PROBE_UDID" "$PROBE_SCHEME://readback/readback"
PROBE_DATA=$(xcrun simctl get_app_container "$PROBE_UDID" "$PROBE_ID" data)
cat "$PROBE_DATA/Documents/composer-readback.json"
```

URL 打开可能使 App 回到前台，所以真实 background sample 由 `applicationDidEnterBackground` 自动读取/导出，不能用 `openurl` 冒充后台观测。设备读取使用 main 已有的 App container 下载方式获取同名文件；本任务没有启动设备，也没有声称已下载/读取 a881 的实际结果。

**首份配置证据至少要求**：manifest 的 `diagnosticsEnabled=true`；report.buildRunID 与本次 manifest.runID 相同；最新手动 sample 的 `paired=true`，`facts.attached=true`，`facts.spellCheckingName="yes"`（rawValue 来自真实 UIKit 枚举，不能用 autocorrect 推断）。未达到这些条件，先排查未安装、factory 未注册、尚未配对或 native bundle 错误，不能继续把拼写效果标为已支持。

原 77d5 report 是 schema 1 的 `{schema, processRunID, buildRunID, samples}`；ACK 修复后的新 App 使用 schema 2，另有 `control`，包含 native handler 次数、真实 adopted/JS-confirmed revision、固定错误码和有上限的计数。`editorToken` 是弱对象身份的进程内单调编号，不是 AX ID 或地址；仅同一 `processRunID` 内可比较。进程重启后即使 token 相同也不能当同一个 editor。`composerGeneration` 是**fixture Input mount generation（当前 1）**，不冒充不可见的生产 trait coordinator 内部 generation。full resolve 失败时 `paired=false` 且 facts/token 缺省，不拿缓存填成成功。

## 生命周期与真实输入流程

1. **未 focus 空输入**：执行 readback/readback，保存独立副本。
2. **focus → 输入**：main 正常点击原 Input，使用系统键盘实际输入；分别调用 `readback/focused`、`readback/typed`。比较同一 processRunID/composerGeneration/editorToken，读取真实 firstResponder/markedTextPresent/trait；诊断从不代点或设置 first responder。
3. **背景 → 恢复**：main 正常按 Home 后读取自动导出的 background sample，再恢复 App 并 readback。foreground/background 字段来自真实系统回调和 applicationState，不接受同名 URL 伪造事件。
4. **合成 Host revision**：main 调用 `"$PROBE_SCHEME://host-change"`，只递增测试 revision 并给 fixture JS 一个事件；JS 修改编辑器外的 revision 标签并 ACK。再调用 readback/readback，要求 requestedHostRevision==adoptedHostRevision，且原 editorToken/mount generation 不变、trait 仍 yes。这不连接真实 Host，也不证明完整生产 Host 切换。
5. **实际 blur**：正常点离输入，再 readback/blurred。不提供强制 resign/selection 控制。
6. **配置读回通过后**，main 才继续实际错拼标记和中文软件键盘 IME：用真实键盘进入未提交拼音/候选阶段，读取 `readback/ime` 并保存 JSON；提交候选后再读取。native editingBegin/Change/End 与 afterNotification samples 用于复核真实 marked-text 生命周期，不接受 `setMarkedText`、直接设置 marked range、粘贴汉字或硬件 ASCII 回放冒充真实中文 IME。

导出文件每次原子覆盖，buffer 只留最近 128 项。请 main 在关键阶段复制为独立证据文件，尤其在 IME composition 时与提交后立即保存；不能因 buffer 已滚出 marked=true 就推断从未发生。手动 URL 仅允许 readback/focused/typed/blurred/ime 五个标签；native notification/lifecycle 标签不能通过 URL 伪造。

## serve-sim 静态调查与 main 实际操作

最初只读调查中，工作区 `packages/mobile/node_modules/serve-sim/package.json` 解析到 **0.1.43**；这不等同于 main 当前正在运行的 helper。main 后续已核实其实际 helper 为 **0.1.49**，并用已核验的 `0x0c` helper 事件显示真实软件键盘。此为 helper 接口操作，**不是公开 CLI 子命令**，也不是对 editor 的 marked range 注入。公开 CLI 的 `tap`、`type`、`button home`、preview/record、AX 接口与内部 helper 路径保持区分；`type` 的 **US keyboard only** 限制不能充当真实中文候选/marked-text 证据。

main 可使用已有包，无需下载/升级：

```sh
node packages/mobile/node_modules/serve-sim/dist/serve-sim.js --detach -q "$PROBE_UDID"
node packages/mobile/node_modules/serve-sim/dist/serve-sim.js tap 0.5 0.6 -d "$PROBE_UDID"
node packages/mobile/node_modules/serve-sim/dist/serve-sim.js type 'mispelled' -d "$PROBE_UDID"
```

tap 坐标只是命令语法示例，main 必须根据该次截图/AX 定位，不能照抄坐标。未把 software-keyboard helper 事件描述为公开稳定 CLI；本 agent 未执行该 helper、设备控制或 Simulator 设置操作。

Simulator.app 公开 **I/O → Keyboard → Toggle Software Keyboard（⌘K）** 是可选的正常 UI 路径；本次 main 的 osascript 读菜单在 10 秒超时，没有通过它取得键盘 UI。本次实际路径是上述 0.1.49 helper 显示软件键盘，再通过 Globe 菜单选择**既有**简体拼音（菜单另有 Emoji/English），未安装或修改输入法。没有修改 ConnectHardwareKeyboard、Simulator defaults、系统语言的脚本。原 English 键盘由 main 恢复中，目前不记录为已恢复。硬件 `serve-sim type`、粘贴或 fake marked range 均不能代替真实逐键触摸/候选选择。

## main 已取得的 77d5 实际证据

证据目录：[.scratch/nsh/composer-probe-77d5545d8b1443a2](../../../../.scratch/nsh/composer-probe-77d5545d8b1443a2/)。buildRunID=`77d5545d8b1443a2`，processRunID=`3B02337A-B69A-4870-B776-61460345A8CA`。

- [manual-readback.json](../../../../.scratch/nsh/composer-probe-77d5545d8b1443a2/manual-readback.json) 与 [typed-background.json](../../../../.scratch/nsh/composer-probe-77d5545d8b1443a2/typed-background.json)：main 明确允许了 iOS Open 确认后完成实际手动读回；editingBegin/Change/afterNotification/background/foreground 均为同一 editorToken=1、composerGeneration=1、paired=true、`.yes/raw 2`。首次手动 URL 曾被确认弹窗拦住，不将那次请求当作成功。
- 软件键盘与语言菜单：[software-keyboard.png](../../../../.scratch/nsh/composer-probe-77d5545d8b1443a2/software-keyboard.png)、[pinyin-keyboard.png](../../../../.scratch/nsh/composer-probe-77d5545d8b1443a2/pinyin-keyboard.png)。
- main 实际触摸 n/i 键，[pinyin-composing.png](../../../../.scratch/nsh/composer-probe-77d5545d8b1443a2/pinyin-composing.png) 显示带下划线的 ni 与候选“你”；实际触摸候选“你”后取得 [pinyin-committed.png](../../../../.scratch/nsh/composer-probe-77d5545d8b1443a2/pinyin-committed.png)。没有 paste/setMarkedText/硬件 ASCII 冒充这次 IME；硬件输入只用于事前清除旧文本。
- [pinyin-notifications.json](../../../../.scratch/nsh/composer-probe-77d5545d8b1443a2/pinyin-notifications.json) 与 [pinyin-proof.json](../../../../.scratch/nsh/composer-probe-77d5545d8b1443a2/pinyin-proof.json)：samples 27–31 的 markedTextPresent=true，32–35 提交/后台后为 false；九项均 paired=true、editorToken=1、gen=1、`.yes/raw 2`。本 agent 已按原始 metadata JSON 核对这些序号与字段。
- [host-revision-ax.json](../../../../.scratch/nsh/composer-probe-77d5545d8b1443a2/host-revision-ax.json) 显示视觉 revision=1；[host-change-background.json](../../../../.scratch/nsh/composer-probe-77d5545d8b1443a2/host-change-background.json) 及后续样本仍为 requestedHostRevision=1 / adoptedHostRevision=0。**77d5 的 Host ACK 未闭环**，不能由视觉更新或上述 IME 证据推定闭环。

可以记录“独立真实 NSH Input 载体的 `.yes` focus/background 与此次真实简体拼音 composition→commit 场景已取证”。**红色 spell marker 仍未验；完整 production Chat、latency/performance、history、所有键盘/所有 IME 均未验**，不扩大验收范围。

## ACK 修复、新 App 与精确路由

实际红/绿回归复现了 77d5 的症状：视觉 revision=1，但 handler 次数=0，NSH 报 `ERR_ACCESS_DENIED`。原构建直接编译嵌套 fixture，没有载入带 grant 的 app config，77d5 缺少 `nsh/capabilities.json`。现在 source pack 写入独立 `App.tsx + nsh.json` 并以该 App 为编译入口。注意 SDK 的 `app.json` 本来只含 id，capability 必须检查独立的 `capabilities.json`；构建会核对两者，且只放行 `fixture.composer.hostAdopted`，其它能力全部关闭。

NSH Source `NativeShell.swift:580–595` 明确：`surface.handle` 按完整名称精确匹配，raw data 经 JSONSerialization 原样解码为 Foundation 对象，不包 `args/body`。新 parser 只接受单字段 `{revision:正整数}`，拒绝布尔、fraction、string/wrapper/extra keys 及非当前 requested revision。adopted 只在实际 handler 进入并通过该 parser 后推进；JS 必须验证 native 回复 `{accepted:true,revision:同一值}`，然后通过独立诊断 prop 回执，才能推进 jsConfirmed。视觉值、requested 或 JS accepted 状态均不能代填 native adopted。

错误不再永久吞掉：schema 2 的 control 记录固定错误码/有上限计数、nativeHandlerCalls/rejectedHandlerCalls、lastRawInputKind 和 jsPhase；JS catch 仅映射 SDK error.code，不保存 message/正文/credentials，native runtime/load/export 错误也只记录固定码。每种固定码最多输出一条 metadata 日志，状态更新不改变 Input 所在 JSX/mount。

已构建但**未安装或运行**的新 simulator App：[6ff3363efbae4311 manifest](../../.nsh/composer-spellcheck-probe/6ff3363efbae4311/manifest.json)，同目录 `ComposerProbe.app` 已完成 NSH 编译、真实 SDK 链接和 simulator ad-hoc 签名，且编译产物中的 id/capabilities sidecar 已核对。

```text
identifier: example.nsh.composer-probe.6ff3363efbae4311
scheme: nsh-composer-probe-6ff3363efbae4311
Host change URL: nsh-composer-probe-6ff3363efbae4311://host-change
Readback URL: nsh-composer-probe-6ff3363efbae4311://readback/readback
其他手动标签: /readback/focused、/readback/typed、/readback/blurred、/readback/ime
```

由 main 安装新 App、明确允许可能出现的 iOS Open 确认，再请求 host-change。等待新 fixture 的 `probe-host-ack` 显示 `ACK accepted revision:1 code:none` 后再 readback，核对 control 中 requested=adopted=jsConfirmed=1、nativeHandlerCalls=1、rejectedHandlerCalls=0、lastRawInputKind=object、errors={}，并核对同 process/editorToken/gen 及 paired/yes。`hostAcknowledged` 是 native 接受 payload 的 sample，`hostChanged` 是 JS 验证 native 回复后的 sample；这两类不可用手动 URL 伪造。**新 App 的设备 ACK 证据仍待 main 提供**，不把 headless 通过冒充实际设备闭环。

## 本任务验证边界

### main 的 6ff 实际 UIKit ACK 证据

新 App `6ff3363efbae4311` 已由 main 安装并启动，明确允许其 iOS Open 提示后，AX 显示 `ACK accepted revision:1 code:none`。实际手动 readback 的 `control` 中 requested/adopted/jsConfirmed 均为 1，nativeHandlerCalls=1、rejectedHandlerCalls=0、lastRawInputKind=object、errors={}；同一进程全部 paired 样本保持 editorToken=1、composerGeneration=1，最新 readback 为 attached=true、spellCheckingName=yes、rawValue=2。证据为 `.scratch/nsh/composer-probe-6ff3363efbae4311/host-ack-ax.json` 和 `readback.json`。这关闭独立输入探针的合成 Host ACK 场景，不证明完整生产 Chat 的 Host 恢复、IME、历史或性能。

77d5 的原 English (US) 键盘与初始隐藏软件键盘状态已经由 main 恢复，证据为 `.scratch/nsh/composer-probe-77d5545d8b1443a2/restoration.json` 及 `restore-keyboard-menu.json`；未安装输入法或写系统 defaults。上文“待安装／待恢复”描述保留为先前阶段记录，以本段实际运行结果为准。

SDK compile + ledger tests 仅证明可编译和诊断状态/隐私合同；main 的 77d5 真实读回与 IME 证据范围如上。main 独占设备，本 agent 未运行 UIKit App/Simulator、实际 Host、serve-sim 控制或模型；仅在后续明确授权下运行独立 synthetic probe 的 headless ACK 测试，并构建新的未安装 App。红色拼写标记与新 App 的设备 ACK 仍待 main 取得，验收标准保持上述顺序。

2026-11-08 早期 SDK-only 阶段历史记录：`native-composer-probe.test.ts` 4/4 通过，其中 7 组生产诊断 ledger 的纯 Swift 检查、只读边界/默认关闭/新身份合同、以及**完整独立 probe 的真实 UIKit/NativeShell SDK whole-module 对象编译**。fixture 专用 `probe-tsconfig.json` 的 `tsc --noEmit` 与 build-probe.mjs 的 `node --check` 通过。SDK 26.5 / arm64-apple-ios15.0-simulator 的该阶段源包和对象位于 [.nsh/composer-spellcheck-probe/b75d6e0050bd4e79](../../.nsh/composer-spellcheck-probe/b75d6e0050bd4e79/manifest.json)，manifest 明确 sdkOnly=true / diagnosticsEnabled=false；这不是可运行 App 或实际 readback。该阶段 dead-code 已运行并检查（132 unused files、797 unused exports、6 组 duplicates），未命中新 probe 文件；未清理无关报告项。该阶段没有执行完整 NSH compiler/App build 或任何设备操作。

ACK 修复后新增验证：两份聚焦 Vitest **8/8 通过**；包含 11 组 Swift ledger/control 检查、真实 SDK 对象编译、实际 headless synthetic probe 的成功 ACK/denied grant/wrong reply/native reject 四个场景。成功分支连续两个 revision 均真正进入 handler、校验回复并保留原 draft；失败分支只显示固定错误码，无 unhandled rejection。fixture tsc 通过；上述 6ff 新 App 完整构建成功但未安装。headless 不证明 UIKit 对象身份，设备同对象仍需 main 对照 token/gen；没有性能结论。
