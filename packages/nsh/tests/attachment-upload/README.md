# Contact attachment frozen consumer interface

Host protocol authority remains `packages/web/server/lib/assistants/DOCUMENTATION.md`
§ Contact upload receipt and retirement HTTP contract. No Host implementation or
resource/Observer code is modified by this owner.

## Production interfaces

- `state.captureAttachment(pageOperation)` captures the exact page object, runtime
  lane, immutable target, authoritative contact generation, text/reference edit
  revision and complete local draft revision. A cache seed or unknown generation
  cannot authorize a picker. `prepare()` awaits the existing durable draft owner's
  `checkpoint()` and rechecks every fence; it returns `contactGeneration`, transient
  `draftIdentity`, stable `draftRevision` and opaque `pageOperation` metadata.
- `adopt(raw)` validates descriptor generation and all original fences before a
  single append. Text/reference/attachment edits, reset, scope or page A-B-A reject
  the result. `commit()` waits for the original durable attachment write before
  native metadata can be acknowledged. `recover(raw, savedRevision)` is used only
  after explicit cold GET reconciliation; it requires the same checkpoint, or
  confirms an exact descriptor already persisted without appending twice.
- `attachment-pick` retains the original adopter across lost ACK. Another press of
  the existing Attach button invokes GET reconciliation, not another picker/PUT.
  Rejected/stale results go through exact retirement. The original accepted draft
  can finish a local exact ACK after lease retirement; it sends no Host request.
- `runtime.pickAttachment` receives `kind`, `assistantID`, `requestId`, `expectedHost`
  and the captured context above. Native GET generation must match the captured JS
  value before the receipt probe/presentation. New PUTs always carry the marker and
  captured generation. Even 201 requires an exact receipt GET before adoption.
- `runtime.pendingAttachments` receives `expectedHost`, `assistantID` and the captured
  draft context. It lists only exact connection/assistant/hashed-draft receipts, at
  most 64, with `requestId`, `uploadID`, `generation`, `draftRevision` and `phase`.
  A surviving old native owner is marked `retiring` with `cleanupHost`; a new JS
  page may only retire it using that original scope, never inherit its adopter.
- `runtime.reconcileAttachment({requestId, expectedHost})` performs only exact GET.
  Null means unresolved not_found/inflight, not a cancellation ACK. Restored native
  operations have no PUT capability. Their GET/DELETE uses only the original
  Keychain connection/transport/authorization/record-version identity.
- `runtime.cancelAttachment({requestId, expectedHost, assistantID})` awaits exact
  DELETE and validates the complete retirement envelope. Failed cleanup stays
  visible/retryable. `runtime.acknowledgeAttachment` compares the exact descriptor
  after the adopter's durable write and releases only that operation's metadata.
  All handlers and NSH capability entries are installed in production.

## Cold-recovery local ACK lifetime (oracle P2)

A successful cold committed GET now retains only its exact local acknowledgement
closure in `AttachmentBridge`, keyed by original request ID and captured scope.
`acknowledgePick` consumes that owner instead of reconstructing an operation through
`admit(expectedHost)`. The closure checks original connection/transport/authorization/
record-version and exact descriptor, then performs request/upload-CAS metadata removal.
It does not require a still-current lease after the accepted draft's durable write.
Unknown/inflight/not_found results do not create this owner; no GET or PUT capability
is retained through it. Explicit retirement revokes the local ACK owner.

Failed storage removal retains the owner and journal for exact retry. Actual original
authorization revocation or record-version change still rejects local ACK without
network or metadata deletion. A late clear cannot erase another upload that reused
a request ID. Public bridge contracts and the journal schema are unchanged.

`cold-ack.swift` runs the actual production Bridge plus extracted production Runtime
methods and original-authorization lookup: cold committed GET → deferred durable draft
write → background/new Host lease → local ACK. It also covers failed clear/retry,
revocation/record changes, foreign descriptor, replacement metadata, unknown non-ACK
and a new same-contact picker. The companion `attachment-pick.test.ts` regression
executes the production pending-cleanup queue and verifies old-scope ACK drains
before the new Attach reads the journal, with no repeated PUT or duplicate adoption.

## Device journal and failure states

`AttachmentReceiptJournal.swift` uses NSH's existing device `storageDirectory`
interface and atomic metadata writes. The record schema is version 1, bounded at
64 receipts / 256 KiB. Required fields are `requestID`, `uploadID`, `assistantID`,
`connectionID`, `transportID`, `authorizationID`, `connectionVersion`, `generation`,
`draftID` (SHA-256 of the original durable key), `draftRevision`, `pageOperation`,
`phase` and `descriptor` (null or a typed exact Host descriptor). Phases are
`prepared`, `unknown`, `retiring`, `retired`. Credentials, URLs, original bytes,
user paths, message text and closures are never serialized.

The prepared record must be durable before presentation. Unknown must be durable
before PUT; failure there sends zero PUTs. A real dispatch followed by lost ACK or
storage failure remains unknown. Descriptor persistence precedes adoption. Exact
retirement persists its irreversible local fence before DELETE; a validated Host
ACK permits exact local removal. Failed removal is retried, never treated as a
successful empty journal. Every update/remove compares requestID plus uploadID;
late callbacks cannot resurrect old metadata or erase a replacement operation.

Missing/revoked/changed original authorization or connection-record version returns
`attachment_original_authorization_unavailable` with zero recovery network traffic.
The record remains pending for explicit retry if the original connection is restored;
no arbitrary current Host, new lease or replacement credential can upload it.
An unreadable/corrupt journal returns `attachment_receipt_storage_failed`; no failure
is normalized to an empty catalog. Capacity rejects new owners without eviction.
Zero-dispatch errors are distinguished from `attachment_upload_unknown`. Existing
Chat/global error surfaces provide translated retry guidance in every shipped locale.

Original Photos/provider files, session temporary files and shared objects are never
deleted. Retirement prohibits new admission and never reports physical deletion.
Same hash plus different uploadIDs remains separate ownership.

## Validation and remaining acceptance boundaries

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/attachment-upload-swift.test.ts packages/nsh/attachment-pick.test.ts packages/nsh/attachments.test.ts packages/nsh/state.test.ts --testTimeout=15000
bunx tsc --noEmit -p packages/nsh/tsconfig.json
```

The Swift fixtures execute production policy, journal, extracted actual Runtime
attachment methods and the production ConnectionStore exact lookup with injected
send/current/storage and temporary original files. They reconstruct journal/runtime
without live closures and cover lost ACK GET-only, reset before picker/during PUT/
after commit, precommit retirement, pre/post-dispatch persistence failure, cleanup
retry, authorization/record changes, late exact clear, same-hash isolation, noReplay
and the 64-owner cap. Production picker delegates run with delayed UIKit doubles.
Actual state tests cover canonical generation unknown, text ABA, exact page-operation
and Host A-B-A, one append, durable recovery and storage-before-ACK through the real
picker retry entry. Installed NSH check, tsc, iOS SDK typecheck and full Swift compile/
link are separate build checks, not device evidence.

Main owns actual UIKit/Photos and the independent oracle. No real Host, socket,
model, device, Git operation or dependency change is used by these tests.
The 15-second runner timeout covers cold TypeScript module import on a shared build
machine; no operation-count, CAS, protocol or lifecycle assertion is relaxed.

Known frozen-interface conflict requiring the resource owner: as currently written,
`ios/ResourceBridge.swift` ContactAttachmentResource descriptor whitelist does not accept
`generation`, while `resources-request.ts` forwards the typed canonical descriptor.
This owner preserves generation and leaves that frozen source unchanged. New contact
attachment preview is therefore not accepted until the resource owner resolves this
precise boundary; it must not be hidden by silently dropping descriptor metadata.
