# NSH Provider 删除 — 独占实现与交接

main 实跑追记：修订后的独立 runner 已在 NSH 真实引擎执行原 7 个 UI 场景，**7/7 通过**，包括 global/scoped、config/credential 部分失败、ACK 后权威回读失败及 env/runtime 来源禁止删除。全部使用内存 Host，没有删除真实 Provider、凭据或 Host 配置。该结果不替代 UIKit/真机或完整 Provider 页面视觉验收。

日期：2026-11-07。此文只覆盖 Provider 删除合同与生产接线，**不是完整 Provider/Settings 1:1 已验收**。其它能力与既有缺口仍须交付，不按 MVP 豁免。

本记录取代 `OUTER-SETTINGS-VALIDATION.md` 中“Provider 删除仅删除 auth”的历史实现结论；不改写其余能力或历史验证结果。

## Ownership 与证据等级

- 生产：`settings-providers.tsx`、`settings-provider-removal.ts`。
- 纯协议：`settings-provider-removal.test.ts`。
- 引擎交互待跑：`settings-provider-removal-ui.test.ts`、`settings-provider-removal-test-app.tsx`、`tests/settings-provider-removal-host.js`。独立入口只加载内存假 Host，不调用真实模型/配置/凭据。
- 没有修改 application/state/features/settings-collections/settings-projects/settings-basics/ios、Web 业务代码或翻译文件；复用已有十语言正式字典 key。
- **C** = 当前生产接线；**F** = 本轮实际执行的纯测试；**H/S/D** = 真实 Host/UIKit 模拟器/真机。本轮没有 NSH engine、UIKit、生产 build 或真实配置 mutation。
- 当前工具无子 Agent 派发入口，未派出下层 general；不伪造多层审计结果。

## 真实 HTTP 合同（已核当前源码与已安装 SDK）

Web authority：`packages/ui/src/components/sections/providers/ProvidersPage.tsx` 的 `handleDeleteProvider`、`providerConnectionQueries.ts`、`providerSourceQueries.ts`。

当前实际 Web client 是 `@opencode/client` **2.2.1**，不是根文档尚存的旧 SDK 名称。通过 `OpenCode.make` 注入只返回固定 JSON/204 的假 fetch，实际调用 `provider.list`、`integration.list`、`integration.get`、`credential.remove`，确认下列 URI，**没有网络访问**。Native 继续使用 `runtime.ts` 已有 SDK gap，由 Swift 注入认证。

| 阶段 | method / path | 成功形状与语义 |
| --- | --- | --- |
| Provider authority | `GET /api/provider?location%5Bdirectory%5D=...` | `{ data: ProviderInfo[] }`，从 provider 的 `integrationID` 定位；缺字段才按同名 ID |
| 连接 authority | `GET /api/integration?location%5Bdirectory%5D=...` | `{ data: IntegrationInfo[] }`；`connections` 只读取 credential ID/env 类型，不读取密钥 |
| Web 单项复核（Native 用同源完整 list） | `GET /api/integration/:integrationID?location%5Bdirectory%5D=...` | `{ data: IntegrationInfo }`；fixture 也服务既有 `SettingsIntegration` |
| 来源 authority | `GET /api/config/providers/sources?directory=...` | 直接 providerID→source map；`files: [{ path, scope }]`，scope=user/project/custom |
| 文件配置删除 | `DELETE /api/provider/:providerID/auth?scope=config&directory=...` | `{ success: true, removed: boolean, requiresReload: false }`；**无目录也必须保留 `?scope=config`** |
| Credential 删除 | `DELETE /api/credential/:credentialID` | SDK 返回 204；Native body=null；凭据 runtime-global，**不带 directory/location** |
| 删除验证 | 再读 Provider + Integration + 来源 map | Provider 必须消失，文件/凭据/env 均不可仍残留；失败不能退页 |

未指定目录时省略两类 GET 的 query 与 DELETE 的 `directory`；不伪造一个目录，也不把默认 auth scope 当作 config scope。

Host owner：`packages/web/server/lib/opencode/routes.js` 的 sources/DELETE 路由、`provider-sources.js`、`DOCUMENTATION.md` 的 Public exports。`scope=config` 同时删除当前 location 可见每个物理文档的 `provider[id]`/`providers[id]`，跨文件非事务，部分失败允许幂等续删；不删 credential、不 reload。Raw `GET/POST /api/credential` 受 credential-boundary 禁止，本实现没有调用或绕过它。

## 行为与失败恢复

1. 初始加载删除来源元数据；失败时保留 Provider/model 页面，禁用删除并给元数据 Retry。Env 与 runtime-only 来源分别展示既有本地化解释。
2. 用户点删除后重新 GET；Native AlertDialog 显示完整共享配置/凭据影响说明，Cancel/关闭不 mutation。安装的 NSH 0.4 类型返回 `{ action }`，不是 Context7 文档片段的裸字符串。
3. 确认后再次读取 authority，核心拒绝 env、无可删来源、坏响应、Host/page fence 失效，以及未经确认的新 credential/file/integration。不能只靠 UI disabled 保安全。
4. Config ACK 后立即 checkpoint；逐个删除已授权的 credential，逐个 checkpoint。失败保留原 detail/intent，禁用冲突的模型与 auth 编辑，按钮改 Retry。已 ACK 的配置/账户不重放。
5. Lost credential ACK 从 scoped integration metadata 核对；已消失的 ID 不再次 DELETE。Config 未 ACK 可重试同一幂等 file-removal 操作。失败不做危险回滚或重建凭据。
6. 写入后验证失败只保留页面并手动 Retry；全部写入 ACK 后重试仅 GET。环境来源在部分失败后出现同样禁止后续 mutation。
7. 只有 authority 确认 Provider 已移除才通知同 epoch+directory 的父 catalog 刷新并返回。没有 `location.reload`、服务重启、模型调用或默认 auth 删除兜底。
8. 出现未经确认的新账户/文件/不同 integration 时不会扩大旧 intent；保留页与失败，需要退出重新打开并进行新的明确确认。不能在旧 Retry 中偷偷删新来源。

## C/F/H/S/D

| 能力 | C | F | H | S | D |
| --- | --- | --- | --- | --- | --- |
| 全局与 directory wire、编码、scope=config、runtime-global credential | 已接线 | 纯协议通过；真实 SDK 假 fetch 确认 URI | 未测 | 未测 | 未测 |
| 原生共享影响确认/取消 | 已接线 | main 首跑卡 fixture URL；修后待 main 复验；纯 inspect 无 mutation 通过 | 未测 | 未测 | 未测 |
| env/runtime 来源门与确认后重查 | 已接线，核心再拦截 | 纯协议通过；混合文件/credential/env 与中途 env 变更均覆盖 | 未测 | 未测 | 未测 |
| 部分 config/credential 失败、lost ACK、坏响应、scope fence | 已接线 | 纯协议通过 | 未测 | 未测 | 未测 |
| 验证失败保留 detail、读取重试不重放 ACK | 已接线 | helper + 无 URL VM 纯协议通过；UI fixture 修后待 main 复验 | 未测 | 未测 | 未测 |
| 移除后返回与父目录刷新 | 已接线，局部 epoch+directory revision | main 首跑卡 fixture URL，修后待复验，不能声称引擎通过 | 未测 | 未测 | 未测 |

## 实际验证与 main 接手

- `bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-provider-removal.test.ts packages/nsh/settings-protocol.test.ts`：16:06:19 最终 **2 files / 35 tests 通过**（本轮 Provider 新增22项 + 既有协议13项），其中包括 files-only/credential-only/新来源/env重试；无引擎调用。
- `node --check packages/nsh/tests/settings-provider-removal-host.js`：通过。
- Settings design audit 两个本 scope TSX：通过；不证明 Native 视觉1:1。
- `bun run dead-code`：exit 0，已检查报告。CLI 字符串入口 `settings-provider-removal-test-app.tsx` 列为 unused，属真实 fixture 入口，不删除；helper 被生产与纯测试消费。其它全仓库报告未修改。
- `bunx tsc --noEmit --project packages/nsh/tsconfig.json`：**失败**。当前错误均报告于共享 UI 导入链：`QuestionAutoDelegateStatus.tsx` 的 DOM JSX、`button.tsx`/`i18n/context.tsx`/`sync-context.tsx` React/NSH JSX、desktop globals、`ImportMeta.env`、process.cwd 与 attachment 隐式 any；本 scope 文件未报错。未越权改其它 owner，也不把此结果写成通过。

main 串行执行（本线未执行）：

```sh
NSH_BIN="$NSH_BIN" bunx --package vitest@4.1.11 vitest run \
  --config packages/nsh/vitest.config.ts packages/nsh/settings-provider-removal-ui.test.ts
```

7 项已准备：global/scoped 取消→确认→父目录刷新、partial-config/partial-credential 留页与安全重试、验证 GET 失败留页、env/runtime disabled。之后需 main 自行 NSH check/build 与 UIKit/真实 Host/真机验收；不能拿纯测试代替这些证据。仅在明确授权的一次性隔离 Host 配置上验证真实删除，不用现有真实账户做破坏性联调。

## main 首跑红灯后的 fixture 修复

- main 报告 7 项 engine 均卡初始 catalog，screen 为 `URL is not defined / Retry / Custom / Providers`。这不是 Provider 生产删除已通过的证据。
- 本线新增 `settings-provider-removal-host.test.ts`，在 `vm.createContext({})` 中确认 `URL` / `URLSearchParams` 均不存在，加载真实 `tests/settings-provider-removal-host.js`。16:12:54 首跑 **48/48 红**，全部在首个 catalog 请求重现 `ReferenceError: URL is not defined`；不是靠静态搜字符串判定。
- 只改本 scope 测试 Host：复用当前准确的纯解析器 `tests/new-session-request.js` 的 `fixtureRequest`（未修改共享解析器）。每条路由分别限定 method、允许/必需 query、精确目录与已知 ID；拒绝重复 key（含编码别名）、额外/缺失 query、空/未知目录、错误 scope、路径后缀、绝对 URL、fragment、未知 method 与 body。初始 catalog 只接受 global 或 `/fixture/project`，之后锁定该范围。Credential 仍只接受无 query 的 DELETE，不存在 raw credential 读取兜底。
- 原有 7 项 engine 测试/断言完全保留；新的 50 项纯 VM 回归包含同样 7 场景的真实 Host 路由和生产 removal helper：global/scoped 初始读取/取消不写/成功删除、partial-config/partial-credential 注入失败与 checkpoint 重试、验证 GET 注入失败、env/runtime gate。其它43项覆盖负向路由/方法/目录（其中循环覆盖全部端点）。
- 16:14:36：下列命令 **4 files / 111 tests 全绿**，其中 Provider Host 无 URL VM **50项**、Provider removal **22项**、既有 settings protocol **13项**、既有 new-session Host **26项**。JS `node --check` 通过；再次 `bun run dead-code` exit 0，已检查本 scope 报告，仍只有字符串 CLI fixture 入口被列 unused，没有因此删文件。

```sh
bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/settings-provider-removal-host.test.ts \
  packages/nsh/settings-provider-removal.test.ts packages/nsh/settings-protocol.test.ts \
  packages/nsh/new-session-host.test.ts
```

本次未修改任何生产代码、引擎验收或类型绕行；未再跑整包 tsc（main 已交其它 owner 修 `draftStarters` type barrel graph）。没有运行 NSH engine/UIKit/build/H/S/D；请 main 继续按上面的原 7 项 engine 命令串行复验。

## 单脚本加载边界与每场景 Host bundle（最新状态）

- main 再跑 7 项不再报 URL，但全部启动失败：`could not load module tests/new-session-request.js`。原因是 `--web-host` 读取单脚本，不加载相对模块；上一版纯 VM 自带模块加载器，不能验证这个边界。
- 新增测试专用 `tests/settings-provider-removal-runner.js` 的 `withProviderRemovalHost`：按 `new-session-native.test.ts` 的现行合同，在 `OPENCODE_TMP_DIR` 或 OS 临时目录的 `opencode` 下为**每次场景调用**创建独立 `nsh-provider-removal-*` 目录；先 `bun build tests/settings-provider-removal-host.js --target=browser --outfile <absolute temporary>/host.js`，再把这个绝对路径交给 callback。结束或失败均仅清理本次目录。
- `settings-provider-removal-ui.test.ts` 的唯一 `nativeTest` runner 统一使用该 callback 包裹 engine spawn，故原 **7 项全部使用编译产物**，不是只改某一场景。NSH 按 web-host 路径隔离 headless Storage，因此每 case 的临时路径也隔离了 Storage。超时上限仅增加 Bun build 的预算；原有业务断言与严格 Host 路由未删除/放宽。
- `settings-provider-removal-host.test.ts` 同样使用这个 runner 打包真实 Host，然后在无 URL/URLSearchParams、**没有 require/import resolver** 的 VM 中执行 bundle。AST 校验产物无外部静态 import/re-export；检查每次 host 路径绝对且唯一、正常结束删除产物，并新增 callback 抛错时清理目录回归。原7场景路由与其余负向合同现在全部验证打包产物，不再验证有人工 loader 的源码。
- 16:20:07 同上纯验证命令：**4 files / 112 tests 通过**（Provider Host bundle VM 51、removal 22、settings protocol 13、new-session Host 26）。`node --check packages/nsh/tests/settings-provider-removal-runner.js` 通过；dead-code 再跑 exit 0，已检查本 scope，仍仅字符串 fixture app 入口列 unused。
- 本轮只改测试 runner、纯VM回归及本文，没有改 production、NSH capability、application/settings 或 main 的类型工作；没有新增 Host audit 调用，因此没有测试 audit 权限需求。未运行 engine/设备/生产build；7项 engine **仍待 main 按上面原命令串行复验**，不能把纯 bundle VM 通过当作 engine 通过。
