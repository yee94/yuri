# Built-in file HTML preview

`ProjectFilePreview` is the shared production consumer for FilesView and
MobileFilesSurface. Both pass the actual file path, project/worktree directory
and captured Host entry to `resolveProjectFilePreview`. No file preview executes
an unscoped Relay `srcDoc` or a query-authenticated FS serve URL.

The existing `MobileHtmlNetworkBoundary` owns the native network lease and passes
its `hostOrigin` into the helper. Other Relay runtimes use the helper's existing
Electron preview gateway or expose unsupported/failure; they never silently fall
back to the Hub's filesystem or an inline document with broken relative resources.

The component removes an old document immediately when path, Host entry, content
revision, runtime generation, auth generation or native origin changes. Cleanup
aborts registration and releases the target. Late cancelled results are released,
not displayed. Helper or iframe errors remove the document and offer local retry.
Loading and retry copy use existing localized preview messages.

An active proactive URL-auth consumer renews short-lived path credentials before
their expiry. Each token replacement re-registers, swaps the source and revokes
the old target; a replacement during registration triggers a trailing resolution
instead of displaying an outdated path token. A separate deadline renews target
expiry. Renewal can reload page state, as with the existing URL preview sheet.
Metadata-only file polls retain the iframe; actual HTML content changes replace
the target. Sheet overscroll handling and mobile fullscreen/source controls remain.

Tests cover the actual shared component's native-origin input, sandbox, lifecycle,
token and target renewal, failures/retry, cross-Host cancellation and 50 unrelated
renders. FilesView and MobileFilesSurface tests consume that component, including
same-path Host switching and source toggling. These component tests mock target
registration; browser resource-graph, real gateway, Electron and Capacitor network
acceptance must be recorded separately from the helper/backend owner's evidence.
