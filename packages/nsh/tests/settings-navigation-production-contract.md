# Production Settings navigation fixture

## Boundary

`settings-navigation-production.test.ts` owns its tests and these fixtures. The subsequent URL-input investigation was explicitly authorized to make a narrow change in `settings-collections.tsx`: the two remote MCP fields only. It does not change application navigation, `settings.tsx` or state. The engine entry imports the real `App.tsx`; the root-global entry only seeds the initial tab to index 3 and mounts the real `YuriNativeApp`. There is no replacement Settings/Chat widget, test navigation callback, injected route, audit button, or custom title.

Each invocation creates a unique app/config/Storage/bytecode directory and cleans it in `finally`. The headless `nsh/test` driver uses `open(..., { host: { handlers } })`; its test-realm Host audit is directly accessible without adding UI or production capabilities. No `--target`, device, main bundle, real Host, filesystem mutation, model, Git command or OS notification is used.

The strict Host has two projects, an actual worktree under the second project, and a newer unrelated recent session/lastDirectory. Only `/fixture/second/.worktrees/topic` may receive the three scripted PATCHes. Agent metadata POST is a read, not a mutation. Unknown methods, endpoints, native calls, body fields and malformed/doubled queries throw and remain in the audit even if production catches the error. Location-less catalogs have distinct global identities. Notification root GET/configure and attention's raw live-Location inventory + location-scoped pending reads follow the current production contracts; notification configure only returns an in-memory lease, never OS permission or delivery.

The root's `native.diagnostics.status` is explicitly allowlisted with an empty input object only. Its accurate Swift schema-2 response is `{schemaVersion:2,mode:'event-recorder',enabled:false,recordingLease:null,eventCount:0,maxEntries:500,maxBytes:262144}`. This is read-only, supplies no recording lease and grants no enable/append/export authority. A pure regression feeds that response through the real diagnostics root and verifies no append, writes or rejected calls. Requests with extra status fields, and all three mutation/export methods, remain rejected.

## Public controls and title semantics

- Expand `id:project-worktree-/fixture/second/.worktrees/topic`, then press `id:project-session-ses_actual`. These are the real Projects disclosure/session controls, not a direct route seed.
- Chat MCP uses `id:chat-header-root >> id:chat-header-options` followed by `id:chat-menu-mcp`. This explicitly targets the production headless header, not the separately positioned UIKit header-right slot. No UIKit coordinate/layout claim is made.
- Scoped Search defaults to the real `app.keyboard.press('mod+p')` command. Each scoped scenario opens it, presses `mod+p` again to close it, and verifies that the retained Chat draft is unchanged. The second scoped scenario presses `mod+b`, waits for the real reused ProjectsHome `id:projects-open-search`, checks that the composer is hidden, then uses public Back to verify the retained draft. It reopens the Switcher and presses that Search control before opening Settings; it never waits for a system-title Text. Both paths retain all three actual-directory write assertions, final Back/draft checks and `rejected: []`.
- Search Open Settings uses `id:projects-search-command:open-settings`; its settings entries and list/editor callbacks are production controls. On the pushed home, headless checks the real `id:settings-search` content and exactly **zero** `Settings` strings in `app.texts()`, both on entry and after returning from the collections. NavPage's system navigation title is not exposed as content by this API. The public App declaration has no navigation-title/tree reader; no fake Text or guessed API is added. The system title's presence, uniqueness and geometry remain UIKit acceptance, not a static-title or headless pass. Root Settings retains its own content title and original assertion.
- No numeric coordinates are fabricated. The public NSH test API supplies semantic press selectors, not arbitrary screen taps. Directory data must use literal `includes` predicates when inspecting text; it must not be embedded in `text:/.../` regex selectors.
- Root-global uses the real Home on the initial Settings tab. This checks its callback scope and nested pages, not whether the system TabBar can be tapped on UIKit.

## Hardware-keyboard boundary

Main wired the public NSH `keymap.bind` entrypoints to the Web defaults: `open_command_palette` is `mod+p`, and `toggle_sidebar` is `mod+b`. The driver uses the documented `Keyboard.press(keys: string): Promise<void>` in `.nsh/types/nsh/test.d.ts`; `.nsh/types/nsh/index.d.ts` specifies that these are hardware-keyboard bindings on iOS/Android, including externally attached keyboards.

The pure guard reads only the two Web metadata string fields from `shortcuts.ts`; it never imports/evaluates that browser module or includes its graph in QuickJS. The pure driver test proves the public API calls, waits and lost-draft assertion are executable, not that production key dispatch or navigation has run.

`NSH_SETTINGS_NAVIGATION_CHAT_SEARCH_SELECTOR` remains an optional override only for an actually existing visual entry. Without it the default is the hardware shortcut, not an error. For a real `id:chat-menu-*` item, the driver opens the production header options first; if that item opens the existing Session Switcher, it then presses that page's production `projects-open-search` control. No route is manufactured.

This does **not** create or prove a touch-only Chat search entry. As on the current Web mobile surface, the global Projects-root search is a separate visible entry with no Chat scope. Do not add a header icon or fixture widget to disguise the hardware requirement, and do not claim these headless keyboard cases prove touch-only or UIKit behavior.

## Original engine failures and MCP evidence boundary

Main's first serialized engine run reported **18 cases: 15 pass / 3 fail**. Preserve that result independently of later pure-test totals:

| Scenario | Original reported failure | Current treatment |
| --- | --- | --- |
| `chat-mcp` | Save rejected with `Unexpected MCP patch`; no actual PATCH body was supplied in the feedback. | Keep exact `url,scope` keys, edited URL and `scope: 'project'` requirements. Capture the next engine input before judging a fixture or production bug. |
| `scoped-search` | `app.texts().filter(value => value === 'Settings')` expected count 1, actual 0. | Verify real Settings content and zero duplicate content titles; system navigation title remains UIKit-only. |
| `switcher-search` | Waiting for `text:Show Session Switcher` failed although Projects/worktree content was present. | Wait for the real ProjectsHome search ID and verify Back/draft behavior, not system-title text. |

Read-only production tracing found that Web `listMcpConfigs()` in `server/lib/opencode/mcp.js` returns scope from the source config path; `updateMcpConfig()` writes the existing source path. Native `readSettingsCollection('mcp')` in `settings-protocol.ts` preserves the returned rows. `SettingsCollection` uses `item.scope || 'user'`; its save body is the minimal `nativeCollectionChanges()` plus the retained draft scope. Neither parser nor save protocol was changed.

The pure callback harness executes the original `SettingsCollection` load/edit/save functions and original `settingsLifetime()` transaction logic with inert JSX node records. It invokes clear and successive typed URL callbacks, then Save. The captured request is:

```text
PATCH /api/config/mcp/scope-mcp?directory=%2Ffixture%2Fsecond%2F.worktrees%2Ftopic
{"url":"https://mcp.example.invalid/edited","scope":"project"}
```

This confirms the pure callbacks preserve fixture scope; it does **not** reproduce NSH input dispatch, signal scheduling or engine serialization. It was insufficient to reproduce the engine failure: the inert harness directly delivers each successive value to the callback, so it cannot lose a character stream when a native editor loses identity or focus. Do not label it a production scope bug or a fixed MCP engine case based on this pure result.

The Host records the actual request body before mutation validation, and rejection diagnostics now include fields/scope/URL for `Unexpected MCP patch`. Generated engine scenarios log `settings-navigation-failure:` with scenario, rejected audit and exact MCP PATCH records before rethrowing the original error. Pure rejection regression checks user scope, an unchanged URL and an unrelated field all fail without mutating the fixture. Nothing accepts arbitrary scope or extra fields.

## Follow-up: first-character URL and field construction boundary

Main's next serialized run reported that all three MCP-writing navigation cases remained red, but both title problems had passed. Its strict audit supplied the previously missing runtime input:

```text
runtime.request
PATCH /api/config/mcp/scope-mcp?directory=%2Ffixture%2Fsecond%2F.worktrees%2Ftopic
{"url":"h","scope":"project"}
```

This rules out the proposed scope mismatch for that run. The URL had already become `h` before the Host rejected it; neither the fixture scope parser nor a relaxed expected URL can repair lost typing. The original full-URL expectation remains unchanged.

Static evidence from an isolated build of the actual production `SettingsCollection` (NSH compiler only; no engine) distinguished the construction paths:

```text
before: cond(() => draft().type === "remote", () => [
          () => field("url", ...), () => field("timeout", ...), ...])
after:  cond(() => draft().type === "remote", () => [
          component(SettingsInput, {testID:"settings-url", get value(){return value("url")}, ...}),
          component(SettingsInput, {testID:"settings-timeout", get value(){return value("timeout")}, ...}), ...])
```

The compiler lowers opaque factory expressions into dynamic insert functions; direct component children are constructed in the conditional branch with reactive leaf props. The local NSH compiler/runtime source describes `component()` as untracked and `cond()` as preserving its branch until truthiness changes. Therefore `draft.set` alone does **not** prove that the remote `If` itself is remounted. The precise engine invalidation/ref/focus mechanism is still unobserved; do not present the construction-path difference as a measured native unmount trace.

The narrow candidate fix removes those two opaque factory expressions only. IDs, localization, edit locks, live value getters, `set()` callbacks, timeout validation, scope and minimal PATCH fields are preserved. No caching, replacement input, focus forcing, delayed Save or longer wait was added. Agent/Skills field construction is untouched and its original clear/type/save callback wire has pure regression coverage.

The new static mount-boundary guard failed on the old source (`Received: []`, no direct remote URL editor) and passed after the change; actual NSH compilation confirmed two direct editor components and zero URL/timeout factory calls. This is a structural red/green test, **not** a reproduction of native focus loss.

Both Chat MCP and scoped scenarios still use `app.clear` followed by ordinary full-string `app.type`. Immediately after type returns they require the exact full URL, before waiting for Save. They then press `x` through `app.keyboard` (no selector/refocus) and require the full URL plus `x`; Backspace must restore the full URL. This exposes the original `h` immediately and probes retained input focus without replacing the character stream. Pure driver regressions reject both `h` and a lost-focus continuation. Public App has no input-ref/focused-node inspection API; main must confirm actual engine behavior and UIKit must confirm real UITextField focus. This worker did not run either.

Validation of this candidate: the navigation file has 23 pure passes and 4 opt-in engine skips. Together with the existing collection-core, settings-protocol, collection type-boundary and diagnostics-root files, 72 tests pass and the same 4 engine cases remain skipped. Isolated NSH compilation, focused strict production/test tsc, scenario tsc, fixture JS/MJS syntax and the Settings design audit pass. The repository Knip command was run with `--no-install`; it reports existing workspace findings/configuration hints and no `settings-navigation` or `settings-collections.tsx` entry. No native-focus measurement, engine test, real Host, device, main bundle build, Git command or dependency installation was performed.

## Latest main engine evidence: search demand and cancelled debounce

Main's later serialized run reported **8 files, 109 pass / 2 fail**. `chat-mcp` passed; all three MCP-writing cases passed the complete URL, retained `scope: 'project'` and keyboard-only continuation assertions. The two scoped cases also passed all Agent/Skill/MCP actual-directory writes, final Back/draft and `rejected: []` checks. Their only remaining failures were the final assertion requiring an `/api/fs/find` call. Diagnostics/retention synthetic gates also passed according to main. These are headless engine results, not UIKit validation; they do not establish the previously unobserved exact unmount mechanism.

Read-only inspection of `projects-search.tsx` explains the remaining failure without a production search bug:

- `groups()` matches local commands against current input immediately.
- Input `onChange` cancels the previous controller revision and schedules `controller.search(input())` after 250ms.
- Selecting a local command calls `select()`, which clears that timer and cancels the controller before navigating.
- The controller issues `/api/fs/find` **only** for a trimmed nonblank query with explicit `focusDirectory`. Empty input searches sessions only; a query without Focus searches sessions/content globally but never guesses a file directory.

Thus entering `Open Settings` and immediately selecting its local result need not send a file request. That absence is correct cancellation/budget behavior. The scenario previously asserted demand that the user had never actually completed.

Both scoped paths now first type the genuine file query `worktree-scope-proof`. The strict fixture returns `notes/worktree-scope-proof.txt` only for that query at `/fixture/second/.worktrees/topic`; it rejects blank/whitespace file queries and all non-actual file directories. The scenario waits for the real production result ID `projects-search-file:/fixture/second/.worktrees/topic:notes/worktree-scope-proof.txt`, then for the production English `Loading...` content to be gone, and rejects the real retry/error control. No sleep or direct request is used by the engine driver. The completed exact proof-query wire is checked before clearing the input and entering `Open Settings` for local command navigation.

The original final `/api/fs/find` actual-directory assertion remains, strengthened by requiring **every** file query to be a GET scoped to that same actual worktree with the production `limit=40&type=file` wire. All three write paths, Back/draft and `rejected: []` assertions remain. No production search, debounce, focus resolution or query budget was changed; no file read, preview route, empty-Focus scope or unrelated filesystem request was added.

Pure regressions execute the actual production controller and page input/command callbacks against the strict standalone Host, using inert JSX records rather than a replacement renderer. They verify: blank input never queries files; nonblank input without Focus never queries files; the explicit actual-worktree query returns the proof file with settled pending/error state; selecting the local command cancels the timer with and without Focus; typing a newer query cancels the older timer, with zero file calls at 249ms and exactly the final query at 250ms. The new fixture tests first failed on the old empty file response and whitespace acceptance, then passed after the fixture change. Fake timers are confined to pure tests, never used to advance production engine time.

Current focused validation: navigation plus existing `projects-search.test.ts` has **35 pure passes / 4 engine skips**. Focused strict test/scenario tsc, standalone scenario tsc, JS syntax and production graph/four generated script compilation pass. Knip ran without installation and reports workspace findings, including the controller export exercised through the VM callback harness; none was deleted or suppressed. The updated navigation scenarios still await main's serialized engine rerun; this worker did not run an engine or UIKit.

## Runtime scope follow-up (synthetic forwarding contract only)

This follow-up changes only the navigation strict Host, tests, scenario audit type and this document. No production collections/runtime/state/search owner or other owner's fixture is edited. The file-result query, all three exact writes, complete MCP input and keyboard continuation, Back draft and debounce-budget assertions remain intact. Body `scope: 'project'` and runtime `expectedHost` are independent contracts; the latter never changes the mutation body or directory.

`connection.list` returns exactly `{connections,selected,runtimeScope}`. The default selected ID remains `settings-navigation-production`; a second synthetic connection exists only to exercise a handoff. `runtimeScope` contains the selected ID and a deterministic, explicitly synthetic UUID lease, or is `null` in the unselected constructor fixture. Every valid `connection.select({id})` returns a new snapshot and rotates the lease, including A→B→A and selecting the same ID. `connection.rename({id,version,label})` follows the existing versioned metadata shape, returns the snapshot without rotating its lease, and rejects stale versions or extra fields. Invalid controls preserve the current snapshot. These handoff/rename calls are exercised directly by pure tests only; the engine capability list is unchanged and grants neither method. Unknown calls and fabricated lease-control APIs remain rejected. No secondary Host domain wire is fabricated.

The `runtime.request` envelope permits only `path,method,body,expectedHost`. A supplied `expectedHost` must be an object with exactly the two own keys `hostID,lease`, both matching the current selected scope exactly; strings, arrays, null/undefined, missing/inherited/extra keys, wrong Host and stale/non-string leases are rejected. Non-GET methods require it even for metadata POST reads. Scope validation happens before the domain request audit/dispatch and any write. A supplied scope on GET is equally strict: A→B→A cannot revive an old bound read. An omitted scope is accepted only for legacy read-only GETs on already allowlisted routes; omission never grants a mutation or an arbitrary endpoint. No selected Host means no request authority.

The newly landed state owner also forwards `expectedHost` on its known `runtime.stream` and keyed `runtime.stop` envelopes. These existing fixture methods accept that additional field only through the same exact scope validator; malformed/stale supplied scope still rejects. Their previous unbound forms and fixed path/key limits remain unchanged, without new capabilities or a claim that real Native stream authorization was tested.

Once the scope owner's API landed, the pure harness switched to the original production `runtime.ts` `bindRequest()` and `connectionSnapshotFrom()` with only `nsh.host.call` replaced by the strict in-memory Host. The `captureHostRequest` ports supplied to the original collection lifetime and search callbacks return that real captured binder. Tests verify that later mutation of the caller's supplied scope object does not change the captured request; missing/null snapshot authority rejects POST/PUT/PATCH/DELETE in JS before any native call, including a legacy snapshot that still has the correct selected ID but `runtimeScope: null`. The existing exported legacy `request()` is checked as an unbound read only.

Each of Agents, Skills and MCP has a real JS-binder continuation paused across an await. The synthetic Native side selects A→B→A while the request is paused; the public current Host ID is restored but the lease is not. Resuming the old request rejects with `requests: []`, `writes: []` and all domain data unchanged. A stale bound GET is also rejected. Capturing the new lease then permits precisely the original valid mutation as a positive control. Request audit rows retain forwarded `expectedHost`, while write rows keep their original exact path/directory/body shape.

Generated engine scenarios additionally assert that every non-GET and every known newly bound collection/file-search read forwards the fixture's exact runtime scope. Legacy global GETs are not reclassified as bound writes. An engine run on the old unbound production API is expected to fail rather than falling back to an inferred selected ID, a fresh lease at dispatch, or a relaxed fixture.

These tests establish JS capture/forwarding and rejection by a **synthetic** scope guard. The UUIDs are not real Native credentials or authority. No real Swift transport authorization, Keychain identity, platform isolation, engine run or UIKit behavior is established. Main owns the serialized eight-file engine batch after its scope API lands.

Scope follow-up validation: **36 pure passes / 4 engine skips** in the navigation file, including the original actual-file result/query budget and all three editor wire contracts. The new scope tests first failed against the old snapshot/unbound-write fixture and then passed with the strict protocol. Focused strict test/scenario tsc, standalone scenario tsc, Host JS syntax and production graph/four generated script syntax pass. The first strict tsc attempt observed a concurrent owner-side `state.ts` TS2454 error; after that owner update, the same command passed without editing state here. Knip was run with `--no-install`; its workspace/dynamic-controller findings were inspected and left intact. No engine, device, main bundle build, real Host, Git command or dependency installation was run.

## Main serialized engine verification

The follow-up main run completed with **40 passed, zero failures**: 36 pure cases and all four opt-in production public-navigation scenarios (`chat-mcp`, `root-global`, `scoped-search`, `switcher-search`). The command used `NSH_SETTINGS_NAVIGATION_PRODUCTION_ENGINE=1` and an explicit `NSH_BIN` pointing to the existing local distribution. The preceding attempt had 36 passes and four `spawnSync nsh ENOENT` failures before engine startup; no assertion was relaxed to fix that launch environment.

This verifies the real production App graph in the headless NSH engine, including the strict scope forwarding, full MCP editor input, actual worktree search and retained Back draft assertions described above. It does not establish UIKit geometry, system navigation-title rendering, touch gestures, actual Swift lease admission or real Host behavior.

## Settings page lifetime migration: callback VM adapter

Main subsequently reported that all four actual navigation engine scenarios passed. Its latest broader batch was **103 cases: 99 pass / 4 fail**: three navigation pure callback cases failed with `TypeError: captureHostOperation is not a function` at the old `collectionEditorCallbacks` VM port; the separate quota visibility fixture failure belongs to another owner. Main also reported both Context engine cases passed. These results are retained as main's reported engine evidence, not runs performed by this worker or UIKit acceptance.

The production collection now constructs `settingsPageLifetime()` rather than `settingsLifetime()`. The old VM supplied only `captureHostRequest` and observed only `settingsLifetime`, so it could not execute the new production entry. The focused three-case command reproduced all three exact TypeErrors before the loader change.

The navigation VM now extracts and executes the actual `state.ts` `captureHostOperation` function declaration, following the existing voice-confirm production fixture pattern. Root inputs are explicit signal ports for connection, runtimeScope, generation, readiness and foreground; requests use the actual `runtime.bindRequest` against the unchanged strict synthetic Host. The returned operation remains immutable, keeps its construction-time sender/scope/generation, and uses the original current/stale checks. The loader observes the result of the **original** `settingsPageLifetime` function; neither that lifetime nor `settingsOperationLifetime`, transactions or collection callbacks are replaced by an empty/fake controller.

VM signals register effect dependencies, schedule changed subscribers in deduplicated microtasks, remove old dependencies before reruns and detach subscriptions during cleanup. `untracked` suppresses caller dependency collection. This replaces the old one-shot effect stub only inside the collection callback harness. JSX value/disabled/condition properties are observed lazily; no native renderer or alternate navigation UI is executed. The component receives the real page/entity/directory and an active prop getter, without changing production active semantics.

The original MCP/Agents/Skills clear→successive typed values→Save cases still assert their exact minimal wire and actual directory, now also checking the complete live field value. Three additional regressions verify that draft edits trigger no authority/load requests; scope/generation changes retire the old lane; a captured old operation cannot send; confirmed foreground renewal causes exactly the domain's required collection reads (MCP 1, Agents 2, Skills 1); the dirty field survives renewal; and Save sends only the touched field using the new exact expectedHost. All callbacks are disposed to retire the actual lifetime/effects. Existing engine Back/draft, complete MCP keyboard continuation, actual-file result, query-budget and strict-unknown assertions remain unchanged.

Validation after this adapter-only change: **39 pure passes / 4 opt-in engine skips** in `settings-navigation-production.test.ts`; focused strict test/scenario tsc, strict Host JS syntax, production graph compilation and all four generated engine-script syntax checks pass. No production source or other owner's fixture was edited. This worker ran no engine, device, main build, real Host, network, Git command or dependency installation. Main owns the serialized engine/batch revalidation.

## Background history monitor: jobs-only root contract

Main reported a later combined batch of **144 tests: 127 pass / 17 fail**; the three navigation engine cases (`chat-mcp`, `scoped-search`, `switcher-search`) reached the strict rejected audit because the new shared root history monitor read previously unlisted history routes. Main subsequently clarified the precise Web ownership: `SidebarBackgroundTasks.tsx` line 87 observes `importJobsQueryOptions()` only, while `onboarding/HistoryImportStep.tsx` line 31 calls `useImportJobQuery()`. `historyImportQueries.ts` maps these to separate bare GET `jobs` and `job` routes. Therefore the root fixture must not accept `job` merely because the initial Native shared monitor also read it.

Read-only Native tracing found `NativeSetupTourOwners` creates a shared `setupHistory(undefined, operation)` monitor. The Projects root `NativeHistoryImportTaskEntry` uses `observeImport(..., 'tasks')`, with `active` limited to the Projects root; `observeImport` additionally requires foreground lifecycle and current owner. Tour steps instead demand `'tour'`. The old controller `refresh()` read both job and jobs for tasks; that was the overread sent to the Tour owner rather than an excuse to widen this fixture. During this update the Tour owner changed the controller read admission. A pure test now executes its real `createHistoryImport` against the strict navigation Host: initial tasks demand reads exactly `jobs`, deduplicated demand does not reread, empty jobs schedules one 15s background check, hiding cancels it, and hidden refresh performs no request. It checks settled `jobsReady`, no errors, no scan/writes and **zero `job` reads**. It does not replace or modify the production monitor or prove UIKit mounting/lifecycle behavior.

The final fixture change allowlists only exact `GET /api/yuri/history-import/jobs`, without query or any body property (even explicit `undefined` is rejected). It requires a present `expectedHost` already validated against the exact current synthetic Host/lease; legacy unscoped GET compatibility is deliberately not allowed on this new route. The response is the bare array `[]`, validated through real `parseNativeImportJobs`, not `{jobs:[]}`. No capability is added. `GET /job` remains rejected: its legitimate Tour null receipt is handled by `readImportReceipt`, but this navigation root never enters that surface and does not synthesize it.

Pure negative regressions reject missing scope, query/id/directory/extra fields, body/null/undefined properties, POST/PUT/PATCH/DELETE, unknown paths and all `job/scan/start/cancel/resume/dismiss/imported/sources` calls. A captured old jobs read after A→B→A still rejects and cannot write. Every generated ordinary-navigation engine case now additionally asserts zero `/api/yuri/history-import/job` reads, alongside the unchanged `rejected: []`, file query budget, actual file result, all three exact writes, complete MCP input and Back/draft checks. The first protocol/monitor tests failed on the old fixture; the jobs-only final cases pass against the updated owner.

The concurrently migrated `settings-controls` imports `./native-select`. The callback VM registers that exact unrelated UI leaf as an inert `NativeSelect`, as it already does other picker leaves; real page lifetime, operation capture, transactions and clear/type/save callbacks remain executed. No selection interaction or new host method is claimed by this port.

Current verification: **42 pure passes / 4 engine skips**, standalone scenario tsc, strict Host JS syntax, real production graph compilation and four generated-script syntax checks pass. Focused strict tsc first observed external owner-side `native-select.tsx` errors (invalid `nsh.Input` import and unsupported/nullability props); after concurrent owner fixes the repeat retained only two `string | null | undefined` → `string | undefined` errors on line 46. This file was not changed here and that check cannot be claimed green. Knip ran with `--no-install`; its existing workspace findings contain no navigation/history-core/parser entry. No engine/device/main build/real Host/network/Git/dependency operation was run by this worker. Main owns the singleton full-batch rerun and the Tour/Voice outer-owner runtime investigations.

## Commands (from repository root)

Pure Host contracts, production helper calls and graph/syntax compilation only:

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-navigation-production.test.ts
bunx --no-install tsc --noEmit --skipLibCheck --target es2023 --module esnext --moduleResolution bundler packages/nsh/tests/settings-navigation-production-scenarios.ts
node --check packages/nsh/tests/settings-navigation-production-host.js
```

Only main, in its serialized headless engine window:

```sh
NSH_SETTINGS_NAVIGATION_PRODUCTION_ENGINE=1 bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-navigation-production.test.ts -t 'production public navigation:'
```

To run just the two hardware scoped-navigation cases, without any selector override:

```sh
NSH_SETTINGS_NAVIGATION_PRODUCTION_ENGINE=1 bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-navigation-production.test.ts -t 'production public navigation: (scoped-search|switcher-search)'
```

Node/VM, Bun graph compilation and TypeScript success do not establish NSH engine, UIKit, device, production Host, title geometry or native TabBar correctness.
