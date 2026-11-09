# Desktop Assistant conversation presentation

## Ownership and integration

`desktop-assistant-conversation.tsx` is contact-only native presentation, not a
Session Chat/Activity renderer. It does not create an Input, List, Scroll,
request, subscription, draft, transport, cache, read receipt or send controller.
The existing conversation owner retains all those lifetimes and supplies slots.
No iOS or ordinary Session consumer is changed by this module.

### Frozen exports

- `desktopAssistantEditorStyle`: apply after appearance typography to the single
  existing desktop contact Input. Minimum 48, maximum 160, padding 12, 14/24 text.
- `NativeDesktopAssistantComposer`: required `editor`, `attach`, `send` JSX slots;
  optional `attachments`, `feedback`, `overlays`, `anchorRef`, `onWidth`,
  `onHeight`, `focused`. The caller supplies the actual 32pt semantic attach/send
  controls, their localized labels, disabled states and keyboard/send admission.
  There is no microphone, Agent/model picker, stop or second action band.
  `onWidth` reports the material surface width; `onHeight` reports the entire
  footer occupancy. Use callbacks (`value => signal.set(value)`), not an unbound
  native signal setter. Layout callbacks only publish changed positive sizes.
- `NativeDesktopAssistantMessage`: required `message: Message`, `bot: Row`,
  `kind: 'user' | 'assistant' | 'peer'`, `showAvatar`, `current`, `renderCard`;
  optional `timeSeparator`, `peerLabel`, `onOpenLink`, `renderFile`, `status`,
  `feedback`, `spacing`, `first`. The caller supplies grouping, actual sender,
  localized time string, original message identity and authoritative status.
  `spacing` is 0 after a separator/for the first row, 24 for a new turn, 6 for a
  same-assistant run, 12 otherwise. `first` uses the Web first separator's 4pt
  top inset instead of 28. `feedback` carries the existing failed-send/retry UI.
- `NativeDesktopAssistantEmpty({bot,current})`: Web avatar/name/title/description,
  reusing existing translations; no new navigation or quick-action entry.
- `NativeDesktopAssistantTyping({bot,current})`: actual Bot avatar and three
   native pulse dots. The caller decides presence from real busy/local-preview
   authority, but suppresses it while the original send is pending, matching
   Web's `!sending && (processing || serverWorking)`. Sending is not processing
   authority. `current`, lifecycle and reduced motion gate the animation.
- `NativeDesktopAssistantSendError({messageID,error,active,retryDisabled,onRetry})`:
  the existing user bubble's error affordance and anchored details/retry surface.
  Modal/inactive admission closes the popup and disables the trigger. The callback
  delegates to the original Chat's exact message retry; it never sends itself.

`current` must include captured Host/page authority and interactive admission.
Modal pause changes that accessor, not the mounted message/Input ownership.
`onOpenLink` uses report-only native links and captured-source checks; absent or
failed routing reports the existing localized unavailable state, never opens a
system browser as a silent fallback.

## Web geometry and tokens

Source of truth: `AssistantConversationSurface`, `AssistantSessionComposer`,
`ChatPromptComposer`, `AssistantContactAttachment`, `AssistantReadMarker` and
the three `Assistant*Card` components in `packages/ui/src/components/assistants`.

The composer reuses `NativeDesktopChatColumn` only for the existing Web column
breakpoint/insets. Footer top 4 + form top 6 / bottom 16 + bordered surface 50 =
76 at minimum. Attach and send each sit in a 48pt-high inline edge slot with
6pt outer inset. Extra attachment/feedback content grows the same retained
surface, bottom-aligning those controls rather than creating another editor.
Dark hover/focus uses the same 8%/11% foreground overlay as Web, with one
material owner. Light border/shadow uses existing semantic NSH tokens.

Messages center within 672pt. Non-user rows reserve 36 + 10pt for a 32pt Bot
avatar and its gap even within a continuation run. User content is right-aligned
and capped at min(82%, 480); assistant/peer content at min(84%, 544). Text parts
have 16/10pt padding and 24pt line-height. Users render literal native TextView
documents, not Markdown; assistant/peer content uses native Markdown. Peer
messages use the Web dashed muted surface and localized source label. Pure
Markdown images omit ordinary prose bubble padding/material.

NSH `primary` intentionally means a neutral action. User bubbles therefore read
non-action `primary.base/foreground` from the existing canonical appearance
`webTheme` when available; neutral NSH tokens are only the no-snapshot fallback.
No additional appearance source or settings request is created.

## Part and failure contracts

Raw `message.content`, including an explicitly empty array, owns original part
order. Only legacy messages without `content` fall back to text/cards/files.
The component does not group original messages into Session turns or Activity.
Legacy internal settle text stays invisible. User failed sends retain their
original bubble; caller feedback owns recovery. Assistant errors render centered
11/16 text without an avatar, matching Web. Sending metadata is explicit;
history is never inspected to infer busy or optimistic state.

All session/assistant/schedule card Rows go unchanged to `renderCard`. Their
real card owner remains responsible for live state, model/project/branch/time
metadata, navigation and the Web 304×148 card chrome. This module does not
invent missing metadata or perform per-card loads. `renderFile` similarly
delegates attachment bytes/preview/download. Without a file renderer, the
filename is retained with localized unavailable feedback; no bytes are fetched.
Composer slots can expose existing unsupported attachment feedback without
pretending upload works.

Read-marker visibility/receipt, history pagination and follow position remain
with the caller's original List owner. No receipt is issued from row mounting.
Send-flight geometry/animation is not implemented or imitated.

## Validation

`desktop-assistant-conversation-native.test.ts` runs the independent fixture on
the actual NSH 0.4 QuickJS/headless engine for both macOS and Windows models.
Eight scenarios cover:

- exact 1068×832 footer/surface/Input geometry, existing column geometry,
  light/dark material presence and absence of Session tool controls;
- first-run-only avatar, native literal user text/Markdown assistant text,
  original mixed text/session-card/text/file/assistant-card/schedule-card order;
- 50 draft edits plus 50 unrelated updates: no additional message mounts,
  content reads, avatar-seed reads, card/file construction or HTTP/Host I/O;
- resize and repeated modal admission keep the same Input/message/card owners
  and full draft; real injected send action remains usable after resume;
- authoritative typing/sending slots, peer timestamp/source, centered errors,
  legacy content, empty state and explicit unsupported attachment feedback.

Run from root with the installed NSH 0.4 binary selected via `NSH_BIN`:

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/desktop-assistant-conversation-native.test.ts
bun run --cwd packages/nsh nsh:check
```

These are synthetic presentation and operation-count proofs, not real Host
integration, OS screenshots, physical keyboard/IME, AppKit/Win32 timing or visual
acceptance. The fixture card slots deliberately test passthrough, not full card
UI. Actual authenticated attachment upload/preview/download, card-owner wiring,
read receipts, send-flight and production input-to-paint budget remain unverified
here and must not be called complete based on this fixture.

Observed in this change: all eight native scenarios pass, and an isolated
TypeScript check of the component/fixture import graph passes. A later full
package script run is blocked by the concurrently introduced audited
`NSH_SOURCE_DIR` prerequisite; a direct full-package TypeScript run also finds
an unrelated application translation key during integration. `dead-code` cannot
load the existing Web Vite config because `vite-plugin-pwa` is missing. No
dependency is installed to bypass either blocker.

## Production-root integration checkpoint

`application.tsx` now enables this presentation only for desktop Assistant targets.
The original verified-writer Chat, durable draft, single Input and inverted List
remain mounted. `desktopContactMessageRows` supplies individual contact identity,
peer source, real createdAt, avatar grouping and time separators; no Session
turn/header/metrics/copy-TTS controls or model/Agent/microphone/stop toolbar is
mounted in this branch. Current locale is sent unchanged, including `en-US` from
the system. No locale normalization is used to satisfy a fixture.

The same native attachment chooser/receipt owner now receives an explicit
Assistant target; descriptors round-trip through draft v1 and become file parts
on the original protected message request. `contactOptimistic:true` only adds
bounded presentation within the original Chat. Failed user bubbles supply this
module's SendError slot, while unrelated attachment/history/durability errors
retain their own feedback. Unknown retry is a read-only causal proof, not writer
recovery. Full contract: `state-writer-DOCUMENTATION.md` and
`assistant-attachment-DOCUMENTATION.md`.

The first integrated root checkpoint passed **74/74 internal scenarios** and
the state/read-marker/App/conversation batch **4 files / 228 outer tests**.
It covered actual contact/peer rendering, attachment-only send, Settings retaining
attachments and 50 input events with zero extra requests. The manual fixture clock
isolated existing safety polling; the operation-count assertion was retained.
This used the original 0.4.0 headless binary, not the compatibility-patched runtime.
The subsequent same-digest `86fb08…cfe7` batch passed five files / 258 outer tests,
including all 78 internal App scenarios and the exact-message retry/error owners.
Those results precede the contact-inset follow-up and do not validate it.
Native authenticated preview/download, complete dedicated cards, paste/drop,
thumbnails, send-flight, OS timing/IME and full visual acceptance remain open.

The contact-only List now follows the Web transcript's `px-4 sm:px-8`,
`pt-5 sm:pt-7` and content `pb-12`: 16/32pt horizontal padding at the 640pt
window breakpoint, 20/28pt logical old-edge padding and 48pt logical latest-edge
padding. Inverted List header/footer own those edges; no additional scroll
container or compensation writer is introduced. Session/iOS spacing is unchanged.
Actual-App measurement assertions in `ContactRead.test.tsx` check the real
marker/viewport's 32pt horizontal and 48pt latest-edge gaps, not copied geometry.

The production List header's former `busy || sending` presence condition was
corrected to `busy && !sending`, without replacing the presenter or moving its
layout. The existing contact-card pending-send tests now also require zero
processing dots before admission, including after a genuine contact-turn-start
event arrives while the send ACK is held. After the exact ACK, an authoritative
working snapshot permits processing; turn-end removes it. All four pending
cases failed before this one-condition fix, then the complete 32-case card and
88-case App headless suites passed with diagnostic paired digest `8a261…ff25`.
No send-flight or source-to-message morph is implied. This is state-presence
evidence only: the existing List-header status placement still differs from the
Web overlay slot, and locked-screen AppKit cannot supply pixel or timing proof.
