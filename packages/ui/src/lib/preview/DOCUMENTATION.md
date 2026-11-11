# Mobile HTML networking

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

The URL sheet owns a proactive URL-auth consumer and renews expiring preview
targets. Credential/target renewal replaces the iframe URL; it can reload page
state. Registration/network failure removes the document and exposes retry.
Cancelled/stale registrations cannot mint credentials for the next runtime or
replace its displayed document. Ordinary rerenders do not reconnect or re-register.

Built-in file HTML in `MobileFilesSurface` and `FilesView` uses the same network
boundary. Its existing file delivery remains unchanged: Relay reads inline HTML;
direct connections use the authenticated FS serve URL. Inline file-relative assets
are not a complete authenticated resource graph; this change does not claim that
arbitrary relative-resource HTML files now work. Their browser-owned absolute
requests use the same native gateway and inherit its platform limits.

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
