# Package, install, update

## Complete minimal appearance plugin

Default to a directly authored CommonJS file in a separate plugin directory. These two files are a complete theme + logo + CSS plugin: no dependency installation, compiler or dev server is needed. Include only the contributions requested by the user.

`package.json`:

```json
{
  "name": "yuri-studio-skin",
  "version": "0.1.0",
  "private": true,
  "exports": { "./gui-experimental": "./gui-experimental.cjs" },
  "files": ["gui-experimental.cjs"]
}
```

`gui-experimental.cjs`:

```js
const { Plugin, Registry, Style } = require('@opencode/plugin/gui')

const Theme = Registry.define('yuri.theme')
const Branding = Registry.define('yuri.branding')

module.exports = Plugin.define({
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

This package has no server entry and no `main`; its package name becomes its plugin ID. For a mixed server/GUI plugin, use the server part's `Plugin.define` ID consistently. The host supplies the SDK through `require`; a standalone Node `require` is not the plugin runtime. Use `node --check gui-experimental.cjs` for a quick syntax check.

Keep CSS/SVG as strings and Dock PNGs as data URLs in this file. Window DOM APIs and host-provided Solid helpers work without JSX. The host resolves only its shared modules, not relative `require('./style.css')`, sibling source files, or arbitrary installed dependencies. TypeScript snippets in other references describe contracts; direct CJS uses plain JavaScript, `require` and `module.exports` without type annotations.

## Installation and updates

1. Write the two files above and syntax-check the `.cjs`. Installation follows the user's requested scope; a direct-CJS plugin needs no package-manager step. The GUI entry is executable CommonJS JavaScript, not TS/TSX or ESM source.
2. Inspect the user's **global** `opencode.json(c)` and preserve unrelated configuration/comments. Add the absolute plugin directory to `plugins`, or use the documented OpenCode plugin installation command after checking that CLI's current help/docs. Do not invent CLI flags. For example:

   ```jsonc
   { "plugins": ["/absolute/path/to/yuri-studio-skin"] }
   ```

3. Yuri loads GUI entries from the connected service's global inventory. A project-only plugin entry will not supply a window GUI. Save changes directly to the exported `.cjs`; the local-file watcher updates the GUI revision and reloads the plugin. No build, version bump or application restart is needed for this edit loop. Confirm the plugin appears active in plugin settings; explicit refresh can retry a failed instance. The GUI enable switch is separate from server plugin loading.
4. Verify appearance contributions apply when the GUI is enabled, using [appearance](appearance.md) for priority and fallback. For other capabilities, verify their registered entry points.
5. For publication, remove `private` only when requested and include the exported CJS file in the package. Use a new npm version for published updates. No publishing is implied by a local customization request.

## Optional: compiled source

Use a build only when the implementation needs TS/TSX, JSX, bundled dependencies or split source/assets, or when maintaining an existing compiled plugin. The GUI host still receives one CommonJS file; OpenCode's ability to load server-side TypeScript does not extend to the GUI entry.

For this branch, put the source in `src/gui.tsx`, point `./gui-experimental` at `./dist/gui-experimental.cjs`, and include `dist` in `files`. Use `@opencode/plugin` 2.2.0 with compatible `vite`, `vite-plugin-solid` and `solid-js` development dependencies and these scripts: `build: vite build`, `dev: vite build --watch`. Install dependencies only within the authorized plugin scope.

```ts
import { defineConfig } from 'vite'
import { gui } from '@opencode/plugin/gui/vite'
export default defineConfig({ plugins: [gui()] })
```

The official preset compiles Solid JSX and emits one CJS file, inlining dynamic imports and non-shared dependencies. SDK/Solid/Effect shared modules remain host-provided. Here, saving source requires a rebuild (or `vite build --watch`) before the exported file changes and reloads.

## Verification and rollback

Verify each implemented capability in the target client. Check its normal, failed and unavailable states, cleanup on disable/reload, and isolation from unrelated plugins. Capability-specific checks belong to the matching reference. Report checks not performed rather than inferring cross-platform success.

Rollback: disable this GUI plugin or remove only its config entry. Disabling cleans contributions and native leases; appearance falls back according to its resource priority. Preserve unrelated plugins, user data and Yuri app resources.
