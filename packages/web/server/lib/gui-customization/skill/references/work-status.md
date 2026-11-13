# Work-status widgets

`Registry.define('yuri.work-status')` contributes plugin-owned Solid/DOM content below Changes and above Todos in the conversation's work-status column. It uses the same GUI package, plugin context and Solid renderer as panels/pages. This is a Yuri supplemental registry, not the upstream `Slot` registry.

## Registration and layout

```ts
interface WorkStatusContribution {
  readonly id: string
  readonly order?: number
  render(props: WorkStatusProps): import('solid-js').JSX.Element
}
```

Register with official `ctx.add`. An accessor returning `undefined` withdraws the widget. IDs are non-empty strings up to 128 characters, unique within this plugin's work-status contributions. `order` defaults to zero and must be finite. Widgets sort by ascending order, then the server's global plugin inventory order, then registration order within that plugin. Keep the render function stable when updating only order or visibility.

Content has natural height and shares the column's scrolling. An empty contribution creates no visible placeholder. There is no host title, card or component toolkit. Use [plugin styles](plugin-styles.md) and [icons](icons.md) to follow the surrounding appearance; the plugin owns its markup and interactions. Inline column width is currently 196px; the popup is 264px including its padding. Fit the available container rather than hardcoding a page width.

Web desktop and Electron render the widgets in both inline and popup modes, including when connected to a remote/Relay Host. Mobile, Capacitor and VS Code currently have no work-status column and do not mount these contributions. Registration itself remains valid. The slot follows the column's visibility setting and adds no native permissions or startup loading gate.

## Injected information

`render` runs once per mount. Read reactive properties inside Solid computations instead of destructuring their initial values.

| Property | Shape and source |
| --- | --- |
| `session` | Official `MountedSession` reference for **this displayed conversation**, or `undefined` before a draft has a session/directory. Yuri supports `id`, `key`, `directory`, `server`, `tab`, `pending`, `visit`, `location` on this reference; unsupported SDK members reject as elsewhere. |
| `directory` | Actual displayed working directory, or `null` while unresolved. Never replaced with another selected project's directory. |
| `runtimeId` | Opaque execution scope identity; Remote Projects include Hub/Host/Location and the captured authorization revision. Not a URL or durable cross-transport key. |
| `project` | Reactive `{ id?: string, name: string, directory: string } \| null`. Same project/worktree resolution as the built-in rows; a directory fallback can have no project ID. |
| `worktree` | Reactive `{ name: string, directory: string } \| null`. Explicit attached/discovered worktree, when known. |
| `git` | Reactive read-only summary described below, shared with the built-in Git rows. |
| `placement` | Reactive `'inline' \| 'popover'`. |
| `active` | `true` while mounted; changes to `false` before disposal. |
| `signal` | This mount's `AbortSignal`. Aborts on hiding, scope change, withdrawal, plugin replacement/disable/failure or host disposal. |

Git summary fields:

```ts
interface GitSummary {
  readonly state: 'unknown' | 'not-repository' | 'ready'
  readonly loading: boolean
  readonly branch: string | null
  readonly changedFiles: number | null
  readonly additions: number | null
  readonly deletions: number | null
}
```

`unknown` includes unresolved and pending-worktree data. Missing totals are `null`, not zero; a light Git snapshot can have a branch/file count but no line totals. `not-repository` comes from the shared repository check. `ready` describes the last available snapshot, not a successful request on every render. The existing Git store preserves its last snapshot after refresh failure and does not publish error details here; `loading` describes its foreground status load, not silent background requests. The slot adds no Git polling, file-content reads or message-history subscriptions.

Theme, locale, plugin options and authenticated client remain on `usePlugin()` / setup `ctx`. `ctx.sessions.current()` still describes the window's primary selection; use the injected session for widget-scoped requests. Existing navigation APIs retain their support boundaries: for example, file navigation for an explicitly different session can be rejected. Do not silently retarget it to the primary conversation.

Remote Projects use the current window's GUI inventory and options, not remote GUI code. Their injected `session.id`/`directory` are raw remote values; `session.key` and `session.server.id` are scoped identities, and `session.location` includes Hub/Host and the authenticated instance ID when known. The remote reference is read-only: `session.server.client` is explicitly unsupported, while `ctx.client` and screen/file still belong to the window. Widgets querying their own external service can use their configured endpoint plus the injected session ID. No remote SDK, filesystem or native capability is added by mounting the widget.

## Lifecycle and updates

Changing project/Git metadata or placement updates the existing Solid view; unrelated session/layout/stream updates do not rebuild the widget catalog or remount its DOM. Changing the displayed session ID, directory, host or captured authorization scope creates a new mount and aborts the previous one. Multiple visible instances have independent props and signals.

Use `onCleanup` for listeners and timers, or bind DOM listeners/requests to `props.signal`. Ignore completed asynchronous work after that signal aborts. Registration and rendering exceptions use the existing plugin failure path: affected content disappears, diagnostics remain in plugin settings, and unrelated plugins stay usable. Arbitrary plugin JavaScript still runs on the window's main thread; keep expensive work out of setup/render and stop view-owned work on cleanup.

## Complete direct-CJS example

Use the package layout in [workflow](workflow.md). This example displays the owning project and branch using inherited colors and a host SVG symbol. It needs no component imports or compilation.

```js
const { Plugin, Registry, Style } = require('@opencode/plugin/gui')
const { createEffect } = require('solid-js')
const WorkStatus = Registry.define('yuri.work-status')

module.exports = Plugin.define({
  setup(ctx) {
    ctx.add(Style, `
      .workspace-widget {
        display: flex; align-items: center; min-width: 0;
        gap: calc(0.5rem * var(--padding-scale, 1)); padding: 0.375rem 0.5rem;
        font-family: var(--font-sans, system-ui, sans-serif);
        font-size: var(--text-ui-label); color: var(--muted-foreground);
      }
      .workspace-widget span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `)
    ctx.add(WorkStatus, {
      id: 'workspace', order: 10,
      render(props) {
        const row = document.createElement('div')
        row.className = 'workspace-widget'
        const ns = 'http://www.w3.org/2000/svg'
        const icon = document.createElementNS(ns, 'svg')
        icon.setAttribute('viewBox', '0 0 24 24')
        icon.setAttribute('width', '14')
        icon.setAttribute('height', '14')
        icon.setAttribute('aria-hidden', 'true')
        icon.style.cssText = 'flex-shrink:0; --yuri-icon-stroke:2'
        const use = document.createElementNS(ns, 'use')
        use.setAttribute('href', '#yuri-git-branch')
        icon.append(use)
        const label = document.createElement('span')
        row.append(icon, label)
        createEffect(() => {
          const name = props.project?.name || props.directory || ''
          const branch = props.git.branch
          label.textContent = branch ? `${name} · ${branch}` : name
          row.title = props.directory || ''
        })
        return row
      },
    })
  },
})
```

Verify the widget under Changes, live field updates without resetting its local inputs, inline/popup width, session and host switches, and cleanup on hiding/disable/reload. Check that slow work observes the mount signal and that failed widgets leave other entries intact.
