# Remote Projects 性能验收工具

这是测量基础设施，不是功能实现，也不是通过声明。`run.mjs report` 默认将全部 25 个 gate 标为 `unverified`；原始测量不会自动升级成整个 gate 通过。不能用 HTTP/helper 计时或 happy-dom 测试耗时替代 UI 真实性能。

最终契约冻结轮次的功能结果与限制见 `.scratch/remote-projects/performance/candidate-final/DIAGNOSTIC.md`。`candidate`、`candidate-stable`、`candidate-final` 分别保留，不能跨 hash 合并成整链通过；功能闭环未通过时不进入正式性能比较。`stable-electron-smoke.mjs` 在重复同一 mode 前自动归档旧结果 JSON，控制回执和网络日志继续追加。

新候选正常入口使用 `REMOTE_PROJECTS_STRICT_ENTRY=1`；setup-add 还要求 `REMOTE_PROJECTS_PREAUTHORIZED=1` 和生产 main 启动前签发的本机授权。此模式不执行 admission/summaries/active 的额外 fetch，禁止 inspect/reload/手动同步模式，添加后只观察会话自动出现且可见，不代点展开。发送以实际 ChatViewport 的 `[data-scrollbar="chat"]` 子树新增回复和真实发送键事件为准，5 秒内未出现返回失败；整页文本或 provider 收到请求不能替代此断言。

## 可重复基线

独立 HEAD 源码/依赖/构建位于 OS 临时目录，位置与提交见 `.scratch/remote-projects/performance/baseline-environment.json`。没有改动主工作树依赖，没有连接生产实例。基线源码不跟随后续工作树变化。

```sh
# 使用上述 JSON 中的 directory，不要指向实际用户安装目录。
node scripts/remote-projects/run.mjs regressions --repo="$BASELINE_DIR" --phase=baseline --build="$BASELINE_COMMIT"
node scripts/remote-projects/run.mjs regressions --phase=candidate --build="$CANDIDATE_BUILD"
bun run --cwd "$BASELINE_DIR/packages/ui" test:avatar-performance
```

最后一项源码目前为 `test.skip`：退出码 0 并不等于性能通过。必须检查 JSON pending/skipped。两次回归文件 hash 不同则检查阈值和断言，禁止以放宽阈值获得通过。

## iOS native diagnostic（非预算通过）

本轮 selection / iOS 编辑生命周期定向诊断使用 `input-targeted-selection.mjs PLAN.json` 与 `input-targeted-ios.mjs PLAN.json PHASE`。两者要求显式 isolated/ready plan，拒绝覆盖产物，不启动平台服务；前者通过真实 Electron Home/Right/Shift 与正常 sidebar 导航采集只读生命周期，后者拆分 Web/native 的 focus/software/hid/dismiss/navigation/background。输入、冻结来源、安装包完整 hash（含 Swift debug dylib）、旧归档缺口与清理规则见 `.scratch/remote-projects/input-targeted-platform-plan.md`。工具成功不等于活平台验收，未 ready 不启动完整矩阵。

iOS focus 默认用 fresh AXLabel 定位；当真实 Web TextArea 仅提供 AXValue 时，plan 可显式设置 `fieldAXMode: "value"` 与可选 `fieldAXValue`（默认 `fieldLabel`）。导航返回项含动态相对时间时，可设置 `returnAXMode: "prefix"`，用已观察到的稳定 label 前缀匹配。两者仍要求 fresh AX 唯一可用目标，并经真实 tap，不写入 value/focus/selection。

Selection runner同时硬断言trusted Home/6Right/15ShiftRight、往返节点换代与最终选区；无生产hook候选可设 `expectOwnerRecordObservable: false`。iOS只读probe的 `runtimeAssetPaths` 仅输出同源 `/assets/` JS/CSS路径（不含query/正文），用于对照实际加载入口与installed bundle，不把旧App/缓存入口贴成新资产。

已在独立 HEAD native 副本和全新专用 Simulator 上完成真实 Capacitor build/install/launch。最初的 `-34018` 已由 **Xcode Simulator ad-hoc 签名流程**解除：使用安装 SDK 的 `Entitlements.plist` 生成 Simulated.xcent / executable entitlement 段，不需要发行证书或绕过安全存储；单独 codesign 补签虽静态验证成功，实际无法启动，不推荐。真实 Hub 配对后已进入项目/会话页，终止重启无需重配，native UI 前后台检查已留证。原生基本输入尝试未观察到 fixture 保留，仍明确非通过。最新命令、证据和清理结果见 `.scratch/remote-projects/performance/IOS-SIGNED-DIAGNOSTIC.md`；旧报告仅为历史轮次。

入口为 `ios-prepare.mjs`、`ios-build.mjs`、`ios-xcode-sign.mjs`、`ios-native-smoke.mjs`、`ios-test-hub.mjs`、`ios-serve.mjs`、`ios-accessibility.mjs`、`ios-background-smoke.mjs` 和 `ios-verify-evidence.mjs`。所有服务/构建调试从 tmux upsert；只操作 workspace metadata 的精确 UDID/name。先等上一阶段完成、根据当前 AX 定位再操作；结束依次 stop Hub/helper、cleanup 专用设备、verify evidence。开启测试 App 现有 native UI 设置后才能诊断 UIKit composer；`ios-native-input-smoke.mjs` 是功能诊断，fixture 不可见返回非零，helper 回执不代表输入成功。截图上界不是精确 presentation，欢迎页 Web 输入不是 UIKit 输入。

首事件焦点诊断可在新任务 Simulator 的独立 workspace 中复用已有签名 `appPath`，不必重新执行 prepare/build/sign。`ios-input-probe.mjs LABEL` 使用现有 LLDB 读取 UIKit firstResponder、WK activeElement/selection，安装保留原行为的事件/blur观察探针；不会写输入value/draft或强制focus。`ios-input-case.mjs LABEL 输入消息 a` 以fresh AX定位、真实tap和serve-sim type做失败可见的最小复现；native占位标签对照用 `LABEL "Tap to type" a --label`，并核对实际UITextView编辑通知。输出拒绝覆盖，须串行执行（同一App不能并发附加多个debugger）。诊断后终止该任务App并删除专用Simulator，清除进程内观察探针；不要把调试器停顿计为输入延迟。

已出现系统软件键盘时，`ios-software-input.mjs LABEL EXACT_AX_FIELD FIXTURE_TEXT_FILE` 按每次fresh AX中的实际键位触控输入，并逐字符核对AXValue；不调用CLI type，不直接写DOM/native输入值。只接受不超过300字符的隔离ASCII fixture，默认拒绝替换非空文本；中断后新label配合 `--resume-prefix` 仅允许继续与fixture完全匹配的已输入前缀。AX超时、找不到键位或文本不匹配均失败保留，不用exit0或截图猜测输入成功，也不自动重启设备恢复。

## 数据集 L

```sh
node scripts/remote-projects/run.mjs dataset
bunx vitest run --config scripts/remote-projects/vitest.config.mjs
```

生成 `L.json` 与同规模 `L-local-control.json`：50 项目、5000 摘要、300 条各类候选、5 路流式（L 分布在 3 台远端机器）、5 台远端 + 本机、10 个同名/同路径跨机器项目。固定时钟和 ID，输出 SHA256。local control 的相同路径必须展开为不同路径，避免不合法本机重复身份。生成器运行耗时没有验收意义。

## Fake Remote Host（真实 HTTP/SSE）

长驻服务只能通过 tmux upsert 启动；先检查窗口，再复用或创建，不得复用开发服务或用户资料。

```sh
tmux list-windows -a
# 不存在同意图窗口时才执行；运行目录保持当前工作树。
tmux new-session -d -s remote-projects-perf -n fake-host-1 'node scripts/remote-projects/fake-host.mjs --host=perf-host-1 --profile=lan --port=0'
tmux capture-pane -pt remote-projects-perf:fake-host-1
```

其他 host 改为 perf-host-2..5，使用独立窗口。日志返回随机 loopback 端口；不要在仓库保存真实 URL/凭据。没有鉴权的 fixture 只绑定 `127.0.0.1`，不是可部署服务。

- `/api/hosts/capabilities`、`/api/hosts/status-stream`、`/api/yuri/session-index`、`/api/projects`、`/api/session`、`/api/session/status`、`/api/event` 对齐当前 Gateway 上游路径。
- `GET /__perf/metrics`：上游累计请求/分路径请求、当前/峰值并发、当前/累计 SSE、事件数、失败交换数。指标端点自身不计入业务请求。
- `POST /__perf/control` body `{mode:'online'|'offline'|'stall'|'unauthorized'|'incompatible',stallMs?:30000,event?:{...}}` 控制故障和推送。
- Gateway 状态流事件使用 `{directory,payload:{type,properties}}`；delta 应只进入内容流。事件附带 `__perf.sequence/emittedAt/hostId`，不包含用户数据。
- LAN/Relay/weak 仅是服务端延时 5/80/300ms，weak 每第 100 个交换断开一次。**不是实际 Relay、SSH 或 1% TCP 丢包，不可冒充对应网络 gate。**
- 未实现的 endpoint 返回明确 404，禁止空成功；messages、terminal、preview 等仍需 owning agent 的高层 fixture。实际 Hub 的 descriptor 注入与隔离启动以 backend-contract 和 owning 模块为准，不直接写用户配置。
- L fixture 的已知项目视为无 Git：`GET /api/git/worktrees?directory=root` 返回 `200 []`；未知路径 404、缺目录 400。`POST /api/yuri/session-index/sync {directories}` 返回 202 和请求目录已种好的真实 fixture 摘要、完成态 sync；不接受未知目录或其他 mutation，不影响完整 GET snapshot。

真实无 UI 远端的后端复核使用 `index-http-smoke.mjs`，与 L fixture 测试分开：在 tmux 中运行 `node scripts/remote-projects/index-http-smoke.mjs /path/to/opencode`。它只使用当前 Node 绑定（不安装或重编）、两个隔离 Yuri/OpenCode、真实导入/配对/添加项目与 HTTP/SSE；模型请求被隔离 loopback trap 拒绝。结束停止自己的服务，源码前后 hash、scheduler、网络和事件证据写入 `.scratch/remote-projects/performance/index-http-smoke/`。该结果不是 UI E2E 或性能预算。

只测真实 HTTP 完整响应诊断：

```sh
node scripts/remote-projects/run.mjs observe-http --origin=http://127.0.0.1:PORT --path=/api/hosts/HOST/summaries --count=30 --confirm-isolated-test
```

记录每次样本、失败和字节数；失败不丢弃/伪装成功。该结果**不是** transcript 可见、冷启动、真实 RTT 或完整 gate。

## 真实生产 UI 测量

单一性能owner的增量工具使用 `performance-owner-*`，不修改原功能runner。`performance-owner-cold.mjs` 在临时副本排除启动遮罩/祖先隐藏/遮挡后保留实际CDP screencast像素、frame-swap时间及源码hash；driver的 `measured` 仍不等于paint通过。`performance-owner-cold-pixels.py` 仅准备固定本机fixture的目标区域帧区间和复核图，输出pending，必须独立检查实际图片；不能把DOM、截图完成、frame swap或rAF冒充精确物理屏幕presentation，也不能把本机20条正文fixture扩展为L/远端/iOS验收。

`performance-owner-memory.mjs --rss-staircase --confirm-owner-window-released` 保留原5s稳定期/15s窗口、正反阶梯与自然GC，禁用inspector/分配采样，不强制GC。`--long-switches` 则是另一个带profiler的750ms开关归因诊断，不能与阶梯混用或作为RSS预算样本。所有运行拒绝覆盖既有证据，必须串行占用本任务窗口并保留失败；统一结果见 `.scratch/remote-projects/performance-owner-result.md`。

`browser-probe.js` 可由 CDP `Page.addScriptToEvaluateOnNewDocument` 注入隔离生产 UI。监听真实 textarea 的 capture→window bubble 同步派发、下一 rAF、Long Tasks。不保存文本/剪贴板。`snapshot()` 明确记录局限：不包含派发后的微任务/延迟 commit；rAF **不是** paint；long task 重叠不是归因；DOM 不能代表 iOS 原生 UITextView。

可运行 Ego 的真实 50 次 typing 诊断（启动前要求当前选定会话、真实 textarea 可见、草稿为空，服务必须是隔离的生产测试实例）：

```sh
node scripts/remote-projects/measure-browser.mjs --url=http://127.0.0.1:PORT/SESSION_ROUTE --selector='textarea[KNOWN_SELECTOR]' --build=BUILD_HASH --dataset-hash=DATASET_HASH --scenario=local-typing --confirm-isolated-test
```

只操作此任务自己的 TaskSpace，不覆盖现有草稿，成功关闭任务页。失败后 CLI 输出 spaceId，后续用 `--space=ID` 继续同一空间。此工具不注入 fake DOM，不模拟已完成 UI。浏览器诊断不能代替 Electron 或 iOS gate。中文 IME 必须真实系统输入法；paste、undo、删除、picker 开/关后、5 路并发、弱网和本机/远端各 50 事件还需实际跑场景，并录制主线程 rendering trace/真实 paint。

## Hub 资源观测

```sh
# 长达 300/600 秒的观测应在上述专用 tmux 窗口启动。
node scripts/remote-projects/observe-process.mjs --pid=ISOLATED_HUB_PID --seconds=300 --confirm-isolated-test
```

用 macOS `ps TIME` 的进程累计 CPU 秒差 / 实际单调时间得单核口径 CPU%；RSS 转为 bytes。不是 `ps %cpu` 生命周期均值。记录每秒原始样本与 RSS 分布，不臆测每条订阅内存。必须另配同进程无订阅基线、逐条订阅阶梯实验、上下游请求/连接计数、Hub 所有权内 timer 计数；资源采样器本身的计时器不属于 Hub。未实现 owner timer 计数时 P4-17 不能通过。

## 25 个 gate 的测量边界

完整预算/测量定义在 `gates.mjs`，以 spec 为最终权威。报告按 gate 独立，不把一个场景推广到其他平台。

| Gate | 必要证据与 runner 边界 |
| --- | --- |
| 1 | owning Gateway/Registry 零 remote 项目确定性请求、订阅、timer/poll 计数；不能仅看 fixture 没收到请求 |
| 2 | 同配置生产 Electron/iOS 各≥20 次真正 cold boot；导航开始→sidebar 首 paint/transcript 首 paint；P50/P95 各≤5%回退 |
| 3 | regressions runner 原有 19 测试及单独 avatar；skip 仍是缺口 |
| 4 | L/同规模 local control 各冷启动；断网前已落 SQLite；不能等待连接再开始时钟 |
| 5–7 | UI Registry/真实 JSX 边界 selector 计数与引用相等；delta 结构工作与真实状态转换计数分别统计 |
| 8–10 | 浏览器 probe 仅辅助；Electron/iOS 原生输入与 paint trace、300 目录按需请求和 selector 计数必需 |
| 11 | 用户 click→cached transcript 真正可见≤100ms；禁用网络验证不等待连接 |
| 12 | click→最新权威内容/状态可见；warm/cold 及真实 LAN/Relay/SSH 分开统计 P95 |
| 13 | 同机同步时钟源标记上游 emit→客户端收到；减去同链路实测传输基线；不能减配置里的 RTT 常数 |
| 14 | 断网起点→离线 paint；恢复起点→补齐完成；记录序列验证无重复/无缺失/顺序 |
| 15 | 实际 TCP 丢包/真实弱网配置与 UI trace；weak fixture 不足以通过 |
| 16 | 外部另一客户端真实 start→Hub sidebar busy paint；LAN/Relay 都测 |
| 17 | 600s 无客户端；拥有者内部 timer 计数+上下游计数，不能仅看当前连接为0 |
| 18 | 300s 五 host idle 进程 CPU 积分<0.5%；SSE 一条/host；逐条内存≤10MB（10,000,000 bytes）；无周期全量拉取 |
| 19 | ≥9 条内容需求验证默认8容量、跨观察者共享与释放；LRU 只回收零观察者资源，不静默中断仍被使用的流；每条 RSS 增量≤30MB（30,000,000 bytes）；状态流继续可见 |
| 20 | 一个真实 fake upstream 卡30s，其他4 host 的 baseline/candidate 请求/刷新 P95≤10%回退 |
| 21 | 现有单 runtime 上限来自代码/契约；真实刷新并发峰值≤2倍且单 host≤原上限 |
| 22 | 完整操作后查询 Hub 全部持久化内容表（包括 transcript cache），远端 rows=0 |
| 23 | 真 iOS/模拟器 phone→Hub socket 记录；不能用桌面或仅上游 SSE 数替代 |
| 24 | 真实 App 后台/前台 lifecycle；后台释放宽限期按现有代码；已连接Hub前台最新≤2s |
| 25 | iOS 生产 L/同规模本机滚动 trace 无≥50ms任务且不回退；桌面 Chrome无替代效力 |

## 完整 Electron 生产 bundle probe（已实际运行）

`electron-production.mjs` 在新的 OS 临时 HOME/XDG/appData/userData 中，通过真实 Electron binary 动态导入目标目录**未修改的** `packages/electron/main.mjs`。使用真实 preload、同进程 Hub server、`yuri-ui://app` 生产资源，不是另造 textarea 或假 DOM。白名单继承环境，不读取用户配置/凭据。每个 run 先启动独立真实 OpenCode CLI，通过真实 session/import API 灌入 1 项目/1 会话/20 条消息，再开始 Electron launch 时钟。返回用户默认本机、窗口恢复和项目设置均只写入该 run 的临时目录。CLI 不进行模型推理。

目标目录须预先具有生产资源和匹配 Electron 的 native ABI；**不要在运行其他 agent 后端的活动工作树重建 ABI**。基线曾遇 Node ABI137/Electron145 mismatch，实际错误与基线独立重建日志已保存。

同一隔离 OpenCode 数据目录重启定向场景时，`startSeededOpenCode` 可显式传入已有 fixture 的 `reuseSessionId`：只通过官方消息接口核对已有非空 transcript，不重复导入固定 message ID，也不写草稿；缺失则阻断，不清理或覆盖数据库。默认新目录的 seed 行为不变。

```sh
# 只能对独立基线/候选目录执行这些现有构建脚本。
bun run --cwd "$ISOLATED_REPO/packages/electron" build:web-assets
bun run --cwd "$ISOLATED_REPO/packages/electron" rebuild:native
# 上述构建也应置于专用 tmux，使用干净环境；node-gyp verbose 可能输出环境，禁止携带凭据环境变量。

# 必须通过专用 tmux upsert 启动，20 个 run 串行；失败停住并留原始错误，不虚构20个样本。
node scripts/remote-projects/electron-production.mjs --repo="$ISOLATED_REPO" --phase=baseline --build=COMMIT --cold-starts=20 --opencode-binary="$OPENCODE_BINARY" --out=.scratch/remote-projects/performance/electron-baseline-20
# candidate 使用同一命令、同一设备、同一工具、同一构建/网络/seed配置，仅改 repo/phase/build/out。

# 独立输入 run：真实 keydown/char/keyup、Backspace、webContents.paste、webContents.undo。
node scripts/remote-projects/electron-production.mjs --repo="$ISOLATED_REPO" --phase=baseline --build=COMMIT --cold-starts=1 --input --opencode-binary="$OPENCODE_BINARY" --out=.scratch/remote-projects/performance/electron-baseline-input-native
node scripts/remote-projects/summarize-electron.mjs path/to/runs.json
node scripts/remote-projects/analyze-electron-trace.mjs path/to/input-trace.json path/to/trace-analysis.json
node scripts/remote-projects/archive-electron-evidence.mjs path/to/runs.json
```

`--headless` 只作环境诊断后备，不能和默认真实 GPU 窗口混为同配置。当前实际成功采集未启用 headless / disable-gpu。

冷启动终点：真实 sidebar/transcript DOM 已可见后，真实 `capturePage()` compositor 图像返回。保留 DOM 可见时间与截图；这是包含50ms轮询/截图开销的保守可见性上界，**不是精确 first-presentation timestamp**。Cold 指新 Electron+Hub进程、新 Chromium profile，不是重启操作系统/清 OS page cache；OpenCode 已在 launch 前独立 ready。生产 renderer + bundled UI 协议，但 shell 为 development channel，非签名安装包。不得据此宣称 signed packaged startup 已验证。

每个输入场景50次实际编辑操作，逐次断言文本长度、selection 和 focus，原始记录无正文/剪贴板内容。粘贴前只在可完整恢复已知格式时临时替换剪贴板，并在 finally 恢复；未知格式明确阻断，不丢失原格式。撤销用真实 Chromium edit command 并要求 `historyUndo` input，不能仅发送未生效快捷键算成功。`emulated-ime` 是50次真实 Chromium composition循环/100个input事件，但**不是 macOS 中文输入法候选流程**。

输入期间同时保留 Chromium JSON trace。分析器基于元数据定位 Renderer/CrRendererMain，统计真实 top-level task（包括同步派发之后微任务）及包含 input 的任务；GPU/worker 长任务分开，不能假冒 renderer任务，也不能从 rAF推断 paint。

当前真实 fixture **不是 L**，没有5路并发、远端项目或系统中文IME。因此这批数据是可重现本机baseline，不是整个P2通过证据。完整原始产物通过 archive runner白名单复制到 performance/artifacts（trace gzip + SHA256）；不复制profile/settings/DB/凭据。

**负载纪律**：本轮采集时其他实施agent仍可能构建/跑tests，全部既有样本仅为 `diagnostic`，不能用于正式预算或计算candidate回退。runner默认 `--classification=diagnostic`。正式采样由主agent统一安排空闲窗口，baseline/candidate串行运行；仅在确实排除其他构建/测试负载后增加 `--classification=budget --confirm-quiescent`。该flag不是自动证明空闲，也不会自动通过gate。每次run记录系统load average供复核，不能用低load代替独占/排程证据。

## 证据格式与汇总

内存验收沿用 spec 的十进制 MB：1MB=1,000,000 bytes；RSS 原始记录始终为 bytes。诊断展示可另外标 MiB（1,048,576 bytes），但不得把 10/30MiB 当成 10/30MB 的门槛。

`evidence.schema.json` 是单条记录 schema，`validateEvidence` 做无依赖运行时检查。记录必须附设备/OS/runtime版本/build/hash/命令、baseline 或 candidate、原始 artifacts、raw samples + unit。P50/P95 使用 nearest rank；失败、缺样本和未验证都明确保留。计数型 evidence 用 `runtime:'counter'`，不能伪装 UI 毫秒。

```sh
node scripts/remote-projects/run.mjs report path/to/baseline-record.json path/to/candidate-record.json
```

生成 `gate-report.json`；全部 gate 在人工核查运行时、场景、预算、语义和前后同配置之前仍是 `unverified`。不提供 `--force-pass`。
