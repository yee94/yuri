# Production Settings → Voice fixture

## Boundary

`settings-voice-production.test.ts` creates an isolated entry whose only statement imports the real `packages/nsh/App.tsx`. Every prepared engine case goes through the actual Projects search button, ordinary typing of `Open Settings`, the production command row, Settings Home, then Voice. There is no seeded Tab, injected route, replacement UI, component callback invocation, audit widget, or production configuration change.

The root Host includes the precise disabled `native.diagnostics.status` schema 2 response and read-only retention preference startup. Only explicitly enumerated root/search GETs can delegate to the existing strict navigation Host. All retention/archive/delete/config mutation calls remain rejected. Notifications get an in-memory disabled configuration lease only; no OS authorization or delivery exists.

`withVoiceProductionFixture` uses a unique application identity and a separate temporary App/config/Storage/bytecode directory. It removes only that directory in `finally`. The production `nsh.json`, App, state, Voice UI, native Swift and other agents' fixtures are not edited.

## Native-issued scope contract

- `connection.list` and `connection.select` return the complete public snapshot plus `runtimeScope: {hostID, lease}`. The synthetic lease is a UUID, not a guessed JS generation. Selecting a Host (including the same Host) issues a new lease. Unscoped lifecycle `runtime.stop({})` retires the current lease; resume must consume the next actual snapshot.
- `runtime.request` accepts only `path`, `method`, optional `body`, and optional `expectedHost`. Every non-GET requires an exact current `{hostID, lease}`. A supplied GET scope is checked too. Missing/mismatched/extra scope fields fail before any write or native audio fake work. Legacy unbound GETs alone remain read-only.
- Root `runtime.stream` requires the exact current scope. `runtime.stop` permits only a known issued cleanup scope, or the actual unscoped lifecycle stop; old scoped cleanup does not stop/relabel a new Host's authority.
- `voiceRecognition.capabilities({})` remains scope-free. `start` requires exactly `owner,revision,provider,expectedHost` and checks the captured Host and lease before acquiring any fake capture. `finish`/`cancel` keep exactly `owner,revision`; a retained old lease can still be cleaned after a Host switch.
- The public production callback harness in `settings-voice-confirm-production.test.ts` now executes the real `runtime.bindRequest` and real `settingsLifetime` against a synthetic `app.runtimeScope` signal. It does not patch the save helper or omit `state.request`. A native-only same-Host lease retirement proves that the already-captured sender is rejected rather than silently rebased to current authority.

These checks do not claim the unfinished Swift/runtime-scope integration has run. Missing scope must be fixed by its production owner; the fixture must not accept missing write authority to make an engine case pass.

## Strict Voice fake

All behavior is in memory. The Host imports only pure settings data and the existing strict root/request parser. It does not call HTTP, microphone/recording APIs, NSH system `Speech`, audio synthesis/playback, sockets, models, shell, filesystem or OS services.

Voice GET and ordinary PUT ACK return the full public speech-settings shape, including all configured flags and fields not projected into the generic page editor. A deliberately supplied public mask must leave every credential input blank. The only accepted PUT bodies are six exact, literal synthetic test patches. Other fields, credential text, queries, aliases, methods and paths fail closed and remain in `rejected` even if production catches the exception.

Scenarios can only arm fixed one-shot failures or held in-memory responses. They cannot inject settings, clear audit evidence, add capabilities or manufacture production UI state. Audit/scenario/release calls exist only in the test realm, never in app capabilities.

`speech.prepare/segment/stop/release` validate owner identity, monotonic revisions, exact preview text and `source:'settings-preview'`. Prepare requires a complete authoritative GET after the last write. Browser preview is allowed while `showMessageTTSButtons:false` and dictation is disabled. A held segment resolves on Stop and the same owner must be released.

`voiceRecognition` validates configured provider and owner/revision, supplies literal synthetic partial/final text, and retains cleanup identities. The fake supports delayed GET/final results so the actual production controllers must fence old Host/background completions. Local model status is a read-only synthetic response; all download/delete/synthesis/transcription endpoints remain forbidden.

## Prepared engine cases

1. `browser-preview`: public navigation, full ordinary text input, exact combined PUT, authoritative GET, Preview despite hidden Chat TTS controls, Stop/release, public Back.
2. `ack-read-retry`: PUT ACK then GET 502; Preview retries only GET and clears the confirmed secret.
3. `new-edit-fence`: edit a newer secret after the old ACK/read failure; reconciling the old receipt cannot clear it or prepare audio. Only the next explicit attempt writes the newer draft.
4. `placeholder-receipt`: a configured-false-only public placeholder is incomplete, not a receipt. Next complete GET recovers without another PUT.
5. `unknown-ack`: an unknown credential ACK remains unconfirmed despite a later `configured:true`; no audio and no repeated PUT.
6. `local-model`: production local STT radio selection, exact save and reopen, no model mutation.
7. `literal-asr`: configured local provider, real production ASR dialog, literal partial/final TextView content, Stop-and-transcribe and capture cleanup.
8. `stop-close-invalidated`: public modal Back cancels; stale partial/wrong-revision invalidation cannot affect a new capture; matching native invalidation closes the keyed tester.
9. `lifecycle`: background stops/releases held preview; a held final after background cannot reappear on resume; no autoplay or implicit new capture.
10. `host-fence`: real connection-link listener opens Connect, public saved-Host selection adopts the replacement snapshot; retired final/partial cannot cross into the secondary Host; its configured STT remains `openai-compatible`, never system Speech.
11. `host-read-fence`: the same real Host transition while an authority GET is held cannot turn its late old reply into new-Host preview or settings.

Every driver preserves exact body/operation-count checks, `rejected:[]`, no browser requests/opened URLs/system speech/picker/Host posts, and no synthetic credential values in Storage. Failures print the strict audit then rethrow; unknown calls are not turned into success.

The public test API has no input-ref/focus trace or system-title reader. The drivers preserve immediate whole-string typing assertions, but do not claim UITextField focus, UIKit layout, system-title geometry, acoustic quality or real-provider behavior. Held-response scheduling through `nsh/test` is prepared but not run by this worker.

## Held-handler engine finding and candidate driver correction

Main's serialized browser-preview diagnostic reached Preview press, exact PUT/GET and speech.prepare successfully, then recorded `speech.segment pending`, held segment, `rejected:[]`, and no press completion. The screen showed Saved/Stop. NSH's 30-second case timeout fired. This is a failed engine case, not a production Stop failure or a passing concurrent-audio test.

Local NSH source `crates/nsh-testing/src/module.rs:1191–1197,1269–1307` awaits each JS Host handler inside a `serve` invocation. Awaiting the public Preview press before issuing Stop therefore deadlocks its own held handler. Each public step has its own `serve` (`2050–2060`), while the App mutex covers only a Driver operation on a blocking thread (`2104–2113`); it is not held for the entire Host-handler future. Headless settle is bounded (`headless/mod.rs:971–982`).

The candidate driver keeps the first public press Promise outstanding, attaches an immediate rejection observer, then uses other public steps to wait for the held audit, send playing, and press the same production Stop button. Only the resulting production `speech.stop`/release resolves the held segment; the driver then awaits the original press Promise so its failure is not swallowed. GET/final Host and lifecycle cases likewise retain the initiating public Promise until the real boundary action and deliberate late-response release. No held response becomes immediate success, no input/body/budget/scope assertion is removed, and no sleep/timer is added.

Main subsequently reran the corrected browser-preview case serially with the existing real `NSH_BIN`, `NSH_VOICE_PRODUCTION_ENGINE=1`, and the same `-t 'prepared actual production Voice navigation: browser-preview '` selector. Actual result: **1 passed / 29 filtered skipped, 2.19 seconds**. This establishes the public concurrent-step seam for this real production navigation → exact save/readback → held Preview → public Stop/release case. The original 30-second held-handler timeout remains the red result; the corrected driver is the observed green result. Production controller, capabilities, permissions and strict mutation/scope assertions were unchanged.

Main's subsequent full eleven-case serialized engine batch completed: **10 passed / 1 failed (`lifecycle`) / 19 pure cases filtered skipped, 24.43 seconds**. This does not establish eleven passing engine cases. The other ten named cases, including held GET/final Host fences, passed in that batch. Diagnostics print begin/end for every public step and pending/returned/failed for every native fake call. Browser-preview is bounded by a 30-second NSH case timeout; other cases retain 90 seconds.

The full output is retained in main's shell artifact `sh_1b5db73df001HnEZrUe8E15cnG.out`. Read-only inspection confirms:

- lifecycle steps 11–14 acquired a held segment, used public `setLifecycle('background')`, received production speech.stop and speech.release, settled the original Preview press and verified the playback owner released;
- step 15 delivered the stale playing event while backgrounded; step 16 used public `setLifecycle('active')` and completed;
- step 17 then failed the unchanged `app.enabled('id:settings-voice-preview')` condition after the documented 5000 ms wait. The Voice page was still visible. No navigation-away/back, route remount, callback injection or capability retry was requested by the driver;
- root connection.list/config refresh/stream/appearance resumed, but voiceRecognition.capabilities remained at one total call. There was no new Voice GET after foreground return, held lanes were empty, the original playback was released, captures were empty, writes were zero, and rejected remained empty;
- the later ASR-background/late-final portion of this same lifecycle case was **not reached**, so this batch does not validate it.

Waiting for the still-visible Voice page to regain its public Preview action is an intended resume expectation. Do not make it pass by removing the enabled check, extending the wait, navigating to reconstruct the page, weakening current/active, or admitting an obsolete lease. The 10/11 result above is preserved as historical red evidence; the subsequent production operation-only correction and reruns are recorded below.

There is also a separate Native lifecycle simulation limitation: `nsh/test` setLifecycle updates the app's NSH lifecycle signal, but does not call this synthetic Host's Swift-equivalent `RuntimeBridge.setForeground`. The actual native implementation closes admission/rotates through `RuntimeHostAuthority.setForeground` on suspend/resume. In this failed run only a scoped stream-stop occurred; the audit retained lease `11111111-1111-4111-8111-000000000001` through foreground return. The fixture's unscoped stop rotation branch was not invoked. Thus this result proves a public JS-page resume failure even under a stable synthetic lease; it does **not** prove native foreground lease rotation. Any later explicit fake native-lifecycle transition must follow the real closed-background/new-foreground-snapshot protocol, keep stale leases rejected and be reported as an additional strengthened test, not used to erase this production-page failure.

## Operation-only recovery and latest actual engine evidence

The Settings owner subsequently corrected production recovery through `captureHostOperation`, `settingsOperationLifetime` and Voice confirmation `replaceLane`. Only the asynchronous operation lane and transient tester are replaced after authoritative foreground adoption; the mounted editor/Scroll, dirty values, pending acknowledged/unknown journal, field edit revisions and secrets remain owned by the existing page. Captured old operations retain their original sender/scope/generation and fail after retirement; no latest-request proxy is introduced. Cleanup must finish before fresh capabilities are acquired. See `settings-operation-recovery-contract.md` for that owner's exact implementation and the separate frozen model-manager recovery boundary.

Main reran the actual lifecycle engine case after this correction: **1 passed / 29 filtered skipped, 2.72 seconds**. Main then reran the complete eleven public production Voice scenarios: **11 passed / 19 pure cases filtered skipped, 20.50 seconds**. These are reported main-owned serialized NSH engine results; this worker did not run the engine. The unchanged lifecycle scenario now proceeds through both Preview background stop/release/resume and ASR background cancellation/late-result fencing. The strict fake protocol, active/current/lease checks, exact mutation/read budgets, literal transcript and zero-external-work assertions were not relaxed. Browser's 30-second and other cases' 90-second NSH limits remain unchanged. Both the original held-handler timeout and the earlier 10/11 batch remain distinct historical results, not overwritten by the latest pass.

Evidence level is **headless actual production App/navigation/controllers with strict synthetic native/HTTP handlers**. It is not UIKit/device, real provider, microphone/audio, Native foreground rotation, or network evidence. The Native lifecycle simulation limitation above remains in force despite all eleven headless cases passing.

The existing `settings-voice-confirm-production.test.ts` callback regression was updated independently after the operation interface changed. It extracts and evaluates the actual `state.captureHostOperation` declaration with synthetic root-owned readiness/generation/connection/scope signals and the real runtime request binder. Signal dependency scheduling runs operation observation, activation, readiness-driven capability acquisition and tester effects; hard-coded effect indexes were removed. All original 15 cases are retained. Three added cases verify acknowledged/unknown journal retention across operation renewal and old delayed read/finally versus a newer secret/flight, for **18 callback cases**. With the 24 confirmation-owner cases, the focused run reports **42 passed**; the focused Voice production test tsconfig also passes. Retry discovery now restores the fake capability response before pressing the real retry action, instead of forcing an effect by index after a failed retry. No engine pass substitutes for these pure callback checks.

## Subsequent App root monitor regression: current evidence boundary

After further App/root changes, main reported a combined nine-file run with **127 passes / 17 failures out of 144 cases**, including all eleven Voice engine scenarios failing. Its artifact `sh_1b614138e001CIdKe3SZD08Wkv.out` preserves this later regression independently of the prior eleven-pass batch. In the inspected browser-preview failure, public step 9 (press Voice) ended, but the next wait saw no Voice GET/capabilities and an empty screen. The strict Voice wrapper also rejected the new root `/api/yuri/history-import/job` and `/jobs` calls. These are separate findings; fixing legitimate monitor routing does not establish that the page mounts again. App/Settings owners retain production ownership and main owns the engine rerun.

Web source establishes the intended split: `SidebarBackgroundTasks.tsx:87` consumes `importJobsQueryOptions` (`GET /api/yuri/history-import/jobs`); `HistoryImportStep.tsx:31` consumes the singular `/job` only for the import step. The Voice wrapper therefore handles **only exact scoped GET `/api/yuri/history-import/jobs` returning `[]`**, once in its own audit, without delegating to the navigation base or broadening a prefix allowlist. Scope host/lease must be current, no query or body field is accepted, and all import POST/scan/resume/cancel/dismiss routes remain rejected. Ordinary Voice scenarios additionally assert zero singular `/job` reads. The root must remove its unintended `/job` read; the fixture does not hide it by returning null.

Pure strict-Host tests cover primary/secondary exact jobs reads with no duplicate audit entries, missing/stale/extra scope, arbitrary query/body, related paths and writes. The callback harness also gained only an inert `NativeSelect` UI leaf port for the shared control's new explicit import; mutation/controller/request ports and all original assertions remain real and strict. Latest worker-only focused verification is **63 passes / 11 engine skips across three files**, plus focused test tsc and static actual-App/driver graph build. No new engine, UIKit or native-provider pass is claimed for this latest App revision.

## Latest main-owned combined verification

Main subsequently corrected production `SettingsOperationPage` token forwarding from an object spread to an explicit JSX prop. Its actual Voice single-case rerun passed: **1 passed / 31 filtered skipped, 2.24 seconds**. This is distinct from the earlier 2.19-second held-driver fix and the 2.72-second lifecycle recovery pass.

Main then executed the same-round combined matrix with Context, Quota, Navigation, Voice, NotificationRoot, GitHub and About opt-ins enabled: **9 files / 153 tests, all passed, 71.95 seconds**. The retained shell artifact is `sh_1b621938f001Pa0M1D5EXvNoRO.out`. All eleven Voice production engine scenarios ran within that combined matrix, together with the Voice confirmation callback regressions and strict raw Host/config fixture checks. **153 is the total of pure and opt-in tests across those nine files, not an engine-only count or a Voice-only count.** The prior combined 144-case result (127 passes / 17 failures) remains historical regression evidence above; it has not been removed or relabeled.

Main also reports TypeScript exit 0 after its separate bounds/NavStack corrections and 26 passing NativeSheet popupStyle-forwarding tests. These are separate validation scopes, not additional Voice engine cases. This worker made only this contract update and did not modify source or rerun tests for this report.

The latest combined pass establishes the reported **headless actual production App with strict synthetic handlers** behavior at that revision. It does not establish UIKit/device rendering, real provider/microphone/audio/network behavior, or Native foreground lease rotation. Those evidence boundaries remain unchanged while main continues GUI/native-build integration.

## Commands

Pure Host and actual callback regressions plus static App/driver graph builds only:

```sh
node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-voice-production.test.ts packages/nsh/settings-voice-confirm-production.test.ts packages/nsh/settings-voice-confirm.test.ts
node_modules/.bin/tsc -p packages/nsh/settings-voice-production.tsconfig.json --noEmit
node --check packages/nsh/tests/settings-voice-production-host.js
node --check packages/nsh/tests/settings-voice-production-runner.mjs
```

Only main, in its serialized headless window (no `--target`, UIKit or device):

```sh
NSH_VOICE_PRODUCTION_ENGINE=1 node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-voice-production.test.ts -t 'prepared actual production Voice navigation:'
```

Run the first case alone before the full matrix when tracing new root/scope contracts:

```sh
NSH_VOICE_PRODUCTION_ENGINE=1 node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-voice-production.test.ts -t 'prepared actual production Voice navigation: browser-preview '
```

Use `NSH_BIN` to select the existing NSH binary. Opt-in is off by default; this worker runs only Node/VM, TypeScript, JavaScript syntax and Bun's static graph build. Those passes do not establish NSH engine, UIKit, device, real Host/provider, microphone/audio, network, or the native-scope owner's platform correctness.
