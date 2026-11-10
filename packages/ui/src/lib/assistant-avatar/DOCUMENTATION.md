# Assistant avatar animation module

## Interface

React callers use the existing facade, without managing a player, renderer,
clock, pointer listener or animation library:

```tsx
<AgentAvatar kind="assistant" name={seed} size={44} motion="working" />
```

Omit `motion` for a standalone history/picker/static face. Active contact rows,
headers, transcript avatars (including settled messages), and empty/error states
use `AssistantWorkingAvatar` to connect the same authoritative live work, with an
optional row hover target. Inactive contact surfaces omit live motion. The
navigation facade plays one complete first-visible idle clip with a double blink,
then eases back to rest and stays still
without pointer following or ambient shape cycling. No persisted
recipe or visual geometry changes as a result of this runtime extraction.

List/header faces default to `followPointer` while idle; the React leaf enables gaze only
when `(any-hover: hover) and (any-pointer: fine)` matches, updating on capability
changes rather than using viewport width. Transcript/processing/empty/error faces
pass `followPointer={false}` on every device. `AssistantWorkingAvatar` supplies
the assistant ID as `animationKey`, independently of its saved recipe seed.

`runtime.ts` is the non-React seam. `mountAvatarAnimation(host, { id, seed,
animationKey?, randomizeShape?, eyeColor? })` returns only:

- `update({ active, motion, size, followPointer?, blinkOnMount?, animateIdle?, playOnce? })`: update live state, preserving the player
  during continuous non-idle work/size changes. `active` is the view's intersecting, foreground,
  non-reduced-motion eligibility. Saved recipe motion-off is also enforced here.
  `blinkOnMount: true` opts into one native blink on the first eligible update, consumed
  for this renderer's lifetime. It does not replay on foreground/intersection return.
  First appearance during working consumes the greeting without a local blink,
  joining the shared eyes immediately. `blinkOnMount: 2` plays two native blinks on the same
  resting player, with a short open-eye gap, without entering working/thinking or
  replacing the renderer. The existing frame subscription owns the bounded second
  blink; interruption cancels it and visibility return does not replay the greeting.
  Idle cleanup waits for the pending second blink and bounded .4-second blink;
  no timer, recurring idle blink or per-frame React updates are introduced.
  `animateIdle: true` explicitly opts into the reference ordinary idle clips without
  pointer following or shape cycling. It starts from the settled static pose and
  lets the existing springs enter the clip. Its first appearance blink waits
  0.4 seconds so the native .35-second up-right-to-idle bridge stays visible with
  open eyes; blinking across the turn would make reopening look like a reset.
  Both greeting blinks use the existing frame countdown and cancel on interruption.
  Turning it off eases the same player
  back to rest before releasing frame work. Schedule enables it only during its
   seven-second greeting; other idle callers retain their quiet default.
   `playOnce: true` enables a single idle clip without pointer following. The engine
   observes its actual loop counter, not a guessed timeout, to finish the whole
   selected clip (four seconds for compact navigation, plus entry/exit bridges),
   then eases the same player back to rest before unsubscribing from the frame clock.
   The entry bridge does not count as a completed clip. Offscreen, hidden-document,
   reduced-motion or unmount interruption cancels it; visibility return and unrelated
   renders never replay it. Other callers retain their existing continuous motion.
- `hover()`: trigger the bounded existing shrink/rebound outside working; eligible idle faces
  lazily start a resting player only for the hover excursion.
- `dispose()`: idempotently release subscriptions/pointer ownership and remove
  only this instance's SVG. Updates after disposal are ignored.

The React leaf owns standard observer/media/document Hooks and updates eligible
animation state in a layout effect before paint; the runtime owns all
imperative resources and per-frame DOM work. Mount paints a still face once.
Inactive instances allocate no player or frame subscription. Idle faces without
pointer following, `animateIdle` or `playOnce` hold the exact reference static pose (looking up-right), with
no player, pointer lease or frame work outside an opted-in first-visible blink. Hover briefly animates that settled pose,
then restores it and releases the player/clock. Returning from work to idle does
the same cleanup. Mouse-capable list/header faces retain live gaze even when idle.
Navigation releases its player/clock after the greeting. Static React faces
serialize their image only when needed; live faces do not generate an unused URI.
Navigation alone supplies an optional `eyeColor` (`white` or `black`) from the
application theme. The same painted-eye mode is used for live, reduced-motion
and saved-motion-off artwork; static image cache keys include the override.
It does not change saved recipes, eye geometry, ordinary contact cutouts or the
bounded per-shape rest-model cache. Theme changes recreate only the affected
navigation renderer, with no new frame clock or per-frame React work.

## Motion boundary

Avatar pigment selection remains pure in `recipe.ts`: twelve mixed soft/vivid/
neutral colors are available for new defaults and randomization, while existing
opaque seeds retain the frozen original six-color mapping. New random choices
are persisted as explicit v1 recipes; no read-time migration or per-frame random
color is introduced. `palette.ts` owns the exact artwork pigments for all static,
live and PNG consumers, consumed by `engine.ts`. It also maps contact user bubbles
to that identity: vivid pigments stay exact; soft/neutral pigments use stronger
same-hue fills. Text prefers white whenever its contrast reaches 4.5:1; brighter
fills retain black text to meet that minimum, independently of the application theme. Geometry, paint-mode caches
and scheduling are unchanged.

`frameClock.ts` joins Motion's application-wide `frame.read` / `frame.render`
pipeline. Any number of active avatars registers one shared read callback and
one shared render callback, throttled to 30 geometry paints/second. All avatar
measurements precede all avatar writes. Last unsubscribe cancels both callbacks;
Motion may still have unrelated application work, which this module never stops.

Motion does not accelerate the sphere/non-sphere projection or SVG `d` generation.
Those remain the existing engine. Hover geometry, eye descriptors, source clips,
containment and the source body's spring interpolation are unchanged. This is a
shared scheduler and ownership simplification, not a claim that SVG morphing has
become GPU/compositor-only animation.

All working contact faces share a window-scoped timeline keyed by
`[animationKey, seed]`, including list, header and transcript slots of different
sizes. A common compact clip/geometry mode keeps normalized frames identical;
resizing never restarts or splits the timeline. It advances once per shared frame
timestamp; newly mounted or returning visible faces immediately paint its current
pose. Working ignores pointer gaze, local hover and appearance blinks so an
individual instance cannot diverge. Idle retains its existing gaze/hover policy.
Resuming work during an idle hover clears the local interaction and immediately
repaints the current shared frame before the next browser paint.
Each instance still renders its own SVG. Last consumer release removes the
timeline; if all consumers go inactive,
resume starts a fresh bounded timeline instead of replaying background time.
Different assistant IDs and recipes never share mutable state.

## Independent performance gate

From the repository root:

```sh
bun run test:avatar-performance
```

This standalone Vitest configuration requires Chrome/Chromium and fails rather
than silently skipping when unavailable. It builds the real engine and React
facade using production code and React's production profiling renderer, with no
Yuri/OpenCode server, account, real catalog or external network dependency.

After 60 warm-up paints, 120 fixed-step samples per scenario measure **model
generation plus SVG attribute writes**, not browser layout/paint/compositing:

| Scenario | p95 ceiling per complete batch |
| --- | --- |
| One ambient/random-shape avatar | 4 ms |
| Twenty mixed-shape idle avatars | 8 ms |
| Twenty mixed-shape working avatars | 10 ms |

Median, p95 and max are recorded. The full 30Hz frame interval is 33.3ms; these
budgets leave headroom but do not establish a platform-wide frame-rate promise.
Timing depends on hardware; the dedicated job runs serially and must not run
alongside the whole workspace suite. Threshold changes require measurements and
review, not automatic relaxation to pass CI.

The same browser test verifies twenty active production faces, zero React commits
per animation frame, zero SVG writes for fifty unrelated parent updates, one
shared pointer listener, zero reads/writes/commits during a thousand pointer
events, desktop idle gaze, zero ongoing writes/listeners for twenty idle transcript
or touch-only faces, zero ongoing writes/listeners after the bounded navigation-style
greeting, sixty frame-identical working samples across late mounts,
mixed slot sizes, mouse gaze requests and hover, and zero ongoing
writes/listeners under reduced motion. Unit tests guard 30Hz cadence,
read-before-write, visibility/identity/hover lifecycle, one timeline advance per
shared paint and last-consumer cleanup.

`.github/workflows/avatar-performance.yml` runs this gate independently on related
PRs. `YURI_TEST_EVIDENCE_DIR` retains a JSON measurement report and local fixture;
CI uploads only the JSON, never the bundled research assets. This does not replace
Electron, VS Code, Capacitor, IME/composer or native-device acceptance.
