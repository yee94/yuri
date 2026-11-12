# Remote Project client boundary

`HostLocation` carries the current Hub identity, optional Remote Host identity and
the **raw filesystem directory**. A `locationKey` is an identity, not a path.
Only identity-indexed state may use it; Files/Git/SDK/terminal operations receive
`location.directory`. Local location/session keys retain their previous bytes.
Remote location/session keys include Hub, host, directory and session as applicable.
Durable partitions omit transport generation so a LAN/Relay reconnect can retain
drafts and transcript seeds. In-flight request/query scopes include Hub transport
identity and the Host's logical authorization/descriptor scope, not its transient
physical connection instance, and must not commit across either boundary.

## Add-project directory entry

`DirectoryExplorerDialog` orchestrates machine → directory selection; with no
remote Hosts it retains the direct local entry. `DirectoryExplorerViews` owns the
shared Dialog/MobileResizableSheet presentation for all three steps and the pure
machine list. `RemoteDirectoryExplorerDialog` only adapts model state to that
presentation. It adds no separate configuration inventory or mobile terminal.

Only available saved Hosts count as additional machines; disconnected saved Hosts
remain choices, while removed references do not. Cold catalog discovery shows only
loading, never a speculative machine step. Empty/unsupported catalogs go directly
to the existing local picker; discovery failures expose an error alongside local
browsing. The machine step's footer opens Remote Instances Settings directly in
the shared SSH editor's new-entry mode (`settingsRemoteInstancesSelectedId: 'new'`).
Settings' Add SSH actions use that same mode. Opening it does not persist a
placeholder Host or connect; Create saves, while Connect saves then connects.

`useDirectoryMachineModel` owns selection and the Query connection mutation.
Remote Next uses `registry.connectHost(hostId, { verify: true })`: cached online or
connecting badges do not authorize entering the directory step. The shared flight
awaits the Hub's SSH preparation and authenticated capability admission. Pending
stays on the machine step; failure preserves selection/error for explicit retry.
Changing selection (including A→B→A), closing/reopening, unmounting or switching
Hub fences late navigation. Local Next remains immediate. No polling or extra
status/content stream is introduced for readiness.

Picker errors do not insert banners or retry rows. Connection failures occupy the
machine row's fixed status slot; catalog and directory-operation failures use the
same reserved header slot. The shared Tooltip reveals details on hover/keyboard
focus (long press on touch). The existing primary action owns connection retry.
Success/error states retain row, header and footer geometry; both footer actions
use the same compact button recipe, and machine labels/status/steps share sizing.
The SSH action aligns its plus icon and label with the machine icons and names;
hover/focus and the existing Settings navigation remain intact.

`remoteDirectoryQueries` owns home/list Query options, DTO parsing and the
post-body scope fence. `useRemoteDirectoryExplorerModel` owns path selection,
registration mutation and navigation. Query owns pending/error/request lifecycle;
ReactUse `useEvent` and `useMountedState` own event-time callbacks and mount checks.
Same-tick submissions use Query's synchronous mutation registry to deduplicate.
No polling, second cache or manually mirrored pending/error/alive state is added.

The machine step performs no filesystem IO. A cold directory open requests home
once and then one listing; physical transport-status changes do not restart them.
Changing authorization/Hub scope cancels stale reads and fences response-body
completion. After mkdir, scope/departure is checked before project registration;
late registration cannot navigate a departed picker. If mkdir succeeds but
registration fails, the directory remains and the path/error stay available for
an add-only retry. An acknowledged server registration remains valid even when
later UI callbacks fail; it is not deleted as an attempted rollback.

## Request ownership

`HostRuntimeRegistry.resolve(location)` returns one immutable captured entry:

- `sdk()` uses the generated OpenCode client, retaining generated method, body,
  headers, query and cancellation. `service()` exposes the existing higher-level
  OpenCode service with separate caches and serial send boundaries.
- `fetch('/api/…')` routes Yuri-owned capabilities through the current Hub's
  authenticated `runtimeFetch`. Remote paths become
  `/api/hosts/:hostId/api/…`; no upstream URL or credential reaches the renderer.
- `queryScope` includes the current transport, Hub, host, location and local logical
  scope revision. The existing `connectionGeneration` entry field names that local
  revision for compatibility; it is not the wire `generation` UUID.
  `cachePartition` is the stable client-durable scope.
- `requestHost` is for Hub-owned controls (`projects`, `summaries`, `subscriptions`,
  `connect`), not an upstream OpenCode path.

New Hosts expose opaque `scopeGeneration`: the gateway retains this identity for
one saved descriptor/auth configuration even while zero-reference short HTTP
connections open and close. Descriptor/credential/target changes and remove/readd
allocate a new identity, including A→B→A. Entries reject after a Hub/transport
switch, scope change, removal or availability revocation. Plain connecting/idle/
connected transitions, `lastConnectedAt` and new physical wire UUIDs do not replace
an entry with the same logical scope. A directory picker must not wait for live
`connected`: before project references exist, its short requests create no status
stream or persistent connection. No foreground lease or keepalive is added.

Legacy Hosts with no `scopeGeneration` retain conservative state/wire/time fencing.
Once a scope-aware Host has been observed, an unversioned available status cannot
downgrade it to legacy semantics. An unavailable row without a token instead
revokes the known scope. Retired authorization tokens cannot be restored by late
catalog/status snapshots, including after same-ID readdition; retired identities
are kept for the registry lifetime and cleared at disposal. Physical wire UUIDs
remain independently filtered, and a scope-aware Host without a current wire
cannot admit old content frames. Callers re-resolve after scope changes; an earlier
response cannot mutate the new scope. JSON/body consumers must also fence after
awaiting body consumption.
`getHostRuntimeRegistry` does not replay an old catalog on every React render;
successful catalog Query reads apply snapshots outside render.

Host summaries include optional `worktrees.projectDirectories` (project root to
authoritative Git checkout paths) and `staleProjectDirectories`. Root membership
is implicit. `resolveRemoteProjectOwner` is the shared sidebar, Header and route
ownership rule: explicit project roots take precedence, followed by the most
specific verified checkout. Never infer aliases for a nested project from its
parent repository catalog; the server's filtered directory map is authoritative.
Equal ambiguous aliases are
not assigned by array order. A stale topology retains its previous paths for
continuity; it does not authorize requests, which the Hub must still validate.
Malformed topology rejects the snapshot rather than creating an authoritative
empty map. URL/notification restoration without a project reference ensures the
Host summary before resolving ownership and rechecks navigation/runtime fences.
Neither ownership nor URL restoration rewrites the raw worktree cwd to the root.
Only topology tips and the existing summary recovery boundaries invalidate this
metadata; token events do not enumerate Git or refetch summaries.
If a new worktree's first content subscription returns 404 before topology arrives,
the successful summary Query supplies its mapping to `HostContentDemand`. Only
still-visible rejected demands with a new matching mapping retry; existing leases
are untouched. Identical snapshots cannot create a retry loop, and topology that
arrives during an in-flight rejection is not lost. No retry timer is added.

`getLocationOpencodeClient` creates an independent service for a remote Location.
It does not switch the window endpoint or set the root singleton's directory.
Its native-local FilesAPI and home-directory fallback are disabled. Root local
callers retain the singleton and original SDK dispatch path.

## Realtime and lifecycle

One registry service consumes the **existing** `yuriEvents` connection regardless
of visible pane count. `yuri:host-status` updates only that host's listeners;
`yuri:host-event` goes only to that host's content consumers. Token events never
notify status/catalog subscribers. Event parsing discards invalid envelopes
without creating empty authoritative state.

Host aggregate frames arrive on the existing global OpenCode event transport.
`event-pipeline` projects `yuri:host-status`, `yuri:host-event` and
`yuri:project-order-changed` through `dispatchYuriEventEnvelope`, the same parser
and bus used by `/api/yuri/events`. These frames are declined from local reducers,
but still advance transport resume tips. Global ready/reconnect projects a separate
internal `global-event-stream-ready` lifecycle notification so active remote leases
recover when this channel returns. It must not synthesize product
`event-stream-ready`: local-only consumers use that notification to refetch their
own state, and global reconnect must not add local background IO.
This bridge opens no additional transport and has no IO when there is no remote
consumer. Host subscriptions still update live state. Only a logical scope change
or revocation replaces a scope-aware captured entry; the mounted
HostRuntimeProvider then re-resolves it. Never disable the scope fence to make a
stale entry appear usable, or use physical connection churn as authorization loss.

`HostContentDemand` reference-counts visible session observers. It POSTs a content
lease with raw directory/session identity, refreshes authority at content readiness,
and DELETEs after the final observer leaves. It never evicts a live consumer to
work around the Hub's content cap. A late acquisition is released rather than
refreshed. Backgrounding releases leases; foregrounding and stream-ready/host
recovery reacquire and revalidate. Capacitor uses `App.appStateChange` in addition
to WebView visibility; there is one native lifecycle listener per demanded Hub.
The Hub remains responsible for cross-window sharing, global limits and reconnect.
Readiness is deduplicated by lease and `readyGeneration`, not permanently by lease.
Both the POST ready snapshot and multiplexed ready event can trigger the boundary;
the shared channel identity must match. Reconnect generations received during a
refresh coalesce into a trailing authority refresh, rather than being dropped.

Construction, local resolution and unused demand create no requests, sockets,
polling or timers. Host discovery is enabled only by explicit picker interaction
or an existing Remote Project consumer. Electron and Capacitor are supported
client surfaces; ordinary web and VS Code return an explicit unsupported decision.

## Validation boundary

`registry.test.ts` covers local-key compatibility, safe DTOs, same-path identities,
request fidelity, Hub/host fencing, zero unused work and host event fanout counts.
`sync/remote-session-state.native-capture.test.ts` replays a portable exact
subsequence of the final native capture through actual global WS ingress, bus,
registry and remote transcript repository, checking the first delta before history
refresh. It also projects the new scope field onto the recorded connecting/connected
status sequence: pending requests survive ordinary admission; actual scope
revocation rejects old requests and replaces the mounted entry without reload.
Foreign Hub or stale-wire frames cannot reach content consumers. The fixture records its
source SHA256; only physical directory values are replaced with a neutral path.
`content-demand.test.ts` covers observers, background/resume, late acquisition,
same-session cross-host isolation, readiness generation deduplication and trailing
reconnect refresh, and the ninth-live-consumer rejection.
`../opencode/client.host-location.test.ts` exercises actual generated SDK requests
over direct and fake Relay transport and verifies filesystem path fidelity.

These are deterministic client contract/operation-count tests. They do not prove
production Electron/iOS timing, real SSH/Relay behavior, native terminal/preview
rendering or the complete product acceptance matrix. The owning feature's
acceptance record must list those runtime measurements separately.

`sync/fixtures/remote-projects-indexeddb-renderer.ts` is an explicit browser fixture,
not an application entrypoint or automatically run Vitest test. Build it to an IIFE,
load its HTML with the existing Electron transcript IndexedDB evidence harness,
and await `window.__YURI_TRANSCRIPT_DURABLE_INDEXEDDB_EVIDENCE__`. It uses real
Chromium IndexedDB to check same-ID local/Host/Hub transcript and draft-reference
isolation, reopening, reconnect-stable partitions, isolated deletion, and the
remote runtime selector's refusal to construct the Hub HTTP cache. The separate
Electron evidence Vitest wrappers may be skipped; a skip is not this execution.
