# Desktop overlays

The normative contract is
`packages/ui/src/components/ui/DOCUMENTATION.md#desktop-picker-dialogs`.
Read it and the owning module documentation before editing an overlay.

## Choose the surface

1. Classify the task: compact search/list picker, anchored menu, confirmation,
   editor, Settings form, or full content viewer. Classify by behavior rather
   than the component's filename. Keep destructive warnings, permission and
   connection errors, field labels and essential operation consequences.
2. For desktop pickers, use `DialogContent presentation="picker"` and the
   shared `yuri-picker-*` layout classes from `picker-dialog.css`. For anchored
    menus, use `yuri-mobile-overlay-surface yuri-popup-surface` through the owning
    shared primitive. Read `packages/ui/src/components/ui/DOCUMENTATION.md#anchored-popup-surfaces`
    for the shared fill, light shadow tokens and reduced-transparency contract.
    Lists stay transparent; inline mode and mobile sheet material stay separate.
    Settings forms retain the Settings specification.
   Desktop picker dialogs omit the corner close button by default; retain Escape,
   backdrop dismissal and existing Cancel actions with their pending guards.
   Ordinary dialogs and mobile close controls are separate owners. Reserve header
   space for a corner close only when explicitly enabling one.
3. Let the outer surface own glass, edge and shadow. Lists and scrolling
   wrappers are transparent content regions. Align header, search, row content
   and footer to the same inset; keep scrollbars from changing list width.
4. Keep title and necessary controls; remove repeated explanatory subtitles,
   decorative heading icons, Actions headings and help cards. Shortcuts are
   real key hints: reuse `Kbd variant="hint"` or `ShortcutKbd variant="hint"`
   with sprite `Icon` keys. Derive modifiers from the actual shortcut platform,
   and preserve remapped combinations. Ordinary keycap editors keep their
   default presentation.
5. Preserve behavior: query scope/cancellation, pending gates, disabled states,
   external links, independent row actions, navigation and scroll ownership.
   Keep mobile sheet/page routing explicit rather than inheriting desktop
   geometry.

## Evidence before delivery

- Inspect the outer material and the inner list in computed styles. The list
  should have a transparent background, no decorative border and no shadow.
- For popups, verify the fine edge and lighter shadow in both themes, including
  reduced transparency. Default inline opaque fills must not cover the glass.
  Internal borders use the shared popup divider tokens, softer than the outer
  rim; verify ordinary and virtualized rows without changing row measurements.
- Check light/dark, long titles and paths, a long scrolling list, and a narrow
  desktop window. Header/row/footer alignment stays stable; actions remain
  reachable without horizontal overflow or clipped rounded edges.
- Check shortcut badge dimensions against the shared component, including
  macOS Command, other-platform Ctrl, and remapped keys where supported.
- Run focused interaction/presence tests; verify the default dialog and mobile
  presentation still behave independently. Report fixture-only checks as such.

When auditing multiple windows, report the migrated picker types and the
intentional non-picker exclusions. Avoid claiming every modal was redesigned
from a `DialogContent` search alone.
