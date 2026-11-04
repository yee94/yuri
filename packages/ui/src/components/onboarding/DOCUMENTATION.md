# Three-step setup tour

`SetupTourHost` owns startup eligibility; `SetupTourDialog` owns the bounded
shared Dialog. `OnboardingScreen` continues to own pre-connection/fullscreen
setup, recovery and content indexing. The tour never opens Add Project.

## Entry and persistence

Desktop/web `MainLayout` mounts the host after connection. Automatic eligibility
waits for home/config readiness, settings hydration and the authoritative
`projectOrderQueryOptions` snapshot. Failed/pending reads are not empty projects.
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
   The tour then requires a nonpartial authoritative model catalog before advancing;
   it does not infer provider-to-plugin ownership or claim an inference request was
   tested. Magpie itself must be set up on the connected Host (local or remote) as
   described in its README. Missing models keep this step open with setup guidance.
   Other providers reuse `ProvidersPage`, including its native OAuth, credential,
   custom-provider and discovery flows, inside the same dialog.
2. **Tools:** Only Eficy and yee-profile are offered. Exact package identity detects
   existing versioned entries; existing configuration is not overwritten. Batch
   failures preserve successful independent writes and retries do not duplicate
   those entries. Activation is read from OpenCode, not inferred from configuration.
   Explicit application performs at most twenty activation reads, 750 ms apart,
   stopping when selected plugins have a reported state, the scope changes, or the
   dialog unmounts. Pending/failed activation keeps the step open for retry/README
   inspection; closing performs no further writes.
3. **Voice:** Independent input and read-aloud entry points render the corresponding
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

Desktop uses a vertical three-step navigation rail beside the content viewport.
Provider/voice editors and README occupy that same right-hand viewport without
resizing the dialog. Narrow screens stack navigation above content. Embedded
Provider content drops its standalone page insets; its own scroller owns the form
viewport. The tour footer remains outside that viewport. Plugin deduplication is
behavior, not explanatory copy in the onboarding cards.

## Verification

Tests cover authoritative startup gating, existing workspace suppression,
postponement/manual reopening, runtime partitioning, unchanged pins/options,
partial installation/retry, late completions, README/icon metadata, the real speech
save adapter and absence of automatic work while dismissed. Browser/platform tests
must use isolated configuration or mock mutation routes rather than installing
plugins or altering speech credentials on a developer's active Host.
