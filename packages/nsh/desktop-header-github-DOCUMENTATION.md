# Desktop Header GitHub：真实共享 status / selection

本切片拥有 `desktop-header-github*` source/view 及专项测试；本轮仅在原 `settings-github-core.ts` / `settings-github.tsx` 补可选共享 status 消费，不改 root、application、desktop-chat-header、四层 Settings 注入、state、Host 或配置。生产 actual-App 装配由 main 独占。

## 源码结论，不沿用旧计划

- Web `Header.tsx:152`：`!githubAuthStatus?.connected || isMobile` 直接返回 null。**没有已连接快照时没有 GitHub 按钮、空状态或“去设置连接”的入口**。不能拿 connection label、原生 Host 是否连接或 CLI availability 当 GitHub connected。
- connected 且 accounts 数量为 0/1：24px 只读头像容器，有 connected/login tooltip，**不是按钮**，没有选账号或设置导航动作。头像没有/加载失败才回退 GitHub glyph。
- accounts > 1：账号菜单；当前 user 决定 trigger 头像/login；菜单按原 accounts 顺序显示 `name.trim() || login || GitHub`、`login · CLI/OAuth` 和真实 current check。current 项不发送 mutation。
- Web 数据只有 runtime-scoped `githubAuthQueries` 一个 query；激活是 `POST /api/github/auth/activate` body `{accountId}`，ACK status 更新同一 query。没有 Header OAuth/connect/disconnect/刷新账号按钮。
- 现有 NSH `SettingsGitHub` 确实在页面内创建私有 controller，不存在可直接登记的全局 status source；它已有公开 `dependencies?: GitHubDependencies` 注入口。新模块复用现有 `settings-github-protocol.ts` 白名单解析、source+id selection key、头像校验；不创建另一个 `createSettingsGitHub`、device flow、timer 或 token cache。

## main 冻结 API 与共享前置条件

```tsx
import { createNativeDesktopHeaderGitHubSource } from './desktop-header-github';
import { DesktopHeaderGitHub } from './desktop-header-github-view';

// root 同一 Host authority 的唯一实例，不是每个 Header/Settings/file 的实例。
const source = createNativeDesktopHeaderGitHubSource({
  scope: { host: capturedRuntimeScope, directory: capturedDirectory, authorityKey },
  current: capturedIdentityCurrent, // Host/origin/auth + owning scope，不能混 modal/active
  operation: currentPageOperation, // () => PageOperation | null；必须传真实 captured operation
});
const github = source.header({
  current: capturedIdentityCurrent,
  directory: currentDirectory, // 实际目录 accessor；与 source 捕获值不同时拒绝读/写/显示
  active: readDemand,
  interactive: canInteract,
});

// 一次初始/明确 demand 进入调用；不是每个 render、input、status change 的 effect。
void github.ensure();
<DesktopHeaderGitHub port={github} onOpen={() => header.close()} onResult={handleExistingFeedback} />

// 真实 Git Settings page 使用相同 source，自己的 PageOperation 与 active/interactive guard。
const registration = source.settings({
  current: settingsIdentityCurrent, directory: settingsDirectory,
  active: settingsActive, interactive: settingsInteractive,
  operation: settingsPageOperation,
}, existingOpenUrlOwner);
<SettingsGitHub active={settingsActive()} dependencies={registration.dependencies} /* 原 props */ />
// 仅原 Settings flow/pending/cancellation 已结算后撤销 registration。
// 原 controller dispose/cancel 仍由 Settings 拥有；不能先断开 adapter 再尝试取消。
registration.dispose(); // boolean，pending/unknown/flow 尚存在时 false，不假称已释放
```

### 不能只接 Header 而忽略 Settings

薄 root 与四层 Settings 注入已由另一 owner 完成，合同见 `desktop-header-github-root-DOCUMENTATION.md`。现有 `registration.dependencies` 的对象透传自动携带本轮可选 `sharedStatus`，**root 不需要增加 getter、effect、请求或 remount**。source 的 `settings()` 一次只允许一个页面登记，重复登记拒绝。

实际 App 须同时装配 Header 与这条 Settings slot，不能把 Header 的 source 当长期第二读源、让 Settings 继续独立读取同一资源。新专项测试直接复用既有 root fixture，不修改 root 文件，运行真实四层注入与原生产 Settings 组件；不据此声称实际 App 已接线。

桥接后的 Settings controller 只保留页面展示/交互/OAuth 流程状态；GET status 与 POST activate 实际都经过这个 source 的唯一 cache/flight，Header 消费同一 projection。Settings 显式刷新仍会 GET，同一时刻读取合并，不拿旧 cache 冒充显式刷新成功。Settings 在已发 Header mutation 中途进入时，等待该 mutation 结算后再 GET；若 modal 撤销了较早 Header 读取，最多交接一次到实际 Settings operation，不是 timer/poll。其它 OAuth/CLI/删除 wire 只转交原 controller 通过传入 PageOperation 执行，原控制器的 `changed` 回调登记其 busy/flow/pending/readback 锁。不能吞掉 `registration.dependencies.changed`（现有 SettingsGitHub 已会调用它）。

Header busy/unknown 与原 Settings 设备流程互斥；取消允许与原 in-flight complete 并行，不能把原安全取消排在一个永久挂起的 complete 后面。只有原 Host 的 confirmed cancel ACK 才能解除这条 cleanup 锁；没有新 OAuth timer 或 token/code state。

### 可选共享 status 消费端口（本轮闭环）

```ts
type GitHubStatusSnapshot = Readonly<{ status: GitHubStatus | null; stale: boolean }>;
// GitHubDependencies 的可选字段；source.settings() 已提供。
sharedStatus?: {
  snapshot(): GitHubStatusSnapshot | null;
  subscribe(listener: (snapshot: GitHubStatusSnapshot) => void): () => void;
};
```

- snapshot 不发请求，只读同 scope/current/仍登记页面的白名单完整 status；无快照用 null，不伪造 disconnected。订阅不立即回调，仅在 source 的 authoritative adopt 通知；失败、busy、input 不广播。退订、registration 释放与 source retire 均撤回观察权限，旧页面不能接收新页面通知。
- 原 `createSettingsGitHub` 在构造时静默播种并订阅；只更新 `{status, stale}`，不改 `flow/removal/pending/issue/reconciled/connected/exchanging/needsReadback/cancellation`，不重置 timer 或清理锁。`dispose` 退订，原 `replaceLane` 依照既有生命周期撤旧订新；没有新增 controller/OAuth owner。
- 原组件初始化允许同步订阅回调先于 signal，随后以 controller 当前 state 建 signal，不访问未初始化变量；构造播种本身不发布 changed。
- Header ACK → 打开 Settings → 首次 GET 失败，仍展示共享 last-confirmed current、原错误与显式 stale。共享模式 stale 阻止普通写动作，显式刷新与原 OAuth 取消仍可用；无 sharedStatus 的私有 iOS 路径保留原请求、动作及生命周期行为。
- Settings 自己的 activate ACK 也更新同一 source，并回送同 controller；ACK 后读失败不重复 mutation、不释放 needsReadback。订阅即使展示了 pending 目标也不能确认 unknown；只有原严格 GET 回读分支才能 reconcile。桥额外拒绝 `unknown` 但实际 GET 失败的旧 prior，不能把未知结果标签当读取成功。
- status 订阅的 changed 反馈只登记原锁；锁和 issue 没变时不再通知 Header，不从 controller 反向 adopt，不造成反馈循环或重复 projection。50 次无关读取/输入验证零额外 status I/O、订阅重建、Header 投影或 remount。

传输未提供的能力不能伪造：当前默认 PageOperation 的 bindRequest 会在 HTTP 失败时丢掉 GitHub 响应 body.code；原 Settings 的 raw request adapter 则会保留特定 negative-receipt code。因此注入桥后，若 main 仍使用这个默认 PageOperation，某些 Settings 删除明确拒绝会保守降为 unknown，不能宣称完整保留 raw adapter 的负回执体验。桥原样保留传入 request 已提供的 typed error，不从 message 猜 code；main 需要 owning transport 的真实 typed-error 合同才能补齐这部分，不能在本模块另起 raw sender。Header activate 的既有未知语义不因此变为乐观成功。

### root / scope 生命周期

- Header 新视图替换原 GitHub rendering 分支，不再同时画旧的 GitHub props 入口。不要以 Settings 导航替代 `port.select(key)`。
- `DesktopHeaderGitHub.onOpen?: () => void` 只在 available 且菜单关闭→打开时同步调用，用于 main 先 `header.close()` 收起 services/apps/mainmenu/contextdetail，随后 view 再复验真实 port.available 才打开自身菜单。只读单头像、构造/effect/render、关闭事件和当前已打开状态不触发；回调不是写授权，回调导致 modal/retire/撤权时不打开，也不发请求。
- 若 main 暂时复用旧 Header 动作 port，账号 action value 必须是 projection 的 `key`（source+id），最终调用 `github.select(key)`，不能把原始 id/login 当 key。新视图已经正确使用此合同并带 CLI/OAuth 文案。
- 同一 source 可以服务同一 captured Host/directory 的 Header、Settings 与多个只读 consumer；不要每次弹层/模态或 50 个输入创建 source。Web 的 auth resource 是 Host-global，所以切目录时也不能并行产生两个可写 owner；必须保留/结算旧 owner，遵守 `source.dispose()` 的 false，尤其 unknown 不得通过重建 source 洗掉。
- Host/origin/auth 退休不可复活；PageOperation 还必须有同一 captured runtime scope/lease。directory 在 dispatch 和 continuation 都精确核验；没有给 global auth CGI 擅加 directory query。
- modal/inactive 只撤销 guard，保留 prior；菜单关闭，不做读、不丢 projection。已发 mutation 不承诺物理取消：同 scope 的有效 ACK 可以更新权威数据，但 modal 后不回调迟到 UI feedback；若 PageOperation/authority 已失效则保留 unknown，不采用为成功。
- 销毁或窗口关闭要保留 existing Settings pending/unknown guard；`source.dispose()` 对在途 mutation、unknown activation、原 Settings flow/unknown 返回 false。它不是磁盘或跨进程屏障，不提供并行 Engine/窗口的 CAS 授权。
- 真正 Host/owner 销毁时先 `source.retire()` 永久撤销 callback，再尝试 `dispose()`；retire 不声称在途写入已取消或结算，也不清 unknown。不能只在 JSX cleanup 中忽略 dispose false，然后让晚到回包访问已销毁的 signal。不能借 retire 给同一 Host 创建第二 writer、洗掉未知结果；不同 Host 的新 owner 不接收旧回包。

## 窄 Header port / projection

`DesktopHeaderGitHubPort`：

| API | 合同 |
| --- | --- |
| `state()` | `{projection,reading,busy,stale,issue,pending}` 的只读当前值 |
| `visible()` | 只在真正 connected 快照、当前 owning identity/directory 下可见；inactive 同 scope 仍保留 |
| `interactive()` | 当前 captured operation + active + interactive 的动作反馈许可，不拿 pending 伪装 authority |
| `available()` | 真实 owner 内 mutation gate；还检查 read/write、stale/unknown、Settings OAuth 锁 |
| `ensure()` | constructor 零读；明确首次 demand 只读一次，已知/已失败不因输入重复读取；原 Settings mutation 标 dirty 后下一次明确 demand 可读取 |
| `refresh()` | 显式 GET/reconcile；失败保 prior，不做 OAuth、不重发选择 |
| `select(key)` | 原 CGI POST `{accountId}`；current 为 noop，source 歧义/保留 id 拒绝；原 Settings 可激活 disconnected 下已存账号，但 Header 不画假入口 |

projection 只含真实 login、已校验 public avatar、原序 accounts 的 `{key,id,source,current,label,login,avatarUrl?}`；不向 Header 暴露 email/scope/token/device code/raw dump。共享 source 私有 status 仍用原 Settings 协议的白名单字段，供原页面展示；不写 Storage 或日志。

结果 `accepted/failed/unknown/stale/unavailable/identity/noop` 明确分开。有效 activate ACK 必须 connected 且原目标 source+id 为 current。request reject、malformed/wrong-target ACK、撤销的 PageOperation 都不是明确未提交证明：保留 prior/pending、禁止重发、不能靠关菜单清 unknown。GET 只有匹配到原目标 current 才消除 unknown；读到原账号仍保持锁。没有新增 Web 不存在的 retry/accept/连接账号入口，main 可用原 Settings 显式刷新恢复。

status 缺失/失败从不制造 connected；成功 disconnected 清显示。Web 类型允许 accounts 缺省，按 Web 投影为空数组（只读头像），不伪造账号。oversize >200、重复身份、多 current、无合法账号 user 等 malformed response 拒绝整批，不截断或抹掉 prior。availability 用已发布的 reading 状态，不依赖尚未 finally 清理的 Promise slot，避免请求结束后按钮永久 disabled。

## 头像与 native 权限

Header 与现有 Settings 使用**同一个** `gitHubStatus` avatar 白名单，仅接受 `https://avatars.githubusercontent.com/u/<数字>` 以及其 `v/s` 数字参数。UI 在交给 Image 前再次调用该原校验，拒绝 Host 相对 URI、file/data/HTTP、其它 origin、userinfo、token/bearer query。不生成鉴权 URL、不把 bearer 写 URL、不从 Host credentials 代理下载。图片失败稳定 fallback，新 URL 重建其局部失败状态；只读头像有真实 connected tooltip。

固定 NSH 0.4 的本地 `sandbox-and-capabilities.md` 说明 remote Image 以及每个 redirect 都受 network capability 检查。生产配置 grant 由 main 单独负责，未授权时 fallback；精确声明为：

```json
"network": { "http": [{
  "host": "avatars.githubusercontent.com", "methods": ["GET"],
  "schemes": ["https"], "port": 443, "pathPrefixes": ["/u/"]
}] }
```

无需 `hosts:["*"]`、Host bearer 或通配外网权限。本切片没有改配置，不能声称生产远端图片已经加载验收。测试临时 config 使用上面的精确 grant，但整个 NSH 子进程另受 macOS sandbox `deny network*`，只验 Image 节点与拒绝/fallback 行为，不触达真实外网或账号。

## 验证与未验

pure tests 覆盖真实 Settings controller 与 source 共用 status/selection、唯一 OAuth lease/timer、取消并行、安全 avatar、connected null/false/optional accounts、unknown 精确 GET、ACK/歧义 identity、directory/lease/Host/late/modal、50 次 ensure/projection 零网络/枚举/通知等。

native test 使用独立临时 config/App/test、真实生产 `DesktopHeaderGitHub` + native source + PageOperation 形状的 captured bindRequest，以及原 `createSettingsGitHub`；Mac/Windows 各验证 unknown/disconnected 无入口、single avatar-only、多账号 labels/current/真实选择、Settings 共用、失败/unknown只读恢复、Host 迟到、模态/后台、50 input 零读/写/数据投影工作/重挂，另验 modal 后无迟到 action feedback。全部网络由 OS 拒绝，只使用合成账号和内存 Host，绝不执行真实 OAuth/Host 写入。

本轮 `desktop-header-github-status-native.test.ts` 在不修改 root fixture 的前提下，补真实 Settings 首读失败保 prior/stale、Settings ACK 后读失败、unknown 跨关闭尝试/前后台、OAuth flow/cleanup 保持，以及 50 次无关输入的验证。`desktop-header-github-native.test.ts` 补 onOpen 父浮层关闭、callback 后撤权拒绝打开；原 modal/late 场景继续运行。

仍需 main 完成 **Header actual-App 装配** 与头像 capability；还没验证 AppKit/Win32 视觉、真实公共图片加载、真实账户/OAuth、多个 native Engine 的同步或 crash persistence。默认 PageOperation 丢删除负回执 code 的既有边界仍在。本 slice 不代表整个 Header/PC 已验收。

本轮最终结果：**9 个 Vitest 文件 / 79 项通过**，包含原 63 项、共享 status/core、root core 与 3 个 native 外壳；三组 Mac/Windows headless **共 30 场景**通过（Header 14、原 root 8、本轮 status 8）。Settings design audit、最终整包 tsc 与 `nsh:check` 均通过。期间其它 owner 的 `desktop-diff-list.tsx` 图标类型和 `new-session-page.tsx` role="status" 曾阻断检查；本 scope 未修改它们，最终重跑已无错误。`bun run dead-code` 已在 OS 禁网下执行，仍被既有缺失 `vite-plugin-pwa` 阻断，未取得报告，未加依赖。测试使用固定 NSH 0.4.0，全部 native 子进程由 `/usr/bin/sandbox-exec` deny network；没有 Git 命令、真实 GitHub 账号、真实 Host 写入或模型访问。
