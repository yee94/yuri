# 未替换生产 App/Chat 的 UIKit 历史载体

当前进展见 [control-read-sharing-v1](CONTROL-READ-SHARING-RESULTS.md)：main的92aa实际14帧baseline均≤5ms，但十个identifier即时getter均nil、两个带binding control读窗约225/229ms，两个新红灯均保留。已核对真实SDK的test_id-backed getter，当前公开native写入端口缺失；[SDK owner最小端口合同](SDK-IDENTIFIER-PORT.md)列明边界。control已改为仅同轮共享coverage原始事实，完整binding geometry/审计和5ms总wall（含freeze）保留。完整优化链接单独600000ms，其它工具240000ms，超时只清理本次exact PID子树。

该revision已一次构建 [f37195ff独立可安装包及exact hash](CONTROL-READ-F37195FF-ARTIFACT.md)，完整优化链接171.203s、签名/冻结核验通过，未运行；这是十binding control复验包，身份写入口仍未完成，不能称identity已修复。

最新独立诊断见 [native-freeze-v1 / 92aa2cd2](NATIVE-FREEZE-RESULTS.md)：已用实际window构造类型的离线消融定位首次协议一致性查询CPU开销，实现精确native容器无损转换，新增可选thread CPU阶段并完成新包构建。db06一次实际首帧18.275ms与旧5e595357的5.777ms均保留原失败，仍需main在新包严格唯一prepare→read→AX→read；SDK adopt unknown、原−53红、自动pan暂停。

前轮独立诊断为 [scroll-insets-v1与首帧成本记录](SCROLL-INSETS-RESULTS.md)，变更前性能指纹见 [baseline](SCROLL-INSETS-BASELINE.md)，对应旧包main操作见 [SCROLL-INSETS-MAIN.md](SCROLL-INSETS-MAIN.md)。实际5e595357一次短程因首帧5.777ms被原5ms护栏正确拒绝，SDK linked路径已实际起效但身份未过；该revision同轮采集两组public scroll inset并提供默认off的阶段计时，不借旧压力签新frame，原−53pt/SDK adopt unknown及自动pan暂停保留。

当前先看 [P1-P2-989-FINDINGS.md](P1-P2-989-FINDINGS.md)：pre-pan/pre-mark的当前保护范围及≤5ms control读窗已收紧，旧989合同禁止自动输入；token getter立即读回仍待main单次验证。后续上层sibling越界子树修正独立冻结在 [COVERAGE-SUBTREE-FREEZE.md](COVERAGE-SUBTREE-FREEZE.md)。main已在独立b1fe65f6 Debug-assert UIKit载体实际跑通siblingOverflow/snapshotRejects/typedGeometryParity三个原函数；该pass不覆盖Observer/writer/Host/pan或token实际读回。

长时Observer已证实整包flush/OOM，原方案与成本基线保留在 [LOSSLESS-EXPORT-V4-DESIGN.md](LOSSLESS-EXPORT-V4-DESIGN.md)。现已另实现显式 [v4分段管线与独立stream reader](v4/README.md)，纯值压力和完整SDK链接已通过；最终SHA、8/16/32成本、32帧高RSS限制和main接手边界见 [V4-EXPORT-RESULTS.md](V4-EXPORT-RESULTS.md)。v3默认仍有旧整包风险，不能用于长时UI。v4真实读窗/RSS/flush须main在独立新包验收，自动pan继续暂停，原−53pt问题没有关闭。

本轮另有 [identity-only短程协议](v4/IDENTITY-ONLY.md) 和已构建的 [5e595357可安装产物及exact hash](IDENTITY-5E595357-ARTIFACT.md)：默认不注册display-link，只有一次显式prepare触发有限真实基线，然后只做read→AX→read，不开放mark/pan。main授权worker本轮运行NSH **build编译**和完整SDK链接生成独立Simulator App；没有运行engine、设备或Host。它不覆盖下文历史轮次“未运行compiler”的记录，也不把编译写成built Observer实际验证通过。

当前 v3 合成 AX-ID instrumentation 见 [AX-ID-V3-CONTRACT.md](AX-ID-V3-CONTRACT.md)：只有显式 prepare-ax 写正文 accessibilityIdentifier，driver 必须核验真实 AX token 与 native weak binding；不再称完全 readonly。保留 main 的 Composer NativeInputMetadata 两个构建输入，二者目标与前缀隔离；旧 artifact、v2 冻结文档及 strict 工具不改。

独立 window/header Observer 的最新增量合同、SDK 编译边界、新包命令和冻结 driver 接线 seam 见 [OBSERVER-WINDOW-CONTRACT.md](OBSERVER-WINDOW-CONTRACT.md)。新 builder 使用 pan-read-v2；旧 artifact 不改，driver 需主会话单独接线，partialtext AX 身份仍未绑定。本说明后续历史验证不覆盖该新 observer 的真实设备运行。

最新主验反馈：main已实际安装启动冻结normal `1bb480cd`，完整production root→Chat、fresh nonce clock及startupSweeps=1/rejected=0/mutations=0成立。探索录制因闲置超过5分钟触及18000样本并overflow，仍为invalid。新增限时主验入口及独立moving红灯工具见 [SMOKE.md](SMOKE.md)：只在下一独立artifact提供pan/processNonce字段；旧artifact与原stationary checker不改。本节以下保留首次交付的worker阶段说明，设备执行结果以上述main反馈为准。

**原生产录像53pt仍红，默认实验OFF。此载体的数据是全新中性合成数据，不是原53pt会话的匿名回放；即使全部窗口通过，也不能关闭原生产问题。** worker仅做纯测试、Bun静态源图staging、Swift/TS静态校验和离线工具编译；未运行NSH compiler/engine、安装/启动设备、连接真实Host、执行Git或调用模型。真实UIKit与独立review由main后续执行。

## 实际被测对象和源图

入口仍为原 `packages/nsh/App.tsx → NativeStartup → YuriNativeApp → Chat`，生产List/controller/presentation/state/正文/Activity/metadata/分页按钮不替换。生产startup授权cache-gate也不绕过：注册真实 `AuthorizationCacheCleanupBridge` 五个严格handler，以空pending运行；native afterSweep前连connection.list也拒绝。`retireHistoryAuthorization`仍来自生产singleton，空pending不伪造任何retirement身份。voice/passkey只读目录仅在原页面真正进入时按需调用，不在fixture启动预拉。`stage-native-application.mjs` 逐字节stage完整App依赖闭包及已安装依赖；原生外观、Sheet、DatePicker、ChatHeaderCollapse和Picker owner同样复制并hash。唯一个外加JS模块是无UI的clock sidecar：没有mount、state写入、timer、measure或scroll动作。

构建脚本只操作新 `.nsh/history-production-uikit/<独立build>/`，冻结JS/Swift/工具源、依赖逐文件哈希和原字体校验和，编译只消费stage文件。原 production main/SDK/distribution 不修改。默认App/Chat逐字节不变；`--experiment-on` 只在**新artifact的stage**把唯一 `const footerExperiment = signal(false)` 改为true，manifest记录前后SHA和这个单点变更。比较OFF/ON前必须比对全部production源/依赖hash（仅此seam可不同）；其他漂移则不得作因果A/B。

```sh
# main执行完整构建：只编译/签名，不安装或启动。
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/scripts/build-history-production-uikit.mjs --scenario terminal
# 其余独立artifact：--scenario normal / partial / growth；ON必须显式追加 --experiment-on。
# worker可用的静态路径（不运行NSH）：
node packages/nsh/scripts/build-history-production-uikit.mjs --stage-only --scenario terminal
```

完整构建产物为 `manifest.json`、`HistoryProductionUIKit.app`、`stage/`、`native/`、`tools/`。`tools/clock-client` 与 `tools/pixel-measure` 是macOS离线/文件握手工具，不加载NSH或连接Host。manifest含独立bundleID、App bytecode/executable双hash、SDK公开接口hash、完整依赖hash、能力、scenario和 `production53ptVerdict=unresolved`。`--stage-only` 没有App，不能安装；`--bundle-only` 没有Swift App，不能拿作原生验收。

## 内存Host及500条生产wire

### ui-parity固定密度50/100/105/200（当前冻结）

`HISTORY_SYNTHETIC_DENSITY`仅接受精确字符串 `50`、`100`、`105`、`200`，并且必须显式搭配 `HISTORY_SYNTHETIC_RUN_MODE=ui-parity`。未设置时种子完全保持原样，normal与其它scenario均不额外增加padding字段，生产消费者继续采用缺省100。空串、范围外值、050、+50、50.0、前后空格、换行、null文本或JSON均以 `history_fixture_density_profile` 拒绝；合法密度若用于缺省history-diagnostic则以 `history_fixture_density_requires_ui_parity` 拒绝，避免混入历史采样阈值比较。不解析任意JSON环境配置。

密度profile只给GET `/api/config/settings`增加数值类型padding；不修改fontSize、theme、消息、500条历史、Changes/Bots/计划数据、grants、scope或业务PUT门禁。reference-105仍只提供原固定字体105等白名单，不因为density=200就改fontSize。完整优先级是 **原seed → reference appearance白名单 → density仅padding → 显式diffLayout仅diffLayoutPreference**。同一进程反复GET返回同一固定结果，不是随GET次数轮换或在线更新。

启用时snapshot及ui-parity audit的 `activeProfiles`额外记录 `density:50|100|105|200`，只含白名单数值；未启用则不增加此键，保留既有精确审计形状。每次读取增加 `synthetic-density-read` 元数据，仍遵守ui-parity的128项/32KiB journal及64KiB文件边界，不另起writer/timer。主会话以background audit核对有效profile、settings读取及rejected=0/mutations=0/network=false；非法schema及业务PUT负测单独保存，不混入正面窗口。

main在新独立artifact、系统dark下，**分别冷启动并保存各自AX/截图/background audit后再进入下一档**。以下明确设置全部profile，避免继承残留布局值（命令由main执行，worker未运行设备）：

```sh
SIMCTL_CHILD_HISTORY_SYNTHETIC_RUN_MODE=ui-parity SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE=reference-105 SIMCTL_CHILD_HISTORY_SYNTHETIC_DENSITY=50 SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT=dynamic \
  xcrun simctl launch --terminate-running-process "$HP_UDID" "$HP_BUNDLE_ID"

SIMCTL_CHILD_HISTORY_SYNTHETIC_RUN_MODE=ui-parity SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE=reference-105 SIMCTL_CHILD_HISTORY_SYNTHETIC_DENSITY=100 SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT=dynamic \
  xcrun simctl launch --terminate-running-process "$HP_UDID" "$HP_BUNDLE_ID"

SIMCTL_CHILD_HISTORY_SYNTHETIC_RUN_MODE=ui-parity SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE=reference-105 SIMCTL_CHILD_HISTORY_SYNTHETIC_DENSITY=105 SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT=dynamic \
  xcrun simctl launch --terminate-running-process "$HP_UDID" "$HP_BUNDLE_ID"

SIMCTL_CHILD_HISTORY_SYNTHETIC_RUN_MODE=ui-parity SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE=reference-105 SIMCTL_CHILD_HISTORY_SYNTHETIC_DENSITY=200 SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT=dynamic \
  xcrun simctl launch --terminate-running-process "$HP_UDID" "$HP_BUNDLE_ID"
```

真实跨边界纯合同为Foundation GET settings → `appearanceFromSettings` → `nativeLayoutDensity/projectHomeDensityGeometry`，覆盖四scenario四档密度、重复读取、200数值回读、字号105独立、缺省无padding、明确split与density组合、非法环境/diagnostic使用拒绝，以及settings PUT/GET body/query拒绝。几何断言使用生产sqrt(padding/100)投影，检查Settings卡片、Select、Sheet、输入区与项目卡片及独立字号/固定半径/最小触区，不跑UIKit/engine。

该固定启动profile不代表live热更新、真实Host保存、全部density消费者或UIKit几何验收通过。main另验长语言、窄屏、Sheet/Select、输入与软键盘及实际手势；−53pt/三body/视频标准不由此模式替代。仅修改SyntheticHost.swift、host.test.ts与本README，不动生产/Observer/build/main或旧artifact。

冻结验证：focused Host29项通过，加build/grants与sidecar三文件共32项全部通过；SyntheticHost.swift真实iOS Simulator SDK / arm64-apple-ios15.0-simulator typecheck通过，检查前后Host hash一致。未运行设备、engine、真实Host、Git、依赖安装或模型。

### 固定 synthetic transportID（当前冻结）

连接快照现对唯一 `https://synthetic.invalid` 合成直连记录补充固定公开opaque UUID `transportID=cd9d3a81-277a-4e69-958a-cf789c8b46e3`。它仅是这个测试fixture的稳定分区ID，不含origin、凭据或tuple编码，不从hostID/authorizationID/lease派生，不执行或仿造生产ConnectionStore的transport tuple authority，不新增环境变量或任意覆盖入口。四个scenario与默认/ui-parity共用此测试连接定义；各独立artifact仍拥有各自App sandbox。

核对最新生产 `runtime.connectionSnapshotFrom`：transportID仍是可选字段，缺省快照可解析但不会获得品牌分区入口；提供时必须为1–128个ASCII字母、数字、下划线或连字符。fixture使用合法UUID满足当前公开合同，不降低parser，也不让TS在缺值时按URL猜ID。hostID、原authorizationID=`history-synthetic-only`、direct origin与runtimeScope的hostID/lease均保持原样；transportID只属于connections条目，往expectedHost里添加它仍会被严格scope gate拒绝。

新纯合同从Foundation Swift实际connection.list JSON开始，经过真实runtime.connections/connectionSnapshotFrom，再执行生产state.adoptConnections函数，确认app.connection保留UUID且app.runtimeScope仍是原两字段。随后使用真实local-compatibility-preferences-core及内存Storage adapter验证：默认品牌读取、显式本地保存与重开回读仅命中 `sidebar-brand-transport-v1.<UUID>` 分区，不调用Host业务写，审计mutations=0/network=false。覆盖4个scenario、重复connection.list稳定、legacy缺值仍可解析、非法transportID仍拒绝、scope夹带transportID仍拒绝。该pure signal/Storage边界不等于设备UI编辑或持久化已验。

main统一新包后走Settings → Appearance → 品牌字段，验证不再因fixture缺transportID出现scope-required，编辑/本地保存/返回重开及background审计需实际复验；不需要也不允许真实Host settings PUT。此前Appearance根reader恢复修复仍归生产owner，本字段不能替代scope/生命周期修复。只修改SyntheticHost.swift、host.test.ts、本README，未触碰生产Prefs/ConnectionStore/Observer/build/main或旧artifact。

冻结验证：focused Host27项通过，加build/grants与sidecar三文件共30项全部通过；SyntheticHost.swift的真实iOS Simulator SDK / arm64-apple-ios15.0-simulator typecheck通过，检查前后Host源hash一致。未运行设备、engine、真实Host、Git、依赖安装或模型，不标UIKit品牌编辑完成。

### a881 Appearance 拒绝诊断：保留 scope gate（本轮）

主会话在 a88162b4 ui-parity 上已实际确认 background审计约27KB、首次Changes/input rejected=0/mutations=0；随后进入Appearance显示“重新加载配置失败”。只读证据为 `.scratch/nsh/uikit-a88162b4-appearance/{settled.json,ui-parity-audit.json}`。该audit累计rejected=4，128项近期journal中保留3条 runtime.request / history_fixture_arguments，两个后续拒绝约相隔30秒。由于旧拒绝记录没有请求形状，**不能声称旧4条的实际字段已从现场直接读取**。

核对冻结 `2026-11-07T21-09-49-451Z-a88162b4/manifest.json` 与stage字节hash后，runtime.ts、runtime-scope.ts、appearance.tsx、state.ts均匹配冻结manifest：runtime.request只有path/method、可选body和可选expectedHost；scope仍精确hostID/lease，没有新增headers、transportID或其它准入字段。因此本轮没有证据扩张任何GET输入schema，也没有允许缺scope的settings读取。

冻结源码存在可重放路径：state在退后台时保留connection但清空runtimeScope、增加epoch；Appearance根effect在此边界可重建sync并在untracked中captureHostRequest，捕获bindRequest(null)。同Host恢复时若scopeKey仍相同，则只rebind同步器，不替换其readSettings闭包；30秒refresh继续使用不含expectedHost的请求。通过冻结NativeAppearanceSync函数+真实runtime构造器、手工生命周期边界及同步器读取边界重放，观察到初始settings GET含expectedHost，恢复GET与30000ms回调GET均只有method/path。未运行真实响应式调度器或UIKit，这证明源码缺陷路径可复现，不冒充原现场每条拒绝的因果证据。

main/Prefs owner需核对appearance.tsx的reader捕获/恢复重绑与state.ts的scope生命周期。当前fixture继续拒绝无expectedHost、旧scope、附加scope字段或越权method；不把无scope读取自动补签成当前Host，也不将任意headers/method加入允许字段。Prefs生产文件、其transportID边界工作、Observer/build/main及a881旧artifact均未修改。

新增脱敏拒绝诊断在原 `rejected` 事件附加：静态白名单path、有限method枚举、knownKeys、missingRequiredKeys、unknownKeyCount、scopeKnownKeys、scopeUnknownKeyCount。path只保留本次排查涉及的固定settings/themes/catalog/agent/root目录等静态端点，query/hash全部去除，其它路径记 `<unlisted>`；未知method记 `<invalid>`。仅报告固定已知字段名及未知字段数量，不记录未知key名称、scope值、body、headers或凭据。示例：

```json
{
  "phase": "rejected",
  "name": "runtime.request",
  "code": "history_fixture_arguments",
  "path": "/api/config/settings",
  "method": "GET",
  "knownKeys": ["method", "path"],
  "missingRequiredKeys": ["expectedHost"],
  "unknownKeyCount": 0,
  "scopeKnownKeys": [],
  "scopeUnknownKeyCount": 0
}
```

本轮只改SyntheticHost.swift、host.test.ts与本README。focused Host26项、加build/sidecar共29项通过；新增测试执行真实runtime.bindRequest，证明合法绑定settings/themes GET成功、缺scope捕获不会因后来的合法绑定自动获得authority，并验证拒绝日志不含sentinel凭据/headers/未知key值。纯测不将生产生命周期问题判成已修。main须合并Prefs owner修复及新诊断后建立新独立包，再重新验证Appearance进入、后台恢复及30秒刷新，要求新background audit rejected=0/mutations=0；不得沿用a881此前Changes/input的零拒绝结果结项。

本轮SyntheticHost.swift的真实iOS Simulator SDK / arm64-apple-ios15.0-simulator typecheck通过；未运行engine、设备、真实Host、Git、依赖安装或模型。

### 显式 ui-parity 长时 UI 模式（当前冻结）

2026-11-08 主会话反馈：989dfdee 的历史 Observer 在约8分钟触及18000样本后自动主线程导出，capture约2.42GB、进程峰值约21.5GB，并伴随 clock/AX timeout。主会话已保存证据并停止旧进程；本 worker 不对其因果、原始样本或实际设备状态作额外签收。本节提供**仅用于完整 UI 长时操作**的独立启动模式，不替代 −53pt / 三 body / 连续视频 / 时钟与1.1pt等历史验收标准。

仅显式 `HISTORY_SYNTHETIC_RUN_MODE=ui-parity` 启用；缺省仍为 `history-diagnostic`，不改变其 Observer 创建/采样/导出合同。空串、显式 history-diagnostic、大小写变体、任意JSON、尾随换行均以 `history_fixture_run_mode` 拒绝。实现只改 fixture `main.swift`、`SyntheticHost.swift`、`host.test.ts`、本 README；保留 `NativeInputMetadataOwner.install` 和 `NativeComposerSpellcheck.install`，没有改 Observer/build/ClockClient/sidecar/生产TSX/旧artifact。

ui-parity 分支不构造 `HistoryProductionObserver`，不注册 CADisplayLink、采样 timer、frame collector 或 control.json 文件监听，也不设置 host.onRecord 转存事件。仍通过原 NativeStartup、空pending cache sweep、精确 grants、connection snapshot admission、expectedHost/lease与业务写拒绝进入真实生产 App；normal500源、Changes、2 Bots/2 Tasks及opaque游标不变。

原 sidecar 启动会调用 `history.qa.ready`。ui-parity 仅为现有已授予的 ready/clock/clockAck 注册模式专用 handler：精确空输入 ready 返回 `{available:false,runMode:"ui-parity",observerDisabled:true,strictAcceptance:false,historyDriverAdmission:false}`，不冒充诊断ready或时钟ACK；clock/clockAck明确拒绝，不发送 clock.request。mark/prepare-ax/read-ax/flush没有文件控制接收器，不可用；ClockClient不改、不得用于此模式。不存在新的 network、业务 GET/POST、native audit grant或wildcard。

**轻量审计**：启动时写一次，之后只在主会话用系统操作将 App 退后台、触发原 `applicationDidEnterBackground → flush` 时原子覆盖 `Documents/ui-parity/ui-parity-audit.json`。不是逐GET/tick写文件；无需新增命令或桥。每次导出包含 runMode/sourceSynthetic/observerDisabled/strictAcceptance=false/historyDriverAdmission=false、diagnosticsAvailable全false、Host snapshot、processNonce、bundleID/buildID、auditTrigger=startup|background 与本次 nativeUptimeMs。processNonce用于本次进程身份，nativeUptimeMs仅是审计时点，不是clock握手或geometry样本。startup文件通常尚未完成业务读取，主会话应在目标 UI 操作后显式退后台，再读取覆盖后的 background 文件。

该模式 Host journal 保留最新最多128项、合计最多32768字节，每项最多2048字节；超大条目替换为明确 omitted 元数据，丢弃旧项累计 journalDropped/journalSequence，journalOverflow明确为true。累计 rejected/mutations/network与当前profile独立保留。纯审计payload上限49152字节，main补入固定身份后文件上限65536字节，超限拒绝写入；不含frames、body source、截图或实际AX树。它是**有界近期审计**，不能证明被丢弃的请求全历史；不能据最终snapshot当成历史strict acceptance。写入失败显示已有 hp-native-error，不能将旧文件当新导出。

为防止旧 ready/capture/ACK 被误用于新模式，若同一sandbox的 `Documents/history-production` 已存在 ready.json/capture.json/control.json/control-ack.json/clock-ack.json，ui-parity启动拒绝 `ui_parity_requires_fresh_artifact`，不删旧证据。main必须新独立build/bundle使用此模式。manifest仍是builder的编译身份，**runMode为启动时runtime字段，manifest本身不授予historydriver admission**；ui-parity不生成ready.json/capture.json/clock-ack.json/control-ack.json，审计显式 historyDriverAdmission=false。不得把 ui-parity 审计重命名成 capture、与旧manifest/capture混用、或作为历史driver输入；driver需要fresh ready/nonce/clock/frames而这里都不提供。v3 Observer及driver护栏仍归其 owner/main，本轮不修改它们。

main 等新Observer/AX/密度源稳定合包到全新artifact后启动（本 worker 未执行设备）：

```sh
SIMCTL_CHILD_HISTORY_SYNTHETIC_RUN_MODE=ui-parity \
SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE=reference-105 \
  xcrun simctl launch --terminate-running-process "$HP_UDID" "$HP_BUNDLE_ID"
```

仍需主会话将系统设为dark；如有显式 DIFF_LAYOUT 则按下节优先级覆盖，否则参考profile为dynamic。正常UI入口/testID与下方Changes/Bots/计划路线一致。操作结束退后台后，主会话从该App data container读取 `Documents/ui-parity/ui-parity-audit.json`，核对 sourceSynthetic=true/runMode=ui-parity/observerDisabled=true/strictAcceptance=false/historyDriverAdmission=false，Host rejected=0/mutations=0/network=false、profile及目标请求；startup或旧processNonce文件不能充当本阶段background审计。

**模型目录最窄合同补齐**：Web `queries/configCatalogQueries.ts` 的 locationOf(null)省略location；当前生产 `features.tsx` 的 modelCatalog.load(null)同样读取无query `/api/config/catalog/providers`，includeAgent=true时再读 `/api/agent`。normal fixture现允许精确无query `/api/agent`，或唯一 `location[directory]=/fixture/history`；目录非空时不接受其它workspace，错误key、空值、多余/重复query、`/api/agents`与尾斜杠均拒绝。terminal/partial/growth保持原必填location合同，不在生产代码里伪指定root。测试直接执行当前真实modelCatalog函数与pure signal boundary，覆盖includeAgent开关、null/已知workspace、默认/ui-parity；当前BotEditor传includeAgent=false，不能从这个agent缺口反推旧Bot Retry的所有成因，main需新载体复验。

本轮focused Host suite24项通过，包含ui-parity默认/显式/非法模式、sidecar unavailable语义、零伪clock、同源业务响应/500条25页、scope/写拒绝、1500次读取后的journal字节与条目边界、超大条目omitted、main分支/已有安装/grants源合同、实际modelCatalog全局读取。纯测试/SDK编译不证明UIKit可启动、性能无扰动或长时UI已完成，本轮没有运行engine/设备/真实Host/Git/依赖安装/模型。

冻结验证：`host.test.ts`、`build.test.ts`、`sidecar.test.ts` 三文件共27项全部通过；按当前build.swiftSources复制完整15个真实Swift源（包含新输入metadata/spellcheck及当前Observer）到独立临时目录，真实NativeShell framework / arm64-apple-ios15.0-simulator SDK整体typecheck通过，检查前后源hash无漂移。仅Observer现有UIApplication.windows弃用警告，未修改其owner区域。没有链接/启动App或重新创建旧artifact；完整Ui-parity设备启动/退后台原子写审计与长时资源曲线仍待main实际确认。

### 固定启动外观 reference-105（当前冻结）

`HISTORY_SYNTHETIC_APPEARANCE` 仅接受精确字符串 `reference-105`；未设置保留原 settings 种子，空串、未知名称、JSON 或带尾随换行的值在 Host 初始化时以 `history_fixture_appearance_profile` 拒绝，不静默回退、不解析任意环境 JSON。只改变测试 Host 的只读 settings 响应，不写真实 Host、设备配置或业务文件，也不增加生产组件/桥/能力。

来源冻结时点为 **2026-11-08 本轮主会话转交的 Web `:5188/mobile.html` 只读 GET 白名单**，本 worker 未重新访问该页面/Host，未推测更精确的抓取时间。参考是 **Chromium / Mac UA 的触摸页面**，不是 iOS Safari；仅外观输入对齐不能证明浏览器字体、布局、safe-area或 UIKit 几何相同。白名单固定为：

```json
{
  "themeId": "jetbrains-dark",
  "themeVariant": "dark",
  "lightThemeId": "nightowl-light",
  "darkThemeId": "jetbrains-dark",
  "useSystemTheme": true,
  "fontSize": 105,
  "monoFont": "system-mono",
  "uiFont": "system",
  "chatRenderMode": "sorted",
  "diffLayoutPreference": "dynamic"
}
```

`messageStreamTransport` 和 `padding` 保持字段缺省，由生产消费者解析为 `auto`、`100`，不额外写入猜测值。profile 叠加于原有合成项目/通知关闭/会话设置种子；显式启用时四个 scenario 均可采用，但不改变各自消息、Git、Bots/计划与分页合同。`useSystemTheme=true` 保留，因此 main 须先将目标系统设为 dark，再做 JetBrains Dark 同条件截图；fixture 不强制系统外观。

组合优先级：**原 settings 种子 → reference-105 固定白名单 → 显式 HISTORY_SYNTHETIC_DIFF_LAYOUT**。只开 appearance 时有效布局为 dynamic；同时设置已允许的 inline/side-by-side/dynamic 时，仅该显式布局覆盖 reference 的 dynamic，其余字段原样保留。不设两个变量时仍为原 normal inline；其它 scenario 仍不新增 diffLayoutPreference。非法布局即使搭配合法 appearance 也拒绝。

main 在新载体合包并准备好系统 dark 后启动（仅由 main 执行，本 worker 禁设备/engine）：

```sh
# 不带 DIFF_LAYOUT，保留参考 profile 的 dynamic；确保启动环境没有残留的 DIFF_LAYOUT 覆盖。
SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE=reference-105 \
  xcrun simctl launch --terminate-running-process "$HP_UDID" "$HP_BUNDLE_ID"
# 显式比较 split：只覆盖布局，其它参考外观不变。
SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE=reference-105 \
SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT=side-by-side \
  xcrun simctl launch --terminate-running-process "$HP_UDID" "$HP_BUNDLE_ID"
```

snapshot 新增 `activeProfiles:{appearance:null|"reference-105",diffLayout:null|"inline"|"side-by-side"|"dynamic"}`；null 表示该 profile 不作用于当前 seed。`synthetic-appearance-read` journal 同样记录 activeProfiles，只有固定枚举，不记录任意环境内容、URL、凭据或用户数据。反复 GET 返回相同 seed；Host settings PUT 继续拒绝，正面审核仍要求 rejected=0/mutations=0/network=false。

本轮 focused Host suite 19项全部通过（新增2项）：真实启动环境白名单/未知拒绝、四 scenario 完整 settings 精确比较、三布局组合、生产 appearance 主题/字号/auto/100解析、重复读取与写拒绝。SyntheticHost.swift 的真实 iOS Simulator SDK / arm64-apple-ios15.0-simulator typecheck 已通过。UI/生产/Observer/build未改，未运行设备、engine、真实Host、Git、依赖安装或模型；前一轮完整11源 SDK compile记录保留在下方但不冒充本轮完整合包证据。main 等 AX/密度/Observer源稳定后再创建全新 artifact，旧 artifact 不覆盖。本 profile 不代表 Web/UIKit 视觉已验。

### 新 normal Changes 只读数据与 main 路线

本轮仍只修改 `SyntheticHost.swift`、`host.test.ts`、本 README，未改 Observer/build/生产模块，未构建或覆盖旧 artifact。新 normal 的合成 workspace 现在明确 `isGitRepository=true/isClean=false`；完整 status 与 `mode=light` 返回同一3文件状态，不用“无 Changes”避开入口。文件与统计为：

| 文件 | index / working_dir | diffStats | 文本 |
| --- | --- | --- | --- |
| `src/staged.txt` | `M` / 空格 | +3 / −3 | 180行，3处替换，含长行 |
| `src/working.txt` | 空格 / `M` | +3 / −3 | 180行，3处替换，含长行 |
| `docs/new-note.md` | `?` / `?` | +72 / −0 | 新文件72行，original为空，patch使用 `/dev/null` |

生产 `changesSnapshot/changeGroups` 与 Composer 的 `summarizeGitChangedFiles/extractGitChangedFiles` 直接消费这些 wire，去重总计3文件、+78/−6。`GET /api/git/file-diff` 返回原生 DiffView 所需 original/modified/isBinary，`GET /api/git/diff` 返回同源有效 unified patch。两者都严格要求唯一 directory/path/staged，path 仅表中3个，staged 必须分别为 true/false/false。normal `git/check/status/worktrees` 加上按需 `git/remotes`（空数组，无远程）、`git/branches`（仅 synthetic-changes）和 `git/primary-root`（仅 /fixture/history）覆盖当前项目菜单、工作树上下文及 Changes workspace reader 的精确只读调用。后三者仅接受唯一 directory，无通配空对象成功。

历史入口保留原500条消息、页序、全部原正文/reasoning/shell 内容。只有 normal 的 `GET /api/session/history-production-500/message/hp-0499?directory=…` 完整响应在原 content 后追加一个已完成的合成 `apply_patch` 工具 `outer-history-patch`，不执行 patch。其 metadata.files 带已验证 modified/added、统计及不完整历史单侧文本，使生产 reader 按需读取 `/api/yuri/sessions/history-production-500/changes?directory=…&messageID=hp-0499&file=…`。只接受这一个 session、message、directory 和3个文件；返回 `{diff:{file,status,before,after,patch,isBinary}}`。历史正文标记 `HISTORICAL RECORDED`，当前 workspace 标记 `WORKSPACE SYNTHETIC`，不能互相充当依据。canonical endpoint 已支持，不开放未使用的 legacy session/diff fallback。其它 scenario 的 Git 状态和历史正文维持原合同，上一轮2 Bots/2 Tasks/opaque游标仍保留。

main 在仓库根构建全新 normal（本 worker 未执行）：

```sh
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/scripts/build-history-production-uikit.mjs --scenario normal
```

main UIKit 三条原入口路线：

1. **Composer**：项目 `project-session-history-production-500` → Chat → `composer-changes`（3文件、+78/−6）→ `composer-changed-files` → `composer-change-src/staged.txt` 或另外两个文件 → `native-changes-sheet` / `changes-native-diff`。`changes-back` 回到真实 workspace 列表，`changes-close` 关闭。打开文件会先构造 workspace owner，所以可按需读取 remotes，并非只有单文件 diff GET。
2. **项目**：`projects-menu-history-project` → 原选项 Sheet → `projects-option-changes`（等待原生 dismiss completion）→ `native-changes-sheet` → `changes-workspace-list`。可折叠 `changes-group-staged/working`、`changes-directory-true-src` / `changes-directory-false-src` / `changes-directory-false-docs`，或 `changes-view-mode` 切树/列表。文件控件为 `changes-staged-src/staged.txt`、`changes-working-src/working.txt`、`changes-working-docs/new-note.md`。点文件进入原 DiffView。顶栏 `changes-diff-actions` 为图标：`changes-open-preview`、`changes-wrap`、`changes-layout`。`changes-diff-refresh` 只在加载失败的错误行出现。`changes-back` 返回列表，`changes-close` 或系统拖下关闭。
3. **历史工具**：Chat 展开最新相关 `body-activity-<实际row key>`，由生产 materialization 发 hp-0499 exact-fill；找到 `tool-expand-outer-history-patch` → 原历史 ChangesSheet → 首文件 exact historical GET。`changes-back` 回历史3文件列表，选另一个文件触发对应历史 GET；文本 diff 的 `changes-wrap` / `changes-layout` 可切换软换行和行内/并排；关闭返回 Chat。实际 row key 由 AX/native capture 读取，不能猜后缀。原 `tool-expand-tool-hp-0499` 仍是原 shell，不是新增 patch。

`changes-native-diff` 使用生产 DiffView，长行、多处修改、180行文本供 main 实测选区/纵横滚动；不新增假的渲染组件或手势。iOS resize 使用原生 Sheet grabber 的 .42/.72/1 detents（旧系统 medium/large）；`changes-sheet-resize` 仅非 iOS 存在。workspace 的 `changes-commit-resize` 只调整本地输入区域，可验拖动但不提交。原生 selection 支持程度、滚动/resize 过程、系统 dismiss/Back 是否正确仍必须实际验收，不能由纯 reader 测试宣称已完成。

**布局零写入边界**：生产 diff 没有自带布局切换控件，设置中的 inline/side-by-side/dynamic 保存由 Host PUT 所有，而本任务禁止业务写。fixture 只新增进程启动环境 `HISTORY_SYNTHETIC_DIFF_LAYOUT`，严格接受这3个值，缺省 inline；normal 的每次 settings GET 返回同一个固定偏好，journal 的 `synthetic-layout-read` 记录实际值。main 可在同一新 artifact 分别冷启动以下3种 profile（设备操作仅由 main 执行；每次保存独立 capture）：

```sh
SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT=inline xcrun simctl launch --terminate-running-process "$HP_UDID" "$HP_BUNDLE_ID"
SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT=side-by-side xcrun simctl launch --terminate-running-process "$HP_UDID" "$HP_BUNDLE_ID"
SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT=dynamic xcrun simctl launch --terminate-running-process "$HP_UDID" "$HP_BUNDLE_ID"
```

这能检验同一真实 production chain 的三种布局输入，不代表“打开弹层时在线切换”已验。dynamic 跟随**窗口**宽度：已有文件 <1100pt unified、≥1100pt split；新文件始终 unified。明确 side-by-side 即使窄屏/新文件仍 split。若要同进程通过生产设置保存实时切换，需另行允许 synthetic Host 偏好写；本轮不放宽该限制，也不使用随 GET 次数轮换偏好的假实现。

审计：`request/response` 保存 method/path/query/status，新增 `synthetic-changes-status`（requestID、fileCount、insertions、deletions）和 `synthetic-changes-diff`（requestID、workspace/historical、file、staged或messageID）。main flush 后应逐入口核对实际读取、`rejected=0/mutations=0/network=false/synthetic=true`。所有 stage/unstage/discard/revert/commit/fetch/pull/push/worktree 写、small-model 生成及 Host settings PUT 均拒绝；不可点击这些操作后还签正面零拒绝。生成按钮不是只读布局动作，即使前置 diff GET 允许，最终 paid/model POST 仍拒绝。

本轮 focused Foundation suite 为17项，其中新增4项验证真实 reader/Composer纯投影、历史 exact hydration 隔离、三布局只读 profiles、非法 scope/query与所有 Git 写拒绝。SDK typecheck 与纯合同结果只证明读取合同，不证明 UIKit 已验；未运行 engine、设备、真实 Host、Git、依赖安装或模型。

最终冻结验证：设置已有 NSH_DIST 后运行本目录完整 Vitest suite，**8文件 / 29项全部通过，无 skip**；新 Observer 的 SDK probe 已实际启用。随后将 build.mjs 当前 `swiftSources` 的11个真实源逐字节复制到独立临时 compile 目录，使用真实 NativeShell framework、arm64-apple-ios15.0-simulator 执行完整 `swiftc -typecheck` 及 `-whole-module-optimization -emit-object`，均通过；执行前后逐文件 hash 一致。没有链接/执行 App 或运行 NSH。`SyntheticHost.swift` 的 snapshot、追加工具 metadata、历史 diff 和 history row 使用明确 `[String: Any]` 局部字典，已消除旧条件字典 compiler diagnostic 问题；Observer owner 文档里此前的 Host 中间态阻塞已由本次完整编译解除，不修改其文档或源码。

本次完整 SDK 编译实际采用 Observer SHA256 `1818388e1525d740bcb9ffad879ba09aca20ed839234df70500a1a457cb23138`、SyntheticHost SHA256 `75b8c324b68b3cccf8b4e23e326afa690ea89b545a0cfbd2fa0e9e830094ffa9`。build.mjs 的当前 observerContract 前缀为 `pan-read-v2; window-header-v1`；driver 对 v2 的接纳仍由 main 接线，不能把完整编译成功解释为 driver 或 UIKit 已通过。旧 artifact 保持原身份；新 source graph 变化需要新独立 build。

### 新 normal 的外层只读 Bots / 计划数据（本轮 tests-only）

新构建的 `--scenario normal` 保留原500条 Chat 和25页历史，另提供2个合成 Bot、2个合成计划与6条已记录的合成运行历史。数据字段依据 `tests/assistants-settings-host.js`、`tests/assistants-host.js`、`tests/schedules-host.js` 和 `features-uikit/SyntheticHost.swift`，使用生产 snapshot、详情与历史消费者；没有替换生产 UI 或添加测试导航。`terminal/partial/growth` 仍返回原空 Bots/计划集合。所有数据来源均为 **synthetic fixture**，不是实际 Host 的已运行任务或签收证据。

本轮只改 `SyntheticHost.swift`、`host.test.ts` 与本 README，不改 build.mjs、observerContract、Observer.swift 或生产 TSX/Swift。未触碰 `.nsh/` 中已冻结 `cec5b612` / `438…` / `b0e82f9e` 等旧 artifact，不能在旧目录重新构建覆盖。main 在仓库根创建全新随机 build：

```sh
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/scripts/build-history-production-uikit.mjs --scenario normal
```

main 的实际 UIKit 路线（本 worker 未执行）：

1. 原四 Tab → 助理，检查 `assistant-catalog`、`assistant-row-outer-bot-1/2`。Research Bot 为置顶且 working，Review Bot 带未读2；头像 seed 分别为 `outer-bot-1/2`。这些是合成展示状态，无运行中模型。用当前实际 row/card frame 内的真实长按打开 ActionSheet，再选 **编辑** 进入生产 Bot 详情/设置，验证 prompt、模型、目录及关联计划；Back 返回列表。卡片不再有额外 more 按钮或 `assistant-menu-*` testID；无障碍菜单通过 row 的公开 `menu` custom action，默认 `activate` 打开当前联系人。主新包须核验该菜单动作可达、长按松手不误开 Chat，以及 swipe release/terminate 后同 ID 刷新的 AX 菜单可用。需要设置入口另走 Settings → Bots → `assistant-settings-edit-outer-bot-1/2`；会话 header 的独立设置入口不变。
2. Bot 详情中的 `assistant-channel-weixin/wecom/feishu/dingtalk` 各打开真实系统 pageSheet，检查未配置表单，点 `assistant-channel-close` 或系统关闭；渠道读取按需发生，无真实账号/凭据。不连接、不保存。Bot 关联计划按钮可进入同一真实计划详情。
3. 原计划 Tab → `scheduled-tasks`，检查 **Synthetic daily schedule**（启用）与 **Synthetic paused schedule**（暂停）及筛选；点击卡片进入生产详情，查看配置/执行内容与 `scheduled-history`。`scheduled-history-more` 读取该任务第2页并终结，共3条，Back 返回。
4. 计划首页 → `scheduled-history-tab`，查看全局6条历史，点击两次 `scheduled-history-more` 完成3页。详情右上编辑进入生产 TaskEditor，可检查日程/目录/模型，打开模型 Sheet 后 `features-model-close`，最后 `features-task-cancel` 或 Back。不更改后 Save，也不点击运行/暂停/恢复/删除/置顶/标记全部已读/清空历史。运行记录引用现有 `history-production-500`；其“打开会话”沿现有项目 Chat 只读路线。

本次范围是列表 → 菜单编辑/设置 → 详情/二级配置/历史。Bot 卡片主体会打开 contact Chat，**本轮未增加 contact/messages 读合同**，不能将该分支或发送路径算为已覆盖。未读展示不签发 `readTip`；不得据此宣称已验证已读写回。main 必须以实际 AX/画面确认入口、头像/标记、Sheet、Back/关闭，不以本轮纯合同测试替代 UIKit 验收。

| 允许的新增读取 | 精确限制 |
| --- | --- |
| `GET /api/yuri/assistants/capability`、`snapshot` | 无 query；仅 normal 的 snapshot 为 enabled/revision/2 assistants |
| `GET /api/yuri/assistants/outer-bot-{1,2}/scheduled-tasks` | 无 query；每个 Bot 仅对应同编号任务，采用现有 projectID/taskID/task wire |
| `GET /api/yuri/assistants/outer-bot-{1,2}/weixin` 或 `/channels/{wecom,feishu,dingtalk}` | 无 query；未配置状态，无秘密字段、配对或网络 |
| `GET /api/projects/history-project/scheduled-tasks` | 无 query；2条任务集合供编辑器核验 |
| `GET /api/yuri/scheduled-tasks` | 无 query；现有 projectId/task 包装与 failedProjectIds |
| `GET /api/yuri/scheduled-task-runs?limit=20` | 全局；或成对的 projectId=history-project 与 taskId=outer-task-{1,2}；唯一可选 before 是此前同 scope 已签发的 opaque token |
| `GET /api/config/catalog/providers` | normal 允许无目录供 Settings Bot 编辑；可选 directory 仍只能 /fixture/history；其余 scenario 保留必填目录 |

所有请求仍先校验精确 expectedHost/lease，GET 不接收 body，多余/重复 query、未知 ID、未签发或跨任务游标均拒绝。opaque token 经 encodeURIComponent 原样送回，不能根据示例猜页。页面上限为2条记录（请求 limit 仍遵循生产20），全局3页、每任务2页，complete 与 null nextCursor 一致。`capture.json` 的 host journal 保留 request/response，另有 `outer-history-response` 的 requestID、scope、requestCursor、responseIDs、nextCursor、complete；main 用新 artifact 的 flush 导出实际请求后核对 `synthetic=true/network=false/mutations=0/rejected=0`。nonGET 业务写仍全拒绝，唯一既有例外为只读 Goal RPC POST；纯负向合同故意制造 rejected，不能混入 UIKit 正面窗口。

本轮 focused Foundation suite 为13项（新增3项）：生产 snapshot/联系人/关联任务消费者、全局与任务 opaque 分页、猜测/跨任务游标和全部新增业务写拒绝。worker 未运行 NSH engine、设备、真实 Host、Git 或付费模型；不标 UIKit 完成。

`SyntheticHost.swift` 用 Foundation-only mapping，先真实 `connection.list` snapshot admission，再要求每个runtime请求/stream的 `expectedHost` 精确匹配已签发的 `history-production-synthetic` / `00000000-0000-4000-8000-000000000053`。缺省、旧lease、附加字段、其他目录/会话、重复/多余query均拒绝；不会以空成功兜底。stop遵循生产cleanup合同：scope必须结构合法，旧scope/owner只是成功no-op，不能取消新stream。根目录/SessionIndex/项目顺序、外观配置、关闭的通知/诊断/语音、目录catalog、Chat元数据/status/inbox/form/permission、Goal只读RPC及本地stream receipt均有窄合同。

### 当前 stream 合同与新 normal artifact

Chat start精确要求 `path/key/expectedHost/mode/ownerID`；mode只接受 `auto/ws/sse`，owner为1–128个ASCII字母、数字、`-`或`_`。path只接受 `/api/event` 加唯一的fixture directory query。global start保留 `path/key/expectedHost` 三字段和 `/api/yuri/events`，不接收mode/owner。所有校验完成后才替换字典中的UUID ticket。Chat stop精确要求 `key/expectedHost/ownerID`，global stop要求 `key/expectedHost`，按保存的scope及owner比较后移除。

每次start保存当次scope/owner/ticket。ready发送当前生产使用的 `runtime.event` 加 `type:"reconnected"`；data同样用 `runtime.event`，断开用 `runtime.disconnected`。生产未单独发送 `runtime.ready`，此fixture也不虚构该事件。所有回调使用捕获ticket的scope/owner；旧ticket、同owner重新start前的ticket以及stop后的ticket全部丢弃，绝不读取fresh app scope替迟到事件补签。这只是合成I/O展示fixture，不执行WS/SSE或真实Host连接，也不替代已冻结的Direct loopback fixture。

设置和主题目录均为只读对象，themes返回 `{themes:[]}`，内置主题由生产消费者解析。截图、取消、Back不需要Host写；代码字号单独Save使用生产device-local storage流程，不属于Host偏好。Host PUT/POST/PATCH/DELETE仍关闭，唯一例外仍是既有只读Goal RPC POST。main若修改其他Host偏好再Save，会按既有规则拒绝，不能把该路径签为零拒绝。

本轮只更新本文件、`SyntheticHost.swift` 和 `host.test.ts`；未新增Swift文件，不需要扩充构建源清单，不stub生产类。build script、Observer、history driver及recorder工具不改。旧 `cec5b612` 和其他artifact身份/hash不覆盖。由main构建新独立载体：

```sh
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/scripts/build-history-production-uikit.mjs --scenario normal
```

严格纯合同命令：

```sh
bunx --offline vitest run --config packages/nsh/tests/history-production-uikit/vitest.config.ts packages/nsh/tests/history-production-uikit/host.test.ts
```

本轮10项通过：实际Foundation Swift callback runner、精确输入/非法mode/owner/路径、拒绝前保留旧ticket、owner/scope CAS、同owner重开与迟到回调隔离、global兼容、500条分页、只读设置及生产event/appearance消费者。`SyntheticHost.swift`另通过iOS Simulator SDK的arm64 iOS15 typecheck。未运行engine/device、真实Host或完整UIKit App；main须在新artifact实际确认生产root→设置卡片→代码字号→返回/动画可达，且audit `rejected=0/mutations=0`。这不等于原53pt场景通过。

只有GET及严格匹配的Goal GET语义RPC POST允许；session create/prompt/command/shell/revert、配置/目录/Git写、small-model、网络、连接变更、音频合成都拒绝。不编译RuntimeBridge、ConnectionStore或Keychain。Git读取只是内存中的“不是Git仓库”目录事实，不执行Git。未知协议会留下`rejected`，所有正面窗口都要求0；不要吞掉它们继续签收。App自身Storage使用独立sandbox，不预写业务ready或手工替换app.connection。

500条ID为 `hp-0000`…`hp-0499`，每20条newest-first、opaque `history.before.<index>`，共25页；源顺序不按ID再排序。每三条为user、assistant reasoning/tool、assistant final body，20条分页故意跨turn边界。正文含可见 `ANCHOR hp-NNNN`、完整段落、列表和code block；tool为slim历史，展开真实Activity后由生产exact-fill GET返回完整长output。不是用简化TextView代替NativeTranscriptBody。无原用户正文、真实命令执行或真实provider请求。

| scenario / 独立窗口 | 真正触发入口 | 源事实和验收边界 |
| --- | --- | --- |
| normal | 原 `history-load-older` 或真实向旧端scroll | 正常more=true的20条采用，记录request/cursor/response IDs，不能零load签收 |
| terminal | 继续同一真实分页到最后20条 | 第25页 `complete=true/nextCursor=null`，完整footer隐藏单独判定；OFF必须保留负控制能力，不保证恰等于原53pt |
| partial | 第一次 `history.before.480` 固定返回一次503，再点原Retry按钮 | 生产error文本真实出现，Retry同步清错、more仍true，然后正常下一页；局部footer收缩独立于完整隐藏，不能记成controller已解决 |
| growth | 真实latest admission/原安全poll读取相同tail；另展开真实Activity/Thought | `hp-0497`在第2次及后续tail GET增加完整段落，前32代有自然增长；没有加载延迟/提交gate。真实Activity `body-activity-*`、`tool-expand-tool-hp-*`可触发正文exact-fill/展开。没有增长时不能签自然增长窗口 |

normal/terminal没有不同的假布局：它们消费同样500条，只是main选择正常页或终页窗口。安全poll始终是生产自己的行为；录制增长窗口前不得用开关冻结它。没有固定footer spacer、缓存高度、第二offset/inset writer或删除/隐藏内容。生产自有折叠/局部Scroll保持原行为，不以fixture额外裁剪换平稳。

## main独占设备：启动和真实控件

设 `HP_BUILD` 为本次manifest所在目录，`HP_BUNDLE_ID`逐字复制manifest.bundleID；设备、framebuffer尺寸由main实际确认，以下命令worker未执行。

```sh
xcrun simctl install "$HP_UDID" "$HP_BUILD/HistoryProductionUIKit.app"
xcrun simctl launch "$HP_UDID" "$HP_BUNDLE_ID"
xcrun simctl get_app_container "$HP_UDID" "$HP_BUNDLE_ID" data
```

将返回sandbox下的 `Documents/history-production` 设为 `HP_DATA`。`ready.json`只表示clock sidecar装载，**不是production root/Chat adoption**。先在实际App检查 `main-tabs`、`projects-toggle-history-project`（需要时展开）、`project-session-history-production-500`，点击真实session进入 `transcript`。不得从测试JS改nav/app状态，不加诊断导航或替代List。任意原生错误 `hp-native-error`、App协议错误、缺Session或错误前台先保存原文/AX/截图，判invalid并修Host窄合同，不能用假按钮绕过。

主要真实IDs：`history-load-older`、`history-page-error`、`history-refresh`、`body-activity-<真实row key>`、`tool-expand-tool-hp-NNNN`、`body-part-<生产part key>`、`history-copy-hp-NNNN`、`history-actions-hp-NNNN-user/assistant`。part/row key由生产投影生成，必须读取当前实际AX/native capture，不猜固定suffix。每手势最多一页仍由原historyScroll授权；不要用`scrollTo`或直接调loadOlder代替触摸。

## 原生观测及不能伪造的身份

`Observer.swift` CADisplayLink在真实UIView树读取转换后的rect、UIView实例身份、actual UIScrollView offset/contentSize/tracking/dragging/decelerating，以及源request/response时间。原生记录没有用core measure、AX缺席或JS commit代替native geometry。首次观察到具体content UIView时记录 `native-first-observed`；即使是离屏挂载也明确visible=false。新的SDK mutation/adoption ticket未公开，所以 `sdkMutationGeneration/sdkAdoptionIdentity` 为null，**首次挂载不冒充SDK采用ACK**，Host `sourceGeneration=1`也仅是固定合成数据源代际。

生产footer两个wrapper目前没有testID。载体只读记录原按钮/错误的真实ancestor UIView实例、class和frame，并继续弱读这些确实观察过的祖先；**不会给某个祖先编造“这就是natural/held owner”的身份**。完整footprint释放如果无法由真实层级明确定位，就保持未验；不能凭button消失推出wrapper0高。SDK排队事件是否重读新handler也仍是SDK边界，不由此载体声明已证明。

当前保留最多18000实际native样本/20000事件，Host journal最多20000；溢出明确invalid，不裁掉坏帧。观测本身有CPU/内存成本，未设备测量，不宣称无扰动或60fps必达。这里只记录匿名合成ID/原生几何，不导出text/label/用户配置。

```sh
# 只读保存ACK；返回后capture.json已经原子写入。
"$HP_BUILD/tools/clock-client" "$HP_DATA" flush
# 从当前capture最后的实际nodes中预选三个完整可见、互不重叠的旧内容块。
# 在触发任何目标动作前把三个真实ID固定在native mark事件，不能事后挑最稳的：
"$HP_BUILD/tools/clock-client" "$HP_DATA" mark "$HP_ANCHOR1" "$HP_ANCHOR2" "$HP_ANCHOR3" > "$HP_OUT/mark.json"
```

mark仅读取已有periodic sample，不进行新measure或布局。ACK给出baselineSequence；三个ID必须在该帧各有一个完整可见节点，否则原生失败关闭。mark后点原分页/Retry或执行目标生产动作；滚动中的窗口无输入量独立证据时判invalid，不推测用户位移。正常、终页、partial、growth分别保存，不把一个模式的绿搬给另一个。

## 三个时钟的实测握手

`clock-client`以macOS `ProcessInfo.systemUptime`记hostSend → 原子写control文件；模拟器目录watch收到nonce后真实派发给sidecar；sidecar以performance.now记录JS send → host.call，Foundation当次调用记录native receive/return → JS receive → native ACK写文件；CLI实际看到相同nonce的ACK后记hostReceive。没有预设两种uptime同epoch，也不拿旧采样时间冒充fresh clock。文件watch/JS/主线程迟到都会扩大真实不确定度，不用固定sleep藏延迟。

```sh
# 先完成录制ready，再做窗口前多组握手；clock不改变生产数据或UI。
for i in 1 2 3 4 5 6 7 8; do "$HP_BUILD/tools/clock-client" "$HP_DATA" clock >> "$HP_OUT/clock-before.jsonl"; done
# 目标事件后保留完整>=4秒真实采集，再做窗口后8组同样的clock到clock-after.jsonl。
```

每对offset区间为 `[nativeMs-hostReceiveMs, nativeMs-hostSendMs]`；求所有区间交集，空交集/漂移/不确定度过大拒绝。JS往返另保留native相对JS的上下界；它不是UIKit commit ACK。窗口前exchange必须确实早于baseline−250ms，后exchange晚于baseline+4000ms（算入offset上下界）。两种uptime在本次保持awake时同速是明确假设，端点握手不能证明内部非线性漂移绝不存在。

将before/after JSONL合成数组保存 `native-sync.json`（保留原JSONL）：

```sh
python3 -c 'import json,sys; print(json.dumps([json.loads(x) for f in sys.argv[1:] for x in open(f) if x.strip()]))' "$HP_OUT/clock-before.jsonl" "$HP_OUT/clock-after.jsonl" > "$HP_OUT/native-sync.json"
```

## live IOSurface录制、逐帧像素和判定

复用main已做live smoke的 `.scratch/nsh/record-source-6gTy3C/record-source` 与 `record-check.py`；源码和二进制本轮未修改。先确认其provenance，尺寸必须是main实测framebuffer；`HP_RECORDING`必须不存在。命令只由main执行：

```sh
"$HP_REC/record-source" capture "$HP_UDID" "$HP_PIXEL_WIDTH" "$HP_PIXEL_HEIGHT" 90 "$HP_RECORDING" "$HP_DEVELOPER_DIR" --live-source-authorized
```

main以子进程管理并等待实际 `ready.json`，再做上述前clock/mark/真实触摸。保留所有原始源ledger/movie/PTS/AX/手势发送及ACK时间。完整后clock与flush结束后，对该录制进程SIGINT并等待finalized/退出；不能用末帧保持补尾、CFR、补帧或只截取成功端点。

```sh
"$HP_BUILD/tools/clock-client" "$HP_DATA" flush
# ACK之后复制capture.json到HP_OUT；从真实host journal选mark之后目标history-response的requestID。
python3 "$HP_BUILD/tools/check.py" "$HP_OUT/capture.json" \
  --manifest "$HP_BUILD/manifest.json" --baseline-sequence "$HP_BASELINE_SEQUENCE" --request-id "$HP_REQUEST_ID" \
  --anchor "$HP_ANCHOR1" --anchor "$HP_ANCHOR2" --anchor "$HP_ANCHOR3" \
  --sync "$HP_OUT/native-sync.json" --recording "$HP_RECORDING" \
  --record-check "$HP_REC/record-check.py" --record-binary "$HP_REC/record-source" \
  --pixel-binary "$HP_BUILD/tools/pixel-measure" > "$HP_OUT/verdict.json"
```

判定同时检查：同App bytecode/executable身份、mark确实先于请求、20条实际response身份和窗口内新native content实例（growth可用同实例正文自然高度改变）、同viewport和三个旧实例、250ms pre、>=180实际post/3秒、native及live源最大gap50ms、源read bracket＋clock误差、真实读取/编码/解码PTS一一对应、零drop和完整stop/finalized。无load/无新原生效果、缺节点/复用/遮罩/移动中/协议拒绝/溢出/断时轴均invalid。

`PixelMeasure.swift`完整顺序解码实际coded frames，使用clock上下界找事件前真实编码reference和全部事件窗口帧；从三个**事前固定**native anchor对应像素区域做联合二维纹理位移注册。无插值/平滑/单帧忽略；best MAE≤1.5且≥3px局部替代至少差1，否则invalid；整数像素精度明确为1/scale pt。内层glyph移动也不能仅靠外框stable判绿。ROI重复纹理、内容改变或不可信配准会invalid，不能为了绿改选窗口或降低阈值。保留输出的逐帧PTS/位移/质量，并独立人工查看事件原帧；自动联合注册不等于任意内部变形和短于实际采样间隔的瞬态全无。

- exit1 / `red`：native或可信coded pixel存在>1.1pt额外位移，保留失败，不用最终复位抹除单帧。
- exit2 / `invalid`：证据/归因/时钟/帧覆盖不满足；不能签收。
- exit0 / `synthetic-production-window-pass`：仅该合成源、真实production组件和已覆盖native/coded窗口通过。原生adoption内部身份仍未知，原53pt仍unresolved；不是完整footer/partial/rowheight全部完成，更不是原生产53pt关闭。

至少三轮独立冷启动保留所有红/invalid；OFF对照若未复现不能强行登记“已修”。ON完整隐藏及后续真实手势rest释放需要分别采集，footprint实际归零和同期像素不得移位；partial/rowheight没有相应实现，仍独立保红。最终必须在原生产录像同会话形状/同build/同真实Host触发场景复验；没有同场景证据，主目标不得结项。

## worker验证与main首跑边界

纯suite入口为 `vitest run --config packages/nsh/tests/history-production-uikit/vitest.config.ts`。它真正编译执行Foundation Host/clock，执行实际sidecar JS和生产message/row projection；53pt单采样红灯/回归baseline、缺帧/实例复用/用户运动等是明确标注的离线校准，不冒充UIKit实测。一次默认OFF完整生产源图stage已实际完成，manifest记录精确冻结输入；后续source变化需要新stage，不把旧stage当新App。UIKit/NativeShell静态typecheck和离线工具编译不证明Host已在App实际启动。

main第一步应构建并独占设备做bootstrap＋clock握手＋短native/movie采集smoke，核对根协议零拒绝、真实Chat、native三anchor和时钟误差。再做四类目标窗口；任何缺协议只修本载体的精确read route，不放宽allowlist，不替换production view。独立review由main派发；本worker不声称已完成review或生产闭环。
