# Shared HTML/GUI TCP channel

`channel.ts` owns URL authentication, protocol-v1 ready validation, the bounded
startup deadline (including authentication), heartbeat, cancellation and socket
cleanup for `/api/gui-network/ws`. It accepts a socket factory and an optional
Host-scoped path. There is no second protocol, Relay service or credential store.

Consumers:

- `gui-plugins/mobile-network.ts`: shared native-mobile HTML/plugin leases,
  lazy dialing, reconnect/backoff and native stream credit. Its platform wire
  remains separate from the application's transport.
- `preview/desktop-browser-network.ts`: a session-Location-scoped Electron
  Browser lease. It uses the existing runtime transport, with
  `/api/hosts/:hostId/api/gui-network/ws` for Remote Projects. Electron main owns
  SOCKS, per-stream credit and isolated in-memory webview partitions.

`components/preview/HtmlNetworkBoundary` is the shared execution gate: no HTML
content until acquisition succeeds; remove descendants on owner/generation
change or failure before aborting the old lease; retry acquires a fresh lease.
Mobile HTML/plugin adapters retain their different eager/lazy connect behavior.

The Browser policy is deliberately simple: ordinary Web uses the client's
network directly. Electron uses direct networking for a client-local session;
all remote sessions use their execution Host, whether reached over direct/SSH
or Relay. Remote Project Location takes precedence over the window's Hub.
The existing desktop realtime proxy also admits these exact WS paths for
custom-header runtimes, retaining its configured-runtime and local-auth gates.
No failure falls back to client networking. A missing desktop bridge requires
the newer installer; Browser has no legacy iframe-proxy fallback.

This does not change file-target authorization or the transport required by
other preview surfaces. An ordinary iframe cannot select a separate Electron
session. Those consumers still use the preview gateway; configuring the app
session's SOCKS proxy to reach them would also reroute Yuri's own traffic.
