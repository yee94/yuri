# HTML/GUI network egress

Electron Browser also consumes this protocol through an isolated SOCKS5 session.
Remote Project sessions use the authenticated Hub
`/api/hosts/:hostId/api/gui-network/ws` upgrade, which forwards to this endpoint
on the selected execution Host. Client-local Electron sessions and ordinary Web
Browser views connect directly and do not acquire a GUI TCP channel.
The shared UI channel owner is `ui/src/lib/gui-network/channel.ts`; platform
adapters retain their own native SOCKS/stream-credit ownership.

`runtime.js` owns `/api/gui-network/ws`: an authenticated, origin-checked TCP
multiplexer reached through the existing private Relay dispatcher. Target bytes
are opaque; the Host resolves the destination and dials TCP, while the phone
WebView owns website TLS, cookies and browser origin checks. Yuri credentials are
used only for the upgrade, never added to target traffic.

## Wire and ownership

- Version 1 starts with `ready`. Controls are `open`, `opened`, `credit`, `fin`,
  `close`, `ping`, `pong`. Binary frames start with a big-endian uint32 stream ID.
- `ready.httpOrigin` optionally advertises `http://localhost:<listening-port>` for
  browser-owned Host assets. Clients accept only that canonical HTTP origin, with
  no credentials, path, query or fragment. Older Hosts can still carry GUI TCP;
  built-in loopback URL previews require this field and fail without it.
- 16 KiB chunks, 128 KiB credit per direction/stream, 32 streams per connection,
  eight authenticated connections per runtime. Credit returns only after the
  next consumer's write completes. TCP half-close is distinct from reset.
- Connect timeout: 15 seconds; TCP idle timeout: 120 seconds; client silence:
  60 seconds. Disconnect/shutdown destroys every destination owned by that WS.
- Host and UI Relay senders immediately flush this exact WS path through the
  unchanged serialized E2EE chain. Both WS path and URL-token allowlists include it.
- Authentication is the existing paired-client or enabled owner session gate.
  Paired-client revocation is rechecked periodically. Valid authenticated clients
  can reach any valid hostname/port visible to this Host, including private and
  loopback addresses; this endpoint has no per-plugin destination policy.

The client owner is `packages/ui/src/lib/gui-plugins/mobile-network.ts`. Its
native wire factory dials only the saved Relay endpoint using URLSession/OkHttp;
the existing TypeScript tunnel performs E2EE and multiplexing. It creates an
independent connection to the same Relay/Host identity, rather than installing a
WebView hostname bypass. Native sees ciphertext for this wire and bounded opaque
website bytes for its loopback SOCKS server. The main application tunnel remains
owned by the runtime.

## Native gateway lifecycle

`mobile-main.tsx` awaits `prepareMobileGuiNetwork()` before importing runtime
configuration or mounting the application. `prepare` installs a persistent local
SOCKS gateway. Without a GUI lease it forwards ordinary application TCP directly.
`capabilities.supported` means gateway preparation succeeded, not zero-bypass
network isolation.

Before GUI CJS/setup executes, `start` closes old gateway streams and switches
new streams to the Relay emitter. `start.direct` lists Yuri's own endpoints
(current Relay server, runtime origin, saved LAN candidates as `host:port`); the
gateway matches them at SOCKS connect time and forwards those streams directly,
so the application tunnel is never nested inside plugin egress. All other streams
use the plugin Relay channel, which the UI opens on the first plugin stream and
closes after 60 seconds idle. A lost channel fails only in-flight plugin streams;
the next stream reconnects with backoff while the lease and plugins stay loaded.
`stop` closes streams/wires and returns the gateway to ordinary application
forwarding; it does not uninstall the WebView proxy. Native owner destruction owns
final listener/proxy cleanup. The gateway shares the main iOS data store / Android
WebView process with ordinary app traffic; the direct list keeps that traffic off
the plugin channel. The goal is Host-equivalent reachability, not isolation.

`ui/src/lib/preview/mobile-html-network.ts` shares this owner between GUI setup and
built-in HTML previews. The last consumer releases the gateway. Built-in loopback
links register with `/api/preview/targets`, then load the authenticated Host proxy
URL through the same native SOCKS path. Website bytes still render on the phone.

## Coverage and limits

`runtime.test.js` exercises real auth/origin gates, half-close, byte fidelity,
credit and the Relay dispatcher. `native-ios.test.js` is opt-in via
`YURI_IOS_TEST_DEVICE` and `YURI_IOS_TEST_PRODUCTS` (Capacitor simulator build
products). It compiles production Swift into an isolated probe app, bundles the
production UI transport, and uses the real Relay server and Host E2EE with test
identities. It removes that app and stops its servers after running. It verifies
HTTP upload, WebSocket, nested iframe/dynamic script/fetch, HTTPS, failure after
the Host disconnects and ordinary networking after lease release. The six cases
combine `localhost` / `127.0.0.1` / `[::1]` with and without a pre-lease fetch
through the prepared gateway. Target HTTP/WS connections are matched against
actual Node Host outbound sockets; successful page loads alone do not prove routing.
Run native probes sequentially.

### Built-in URL preview acceptance (iOS 26.5, 2026-11-06)

The three additional `preview=true` cases pass for prewarmed `localhost`,
`127.0.0.1` and `[::1]`: production shared leases and URL mapping, real Host preview
proxy/auth, upload, WS, nested frames/scripts/fetch, HTTPS, Host-socket attribution,
failure after Relay loss and normal networking after final release. One shared
consumer is released early to verify the remaining HTML consumer retains egress.
Run these with `-t 'preview=true'`; filtering skips the six raw cases below, rather
than changing their acceptance status. Explicit IPv6 preview targets retain IPv6.

This is a scoped workaround for the built-in URL entry. Inline file documents and
arbitrary plugin JS are not globally rewritten, so the raw-IP bypass remains.

### Current failing acceptance (iOS 26.5, 2026-11-06)

| Target | Prewarm | Result |
| --- | --- | --- |
| `localhost` | No / Yes | Both passed: Host-socket attribution, disconnect and release recovery |
| `127.0.0.1` | No / Yes | Both failed: HTTP and WS bypass |
| `[::1]` | No / Yes | Both failed: HTTP and WS bypass |

All failing cases reach `/after-disconnect` directly after the Host stops.
`Cache-Control: no-store` and socket attribution exclude a cache-only explanation.
The persistent gateway fixed prewarmed `localhost`, but not loopback IP literals:
**2 passed, 4 failed**. The failing opt-in tests remain acceptance blockers,
not skipped/expected failures.

A separate native control created a new nonpersistent `WKWebsiteDataStore`, set
SOCKS to an unreachable loopback port with `allowFailover = false`, then created
the WKWebView and loaded local HTML. It used neither Capacitor nor Relay. HTTP/WS
to `localhost` failed; HTTP/WS to both loopback IP literals still reached the
target directly. This rules out Yuri's Relay and reuse of its default data store
as causes of this simulator result. A fresh container alone is not an evidenced
fix. Explicit match domains, a hostname proxy endpoint and HTTP CONNECT also
failed earlier controls; those experimental changes were removed.

These observations are from iOS 26.5 Simulator. Physical iOS behavior is still
unverified; no connected iPhone was available. Latest complete Android debug and
iOS simulator product builds passed, but Android has no device-network evidence.

This is a TCP/WebView proxy, not an OS VPN or a JavaScript sandbox. WebRTC/UDP,
native network APIs, external-browser handoff and connections created before the
proxy was installed are not an enforced all-network boundary. Independent plugin
containers and strict network isolation remain unfinished. See the mobile README
for scope and the GUI Provider documentation for activation and release ordering.
