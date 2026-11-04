# Settings Form Design Specification

This document is the visual and structural contract for every Yuri
Settings surface. It applies to desktop, hosted mobile, Capacitor mobile, VS
Code, and Electron. A feature must not create a second Settings recipe for one
runtime.

The reference implementation is `SettingsGroup.tsx`; the owning tokens and
responsive rules are in `styles/settings.css`. Scheduled-task detail uses the
same tokens through the grouped-card compatibility aliases.

## Required composition

Every ordinary setting uses one of these structures:

```tsx
<SettingsGroup label={t(sectionLabelKey)}>
  <SettingsRow
    itemId="page.setting"
    label={t(fieldLabelKey)}
    description={shortDescription}
  >
    {control}
  </SettingsRow>
</SettingsGroup>
```

```tsx
<SettingsField
  itemId="page.setting"
  label={t(fieldLabelKey)}
  description={longDescription}
  descriptionPlacement="outside"
>
  {control}
</SettingsField>
```

- `SettingsGroup` owns the section label and exactly one material card.
- `SettingsRow` owns label/value columns, row geometry, search anchors, and
  overflow behavior.
- `SettingsField` owns a standalone setting. It must not repeat the field name
  as a section heading.
- `SettingsToggleRow` is the required Boolean pattern. It owns the label/value
  layout plus pointer and keyboard activation without double toggling the
  nested segmented switch.
- Rows must be direct children of the grouped card. A semantic `radiogroup`
  wrapper may contain standard rows when required for accessibility.
- Pages and nested collections use `yuri-settings-page-content` or
  `yuri-settings-section-stack`. They must not substitute local `space-y-*`,
  `mb-*`, or padding recipes for sibling Settings groups.

## Manual save actions

`SettingsActionHeader` owns the common non-sticky title/action layout. Place it first
inside the editor's scroll content; put the primary save/create action last on the
right, and secondary actions before it. Delete uses a localized, labelled icon
button. Keep the existing validation, dirty, pending, and error behavior with the
editor; the header owns presentation only and must not perform or aggregate writes.
Long action labels wrap within the action area on narrow/mobile surfaces.
The header scrolls with its editor and has no overlay background, stacking layer,
or bottom divider; spacing separates it from the grouped card.

Independent sections pass `actions` to `SettingsGroup`. Its title and actions stay
in normal document flow and scroll with the card; group headers never stick or
cover their rows. Saving voice synthesis, recognition, or one prompt never saves
an unrelated group. Whole-page editors use a single header spanning
the complete form. Do not put the only save control after a long editor or list.
Group action headers omit the whole-page header's vertical padding and retain the
shared section-to-card gap. Remote-instance section actions use compact `xs`,
normal-weight neutral buttons consistently across device, SSH, network, and
remote-desktop groups.
Existing mobile navigation action portals remain the owner when supplied; do not
render a second save button in the content header. Instant-apply controls retain
their existing mutation behavior.

Verify top/bottom scroll positions, narrow layouts, and that each action still
uses its owning editor's state. Titles and actions must scroll away with their
content rather than remain pinned above other Settings rows.

## Typography hierarchy

| Role | Token / owner | Mobile | Desktop |
|---|---|---:|---:|
| Secondary-page title | `MobileDetailNavigation` | shared navigation title | owning desktop pane |
| Section label outside a card | `--yuri-settings-section-title-*` | 12px / 16px, normal | base UI label / form line-height, normal |
| Field label and value | `--yuri-settings-row-label-*` | base UI label / form line-height | same |
| Helper or description | `--yuri-settings-row-meta-*` | form helper size / line-height | same |

Page code must not apply `typography-ui-header` to a Settings section label.
It must not override the responsive section-label size or weight. Short helper
copy can remain under its field label. Copy that wraps to multiple lines goes
below the card through `descriptionPlacement="outside"`.

## Geometry and vertical rhythm

All measurements come from the Settings workspace tokens:

| Concern | Token | Current contract |
|---|---|---:|
| Card radius | `--yuri-settings-group-radius` | 16px |
| Section label to card | `--yuri-settings-section-gap` | 8px |
| Card to next card | `--yuri-settings-section-stack-gap` | 20px |
| Row minimum height | `--yuri-settings-row-min-height` | 52px |
| Row horizontal inset | `--yuri-settings-row-inset` | 14px |
| Row vertical padding | `--yuri-settings-row-block-padding` | 11px |
| Row divider | `--yuri-settings-row-divider` | one semantic 1px divider |

The group card uses `--yuri-settings-group-background`,
`--yuri-settings-group-border`, and no shadow. Individual pages must not add a
different border, radius, shadow, row height, or group gap. Conditional rows do
not change the spacing before or after their group.

## Label, description, and value placement

- A section label is outside the card.
- A field label is inside the card, in the row's left column.
- A short description is smaller muted copy directly below that field label.
- A long or wrapping description is smaller muted copy below the card.
- Stable values occupy the right column and align to the right.
- Select, Input, NumberInput, and custom `yuri-settings-inline-value` triggers
  use the surface's border default. Hover, popup-open, and focus use a solid
  `--interactive-hover` background without adding a focus-specific border,
  outline, ring/shadow, or numeric stepper divider. Focus is communicated through
  fill for both mouse and keyboard. Transparent border space preserves geometry.
  The background persists after hover ends, including focus within compound
  controls. This material is workspace-scoped, not SettingsRow-scoped: search,
  model filtering, project pickers, and portaled Settings dialogs use it too.
  Sidebar collection controls are the explicit exception: `yuri-settings-sidebar`
  sets `--yuri-settings-control-border` to `--form-surface-border` for search,
  filter, and project/context pickers on both desktop and mobile. Standalone
  project pickers use `yuri-settings-sidebar-picker` for the same token. Their
  faint edge stays unchanged in every state; hover/open/focus changes only the
  background, never restoring a focus ring/outline. Detail-form inputs keep the
  transparent border token.
  `Input` callers may explicitly pass `bordered` or `bordered={false}` to override
  that inherited default. An enabled border uses the same faint
  `--form-surface-border` in every state, not a focus ring. The provider and
   custom-provider model filters opt in; filled ordinary detail fields remain unchanged.
  Without an explicit option, empty text inputs show the same faint border using
  `:placeholder-shown`, not `:empty` or the initial HTML `value` attribute. Typing
  restores the surface default; clearing restores the border even during focus.
  Explicit `bordered={false}` stays borderless when empty, and `bordered` stays
  bordered when filled. No additional focus outline/ring or layout shift is added.
  Disabled fields retain their inactive material; validation remains visible via
  a stable semantic error indicator instead of a neutral focus ring.
- Multi-line `Textarea` editors use the same Settings background, interaction,
  and radius tokens as compact controls. Hover and focus both add the interaction
  background, but focus never adds a border, ring, outline, or shadow.
  Textarea-only cards and rows have no outer padding; text and resize controls
  keep their own content insets. Label/value rows keep their normal spacing.
  Preserve left-aligned text, multiline height, scrolling, resize controls,
  disabled state, and stable validation feedback independent of focus.
  Summary's Commit Message and session-title prompts use this shared `Textarea`,
  not CodeMirror: they are plain multiline text with wrapping and a resize handle,
  without line-number gutters or code-editor search chrome. Existing prompt
  content and explicit-save behavior remain unchanged.
- The desktop value column, including adjacent reset actions, is capped by
  `--yuri-settings-desktop-value-max-width`. Mobile uses the same semantic row
  and keeps compact controls beside their labels through the shared responsive grid.
  Controls do not extend beyond that column with negative trailing margins.
  Grouped forms may use `cardClassName="yuri-settings-equal-controls"` to keep
  related input/select/adorned-input edges equal on narrow cards too, instead of
  allowing each row to size its value from content. `SettingsRow.footer` places
  supporting content below both columns and spans their full available width,
  retaining the row insets without widening or stacking the input itself.
  Inner actions reserve text space and fit the control's fixed
  height; focus is communicated by the field fill rather than another ring.
- Complex collections and editors that cannot fit in a compact value column
  add `yuri-settings-split-row-stacked` to `SettingsRow`. On narrow/mobile
  surfaces the label occupies the first line and the complete control receives
  the full card width; the generic mobile two-column rule must not override
  this layout.

## Controls

- Boolean row: shared `SettingsToggleRow`, with its `SettingsSwitch` in the
  right-aligned value column. Use a bare shared `SettingsSwitch` only when it is the
  right-column control of a true label/value `SettingsRow`, or when one control
  enables an entire section — then it belongs in the `SettingsGroup` `actions`
  slot so the toggle sits on the section title row.
- `SettingsSwitch` presents localized Off / On segments, in that order, with
  equal widths. It reuses a 5% foreground tint over `surface.muted` and `yuri-segmented-selected-pill` for
  a quiet track and raised selection in both themes. Base UI RadioGroup owns
  keyboard navigation and the single tab stop; choosing the current value is
  a no-op. Its events stay inside the group so legacy clickable rows cannot
  perform a second write. Mobile retains the shared Button touch minimum.
- Standalone Boolean settings apply from the switch; do not add a second save
  action below the row. When applying requires an app restart (window transparency),
  selecting a new value opens a restart confirmation while keeping the current
  value selected. Cancel/dismiss performs no write; confirmation persists and
  restarts once, with controls disabled while pending. A failed write preserves
  the current value and leaves confirmation available for retry.
- Mutually exclusive list: shared `Radio` rows.
- Short option set: shared `Button variant="chip" size="xs"` with
  `aria-pressed`.
- Numeric value: shared `NumberInput`.
- Text/path value: shared `Input`.
- Icon action: shared `Button size="icon"` plus sprite `Icon`.

Entity creation, credential entry, search fields, and multi-line source/template
editors using `Textarea` follow the same borderless Settings control recipe.
Credential fields may keep full-width, left-aligned geometry, but must not add a
separate border, focus outline/ring, or resting input plate.
Their surrounding section label, group spacing, typography, and helper placement
still follow this specification.

`SettingsJsonEditor` is shared by Global Configuration, plugin options, and the
add-plugin dialog. It enables native CodeMirror fold gutters for JSON/JSONC
objects and arrays. Folding only changes the view, never the
configuration text or dirty state; fold controls are localized and placeholders
use the active theme's surface, foreground, and border colors.

Global Configuration places its editor flush against the grouped card's sides
and bottom, without card padding or a gap below the compact file/reload toolbar.
The toolbar uses `py-1`; there is no description below the card.

The Plugins source editor follows its approved compact entity mockup with shared input/card tokens,
13px truncated package titles with 10px monospace version subtitles, and one
compact update strip shared by registry and runtime updates. Its collection opts
into `SettingsSidebarItem.compact`; healthy rows have no redundant loaded/type
line, while errors and operation progress add one detail line. Ordinary Settings
rows and other collections retain their default geometry and wrapping.
The approved Plugins mockup also embeds a compact GUI interface/status/switch
strip above a provider's form and a small neutral window capability icon in its
collection row. There is no second GUI inventory card or row action menu.
Plugin detail header actions are ordered delete icon, reload, save. Delete
replaces discard and opens a confirmation naming the selected config entry or
local file; failure retains the editor and confirmation for retry.
Plugin options (JSON) use `SettingsJsonEditor`, including when adding npm/path
plugins. Object-only JSON validation, empty-as-default semantics, and
update/reload/submission disabled states still apply. Accessible labels,
validation state, and placeholders belong to the editable content element.
Plugin source files remain on their existing separate editing surface.

## Responsive and platform rules

- Verify mobile Settings layouts down to a 350px viewport width.
- Desktop and mobile render the same Settings components. Do not branch into
  duplicate markup merely to change visual layout.
- Mobile secondary pages use `MobileDetailNavigation`; pages must not recreate
  the back button, title position, or trailing action.
- A Settings page whose desktop surface is a collection beside an entity
  editor is `kind: 'split'` in Settings metadata. It has one shared information
  architecture with two responsive presentations:
  - desktop: Settings navigation / entity collection / selected entity editor
    may remain visible side by side;
  - mobile: Settings home -> entity collection -> selected entity editor is a
    three-level navigation flow. Selecting or creating an entity advances one
    level; Back from the editor returns to the collection, and Back from the
    collection returns to Settings home.
- Split pages must use the `SettingsView` `nav`, `page-sidebar`, and
  `page-content` stages. Feature pages must not own a competing mobile detail
  flag, history entry, back button, or duplicated mobile-only editor.
- Split-page collections use `SettingsSidebarLayout` or the same
  `yuri-settings-page-content` contract as their single scroll root. The mobile
  Settings shell owns the horizontal page gutter, so collection pages must not
  add a second mobile `px-*` layer. Summary controls and collection sections
  are `SettingsGroup` cards; the shared `MobileDetailNavigation` is the only
  secondary-page title, so collections do not repeat a local `h2`.
- A management page made of independent actions or dialogs is not a split page
  merely because it contains a list. Use `kind: 'single'` until an inline
  selected-entity editor actually exists.
- Settings may scroll as a page, but feature code must not pin a local title or
  search surface unless the owning navigation component explicitly requires it.
- A viewport-fixed secondary surface that escapes its parent page gutter must
  own exactly one `--yuri-mobile-page-inline-inset` at its scrolling body
  boundary. Its header aligns to that token, and descendants must not add
  another page-level inset. Bottom actions use the shared
  `MobileFloatingBottomBar` rather than a page-specific full-width footer, so
  their glass material, screen-edge clearance, and safe-area behavior match the
  root mobile dock.
- Labels, controls, helper copy, borders, and gaps must remain identical across
  light, dark, and high-contrast themes by using semantic tokens.
- Desktop split panes respond to the available detail-container width: below
  48rem the collection sits above the editor with its own bounded scroll area.
  Entity names wrap, and skill metadata occupies a separate line.
- Usage configuration spans the full detail width above the provider list and
  quota detail. Those results stack when the detail container is narrow.
- Cards at or below 32rem keep ordinary fields, selects, numeric inputs, short
  option groups, and Boolean controls inline: label on the left, content-sized
  value on the right. The value footprint is capped at 60% of the card width
  (up to 20rem); long labels wrap within the remaining space. Only explicit
  `yuri-settings-split-row-stacked` editors and collections use a full-width line.
  Container width, not viewport width, determines the compact layout.
- About version and export rows keep content-sized labels and right-aligned
  values on one line at every width. Action containers use the full row width
  without a value-column cap; buttons stay content-sized and right-aligned.
  Boolean rows retain the shared SettingsToggleRow layout.
- Scheduled-task entity editors keep compact label/value rows on one line at
  narrow widths. Cron previews and preset collections use full-width detail
  rows; an empty task title shows a red bottom border for required validation.

## Forbidden legacy patterns

Do not introduce these inside a Settings detail page:

- `h3.typography-ui-header` as a section label;
- local `mb-8`, `space-y-6`, `space-y-8`, or `px-2 pb-2 pt-0` section recipes;
- page-specific card borders, radii, shadows, input widths, or row dividers;
- separate desktop/mobile copies of the same form row;
- resting or hover borders and permanently filled input plates for ordinary
  inline Settings values instead of the shared interaction-only solid background;
- helper text inheriting the field-label font size.

## Review checklist

1. Every ordinary section is a `SettingsGroup` or `SettingsField`.
2. Every stable label/value pair is a `SettingsRow`.
3. Section label, field label, and helper copy occupy three distinct token
   levels.
4. Long descriptions live outside the card.
5. Sibling cards use only the shared stack gap.
6. Rows have one consistent border/divider treatment.
7. Values are right-aligned and borderless, with solid interaction backgrounds and no layout shift.
8. Search registry entries and `data-settings-item` anchors still agree.
9. Desktop and mobile use the same component tree.
10. Split pages traverse collection and editor as separate mobile levels, with
    browser/native Back returning exactly one level.
11. Focus, keyboard activation, long text, and conditional rows are verified.
