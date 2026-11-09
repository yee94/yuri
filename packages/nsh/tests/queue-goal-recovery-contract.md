# Queue / Goal recovery evidence

## Ownership and change

`state.ts` remains the only owner of native session inbox mutations and durable
`queueEdit` transfers. `chat-queue.tsx` invokes that owner; Goal continues to use
the native command/RPC owner, not prompt or a second queue. No storage format,
transport API, input handler, UI layout or shared Web behavior changed here.

The edit retry previously repeated DELETE before checking whether the prior
DELETE succeeded. A committed cancellation with a lost response therefore became
a persistent 404 loop. The regression in `state.test.ts` failed at the second
`editInbox('q')` (`expected false to be true`) before the fix.

Retry now first uses the existing exact-message and inbox reconciliation:

| Authority | Result |
| --- | --- |
| Exact message absent; inbox item absent | Clear the transfer marker durably; keep text/files; no new DELETE or prompt |
| Exact message exists | Treat as consumed; never resend the consumed input; preserve later user edits |
| Either read fails | Keep recovery unresolved and sending blocked; do not infer empty success |
| Exact message absent; same item still pending | Flush the recovery record before another DELETE; then reconcile again |
| Captured runtime lease retires during a read/write | Reject the old completion; do not adopt it into the new lease |

The Web comparison is specifically the native inbox path in
`packages/ui/src/sync/session-inbox-edit.ts` and `session-prompt-api.ts`, not the
separate Yuri-owned server/local message queue. `QueuedMessageChips.tsx` also has
additional inbox transitions (including steer back to queue); this batch does not
claim those untested/native-missing actions or full feature parity.

## Executed verification

```sh
NSH_BIN=/path/to/nsh/bin/nsh bunx vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/state.test.ts \
  packages/nsh/chat-goal-state.test.ts \
  packages/nsh/chat-goal-model.test.ts \
  packages/nsh/queue-goal-recovery.test.ts \
  packages/nsh/chat-queue.test.ts \
  packages/nsh/chat-queue-presentation.test.ts \
  --testTimeout 20000
```

2026-11-08 result: **6 files / 170 tests passed**, no skipped tests in this run.
The 20-second Vitest timeout accommodates cold module transformation; it is not a
UI responsiveness or frame-time budget. The first isolated red run hit the default
5-second timeout; the subsequent run reached the actual failing boolean assertion.

- Production state: lost cancellation ACK, promoted input with/without later
  edits, exact-message/inbox failures, still-pending retry, failed durable writes,
  retired lease, and cold module/Storage restoration.
- Production App in the real NSH headless engine: three inbox items beside an
  existing Goal; edit/failed cancellation/retry with attachment retained;
  `delete=1` before and after retry; explicit send produces `prompt=1` and exactly
  one replacement queue row. Prompt wire is checked against the existing
  `sessionFiles` contract (`uri`/`name`, not the draft-only MIME field).
- Independent App interaction: Goal pause/resume/clear, steer one item, fail then
  retry removal of another; unrelated draft and surviving items remain intact;
  receipt is `delete=0 remove=2 steer=1 prompt=0`.
- The isolated Host validates the captured runtime scope and rejects unexpected
  methods/routes through the strict base fixture. It performs no fetch, model,
  speech, Git or user-directory writes. Generated per-run drivers are removed by
  their owning helper.
- Focused TypeScript check of production `state.ts` and its transitive imports
  passed using the package's existing tsconfig. Full `nsh:check` at this point
  failed in the concurrently edited `chat-changes.tsx`: TS2339 on
  `Clipboard.writeText`, TS7006 on its rejection parameter. That surface was not
  changed to obtain a green check.
- `bun run dead-code` completed; the report was inspected: 132 unused files,
  795 unused exports, 613 unused exported types, 12 exported types in used
  namespaces and 6 duplicate-export groups. Neither new recovery fixture file was
  reported unused. No unrelated entries were removed; these repository-wide
  findings are not a clean-code or runtime pass.

## Not accepted by the headless batch

This is C/F and production-App **headless** evidence, not UIKit/Safari/physical
device evidence. There was no full iOS build/install, no simulator access, no
real-Host queue or paid generation. Same-host/theme/viewport frame comparison,
keyboard/IME, requeue, drag ordering, actual process termination, real consumption
and reconnect/Relay remain unaccepted. A consumed item with later edits stays
blocked for explicit resolution; this test does not prove a complete UI recovery
exit for that case. Performance guards passing does not establish measured input
latency. C16/F19 and all 73 matrix rows therefore remain incomplete.

## Follow-up: full UIKit / real Safari, isolated HTTP authority

2026-11-08: batch P in `PROJECTS-SESSION-ACCEPTANCE.md` supplements (does not
retroactively broaden) the headless results above. Full production build
`2026-11-08T01-33-19-349Z-78eaed1d` used 53 frozen Swift inputs, the production
RuntimeBridge and normal connection UI, all App UI/resources/GUI preview/branding,
and no business-source override. Build exited 0 with existing MainActor warnings
in `FeedbackLayoutBridge.swift`. Installation hashes match the recorded executable
and bytecode hashes. The separate simulator was not shared with the parallel SDK
investigation. No physical device, model runner, paid generation or real user
project was involved.

Evidence is retained under `.scratch/nsh/queue-goal-platform-evidence/`:

| Evidence | Actual observation |
| --- | --- |
| `native-final-baseline.json`, `safari-final-baseline.json` | Same loopback Host, directory, three inbox identities, Goal, selected Fixture Model, dark theme and 402×874 device screen |
| `native-final-lost-ack.json`, `native-final-recovered.json` | Real touch editing → committed DELETE/503 → explicit recovery; `editDelete=1`, `prompt=0`, text and `queued.txt` retained |
| `native-final-requeued.json`, `safari-final-requeued.json` | One successful manual re-admission on each platform, two unrelated original items and active Goal preserved; `editDelete=1`, `prompt=1`, one replacement row |
| `native-goal-{paused,resumed,cleared}.json`, Safari equivalents | Actual panel/row controls change authoritative Goal; clearing leaves unrelated queue entries intact |
| `native-remove-{failed,retried}.json`, Safari equivalents | First removal 503 retains the item, second succeeds; `removeDelete=2`, independent `steer=1` |
| `native-final-process-reopen.json` | Actual process terminate/launch and normal project/session navigation; same queue, `prompt=1`, no additional DELETE |
| `verification-summary.json` | Assertions over captured AX/audit: both platform flows above pass; real runner, equal content viewport and pixel-parity flags remain false |
| `build-install-verification.json` | Installed executable/bytecode match frozen build; state, drafts and all queue/Goal source hashes match current files |

Screenshots referenced by capture basename are retained in the approved OS
temporary evidence directory and were visually inspected for baseline, failure
and restoration states. The original `native-baseline` / `safari-baseline` files
are **not** the final pair: they contained incomplete fixture routes/catalogs.

### Fixture corrections and real differences

- Added valid permission/voice reads, raw session response and provider catalog
  `partial:false`. The catalog parser requires that flag. Before correction,
  Safari had no selected model; those frames are not accepted same-state evidence.
- Yuri-owned queue capability **501** is the existing Web cutover contract for a
  native-inbox-only Host. `capability:false` is a blocked state, not legacy mode.
  Initial disabled actions were fixture defects, not proven product failures.
- The initial synthetic `attachment://` URI is not a durable URL supported by the
  Web restoration builder. Final repeated flows use the same valid
  `file:///isolated/queue-goal/queued.txt` reference on both platforms. There is no
  actual file read in this fixture.
- Native retains the URI/name in the new prompt. Web deliberately compiles a
  non-image `.txt` into the existing synthetic Host-path reminder and diagnostic
  selection metadata (`packages/ui/src/lib/opencode/client.ts`, `promptFilePart`).
  Its first rejections were overstrict fixture expectations, not evidence of lost
  files. Final HTTP validation admits either exact production representation and
  rejects arbitrary prompt/selection writes. Successful Web wire contains the
  exact original path. This does **not** prove equivalent real-runner consumption.
- Safari also attempts the ancillary `message-sent` route, which the fixture
  rejects with 405. Its final `blocked=1` is that route; the prompt itself succeeds
  once. No later successful prompt was counted to hide a duplicate.
- Native shows attachment count/name and explicit unknown-state recovery. Safari
  does not show the same filename/recovery control in the captured compact view;
  it preserves a draft and compiles its reference. These are recorded interaction
  differences, not pixel or recovery-UX parity acceptance.
- Both share a 402×874 **screen**, not identical usable content viewports: Safari
  browser chrome is present. Raw queue-row/action geometries and typography differ;
  do not subtract absolute Y positions and call this a layout regression or pass.

### Still open

Current full-package `nsh:check` passed again after parallel Changes work, without
editing that owner's code. However the source recheck found later drift in
`FeedbackLayoutBridge.swift`, `ResourceBridge.swift`, `SheetPresentation.swift`,
`error-notice.tsx`, `chat-changes.tsx`, `transcript-tools.tsx` and
`transcript-tools-model.ts`. This is a frozen full-App run, **not** acceptance of
the latest complete App or current Sheet implementation. Web production dist was
served and its HTML hash recorded; it was not rebuilt in this follow-up, so its
current-source equivalence is not established.

The final focus tap did not establish a visible software keyboard. Full keyboard /
IME, equal-content-viewport comparison, current-build overlays, consumed-before-
cancel recovery, steer-back-to-queue, drag ordering, Relay/physical device and
other Projects/Session entrypoints remain unaccepted. `realRunner:false` is an
explicit evidence boundary, not a completed queue-consumption test. All 73 matrix
rows remain incomplete. `cleanup-verification.json` confirms owned ports closed,
the dedicated simulator shut down (not deleted), evidence retained and the
parallel simulator left booted. The earlier 170-test suite was not rerun for this
fixture/docs-only follow-up; current full-package typecheck and runtime/audit
assertions are the new validation.

## Batch Q: common frozen source, standalone Web and actual keyboard

Both platforms were rebuilt from the same 6419-input snapshot. Full UIKit build
`2026-11-08T02-24-31-769Z-ec7076cf` succeeded with 53 Swift inputs and no business
override. Installed executable and bytecode hashes match; staged app inputs match
the freeze manifest. Final Web CSS is 457818 bytes with generated utilities, not
the earlier incomplete PostCSS output. Served final static hashes are checked.

The Web app installed from `/` stays standalone through session navigation with a
402×812 root/visual viewport at scale 1. Installing from `mobile.html` did not keep
navigation chrome-free and is not the comparison baseline. Read-only LLDB measured
UIKit window/root 402×874 and safe insets top62/bottom34: the top-excluded canvas is
402×812 but fully safe content is 402×778. This removes browser-chrome uncertainty,
not the remaining layout/safe-area differences. No viewport/layout override was
applied. The final same-state baseline checks full inbox-array and Goal equality.

`q-native-*` / `q-web-*` retain these actual interactions:

- Committed DELETE/503, preserved draft, then exactly one re-admission per platform;
  Native sends while its real keyboard is visible, Web after dismissing it.
- Real system Pinyin keys: `n` → Chinese candidate `你` → delete back to original.
  Recorded composition/candidate values and keyboard keys prove more than focus;
  no prompt was sent during composition. No dictation/model request was used.
- Goal pause/resume through each platform's actual controls.
- Shared Projects menu order, and Native edit icon draft → dirty close confirmation
  → cancel stays in editor → discard returns without saving.

Recovered Web focus initially placed send and the OS input-accessory Done button
in intersecting AX frames and scrolled the chat header out of view. Native kept
its header/send visible. A later ready-state Web input of `你` moved the composer
above the accessory, so this is **stage-specific evidence requiring reproduction**,
not a claim that Web sending is always obscured. `/api/info` was missing in the
fixture; adding its read-only version response removed the false initialization
error. Earlier failure/recovery input evidence is retained with that limitation;
ready-state baseline/keyboard evidence is separate. The temporary final character
probe was removed without sending.

Verification: `python3 .scratch/nsh/verify-frozen-queue.py` writes
`q-verification-summary.json`, asserting frozen-source and installed hashes,
current served assets, common canvas dimensions, same-state inbox/Goal, real
keyboard/candidate changes, one DELETE/one prompt each, menu/dirty cancellation,
and 73 incomplete rows. It also records live-source drift (including parallel
implementation work and this batch's acceptance docs) without reverting it.
`q-native-viewport.json` is the actual Native
measurement; a Native capture's `viewportEvidence` belongs only to the Web observer.

Not accepted: complete UI parity, real runner consumption, all recovery branches,
Goal failure/clear/steer/delete branches on this new build, all Projects editor
branches, physical devices/Relay, continuous keyboard animation, multiline,
selection/undo/external keyboard and input-latency budget. Prior 170 headless tests
were not rerun or recounted as Q evidence. Full batch details and next rows are in
`PROJECTS-SESSION-ACCEPTANCE.md` batch Q.

Cleanup is verified in `q-cleanup.json`: owned HTTP/helper ports closed, dedicated
simulator shut down, parallel simulator untouched. `q-image-index.json` preserves
41 screenshots under `q-screenshots/` with hashes. The source snapshot, full audit,
device data and test Web Clips are retained; nothing was committed or published.
