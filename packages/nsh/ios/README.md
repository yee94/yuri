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

The compile also includes the existing, Capacitor-independent
`packages/mobile/ios/App/App/YuriViewExportRenderer.swift`, required by
`GuiPluginDeviceBridge.swift`. The renderer is reused directly, not copied or forked.

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

GUI 文件内容使用独立 `GuiPluginPreviewBridge`，由主控制器注册；主界面仍由 NSH/UIKit 渲染。首次打开时才验证已暂存的 `gui-plugin-preview` 资产并创建应用私有的 Host 存储 backend，资产缺失不会阻止其他页面启动。每次 capture 使用 Runtime 的精确 Host lease，并同时提供 buffered 与 lossless pull reader；认证和 Relay 仍归 Runtime。Host 失效、后台和主控制器退出均撤销该原生预览。完整主题/语言/context、文件入口及真实插件验收状态见 `../GUI-PLUGIN-CONTRACT.md`，注册完成不代表这些能力已全部验收。

单日期选择器由 `DatePicker.swift` 的系统 inline `UIDatePicker` 所有。NSH wrapper 传应用 locale、0–6 的周起始和 before/after 日期界限；Swift 转换为 Calendar.firstWeekday、minimumDate/maximumDate，严格验证 ISO 日期。range、自定义离散禁选或时间编辑继续交 NSH 原有 DatePicker，避免静默忽略 UIKit 无对应的合同。系统日历实际禁选、语言与周起始布局仍需 UIKit 验收。

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

Passing `assistantID`, `requestId`, `expectedHost` and the captured contact/draft context selects the contact receipt
protocol frozen in the Host assistants documentation. Before presentation,
`contactAttachmentOperation` captures the original authenticated connection and
lease, reads `/contact/messages?limit=1` generation, and requires the exact receipt
probe (including a validated 404 not_found envelope). The GET generation must equal
the JS adopter's already-authoritative captured generation. Read failure is never zero;
an old Host's generic 404 never permits a legacy PUT. PUT carries the original
generation query and receipt-aware Accept marker alongside integrity headers. A 201
also requires a fresh exact receipt GET before returning a descriptor for adoption;
a reset between commit and ACK cannot be adopted through that result.

The native AttachmentBridge retains up to 64 exact operation owners independently
of picker/page lifetime. Picker `defer` releases presentation, not an ambiguous
upload receipt. `runtime.reconcileAttachment` performs GET only; committed data
can return only through the original live lease and JS adopter. The actual state
adopter captures target, canonical contact generation, durable edit revisions and
the exact application page-operation object; all must still match before one append.
Unknown/cached-only generation cannot open a picker. The
existing attachment button retries this original reconciliation when unknown;
it does not open another picker or repeat PUT. A null reconcile result means
still unresolved (not_found/inflight), not cancellation success.

`runtime.cancelAttachment` awaits `retirePick` and the exact durable DELETE ACK.
The native-only retirement closure has the original connection and authorization
identity, is callable only by its exact policy, and cannot issue arbitrary paths,
GETs or uploads. It can retire after a lease/selected-Host change while the original
authorization remains registered. Revocation/unavailability keeps a retryable
failure. The original opaque connection, transport, authorization and connection-record
version must still match; a changed/revoked/missing record sends no recovery traffic
and reports original-authorization-unavailable, keeping the receipt for retry. It
never obtains new credentials. `runtime.acknowledgeAttachment` releases
the owner only after descriptor equality and original authorization checks; JS invokes it
after the original adopter accepted the descriptor and its existing durable draft
owner finished the attachment write. The pending/reconcile/acknowledge handlers are
installed in main.swift and included in the NSH capability allowlist.
An already accepted original draft can finish this exact local ACK after its lease
retires; that local release grants no new send/PUT authority and uses no network.
This applies to cold recovery as well: after a committed GET, AttachmentBridge retains
only the exact local ACK closure until durable adoption and metadata removal finish.
It never reconstructs that ACK through a fresh admission. Storage failure retains
the closure for retry; original authorization/record changes still reject it.

Retirement prevents new admission; it never reports physical deletion. Original
provider files/session temporary files and shared objects remain untouched; same
hash with distinct uploadIDs stays independent.

`AttachmentReceiptJournal` uses the existing `NshAppView.storageDirectory` device
storage interface (or NSH's documented per-app default directory). Atomic, metadata-only
write-ahead records retain exact assistant/upload/request/generation, descriptor,
opaque original connection/transport/authorization/record-version references,
hashed durable draft identity, durable checkpoint revision and opaque page-operation.
It never serializes closures, credentials, source bytes, user paths or message text.
Every write rereads the bounded journal and compares request/upload identity; a late
clear cannot remove another operation. Corrupt/unreadable storage is failure, never
an empty journal. At 64 pending operations new selection fails without eviction.

The prepared record is durable before presentation. The unknown record is durable
before PUT dispatch. A failure in either stage reports zero dispatch; a failure after
dispatch retains unknown. ACK descriptors are persisted before adoption. Retirement
persists its irreversible local fence before DELETE, then clears metadata only after
a validated Host retirement ACK. Failed DELETE/storage cleanup remains retryable.

After process restart, the existing attachment button explicitly reads
`runtime.pendingAttachments` for its exact draft/assistant/Host and reconciles an old
receipt. The native restored operation can only GET/DELETE its original upload; its
upload closure always rejects. Adoption additionally requires the same durable
checkpoint and a fresh current page/Host/generation CAS. If a prior draft write
already contains the exact descriptor, recovery confirms it without a duplicate append.
A newer draft rejects adoption and exact-retires the upload. A surviving old native
page owner is exposed as retirement-only with its original cleanup scope, never
transferred to a new page. No startup path auto-appends recovered attachments.

Focused synthetic evidence: `attachment-upload-swift.test.ts` executes policy and
production picker delegates with delayed UIKit doubles, and typechecks picker plus
the extracted production Runtime attachment methods against the iOS SDK. It uses
temporary original files and injected transport, without Host/network/device/model.
It also executes native journal/runtime reconstruction, exact production authorization
lookup, lost ACK/reset, storage failures, same-hash isolation, no-replay and capacity
contracts. `state.test.ts` runs the actual state adopter and the existing picker retry
entry. These synthetic checks do not establish actual UIKit/Photos/Relay behavior.

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
