# Global pages and tabs

Yuri provides a global **main-content placement**, not a new renderer. `yuri.page` registers Solid content; `yuri.pages` opens the caller's page. The same host mounting, plugin context, options and cleanup are used by pages, file panels and settings. A page can render ordinary Solid/DOM or embed an existing web app in an iframe. It does not need a session or plugin `main`.

## Complete window entry

This typed example shows the page contract. For the default direct-CJS package in [workflow](workflow.md), replace imports/exports with `require`/`module.exports` and omit type annotations; it uses no JSX. Retain TypeScript through the optional build branch only when needed.

```ts
import { Command, Contract, Plugin, Registry, TitlebarItem, usePlugin, type IconName, type TitlebarItem as TitlebarContribution } from '@opencode/plugin/gui'
import { createComponent, type JSX } from 'solid-js'

const Page = Registry.define<{
  id: string; title: string; icon?: IconName; render(): JSX.Element
}>('yuri.page')
const Pages = Contract.define<{
  open(id: string): boolean; current(): string | undefined
}, 'yuri.pages'>('yuri.pages')

function Dashboard(): HTMLElement {
  const ctx = usePlugin()
  const root = document.createElement('section')
  root.className = 'studio-dashboard'
  root.textContent = typeof ctx.options.message === 'string' ? ctx.options.message : ctx.t('welcome')
  return root
}

export default Plugin.define({
  i18n: {
    en: { open: 'Open Studio', welcome: 'Studio dashboard', unavailable: 'Studio is unavailable in this layout' },
    'zh-CN': { open: '打开 Studio', welcome: 'Studio 看板', unavailable: '当前布局不支持 Studio' },
  },
  setup(ctx) {
    const pages = ctx.use(Pages)
    ctx.add(Page, { id: 'dashboard', title: 'Studio', icon: 'window-analytics', render: () => createComponent(Dashboard, {}) })
    const open = () => {
      const live = pages()
      if (!ctx.layout.narrow() && live.status === 'active' && live.value.open('dashboard')) return
      ctx.toast.show({ title: ctx.t('unavailable'), variant: 'error' })
    }
    ctx.add(TitlebarItem, (): TitlebarContribution | undefined => {
      if (ctx.layout.narrow()) return
      const live = pages()
      return {
        id: 'dashboard', label: 'Studio', title: ctx.t('open'), icon: 'window-analytics',
        pressed: live.status === 'active' && live.value.current() === 'dashboard', run: open,
      }
    })
    ctx.add(Command, () => ({ id: 'dashboard', title: ctx.t('open'), enabled: !ctx.layout.narrow(), run: open }))
  },
})
```

The host key is `JSON.stringify([pluginId, pageId])`; pass only your **local** page ID to `pages.open`. The API cannot open another plugin's page or override a host contract. It returns false if navigation is unavailable. Access `ctx.use(Pages)()` live when clicking; it can be inactive while a provider is unavailable.

Global pages and their entry points are for desktop/Web desktop layouts and VS Code. On mobile the pages contract is inactive and the page is not mounted; hide the titlebar item and disable its command when `ctx.layout.narrow()`. Use a file Panel for mobile file previews instead. Registration itself does not navigate.

## Optional: embed an existing application

Use ordinary Solid/DOM for plugin-owned content; an iframe is an option for an existing web application, not a page requirement. For an embedded application:

- Verify browser reachability, CSP, mixed-content and framing policy before choosing this design.
- Use the service's supported authentication flow. A message-based handshake requires a receiver on both sides; validate message source and origin and send credentials only to the exact recipient origin. Keep credentials out of URLs and persisted page snapshots.
- Keep embedded navigation within the page's intended scope. Custom history controls and navigation messages are needed only if the requested interaction calls for them.
- Own frames and listeners within the mounted component; release them with `onCleanup`. Preserve the mounted view across unrelated session/render updates.

### Case study: Runmark

Source: npm `@runmarks/opencode-plugin`, repository package `packages/plugin-opencode`; see `src/gui.ts`, `src/gui-pages.ts`, `src/gui-frame.ts`, `src/gui-navigation.ts`, and its README.

Runmark embeds its existing Dashboard. `DashboardFrame` reads `endpoint` / `apiKey` from `usePlugin().options`; a source/origin-checked `runmark.embed.ready` / `runmark.embed.auth` handshake supplies in-memory `X-API-Key` authentication. Its embedded fetches omit cookies and reject redirects. Its navigation UI uses bounded in-memory history and `runmark.embed.location` / `runmark.embed.navigate` messages.

Those message names, header and navigation rules form Runmark's service protocol, not the `yuri.page` contract. Consult the integration's current source when adapting it.

## Entry icon versus content branding

Choose `TitlebarItem.icon` from the supported catalog names in [plugin entry icons](icons.md), which covers upstream `IconName`, Yuri's compatible names/aliases and fallback behavior. Set it on the entry itself; `yuri.page.icon` does not configure that entry. Top-level `package.json.icon` supplies artwork in Settings plugin details, not the global navigation entry. Application Logo/Dock branding uses `yuri.branding`; see [appearance](appearance.md).

## Verification

Verify opening/current-page state, access to the plugin's options, inactive-layout behavior, and cleanup on close, disable or replacement. For an embedded service, also verify its authentication and navigation boundaries and confirm unrelated session updates retain the view.
