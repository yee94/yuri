# Retained Desktop Header metadata owner

## 冻结 API

`createDesktopChatHeaderOwner` 来自 `desktop-chat-header-owner.ts`，纯 TS，无 NSH/React signal/effect/runtime import。

```ts
createDesktopChatHeaderOwner({
  target: ChatTarget, // captured session/assistant target，构造后不迁移身份或目录
  operation: () => Pick<PageOperation, 'current' | 'request'> | null,
  current: () => boolean, // captured Host/origin/authorization + 原 Chat/route identity，不包含 modal
  changed: (value: ChatHeaderMetadata) => void,
  now?: () => number,
})
// 返回
snapshot(): ChatHeaderMetadata
update(value: { readDemand?: boolean; busy?: boolean }): void
setDemand(value: boolean): void
refresh(force?: boolean): Promise<DesktopChatHeaderResult>
refreshQuotas(force?: boolean): Promise<DesktopChatHeaderResult>
setQuotaMode(mode: 'usage' | 'remaining'): DesktopChatHeaderResult // 始终 unsupported
dispose(): void
```

`PageOperation` 仅 type import；唯一读口是该 captured lane 的 `request(path,'GET')`，没有另起 sender、Chat、catalog 或资源 API。`changed` 挂在 retained Chat owner，不挂在 header render slot。构造零 GET、零 timer；默认 demand=false，busy=false。主根单次构造，原 owner cleanup 才 dispose：

```ts
const owner = createDesktopChatHeaderOwner({ target, operation: operations.operation,
  current, changed: value => retainedHeaderMetadata.set(value) });
// 主 Chat 原本的窄 lifecycle/operation/busy effect 内（不是输入/draft effect）：
owner.update({ readDemand: chat.active() || chat.syncActive(), busy: chat.busy() });
// metadata prop 直接读 retainedHeaderMetadata；modal 不撤下 publisher/不销毁 owner。
// refresh-usage consumer 先复验 action intent.current，再 await owner.refreshQuotas(true)。
```

当前 `Chat` 的 `operations.displayCurrent` 满足 identity-current 语义；**不能换成 `operations.current`、`chat.active`、lifecycle 或暂时 readiness**，否则一次暂停会被当成永久 authority 退休。`operation` getter 负责可暂停的 lane current。`quota-mode` 的 action port 应保持 `available:false`；即使调用 `setQuotaMode` 也只返回 unsupported。

## 读取/保留合同

- 每个 owner 只有一个原 `createChatHeaderMetadata` controller。same-authority lane 暂停/恢复不重建 controller，保留原 bounded catalog cache、metadata 与 quota 内部 prior。
- 初次可用 lane、真正 operation 对象变化/暂停后重新准入、busy→idle 只把 metadata 标 dirty。demand=true 且不 busy 才自动刷新；并发事件合并，正在读取期间的新真实刷新事件最多合并成一个后续批次。没有 dirty 时重复 update/setDemand、50 次草稿更新或 header mount/unmount 不读取。
- modal 的 `active || syncActive` 若仍为 true，不改变 read demand 或 lane；只改变 header 的 interactive/active。false demand 撤销在途并保 prior 标 stale；单纯 false→true **不是新刷新原因**，只执行此前确有 lane/idle 事件延期的批次，不自行重试失败/取消请求。前后台的真正新 lane 则是独立刷新原因。
- 每次读取前后都复验相同 operation/current/demand/generation；lane 替换或暂停先 cancel 原 controller 并撤权旧 changed/flight。旧 quota 账户响应不能在新 lane 到来后发布。原 controller.cancel 不重置它的 loading，外层负责保留快照并将 loading=false、contextStale=true、已有 quota groups/rows 标 stale，不删除 prior；quota.loaded=false 使上一代成功空集合也不能冒充当前权威空结果。撤权立即让已返回的 Promise settle 为 stale，但不宣称物理中止原 HTTP。
- current=false 表示 captured authority 退休，不是 modal。owner 永久拒绝新读取，保留旧 snapshot 仅供原 owner 检查，不向外发布其退休内容；另一个 Host/route 必须使用自己的新 owner，不能 current=false→true 复活。
- metadata 仍是原 source 的最多4个并行 GET：exact session、最新20条 projection、catalog、light Git。warm catalog 依原60秒缓存减少到3GET；没有全目录枚举、poll、额外 bootstrap 或输入期扫描。assistant target 不请求这些 session metadata。
- quota 只由显式 `refreshQuotas`（usage 打开/刷新）发原 source 的 settings/providers/Magpie aggregate 与最多32个 configured provider GET、原四并发；自动 metadata/idle/lane/resume 不读 quota。

## 回执

- metadata accepted：本次 flight 真实看到完成，仍具 exact authority，errors 为空且 context 不 stale；任何原 source 失败/未完成为 failed。并发显式调用复用一个实际 flight，不新增 GET。
- quota accepted：本次 flight 真实看到 loaded=true/loading=false 的新完成快照，顶层 errors、group.error/group.stale、row.accountError/row.stale 全无；provider/account 局部失败也为 failed，保留所有有效兄弟结果。成功空集合是 accepted；未知 token/不限额数值不等于请求失败，不伪造0。expired/reset 造成 stale 也保守回 failed，不声称已刷新为最新。
- 无 demand、无有效 lane、assistant metadata、已 dispose 的调用为 unsupported；原 flight 执行中退休为 stale，不传播 accepted 到后来的 lane。GET throw/原 source 吞掉的失败不能作为成功；本次没有匹配的完成快照就是 failed。
- quota-mode 没有真实 mutator：始终 unsupported，零写入/零本地乐观 mode。真实偏好保存归未来原 settings owner，不在本 slice 发 POST。

## 验证边界

本次只新增 owner/纯 Vitest 与本专项文档，不修改 application、手机 header、原 metadata/quota source 或任何 Host。Context7 已知配额耗尽，本轮未重试；复用既定本地源码合同，不修改指定 NSH 0.4 源码。

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-chat-header-owner.test.ts \
  packages/nsh/desktop-chat-header-core.test.ts \
  packages/nsh/chat-header-metadata.test.ts \
  packages/nsh/chat-header-quota.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
bun run dead-code
```

- **4文件45/45通过**；其中新 retained owner **15项**，用真实原 metadata/quota controller，不 mock factory。覆盖首批4GET、warm批3GET、60秒catalog失效/force、50次更新零额外读/引用稳定/零timer、modal active||syncActive、operation暂停/换代、demand-only恢复不重试、即时stale回执/晚到响应、显式usage/coalescing、metadata与quota并发及交叉失败、provider/account/incomplete/空集合、busy→idle合并后续批次、authority不可复活、dispose和assistant目录。
- **整包 tsc通过**（当前并行工作区）；main后续修改仍应重跑其实际root聚焦测试。
- `dead-code` **被既有缺失 `vite-plugin-pwa` 阻断**：加载 `packages/web/vite.config.ts` 失败，exit2；未补装依赖。
- 未运行真实Host、主App production retained-publisher接线、系统窗口/物理键盘/视觉或完整native应用构建。本续工是纯 owner / 原bounded reader合同证据，不冒充主根runtime或AppKit/Win32签收。没有git/GitHub、Hostwrite、secret读取或付费调用。

已归还本 owner、focused tests 与专项文档。main仍独占 application，按冻结API接线；无需修改旧手机header/metadata/quota。
