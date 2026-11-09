# Changes diff layout consumer seam

## Local source evidence

- Web `packages/ui/src/components/views/DiffView.tsx` declares `SIDE_BY_SIDE_MIN_WIDTH = 1100` and getLayoutForFile first honors explicit inline/side-by-side. Dynamic returns inline for a new file or viewport width below 1100; otherwise side-by-side. It uses useDeviceInfo screenWidth, not the Sheet width or a mobile-only override. 1100 itself selects side-by-side for an existing file.
- Web workspace new-file metadata is index/working_dir equal to A or ?. Historical canonical metadata is status=added; tool-patch metadata uses the exact `--- /dev/null` marker in diffPatchUtils. Empty old text alone is not proof of new-file status.
- Local `packages/nsh/.nsh/types/nsh/base.d.ts` defines DiffLayout as split | unified and DiffViewProps.layout accepts it. No remote docs were fetched; Context7 was not called.

## Implemented consumer

`chat-changes-layout.ts` exports:

```ts
type NativeDiffLayoutPreference = 'dynamic' | 'inline' | 'side-by-side';
nativeDiffLayoutPreference(value: unknown): NativeDiffLayoutPreference | null;
nativeDiffLayout(preference: unknown, viewportWidth: number, isNew: boolean): 'unified' | 'split';
```

NativeComposerChanges and NativeChangesSheet both accept optional `diffLayoutPreference?: NativeDiffLayoutPreference | null`. The prop is forwarded through SheetPage/Content/NativeChangeDiff to NativeDiffDocument. The native DiffView receives unified for inline, split for side-by-side (including narrow screens/new files), and the Web viewport/new-file rule for dynamic.

Null, undefined and invalid runtime values remain unknown. The display-only fallback is unified; it does not manufacture a confirmed inline setting, mutate a preference, clear an error or perform a write. Invalid viewport width also selects the display-only unified fallback. There is no settings request, new store, local persistence, Host fallback or extra synchronization owner in this consumer.

The new-file metadata computation is separate from viewport layout. Layout selection is O(1); it does not parse patches, clone bodies, scan files or fetch on viewport/preference changes. Owned metadata is derived from the existing selected reader snapshot. Historical metadata never consults current Git. HistoricalChange now optionally carries validated added/deleted/modified/renamed status; historical on-demand reads preserve it without changing body validation or authority. Source status wins over a conflicting patch marker; a patch marker is only used when status is absent.

Reader identity, owner.draft, generation edit revision, unknown journal, Each diff key, DiffView source strings, source-hunk mapping, selection/native ref and preview callbacks remain unchanged. The new setting is not part of any remount key.

## Canonical appearance/application seam

These files were intentionally not edited: appearance.tsx, appearance-core.ts, application.tsx, state.ts and settings-preferences-core.ts.

Main has now installed and verified the appearance-core field/parser and all three application props. Current source confirms the parser at appearance-core.ts:176 and the props at application.tsx:1406/1523/2142. Main reported 73 appearance-core tests passing. The following schema/default rules describe that shared-owner contract; they are no longer pending assembly. Settings capability metadata remains with the preferences owner.

1. Add the following field to NativeAppearance in appearance-core.ts (AppliedNativeAppearance inherits it):

   ```ts
   diffLayoutPreference: NativeDiffLayoutPreference | null;
   ```

2. In the existing successful appearanceFromSettings path, parse that same Host snapshot using the pure consumer validator:

   ```ts
   import { nativeDiffLayoutPreference, type NativeDiffLayoutPreference } from './chat-changes-layout';

   diffLayoutPreference: settings.diffLayoutPreference === undefined
     ? 'inline'
     : nativeDiffLayoutPreference(settings.diffLayoutPreference)
   ```

   Missing field in a confirmed successful settings object uses Web's inline default (useUIStore initial value). An explicitly invalid value becomes null. A failed settings GET must never take this missing-field path or publish a successful default. Preserve the existing canonical refresh's prior snapshot/error handling: same-Host read failure may retain its prior validated preference with the existing error; no prior snapshot means unknown. Host switch uses the existing sourceHost/scope reset. The new preference is JS-only; do not add it to appearance.apply or Swift override DTOs.

3. Pass the field from the existing current-Host canonical signal to **all three** production entrypoints. Current locations in application.tsx are NativeComposerChanges at line 1407, Chat's historical/tool NativeChangesSheet at line 1524, and project's NativeChangesSheet at line 2143:

   ```tsx
   diffLayoutPreference={nativeAppearance.current()?.diffLayoutPreference ?? null}
   ```

   This is a read of the existing root snapshot, not a request or a second store. If the appearance owner instead exposes a canonical getter, pass its nullable validated value through the same prop. Do not destructure/freeze this signal at page construction.

4. The Settings capability metadata in settings-preferences-core.ts belongs to the preferences owner; this task does not alter it. Historical callers with canonical status must include that status in their existing HistoricalChange metadata; metadata absent from a complete text pair is not guessed from its empty original side.

## Pure red/green evidence and limits

`chat-changes-layout.test.ts` compiles and executes the actual production Changes JSX, passes a validated preference through public Sheet and Composer props, and observes the native DiffView boundary. The Composer harness opens its emitted Sheet props around an already selected real reader; it does not simulate native gestures. Native primitives and the unrelated Workspace UI are observation boundaries. The reader, body validation, status metadata and navigation helpers are real production code.

Initial consumer regression: **6 failed / 6 passed**. Failures were hardcoded unified for explicit split/dynamic-wide and public prop forwarding; hunk navigation/stale completion already passed. A separate historical on-demand test then failed because status=added was discarded. After the consumer and metadata fixes, **13 focused tests pass**.

Combined Changes validation: **7 files / 81 tests passed, 1.98s**. It includes existing strict historical authority, unknown journal, callback and same-Host lease replacement draft/generation regressions. New tests cover 1099/1100 boundary, explicit split on narrow/new files, public prop chain, unknown/invalid validation, 2000-line source reference stability and no added Git requests, historical/current isolation, owned added status and original DiffView hunk/target navigation in both layouts. Full NSH TypeScript and four-file Bun syntax conversion passed.

Dead-code completed and was inspected: no report for the layout helper, Changes consumer or model; existing workspace/configuration hints remain. No entry was removed to suppress those hints.

The VM checks emitted layout props, reference/operation contracts and real callbacks. It does not run native diff rendering, validate selection gestures, measure resize latency, prove stable native mounts during reactive updates, or establish UIKit parity. After the canonical appearance assembly, main owns independent oracle review and engine/UIKit tests covering switching preference and resizing an open diff, historical/workspace files, native selection, preview lines, large diffs and commit drafts across lease changes. This remains an open 1:1 acceptance item until those checks pass.

No engine, device, real Host, Git, dependency change or paid request was executed by this task.

## Oracle P2: tool metadata must retain canonical file status

The first implementation preserved status in Changes history but NativeToolFile and both nativeToolDetails adapters dropped it beforehand. A completed tool snapshot with status=added, before='', after='historical text' and no /dev/null patch was already complete body authority, so no hydration could recover the lost status. Dynamic-wide then treated the file as modified and selected split.

The production fix is confined to transcript-tools-model.ts: NativeToolFile now exposes optional added/deleted/modified/renamed status, and both metadata.files and metadata.filediff retain only these exact validated enum values through one private validator. No status is inferred from old text, tool completion state, patch counts or current Git. Paths, bodies and the application forwarding contract are unchanged. Canonical appearance parsing was not modified.

New tests execute nativeToolDetails → real createChangesReader → nativeDiffIsNew → nativeDiffLayout. Before the fix, transcript-tools-model.test.ts had **8 failed / 26 passed** (four enum values across both adapters). After the fix all **34 tests pass**. Added with complete pairs uses unified in wide dynamic mode with zero requests; non-added/absent/invalid metadata does not manufacture added from before=''. One-sided added snapshots still request only their exact historical endpoint and remain unavailable if still incomplete, never current Git.

Combined validation after the oracle fix: **8 files / 115 tests passed, 1.82s**; complete NSH TypeScript and two-file Bun syntax checks passed. Dead-code was checked; the only relevant report was the existing NativeToolField export, which was not changed or removed. Reader/draft/unknown journal regressions remain included. The fix is ready for the original oracle to re-review; no engine/UIKit result is claimed.
