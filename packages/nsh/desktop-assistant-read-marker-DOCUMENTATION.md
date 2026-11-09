# Desktop Assistant contact read marker

## Ownership and frozen interface

`desktop-assistant-read-marker.ts` is an event-driven, injected pure controller.
It does not create a List, store, transport, native grant, subscription, global
registration, background timer or polling loop. It has no NSH runtime import;
`PageOperation` is a type-only dependency narrowed to `current` and `request`.
Ordinary Session and iOS read behavior are outside this module.

```ts
createDesktopAssistantReadMarker({
  assistantID,
  current: () => boolean,
  position: () => AssistantReadPosition | null,
  operation: () => Pick<PageOperation, 'current' | 'request'> | null,
  measure: () => Promise<{ marker: Rect; viewport: Rect } | null>,
  now?: () => number,
}) // { invalidateFrame(): void, scroll(frame): void, check(): Promise<boolean>, retire(): void, dispose(): void }
```

`Rect` contains finite `{x,y,width,height}`. `frame` is the existing List's real
`{offset:{x,y},contentSize:{width,height},size:{width,height}}` scroll event. The
controller copies the frame and shared-parser position rather than retaining
caller-mutable objects. Each controller belongs to one captured contact owner.

The original conversation owner must supply:

- `current()`: exact Host/route identity, actual active/current/foreground contact
  admission and no blocking modal/closing state. Temporarily false does not
  permanently retire the controller; call `check()` on both pause and resume.
- `position()`: the authoritative latest real contact position from a complete,
  gap-free loaded projection. Return null for unresolved, gapped, historical or
  optimistic-only content; do not derive it from first row/mount/viewability.
- `operation()`: the exact existing PageOperation, retaining its original
  verified-writer-bound request. Change the object on lease/operation retirement.
- `measure()`: the actual 1×1 marker at the latest real row's bottom and original
  List viewport, measured in the same native page coordinate system. Missing
  refs or failed measurements must not be replaced by invented rectangles.

Pass the existing List `onScroll` payload to `scroll(frame)`, which records the
physical frame and starts a check. Explicitly call `check()` on position, lane,
focus/activity, modal and layout changes; do not subscribe to composer text or
check on every keypress. Call `retire()` on permanent Host/owner departure and
`dispose()` on cleanup; both are permanent and idempotent.

The desktop contact application also owns a pure
`createDesktopAssistantReadSnapshot` adapter over this same List ref. Layout,
ref, readiness, position, lane and active changes invalidate the prior frame and
request a singleflight native `getScrollSnapshot()`. Exact ref/marker, current
owner/operation, copied position and event generation are rechecked after await;
new scroll events cancel pending reads and preserve the original user path.
Only a current non-null real result enters `scroll(frame)`, never the history
gesture handler. `invalidateFrame()` revokes pending measurements and clears the
frame without inventing another one. Ordinary Session and iOS do not construct
the adapter. Actual-root headless evidence is recorded in
`tests/desktop-application/CONTACT-READ.md`; it is not physical-window evidence.

## Geometry, lifecycle and dispatch

Without a real scroll frame from this captured contact owner's original List,
a check performs zero measurements and zero requests. All content and viewport dimensions must
be finite and positive. Inverted NSH List offsets remain physically top-down:

```text
bottom = contentSize.height - size.height - offset.y
abs(bottom) <= 2
```

The two-point tolerance is inclusive on both sides; larger bottom overscroll is
not accepted. Short content uses only its real native frame, including an actual
minimum-content-sized frame if the List reports one. No guessed inset, inverted
offset negation or `max(0,bottom)` can establish latest visibility.

The frame belongs to that retained List, not to a temporary operation lane. A
same-owner foreground/modal resume or lease replacement can use its real frame
with a fresh measurement and exact-operation fencing; it need not fabricate a
scroll event. Host/route departure must retire this controller, so a new owner
cannot inherit the old frame.

The marker and viewport rectangles must be positive and finite, with the entire
marker vertically and horizontally inside the viewport (boundary contact without
positive overlap is not visibility). This also prevents horizontally clipped
pixels from being treated as a fully visible read marker.

Concurrent checks share one Promise/flight. Every explicit check/scroll revokes
an outstanding measurement; a newer event is coalesced into a fresh pass after
that measurement settles. Before POST, the controller rechecks event generation,
frame identity, exact position, operation identity/current and owner admission.
No stale measurement can dispatch after modal/Host/position/lane replacement.
Only explicit events received during an await can request the subsequent pass.

The only dispatch is through the original operation:

```text
POST /api/yuri/assistants/:encodedID/contact/read
{generation,ordinal,messageID}
```

The controller directly shares `parseAssistantReadPosition` and
`parseAssistantReadResponse` from Web `assistantDTO.ts`; it does not import the
React/query transport. A valid response must have the exact assistantID.
An ACK marks only its still-current exact operation/position done, never a new
position observed while it was pending. `check()` resolves true only if its
coalesced flight accepts a current ACK, not merely because a POST was sent.

At most one flight, one done operation/position and one failed-target deadline
are retained. Measurement exceptions, request failures, malformed responses and
wrong assistantIDs apply a 15-second cooldown to that target. After expiry,
only a new explicit scroll/layout/check can retry; no timer or retry loop is
installed. A new target does not inherit a different target's cooldown. Valid
`changed:false` responses still constitute confirmed reads.

The original request owns native authorization and timeout. This controller
never acquires/renews/replaces a writer or clears sticky unknown. Even if
PageOperation display identity remains current, a cooldown retry still passes
through that same request's writer gate; an invalid grant must reject before
native dispatch. No fallback transport is allowed. A read ACK or contact
history is not evidence to unlock a writer or decrement catalog unread counts;
complete authoritative catalog reconciliation remains with its existing owner.

## Validation and limits

`desktop-assistant-read-marker.test.ts` exercises the public injected boundary:
real-frame prerequisite, zero/NaN/clip/partial visibility, bottom/overscroll
boundaries, short content, exact request and response, mutable input isolation,
operation/Host/modal/gap/position fencing during awaits, coalesced fresh passes,
late ACKs, bounded per-target completion, cooldown, same-writer unknown gates,
zero timers, 50-check no-work guards and permanent retirement/disposal.

Run with `bunx vitest run --config packages/nsh/vitest.config.ts
packages/nsh/desktop-assistant-read-marker.test.ts` from the repository root.
These are pure controller tests. They do not validate production wiring,
AppKit/Win32 measurement/scroll coordinates, real writer authority or a live Host.
