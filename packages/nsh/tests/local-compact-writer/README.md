# Native local compact writer

`chat.admitLocalCompact(invocation): Promise<{status:'accepted'|'rejected'|'unknown'}>`
is a narrow control admission on the existing Chat writer. It does not call
`chat.command`, replace the document, select a model, create a sender/stream, or
create another store. Only the current writable session owner can admit it.

## Composer and wire

The snapshot must contain a bare authored `/compact`, matching target, scope,
operation/lifecycle and monotonic document revision. Both an unchanged captured
document and the shared registry's exact single text-consumption revision are
accepted; edits/ABA, unconfirmed tail, references, queue-edit, pending receipt,
hidden/read-only owner or an active compaction barrier are rejected. The writer
itself never consumes current text, attachments, references or Git context.

Wire authority is `ui/src/sync/session-compaction-api.ts`: POST
`/api/session/:id/compact?directory=…` with `{id,delivery:'steer'}` only. No legacy
summarize route, provider/model patch, prompt metadata or resources are sent.
The existing history lease/revert commit, pendingSend write-ahead, dispatch,
cleanup and authoritative refresh remain the single operation lane.

accepted requires a real inbox item with exact request ID, session ID and
`type:'compaction'`. A pre-dispatch exception or reliable non-timeout/non-rate-limit
4xx is rejected; missing/void/malformed/wrong-ID/wrong-session ACK or ambiguous
dispatch is unknown. Once an exact ACK exists, later refresh/cleanup failure does
not turn it into a replayable operation.

## Durable compatibility and upstream limits

The original v1 pending journal adds only
`localCompact:{version:1,resourcePolicy:'preserve'}`. Its owned text/files/references
are empty, with no compiled prompt, command or context. Older unmarked v1 sends
keep their existing semantics; malformed markers fail closed and retain prior
stored bytes. The original authored source stays in its independent fields.

The current upstream `Session.compact` accepts the supplied `id`; server handler
passes it unchanged. `SessionInbox.admitCompaction` returns the exact pending
compaction for that ID, but may coalesce onto another pending compaction ID and
rejects a promoted ID. This is **not** an unconditional replay guarantee. Even
after restart, ordinary send/retry only reads the inbox or exact typed/statused
checkpoint for the original stable ID. 404, empty inbox, fetch failure, a user
message with that ID, or a coalesced other-ID ACK do not authorize replay or fake
success. A coalesced other-ID ACK conservatively remains unknown for this local
operation, while its real returned barrier is retained.

## One native inbox barrier

`chat.compactionBarrier()` is read-only and owned by the same Chat. The original
inbox GET keeps user queue rows unchanged while retaining compaction controls for
the barrier; `session.compaction.*` and adopted latest history checkpoints update
that same state. Exact terminal IDs cannot clear another pending compaction;
late GETs are revision-fenced. Inbox absence/read failure alone never clears a
promoted running barrier. Unknown compact receipts also veto explicit steer,
without pretending persisted unknown state is live activity. Queue admission,
cancel/edit, Goal and ordinary prompt dispatch retain their existing semantics;
the upstream inbox remains authoritative for actual promotion.

## Verification

`state.test.ts` covers real registry consumption, id/delivery-only wire,
write-ahead, source resources, precise/invalid/coalesced ACKs, HTTP outcomes,
cross-module restart, exact read-only recovery, stale barrier reads/events,
queue steer gating and ACK-after-refresh-failure behavior. `drafts.test.ts` uses
real temporary disk for marker round trips and malformed-write preservation.

`local-compact-writer-native.test.ts` runs six isolated NSH 0.4.0 Mac/Windows
headless scenarios using the actual registry/writer and strict fake Host. This
is not full application/menu wiring, native-window rendering or real Host/model
validation; main owns the production action binding.

The compact POST fixture now calls `fixture.writer.assertWrite` with the exact
session target before recording a request or simulating a lost ACK. The Commands
wrapper directly verifies absent, omitted, wrong-target, wrong-kind, released and
old-lease grants are rejected, while an exact live session grant is accepted.
It does not synthesize or acquire a grant on behalf of the writer.

The stricter Host initially exposed that `Root.tsx` constructed `createChat`
without a desktop `writerGrant`. The fixture now uses the real root loader and
`NativeDesktopChatWriter`, waits for verified ACK before constructing Chat, and
injects the same grant/unknown hook plus an independent read-only recovery lane.
Grant unknown disables writable activity just like the production root; the
fixture observes the actual writer action result instead of expecting an inactive
registry to publish a UI callback. All six original scenarios pass, with their
attachment, barrier and no-replay assertions retained.

A valid same-session coalesced compaction receipt now preserves that returned
operation's barrier before checking this submission's causal ID. It cannot
acknowledge the original pending intent, clear sticky native unknown, or borrow
another session's receipt. Malformed/wrong-session receipts create no barrier.
The actual `YuriNativeApp` Commands fixture, including compact ACK/unknown
recovery on both models, passes all 50 scenarios; its wrapper additionally passes
45 direct Host authorization tests. Latest combined state/compact/Commands run:
three files, 205 outer tests passed (nested scenarios are not added again). See
[Commands fixture evidence and limitations](../desktop-commands-application/README.md).
