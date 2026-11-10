# Four-step setup tour

`SetupTourHost` owns startup eligibility; `SetupTourDialog` owns the bounded
shared Dialog. `OnboardingScreen` continues to own pre-connection/fullscreen
setup, recovery and content indexing. The tour never opens Add Project.

## Entry and persistence

Desktop/web `MainLayout` mounts the host after connection. Automatic eligibility
waits for home/config readiness, settings hydration and the authoritative
`projectOrderQueryOptions` snapshot. A successful settings object without a
`projects` property is the fresh-install empty catalog; an explicit malformed
property, malformed response, or failed/pending read is not an empty catalog.
The catalog is Yuri's registered-project list, not OpenCode's discovered root
project. The Host initializes an empty registry before accepting first-launch
directory updates; `lastDirectory` is migrated only from pre-registry settings,
never from a deliberate empty registry.
An existing project snapshot suppresses subsequent automatic onboarding, even if
the last project is later deleted. Opening alone records pending progress, not
completion. Closing postpones automatic presentation, retains the current step,
and allows explicit resume from the command palette. Step-level “later” advances
without making a configuration change or marking that capability ready.

`useSetupTourStore` saves only step/dismissal, partitioned by the stable connected
instance through `createInstanceScopedJSONStorage`; the open flag is transient.
Instance changes rehydrate that partition. Transport/generation/directory changes
remount the dialog and cancel its local work/drafts. Hosted/Capacitor mobile mounts
the same host in manual-only mode. Standalone VS Code has its own project registry
and no Host speech settings, so neither automatic nor manual tour is exposed there.
Mini Chat and embedded conversation roots do not mount it.

## Real configuration owners

1. **Models:** Magpie is `opencode-magpie-plugin`, applied once in this step.
   Plugin entry writes reuse `usePluginsStore.createEntry` with user scope and
   retain existing pins/options. OpenCode owns package installation and activation.
   Host user-scope plugin creation fills missing `$schema` with
   `https://opencode.ai/config.json` and missing `lsp` with `true`, alongside the
   selected `plugins` entries. Existing explicit values and JSONC comments survive.
   Saving the Magpie entry immediately advances the tour, without requesting plugin
   activation or waiting for a model catalog. Magpie itself must be set up on the
   connected Host (local or remote) as described in its setup guide.
   Other providers reuse `ProvidersPage`, including its native OAuth, credential,
   custom-provider and discovery flows, inside the same dialog. These direct-provider
   flows retain their authoritative model-catalog check before advancing.
2. **Tools:** Only Eficy and yee-profile are offered. Exact package identity detects
   existing versioned entries; existing configuration is not overwritten. Batch
   failures preserve successful independent writes and retries do not duplicate
   those entries. “Save and continue” writes the selected entries to OpenCode config
   and advances after successful saves. It does not install packages, poll activation,
   or gate progress on background loading; OpenCode's config watcher owns that work.
   Saving is not a claim that a plugin or model is already usable. Failed saves keep
   the step open for retry; runtime changes or closing stop subsequent writes.
3. **Import:** `HistoryImportStep` owns source selection, read-only examples and the
   explicit “Next” import action. Host-owned `/api/yuri/history-import/*` routes read Claude
    Code, Codex, Cursor editor/CLI, DeepSeek Harness and current-instance OpenCode
    histories. OpenCode selection registers its original projects and indexes
    existing sessions without copying them or rewriting native configuration. Entering this
   step detects sources once through a runtime-scoped Query (60s freshness,
   five-minute cache retention, no focus refetch). Discovery reads only; nothing
   is written until “Next”. Every step remains optional. The job Query
    polls only a running job. Five compact horizontal cards fill the content width
   in three equal columns (one on narrow screens), with a small logo, source name
   and installation dot, never source/destination paths. Top source cards and
   preview group headings show the same metadata-derived count, separate from
   the five displayed examples. Positive candidate counts use `≈` because
   duplicates, malformed and empty transcripts have not been checked; unavailable
   counts are hidden without placeholders, never replaced with zero. A successful
   empty inventory shows `0`.
   Executable/application probes run on the connected Host, not the browser/phone,
   and do not launch agents. Installed, not detected and unknown are distinct;
   readable history remains selectable even after its tool was uninstalled.
   Entering uses `scan` with `limitPerSource: 5, includeCounts: true`. Metadata
   traversal counts candidate history files while transcript parsing stops once
   each source has enough examples. Cursor editor uses `COUNT(*)` and a bounded
   composer-header query within the same private DB/WAL snapshot; counts do not
   require reading the remaining message bodies. These are candidate counts, not
   verified importable totals or the latest conversations across the catalog.
   Below the source cards, read-only conversation cards are grouped by source,
   up to five each, in full-width single-column lists with title, source logo,
   localized date and an excerpt of real conversation text as the subtitle.
   The excerpt prefers assistant text, falls back to user text and excludes
    thinking/tool records. There is no per-conversation selection or pagination.
    The subtitle states that duplicates are not imported again. A separate
    runtime/scan/destination/job-revision-scoped Query checks only sample import
    identities after preview is available; it does not disable “Next”. Verified
    entries show “Already imported”; failed/unknown checks show no status instead
    of claiming “not imported”. A completed job changes the badge query key.
    Counts still include already imported histories, not just pending work.
   Checkboxes beside source group headings and top source cards share the same
   local selection, controlling which tools are imported, not individual examples.
   Every source starts unchecked. Previews and counts remain visible; “Next” with
   no selected source advances without starting an import job or full scan.
   Unchecked source previews remain visible and dimmed so they can be reselected.
   There is no selected-count toolbar, rule/merge/refresh control or select-all
   button. A text retry action appears only when discovery or job loading fails.
   Per-source/file sample read failures stay silent in the tour; readable previews
   remain usable. The Host response still retains those failures, and a failed
   sample never displays the successful empty-history message. Confirmed
   jobs continue on the Host after closing the dialog; cancellation stops between
   items. Full receipts survive Host restart; unfinished jobs become interrupted.
   Retrying imports is safe through deterministic session IDs and verified
   provenance. Conversations retain their source project; missing project paths
   use the current tour directory. Each selected conversation remains separate;
   the tour never combines selected histories into one conversation.
    The tour footer submits `yuri-tour-import`: “Next” immediately starts Host-owned
    scanning, validation, project creation/registration and verified writes for
     selected sources. Phase progress appears below the title/subtitle, before
     source cards and history previews. An accepted start scrolls to the heading
     once so the new progress is immediately visible; polling never scrolls the
     user's reading position. Previous terminal jobs and their retained errors
     are not displayed here. A running Host job remains visible; a job started
     in this mounted step hides its progress and error feedback immediately on
     completed/partial. Cancelled/interrupted feedback remains available for retry.
     “Continue in
    background” advances to voice without cancelling the task. Samples never bound
    the import selection; the Host rejects plans built from sampled scans. Missing
     project directories are created only after confirmation. Accepted completed
     or partial jobs advance without starting another import; cancelled/interrupted
     jobs remain retryable. Empty source selection and
   skipping perform no write. Errors keep the step open; runtime changes abort
   pending operations and cannot trigger the next write or navigation.
     Retained per-item failure codes are deduplicated beside retryable progress.
     Partial-job failure details remain in Host receipts, not the finished UI.
     Tour/background source jobs import conversations only. They never scan,
     copy or activate project rules, skills or configuration, including on resume.
     Existing files are left untouched; project registration only exposes sessions
     in the project list. The explicit Host preview API retains optional settings
     planning for separate, explicitly requested operations, not this tour.
     The tour omits the import-options heading and explanatory footer.
     See the Host `history-import/DOCUMENTATION.md` for
   formats, conflict policy, limits and intentionally lossy conversion.
4. **Voice:** Independent input and read-aloud entry points render the corresponding
   section of `VoiceSettings`, preserving its full provider choices and native
   availability checks. Entering an editor never changes the saved provider.
   Each section retains its own save/test controls. The overview uses microphone,
   speaker, local-device and cloud icons; Doubao is an optional recommended shortcut.
   The shortcut reuses `useSpeechSettingsForm`, `VolcengineSpeechSettings`,
   and `/api/voice/settings`. Choosing the editor stages Volcengine ASR/TTS and
   dictation/read-aloud enablement together. The API key is entered once, remains
   only in the form until submitted to the connected Host, and is never added to
   tour persistence or Query keys. Failed saves retain the draft. Existing shared
   microphone tests and TTS previews save the same draft before testing. Saving
   configuration is not labelled a successful recognition/playback test.

## Metadata and presentation

Magpie and tool cards expose a full-card pressed button with a prominent corner
check and selected border. Configured tools retain that toggle; their configured
label describes existing state independently of the current selection. Deselection
only excludes a plugin from this tour's apply batch and never removes configuration.
README/setup links remain separate controls and do not toggle the card.

The model step uses bundled brand icons and localized product copy for Magpie,
marked recommended, plus common OpenCode providers and official setup links.
Provider shortcuts prepare an existing connection or seed `ProvidersPage` with
an initial connection choice. Missing native integrations fall back to its chooser.
Magpie does not use registry description/version/README as its introductory card.
The tools step's runtime-scoped plugin registry batch query opts into `details=true`
for the latest developer description and README; `PluginIcon` displays the
sanitized top-level package icon. The details query has a distinct key from the
ordinary version-only query. README uses `SimpleMarkdownRenderer` with local
file-reference interactions disabled. Missing/read-failed metadata is explicit and
retryable. Tool descriptions and artwork remain developer-provided.

The shared Dialog, Button, Checkbox and Settings primitives own material, focus,
Escape and form layout. CSS only sizes the frame, scroll region and entity cards;
all colors use semantic theme variables. Localized chrome ships in every locale;
developer content and package identities retain their original language.

Persisted tour version 0 voice progress (`step: 2`) migrates to `step: 3`, retaining
dismissal. Version 1 stores the new import step at `2` without remapping it again.

Desktop uses a vertical four-step navigation rail beside the content viewport.
Provider/voice editors and README occupy that same right-hand viewport without
resizing the dialog. Narrow screens stack navigation above content, with four
equal columns and numbers above wrapping labels so steps cannot overlap. Embedded
Provider content drops its standalone page insets; its own scroller owns the form
viewport. The tour footer remains outside that viewport. Plugin deduplication is
behavior, not explanatory copy in the onboarding cards.

## Verification

Tests cover authoritative startup gating, existing workspace suppression,
postponement/manual reopening, runtime partitioning, unchanged pins/options,
partial config saves/retry, absence of activation/model waits for Magpie, late
completions, README/icon metadata, the real speech
save adapter and absence of automatic work while dismissed. Browser/platform tests
must use isolated configuration or mock mutation routes rather than installing
plugins or altering speech credentials on a developer's active Host.
