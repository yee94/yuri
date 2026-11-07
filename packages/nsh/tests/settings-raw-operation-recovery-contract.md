# Raw Settings operation recovery

Scope: `SettingsGitHub`, `SettingsGitCredentials`, `SettingsAbout` and their three owning core controllers. This change consumes the existing `settingsPageLifetime` / `settingsOperationLifetime` and production `captureHostOperation()` assembly. It does not change application navigation, root authority, Native or Swift.

## Consumers and preserved protocols

- `createSettingsGitHub`: `settings-github.tsx`, `settings-github.test.ts`, `settings-github-host.test.ts` and the new recovery tests.
- `createSettingsGitCredentials`: `settings-git-credentials.tsx`, `settings-git-credentials.test.ts`, `settings-github-host.test.ts` and the new recovery tests.
- `createSettingsAbout`: `settings-about.tsx`, `settings-about-core.test.ts`, `settings-about-update.test.ts`, `settings-about-fixture-host.test.ts` and the new recovery tests.
- `gitSettingsNativeRequest`: GitHub and discovered-credential pages; its optional explicit scope preserves the prior constructor-only call signature.

The controllers add `replaceLane(dependencies)`. Public methods otherwise keep their protocols. Each invocation enters one fixed inner lane. Replacement first copies the retained state and private selection metadata, then disposes that inner lane and constructs a new operation controller. Existing async continuations keep the disposed instance and original dependencies; no request proxy points to the replacement sender. GitHub replacement explicitly disables dispose-time Host cancellation, even if a test caller has not yet invalidated its old `current` predicate.

## Authority and retained state

The page keeps its Scroll, signals, form controls and navigation identity. Same-Host foreground waits for the confirmed root snapshot; it replaces operation ownership and refreshes GETs. A null suspension scope preserves displayed snapshots and drafts. Actual Host identity/origin/authorization changes permanently retire the mounted owner, including A-B-A.

Each raw sender binds `bindRawRequest(op.scope)` once and checks the exact assigned token plus `op.current()` before and after suspension. It passes the raw response to the original dedicated parser. In particular, GitHub exact-removal 400/404/409 codes and About update GET 502 partial snapshots retain their existing semantics. The ordinary operation request, which throws on HTTP errors, is not substituted for this raw parser boundary.

Covering the route also replaces the controller with an inactive lane. Returning to the route creates a new assigned token even when the root operation object is unchanged. Old reads, writes, finally callbacks, alert confirmations, browser-open results and diagnostics flush continuations cannot adopt or dispatch using that token. Local edit signals and transaction state remain retained.

- GitHub retains account snapshots, exact deletion selection and pre-dispatch mutation journal, ACK readback requirement and unknown-result status. Active device codes belong to their original lane: replacement clears secrets and timers and records an unknown connect state. It does not resume exchange or replay cancellation. A late start result cannot cancel through the new sender. Explicit unknown acknowledgement remains required when public account status cannot prove the result.
- Credential import retains the selected discovered source, exact profile draft and private form fields, pending import identity and saved receipt. The pending draft is recorded before POST. GET reconciles the entire exact profile; it never treats a matching host alone as proof of the imported profile. ACK receipts cannot become new imports after a readback failure.
- About retains independent version snapshots, acknowledged task identity/progress and update uncertainty. Uncertainty is recorded before update dispatch. Replacement discards only transient confirmation/busy/read ownership; it does not POST the plan again. The next update action still requires a freshly read plan and explicit confirmation.

Native diagnostics calls check assigned operation authority immediately before actual dispatch (including after the root recorder flush) and after the response. The existing Swift API accepts no `expectedHost` on client metadata/status or the device-wide enabled preference; its strict payloads are unchanged. Export passes the captured `hostID`, and existing Swift captures/checks its own share scope and invalidates the share on Host retirement. Browser opens cannot be physically undone once dispatched; their dispatch and JS result adoption are fenced. No automatic new browser open is added during recovery.

## Evidence and boundaries

`settings-raw-operation-recovery.test.ts` exercises actual owning controllers: unknown exact deletion, cancellation ownership, stale reads/finally, retained credential form/source, in-flight import reconciliation, uncertain update and acknowledged task retention. `settings-raw-production-recovery.test.ts` runs the actual three TSX pages, actual lifetime and raw binder, and the original `state.ts` operation-factory declaration with inert JSX and strict synthetic Native ports. It covers snapshot gap, repeated-lease renewal, GET-only resume, permanent A-B-A retirement, raw error-body code/status preservation, a retired raw sender, late page GET/finally and covered-route recovery.

These are pure JS tests. They do not prove UIKit focus/selection retention, real device OAuth/cancellation, Keychain, real credential deletion/import, Host installation/update, actual Native race behavior or browser/deep-link delivery. Application's stable route/display gate and the serial public-navigation engine rerun remain the main owner's responsibility. No engine, device, network, Git or build action is used by this task.

Main supplied an independent read-only oracle result from session `ses_e49f973d8ffekN1U2F2O9U3DZw`: it found no confirmed implementation defect in the three pages/cores and statically checked fixed scope, assigned token, old finally, retained journal, GET-only recovery and actual Host retirement. The oracle did not run tests. Its two requested evidence gaps are now covered by actual page callbacks: deferred AlertDialog confirm/cancel after replacement cannot consume a new lane's pending confirmation; export waiting on the real diagnostics root's delayed append/flush cannot dispatch Native export or change the resumed lane. These are separate pure regressions, not tests run by the oracle.

Final local validation including the fixture admission follow-up: ten focused Vitest files passed, 106 tests total (four raw recovery/admission/config files plus GitHub, credential, About core/update and their two strict synthetic Host suites). `tsc --noEmit -p packages/nsh/tsconfig.json` passed. Dead-code validation was not run: the local `knip` executable is absent, and this task prohibits network access or installing dependencies.

## Isolated engine fixture admission follow-up

Main's first serial engine run failed: About stayed unknown at first version lookup, and GitHub completed its OAuth/account actions but showed no discovered import row. Static inspection found two distinct causes. About's old injected fixture never adopted root readiness, so the production initial-load gate could not run. The discovered list read the controller's non-signal state inside `Each`, so successful async GETs did not invalidate the list. The list now derives candidates from its existing `state()` signal and the unchanged shared pure candidate filter; it adds no request, cache, timer or global scan.

Both dedicated engine fixtures now await `admitSettingsFixture()`, which calls the actual `loadConnections()` and checks the actual `captureHostOperation()` before their first page mount. Their pages use production operation ownership and raw parsers. Only the synthetic browser-open port and deterministic profile ID are injected; there is no `current: () => true`, mutable request proxy, manual `app.connection.set`, or hand-written root readiness. This first-admission gate remains true after initial mount and therefore does not remount a page for operation renewal. Failure has an explicit fixture-only admission marker.

The synthetic Hosts expose an exact `connection.list` snapshot with `connections`, `selected`, and `runtimeScope: { hostID, lease }`, and require exact `expectedHost` fields on every HTTP request. Missing/extra/malformed/stale/cross-Host fields fail before synthetic mutation handling. Their renewal and A-B-A controls issue different synthetic lease strings and never authorize actual Native/Swift work: these fixtures are forwarding oracles only. Config capabilities permit these narrow test ports, not actual browser/network/connection mutation access. Existing account switching, exact removal, cancellation, import, update confirmation/retry and three diagnostic-export assertions are retained.

`settings-raw-fixture-admission.test.ts` imports actual state/runtime/bootstrap modules under inert NSH signals and delays `connection.list`. It proves no initial page requests precede adoption, actual page GETs forward the adopted scope, renewal changes lease, original owners retire across actual adopted A-B-A, and the discovered `Each` subscribes to the async data signal. The strict scope tests also reject old forwarding after returning to A. `settings-raw-fixture-config.test.ts` checks generated capability manifests and parses both engine input scripts without running either engine.

## Main-reported engine and loader evidence

Main reported that its first rerun of both isolated engines failed while loading the new `.mjs` dependency, before either page mounted. Main fixed the two `prepare…` config functions to bundle each `tests/settings-*-host.js` with `bun build --target=browser` into the isolated temporary directory's `host.js`, preserving all existing capability declarations. This loader/config repair belongs to main; this worker did not modify or rerun those patches.

After that repair, main serially ran the GitHub and About opt-in engine cases with `NSH_GITHUB_ENGINE=1` and `NSH_ABOUT_ENGINE=1`: both passed, with a reported combined duration of 8.77 seconds. This is actual NSH engine evidence for the two isolated synthetic fixtures, separate from the 106 previously passed pure tests and the independent static oracle. It does not establish the broader application's public-navigation or Native lifecycle acceptance.

The same batch's two config-only tests initially failed solely because they still asserted the original source Host path. Main updated their assertions to require the temporary `host.js`, no external import/re-export in its AST, and a `createHost` function. Main reported the focused config rerun passed 2/2 in 254 ms. The earlier 106-test pure run and both deferred-oracle regressions remain recorded above; no combined post-loader 106-test rerun is claimed here.

No real OAuth, credential persistence/deletion/import, Host update/install, physical device or UIKit acceptance follows from these synthetic engine results. This documentation-only evidence update ran no tests or engine and did not alter main's code/config patches.
