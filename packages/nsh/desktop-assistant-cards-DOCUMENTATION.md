# Desktop contact receipt cards

## Frozen integration contract

`desktop-assistant-cards.tsx` exports `NativeDesktopAssistantCard` and
`NativeDesktopAssistantCardProps`. It is a presentation-only slot for the existing
contact message renderer, not another conversation, resource or navigation owner.

```ts
{
  card: Row;
  assistant?: Readonly<Row> | null;
  session?: Readonly<Row> | null;
  task?: Readonly<Row> | null;
  branch?: string | null;
  liveStatus?: { readonly type?: string } | null;
  avatarClockScope?: string;
  current: () => boolean;
  onOpen: (card: Row) => void;
}
```

Main passes `card` as the **original raw content part**. `onOpen` receives that
same object, not a reconstructed route or a metadata-enriched card. Main keeps
its existing ResourceCard navigation owner and rechecks captured authority,
actual entity and current navigation admission there. This worker does not edit
`application.tsx`, `state.ts`, `model.ts`, the conversation/List or navigation.
Unsupported raw card types produce no fabricated receipt type or guessed action;
the caller retains its existing handling for other resource kinds.

### Read-only sources main must supply

All values are exact single-entity projections from existing owners. Missing,
failed, deleted or not-yet-loaded values remain `undefined`/`null`; no card creates
a transport, store, catalog, subscription to a whole catalog, polling or I/O.

| Prop | Source/fields needed |
| --- | --- |
| `session` | Actual active-or-archived row for **card.sessionID**, including `title`, `directory`, original `providerID/modelID` or `model`, and original `summary` (`additions/deletions/files/diffCount`). A reduced native `Session` with only id/title/directory cannot supply the footer metadata; do not fill those fields with zero/current-composer guesses. |
| `liveStatus` | Same session's authoritative runtime status (`type`); never the contact's working flag or persisted history. |
| `branch` | Current branch of the resolved **session directory**, from the existing read-only branch owner. Never card.branch, the active page's directory, or a scan across projects. |
| `assistant` | Actual `card.assistantID` row, especially saved `avatarSeed`, `working`, `activeContactTurn`. Receipt `name/providerID/modelID` remain receipt snapshots as in Web. |
| `task` | Actual `(card.projectID, card.taskID)` task's original `schedule`. Used by the shared helper only for missing legacy schedule details. Existing complete snapshots are not overwritten. |
| `avatarClockScope` | Existing native clock scope, **exactly** `JSON.stringify([epoch(), app.connection()?.id])` from main's existing identity owner. Same Host/Bot/recipe joins the same singleton player/current frame used by existing native avatars. Missing scope retains the original static saved artwork without creating a private clock. |
| `current` | Retained owner identity plus foreground/modal admission. Cover also checks native lifecycle at render and at actual press. Main retains final navigation CAS. |

Do not derive these by iterating all cards/catalog entries during draft input.
Pass entity-local signals/getters and stable raw source references; an unrelated
signal must not rebuild the card, model projection, recipe or avatar player.

## Web fidelity and explicit unknowns

Reference implementation is the real Web `AssistantSessionCard`,
`AssistantAssistantCard`, `AssistantScheduleCard`, `ContactCardModelLine`,
`contactCardChrome`, and `scheduleCardPresentation`, not a thumbnail/mockup.

- Shared cover: baseline **304×148pt**, 10pt vertical / 16pt horizontal padding,
  radius **21.6pt**, rows **40/20/20/48pt**, 32pt header content and 8pt header
  bottom gap. Width can contract to the available column; height stays 148.
  These baseline values also match main's read-only observation of an existing
  real Web schedule card at 1068×832. Long values truncate visually but full
  title/path/branch/model/prompt/time are retained in native tooltips and labels.
- Typography uses existing native `uiLabel` (baseline 14pt); header/detail .8em,
  status/model/cadence .75em, title 20pt line-height; single clock 1.25em with
  22pt line-height / −.3pt tracking. Counts and clocks use tabular numerals.
- Semantic muted surface, foreground/secondary/status colors, 45% existing
  interactive hover and visible native focus ring; no new palette or icons.
- Session live nonblank title/directory beat the receipt. Cancelled always wins;
  live busy/retry beat other stored status; stored error/question/complete/
  busy/retry survive live idle; otherwise live idle means complete, stored idle
  remains idle. All seven Web statuses map to the existing translated keys.
  **Neither source knowing a status stays unknown, not Web's historical guessed
  busy.** Future unknown statuses are not labelled idle or complete.
- Session model/changes directly use shared `readSessionModelLabel` and
  `readSessionChangeSummary`. Changes only display for complete/idle; absent,
  negative, nonfinite and zero summaries are not invented. Full model identity
  is preserved. By explicit task requirement, complete provider/model values
  use existing `NativeProviderLogo` / `getProviderLogoCandidates` artwork and
  aliases; no parallel brand matching. Opaque model labels use Web's brain icon.
- Assistant artwork calls original `assistantAvatarSvg`/recipe and subscribes
  to original `nativeAssistantAvatarClock`. It has no pointer-follow, working
  dot, alternative avatar recipe/player or per-card animation timer. Modal,
  background, reduced-motion and cleanup release its lease; same Bot keeps
  original shared-frame/settling semantics. Unknown working authority is not
  synthesized from historical messages.
- Schedule cadence/clock/date/cron/legacy fallback are the actual shared
  `resolveScheduleCard` / `getScheduleCardPresentation` functions. The tiny
  `.js` re-export plus `.d.ts` boundary erases only their React-specific type
  graph from NSH JSX type-checking, not their runtime implementation. Raw parts
  and timezone are never rewritten or persisted. Web's existing time-unavailable
  translation remains explicit when no clock exists.
- The entire cover is one public `nsh/base Button`, role button and existing
  translated accessible open label. Invalid missing route identity is disabled;
  modal/background disables interaction without changing its geometry. Press
  checks `current` and native foreground again, then delegates the raw card.
  No global keyboard binding or second navigation lane is installed.

## Verification and remaining blockers

`desktop-assistant-card-model.test.ts`: five focused Vitest cases cover every
status, precedence, actual directory/branch, shared model/summary helper rules,
all four schedule kinds, missing/failed legacy sources, raw immutability,
navigation identity and provider identity extraction.

`desktop-assistant-cards-native.test.ts` creates an isolated temporary NSH config
and invokes the supplied real NSH **0.4.0** binary. It bundles the actual UI and
tests both macOS/Windows headless models, with no network, real Host, credentials,
physical windows or real user state. The scenarios cover:

- Three full cards, measured 304×148 geometry, shrink-to-248 width while retaining
  height, full metadata/artwork and 17.5pt single clock; dark/light repaint.
- **50 real Input edits plus 50 unrelated signal updates**: unchanged card mount,
  session/model field read, avatar recipe read and clock subscription counts;
  zero requests/Host calls/storage writes.
- Live status hides completed changes; schedule changes/localization, sparse
  unknown status/model/summary and raw receipts remain intact.
- All three guarded raw navigation callbacks; modal and native lifecycle veto.
- Original receipt/existing avatar shared-clock equal-frame samples, two leases
  on the same singleton, release on loss of interaction, zero I/O.
- macOS native Tab → Enter / Space activation across all three cards.

**Windows keyboard is an open NSH 0.4 runtime blocker.** The same real-headless
Tab→Enter test was run and failed (`calls:0`), then retained as an explicitly
skipped Windows regression, not counted as passing. Read-only source confirms
`nsh-testing/src/headless/keyboard.rs::tabs_to_views` only admits MacOs/Web;
Win32 `input.rs::tab_focus` likewise traverses text fields. The permitted card
scope cannot fix that native runtime ownership. Main must resolve this upstream
or report the Windows keyboard gap; do not add a card-local global-keymap hack.

An isolated temporary `nsh check . --tsc <installed tsc>` generated its own types
and strictly compiled the actual component/fixture import graph successfully.
Root `bun run dead-code` was attempted but failed loading existing Web Vite config
because `vite-plugin-pwa` is unavailable; no dependency was installed to bypass it.

**Headless does not render pixels or prove OS acceptance.** AppKit/Win32 visual
comparison, screen-reader focus/activation, physical keyboard, high-contrast,
real Host/live-owner wiring and the actual App consumer are not signed off by
these isolated fixtures. Main owns production source injection and end-to-end
App verification; there is no claim of complete Mac/Windows 1:1 acceptance.

## Production-root integration

`ChatOwner` now supplies these cards only for desktop contacts. A single computed
index combines the original root session summaries and retained Projects rows,
preferring a newer `updated` timestamp and the retained row on equal timestamps.
The root publishes its existing sidebar switcher source; that source's normalized
worktree branch map is reused. No card starts a session/branch read, second catalog,
timer or transport. Root-directory branch metadata that this source does not own
remains absent. `desktopContactCatalog()` exposes only the root's already stamped
session/Assistant/task rows for the current authority; failed reads retain prior
rows only under that authority. Unscoped `app.sessions`/`app.bots` remnants after an
authorization change are not card metadata. Exact `(projectId, task.id)` entries
provide task fields. Existing working avatars join the same scope.

Both existing session producers now retain only the shared helper's model label
and compact nonzero change summary, not raw metadata, history or credentials.
`desktopContactSessionStatus` reads the exact root event cache and native scope;
only a real `session.status`/`yuri:session-status` type supplies busy/retry/idle.
An execution-ended boolean is not fabricated idle. Reconnect or authority change
revokes that metadata. These additions do not issue extra reads.

The existing `ResourceCard` still owns captured PageOperation, pending admission,
canonical lookup when needed, and guarded Session/Assistant/task navigation.
Contact Session navigation now prefers the same actual session directory/title
shown on the card; ordinary Session/iOS card precedence is unchanged. Reactive
fields are passed explicitly through this wrapper; spreading a newly calculated
plain metadata object would freeze live status at the wrapper's initial value.

Historical App narrow regression: **6/6** scenarios on paired digest
`7834beffee6dc6dd588bee99f717366a37dca2282ceb53544b80734e800f97e0`
(one card type per platform). They verify live title/model/summary and real retry
status, no historical branch substitution, legacy schedule resolution from the
actual task, 50 input edits with zero extra requests, Settings veto/retained writer,
and navigation to the exact directory/Assistant/task through the original owner.
That batch used the older retained-route navigation. The subsequent 11-file batch
passed 346 outer tests, including 84 internal App scenarios, before scoped catalog
and Web-aligned navigation changes. Neither batch validates those later changes.

Current navigation follows the Web destinations: Session still pushes a retained
route; Assistant reuses `AssistantHome.changeConversation` to select the exact
contact, and Schedule enters `DesktopScheduleHome`'s existing TaskEditor panel.
Assistant/Schedule departure uses the original mounted collector and release ACK,
not a second detail-page writer. Cross-page seeds are authority-bound, consumed by
the destination's fresh owner, and never fall back to the first Assistant when an
explicit ID is missing. Same-contact navigation preserves the current owner.
The source PageOperation is rechecked while the original owner remains mounted;
late replies, pending/unknown veto and post-release commit need actual-root tests.
Full App and physical OS keyboard/visual behavior remain separate acceptance.
