# Custom file formats and previews

A file parser/viewer uses official `LinkHandler` + `Panel` + `PanelTab.file`, optionally `yuri.file-icon`. Yuri matches the tab's normalized complete file path to its existing file preview and mounts your Solid view there, including the mobile file sheet. The plugin owns format parsing and rendering; a custom format can use ordinary DOM/Solid without an iframe or compiler. Upstream `FileViewer` is unsupported in Yuri.

## Complete JSON-format viewer

This working entry recognizes `.report.json`, parses JSON into formatted text, retains its DOM on background updates, and localizes errors. Use the package/build config in [workflow](workflow.md). A real visual report renderer replaces only the parsing/rendering part.

```ts
import { bindPlugin, createKeyed, LinkHandler, Panel, Plugin, usePlugin, type PanelProps, type PanelTab } from '@opencode/plugin/gui'
import { createComponent, onCleanup } from 'solid-js'

const suffix = '.report.json'
function matches(href: string): boolean {
  if (!href || /[\u0000\r\n]/.test(href) || /^[#?]/.test(href)) return false
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return false
  return href.split(/[?#]/, 1)[0].toLowerCase().endsWith(suffix)
}
function linkPath(link: { href: string; base?: string }): string {
  const href = link.href.split(/[?#]/, 1)[0]
  return link.base && !/^(?:[a-z]+:|[\\/])/i.test(href) ? `${link.base}/${href}` : href
}
function Preview(props: PanelProps): HTMLElement {
  const ctx = usePlugin()
  const root = document.createElement('section')
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const content = document.createElement('pre')
  content.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'
  root.append(status, content)
  createKeyed(() => JSON.stringify([props.session.key, props.screen.file.root, props.tab.file]), () => {
    const file = props.screen.file
    const path = props.tab.file
    if (!path) return
    let active = true
    status.textContent = ctx.t('loading')
    content.textContent = ''
    void file.sync(path).catch(() => { if (active) status.textContent = ctx.t('failed') })
    onCleanup(() => { active = false; file.unwatch(path) })
    createKeyed(() => file.get(path), (state) => {
      if (state.error || state.notFound) { status.textContent = ctx.t('failed'); return }
      if (!state.loaded || !state.content) return
      try {
        const report: unknown = JSON.parse(state.content.content)
        content.textContent = JSON.stringify(report, null, 2)
        status.textContent = ''
      } catch { status.textContent = ctx.t('invalid') }
    })
  })
  return root
}
export default Plugin.define({
  i18n: {
    en: { loading: 'Loading report…', failed: 'Could not read report', invalid: 'Invalid report JSON' },
    'zh-CN': { loading: '正在加载报告…', failed: '无法读取报告', invalid: '报告 JSON 格式无效' },
  },
  setup(ctx) {
    const tabs = new Map<string, PanelTab>()
    const View = bindPlugin((props: PanelProps) => createComponent(Preview, props))
    ctx.add(LinkHandler, {
      priority: 10,
      match: (link) => matches(link.href),
      exists: (link) => {
        const file = ctx.screen.current()?.file
        return file ? file.exists(file.resolve(linkPath(link))) : false
      },
      open: (link) => {
        const screen = ctx.screen.current()
        const session = link.session ?? ctx.sessions.current()
        if (screen && session) ctx.layout.open(`${ctx.id}:${screen.file.resolve(linkPath(link))}`, session, { background: link.background })
      },
    })
    ctx.add(Panel, {
      id: 'report', region: 'side', mobile: { title: 'Reports', order: 46, kind: 'menu' },
      list: (input) => {
        const wanted = input.open.filter(matches)
        for (const path of tabs.keys()) if (!wanted.includes(path)) tabs.delete(path)
        return wanted.map((path) => {
          let tab = tabs.get(path)
          if (!tab) { tab = { id: path, title: path.split(/[\\/]/).at(-1) ?? path, file: path, closable: 'compact' }; tabs.set(path, tab) }
          return tab
        })
      },
      render: (props) => createComponent(View, props),
    })
  },
})
```

`Panel.list` returns stable tab objects; `file` is the full canonical workspace-relative or absolute path, not its basename. Read `props.session`, `props.tab`, and `props.screen.file` through live getters. The owner changes on directory/file identity, not on each token or ordinary parent render. `file.sync(path)` reads and acquires a watch; `file.get(path)` is reactive; `file.unwatch(path)` releases it. There is no public `file.watch` method. Source reads are bounded at 128 KiB UTF-8, 64 model entries; a held lease observes changes at a 2-second foreground stat interval, not push-real-time.

Register `yuri.file-icon` as `{ id, extensions: ['report'], svg, lightSvg? }` for a dedicated extension. Matching uses the final extension only: `.report.json` is still `json`, so registering `json` changes **all** JSON file icons. Prefer a distinct suffix such as `.report` when you want a dedicated icon. Directories are never overridden. SVG safety rules are shared with branding; limits are 64 entries/plugin, 512/window, 1–64 extensions/entry, 8 MiB total raw SVG.

## Optional: executable formats

When a format executes source rather than displaying data:

- Treat source as untrusted content. Decide the iframe sandbox, allowed dependencies and network policy deliberately; a same-document plugin is not a security sandbox.
- Keep the outer preview DOM/iframe stable for background changes. Send revisioned updates; don't reset the reading position or recreate the frame on every file poll.
- Validate message source, expected origin (or the explicitly designed opaque-origin protocol), frame ID and source revision. Ignore messages from old attempts/closed panels.
- `iframe.onload`, runtime initialization and content commit are different milestones. Show local loading until the current source actually commits; retain prior interactive content during a background update. A file/read/compile error is not authoritative empty success.
- Close/retry/source-mode transitions remove listeners, cancel stale work and dispose the frame. Two mounted instances of one tab must not share mutable DOM, screenshot targets or controllers.
- If preview actions or exports are requested, use [preview actions and exports](preview-exports.md). The host owns placement; the plugin owns rendering and capture for each mounted instance.

### Case study: Eficy

Source: npm `@eficy/opencode2-plugin`, https://github.com/yee94/opencode-eficy. See `src/gui.tsx`, `src/file-links.ts`, `src/frame.ts`, and `packages/opencode2-plugin/README.md`.

Eficy routes `.eficy` into a Panel and supplies an iframe runtime to compile/render TSX. Its separate server entry registers an agent skill and validation tool. This illustrates an executable format with server-side authoring support; neither the TSX runtime nor the server entry is required for a data-only viewer. Consult the integration's current source for its frame protocol and dependencies.

## Verification

Verify local-path matching, unrelated-link handling, valid/invalid/missing input, background updates preserving the view, and cleanup on close or disable. Exercise two mounted instances and the target mobile layout when applicable. Executable formats also need stale-result and execution-boundary checks.
