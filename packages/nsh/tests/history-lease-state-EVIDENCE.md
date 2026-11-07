# State owner handoff: history / Host lease / notification catalog

## Implemented boundaries

- `history-presentation.ts` + `state.createChat`: optional synchronous pre-flush data callback, projected final footer facts, successful-history/presentation/failure/reset authority and scoped mounted owner/history generation. No application/footer/UI/offset writer changes.
- `runtime-scope.ts` + `runtime.ts`: strict Native scope parsing, frozen captured senders, scoped GET, mandatory scope for all non-GET, raw status/body parser boundary, actual connection snapshot parsing. No `runtime -> state` import or Native-wide implicit scope injection.
- `state.ts`: direct select-snapshot adoption, real optional authorization field, scope/metadata fences, foreground snapshot-before-demand, same-Host Chat operation-only reconstruction with retained messages/window/row references/draft owner, fixed old senders and no unknown-write replay. `captureHostOperation()` is the page-owner assembly seam.
- Root notification catalog: existing refresh writer publishes domain success/completeness receipt. Await joins/reuses that writer, rejects partial/failure/stale authority and accepts genuine empty success; separate page writers cannot lend replacement arrays the prior root receipt.

Integration contracts are [history-presentation-contract.md](history-presentation-contract.md), [runtime-scope-contract.md](runtime-scope-contract.md), and [notification-catalog-contract.md](notification-catalog-contract.md). They include exact main props, persistent Tab/route operation lifetime, and the concrete Voice capability-reacquisition blocker.

## Pure checks actually run

Final focused command, all **10 files / 224 tests pass**:

```sh
bunx --no-install --package vitest@4.1.11 vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/notification-catalog-state.test.ts \
  packages/nsh/runtime-scope-state.test.ts \
  packages/nsh/runtime-scope.test.ts \
  packages/nsh/history-presentation.test.ts \
  packages/nsh/history-state.test.ts \
  packages/nsh/chat-authority-state.test.ts \
  packages/nsh/transcript-actions-state.test.ts \
  packages/nsh/state.test.ts \
  packages/nsh/chat-goal-state.test.ts \
  packages/nsh/context-usage-route.test.ts
```

Evidence groups remain distinct:

| Group | Focused tests | What it proves |
| --- | --- | --- |
| History presentation | 15 | Real createChat writer + dependency-tracked batched observer sees final facts/rows/footprint together; error/reset/repair/gap/callback/operation-count guards |
| Runtime factory | 6 | Strict parse, immutable sender, non-GET rejection, raw contract, no implicit Native injection/replay |
| Runtime state | 14 | A→B→A, foreground snapshot ordering, same-Host window/row/draft identity, old reads/prepare/ACK/compiler/materializer fences, repeated-fixture-lease reconstruction |
| Notification catalog | 26 | Full/empty success, shared root flight, domain failure/partial/retry, dirty tips, Host/auth/lease/page/refresh fences and array ownership |
| Existing focused surfaces | 163 | History, authority, transcript actions, Context observer, Goal and existing state behavior |

`tsc -p packages/nsh/tests/runtime-scope-tsconfig.json --noEmit` passes, including the new tests and actual source dependency closure. A separate `bun build packages/nsh/state.ts --target=browser --external nsh --outfile <temporary-output>` succeeds (54 modules); this is isolated static bundling, not a main/NSH engine build.

Package-level `tsc -p packages/nsh/tsconfig.json --noEmit` was also attempted. It is not green: the GUI browser test cannot resolve two existing module imports and has a missing value prop, while shared desktop Window declarations are omitted by that package configuration. The focused config explicitly includes the existing desktop declarations and does not include the unrelated browser test; it does not silence diagnostics in owned state/runtime source.

Offline cached `knip@5.80.0 --no-exit-code --include files,exports,nsExports,types,nsTypes,enumMembers,duplicates --reporter json` ran. The report remains non-clean across the repository (123 unused files, 437 issue records). In the owned modules it reports the root-facing `captureHostOperation`, `awaitNotificationCatalogReady`, `resumeChatOperations` exports and the catalog state type as not yet consumed by application. These are intentional pending main integration points, not deleted to hide the report.

## Guards proved red and restored

Using exact local patches (no Git commands), temporarily disconnected the optional history callback: the final-exhaustion batched presentation regression failed with zero terminal notices. Restored the callback. Temporarily removed outgoing expectedHost: the captured-lease GET/POST test failed for both requests. Restored expectedHost. All final checks above ran after restoration.

## Not completed or claimed

No engine, UIKit, device, real Host, network acceptance, main build, Swift edit, dependency install or Git operation was performed. Tool discovery exposed no usable subagent/delegation tool, so this evidence has no independent delegated review.

Main still owns actual application notification props/recover trigger, stable route/Tab display lifetime, and business/Settings operation-owner reconstruction. In particular, the supplied Voice lifecycle engine red is explained by the fixed settingsLifetime epoch and constructor-captured request/scope; the new state factory and pure repeated-lease test do not substitute for modifying that owner and rerunning its engine test.

No production footer experiment was enabled, no offset/inset compensation added, and no scroll threshold changed. Main's supplied build6 fixture numbers are fixture evidence only. This handoff does not claim that the real production Host 53pt jump, partial footer shrink or UIKit release has been solved.
