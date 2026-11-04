# Yuri shared UI

`@yuriai/ui` owns the shared React surfaces, runtime contracts, state and persistence.
OpenCode package identities and protocols remain third-party contracts.

## File editor toolbar

File controls use the compact floating toolbar in the editor's upper-right corner,
expanded on hover or click. There is no docked-toolbar setting; historical saved
values are ignored. GUI preview controls retain their floating scrollbar inset.

## Diff context loading

The working-tree/staged diff toolbar's full-file switch loads both complete file
versions for expanded, mounted rows and expands unchanged lines in Pierre. Turning
it off restores compact patch context. Background loads retain the mounted preview,
show per-file busy feedback, and expose errors with Retry without hiding the last
snapshot. Request lifetimes depend on file/status/scope/context inputs, never their
own response data; stale completions and timeout handles are cleaned up on change.
Turn snapshots do not offer this switch: partial historical patches must never be
hydrated from the current working tree. Other Pierre consumers remain compact by
default. Covered by `src/components/views/DiffView.fullFiles.test.tsx`.

Single-file previews opened from Git Changes preload complete file versions but
start with unchanged regions collapsed. Pierre's separators expand nearby context
on click; the toolbar's full-file switch expands or collapses all unchanged lines
without fetching those preloaded versions again.

## Default themes

New preferences use Cursor Dark (`cursor-dark`) and Carbonfox Light
(`carbonfox-light`), following the system appearance. Explicit saved selections
remain the base preferences. Enabled GUI theme plugins can temporarily override
the matching variant without changing those preferences or adding Settings choices;
disabling them restores the base theme. The web host fills missing theme preferences with the same
defaults; Web, Mini Chat and mobile cold-start backdrops use Cursor's dark surface
until persisted splash colors or the resolved runtime theme are available.

Cursor Dark's primary text, elevated text, quotes and tool-title base use opaque
`#DEDEDE` instead of translucent gray-white. Secondary text, reasoning, tool
descriptions, accent headings, links, syntax and status colors keep their existing
palettes.

Carbonfox Light's primary text, elevated text, Markdown headings, chat messages
and tool-title base use `#212121`, the RGB inverse of Cursor Dark's `#DEDEDE`.
Secondary text, syntax, links and status colors keep their existing palettes.
All themes now share a primary-text brightness floor: `#212121` in light mode and
`#DEDEDE` in dark mode. `lib/theme/baseTextColors.ts` lifts darker hex colors by
sRGB relative luminance, accounting for text alpha over its surface; brighter
colors retain their palette. This covers surface/elevated text, chat messages,
tool-title bases, bold/italic text and neutral/base-colored Markdown headings.
Secondary text, colored accent headings, code, links and status colors remain
theme-owned. Non-hex custom CSS colors are preserved. Theme resolution and CSS
generation apply the same rule, including custom, embedded and VS Code themes,
so direct color consumers and saved splash colors agree with CSS tokens.

Light-mode UI selection tokens use a shared neutral 7% foreground/background mix
and ordinary foreground, including header and preview controls. Dark-mode UI
selection and raw editor/terminal text-selection palettes stay theme-owned.

## Startup logo geometry

The mobile HTML also includes the canonical 120 × 120 logo inside `#root` before
JavaScript loads. React replaces it on first commit. GUI plugin discovery and
installation wait for the usable shell and a paint opportunity; plugin loading
stays in the background without a global dialog or sheet and never owns the application startup gate.
`OpenCodeUpgradeScreen` supplies a React logo while its first check or runtime
recheck is pending, and a logo Suspense fallback plus error boundary for the app.
This prevents createRoot from replacing static branding with an empty commit.
The web timeout removes its static overlay only after React has committed content;
mini-chat's in-root logo is replaced by React without a destructive timeout.
GUI revision checks, code downloads and installation stay silent, including failures;
diagnostics remain in plugin settings, and file previews own their local loading state.

The full-text index startup screen keeps the same transparent 120 × 120 CSS-pixel logo at the viewport center as the desktop/web splash. Its progress ring is concentric with the logo; percentage, description, and background action occupy an independently scrolling area below it. The fullscreen dialog must not scale during entrance or exit, and progress/text changes must never reposition the logo.

## Add-project directory picker

`DirectoryExplorerDialog` shares the desktop global-search translucent overlay
material. Its directory list is a transparent scrolling region, never a nested
card with its own fill, border or shadow. Header, path field, directory content
and footer use aligned 24px desktop / 16px mobile content insets. Local layout
and compact type live in `src/components/session/directory-explorer-dialog.css`.
Explanatory subtitles and directory headings are omitted. Desktop shortcut hints
use the shared `Kbd variant="hint"` badges with sprite `Icon` keys; macOS shows
Command, other platforms show Ctrl. The footer may wrap without squeezing its
actions. Mobile omits keyboard hints and retains the controlled shared
resizable sheet and 44px folder-navigation targets. Browsing, hidden folders,
quick add, create/add, native folder selection and clone/identity behavior share
the existing handlers across both layouts.

## Assistant avatars

Assistant contact faces use the locally bundled procedural avatar
engine plus an independent non-sphere geometry implementation, with the
existing compact shape-grid/color-swatch picker in Assistant Settings.
They do not replace app branding or coding-agent faces. All shared UI and native
PNG share thumbnails resolve the same saved `avatarSeed` recipe. See
`src/components/assistants/DOCUMENTATION.md#generated-avatars` for persistence,
animation budgets and runtime validation boundaries.
The reusable Motion-backed animation runtime and independent
`bun run test:avatar-performance` browser gate are documented in
`src/lib/assistant-avatar/DOCUMENTATION.md`.

## Sidebar wordmark

The default sidebar brand is `Yuri`. Whenever the name contains `Yuri`,
`SidebarBrandMark` adds a 24px `YuriLogo` portrait before the name and vertically
centers the portrait, wordmark, and custom text.
`SidebarBrandMark` renders the approved
sculpted SVG through `YuriWordmark` for each exact, whitespace-separated `Yuri`
word, including mixed names such as `Yee Yuri`. Its width is cap-height-relative
(2.44814cap = 626.723 / 256), matching the visible artwork to the bold
Syne text's cap height. All words use the
same theme foreground. Without a standalone `Yuri` word, the first word uses the
normal foreground and trailing words use the current theme accent (`Team CODE`
accents `CODE`). Custom text retains its original 1.0625rem size, 700
weight and 0.08em tracking; Syne loads only when custom text is present.
Whitespace-only names hide the slot. Store version 3 migrates exact historical default
names, preserving other custom values and the existing runtime-scoped storage.

## Brand migration

`src/lib/brand-storage-bootstrap.ts` is the single synchronous same-origin
localStorage coordinator. Storage consumers import it before evaluating persisted
state. It copies product-owned old namespaces into Yuri keys, preserving values
byte-for-byte, including malformed values for their owning store's recovery logic.
Encoded runtime/instance identities are opaque. Existing Yuri keys win; old values
are never deleted. Per-key completion markers prevent intentional deletions from
being resurrected. Failed writes/verification remain retryable on reload; bootstrap
fails closed instead of allowing empty stores to overwrite draft metadata.

The same migration owner gates the five IndexedDB databases used for draft blobs,
assistant attachments, durable transcripts, transcript search and diagnostics.
It snapshots old stores in one readonly transaction, preserves key paths/indexes,
and commits copied records plus a completion marker in one new-database transaction.
Existing records win. A failed transaction leaves the source intact and can retry.
An independently initialized Yuri database is authoritative and is not overwritten.
Completed migrations check only their marker; they do not rescan transcript blobs.
Absent old databases are probed with an aborted creation, so fresh installs do not
create old-brand databases. Neither user text nor stored file URLs are rewritten.

This only covers accessible storage in the **same origin**. Electron's old scheme,
a changed web domain, and a new mobile application sandbox require the owning
runtime's explicit export/import or re-pairing flow. Browser migration cannot read
another origin or transfer native Keychain credentials. The shell must finish any
origin import before loading shared UI modules.

### Legacy read exceptions

| Location | Allowed legacy input | Scope / exit condition |
| --- | --- | --- |
| `src/lib/brand-storage-migration.ts` | Two historical full-brand namespaces and product `oc` storage prefixes | Copy-only storage migration; remove no earlier than the next major migration window, after native import acceptance |
| `src/lib/brand-storage-migration*.test.ts` | Old keys, database names and sample user text | Migration regression fixtures; retire with the migrator |
| `src/apps/deepLinks.ts`, `src/lib/connectionPayload.ts`, `src/apps/deepLinks.test.ts` | Two old URI schemes | Read-only link parsing and regression fixtures; generated links use Yuri, pairing validation/expiry/exchange remain unchanged; retire after old-client migration window |
| `src/lib/theme/themes/index.ts` | Two old built-in theme IDs | Resolve existing preference values; retire after preference migration window |
| `src/sync/input-draft-composer-parser.ts` and its test | Two old serialized draft discriminants | Recover existing paste/reference sidecars without rewriting user text; retire with draft migration |
| `src/lib/messages/inlineMessageLinks.ts` | Old skill/agent fragment prefixes | Read stored message links, emit only Yuri fragments; retain while historical transcripts can contain them |
| `src/components/assistants/AssistantConversationSurface.tsx`, `src/components/assistants/contactMessageTime.ts`, `src/queries/assistantContactMessages.ts` | `oc.settle.*` | Hide persisted internal markers without rewriting transcript content; retain while historical transcripts can contain them |

The UI maintainers own these exceptions. Legacy names are not emitted as new keys,
new URLs or new protocol defaults.

## Runtime contract integration

Mobile remote desktop lives in `src/mobile/RemoteDesktopPanel.tsx`, with transient connection/gesture ownership in `src/lib/remote-desktop/` and runtime-scoped capability Query state in `src/queries/remoteDesktopQueries.ts`. It uses the existing runtime fetch/auth/socket path for direct and Relay connections. The connected Host owns capture and input; the client never falls back to its local computer. See `../web/server/lib/remote-desktop/DOCUMENTATION.md` for supported platforms, interaction, resource limits and acceptance gates.

The panel forwards zoom/Fit state transitions to the session connection without React state or per-frame traffic. `connection.ts` sends the bounded `view.zoomed` control only after the Host advertises `ready.zoomQuality: true`; old/non-advertising Hosts receive no unknown commands. The latest state is retained through startup, and connection closure/runtime switching rejects later control. New Hosts prioritize source-resolution detail while zoomed and restore normal adaptive quality on Fit, without reconnecting or resetting local zoom when encoded dimensions change at the same aspect ratio.

The local Electron Settings → Remote instances page includes `RemoteDesktopSettings`, a default-off permission checker. `remoteDesktopSetupQueries.ts` owns native setup Query/mutation state; `lib/desktop.ts` provides the narrow local IPC calls. The mobile panel explains how to enable a disabled Host and does not open a control socket until the Host reports enabled. Permission management never targets a remote runtime or changes the phone's own permissions.

The phone Projects header menu lists saved native-mobile instances directly,
marks the active instance, and switches through the shared mobile connection
controller in one tap. Busy connections disable switching. A failed connection or
password challenge opens the existing instance surface; Settings retains instance
management. With no saved instances, the menu keeps the instance-management entry.

The Host version row in About and the desktop remote-instance menu share
`HostVersionUpdate`. It checks `/api/system/update` through the active runtime,
shows an update dot, and confirms an exact version/channel/plan before remote
update/restart. OTA, native installer and CLI package updates remain Host-owned;
beta-to-stable rollback is explicitly disclosed. Runtime-scoped Query state keeps
progress across reconnects and rejects stale mutations after a Host switch.
About labels the two Yuri versions as Yuri Client and Yuri Service. When the
desktop shell is connected to its local service, that service row is read-only
and its update search entry is hidden; the client updater owns local updates.
Remote desktop connections, web and mobile retain the service update control.

Desktop host-picker actions keep their popup visible during SSH preparation and
show the polled SSH phase inline. Switch, connect and new-window actions share a
synchronous local guard and disabled controls until completion; failures leave the
picker open for retry. The services menu ignores dismissal and tab changes while
an action is pending. Host-switch mutations from the picker opt into inline
progress, while the global overlay still covers the actual endpoint transition.

Desktop startup restores each window's boot Host before consulting the global
default. Relay-capable Hosts retain direct-first, identity/authenticated fallback;
direct-only Hosts keep the shell-selected endpoint and adopt the stable saved
`host:<id>` runtime key so an SSH forward's changed port does not lose UI context.
Local windows do not reconnect another window's default remote Host. Web, VS Code
and mobile do not participate in this native window-restore flow.

All runtime owners must agree on `__YURI_*`, `yuri:*`, `/api/yuri`, `Yuri*` native
plugins, `yuri-ui` / `yuri-asset` schemes and `yuri_url_token` / `yuri_preview_token`
query parameters. Product CSS/custom properties/data attributes now use `yuri-*`;
native keyboard, webview and desktop injection code must emit the same names.
The server metadata namespace is `metadata.yuri`; authoritative server migration
must preserve old session goals, reviews, assistant/task membership and title data.
Mixed old shells are not supported by merely changing a display name: the native
bundle/update compatibility gate belongs to the mobile/desktop owners.
Mobile OTA requests carry `applicationId` only from native `App.getInfo().id`.
Missing or unreadable native identity stays absent; the web bundle/config never
supplies a fabricated identity. Old/missing identities can receive an installer
decision but cannot accept or download Yuri OTA. Desktop checks invoke
`desktop_check_for_updates` with only the channel override; Electron supplies the
native identity at its privileged boundary.

Release builds must configure verified update URLs with
`VITE_YURI_EDGEONE_UPDATE_CHECK_URL`, `VITE_YURI_VERCEL_UPDATE_CHECK_URL`,
`VITE_YURI_EDGEONE_OTA_CHECK_URL`, `VITE_YURI_VERCEL_OTA_CHECK_URL`, and
`VITE_YURI_IOS_TESTFLIGHT_URL`. Unconfigured update services use reserved `.invalid`
addresses, and the iOS installer link falls back to the candidate releases page.
These defaults are not a configured or verified release service.

`src/components/ui/YuriLogo.tsx` and `src/assets/brand/yuri-mark-{black,white}.svg`
use the final approved vector geometry. The mark stays black or white; theme
containers own backgrounds. Animation honors reduced motion.

`src/components/ui/YuriWordmark.tsx` renders the approved sculpted-serif wordmark
from `src/assets/brand/yuri-wordmark.svg` as a current-color mask. The disconnected
welcome page places it in a safe-area-aware top-left header; the portrait remains
the central decorative mark. `assets/brand/yuri/build_wordmark.py` regenerates the
master artwork and synchronizes this bundled SVG. The welcome's connection/history
actions retain their existing shared sheet and modal behavior.
Saved-device connection failures in mobile history appear only as a solid error
icon to the left of the overflow menu, without inline error details or retry copy.
Tapping the icon retries that device immediately through the shared connection
controller and replaces the error affordance with the row's connecting state.

## Desktop conversation width

Desktop `ChatWorkspace` owns two full-height columns: the primary conversation
(including its session header and terminal dock) and the preview `ContextPanel`.
The primary header's folder action and the existing right-sidebar shortcut
toggle the preview independently of its tabs. Opening without a selection shows
a localized select-file SVG empty state; closing the last tab hides the entire
preview and its nested rail, while the panel close action hides it without deleting tabs.
An additional close shortcut on an already-empty preview closes the panel, not
the OS window. The session overflow menu omits the redundant Changes panel entry;
Git changes remain available in the preview's Git rail.
The preview toolbar owns its always-visible joined Git/Files icon group
(one rounded outline with internal dividers), expand and
close actions. The preview's expand/restore button uses paired diagonal arrows and
toggles the same full-workspace preview used when dragging leaves less than 350px
for the conversation. Both use normal layout flow, identical spacing, the restore
icon and an active resize handle. Dragging right can restore either fullscreen
entry; the restore button returns to the last fitting split width (clamped to
leave 350px for the conversation). Tabs and conversation drafts stay mounted.
Split and expanded previews retain a `py-1.5` vertical inset. Their internal
toolbar subtracts both density-scaled insets from the conversation header height, keeping tabs
and toolbar buttons on the same vertical centerline. Both retain the split layout's horizontal spacing.
The file-tree search uses a compact 28px field with a 14px icon and a fine focus
ring and a subtle local-background fill (2% foreground, 4% on hover), not a dark
elevated plate; filtering, clear-to-refocus, and existing file actions stay available.
The existing Files/Git/Browser rail is inside that preview; its visibility no
longer closes or resurrects preview tabs. Hidden rails unmount their
consumers. An open preview with no selected tab always reveals the rail, including
restored empty panels and compact layouts. It preserves the last chosen view and
defaults to Git (Files if the main Git view is already active). Git refresh follows
actual rail visibility, including this empty-state fallback. The preview has one
inset rounded border. File paths remain in tab hover titles rather than a separate
path header; content begins directly below the toolbar (except actionable notices).
The entire preview surface (toolbar and content) raises the theme background's
OKLCH lightness by 0.015 in light mode, capped at 1 while preserving hue/chroma.
Dark mode retains its 4% foreground mix. Both keep a subtly raised layer rather
than darkening the light surface; nested editors inherit its local
background token. Stacked Changes file headers also use that local background
(including their sticky translucent state), rather than separate elevated plates;
diff addition/deletion colors and hover/selection feedback retain their meaning.
The rail is transparent and inherits the same preview background, without a
separate darker plate. Its resize minimum is 240 CSS pixels; the default stays
360px and manually chosen widths survive reopening. In split mode, one 1px divider mixes 8% foreground into
that background to keep the boundary visible; single-view mode omits the divider.
It starts directly
beneath its toolbar, without a second tab strip or
top spacer. Below 400 CSS pixels of content width, the preview uses a single view:
the rail fills the content area, and confirmed file/tab navigation synchronously
switches the panel's transient `activeView` to preview in the same store action.
Failed validation or a blocked unsaved-file guard keeps the rail visible. Opening,
focus restoration and unavailable-tab fallback do not wait for React Effects;
the initial empty layout and valid rail selection are derived on the first render.
Its toolbar buttons reopen the rail; widening restores both panes without changing
the saved rail selection/width or unmounting the file preview. Resize events only
update React layout state when crossing the threshold.
In light mode, the header's selected tabs and Git/Files segments use a local
7% foreground mix over the preview background, keeping selection neutral and
aligned with the theme's tint. Dark selection and editor text-selection tokens
are unchanged. Header hover/press use the same neutral tint at 6%/10%, so a
selected segment never flashes the theme's unrelated accent tint on interaction.
Desktop Git rails use compact Changes/Commit titles, a single-line textarea with a
38px default/minimum height and a draggable top border, and shared xs actions.
Dragging up enlarges the field; dragging down shrinks it. The focusable border also
supports Arrow Up/Down and Home to reset. Pointer moves update only the field's
height, without React renders or repeated layout measurements.
Manual height survives editing and clearing; overflowing text scrolls instead of
automatically enlarging the field. The textarea matches
the file-search field's inset edge, theme-derived fill and hover/focus feedback.
Its transitions exclude geometry so manual resizing stays immediate.
Only the commit section adds a small bottom inset (`pb-1`); the outer scroll surface
adds none. Mobile keeps the existing title, 38px field and touch sizing;
staging/index-mutation guards, generation, gitmoji and commit/push remain unchanged.
Right-side frameless window controls move from the session header to
the preview header while open; WCO/titlebar insets remain reserved.

The preview's saved and drag-resized width is at least 300 CSS pixels; older
narrower saved widths are clamped on restore. A smaller workspace still bounds
the rendered panel to its available width. Its full-height resize hit area is
1rem wide and straddles the boundary. The short rounded 3px grip sits on the chat
side, clear of the preview border, and remains hidden until hover or dragging.
It uses a faint 25% muted-foreground fill and a localized Resize tooltip. Only the
outer resize affordance may overflow; the rounded content surface stays clipped.
Expanded previews omit the resize handle.

Desktop `ChatWorkspace` keeps the primary conversation (transcript and composer)
at least 350 CSS pixels wide while a ContextPanel is open. If the requested panel
width leaves less space, the primary pane hides without unmounting and the panel
fills the workspace. Window/sidebar resize, live panel dragging, closing, and
expansion re-evaluate this local layout; exactly 350px restores the primary pane.
The saved panel width and draft remain unchanged by automatic collapse. Decisions
use the requested width, not the filled panel width, to avoid resize feedback loops.
Split width changes do not animate through unreadable intermediate widths. Phone,
native-mobile and the separate VS Code layout retain their existing behavior.

## File preview fallback

File toolbars retain find-in-file but have no go-to-line control or shortcut.
The shared CodeMirror search keymap also omits its built-in go-to-line command;
find, replace, and navigation to source references keep their existing behavior.

`FilesView` and `MobileFilesSurface` retain the inline GUI-plugin preview as the
outermost preview choice. The ordinary text fallback first reads authoritative
`FilesAPI.statFile` metadata; a binary result never triggers a UTF-8 content read,
editor or save. Unknown suffixes still display text when stat permits it. Stat
failure/unavailable capability is an error, not evidence of a text file. Existing
image/PDF rendering stays on its asset path.

`components/views/BinaryFileFallback.tsx` owns the shared non-text state. Local
desktop users explicitly choose “Open in system app”; both its visibility and
the existing `openDesktopPath` boundary require the active local origin. Remote
desktop, web, mobile and VS Code use `FilesAPI.downloadFile` when supplied by
their runtime. Opening a file tab never triggers either action automatically.

Mobile reuses the stat watcher query for classification instead of adding a
second metadata read, and revalidates cached classification on opening a file.
Runtime/scope/path/read-options remain part of its query
identity; binary transitions disable text refetch. Desktop preserves outside-file
read options/grants for stat and content and rejects stale stat completions before
starting a content read. Binary files keep metadata-only external-change watching.

Mobile text previews show the loading canvas only while no content snapshot exists.
Background reads keep the existing preview and scroll container mounted, including
when the previous content is an empty string. External updates replace content in
place rather than resetting the reader to the top. Refresh failures retain their
existing error presentation.

Desktop ordinary and fullscreen previews likewise retain the last loaded path and
content while a same-file background read is pending. Polling starts one guarded
refresh directly instead of clearing that path to trigger a foreground load;
editing/saving remains disabled until the read settles. Transient background read
failures report a toast without clearing the preview; missing files and directory
errors retain the existing navigation cleanup. New selections reject late refreshes.
Metadata-only changes do not recreate HTML iframes. Inline HTML still updates its
document when the source changes; URL-based HTML reloads only for a genuinely
changed source or its existing navigation/auth lifecycle. GUI-plugin previews remain the
outermost branch, and their file updates and foreign-DOM lifetime stay plugin-owned.

The refresh tests exercise the real desktop polling/mobile Query paths and guard
Markdown scroll-node identity, HTML iframe identity on metadata-only changes, and
plugin frame/control continuity during host source reads. Plugin integration and
file-model tests cover owner-scoped mounts and in-place content updates; these
fixtures are not native-device or independent Eficy-runtime acceptance.

The file-reference and mobile binary tests cover skipped reads/writes, explicit
actions, plugin precedence, stat failures and stale completions. They do not prove
real OS app opening, native mobile downloads or remote/Relay transfer behavior.

## Scheduled-task history

Scheduled-task history loads the next 20 runs automatically within 240px of the
scroll boundary, using the workspace/sheet scroller or the mobile root tabpanel.
There is no load-more action row; only an in-flight status spinner appears below
the list. Requests are serialized and pause while hidden, refreshing, or in error.
Failed pagination preserves loaded rows and the existing explicit retry action.

## Validation

Use `bun run --cwd packages/ui type-check`, `lint`, and `test`.
The `brand-storage-migration.chrome.test.ts` regression uses real Chromium
IndexedDB for Blob copying, transaction abort/retry and non-resurrection. This is
same-origin browser evidence, not proof of Electron cross-origin or native-sandbox
migration. Real shell install/import/relay/OTA acceptance remains required.
