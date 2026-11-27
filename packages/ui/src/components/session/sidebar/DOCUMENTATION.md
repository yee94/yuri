# Session Sidebar Documentation

Desktop local and remote project rows share `SortableProjectItem` and its context
menu. Their Edit action opens the same `ProjectEditDialog` and identity controls.
Remote edits persist through the captured Hub's project-reference endpoint and
render stored icons through the corresponding Host. Local default-model and
worktree-management controls do not run against a remote directory.
Choosing a palette icon writes its metadata immediately, independently of the
debounced text fields. An existing image is detached from the project icon in the
same write; the source file is not deleted. Remote rows update after Host confirmation.

## Flat worktree sessions and explicit ownership

Project lists on desktop and mobile render a flat list of active sessions under
each project root (no nested worktree subgroup headers). Startup, reconnect,
mini-chat bootstrap, mobile sheets, and manual project sync do not automatically
enumerate Git worktrees via `git worktree list`; worktree APIs remain on-demand
for explicit user actions (creating/validating/removing worktrees and Settings).

Sessions created inside a linked worktree persist `metadata.yuri.worktree`
(`projectId`, `projectDirectory`, `worktreeRoot`, `path`, `branch`, `name`,
`relativePath`) through the Host metadata store and SQLite session index.
`createSessionOwnershipIndex` binds sessions using explicit
`metadata.yuri.workspaceId` first, then `metadata.yuri.worktree` ownership
(isolating monorepo subdirectory projects without polling sibling checkouts),
then directory/worktree fallbacks (preferring dedicated single-path projects
over multi-path workspaces for legacy directory-only sessions).
Every session Yuri creates records its owning local project as
`metadata.yuri.workspaceId` — single-path projects included
(`resolveNewSessionWorkspaceId`) — so moving it outside the project's paths
(OpenCode worktrees, sandboxes) cannot detach it. Sessions without Yuri
metadata (OpenCode TUI, imports, older sessions) fall back to OpenCode's own
`session.projectID`: `useSessionOwnershipIndex` reads `project.list()` once for
unclaimed IDs (`unresolvedOpenCodeProjectIds`), maps each to its canonical
checkout, and binds the session to the Yuri directory of that repository — the
root project, a multi-path member, or a monorepo subdirectory project whose
relative path the session directory repeats. No `git worktree list` or
per-directory probing is involved. Sessions that still match no project stay
out of the project view.

Desktop/Web scope active sessions by this ownership index, not by a
`projects[].path` + `yuri.worktreeMap` allowlist, so a worktree created outside
Yuri (terminal `git worktree add`, `session_move`) shows under its registered
project in the project view, pinned group and task view without being in the
cached worktree map. `sidebarSessionScope.ts` owns both scopes: the project
view reads the index buckets directly, while pinned/task rows (not bucketed by
the index) use `filterOwnedSessions`, which hides active sessions no project
owns once projects exist and never drops archived or directory-less rows.
VS Code keeps the strict opened-workspace-path filter
(`filterVSCodeWorkspaceSessions`).
Multi-path workspaces (`paths.length > 1`) default to the stacked `folders`
icon when no custom icon/image is set; blank 0-path workspaces (`paths: []`)
use a Host-managed backing directory for OpenCode while hiding Git/Worktree UI.
Linked-worktree rows render a compact footer (`[data-session-worktree-footer]`)
showing the branch icon, branch name, and distinct worktree name.
Task cards reuse the project row's resolved worktree when available, falling
back to the session's indexed worktree metadata when the project row is absent.
Desktop task cards, pinned rows and project-tree rows read the cached branch
for the session's current checkout and retain the worktree name when matching
metadata is available. A worktree footer can show the branch even when an
external move did not create Yuri worktree metadata. Worktree labels from an
earlier checkout are ignored. The visible sidebar ensures Git status for the
selected session's checkout when it differs from its project root.

## Task navigation icons and hover details

The desktop task-view header's add button opens the existing add-project dialog,
matching the project-view header. New-session creation stays on its separate action.

`MobilePhoneShell` owns the persisted `yuri.mobile.homeView` selection and passes
it to both the home page and the Web tab bar. The Web Projects tab follows the
title menu and PC switch (`list-check-2` for Tasks, `folder-tree` for Projects).
The shared native tab definitions and native bridge remain unchanged.
Mobile tasks use flat inbox-style rows with no per-row glass background, shadow
or backdrop filter regardless of running state or the last selected session;
execution is indicated only by the status slot. Each row reuses `TaskProjectBadge`
inside a 40px circular project mark, with a 22px logo/glyph and 14px content gap.
The icon is part of the same full-width selection/long-press target as the text,
not a separate action. Task lists and swipe rails span the viewport without the
page's outer gutters or a maximum-width card shell. The existing page inset is
inside the row instead, retaining icon/text/menu alignment and a full-width touch
target; separators start at the text column (page inset + 54px) and reach the
right edge. The inline archive retains its aligned inner padding. Project view,
the glass header and dock keep their existing layout.
The overflow button and bottom pin mark share a 36px trailing column flush with
the row's right edge, centering both glyphs on the same axis. The overflow button
retains its full 36px touch target; the pin remains part of the row selection target.
PC and mobile task cards share `TaskUnreadDot`: an 8px blue marker immediately
before the project name in the first line's normal flex flow, vertically centered
within that metadata line (not the whole task row or avatar). The dedicated
`--session-unread-fill` token stays blue independently of the theme's info color.
The dot, title weight and swipe Read/Unread action consume authoritative unread
state; selected rows do not hide it. Running/question/permission indicators take
precedence as in project rows. Marking read removes the dot without changing row
height or the title/branch insets.
Their compact type scale is scoped in `mobile.css`: title 14/20px, project
12/16px and time/branch 11/14px at the default rem scale. Titles use regular (400)
weight, with medium (500) reserved for unread tasks. Rows use 14px vertical
insets and no inter-row gap; the archive group follows in document flow with an
8px gap and no glass background, border shell, shadow or backdrop filter.
Mobile task rows always reserve the compact 14px branch line and its 6px top
gap, including unpinned rows. The task model projects the same branch/loading/
no-git distinction as PC from the existing shared Git status: unknown Git status
stays loading, a confirmed non-repository shows its home-shortened project path.
Loading uses the existing localized `common.loading`, a small branch glyph and
muted text without a spinner or pulse. Resolution, pinning and missing metadata
do not add/remove this line; title wrapping remains capped at two lines.
Its 48px disclosure header aligns an 18px archive glyph within the same 40px
icon column and puts its label at the task text inset (54px). The count uses
the 11px meta scale. Expanded rows share that 54px inset, top separators and
44px minimum height; they show only a single-line 12px title and `undo-2` restore
action, omitting project badges and timestamps. Disclosure IDs are instance-unique;
collapsed lists stay unmounted, and pagination keeps the existing Show-more action.
Active titles clamp to two lines, metadata
truncates, and the separate menu/restore controls retain their 36px touch floor.
The large page title, glass header controls and both bottom bars are unchanged.

Inbox task rows retain three operation entrances. Left swipe reuses
`useMobileSwipeActions` / `MobileSwipeActionRail` in left-to-right order:
Mark read/unread, Pin/Unpin, task Archive. The first action uses compact Read/Unread
copy with the full localized accessible name and a neutral solid button plate;
Pin retains the selection-tone plate; Archive uses the shared solid red destructive
plate with white icon and text, matching project-tree session swipe actions. Labels
stay single-line with ellipsis for longer locales. Read actions share `useSessionReadMenuAction` with the half-sheet,
including its narrow per-session subscription, Host writes and failure feedback;
the callbacks route through the same home/container mutations as the full menu,
so Archive remains the Host settled projection rather than real archive metadata.
Long press and the visible three-dot button both use the existing
`MobileRowActionsSheet` / `MobileResizableSheet` half-sheet with the complete
session commands. Opening it closes the swipe rail. The project mark, text, time,
pin mark, overflow button and separator translate together; there is no per-row
glass fill. Moving/scrolling cancels the long-press timer, and completing a swipe
or hold never selects the session. Pointer moves update only the active row and
measure rail width once at pointer-down; they do not reload sessions or transcripts.
Running tasks expose only Pin/Unpin: Read/Unread and Archive are omitted from both
the rail and full action sheet. Archive dispatch rechecks live activity, including
descendant work, before changing pins or settled/archive state. Archivable task and
project rows share the full-swipe expansion, threshold haptic and release-to-archive
behavior described in the shared UI documentation.

Archived task rows use Lucide `undo-2` for restore on mobile and PC. On PC the
quick restore replaces the row's time on hover/focus; the archived row does not
also offer a quick pin. Shift still selects hard delete. Context-menu restore
uses the same icon.
Mobile settled rows also support full-swipe Restore: the existing restore plate
expands over the read action, confirms with one haptic and restores on release.
Reversing or cancelling keeps the row settled; this reuses the archive gesture
controller without additional effects or per-move geometry reads.

Archiving the current desktop/Web task never opens the archived shelf. After a
confirmed write, focus moves to the next unarchived row in the current visual
order (pinned rows first), or the previous row when archiving the last one.
If the preferred neighbor has disappeared, the first remaining task is used;
with no remaining tasks, selection clears into a new-session draft without
creating a session. Failed writes leave selection alone. The mutation completion
is transport/generation-fenced, and a newer navigation intent (including ABA),
session selection or departure from Chat cancels the focus move. Archiving an
unfocused task and restoring an archived task do not navigate. Archived
membership or an externally opened session never automatically expands the shelf.

`SessionHoverDetails` mounts only while the row tooltip is open. It shows the
full title, project badge, cached current-host label, branch and authoritative
session model (resolved against that directory's existing provider catalog). Missing machine
or model metadata is omitted; local desktop may use the existing Local label.
The branch row uses cached Git status for the session's checkout directory,
preferring its worktree path when present. If Git status is unavailable, the
row uses the matching worktree or sidebar branch metadata. Hover never
fetches a transcript, probes a Host or requests git status. The shared Tooltip
owns anchoring, collision handling and material.

For a multi-path workspace, the project header and session hover card use one
project icon slot. The default is the double-folder glyph; a customized project
icon takes precedence. The session hover card shows the workspace name, then
branch, and lists all attached paths in configured order, one ordinary
directory row (route icon) per path. The project tooltip lists the same paths. The row's workspace or indexed
workspace binding is not replaced by the live session's executing project;
a distinct session checkout is shown separately.

## Error presentation

Remote project mutation failures use the shared toast once and retain confirmed
rows/selection for retry through the original action. Summary/search/pagination
load failures use a project-keyed toast and retain cached rows. Errors never
insert banners, text or Retry rows between project headers and sessions on either
desktop or mobile. Project Sync remains the explicit data-refresh action; it
must not be presented as a retry for a failed archive or other mutation.
`RemoteChildSessions` and `SessionSwitcherDropdown` follow the same no-error-row
rule. Child/summary read failures retain cached rows and expose retry on the toast;
navigation failures notify without inserting content. The unavailable switcher
keeps its existing refresh action rather than adding error text to the menu.

## Remote session deletion

Desktop row menus and mobile action sheets expose Delete; the shared selection
toolbar also exposes bulk Delete. Both use the section model's confirmation,
capturing immutable Host entries and raw directories before confirmation. Unlike
the local delayed-undo flow, remote deletion is confirmed before dispatch and
does not optimistically remove rows. The target Host owns cascading subsession
deletion; the warning says so without inventing a count from a partial index.
Submissions share the per-Host serializer and same-tick pending gate. Failed
targets remain in the dialog and selection; successful targets are removed from
selection and never retried as part of a partial failure. An authoritative
`SessionNotFoundError` for that exact ID counts as already deleted, while generic
HTTP/transport failures do not. Summary and child Queries refresh after writes.
Only an unchanged navigation reference for the deleted session on that same
Hub/Host/project is replaced with a remote draft; later selections and local
state remain untouched. Authorization changes invalidate the captured entry;
confirmation never re-resolves a replacement Host behind the user's back.

## Fixed desktop navigation

`SessionSidebar` keeps the configured Electron brand/search row and desktop
navigation actions outside `SidebarProjectsList`'s scroll region in both windowed
and native fullscreen modes. Fullscreen does not move these actions into the
scroll body or move the brand/search into `TitlebarLeftControls`. Electron's
titlebar retains the search fallback when the sidebar is collapsed or no brand
is configured. Web retains its titlebar brand/search placement; mobile retains
its scroll-body navigation, and session search retains its existing filtering.

## Explicit Remote Project presentation

`SidebarProjectsList` accepts an optional `hostRegistry`; project sections retain
`hostId` and `remoteState`. `SortableProjectItem` mounts `RemoteHostIndicator` only
for remote rows with that registry. The indicator subscribes to its own host,
exposes machine/status/last-sync/error details through hover and accessibility,
with a vertically centered computer icon and machine name that uses
remaining header space (up to 12rem) with ellipsis. Compact SSH labels omit the login
prefix from user@host names; hover/accessibility retain the original full name.
Project names take width priority over machine labels. Remote project labels keep
the same width and position on hover, focus and menu-open: the absolute action
buttons share a transparent overlay with 12px left padding. The title button is
clipped and faded before that overlay, so its text and hit area cannot enter the
actions; the sidebar's original glass/background stays continuous. The clip is
derived from the rendered action count (24px buttons, 4px gaps and overlay insets).
Invisible actions do not reserve their full width or shrink labels. Host tooltips show the
full name above separate bulleted status, last-sync and optional error rows.
Remote identity tooltips use a local 600ms hover delay instead of the sidebar's
instant tooltip group, so briefly crossing a machine label does not open details.
Mobile project cards and recent-session project chips/root headers reuse this
compact identity. Touch long-press on the identity opens only its tooltip, not
the enclosing project's action menu; project labels have priority within the row.
The indicator does not discover hosts or enumerate project/session catalogs. The mobile
and desktop project bodies never add a connection/status/last-sync text row;
those details live in the machine icon tooltip and accessible label. The mobile
`MobileProjectsHome` / `MobileProjectCard` boundary accepts the same registry and
identity fields. `SessionSidebar` and `MobileProjectsHomeContainer` now consume
the Hub catalog and preserve the Hub reference ID, host and raw path. Their
local ownership/worktree projections exclude remote projects; `RemoteProjectSection`
consumes the shared per-Host summaries Query instead of a Hub local child store.
Desktop and mobile sections mix both kinds through `sortProjectEntries`, including
manual, alphabetical, added-date and recent modes. Remote host status stays on that
host's leaf subscription, and token events do not invalidate structural lists.

### Remote section module ownership

- `RemoteProjectSection` composes the Host adapters and editors. It does not
  fetch summaries or implement remote writes in JSX callbacks.
  Its leading pinned/attention rows pass `secondaryMeta` into the remote row
  adapters as well as the list item. Mobile renders it through the shared
  `MobileSessionRow` subtitle; desktop retains project/branch secondary text.
  A custom `content` row must not discard the owning project's label.
  The subtitle ends with the existing compact `RemoteHostIndicator` (computer
  icon and Host name), preserving SSH-name shortening, ellipsis, full-name
  tooltip and isolated touch long-press. Project text keeps priority up to 60%
  of the subtitle row, matching remote project/session identity presentation.
- `hooks/useRemoteProjectSectionData` owns summary/search/page Queries, ownership
  projection, pin/manual ordering and refresh. It does not render either platform.
- `hooks/useRemoteProjectSectionModel` owns selection/editor state and commands:
  captured Host writes, per-Host serialization, confirmation, compensation and
  navigation targets. Both presentations invoke these same commands.
- `remoteProjectPresentation` defines the data/intent contract. Mobile does not
  inherit `SortableProjectItem` props; desktop-only menu state stays in its adapter.
- `RemoteSessionGroups` binds remote snapshots and commands to the existing
  `useSessionGrouping` and `SessionGroupSection`, including folder layout,
   worktree headers, default row limits and More/Fewer controls. Its source
  input prevents reads of same-path Hub folders/pagination and local destructive
   commands. Visible keyboard targets come from that renderer's actual projection.
   Archived sessions and the archive header are omitted on both platforms. Active
   sessions placed in the grouping fallback bucket flow into the main group;
   their original Host directories remain intact for navigation and commands.
   The section publishes its busy/retry and unread roots through the shared
   `listInProgressHomeSessions` projection. Desktop and mobile merge these with
    local attention rows by activity time in the existing leading list. The flat
    Tasks view also uses the Host index's activity time, not the remote session's
    metadata update time. Execution and legacy status events refresh only the
    owning Host's summary so the running badge follows live state. Host row
   actions remain bound to the section model; clearing unread removes settled
   rows from the leading list. Accepted remote sends and real busy/idle
   transitions also call the shared `moveProjectToTop`, promoting the entire
   owning Host project in the persisted Hub order. Duplicate status events do
   not undo a later manual drag. Same-path local/other-Host projects are excluded.
- `SessionRowLayout`, `SessionRowContent`, `SessionRowTitle` and `SessionRowActions`
  own the desktop row geometry shared by local `SessionNodeItem` and the remote
  command adapter. Remote data never mounts the local session subscriptions.
- `RemoteMobileSessionGroups` adapts Host summaries to `MobileProjectGroups`;
  both kinds use `MobileProjectSurface`, `MobileProjectCard`, `MobileSessionRow`,
  the same workspace labels, row drag scope, root-session filter and pagination
  limits. Mobile expansion uses the existing project/worktree expansion store.
  There is no remote-only directory/folder list, checkbox, drag handle or inline
  create-folder row. Action sheets retain captured Host commands.
- `RemoteProjectResources` keeps optional icon and expanded-child Query lifetimes
  on their existing leaf observers, separate from summary/model lifetimes.

Mobile project/session/folder menus provide action descriptors to the shared
`MobileActionSheet` in `mobile/projects/MobileRowActionsSheet.tsx`. That renderer
owns icons, haptics, grouping, dividers, disabled rows and the resizable sheet;
local `MobileRowActionsSheet` is its existing local-menu adapter. Remote commands
never use local session callbacks. Action sheets mount on demand, not per idle row.

The model opens raw session IDs through `useSessionNavigationStore`.
Title, archive, unread, folder and directory-order writes use the captured registry
entry; failed writes leave the confirmed snapshot intact and display the error.
Remote pin/unpin requests use the same scoped registry path but terminate in the
Hub's DB, not the Remote Host. Pins remain editable while the Host is offline.
`pinnedSessionIds` is authoritative for row actions and leading-list membership;
an old `session.time.pinned` must not restore a cleared pin. The mixed leading
list's `__pinned__` order is also Hub-owned.
Folder writes serialize per Host and read the full remote folder snapshot before
changing a scope. Desktop sections reuse `SessionFolderItem` and its `parentId`
tree; mobile follows its existing flat root-session/worktree presentation.
The same projection owns visible keyboard targets and drag order. All sessions
use `createSessionNodeComparator`: saved manual order and its activity baseline
share the original rule, promoting newly active sessions without reshuffling
unchanged peers; pin/time ordering is the shared fallback. Expanded children join
the same keyboard target tree and use the same pin/time comparator.

`SessionFolderDndScope` owns session dragging on both sources. Folder drops change
membership; row drops reorder within the same folder. Modifier-click selection
keeps multi-session folder moves without permanent checkboxes. Remote-only folder
drag handles and nesting drop zones are removed. Nested-folder creation and deletion
use the existing folder controls; deleting a folder releases its descendants'
sessions. Failed writes preserve the confirmed tree and selection. Host metadata
keys and raw filesystem paths are retained, including Windows separators; normalized
paths are used only for grouping/ownership comparison.

Host summaries' authoritative worktree topology supplies outside-root directory
ownership. Explicit/most-specific project references still win; raw cwd stays
unchanged when opening that worktree. User-driven older pages and child expansion use the Host SDK
with bounded cursor pages and cancellation; title search also uses that SDK.
Neither path writes remote messages or session IDs into Hub local stores.
Project metadata waits for the remote confirmation, while close removes only the
Hub reference. Only local projects enter `settings.projects`; remote ordering and
collapse currently remain in the instance-scoped client cache, pending a Hub layout
API (cross-client Hub layout persistence is not implemented). They never mutate
remote metadata. Missing Hosts and removed projects retain their rows; Sync can recreate
the registration for an explicitly retained `remote-removed` reference.

`DirectoryExplorerDialog` discovers the Hub catalog only while open. Remote
machine selection supports Up/Down (skipping disabled hosts) and Enter to
continue; repeated/composing Enter never submits. The selected machine receives
initial focus, and connection readiness still owns admission to directory browsing.
Directory input underlines remain visible without focus. Remote
selection mounts `RemoteDirectoryExplorerDialog` instead of the local browser,
using registry HTTP for raw filesystem paths and the Hub's dual-write project
registration endpoint. A successful registration upserts the confirmed reference
into the project store and opens its scoped draft before the optional caller
callback. Remote registration refreshes the catalog; it must not
be inserted through the local-only `addProject` fallback. Browser/VS Code clients
show an explicit unsupported explanation and retain local project selection.

Project Settings and the desktop/mobile project editors show the workspace
directories as read-only paths, not inline add/remove controls or a worktree
list, including for ordinary single-directory projects.
Editing reopens the local multi-directory picker on the existing workspace,
without machine discovery or new-session navigation. Removal, addition and
primary-directory order are staged until one workspace update is confirmed.
The local desktop picker can grant access through Finder; canceling the editor
does not write the workspace's directory list.

The remote navigation bridge can carry draft title, parent, folder, permission,
pending-worktree/bootstrap and worktree metadata separately from the Hub draft.
`updateRemoteDraft` uses the captured navigation object as a CAS token, rejects
Host changes, and cannot overwrite a later selection or an existing session.
Worktree and chat owners consume that metadata at their production boundaries;
ordinary session navigation without draft options clears it.

Remote headers expose the shared worktree dialog without enumerating Git on every
project row. Worktree action availability is independent from verified checkout
topology: a nested source-directory project may legitimately have no checkout
alias. Git repository eligibility is checked by the captured Host creator, not
guessed from topology. `NewWorktreeDialog` and its linked `GitHubIntegrationDialog`
bind the explicitly requested project (not a retained background workspace), and
local dialogs clear inherited Host context. Both preserve their mature forms.
Remote branches, worktree conflicts, validation, GitHub auth/list/context and
prompt templates use Host scope; no remote path reaches local worktree/session
actions. The dialog-owned GitHub adapter intentionally exposes only six read
capabilities, with no machine-auth mutation surface. Remote GitHub configuration
stays read-only and explains the instance-switch requirement.

Creation delegates to `createRemoteWorktreeDraft`, retaining Host setup/bootstrap,
relative source cwd and draft CAS ownership. Completion callbacks receive
`remote: true`: the helper already owns navigation and callers must not reopen
the bridge (which would erase worktree draft metadata), nor select a local raw
session ID. A superseded selection does not invoke UI-navigation completion.
Linked issue/PR context sends through the captured worktree Host prompt endpoint;
context failure reports separately from successful worktree creation. Failed
creation leaves form values available for retry.

Project dropdown and right-click menus have one shared popup hairline immediately
before destructive Close; ordinary actions have no separators. Action icons inherit
their label color, including Close. Mobile project action sheets use the same
single destructive-action divider and color mapping while retaining touch targets.

`SidebarBackgroundTasks` is the shared inline progress area to the right of the
footer settings/device/help buttons. It consumes existing runtime-scoped import,
content-index and Host-update Queries plus the client update store; it adds no
separate task store or floating tip. The subdued area is right-aligned and fits
its content. A single task shows a progress ring and short label; multiple tasks
show only adjacent rings. No visible percentages are rendered. Unknown totals use
an indeterminate ring, with animation disabled for reduced motion. Clicking the
group opens a Base UI Popover centered above its trigger, with live task phases and
processed/downloaded counts. It shares DeviceConnections' exact popup material
(`yuri-mobile-overlay-surface yuri-popup-surface`), 10px offset, 72-unit width,
viewport bound and 2xl outer radius. The compact header/list share a 3-unit inset.
Each item uses one 16px ring, task name/status and a trailing Continue button;
processed and failed counts share one secondary line. Every task detail uses the
same 4px rounded progress bar, `surface.subtle` track, `primary.base` fill and
300ms reduced-motion-aware width transition, independent of task type. Failures
switch only the fill to `status.error`; unknown totals use the same one-third
indeterminate fill, static on failure or reduced motion. Client byte counts use
decimal MB with one localized decimal place; unknown totals show only downloaded
MB. Host snapshots without byte counts never fabricate MB.
The footer keeps its rings and never shows percentage text. Items have no card/large
icon plate and are separated only by the shared popup divider token/width.
Only the outer surface paints blur, fill, edge and shadow; rows remain transparent.
There is no modal scrim or corner close button; outside click and Escape dismiss.
Details initially retain focus on the trigger (`initialFocus: false`), so global
focus-ring suppression cannot erase the popup's shared rim/shadow.
Import `completed` and `partial` are both finished: they leave the background
list and offer no Continue action, while durable receipts retain failure details.
Cancelled/interrupted imports and failed index/update tasks remain visible with non-spinning error-colored rings and per-row
Continue actions. Each row owns independent mutation pending/error state and
synchronous duplicate-click admission. Failed retries preserve the task and its
successful results. An already-open popup shows its empty state after the final
task succeeds. Observed import completion refreshes the project
catalog once. Refresh failure retains progress with retry wording in details.
Client downloads reuse store events, while Host-owned/background downloads use
the existing update operation snapshot. A same-version local client/Host mirror
is shown once; different target versions are not deduplicated.
Imports use the unfinished `jobs` query, excluding both completed and partial
imports, so a newer task cannot hide older interrupted/cancelled
ones; the tour keeps its separate latest-job query. Recovery seeds both caches
only in the captured runtime generation. Continue sends only the original job ID
and confirmation; source/fallback-directory selection never appears in the popup.
Imports resume saved original intent. A failed Continue changes that import row's
button to Remove; nothing is removed until a second explicit click. Remove only
dismisses the task record, not imported content. Failed removal retains the row
and Remove action for retry. Legacy jobs with missing intent report that limitation
instead of fabricating a new selection; they follow the same Continue→Remove flow.
Index recovery reuses durable checkpoints. Host update recovery fetches a fresh
plan for the failed operation's exact version/channel/kind; an unavailable or
changed plan is a visible failure, never an implicit update to a newer release.
An already-active matching operation resumes observation; a matching succeeded
operation with the target running version removes only that Host's stale task.
Neither path calls the local client updater, even when both target the same version.
Client downloads reuse their owning updater with `resume: true`, without applying
or restarting the client. Check-only failures do not invent download tasks.
The update footer button hides its duplicate download indicator while this
area is mounted. A downloaded client update also suppresses an active stale local
Host mirror for the same version, while unrelated and failed Host tasks remain visible.
The restart action is icon-only with a tooltip. When it shares the footer with
background tasks, those tasks are also icon-only with a hover label; the two
controls share one right-aligned group with a fixed gap. A single task uses the
same 28px button as the left footer controls; multiple rings retain their required width.
Clicking delegates directly to the existing restart mutation, never the details
dialog; pending restart disables repeat clicks and exposes the updating label as its accessible name.
Runtime generation changes remount the observers and clear completion tracking.
Import/index/update polling uses 1s/3s/2s while active and 15s while idle; unsupported
capabilities stop polling. The memoized leaf isolates this work from session-tree
renders. Hidden/runtime-button-free footers do not mount its observers. Shared
web/desktop and hosted/native-mobile sidebar surfaces consume Host state;
standalone VS Code has no Host import/index capability.

The sidebar does not discover or refresh GitHub PR status. Session-tree mounting,
project/worktree expansion, and session updates must not request PR auth/status
or subscribe to PR-store projections. The obsolete PR request effect and group
badge/tooltip plumbing have been removed; group labels and branch subtitles remain
local metadata. GitHub API capabilities outside this sidebar are unchanged.
`SessionSidebar.actions.performance.test.tsx` guards this dependency boundary.

Session menus no longer offer opening a conversation in the side panel. The
Electron Mini Chat Window action remains available; subtask and review panels
retain their existing behavior independently of the sidebar menu.

Inline renaming belongs to the row instance that started it. When a session is
visible in both Pinned/In Progress and its project, only the originating row
renders the editor, focuses it and selects its title; the duplicate stays a normal
row. Both context-menu Rename and mouse-focused Enter preserve this ownership.

Root session context menus offer **Mark as unread** for read sessions (including
an already selected session), and **Mark as read** for unread sessions. This
action sits immediately below Pin/Unpin and does not open the conversation.
Rename follows the read/unread action on desktop and mobile; child sessions that
omit read/unread place Rename after Pin/Unpin.
The action shares the notification store's server-backed
attention projection and reports failed writes without changing the existing
badge. Manual reminders remain unread through remote snapshot refreshes until
the conversation is subsequently opened/refocused. Child sessions omit the action.

Session right-click menus and their portaled submenus use
`yuri-session-context-menu`. With Electron window vibrancy active, every shared
popup surface uses the solid theme elevated fill so underlying session titles
cannot compete with menu labels. The native `data-yuri-vibrancy` marker is the
only material gate, independent of device-class initialization. Session menus inherit that rule
through `yuri-popup-surface`; non-vibrant runtimes retain the shared 50% fill, and
reduced-transparency mode remains opaque.

Sidebar numeric shortcuts and global-search hints share `Kbd variant="hint"`.
The variant owns the sidebar's compact 14px pill, 10px sans-serif label and neutral
6% foreground fill; consumers do not maintain their own shortcut color/size recipe.
The row render callback invalidates memoized groups when the numbered focus-key
assignments change, including changes caused by earlier projects or the top section.
Equivalent assignments retain its identity even when the session model refreshes;
hints and keyboard activation must always use the same current numbered snapshot.
Collapsing the whole sidebar retains its last committed navigation snapshot for
both numbered and adjacent-session shortcuts, including pinned/in-progress rows.
Hidden activity subscriptions remain disabled; focus reconciliation waits until
the sidebar is visible rather than treating gated activity as an empty group.
Reopening refreshes the snapshot, and switching instances clears retained targets.

## Refactor result

- Title shimmer requires the Host's `isGenerating` plus an unexpired
  `generationExpiresAt`. Admission and retry backoff do not shimmer. An active
  row arms one deadline timer (no polling); missing cleanup events cannot leave
  the title loading indefinitely. Old loading flags without a deadline are inert.

- Desktop update downloads close the update dialog immediately and continue in
  the store. The footer uses a transparent, theme-foreground update button and
  replaces the download icon with a context-style progress ring within the same
  mini 20px button with a 14px ring (percentage in the tooltip), then reopens details
  for errors or restart confirmation; closing the dialog never cancels downloads.
  The private `SidebarUpdateButton` owns update subscriptions and ring rendering;
  progress does not rerender the footer or device shortcut. Hidden update buttons
  are unmounted. Ring animation uses CSS without Effects or timers.
  The downloaded/restarting action uses a compact icon-only layout and
  uses the same transparent resting `Button variant="ghost"` as other footer
  controls; hover/press feedback and the single-restart guard remain intact.

- Leading New / Schedule / Assistant navigation rows use explicit `px-2` so
  `Button`'s direct-SVG padding rule cannot shift the Assistant row when its icon
  becomes an image. Avatar artwork scales to 125% inside the unchanged 16px slot;
  all three labels retain the same left edge in both avatar and fallback states.
  On desktop layout (Electron and web, not fullscreen) those rows, plus GUI
  titlebar items, sit in a `shrink-0` block under the brand header and outside
  `SidebarProjectsList`, so they stay fixed with the logo. The brand row itself
  stays Electron-only. Mobile, fullscreen, search, and VS Code keep the rows in
  the scroll body (VS Code still omits them).
- Official GUI `TitlebarItem` contributions appear immediately below Bots and
  before pinned/in-progress sessions as icon-and-label rows. Their leaf component
  owns the GUI subscription; SessionSidebar does not subscribe to plugin state.
  Icons follow the official named-icon contract rather than package-image metadata.

- `DeviceConnections` owns the settings-adjacent desktop/phone shortcut. Its
  hover/click popover fetches the active runtime's authorized devices only while
  open; failed refreshes retain the previous snapshot with an error message.
  Device rows include only live authenticated event-stream connections reported
   by the host, excluding the local desktop and the authenticated current device
   identified by the host's `currentClientId`. The panel refreshes every five
  seconds while open and never treats missing presence support as empty success.
  The non-persisted
  `devicePairingRequested` UI intent opens the existing remote-instance pairing
  dialog and is consumed once by that page. Runtimes without `clientAuth` omit
  this shortcut. Its outer popup uses the shared `yuri-popup-surface` frost and
  light elevation; device rows stay transparent rather than nested material cards.

- Navigation loading includes live busy/retry descendants and Agent-owned running shells through `useSessionActivity`; a parent remains loading after its own reply completes while background subagents or shells run. Shell indicators are limited to the owning session's latest authored user round; older processes continue running without keeping the row loading. Shell owners and their ancestors share the same projection, without changing the parent's raw execution status. `useRunningSessionIds` uses the same shared tree projection for pinned/in-progress and always-visible rows. Execution reads the parent's own status. Manual transcript refresh remains available during busy/retry so missed terminal events cannot block recovery.
- `SessionSidebar.tsx` now acts mainly as orchestration; core logic moved to focused hooks/components.
- Sidebar is now a single multi-project tree: an optional pinned + in-progress
  top section, then projects, then worktrees/archived groups, then sessions.
  Pinned sessions render in both the top section and their original project
  groups. The shared `pinnedSessions.ts` module owns both top-section helpers:
  `derivePinnedSessions` for the pinned group and `listInProgressHomeSessions`
  for the unlabeled in-progress/unread group below it. Running and unread
  sessions still remain in their project groups — the in-progress rows are an
  additional lift, not a move. Mobile projects home uses the same contract
  together with `createSessionOwnershipIndex` for session→project assignment
  and `buildSessionTree(..., { omitPinnedSessions: false })` so
  pinned roots remain in project/worktree lists and their counts.
  Parent/child attachment runs on the full session list. Top-section pinned rows
  stay flat (no expand chevron, no nested subagents), while their original project
  representation retains the normal parent/child tree.
  Top-section hover cards resolve project and branch from session ownership
  (`resolveTopSectionSecondaryMeta`) independently of project-tree rendering.
- Pinned rows reorder only inside the pinned group; in-progress rows remain outside
  that scope. PC uses mouse drag, mobile uses a 350ms hold with 6px movement
  tolerance. A quick swipe still scrolls/reveals row actions. The same DnD scope
  locks motion to the vertical axis on PC and mobile. Native mobile emits a
  medium haptic on drag activation and a light haptic on release/cancel, bypassing
  streaming-haptic cadence so both interaction boundaries receive feedback.
  The same DnD scope
  and preview serve desktop, mobile home, and the session sheet. The preview is
  portaled to `document.body`: mobile glass/backdrop-filter establishes a fixed
  containing block and otherwise offsets both the overlay and collision geometry.
  Mobile session menus open from the three-dot button, not long press.
  Project dragging is unchanged. Inline rename disables pinned dragging.
  `SessionNodeItem` owns the single sortable row wrapper. The pinned section
  supplies only its DnD scope: wrapping the renderer output again registers the
  same id twice and applies sibling/active translations twice, drifting text out
  of the intended slot. Mobile home supplies one wrapper around its plain row.
- The Host persists session orders and activity baselines via
  `GET/POST /api/session-folders/order`. `useSessionOrderSync` projects the runtime
  Query snapshot into the existing sidebar store; SSE order tips, reconnect, and
  foreground refresh reconcile other clients. Legacy local scopes import only
  when absent on the Host. Failed saves roll back their scope and show an error.
  `__pinned__` is the pinned scope: activity never promotes it, and unranked pins
  follow saved rows in creation order. Directory scopes retain the existing
  manual-order/activity-promotion rule on desktop and mobile. Pagination controls
  and project rows are not session drop targets. Missing/unpinned ids are ignored
  without pruning partial snapshots. VS Code retains local directory ordering
  and has no pinned group; older Hosts without the order route reject saves.
- The top section renders every pinned session plus unlabeled top-level running
  and unread rows, and supports header collapse. Running descendants keep their
  root conversation active through the shared activity projection, but are never
  independently promoted here, including when their parent is missing. Its title becomes
  pinned/in-progress when the in-progress group is non-empty. Web, desktop,
  VS Code, and mobile home share this contract; VS Code still has no global
  pinned group but does show the in-progress rows in this top section.
  Expanded project/worktree
   groups reveal 3 sessions by default from the already-fetched 20-session page;
   Show more reveals cached rows before loading the next 20-session page on demand.
   Once expanded past the default page, Show fewer is available alongside Show more
    so the list can fold back without loading every remaining row first. Always-visible
    sessions (busy/retry live status, plus fallback global busy/retry entries, plus the
    current viewing session) from the loaded snapshot remain visible beyond the folded
    boundary. That fold-boundary rule is owned by `hooks/useAlwaysVisibleSessionIds` and
    `selectVisibleSessionNodes` / `selectVisibleSessions`; the mobile sessions sheet,
    projects home, and status-bar group lists share the same contract. Project/worktree
    collapse toggles are unrelated — only the Show-more fold keeps those rows visible
    while the group is expanded.
- Project/worktree Show more first reveals already-fetched rows, then fetches the next 20-session page for its own directory at the local boundary.
- Virtualized groups share the sidebar scroll element. `getTotalSize()` excludes the group's ancestor offset, but scroll offsets and item positions include `scrollMargin`. Preserve those ancestor coordinates when scrolling to a group; do not clamp to the group's height alone. The official unpatched virtual-core is used. `virtualizerScrollMargin.test.ts` covers ancestor offsets, bounded initial end positions, and repeated Show more.
- The mobile session tree shows 20 root sessions by default for projects without worktrees. Projects with worktrees show 5 sessions per root/worktree bucket by default; Show more and Show fewer use that bucket's default page size. Collapsing and reopening a project or worktree preserves its revealed session count until Show fewer is selected or the sessions surface closes.
- Mobile projects home performance contract (reference isolation, not full stop): `mobileSessionTreeNode.ts` structurally shares tree node objects (`reuseMobileSessionTreeNode` / `reuseMobileSessionTreeNodeList`) so parent model rebuilds (running set / unseen map / directory churn) do not allocate a fresh node per unchanged row. `MobileSessionRow` is `React.memo`'d with `areMobileSessionRowPropsEqual` (identity-stable `session` + callbacks). `MobileProjectsHome` memoizes live rows and session lists against parent identity churn. This reduces paint work when references are stable; it does **not** claim that hiding the home surface unsubscribes every home store or stops all background derivation. Closed recent-sessions sheet list gating lives under chat `MobileSessionStatusBar` / `mobileSessionStatusBarList.ts`.
- Mobile project/worktree rows retain their long-press action panels. Session
  rows use long press for sorting within their list and the visible three-dot
  button for their action panel. Web session rows retain their desktop context menu.
- Project rows retain the persisted project-registry order while session and worktree data hydrates. Manual drag and conversation activity are peers on the current order: drag writes both the registry and `manualProjectOrder`; successful sends and live session status transitions promote the owning project on both lists while preserving the remaining relative order. Status transitions compare against the directory child-store status, falling back to the global live status map for unopened directories. Duplicate status events, hydration, and ordinary selection preserve the current order. Settings sync adopts the incoming registry and prunes removed ids from the local manual order. Explicit alphabetical/date/recent display modes retain their own comparators; drag is available in manual mode.
- Worktree conversation activity also promotes that linked worktree within its project. Desktop drag and activity write `useWorktreeOrderStore`, shared with mobile and Host synchronization. `useGroupOrdering` projects shared paths over worktree slots, falling back to legacy group preferences before shared order exists; main workspace and archived bucket placement remain unchanged.
- The Projects section header no longer shows a global syncing accessory. While a
  project's session directories are fetching, that project's folder icon swaps to a
  spinner. The expanded body shows localized "Loading sessions…" only when there is
  no usable snapshot; background refresh keeps the existing rows visible.
- `SidebarProjectSection` is the memo boundary between list orchestration and a
  project's sortable header/body. It receives stable group arrays, callbacks and
  project-local booleans; unrelated top-section renders do not execute its Hooks.
  Project loading/refreshing subscribe to boolean membership in that project's root
  and known worktree directories. `SessionSidebar` only observes whether any
  directory is pending for focus reconciliation. Loading flags can repaint the
  relevant header without recreating its group elements. Sensor option objects
  retain their identity so real `useSensor`/`useSensors` results do not invalidate
  that body memo. Event adapters use
  `useEvent`; render callbacks retain their semantic invalidation dependencies.
  `SidebarProjectsList.performance.test.tsx` covers 50 unrelated parent commits,
  50 other-directory store updates, same-project loading, retained row DOM and
  fresh action callbacks with the real sensor Hooks. Menu and tooltip presence never changes the
  row's or title's ancestry: conditionally wrapping an already-focused or dragged row would remount that DOM.
  `SessionNodeItem` renders the row itself with `sessionRowContextMenuTriggerProps` (right-click at
  the pointer, still touch long press, iOS callout suppressed) and mounts `SessionRowContextMenuRoot`
  beside it only from a menu request until the exit finishes. The root opens on the commit after it
  mounts so the enter transition still plays. The title hover card keeps its always-mounted root.
- Row action tips (pin, unpin, archive, open in editor) mount on the first mouse/pen hover of the
  row or keyboard focus of its title; `mobileVariant` mounts them eagerly. Before that the buttons
  render bare with their accessible labels. Arming remounts only those buttons, so it waits while
  one of them holds focus. In production React (Chrome, 4× CPU throttle, 200 rows with real drag
  Hooks) idle per-row menu and action-tip roots made up about half of row mount and unmount time.
- `useSessionSidebarSections` structurally shares the last committed project's
  JSON model, matching projects and groups by id. Unchanged groups and nodes retain
  references across other-project updates; removed projects leave
  the retained snapshot. The empty search map is shared. This bounds retention to
  one committed tree and prevents unrelated group renders; it does not eliminate
  upstream grouping calculations. Group event callbacks take the group explicitly
  so the parent does not allocate an adapter for each render. Folder subscriptions
  select only that group's folder scope.
- Downstream derivations keep those references, so one project's update (a turn
  ending, a title refresh) re-renders only that project's section. Removing the
  archived bucket for the tree derives per source section (`withoutArchivedBucket`,
  a module-level `WeakMap`); `renderGroupSessions` depends on the focused target's
  primitive fields, not the rebuilt target object; `useAlwaysVisibleSessionIds`
  keeps its previous set while the membership is unchanged; the project
  `SortableContext` receives an `items` array that is only replaced when the order
  changes, because a new array republishes its context to every project header's
  `useSortable`. Mod+1…9 slots reach rows through the per-sidebar
  `SidebarShortcutNumberContext` store (`sidebarShortcutNumbers.ts`); each row
  selects its own Focus key, so renumbering re-renders only rows whose slot changed
  and `renderSessionNode` keeps one identity for the sidebar's lifetime.
- `SidebarMaintenance` owns session-order synchronization and complete-catalog
  folder cleanup subscriptions. Catalog generation/loading changes do not subscribe
  the visible tree's parent to those maintenance-only inputs. Existing complete-
  catalog and hidden-sidebar cleanup rules still apply. Update progress subscribes
   inside the mounted update dialog; the parent selects only update-button visibility.
- Project expand/collapse, manual sync and draft actions use stable `useEvent`
  callbacks at the project boundary. Directory collection stays a render-time
  memoized function, so topology changes still rerun expanded-project hydration.
  Navigation intent owns automatic reveal; callback identity does not re-arm it.
  `SessionSidebar.actions.performance.test.tsx` guards 50 catalog-driven parent
  renders and confirms the click uses the latest loader.
- Tooltip handle migration is not a drop-in replacement for this application's
  wrapper: touch/pen long press and click suppression currently use the ancestor
  `LongPressTooltipContext`. A detached trigger outside that ancestor loses those
  handlers even when Base UI's handle connects it to a mounted Root. Keep the current
  roots until a shared implementation covers touch cancellation, trigger handoff,
  unmount cleanup, first hover/focus and stable button DOM.
- Runtime session index cold start first hydrates through TanStack Query SWR + a
  runtimeKey-scoped client cold-start snapshot (stale paint only), then the
  authoritative SQLite-backed `GET /session-index`, then asks the runtime-owned
  Web Server to refresh the newest 20 root sessions for every persisted project
  root and known worktree directory. Server SQLite + GET remain authoritative:
  a failed GET keeps the last good seed rows; a successful empty snapshot can
  clear them. The browser never fans out project `session.list` calls. The
  server uses one preemptible background lane; selected-session detail/message/
  children requests abort that lane, run first, and let the directory resume
  afterward. Git/worktree discovery is not part of session startup. Archived
  sessions remain a separate lazy path.

  When the session-index API is unavailable (501), the coordinator falls back to
  the existing SDK-backed global session list; unsupported `null` must not be
  treated as an authoritative empty success that wipes the client seed.
- Cached starts use OpenCode's `start` timestamp filter and merge only sessions
  changed since the last successful sync, and only when that directory already
  has at least one cached root summary. An empty cached directory is not
  incrementally eligible, so a later refresh can rediscover historical roots
  whose `time.updated` is older than `lastSyncedAt`. SQLite separately tracks
  the last incremental and last full reconciliation times; a full newest-20
  pass also runs at most once per 24 hours to remove sessions deleted or
  archived while the app was closed.
- `SessionStartupCoordinator` owns that pass before `SessionSidebar` mounts its
  normal orchestration. Hydrate of the SQLite session-summary index starts
  immediately (does not wait for settings) so the last snapshot can fill the
  sidebar before OpenCode finishes initializing. Directory planning and the
  background root refresh still wait for registered settings hydration, then
  read the latest persisted project paths so an initially empty renderer store
  cannot release the startup barrier early. After starting the server job, the
  UI observes SQLite revisions through Yuri tip events + GET. When SQLite
  has rows the startup logo releases as soon as those rows land in the store;
  validation continues with cached rows visible. A first run with an empty index
  waits until hydrate settles and OpenCode init (or the blocking root sync)
  completes; sidebar code must not start another hydrate or list cycle.
- Project collapse state controls presentation only; Electron session-summary
  refresh targets come from the persisted project index, so no collapse/re-expand
  gesture is required to make a project appear.
- Project, labeled session-group, and folder bodies use controlled Base UI
  Collapsible panels with a 200ms ease-out height transition. Existing headers
  and persisted collapse state retain ownership; search-expanded groups/folders
  retain their open behavior. Body spacing sits inside the animated panel so
  the occupied height reaches zero. Closing bodies become inert immediately
  and unmount after exit; reduced motion disables the transition. Virtualized
  groups re-measure on actual body mount, refresh their ancestor-scroll offset
  when a sidebar height transition ends, and release their scrolling subscription
  after the closing body unmounts. Dedicated mobile pages keep their own behavior.
- Renderer-level worktree catalog reconciliation runs after event-stream ready,
  topology changes, and deduplicated unknown session directories. The sidebar
  consumes that catalog and retains `yuri.worktreeMap` as its cold-start snapshot.
- Each project menu provides a session-sync action. It refreshes the project's
  root and known worktree directories through the Electron server-owned index
  queue, while Web and VS Code use the bounded SDK refresh fallback.
- Each session context menu provides a transcript refresh action ("Sync
  messages"). It fetches an authoritative OpenCode tail and replaces that
  session's visible transcript only after the fetch succeeds. Failure keeps the
  prior transcript. Busy/retry sessions disable the action. This is not the
  project session-list sync.
- The native tray consumes the sidebar/global cache and lightweight global status; it does not trigger a delayed all-project session-list fanout.
- Mounting active or archived session rows creates only lightweight child-store
  subscriptions (`bootstrap: false`). Routed live status/permission events still
  update those rows, while config/path/session bootstrap remains owned by the
  active chat instead of fanning out across every visible sidebar directory.
  Selecting a session never fetches its children; child sessions are loaded only
   when the user expands the parent tree control. Every explicit expansion refreshes
   that parent's children, even if some are already known from live events. Concurrent
   loads coalesce through Query; the loader follows official `session.list` parent-filtered
   pages until exhaustion. Mount, selection, restored expansion state and collapse do not
   fetch children. Loading is shown on the chevron; failure preserves the tree and offers
   retry by collapsing/re-expanding. Sessions with a `parentID` are
  never promoted to project roots — if the parent is missing, archived
   differently or system-owned (e.g. scheduled-task), the
   child stays hidden instead of leaking into the main list.
   The sidebar's live aggregate uses `includeChildren: true`; the ordinary global
   catalog remains root-only. This distinction is required between the on-demand
   loader's directory-store commit and `buildSessionTree`, otherwise fetched
   children are filtered out before they ever reach the expanded row. Loaded
   child identities survive subsequent live updates while system isolation still applies.
- Tray status is event-first. Its startup/reconnect compensation waits for an
  established OpenCode connection, coalesces overlapping refreshes, and queries
  at most two directories concurrently; the 30-second poll is only a missed-event
  safety net.
- An idle global-session store always triggers a priority refresh, including after a runtime endpoint reset; the status therefore cannot remain idle after the sidebar's one-time mount effect has already run.
- `NavRail` is no longer part of sidebar/navigation flow.
- Visible sidebar Scheduled/Assistant navigation entries reuse `SessionBusyIndicator`
  as a trailing activity ring. Assistant activity selects server snapshot
  `working` / `activeContactTurn`; its unread badge remains independent. Scheduled
  activity selects current catalog `lastStatus: running`, refreshed on run events,
  reconnect, and foreground reconciliation (2.5s busy / 15s idle). Leaf observers
  unmount while the sidebar is hidden and do not subscribe the session tree to activity.
- Project headers now own root sessions directly; there is no separate rendered `project root` subgroup.
- Active/hover rows use Codex-style inset neutral chips (`SIDEBAR_ROW_*`); light mode
  uses a soft wash (hover ~3.5%, active ~6%) so cream themes stay airy, while dark keeps
  a slightly deeper wash (hover 8%, active 11%) so the two states still read apart. Nested
  rows indent via padding *inside* the chip so hover/active wash stays full-width
  (reserved left gutter). Depth 1
  uses the folder icon column (`16 + 6`) so all project sessions share one vertical line under the
  parent folder *name*. Deeper levels (subagent) add ~one UI-label font size (`14px`) each.
  Worktree/archived group headers reuse the same folder chip chrome (hover wash + depth-1
  nest pad) so they share one vertical line with sibling folders; their direct sessions/folders
  keep that same depth so worktree items align with surrounding project items. Subsession
  expand chevrons align to the folder-icon column and stay hidden until row hover (unless
  always-show-actions). They render only when the session has loaded children or the
   persistent session index has confirmed that it has at least one child. A live
   snapshot that omits `hasChildren` retains the index's availability hint.
  Pinned rows stay flat: no subsession chevron and no nested children.
- Session rows are single-line (no inline timestamp); details (title, relative time, folder/project,
  branch) open in an immediate floating hover card. Top-section (pinned / in-progress) rows
  always populate that project and branch from ownership, not from the omitted project-tree index.
  Project-tree rows, including sessions inside folders, use the owning project's
  display name for the folder-icon line, never a worktree/group or folder name;
  the branch remains separate. Project-name changes invalidate the group memo.
  A shared `TooltipProvider`
  (`delay=0`, `closeDelay=150`, `timeout=600`) groups row tips so adjacent handoff
  is instant; per-row tooltips do not nest their own Provider. Pointer click keeps
  focus for Enter-to-rename until focus moves elsewhere.
- A session title button focused by an explicit mouse click enters inline rename
  on Enter. Keyboard or programmatic focus does not arm this shortcut, and blur
  clears the mouse-focus authorization.
- Inline rename cancels on blur outside its controls; Enter or the check button saves.
  Double-click reuses the context-menu Mini Chat action for that session on Electron;
  other runtimes do not act on the double-click.
- Compact relative times use `common.relative.*Compact` i18n keys.
- Row action icons (pin, archive/delete) use title-matched `h-3.5` glyphs with `gap-1` spacing; the title
  reserves right padding on hover so icons own their space — no fade veil behind them.
  The former three-dot overflow menu is a direct archive control; hold Shift to hard-delete
  (archived buckets always show delete). Rename/share/folder and other actions remain on the
  row context menu.
- Session busy/unread/question status is a trailing shrink-0 marker on the right of the title
  (highlighted `question` icon while an ask-tool question is pending, ContextUsage-style
  track+arc ring while busy, info-colored unread dot when idle+unseen). Pending questions
  outrank the busy spinner because the session is waiting on the user. The unread dot stays
  on the selected row; opening the session does not by itself mean the just-finished turn
  was seen. It owns its own
  gutter so long titles truncate before it, and hides instantly on row hover (no
  opacity/padding transition) when hover/always-visible row actions take that edge.
- Archived groups are collapsed by default and support bulk deletion at group/folder level.
- Session rows support compact inline dates in minimal mode and simplified metadata in default mode.
- Session-row visual selection is published through a narrow row-only Focus store before authoritative navigation. Focus includes the render scope (`pinned` or `project`) plus session/project identity, so duplicate representations never both receive the Active background or satisfy the wrong paint barrier. On desktop, focusing a fully visible session preserves the sidebar scroll position; a partially or fully out-of-view row smooth-scrolls to about one-third down the sidebar viewport (`scrollFocusedSessionRow.ts`). Mobile keeps `block: 'nearest'`. Reduced-motion users get an instant jump.
- Project navigation follows the router's `/session/new` draft target, not a
  search-owned DOM command. `SessionSidebar` projects the draft's selected project
  ID and existing navigation-intent revision into `SidebarProjectsList`; only the
  desktop Chat primary requests a reveal. The list locates that project's header
  inside its own scroll viewport and reuses `scrollFocusedSessionRowIntoView`.
  Already-visible headers do not scroll. Each request is consumed once after its
  header mounts, including delayed project hydration and reopening the sidebar;
  later catalog/status/collapse updates never re-scroll. A new intent can reveal
  the same project again. No project reordering, expansion, session loading or
  independent selection state is added. Search-filtered trees wait until their
  filter clears; mobile and VS Code's headerless main-workspace view are unchanged.
- Previous/next-session navigation consumes ordered snapshots published from the rendered sidebar model and cycles one combined ring: visible pinned rows first, then the logically visible project rows in sidebar order, wrapping across both sections. Rows hidden by pinned/project/group/folder collapse or the group's Show more boundary are excluded, while always-visible (busy/retry + current viewing) rows retained beyond that boundary remain keyboard targets.
- Global Mod+1…9 navigation numbers the first nine logically visible session rows from top to bottom across Pinned and the expanded project tree. Container headers never consume a number; duplicate Pinned/Project representations remain distinct Focus rows. Holding the platform primary modifier for 500ms reveals compact shortcut chips only on those rows; each chip occupies only its intrinsic width and replaces row quick actions until release. Releasing the modifier, window blur, or page hide clears the hints immediately.
- Task view: on desktop/web (not mobile, VS Code, main-workspace-only or while searching) the Projects label slot holds a Tasks / Projects switch (`SidebarViewSwitch.tsx`; the choice persists globally, not per instance, in `yuri.sessions.sidebarView`). Tasks replaces the project tree with one flat active list (`SidebarTaskList.tsx`) plus the Settled shelf, built by the pure `taskView.ts` partition: subtask and pinned rows stay out; a session the Host index does not hold (older rows pulled in by browsing the project view) stays out unless it is running or has a pending request, and is not filtered while no index snapshot is loaded; a project-view (real) archive never joins the active list and is listed on the Settled shelf instead (its row offers a real unarchive), and the shelf is ordered newest archive / settle time first; a running session or one with a pending question/permission is always active (running rows carry the status word, there is no separate In progress shelf); otherwise the Host `time.settled` projection decides. The pinned / in-progress section is part of the active tab: it renders directly under the switch (`SidebarProjectsList`'s `tabLeadingContent`) in both views rather than above it, and falls back to `topContent` only when the switch is not available. Rows are ordinary `SessionNodeItem` rows in `project` render context, whose Archive button and menu item call `setSessionSettled` instead of hiding the session when the sidebar passes it (card and slim rows only; an archived-shelf row offers move back to active). The UI never says "settle": in the task view Archive means the Host `settled` state, which never removes the row, clears a pin or writes archive metadata; the project view keeps the real archive. Dragging rows in the active list reorders them in memory only (`taskTransientOrder.ts`): a moved row's place is forgotten the first time its activity, running or attention state changes, so session updates re-rank it normally; nothing is persisted. While the task view is active the pinned section keeps pinned rows only (running rows are in the active list), and the published navigation snapshot and Mod+1…9 targets use the task view's logically visible order (active list, then the open Settled page; a collapsed shelf contributes nothing) so keyboard session switching follows the layout on screen. Remote Project sessions are not in the task view yet. Mobile (`packages/ui/src/mobile/projects`) reuses the same `deriveTaskBuckets` and Host `time.settled` projection, and says Archive, never settle: the large page title on the Projects home is a dropdown (`MobileHomeViewMenu`, choice persisted in `yuri.mobile.homeView`) that switches between the Projects tree and the task view. The task view (`useMobileTaskViewModel` + `MobileTaskCard`) renders one independent glass card per task (no shared list surface), pinned first, then active: project badge, one status slot (time, `Running 3m`, or the amber waiting chip), title, and the branch line (worktree branch, else the project root's current branch from the shared git store, requested on demand while the view is open) with the pin icon at its end. There is no swipe rail and no new menu item: the existing `...` button and long press open `MobileRowActionsSheet`, and in the task view its Archive item archives in place (`setSessionSettled`, with an Undo toast) instead of the real archive. Archived tasks are a collapsible block at the end of the page (`inbox-archive` icon, count, chevron), not a floating bar: single-line rows with a restore button and a paged Show more (`SETTLED_SHELF_PAGE_SIZE`). Active rows are two-line cards (t3 code sidebar v2 model): `secondaryMeta.card` makes `SessionNodeItem` add a detail line (status word, project, branch, compact time) from live row state it already subscribes to. Waiting-on-you (amber) and working (sky) show one status chip (icon + word) at the top right in place of the bare marker, and nothing else on the row repeats it (no second status word, no permission badge); the pinned section renders the same card rows in the task view (`pinnedSectionItems`, built by the same cached task-row builder, same order, remote rows untouched). Ready is unlabeled and an unread title turns medium weight; in-flight titles keep the normal colour. Settled rows are small, quiet single lines (`secondaryMeta.slim`: smaller title, muted, compact time on the right), and the Settled shelf (`SidebarSettledShelf`) is pinned to the bottom of the sidebar outside the scroll area through `SidebarProjectsList`'s `taskFooter`; collapsed it is one header row, open its rows scroll inside a `40vh` cap. Cost rules: `SidebarViewSwitch` animates only its two buttons through a `0fr→1fr` grid track (no measuring, `motion-reduce` safe); the Settled shelf builds and renders one page at a time (`SETTLED_SHELF_PAGE_SIZE`, "show more" extends it, ⌘ navigation follows the same limit); task `PinnedItem`s are reused across rebuilds through a per-session input cache so memoized rows keep their references; the switch carries no attention dot.
- Every session navigation announces a monotonic intent revision. A later sidebar, keyboard, deep-link, or switcher intent invalidates an older pending sidebar commit, including ABA sequences such as A -> B -> A.
- Switching between Tasks and Projects (shortcut or tab) keeps the routed conversation unchanged. Local focus resolves against the destination's rows: a Projects-only In Progress copy hands off to its task card, and a pinned session missing from the flat task list focuses its pinned row. The mounted row uses the ordinary viewport-aware focus scroll. Returning to Projects permits one new ancestor reveal for the same navigation intent; background refreshes do not re-arm it and the switch does not open the archived task shelf.
- Within one visit to Projects, project/group/folder ancestors are auto-expanded at most once for each navigation intent. Explicitly collapsing the project that owns the focused session remains respected during later hydration or persistence refreshes.
- Chat LRU visibility follows the authoritative selection synchronously: cache hits reveal the retained Activity immediately, while misses show an explicit skeleton. Constrained surfaces retain two 16 MiB views; geometry cache reuse keys on complete runtime, directory, and session identity; active-view estimates alone record cache size and trigger trimming. A newly rendered Activity enters the bounded LRU only after its DOM commit, so interrupted keyboard switches cannot evict a reusable view.
- New extractions in latest pass reduced local effect/callback bulk further:
  - project session list builders
  - folder cleanup sync
  - sticky project header observer

## VS Code grouping

- VS Code uses the **same grouped project tree** as web/desktop (project headers + folders + pinned-first ordering), not a separate flat list. Each open VS Code workspace folder is a project header.
- VS Code groups strictly **by open workspace**: `useSessionGrouping` funnels every non-archived session into the project's root group and emits **no per-worktree subgroups** (worktrees aren't registered in VS Code). `getSessionsForProject` buckets sessions to a workspace by exact directory match, so only sessions whose directory is an open workspace folder appear.
- VS Code passes `hideDirectoryControls` (clean workspace headers, no worktree/close chrome) and no longer passes `showOnlyMainWorkspace`/`sharedSessionsOnly`. Folders and pinning therefore work natively, scoped to the workspace root.
- VS Code still renders no global pinned group and no leading New Session/Scheduled/Assistants buttons, but does render the shared top section's unlabeled in-progress rows (busy/retry or top-level unread) above the project tree.

## File summaries

### Components

- `SidebarHeader.tsx`: Optional session-search field only (action toolbar removed).
- `GlobalSearchButton.tsx`: Shared command-palette trigger. Electron with a configured logo renders it in the fixed (non-scrolling) sidebar brand row while open; otherwise it sits next to the titlebar collapse control (web parity, including logo-less Electron).
- `TitlebarLeftControls.tsx`: Persistent Web brand and sidebar-toggle controls, plus Electron global search when the sidebar is collapsed or no logo is configured. Fullscreen Electron uses the Web single-row brand/search/toggle layout and hides the separate sidebar brand row. `useDesktopWindowFullscreen` shares the authoritative native fullscreen state with the header inset and sidebar through one resize subscription.
- `SessionSidebar.tsx` desktop brand header: When a logo/wordmark is configured, Electron renders brand + search above `SidebarProjectsList` (`shrink-0`, outside the scroll region). Empty brand config reserves no row and leaves search in the titlebar. The same non-scrolling block holds New / Schedule / Assistant (and GUI titlebar items) on any desktop layout, including web, even when the brand row is absent. Mobile, fullscreen, and an open session search keep those rows inside the scroll body. Sidebar brand text is persisted in Host `settings.json` (`sidebarBrandName`) and mirrored in instance-scoped localStorage (`useSidebarBrandStore` via `yuri.inst.{runtimeKey}.sidebar-brand-store`, migrating legacy `yuri.rt.*` entries on first read) so SSH port churn, direct⇄relay switches, and Electron restarts/updates preserve each host's wordmark while packaged multi-window local and remote hosts stay isolated.
- `SidebarTopBar.tsx`: Desktop titlebar strip with preserved window-drag regions beneath the persistent titlebar controls.
- `SidebarDisplayModeMenu.tsx`: Project collapse/expand overflow menu; rendered in the Projects section title row beside the add-project action.
- `SidebarPinnedSessions.tsx`: Global top-section renderer for pinned sessions plus the unlabeled in-progress/unread rows below them.
- `SidebarViewSwitch.tsx`: Two-segment Tasks / Projects switch; only the selected segment shows text.
- `SidebarTaskList.tsx`: Task view body (active list and the Settled shelf); an empty shelf renders nothing.
- `SidebarAnimatedRows.tsx`: Row add/remove animation for the task list, Settled shelf, pinned / in-progress section, non-virtualized project-tree groups and folder rows. Virtualized groups (30+ active, 50+ archived rows) do not animate. Rows collapse and expand in height and opacity with a 200ms tween, never a spring. A commit that adds more than three rows mounts them without an enter animation; one that removes more than three drops them at once. Rows already mounted never animate in. Opacity stays on motion's frameloop (not WAAPI) so it starts on the same frame as the height collapse, after the long frame that commits a session switch. `withoutRemovedRows` lets `SessionSidebar` drop rows the live session list removed (archive, delete) in the same commit as the action, instead of after the deferred (`useDeferredValue`) list render that navigation keeps interrupting; removals of more than three rows stay on the deferred lane. The wrapper must take exactly the row's space through the whole animation: it clips with `overflow: clip` (no new formatting context, so the row's 2px `my-0.5` margins keep collapsing as at rest), repeats the row's bottom margin, and at zero height cancels the gap above it with a negative top margin. Neighbours therefore move monotonically and do not shift when an animation starts, ends or the row unmounts. Browsers without `overflow: clip` (Safari 15) fall back to `hidden`, which shifts neighbours by the row margin.
  When membership is unchanged, only rows whose keyed positions changed get a 200ms directional slide inside their destination slots. Translation and clipping move together so adjacent cards cannot cross; no DOM positions are measured. A newer move replaces an in-flight slide. This is disabled for reduced motion, lists above 300 rows, a bulk reorder affecting more than 24 rows, exiting rows, and during the drag-to-reorder lock (`SessionListReorderLockContext`, provided by `SessionFolderDndScope`, remains locked for 400ms after drag end).
- `taskView.ts`: Pure partition of sessions into active / settled and the logically visible task order used by keyboard navigation.
- Remote projects in the task view: while it is active, desktop and mobile mount one headless `RemoteProjectSection` per remote project (`onTaskItems`) instead of the project tree. It publishes unarchived root sessions from that Host's summary snapshot and renders only the rename/delete dialogs its row actions open. Both task views pass unpinned remote rows to `deriveTaskBuckets({ remoteSessions })`, so they rank with local rows without filtering by local index or settle state. Mobile uses the same task card surface and its existing filters, with the shared compact Host tag next to the project name; the project mark stays unchanged. Remote actions stay scoped to the Host; Archive is a real remote archive, not a local settle.
  Remote task cards use the desktop session context-menu styling and shared hover details; task-only actions never go through local session stores. Unknown branches leave the third line blank at its usual height rather than displaying the remote path.
- `SidebarFooter.tsx`: Static footer with icon-only settings and shortcuts actions, plus optional update button.
- `SidebarProjectsList.tsx`: Main scrollable tree renderer for projects, root sessions, worktrees/groups, and empty/search states.
- `SessionGroupSection.tsx`: Renders a single worktree/archived group, collapse/expand, folder subtree, and group-level controls.
- `SessionNodeItem.tsx`: Renders one session row/tree node with inline metadata, menu actions, minimal/default variants, and nested children.
- `ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete and folder delete flows.
- `sortableItems.tsx`: DnD sortable wrappers for project and group ordering plus project-row action affordances.
- `sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping/moving sessions into folders.
- `sidebarShortcutNumbers.ts`: Per-sidebar Mod+1…9 slot store and context; `SessionNodeItem` reads its own slot by Focus key, outside the row's props.
- `sessionNavigationModel.ts`: Flattens the rendered project/group/folder model into ordered shortcut targets, then filters them against project/group/folder collapse and Show more state so project-scoped shortcuts use only logically visible rows. Also owns `selectVisibleSessionNodes` / `selectVisibleSessions` for the compact Show-more fold (first N, then append always-visible ids past the boundary).
- `hooks/useAlwaysVisibleSessionIds.ts`: Shared running (busy/retry + uncovered fallback) and always-visible (running ∪ current viewing) session-id sets for PC sidebar and mobile session lists.
- `sidebar-numbered-navigation.ts` (sync): Publishes the global first-nine visible session target order consumed by Mod+1…9, with revision-safe responsive remount cleanup.
- `sessionOwnership.ts`: Resolves session directories once into shared project/worktree ownership and folder-scope indexes.
- Yuri projects are working-directory scopes, not OpenCode repository identities.
  Creation, selection and sidebar ownership use the deepest registered directory;
  explicit project roots beat worktree mappings at the same directory. A nested
  project such as `repo/src` maps only confirmed Git checkout roots to
  `checkout/src`, never to the checkout root. `WorktreeMetadata.path` is that
  scoped working directory; `worktreeRoot` remains the Git resource used for
  bootstrap and deletion. Main-checkout entries are excluded from each project's
  worktree list. Persisted repository-wide nested catalogs are projected before
  first paint; existing sessions are not moved or rewritten. A historical session
  already inside `checkout/src` belongs to the nested project, while sessions at
  `checkout` remain with the repository project. Directory mapping performs no
  filesystem/network reads and is refreshed by the existing bounded topology
  coordinator. Successful refreshes retain primary-repository identity separately
  from catalog entries, including empty catalogs. Events from either a parent or
  nested scope refresh every scope of that repository; unresolved event origins
  use authoritative primary-root discovery, never directory-prefix inference.
  One coordinator refresh batch shares one raw listing per runtime/repository,
  then projects each scope independently. New batches bypass the HTTP TTL; local
  mutations invalidate sibling caches and stale in-flight results. Runtime changes
  clear discovery identity and reject stale refresh commits. Enumeration failure
  retains existing catalogs and attachments. Creating a session in a mapped subdirectory checks its
  existence through the runtime file-stat Query when available; failure keeps the
  draft and never retries at the checkout root. Deleting a checkout invalidates all
  referencing project catalogs and attachments. Standalone VS Code retains exact
  open-workspace matching and no worktree subgroups.
- `manualProjectSessionSync.ts`: Builds deduplicated manual session-index sync directories from the project root, current selection, and freshly refreshed worktree catalog.

### Hooks

- `hooks/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations).
- `hooks/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- Session bodies are loaded only for the selected session. The sidebar does not
  prefetch neighboring/recent session messages because those background pages
  compete with the active chat during cold start and rapid navigation.
- `hooks/useSessionGrouping.ts`: Builds grouped session structures and search text/filter helpers.
- `sessionTree.ts`: Pure parent/child forest builder for project grouping; project consumers retain pinned roots and their descendants.
- `hooks/useSessionSidebarSections.ts`: Composes final per-project sections and group search metadata for rendering.
- `hooks/useProjectSessionSelection.ts`: Resolves active/current project-session selection logic and session-directory context.
- `hooks/useGroupOrdering.ts`: Applies persisted/custom group order with stable fallback ordering; archived groups are reorderable.
- `hooks/useArchivedAutoFolders.ts`: Maintains archived auto-folder structure and assignment behavior by reading `foldersMap` imperatively (re-running on `foldersHydrationGeneration` rather than subscribing to its own `foldersMap` writes), batching additions per folder via `addSessionsToFolder`, and preserving currently assigned archived session IDs during cleanup.
- `hooks/useSidebarPersistence.ts`: Persists sidebar UI state (expanded/collapsed/group order/active session) to instance-scoped storage (`yuri.inst.{runtimeKey}.*`) + desktop settings. Project registry order and `projectSortOrder` are Host-authoritative with instance-scoped startup caches. Desktop and mobile project lists use `lib/projectOrder.ts`; manual mode follows the registry and alphabetical modes use a fixed collation locale across devices. Session pin membership is derived from the server session-index snapshot (`pinnedSessionIds` plus in-window `time.pinned`), not localStorage.
- `hooks/useProjectRepoStatus.ts`: Tracks per-project git-repo state and root branch metadata.
- `hooks/useProjectSessionLists.ts`: Reads live and archived project buckets from the shared ownership index.
- `hooks/useSessionFolderCleanup.ts`: Cleans stale folder session IDs by reconciling known sessions/archived scopes.
- Project headers paint no background of their own. macOS vibrancy requires every
  inner sidebar surface to stay fully transparent (see `index.css`); an inline
  `backgroundColor` on the `ContextMenuTrigger` render div (previously applied to
  every project header, stuck or not) repainted an opaque chip over the frosted
  surface. Do not reintroduce per-header background/paint styling here, and do not
  add sticky-header machinery (sentinels + `IntersectionObserver`) unless a header
  actually needs an opaque stuck state.
- Folder and session-order cleanup consume the store's complete-catalog ID snapshot (`fullCatalogSessionIds` + generation). Pinned IDs come from the session-index snapshot and need no local prune. Bounded directory snapshots only drive visible rows.
- Session order is keyed by each group's `folderScopeKey` and stores the drag-time order plus an activity baseline. Manual drag and later session activity are peers on that list: matching baselines keep the saved order; only members whose activity advanced past the baseline (or that are new to the scope) promote to the front by activity while the remaining relative order is preserved. The baseline includes folded rows outside the draggable slice, so their unchanged activity preserves their position. Duplicate/stale activity refreshes preserve drag ranks. A subsequent drag captures the current visual order and a fresh baseline. Legacy orders with a missing baseline use natural activity order until the next drag. Cleanup prunes removed ids from order and activity while retaining survivor baselines. Visual rows, navigation, and sortable items consume the same scope-local effective order from `sessionSortableOrder.ts`.
- `sessionSortableOrder.ts` derives visible sortable IDs and the shared scope-local comparator from the rendered folder tree, collapsed/search state, Show-more slice, and the effective order above. Reordering stays within one folder or the ungrouped scope; folder drops own cross-folder moves.
- Visibility performance (`isVisible` prop): desktop passes `isSidebarOpen`, mobile
  passes `mobileLeftDrawerVisible`. When false, the session row tree unmounts and
  speculative work stops (live session/status aggregates, sticky headers,
  search listeners, archived auto-folders, project repo status). The
  outer sidebar chrome stays mounted so UI state and authoritative session-index
  refresh remain available for an immediate reopen (mobile always-mount for
  issue #1695 is preserved at the layout shell).
- Structural vs recency: global `upsertSession` and live-list equivalence ignore
  pure `time.updated` churn so ownership/grouping memos do not rebuild on every
  streaming tick. Title/parent/archive/directory/share/metadata still invalidate.
  Row activity continues to come from the session-keyed live status channel.
- Directory child-store eviction uses a soft `MAX_DIR_STORES` plus a 30s grace
  window and microtask-coalesced eviction so expanding a project with many
  worktrees cannot thrash still-mounting directories.

### Types and utilities

- `types.ts`: Shared sidebar types (`SessionNode`, `SessionGroup`, summary/search metadata).
- `activitySections.ts`: Persisted top-section storage/helpers for the current `recent` session list.
- `sessionFocusReconciliation.ts`: Repairs the explicit Pinned/Project focus identity after sidebar metadata or visibility changes without changing the authoritative current session.
- `utils.tsx`: Shared sidebar utilities (path normalization, sorting, dedupe, archived scope keys, project relation checks, text highlight, labels, compact/default date formatting, nest-indent padding helpers).
