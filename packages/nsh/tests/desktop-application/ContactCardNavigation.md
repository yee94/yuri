# Actual App contact-card navigation regression

## Scope and ownership

`desktop-assistant-card-navigation-native.test.ts` uses the existing
`bundleDesktopHost` helper and unchanged `desktop-application/host.js` /
`desktop-writer-host.js`. It creates its own temporary config, copies the complete
production capability baseline exactly, and adds only
`contact-card-navigation.test.audit` to that temporary Host allowlist. Production
config, application, Assistant/state owners, existing App tests and helper files
are not modified by this regression.

`ContactCardNavigation.test.tsx` imports the actual production App directly for
four positive scenarios. The remaining scenarios mount the same
`YuriNativeApp` through `ContactCardNavigationRoot.tsx`, which observes public
NSH Storage and delays only public synthetic bridge response delivery. No product
controller, route, writer, component, callback or application-state setter is
injected. Tests navigate through real buttons; the non-home path is
Assistant home alpha → actual Session receipt → Session's existing Assistant
resource button alpha → retained alpha Chat route → beta receipt → Assistant home.
There is no test-only routing entry or saved-route shortcut.

All native receipts, records, connections and runtime events are synthetic. The
original writer Host verifies grant/target/expectedHost for contact writes; the
test's additional reader replies also verify the selected native scope. Unknown
mutations fail and are recorded. The only additional POST read exception is the
exact retained Session Goal RPC, with exact directory and body assertions. The
network remains stubbed/offline, and every scenario asserts zero direct network
requests. No live Host, credentials, physical native window, native OS callback or
real user Storage is accessed.

## What the ACK gate means

The synthetic native producer first processes the genuine
`desktop.writer.release` request and removes its grant. Only its successful
response delivery to JS is held. Thus these tests exercise an **ACK boundary**,
not a fake still-writable writer or an unissued release request. While JS waits,
the original conversation remains visible but read-only, its original draft is
already flushed, and no destination writer/read/draft hydration starts. Releasing
the exact ACK permits the exact destination; the original native grant is absent
and release is dispatched exactly once.

Opening Settings during this interval invalidates navigation. A later successful
ACK must not revive the old writer or silently retry acquisition. The retained
draft remains visible and fail-closed after Settings closes. This regression
deliberately does not demand that an owner with uncertain/released custody can
write again.

## Case accounting

The wrapper requires **32 internal tests: 32 passed**, with zero skipped tests.
There are **16 scenarios per headless platform model**:

| Boundary | Cases per platform |
| --- | ---: |
| Uninstrumented actual App Assistant/Schedule positive destinations, one release and flushed original draft | 2 |
| Assistant/Schedule held native release ACK: old screen retained, zero target acquire/write/contact GET/draft read/write until ACK | 2 |
| Settings during each held release: late ACK cannot route, reacquire or restore write admission | 2 |
| Original send pending: actual card press cannot release, acquire a target or replay/alter the saved pending intent | 2 |
| Original send lost ACK/unknown: native disabled card refuses the press, with the same zero-side-effect and pending-preservation assertions | 2 |
| Same-alpha receipt pressed twice: same writer/grant, draft, one List/Input, no new contact read or Storage hydration | 1 |
| Real non-home retained alpha route: first destination contact GET is beta, never first-catalog alpha | 1 |
| Exact beta seed absent in fresh destination catalog: explicit unavailable, no alpha fallback/contact GET/writer | 1 |
| Beta removed through a genuine catalog refresh during held release ACK: no late navigation or target I/O | 1 |
| Delayed missing-target catalog reply after genuine connection selection to another Host/authorization: no commit or beta I/O | 1 |
| Delayed destination contact-read reply after genuine connection selection: no old body publication, cross-authority beta request/acquire or draft write | 1 |

Unknown-state cards are disabled by the real native control. The test attempts the
public `press`, requires its explicit disabled rejection and checks all ownership,
pending, replay and target-I/O invariants. It does not bypass the disabled control
by calling a captured callback, mark the case skipped, or weaken unknown custody.
Pending-state cards do receive the public press and are rejected by the original
departure guard.

The same four pending scenarios additionally exercise processing-state presence:
pending send alone, and even a live turn-start while its admission ACK is held,
must not show `desktop-assistant-typing`. After the ACK, a matching working
snapshot permits the original dots; turn-end removes them. The first run failed
all four cases on the old `busy || sending` condition. The corrected
`busy && !sending` condition passed the full 32-case suite under diagnostic
paired digest `8a261…ff25`, alongside the unchanged 88-case App suite. Fixture
snapshot working state follows the same synthetic turn-start/end authority;
it does not demand that a stale false snapshot preserve a running indicator.
These are additional assertions within the original cases, not four extra tests
or proof of Web send-flight geometry/animation.

The same-contact case checks observable owner retention (grant, hydration, reads,
draft and unique List/Input), not inaccessible internal native node identifiers.

## Verified toolchain and result

Focused run on 2026-11-08: **1/1 Vitest wrapper passed; 32/32 internal NSH tests
passed; zero skips**, approximately 16 seconds including both actual App bundles.
Both environment variables explicitly used the existing paired tools for digest
`7834beffee6dc6dd588bee99f717366a37dca2282ceb53544b80734e800f97e0`.
The executable hashes matched its unchanged receipt:

- CLI: `5fcc770349635e237df43fdfa072426af0375084dc006374bf2c376f06a81d5b`
- Runtime: `0ac82f67e63258d4438231b5baabee9f9226704c611c6a3b05594722de4a3197`

```sh
COMPAT="$PWD/packages/nsh/.nsh/compat/7834beffee6dc6dd588bee99f717366a37dca2282ceb53544b80734e800f97e0"
NSH_BIN="$COMPAT/tools-darwin-arm64/bin/nsh" \
NSH_RUNTIME="$COMPAT/tools-darwin-arm64/runtime" \
bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-assistant-card-navigation-native.test.ts
```

An isolated temporary TypeScript config extending the existing NSH config, with
`ContactCardNavigationRoot.tsx` and the package's normal shared desktop ambient
declarations, strictly checked the actual fixture/App import graph successfully
using installed TypeScript. This did not regenerate shared tools/types. NSH itself
bundled and executed the complete test source; the test runner source is not
claimed to have undergone standalone TypeScript checking.

`bun run dead-code` was attempted but stopped loading the existing Web Vite
config because `vite-plugin-pwa` is unavailable; there is no complete dead-code
report. Repository `bun.lock`, `package.json` and `node_modules` modification times
were unchanged by this command. No dependency, tool digest, preparation lock or
production capability manifest was edited.

## Explicit remaining acceptance

These are macOS/Windows **headless platform models**, not physical AppKit/Win32
window, keyboard, accessibility, rendering, real native custody/disk-durability or
live Host acceptance. Same-connection-ID authorization rotation is not separately
exercised; the late-result cases change Host and authorization through the real
connection selection UI. Schedule-target removal and full task mutation/recovery
remain outside this narrow navigation suite. Existing App-wide suites were not
rerun here, and this does not claim full desktop 1:1 parity.
