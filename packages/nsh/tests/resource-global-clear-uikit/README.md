# Independent production global-clear UIKit carrier

Only build this fixture in the agent session. Main owns every install, launch and UIKit operation. Existing `resource-page-uikit` outputs, ec8c465f, and its builder are untouched. A built app is **not** a UIKit PASS.

The actual application AX/display name is **Synthetic Global Clear QA**. Build 05f2b824 has a fixture-only hit-area failure: enable was at x=8/y=8, 17pt high, under system status/breadcrumb UI. Main's tap returned to HistoryProductionQA; controls remained disabled and only backgrounding was audited. No resource open/fullscreen/global-revocation operation ran. Preserve that artifact and `.scratch/nsh/global-05f2b824-preview-enable/` as fixture-hit-area red evidence, not a production pre-attach failure or crash.

The toolbar follow-up applies the public reactive `nsh.safeArea` top/bottom/left/right as padding on the fixture root only. Four controls use two rows with two 44pt-high Buttons each, short visible test labels and full accessibility labels; all existing testIDs/callbacks are retained. The toolbar is nonshrinking and 112pt high; the lower NavStack takes the remaining space with a zero minimum height. No padding or sizing is passed into the production page or fullscreen Dialog. The fixture Open button also has a 44pt minimum hit height. Static frame constraints cover 402×874, 320×568 and 844×390 safe-area inputs, and actual TSX callbacks cover explicit enable/audit/one-switch/two-switch dispatch. These checks are not measured UIKit frames; main must install the new unique build and inspect its actual AX geometry before attempting the scenario.

## Scope and provenance

- Real `ResourcePreviewPage` → resource owner → HTML viewer, native NSH NavStack/NavPage/Dialog, actual ResourceBridge and NativeAnchor.
- The builder extracts the exact connection-ID effect from `application.tsx`. The effect calls the unchanged `createResourceConnectionClear`; it is not a separate clear algorithm. Complete `Application`/AppRoutes and other navigation behavior are not claimed.
- Synthetic in-memory RuntimeHostAuthority, exact GET allowlist and static HTML. No RuntimeBridge/ConnectionStore instance, credentials, network, real Host or Host writes. The existing `guiPreview: false` prop avoids unrelated GUI setup; GUI behavior is outside scope.
- Controls are disabled until `resource-global-enable`. No production UI, timer, sleep, delay, state mutation or test flag is added.

Two transparent **fixture-only** adapters are recorded in `fixture-build.json`:

1. Frozen `resource-html-native.tsx` wraps the public native component's real event props to journal and then forward the original event. It never invokes opened/closed except upon the matching actual native event. Original adapter bytes are preserved under `originals/`.
2. The production Swift anchor and ResourceBridge files are included byte-for-byte as prefixes of generated compilation units. Test appendices in the same files can construct the private anchor and observe the real private release method without changing those production bodies. No public/private UIKit API interception or SDK stub is used.

The anchor carrier initially withholds **only** the actual anchor UIView from its parent. When its own UIKit `didMoveToWindow`/layout proves a containing presented controller, it checks the real anchor has no window, records `preAttachConfirmed`, rotates memory authority, and emits the connection snapshot. JS changes connection ID first (triggering the extracted production global effect). A transparent forwarding observer on the registered production retirement port records `globalClearAdmitted`; only its follow-up job publishes the new scope and pushes a later route. This keeps the later route strictly after the actual capture even if the SDK batches effects, and prevents a scope boundary from doing the work before global admission. After the real closing prop/attempt and connection-applied ACK arrive, the carrier inserts the original UIView. UIKit drives its actual attach, opening observer, action-registration failure and exact dismissal. No production anchor state is modified and no completion is synthesized.

`Arm two switches` repeats ID B → C through that same effect before releasing the UIView. A later B route belongs to the second capture; the later C route must survive the old completion. This is stronger than testing a local Back or changing only runtimeScope.

## Build only

```sh
NSH_BIN=/path/to/bin/nsh node packages/nsh/scripts/build-resource-global-clear-uikit.mjs
```

Optional `--stage-only` freezes/typechecks; `--bundle-only` additionally compiles the NSH bundle. Default also freezes the real SDK, typechecks/links Swift and ad-hoc signs a simulator app. Each invocation creates a unique `.nsh/resource-global-clear-uikit/<build-id>/` and bundle ID. No install/launch command is executed. Manifest includes source hashes, exact extracted-effect hash, adapter/generated-unit provenance, SDK/bundle/executable hashes and source-drift check.

Read-only artifact verification (does not launch anything):

```sh
node packages/nsh/tests/resource-global-clear-uikit/check-build.mjs /absolute/path/fixture-build.json
```

It verifies frozen source/type inputs, both explicit adapters, unchanged production Swift prefixes, the exact original effect, capability allowlist, and SDK/bundle/executable hashes. Its output deliberately says `actualUIKitValidated: false`.

Fixture-only static layout/TSX callback regression (no engine/device/Host):

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/resource-global-clear-fixture.test.ts
```

## Main operation: preview mode

Start a fresh app instance per scenario; do not reuse one whose authority has already rotated or which entered the background.

First confirm **Synthetic Global Clear QA** and inspect the new toolbar AX: each control's height must be at least 44pt, its frame fully within the native safe region, with no overlap with status/breadcrumb or the lower native navigation header. Do not reuse the old y≈16 enable coordinate. If geometry is wrong, retain the audit/AX and stop; no production lifecycle verdict follows from that failure.

1. Press `resource-global-enable` (explicit opt-in), then `resource-global-open`. It opens the production resource page with synthetic HTML.
2. Leave the production viewer in preview mode. Do not use Refresh or Save/Share in this timing scenario.
3. Press `resource-global-arm` in the fixture toolbar. Alternatively use `resource-global-arm-twice` to test B/C captures and later-route survival.
4. Press the **production** `resource-html-fullscreen`. No further timing click is required: mounting the actual Dialog triggers the stage gate and authority/connection switch.
5. Wait for the actual Dialog to dismiss. Expected destination is `resource-global-late-route`, **not** the root and not a still-open original resource page. No local resource Back is part of this scenario.
6. Press `resource-global-audit`; read the JSON from `resource-global-audit-value` in the visible later route. Save its AX snapshot alongside the manifest/build ID. The native readback method is `fixture.globalClear.audit` (no parameters); the UI button calls that exact handler. There is no HTTP audit server.

If the modal remains pending, **do not** click an underlying audit/Back through it. Every record also atomically replaces the same bounded metadata snapshot at the isolated app's `Documents/global-clear-audit.json`. Main can resolve the app's data container with `xcrun simctl get_app_container booted <bundle-id> data` and read that file directly. This does not depend on JS or modal dismissal and does not expose any content. `auditWriteFailed` must be false; missing/unreadable audit is inconclusive. The builder/agent never runs that device command.

## Main operation: source mode without a fullscreen WK

Fresh app; repeat enable/open, then press the production `resource-html-mode`. Confirm raw HTML source and the View preview action. Arm one/two switches, then press `resource-html-fullscreen`. The production source-fullscreen path must close through the same actual NativeAnchor and UIKit dismissal completion, even without a fullscreen WK. Read back the same audit.

## Evidence and fail boundaries

Journal capacity is **64**, oldest-first eviction. Records contain only fixed `Event` enum, sequence, weak-controller token, generation, attempt and numeric route token. No content, file bodies, user paths, raw receipt, owner string, credentials or raw errors are stored. Weak controller tokens do not keep controllers alive. The AX audit is metadata only.

Required sequence (some repeated intent/layout observations are harmless):

| Record | Authoritative source |
| --- | --- |
| `resourceRead` | Forwarded actual ResourceBridge.startRead call; no read payload is journalled |
| `controllerMounted`, `preAttachConfirmed` | UIKit carrier window/responder ancestry and actual anchor.window == nil |
| `authorityRevoked` | Actual native RuntimeHostAuthority rotation before insertion of the anchor UIView |
| `globalClearAdmitted` | Forwarding observation of the registered production retireForConnection call from the original clear |
| `connectionApplied`, `lateRouteAdded` | Follow-up after actual global admission/capture; test-owned later NavStack route |
| `closeIntent`, `anchorAttached` | Original anchor props observed/forwarded; actual UIView inserted only after intent and ACK |
| `actionRegistrationFailure` | Actual production native component `failed` event after strict captured-receipt registration; no fake callback |
| `controllerOpened` | Actual native opening transition event; JS may already have revoked the display |
| `dismissCompleted` | Actual native `closed` event, whose production source emits exclusively in UIKit dismiss completion |
| `leaseRelease` | Actual ResourceBridge release removed a previously existing lease |
| `routeRemoved` | Observed removal from the real NavStack routes after production clear completion |

`dismissCompleted` must precede final `leaseRelease` and original resource `routeRemoved`. With two switches, both connection-applied observations must precede anchor insertion; the later C route remains. `actionRegistrationReady` must not occur for the revoked anchor. Controller token and generation must match across mount/intent/failure/completion. Do not use Refresh: the expected resource read count is one, with no `resourceRead` after revocation. Scope rotation must not create a second mount or authorize actions; final route count should be root + surviving later route (2).

No `gateMissed`, `nativeFailure`, `backgrounded` or `closeFailed` is accepted as PASS. A missing stage, a retained modal/route, absent completion, or missing/evicted necessary evidence is **inconclusive/fail**, never a synthetic success. If UIKit does not deliver a stable containing-controller stage on this SDK, retain the artifact/AX/audit and report that boundary; do not click a stale underlying Back or manufacture lifecycle events. `closeFailed` is useful failure evidence but this carrier does not claim device-level rejection/retry acceptance. Existing controlled-native tests cover that branch.

Normal loaded fullscreen WK and save/share cancellation are covered by the separate ec8c resource page run. This carrier specifically targets actual pre-attach authority revocation plus global route clearing; it does not replace those scenarios, the later Loading-caption rebuilt run, real Host/Relay, or complete AppRoutes acceptance.

## Main actual UIKit run: 0882ce12

Main installed and ran this rebuilt carrier after confirming Enable's actual frame `(8,70,189,44)`, clear of the system status area. Two fresh-process scenarios passed their recorded ordering checks:

- Preview, one connection switch: actual dismiss sequence 15, lease release 16, original route removal 17; later route 2 survived.
- Raw source confirmed before fullscreen, two connection switches: both connection-applied observations preceded anchor insertion; actual dismiss sequence 19, lease release 20, removals 21/22; later C route 3 survived and the final route count was 2.

Each audit contains one resource read, the same weak controller token/generation through attach and actual dismissal, action-registration failure after revocation, and no `gateMissed`, `nativeFailure`, `backgrounded`, `closeFailed` or `actionRegistrationReady`. Main read the native sandbox audit and independently checked the sequence, counts and survival conditions. Evidence: `.scratch/nsh/global-0882ce12-preview-result/{ax,audit,proof}.json` and `.scratch/nsh/global-0882ce12-source-two-result/{ax,audit,proof}.json`; source mode was independently confirmed in `global-0882ce12-source-mode/settled.json`.

These are actual UIKit results for the stated isolated memory-authority scenes. They do not prove complete AppRoutes, real Host/Relay, or device-level close rejection/retry. The earlier 05f2b824 Enable at y=8 hit the system breadcrumb and backgrounded the fixture without enabling it; that historical failure remains a fixture hit-area failure rather than a production pre-attach failure.
