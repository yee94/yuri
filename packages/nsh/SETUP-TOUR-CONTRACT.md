# Native Setup Tour 装配与验收合同

## 状态：独立模块已提供，尚未完成手机 1:1 验收

本次维护 `setup-tour*.ts*`、`history-import*.ts*`、本文，并在 main 明确 handback 后独占完成 `application.tsx` 的主装配。未修改 state/runtime/settings owner、Swift、`nsh.json` 或共享字典。源码已挂载实际 App；fake Host 与静态 bundle 不等于真实 Host 成功或 UIKit/录音/手势验收。

### 当前源码基线

- `packages/ui/src/components/onboarding/SetupTourHost.tsx`：当前手机通过 `MobileApp.tsx` 的 `<SetupTourHost autoStart={false} />` 显式重新打开，不照搬 desktop 的无项目自动打开策略。
- `SetupTourDialog.tsx` 当前是 **模型 → 扩展工具 → 历史导入 → 语音** 四步。历史导入不是可删除的 MVP 项；原三步目标保留，新增历史导入也必须保留。
- Magpie 推荐卡使用既有品牌 SVG/说明，选择后直接保存 `opencode-magpie-plugin`，不在 Tools 重复选择。Tools 初始选择与 Web 一致为 Eficy/profile，只有显式“保存并继续”才写入。
- Provider 入口使用当前六家 Web 选项和仓库原始品牌 SVG。豆包使用原始 `doubao.svg`，在 ASR/TTS 服务介绍中置首。不生成、不临摹图标；测试中的 synthetic metadata 不是生产 artwork 验收。

## 文件与 owner

| 文件 | 职责 |
| --- | --- |
| `setup-tour-core.ts` | Host-scoped 纯控制器、四步、选择/草稿、只读刷新、插件配置 ACK/未知结果日志、显式下一步/稍后 |
| `setup-tour.tsx` | `createNativeSetupTour` 构造工厂、`NativeSetupTourPage`：一个系统 NavPage、品牌入口、元数据/README Sheet、Liquid Glass footer |
| `setup-tour-voice.ts` | 豆包本地推荐草稿；复用 `createSettingsVoiceConfirmation` 的唯一写入/凭据/回读实现 |
| `setup-tour-details.tsx` | 独立详情路由；复用现有 Provider/Integration/Voice 页面及 `SettingsVoiceTests`；豆包表单与脏稿返回确认 |
| `setup-tour-test-host.ts` | 仅内存的严格 fake Host，不是发布桥/服务，不接触网络、文件配置、安装或麦克风 |
| `setup-tour-core.test.ts` / `setup-tour-production.test.ts` | 真实控制器、准备后的严格 Host bundle、真实 `runtime.bindRequest` 和 TSX 事件闭包测试；不使用 NSH 引擎 |
| `history-import-protocol.ts` | 复用 Web `historyImport.ts` 公共类型/来源/进度 helper，补 Native 边界校验；Web 没有运行时 parser，不另造 wire |
| `history-import-core.ts` | 五来源自动只读发现、60 秒 fresh / 5 分钟 inactive cache、选择、回执、写入日志、operation-only 换 lane 与单一轮询 |
| `history-import.tsx` | 原生 Tour 内嵌步骤、独立导入页、后台入口与任务页、原生回执 Sheet、统一进度/ring token、构造期 scope 工厂 |
| `history-import-test-host.ts` / `history-import-*.test.ts` | 独立严格内存 Host、真实 raw binder、生产控制器/事件闭包和类型闭包检查 |
| `setup-tour-progress.ts` / `setup-tour-application.test.ts` | Host 分区的普通 Storage step/dismissed、实际 application 命令/返回/精确关闭与 reopen 回归 |
| `application.tsx` | `projectSearchCommands` 显式 `setup-tour` 命令、实际焦点目录、单 NavStack 路由、共享后台任务入口、确认 foreground operation 恢复、README 安全路由与豆包 recognition adapter |

原生声明当前没有独立 `Form` 组件。表单复用 NSH 现有 `SettingsGroup`、`SettingsInput`、`SettingsChoice`，不是 HTML Form/WebView。NSH `Button` 用受支持的 `selected` 表达可访问选择状态，不使用不支持的 `accessibilityState`、cast 或忽略类型检查。

## main 最小装配接口

1. 实际打开 Tour 的动作中构造一次 `createNativeSetupTour({ directory, step, onMove, onClose, historyImport?, onHistoryJobsSettled? })`，并由该 route owner 保留 controller。
   - 工厂在**构造时**捕获 `captureHostOperation()`，稳定 display identity 为 Host ID/origin/authorizationID，operation 内含 immutable scope/generation/request/current。
   - 不在 onPress/Retry 偷换 sender。普通 hide 只撤需求；同 Host 新 foreground lease 由根 `createPageOperations` 确认后显式 `replaceLane(operation)`。旧异步仍固定旧 sender/ticket，不能在 await 后借新 lane。
   - 底层 sender 使用 `bindRequest(scope)`；旧 global request 只能兼容 GET，不能成为写入兜底。
2. 在当前 `NavStack` 直接挂 `<NativeSetupTourPage controller={tour} active={真实顶层且前台} ... />`。不要再外包一层 NavPage，不创建第二个导航栈。
3. `onOpenDetail(detail)` push 一个 sibling `NativeSetupTourDetailPage`，传原 directory、现有 SettingsCallbacks、真实顶层 active。
   - `{ kind:'provider', providerID }`：现有 `SettingsIntegration`，包括 key/form/OAuth/command/external 等原 owner 能力；目录完整传递。
   - `{ kind:'provider' }`：现有 `SettingsProviders` 目录，自定义 Provider 仍为首入口。
   - `{ kind:'voice', section:'asr'|'tts' }`：现有 `SettingsBasics` 的 Voice owner，携带 `voice.sttProvider` / `voice.voiceProvider` target。现有页面仍是完整 Voice 表单，不宣称已经拆成与 Web 完全相同的独立段布局。
   - `{ kind:'voice', section:'doubao' }`：本模块豆包凭据/TTS 资源与 speaker、自定义 ID、ASR 资源、context 表单。GET 只预填本地草稿；Save/音频 Test 才进入现有 Voice 确认 owner。
4. `NativeSetupTourDetailPage.onComplete` 接 `tour.completeVoice()`，由 `onClose` 一次性关闭相关 Tour 路由。它只在同 Host 的 Voice 步骤有效，允许显式已确认详情在 Tour 被覆盖时完成。
5. application 的 `SetupTourDetailRoutePage` 已注入**现有** `createSettingsVoiceRecognitionAdapter`：真实 capabilities、typed `expectedHost: operation.scope`、page/operation current fence、hide/换 lane/dispose 清理。`asrReady` 等真实 capability 完成才挂 tester，避免初始 null 被永久捕获。真正 unsupported 时保留 unavailable，不替代设备听写；TTS/ASR 均复用 `SettingsVoiceTests`，构造/打开不会合成或录音。
6. Native 工厂现在返回 `tour.historyImport`，**直接在第四步顺序中的第三步嵌入真实 NativeHistoryImportStep**；不需要 `onOpenHistoryImport` 占位跳转。`onOpenHistoryTasks` push `NativeHistoryImportTasksPage`，传同一个 `tour.historyImport` 和真实顶层 active。history owner 的显式“继续后台/完成”自动委托 `tour.completeImport()` 进入 Voice；没有由 main 发起导入的胶水代码。
   - 已删除 `onOpenHistoryImport` 旧占位接口与 unavailable 分支；`NativeSetupTourPage` 的类型要求带真实 history owner 的 controller。不能仅注入纯 `createSetupTour` 然后显示一个“未接入”导入卡片。
   - root 可挂 `NativeHistoryImportTaskEntry`，`controller` 必须是同一 owner，`active` 是根当前可见且前台状态，`onOpen` push 同一个任务页；它只读任务目录，不创建工作。
   - 独立导入页/任务页由系统 `NavPage` 直接 pop，保留默认返回键/手势；写入正在提交时才禁用 pop。可选 `onDismiss` 是已关闭通知，**不得再次 nav.pop**。关闭 Sheet 不关闭路由，关闭路由不 cancel/import/resume 工作。
7. `onOpenReadmeLink(url)` 接现有资源/链接导航 owner。README 使用 `TextView links="report"`，不让任意相对路径、Host-local 地址或其他 scheme 绕过现有授权/Relay 处理。没有该回调时点击明确显示错误，不暗中用浏览器兜底。
8. application 现在按稳定 Host/origin/authorizationID/directory 保留 Tour 与 history display owner，close/explicit reopen 使用同一 controller 的 `reopen()`，保 step/provider/plugin selection/preview/ACK/unknown journals。`setup-tour-progress` 仅把 Host 分区的 `{step,dismissed}` 存普通 Storage，没有秘密或 operation lease。不能用步骤/epoch/lease key dispose 重建 owner。
   - `replaceLane(operation)` 是确认新 operation 后的窄 seam：只替换 operation；立即核验 job/jobs/已知 exact ID，或刷新 plugin/config metadata，不自动重放 start/resume/cancel/dismiss/plugin POST。`ensureDiscovery()` 在首批 GET 核验后恢复 Web 的只读 discovery query/cache admission；后台目录不运行 scan。
   - 无 ID 的 source-start 继续 unknown，不关联 latest。旧 sender 的 late ACK/错误/finally 都不能改新 lane 的日志或忙碌 gate。真正 Host/origin/authorizationID 变化永久退役旧 owner；main 的 identity-keyed 根清理旧 owner，不能借同名 Host 重新激活旧日志。
   - Voice 表单复用现有 `createSettingsVoiceConfirmation.replaceLane`，保留草稿与 pending secret journal；豆包已配置但未重输 key 时只保存所选公开设置，不补发 secret。
   - 传入 owner 必须 `current()` 且 directory 与 Tour 完全相同，工厂 fail closed 拒绝错上下文。更换目录要保留旧 owner 的未确认日志，不允许把它的新一轮输入偷换到新目录。root 只挂当前共享任务 owner，避免每个列表/任务行各自读 jobs。
   - 若不传外部 owner，Tour 工厂会构造一个同捕获 scope 的 history owner，供单一路由生命周期使用，dispose 时一并清理。main 需要后台/重开连续性时应使用上面的外部 owner 模式。

装配形状（在实际 scope/目录 owner 中执行；不是在 onPress/Retry 重新捕获 sender）：

```tsx
const history = createNativeHistoryImport({
  directory: projectDirectory,
  onJobsSettled: refreshExistingProjectDirectory,
});
// 用户显式重新打开 Tour 时建立页面 controller，并复用尚有效的 history。
const tour = createNativeSetupTour({
  directory: projectDirectory, historyImport: history,
  onMove: rememberLocalTourStep,
  onClose: closeTourRoutesByIdentity,
});
// NavStack route renderer 中直接使用：
<NativeSetupTourPage controller={tour} active={isTopTour}
  onOpenDetail={pushExistingSetupDetailRoute}
  onOpenReadmeLink={openExistingScopedResourceLink}
  onOpenHistoryTasks={() => pushTasksRoute(history)} />
<NativeHistoryImportTasksPage controller={history} active={isTopTasks}
  onDismiss={notifyTasksRouteClosed} />
// 已有全局后台任务区增加同一 owner 的导入入口；不替代其他任务 owner：
<NativeHistoryImportTaskEntry controller={history} active={isRootVisible}
  onOpen={() => pushTasksRoute(history)} />
```

`onDismiss` 仅清理该 route 的附属状态。系统已 pop，不能再次调用 pop；`onOpenReadmeLink` 必须沿既有安全资源/Relay link 路由。Provider/Voice 的 `SetupTourDetail` 联合类型、详情组件 props 及 `onComplete→tour.completeVoice` 仍遵循前面的接口。没有改手机 `autoStart=false`，不添加项目为空自动弹出引导。

### 原生材料、图片与生命周期

- Tour 内容为普通 token 化卡片；仅 footer 一个系统 `glassEffect:'regular'` owner。README 为原生 Sheet，关闭/系统返回不进入 WebView。
- 当前元数据名称、description、icon、README、version 按 Host registry 返回直接显示，不从包名生成另一套介绍。缺失/失败显示正式本地化错误并保留可用快照。
- 原始品牌 SVG 是本地 import。开发者 `metadata.icon` 直接交原生 Image；真实远程图与 Host 相对认证图片的加载尚需 main/资源 owner 证明。不得用假图/首字母卡片冒充成功，也不得自行在 URL 拼接凭据。
- `onMove/onClose` 是 main 导航/偏好接点，不代表服务端配置成功。失败保留当前 step、选择和草稿。
- 只读加载与写入 busy 分开：初始 GET 卡住也能“稍后”、切步骤或系统返回。旧步骤结果被 turn fence 丢弃。真正写入期间阻止重复提交和离页。

## Host 协议与确认语义

### 插件与 Provider

- GET `/api/config/plugins?directory=…`，复用 `readSettingsCollection`，区分 entries/files；版本化 npm 包复用 `splitPluginSpec` 排重，不把本地文件当 npm 包。
- GET `/api/config/plugins/registry?specs=…&details=true&directory=…`，只查询两项 Tools 包的真实作者元数据。
- 显式提交复用 `settingsMutation('plugins', …)`，POST `/api/config/plugins/entry?directory=…`，body 只有 `{spec,scope:'user'}`。认可实际 Host `success:true` 后再 GET 确认配置项。
- 不调用 install/reload/check/update，不等待模型就绪。OpenCode 后台加载拥有后续安装/激活。
- `$schema/lsp` 的唯一补默认 writer 是 `packages/web/server/lib/opencode/plugins.js#createPluginEntry`：`{ $schema:…, lsp:true, ...existing }`，既有显式值优先。Native 不 PATCH 整份配置、不重复实现文件写入。fake 的 round-trip 与静态源码断言不替代真实文件写入验收。
- 其他 Provider 继续时 GET 当前 scoped provider catalog，拒绝 partial/没有模型的目录；不把失败当权威空集合。
- 每个包单独保留 confirmed/unknown 日志；部分失败不阻止另一包成功。ACK 后 GET 失败或 ACK 后列表暂缺，只重读，不重放 POST。未知传输结果也只 reconcile；明确 4xx/`success:false` 才可由用户显式再次提交。缺失权威证明时保持未完成，不猜测安装失败。

### 语音

- `/api/voice/settings` GET/PUT 完全复用现有 Voice confirmation owner 和公开 settings parser。
- 只有显式打开推荐表单后，才本地草拟 `voiceProvider/sttProvider:'volcengine'`、`dictationEnabled/showMessageTTSButtons:true`，打开/恢复从不自动 PUT。
- 未配置且没有真实输入 key 时阻止 Save。既有 configured 不回填 mask 作为 key；关闭 owner 清理 secret 草稿。
- 已 ACK 但回读失败保留草稿和日志；Retry/Save 只走同一 captured sender 的 GET 确认 lane，不能再次发送 secret。
- TTS resource/voice 复用现有 catalog。ASR 四项与 Web 的 `VolcengineSpeechSettings` 相同，保留未知已有 ID；播放/录音仍由既有原生 Voice test/recognition owner 处理。

## 已实现的原生历史导入与后台任务

逐项对照 `HistoryImportStep.tsx`、`historyImportQueries.ts`、`historyImport.ts`、`SidebarBackgroundTasks.tsx` 与 Host `history-import/DOCUMENTATION.md`：

- 五来源及 Web 使用的原始 SVG；installed/not-detected/unknown 三态、精确/估算计数、未知计数不伪造零、扫描状态。
- 每来源最多 `historyPreviewLimit=5` 个预览，保留 title/excerpt/updated、source 双入口选择、已导入 badge、空、逐来源错误、unsupported 状态。预览不是全量选择目录；start 按所选来源完整发现，与真实 Tour 相同。
- 进入 import 步骤后 GET `job` 成功且非 running，**自动** POST `scan` `{sources:五来源,limitPerSource:5,includeCounts:true}`，随后只读 POST `imported`。POST discovery 不是安装/导入，不要求先点“查找”。已移除该额外按钮；后台 jobs 读取失败不会阻止独立 scan/继续动作。
- 对齐 Web source query 的 fresh 60_000ms、inactive gc 300_000ms、retry=false、无 window-focus refetch。fresh reopen 复用样本；stale admission 才重扫；失败保 prior、显式 Retry；GC 惰性执行，不新增 cache timer。隐藏不会发新 scan，旧隐藏返回不会替换预览；用户 selection、未知日志不随 cache GC 丢失。
- Header 仅显示未 finished 且 running 或本次 accepted 的 job；历史 cancelled/interrupted 不冒充本次状态；completed/partial 都从 header/后台任务列表退出。只有 running header 画进度条。Next 的 running / 本次 finished 优先级与 Web 一致，不因旁路 catalog 失败或刷新中的 discovery 阻止“继续后台”。
- 显式 Next 才 POST `start` `{sources,directory,confirm:true}`。保存完整合法 receipt 和 accepted ID，GET `job?id=exactID` 确认；running/该次 finished/未选来源的继续语义与 Web 相同；selected sources 不因为返回/失败被清空。
- `cancel` 是协作停止，ACK 后仍 running 时记录 cancelRequested，禁用重复 cancel，继续观察。关闭/系统返回只关页面，不发送 cancel，不回滚已成功结果。
- 后台任务 GET `jobs` 按服务端顺序显示，失败/取消/中断保留；显式 `resume {id,confirm:true}` 只引用原选择，不传新 sources/directory；明确恢复失败后该行变 Remove；`dismiss {id}` 通过 exact receipt 的 dismissed 状态确认，不删除历史会话或其他任务。
- 完整保留收到的 phase 进度、计数、错误 code、status/项目/index 独立失败及 JSON 回执。Host `job` 最多返回 80 个近期/失败 receipt，并非全历史明细；Native 不再裁掉收到的结果，不拿 summary 的空 results 覆盖完整 detail。detail 缓存有 16 份上限，不持久化用户正文。
- Tour、任务页共用 `NativeHistoryImportProgress` 和 `NativeHistoryImportRing`。细条轨道=Host `surface.subtle`，填充=Host `primary.base`，失败=Host status.error；由既有根 appearance 的 context palette/cssVars 读取，未拿到主题时不猜色。ring 无百分比数字，unknown total 不伪造总量，动画服从 reduce motion/active。
- 多个实际可见 consumer 共享一个 owner、一条按需求合并的 refresh flight 和一个定时器。根 Projects 后台入口/任务页只需求 `jobs`，首次与后续轮询均不读 latest `job`、不 scan；只有 import 步骤出现才需求 `job`，成功且 non-running 后接纳自动 discovery。jobs 在途时进入 import，等待该 flight 后只补缺少的 job，不重复 jobs；离开 import 后仍可见的后台入口继续仅 jobs。running 1 秒、后台目录 idle 15 秒；Tour idle 不轮询、全部隐藏/后台/失效停止。running→非 running 的 query enable 边界按 cache 自动发现，永不轮询触发 start/resume/cancel/dismiss。
- 恢复的已知 pending journal 或用户显式查看回执允许额外 exact `GET job?id=…`；即使缓存已有同 ID 的旧 receipt，也必须重新核验，不能用旧缓存清除未知。没有 ID 的 start 保持 unknown，不读 latest 猜测身份。每项失败保留 prior 和对应 errors；首次 jobs 失败保持 `jobs:null/jobsReady:false`，不替换成空成功。

### 后台读取协议与 Web 依据

`packages/ui/src/components/session/sidebar/SidebarBackgroundTasks.tsx:87` 无条件挂载 `importJobsQueryOptions`，只读 `/jobs`，`retry:false`，running 每 1000ms、idle 每 15000ms；`historyImportQueries.ts:28` 的 staleTime 为 0。latest `/job` 归 `HistoryImportStep.tsx` 的 jobQuery 和 `historyImportQueries.ts:21`，不是后台入口启动所需。Native 以实际可见需求收窄读取，所有资源继续经 captured expectedHost/sender，未放宽 scope 或 fixture 前缀。

| GET 路径 | 响应与预算 |
| --- | --- |
| `/api/yuri/history-import/jobs` | 未 finished、未 dismissed 的完整 catalog 数组，服务端 `created` 升序；空成功 `[]`。每项 `{id,state,total,completed,created,results:[],failures,resumable,progress?}`。根入口首次 1 次；可见时按 1s/15s 单计时器刷新。 |
| `/api/yuri/history-import/job` | 最新未 dismissed 的完整 public job，或空成功 `null`。只在 import 步骤读取，running 时 1s；idle 不轮询。 |
| `/api/yuri/history-import/job?id=…` | 精确身份的完整 public job 或 `null`，可读取 dismissed 回执；仅已知 journal 恢复/显式 receipt/已接受任务核验按需读取。 |

完整 job 的字段为 `{id,state,total,completed,created,results,resumable,dismissed,progress?}`；results 合并最多 40 条失败和 40 条近期，按原 position 排序去重。`failures` 是 catalog summary 字段，不要求完整 job 必须包含它。服务端真源为 `packages/web/server/lib/history-import/store.js` 的 `unfinished/latest/get`。
- `onJobsSettled(ids)` 是原项目目录刷新 owner 的接点，只有成功 GET jobs 观察到实际 running→终态/退出才调用，main 必须将该回调绑定同一 Host/lease 的原目录 owner。回调失败单独记录 `errors.projects`，不把有效 jobs 变成失败或丢失；显式 Retry 只重试该已有端口，不重新导入。不能另造本地“导入成功”项目。

### 未知结果限制与恢复

- ACK 后 GET 失败：journal 保留 action、原 ID、acknowledged 和完整 receipt；显式 Retry 只读 exact `job?id`，不重放原 POST。
- 日志以 source-start/实际 task ID 隔离，`pendingActions` 暴露各自未确认动作。一个 source-start 未知不会阻止用户显式 cancel/dismiss 另一个已核验任务；同任务的未知动作仍必须先走 exact GET，不能重复 POST。`writing` 只序列化正在发出的提交，不把所有错误任务永久锁在一起。
- resume/cancel/dismiss 的未知回复固定核验同 ID；running/finished、cancelled/interrupted、dismissed 等对应权威状态才解除相应未知；不拿失败列表的数字作写入成功证明。
- **source `start` 的公开 API 没有客户端请求 ID，丢失整个回复时没有可验证的 job ID。** controller 保留原 sources/directory 与 unknown journal；即使 latest/jobs 恰好多了一个任务，也不猜它就是本次请求，不重发 start。此时继续只读查看/退出后台，保持未确认错误；无可靠协议不能伪造恢复成功。已知 ID 的 ACK 回读失败则完全可恢复。实现未新增 Host 协议、未修改服务端以假装解决此限制。
- 本客户端恢复由根确认新 immutable operation 后显式换 lane，不通过 latest sender proxy；首批恢复 GET、历史 metadata/draft/journal 保留。真正身份失效的 owner 不写新 Host、不刷新/关闭新 Tour。

## 文案与未验证项

全部可见普通文案复用现有正式十语 key（`tour.*`、`historyImport.*`、`backgroundTasks.*`、Voice/Settings/common keys）。本次不新增 key、不修改共享字典。README、包名、Provider 名、资源 ID、错误码/原始回执 JSON 是原始技术/作者内容。若 main 要比通用失败提示更明确地解释无法关联的 source-start，建议新增 `historyImport.resultUnknown`：说明请求可能已接受、请查看后台任务、不会重复发起；由字典 owner 一次性补齐十语，不用英文占位。

### 可复现离线检查

```sh
node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/setup-tour-core.test.ts packages/nsh/setup-tour-production.test.ts packages/nsh/history-import-core.test.ts packages/nsh/history-import-production.test.ts packages/nsh/setup-tour-application.test.ts
```

production test 在内存准备实际 fake Host 的 Bun bundle，以无 fetch/URL/WebSocket 的 Node VM 执行；真实 `runtime.ts.bindRequest(scope)` / `bindRawRequest(scope)` 再接严格 fake。拒绝未知 native 调用、错误方法/路径/query、额外字段、错误 scope/lease、未同意写入及音频/安装等越界请求；假任务仅在严格合成 Host 内处理。TSX 测试只执行真实事件闭包，JSX 节点作为 inert 数据记录，不是 NSH 替代渲染器。类型测试使用本仓库生成的原生声明检查完整依赖闭包，不过滤其他 owner 的错误。

实际结果由本次交付回复给出。静态 bundle 使用 Bun、NSH external 和 SVG text loader，仅证明 TSX/模块可静态打包，不是 NSH artwork 或 UIKit 证据。

当前回归覆盖实际 application 的普通 Voice 打开闭包（原 settings 路由、实际目录、顶层 active/operation、覆盖撤权）、单 observer/通知根、Tour 精确关闭/reopen，以及 Chat admission 首 token 仅 run、后续有效 token 仅 reconcile、null/重复/隐藏/stale 不运行。生产 TSX 回调覆盖真正 Tour 工厂→共享 history owner→start/exact receipt→继续后台进 Voice；另有隐藏 signal 采用计数守卫。最终测试数字和完整类型闭包阻塞以本次交付的实际结果为准，不沿用旧 84/84 或 97/97。

2026-11-07 21:07 的五文件实际结果：**107 passed / 1 failed（108 total）**。唯一失败为包含实际 application/App 的完整类型闭包：其它 owner 的 `chat-chrome-surfaces.tsx:13` 两项 `Bounds.height` 类型诊断；生成声明要求 `event.bounds.size.height`。未排除该文件或过滤诊断。选择器旧 5 项错误和 application closing-tag 语法错误均未再出现。同期实际 `App.tsx` 内存静态 bundle 成功，App.js **8,677,184 bytes**；未写出构建产物，没有调用 NSH 主构建或引擎。

顺序补入 application 的新会话 admission token effect 后，另执行 `new-session-admission.test.ts` 与 `new-session-recovery.test.ts`：**25/25 通过**，保持真实 owner 的旧 flight 等待、token 隔离、unknown 只读核验和 source 清理语义；未修改其实现或测试。

### main 接管后的修复与单例证据

以下为 main 在接管 application 后回报的亲测证据，本 owner 未重复执行：

- main 修正 `chat-chrome-surfaces.tsx` 的布局读取为 `event.bounds.size.height` 后，全包 **tsc exit 0，无诊断**。这解除上述类型阻塞；原五文件的历史结果仍记作 107 passed / 1 failed，不追改成已重跑全绿。
- 普通 Voice 的生产挂载问题定位到 `SettingsOperationPage` 的 JSX 转发：将 `{...{ operationToken: operations.operation() }}` 改为直接 `operationToken={operations.operation()}`。修前 `browser-preview` 单例在 rejected=[] 的情况下仍为 0 voice GET / 0 capability 调用 / texts=[]，1.38 秒失败；main 仅改这一行后，同单例 **PASS（1 passed / 31 filtered，2.24 秒）**。这是生产 JSX forwarding 的实际挂载差异，不是 history fixture 预算导致；此前 inert JSX 闭包测试不能覆盖该运行时语义。
- 当前 main 独占完整 9 文件 engine 组合重跑。尚无普通 Voice 全部 11 项矩阵或整个组合全绿的证据，不据单例通过宣称这些验收完成。application 保持 main 接管后的稳定源码，本 owner 只更新本文。

未执行：真实 Host、网络请求、插件安装、计费操作、录音/合成/播放、NSH 引擎、UIKit/设备、主应用构建、Git、依赖安装。`dead-code` 脚本依赖 `bunx knip`，本地没有 knip executable；遵守本次禁网络/禁依赖而未执行，不把缺少装配导致的未引用导出当作已验证死代码结论。

源码已装配实际 `App.tsx`；普通 Voice 的 browser-preview 引擎单例已由 main 验证通过，完整矩阵及组合结果仍待 main 回报，单例不能证明录音或 UIKit 成功。ACK/unknown journal 在同进程稳定 owner 内保留，尚未实现跨进程 journal 持久化。四步全部页面/弹层、真实 direct/Relay Host、作者图片、键盘、系统返回和 UIKit Liquid Glass 的实际验收仍未完成。
