# GUI plugin UI boundary

`GuiPluginTitlebarItems` consumes official global `TitlebarItem` contributions.
Web/desktop renders them as full-width icon-and-label navigation rows below Bots,
before pinned/in-progress sessions, rather than duplicating them in the left
titlebar. VS Code retains its header presentation; mobile root/session headers
retain compact controls and the mobile session drawer uses navigation rows.
Entries remain independent of session selection and do not request early loading
or introduce a startup gate. Navigation rows use the surrounding shared ghost
Button style and compact controls retain neutral solid buttons. Busy/pressed,
accessible title/label and passive status semantics are preserved.
Settings → Plugins uses the package's top-level `package.json.icon`, not nested
`magpie.icon`. GUI sidebar/titlebar entries instead use official `IconName` strings
resolved to available Yuri sprites (including `globe` → `global`) in current text
color. They never query or substitute package artwork. Busy still uses a spinner.
Unknown icons preserve the label. Plugin-owned labels remain under the plugin's
i18n. Native actions retain the existing main/IPC policy.

An entry is an action, not a global page registration. Official `Panel` content is
session-scoped, and `dialogs.open` means a modal, not a full main-workspace page.
This host does not reinterpret either API as a global page or intercept
`system.openExternal` to embed an arbitrary URL.

File previews render inside the existing FilesView tab or MobileFileDetail body.
File previews and standalone plugin panels share the mobile edge-to-edge marker;
their active sheet removes bottom safe padding and the home-indicator overlay.
This applies to every plugin rather than a hardcoded file extension. Mobile file
detail retains edge-to-edge layout across preview/source switching.
Host source/preview controls and plugin `yuri.previewActions` contributions share
one control group outside the capture viewport. Desktop FilesView and the default
inline bridge float that group at the original top-right position; the opt-in
docked toolbar keeps the same group. MobileFilesSurface uses its header or
`MobileSheetHeaderActions`. Standalone mobile panels use the sheet title row;
desktop dialogs float actions above their panel content.
`GuiFileLinkBridge` registers that visible file surface before dispatching its
LinkHandler. The host matches the contribution's explicit `PanelTab.file` against
the normalized absolute file path; an inline-owned panel never opens a modal.
`GuiPluginSurface` remains mounted once for standalone panels without
an inline file owner. `GuiPluginWindow` supplies Dialog/Sheet for those standalone
panels and settings pages only.

Explicit message file links and Changes' open-file actions navigate to the file
surface without a file-read or plugin-support preflight. Read failures stay in
that opened file tab; host-reported plugin failures silently restore its source fallback.
Changes row selection still defaults to diff. Background link probes annotate
inferred references but cannot veto explicit Markdown file-link navigation.

Mobile Changes diff detail exposes the same open-file preview action for every
extension, including plugin-owned `.eficy` files. It resolves the path against the
Changes directory and uses `MobileAppActions.openFile`, closing Changes and opening
the existing file surface/bridge. The action belongs to the detail header or the
owning sheet's header slot; no plugin-support or diff-read preflight gates it.

`GuiPluginMount` gives the host a content container and a distinct action target.
`GuiPreviewActions` attaches that target to the owning toolbar. React never
reconciles foreign descendants. Changing host, contribution key or contribution kind,
the owning plugin's readiness revision, closing the window, or removing the contribution
disposes the previous mount. The host should expose its bundle `revision` on each
snapshot plugin: React may batch uninstall/reinstall into one render, so id/status
alone cannot detect replacement of a settings renderer with the same key.
Panel and settings snapshots carry an explicit `pluginId`. Inline previews,
standalone panels, and manager settings mounts select readiness by that exact ID;
unrelated plugin reloads preserve their foreign DOM. Do not infer ownership from
the contribution key prefix: official plugin IDs are strings without a no-colon
constraint, so IDs such as `demo` and `demo:tools` can share a prefix.
Mount failures reuse `FilePreviewError` / `FilePreviewState`: the same centered,
theme-aware SVG and wrapping text canvas used by file/Eficy preview errors, not a
top error row. The foreign container is cleared and hidden until a new mount identity
or revision retries it. Global pages also use that canvas after host-reported plugin
failure removes the contribution, and have a React boundary with the same fallback.
Global pages reuse the `WorkspaceSurface` component with ContextPanel: inset spacing,
rounded corners, clipped content and the same theme-aware inset ring/material.
Healthy global pages have no host title, Back button or status chrome. A plugin
may render its own compact navigation inside that surface; frame history and
address synchronization remain plugin-owned rather than using Yuri's history.
Detailed host diagnostics remain in Settings; the global failure canvas shows generic
localized copy rather than exposing plugin error payloads. Cross-origin iframe document
errors are not observable by this React/Solid boundary; plugin-owned frame protocols
must report those failures explicitly rather than guessing success from `load`.
Cleanup failures are reported through the shared
toast while the container is still cleared. Locale changes update fallback copy
without remounting foreign content. Discovery, bundle download and activation
failures stay silent outside plugin settings: no file-view banner/retry row,
command-palette error entry, or root-surface toast. The provider/host retains failure
state for diagnostics and the Plugins manager's explicit reload controls.

The Plugins collection has no separate GUI inventory or row action menus.
A provider row carries a muted 13px window icon (localized UI-plugin tooltip)
even when its GUI is disabled; it is not a text badge.
Ownership is matched against the authoritative GUI inventory source (exact
package target or normalized local path), never a guessed GUI ID/package name.
`GuiPluginsManager` is embedded above the selected provider's form, scoped by
GUI IDs, with one compact UI-plugin/status/switch strip per matching GUI plugin
and an 11px capability description beneath the label.
It uses the existing per-runtime enable preference and host activation state;
plugin update/reload disables and dims these controls with the rest of the form.
Only that provider's commands, panels, menu launchers and settings appear below
the status line; snapshot contributions carry their explicit `pluginId` owner.
It reads inventory and runtime statuses from the provider, delegates enable/reload actions, and opens
settings contributions. Its panel group also exposes `session.panel` menu-item
launchers, including when no panel is open yet. Launcher actions use the same
error-reporting path as other manager actions. Contribution rows are dynamic entities and are not
registered individually in Settings search. The owning Plugins page remains the
navigation entry. `GuiPluginCommands` is an independently filtered command-palette
group with five-row previews and explicit expansion.
Initial plugin discovery is silent in the palette: no loading row or empty group
is shown. Loaded commands remain usable during discovery and other plugins' failures;
failed loading never adds an error/retry entry.

Plugin keyboard shortcuts and slash-command autocomplete are not supported in
this first version. Command-palette and manager actions are the available command
entry points; contributed shortcut bindings are not installed by this UI.

## Preloading and preview preparation

The provider initially fetches inventory, then preloads active enabled GUI plugins
at browser idle (2s timeout, 1s timer fallback). A visible, active file bridge,
or the mounted Plugins manager calls `requestLoad()` to bypass that wait.
The command palette only consumes the provider's live command snapshot; opening,
typing, and reopening never initiate plugin loading or wait for activation.
Inactive/inert/hidden file views do not initiate demand themselves. Demand is retained for the current
runtime so closing and reopening a file reuses the installed host and bundle queries.
Persistent code is revalidated before installation; its transport and freshness
contract belongs to `lib/gui-plugins/DOCUMENTATION.md`.

The standard inventory only declares `features.gui`; file matchers are registered
by plugin setup. Preload or explicit demand therefore loads enabled GUI plugins, not a
guessed extension-specific plugin. Server-only and disabled plugins are excluded.
File views place `GuiPreviewLoading` in their existing preview slot, keeping file
tabs and toolbars in place. The centered, transparent file-content canvas reserves
its illustration position through the shared `FilePreviewState`, matching the file-error
canvas regardless of description length or action visibility. It reserves
at least 240px (including under the global mobile flex min-height reset) and inherits
the file surface rather than adding a card. The source action uses a visible keyboard
focus background even where global styles suppress focus rings. A decorative
SVG animates content-line opacity with CSS only; reduced-motion disables it. A
localized title and first-open hint describe preview preparation without implementation
terminology or cache assumptions. “View source” and the toolbar source toggle remain
usable before a host exists; source choice is retained for the file/base/session
identity, so a late preview cannot take over. Discovery completion without a match
removes the loading canvas and restores ordinary source with no plugin controls.
Ready handlers may render and switch to/from source while other bundles are still
pending. Failed loading removes the preparation canvas and silently keeps source usable;
only the manager retains its existing reload control. Runtime changes reset demand; mounted entrypoints request
the new runtime explicitly.

Ready/preloaded file panels also pass `GuiPreviewLoading` as `GuiPluginMount`'s
fallback. The mount yields across two animation frames before calling plugin code,
leaving a paint opportunity for the default SVG even when there is no bundle request.
The empty foreign container remains measurable; React owns only the sibling loading
overlay. Source selection, unmount, and owner/revision replacement cancel deferred
work. Unrelated renders and fallback-copy changes do not restart it. Synchronous
mount completion hands off to plugin-owned preparation; plugins with asynchronous
file reads or iframe runtimes must keep their own visible loading surface until
actual content commit or an actionable error, not merely iframe `load`/runtime-ready.
Standalone/settings mounts without a fallback retain synchronous layout mounting.

`GuiFileLinkBridge` wraps file content and calls `openLink` with the selected path,
exact matching and the workspace base. It does not fetch file contents. A matching
file panel is the default preview, with one icon-only source/edit toggle; normal source/image
content remains the fallback when no panel matches or the plugin is disabled.
Authoritative binary stat results use the shared file-view `BinaryFileFallback`
instead of reading or editing UTF-8; this fallback and its explicit system-open /
runtime-download actions are owned outside GUI plugins. Plugin previews retain
priority over that state. See `packages/ui/README.md#file-preview-fallback`.
Source mode releases the Solid mount while retaining the parent editor draft.
FilesView and MobileFileDetail place the combined `controls` render-prop (plugin
actions plus source toggle) in their floating/docked toolbar or header.
`toggle` remains a source-only control for consumers explicitly needing it. There is no separate
plugin mode bar, and unmatched files receive no plugin controls.
Closing or switching the file releases its presentation lease and hides its old
active plugin panel instead of reopening it as a dialog. Multiple consumers have
independent leases. Desktop FilesView also passes its active-view state. Mobile file
bridges combine this with `MobileWindowActiveContext`, the owning window's reactive
top-of-stack state. Initial inert mount, interactive-present, a covering window and
reactivation therefore release/reacquire the file lease and retry matching without
waiting for a plugin update. Reading ancestor attributes alone is insufficient: a
preloaded plugin can be ready before the sheet is admitted to the window stack.
Source selection survives covering/uncovering. Inert/hidden ancestors cannot initiate
an automatic preview. Initial plugin registration, a new file/base, host replacement,
an updated plugin revision, session change or an observed loading cycle retries matching. Panel
snapshots alone do not.
Link discovery deliberately uses all plugins' readiness so newly available or
reloaded handlers can match a file. This retry signature is separate from the
owner-scoped mount revision: retrying matching does not itself recreate an
existing preview. Inline mount revisions also include session identity.
Reloads that preserve both host identity and the plugin status signature do not
force a preview open: the preview icon retries the same file,
as does leaving and reopening file detail. React strict effect replay does not
duplicate an automatic link opening.

The integration tests mock the provider and host boundary and use real React DOM.
They cover foreign DOM lifetime, error visibility, settings removal, tab actions,
file routing, deferred entrypoints, loading/retry and repeated snapshot no-ops. They do not prove Solid rendering,
actual mobile gestures, native focus, network bundle loading or runtime transport.

`GuiPluginLazyLoading.test.tsx` additionally composes the real provider, file bridge,
host and a minimal standard CJS fixture. It covers cold startup without downloads,
delayed bundle loading with a source action, retained source choice, inline file-content rendering, warm
reopening and failed download/reload. SDK/file I/O and the standalone surface are
fixtures; plugin-specific runtimes and browser execution belong to the independent
plugin projects.
