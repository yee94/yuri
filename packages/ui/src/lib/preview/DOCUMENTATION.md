# Mobile HTML networking

## Desktop Browser and shared ownership

Browser network routing follows the session's execution Location. Web Browser
iframes load the original URL on the client without target registration,
URL-auth or proxy rewriting. Electron local sessions also load directly.
Electron remote sessions use an isolated SOCKS webview partition via
`desktop-browser-network.ts`; Remote Projects use their Host-scoped GUI TCP
route rather than the current Hub. Direct/SSH and Relay use the same adapter.
The guest mounts only after proxy configuration completes, and runtime/scope
loss closes it without a client-network fallback. This requires a new installer.

The protocol/auth/ready/heartbeat implementation is shared with native-mobile
HTML and plugins in `../gui-network/channel.ts`. `HtmlNetworkBoundary` owns the
shared execution/retry lifecycle; `MobileHtmlNetworkBoundary` now only selects
the mobile eager/lazy acquisition adapter. Browser's former iframe proxy
registration/auth/gateway branch was removed. Other file/preview gateway
consumers still own their existing routes, as described below.

## Remote project scope

`project-preview.ts` provides `resolveProjectPreviewUrl(entry, url, signal)` for
an explicit project Host. Loopback target registration goes through that entry;
the resulting browser URL retains the host prefix before Hub URL authentication.
External origins receive no Yuri credentials. The Hub preview proxy must preserve
that prefix across HTML/CSS resource rewrites, redirects and WebSocket upgrades.
This helper only owns the entry URL, not the entire resource graph. Native HTML
network leases and UI callers must explicitly integrate the scoped source; the
existing Hub-only mobile source is not silently rebound to a remote project.

`mobile-html-network.ts` owns reference-counted native network leases shared by
the GUI host and built-in HTML views. It delegates to `gui-plugins/mobile-network`
and the existing paired Relay; it does not create another Relay service. Concurrent
consumers share startup. Cancelling one does not cancel the others. The last owner
releases the native gateway; runtime generations never share an entry, and a failed
open is never shared. Acquiring only routes plugin egress; the Relay channel connects
on first use or `connect()`. Channel loss notifies every owner but keeps the lease.
Yuri's own Relay/runtime/LAN endpoints always bypass plugin egress.

`MobileHtmlNetworkBoundary` gates built-in HTML execution on that lease and calls
`connect()` for the Host HTTP origin. On failure or runtime switch it removes iframe
descendants before passive cleanup aborts its owner. It exposes a local retry. Ordinary web/desktop/VS Code rendering passes
through without a native lease. `GuiPluginMount` uses it with `connect={false}`: plugin
views route egress while mounted without waiting for the handshake. Plugin loading and
setup take no lease, and the rest of the application keeps its original network path.

Native mobile `openExternalUrl` loopback links (including bare `localhost:port`),
`openContextPreview`, and `openContextBrowser` open `MobileHtmlPreviewSheet`.
`useMobileHtmlPreviewStore` holds only the transient URL and runtime generation.
Closing releases its owner; switching runtime hides the previous target immediately.
The sheet validates both iframe window and origin before accepting preview-bridge
navigation. External links explicitly opened inside the sheet stay in that surface.

`mobile-html-source.ts` registers loopback URLs with the existing Host
`/api/preview/targets`, mints scoped browser URL auth, and maps the authenticated
proxy path to the network handshake's validated `httpOrigin`. `localhost` denotes
the connected Host, not the phone. IP literal links take the same path. An older
Host without `httpOrigin` fails explicitly. External website URLs receive no Yuri
credentials and use the native proxy with their original URL.

For Remote Projects, the registration uses the explicit Host entry and validates
the returned scoped proxy base. Gateway responses already containing the matching
Host prefix are not prefixed twice; another Host's prefix is rejected. The native
network lease still belongs to the current Hub, not a second per-Host Relay.
Preview and screenshot resource requests capture the Host entry and reject late
completions after its generation changes.

The URL sheet owns a proactive URL-auth consumer and renews expiring preview
targets. Credential/target renewal replaces the iframe URL; it can reload page
state. Registration/network failure removes the document and exposes retry.
Cancelled/stale registrations cannot mint credentials for the next runtime or
replace its displayed document. Ordinary rerenders do not reconnect or re-register.

`project-file-preview.ts` registers built-in file HTML as an explicit file target,
not an authenticated FS entry URL or Relay `srcDoc`. The captured project entry,
physical directory and entry path are sent through the existing Hub transport.
The returned browser path retains the Host, target token and short URL-auth token
as an envelope inherited by native browser relative URL resolution. CSS imports
and images, module imports/dynamic imports, fetch and nested iframes therefore keep
the same scope without copying credentials onto external websites. The server
canonicalizes every descendant inside the registered project root and rejects
symlink escapes. Existing preview rewrites handle root-relative references.

The helper maps that same path to the native lease's validated Host HTTP origin,
or to the existing Electron Relay preview gateway. Relay without a browser gateway
fails explicitly instead of silently rendering broken inline HTML. The native
lease still belongs to the Hub; no per-project network or global runtime is
created. See the owning server `lib/preview/DOCUMENTATION.md` for the path parser,
Hub-token stripping, normal auth/revocation checks and read-only route contract.

Callers own iframe loading/error/retry and remove it immediately on path, Host,
generation or lease failure. Abort/release revokes the target idempotently;
failed cleanup after the old transport ends is bounded by server expiry and is
never sent through the new runtime. Callers keep the existing proactive URL-auth
consumer and renew the source when that short credential changes, as well as
before the target deadline. A failed registration must not restore stale HTML.

## Evidence and limits

Focused UI tests cover sharing, cancellation, failure ordering, late generations,
URL mapping/auth, retry, renewal, bridge message origin and 50 unrelated updates.
The iOS probe uses production Swift, shared lease owner and URL resolver with the
real encrypted Relay/Host preview proxy. Prewarmed `localhost`, `127.0.0.1` and
`[::1]` proxy cases pass upload, WS, nested frames/scripts/fetch, Host-socket
attribution, disconnect failure and post-release networking.

This does not fix WebKit's direct-IP proxy bypass for arbitrary plugin scripts.
The raw-IP cases remain failing acceptance tests. Physical iOS, Android networking,
independent containers and strict all-network isolation remain unverified or
unfinished. See `packages/web/server/lib/gui-network/DOCUMENTATION.md`.
