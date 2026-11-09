# Header 根导航 ticket（冻结装配合同）

## 范围

纯 `desktop-header-navigation.ts` 和 focused tests；另仅在 `desktop-page-departure.ts` / test 增加可选最终验证。无 NSH/UI、Host/native IO、第二 SSH/连接/文件/page owner、timer/poll。application、Header runtime/instances adapter、state 和 Host 由 main 所有，本 slice 不修改。

本模块解决的是**一次入口动作授权转交到根导航 ticket**：`intent.current()` / `canStart()` 只在入口同步复验。原文件 guard 打开自己的 modal，导致 Header.active=false、services/popup intent 撤权，不能取消已经准入的这一个根 ticket。外部 Settings/Help/Search/close、route/window/Host/lease/generation/lifecycle 退役仍必须取消。

## 冻结 API（main 可开始装配）

```ts
type Target = Readonly<{ id: string; url: string; authorizationID?: string }>;
type Intent = { current(): boolean; from: Target | null };
type Guard = Readonly<{
  window: object;                 // 稳定的本窗口 lifetime token
  route: object | null;            // 原 route 对象，不能重新生成等形对象
  runtimeScope: { hostID: string; lease: string } | null;
  connection: Target | null;       // app 当前 committed connection
  connections: readonly Target[] | null; // 已提交 metadata；null=unknown，非成功空
  generation: number;              // 原 Host/runtime epoch
  valid(): boolean;               // captured 外部模态/close/lifecycle/window epoch
}>;
type Ticket = Readonly<{
  snapshot: Readonly<Pick<Guard, 'window' | 'route' | 'runtimeScope' | 'connection' | 'generation'>>;
  current(): boolean;
}>;
type FileReceipt = boolean | { status: 'accepted' | 'cancelled' | 'failed' | 'unknown' };

const navigation = createDesktopHeaderNavigation({
  canStart(): boolean,
  capture(): Guard | null,
  files: {
    request(): Promise<FileReceipt>,  // 原 tabs.requestWindowClose，同一文件 lane
    canLeave(): boolean,             // 原 tabs.canWindowClose；最终 dirty/unknown 复验
  },
  departure: {
    request(commit: () => void, validate?: () => boolean): Promise<boolean>,
  },                               // 原 pageDeparture，不另建 owner
  switch: {
    commit(target: Target, ticket: Ticket): Promise<DesktopHeaderServiceResult>,
  },
  add: {
    commit(ticket: Ticket): Promise<DesktopHeaderServiceResult>,
  },                               // 原 Settings 打开动作；显式 accepted/failed/unknown
});

navigation.switch(target, intent);  // Promise<DesktopHeaderNavigationResult>
navigation.add(intent);             // 同上
navigation.pending();               // boolean；同窗口一个 pending job，拒绝而非排队
navigation.cancel();                // 撤销当前 ticket，不关确认、不 release、不启动下一 job
navigation.dispose();               // 取消且永久拒绝新动作
```

实际导出使用 `DesktopHeaderNavigationTarget/Intent/Guard/Ticket/FileReceipt/Options/Result` 名称。结果保留 `DesktopHeaderServiceResult.status` 的原五种枚举，另提供 `phase: entry|files|departure|commit` 和 `reason`，main 可直接返回给 instances root 的 switch.run/add.run，不增加 Header services 状态枚举。

```ts
switch: { available: () => /* 原入口能力 */, run: (target, intent) => navigation.switch(target, intent) },
add: { available: () => /* 原入口能力 */, run: intent => navigation.add(intent) },
```

## capture / valid 的 main 责任

`capture` 是原 committed metadata 的同步只读快照，不读取 Host、不激活/重建 SSH owner。每次验证重新 capture，对比 window/route 引用、HostID/lease、generation、connection 三字段，并在当前完整 catalog 中精确匹配目标；不以 ID、URL 后缀或旧 popup row 猜目标。

**capture 不得因为本动作自己的 files/page 确认 modal 而返回 null。** `canStart` 可以使用入口的总模态禁用；captured `valid()` 只能检查独立的外部 Settings/Help/Search/close、window lifetime 和 lifecycle/route/Host retirement，不能捕获原 `intent.current`、Header.active、services lane，不能把 `tabs.modalOpen` 一概当外部模态。原 `files.request` / `departure.request` 独占它们自己的确认 lane，ticket 不拥有新的弹窗或确认逻辑。

main 必须用原外部 intent/retirement 的单调 revision（或等价 sticky guard）捕获 `valid()`，或在任何退役动作同步调用 `navigation.cancel()`；外部打开再关闭、后台再回前台、离开再返回不能复活旧 ticket。helper 的 false 验证也会锁死该 ticket，但无法观察外部在两个 await 之间发生又恢复的 ABA，禁止用仅“现在没有外部 modal”的 getter 假称完整生命周期验证。`valid` 也不能依赖 release 后自然失效的页面 editor.current。

## 提交与回执

顺序固定：入口 exact 验证 → 原 files.request → files.canLeave → 原 departure.request(commit, finalValidate) → 在 release 前再次验证所有 captured 身份、target、外部 guard 和 files.canLeave → 原 release → 原 commit。commit 之前的取消/失败/unknown 不 release page，不再确认、不重绑 scope、不自动重放。

同连接三字段完全一致是 accepted/unchanged，无文件确认、page departure 或 native select/stop-streams。重复 pending 调用返回 unsupported/pending，不排队；cancel 后也必须等原在途 job 结束才允许新的确认，避免与原 files lane 并发。

commit 端口如有异步 native capability/gate，必须在**每个 await 后、实际 irreversible native/select/settingsopen 前**复验 `ticket.current()`；helper 不能代替端口内部尚未暴露的异步边界。ticket.current 包含原 files.canLeave。只允许 exact captured target，一次调用。已发出的 native 写不能靠取消变成未发生。

commit 返回 accepted 必须来自原 owner 的真实目标提交 ACK；即使提交切换了 Host/route、旧 ticket 自然失效，或者之后 catalog refresh 失败，helper 原样接受这个显式 receipt，不从当前 app selected 或旧 guard 猜成功/覆盖成 stale。抛错或 malformed receipt 为 unknown；unknown 不当 rollback，也不自动重发。main 的原 native/SSH unknown journal 仍负责阻止重复不明写，`canStart` 必须尊重它；helper 不创建第二 journal 或 reconcile owner。

`files.request` 的 true/false 兼容原 tabs boolean（false=无离页授权）；如原 owning lane 能明确区分 failed/unknown，main 应返回对应 typed receipt，不能把未知保存当成功。departure 的 false 只表示未调用 commit，原页面与文件 owner 保留；它可能是 Cancel，也可能是原 page owner 已向自己的 onError 上报的失败，helper 不臆断具体原因。已开始 commit 后，以 commit receipt 为准，不再把迟到取消/异常解释为可以重试写。此时 page 已经按原授权 release，cancel 不会倒放这个 release，也不能假称恢复了 editor。

| 结果 | status / reason |
| --- | --- |
| 初始禁用 / 已有 pending job / 非法 target | unsupported / blocked、pending、invalid-target |
| entry / exact scope、from、target 失效；cancel/dispose | stale / 对应精确退役原因 |
| boolean files false / typed cancelled / departure false | stale / files-denied、cancelled、departure-denied，不伪造写失败或 ACK |
| files 明确 failed / 最终 canLeave=false | failed / failed、files-changed |
| unavailable catalog、抛错、malformed receipt、明确 unknown | unknown / unavailable 或 unknown；不自动重发 |
| 完全同连接 / 真实 commit ACK | accepted / unchanged、committed |

无当前连接时，已测试 `connection/from/runtimeScope=null` 且 metadata 为已知完整空数组的 Add 路径；metadata 必须是已知完整集合（可以为空），不根据 unknown/null catalog 合成空集合或猜一个 Host。

## pageDeparture 可选扩展

`request(commit, validate = () => true)` 在无 page owner 的 commit 前，以及有 owner 的 requestLeave callback 中 **release 前**同步复验 validate。旧 callers 不传参数，startup onIntent、release-before-commit、单 pending、原 requestClose/canClose 完全保留。native close 不采用这个导航 validate，也不 release page。

## 验证边界

最终 **5 文件 / 138 项通过**：

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-header-navigation.test.ts \
  packages/nsh/desktop-page-departure.test.ts \
  packages/nsh/desktop-header-instances-root.test.ts \
  packages/nsh/desktop-header-services.test.ts \
  packages/nsh/desktop-window-close-core.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
```

全包 tsc、独立临时 tsconfig（含本模块、真实 pageDeparture 及两者全部 focused tests）均通过。`bun run dead-code` 已执行，仍因既有 `vite-plugin-pwa` 缺失不能加载 web vite config，未添加依赖。未运行 Git/GitHub 或修改上游/其他 slice。

覆盖：初始拒绝、unknown metadata≠empty、同连接 no-op、source/target id+url+auth exact、caller mutation 不 rebind、单 pending/cancel/dispose、files Cancel/failed/unknown/dirty、真实 page owner 的 release-before-commit 与无 owner validate、owner late callback/repeated callback、外部 Settings/Help/Search/close/window/route/Host/lease/generation/lifecycle/ABA 退役、自身确认关闭 Header 却不撤销 root ticket、native gate 晚到和显式 ACK/failed/unknown/malformed receipt、ACK 后 refresh unknown 仍保 accepted、Add 自己打开 Settings 不被误当外部 veto。原 callers 和 native-close 纯合同回归保留。

本模块测试使用真实纯 helper 与真实 pageDeparture、合成原文件/native 端口；不写真实 Host、不证明 actual-root 装配、native ACK、AppKit/Win32 窗口或真实 dirty-file UI。main 另签实际根的 Switch Cancel/Discard 与 late native gate。没有另建 UI/native fixture 或第二 owner 来替代这些生产验证。
