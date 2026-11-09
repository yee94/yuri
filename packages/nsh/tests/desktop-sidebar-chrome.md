# Desktop sidebar chrome — focused boundary

`desktop-sidebar.tsx` follows the non-plugin Web desktop navigation order from `SessionSidebar.tsx`: new chat → Schedule → Bots. These actions scroll with the project list. The existing application titlebar already owns the brand, global search, sidebar toggle and session-title switcher; the sidebar must not duplicate them.

`SidebarPinnedSessions.tsx` supplies one Pinned / In progress heading in Web. Native presents one heading and synchronizes its existing two fold signals; navigation, catalog, drag and write ownership remain unchanged. Idle dots are not rendered in desktop session rows; attention markers trail the title.

The footer follows `SidebarFooter.tsx`: 28pt icon controls, 4pt gaps, 16pt settings/help artwork and 18pt device artwork. Archived-session navigation remains available through the Projects heading menu instead of a fourth full-width footer row. Existing per-project archive controls remain intact.

## Application handoff

- Pass `selectedSection` from the actual visible route/tab. Sidebar alone cannot establish the active main section.
- Keep `active` tied to the foreground window lifetime; pass `interactive={!desktopInteractionBlocked() && !desktopGitDialogOpen()}` separately. The optional prop defaults to true. A Settings/Search Dialog blocks actions and closes menus/cancels held drags without unmounting rows, controller, rename/folder/export drafts or the source owner. `authority` owns catalog reads/display and switcher snapshots; `can`/`admitted` separately gate shortcuts and handlers. Every user action rechecks admission, including confirmations after await; already-started document receipt observation retains its authority owner.
- Pass `onShortcuts` to a window-local shortcut **help Dialog**. Web calls `toggleHelpDialog` and renders `components/ui/HelpDialog.tsx`; this is not the editable shortcut Settings page. Until supplied, the help button is intentionally disabled, never a fake success or settings redirect.
- Stable UI selectors: `desktop-new-session`, `desktop-schedules`, `desktop-assistants`, `desktop-settings`, `desktop-connections`, `desktop-shortcuts`, `desktop-sidebar-projects-menu`.
- The native Bots icon currently uses Web's `ai-agent` fallback. Web's chosen contact avatar, unread count and navigation activity still need authoritative root-owned projections; this change does not introduce another fetch/controller or invent their state.

## Evidence and limits

`desktop-sidebar-chrome-native.test.ts` runs the production component in an isolated synthetic fixture on NSH 0.4 macOS/Windows **headless models**, at 1068×832 and 800×480. It exercises order, single titlebar ownership, actual callbacks, combined folding, archive-menu reachability, help-owner absence and hidden/inactive boundaries. It is not AppKit/Win32 rendering or physical-keyboard evidence.

The modal fixtures additionally run at 1068×1000: 50 rename keystrokes plus 20 admission toggles must add zero catalog requests, preserve rows/folds/input/source and retain exactly one installed actions owner. Blocked navigation, menu/drag, a drag held across blocking and teardown via `active=false` are exercised independently. NSH headless may resolve a press disabled by an ancestor rather than reject it; the tests therefore assert both disabled state and absence of effects, not only driver error codes.

`desktop-sidebar-engine.test.tsx` retains its search/Host-switch checks in the fixture's synthetic shell, instead of expecting a duplicate `desktop-search` row or visible Host-name footer text. It also asserts that the removed search row does not return. The session/children/rename/archive/restore/CRUD/export/drag regressions remain in place and were not replaced by the chrome fixture.

Native windows were not launched. Font metrics, row hover/action reveal, full avatar/activity parity, exact tree indentation and same-state screenshot comparison remain unverified; successful headless checks do not complete the 1:1 visual acceptance.
