# Appearance contracts

Use `Plugin`, `Registry`, and `Style` from `@opencode/plugin/gui`. The package build/install instructions are in [workflow](workflow.md).

## Activation and priority

Enabled plugins apply themes, CSS, Logo and supported Dock icons automatically. There is no separate plugin-appearance selector. For each resource kind (and each theme variant), the last matching contribution wins: later plugins in the service's global inventory take priority, then later contributions within that plugin. Priority follows inventory order, not asynchronous bundle arrival or plugin names.

Disabling, failure or withdrawal reveals the preceding active contribution, then the user's base theme or Yuri's default branding. Existing light/dark mode and saved base theme choices remain unchanged. Expose only the intended active resources; if a plugin needs its own variants, choose which to register through its own configuration.

## Theme contributions: `yuri.theme`

Each contribution is:

```ts
type ThemeContribution = {
  id: string
  title: string
  variant: 'light' | 'dark'
  colors?: Record<string, unknown>
  config?: {
    fonts?: { sans?: string; mono?: string; heading?: string }
    spacing?: { xs?: string; sm?: string; md?: string; lg?: string; xl?: string }
    transitions?: { fast?: string; normal?: string; slow?: string }
  }
}
```

`colors` is a deep partial Yuri theme, merged onto the built-in default for the variant. Common families: `primary` (base/foreground/hover/active), `surface` (background/foreground/muted/mutedForeground/elevated/elevatedForeground/overlay/subtle), `interactive` (border/hover/active/selection/selectionForeground/focusRing), `status`, `syntax`, `chat`, `markdown`, `tools`. Preserve the schema's nested string/color structure. Required resulting tokens are validated. Neutral base-text brightness floors still apply; syntax, secondary and accent colors remain theme-owned.

```ts
const Theme = Registry.define<ThemeContribution>('yuri.theme')
ctx.add(Theme, {
  id: 'ink-dark', title: 'Ink Dark', variant: 'dark',
  colors: {
    primary: { base: '#8dafff' },
    surface: { background: '#151820', muted: '#202532' },
  },
})
```

The host owns a collision-free theme ID `gui:` + `JSON.stringify([pluginId, id])`; authors supply only the local `id`. Themes override the current matching light/dark variant while enabled and are not added as Settings choices. Up to 16 themes per plugin, 128 per window, 64 KiB per theme. VS Code continues to follow its editor theme; embedded views follow their parent theme.

## CSS: official `Style`

```ts
import css from './skin.css?inline'
ctx.add(Style, css)
```

CSS is active immediately while the plugin is enabled. Host base theme variables stay before plugin styles, including after theme switches. Ordinary CSS specificity and source order still apply; the declarative resource priority above does not reorder style elements. Base light tokens include `:root:not(.dark)` (two class-level selectors), so a plain `:root` override has lower specificity; use `html[data-theme="light"]` / `html[data-theme="dark"]` or matching specificity. Tailwind aliases such as `--background` / `--primary` are important declarations and require an important override if you deliberately bypass a registered theme. Common semantic tokens: `--surface-background`, `--surface-foreground`, `--surface-muted-foreground`, `--primary-base`, `--interactive-selection`, and `--font-mono`. Inspect actual current DOM/tokens before targeting a specific layout; generated Tailwind classes are not a stable plugin API. `[data-yuri-logo]` identifies the shared application logo. CSS does not cross iframe or native-window boundaries.

## Branding: `yuri.branding`

```ts
type Branding = {
  id: string
  title: string
  logo?: { svg: string; lightSvg?: string }
  dockIcon?: { png: string; lightPng?: string }
}
const Branding = Registry.define<Branding>('yuri.branding')
ctx.add(Branding, {
  id: 'studio', title: 'Studio',
  logo: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#8dafff"/></svg>' },
})
```

At least one of `logo` / `dockIcon` is required. `svg` / `png` are the dark/default resource; the `light*` resource is optional. Logo and Dock are resolved independently, so a Logo-only plugin does not suppress another plugin's Dock icon. Branding does not rename the app or replace its wordmark text.

- Logos: inline complete SVG text with SVG namespace; maximum 16 KiB UTF-8 each. Static geometry, groups, gradients, defs, clipPath, mask and local `#id` references are allowed. Scripts, event handlers, embedded HTML, stylesheets, inline style, external references, DTD and processing instructions are rejected. Resources render as images, never injected SVG markup.
- Dock: inline `data:image/png;base64,...`, at most 2 MiB of URL text, valid PNG, dimensions 1–1024 per side. Import with `?inline` as text only when it really yields a PNG data URL, or generate the data URL at build time. No filesystem path or remote image URL. Requires trusted local macOS Electron; no plugin `main` needed. Preview builds or older shells may reject the capability. Other runtimes still support the logo.
- Maximum 8 branding entries/plugin, 64/window; combined serialized appearance contributions 8 MiB/plugin, 16 MiB/window. IDs/titles are nonempty strings up to 128 characters; IDs are unique within each registry/plugin.
- Unregister, disable, reload, failure and runtime switch withdraw resources. If several local windows apply a Dock icon, the newest active window update wins; closing/releasing it restores the previous window's icon or Yuri default. System appearance changes cannot overwrite an active plugin icon.
- Invalid appearance contributions or a failed Dock application fail the owning plugin and clean its contributions; unrelated plugins remain active. Diagnostics appear in plugin settings. These contracts do not grant a JS sandbox.

## Verification

For each supplied appearance resource, verify automatic activation, light/dark behavior, disable restoring the fallback, re-enable restoring the resource, and hot rebuild removing obsolete resources. Confirm saved base theme preferences remain intact and multiple providers follow inventory priority. CSS overrides must retain their intended precedence after theme switches. Check Logo changes in the running UI; startup branding remains built-in. Dock verification requires a real trusted local macOS Electron window, including lease release and multiple-window ownership when applicable.
