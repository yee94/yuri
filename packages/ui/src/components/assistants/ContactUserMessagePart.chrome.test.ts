import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'vite'
import { expect, test } from 'vitest'
import cursorDark from '@/lib/theme/themes/cursor-dark.json'
import carbonfoxLight from '@/lib/theme/themes/carbonfox-light.json'
import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession } from '../ui/chromeCdpHarness'

const here = dirname(fileURLToPath(import.meta.url))
const uiSrc = join(here, '../..')
const require = createRequire(import.meta.url)

test.skip('failed parts stay independently centered, have no hover fill, and open an anchored retry popup', async () => {
  const work = evidenceRoot()
  const entry = join(work, 'entry.tsx')
  const html = join(work, 'index.html')
  const css = await compileProductionCssAsync(uiSrc)
  writeFileSync(entry, `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ContactUserMessagePart } from ${JSON.stringify(join(here, 'ContactUserMessagePart.tsx'))};
    const failed = { assistantID: 'bot', messageID: 'original-message', parts: [], status: 'failed', error: '连接服务超时，请检查网络后重试。', createdAt: 1 };
    function App() {
      const [turn, setTurn] = React.useState(failed);
      const retry = () => { window.retryCalls = (window.retryCalls || 0) + 1; setTurn(undefined); };
      return <main className="mx-auto flex w-full max-w-[42rem] flex-col items-end gap-1.5 px-4 pt-32">
        <ContactUserMessagePart failedTurn={turn} retryDisabled={false} onRetry={retry}><div className="rounded-[1.15rem] bg-[var(--primary-base)] px-4 py-2.5 text-[var(--primary-foreground)]">ui不过关</div></ContactUserMessagePart>
        <ContactUserMessagePart failedTurn={turn} retryDisabled={false} onRetry={retry}><div role="img" aria-label="图像附件" className="flex h-40 w-[200px] items-center justify-center rounded-[1.35rem] bg-[var(--surface-muted)] text-muted-foreground">图像附件</div></ContactUserMessagePart>
        <textarea aria-label="下一条草稿" defaultValue="保留这条新草稿" className="mt-8 w-full bg-[var(--surface-muted)] p-4" />
      </main>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `)
  await build({
    configFile: false, logLevel: 'error', mode: 'production', root: join(uiSrc, '..'), publicDir: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    esbuild: { jsxDev: false },
    resolve: { alias: { '@': uiSrc, 'react': dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) } },
    plugins: [{
      name: 'send-error-i18n-fixture', enforce: 'pre',
      resolveId(source) { return source === '@/lib/i18n' || source === join(uiSrc, 'lib/i18n') ? '\0send-error-i18n' : null },
      load(id) { return id === '\0send-error-i18n' ? `const labels = { 'assistants.contact.sendError.title': '消息未发送', 'assistants.contact.sendError.viewDetails': '发送失败，查看错误详情', 'chat.history.retry': '重试' }; export const useI18n = () => ({ t: key => labels[key] || key });` : null },
    }],
    build: { emptyOutDir: false, minify: true, outDir: work, lib: { entry, formats: ['iife'], name: 'SendErrorFixture', fileName: () => 'fixture.js' } },
  })
  const bundle = readFileSync(join(work, 'fixture.js'), 'utf8')
  writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>window.fixtureError = null; window.addEventListener('error', event => { window.fixtureError = event.message; });</script><script>${bundle}</script></body></html>`)
  const session = await openChromeSession({ width: 1024, height: 844 })
  try {
    for (const width of [320, 390, 1024]) {
      const page = await openPageSession(session, { width, height: 844, standalone: false })
      await page.navigateFile(html)
      const ready = await page.evaluate<{ count: number; error: string | null }>(`new Promise(resolve => {
        let attempts = 0;
        const check = () => { const count = document.querySelectorAll('[data-assistant-contact-send-error]').length;
          if (count || window.fixtureError || attempts++ > 120) resolve({ count, error: window.fixtureError }); else requestAnimationFrame(check);
        }; check();
      })`)
      expect(ready.error).toBeNull()
      expect(ready.count).toBe(2)
      for (const [name, theme] of [['light', carbonfoxLight], ['dark', cursorDark]] as const) {
        await page.evaluate(`(() => {
          const colors = ${JSON.stringify(theme.colors)};
          document.documentElement.className = ${JSON.stringify(`${name === 'dark' ? 'dark ' : ''}${width < 600 ? 'mobile-pointer' : ''}`)};
          for (const [group, values] of Object.entries(colors)) for (const [key, value] of Object.entries(values)) {
            if (typeof value === 'string') document.documentElement.style.setProperty('--' + group + '-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), value);
          }
          document.documentElement.style.setProperty('--background', colors.surface.background);
          document.documentElement.style.setProperty('--foreground', colors.surface.foreground);
        })()`)
        const markers = await page.evaluate<Array<{ x: number; y: number; centered: number; fill: string; dotFill: string; icon: string | null; glyph: string }>>(`(() => [...document.querySelectorAll('[data-assistant-contact-send-error]')].map(el => {
          const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect();
          const icon = el.querySelector('use').getAttribute('href');
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, centered: Math.abs(r.y + r.height / 2 - p.y - p.height / 2), fill: getComputedStyle(el).backgroundColor, dotFill: getComputedStyle(el.querySelector('[data-assistant-contact-error-dot]')).backgroundColor, icon, glyph: document.querySelector(icon).innerHTML };
        }))()`)
        expect(markers).toHaveLength(2)
        for (const [index, marker] of markers.entries()) {
          expect(marker.centered).toBeLessThanOrEqual(0.5)
          expect(marker.fill).toBe('rgba(0, 0, 0, 0)')
          expect(marker.dotFill).toBe('rgba(0, 0, 0, 0)')
          expect(marker.icon).toBe('#yuri-exclamation-fill')
          expect(marker.glyph).toContain('fill="currentColor"')
          expect(marker.glyph).toContain('stroke="none"')
          expect(marker.glyph).not.toMatch(/<circle|<ellipse/)
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: marker.x, y: marker.y })
          expect(await page.evaluate<string>(`getComputedStyle(document.elementFromPoint(${marker.x}, ${marker.y}).closest('button')).backgroundColor`)).toBe('rgba(0, 0, 0, 0)')
          await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' })
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' })
          const focus = await page.evaluate<{ visible: boolean; shadow: string; filter: string; outline: string; opacity: string }>(`(() => {
            const el = document.querySelectorAll('[data-assistant-contact-send-error]')[${index}]; el.focus();
            const style = getComputedStyle(el);
            return { visible: el.matches(':focus-visible'), shadow: style.boxShadow, filter: style.filter, outline: style.outlineStyle, opacity: style.opacity };
          })()`)
          expect(focus.visible).toBe(true)
          expect(focus.shadow).toBe('none')
          expect(focus.filter).toBe('none')
          expect(focus.outline).toBe('none')
          expect(focus.opacity).toBe('0.7')
        }
        if (keepEvidence()) {
          const screenshot = await page.send('Page.captureScreenshot', { format: 'png' })
          writeFileSync(join(work, `${name}-${width}-closed.png`), Buffer.from(String(screenshot.data), 'base64'))
        }
        await page.evaluate(`document.querySelector('[data-assistant-contact-send-error]').click()`)
        const popup = await page.evaluate<{ x: number; y: number; right: number; bottom: number; side: string | null; text: string }>(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
          const el = document.querySelector('[data-assistant-contact-send-error-popup]'), r = el.getBoundingClientRect();
          resolve({ x: r.x, y: r.y, right: r.right, bottom: r.bottom, side: el.dataset.side || el.parentElement.dataset.side, text: el.textContent });
        })))`)
        expect(popup.x).toBeGreaterThanOrEqual(0)
        expect(popup.right).toBeLessThanOrEqual(width)
        expect(popup.y).toBeGreaterThanOrEqual(0)
        expect(popup.bottom).toBeLessThanOrEqual(844)
        expect(popup.text).toContain('连接服务超时')
        expect(popup.text).toContain('重试')
        if (width === 1024) expect(popup.side).toBe('left')
        if (keepEvidence()) {
          const screenshot = await page.send('Page.captureScreenshot', { format: 'png' })
          writeFileSync(join(work, `${name}-${width}.png`), Buffer.from(String(screenshot.data), 'base64'))
        }
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
        await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        expect(await page.evaluate<boolean>(`!document.querySelector('[data-assistant-contact-send-error-popup]')`)).toBe(true)
      }
      await page.evaluate(`document.querySelectorAll('[data-assistant-contact-send-error]')[1].click()`)
      await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      await page.evaluate(`document.querySelector('[data-assistant-contact-send-error-popup] button').click()`)
      expect(await page.evaluate<number>('window.retryCalls')).toBe(1)
      expect(await page.evaluate<string>('document.querySelector("textarea").value')).toBe('保留这条新草稿')
      expect(await page.evaluate<number>('document.querySelectorAll("[data-assistant-contact-send-error]").length')).toBe(0)
    }
  } finally {
    await session.close()
    if (!keepEvidence()) rmSync(work, { recursive: true, force: true })
  }
}, 120_000)
