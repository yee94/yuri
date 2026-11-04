# Package, build, install, verify

## Complete minimal appearance plugin

Use a separate plugin directory, not Yuri's source tree. These three files illustrate a complete theme + logo + CSS package. For pages, file viewers or other capabilities, keep the package/build structure and use the matching reference's GUI entry. A Dock contribution is needed only when requested.

`package.json`:

```json
{
  "name": "yuri-studio-skin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { "./gui-experimental": "./dist/gui-experimental.cjs" },
  "files": ["dist"],
  "scripts": { "build": "vite build", "dev": "vite build --watch" },
  "dependencies": { "@opencode/plugin": "2.2.0" },
  "devDependencies": { "vite": "^7.0.0", "vite-plugin-solid": "^2.11.0", "solid-js": "^1.9.0" }
}
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import { gui } from '@opencode/plugin/gui/vite'
export default defineConfig({ plugins: [gui()] })
```

`src/gui.tsx`:

```tsx
import { Plugin, Registry, Style } from '@opencode/plugin/gui'

const Theme = Registry.define<{
  id: string; title: string; variant: 'dark' | 'light';
  colors?: { primary?: { base?: string }; surface?: { background?: string } }
}>('yuri.theme')
const Branding = Registry.define<{
  id: string; title: string; logo?: { svg: string; lightSvg?: string }
}>('yuri.branding')

export default Plugin.define({
  setup(ctx) {
    ctx.add(Theme, {
      id: 'studio-dark', title: 'Studio Dark', variant: 'dark',
      colors: { primary: { base: '#8dafff' }, surface: { background: '#151820' } },
    })
    ctx.add(Branding, {
      id: 'studio', title: 'Studio',
      logo: {
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#8dafff"/></svg>',
        lightSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#3155a0"/></svg>',
      },
    })
    ctx.add(Style, '[data-yuri-logo] { border-radius: 12%; }')
  },
})
```

This package has no server entry and no `main`; its package name becomes its plugin ID. For a mixed server/GUI plugin, use the server part's `Plugin.define` ID consistently. No separate Yuri entrypoint is needed. The official Vite preset compiles Solid, inlines dynamic imports/dependencies, and emits one CJS file. Shared SDK/Solid/Effect modules must remain host-provided, not bundled duplicates.

## Installation and updates

1. Ask permission before installing dependencies or changing config. Use the user's selected package manager to install this standalone package's declared dependencies and run `build`. Verify `dist/gui-experimental.cjs` exists and exports a definition; do not point the host at TSX or an ES module.
2. Inspect the user's **global** `opencode.json(c)` and preserve unrelated configuration/comments. Add the absolute plugin directory to `plugins`, or use the documented OpenCode plugin installation command after checking that CLI's current help/docs. Do not invent CLI flags. For example:

   ```jsonc
   { "plugins": ["/absolute/path/to/yuri-studio-skin"] }
   ```

3. Yuri loads GUI entries from the connected service's global inventory. A project-only plugin entry will not supply a window GUI. Local path changes rebuilt by Vite are revision updates, not new npm versions. Confirm the plugin appears active in plugin settings; explicit refresh can retry a failed instance. The GUI enable switch is separate from server plugin loading.
4. Verify appearance contributions apply when the GUI is enabled, using [appearance](appearance.md) for priority and fallback. For other capabilities, verify their registered entry points.
5. For publication, remove `private` only when requested, build first, and publish the package with its CJS artifact. Use a new npm version for updates. No publishing is implied by a local customization request.

## Verification and rollback

Verify each implemented capability in the target client, not only the bundler. Check its normal, failed and unavailable states, cleanup on disable/rebuild, and isolation from unrelated plugins. Capability-specific checks belong to the matching reference. Report checks not performed rather than inferring cross-platform success.

Rollback: disable this GUI plugin or remove only its config entry. Disabling cleans contributions and native leases; appearance falls back according to its resource priority. Preserve unrelated plugins, user data and Yuri app resources.
