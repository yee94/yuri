# Touch gestures

One owner for tap, double tap, long-press timing and Android native-pan locking.
Surfaces describe *what* a gesture does; this module owns *how touch is read*.

## Use these, do not hand-roll

- `bindDoubleTap(root, { resolve, onDoubleTap })` — double tap on an element inside
  `root`. `resolve` maps an event target to the element the gesture belongs to, or
  `null` for targets that keep their own behavior (links, buttons, media, code).
  Both taps must land on the same resolved element.
- `bindLongPress(root, { resolve, onLongPress })` — long press on an element inside
  `root`, fired once after `LONG_PRESS_MS` of a still touch. Lifting, dragging past
  `LONG_PRESS_MOVE_PX`, cancelling, or a mouse press aborts it. The click that
  follows a fired press is swallowed and the native context menu on resolved
  targets is suppressed.
- `createTapRecognizer()` — pointer down/up pairs classified as `'none' | 'tap' |
  'double-tap'`, for surfaces that already own pointer handling (image viewer,
  remote desktop).
- `isDoubleTap(previous, current)` plus the shared constants `TAP_MAX_MS`,
  `TAP_SLOP_PX`, `DOUBLE_TAP_MS`, `DOUBLE_TAP_DISTANCE_PX`, `LONG_PRESS_MS`,
  `LONG_PRESS_MOVE_PX`. Never write a numeric threshold in a surface.
- `lockNativeTouchPan(element)` / `useNativeTouchPanLock(ref)` — for surfaces that
  own their touch gestures.

## Why the rules exist

- **Clock.** Every sample uses `event.timeStamp`. Mixing `Date.now()`,
  `performance.now()` and `event.timeStamp` made taps from different handlers
  incomparable.
- **Tolerance.** A tap is at most `TAP_MAX_MS` and `TAP_SLOP_PX` (finger jitter on
  Android exceeds 10 px routinely); two taps are within `DOUBLE_TAP_MS` and
  `DOUBLE_TAP_DISTANCE_PX`. A hold or drag is never a tap: it belongs to the
  platform (native text selection, scrolling).
- **`pointercancel`.** Android Chromium can start a native pan or selection in the
  middle of a tap and cancel the pointer stream. `bindDoubleTap` therefore also
  accepts the native `dblclick`, de-duplicated so a gesture opens exactly once.
- **Native pan lock.** Android hit-tests `touch-action` on the compositor, where
  transformed or zoomed layers can expose a stale region and start a native pan.
  A non-passive `touchmove` that cancels the default forces the browser to wait
  for script. Use the lock only on surfaces that own all touch gestures (image
  viewer canvas, remote desktop). Never on scrollable transcripts or text that
  must keep native selection and scrolling.

## Current consumers

Image viewer (`ToolOutputDialog` / `imageViewerTransform`), remote desktop
(`lib/remote-desktop/gestures.ts`, `RemoteDesktopPanel`) and every long-press timer
(`mobileLongPress`, `MobileAgentButton`, `ModelControls`, `tooltip`). The tooltip's
longer press-to-reveal delay is intentional. Contact bubbles deliberately use
native selection (`user-select: all`) and no custom gesture.

A new tap-like gesture starts here. If the shared API cannot express it, extend
it with a test rather than adding a parallel recognizer.
