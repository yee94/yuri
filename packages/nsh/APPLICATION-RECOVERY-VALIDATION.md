# Application operation recovery handoff

## Implemented boundary

`page-operations.ts` separates the mounted page's identity from its operation authority. The display identity captures Host id/origin/authorizationID, permanently retires on an actual change, and survives same-Host suspension. The operation signal becomes null on hidden/background/unconfirmed state; only an admitted `captureHostOperation()` result is assigned. Each assigned object's `current` and `request` check that exact assigned object, page lifetime and active state. A callback never forwards to a newer object's request. A readiness-gap candidate is discarded and cannot later become current. The effect observes root readiness through the factory predicate, including legacy snapshots whose runtimeScope remains null.

Application preserves Chat/NavStack/List/row-projector identities across same-Host foreground. The Chat sends its current operation signal to transcript history, speech and admission. Prompt compilation, attachment confirmation/picker and dictation callbacks capture their operation before awaiting. Covers retire operation authority but leave the retained Chat sync demand on the existing state owner.

- Transcript history retains its storage recovery signals and rebuilds action callbacks from the operation signal. Release closures carry their captured Chat generation; an obsolete `onPending(false)` cannot release a newer Chat lane. Row action confirmation captures its original binding before awaiting.
- Speech keeps the facade/state signal but disposes the old controller and creates a new one only after admission. Explicit speech action confirmation captures the old controller; it cannot call a replacement controller after the dialog resolves. Native speech admission is still subject to the native bridge's own contract.
- Header metadata disposes the previous read controller, retaining the displayed snapshot; historical model-name catalog reads use a fresh operation.
- Context overview disposes/recreates its read-only controller from the actual current `chat.messageScope` while retaining the route/page.
- Projects authority preserves buckets, order and visible selections, resetting only flight/pending slots at retirement. AssistantHome and ScheduledCatalog/History use captured per-action lanes. Search retains its page/input and captures a lane per query. Root Home Tab content is keyed by actual id/origin/authorizationID only, never suspension epoch.
- `SettingsQuotaOperationPage` removes the fixed `route.generation === epoch()` visibility condition. Its stable identity gate allows the quota owner's existing operation-only recovery to run without remounting its form or changing directory.
- `SettingsOperationPage` supplies an `operationToken` prop for Settings-owned forwarding. No settings implementation, quota implementation, state/runtime or Swift source was changed by this application task. The SettingsPage→SettingsBasics forwarding remains the Settings owner's responsibility if it opts into that explicit token; the worker's existing self-managed recovery is not replaced here.

The notification root's captureRequest/authorizationID/catalog readiness and catalog-receipt recovery effect were preserved.

## Production navigation effect-loop fix

The responsive changes-reader getter subscribed its caller to content revision. The composer visibility effect then called `cancel()`, which publishes that revision; on a keyboard navigation cover, this formed a read/write loop. The getter now observes operation replacement only. Visibility/Sheet cancellation side effects run untracked. Keyboard handlers remain registered and execute their navigation actions untracked; no keybinding, test assertion, request budget or scroll threshold was removed.

The pure regression executes the production `createOwner` and `NativeComposerChanges` functions with dependency-tracked signals and a reader whose cancellation actually publishes a revision. Fifty cover/back cycles remain bounded. This is not an NSH engine result; main owns the serial engine rerun.

## History pre-flush seam

Chat constructs its footer helper and signal before calling `createChat`. The synchronous `beforeHistoryPresentationFlush` consumes supplied final facts, including `more || historyError || boundaryMissing || repairPending || hasGap`, and recognizes only `successful-history` as successful authority. It does not read a not-yet-assigned Chat. Retirement resets the footer scope. The experiment remains false, with no entry to enable it. No new offset/inset/scroll writer or threshold was introduced.

Natural-height/ref tickets and UIKit release measurement are not integrated or verified here. This seam does not fix or prove the real production 53pt displacement; default-off yields zero retained footprint.

## Actual pure/static evidence

At handoff, local `tsc --project packages/nsh/tsconfig.json --noEmit --pretty false` passed. Eleven pure Vitest files passed, 128 tests total: application-recovery, runtime-scope-state, history-presentation, business-request-owner, context-usage-route-surface, transcript-actions, new-session-ui, new-session-selection, chat-changes-actions, appearance, speech-core.

`application-recovery.test.ts` has nine tests. It executes production pageScope/operation owners, Projects controller, transcript-history and audio owners, actual Chat setup and the actual quota route active expression. The Chat test verifies one construction, retained window/row/List ref/draft/input-mode/choice identities, stale attachment/dictation rejection and no operation reconstruction across fifty draft edits. Its dependency-tracked signal harness is distinct from the inert callback-only wire loaders.

A separate pure run of settings-navigation-production, settings-quota-production and context-usage-production exposed outdated callback-loader adapters. The search loader was updated to execute the real page-operations module with its existing strict bound sender. Three remaining collection-editor callback tests fail because the Settings-owned loader does not supply `captureHostOperation` to its newly changed `settingsPageLifetime`; that loader's settings adapter and assertions were not altered here. Eleven opt-in engine cases were skipped by that pure run.

No engine/UIKit/device/main build, real Host, network, Git, dependency installation or knip download was run. The supplied engine failure log was read; engine reacceptance remains main-owned. No readonly subagent was dispatched: the available tool catalog did not expose a delegation/session-prompt tool.

## Explicit remaining work

- Main should serially rerun the actual keyboard navigation/context/quota scenarios after the loop fix and quota gate fix. Pure tests do not assert those engine scenarios passed.
- Other constructor-only business owners still require operation-only foreground migration: feature editors, assistant details/settings/channels, model picker, new-session durable owner, project-directory registration, tool-row navigation and resources. Their captured senders must remain fixed; do not restore them by swapping a global request proxy.
- The Projects deferred-delete journal still has its original epoch lifetime. It was not rebound or automatically replayed during foreground recovery. Its retained failed/unknown journal handling needs its owning follow-up; other Projects actions being resumable is not evidence that delete recovery is complete.
- An unknown first admission is not automatically retried on replacement. The existing durable new-session source/handoff generation still prevents post-suspension source completion/reconciliation; full pending-admission recovery needs an explicit retained journal/source-owner seam. The application marks an interrupted sending admission unconfirmed, preserving its source rather than replaying it.
- `SETUP-TOUR-CONTRACT.md` was read. Tour/history-import assembly remains explicitly handed to main: use the existing setup-tour command from Web, mobile autoStart=false, one system NavPage per route, shared same-Host/lease/directory history owner across reopen/task entry/task page, no duplicate poller, no ACK/unknown replay, and existing scoped resource/Relay links. No placeholder route or new Settings/Tab entry was added.

These gaps prevent claiming complete NSH foreground/1:1 acceptance.
