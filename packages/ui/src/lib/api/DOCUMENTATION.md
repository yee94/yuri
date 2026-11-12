# Project capability transport

Remote project callers pass a captured `HostRuntimeEntry`; they never change the
window runtime or encode a location key into a physical filesystem path.
`captureProjectScope` fences transport/auth generation and the registry's captured
Hub/host logical `scopeGeneration` revision, including after response body parsing.
Physical wire reconnects do not revoke that scope; authorization/descriptor changes
and unavailable/removal transitions do. A stale
operation throws rather than returning an authoritative empty snapshot.

`createProjectFilesAPI(entry)` owns HTTP filesystem calls and SDK file search.
It omits native Hub actions such as reveal/IDE opening. Query file adapters select
this transport whenever input carries `scope`, even if a caller passes a local
FilesAPI. Query hooks also inherit `HostRuntimeProvider`. Legacy unscoped callers
keep their runtime behavior.

`createProjectGitAPI(entry)` in `../gitApiProject.ts` implements project GitAPI
reads, hunk/index, history, stash, merge/rebase and worktree mutations without the
directory-only HTTP caches or global runtime bridge. Machine identity writes are
explicitly rejected; users open instance management instead.
Branch/remotes Query hooks inherit the project provider and do not load/write
Hub-only startup snapshots for scoped entries.

`createProjectTerminalAPI(entry)` in `../terminalApi.ts` has its own socket manager,
capabilities, bind identity and replay cursors. Owners must dispose it on departure
or host-offline transitions; runtime/auth switches dispose automatically. It never
falls back to a per-host EventSource. The Hub must support the host-prefixed WS
upgrade through its existing realtime/Relay proxy and narrow URL-auth allowlist.
If create/restart completes after that terminal API owner is disposed, it releases
the returned PTY through the original captured scope before rejecting the result.
This cleanup still enforces current runtime/auth/Host authority; it never resolves
the replacement selection or bypasses a revoked scope. Ordinary completed PTYs
remain owned by persisted tabs and can be rebound after a surface is reopened.

Catalog options factories accept an optional third entry argument (agents,
providers, raw agents, commands, installed skills, MCP). Their keys append the full
entry queryScope; raw physical directory goes to SDK/location headers. Provider
catalog SDK fallback stays on that same entry. Imperative legacy snapshot/refresh
helpers remain unscoped; remote consumers use the scoped options with QueryClient.
Saved-permission scopes carry `entry` and authoritative upstream project ID.

`readRuntimeFile` accepts `scope`, `acquireRuntimeImage` accepts a fourth entry,
and `directFileResource` accepts a third entry. Scoped bytes bypass the historical
Hub-only durable/native cache. A per-reader image stream never registers a bare
remote source path for a later Hub read. Native save/share must use a scoped
`readRuntimeFile` rather than the old unscoped source-path reread. Attachment
uploads accept `input.scope`, upload temporary bytes on the selected Host and
return its physical file URL; they do not seed Hub-only caches.

`useProjectRuntimeAPIs` is consumed by the production FilesView, DiffView, GitView,
TerminalView and mobile Files/Changes surfaces. It inherits explicit Host context,
keeps physical directories separate from UI identities, and omits native Hub
editor/GitHub fallbacks. Its terminal owner is lazy and disposed on Host departure.
`useProjectGitStore` projects the existing Git store into generation-scoped slots;
only store keys are encoded, and transport calls receive the original directory.
Branch Query helpers recognize that scope and skip Hub startup snapshots. The
worktree metadata hook disables local discovery before reading the selected Host.
FilesView tabs use entry.key while reads/search/write use the physical root.
Files surfaces do not mount a separate Host configuration inventory. Remote
configuration management stays in the existing whole-instance settings flow;
conversation model/tool catalogs still read their explicit Host scope.

These consumers do not prove server authorization, native networking or actual
Relay correctness. Focused tests cover a real mobile file component switching
same-path Hosts, Git store projection with raw Windows paths, lazy terminal
create/connect/input/resize/close/disposal, routing, stale body completion, failed
refresh retention and upload bytes. Native/desktop gateway resource-graph and real
SSH/Relay acceptance must still be measured independently.
