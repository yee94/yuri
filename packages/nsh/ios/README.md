# Native iOS Host

This UIKit host embeds the static NSH 0.4.0 `NativeShell.xcframework` and loads
`nsh/bundle.nshc`. It is separate from the Capacitor app: its bundle identifier is
`com.yee94.yuri.nsh` and its product is `.nsh/out/YuriNative.app`.

From the repository root:

```sh
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/scripts/build-ios.mjs
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/scripts/build-ios.mjs --device
bun packages/nsh/scripts/check-native-bridge.mjs
```

`NSH_BIN` defaults to `nsh` on PATH. `NSH_DIST` optionally selects the distribution
root containing `embed/ios`; otherwise it is resolved relative to the executable's
real path. Builds require Xcode with an iOS 26 or newer SDK, use Swift 5 mode and
target iOS 15. Both device and simulator products are arm64. Simulator products are
ad hoc signed with simulated Keychain entitlements embedded in the Mach-O
`__TEXT,__entitlements` section, matching Xcode's simulator behavior; device
products are unsigned by default. The script builds TSX,
compiles all `ios/*.swift`, links the static framework and system frameworks, copies
bundle resources, and writes Info.plist. A failed compile preserves the previous
successful app. No framework is dynamically embedded.

## Yuri brand resources

`scripts/generate-branding.swift` uses system CoreGraphics/ImageIO, without an
NPM or Python image dependency. It derives the iOS icon from the approved
`assets/brand/yuri/yuri-b-icon-{light,dark}.svg` gradient colors and the matching
1024px B mark alpha. The artwork retains its approved proportions, but has no
desktop exterior margin, shadow or pre-rounded mask: SpringBoard owns that mask.
The generated catalog is `.nsh/branding/YuriBrand.xcassets`. `actool` compiles both
icon appearances, and its primary-icon plist is merged into the app Info.plist
before signing. The Keychain Mach-O simulator entitlements are unchanged.

`LaunchScreen.storyboard` uses adaptive `YuriMark`, `YuriWordmark` and the native
theme's background color. All images have 1x/2x/3x variants and use the existing
brand PNG exports. `ibtool` compiles the launch screen into the app.

TSX consumers import `YuriMark`, `YuriWordmark` and `yuriBrandSizes` from
`../branding` (adjust the relative path for the caller). Both components accept
`size: 'compact' | 'standard' | 'hero'`, `decorative?: boolean`, and
`testID?: string`. Mark sizes are 32/64/96pt; wordmark widths are 80/112/160pt with
the original aspect ratio. They use NSH `Image` and direct local SVG imports,
reactively selecting black/white artwork with `colorScheme()`. The build syncs
the four approved SVGs into `assets/brand/` inside the NSH package: NSH 0.4 does
not copy imported assets outside its project root into the output bundle.
No WebView,
network URL, emoji or substitute typography is used. NSH bundles these imported
assets when the welcome/About caller imports the components.

The standalone `scripts/branding-preview.tsx` entry exercises those imports
without editing the application's screens:

```sh
nsh build packages/nsh/scripts/branding-preview.tsx --release --out packages/nsh/.nsh/branding-preview
node packages/nsh/scripts/verify-branding.mjs
```

The preview is a headless component test entry, not an installable package.
`verify-branding.mjs` checks the real app bundle (including all four imported SVGs),
adaptive AppIcon/launch catalog entries, the compiled storyboard, code signature
and embedded simulator Keychain entitlements. It writes inspectable JSON/text
evidence to `.nsh/out/branding-evidence/` without touching Simulator.

After the main session finishes any live conversation, install the successful
app, return Home, and capture SpringBoard. Do not uninstall the app to refresh
its icon: that can destroy local data. Installation and launch are deliberately
not part of the build script.

```sh
xcrun simctl install booted packages/nsh/.nsh/out/YuriNative.app
# Return to Home using Simulator controls, then capture the actual Home screen:
xcrun simctl io booted screenshot packages/nsh/.nsh/out/springboard-brand.png
xcrun simctl launch booted com.yee94.yuri.nsh
```

Check Home in light/dark appearance and inspect the actual launch transition;
static asset inspection alone is not evidence that SpringBoard or UIKit rendered
the intended appearance.

Optional device development signing requires both `NSH_SIGN_IDENTITY` and
`NSH_PROVISIONING_PROFILE`. Use a development provisioning profile that covers the
bundle identifier and your test device. The build checks its identifier, expiration
and development entitlements, then embeds it and signs. This does not publish an
archive, App Store release or TestFlight build.

## Native boundary

- `ConnectionStore` atomically persists connections and credentials in one
  device-only Keychain record. Public connection metadata excludes credentials.
- `RuntimeBridge` issues password credentials through `POST /auth/session` with
  `issueClientToken: true` and `trustDevice: true`. Pairing uses the existing v2
  redemption endpoint. Authorization headers are constructed only in Swift.
- Requests are restricted to the selected Host origin. Auth-management routes,
  traversal paths and redirects are rejected. Responses require JSON, except the
  exact `/api/fs/read` path which also accepts UTF-8 `text/plain`. HTML is rejected.
  Response reads stop at 32 MiB rather than buffering unlimited bytes.
- Connection changes invalidate pending requests, connection attempts and uploads.
  Replacing/stopping an SSE subscription cancels only that subscription. SSE uses
  explicit CR/LF parsing to preserve empty-line event boundaries, a 2 MB event
  bound, and bounded reconnect backoff.
- A Relay connection additionally stores its canonical Relay URL, server ID and
  pinned P-256 public key in Keychain. Direct connections and each server/Relay
  endpoint have separate identities. Public metadata adds `transport: direct | relay`.
  Pairing probes ordered direct candidates before Relay, falls back only on network
  failures, checks advertised Host identity, and redeems exactly once over the
  chosen transport. A lost redemption response is never automatically retried.
  Relay HTTP, SSE and uploads use `RelayTunnel`; changing connections closes the
  previous tunnel. SSE keeps partial UTF-8 bytes until complete line boundaries.
- Deep links are buffered until the controller is visible and require native
  confirmation. Confirming emits `connection.link`; only a subsequent explicit
  Connect action redeems the link. The TSX root must handle that event and route
  to the connection form, including when a saved connection is already active.
- The QR scanner serializes camera start/stop and never starts after cancellation.

## Attachments

`runtime.pickAttachment({kind: 'images' | 'files'})` uses PHPicker or the document
picker. Cancellation returns `null`. Success returns only `{uri, name, mime}`;
file bytes never cross the TSX boundary. Swift reads regular files with no-follow
semantics, rejects directories/symlinks/empty files, limits reads to 25 MiB, hashes
the data with SHA-256, and sends a raw PUT to
`/api/fs/prompt-attachments/:attachmentID?storage=temporary` with the four
`X-Yuri-*` metadata headers. Filename headers use `encodeURIComponent`-equivalent
encoding. Returned digest and length must match before the Host path becomes an
encoded `file://` URI. A connection switch invalidates the captured upload scope.

Assistant attachment descriptors use another server contract. Passing
`assistantID` currently rejects explicitly; expose the picker only for session
targets until that contract is implemented.

`check-native-bridge.mjs` compiles the production bridge for macOS against a small
NSH test double and exercises a local HTTP/SSE fixture. It covers password issuance,
bearer headers, the production public metadata value, JSON/text/HTML boundaries,
declared response limits, redirects/traversal, stale request/connect/upload results,
attachment upload headers/digests/URI encoding, and replacement of an active event
stream. Its Bun WebSocket fixture uses the production JavaScript Relay crypto and
mux codec to verify candidate fallback, single redemption, encrypted HTTP/uploads,
chunked UTF-8 SSE and reconnect. It needs Bun but installs no dependencies.
Persistence is replaced in this harness, so it does not write Keychain or
prove picker permissions, camera behavior, device signing or real Host operation.
