# Local magic writer admission

`state.ts` 的 `chat.admitLocalMagic(compiled, invocation)` 接受原 registry 的
`NativeLocalCommandInvocation`，返回 `Promise<{status:'accepted'|'rejected'|'unknown'}>`。
它是既有 sender 的窄准入，不是 `chat.send({prepare})` 的别名：

- 捕获并复验真实 target/scope、`composerRevision()`、完整 text、前台/显示态、operation lane 和 invocation current；文本/资源 ABA、pending、queue-edit、只读 display 均拒绝。
- `compiled.files` 必须显式为 `[]`，agents/skills 不得带资源。只保存 invocation 捕获的 selection，dispatch 前用所属 session authority 核对；不借用当前 composer selection，不重新编译或附加当前 context。
- 本地操作始终 steer，复用原 history send lease、revert commit/repair、稳定 input ID、write-ahead flush、prompt receipt 校验和现有 refresh。不会新建 sender、stream 或 store。
- accepted 必须有匹配 input ID 与 session ID 的真实 prompt admission。未 dispatch 的异常为 rejected；dispatch 后丢失/空/畸形回执为 unknown；可靠的非超时/限流 4xx 为 rejected。后续显示或 cleanup 异常不改变已取得的 ACK。
- 三种结果都不消费源文档、引用、附件、Git context 或既有 inbox。正向恢复只清除该 pending receipt。

## Durable compatibility

沿用 `nsh:chat-draft:v1` envelope 与既有 `ContextSubmission` 字段，新增可选
`pendingSend.localMagic = {version:1, resourcePolicy:'preserve', command, selection}`。
selection 的 model 使用 `{providerID, modelID, variant?}`。没有该字段的旧 v1
记录维持原普通 send / Goal / shell / queue 语义；有字段但畸形时恢复失败并保留原字节，不能丢掉标记后按普通 draft send 重放。

write-ahead 在 POST 前持久化 `uncertain:true` 和精确 compiled payload。带标记的
pending 只能由 `recoverPendingSend()` 只读检查 inbox / exact message ID；普通
`send/retrySend` 不再 POST，即使本地 uncertain 为 false 也不能走普通发送。
404、空集合和读取失败不是否定 mutation 的回执，不解除未知锁。没有新增 replay 按钮。

## New-session

`draft.admitLocalMagic(compiled, invocation)` 返回
`Promise<{status:'accepted'|'rejected'|'unknown'; handoff?:NativeNewSessionHandoff}>`。
accepted **仅表示既有 create receipt + destination staging 已安装**，不是模型发送成功。
main 从 `handoff` 继续原 ownership transfer、导航和 `createNewSessionAdmission`；
不要直接 complete source，也不要再调用 create。

source 的上述 durable marker 明确清理策略：`complete(handoff)` 只清 pending 和
创建 receipt，保留原 document、references、attachments、context。destination 不拷贝
source document/resources，只安装原 stable-ID compiled pending；其展示 draft 为空。
`sendNewSessionHandoff` 经 `chat.dispatchLocalMagicHandoff(inputID)` 进入同一个 sender；
该窄端口只接纳已安装、同 ID、未 uncertain 的 magic pending。未知 prompt 只读核验；
未知创建沿用 `creating` receipt，跨重启不再 create，只接受原有显式空闲空会话恢复。

## Verification boundary

Vitest 使用原 state/new-session harness 与 `drafts.test.ts` 的真实临时磁盘持久化。
覆盖 source 资源保留、精确 ACK/4xx/unknown、写前失败、ABA、只读/隐藏拒绝、
module restart、无普通发送重放和 v1 marker round trip / malformed fail-closed。
未访问真实 Host、模型、凭据或原生窗口；不代表 AppKit/Win32/UIKit 与 main 接线已验收。
