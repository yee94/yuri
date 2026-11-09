# 新会话 native writer 接入边界

## 已核对的原 owner

`new-session.ts` 的 `openNativeNewSession` 同步 `openDraft` 并开始恢复 source durable / Storage receipt。native acquire ACK 必须在调用该 factory **之前**完成。不是 readonly UI 包装，也不是在 submit 时 claim。目录来源是明确选择的目录经 Host `GET /api/fs/list?path=...` 返回的 canonical `path`；不从首 project、历史 metadata、空 path 的 Host home 或 canonicalize POST 猜目标。`.opencode/plans` 的 ENOENT 假空成功另须父目录实际 entry 证明。

正式 writer 合同见 `desktop-writer-DOCUMENTATION.md`。本模块只消费注入的 `DesktopWriterClient`，不 load capabilities、不构造 grant、不新建跨窗口 authority。原 root 一次 load；iOS 不构造本 admission，保留旧路径且零 writer/capability I/O。

## 冻结的 admission 端口

`createNewSessionWriterAdmission({client, operation, directory, current, changed?})` 是纯 controller，`client` 是原 root 实例或 `undefined`，`operation` 是原 captured PageOperation。`current` 表示原 route/Host owner lifetime，**不能使用临时模态/前后台/输入状态**。同步 construction 零 I/O；显式 `ready()` 只运行一次只读 canonical 解析和一次 claim；`snapshot()` 给出 `unavailable|resolving|acquiring|ready|denied|unknown|retired|released`。没有 verified ACK 就没有 admission，也不能调用 source owner factory。50 次输入/状态读取零 capability/acquire 调用。

`admitted()` 返回 `{ directory, client, claim }` 或 null；`claim.grant` 是正式 claim 的稳定 getter，不复制/序列化原 opaque grant。admission 本地 WeakSet 仅验证由本 controller 出具且一次采用的包装，不分配任何 grant、native 锁或 target book。`ready()` 不自动重试 unknown 或 denied。`close({allowed})` 只在业务已决定最终退休后等待在途解析/acquire，并委托原 claim.close；只有安全 native release ACK 才返回 true / released。`retire()` 只撤销可用性，不自动 release。

`safeToLeave()` 只读原 phase/flight/claim.status；不把暂时不可用的 grant getter 当零 held 的证明。pending/unknown/hasGrant 即使 Host stale 或 claim retired 仍保护，不操作原 claim。

## 主 Chat 的 handoff（已冻结并落盘）

### Pre-source 生命周期 observer（冻结）

```ts
onWriterAdmissionGuard?: (guard: NewSessionWriterAdmissionGuard) => void | (() => void);
// 独立类型来自 ./new-session-writer，无 desktop root import
// current(): boolean; prepare(): Promise<boolean>; canClose(): boolean;
// cancel(): void; release(): Promise<boolean>;
```

desktop `NewSessionOwnershipSlot` 在启动 resolve/acquire 前同步登记；root 只关联原 route 标签并返回注销函数。`current` 是 slot lifetime，不跟随模态、前后台或 stale Host 撤保护。prepare 和最终 canClose 都检查真实 admission/原 claim status；resolving、acquiring、unknown、held ACK 尚未构造 source 一律 veto。无 selected、无 client/unsupported，以及 denied 且原 claim 零 held/pending/unknown 可以通过。prepare 后 client ready 开始 acquire 会使最终复验失败，cancel 撤销准备。

release 只是 prepared 且仍 safe no-authority 的 noop，不调用 admission.close、claim.release/retire、capabilities 或第二次 acquire。native close 仅 prepare/canClose，绝不先 release。只有真实最终卸载才继续原 admission.close 处理 stale/late ACK；unknown 不洗锁。`onRetainedOwner` 回调成功返回后才注销等待 guard，原 source 的业务 guard 接手；若提供 observer 却没有 source publisher，则继续 veto 已安装 source，不能静默撤保护。iOS 不调用 observer，也不构造此 guard。observer 不保存/暴露 grant，不建立第二 claim/registry authority。

等待页的项目选择 modal 仍可打开；提交选择同样先查 safe no-authority，pending/unknown 不能借内部换目录绕过等待保护。

`NativeNewSessionPageProps.desktopWriter?: () => DesktopWriterClient | undefined` 由 main 注入每窗原 root client getter。getter 使用原 root readiness signal；尚未 ready 时显式等待、不挂 source durable，effect 在 getter ready 后一次 claim。iOS 不调用该 getter、不构造 admission、不调用任何 writer 方法。pending admission 等待原 operation/client，不从输入/临时 modal 重建 owner。同目录 `/new` 复用原 owner；实际目录切换只读解析后先 flush/安全 release 旧 source，再 claim 新目标。

无目录是正常的新会话选择项目状态：原 `NewSessionLayout/Welcome`、Choose a project 提示/入口及 readonly Composer（附件/听写/模型/发送禁用）都保留。`NewSessionUnadmitted` 没有 draft/Storage/receipt/catalog owner；不读写 durable，不调用 getter 以外的 writer 方法。项目选择复用原 modal/路径输入；明确选择后才 GET canonical → native ACK → 原 owner。缺 client/denied/unknown 的已选目录显示等待/不可用，但仍保留项目选择入口。不能用首项目、lastDirectory 或旧 metadata 让这块只读展示获得权限。

目录切换先用原 captured operation 只读解析所选目录，若 canonical 与现 owner 完全一致，保留同一表单/稿件/claim，不做 release/acquire；确实不同才 flush/安全 release 后启用新 target。后台或同身份 lease 轮换不销毁 ready 表单；初始 acquire 尚未完成时也保留原 claim，`admission.resume(nextOperation)` 等原 ACK 后用正式 renew 续 lease，不换 ownerID。旧 continuation 仍用原 operation，不借最新 sender 派发。

`NativeNewSessionPageHandoff.desktopWriter?: DesktopWriterClaim` 是创建后已经 ACK 的**同一个 session claim**，`handoff.desktopWriter.grant` 可直接交给 `createChat(..., { writerGrant })`；主 Chat wrapper 接管其最终 `renew/close/release`，不得再 claim 同目标。source 自己的 `handoff.release()` 只释放 source new-session claim，绝不释放这个 session claim。原 source 关闭后 session grant 仍存活，Host 身份仍严格比较 id/origin/authorizationID；最终 Chat owner 退休必须显式 retire/close 它。main 必须把已有 handoff admission 的保护与 Chat retirement 组合，而非只看 Chat.canReleaseWriter。

源码路径：Page 的 `NewSessionOwnershipSlot` 异步 admission → `AdmittedNewSessionOwnershipSlot` 才构造原 owner；`openNativeNewSession` 也在任何 `openDraft` 前验证原 admission，不能从其他入口绕过。创建 POST 使用 captured source getter；真实 receipt 必须给出 exact directory 和非空原始 session ID，再 claim session。model/agent POST 和 destination draft restore/stage 都晚于 session ACK。claim 失败保留 created receipt/inputID/附件，只读且零 recreate。source/captured operation 不重绑旧 continuation；同身份重连走正式 `renew`，不是重新 acquire 或重挂表单。

## 必须先解决的 source retirement barrier

原 pipeline：source flush → creating/inputID → create POST → created receipt → folder/model/agent → destination durable staging → installed receipt → transfer → Chat noteAdmission(unknown/acknowledged) → source.complete（清 source durable + 重置 receipt）→ source.close。

严格按“session acquire ACK 后、handoff 前 release new-session”执行，会让后续 `noteAdmission`、`complete`、`close.flush` 无 source grant。不能提前丢 inputID/unknown-create/附件锁，也不能把 session grant 假作 new-session target。当前没有正式的 native source journal migration/transfer authority，所以不能假称现有接口已完成安全退休。

当前实现选择不丢恢复语义的顺序：先 acquire session → 用该 session grant 配置/stage/Chat 首发 → 原 source grant 保留到 source.complete/flush/settle → 最后安全 release source grant。符合“先 acquire session 再 release source”；**若 handoff 前必须立即释放 source，则这一更强合同尚未满足**，必须先提供真正的 source journal migration/retirement authority，不能提前清锁来拟合顺序。已向 main 明确这一差别，不能默认为完整验收。

source 退休是两阶段：prepare/flush/settle → `releaseWriter()` 等 exact source release ACK（durable 与 owner lifetime 仍保留）→ 路由 commit/unmount 时 `close()` 仅做本地 durable cleanup。release 未知时不 close durable、不置 alive=false、不把 ownership.released 置 true。installed/creating/created/pendingSend/queueEdit 仍保护原 source，不因导航 cleanup、发送失败或 unknown acquire 自动 release。release 失败可重进业务 guard，但原 claim 的 sticky unknown 不重发 native release。

## Main 的 source 关窗 guard（已落盘）

原 `onRetainedOwner` 所得 `NativeNewSessionOwner`，以及 route handoff 中保留的 `handoff.owner`，提供：

```ts
await owner.prepareWriterRetirement(); // boolean：暂停新动作，flush/settle；不 native release/close durable
owner.canReleaseWriter();             // 同步最终复验 prepared revision + business guards + exact current grant
owner.cancelWriterRetirement();       // close veto/取消后恢复原 owner，撤销在途 prepare
await owner.releaseWriter();          // boolean：仅 prepared/原 owner/revision guard 仍有效才 release；不 close durable
owner.sourceWriter();                 // 原 new-session claim（不是 handoff 的 session claim）
```

native close/Quit：main 组合所有 retained source、handoff source、Chat/file/attachment/history 等 guards，prepare 后在原 kernel decision 前再次同步 canRelease。**不要提前调用 owner.close/handoff.release**。native 最终成功后只 retire 原 claim；原 kernel 已负责 native grant 清理，不能再发 release。native veto/flush 失败则 cancel，保留同一原 owner。此端口不替代 main 总 guard、真实 final-close ACK 或 Rust 的最后 veto。

窗口内 route/目录离页：main prepare → 同步 final canRelease → await releaseWriter ACK → 原 guarded route commit；实际 unmount 再 close。releaseWriter 在途复用同一 Promise，成功后幂等 true，unknown 后不自动重发。ACK 前后 durable 都仍 live；ACK 后编辑保持暂停，不能把 cancel 当重新取得已释放 authority。`close()` 识别原 source.phase=released，只清理本地且幂等一次，不再发 release；若此前尚未 release，close 内部先完整 prepare/release ACK，再 close durable，任何 false/unknown 都保原 durable。installed source 未完成 admission/complete 时 generic close/release 仍拒绝。

`bindRetirementGuard` 将原附件/录音/选择/业务 flight 接入 source core；未知工作在 view unbind 后仍保护，不能靠卸载把 guard 清掉。已决定的任务真正 settle 才解除 pending，未因为 view 的 alive=false 永久卡住正常成功 handoff；unknown submission/attachment 的独立 receipt 仍保留锁。

其他写目标：starter `POST /api/config/commands/metadata` / PUT config / fs mkdir/write 不属于 new-session/session mutation，保持其原 metadata/config owner transport，未夹 new-session grant。核对 `projects-sidebar.ts:folders`：membership 的权威 session 读取是 GET，实际 POST 是原 `folderRoute` 的完整 folders settings（并非 session mutation）。继续走原 Sidebar mutation lane，未借新会话/session grant 冒充 folders 写授权，也未新增旁路。今后若 native gate 覆盖该 settings 资源，须由 owning adapter 增加对应 authority，而不是本 slice 猜 target。

## 当前边界

本 slice 不改 application/state/drafts/runtime/desktop-writer/Host，也不改已签收 Header。已消费 worker 后续落盘的正式 client/transport/renew 类型。main 的具名 `tests/desktop-writer-host.js` 已同步 renew；两个真实 NSH fixture 都直接使用它，未修改共享 producer、未给 Page 注入 supported bool。

## 验证与未验边界

- 纯测试 **18 文件 / 391 项通过**（范围见 `NEW-SESSION-VALIDATION.md`）：真实 owner/admission/custody + 正式 loader/transport；覆盖 pre-ACK 零 durable、opaque admission 不可复制采用、known/create/schema/target、native denied/unknown/late、50 输入、modal/background、初始 acquire 后续 lease、destination Storage failure 零 recreate、retained source cleanup、unknown release 不置 released、附件/选择 guard 与 native-close prepare/cancel/最终 revision veto，以及显式 releaseWriter ACK 前后零 durable.close / cleanup 幂等 / installed source 拒绝 generic close。新增等待 guard 覆盖 resolve/acquire/unknown、ACK-before-source、prepared 后开始 acquire、denied/unsupported/read failure 零 held 安全通过，以及 stale held ACK 到真实销毁前零 release。
- 新 `new-session-writer-native.test.ts`：**27 个真实 NSH headless 场景**，macOS/Windows 各 13 + iOS 1。使用真实 Page、原 source、正式 native loader/client、真实 Chat writer injection/admission 和具名 synthetic producer；包括无目录 readonly Composer → 明确选目录 → ACK 后才编辑、缺 capability/conflict/unknown/late、50 输入零 capability/claim、modal/后台保稿、同 canonical alias 不重挂、session transfer unknown/unknown create 零 recreate/iOS 零 writer calls。两平台另验证显式 release ACK 后 durable 仍 live，实际 route cleanup 才本地 close 一次；unknown release 连 cleanup 都不提前 close、不重发。等待 guard 覆盖 pending resolve/acquire 同时 request 导航/native close veto、same-Host modal 保留、unsupported/read failure/denied 零自身 claim 可离、unknown veto，以及 `waiting+ → source+ → waiting-` 无空窗接手，最终只留一个 source guard。50 输入零 observer 重登记；iOS observer 零调用。
- 既有 `new-session-local-page-native.test.ts`：**12 个场景**；fixture root 一次 load 并把原 session grant 注入真实 Chat，Host 同样复用具名 producer，验证 magic/Tab/Enter、原附件/context 保留和未知 create。
- 用户指定的实际根临时目录：macOS Header clean switch 和 dirty-file Cancel/Discard 两条 focused 均通过，未改 Header/application source。
- 独立严格 tsc 覆盖本 slice source、writer/directory/local-page tests 和新 NSH fixture/runner，通过；最终全包 `tsc --noEmit --project packages/nsh/tsconfig.json` 也通过。中途并行 owner 的 assistants Props 类型不匹配已由其修复，未越界修改。旧 JS Host fixture 的历史 `.body` 推断不纳入独立严格检查，运行回归照常执行。
- `bun run dead-code` 仍被既有缺失的 `vite-plugin-pwa` 阻断，未加依赖。没有运行 Git/GitHub、真实 Host、OS 窗口或修改 NSH 上游。

main 已在首页和显式 new-session route 两入口接 `onWriterAdmissionGuard`，在 resolve/acquire 前登记同一 mounted collector，source publisher 接手后注销等待 guard。实际 Navigation 根新增两平台 **4/4 等待期场景通过**，覆盖导航/native close veto、Settings 保留、ACK 后原 source 接手和后续正常导航；完整 Navigation wrapper 内部 **56/56 通过**。这些不是 AppKit/Win32 物理窗口、真实磁盘崩溃恢复或真实 Host/模型验收。native `recovery:false` 仍保留；不强解锁、不删 unknown receipt、不伪装 full multiwindow available。

main 的 Folder unknown/cold-recovery 两平台 fixture 仍由 main 所有；旧 Engine 未销毁时重开因 held writer 为 Unavailable 是真实冷恢复缺口，不用放宽 native 锁或删除 unknown receipt 处理。
