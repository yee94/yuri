# Desktop writer：冻结的 TS consumer 合同

## Main / Chat worker 现在按此接线

实现文件为 `desktop-writer-core.ts`（纯状态机/验证）和 `desktop-writer.ts`（NSH 薄 loader）。这不是 JS writer authority；真实独占与持久化仍由 Rust Process/原 Vault lane 授予。第二生产窗/MiniChat 仍禁用。

```ts
import { loadNativeDesktopWriterClient } from './desktop-writer';
import { bindRequest, bindRawRequest } from './runtime';

// 每个桌面 window root 一次。adapter 在非 desktop 上直接 undefined，零 capabilities I/O。
const client = await loadNativeDesktopWriterClient({ current: windowOwnerCurrent });
// 明确 bootstrap Ready / committed scope 后，每个主 Chat / assistant / 新会话 owner 一次。
const owner = client?.claim({
  expectedHost: capturedScope,
  target: { kind: 'session', id: sessionID },
  current: chatOwnerCurrent,
});
await owner?.ready();
if (!owner?.grant()) { /* 不 openDraft/恢复/编辑；保留显式 unavailable/denied/unknown */ }
const send = bindRequest(capturedScope, owner?.grant);
const raw = bindRawRequest(capturedScope, owner?.grant);
// HTTP factory 增加同形可选 writer getter；每次 dispatch 再验证。
createDesktopHttpClient({ ...existingOptions, writer: owner?.grant });
```

**桌面缺 client/owner 时不要挂可写 owner**，也不要把 `owner?.grant === undefined` 当成已授权。runtime 的可选参数用于保留 iOS 旧 caller；缺 seam 的桌面受保护写仍由 native 最终拒绝，不 lazy acquire。只读 panel 不 claim。iOS 不调用本 loader/claim，也不读取 desktop capabilities。

### 冻结类型/方法

```ts
type DesktopWriterTarget = Readonly<{
  kind: 'session' | 'assistant' | 'new-session'; id: string;
}>;
type VerifiedDesktopWriterGrant = /* 只能由 verified native ACK 签发的 opaque 对象 */;
type DesktopWriterPhase =
  'acquiring' | 'renewing' | 'ready' | 'denied' | 'unknown' | 'releasing' | 'released' | 'retired';

// 纯 loader：loadDesktopWriterClient({source:()=>DesktopWriterSource|undefined,current})
// native loader：loadNativeDesktopWriterClient({current})
interface DesktopWriterClient {
  readonly windowID: string;
  current(): boolean;
  claim(options: {
    expectedHost: RuntimeScope;
    target: DesktopWriterTarget;
    current(): boolean; // 稳定 owner/Host identity/target lifetime；不是 lease/transport/modal/后台开关
  }): DesktopWriterClaim;
  retire(): void; // 撤销 JS 使用资格，不释放 native grants、不 cancel
}
interface DesktopWriterClaim {
  readonly ownerID: string; // 每次 claim 用 NSH crypto.randomUUID；不能调用方指定/跨 mount 重用
  readonly windowID: string;
  readonly expectedHost: RuntimeScope;
  readonly target: DesktopWriterTarget;
  ready(): Promise<VerifiedDesktopWriterGrant | null>; // 同一 Promise / 一次 acquire，无隐式重试
  grant(): VerifiedDesktopWriterGrant | null; // 稳定 getter，dispatch 时读取，不缓存字符串
  phase(): DesktopWriterPhase;
  status(): Readonly<{
    phase: DesktopWriterPhase; pending: number; hasGrant: boolean;
    unknown: boolean; error: DesktopWriterError | null;
  }>;
  subscribe(listener: () => void): () => void;
  canRelease(): boolean; // 仅 native receipt + 本地 pending/unknown/current 条件；不等于业务 allowed
  release(options: { allowed(): boolean }): Promise<boolean>;
  renew(options: { expectedHost: RuntimeScope }): Promise<VerifiedDesktopWriterGrant | null>;
  retire(): void; // 同步撤销 grant 使用，保留原 receipt；零 native I/O
  close(options: { allowed(): boolean }): Promise<boolean>;
  markUnknown(cause?: unknown): void; // domain 坏 ACK / 未知提交；sticky，不清 native 锁
}
```

`target.id` 为**原始** session/assistant ID，不预先 encodeURIComponent。new-session 的 id 是 main 提供的 canonical Host directory，不读当前默认目录、不猜 sessionID。不要用 grantID/ownerID/windowID 作 Storage key。所有 native grant 字符串保留在模块 WeakMap/闭包内；复制/手写/序列化的“grant”不能给 transport 授权。

## 生命周期与失败

- root 显式 load 一次完整 capabilities，只验证 discovery；每个 claim 显式发一次 `{ownerID,target,expectedHost}` acquire。ready 不拒绝 Promise；失败看 phase/status，不能靠 catch 后继续 openDraft。重复 ready/getter/status 和 50 次输入更新零额外 native calls。
- acquire ACK 必须完整 exact 字段、schema/window/owner/target/scope 全匹配；snapshot 深冻结。晚到 ACK 不发布到 retired owner，但**保留原 receipt**。若仅 owner 已退休、原 client/source/lease 仍可用，可通过显式 allowed close 清理；若 source/client 已退休或 ACK 不可信，sticky unknown，不猜 grantID、不从新 client 借权限释放。
- `release({allowed})` 必须由主 owner 在 draft/dirty/pending/unknown guard 全部通过后显式调用；in-flight 重复 intent 共用 Promise，无自动 retry。unknown release、timeout、lookalike Error、坏 ACK 或迟到/旧 client ACK 都保留原 receipt 和 unknown，不把本地状态置 released。只有匹配原 grantID 的 exact native `{released:true,grantID}` 才是释放 ACK。
- `retire()` 只撤销 JS 使用资格。`close({allowed})` 用于**已决定最终退休**的 owner：立即 retire，等待那一次 acquire 的 late ACK，再在 allowed 仍成立且无 pending/unknown 时尝试一次 release。close 不是 dirty guard，也不代替 Rust final-close/shutdown；取消离页时不要调用 close。未知态没有强解锁/恢复方法，native `recovery:false`。
- **原生窗口 close/Quit guard 不要提前 release。** TS 全部业务 guard/flush 通过后只复验 `canRelease()`/phase/pending/unknown，再提交原 closeDecision；Rust 还会做最终磁盘/epoch 复验并在真实 final-close 清理 grant。原 closeDecision Promise 最终成功后 TS 只 retire/dispose 本地 owner，不再对已由 Rust 清理的 grant 调 release。若 native 最终 veto/flush 失败，原 claim/grant/draft 仍应可用。显式 TS release/close 主要用于窗口内 route owner 交接或未被 native final-close 覆盖的 late acquire 清理。
- 原 transport 的受保护 write 派发会登记本 claim 的 pending；响应坏形/网络错/取消/迟到变为 sticky unknown。合法完整 2xx 只证明 native transport 完成；Chat/domain parser 发现坏 ACK 仍须 `markUnknown`，业务保护不能被 transport 替代。
- 新会话创建使用 `{kind:'new-session',id:canonicalDirectory}` grant；得到**权威真实** sessionID 后显式 claim session、等待 ready ACK，之后再 allowed release 原 new-session owner。这里没有从 create response 自动猜 ID、自动迁移/释放旧 draft 的 helper。

## Transport seam

`bindRawRequest(scope, writer?:()=>VerifiedDesktopWriterGrant|null)` / `bindRequest` 同形。保留原 path/method/body/expectedHost，不改 body/URL/query/auth；仅受保护 mutation 的 native envelope 增加 `writerGrant: grantID`。GET、只读 `POST /api/rpc/opencode.goal/get` 不读取 getter、不注入 grant。route 匹配仅用于验证**显式 target**，绝不根据 path 获取 authority 或 acquire。

`createDesktopHttpClient` 的新增 option 也是 `writer?:()=>VerifiedDesktopWriterGrant|null`；dispatch 复验 native window/scope/target/owner/client，cancel 仍只有原四身份字段。原 8-job native预算、HTTP receipt ID 和 unknown/cancel 结果不变；writer 的 unknown 不会被 cancel-acknowledged 洗掉。无关设置 mutation 不注入 session writer。

此文件冻结 consumer API，不代表 root/Chat 已接入、真实 OS/Host 网络或生产多窗验收。focused 验证结果完成后追加。

## 同一 authority 的被动续 lease：显式 renew（已冻结）

- **保留同一个 client 和 claim/ownerID/draft owner**，收到 native 新 committed scope 后显式 `await owner.renew({expectedHost:newScope})`。不能 dispose/new client/新 ownerID 绕锁；`current` 捕获稳定 owner/Host origin+authorization/target lifetime，不能因为临时 transport 不可用或 lease 轮替就返回 false。主动换 Host/授权则须按正常 guard 在切换前 release。
- renew 不改变原 `ready()` Promise；renew 成功后 `owner.expectedHost` getter 和 `owner.grant()` 返回新 scope/opaque grant，旧 verified 对象永远失效。调用方必须用新 scope 重绑 `bindRequest/newHttpClient` lane；原 Chat 与 durable draft 不销毁、不恢复第二遍。renew 等待期 grant 为 null，所有 write 禁止；重复相同 intent 共用 Promise，无自动重试。
- acquire 尚未 ACK 时可以显式提交一次 renew intent：先封住旧 scope，等待原 acquire receipt，再只发一次 native renew；这不是第二次 acquire。此时原 `ready()` 返回 null，不把旧 scope 对象交给 consumer，调用方等待自己的 renew Promise。相同 in-flight intent 合并，不同 scope intent 不自动排队。单纯 owner retire、source 退休或 unknown 时不再派发；若已有显式 close 等待这次 queued intent，则只有 late allowed 仍成立、原 source 仍 current、pending/unknown 均无时才允许它仅为 cleanup 续租，再按新 scope release。迟到 renew ACK 保留新 receipt，但不向 retired owner 发布。close veto 不续租、不退回旧 scope release；native final-close 仍按原关闭屏障处理 clean held record。
- 新 native method 为 `desktop.writer.renew({ownerID,target,expectedHost:newScope,grantID:oldNativeID})`，capabilities 必须完整包含 `renew:true`（旧缺字段 fixture 不算支持）。core 私有持有 oldNativeID，caller 不传 grant 字符串，也不传同身份 supported bool。
- native 用同一原 Process/Vault lane 的 held record + in-memory active 证明旧 authority；origin 与 authorizationID 来自真实 committed Connection，不接 JS authority。只有同一真实 window/owner/target/Host ID、原 stable origin/auth 不变、pending=0/unknown=false 时原子换 native grant/scope；持久 ACK 后才回新 grant。旧 grant 在两种 HTTP 入口均立即拒绝。
- 旧 durable held record 若缺 authority，继续保留、fail-closed recovery_required，不能从 current connection 补猜 authority。native 续租网络未知、坏 ACK、身份/授权变化均不清旧 receipt/unknown，不自动重发 renew、不强行 old-scope release。被动 lease 轮替后的正确出口是本协议，不是关窗重开。

## 本轮验证证据

- Vitest：core/transport/原 HTTP/runtime 四文件 **70 passed**；连同既有 `state.test.ts`、`new-session-writer.test.ts`、`new-session-local-page.test.ts` 共七文件 **217 passed**。后者只运行 consumer 回归，未改这些 owning consumer。
- 整包 `tsc --noEmit -p packages/nsh/tsconfig.json` 通过。
- native binary 与 `synthetic_smoke` 的全部 synthetic fixtures 各 **372 passed / 0 failed / 0 ignored**（显式 `--include-ignored`，原有隔离 TS fixtures 均提供）；包括真实产品 manifest、双 QuickJS Engine、原 Vault lane、同 authority renew、换 origin/auth 拒绝、pending/unknown、旧两 HTTP grant 拒绝、确定存储失败保 prior、CommitUnknown 零重放及 legacy record 保留。
- `cargo clippy --all-targets -- -D warnings`、Mac binary/synthetic example build 通过；链接仍提示既有 `__eh_frame` compact-unwind 大小 warning。Windows metadata frontend 通过，**不是 Windows target/SDK/link/OS 验证**。
- `bun run dead-code` 已重跑，仍在加载既有 `packages/web/vite.config.ts` 时因缺失 `vite-plugin-pwa` 中止；输出 `Saved lockfile`，未装依赖、未回退其他工作。
- 无真实 UI/账号/chooser/SSH/Host/模型、真实凭据或网络写；native 网络测试仅短时自建 synthetic loopback。未重建产品 bundle/capabilities，未发布；root/Chat/new-session 的最终生产装配与 OS 窗口验证不由本证据替代。第二生产窗/MiniChat、unknown/crash recovery 继续 gated。
