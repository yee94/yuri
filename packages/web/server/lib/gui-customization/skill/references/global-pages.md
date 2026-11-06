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
       if (live.status === 'active' && live.value.open('dashboard')) return
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
     ctx.add(Command, () => ({ id: 'dashboard', title: ctx.t('open'), enabled: pages().status === 'active', run: open }))
  },
})
```

The host key is `JSON.stringify([pluginId, pageId])`; pass only your **local** page ID to `pages.open`. The API cannot open another plugin's page or override a host contract. It returns false if navigation is unavailable. Access `ctx.use(Pages)()` live when clicking; it can be inactive while a provider is unavailable.

Desktop/Web desktop layouts and VS Code use the main-content placement. New
Capacitor shells show registered pages as icon cards under Projects → Apps and
mount them in a mobile sheet. Keep the page registration on narrow layouts even
when hiding its desktop titlebar item. Registration itself does not navigate.
Use the live pages contract to determine availability rather than treating every
narrow layout as unsupported. Hosted mobile global pages remain unsupported.

Native mobile requires shell API 4, iOS 17+ or Android WebView proxy support, a
saved Relay pairing and an updated Host. A gateway is prepared at mobile startup
and switched to Relay before plugin code/setup; rendering stays local. Current
iOS 26.5 Simulator acceptance still fails for loopback IP literals, including with
a fresh data store. The supported native bridge therefore does not establish that
every HTTP(S)/WS(S) request follows Relay. Website CSP, CORS, framing policy and
authentication still apply. This does not cover WebRTC/UDP, native networking or
external-browser handoff, and is not a sandbox for arbitrary plugin code. Cleanup
must still release plugin timers, frames and subscriptions with their owner.

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

The top-level plugin `package.json` `icon` supplies Yuri's plugin-entry artwork when available (validated image/data resource; monochrome SVG can follow `currentColor` through the host mask). `TitlebarItem.icon` is a name from the official icon catalog. Neither replaces the application's Logo; use `yuri.branding` for that. Keep existing official product artwork instead of inventing a substitute.

## Verification

Verify opening/current-page state, access to the plugin's options, inactive-layout behavior, and cleanup on close, disable or replacement. For an embedded service, also verify its authentication and navigation boundaries and confirm unrelated session updates retain the view.
