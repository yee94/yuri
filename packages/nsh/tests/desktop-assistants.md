# Desktop Assistants presentation

## Source and ownership

The reference is the non-mobile branch of `packages/ui/src/components/assistants/AssistantView.tsx`, including `AssistantPinnedContacts.tsx`, `AssistantContactMenu.tsx`, `AssistantMarkAllReadButton.tsx`, `AssistantContactStatus.tsx` and the shared `assistantWorkspaceState.ts` presentation resolver. Desktop Web has no contact search/filter toolbar; the native desktop branch deliberately does not add the mobile search action or swipe actions.

`AssistantHome` still owns the only capability/snapshot polling/event/mutation lifecycle. `desktop-assistants.tsx` only presents its props. `presentation="desktop"` opts in; the absent/default presentation keeps the existing mobile tree and swipe behavior. The first authoritative snapshot item is initially selected (Web behavior); pin/recency order affects the contact list, not identity selection. Selection changes only the inline conversation slot, never invokes the mobile `onOpenChat` navigation callback.

The contact rail follows Web's `clamp(256pt, 22vw, 320pt)`, including 64pt pinned artwork and 44pt ordinary artwork. The selected conversation has the separate 64pt header, 40pt artwork, actual Bot name, status, mini-window and settings entry. Existing `AssistantAvatar` consumes authoritative working fields; no additional stream or fake activity model is introduced.

## Application integration

Use the same existing creator/editor callbacks and supply the existing native Chat owner through a slot:

```tsx
<AssistantHome
  presentation="desktop"
  active={homeForeground}
  interactive={!desktopInteractionBlocked() && !desktopGitDialogOpen()}
  onOpenChat={openChat}
  onCreate={openBotEditor}
  onEdit={openAssistantSettings}
  requestConversationChange={(commit, current) => /* root exact-inline-owner prepare/release/commit */}
  renderConversation={context => /* existing native conversation owner */}
/>
```

`context.bot()`, `context.active()` and `context.interactive()` are live accessors. The factory is called once per selected Bot identity, not on snapshot updates or Dialog toggles. Use `assistantChatTarget(context.bot())` for the existing Chat contract. Keep that Chat's established display-vs-sync admission (`active && interactive` vs `syncActive`) rather than creating a parallel transport. The factory must not construct a second catalog controller. While a temporary Dialog covers the workspace, retain the home component and keep `active` tied to its actual foreground lifetime; only change `interactive`. The root still owns creator/editor drafts, navigation and settings.

Optional `onOpenMiniChat(bot)` must use the actual native window capability. Without it the existing entry is disabled and its tooltip explicitly says unavailable; this is not a successful Mini Chat implementation. Optional `contactStatus(bot)` can publish authoritative selected-Chat empty/error/time state from that same owner. Without it, snapshot `latestMessagePreview.createdAt` uses the shared Web formatter; absence remains unavailable, never falsely "never contacted". Without a conversation slot the right side explicitly reports unavailable rather than displaying a made-up chat.

### Frozen inline selection admission

`AssistantHomeProps.requestConversationChange?: (commit: () => void, current: () => boolean) => Promise<boolean>` is the only new admission port; it belongs to the existing Home, not the presentation or a second catalog/sync/writer. The desktop root must inject it and capture the actual mounted inline Chat owner at invocation. Root prepares that exact owner's writer, validates the captured grant together with `current()`, awaits its release ACK, revalidates, then calls the supplied synchronous `commit()` once and resolves `true`. A veto, unknown release, stale owner or failure must not call commit. Resolving `true` without commit does not select anything; invoking commit and later returning false/throwing cannot undo root's already-authorized destruction. The absent port preserves existing consumers; it is not evidence of safe production writer release.

Explicit different-Bot clicks capture current selection lifetime, the existing authoritative catalog identities/directories, target ID, original Host operation and interactive generation before waiting. Commit checks these again against the live source. Same-Bot clicks cause zero callback/I/O. There is one callback flight shared with catalog-driven retirement: a newer click invalidates the older intent but is not queued/replayed, and a late callback cannot take over even if the target disappears then reappears. Callback completion closes its commit capability permanently. Capability/target/Host retirement, modal suspension, current-selection change and disposal veto an ordinary selection commit. Snapshots with unchanged identities preserve the selected owner. Input and Settings/Search/Help do not request a conversation change or replace selection; the retained Chat keeps its existing draft/sync ownership.

Selected-Bot deletion keeps its original confirmation and remote mutation. After a validated delete ACK, the true catalog removes that Bot immediately, exactly like external adoption. The selected slot remains mounted/read-only until the shared retirement callback commits; Retry only retries retirement/reads and cannot replay confirmation/DELETE. No separate ACK cache, Bot catalog or unknown-write journal is added. Rejected/unknown remote writes do not themselves clear selection or release the inline owner. iOS still follows its original confirmation/mutation/catalog path.

### Catalog retirement retains the actual mounted lifetime

Home holds only the selected slot's serial and a shallow rendering-props snapshot. This is not another catalog: contacts always consume live `app.bots`, and neither global adoption nor unrelated complete rows wait for writer admission. Matching ID/directory snapshots update only rendering metadata, preserving the actual Chat instance. An ID removal, `effectiveWorkspacePath` change, snapshot disablement or unsupported/unknown capability immediately makes the slot's `active` and `interactive` accessors false using live authority, then latches that lifetime as terminal. The saved Bot props are prior display only; they do not grant polling, mutation, sending, or a replacement writer. In-place directory changes are also compared against the copied original identity rather than a shared mutable catalog row.

The terminal slot stays in the same keyed presentation branch even when workspace state changes to unavailable/onboarding. Its existing status/error/Retry surface reports unavailable, while the actual catalog rail continues showing complete rows (disabled only when capability itself disallows catalog actions). It does not gain a new page/action. Settings and Mini Chat for the retired prior identity are disabled. The presentation's narrow optional `conversationAdmission` carries the Home-owned serial and derived gates, not a second owner; root needs no new port or state-adoption hook.

Desktop tips/polling re-read disabled/unsupported/unknown capability instead of indefinitely reusing a negative cached result. Recovery can re-enable authoritative contact actions, never the old terminal Chat lifetime. The mobile capability-cache path is unchanged.

The existing `requestConversationChange` is invoked once automatically per retired lifetime when foreground interaction permits. Its retirement `current()` validates exact serial, latched retirement, Host identity/generation, owner lifetime and intent, deliberately not the deleted Bot's membership or its retired interactive operation. Root can therefore prepare/flush and release the original claim. Until root actually calls commit, false/unknown/pending retains the same read-only Chat and draft. Retry uses the same single flight, and newer target clicks cannot take over a held retirement. Only commit clears that exact slot. Catalog reappearance/re-enablement does not un-latch retirement, automatically reacquire a possibly released claim, or cancel a valid terminal retirement halfway through release. After acknowledged retirement no Bot is auto-selected; only a new explicit contact action can create a new serial/writer. Automatic first selection is restricted to the initial-none state and a complete enabled snapshot.

Thus Home/global catalog adoption, capability disablement and delete-ACK/refresh races no longer destroy the selected writer before release admission. The root remains responsible for actual all-mounted guard preparation, exact inline release ACK and fail-closed unknown handling, and for navigation/Host/window lifetimes that remove Home itself. This change does not edit state, root navigation, writer, Host or draft-registry ownership.

## Verification and remaining acceptance

`desktop-assistants-native.test.ts` runs the production owner/presentation against a strictly synthetic Host. Both macOS/Windows headless models cover split selection, live title, context pin/edit/delete and delete failure, read failures preserving rows, empty/disabled/unknown authority, callbacks, 640×480 resize and one slot owner retained across refreshed snapshots, 50 draft keystrokes and 20 modal toggles with zero additional catalog requests. The desktop fixture never starts another catalog owner or stream.

The same actual `AssistantHome` controller fixture now covers zero admission on same selection, 50 input characters and modal toggles; false/throw preserving Bot/draft/other complete rows; held target deletion and disappearance/reappearance, stale Host, same-Bot cancellation, newer-Bot single-flight invalidation and modal retirement; settled/retired late commits; successful guarded replacement; and selected-delete local veto/retry without repeating its acknowledged remote write or confirmation. It uses only synthetic requests and in-memory admission promises, not native writer authority or real accounts.

Additional retirement cases run external removal, disablement and directory changes with held/veto/unknown callbacks: zero unmount/release/mutation before admission; prior Bot/draft/path still visible; complete unrelated contacts retained; exactly one release/unmount on approval; no automatic replacement; and same-Bot reappearance cannot revive a terminal lifetime or accept a stale commit. Direct `app.bots` replacement and an in-place directory mutation exercise the authoritative adoption boundary independently of Home's loader. Unsupported capability and a newer target during held retirement are separate cases. The fixture explicitly invokes a mutation attempt outside the disabled Input and checks both live accessors, so readonly evidence is not merely button visibility.

Selection/retirement validation: NSH 0.4 headless reports 57 passed / 1 existing Windows keyboard skip, and `nsh:check` passes. Focused mobile `assistants-ui`, pure `assistants-core` and swipe regressions pass (44 Vitest tests including the mobile wrapper). The earlier additionally attempted `assistants-settings-ui` fails while waiting for `Fixture linked schedule prompt` on the schedule page (`No schedules yet.`); this change does not edit that settings/schedule controller or its fixture. Repository `dead-code` cannot load the existing web Vite config because `vite-plugin-pwa` is missing; no dependency was installed to bypass it.

The macOS headless model additionally covers native Tab/Return activation. The Windows keyboard case is explicitly skipped because NSH 0.4 `crates/nsh-testing/src/headless/keyboard.rs::tabs_to_views` only dispatches view traversal for macOS/Web. Production does not install fake Windows bindings to satisfy this driver limitation. Win32 physical keyboard remains unverified.

`assistants-ui.test.ts` retains the original mobile search/swipe/details assertions; its synthetic bootstrap now calls `loadConnections()` and grants only `connection.list` plus its existing runtime calls, matching current confirmed-readiness requirements instead of manually bypassing them. `assistants-core.test.ts` and `assistants-swipe.test.ts` remain separate regressions.

The actual `YuriNativeApp` App wrapper now runs 72/72 macOS/Windows headless scenarios. Its 24 new retirement cases combine the real catalog owner and verified writer with removal/disable/directory changes, clean release, held release dispatch, pending message and unknown message outcomes. They verify prior readonly Chat/draft retention, no release before ACK, native-close/navigation veto, Settings retention, no automatic replacement/reacquire, and durable original text. The release delay lives at the public bridge dispatch boundary in `tests/desktop-application/AssistantRoot.tsx`, not inside NSH's serial synthetic Host handler; no product route/controller/test props are injected.

No native window was launched for those root cases. Complete conversation/creator/settings UI, Mini Chat capability, contact-status fallback, AppKit/Win32 drawing, exact typography/hover/geometry and same-state Web screenshots remain unverified. In particular the current inline Chat still uses Session transcript/composer presentation rather than the dedicated Web Assistant bubbles and single-row composer; attachment upload, peer metadata, read marker and contact-specific rendering are separate unfinished work. Headless and type checks are not a visual 1:1 sign-off.
