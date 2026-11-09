# Header Instance：真实 root ports handoff

## 范围与真实来源

新增 `desktop-header-instances-root*`；仅在 `desktop-remote-connections-root.tsx` 增加窄公开投影/订阅/动作 API 和原 slot 的 mounted 计数，不重写原 slot/表单。services 只做 unknown transport 和 optional visible-only subscribe 的最小合同扩展。未改 application、HeaderRuntime、desktop-chat-header、state、Host、SettingsAbout 或 MCP 请求/动作。

- `createDesktopHeaderInstancesRoot`（`.tsx`）直接读取既有 `app.connections/app.connection/app.online` signals，底层纯 `createDesktopHeaderInstancesRootController`（`-core.ts`）拥有显示投影与 captured action intent。它不调用 `connection.list`、runtime GET、native discovery、SSH refresh 或更新API。
- 唯一 SSH source 是已存在的 `createNativeDesktopRemoteConnectionsRoot(...).header`。未创建 controller 时 `owner/state=null`，即使 bootstrap 已 cache 一个能力 port 也不能冒充 registry 已就绪；Header 永远不采用/创建这个 controller。
- Native `Connection` 只有 `id/label/url/lastUsedAt/authorizationID`，没有 kind/default/probe。全部未证明的 kind 为 **unknown**；不检查 URL、不用 localhost/loopback/label 猜 local/SSH/Relay，不把 HTTP 当 LAN。
- 唯一 SSH 关联是原 typed snapshot 的 `phase:'ready' + connectionID`，且对应 registry instance 存在、当前 committed connections 中有相同 ID、仅一个 SSH target 声明该 ID。多个声明歧义时不选第一条，不按 URL补关联。根保留原 committed 顺序，后接未绑定 registry 顺序，不按 identity 排序。
- 绑定行 `connection:<nativeID>` 直接用 committed label 和精确 native target；不重复增加 registry 行。未绑定 registry 行 `ssh:<registryID>` 来自 typed registry，因此 kind 确为 SSH，但不是已提交/当前 Host，不能点 switch。native ACK 中未知 connectionID 不生成 phantom native connection。
- 当前 check 来自 exact `id/url/authorizationID` 的 `app.connection`；在线只来自该 active connection 的 `app.online` live signal，不从 selected、probe 或 SSH prior推在线。无任何真实 probe producer，所以 latency 一律 null。default 全false、default/new-window availability 全false，入口仍显示，零猜测。
- remote failed/unavailable/unknown/busy 时保留其合法 typed prior（kind/registry身份），但不将旧phase作为最新live状态；Connect失败关闭。一个 SSH source失败不删除已知 committed兄弟连接。committed读取异常/畸形/未提交selection则 throw，services保留prior并撤销动作，而不是成功空集合。
- About 现有 owner 是页面私有；本 adapter **不提供 update port或版本 source**，不新建同一个 About/updater。main 继续缺 source，不猜版本、不额外GET。

## main 精确装配 API

```ts
import { createDesktopHeaderInstancesRoot } from './desktop-header-instances-root';

const instances = createDesktopHeaderInstancesRoot({
  current: () => workspaceAlive, // window lifetime，不跟当前选中的远程Host永久退休
  remote: remoteConnections.header, // 已有唯一root，不是新loader/controller
  switch: {
    available: () => /* 当前根已有switch准入能力 */,
    run: async (target, intent) => {
      // target: frozen { id, url, authorizationID? }；无token
      // intent: { from: frozen同形来源|null, current():boolean }
      // main用原 pageDeparture + filesguard，在异步确认后、真正提交前
      // 复验 intent.current()；再检查当前 target 的三字段完全一致。
      // 只由main调用既有switch owner，不在本adapter裸switchConnection。
      return await guardedSwitch(target, intent); // main拥有的真实动作回执，不能void当成功
    },
  },
  add: {
    available: () => /* 原remote-instance导航动作已准入 */,
    run: async intent => {
      // 同样原离页guard后、导航提交前复验current()，使用captured from。
      return await guardedAddInstance(intent); // main拥有的实际导航回执
    },
  },
});
// HeaderRuntime 已支持：
<NativeDesktopRuntimeHeader instances={instances} /* 原props */ />
```

返回值直接满足 `DesktopHeaderInstancesPort`，有 `read/available/run/subscribe`，并有 `snapshot()`（只返回显示prior引用）、`dispose()`。native wrapper随所属window cleanup自动dispose；重复dispose安全。纯controller测试入口接受同形 `committed:{read,subscribe}`；生产只用 `.tsx` 的原app adapter。

`available` 不枚举 native/SSH catalogs；只查上一份已准入投影和O(1)当前remote owner/state引用。真正动作的 `intent.current` 在**事件/异步确认时**复验：窗口、原services intent、captured from三字段、目标仍在committed catalog且url/auth不变；SSH还检查原owner与八字段精确target。rename不替换origin/授权身份；同ID换auth/URL或旧from变化使旧回调失效。main必须实际调用这个guard，不能仅消费availability。switch确实提交到新Host后旧services意图自然退休，services返回stale，不把它当可以重发switch的理由。

## 订阅/demand（已在 services 内消费，无需 main另起Effect）

`DesktopHeaderInstancesPort` 新增可选：

```ts
subscribe?(intent: {current():boolean}, changed: () => void): () => void
```

只通知“已有投影变了”，本身不枚举/读取catalog，不负责Host fetch。services仅在Instance实际可见、active、exact lane有效时注册；关闭、Usage、MCP、模态、lane/identity变化、dispose先撤权并unsubscribe。native wrapper没有观察者时，连app catalog signals都不订阅；有观察者时只读connections/selected/online三个leaf，不含draft。

原app或唯一SSH root发布变化→notification→services的**仅instances**只读read；不刷新MCP或updater。notification撤权旧instances read，即便push发生在在途投影Promise期间，旧read也不能吞掉push或覆盖新快照。同demand/lane重复update不重新订阅；同source引用显式refresh直接复用rows，不再枚举registry。所有Header路径零timer/零poll/零native read。

`read`的intent必须来自已准入的实际PageOperation，不能在原生bootstrap未知时伪造true，再将app初始空signals当完成catalog。Root是窗口保留owner，不在popup mount或每个render里构造；另一窗口使用自己的owner，禁止共享callbacks/selection。

## 唯一 remote root新增 API 与 SSH Connect admission

原返回 `{slot,dispose}` 兼容保留，增加 `header`：

```ts
remoteConnections.header.projection(): {
  owner: object|null; // 独立opaque身份token，只比较，不是controller对象
  state: DesktopHeaderRemoteState|null; // closed projection，定义见core
  available: boolean;
  connectAvailable: boolean;
}
remoteConnections.header.subscribe(listener): unsubscribe // 只监听原controller，零discovery/GET
remoteConnections.header.connect(exactTypedInstance, intent): Promise<Result>
```

closed state只含`ready/busy/failed/unknown:boolean/syncUnknown:boolean`及snapshot的`revision/saving/instances/statuses`；不透传原controller、receipts、preview/history或sync文档metadata。按原state对象引用缓存该O(1)投影，只借原数组引用，不每键复制/枚举registry。

原root构造可选增加一个**实际原确认＋离页/关窗保护producer**：

```ts
connectFromHeader?: (
  target: Readonly<DesktopSshInstance>,
  intent: {current():boolean},
  commit: () => Promise<DesktopHeaderServiceResult>,
) => Promise<DesktopHeaderServiceResult>
```

**当前代码原slot没有可复用的公开Connect确认流程**（原按钮直接controller.start），因此本slice不假称存在，也不提供默认确认/默认true。main没有真实producer就省略这个字段，idle Connect保留禁用。producer须复用实际原确认/原离页准入，并保证同一原controller的 pending/unknown 保持原关窗保护；单纯AlertDialog“同意”、bool或打开Settings不能证明已拥有这些保护。独立fixture的确认是合成注入能力证据，不是生产已接线声明。

具备producer后：原Settings slot仍mounted（即使inactive）时Header connect一律拒绝，不碰其draft/selection/picker/dirty owner；root不持第二表单。idle、native ready、非busy/unknown/failed/saving、exact instance八字段仍一致，才交原producer；producer确认后调用`commit()`，提交点再验所有条件。commit只准一次，重复调用绝不再start。明确准入后临时激活**同一个controller**，调用其原`start(id,'connect')`并恢复隐藏active状态；这一步可能触发该原controller已有的一次capability/read检查，属于明确用户动作，不是Header readonly refresh/polling。

accepted只来自原controller receipt承认“动作已接纳”，不等于SSH Ready或已切换Host。回执丢失保留原controller未知request/proof；Header关闭不清unknown、不cancel/disconnect、不dispose controller、不自动重发。显示/更新当前Host仍归原native提交/root同步，本slice不发新的connection.list来获取它。没有原producer调用commit却返回accepted也不会假成功。原slot的3秒可见只读轮询、dirty/pending/unknown与close逻辑均未改；Header不会开第二个timer。

## 验证账本

```sh
NSH_BIN=/path/to/nsh/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-header-instances-root.test.ts \
  packages/nsh/desktop-header-instances-root-native.test.ts \
  packages/nsh/desktop-header-services.test.ts \
  packages/nsh/desktop-header-services-native.test.ts \
  packages/nsh/desktop-remote-connections-core.test.ts \
  packages/nsh/desktop-remote-connections-native.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
bun run dead-code
```

- 最终组合回归 **6文件81/81通过**。其中新root **14项pure**：constructor/hidden零读、unknown不猜URL/label、nativeID唯一绑定/歧义/未提交ID、顺序/去重、闭合projection、source失败保prior/动作撤权、remote prior失效、50次availability与未变投影零registry枚举、exact callback/frozen target/from、同ID换auth及SSH字段变更的晚到guard、visible-only订阅、push撤权迟到read、void回执不当accepted。
- 新native wrapper实际运行 **macOS/Windows各5场景，共10场景通过**，使用真实`app`signals adapter、真实唯一remote root/discovery/controller、原Settings slot/publisher/protection与真实services View：未建ownerunknown、50字符hidden＋50字符open输入零额外Host/GET、同URL不关联、原生ID绑定、Header refresh零Host、committed push/失败prior、late auth guard、callback-only Add、idle SSH确认取消零start、已确认单次start/unknown保留、原Settings pending关闭拒绝、原dirty Cancel保稿/Discard后原Header恢复。未挂第二Settings slot或第二controller。
- 原services的双平台8个交互＋2个Frame场景回归通过；原SSH core13项＋native adapter35项也通过。所有测试使用各自临时nsh.json/App/test入口，无共享`.nsh/test`竞争。
- **整包tsc通过**（当前并行工作区）；新native fixture经固定NSH0.4.0实际bundle/QuickJS执行。指定NSH源码只读；未重试配额耗尽的Context7。
- `dead-code`被既有缺失`vite-plugin-pwa`阻断：加载`packages/web/vite.config.ts`失败，exit2；未补装依赖。

所有native测试使用严格合成Host与独立临时入口；只注入合成公开metadata，不触碰真实SSH/用户凭据/Host/模型，不执行git/GitHub或付费调用。headless是NSH组件/QuickJS的Mac/Windows平台模型，不等于AppKit/Win32系统窗口、实际网络、物理输入、视觉材质、生产离页/关窗producer或完整App输入P95验收。**main实际application注入仍待main完成**；SSH Connect若没有真实原确认＋close保护producer仍不可用，About/update source仍缺失，不能把合成测试称为这两个生产缺口已补齐。
