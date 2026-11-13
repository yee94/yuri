# Remote Host Gateway

`server/index.js` constructs this module before the generic OpenCode proxy and
stops it before closing the local session index. Electron injects the process-local
adapter from `packages/electron/remote-hosts.mjs`. The adapter reads that computer's
saved hosts/SSH manager, never the focused window's selected runtime. CLI/web/VS
Code instances without an adapter report `supported: false`; desktop and
SSH-managed PC instances expose the local-project authority protocol.

## Ownership and persistence

Resource authority is distinct from a connection: `remote_host_authority` pins a
saved `hostId` to the first authenticated capabilities `instanceId`. Reopening,
credential rotation and transport reconnection preserve the pin. A different
instance returns `remote_instance_mismatch` before resource reads or mutations;
old project references and snapshots remain available. Existing databases acquire
this pin on their first successful admission. Separate SSH/Relay connection records
and credentials remain separate, even when their `instanceId` matches. Public Hosts
and project references expose the pinned identity. The optional Hub-only
`X-Yuri-Target-Instance` request header checks an explicit resource reference and
is stripped before forwarding upstream.

Server-owned work uses `acquireTask(hostId, { instanceId, signal, onEvent })`.
The returned immutable lease owns its authenticated target, fenced request/JSON
methods and idempotent release. Plain reads retain a short HTTP demand; `onEvent`
retains only that Host's existing shared status reader independently of UI windows.
Task callbacks receive metadata/status events, never a second transcript mirror.
Tasks release on completion/cancellation; persistent watches own their lease until
settlement and re-acquire from their explicit target during recovery. No UI and no
task demand still means zero remote readers/transports. Revocation/retargeting
rejects stale leases; it never dispatches against the Hub's local OpenCode service.
Official SDK task mutations use the existing long-running operation budget; reads
retain the short budget. Status projection retains only allowlisted interruption
reasons and a `MessageAbortedError` name marker, never raw error messages/stacks.
Task status also covers authorized remote sessions whose project has not been
associated with the Hub sidebar. Those events go only to the task consumer and do
not create project references or index rows. Content-channel messages never reach
task status callbacks.

- `store.js` owns `remote-hosts.sqlite`: stable Hub identity, remote-project
  references, safe presentation fields, connection receipts and bounded-shape
  unread/folder/order snapshots. `(hostId, path)` is unique. Missing hosts retain
  their reference and display record; removing a reference never deletes remote
  sessions, files or projects.
  `saveProject` is explicit association/upsert; asynchronous metadata completions
  use `refreshProject(reference, remote)` instead. The latter only updates the
  matching existing id/Host/path/addedAt/remoteProjectId row and returns null if it was removed
  or replaced. A late refresh or PATCH must never recreate a deleted reference.
  `hasProjects()` uses SQLite EXISTS-style `SELECT 1 ... LIMIT 1`, never a Host
  lookup, subscription or timer. Existing settings bootstrap and full settings
  project it as read-only `hasRemoteProjects`. Successful reference creation or
  removal sends the existing content-free `yuri:project-order-changed` global
  invalidation tip, including the first/last reference transition. Clients refresh
  their existing bootstrap/settings query, not an unconditional hosts request.
  Hub project order and collapse live only in settings `hubProjectLayout`, not
  in remote metadata or local `projects`. See the settings module contract.
- `gateway.js` owns connections, shared status/content readers, generation fences,
  owner cancellation and the fair two-slot refresh queue. Remote summaries use
  the existing session-index service and its newest-20 directory bound. Each
  partition hashes `hub:<stable Hub ID>:remote-host:<host ID>`; no mutable local
  runtime endpoint or local filesystem resolution participates.
  Remote pin membership also belongs to this Hub partition. Existing persisted
  pins are retained; refresh never imports or clears pins from a Host snapshot.
  `POST`/`DELETE /api/hosts/:hostId/api/yuri/session-index/session/:id/pin`
  terminate on the Hub before the generic proxy, use the existing index DB and
  emit the existing host-scoped index-change tip. Unpin is idempotent, requires no
  remote connection, and cannot modify the same session ID on another Host.
  The target-instance fence and aggregate client authorization still apply.
- `transport.js` owns authenticated direct/SSH-forwarded requests and reuses the
  normative E2EE Relay client. `build:remote-host-relay` compiles that client once;
  normal web build/prepack and `build:llm-bridge` include the build. The generated
  bundle ships inside the web server resources, not as a new dependency.
  Both direct and Relay normalize Fetch `HeadersInit` (Headers/record/pairs)
  before merging target authentication case-insensitively; SDK content-type and
  directory headers survive without forwarding the caller's authorization.
- `routes.js` owns external authorization, host-scoped HTTP/WS routing and demand
  tracking on the existing global client stream. `preview-scope.js` carries only
  a relative host prefix and a nonsecret marker across the remote preview pipe;
  real Hub URL tokens are inserted on the Hub, never sent upstream.

There is no remote message/part/transcript table. Remote content events bypass the
Hub's transcript, message queue, search indexing and upstream watcher side effects.
Remote queue requests execute on the target machine through the prefix proxy.
The local HTTP transcript-cache rejects explicit remote scopes; client IndexedDB
is the only Hub-client content acceleration store. Configuration catalogs are
read-only projected views; raw settings/config files and machine mutations are
not proxy capabilities.

## HTTP protocol

The client proxy permits `PUT /api/yuri/sessions/:id/archive` for Host-owned
archive/unarchive writes and `PUT /api/yuri/sessions/:id/metadata` for metadata
patches. These are exact method/path capabilities, not a blanket
allowance for `/api/yuri/sessions/*`; normal client/Host authorization and target
authority fences still apply.

`task-client.js` exports `makeRemoteTaskOpenCodeClient(lease)` for trusted
in-process Assistant and bound-project consumers. It preserves official SDK
Request method, headers, JSON body, query and abort signal through `lease.request`.
The synthetic SDK base origin is never fetched; every route terminates at the
lease's authenticated target Yuri proxy. That proxy's current runtime gate owns
write admission (`executionAdmission: 'target-yuri-proxy'`), not the Hub's unrelated
OpenCode availability. Target rejection propagates without fallback/retry. This
factory owns neither the lease lifetime nor body persistence; consumers release
short reads in `finally` and retain background watch demand until settlement.

- `GET /api/hosts`: `{supported, hubId, hosts, projects, reason?}`; local SQLite /
  saved descriptors only, no probe. Public hosts contain id/name/source/state,
  available, generation, safe error/timestamps/version, never URLs/credentials.
  Optional `preparationPhase` is live-only, allowlisted SSH bootstrap progress
  while `state` is `connecting`: connecting/checking/installing/updating/starting.
  Phase-only changes use the existing `yuri:host-status` channel; they do not alter
  scope/wire identity or start a new stream. Late callbacks after admission,
  cancellation or failure are ignored; admission/failure clears the phase. Hosts
  without native SSH preparation omit it, retaining generic connection status.
  `scopeGeneration` is an opaque in-process authorization/configuration epoch,
  independent of `generation`, which identifies the physical event connection.
  Releasing an unreferenced short HTTP transport leaves its scope epoch intact;
  credential/target descriptor changes or observed Host removal and re-addition
  create a fresh epoch, including when old credentials are restored (no ABA reuse).
  The identity record has no transport, reader, timer or background IO. It is
  bounded by the current saved Host catalog and cleared on shutdown. Clients fence
  captured HTTP/query scopes by this epoch and continue fencing events by wire
  generation. Current-connection checks still reject late physical responses.
- `GET /api/hosts/projects`: persisted Hub references.
- `POST /api/hosts/:hostId/projects {path,label?}`: remote register first, then
  upsert the Hub reference. A Hub disk failure leaves the remote project intact;
  retry associates the same canonical remote path and deterministic Hub ID.
  The UI route and bound session `add-remote` share `gateway.registerProject`.
  It captures an authenticated task lease (and checks an explicit instance ID),
  validates the remote response, persists the reference and emits the same
  project-order tip. Every outcome releases the lease. Route resource-expiry
  tracking listens to this tip, including when an Agent creates the first reference.
- `PATCH /api/hosts/:hostId/projects/:projectId`: remote metadata write-through;
  cache updates only on successful authority response.
- `DELETE` on that path removes only the reference.
- `GET /api/hosts/:hostId/summaries`: immediate SQLite snapshot, stale marker,
   connection receipts and unread/folder/order snapshots. Offline live status is
  `metadata.yuri.sessionStatus = {type:'unknown',lastKnown}`.
  Opening a replacement status stream does not make persisted activity live:
  the snapshot remains stale/unknown until that connection completes its refresh.
  `worktrees` contains `projectDirectories: Record<projectRoot, string[]>` and
  `staleProjectDirectories: string[]`. These are path-only metadata from the
  remote Git worktree catalog, never locally resolved paths. Root subdirectories
  and verified worktrees outside the project root participate in summaries,
  status ingestion and content leases. Explicit project roots take precedence;
  a nested source project maps only its suffix within the longest authoritative
  checkout: `/repo/src` with checkouts `/repo` and `/other` maps `/other/src`,
  never the entire `/other`. Filesystem presence remains a remote operation;
  the Hub does not stat or resolve these paths on its own filesystem.
- `POST /api/hosts/:hostId/connect`: explicit foreground wake. The response awaits
  native SSH preparation and authenticated capability admission; callers entering
  the directory picker wait for this acknowledgement, not a cached status label.
  Without project references no status stream is opened, so the response's live
  status can still be `connecting` despite successful HTTP admission. Subsequent
  short requests reuse the native manager's matching live Ready tunnel rather
  than repeatedly restarting SSH initialization.
- `POST /api/hosts/:hostId/subscriptions {directory,sessionId?}`: content lease;
  `DELETE /.../subscriptions/:id` releases only the authenticated owner's lease.
- The shared worktree dialog forwards read-only (`GET`/`HEAD`)
   `/api/github/auth/status`, `/api/github/issues/{list,get,comments}`,
   `/api/github/pulls/{list,context}`, and `/api/magic-prompts`. These exact
   routes supply Host GitHub availability, linked context and prompt templates;
   GitHub authentication mutations and prompt-template writes remain forbidden.
- `/api/hosts/:hostId/api/*`: supported project/session APIs preserve method,
  body, query, directory headers, cancellation and streaming. Client credentials,
  cookies, arbitrary destinations, recursive host APIs and machine-level writes
  do not cross this boundary. Large bodies/streams do not inherit the index's
   15-second response-body deadline. Every proxy request still has a bounded
   response-header wait; receiving headers clears that deadline for streaming bodies.
   Snapshots/session reads use the short request budget. Mutations (including
   synchronous shell) and file/preview transfers use a separate five-minute
   operation header budget, rather than being cut off by the 15-second index
   budget. Ordinary JSON bodies remain bounded; file/SSE bodies stay cancellable
   without a fixed total-body deadline.
    `deadline.js` preserves those budgets and TimeoutError semantics while clearing
    deadline timers immediately when their request/connection parent is cancelled.
    Its unref timers weakly retain their owner and are finalized when an abandoned
    signal is collected; completed calls cannot keep a disconnected Host's timeout
    work alive. Streaming responses retain only the existing response-header timer,
    never a new fixed body deadline. Cancellation still reaches the transport and
    all existing authorization/generation fences remain authoritative.
    Gateway-owned `json()` reads additionally retain a request-local consumption
    signal through body parsing and the final descriptor/current-connection check.
    Their `finally` cancels only that local owner on success or failure, clearing
    its deadline without cancelling the shared connection or sibling requests.
    Receiving headers alone never completes this owner; raw/streaming `request()`
    responses retain their existing lifecycle and budgets.
    Optional file reads preserve the Remote's `x-yuri-file-exists` response header:
    an existing empty file and a missing file both have empty bodies, but remain
    distinct. Attachment uploads preserve `x-yuri-content-length`, `x-yuri-sha256`,
    `x-yuri-mime` and `x-yuri-filename` along with their original body bytes; size
    and digest validation still execute on the Remote. These allowlisted metadata
    headers never replace Remote authentication or forward Hub credentials.
- `/api/hosts/:hostId/api/terminal/ws`, `/api/hosts/:hostId/api/gui-network/ws`
  and `/api/hosts/:hostId/api/preview/proxy/*`
  mount real upgrades, mirrored in Relay and URL-token allowlists. Host removal
   closes direct sockets and Relay substreams, including pending handshakes.
   Client revocation tracks the raw upgrade socket before waiting for the upstream;
    authorization is checked again immediately before accepting the upgrade.
    Upstream message handling is installed at socket creation, before awaiting
    physical connection validation or downstream authorization. Frames arriving
    during admission (including the terminal protocol's immediate binary `ok`)
    are held in an ordered, memory-only queue capped at 1 MiB and 256 frames.
    They are forwarded with unchanged text/binary types only after the second
    authorization check and client upgrade. Overflow fails the upgrade and closes
    the upstream; revocation, socket closure and failure discard the queue.
    Direct and E2EE Relay use the same admission path. No greeting is synthesized
     and no terminal handshake timeout is extended to conceal missing frames.
     GUI TCP routes reuse the same credential, Origin and revocation gates for
     Browser sessions belonging to a Remote Project. Direct server-to-server
     upgrades set Origin to the admitted target's origin, never the Hub page's
     origin. Hub URL tokens are stripped; the Remote transport supplies its own
     saved credential. This does not open generic GUI-network HTTP forwarding.

The target-side local authority is `GET/POST /api/projects` and `PATCH
/api/projects/:id`. It only returns local projects. Authenticated
`/api/hosts/capabilities` advertises protocol 1 and the stable instance identity;
old/unavailable capability servers return a structured incompatible failure.
Transport admission uses this protected endpoint for both client authorization
and protocol negotiation, then reuses the result in the Gateway. It does not
require a separate `/auth/session` round trip or accept an unauthenticated health
response as authorization.

## Real time and lifecycle

The target-side `/api/hosts/status-stream` subscribes to the target's existing
server-owned event hub and product tips. It projects only session-summary/status
fields; token/part/message deltas and inbox bodies never travel this status stream.
Native execution/inbox boundaries, unread/order/folder and project revisions are
covered. The Hub holds one such subscription per referenced host while an
authorized global client stream is present, and no periodic full-list poll.
Short HTTP operations retain only their target transport, not a status observer;
creating projects without a global stream cannot start background index scans.
After the final project reference is removed, the last temporary HTTP/WS holder
also closes that Host connection when it releases. A global Hub stream alone
does not keep an unreferenced Host alive; late release callbacks after shutdown
do not query the already-closed SQLite store.
The first status connection, reconnection and `yuri:worktree-topology-changed`
invalidate the remote worktree catalog. Ordinary summary/status changes reuse
it. Refresh requests retain the existing per-Host serial/two-Host global budget.
Those topology edges also enqueue the referenced roots and verified worktrees
through the remote `/api/yuri/session-index/sync` scheduler. Merely reading its
SQLite snapshot would leave a headless remote's imported sessions undiscovered.
Subsequent revision tips pull the updated snapshot; ordinary index tips never
enqueue the same scan again. An empty snapshot while the scheduler is active
remains stale. No remote UI window is required to initialize the index.
A failed project's catalog keeps its prior mapping with an explicit stale root;
it cannot erase another project's summaries or replace failure with empty success.
Removing a verified worktree hides its old summary partition without deleting
remote sessions. The directory resolver is built once per snapshot, rather than
reading the SQLite project/catalog tables for each session bucket.

OpenCode form reads/replies (`/api/form`) are project/session operations and pass
through the same authenticated Host proxy as permission and question operations.
Reconnection uses bounded jittered backoff; one-second source heartbeats permit
the 1.5-second stream stall detector to invalidate live status promptly.

The client's existing global stream carries:

```ts
{ type: 'yuri:host-status', properties: { hubId, hostId, host } }
{ type: 'yuri:host-event', properties: { hubId, hostId, generation, directory?, payload } }
```

Content demand is shared by `(hostId,directory,sessionId)`. Its eight-channel cap
never evicts an active reader: a ninth distinct active channel returns 429. Zero
observer channels are immediately released. Every active lease gets its own
`yuri:content-ready` payload `{id:leaseId,sessionId,channelId,readyGeneration}`;
late joiners get current ready and upstream reconnect changes readyGeneration.
Clients deduplicate by lease plus ready generation, then fetch the authority tail.
The last global stream for an owner releases all its leases. Pending acquisitions
capture the owner's cancellation generation and cannot recreate a revoked lease.

No references means zero added background network requests/readers/timers. No
clients means status/content readers, retry timers and Relay sockets are closed.
Interactive session reads/mutations preempt every host's refresh; interrupted
refreshes are requeued. Continued network waits suppress only their own host's
refresh, so a slow response cannot freeze unrelated hosts. Up to two hosts refresh concurrently,
one per host. Failure/partial/aborted reads preserve the prior snapshot.

## Security

Aggregation requires a real desktop-local bearer or a current desktop/mobile
pairing grant. A password-less browser cookie is not a grant. URL-token requests
resolve the issuing client and recheck revocation/expiry. Every host-event send
uses a live resource filter in SSE, WS and the OpenCode SSE proxy subscriber;
unpaired global-stream consumers cannot receive remote content. Revocation
invalidates the filter before closing streams and outstanding operations.

Native setting changes reconcile ownership and replace connection generations.
SSH preparation installs its placeholder/promise before awaiting native work so
parallel cold requests share one preparation and transport. Credentials never
appear in public hosts, event envelopes or diagnostic errors. Direct candidates
of Relay-paired devices must prove server identity without credentials first.
Unpaired SSH never gets a Relay fallback. Target credentials remain in the Hub.
Native SSH errors are reduced to safe authentication/unreachable/service-starting
codes before crossing the adapter. Relay admission failures keep authorization
and incompatibility distinct from Relay unreachability; raw diagnostics remain
outside Gateway responses and receipts.

## Validation and evidence boundary

`routes.test.js` uses real HTTP servers, production route registration/auth,
SQLite, real WS upgrades, the real E2EE tunnel client and the private Relay server.
It covers dual-write recovery, write-through, generation/authorization races,
unauthorized fanout, per-client shared content readiness, zero-work startup,
resource cleanup, host removal, preview assets/redirects, repeated Relay concurrent
requests/creation/terminal and delayed concurrent SSH preparation.
The three-Host collision fixture also checks SQLite reopen isolation, offline
retention and the global two-refresh/per-Host one-refresh budget while one Host
is stalled. The production `scripts/remote-projects-smoke.mjs` exercises the real
`startWebUiServer` middleware, registration, forwarding and reference removal;
its synthetic direct origin does not establish physical SSH/Relay/UI parity.

These are deterministic correctness/operation-count checks, not production
Electron/iOS timing, CPU/memory, WAN or physical SSH evidence. Those gates remain
separate in the feature acceptance record; do not infer them from this suite.

Latest backend validation covered 173 passing tests across the Gateway, transcript
cache, queue, content search, auth, event runtime, SSE reader, folders and Relay
cross-compatibility suites. The Gateway HTTP suite has 20 cases, including failed
metadata write preservation and remote removal/reassociation. Electron's package
suite passed 504 tests with 14 skipped native evidence cases. Web production build,
Electron main bundle, Web type-check, Electron syntax checks and focused backend
syntax checks passed. Web lint has its existing path-normalization warning;
Electron lint is a no-op. Dead-code inspection reported no Remote Host module
or notification-identity findings. The unmodified production smoke passed twice
after capability admission replaced the separate auth-session preflight.

Integration follow-up added three red-to-green production HTTP/WS cases for
revocation during handshake, bounded response-header waits and cross-host refresh
while an interactive body remains open. All 23 Gateway cases pass; the combined
auth/event-stream run passes 111 tests. The full Web project subsequently passed
4014 tests with 20 skipped (305 passing files and 6 skipped).

This is not a complete feature acceptance result: skipped native evidence remains
unverified, and real desktop/Capacitor UI, physical SSH/WAN and production
performance must be validated by the integrating owner. No release or installer
launch is implied by bundle success.
