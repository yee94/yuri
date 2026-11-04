# Built-in UI structure and styles

Read this for changes to existing Yuri blocks: backgrounds, sidebar, header, chat, composer, preview, Settings or overlays. For contribution schemas and activation, use [appearance](appearance.md). This map travels with Yuri so plugin authors can start without a source checkout or unpacking the application.

## Fast path

1. Locate the requested block in the table below. Prefer a theme contribution for coordinated colors, or a scoped `Style` rule for one block's material/geometry.
2. Inspect only that block's computed styles and ancestors in the target client. Installed plugins may already override the built-in styles; the live result is not necessarily the default.
3. Apply the smallest override, then check the changed block in light/dark and its relevant interaction states. A missing selector means a different view/version or an unmounted block, not permission to broaden the selector to the whole app.

`yuri.*` registries are contracts. DOM attributes and named classes below are current implementation hooks: prefer them over utility-class strings, translated labels, `nth-child` or generated IDs, and check their presence on the installed version. Preserve scroll ownership, resize handles and input layout while changing materials.

## Layout map

Desktop session view, simplified ownership (wrappers omitted; not a selector chain):

```text
html → body → #root → .main-content-safe-area
  aside.yuri-vibrancy-surface → .yuri-session-sidebar
  [data-chat-area]
    main[data-primary-chat]
      header.header-safe-area
      [data-primary-chat-content]
        transcript [data-scrollbar="chat"] → .yuri-chat-scroll-content
          [data-message-id] → .chat-message-column → message content
        .chat-input-column → composer surface
    aside[data-context-panel] → [data-context-layout] → preview / file rail
body → portalled dialogs / menus / tooltips
```

Settings and global plugin pages can replace the session view. Mobile uses page/sheet/composer-foot surfaces rather than this full desktop split. Mini Chat and VS Code have different outer shells; shared composer/message hooks still need their enclosing scope checked.

| Block | Locate | Built-in material / useful knobs |
| --- | --- | --- |
| App canvas | `body`, `#root`, `.main-content-safe-area` | `--background`; several nested wrappers also paint `bg-background`. Clearing only `body` does not clear its children. |
| Left sidebar | `aside.yuri-vibrancy-surface`; contents `.yuri-session-sidebar` | `--sidebar`, `--sidebar-vibrancy-overlay`; native vibrancy rules described below. Dark sidebar text has local overrides. |
| Header | `header.header-safe-area` | `--background`; native Windows chrome can use `--surface-background`. Preserve `.app-region-no-drag` controls and titlebar drag geometry. |
| Primary chat | `[data-primary-chat]`, `[data-primary-chat-content]` | Main and inner ChatContainer wrappers paint `--background`. Chat workspace and preview are siblings. |
| Transcript | `[data-scrollbar="chat"]`, `.yuri-chat-scroll-content` | Scroll viewport and content, respectively. `.chat-column` / `.chat-message-column` own reading width. Message roots carry `data-message-id`; IDs are runtime data, not style keys. |
| Composer column | `.chat-input-column` | Shares `--yuri-chat-column-max` and `--yuri-chat-column-max-wide` with transcript. Also used by draft headings/presets, so not itself the input card. |
| Composer card | `.chat-input-column div:has(> [data-composer-content="true"])` | `ChatComposerSurface`: light background/border/shadow; dark foreground mix (8%, hover/focus 11%). Radius is inline `var(--radius-xl)`. This structural selector is version-sensitive. |
| Composer content | `[data-composer-content="true"]` → `[data-composer-input-shell="true"]` → `textarea[data-chat-input="true"]` | Content/layout owner, highlight/input stack, then transparent native textarea. The textarea is not the card's material owner. Footer: `[data-chat-input-footer="true"]`; actions: `[data-composer-send]`, `[data-composer-stop]`. |
| Preview | `[data-context-panel="true"]`, `[data-context-layout="single"]` / `[data-context-layout="split"]` | Outer panel is transparent; editors, web previews and file rails can paint their own backgrounds. CSS in the host does not style an iframe's document or a native webview. |
| Settings | `.yuri-settings-workspace`, `.yuri-settings-sidebar` | Workspace owns local form tokens. Group structure: `.yuri-settings-group` → label + `.yuri-settings-group-card` → `.yuri-settings-group-row`. |
| Settings card | `.yuri-settings-group-card` | `--yuri-settings-group-background`, `--yuri-settings-group-border`, `--yuri-settings-group-radius`; row padding/dividers are separate tokens. |
| Form controls | `[data-slot="input"]`, `[data-slot="textarea"]`, `[data-slot="select-trigger"]` | `--form-control-*`; Settings adds `--yuri-settings-control-*`. Compound textarea material lives on its wrapper; simple textarea mode puts the slot on the textarea. |
| Dialogs | `[data-slot="dialog-content"]`, `[data-slot="dialog-overlay"]` | Ordinary dialog content uses `--background`; scrim is separate. Picker dialogs use `.yuri-picker-dialog` and glass material. Settings has its own dialog surface, not necessarily `dialog-content`. |
| Anchored menus / selects | `[data-slot="dropdown-menu-content"]`, `[data-slot="dropdown-menu-sub-content"]`, `[data-slot="select-content"]`, `.yuri-popup-surface` | Shared glass uses `--yuri-popup-fill` (an elevated-color mix), `--yuri-popup-edge`, `--yuri-popup-shadow`, `--yuri-popup-divider`. Changing `--popover` alone does not reach every popup. |
| Logo | `[data-yuri-logo]` | May be built-in `svg` or plugin `img`. Replace artwork with `yuri.branding`, not an SVG-path CSS selector. Does not include the wordmark, agent avatars, provider logos or startup splash. |
| Mobile / glass materials | `.yuri-mobile-composer-surface`, `.yuri-mobile-overlay-surface` | Additional glass, pseudo-element and keyboard/safe-area layers. The overlay class is also used on desktop. Inspect `::before` / `::after` as well as background; retain positioning and viewport insets. |

### Chat paint layers

`ChatWorkspace` exposes the outer boundaries. Inside `[data-primary-chat-content]`, the active `ChatContainerContent` has its own full-height `bg-background` root. It is separate from the transparent workspace boundary. The normal conversation branch contains:

```text
[data-primary-chat-content]                         transparent boundary
  … session-host wrappers …
  div.relative.flex.flex-col.h-full.bg-background    ChatContainerContent root
    div.relative.min-h-0.flex-1                     ChatViewport allocation
      div.absolute.inset-0                         viewport positioner
        [data-scrollbar="chat"].chat-scroll         actual ScrollShadow viewport
          .yuri-chat-scroll-content                 scroll content
            … MessageList / turn / virtualizer wrappers …
            [data-message-id]                      message root
              .chat-message-column                 reading-width wrapper
                [data-user-message-bubble="true"]  user bubble, nested in layout/animation wrappers
    div.relative.z-10.bg-background                 composer foot (viewport sibling)
      div[aria-hidden="true"]                      desktop edge-fade gradient
      … .chat-input-column …
        div:has(> [data-composer-content="true"])   composer card
          [data-composer-content="true"]
            … [data-composer-input-shell="true"] …
              [data-composer-highlight="true"]     optional highlight layer
              … textarea[data-chat-input="true"]
            [data-chat-input-footer="true"]        stacked-layout footer
```

The class-only root, positioner, desktop composer foot and edge fade have **no dedicated data selector**. Their utility classes describe the current structure, not unique identifiers. The desktop fade is an absolute `bottom-full` element with a background-image gradient from `--surface-background` to transparent; it is not the scroll viewport's background color. Mobile composer feet use `.yuri-mobile-composer-foot`, optionally `.yuri-mobile-composer-foot--overlay`.

| State / content | Actual selector or structure | Paint ownership |
| --- | --- | --- |
| Normal conversation | `[data-scrollbar="chat"]` inside the ChatContainer root | Viewport/content wrappers normally have no background fill; root and composer foot independently use `--background`. |
| Session hydration | `.chat-scroll` inside the ChatContainer root; no `data-scrollbar="chat"` on this branch | Skeleton scroll viewport additionally has `bg-background`. |
| Session loading placeholder | `[data-session-view-loading="true"]` | Own `bg-background`; no transcript viewport yet. |
| Draft / empty conversation | `.yuri-draft-center` when compact draft layout is active; otherwise unnamed layout wrappers | Root and composer placement wrappers use `bg-background`; a transcript selector need not exist. |
| User message | `[data-message-id] [data-user-message-bubble="true"]` | Inline `background-color: var(--chat-user-message-bg)`; inline radius `--radius-xl`, bottom-right `--radius-sm`. The message root and `.chat-message-column` are not the bubble. |
| User shell output | `[data-shell-result="true"]` | Replaces the ordinary user-bubble branch; no user-bubble fill/radius from `ChatMessage`. |
| Assistant message | `[data-message-id].yuri-message-hover-scope` → `.chat-message-column` → content | Ordinary assistant wrapper is transparent, not a symmetric user bubble. Code, tools and other cards own their materials. `--chat-assistant-message-bg` exists as a token but is not applied to this outer wrapper. |
| Composer card | `.chat-input-column div:has(> [data-composer-content="true"])` | Own fill, border, shadow and inline radius; its parent foot is a separate painted layer. |
| Composer send / stop glyph | `[data-composer-send]`, `[data-composer-stop]` contain the circular icon | Inner icon uses `bg-foreground text-background`: `--foreground` paints the disk, `--background` paints the glyph via `currentColor`. |

Source owners: `ChatWorkspace.tsx`, `ChatContainer.tsx`, `ChatMessage.tsx`, `ChatPromptComposer.tsx`, `ChatComposerSurface.tsx`, and `components/icons/StopIcon.tsx` under `packages/ui/src` (layout/chat subdirectories as listed below).

## Token map and cascade

Theme values are CSS colors, not HSL channel tuples: use `var(--background)`, not `hsl(var(--background))`.

| Theme field | Semantic variable | Generated alias / common consumer |
| --- | --- | --- |
| `surface.background` | `--surface-background` | `--background` → `bg-background`, app/chat/header |
| `surface.foreground` | `--surface-foreground` | `--foreground` → ordinary text |
| `surface.muted` | `--surface-muted` | `--muted`, `--secondary`, `--sidebar-base` → `--sidebar` |
| `surface.mutedForeground` | `--surface-muted-foreground` | `--muted-foreground`, `--sidebar-foreground` |
| `surface.elevated` | `--surface-elevated` | `--card`, `--popover` |
| `surface.elevatedForeground` | `--surface-elevated-foreground` | `--card-foreground`, `--popover-foreground` |
| `surface.subtle` | `--surface-subtle` | `--accent`, `--sidebar-accent-base` → `--sidebar-accent` |
| `primary.base` | `--primary-base` | `--primary`; default action buttons instead use neutral surfaces |
| `interactive.border` | `--interactive-border` | `--border`, `--input` (border, not input fill) |
| `interactive.hover` / `selection` / `focusRing` | `--interactive-hover`, `--interactive-selection`, `--interactive-focus-ring` | Interaction fills and focus; `--ring` aliases focusRing |

The generator writes semantic variables and aliases as **separate values**. Changing only `--surface-background` does not update `--background`. A `yuri.theme` contribution keeps them coordinated automatically. For CSS-only overrides, change the variables actually consumed by the target.

Variables are shared by consumers, not exclusively by visual regions. `--background` also supplies inverse foregrounds (`text-background`), while `--surface-background` supplies composer fills and edge gradients. `--chat-user-message-bg` comes from `chat.userMessageBackground`, falling back to `surface.elevated`; `--chat-assistant-message-bg` comes from `chat.assistantMessageBackground`, falling back to `surface.muted`. An element's `background` property affects that element's paint; changing an inherited variable affects all descendant consumers, including text and nested cards.

Base variables live in `style#opencode-theme-variables`; plugin styles in `style[data-yuri-plugin-style]` follow that block. Light variables use `:root:not(.dark)` (specificity 0,2,0); dark uses `:root` and `.dark`. Aliases such as `--background`, `--sidebar` and `--popover` are `!important`. Later position alone cannot beat specificity or importance. Neither `html:root` nor `html[data-theme="light"]` beats `:root:not(.dark)` at equal importance. Use `:root:root` for a mode-independent equal-specificity rule, or `:root[data-theme="light"]` / `:root[data-theme="dark"]` for a mode-specific one, with `!important` only for important declarations you intend to override.

`data-theme="light|dark"` describes the effective mode; `.light` / `.dark` also exist. `.desktop-runtime` means the native desktop runtime; `.device-desktop` is layout/device classification and also occurs in a desktop browser. A plugin's `Style` participates in the CSS cascade; declarative appearance contribution priority is a separate mechanism.

In light mode, the generated selection fill derives from foreground/background, rather than copying `interactive.selection` directly. Inspect `--interactive-selection` when styling selected states.

### Geometry and text

- Reading/input width: `--yuri-chat-column-max`, `--yuri-chat-column-max-wide`; `.wide-chat-layout` selects the latter. Change both only when both modes are requested.
- Typography: `--font-sans`, `--font-mono`, `--text-markdown`, `--text-code`, `--text-ui-header`, `--text-ui-label`, `--text-meta`, `--text-micro`; corresponding `.typography-*` classes consume the size tokens.
- Settings: `--yuri-settings-group-radius`, `--yuri-settings-row-min-height`, `--yuri-settings-row-block-padding`, `--yuri-settings-row-inset`, `--yuri-settings-section-stack-gap`. Put overrides on `.yuri-settings-workspace`, where defaults are declared, rather than on an ancestor that would be shadowed.
- Controls: `--form-control-height`, `--form-control-radius`, `--form-control-background`, `--form-control-border`. Settings can override these through its local material tokens.

## Scoped recipes

Register these through official `Style`; choose the relevant recipe rather than applying all of them. Colors and dimensions below are illustrative.

### Coordinate canvas tokens

```css
:root[data-theme="light"] {
  --surface-background: #f5f7fa;
  --background: #f5f7fa !important;
}
:root[data-theme="dark"] {
  --surface-background: #171b22;
  --background: #171b22 !important;
}
```

This changes all consumers of these canvas tokens, including the composer base and ordinary dialogs. For a single block, set that block's `background-color` instead. `--card`, `--popover`, sidebar, glass-popup and syntax surfaces remain independently owned. When another enabled plugin already overrides a semantic token with `!important`, resolve that conflict explicitly; these examples target the built-in styles.

### Composer material

```css
.chat-input-column div:has(> [data-composer-content="true"]) {
  background: var(--surface-elevated);
  border-color: var(--interactive-border);
  box-shadow: none;
  border-radius: 18px !important;
}
```

The radius override is important because this component writes radius inline. Input and highlight layers must keep identical typography, padding and line wrapping. Scope the selector under `[data-primary-chat]` when only the primary session composer should change; shared composers can also appear in Bot and mini-chat surfaces.

### Settings card and row spacing

```css
.yuri-settings-workspace {
  --yuri-settings-group-radius: 12px;
  --yuri-settings-row-block-padding: 0.75rem;
  --yuri-settings-group-background: var(--surface-elevated);
}
```

Applies to standard group cards. Specialized list surfaces can deliberately replace the material (for example, `.yuri-provider-collection-card` stays transparent and square); inspect that block's owning rule when it is the requested target.

### Reading width

```css
:root:root {
  --yuri-chat-column-max: 54rem;
  --yuri-chat-column-max-wide: 68rem;
}
```

This keeps transcript, input and column-aligned controls on the same width system rather than stretching only the textarea.

## Transparency and glass

Distinguish three layers: **CSS paint**, **browser canvas**, **native window material**. `background: transparent` removes only that element's paint; descendants, ancestors, pseudo-elements, gradients and native material may still be visible. `opacity` affects text and controls too, so it is not a substitute for background alpha.

- For a translucent block, change its material and preserve foreground/hover/focus contrast. Inspect all painted layers in the block before broadening the override.
- Canvas wrappers, message bubbles, composer cards and popups are separate paint owners. Their shared color variables also serve foregrounds and gradients; the ownership table above identifies element backgrounds separately from those tokens.
- Native macOS vibrancy uses `data-yuri-vibrancy`, `data-yuri-vibrancy-ready` and `.yuri-vibrancy-surface`. The sidebar paints `--sidebar` until ready, then `--sidebar-vibrancy-overlay`. Suppressed/native-browser-visible states and reduced-transparency preferences restore opacity. These are host state signals; CSS must not manufacture them to enable native behavior.
- CSS `backdrop-filter` and native vibrancy are different layers. Removing CSS blur does not remove native blur. GUI appearance contracts expose Logo/Dock resources and CSS, not a general transparent-window/vibrancy control. A web preview cannot prove desktop see-through behavior.
- Host CSS stops at iframe/native-webview boundaries; use the embedded content's own theming contract where available.

## Bounded inspection

Run in the target page's browser evaluation context. Replace the selector list with only the affected blocks; this reads geometry/materials without dumping conversation text or configuration.

```js
const selectors = ['[data-primary-chat]', '.header-safe-area', '.yuri-vibrancy-surface'];
selectors.map(selector => ({
  selector,
  count: document.querySelectorAll(selector).length,
  samples: [...document.querySelectorAll(selector)].slice(0, 2).map(element => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      image: style.backgroundImage,
      backdrop: style.backdropFilter,
      before: getComputedStyle(element, '::before').backgroundColor,
      after: getComputedStyle(element, '::after').backgroundColor,
      canvas: style.getPropertyValue('--background').trim(),
      surface: style.getPropertyValue('--surface-background').trim(),
    };
  }),
}));
```

If an override loses, inspect the matching rule in `opencode-theme-variables`, the target's inline style and the relevant plugin style. Resolve that cascade conflict before scanning unrelated source or application bundles. Verify the requested block, relevant hover/focus/disabled states, mode switch, and removal of the plugin override.

## Source owners (when a checkout is available)

Paths are relative to the Yuri repository; installed-plugin work does not require these files.

- Shell: `packages/ui/src/components/layout/{MainLayout,Sidebar,Header,ChatWorkspace,ContextPanel}.tsx`.
- Composer: `packages/ui/src/components/chat/{ChatComposerSurface,ChatPromptComposer,ChatInput}.tsx`; transcript: `ChatContainer.tsx`, `ChatMessage.tsx` in the same directory.
- Theme variables: `packages/ui/src/lib/theme/cssGenerator.ts`; base materials/native transparency: `packages/ui/src/index.css`, `packages/ui/src/styles/design-system.css`.
- Width/type: `packages/ui/src/styles/typography.css`; Settings: `packages/ui/src/styles/settings.css`; mobile materials: `packages/ui/src/styles/mobile.css`.
- Primitives and Logo: `packages/ui/src/components/ui/`; native window material: `packages/electron/main.mjs`.
