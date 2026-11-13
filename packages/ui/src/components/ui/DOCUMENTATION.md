# Shared update presentation

`UpdateDialogView` is the single update dialog renderer for client updates and
remote Host updates. Its `UpdateDialogModel` contains display data, progress,
messages and action descriptors; `onAction` delegates commands to the owning
adapter. It owns the existing dialog sizing, version diff, Markdown/versioned
changelog/date/mention rendering, scroll area, progress, errors and footer.
It does not query a Host, call an updater, reload a page, or dismiss update-store
state. Channel selection stays in the existing outer About switch; the dialog
does not render a second channel selector or keep its own channel preference.

`UpdateDialog` preserves the existing client-updater props and lifecycle for
About, Sidebar and mobile OTA notices, adapting them to the shared model.
Starting a client download keeps the dialog open so progress, errors and the
restart action remain visible; users can still dismiss it explicitly.
`update/hostUpdateDialogModel.ts` converts the Host DTO to that same model;
`HostVersionUpdate` retains runtime-scoped Query state and exact-plan mutation
orchestration. Remote updates never dismiss or mutate the local client updater.
The Host entry first refreshes the existing query: a new release opens the
confirmation dialog, an authoritative empty result uses the same latest-version
toast as the client update check, and failed/unsupported checks notify separately.
An active operation opens its progress directly. The dialog has no second check
button, and stale runtime/channel check results cannot open it or notify.
When a Host task observed in the open dialog reports success, its adapter closes
the dialog and shows one success toast. Historical success, failed tasks and stale
runtime completions do not trigger that notification.
Host dialogs opt into a viewport-bounded stable frame with a scrolling changelog.
During submission and active updates, a compact status line and progress bar
replace the action row; check/update buttons, empty detail rows and footer
spacers are absent. Reconnect text replaces the status label in that same row.
Installation method labels are omitted from the Host header.
The Host adapter retains display-only release
metadata for the matching plan/version in its runtime/channel scope while busy
snapshots omit the plan; it never reuses that metadata to authorize an update.
Submission, download, installation and reconnect do not hide the changelog or
change the dialog height. Client dialogs keep their existing sizing and lifecycle.

# Default action buttons

`Button`'s default/primary variant uses an opaque `surface.muted` plate with
ordinary foreground text and no border (`border-0`). Hover/press mix foreground
into that same opaque surface; focus uses a neutral foreground ring. These states
do not consume primary/accent tokens. Light/dark themes share this recipe, and
disabled/loading retain their standard interaction semantics. Destructive
variants retain their status meaning. `chip` mode selectors also use the
borderless neutral recipe: selected (`aria-pressed`) mixes 6% foreground into
the solid surface, increasing to 8% on hover and 10% on press. Selection is
communicated through fill strength and `aria-pressed`, never an accent border
or accent text, in both light and dark themes.

The legacy `outline` and `neutral` action variants use this same borderless solid
recipe, so existing import/add/discover actions remain consistent without local
overrides. Keyboard focus remains visible through the neutral focus ring.

All new primary actions reuse `Button` with the default variant (including icon
actions, dialog confirmations, imports, creation, saves, retries and updates).
Consumer classes may adjust layout, but must not override its colors with accent
tokens or recreate the old tinted fill/border/text recipe. Toast utility actions
(copy, acknowledge, undo) use neutral ghost buttons rather than primary plates. This applies to all
shared UI runtimes. `button.test.tsx` guards the primitive across sizes and states,
scans default Button consumers for direct accent overrides, and rejects raw
buttons with literal accent-filled classes. Indirect class variables, CSS and
native controls still require visual review; the source scan is not a CSS engine.

The Projects and Assistant root-header add buttons use `Button mobileGlass`
with `mobileIcon`, matching search/back controls. `yuri-mobile-inverse-action`
only swaps the tint to translucent `surface.foreground` and the icon to
`surface.background`; reflection, blur and shadows retain the shared recipe.

# Settings form controls

Inside `yuri-settings-workspace`, `styles/settings.css` owns the material of
Input, Select, NumberInput, Textarea, and `yuri-settings-inline-value` pickers.
Filled detail fields default to no border; hover/open/focus adds no outline or
ring/shadow. Both mouse and keyboard focus use the shared solid interaction
background. Rules apply
outside SettingsRow too, including model-filter/search toolbars and scoped
dialogs. Disabled state remains inactive; invalid fields keep one semantic inset
error indicator. Numeric inputs/steppers and compound textarea content never add
a second decoration. Non-Settings consumers retain their primitive defaults.
Sidebar collection surfaces use `yuri-settings-sidebar` to give all their input
controls, including search/filter and project pickers, a faint stable
`--form-surface-border` edge via `--yuri-settings-control-border`. Standalone
project pickers can opt in via `yuri-settings-sidebar-picker`. Neither scope adds
a focus ring/outline or changes the borderless detail-form default.

`Input` also accepts an explicit `bordered` option: `true` keeps a faint
`--form-surface-border` edge, `false` hides it, and omission shows a faint border
for empty Settings text inputs, otherwise inheriting the owning surface's default.
Empty state uses native `:placeholder-shown`, which follows the live input value
rather than the initial `value` attribute. An invisible single-space placeholder
is supplied when no visible placeholder is provided; existing placeholder copy
is preserved. `:empty` is unsuitable because inputs are always childless.
Explicit values override the empty/sidebar/detail default without
changing control geometry, hover/focus fill, or validation feedback. Outside
Settings, omitted values preserve the primitive's original recipe; explicit
values select a real thin border or transparent reserved border instead of a
neutral ring. Provider and custom-provider model filters use `<Input bordered>`.

`Input endAdornment={...}` places a trailing icon/action inside the field. Only
adorned inputs add a transparent `data-slot="input-wrapper"`; the native input
keeps its ref, value, validation, and border ownership. The shared geometry
reserves trailing text space for the inset action, including compact Settings
rows. Settings hover/focus on the action highlights the same input surface,
without adding a second border or ring. Callers own action labels, type, disabled
state, and event handlers. Provider API-key fields use the shared slot for their
show/hide buttons; save actions remain outside the input.
In Settings, wrapper widths follow the same value-column cap as plain Inputs and
Selects. Trailing text padding cannot be overridden by compact-row padding;
the action's hit area fits the fixed control height independently of UI density.
Keyboard focus on the action uses the same field fill, without its own ring.

## Multi-line inputs

`Textarea` exposes its material owner as `data-slot="textarea"`: the compound
wrapper in normal/embedded mode, or the native textarea in simple mode. Compound
content uses `data-slot="textarea-input"`; `hasError` marks the surface and adds
`aria-invalid` to its input. Explicit input attributes remain caller-owned.
Simple mode marks its scroll wrapper with `yuri-textarea-simple`.
`styles/settings.css` scopes the shared Settings background, solid hover/focus,
and radius to Settings workspaces. Textarea-only cards and rows omit outer
padding, leaving text/footer insets with the primitive. Focus keeps the interaction
background after hover ends without a ring, outline, or shadow; invalid inputs
retain their stable error indicator.
Other consumers retain the existing primitive material; scrolling, resizing,
sizing, and ref ownership are unchanged.

# File editor navigation

The shared CodeMirror editor keeps find/replace keybindings but excludes the
search package's `gotoLine` binding on both creation and reconfiguration. File
toolbars have no line-number entry or go-to-line action; source-reference
navigation and line-number gutters remain available.

# Compact preview tabs

`SortableTabsStrip variant="compact"` is the ContextPanel preview header recipe:
24px tabs in the window-height-aligned preview header, 12px labels, a neutral selection-token rounded fill,
and no underline or enclosing track. File icons stay visible, with a separate
trailing close button on every closable tab. Selection, horizontal scrolling,
middle-click close and drag reorder retain the shared strip's behavior. Other
tab-strip variants and mobile file navigation remain unchanged.

# Mobile row swipe actions

Row action menus share `MobileActionSheet` from
`mobile/projects/MobileRowActionsSheet.tsx`. It accepts resolved action descriptors
(`id`, icon, localized label, callback, disabled/destructive/separated state) and
owns the `MobileResizableSheet` material, haptic rows and grouping. The local
`MobileRowActionsSheet` builds descriptors from its existing target/callback model;
remote project adapters supply Host-scoped commands. Do not recreate the sheet
rows or bypass their disabled state in feature-local markup. Project menus retain
one divider before destructive Close; session/folder groups use the normal row
dividers. Command execution, availability and error state belong to the caller.

`useMobileSwipeActions.ts` and `MobileSwipeActionRail.tsx` own the homepage session and Assistant contact trailing
two-action rail and gesture controller. Touch/pen intent locks after 10px; vertical
intent yields to scrolling, horizontal movement clamps to the measured rail width,
and release snaps at 35%. Mouse drags and long holds never reveal actions. A shared
reveal event closes other rows; cancelled gestures restore their starting offset.
Consumers retain their own foreground content and business actions. Pointer moves
only update the active row, read geometry once at gesture start, and add no requests.
Session reorder disables swipe through the existing drag context.

# Desktop picker dialogs

Desktop compact search/list surfaces use `DialogContent presentation="picker"`.
This opt-in owns the global-search glass recipe, shared theme-token scrim, top-offset
position, radius and viewport bound. Ordinary `DialogContent` remains unchanged
for confirmations, editors, Settings forms, permission flows and content viewers.
Do not apply picker geometry globally or remove warnings needed to decide safely.

`picker-dialog.css` owns `yuri-picker-backdrop`: 55% of `--surface-overlay`,
fading over 180ms (disabled under reduced motion). All picker dialogs, including
desktop global search, use this same scrim rather than local transparent overrides.
Ordinary dialogs and mobile sheet/page backdrops retain their existing recipes.

The add-project directory picker additionally uses a 180ms fade and 320ms scale
transition from 6% size. Pointer requests carry the trigger's viewport center
through `sessionEvents` and `SessionDialogs`; the
picker maps it to its shared centered/10vh geometry as the transform origin.
Keyboard/programmatic requests clear the origin and fade in place. Reduced motion
disables both transitions. Mobile sheets and other picker popup animations are unchanged.

Picker dialogs omit the corner close button by default. Escape, backdrop dismissal
and any existing Cancel action remain the exit paths, subject to the owner's
pending-action guards. Ordinary dialogs and mobile sheets keep their existing
close controls. `showCloseButton` remains an explicit override. Picker headers
use the normal content inset on the right; only an explicit close button reserves
the extra end space through `--yuri-picker-header-end-inset`.

`picker-dialog.css` owns the shared `yuri-picker-header`, `-title`, `-search`,
`-list`, `-row`, `-label`, `-meta`, `-footer`, `-section` and `-section-title`
classes. These are scoped under the picker surface, so shared mobile/page bodies
can retain their own geometry. The default desktop width is 42rem (global search
retains its wider excerpt layout), top offset 10vh, and maximum height the smaller
of 42rem and 80dvh. Header/search/footer and row content align at 24px; the list's
8px outer inset plus 16px row inset creates the same content edge. List wrappers
stay transparent, without independent fills, decorative borders or shadows.

Titles and primary list labels use 13px / 20px, metadata and group headings
11px / 17px, group gaps 12px and row gaps 2px at the default root size. Existing
compact single-line directory/global-search labels may use 12px. Keep only
necessary controls and feedback; omit repetitive subtitles, decorative title
icons, Actions headings and help cards. Keep creation semantics, errors,
destructive consequences and permissions explicit. Pin search/actions outside
the list scroll region, allow toolbar wrapping, and preserve independent action
targets. Width changes must not shift the text alignment or clip rounded edges.

Shortcut hints use `Kbd variant="hint"` or `ShortcutKbd variant="hint"`: the
same 14px-high, 10px, neutral borderless badges as sidebar/global search.
`ShortcutKbd` renders Command/Enter/arrows with the shared sprite `Icon` in hint
mode, retaining accessible key names; Ctrl and ordinary letters stay text.
Platform and remapped bindings remain authoritative. Default shortcut editors
and keycap tone contracts are unchanged. Mobile keeps its existing sheet/page/dialog
owner and touch sizing rather than inheriting this desktop presentation.

The picker presentation covers global search, directory selection, timeline,
GitHub Issue/PR and association selection, stashes, archived-session browsing,
and keyboard-shortcut help. Focused tests cover the shared real portal, selection
and hint rendering; visual checks must additionally cover production CSS in
light/dark and a narrow window. Component/source checks alone cannot prove glass,
alignment, scrollbar geometry or packaged-runtime behavior.

Keyboard help's five ordered sections and 41 entries live in the environment-free
`src/lib/help-shortcuts-core.ts`, shared with the NSH desktop help Dialog. The
action catalog remains the only default-key/alias source; help also resolves the
current leader remap. Web keeps its existing VS Code row exclusion, mobile/default
presentation, picker surface and read-only interaction. `help-shortcuts-core.test.ts`
guards the complete catalog and `HelpDialog.catalog.test.tsx` checks the actual
Web consumer; native support labels do not filter Web help or replace its UI.

# Anchored popup surfaces

`TooltipContent` accepts the underlying Positioner's optional `anchor` for
controlled, triggerless hints. Catalog rows keep their DOM stable and mount a
tooltip only after the active row's delay, anchoring to that existing element;
inactive rows must not instantiate floating roots or trigger-position observers.
Ordinary trigger-based tooltips retain their existing behavior.

`TooltipContent.positionerClassName` scopes the outer positioning layer separately
from popup content styling. Its default remains `z-50`; the directory picker's
error hints use `z-[70]` so they remain above the mobile sheet's `z-[60]` layer.
Changing the content's z-index alone cannot escape that outer stacking context.

Menus (including submenus and context menus), desktop Select, Changed files,
status overlays and device connections use
`yuri-mobile-overlay-surface yuri-popup-surface`. The base owns blur/saturation;
the modifier owns the shared translucent fill, foreground, fine edge and short
shadow through `--yuri-popup-fill`, `--yuri-popup-edge` and `--yuri-popup-shadow`
in `styles/mobile.css`. The fill uses 50% of the theme elevated surface for
readability, independently of picker-dialog translucency; popup shadows are
deliberately shorter and lighter. When `data-yuri-vibrancy` marks an Electron
macOS window, every popup surface uses the solid theme elevated fill so sidebar
text cannot bleed through. The material gate does not additionally depend on
device-class initialization; blur, rim and shadow remain unchanged. Theme
surface colors remain authoritative. Avoid default inline opaque backgrounds
or copied shadow utilities on popup roots. Explicit caller styles still win.

Only the outer popup paints material. Scrolling lists and static rows stay
transparent; existing hover/selected states remain interactive tokens. Headers,
file-row boundaries (including virtual rows) and menu/Select separators use
`--yuri-popup-divider` and `--yuri-popup-divider-width`: a half-pixel hairline,
weaker than the outer rim, mixed from theme foreground rather than opaque
`surface.subtle`. Tool-card lists outside popups keep their existing dividers. Keep
positioning, portals, collision handling, focus, dismissal and scroll ownership
with their existing primitives. Mobile Select keeps its sheet material and
transparent inner content; inline work status stays material-free. Tooltips and
ordinary dialogs retain their separate recipes. Reduced-transparency mode uses
opaque elevated fill and disables blur in both themes while preserving the edge.

# Command palette subscriptions

The memoized CommandPalette observes session rows/status only while open or while
its exit animation retains results. After `onOpenChangeComplete(false)`, its
selectors return stable inactive values. Reopening reads the current catalog.
The page presentation keeps its existing search and focus behavior.
Native IME header mirroring excludes headers containing input, textarea, select,
or editable content. The mirror is a button/link tap-replay surface, not an input
owner, and cloning the search header also drops its ancestor-scoped geometry.
Search keeps its live header, focus and shared glass styling throughout keyboard
transitions; returning to a non-editable conversation header restores mirroring.
`mobile/nativeImeHeader.test.ts` covers exclusion, stale mirror acknowledgments,
search/back transitions, unrelated DOM updates and ordinary button tap replay.
`CommandPalette.mobile.test.tsx` covers 50 closed-catalog updates with zero commits
and the existing mobile search/navigation behavior.

Conversation readiness does not wait for project file searches. Cold file queries
show a local pending status while indexed conversation results remain visible and
keyboard-selectable; they never gate the entire palette or trigger a premature
empty-results state. GUI commands consume the startup provider's live contributions
only; opening or typing in the palette does not request GUI plugin loading.
Title/content snapshots start before directory file searches; files become enabled
after both initial snapshots settle (success or error). Typing a different query
or closing disables and explicitly cancels the three exact Query keys immediately,
without waiting for the debounce or exit animation. Exit retention preserves cached
rows, not active polling or obsolete network work.

Title and content matches merge into one row per session, retaining the newest
matching content message for its snippet and navigation target. The five-row
preview and “show more” count operate on these unique sessions. Content search
limits are applied by the Host after session deduplication; expansion reveals the
already fetched results rather than requesting another server page.
The default **All** filter renders individual results in one flat relevance order,
including GUI plugin commands. `lib/search/commandPaletteRank.ts` reuses the mention
title tiers (exact, prefix, substring, fuzzy); descriptions, paths and content
snippets provide lower-priority scores. Already-recalled authoritative hits are
never discarded by this presentation pass. Equal scores preserve source order,
including the session source's recency order. Empty queries keep recent chats first.
Pinned filter buttons below the input select All, Chat, Files, Projects, Commands
or Settings; Commands includes plugin commands. They preserve the query, existing
search scope and Query observers, so filtering starts no new requests.
Desktop filters use the shared extra-small button size, with the first label
aligned to the input and result text inset; mobile retains its touch-sized buttons.
Unmodified Left/Right arrows cycle these filters with wraparound and retain input
focus; IME composition and modified arrows keep their normal editing behavior.
Desktop shows the two arrow keycaps immediately after the filters using
the same `Kbd variant="hint"` as conversation rows, followed by a localized
“Switch” label. The first nine selectable rows in the current
filtered, mixed display order use Command+1–9 on macOS and Ctrl+1–9 elsewhere.
Every result type and category expansion row participates; changing filters or
expanding results recomputes numbering. Numeric shortcuts and click/Enter share
the same selection actions. Pending searches, IME and repeated keydowns cannot
activate a numeric result. Mobile omits these hints and numeric bindings.
Each source retains its five-row search preview and a category-labelled expansion row. Counts
refer to loaded, deduplicated results, not an estimated total. Local categories
remain usable while remote searches are pending; loading/errors only appear in
applicable filters. Selection is controlled by result identity so late file hits
cannot steal an active keyboard selection; changing query or category resets it.
Each row displays a localized date and time beside its title: the matching
message's creation time for content hits, otherwise the session's update time
(falling back to creation time). Missing or invalid timestamps stay hidden.
The project column reuses `ProjectIconImage` for custom uploads and automatically
discovered site icons beside the project name, including nested-project and
worktree ownership. Missing, loading or failed images retain the name-only fallback.

Global-search layout is scoped by `data-global-search` in `command-palette.css`,
including contributed plugin commands; shared Command primitives are unchanged.
Groups have 12px separation, items have 2px separation, and headings leave 4px
before their first item (at the default root size). Compact results use 12px
labels and 11px descriptions; conversation rows use a 13px title, adjacent 10px
timestamp, and a 12px/two-line snippet with source whitespace collapsed. Project
and numeric-shortcut columns share the row's vertical center independently of
title/snippet length. Mobile
keeps 44px minimum hit targets and omits the numeric-shortcut column. Existing
theme colors, selection tokens and the desktop glass surface remain authoritative.
Conversation rows use 8px vertical padding. Sidebar and global-search shortcuts
share `Kbd variant="hint"`: 14px-high neutral pills, 10px sans-serif labels, a 6%
surface-foreground fill and muted-foreground/65 text. Search reserves platform-sized
columns without overriding this shared recipe. Ordinary `Kbd`/`ShortcutKbd`
rendering remains unchanged.

File search uses the runtime Files API backed by the official V2 client, not
the removed `/api/find/file` route. Confirmed missing locations are skipped
without removing saved projects. File search failures retain other
results and show a compact muted status, not a red directory-list alert.
Arrow-key navigation loops across the first and last selectable result via cmdk's
`loop` contract, including mobile hardware keyboards.

Conversation search spans all currently added projects, not only the active one.
Before ranking, preview counts and navigation, merged title/content results must
resolve to a current project through `resolveProjectForSessionDirectory`, including
registered worktrees. Unadded/closed projects and unresolved directories are
excluded; recent-session previews apply ownership before their local row limit.
Project closure also filters frozen keyboard-navigation snapshots immediately,
and session activation rechecks current project/worktree state to reject stale rows.
Readding a project can reuse retained search data; filtering does not delete Host
index entries or sessions. This shared policy applies to desktop/web, VS Code and
hosted/native mobile. Commands consume registered contributions,
and project matches filter the existing project list only (no project discovery
or directory scanning). File search requires a selected conversation with a known
`currentSessionDirectory` belonging to a saved project. It makes exactly one
runtime FilesAPI request for that conversation's working directory, capped at ten
candidates. A worktree conversation searches only that worktree, never its main
checkout or sibling worktrees. No selected conversation, unresolved directory or
unknown project means no file search, even if a draft, active project or global
fallback directory exists. Search adds no scope picker or index-status banner.
Its Query key includes transport, generation, the normalized working directory
and query; changing focus cancels the old scoped read and hides its cached rows.
Input changes and closing also cancel in-flight reads and reject late results.
FilesAPI forwards its optional signal
to the official client over direct/relay transports. VS Code cancels the webview
bridge wait and ignores late replies; already-dispatched extension scans may finish.
Results deduplicate by absolute path and retain their source directory for file
opening. Failure remains a Query error and never widens scope to other projects.
`CommandPalette.mobile.test.tsx` guards one request with 51 saved projects,
zero requests without focus/project, worktree isolation, focus-change cancellation
and global conversation/project results when file search is skipped.

# Render-count verification

`scripts/perf/component-render-probe.mjs` counts actual component function/class
render calls by transforming the React development response in memory. It does not
infer work from retained Fiber flags. `componentRenderCounter.test.ts` checks leaf
and nested memo bailouts, real updates, StrictMode, forwardRef and class calls.
See `scripts/perf/README.md` for the counting window, region attribution and limits.

# Toast mutation isolation

`sonner.tsx` owns a layout-neutral `display: contents` host around its Sonner
instance. Shadow/tabindex repair observes only that host, never `document.body`.
New toast subtrees are scanned locally; attribute repair touches only the
affected toast and compares normalized CSS declarations before writing so its
own observer notifications settle. Theme changes repin only this host's toasts.
`sonner.performance.test.tsx` replays 50 unrelated transcript scroll/stream DOM
updates with zero toast scans and covers style replacement and theme changes.

# Image loading

`WorkspaceSurface` owns the shared rounded material used by ContextPanel and global
GUI plugin pages. It renders one clipped, isolated section with the theme-aware
background and a non-interactive inset-ring overlay above its content. Opaque
plugin toolbars and iframes must not cover the ring. Outer spacing, navigation,
resizing and content lifetimes remain with callers; the surface owns no state.

Decoded transcript images use `width: fit-content` on the frame and an in-flow, auto-width image at the reserved height. Narrow/portrait images shrink the bubble to their displayed width; wide images clamp to the available column. Pending/error frames retain their placeholder width. The outer height stays constant so width fitting never reintroduces load-time vertical shifts. The browser geometry regression covers portrait, landscape and width-constrained panoramas with the lazy Markdown theme loaded.

Content frame geometry must also constrain the child image: the unlayered rules in `image-loading.css` override the lazy Markdown theme's intrinsic sizing, contain the image in the 160px frame, and clip overflow. Do not add a separate attachment image height such as `h-32`; resource placeholders and decoded images share the frame height. `imageGeometry.chrome.test.ts` loads the real theme after the shared stylesheet and checks both image bounds and the next message's position across loading, loaded and error phases.

Standalone Assistant Markdown image bubbles mark `data-assistant-contact-media` and have no painted outer backing. Inside that scope, decoded images use natural aspect-ratio bounds capped at the reserved frame height. Assistant attachment images and both Markdown presentation wrappers use `--contact-bubble-radius` on the frame and actual image, matching message/card circular corners without tails, including loading and error phases. The frame remains height-stable and centers the image; transparent spare space must not expose a second bubble silhouette. Other conversation surfaces retain their existing radii. Both Markstream and legacy presentation wrappers share these rules and the Chromium geometry regression.

`LoadingImage` owns content-image presentation on desktop and mobile, including direct and Relay connections: reserve a dotted shimmer canvas while a runtime URL is pending and while the browser loads the bytes; reveal the image only on `load` or a successful cached decode (`complete && naturalWidth > 0`). Resource failures and browser `error` stop the animation and show the translated failure state without painting the browser's broken-image glyph. A source/srcSet change resets the image boundary; detached image events cannot reveal the next source.

Resource acquisition, auth, leases, cancellation and retry remain with each caller. Pass `resourceError` from `useResolvedImageResource`; do not collapse a failed source to an indefinite empty-source spinner. `fill` fits existing thumbnail slots. Transcript content images (Markdown and Assistant attachments) pass `contentFrame`: the frame has one fixed height, `--yuri-content-image-height` (10rem), through pending, loaded and error phases, and the image scales inside it with `object-fit: contain`. Loading bytes therefore never change transcript height or move the reader; the image preview owns full-size viewing. Desktop frames are 20rem wide, mobile frames fill the bubble. Widths are absolute and clamped by `max-width: 100%`, because a percentage width inside a shrink-to-fit bubble collapses an image-only bubble to 0px. Legacy Markdown's `[data-md-image-presentation]` uses the same frame. Other unconstrained previews retain the 12rem fallback. File views also show the dotted canvas during resource/auth acquisition; fullscreen and Assistant attachment pending phases use bounded placeholders on both platforms. Image event handlers and preview metadata stay on the actual `img`. The memoized leaf avoids image Hook work during unrelated composer typing.

`ImageLoadingPlaceholder` supplies the shared visual for resource-only and fullscreen loading phases. Its dim dot grid and two drifting, breathing bright-dot regions follow the public AICSS Image Processing preview (`https://aicss.dev/components/image-generation`), with semantic theme tokens and reduced-motion support. Moving radial masks illuminate only the dots, not a solid sweeping band. CSS lives in the components layer so caller sizing/positioning/radius utilities remain authoritative. Legacy DOM Markdown uses the same visual class while its image-interaction owner tracks real `load`/`error` events.

The mobile connection welcome also reuses the `yuri-image-loading` visual class on an `aria-hidden` decorative span, not the status-bearing `ImageLoadingPlaceholder` component. Welcome-specific layout, fading and stronger breathing live in `apps/mobile-welcome.css` (4.2s shared drift, 2.4s opacity cycle from 0.22 to 1); image-loading behavior and timings remain owned here.

`YuriWordmark` uses the bundled canonical sculpted-serif SVG as a current-color mask. Its width accepts CSS lengths so inline sidebar branding scales with text; standalone welcome callers retain numeric pixel sizing. The welcome positions it in a safe-area-aware top-left header, with `YuriLogo` as the central portrait. Regenerate the wordmark through `assets/brand/yuri/build_wordmark.py`, which also synchronizes the UI asset.

Coverage: `LoadingImage.test.tsx`, `markstreamImages.test.tsx`, `MobileFilesSurface.imagePreview.test.tsx`, and the existing attachment/preview contracts. Avatar/provider icons retain their existing icon-specific fallbacks.

`ProviderLogo` and `ModelLogo` paint bundled brand SVGs as a `currentColor`/`bg-foreground`
mask (`YuriWordmark` pattern) instead of `brightness-0` + `dark:invert`. CSS filters on
`<img>` can be dropped by iOS WKWebView inside animated / backdrop-filtered overlays
(mobile usage metadata sheet), leaving black marks invisible on dark surfaces. Missing
provider marks retain the theme-colored stack fallback.

Mobile file-detail images fill the available content width at their natural aspect ratio, including their loading frame; tall images scroll within the sheet. Fullscreen media previews portal to the body above mobile sheets (`z-index: 80`) and join `MobileWindowStack` while open on mobile, suspending the underlying sheet's modal input ownership until the preview closes. `imageGeometry.chrome.test.ts` checks width and fullscreen hit testing; `ToolOutputDialog.preview.test.tsx` checks modal ownership and restoration.

File read/preview failures in `FilesView` (including fullscreen) and `MobileFilesSurface` use `FilePreviewError`: a bounded, theme-aware SVG canvas above the error title and wrapping details, with the caller's retry action when available. Error details remain visible and accessible via `role="alert"`; they do not replace the preview with unstructured red text.

`FilePreviewState` owns the shared geometry for `FilePreviewError` and `GuiPreviewLoading`. The 80px illustration slot is centered horizontally and anchored 64px above the content midpoint. Details start 20px below that slot and scroll independently in the remaining space. Copy length and optional actions never move the illustration; the minimum canvas height is 240px on mobile and desktop.

# Mobile Window Motion

`MobileWindowMotion` publishes its authoritative `isTop` state through the lightweight
`MobileWindowActiveContext` (default true outside mobile windows). Each portaled window
owns this context independently, including windows nested under an inactive window's
React ancestry. File-preview bridges consume it so becoming interactive retriggers
preview registration after an initial inert mount; covering a window releases its
preview lease. Animation frames do not update this context. DOM `inert`/`aria-hidden`
remain the input/accessibility gate, not an observable substitute for this lifecycle.

`MobileResizableSheet.className` forwards overlay-level styling to
`MobileWindowMotion`. Media saving uses an inline fullscreen control rather than
an additional sheet.

`useHeightSnap` is the shared dynamic pixel-height gesture/settlement owner for mobile
sheets and composer textareas. Callers supply semantic snap IDs and measured heights;
the hook captures geometry once per drag, coalesces writes through rAF, restores the
starting position on cancellation/lost capture, and releases capture/animations on
reset or teardown. `useMobileSheetSnap` retains sheet-specific ratios, fit-content
measurement and downward dismissal. `HeightSnapHandle` shares the visual and accessible
separator primitive; each caller supplies its own value range and translated label.
The controller exposes `settling` separately from `dragging`: consumers with their own
autosizing must yield height and max-height ownership until settlement completes.
Interrupted animations are sampled, cancelled, and only then remeasured, so their
fill cannot contaminate dynamic content-height snap points.
Closed `MobileResizableSheet` shells do not provide a dismiss callback, so unrelated
composer edits cannot refresh a hidden sheet's release-handler effect. Animation and
pointer cleanup runs in layout teardown before a removed composer handle returns
height ownership to its parent's autosize effect.

`heightSnapPhysics` owns recent (100ms) release velocity, direction reversal, flick
projection/adjacent-stop selection and bounded overscroll resistance. Motion's mini
animate and spring generator own critically damped WAAPI settlement (576 stiffness,
48 damping); unit-bearing height/translate keyframes use normalized progress velocity
and rest thresholds. Completion commits the final style before autosize resumes;
cancellation removes the effect before remeasurement. Slow movement uses distance; a short deliberate
flick can advance without crossing the midpoint, and a held finger loses momentum.
Cancellation restores the initial point without fling. Settlement inherits velocity
and can be interrupted from its current visible height.

Sheets use `renderMode: 'translate'`: at press the canvas is frozen once at maximum
height plus spring headroom, temporarily positioned absolutely at the overlay's bottom
to avoid flex shrinking/auto-margin displacement. Only its independent CSS `translate`
changes while tracking/settling; MobileWindowMotion retains `transform` for present/dismiss.
The selected CSS height and original positioning return together after settlement.
Fit-content measurement is cached before entering this canvas mode. Snap targets also
respect the overlay's available height (including keyboard insets). Downward flick
dismissal is eligible from the collapsed position; an expanded sheet first collapses
unless the gesture actually reaches the distance-based dismissal region.

`MobileWindowMotion` owns mobile overlay motion. React owns discrete presence and modal state. Interaction frames write only the component-owned scrim and surface `transform` and `opacity` styles.

`begin(operation)` accepts `present` and `dismiss` and returns whether the interaction started. `update(progress)` receives the current operation completion from `0` through `1`: present maps directly to visible progress, dismiss maps to `1 - progress`. `finish(commit | cancel)` resolves through the recipe: present commits visible and cancels hidden; dismiss commits hidden and cancels visible.

Modes are `standard`, `interactive-present`, and `interactive-dismiss`. Each interaction has a generation; stale updates and settlements cannot affect a newer interaction. Settlement reads the latest controlled `open` value after requesting its commit, then converges to the controlled endpoint before unmounting. Callers must pass `open={state}` rather than a bare `open` boolean attribute: a hardcoded true leaves `openRef` true through the post-dismiss reconcile frame, so the sheet briefly re-presents before the parent unmounts.

`onPreviewChange` reports active interactive-present presence in a layout effect, before paint. Feature list gates must include this preview state rather than waiting for controlled `open` (which commits after release/settlement). It reports false on cancellation, interruption or commit completion; progress frames never invoke it. Sessions uses this to render already-loaded rows throughout a drag while keeping closed list derivation disabled.

**Exit presence:** when a dismiss settle reaches the hidden endpoint, Motion calls `onExitComplete` after deactivating presence (portal/children retain through the exit animation when still mounted). Feature shells that must keep last-open body rows (for example Sessions `MobileSessionStatusBar` `sheetPresent`) clear retained UI only from that callback — never a timeout guess. `keepMounted` is a separate contract: a preserved hidden surface leaves the modal stack and stays inert while retaining child state for the next present.

`MobileWindowStack` owns shared modal ordering and body locking for Motion instances. Its first modal saves and locks body overflow; its final modal restores it. Escape, focus trapping, and `aria-modal` apply to the stack top. Lower stack entries receive `aria-hidden` and `inert`. Present previews mount with `aria-hidden` and `inert` and remain outside the stack.

Initial focus uses a separate, visually hidden `tabIndex=-1` anchor inside each surface, never a focusable wrapper around its controls. iOS WebKit can retarget taps on a `<details>` menu's buttons to a tabindex-bearing ancestor before `click`, preventing plugin export actions from starting. The anchor preserves non-input initial focus and restoration without making the content shell a touch/focus target. `MobileWindowMotion.focus.test.tsx` guards this DOM boundary; real iOS touch validation is still required.

The top browser Motion window bounds its portal scrim to `visualViewport.offsetTop`
and `visualViewport.height`, including Safari keyboard resize and viewport panning.
`useEventListener` owns resize/scroll subscriptions only while that window is top;
unchanged geometry performs no style writes and events do not rerender input children.
Focus, marked text, sheet snap selection and field scroll ownership remain untouched.
Missing visualViewport retains the normal fixed viewport. Capacitor remains exclusively
owned by its existing native keyboard-inset CSS; it does not apply browser geometry as
a second inset. The field form in `NewWorktreeDialog` omits decorative scroll fades so
a focused input/caret is not faded at the keyboard-bounded scroll edge.
Its private `MobileWorktreeFields` reveals only the current input when it exceeds
the field scroller's bounds (including 8px breathing room). Focus, container resize
and visualViewport resize/scroll coalesce into one rAF; an already visible input
causes no scroll. Native `scrollIntoView(nearest, instant)` and input scroll margins
own the reveal, without direct scrollTop writes, refocusing or draft changes.
It runs only while open and stack-top, cancels pending work on deactivation/unmount,
and does not subscribe to typing or manual field-scroller scroll events. Unfocused
fields can remain partially outside the scroller; this is not a whole-form fit rule.
P06's complete UIKit / iOS Safari evidence and remaining platform limits are recorded
in `packages/nsh/PROJECTS-SESSION-ACCEPTANCE.md` batches K–M; component tests alone do not
certify every Motion consumer, pinch zoom, floating keyboard or mobile runtime.

Frame updates use one rAF to coalesce input. Interaction frames avoid root CSS variables, global DOM queries, layout reads, and per-frame React state. Sheet layouts derive from their edge. WAAPI owns settling, interruption reads the active computed progress, and reduced-motion completes synchronously. Capacitor Motion surfaces disable keyboard-bottom transitions while interaction or settlement owns compositor opacity.

`MobileWindowMotionRegistry` provides a narrow imperative bridge and unregisters controllers when the component unmounts or its id changes. Controller lifetime remains independent from surface presence. The mobile Sessions sheet is the current first caller and starts its header-swipe preview with `begin('present')`. Future callers may use the registry for local gesture ownership while keeping presence, modal state, and visual-frame ownership inside `MobileWindowMotion`.

The Sessions sheet exposes a dedicated top resize handle with `72dvh` and `98dvh` snap points. Drag frames write translate directly to the frozen motion surface through `surfaceElementRef`, one write per animation frame; release uses the shared velocity-aware spring and commits the selected snap class. The handle is reserved from the sheet-wide dismiss recognizer, while list-edge downward gestures continue to own dismissal. Current-turn and direct single-file mobile diffs open at `98dvh` and use the same resize behavior. Both presentations include backdrop dismissal and an explicit close action.

`MobileWindowMotion` owns dismissal configuration through `dismissGesture`: its default is disabled, `true` uses defaults, and an object enables the gesture with option overrides. Motion attaches the hook to its real surface, which supplies the edge and surface travel size. The hook supports `top`, `bottom`, `left`, and `right`; it locks scroll ownership at `touchstart` by choosing the nearest target-axis scrollable ancestor. A matching selector provides a checked fallback within the surface. A target scroll container keeps the full gesture when the touch starts away from its matching edge, and a later touch starting at that edge becomes eligible for dismissal. Commit distance uses its own ratio and min/max bounds, separate from the surface-sized animation travel; a correctly directed fling can also commit.

`MobileSheetSnap` owns the shared `72dvh` / `98dvh` resize gesture and accessible drag handle used by Sessions and mobile diffs. The handle can move upward to `98dvh` and continuously downward to zero; releasing below the dismissal threshold closes the owning sheet, while shorter gestures settle to the nearest snap.

`MobileResizableSheet` is the product-level assembly for standard resizable mobile sheets. It combines `MobileWindowMotion`, `MobileSheetSnapHandle`, the shared snap lifecycle, an optional title, leading action, trailing actions, and the close action. Feature pickers that need closed-work isolation keep a stable shell outside the sheet and mount the expensive list body only under MobileWindowMotion presence (exit-safe retain until exit completes) — see chat `MobileModelPickerPanel` / `TimelineDialog` ownership. Picker sheets with neither a title nor leading/trailing chrome omit the header row entirely and move directly from the resize handle into content; nested picker views may retain the borderless navigation row for their leading back action. Current-turn and direct single-file diff viewers retain contextual titles. Files, Changes, MCP, iPad Settings, About/Update, and project-edit sheets use this assembly instead of a local overlay. Sessions uses the same lower-level pieces with its custom action-only header and interactive-present bridge. Bottom sheets reserve their physical bottom safe area at the shared surface level; children provide only feature-specific spacing.

`iframeSheetOverscroll` bridges downward pans that begin at the top of a same-origin HTML iframe onto the owning sheet's motion controller. It reads stable `screenX` / `screenY` for distance and velocity (iframe `clientY` shifts when the surface translates under a fixed finger). Motion travel and commit distance are snapshotted once at gesture start; move frames never re-measure geometry. Pending gestures hold a null controller until `begin('dismiss')` succeeds, then snapshot that single controller for the lifetime. Missing tracked end-touch cancels (never commits stale distance). Element checks use the iframe document's own `defaultView` constructors — outer-global `instanceof Element` fails across realms. `collectIframeScrollChain` / `isIframeScrollChainAtTop` require the full scrollable ancestor chain (target → root via `getIframeDocumentScroller`) at top before handoff. Form fields, `contenteditable` (including `plaintext-only`), and `[data-mobile-sheet-no-dismiss]` never arm dismiss. Fullscreen HTML preview has no owning `data-yuri-motion-id`, so binding must not inject overscroll CSS; only the style node created by that binding is removed on detach. Cross-origin iframe access stays failure-safe without widening sandbox.

Mobile file detail, inline plugin previews and standalone plugin panels use `data-mobile-edge-to-edge-preview="true"`. All file types, including file-detail source views, extend to the physical bottom. HTML additionally retains `data-mobile-html-preview="true"` (sheet) or `data-mobile-html-fullscreen="true"` (fullscreen). Active non-inert sheets that host a preview marker zero surface bottom padding. Other sheets keep the default safe pad. Home-indicator `body::after` hide uses structural `:has(...)` on those markers instead of a root class toggle.

The sheet header is one row: `leading | title | trailing/actions | close`. Every sheet-level action, including copy, refresh, add, save, and show-hidden controls, belongs between the title and close action. A child that hides its own header must use the host `trailing` prop or `MobileSheetHeaderActions`; it must not leave a separate right-aligned icon or action row below the shared header. Sheet-hosted `DiffView` passes `toolbarInSheetHeader` to place its expand, full-file, wrap, and layout controls in that same slot, using icon-only actions and a truncating title; standalone diff views retain their content toolbar. Picker sheets may continue to omit the entire header when they have no title, leading, or trailing chrome.

The sheet body is a flex column (`flex min-h-0 flex-1 flex-col overflow-hidden`) so children can own a bounded scroll region with `flex-1 min-h-0`. It also sets `data-page-scroll-lock="true"` so the global mobile-pointer rewrite that turns `.overflow-hidden` into `overflow-y: auto` does not promote the body itself into a competing scroll container. Searchable pickers (model, agent, draft project, draft branch) must pin their search field outside the scroll region and put the list in `ScrollableOverlay` (or an equivalent `overflow-y-auto` with the `.overlay-scrollbar-container` class) so the dismiss gesture can recognize the list edge. Sessions already follows this pattern; these picker sheets match it.

Dismiss-gesture ownership never arms on form fields (`input` / `textarea` / `select` / `contenteditable`) or on `[data-mobile-sheet-no-dismiss]`. Those controls sit outside the list scroller as pinned chrome; treating their touchstart as a potential dismiss lets tiny finger jitter call `preventDefault` on touchmove and steals focus/keyboard on Android WebView. Initial modal focus lands on the motion surface with `preventScroll`, not the first FOCUSABLE control (which would otherwise hit the snap handle or steal search focus on stack churn).

Searchable picker sheets must not treat a click as activation unless the same control also received the matching `pointerdown`. Focusing a pinned search field raises the IME, which lifts the keyboard-inset overlay; the leftover click can land on the scrim or a model row and close the sheet or pick a model. `matchingPress.ts` owns that contract: overlay scrims use `markOverlayScrimPress` / `shouldCommitOverlayScrimDismiss`, and picker rows consume `markMatchingPress` before their `onClick`. Search fields in these sheets use `type="text"` plus `inputMode="search"` so WebKit does not inject a native search-clear control. Let the browser own tap-to-focus: never focus the search field in `pointerup`. Touch compatibility `mousedown` follows `pointerup`; opening the IME early moves the surface before that mouse event is hit-tested, so its default action can immediately blur the input. A click guard cannot prevent that earlier focus loss. This applies to the shared model picker in chat, Settings, and scheduled tasks.

Feature-owned sheets may pass `bodyClassName` to `MobileResizableSheet` for local body layout treatment. When present, the shared header remains borderless and owns its close action and accessibility contract; features must not restore an empty picker header or picker-title divider locally. The shared sheet always owns its motion and resize handle.
`showCloseButton` defaults to true; mobile plugin windows and the top-level Plugins catalog opt out while retaining their title, resize handle, scrim dismissal and Android Back behavior. Plugin content windows opt into `compactHeader`, using a 16px resize-handle strip and a 24px small-text title row; the outer catalog and other sheets keep their existing header dimensions.

`MobileResizableSheet` also supports `fitContent` for compact action surfaces. In that mode the collapsed sheet follows its content height up to the shared `72dvh` maximum instead of being forced to that height. The header uses a tighter row (`min-h-9` / `pb-1`) and the body stays content-sized so short menus do not read as top-heavy. Dragging still expands toward `98dvh`, at which point the body grows with `flex-1`; downward dismissal uses the measured content-sized collapsed height as its threshold baseline.

`keepMounted` preserves a surface's Portal subtree after its first presentation. A preserved hidden surface leaves the modal stack, releases body and focus ownership, becomes inert and invisible, and retains child state and native scroll position for its next presentation. The mobile Sessions window enables this behavior while continuing to refresh authoritative session snapshots when opened.

`MobileOverlayPanel` keeps its scrollable body as the default. Its opt-in `containedBody` mode provides a fixed, overflow-contained body for children that own their internal scroll region. Scheduled-task route editing uses `MobileResizableSheet`, initially expanded to `98dvh` from every entry point; the workspace places its menu actions in `MobileSheetHeaderActions` without a back arrow, the shared header owns closing, and its editor owns the bounded form scroller.

`MobileDetailNavigation` owns the safe-area-aware header used by mobile secondary pages. It provides the shared back action, centered title grid, optional trailing content, sticky behavior, and the Apple-style one-rem physical screen-edge inset for circular navigation actions. Settings detail pages, scheduled-task editing, session chat, and Assistant conversations use this component instead of recreating the navigation markup or its sizing locally. Conversation surfaces (session chat and Assistant) pass `overlay` so the shared translucent gradient sits over the transcript; settings and editor pages stay in-flow. The shared content node owns its horizontal inset and safe-area calculation; parent layouts must not redefine the inset or apply a compensating negative margin to the header.

`MobileTabPageHeader` owns the safe-area-aware sticky large title for mobile root tabs. It binds to the nearest root tab or Settings scroller and writes scroll progress to `--yuri-mobile-title-collapse` for compositor-only effects (`transform` / `opacity`). The sticky layout box is constant (compact chrome: `safe-area + 0.75rem` plus the 40px action row); expanded clearance is a static in-flow spacer that scrolls away natively, so collapse never rewrites padding/height mid-scroll (that feedback loop is the bounce source). The title scales from `2rem` to `1.25rem` (`transform-origin: left center`) so the compact end holds weight next to the glass actions; the inner row translates from the expanded offset into the compact chrome. The scroll container zeros its own top padding so the header owns that spacing.

Phone headers use the shared `Button` `mobileGlass` variant with the `mobileIcon` size for neutral floating circular actions such as back, search, and trailing navigation. These controls must consume that pair instead of rebuilding their background, blur, theme-specific elevation, focus ring, or 40px geometry locally. Both themes use translucent glass with backdrop blur/saturation, a luminous rim, directional reflection, and theme-scaled outside elevation. Primary create/save actions use the default neutral solid variant with `mobileIcon` size, with the root-header add exception documented above.

`mobileBackNavigation.ts` owns phone push-depth coordination across Chat/Assistant/instance-management secondary pages, Settings details, scheduled-task editing, file details, and Changes diffs. Route owners retain their authoritative local state and explicitly register the compositor surface and, for root pushes, its matching underlay; the driver must never infer either layer by querying an ancestor DOM subtree. Native progress never enters React state: iOS edge-pan samples are reduced through a 60 Hz native display link, Android Predictive Back supplies system progress, and the web driver coalesces both to one transform-only write per animation frame. Static compositor styles are applied once at begin. Settlement copies its visual endpoint into the inline transform before cancelling fill-forwards, synchronously commits a successful route pop while the outgoing surface remains off-screen, and only then clears presentation styles; WebKit must never expose the outgoing page at x=0 between animation completion and React route mutation. The phone tab shell keeps both its active tab and dock mounted and inert behind the opaque secondary surface, so an interactive pop reveals a complete previous-page snapshot without late mounting or background input. The dock remains a separate viewport-fixed retained layer outside the transformed content underlay; putting it below a transformed ancestor changes WebKit's fixed-position containing block by the native bottom safe-area height and causes a completion bounce. Flow-mobile Settings and Scheduled Tasks each keep one persistent, viewport-bounded root layer mounted across root/detail stages and place the detail in a separate viewport-bounded push surface. These roots own their vertical scroll and clip horizontal overflow. Secondary enter is instant with no push transform. Interactive pop translates only the top outgoing surface; the registered underlay stays put with no left parallax. A long tab document or an ancestor that also contains the outgoing surface must never become the compositor underlay. Modal and sheet dismissal remains a separate overlay contract; only a push detail inside an overlay can pre-empt its owner's close action. Hosted H5 installs no touch recognizer and mirrors registered push depth into `history.pushState`; `popstate` dispatches through the same top-route callback while root browser navigation remains browser-owned.

The flow-mobile Settings root and its push-detail surface both use
`--surface-background`; grouped cards provide the local material contrast.

`mobileLongPress.ts` owns the shared 500ms touch/pen hold controller for mobile action surfaces. It cancels on movement beyond 12px, release, or pointer cancellation and consumes the click generated by a completed hold. Both dedicated mobile sessions and the responsive Web sessions sheet use this controller.

## Dialog Surfaces

Global content search refreshes from the Host while open. The first navigation key snapshots title and message rows for the current query and runtime so background indexing cannot move keyboard targets. Editing the query or reopening the palette releases that snapshot. Failed content refreshes retain the last successful results and expose the error separately.

Global search previews at most five rows per non-empty result group while a query is present. Each overflowing group offers a keyboard-selectable “Show more” row; explicit expansion is scoped to the current query and directory and resets when the palette is reopened. Conversation title and body hits share one group: a body hit includes the highlighted title and excerpt, replacing the duplicate title-only row. Multiple matching messages remain individually navigable. Desktop numeric shortcuts follow the visible combined rows and reveal the message when present. Empty groups render no heading. The empty-query recent-session view retains its existing limit.

Desktop search has a responsive 56rem maximum width for excerpts. Native/hosted mobile uses the independent search push page; responsive web uses an opaque full-viewport search surface with the same back header, safe-area padding and keyboard viewport sizing. Neither mobile presentation uses the compact floating search card.

The mobile search header sizes its back column from the actual button and leaves
an explicit 8px gap before the field. The field uses the same density-scaled
2.5rem height as `Button mobileIcon`, retaining the 36px touch minimum.

`DialogContent` owns both the popup surface and its backdrop. Feature-specific dialog treatments pass popup styling through `className` and backdrop styling through `overlayClassName`; this keeps blur and dimming local to the owning dialog without changing every modal surface.

Both the popup and backdrop are Electron `app-region-no-drag` regions. Portal rendering and z-index alone do not exclude the underlying window drag region; dialogs opened over draggable startup/upgrade screens must retain pointer interaction across the entire popup and backdrop.

### Settings picker focus verification

Chat-hosted pickers additionally exercise the production composer pointer capture policy: only DOM-contained toolbar actions may prevent default focus. A portaled search input must keep its pointerdown uncancelled even though React capture propagates to ChatInput. Page/sheet/dialog-only hosts cannot establish this contract.

`MobileWindowMotion.focus.test.tsx` mounts the real model picker, resizable sheet, and Base UI Dialog in happy-dom and checks `document.activeElement` after search activation across page, parent-sheet, and dialog hosts. Touch-order cases additionally require that `pointerup` does not focus early, before the browser's compatibility `mousedown` default action. Real Chromium touch dispatch with a focus-driven keyboard inset reproduces the pre-fix sequence `pointerup → focusin(INPUT) → mousedown(DIV) → focusout(INPUT)`; happy-dom alone does not perform geometry hit-testing or native mouse defaults.

`MobileWindowMotion.android-focus.test.tsx` mounts the exported production `useNativeMobileChrome` hook with the real model panel and sheet. Capacitor SDK calls and unrelated startup server requests are mocked at their boundaries. Native `yuri:ime-state` payloads exercise both open and already-closed keyboard paths: settings/search fields retain DOM focus, keyboard geometry clears, and composer dismissal still blurs its own text field. The test also covers input touch jitter and native-close ordering. Run from the repository root:

```sh
bunx vitest run --project @yuriai/ui packages/ui/src/components/ui/MobileWindowMotion.focus.test.tsx packages/ui/src/components/ui/MobileWindowMotion.android-focus.test.tsx
```

The Android native-viewport experiment also verifies zero secondary CSS inset or
composer transform for changing IME heights. Native start-hide never blurs;
cancelled Back settling open retains focus. These tests establish DOM focus
behavior for supplied event sequences in happy-dom. Physical Android keyboard
presentation and native event arrival order require device validation; full
Settings data loading and deployed-bundle parity remain separate runtime checks.

## Grouped Cards

The normative visual and structural contract is
[`../sections/shared/SETTINGS_DESIGN_SPEC.md`](../sections/shared/SETTINGS_DESIGN_SPEC.md).
All Settings pages, including desktop and mobile secondary pages, must follow
that specification rather than defining feature-local typography or spacing.

`grouped-card.styles.ts` exports compatibility aliases for compact editor surfaces that map directly to the Settings group, row, divider, and section-label classes. Scheduled Tasks uses those aliases inside the same `yuri-settings-workspace` / `yuri-settings-page-content` form root, so its cards and controls consume the identical Settings tokens instead of maintaining a second visual recipe. The phone tab panel owns the shared page gutter for Scheduled Tasks root controls and the task catalog, so those descendants must not add a second horizontal inset. The in-tab editor is a tab-owned push surface, not a `MobileTabsRoot` secondary page: its overlay stays below the web dock (`z-index: 30`) so the root tabs remain visible and interactive. One inner body owns vertical scrolling and exactly one `--yuri-mobile-page-inline-inset` instead of relying on the retained root underlay's gutter. It keeps the shared detail navigation above that body. The enabled Switch sits beside the editable task title and updates the draft; the header Save icon commits it with the rest of the form, immediately before the overflow menu. Multiple trailing controls are passed as an array so the shared navigation reserves their combined width. There is no editor bottom action bar. Body padding clears the retained web dock; the native iOS dock hides during editing (`tabBarCovered`), leaving only safe-area clearance.

Settings detail pages compose the same grammar through `components/sections/shared/SettingsGroup.tsx`. `SettingsGroup` owns an optional section label and one grouped card; `SettingsField` is the required primitive for a standalone setting, keeping its label and short helper text inside that card. Helper text known to wrap uses `descriptionPlacement="outside"` so the standard smaller gray description sits below the card instead of compressing the label/control columns. `SettingsRow` owns the responsive label/value grid, control alignment, long-text containment, and `data-settings-item` anchor. The components and their `styles/settings.css` layout tokens are shared by desktop and narrow/mobile Settings surfaces. Feature pages must not recreate separate desktop and mobile column markup or depend on DOM-shape selectors for new Settings groups.

Full-row Boolean settings use `SettingsToggleRow`. It owns the standard
label/value alignment with the segmented switch in the right column, the standard row
typography, and pointer/keyboard activation while preventing the nested
switch from toggling twice. A bare `SettingsSwitch` remains appropriate when it is
only the right-column control of a true label/value `SettingsRow`.

`components/sections/shared/SettingsSwitch.tsx` owns the localized Off / On
Boolean choice, using Base UI RadioGroup and shared Buttons. Its muted track and
`yuri-segmented-selected-pill` reuse existing theme materials; disabled state,
arrow navigation and explicit-value activation are shared across runtimes.
The general-purpose `Checkbox` outside Settings retains its existing appearance.

`SettingsRow` marks its right column with `data-settings-value`. Editable Settings controls expose semantic `data-slot` values. Select, Input, and NumberInput consume the global `--form-*` design tokens for height, radius, font size, line-height, and helper text inside that value column; they render as right-aligned inline values by default, with a transparent reserved border that becomes visible on hover/focus without moving content. Custom value pickers that do not expose one of those slots add `yuri-settings-inline-value` to their trigger. Page code must not assign a separate visual border, alignment, or geometry contract. Rows are direct children of the grouped card so the card can draw one consistent divider after every non-final row, including conditionally rendered rows. Settings page and section stacks use one `--yuri-settings-section-stack-gap`; wrappers must not add page-specific top margins, padding gaps, or divider gaps between sibling groups.

Desktop Settings navigation preserves the `main` branch's flat sidebar recipe instead of consuming mobile navigation-card styling: 32px rows, 8px horizontal insets, compact row spacing, sidebar surface color, and semantic selected/hover states remain owned by `SettingsView`. Mobile navigation continues to use `MobileSettingsGroup` and its shared card tokens. Detail rows reserve one right-aligned value column capped by `--yuri-settings-desktop-value-max-width`; the cap includes adjacent reset actions and also applies to fields that stack on mobile. Select and Input may fill that column, while NumberInput remains intrinsic-width and is aligned to its right edge. Feature pages must not add local desktop widths to Select, Input, or NumberInput controls.

The desktop detail pane adds no workspace-level padding. Split collections and page bodies retain their owning layout insets instead of receiving a second outer gutter from the Settings shell.

Settings section labels use normal font weight on every surface. Desktop detail labels use the base UI-label size and line height, while mobile retains the more compact section-label size. Section consumers must not override those responsive title metrics locally.

## Select And Searchable Pickers

This is the required contract for new or revised `Select`, `DropdownMenu`, and searchable popup pickers in shared UI. Follow it instead of inventing local search chrome.

Shared `Select` presents every mobile picker in a headerless `MobileResizableSheet` with `fitContent`. Short lists follow their content height, long lists cap at `72dvh`, and `ScrollableOverlay` owns bounded list scrolling and edge-aware dismissal. Desktop layouts retain the anchored Base UI popup with the shared collision defaults.

### Positioning

- Use shared `SelectContent` and `DropdownMenuContent` / `DropdownMenuSubContent`.
- Keep the shared defaults: `collisionPadding={8}` and `collisionAvoidance={{ side: 'shift', align: 'shift' }}`.
- Override collision props only with a documented product reason. Prefer shifting the popup so it stays fully on-screen near viewport edges rather than flipping off-screen.
- Size searchable popups with viewport-aware max height (`max-h-[var(--available-height)]` or an equivalent `min(...)` clamp). Do not let a long option list grow past the visible viewport.

### Search Field Chrome

Canonical look is the bordered shared `Input` style, not a flat bottom divider.

- Prefer shared `CommandInput` for `Command` / `DropdownMenu` searchable lists. It already matches bordered `Input` chrome.
- Prefer shared `Input` for search headers inside `SelectContent` (for example draft project pickers).
- Wrapper padding for the search row is `p-1.5 pb-1`.
- Dense picker search fields are typically `h-8` with a leading search icon.
- Keep the ring treatment: inset `ring-border/60`, hover subtle surface, focus `interactive-focus-ring`.
- Shared searchable pickers retain their bordered input and search icon. Desktop `CommandPalette` is the intentional global-search exception: its locally scoped `command-palette.css` presents a plain text input and a surface-level focus border. The rounded popup uses shared translucent overlay glass; its backdrop is transparent in both themes so only the panel blurs the page. Dedicated mobile uses `MobileGlobalSearchHost` inside `DedicatedMobileAppProvider`: search is an independent opaque push page with `MobileDetailNavigation`, a pinned search input, and full-height scrollable results, never a Dialog or sheet. The existing UI-store open flag owns presence; the host retains the originating screen inert beneath it and registers both surfaces with `mobileBackNavigation` for header, system, browser-history, and gesture Back. While searching, the native composer and native tab bar are covered. `CommandPalette`'s page presentation shares all search data and selection behavior with desktop. Shared `CommandInput` styling stays unchanged.
- Do not reintroduce the old `border-b border-border/40` search divider as the primary search-field affordance.
- The mobile global-search page uses `CommandInput variant="mobileGlass"`: the same neutral glass fill, outside shadow, and 40px capsule height as its back control, without the default input's themed border/focus ring. Its empty query loads the latest 30 instance-wide sessions, showing available cached sessions immediately while that request runs; entering a query switches to title matches.
- Keep search placeholders localized through `locale-ui-patterns`.

### Primitive Selection

| Need | Shared pattern |
|---|---|
| Short fixed option set | `Select` + `SelectItem` |
| Searchable select list | `SelectContent` header + shared `Input` |
| Searchable menu / branch-style picker | `DropdownMenu` + `Command` + `CommandInput` |
| Global command search | `CommandPalette` / shared `Command` |

Reuse the shared primitives above. Do not add one-off popup search components or alternate search visuals for the same interaction.

### Search Ranking

Searchable pickers that filter a long candidate list must rank by relevance, not input order or alphabetical order alone.

- Use shared `scoreByFuzzyQuery` / `rankBranchesForQuery` from `lib/search/fuzzySearch` and `lib/worktrees/branchSearch`.
- Preferred order: exact match → prefix → boundary substring (`/`, `-`, `_`, …) → mid-string substring → fuzzy.
- Do not re-sort matched results with bare `localeCompare` after filtering; that buries exact hits such as `origin/master` under `backup/...-master-...`.
- Secondary keys (local before remote, built-in before custom, project scope) may break score ties only.

### Review Checklist

- Popup stays inside the viewport with the shared collision defaults.
- Search chrome matches bordered `Input` / `CommandInput`, including focus ring.
- Search-border/icon overrides stay confined to the documented global-search exception.
- Long lists scroll inside the popup instead of overflowing the window.
- Matched results are relevance-ranked; exact / prefix hits stay above weak substring or fuzzy noise.
- Nearby searchable pickers (project, branch, model, agent) remain visually consistent.

### Global search

`CommandPalette` chat results use OpenCode `session.list` title search (`search`, root sessions only, newest first). That API matches session titles only; it does not search message bodies. An empty query shows up to nine recent local sessions and does not call the API. A failed title search stays a failure and may still show in-memory title matches; a successful empty page is an authoritative no-match. Chat rows show a highlighted title, a reserved `data-search-summary` line, a truncated project label, and desktop Meta/Control+1–9 shortcuts. Commands, settings, files, and projects keep their previous local scope. The Projects header opens this palette; its menu keeps the local project/session filter. The popup tracks the visual viewport, reserves safe areas, and clamps against the keyboard inset. Loading and error feedback stay separate from a successful empty result.
