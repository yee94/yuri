# Projects UIKit inset diagnosis

This is a synthetic, read-only geometry carrier. It does not fix Projects layout.
The prior `7561343c` full application remains a failed UIKit geometry observation;
the headless 84/4 checks remain valid only for their tested runtime.

Build with an explicitly selected installed `NSH_BIN`:

```sh
node packages/nsh/tests/projects-insets-uikit/build.mjs
```

The builder writes a new `.nsh/projects-insets-uikit/<buildID>` directory, unique
bundle ID, manifest and app. It does not install, launch, change the SDK, or access
the Host/network. Compilation of the small native carrier has its own 600000ms
limit; NSH runtime limits retain their defaults. Failures persist their stage.

The main session owns device operations. Launch the new bundle with
`--insets-mode minimal` (default) or `--insets-mode production`. Check the visible
`insets-build-identity` label against the manifest before capturing. Press the
native `insets-capture` button after layout settles and after each rotation.
The mode is selected at process launch; do not treat stale foreground UI as a
new build. Capture writes `Documents/projects-insets-report.json` atomically and
retains the last 12 snapshots. Copy that file from this exact app's data container.

The three simultaneous minimal Scrolls use the same available width:

1. Original: one percent/max-width node with horizontal padding.
2. Split: percent/max-width shell plus stretch padded content, matching the
   current ProjectsHome change that has failed UIKit validation.
3. Content padding: padding belongs to Scroll's contentStyle, with a stretch
   child and no percent width. This is a diagnostic variant, not a production fix.

At 402pt, all three cards should have x=18 and width=366. The third variant does
not model the 452pt large-screen cap; it isolates Scroll content sizing only.

Production mode mounts the real ProjectsHome with the existing memory-only
Projects ordering Host. Its frozen `projects.tsx` copy gets zero-size native
component anchors and forwarding ref/onLayout observers. The repository's
production source is not changed. The original scroll/content refs, content
layout callback, style, refresh and drag handlers remain in the frozen copy.
The manifest records upstream and instrumented source hashes separately.

Report fields:

- Identity: actual Bundle.main identifier/build ID, PID, selected mode,
  UIApplication active state and UIWindowScene activation state.
- `core.events`: original public NSH onLayout payloads; `core.measurements`:
  original public ViewRef.measure results, recorded separately.
- `surface`, `controller`, `window`: public frame, bounds, converted window and
  surface rects, safeAreaInsets and layoutMargins.
- `hierarchy`: at most 512 UIView objects, public geometry/identifier only,
  with stable per-process object tokens and parent tokens. No class-name
  matching, reflection, labels, text, body, or accessibility-tree traversal.
- Scrolls add contentSize, contentOffset, contentInset, adjustedContentInset
  and public layout-guide frames.
- Each exact native registration records its complete ancestry to NshAppView.
  The explicit native-component bridge wraps its registered UIView once; the
  registration -> component host -> TSX owner relationship is recorded via
  actual object membership. The structural owner must be correlated with the
  original ref and onLayout measurement. If public identifier getters return
  nil, do not replace them with text-AX guessing. If ancestry or parity fails,
  report the binding as inconclusive rather than accepting a guessed frame.

Analyze a copied report without the simulator:

```sh
node packages/nsh/tests/projects-insets-uikit/read-report.mjs /path/to/report.json expected.bundle.id
```

The script checks build/foreground/capacity/errors and prints per-anchor public
UIKit rectangles beside the original NSH events/measurements, plus Scroll and
surface widths. It does not turn a missing or mismatched anchor into a pass.
Use the first differing layer to distinguish surface/root width, Scroll content
width, and native mounting versus NSH core layout. No production root cause or
fix is accepted until the actual UIKit report is inspected.

## Full Home/Nav/Tab and canonical appearance

The `8ce285d6` carrier's actual UIKit minimal variants and synthetic production
ProjectsHome both have 402pt roots/Scrolls and x18/w366 cards with zero native/core
frame difference. This does not explain the older full application's header
controls. There is currently no evidence for a general NSH Scroll percent/padding
mount defect.

`build-full.mjs` freezes the full production App through the existing history
normal builder, preserving the actual Home/Nav/Tab, NativeAppearanceSync and
history synthetic Host. It adds only diagnostic observers to frozen source and
native copies. Repository application/appearance code is not modified. The full
native fixture is recompiled, including its existing font/other bridges; no old
executable is reused.

Use the same main-owned launch profiles as the failed full run:

- `HISTORY_SYNTHETIC_RUN_MODE=ui-parity`
- `HISTORY_SYNTHETIC_APPEARANCE=reference-105`
- `HISTORY_SYNTHETIC_DENSITY=100`

The report is automatic, at `Documents/full-projects-insets/report.json`. There
are no new visible controls, geometry writes, layoutIfNeeded calls, appearance
changes, runtime-budget changes, or periodic polling. Native anchor mount/layout
notifications schedule at most 24 coalesced captures; synchronous native snapshots
also record `appearance.apply.before/after` and `theme.override.before/after`.
The separate core response has its own native timestamp and a same-response
native snapshot, so an asynchronous core response is not mislabeled as a
synchronous pre-theme core measurement.

Original Home safe-area, connected container, Projects Tab, ProjectsHome root,
Scroll, width shell, padded content, card and toolbar retain their styles.
Forwarded original Scroll/content refs and original content-layout callback are
preserved. All exposed geometry belongs to actual UIView instances or the
original public NSH refs/layout events, never inferred AX ancestors.

The frozen ProjectsHome function itself reports a unique consumer marker when
called. Both packed JS marker/selector presence and the runtime native receipt
must match the artifact's expected marker. The report also contains the actual
bundle/build/PID/process nonce. This distinguishes frozen source presence from
actual packed/exported function consumption. The manifest records compiler
executable SHA, packed JS SHA, bytecode SHA, upstream/instrumented source hashes,
and native executable SHA.

```sh
node packages/nsh/tests/projects-insets-uikit/read-full-report.mjs /path/to/report.json expected.bundle.id
```

Inspect synchronous native before/after snapshots first, then the correlated
core-response snapshots to find the earliest ancestor or theme operation with
a different width. Missing/retired anchors or source-marker mismatch are
inconclusive; do not infer a production fix from a successful build.

## Confirmed full-application entry seam

The actual `8d93dfb3` report confirms the exact source consumer marker. Its Home
safe-area, connected container and Projects Tab are 402pt, while ProjectsHome's
root is 362pt in both actual UIView and original NSH onLayout/ref measurement.
The root's actual sibling is an empty UIView at x362/w40, owned by the retained
history-import task entry's `px-5 pb-2` shell. Appearance apply and theme override
before/after widths are identical. This is a parent layout contract, not a
UIScrollView content-width or UIKit mount-offset defect.

The Projects Tab parent now explicitly uses `flex-col`, preserving both owners
and placing the background task entry below ProjectsHome. No task is filtered
out to hide its footprint. The original ProjectsHomeSurface Fragment and closed
Sheet conditional remain unchanged. The regression extracts the actual Home
Tab JSX and actual ProjectsHomeSurface function from application.tsx, then runs
them with real ProjectsHome in NSH. Before the fix it failed with Scroll362;
after the one-class change it passes with Scroll402/card366. Empty, visible and
absent history task entry structures are covered. The next full instrumented
UIKit artifact must independently confirm root402/card366; previous failed
artifacts/reports remain unchanged.
