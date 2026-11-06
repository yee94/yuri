# Yuri GUI host reference

The supported contract is OpenCode GUI SDK **2.2.0**. Consult current official docs at https://opencode.ai/v2/docs/build/plugins/gui for SDK syntax, then respect Yuri's narrower implementation below. Never assume an upstream feature is implemented here.

## Window APIs

- `Command`: command palette and plugin management execution; hidden commands can be called by `ctx.commands.run`. No GUI shortcut registration or slash autocomplete yet.
- `TitlebarItem`: global action/status, independent of a session; reactive label/title/icon/busy/pressed. Supported icon names and upstream/Yuri differences: [icons](icons.md).
- `Panel`: Solid `list/render`, reactive session/tab getters; file panels mount in existing file previews. An independent panel uses a dialog/mobile sheet, not upstream's full draggable workspace layout.
- `LinkHandler`: match, exists and open file/custom links. Use `ctx.links.open({ href, base, session })` for navigation. Preserve workspace-relative identity; never resolve against a different session's directory.
- `SettingsPage`: independent plugin settings pages; host `page/section` injection is unsupported.
- `MenuItem`: `session.panel` only.
- `Style`: document CSS, automatic cleanup.
- `Registry` / `Contract`: contribution lists and live APIs. Own provided token IDs under your plugin ID; `yuri.*` is host-reserved for providers. Declare tokens once in a contract module. Use `bindPlugin` for Solid components shared with another plugin.
- `Store.global` / `Store.session`, translation dictionaries, `ctx.options`; no `from` migration or live cross-window store sync yet. Do not publish options/credentials in URLs, DOM or storage snapshots.
- `ctx.sessions.current()`, current screen files and implemented layout operations; missing members explicitly reject.
- `ctx.toast.show`: pure-text title/description, default/success/error/loading, duration/persistent, returned dismiss; no icon/actions.
- `ctx.system.save`: client-owned UTF-8 file save (32 MiB bound); platform cancellation returns false. `ctx.system.copy` / `openExternal` are available.
- Server plugin RPC through the current authenticated `ctx.client`; GUI cannot install remote server tools by itself.

Unsupported registries include upstream `Server`, `ComposerPill`, `Slot`, `FileViewer`, native menu/embeds. Unsupported APIs reject rather than succeeding silently.

Plugin renderers own their Solid/DOM content. Yuri does not implement upstream `ctx.ui` or expose its React components to plugins; follow [CSS variables and styling](plugin-styles.md) and [icons](icons.md) for visual consistency.

## Yuri supplemental registries and contracts

- `yuri.theme`, `yuri.branding`: see [appearance](appearance.md).
- `yuri.file-icon`: `{ id, extensions: string[], svg, lightSvg? }`; static SVG resources for file extensions, not app/Dock icons.
- `yuri.page` / `yuri.pages`: global main-content Solid pages, desktop layouts/VS Code only. Exact types, entry points and optional web-app embedding: [global pages](global-pages.md).
- `yuri.work-status`: inline/popup widgets below Changes in the desktop conversation status column; read-only displayed-session/project/Git context and mount-scoped cancellation. See [work-status widgets](work-status.md).
- Custom suffix parsing, normalized file identities, `PanelTab.file` and mobile sheets: [file previews](file-previews.md).
- `yuri.exportPDF`, `yuri.exportLongImage`, `yuri.previewActions`: separate host contracts for client-owned export/preview actions. Exact types, registration lifetime, capture protocol and runtime matrix: [preview actions and exports](preview-exports.md).

## Lifecycle and platforms

`setup` is synchronous and runs under a Solid owner. Register contributions there; timers/listeners require `onCleanup`, long work must observe `ctx.signal`. Never use module-global mutable state. Async setup is invalid. Keep heavy work out of startup and streaming renders. Read reactive `props.session` / `props.tab` inside reactive calculations, rather than destructuring once.

`main` is optional, app-scoped, and only available on trusted local Electron with an active native lease. It may import Electron and Node built-ins. Window evaluation sees inert placeholders for those imports, not native access. IPC uses official `Ipc.define` schemas; remote/Relay/Web/VS Code/mobile remain window-only. Native storage, serverEndpoints, cli, embeds and menus are unsupported in Yuri's main host.

Consume `ctx.use(token)` as a live accessor: `pending`, `inactive`, or `active`. Check status before using its value. A disabled provider must not break the consumer. Prefer declarative contributions over DOM replacement, private React stores, or direct native APIs.
