# Plugin icons

Use this reference when choosing an entry icon or rendering icons inside plugin-owned Solid/DOM content. Icon names, package artwork, file icons and application branding are separate contracts. Use [plugin styles](plugin-styles.md) for the surrounding text and colors.

## Upstream contract

OpenCode's `TitlebarItem.icon` is an optional `IconName`, imported as a **type** from `@opencode/plugin/gui`. Its value is a catalog name such as `globe`, not an SVG string, image URL, CSS class or component. The type is erased at runtime; it is not an exported array or an icon renderer.

Upstream generates the SDK union from the application's icon catalog:

- [`packages/plugin/src/gui/icon-name.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/gui/icon-name.ts): accepted SDK names; editor completion comes from this union.
- [`packages/ui/src/icons/catalog.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/ui/src/icons/catalog.ts): upstream artwork and catalog.
- [`packages/plugin/script/icon-name.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/script/icon-name.ts): generator; the SDK carries the names without requiring `@opencode/ui` in plugin bundles.
- [Official GUI reference](https://opencode.ai/v2/docs/build/plugins/gui#titlebar-items): contribution syntax.

Use the installed SDK's declaration for its exact version. The links above follow upstream development; a name accepted by a newer SDK is not proof that Yuri renders it.

## Names supported by both hosts

For a plugin targeting OpenCode and Yuri, choose from this verified intersection of the upstream SDK catalog and Yuri's current **TitlebarItem** renderer (including aliases):

```text
archive arrow-left arrow-right arrow-up brain check circle-check circle-x
close code download edit eye flask folder github globe graduation-cap
keyboard layout-left layout-right lock refresh server shield stop task
terminal window-analytics
```

Common choices:

| Purpose | `icon` |
| --- | --- |
| Web/service page | `globe` |
| Dashboard/analytics | `window-analytics` |
| Server/connection | `server` |
| Files/workspace | `folder` |
| Code/development | `code` or `terminal` |
| Tasks | `task` |
| Experiments | `flask` |
| Success/failure | `circle-check` / `circle-x` |

For the direct-CJS workflow, put the name in the contribution; no icon import or dependency is needed:

```js
const { Plugin, TitlebarItem } = require('@opencode/plugin/gui')

module.exports = Plugin.define({
  setup(ctx) {
    ctx.add(TitlebarItem, {
      id: 'website', label: 'Studio', icon: 'globe',
      run: () => ctx.system.openExternal('https://example.com'),
    })
  },
})
```

For typed reactive contributions, annotate the return type as in the [global-page example](global-pages.md); otherwise TypeScript can widen `icon` to `string`.

## Yuri resolution and fallback

Yuri resolves `TitlebarItem.icon` through these aliases first, then an exact key in its own sprite:

| SDK name | Yuri sprite key |
| --- | --- |
| `globe` | `global` |
| `server` | `server` |
| `circle-check` | `checkbox-circle` |
| `circle-x` | `close-circle` |
| `window-analytics` | `bar-chart-box` |

Yuri's sprite contains additional names, but those are not automatically valid upstream `IconName` values. Use the shared names above for portable SDK contributions rather than casting a Yuri-only name into the SDK type. For an unlisted name, check the installed SDK and target Yuri version before relying on it.

- Missing or unknown name: Yuri keeps the entry label. Sidebar placement reserves an empty icon slot; titlebar placement renders text instead of an icon. It does not substitute package artwork or the upstream default download arrow.
- `busy: true`: a loading spinner replaces the icon and disables an actionable entry.
- Valid icon: titlebar placement shows the icon with a hover label; sidebar placement shows icon and text. Host styles control size and color.
- Registering `yuri.page.icon` alone does not create or configure its navigation entry. Register `TitlebarItem` and set its `icon` separately, as in [global pages](global-pages.md).

Source owners, matched to the target Yuri tag when available:

- [`GuiPluginTitlebarItems.tsx`](https://github.com/yee94/yuri/blob/main/packages/ui/src/components/gui-plugins/GuiPluginTitlebarItems.tsx): aliases, placement and fallback.
- [`sprite.ts`](https://github.com/yee94/yuri/blob/main/packages/ui/src/components/icon/sprite.ts): complete Yuri runtime catalog (the keys of `iconSpriteData`), not the upstream SDK union.

## Icons inside plugin content

For same-document content, Yuri's React `Icon` mounts a hidden SVG sprite with id `yuri-icon-sprite-v2`; its symbols use `yuri-<sprite-key>`. A plugin can reference an existing symbol with ordinary SVG, without importing the React component or a Solid wrapper:

```html
<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
     stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
     stroke-linejoin="round" aria-hidden="true" focusable="false"
     style="flex-shrink: 0; --yuri-icon-stroke: 1.5">
  <use href="#yuri-folder"></use>
</svg>
```

The same markup works in Solid; direct CJS can create `svg` and `use` with `document.createElementNS('http://www.w3.org/2000/svg', ...)`. Inherit `currentColor` from the surrounding text. Common host sizes are 14px for dense status rows and 16px for controls; the normal stroke is 1.5, with `--yuri-icon-stroke: 2` for stronger small icons. Put accessible text on the containing button when the SVG is decorative.

Common **sprite keys**, verified against Yuri's current catalog:

| Purpose | Sprite keys |
| --- | --- |
| Project / branch / worktree / changes | `folder`, `git-branch`, `node-tree`, `changes` |
| Expand / collapse | `arrow-right-s`, `arrow-down-s` |
| Success / failure / information | `check`, `checkbox-circle`, `close-circle`, `alert`, `information` |
| Actions | `file-copy`, `download`, `refresh`, `settings-2`, `external-link`, `close` |
| Loading | `loader-4` (the symbol itself is static; animation belongs to the plugin) |
| Web / analytics | `global`, `bar-chart-box` |

`<use>` needs the exact sprite key: the entry aliases above do not apply (`global`, not `globe`; `checkbox-circle`, not `circle-check`). The complete source catalog is the linked `sprite.ts`. To inspect an installed host's available names once:

```js
Array.from(
  document.querySelectorAll('#yuri-icon-sprite-v2 symbol[id^="yuri-"]'),
  symbol => symbol.id.slice('yuri-'.length),
)
```

These symbol IDs are current DOM implementation hooks, not an SDK icon-renderer API. The sprite is inserted when a host icon renders; check that the chosen symbol exists in the target document. A missing symbol renders no artwork: retain a text label or use plugin-owned inline SVG. Iframes cannot reference the parent document's symbols. The host owns sprite insertion and replacement; plugins only reference it. Standalone artwork should use a 24×24 viewBox, `currentColor` and matching stroke conventions where appropriate.

## Artwork boundaries

| Surface | Contract |
| --- | --- |
| Global plugin page/tab navigation entry | `TitlebarItem.icon`: supported catalog name |
| Plugin artwork in Settings plugin details | Top-level `package.json.icon`: validated image/data resource; not used by the global entry renderer |
| Custom file extension icon | `yuri.file-icon`: SVG resource; see [file previews](file-previews.md) |
| Application Logo / running macOS Dock icon | `yuri.branding`; see [appearance](appearance.md) |
| Artwork inside plugin-owned page content | Render it in the page's own Solid/DOM content |

The current entry contract has no custom-SVG/image field. Supplying an image URL as `TitlebarItem.icon`, or setting `package.json.icon`, does not add one.

## Verification

Check the actual entry in each target placement: selected artwork, visible/hover label, `busy` spinner, missing-name fallback, and withdrawal when the plugin is disabled. SDK typechecking alone does not prove Yuri runtime support.
