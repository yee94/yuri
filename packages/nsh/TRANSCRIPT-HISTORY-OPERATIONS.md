# Transcript history owning operations

`createNativeTranscriptHistory` remains the page-owned history/backup controller. It exposes real operations for desktop local commands and Timeline without creating a second Chat, sender, stream, history collection or store.

## Exact integration API

桌面 main 的 history backup/intent 分区额外包含稳定连接 ID/origin/authorization 身份，不包含 lease；同身份续租沿用，同 ID 换源或换授权不采用旧记录。旧的未按授权分区记录不自动迁移或删除。iOS 原有 storage key 不变。Timeline 只保留本 Chat 的 operation 与 sync，不能以打开模态为由新建 history owner 或覆盖 `chat` stream。

```ts
history.stage(messageIDOrMessage, invocation?) // stage a user boundary, files: true
history.clear(invocation?)                   // restore the entire reverted tail
history.fork(messageIDOrNull, invocation?)    // null = fork-current
history.undo(invocation?)                    // shared Web resolver, previous user
history.redoStep(invocation?)                // shared Web resolver, next user or final clear
```

Every method returns `Promise<NativeHistoryOutcome>` with explicit `status: 'accepted' | 'rejected' | 'unknown'`, optional `reason/error`, and an actual acknowledged fork `target` when available. `invocation` structurally accepts the local-command registry's `current()`; it is checked before dispatch and after preparation. Timeline's operation record has no `current()` method: main can supply a separate `{ current: () => exactTimelineScopeStillAdmitted }` guard. Do not convert legacy `createTranscriptActions.edit/revert/redo/fork` resolved `void` into a local-command receipt. Those wrappers remain for existing message UI only.

Main may bind registry actions directly to `history.undo(invocation)`, `history.redoStep(invocation)` and `history.fork(null, invocation)`. Timeline's one-argument callbacks delegate selected mutations to `stage(id, guard)` / `fork(id, guard)` with the captured guard described above. Only the existing owner calls `onOpenChat`; do not perform a second navigation from a delayed receipt. A returned fork directory must be explicit; the callback is only called for the source target's actual directory.

`capability()` returns `{ stage, clear, fork, undo, redo }`; `pending()`, `unknown()` and `canRead()` are signal-reading accessors. `pending()` includes the shared Chat history lane, including unknown ownership. `read()` exposes actual authoritative messages, marker and completeness, not a second history window. Slash redo must use `redoStep`, not `clear` or the ordinary revert Indicator's full restore.

## Modal admission

Keep this controller and its existing Chat mounted when opening Timeline. `canRead` is an optional input supplying main's exact session/Host/page-lifetime foreground authority, including the owning Timeline modal. Without it, the existing `current() && chat.active()` admission is unchanged.

Main must also keep the supplied `operation()` authoritative while the owning modal is admitted: a page operation already revoked by `chat.active() === false` cannot be revived by `canRead`. Keep the original Chat read/sync demand through main's existing lifecycle lane; never instantiate another Chat/stream to work around modal suspension. Do not broaden admission to settings, another session/directory, a retired Host or the background. The invocation must remain tied to the actual modal or local-command operation. Merely opening Timeline does not execute a mutation.

## Completion, serialization and receipts

- Undo/redo refresh the existing marker authority and serially call the same `chat.loadOlder()` until `messagesResolved`, explicit `more === false`, no gap and no read/paging error prove completeness. No loader, stalled paging, missing marker or failed read returns `rejected / history-incomplete`. A null next user in a partial collection is never final redo. The shared history lane is reserved throughout paging and mutation.
- Stage/edit keep authoritative user reads, idle rechecks, durable attachment checks and the existing history draft backup/document CAS. Queue/pending sends are not cleared or overwritten. Ordinary message edit/revert/fork and full restore use the same mutation owner.
- Fork validates exact session ID/directory, parses actual descending opaque pages and calls the existing `resolveNativeForkBoundary`. Fork-current uses the existing session fork endpoint; no new create-session route is invented. The returned directory is never guessed from the source.
- Before dispatch, the owner saves a separate `nsh:history-operation:v1:<storageKey>` intent containing only target identity and write kind/boundary. `storageKey` must remain Host/session/directory scoped. Backup contents and credentials are not copied into the intent. Intent-storage/pre-dispatch failure is rejected without a network write.
- Explicit HTTP 4xx rejections release the gate (HTTP 408 remains unknown). Lost ACK, timeout, transport failure, 5xx or malformed mutation acknowledgement stays unknown. The original owner retains its mutation lock, history busy state and durable intent; reopening conservatively restores the lock, never the write.
- A parsed valid ACK is accepted even if later refresh, local persistence or navigation fails. No refresh failure turns an acknowledged operation into a replayable rejected/unknown result.
- Fork 的 `onOpenChat` 只在原 core mutation gate 与 page history gate 都结算后通知；普通消息入口与本地命令共用此顺序。窗口离页保护可以因此复验已完成的原 owner，不能在 callback 中绕过 pending 或重新派发 fork。通知前仍复验 captured operation、invocation 与 exact directory；导航失败不改变已确认 ACK。
- `reconcile()` performs read-only authority refresh. A missing marker, empty collection, different state or HTTP 404 is not a negative mutation receipt. The current upstream exposes no operation receipt/causal ID for these writes, notably fork; unknown therefore stays unknown with `upstream-receipt-unavailable`. There is deliberately no automatic retry, replay, heuristic newest-fork selection or manual clear-as-denial method. Main must not settle its own unknown registry/Timeline gate from a normal snapshot.

## Verification boundary

Focused tests execute the real core, page controller (TSX transpiled with presentation imports stubbed), backup and shared Web resolvers against synthetic requests/storage. They cover receipts, retained unknown, reopening, post-ACK refresh failure, directory matching, backup transfer, paging serialization and row exclusion. They do not contact a real Host, run a model, create a real fork, start a stream or prove AppKit/Win32/UIKit geometry. No `.nsh/test` engine is required for these focused tests.
