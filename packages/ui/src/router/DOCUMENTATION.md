# App Router — product navigation

## Top-level exclusive primaries

These are **siblings**, not children of a session:

| Primary | Path | Main column |
|---|---|---|
| **session** | `/session/$id` · `/session/$id/plan` · `/session/$id/{git,diff,…}` | Chat + optional tool |
| **new session** | `/session/new` (alias `/new`) | Welcome / draft composer (no real session id) |
| **schedule** | `/schedule` · `/schedule/history` · `/schedule/tasks/$p/$t` · `…/agent/$focus` | Schedule workspace only |
| **assistant** | `/assistant` · `/assistant/$id` · `…/agent/$focus` | Assistant workspace only |
| **settings** | `/settings/$slug[/$entity]` | Settings overlay only |
| **plugin** | `/plugins/$pluginId/$pageId` | Global Solid placement; Capacitor uses a mobile Sheet |

**Invalid product URLs (must not be written):**

- ~~`/session/$id/schedule`~~
- ~~`/session/$id/assistant`~~

Legacy nested forms still **parse** into top-level `schedule` / `assistant` kinds; all **writes** use top-level paths.

## Mutual exclusion

At most one of: session shell · plan · schedule · assistant · settings  
MainLayout never keep-alive-mounts Chat under schedule/assistant/plan.

Plugin pages are also exclusive; their identity is transient UI selection plus a
credential-free route. Back restores the preceding main tab. Browser history can
restore page identity before plugins finish loading. The immersive placement adds
no header/back/loading/retry chrome; rendering failures use the shared centered
preview-error SVG and text, while detailed diagnostics stay in plugin settings. It never
opens an external browser. Runtime switching clears the selection.

On Capacitor, Projects' Apps cards select the same plugin/page identity and the
shared window stack owns the sheet/back action. The prior main tab is retained.
Only registered pages create cards; unrelated plugin failures do not keep removed
pages open. The GUI Provider must establish the native Relay proxy before setup
or mounting; hosted mobile cannot mount global pages.

## Session tools only under session

`git | diff | terminal | files | diagram | plan` live under `/session/$id/…`.

## API

```ts
buildSchedulePath()      // → /schedule
buildAssistantPath()     // → /assistant
buildSessionPath({ sessionId, tab: 'git' })  // → /session/$id/git
// buildSessionPath({ tab: 'schedule' }) redirects to buildSchedulePath()
```

`createAppNavigation`: `goSchedule()` / `goAssistant()` / `goSession()`.

Remote project/session selection uses `stores/useSessionNavigationStore`, not the
Hub's local `setCurrentSession`. Its `remoteSession` contains `projectId`, explicit
`location: {hubId, hostId, directory}` and a raw `sessionId` (`null` for a draft).
`openRemoteProjectSession` is the synchronous registry-fenced selection action;
`openRemoteProjectDraft` validates a header/global New target against the current
Hub catalog first. Neither changes the singleton endpoint or directory. Local
selection clears the remote bridge. The phone opens a stable draft secondary
container without invoking the local draft/session mirror; the chat entrypoint
consumes the remote bridge even when that container supplies an empty explicit
session ID. Closing the secondary page clears it. Hub switches also clear the
transient selection. URL and notification adapters must retain this full location
and must never resolve a remote raw ID through local session lookup.
Remote routes also retain `instanceId` when supplied by an authenticated resource
reference. URL parsing, native notification/Mini Chat handoff and route restoration
preserve it, and registry admission checks it before changing selection. Legacy
Host-only routes remain compatible with the Hub's persisted connection-authority pin.

Individual tasks use `/schedule/tasks/$projectId/$taskId`. The scheduled workspace
restores the composite identity on initial load and browser Back/Forward; list
selection, save, and editor dismissal write the matching task/list path.
`openScheduledTask` is the shared Assistant card/Settings-row entry. It also
queues a transient UI open request for already-mounted workspaces and URL-disabled
hosts (VS Code/embedded); the active host consumes it once, without persisting it.
Mobile task links and list selections open the shared `MobileResizableSheet`,
including cold links. Desktop retains the workspace detail panel. Missing tasks
and failed project loads retain the requested identity and show unavailable/retry,
never an empty create form. The sheet's close and drag-dismiss share the dirty-draft guard.

The shared `useRouter` state bridge gives the active assistant/schedule primary
precedence over a retained new-session draft. Selecting an Assistant writes
`/assistant/$id`; initial links and browser Back/Forward restore that selection
without selecting an OpenCode session. Changing or clearing the Assistant drops
the previous Assistant's focused child-session suffix. Returning to Chat restores
`/session/new` when its draft is still open and no session is selected.
Desktop sidebar project reveals consume that same draft's selected project ID
and the existing session-switch intent revision. Global-search project selection
continues through `openNewSessionDraft`; it does not introduce another project
route, publish a separate selection, or reach into sidebar DOM. The sidebar owns
one-shot, viewport-aware scrolling after the target header is mounted.

The phone navigation store separately captures an Assistant-origin chat return
target (contact ID and root tab). Popping the worker restores the contact page,
not the root catalog; explicit nested chat routes pop first. This target is
runtime-local navigation metadata, not a persisted URL or session association.

Mobile remote desktop is a dedicated fullscreen push page. Its root back route
`remote-desktop-page` uses the shared `MobileBackNavigationCoordinator` for H5
history and native Back, preserving its source tab/session rather than selecting
a new session or using a sheet. Its local portrait/landscape transform and sensor
listeners exist only while this page is mounted; other pages and native global
orientation restrictions are untouched.
