# Native image preview

`native-image-preview.tsx` owns the shared fullscreen image viewer and the fixed-frame
thumbnail used by Chat, the new-session attachment list and Markdown images. It never reads a
resource, never holds a lease and never builds a credential URL: the caller's owner does that and
hands over an already-authorized source or a renderer slot.

## API

### `NativeContentImage`

```ts
NativeContentImage({
  src,                 // authorized URL, or the caller's identity sentinel while a lease loads
  fullSrc?,            // authorized full-resolution URL, when the caller already has one
  label?, active?, current?,
  width?, height?,     // metadata pixels (resources.read); intrinsic aspect, not the card frame
  frameWidth?, frameHeight?, compact?,
  renderImage?,        // fullscreen => JSX.Element; draws the bitmap itself
  intrinsicSize?,      // { width, height } when not passed as width/height
  identity?,            // caller source identity (lease generation, attachment id)
  gallery?, galleryIndex?, radius?, testID?, onOpenChange?, onClosed?, retirementOwner?,
})
```

- **Fixed frame.** The card measures `frameWidth`/`frameHeight` (compact: 64×64; otherwise
  240×160pt) once. `width`/`height` are the metadata pixels used for the intrinsic aspect and
  the fullscreen fit — metadata arriving late never changes the card frame. The root also sets
  `maxWidth: '100%'` so a narrow message/composer column clips instead of overflowing. A message
  thumbnail draws `contain` inside the 160pt frame; only the compact square crops with `cover`.
- **Renderer slot.** When `renderImage` exists the card draws _only_ that slot; it never mounts an
  `Image` for `src`. This is what lets attachment-card hand over
  `renderImage(true) => <ResourceRasterImage …/>` / `<ResourceSVGImage …/>` for the original
  lease while `src` stays an opaque `resource:<lease>` identity that must not be fetched.
- **Loading/failure.** `src === ''` (lease still loading) and `renderImage === undefined` render
  the neutral placeholder and keep the card disabled. Retry/loading copy stays with the caller's
  owner; the card never retries a read.
- **Source identity.** The card snapshots `identity` + gallery index + the item's `src`/`fullSrc`.
  A different snapshot while the viewer is open (a reused `List` cell, a replaced file, the
  owner's `src=''` → next-lease sequence) closes the old viewer immediately: no return animation,
  no page swap to the new bitmap. `width`/`height` are metadata, not identity, so a late size for
  the same source never closes anything. A change also cancels a measurement that has not
  presented yet, so a delayed open can never apply to the new source.
- **Opening.** A press measures the card (`ViewRef.measure`) and opens the viewer with the
  _visible bitmap_ rect as the transition origin: for a message frame it is the letterboxed
  picture inside the 160pt `contain` box (`nativeImagePreviewSourceRect`); for compact `cover` it
  is the cropped frame; with no intrinsic size (or a direct `Image` before `onLoad`) it is
  `null` and the viewer fades instead of warping. Measurement and the open are fenced by
  `active`/`current`, and a close invalidates a measurement that has not presented yet.

### `NativeImagePreview`

```ts
NativeImagePreview({
  open, items, index?, sourceFrame?, measureSource?,
  active?, current?, identity?, onOpenChange, onIndexChange?, onClosed?, testID?,
})
```

- `items: { src, fullSrc?, label?, intrinsicSize?, renderImage? }[]`. An empty list reports
  `onOpenChange(false)` instead of leaving a dead dialog.
- `sourceFrame` is the thumbnail's page frame when it was pressed; `measureSource(index)` is
  called when closing so the return animation lands on the _live_ source.
- `active === false` (page backgrounded, surface inactive) and `current() === false` close
  immediately, without animating, at every async boundary.
- `identity` is the presented source snapshot. A changed value closes at once (compared by value,
  so a re-render that only carries new metadata keeps the viewer open).
- `open` is controlled. A user close (tap, button, back/Escape, pull) runs the return animation
  first and then calls `onOpenChange(false)`; a programmatic `open=false` takes the same path.

## Gestures and animation

- **Opening.** The fitted image frame is interpolated from the measured thumbnail rect (cover
  scale + center delta) to the fit, with the backdrop fading in (`260ms`, cubic-out). No live
  source frame → fade in (`160ms`). `reduceMotion()` jumps to the end.
- **Zoom/pan.** Each page is a native zoomable `Scroll` (`minimumZoomScale 1`,
  `maximumZoomScale 5`, `centerContent`). Pinch and two-axis panning are the platform's; JS only
  records `zoomScale` for the percentage label and the zoomed fence.
- **Double tap.** `PressEvent.clickCount >= 2` calls `ScrollRef.zoomTo({ scale, x, y })` at the
  pressed content point, or resets to 1 when already zoomed. The single-tap close waits
  `500ms` (`NATIVE_IMAGE_PREVIEW_TAP_DELAY_MS`) because NSH's own click window (documented for
  `app.press` and the phone surfaces) is 500ms; closing sooner would beat a real second tap. The
  Web viewer waits Safari's 280ms because it pairs taps itself.
- **Pull to dismiss.** The image's own scroll view owns the downward pull (`pullValue`), so it
  works where the finger is. The page scales to 75% and the backdrop/controls fade to 15% as the
  pull reaches the threshold; a release past the threshold closes with a fade, otherwise the
  native bounce returns it. While zoomed, the scroll pans instead and the close fence ignores the
  pull; the shrink/fade is not applied.
  Threshold calibration: NSH reports the rubber-banded overscroll, measured on the iPhone 17 Pro
  Max simulator as `drag 120 → pull 56.7`, `180 → 84.7`, `220 → 102.3`, `300 → 135.7` (~46% of
  finger travel). `NATIVE_IMAGE_PREVIEW_DISMISS_PULL = 64` therefore matches the Web viewer's
  140pt release threshold; small viewports use `min(64, height × 0.09)`.
- **Return.** The close re-measures the same visible-rect source through `measureSource`; the
  image animates back to that picture area and the viewer hides (`240ms`). A `null` frame (row
  unmounted, recycled, gallery replaced, unknown aspect) or reduced motion uses the `160ms`
  fade. Source measurement and every animation completion are guarded by an epoch, so a late
  measure or animation from a previous generation never hides a newer viewer.
- **Multi-image.** A horizontal paging `Scroll` owns gallery swipes; `onScroll` derives the page,
  resets that page's zoom, and publishes `onIndexChange`. Paging is not virtualized: every item is
  mounted, which matches the current gallery sizes and keeps a page's zoom while off-screen.

## Data lifecycle

| Event | Result |
| --- | --- |
| `active` false / `current()` false at press or open | No viewer is opened. |
| `active` false / `current()` false while open or closing | Immediate close, `onOpenChange(false)`. |
| `items` becomes empty | Immediate close, `onOpenChange(false)`. |
| `items` shrinks below the index | Index clamps to the last item. |
| Thumbnail unmounted while open | Viewer unmounts with its card; its pending callbacks are invalidated by the epoch. |
| `src`/`fullSrc`/gallery index/`identity` changes while open | Immediate close, `onOpenChange(false)`; the new source is never shown in the old dialog. |
| `width`/`height` (metadata) change for the same source | Ignored: the open viewer and the card frame stay as they are. |
| Source frame gone / no intrinsic size at close | Fade out instead of a return to a stale or guessed frame. |
| Owner retires while the viewer is opening | The pending measurement is cancelled; if the dialog was already dispatched, `close()` waits for its proven dismissal. |
| Renderer image fails | Error copy in the viewer; controls and close keep working. |

### Retirement completion

`NativeContentImage` takes `retirementOwner({ close })`. `close()` returns a promise that settles
only when the presentation is provably gone:

- `viewer()` false **and** no measurement in flight: resolves at once (nothing was requested;
  `close()` also invalidates any pending measurement so it cannot present later).
- Otherwise it flips the viewer to closed. The promise resolves from `Dialog.onClose` for
  user dismissals, or — because NSH does not call `onClose` when the app removes a dialog itself
  (verified on headless and UIKit probes) — from the dialog content view leaving the native
  tree (`ViewRef.measure()` becomes `null`, polled a frame at a time). No fixed timeout stands in
  for the completion; a dialog that somehow stayed in the tree would keep the promise pending.
- A preview mounted already closed (the close won the first frame) proves the same condition and
  reports `onClosed`, so the owner cannot pop and then see a late fullscreen.

`onClosed` on the card mirrors that completion. A captured renderer lease must therefore stay
alive until `close()` resolves; `active === false` makes the next poll path immediate.

`src`/`fullSrc` must already be authorized (or the identity sentinel described above). Nothing in
this module logs or stores a URL, lease, path or credential, and it never calls
`resources.read`/`resources.present`.

## Verification

Run from the repository root.

```sh
cd packages/nsh && node scripts/nsh.mjs check .
cd packages/nsh && node scripts/nsh.mjs build App.tsx --release --out .nsh/bundle
bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/native-image-preview-model.test.ts packages/nsh/native-image-preview-native.test.ts
# Real UIKit scroll-view pull/paging (booted simulator required):
NSH_IMAGE_PREVIEW_IOS=1 bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/native-image-preview-native.test.ts
```

Verified here:

- `nsh check .` passes for the whole package; `nsh build App.tsx --release` succeeds.
- `native-image-preview-model.test.ts`: 7/7 — fit, source transition, letterboxed/cover source
  rect, dismiss follow/threshold, double-tap toggle, index/paging clamps, return-animation
  decision.
- `native-image-preview-native.test.ts` headless: 5/5 (1 iOS case skipped) — opens the caller's
  slot from the fixed thumbnail with an identity `src` and zero fetches, double tap → `200%` →
  `100%`, reset control, pager → `2 / 2`, close button, single-tap close after the click window,
  `active` fence, empty gallery, source-gone fade close, owning row unmount, a 160pt frame that
  stays 160pt when metadata arrives late, a retirement that resolves `close()` and reports
  `onClosed` once, an open viewer that survives late metadata for the same source, and a
  `src=''` → next-lease replacement that closes the old viewer within a frame (`swap-close`
  < 150ms; a return animation would take 240ms) without ever drawing the new source fullscreen.
  - Headless `app.drag` does **not** produce `pullValue` (probed with a plain zoomable `Scroll`:
    pull stays `0`), so dismissal is not asserted headless.
- `--target ios` on the booted iPhone 17 Pro Max simulator with `NSH_IMAGE_PREVIEW_IOS=1`: 6/6 —
  the same cases plus `drag(0, 260)` on the image dismissing the viewer, gallery paging, close and
  the retirement completion on UIKit.
- The automatic simulator run cannot produce a double click: two `app.press` steps there are
  ~644ms apart and both report `clickCount 1`, so double-tap zoom is verified headless only.
- `node scripts/build-ios.mjs` builds the full arm64 simulator app after this change; it was
  installed and launched on the booted iPhone 17 Pro Max (`com.yee94.yuri.nsh`, welcome screen).
  The app has no Host connection in that state, so the real transcript → image → shared viewer
  click path is the parent session's `message-media-native.test.ts`, not this fixture.

Not verified (accurate边界):

- Physical iOS/Android devices: rubber-band damping, pinch magnification, edge hand-off between
  a zoomed page and the pager, and Android's pull implementation.
- Opening/returning frame-by-frame visual parity with the Web crop animation (geometry is unit
  tested; the native animation was observed only as a state change).
- Desktop wheel zoom (not implemented; the Web viewer has it), keyboard shortcuts, VoiceOver /
  TalkBack order, and iOS `statusBar` styling (the capability is not granted).
- Memory/scroll cost for very large galleries (all pages are mounted by design).
- No end-to-end run from a real connected Host message: the launched app sits on its connect
  screen; the fixture and the parent's message-media test are the evidence for that path.
- The dialog dismissal proof observes the content view leaving the tree (`measure() === null`),
  not a private `UIViewController.dismiss(completion:)`; it is the strongest completion NSH 0.4
  exposes for a dialog the app removes itself (`Dialog.onClose` fires only for user dismissals,
   verified on headless and UIKit).

## Message integration and centering

`message-media-native.test.ts` has also run with `NSH_MESSAGE_MEDIA_TARGET=ios`:
the production transcript paints the skill/citation, opens a file action, fills a slim image
once, opens/closes the shared fullscreen viewer and reopens after authority renewal. Its
four-quadrant PNG is local synthetic data; message and fullscreen screenshots provide visible
bitmap evidence rather than a transparent pixel. This still does not exercise a real Host.

That screenshot exposed a top-aligned bitmap despite `centerContent`. The zoomable Scroll now
contains a viewport-sized centering View; the image uses its contained dimensions within it.
Double-tap coordinates add the contained frame origin before `zoomTo`, keeping the tapped
point in the scroll content coordinate system. Centering adds one View per mounted page and
does not add a scroll writer, timer or image decode.

After this correction, the message UIKit integration plus the preview model/headless/UIKit
suite passed 14 tests. The fullscreen screenshot shows the four-quadrant image centered with
equal top/bottom letterboxing. The separate final chip/raster/message focused run passed
14 tests; the earlier broad affected-surface run passed 194 tests with one UIKit-only skip.
No connected Android device was available, so Android gestures and IME remain unverified.

The saved 1320×2868 fullscreen screenshot was also decoded with CoreGraphics: the colored
bitmap occupies rows 994–1873, with vertical center error 0px. Final Android APK and iOS
arm64 simulator builds include the centering and UIKit input-overlay corrections; the final
iOS build log contains no warnings. `nsh:check` passed. Repository dead-code analysis ran and
was inspected: standalone fixtures and some public preview types/exports remain reported,
alongside pre-existing repository findings; this is not a zero-finding claim.
