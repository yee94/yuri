# Desktop Header services：冻结接线与验证

本 slice 只新增 `desktop-header-services*`，不修改 application、desktop-chat-header、Settings 实体页、state、手机或 Host。**独立组件已实现，不代表 actual-root 已接线。**

## Web 对照与 owning boundaries

- `Header.tsx:258–393`：432px 上限 services 浮层，Instance/Usage/MCP 三 Tab；本 slice 仅提供 Instance/MCP **内容**，不建第二浮层、tabstrip、Chat 或 Settings。
- Instance：`ConnectedHostVersionUpdate` 顶行和 `DesktopHostSwitcherDialog embedded`，不是实例 Settings。32pt 连接图标、标签、transport/匹配 transport 的 latency/状态、当前 check、32pt default/new-window、SSH idle Connect、Add instance footer。embedded 不画普通 Dialog title/current/default summary、URL 或刷新工具条；当前 embedded 没有可达 edit trigger，不能凭旧 edit form 代码加编辑入口。
- `desktopHostSwitcherDisplay.ts` 是真实共享纯 display owner，直接复用；active 状态来自 runtime，不能旧 probe 当在线，Relay 不显示旧 direct ping。
- MCP：`McpDropdownContent`；配置与 v2 状态两读，名称并集 localeCompare 排序，8pt dot/状态 Tooltip＋名称＋受控 Switch，28pt refresh，列表高≤256pt，px12/py10、muted p6 卡片和 px10/py8 rows。零配置只展示原 configureInConfig 文案，**不是跳 Settings 取代 runtime panel**。GUI plugin 不挂载。
- 原 `settings-mcp-live.tsx` 是完整 Settings 组件，`SettingsIntegration` 也是带自身 lifetime/polling/form 的组件，不能挂入此 slot。全仓核对没有独立现成纯 MCP lifecycle factory；这里复用 `createSettingsLaneOwner/createSettingsTransaction/settingsRows/settingsObject/scopedSettingsPath`，只适配正式 runtime list/connect/disconnect，不声称复用了不存在的 helper。
- Web runtime slot 本来只有 Switch、状态与刷新，没有 OAuth 输入或 Instance 编辑表单。因此这里不复制 Settings 表单；原 SSH/连接/更新确认表单必须由窗口根已有 retained owner 承载，slot 关闭不 dispose 它们。

## 精确 API

```ts
import { createDesktopHeaderServices } from './desktop-header-services';
import { NativeDesktopHeaderInstance, NativeDesktopHeaderMcp } from './desktop-header-services-view';

const services = createDesktopHeaderServices({
  directory, // captured exact context；不得猜首项目。目录变更使用新 captured owner
  current,   // 稳定 Host/origin/authorization identity；不是 modal/暂时 readiness
  operation, // () => Pick<PageOperation,'current'|'request'> | null；稳定原 operation 对象
  instances, // 可选 DesktopHeaderInstancesPort，下述合同
  update,    // 可选 DesktopHeaderUpdatePort，下述合同
  changed: value => servicesSnapshot.set(value),
});
services.snapshot();
services.update({ tab: 'instance' | 'usage' | 'mcp' | null, active: boolean });
services.refreshMcp(configs = false); // 默认仅 status，与 Web refresh 相同；true 为显式部分失败 retry
services.refreshInstance();          // 两个已有 owner 的窄只读投影独立刷新
services.toggleMcp(name, connected);
services.reconcileMcp(name);         // 未知写的显式只读核验，绝不重发 POST
services.instanceAvailable(action, id?);
services.runInstance(action, id?);   // switch/connect/default/new-window/add
services.updateAvailable();
services.runUpdate();                // 仅委托已有更新 owner，不直接 POST
services.projectInstances(rows, capturedOperation); // 可选已有 owner push，零 GET
services.projectUpdate(projection, capturedOperation);
services.dispose();
```

纯 factory 不 import NSH/React/signal，不持凭据，无默认 sender/connection API。视图 props 都是 `{ owner, snapshot, directory? }`；`snapshot` 传 retained signal **读取**。视图无 mount/effect/GET，不从 slot mount 推断 demand。

### main 所需唯一 header 通知（本线程未修改 header）

```ts
onServicesTabChange?: (tab: 'instance' | 'usage' | 'mcp' | null) => void
servicesBusy?: boolean // 读取 servicesSnapshot().instancePending !== null；只控制services关闭/切Tab准入
```

语义是“**现在实际可见并被准入的 services Tab**”，不是用户最后选中的 Tab。打开/切 Tab 发对应值；关闭、Escape/Backdrop/Back、active=false、lane/identity 退休、cleanup 必须发 null。同步通知，不等依赖 slot mount 的 Effect；不得在关闭的 render callback 里发 GET。main 在窗口/Chat 的已有窄 lane/lifecycle effect 调 `services.update({tab,active})`；`active` 必须同时包含前台、非外部模态、原交互准入。Usage 不激活本 slice；quota 仍归原 metadata owner。禁止把 `active||syncActive` 当此处的可见 demand。

Web 的 `hostActionBusyRef` 还阻止切Tab/用户关闭；当前header没有注入这层busy。main须同步接上上面的只读`servicesBusy`：实例动作pending期间禁用Tab、忽略用户trigger/Backdrop/Escape关闭；**authority/lifecycle/外部modal强制退休仍必须关闭并发null**，不能用busy挡安全撤权。主Chat和Settings自己的busy不混入这个slot字段。核心也会阻止并发实例动作与切换中更新写，不靠header视觉禁用保护runtime。

```tsx
// 伪代码：仅说明消费合同，application 保持 main 独占。
onServicesTabChange={tab => {
  visibleServiceTab.set(tab);
  services.update({ tab, active: servicesInteractive() });
}}
services={{
  instance: () => <NativeDesktopHeaderInstance owner={services} snapshot={servicesSnapshot()} />,
  mcp: () => <NativeDesktopHeaderMcp owner={services} snapshot={servicesSnapshot()} directory={directory} />,
}}
```

当前 header 在 slot 外有 `p-3`，而本组件已实现 Web 原生内容 insets；main 接线时需移除 **这两个 slot wrapper** 的额外 p3（不影响 quota），否则形成双内距。本线程未碰 header。header 外层唯一 Scroll 保留；MCP 内层仅负责256pt局部列表。

### Instance port：复用真实 owner，不注册第二引擎

`DesktopHeaderInstancesPort.read(intent)` 只投影 root 已有 committed `app.connections/app.connection` 与原 SSH controller snapshot。返回 `DesktopHeaderInstance[]`：`id/label/transport/isDefault/display`；`display` 精确使用共享 `ResolveHostRowDisplayArgs`。不调用 `connection.list` 来建立平行 catalog，不把 SSH 安装中或未提交连接当 current。默认值未知不可填第一个连接；`isDefault=false`，`available('default')=false`。

`available(action,id)` 和 `run(action,id,intent)` 由原连接/SSH/导航 owner 注入，**动作最终提交前再验 intent.current()**。`switch` 走原 committed selection；SSH idle `connect` 走已有 start/admission/确认，不从 UI 构造 shell/Relay；Add 只打开原 remote-instance 设置入口，这个 footer 本来就是导航动作。default/new-window 没真实原生 owner 就 false，仍显示禁用按钮与 unavailable Tooltip。新窗口尤其不能用低层 AppView 或外部 openUrl 冒充。

返回 `{status:'accepted'|'failed'|'stale'|'unsupported'|'unknown'}`，禁止 void 冒充 accepted。切换 Host 成功使旧 intent 退休时，旧 slot 回执为 stale 合理；当前 Host 仍只由 root 的真实 commit 改变。列表不乐观设 current/default。已确认动作后回读失败保留 accepted 动作和独立 read error，不自动重放动作。

### Update port：仅原 About owner 投影

`read(intent)` 只调用已有 `about.hostUpdate()`，随后返回 `Pick<AboutState,'hostUpdate'|'updateBusy'|'updateFailed'|'updateUncertain'|'updateConfirm'> & {version?:string|null}`；可选 version 只能来自已存在的 committed serving-Host metadata / `AboutState.host.value.version`，不能拿 client/OpenCode版本补位。版本显示优先hostUpdate.currentVersion、再该真实fallback，均经原aboutVersion验证。即使更新nativegate缺失，也可注入这个**只读**port，available/nativeGate都false。不要调用会读 client/OpenCode/diagnostics 的 `about.refresh()`，不要创建第二 updater。已有 owner 的 pushed state 可 `projectUpdate(value,capturedOperation)` 注入；captured lane 不符/slot隐藏拒绝，push使同资源较早在途read失效，不让旧查询覆盖live进度。

更新写 gate 是 `nativeGate() && available()` 加本地最新精确 plan、supported、ready、非busy/uncertain/task/checkError。`nativeGate` 必须来自真实 native admission，**不是 HTTP POST 路由存在、bundle grant 或 NSH版本**。当前本地 Native Host 没有闭合的客户端更新签名/安装/恢复 gate，因此 main 必须保持 false；仍显示真实版本、可用计划和 unavailable，零更新 POST。若将来补齐 gate，`run(intent)` 委托原 owner 的 prepare/确认/confirm/unknown-reconcile UI，不在此生成确认框或安装命令；外部模态应暂停本 slot demand，原更新 owner的journal/表单继续保留。此 slice 不提供新的更新写路径。

## Wire、部分失败、授权和重试

- MCP 两 GET：`/api/config/mcp?directory=<encoded>` 和 `/api/mcp?location%5Bdirectory%5D=<encoded>`；runtime 返回正式 `{data:[{name,status,integrationID?}]}`，不是老版本 status 字典。配置仅保名称，runtime仅保closed display字段，不留headers/environment/OAuth secret。
- runtime POST `/api/experimental/mcp/<encoded-name>/connect|disconnect?location%5Bdirectory%5D=<encoded>`，没有 config enabled PATCH；成功后只 GET 状态再更新 Switch。v2 list 或 config 畸形/partial/logical failure不伪成功空；两资源独立保 prior，失败一个不抹另一个。
- warning dot/AX/Tooltip 保留 `needs_auth`、`needs_client_registration`；connected/switch仅由真实状态决定。connect后仍needs_auth为failed回执但保留真实warning，不能报 connected。**没有 native OAuth callback gate；本 slice 不新增授权按钮/自动OAuth attempt，不用 openUrl/copy 成功当授权完成。** 如未来需要从 runtime slot直接授权，须先抽出现有真正共享 lifecycle owner并提供native callback合同；此处不复制 SettingsIntegration 引擎。
- POST异常保守为unknown，当前行锁定，不改兄弟行。显示行内显式重试；`reconcileMcp`只GET，读失败继续锁，读到该行后解除unknown **仅允许下一次用户明确动作**，不声称证明旧POST回执、不自动重放。ACK后GET失败是failed，仍保prior和局部重试。ACK前开始的并发refresh不能充当写后核验：ACK使它失效并启动真正的后续GET，迟到旧状态不能覆盖新结果。
- 任意tab/modal/lane变化撤权全部旧job，立即settle stale，保存partialprior并清loading；在途pending mutation变unknown，旧finally不能解锁新代。只逻辑撤权，不声称物理abort。captured身份false永久退休，不能false→true复活。sameidentity operation暂停/恢复保prior；新Host/目录使用自己的新owner，不能搬旧form到新身份。
- 只有打开instance/mcp、实际lane恢复且该slot可见、显式refresh/retry才读。关闭、usage、外部模态零polling，全部代码零timer。重复同demand/lane update零发布/GET/排序/枚举；不把draft放入依赖。预算是50次input零新增services请求与owner构造，非整个App绘制耗时保证。

## 验证账本

```sh
# 固定 NSH 0.4.0 distribution 的 CLI；本地源码始终只读。
NSH_BIN=/path/to/nsh/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-header-services.test.ts \
  packages/nsh/desktop-header-services-native.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
bun run dead-code
```

- 最终聚焦 **2文件18/18通过**：17项pure owner/protocol测试＋1个真实native wrapper。pure覆盖constructor/hidden/usage零读零timer、50次同demand零额外发布/GET、名称并集、正确POST/GET路径、独立partialprior、malformed/partial/logical failure、modal/Host/lane/dispose晚到撤权、unknown只读核验、ACK前refresh竞态、update双gate、readonly pushedprojection fence、正确版本fallback、真实runtime/Relay latency和缺capability。
- wrapper 内实际运行 **macOS/Windows各4个交互场景，共8场景通过**：原生Switch/状态、Instance按钮与不可用gate、未知写GET重试、保留partial、modal晚到、50字符输入、hidden前后台零GET、成功空结果、中文窄窗。另运行 **每平台1个Frame场景，共2场景通过**：1000×700→360×500；surface最终336pt、refresh28×28、default/new-window32×32、MCP列表≤256pt、row宽≤312pt。全部用独立临时nsh.json/App/test入口，不碰共享 `.nsh/test`。
- 独立fixture经真实NSH bundle与QuickJS执行。整包tsc在首轮/最终扩大回归时通过；**归还前重跑被并行范围外变更阻断**：`desktop-header-quota.fixture.tsx:47` 仍传`onModeChange`，而当前quota组件props已不接受它（TS2322）。本slice未改quota组件/fixture；已交main，不能将之前通过写成当前整包通过。最后一次pure17/17仍通过。
- 最终扩大回归 **6文件67通过、1失败（68项）**：唯一失败在本slice范围外的 `chat-header-quota.test.ts:226`，provider bounded-read期望7groups，当前返回6。没有修改quota或其测试；已告知main。这不同于更早工作区状态下的49/49，不能把早先通过冒充最终合并全绿。
- `dead-code`未完成：加载`packages/web/vite.config.ts`时缺`vite-plugin-pwa`，exit2；未补装依赖。
- 没有执行git/GitHub、真实账号/凭据读取、Hostwrite、付费调用；Context7配额耗尽未重试。

两平台 headless 是 NSH真实组件/QuickJS/布局模型，不是 Windows executable 或 AppKit/Win32系统窗口、物理键盘、主题材质视觉签收。main actual-root tab通知、slot外p3移除、现有owner ports接线、真实Host/OAuth/SSH/更新均需另外验收；输入证据是操作数/保稿，不是完整App的P95/IME/paint性能结论。本独立slice已归还main，生产总目标仍有这些明确未完成项。
