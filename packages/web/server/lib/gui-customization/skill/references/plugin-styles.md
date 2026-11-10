# Styling plugin-owned content

Use this reference when rendering a plugin page, panel, preview or settings view. Yuri provides theme CSS variables in the host document; the plugin owns its markup, CSS, layout and interactions. The React shell supplies the mount container and the existing GUI host mounts Solid/DOM content inside it. There is no Yuri GUI component library or implemented `ctx.ui` to import.

## Using the host styles

1. Put a plugin-specific class or data attribute on the content root and scope the plugin's CSS beneath it. Register that CSS with official `Style` so disabling the plugin removes it.
2. Use the variables below for colors and typography; let same-document CSS inheritance follow theme changes. Keep inline content transparent when its host already owns the background.
3. Choose icons from [icons](icons.md). Entry contribution names and SVG symbols inside content have different naming rules.
4. Verify the mounted view in light/dark mode, narrow width, keyboard focus and disabled/selected states. These references guide appearance; they do not constrain the plugin's business UI or supply its interaction behavior.

CSS colors are complete values: `color: var(--foreground)`, not `hsl(var(--foreground))`. Variables resolve at the consuming element, including local surface overrides. Prefer CSS over reading root styles into JavaScript snapshots; a snapshot does not follow theme changes by itself. Plugin bundles are not scanned by Yuri's Tailwind build, so arbitrary utility classes in a plugin are not guaranteed to exist. Write the needed CSS explicitly.

## Global color variables

The theme generator publishes these in the host document. Use the name whose meaning matches the element rather than selecting a color by how it looks in one theme.

| Purpose | Variables |
| --- | --- |
| Canvas and ordinary text | `--background`, `--foreground` |
| Muted surface and secondary text | `--muted`, `--muted-foreground` |
| Raised content | `--card`, `--card-foreground` |
| Popover content | `--popover`, `--popover-foreground` |
| Secondary surface | `--secondary`, `--secondary-foreground` |
| Subtle surface | `--accent`, `--accent-foreground` |
| Borders and focus ring | `--border`, `--input`, `--ring`; `--input` is a border color, not an input fill |
| Theme accent | `--primary`, `--primary-foreground`; use for links/emphasis, not the default button fill |
| Destructive feedback | `--destructive`, `--destructive-foreground` |
| Semantic surfaces | `--surface-background`, `--surface-foreground`, `--surface-muted`, `--surface-muted-foreground`, `--surface-elevated`, `--surface-elevated-foreground`, `--surface-subtle`, `--surface-overlay` |
| Hover and pressed | `--interactive-hover`, `--interactive-active`; apply to interactive elements |
| Selected item | `--interactive-selection`, `--interactive-selection-foreground` |
| Interactive borders | `--interactive-border`, `--interactive-border-hover`, `--interactive-border-focus` |
| Focus and cursor | `--interactive-focus`, `--interactive-focus-ring`, `--interactive-cursor` |
| Accent variants | `--primary-base`, `--primary-hover`, `--primary-active`, `--primary-muted`, `--primary-emphasis` |
| Status | `--status-error`, `--status-warning`, `--status-success`, `--status-info`; each also has `-foreground`, `-background` and `-border` variants |
| Sidebar | `--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring` |
| Loading indicator | `--loading-spinner`, `--loading-spinner-track` |
| Charts | `--chart-1` through `--chart-5` have base styles; further numbered colors depend on the theme's series |
| Pull-request state | `--pr-open`, `--pr-draft`, `--pr-blocked`, `--pr-merged`, `--pr-closed` |
| Code | `--syntax-background`, `--syntax-foreground`, `--syntax-comment`, `--syntax-keyword`, `--syntax-string`, `--syntax-number`, `--syntax-function`, `--syntax-variable`, `--syntax-type`, `--syntax-operator` |

Semantic variables and short aliases are emitted separately. Reading either is supported; overriding one does not automatically rewrite the other. For changing Yuri itself, use the [cascade and surface map](ui-surfaces.md#token-map-and-cascade), rather than overriding global tokens as part of an ordinary plugin view.

## Text, geometry and controls

| Purpose | Variables / behavior |
| --- | --- |
| Font families | `--font-sans`, `--font-mono`; use `font: inherit` for controls that should follow their surrounding text |
| Font weight | `--ui-regular-font-weight` |
| Semantic text sizes | `--text-ui-header`, `--text-ui-label`, `--text-meta`, `--text-micro`, `--text-markdown`, `--text-code`; names describe roles, not a guaranteed size ordering |
| Button typography | `--ui-button-line-height`, `--ui-button-letter-spacing`, `--ui-button-font-weight` |
| Caption typography | `--ui-caption-line-height`, `--ui-caption-letter-spacing`, `--ui-caption-font-weight` |
| Base radius | `--radius` |
| Radius scale | Design-system names `--radius-none`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-full` are declared in Tailwind's theme; use a fallback such as `var(--radius-lg, var(--radius))` if a build does not retain a variable |
| Spacing density | `--padding-scale` is unitless; e.g. `gap: calc(0.5rem * var(--padding-scale, 1))` |
| Physical scale | `--dpt` is a length, `--dpt-n` a unitless factor; desktop defaults are `1px` / `1`. `--padding-scale` already includes the physical factor |
| Form dimensions | `--form-control-height`, `--form-control-radius` |
| Form colors | `--form-control-background`, `--form-control-border` |
| Form typography | `--form-control-font-size`, `--form-control-line-height`, `--form-helper-font-size`, `--form-helper-line-height` |
| Form dividers | `--form-surface-border`, `--form-row-divider` |
| Optional theme config | `--font-heading`, `--transition-fast`, `--transition-normal`, `--transition-slow` exist when supplied by the theme; provide a fallback |

Form tokens can be overridden by Settings ancestors. Settings-only `--yuri-settings-*` variables and popup-specific materials are described in [UI surfaces](ui-surfaces.md); they are not universally available to a plugin mounted elsewhere. Host mobile CSS also applies its minimum touch sizes to ordinary buttons in plugin content.

## Small CSS example

This is plugin-owned CSS, not a component or a registration of a new extension point. Register it with `ctx.add(Style, css)` and put `class="studio-view"` on the plugin root. Its child markup can be authored with Solid or DOM APIs.

```css
.studio-view {
  min-width: 0;
  color: var(--foreground);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: var(--text-ui-label);
  font-weight: var(--ui-regular-font-weight, 400);
}
.studio-view .studio-row {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: calc(0.5rem * var(--padding-scale, 1));
}
.studio-view .studio-detail { color: var(--muted-foreground); }
.studio-view .studio-success { color: var(--status-success); }
.studio-view .studio-action {
  font: inherit;
  color: var(--foreground);
  background: var(--surface-muted);
  border: 0;
  border-radius: var(--radius-lg, var(--radius));
  padding: 0.375rem 0.625rem;
}
.studio-view .studio-action:hover:not(:disabled) {
  background: color-mix(in srgb, var(--foreground) 6%, var(--surface-muted));
}
.studio-view .studio-action:active:not(:disabled) {
  background: color-mix(in srgb, var(--foreground) 12%, var(--surface-muted));
}
.studio-view .studio-action:focus-visible {
  outline: 2px solid var(--interactive-focus-ring) !important;
  outline-offset: 2px;
}
.studio-view .studio-action:disabled { opacity: 0.5; }
```

The example uses Yuri's neutral solid action colors. Quiet row actions can use transparent rest / `--interactive-hover` / `--interactive-active`; selected rows use the selection pair. The scoped focus rule is important because host base styles reset non-input focus outlines with `!important`. Use native `button` semantics for actions and keep any additional behavior in the plugin.

## Document boundaries

Same-document Solid/DOM content inherits these variables without a React-to-Solid component bridge or theme polling. An iframe has a separate document and does not inherit them or the host's SVG symbols; apply its own theming mechanism when using one. CSS and icon guidance do not create new GUI capabilities.

Source owners: `packages/ui/src/lib/theme/cssGenerator.ts`, `packages/ui/src/styles/design-system.css`, `packages/ui/src/styles/typography.css`, `packages/ui/src/components/ui/button.tsx`. Check the matching Yuri version when a variable is unavailable.
