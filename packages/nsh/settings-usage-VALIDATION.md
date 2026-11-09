# Native Usage：契约、接线门禁与验证

## 源码对照与已实现行为

| Web 来源 | Native 消费/行为 |
| --- | --- |
| `UsagePage.tsx` 243–265 | `usageAccountRows`：账户按真实 Host 顺序/ID 投影；账户组替代顶层兼容窗口，保留 user/plan/from、readAt、stale/error；accounts-only 不空白 |
| `UsageCard.tsx` 43–48 | `usageValueLabel` 与原 Web quota helper：余额、无限额、百分比组合、remaining 模式、未知不伪造 0% |
| `UsageCard.tsx` 48、86–108 | 原 helper 的 reset、pace、expected marker；一个页面时钟更新倒计时，不为行建 timer；prediction 读取正式设置 |
| `UsagePage.tsx` 89–117、269–375 | 直接复用 `model-families.ts` 的分组、family rank、显示名和默认匹配；每张模型卡与 Web 一样只消费首个窗口，真实模型键写入 |
| `UsageSidebar.tsx` 89–154 | 既有 Native Settings 控件提供 auto-refresh、30s/1m/5m、usage/remaining 与 prediction；设置仅 partial PUT 后 GET 权威回读 |
| `MagpieConnection.tsx` | 连接计数、不可用状态、折叠地址表单与显式保存；URL 在核心校验协议/凭据/query/hash，ACK 丢失仍只 GET；成功后只读一次 aggregate |
| `UsageSidebar.tsx` 158–201、`UsagePage.tsx` 61–70 | 注册 provider 使用实际 `QUOTA_PROVIDERS` 顺序，随后 Host 动态来源顺序；首次选实际已配置项，保留已有 builtin 选择，失效 Magpie ID 在权威列表后回退 |

Provider logo 直接消费现有 `HeaderProviderLogo`，没有新品牌匹配。warning/safe/critical 来自当前 Host 根 `nativeAppearance` 的 `contextUsageTokens.warning` 与 `cssVars`；包含自定义主题/固定模式/系统模式，无默认主题或前景色冒充 warning。根 authority 未到时不猜颜色。

Web quota helpers 带浏览器 i18n/Zustand 依赖，不能直接带入 QuickJS。`settings-usage-quota-source.mjs` 原样绑定既有 `quota/utils.ts` 的声明，仅注入 Native 翻译与时间 formatter；纯测试逐字检查 `settings-usage-quota.ts` 产物一致，不维护第二套公式。更新 Web helper 后运行 `node packages/nsh/settings-usage-quota-source.mjs --patch` 取得补丁，再应用与复验。

## 默认选择、空选择与 provider 恢复

- Web `UsagePage.tsx` 96–100 只在详情中存在 selected provider 与非空模型窗口时触发默认选择。Native 同样只在详情 owner 激活、settings/对应 provider 权威读取成功、该 provider 键尚未保存、原 `getDefaultModels` 返回非空集合时自动 partial PUT，再 GET 确认。
- 没有模型 profile、helper 默认集为空、首次 settings 失败、provider/source 失败、显式 `provider: []`、已有选择或未确认 draft 时均不自动写默认。
- 默认写入 ACK/回读失败保留 prior 与 draft；后续刷新/恢复只 reconcile，不 replay。确认后，未来真正的“偏好键删除”可以重新应用默认策略，不以进程内永久标记冒充 Host 设置。
- 新 `ui/src/lib/quota/model-selection-core.js` 是 import-free 选择语义叶模块：缺少 provider 键继承默认，显式空数组表示不显示任何模型。`{}` 或无有效 profile 不是清空所有 provider 的写指令。
- Native 和 Web 一样只在进程内记住 selected provider ID，不发明 Host 配置字段或持久化 Storage key。数据仍按实际 Host owner 隔离；Magpie ID 只有出现在本次真实结果中才恢复，不带旧 Host 快照跨 scope。
- `application.tsx` 已传 route.active，`settings.tsx` 已 spread 透传，**无需新增 main props 或修改两者**。

## 请求和失败预算

- 不 active/后台/销毁：0 新请求，0 timer。
- 手动打开/刷新：1 settings GET + 16 provider GET + 1 aggregate；最多 4 个 provider GET 同时进行。若首次合格默认选择发生，额外 1 最新 settings GET + 1 partial PUT + 1 权威 GET。
- 自动刷新：一个 owner timer 按真实 `usageAutoRefresh` / `usageRefreshIntervalMs`（默认 60s，范围 30–300s）调度 16 provider + 1 aggregate；正常不重复 GET settings。若已有未确认写入，先 GET reconcile，绝不 PUT replay。
- 倒计时与自动刷新共用这一个 timer，按最近 deadline 触发；interval 改变重设 deadline，暂停不累积后台 tick。列表没有倒计时行时不启动显示 clock。没有每账户/模型 timer 或 polling。
- 一次显式偏好变更最多 GET → PUT → GET；Magpie URL 确认后额外一次 aggregate，不重新读取其它 provider。
- 每个完成 provider 即刻按注册顺序发布，不等待慢/失败 provider；失败保留其 prior。Magpie malformed/failed source 同样不阻塞其它完整来源；incomplete 保留缺报来源，complete empty 删除旧来源，clearPrevious 清理授权失效来源。

## main 必须接上的真正 owning 合同

原 Host `packages/web/server/lib/opencode/settings-helpers.js` 的 Usage block 过滤 `provider: []`。其 `formatSettingsResponse` 也复用同一 sanitizer，且 `settings-runtime.js` 865–866 在 sanitize 后合并，因此 Native 不能靠 PUT ACK 或本地覆盖伪装成功。本轮 main 已实施下面的 owning 修复，实际写/read-response 门禁已通过。

**Host 最小修复（保留 owning 模块，不新增跨包依赖）：**

```js
// 原 validModels 的过滤保留不变，仅让真正显式 [] 通过。
if (validModels.length > 0 || models.length === 0) {
  sanitized[providerId] = validModels;
}
```

`@yuriai/web` 发布原始 `server/`，不要从该 sanitizer 直接相对 import UI 源文件。没有提供合法 provider 的 `{}` 继续不充当清空指令。

**Web `useQuotaStore.ts::applyDefaultSelections`：** 使用新共享纯 `defaultUsageSelectedModels(state.selectedModels, providerId, getDefaultModels(providerId, availableModels))`；返回 null 时不写，否则 set 其映射并 `updateDesktopSettings(patch)`。这把原来“数组 length 为 0 也重选默认”的缺陷收紧为“只有缺少 provider 键才应用默认”，否则 Host 支持 [] 后 Web 仍会把用户取消的模型重新加回。

**VSCode：** `bridge-settings-runtime.ts` 445–455 直接合并该字段，`settings-visible-runtime.ts` 1–13 原样保留可见字段；当前已经支持 []，无需为此修改。若 main 统一其净化策略，可用共享纯 normalizer，但不能丢失显式空数组。

`settings-usage-host-contract.test.ts` 是接线门禁，直接执行实际 Host write/read sanitizer、实际 Web action（从真实 AST 提取，仅隔离 React/网络）和实际 VSCode visible formatter。未接线时 Host/Web 两项 RED；接完必须全部 GREEN，不能以 Native mock 代替。

## 验证边界

- `settings-usage.test.ts`：原三项 RED → GREEN；账户、值、真实 ID、顺序、权威回读、ACK 恢复、失败保留与请求预算。
- `settings-usage-completion.test.ts`：默认持久化/provider 恢复/单 timer 的三项 RED → GREEN；另覆盖当前自定义 Host warning、明确空选择重开、默认 race、自动失败恢复、间隔净化、逐 provider 发布及 Magpie 部分失败。
- `settings-usage-static.mjs`：仅 Bun 静态解析/链接生产组件 fixture，不执行输出；检查没有 React/Zustand/TanStack runtime 越界，无主构建或 NSH engine。
- 普通 `tsc --noEmit` 与 Settings audit 已执行；最新具体结果以交付消息为准，不把其它 owner 的并行诊断算作用量通过。
- `settings-usage-fixture.tsx` / `settings-usage-engine.test.ts` / `settings-usage-fixture-config.mjs` 已准备真实生产组件及 synthetic canonical Host palette。**未运行 engine fixture**。
- UIKit/QuickJS 仍须按授权验证：十语长文本、账户分组、Switch 点击目标、Progress/marker 坐标、Intl reset/countdown、系统 Back/覆盖页/后台恢复。这是运行时验收边界，不是删减能力。
- 未启动 NSH engine/UIKit/设备/模拟器，未运行主构建、真实 Host、付费服务、Git，未新增依赖；没有修改 backend、VSCode、Web store、application 或其它 owner 文件。

### 最后一次本 agent 复验快照

- Native 两个纯测试文件：**40/40 GREEN**；包括真实 Host sanitizer 已接线后的清空 authority 回归。
- owning 集成门禁：Host write/read sanitizer 与 VSCode visible formatter **2 GREEN**；实际 Web action 的明确 `[]` guard **1 RED**，需 main 在其独占 Web store 收口。合并运行总计 **42 GREEN / 1 RED**，不隐瞒为全绿。
- `bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json`：**GREEN**。
- `bun packages/nsh/settings-usage-static.mjs`：**GREEN**，静态产物 5,289,192 bytes，`executed: false`；检查未引入 React/Zustand/TanStack runtime。
- Settings design audit **GREEN**；dead-code 已审阅，用量范围只有动态加载的 `settings-usage-fixture.tsx` unused-file 提示。
- 真正磁盘 persisted round-trip 由 main 后续 owning 测试补足；这里已验证实际 sanitizer 的写入和 response 净化、Native GET authority，不把内存 fixture 冒称磁盘落盘或真实 Host 联调。

## Desktop slice：当前 Web 事实与接线

本节覆盖本轮桌面改动；上面的旧“未运行 engine”与旧 RED 快照不代表本轮结果。

- 当前 `SettingsView.tsx::renderDesktopContent` 对 Usage 使用专用 `<UsageSidebar><UsagePage /></UsageSidebar>`，在普通 `kind === 'split'` 分支之前返回。`UsageSidebar` 的偏好、Magpie 连接在结果网格之前；`settings.css` 的 `.yuri-settings-usage-results` 是 192–256px provider 列和详情列，`settings-detail <= 768px` 时上下排列。**不是普通实体页的 304px 常驻 sidebar/detail split**，旧 parity 账本中的 Usage split 待办不能作为设计事实。
- 当前 Usage 来源中没有 period filter、日期范围查询、UsageSection 图表页或新增 Provider quota owner。Native 不添加相应控件或请求。实际能力包含刷新、自动刷新/间隔、used/remaining、prediction、Magpie 连接/手动地址、注册及动态 Provider、header 显示、账户/余额/重置/预测、模型 family 折叠与真实模型选择。
- `SettingsUsage` 原有 props **完全不变**。它在真实 `DesktopSettingsPublisher` context 中自动选择 `DesktopUsage`，否则保留原手机页面/子页 JSX。main 不需新增 props，不需修改 `application.tsx`、`settings.tsx` 或 `desktop-settings-root`。桌面 Provider 点击只改变同一个 owner 的选择，不调用 `onOpen`，不销毁 Magpie 草稿、pending receipt、family 折叠或 Settings publisher。
- 唯一 owning API 的向后兼容增量：`createSettingsUsage(...).selectProvider(provider: QuotaProviderId, inlineDefaults = false): void`。只有桌面传 `true`，把原本详情挂载时的默认模型选择交回同一个 operation/write lane；没有刷新 quota 或新请求 owner。普通移动调用仍使用默认 `false`。用户在已确认偏好写入期间选择另一个 Provider，默认选择等待同一 lane 完成；失活/换 lane 清除该待办，未知写入不重发，显式 `[]` 不补回默认。
- 生产窗口根仍只挂一次 `SettingsUsage`。`DesktopUsage`、`desktopUsageRows` 和 `DesktopUsageWindowProps` 是本模块内部呈现接口，不是要求 root 新建 controller 的端口。模型卡继续由原 `UsageWindowRow` 渲染，theme palette、官方 provider artwork、十语字典和 quota helper 沿用现有来源。

### 结构、预算与失败

- 一个外层 `Scroll`；Provider 与完整账户/window/family/model 元数据分别交给 NSH 0.4 的 `List viewport="parent"`，跟随同一个页面滚动，不制造两个独立滚动 owner。即使单账户有上千窗口，也不是一个 eager 巨型账户 View。所有模型和 Provider 均保留，没有分页截断或“只显示前 N 项”。
- 响应式条件读取整个 Scroll 的真实宽度，不用已经扣掉 content padding 的结果列宽度判断 768px。详情保持 Web 的 768px 上限、居中及 window `sm` 内距；resize 只改呈现，不重挂 owner。
- Provider 结果使用一次性派生 Map，避免动态来源的 provider×results 查找；不创建缓存/Storage/transport。结构派生只订阅原 results/selected/settings/collapse；Magpie URL 输入和外部无关 Input 不触发请求或模型目录重枚举。
- GET failure 与 configured-but-failed 的 Provider 不显示成功 no-data/no-quota 提示。原 operation 的 stale fence、部分失败、prior snapshot、未知写入 GET 核验与唯一 timer 保持归属，不以新的本地空数组替代失败。

### 本轮可重跑验证与边界

```sh
NSH_SETTINGS_USAGE_ENGINE=1 NSH_BIN=/path/to/nsh-0.4.0/bin/nsh \
  bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-usage.test.ts packages/nsh/desktop-usage-native.test.ts \
  packages/nsh/settings-usage.test.ts packages/nsh/settings-usage-completion.test.ts \
  packages/nsh/settings-usage-host-contract.test.ts packages/nsh/settings-usage-engine.test.ts
```

- 新 focused：账户顺序、完整窗口/模型元数据、折叠 family、failed vs empty、inline 默认选择、显式空选择、并发偏好完成后的串行默认选择；与既有 Usage/Host 合同一起运行。
- 新真实 NSH headless 生产组件：Mac/Windows 模型各 4 场景，共 8 场景；实际偏好/选择控件、无 route remount、草稿与 publisher 保留、header/模型实际写键、ACK 丢失只读确认、失活/后台/退休与迟到 ACK、resize、中文/波兰语、**50 次无关输入和 50 次 Magpie 草稿输入均零请求/零模型目录枚举**；2000 动态 Provider + 1000 账户窗口 + 2000 模型时只实现化 viewport 附近行。
- fixture 挂真实 `SettingsUsage`、真实 `DesktopSettingsPublisher` 与原 protection；仅注入内存 strict fake settings/quota，native network 请求和 Storage 都断言为空。临时 `nsh.json`、入口和 `.nsh/test` 在每次独立 temp 目录内，绝不覆盖仓库 `.nsh/test`。
- 原移动呈现（无 desktop publisher）的生产组件 engine fixture 同轮运行；不把它称为 UIKit/iOS 真机验收。
- Settings audit 通过；Bun 静态生产 fixture 解析/链接通过、无 React/Zustand/TanStack runtime 越界。`dead-code` 已尝试，仍被 `packages/web/vite.config.ts` 缺少既有 `vite-plugin-pwa` 阻断，没有安装依赖；仓库 lockfile 未修改。
- 并行工作区 `tsc` 的最终结果以交付消息为准；本轮遇到的诊断均在独占范围外，不能据此声称全仓 typecheck 通过。
- **尚未验**：真实 AppKit/Win32 窗口及像素/hover/读屏/物理键盘、完整 main App 接线、真实 Host/账号/付费 quota、网络/安全凭据与磁盘持久化。headless 测试只确认两平台逻辑模型与生产 NSH 组件，不授予完整 Mac/Windows 1:1 视觉签收。没有执行 Git、真实 Host 写入、真实账号或付费调用。

本 slice 最后一次复验：上述 6 个 Vitest 文件 **50/50 GREEN**（包含桌面 wrapper 内的真实 NSH 8 场景及原移动呈现 engine fixture）；`tsc --noEmit --project packages/nsh/tsconfig.json` **GREEN**；Settings audit **GREEN**；静态生产 fixture **GREEN**（5,403,126 bytes，`executed:false`）。`dead-code` 仍为上述依赖阻塞，不计为通过。并行源码后续变化仍须由 main 收敛后复验。
