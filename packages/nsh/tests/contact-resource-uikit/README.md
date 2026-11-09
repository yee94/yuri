# Synthetic contact descriptor / native original preview

Independent build-only carrier for main. Uses actual `ContactAttachmentPreview`, typed descriptor parser, captured ResourceTransport, ResourceBridge QuickLook/image/PDF/save/share, and `createResourceRouteExit` for parent retirement. No production owner, attachment picker/upload policy, state, AppRoutes, HTML anchor, global-clear, SVG, notification or project code is changed by the fixture.

```sh
NSH_BIN=/path/to/bin/nsh node packages/nsh/scripts/build-contact-resource-uikit.mjs
```

Each build creates a new `.nsh/contact-resource-uikit/<unique>/`, unique bundle ID, frozen source/type graph, real SDK, bundle/executable hashes and `changedAfterSnapshot`. It typechecks/links/signs but never installs, launches or runs an engine. No Host/network/credentials/Photos access is granted. `actualPreviewValidated` remains false. Runtime UIKit generates only synthetic 768×4096 PNG and three-page PDF memory bytes; these are not real Photos/provider originals.

Swift is explicitly compiled with `-Onone` (`swiftOptimization: Onone` in the manifest) for this functional QA carrier, not release performance evidence. The earlier optimized-link timeout is an incomplete build, not a passed fixture. Whole-production-source compile may report unrelated actor-isolation warnings from other owners' frozen inputs; this builder does not edit them.

Main-only operations (fresh app per branch):

1. Confirm AX app name `Synthetic Contact Preview QA`, root safe-area padding and 44pt controls. `contact-resource-png` or `contact-resource-pdf` opens the actual contact preview with a full generation-7 descriptor. The source remains opaque; no fs path or URI is sent.
2. Confirm native content/thumbnail, press the production preview action to open actual QuickLook. Inspect long-image/PDF behavior, then dismiss normally. Save/share only cancel; no actual user file or delivery is needed.
3. Return using native parent Back; it awaits the production retirement port. `contact-resource-audit` displays counters on the root. `originalsRetained` stays 2; counters are invocation/read observations, not proof of a successful system presentation or physical file removal.
4. Separate run: open a preview and press `contact-resource-reset` before a new preview/save/share. This advances only the synthetic contact generation, keeping the exact runtime receipt unchanged. A new native presentation must reject the stale descriptor; Refresh must also fail and retain any already displayed content plus its real error. No refreshed generation, new descriptor or new lease is synthesized to pass. Back still retires the original lease. Old descriptors/rows remain generation 7, so opening them again after reset must fail.
5. Background invalidates the synthetic runtime; restart instead of claiming recovery. Keep AX/screenshots/audit and the exact manifest/build ID. Missing content or a system window that did not actually open is a failure, not a compiler PASS.

Only exact authenticated memory routes exist: `…/contact/messages?limit=1` and `…/contact/attachments/att_png|att_pdf`. The raw GET has no generation query. Current row generation is checked separately from Host receipt; no already-owned-turn path is exposed. Unknown routes/oversized bodies fail. Native original bytes stay in the production resource lease; the downsampled thumbnail is not substituted for the original PDF/image.

The pure/native regressions in `resource-contact-generation.test.ts` execute the production Swift parser/read policy plus extracted actual present/close/release bodies with controlled platform boundaries. They verify strict safe integers/unknown keys, exact new/legacy TS roundtrip, stale/reset/changed descriptor rejection, original captured transport, lease release during a pending permission recheck, same-bytes peer isolation, and original retention. Complete real SDK compilation is separate. Actual UIKit, Photos/provider provenance, long-image fidelity and PDF behavior remain main-owned and are not established by these tests or by this fixture's build.
