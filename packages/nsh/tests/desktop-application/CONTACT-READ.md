# Actual desktop App contact-read evidence

## Scope and ownership

`ContactRead.test.tsx` opens the real production `App.tsx` / `YuriNativeApp`, not
an independent List, fake controller or alternate read transport. The existing
ChatOwner creates the controller and owns its single inverted List, latest
authoritative message, marker refs, active/modal state and PageOperation.
The application consumes the original List's read-only snapshot; state, source,
transport, history budget and scroll ownership remain unchanged.

`desktop-assistant-read-marker-native.test.ts` creates an isolated temporary
config/entry, bundles the existing synthetic desktop Host and runs this file.
Both platform models use only synthetic Host records and native writer receipts.
Unknown Host requests fail, all read mutations pass the existing
`createDesktopWriterHost.assertWrite`, and every scenario asserts zero direct
network requests. No real Host, credentials, OS window or external network is
used. Temporary files and the bundled synthetic Host are disposed after the run.

Four positive scenarios open completely uninstrumented `App.tsx`, independently
asserting the exact POST and its original verified writer grant. Remaining
scenarios open `ContactReadRoot.tsx`, which mounts that same `YuriNativeApp`.
It observes the public native-ref `measure()` / `getScrollSnapshot()` prototype,
returns unchanged native results, and optionally holds real snapshot or 1×1
measurement Promises to test late completion. Its detached probe only obtains
that prototype; no replacement
List, marker, controller or transport is mounted. It never synthesizes geometry,
scroll frames, events, positions, authorization or success responses in product
code. Each opened App has its own isolated native engine/prototype.

## Scenarios

Each of the following runs on both macOS and Windows headless models:

1. **Uninstrumented positive:** actual App sends exactly
   `{generation:9,ordinal:24,messageID:"read-message-24"}` to
   `POST /api/yuri/assistants/alpha/contact/read`, using the original native
   assistant writer grant. Only one assistant writer is acquired.
2. **Measured positive/no repeated work:** the same real POST, positive native
   marker/viewport measurements, 50 unrelated composer input updates with zero
   further read measurements/POSTs, and 60 seconds of manual-clock advance with
   no read replay.
3. **Away/unseen/new position:** scroll the original List 1800pt toward older
   content, verify the latest marker is not shown, append a real authoritative
   message via a complete GET after the existing Assistant event, and observe
   zero new read POSTs through 30 seconds. Returning to actual latest sends only
   `{generation:9,ordinal:25,messageID:"read-message-25"}` with the same grant.
   This combines the away and unseen conditions; their independent geometry
   gates remain covered by the pure controller suite.
4. **Settings/late measure:** hold the original marker's real native measurement,
   open actual Settings, release that measurement while covered and assert zero
   POSTs. Closing Settings performs a fresh current check and sends the exact
   original position without acquiring another writer.
5. **Unknown receipt:** lose the real read response after verified synthetic
   native dispatch. Two 60-second clock advances, a complete catalog refresh,
   resize and Settings open/close cannot replay the POST, replace/release/renew
   the writer or authorize native close. The original writer remains held and
   native close is vetoed. The unknown Chat lane also refuses new contact
   history GETs; a successful post-unknown contact-history read is therefore
   **not** claimed as exercised by this actual-App scenario.
6. **Uninstrumented short-content positive:** one real message is acknowledged
   exactly once at `{generation:9,ordinal:1,messageID:"read-message-1"}` with the
   original verified writer grant, before any gesture. Both public scroll
   directions still report `at 0 of 0`; resize and clock advance do not replay.
7. **Short snapshot/modal race:** hold an actual initial snapshot, open Settings,
   release it while covered and observe zero POSTs. Closing Settings requires a
   fresh original-List snapshot before the exact-position acknowledgement.
8. **Scope/ref retirement:** hold an actual short snapshot, leave for Schedule,
   then release it with zero POSTs. Reopening Assistants admits a new owner/ref
   and sends the exact current position through its own original grant.
9. **Layout generation:** resize while the real snapshot is held, release only
   that old reply, and require zero POSTs while a newer snapshot remains held.
   Releasing the new snapshot sends the unchanged exact position once.
10. **Scroll generation:** hold an actual long-content snapshot, move the
    original List 1800pt away, then release it. No read or automatic return is
    allowed through 30 seconds; the original return-to-latest gesture succeeds.
11. **Position generation:** append a second authoritative message through the
    existing event/complete GET while a short snapshot is held. Releasing the
    old-position result cannot POST; a fresh snapshot sends only ordinal 2.

There are 22 engine behavior scenarios, including both former short-content
diagnostics converted into uninstrumented positive exact-POST tests. The measured
positive also requires zero further snapshot reads across 50 composer updates.

## Actual geometry checkpoint and native-event causality

Before the contact-inset follow-up, at a 1440×1000 viewport both models measured:

- original List viewport: `{x:578,y:241,width:862,height:683}`;
- latest real marker: `{x:606,y:907,width:1,height:1}`.

This checkpoint used the then-current 28pt horizontal and 16pt logical-header
insets. The tests do **not** hardcode those rectangles or depend on those inset
values, so the owning application can update contact spacing independently.

NSH virtualized row measurements can change content extent during a gesture.
Returning a fixed 240pt after a 240pt upward gesture did not reliably reach the
new physical latest edge. The fixture uses only public `app.scroll` gestures
and repeats a large downward gesture at most eight times until the engine
reports no remaining movement. It never fabricates an onScroll frame. The
second exact-position POST is still required, so a zero-request false positive
cannot satisfy the return-to-latest assertion.

## Event-driven original-List integration

Only desktop contact Chat constructs `createDesktopAssistantReadSnapshot` beside
the existing reader. Original List/marker layout and exact ref, position,
operation, readiness and activity changes request one singleflight read. Each
request invalidates the reader's prior frame before awaiting the native result.
The adapter revalidates exact List/marker refs, owner admission, operation and a
copied authoritative position, plus its event generation. A newer layout,
scroll, position or pause/resume cannot revive an old reply, even at equal
geometry. Cleanup permanently retires both adapters.

A non-null admitted result goes directly to the original read controller's
`scroll(snapshot)`. The existing `onScroll` handler still delivers genuine user
frames through the adapter, invalidating pending snapshots without generating a
new event. Read-only results never enter history/onScroll pagination. No extra
List, listener, timer, guessed frame, automatic scroll, store or transport is
introduced; ordinary Session and iOS do not construct this consumer.

Removing only the actual List getter from this integration makes the two
uninstrumented short-contact positives fail (zero POST within 5 seconds on each
headless platform). Restoring it makes the complete focused suite pass.

## Frozen native read-only API / independent patch handoff

The independent upstream patch is
[`list-scroll-snapshot.patch`](../../patches/nsh-0.4.0/list-scroll-snapshot.patch).
Its public signature is frozen:

```ts
interface ListRef extends ViewRef {
  getScrollSnapshot(): Promise<ScrollEvent | null>;
}
```

- The result contains actual `{offset, contentSize, size, zoomScale}` in native
  points, using the existing scroll-event coordinate convention. Inversion does
  not turn the returned physical offset into a logical item offset. Pixel ratio
  is not a coordinate multiplier.
- `ListRef` sends an explicit command after the current commit. AppKit/Win32 read
  their live `ScrollState`; headless reads `Screen.scroll` when applying that
  command. Core/ListState offset can contain pending replay and is **not** used
  as the returned native offset. No zero offset or synthetic frame fallback is
  supplied.
- This command has its own private root reply. It neither scrolls nor emits
  `onScroll`, grants pagination/gesture budget or adds listeners to every List.
  It introduces no timer, polling or scroll writer.
- macOS and Windows currently do not implement zoom; their actual supported
  scale is `1`. iOS, Android and other unsupported platforms explicitly resolve
  `null`; the iOS scroll-event path is unchanged. The Web ref also resolves
  `null` rather than guessing a native snapshot.
- Absent, detached, unlaid-out, parent-viewport and non-List targets resolve
  `null`. Invalid/zero geometry and a reply whose viewport/content extent no
  longer matches the pending List are rejected. Detach/release cancels pending
  reads immediately, including reads inside a detached ancestor; a later reply
  cannot revive the old request after reattachment. Duplicate replies are ignored.
- This is a point-in-time read, not a transactional layout/position subscription.
  The consumer must capture and revalidate the exact List ref, active owner,
  PageOperation, authoritative read position and layout generation after `await`.
  A newer scroll/layout/position or retired owner invalidates the consumer's
  pending read even if extents happen to be equal. A non-null current result goes
  directly to the original `createDesktopAssistantReadMarker().scroll(snapshot)`;
  `null` is not permission to fabricate a frame or relax controller gates.

### Hash chain and focused evidence

- Source is a fresh independent copy of verified digest
  `7834beffee6dc6dd588bee99f717366a37dca2282ceb53544b80734e800f97e0`,
  revision `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`. The original complete
  baseline has 1,740 files; the already-applied Shift/Diff preparation has 1,741.
  All 1,741 prepared files were rehashed against its immutable receipt, including
  the legitimate `crates/nsh-core/src/image/cache/tests.rs`. No old normalized
  baseline was used.
- Patch SHA-256:
  `a68c39e74ab98f2685b12464086796f644bceea5281a62180295feff5270e674`.
  It changes 21 files, including four explicit creates. Before/after SHA-256 and
  `beforeExists` for every file, full-tree hashes, unchanged Cargo.lock hash,
  final scratch CLI/generated-types hashes and command logs are recorded in
  ignored `.nsh/compat-list-work/hashes.json`. Existing files use exact unified
  hunks; creates use `/dev/null` and a single full-addition hunk.
- The unchanged preparer's `applyStrictUnifiedPatch` and `hashNSHTree` accepted
  all 21 declarations with no fuzz or offset search and reconstructed the full
  1,745-file scratch tree exactly. This verification does not register a new
  preparation or modify its manifest, tools, lock or source.
- `cargo --offline --locked`: six Core snapshot tests, two `nsh-testing` focused
  Rust runners (five macOS/Windows/iOS JS scenarios plus real headless reads at
  pixel ratios 1/2/2.5/3), and 17 JS declaration tests pass. Coverage includes
  initial normal/inverted short content, long-list physical offsets, actual List
  resize, late extent/ref replies, cleanup and 50 repeated reads without extra
  scroll/load-more events. The JS scenarios assert zero direct network requests.
- AppKit backend `cargo check` and the final scratch CLI build pass. That CLI,
  not a handwritten declaration, generated the isolated probe's types; existing
  local TypeScript checked the exact nullable Promise signature and verified the
  method is not on `ViewRef`. No dependencies were installed. Cached Knip with
  installation disabled is blocked by existing missing `vite-plugin-pwa` in
  `packages/web/vite.config.ts`; no complete dead-code result is claimed.

These are independent preparation-external patch proofs. Actual production App
consumption and conversion of both short-content diagnostics are now covered
above using the paired diagnostic tools. Final preparation registration and the
next corrected CLI/runtime digest remain the main/preparation owners' work.
Windows native compilation, physical AppKit/Win32/UIKit windows/gestures and a
real Host/native writer authority are not validated here.

## Toolchain evidence and rerun

- Original NSH 0.4 desktop distribution: 12/12 scenarios passed; the pure
  controller suite also passed 59/59. This is historical old-engine App evidence,
  not evidence that any compatibility/Diff patch is active.
- Same-digest patched CLI **and** runtime:
  `86fb08a597f2a5b0389f61cac1831a0f3bd55f46a54f35e006ab26269ff1cfe7`:
  12/12 scenarios passed with both `NSH_BIN` and `NSH_RUNTIME` set. This validates
  these actual-App receipt scenarios on that paired toolchain, not Diff behavior.
  A subsequent compatibility digest must be rerun independently.
- Diagnostic paired CLI **and** runtime
  `8a261f52b450ac75cc77225f2751bda1dc59097dd1e48ac5677f67d3ad77ff25`:
  22/22 current actual-App scenarios pass, as do 60 marker and 13 snapshot pure
  tests. Local TypeScript passes. Cached Knip with installation disabled remains
  blocked by the existing missing `vite-plugin-pwa`. This diagnostic digest has
  two known unrelated Core contract failures; this result does not approve its
  release or replace the preparer's next corrected digest. Both tools are
  explicitly selected; `scripts/nsh.mjs` and the preparer are not invoked.

```sh
COMPAT="$PWD/packages/nsh/.nsh/compat/<verified-digest>"
NSH_BIN="$COMPAT/tools-darwin-arm64/bin/nsh" \
NSH_RUNTIME="$COMPAT/tools-darwin-arm64/runtime" \
bunx vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-assistant-read-marker-native.test.ts
```

Actual AppKit/Win32 rendering, physical gestures, genuine native writer authority,
live Host networking and successful history recovery after unknown remain outside
this evidence. The two native refs and modal/snapshot races are exercised rather
than inferred from handler installation. This is headless evidence only, not
AppKit pixel comparison, physical-window acceptance or validation of subsequent
unrelated application/header edits.
