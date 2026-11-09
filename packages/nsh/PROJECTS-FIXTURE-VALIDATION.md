# Projects 专属测试装载与后台恢复增量

## 缺失依赖与实际行为分别记录

- 原三个纯测文件先红：search controller 的 VM 缺少 `./page-operations`；attention root 缺少 `captureHostRequest` 与 runtime readiness 环境。修复前 31 条里 11 条失败、20 条通过，失败发生在装载阶段，不能归因于搜索、Focus 或 partial failure 业务错误。
- `tests/projects-scope-vm.ts` 按实际源码提取 state 的 `epoch`、`captureHostRequest`、`captureHostOperation`，装载完整 production `runtime.ts` 和 `page-operations.ts`。仅 native transport、reactive scheduler 和根快照输入为测试端口；未把 scope/current/request owner 替换成恒真 stub。未知 import 仍直接失败，不加 fallback。
- search 原 old generation、取消、卸载、Focus-only、malformed authorities 与 partial failure 断言保留。补 readiness 撤销、真实 old Host 切换及回切后旧 display 永久退役；dispose 案例明确断言确有三笔请求发出，避免页面已失活导致测试空跑。
- search 专属 Host 接受真实 `connection.list`，所有 runtime 请求须有 exact expectedHost；missing/old-host/old-lease 均拒绝且不计成功 read。纯 controller 对同一 standalone Host 的 partial failure 与重试仍沿用原语义。
- native home、outer 与 search engine fixture 原来只设置 app.connection，缺少当前 root-confirmed admission。现在通过 `tests/projects-fixture-admission.ts` 调用实际 `loadConnections({ forceReconnect: true })`；native/search 专属 runner bundle 完整 synthetic Host，并隔离 config/Storage。未修改 production capabilities 或共享 `tests/host.js`。

## main 的 UIKit 新证据与源码修复

- main 报告 build `2026-11-07T15-48-47-237Z` / `df5bda28` / bundle SHA 前缀 `694a017`：初始竖拖、斜拖各成功一次，Back button 恢复，hidden tree 保留；d1 audit writes=2/rejected=0，各完整阶段两次。此为该包初次拖排的已验样本。
- `.scratch/nsh/projects-drag-fixed-background-audit-20261107-e1/after.json` 已读取：start4/claim4/grant4/measured3/move108/activate3/release4/drop2/unmeasured1/stale1，worktreeOrderWrites=2/rejected=0。后台期间零新增 write 是正确取消，但前台 fresh drag 的 unmeasured/stale 是真实 red，不能标绿。
- 已复现另一项确凿 production 行为差异：新同路径 WorktreeRow 登记 ref 后，旧行 cleanup 无条件 delete(path) 会删除新 ref。新增生产闭包测试先红 `expected undefined to be newRef`；修复为按 headerRef 身份清理，随后新行可正常测量与 drop，真正卸载仍删除自己的 ref。
- 这解释了一条与 e1 `unmeasured` 一致的失败路径，但 UIKit 未采集旧 cleanup 的实际时序，因此不宣称已证明设备唯一根因。没有放宽 current/Host/generation/membership fence，也没有让 stale 走成功。
- UIKit fixture 同时补明确的前台 admission：ready 保留已挂载 display，active 在后台和前台确认期间为 false；确认后 production page operations 创建新 operation/sender。纯回调覆盖旧手势退役、确认前拒绝、确认后新操作获准；未修改共享 root state/page-operations/application。

## 已运行与未运行

- Projects 20 个纯测试文件 240/240 通过，明确排除 `projects-native.test.ts` 和所有 `*-engine.test.ts`。其中 UIKit-named 纯文件仅执行 Foundation synthetic Host，不运行 NSH 或设备。
- 四个生产 fixture 的 TypeScript 依赖图为 0 diagnostics；新 Projects scope VM helper 使用 Node 类型单独检查为 0 diagnostics。
- dead-code 已完成并检查，未报告新 Projects helper 未使用；既有全仓报告保持不动。
- 未启动 NSH engine、模拟器、设备或真实 Host；未运行 Git，未修改 builder、application/main、state/runtime、生产 Swift 或共享 `tests/host.js`。
- 同模型独立只读 review 分正确性/authority/几何 owner/后台恢复与测试真实性两层，均未发现可确认的新缺陷。review 明确指出 VM 初始 readiness 和 effect 调度为测试端口，page-operation 案例不执行完整 loadConnections；实际 admission 路径须由 main 的新 fixture 包验收。
- engine 导航、原生 mount/ref 时序和完整后台恢复仍待 main；纯测试、独立 review 与静态检查均不能替代这些结果。

## main 独占执行的待跑命令

以下命令会启动 engine，本 worker 没有执行；应由 main 按其 engine 资源安排依次运行：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/projects-native.test.ts
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/projects-search-engine.test.ts
```

UIKit：main 重新运行既有 Projects order UIKit builder，逐文件 manifest 必须覆盖新 `projects.tsx`、UIKit fixture、`tests/projects-fixture-admission.ts` 与共享 `time-format-core.ts`。复验具体步骤见 `tests/projects-order-uikit/README.md`；e1 必须以新包 measured/drop、恰好一次新增 Host write、排序真图和恢复后的系统滚动/返回共同闭环。

交付源码 SHA-256（后续编辑以 main 新构建 manifest 为准）：

```text
ef27359de65d6923213d8ed25a8186048ea59d7b5b823839236d7d607cff7e35  packages/nsh/projects.tsx
26029afb454a956dd54e6281d225e9bbb277ed1a876b449d8bccc0104339470f  packages/nsh/tests/projects-order-uikit/fixture.tsx
37a88fbe184cbe573621b88a964b699b43d22f63dec601342c0435cb0f5fdcd8  packages/nsh/tests/projects-fixture-admission.ts
ad5241bc3d3ac286531a302314560d66467d8c6b49a6d389c6429637ee073132  packages/nsh/projects-order-gesture.ts
9b8a741c265822e0fcecbe9eaaa0c10c4890c352edd7626647f3ecc1e16a99f2  packages/ui/src/lib/time-format-core.ts
```
