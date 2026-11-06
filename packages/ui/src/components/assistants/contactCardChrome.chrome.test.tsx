import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession } from '../ui/chromeCdpHarness'
import { AssistantAssistantCard } from './AssistantAssistantCard'
import { AssistantScheduleCard } from './AssistantScheduleCard'
import { AssistantSessionCard } from './AssistantSessionCard'
import { CONTACT_CARD_COVER_CLASS, CONTACT_SESSION_CARD_COVER_CLASS, CONTACT_CARD_FOOTER_CLASS } from './contactCardChrome'
import { iconSpriteData } from '../icon/sprite'
import cursorDark from '@/lib/theme/themes/cursor-dark.json'
import carbonfoxLight from '@/lib/theme/themes/carbonfox-light.json'
import { createRequire } from 'node:module'
import { IOS_DESIGN_PT_SCALE } from '@/lib/designPtScale'

// Render the production card markup with deterministic runtime data. Chrome owns layout.
vi.mock('@/lib/i18n', async () => {
  const { dict } = await import('@/lib/i18n/messages/zh-CN')
  return { useI18n: () => ({ t: (key: keyof typeof dict, params?: Record<string, string | number>) => Object.entries(params ?? {}).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), dict[key] ?? key) }) }
})
vi.mock('@/apps/mobileAppContext', () => ({ useMobileAppActions: () => null }))
vi.mock('@/lib/platform', () => ({ isIPadApp: () => false }))
vi.mock('@/stores/useGlobalSessionsStore', () => ({ useGlobalSessionsStore: (selector: (store: unknown) => unknown) => selector({ activeSessions: [
  { id: 'layout-test', model: { providerID: 'openai', id: 'gpt-6.1-sol' }, summary: { additions: 128, deletions: 36, files: 4 } },
  { id: 'no-diff', model: { providerID: 'openai', id: 'gpt-6.1-sol' } },
  { id: 'design-session', model: { providerID: 'openai', id: 'gpt-6.1-sol' } },
], archivedSessions: [] }) }))
vi.mock('@/queries/gitBranchQueries', () => ({ useGitBranchesQuery: (directory: string) => ({ data: { current: directory === '/p' ? '' : 'main' } }) }))
vi.mock('@/sync/sync-context', () => ({ useGlobalSessionStatus: () => undefined }))
vi.mock('@/router/sessionLookup', () => ({ findSessionById: vi.fn() }))
vi.mock('@/sync/openSessionWithFeedback', () => ({ openSessionWithFeedback: vi.fn() }))
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: vi.fn() } }))
vi.mock('@/stores/useAssistantUIStore', () => ({ openAssistant: vi.fn() }))
vi.mock('@/mobile/useMobileNavigationStore', () => ({ useMobileNavigationStore: { getState: vi.fn() } }))

const here = dirname(fileURLToPath(import.meta.url))
const longTitle = '移动端助手会话宽度修复_' + 'unbroken-session-title-'.repeat(12)
const metadata = 'project-model-branch-'.repeat(12)

function cards(short = false, missing = false, kind: 'daily' | 'weekly' | 'once' | 'cron' = 'daily') {
  const title = short ? 'Hi' : longTitle
  return [
    ...['busy', 'complete', 'complete-no-diff', 'question', 'retry', 'error', 'cancelled'].map((status) => <AssistantSessionCard key={status} card={{ type: 'card', cardType: 'session', sessionID: missing ? 'missing' : status === 'complete-no-diff' ? 'no-diff' : 'layout-test', directory: short ? '/p' : `/projects/${metadata}`, title: missing ? null : title, status: status === 'complete-no-diff' ? 'complete' : status, branch: short ? null : metadata }} />),
    <AssistantAssistantCard key="assistant" card={{ type: 'card', cardType: 'assistant', assistantID: 'layout-test', name: title, providerID: short ? 'p' : metadata, modelID: short ? 'm' : metadata, mode: 'continuous' }} />,
    <AssistantScheduleCard key="schedule" card={{ type: 'card', cardType: 'schedule', taskID: 'layout-test', projectID: 'p', name: title,
      kind: missing ? null : kind, time: missing || kind === 'cron' ? null : '09:00', timezone: missing ? null : 'Asia/Shanghai', prompt: missing ? null : metadata,
      cron: kind === 'cron' ? '0 9 1 * *' : null, date: kind === 'once' ? '2026-12-01' : null,
      times: !missing && (kind === 'daily' || kind === 'weekly') ? (short ? ['09:00'] : ['08:00', '09:00', '12:00', '18:00', '22:00']) : null,
      weekdays: kind === 'weekly' ? [0, 1, 2, 3, 4, 5, 6] : null }} />,
  ].map((card, index) => (
    // Mirror the transcript's padding, avatar rail, and shrinkable message column.
    <div key={index} className="flex w-full justify-start" data-short={short}>
      <div className="mr-2.5 flex w-9 shrink-0 justify-center pt-0.5" />
      <div className="flex min-w-0 flex-col gap-1.5 max-w-[min(84%,34rem)] items-start">{card}</div>
    </div>
  ))
}

type Measurement = {
  kind: string; short: boolean; width: number; height: number; parentWidth: number; right: number; parentRight: number
  scrollWidth: number; clientWidth: number; titleWidth: number; titleScrollWidth: number
  whiteSpace: string; textOverflow: string; titleOverflow: string; fullTitle: boolean; titleHeight: number; lineHeight: number; titleFont: number; statusWidth: number; statusScrollWidth: number; statusRight: number
  footerBottom: number; bottom: number; titleBottom: number; footerTop: number; bodyBottom: number
  borderWidth: number; shadow: string; radius: string; background: string; messageRadius: string; messageBackground: string; dividerWidth: number
  detailRows: Array<{ top: number; bottom: number; height: number; iconLeft: number; textLeft: number }>
  schedule: null | { alignment: string; gap: number; bottom: number; footerBottom: number; cadenceLeft: number; timeLeft: number; cadenceRight: number; icons: number }
}

const sprite = `<svg style="display:none">${Object.entries(iconSpriteData).map(([name, content]) => `<symbol id="yuri-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="var(--yuri-icon-stroke, 1.5)" stroke-linecap="round" stroke-linejoin="round">${content}</symbol>`).join('')}</svg>`

describe('contact card width', () => {
  test('keeps card footers inside the padded frame at native mobile density', async () => {
    const compiled = await compileProductionCssAsync(join(here, '../..'))
    const require = createRequire(import.meta.url)
    const postcss = createRequire(require.resolve('@tailwindcss/postcss'))('postcss')
    const designPtCss = require('../../../../../scripts/postcss-dpt-font-size.mjs').default
    const css = (await postcss([designPtCss()]).process(compiled, { from: undefined })).css
    const root = evidenceRoot()
    const htmlPath = join(root, 'contact-cards-density.html')
    const examples = cards(true)
    const markup = renderToStaticMarkup(<main className="p-4"><div className="flex flex-col gap-4">{[examples[8], examples[7], examples[1]]}</div></main>)
    writeFileSync(htmlPath, `<!doctype html><html class="mobile-pointer"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${sprite}${markup}</body></html>`)
    const session = await openChromeSession({ width: 390, height: 844 })
    try {
      const page = await openPageSession(session, { width: 390, height: 844, standalone: false })
      await page.navigateFile(htmlPath)
      for (const width of [320, 390, 430]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true })
        for (const [themeName, theme] of [['light', carbonfoxLight], ['dark', cursorDark]] as const) {
          await page.evaluate(`(() => {
            document.documentElement.className = 'mobile-pointer ${themeName}';
            const colors = ${JSON.stringify(theme.colors)};
            for (const [group, values] of Object.entries(colors)) for (const [key, value] of Object.entries(values)) {
              if (typeof value === 'string') document.documentElement.style.setProperty('--' + group + '-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), value);
            }
            document.documentElement.style.setProperty('--background', colors.surface.background);
            document.documentElement.style.setProperty('--foreground', colors.surface.foreground);
          })()`)
          for (const scale of [1, IOS_DESIGN_PT_SCALE, 0.9, 1.2]) {
            const measurements = await page.evaluate<Array<{ kind: string; clearance: number; padding: number; height: number }>>(`(() => {
              document.documentElement.style.setProperty('--dpt', '${scale}px');
              document.documentElement.style.setProperty('--dpt-n', '${scale}');
              return [...document.querySelectorAll('[data-assistant-contact-card]')].map(card => {
                const rect = card.getBoundingClientRect(), style = getComputedStyle(card);
                return { kind: card.dataset.assistantContactCard, height: rect.height,
                  clearance: rect.bottom - card.lastElementChild.getBoundingClientRect().bottom,
                  padding: parseFloat(style.paddingBottom) };
              });
            })()`)
            writeFileSync(join(root, `${themeName}-${width}-density-${scale}.json`), JSON.stringify(measurements, null, 2))
            if (keepEvidence()) await page.screenshotPng(join(root, `${themeName}-${width}-density-${scale}.png`))
            for (const row of measurements) {
              expect(row.clearance, `${row.kind} / scale=${scale}: footer clears bottom padding`).toBeGreaterThanOrEqual(row.padding - 1)
            }
            expect(new Set(measurements.map(row => row.height)).size).toBe(1)
            for (const row of measurements) expect(row.height).toBeCloseTo(148 * scale, 1)
          }
        }
      }
    } finally {
      await session.close()
      if (!keepEvidence()) rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test.skip('keeps the contact typing row above the mobile composer fade', async () => {
    const source = readFileSync(join(here, 'AssistantConversationSurface.tsx'), 'utf8')
    const mobilePadding = source.match(/isMobile && '(pb-\d+)'/)?.[1] ?? ''
    const contentClass = source.match(/ref=\{contentRef\} className="([^"]+)" data-assistant-contact-content/)![1]
    const slotClass = source.match(/className="([^"]+)" data-assistant-contact-status-slot/)![1]
    const css = await compileProductionCssAsync(join(here, '../..'))
    const root = evidenceRoot()
    const htmlPath = join(root, 'contact-typing-clearance.html')
    writeFileSync(htmlPath, `<!doctype html><html class="mobile-pointer"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>
      <main class="flex h-screen flex-col"><div id="scroll" class="min-h-0 flex-1 overflow-y-auto ${mobilePadding}">
      <div class="${contentClass}"><div style="height:1200px;flex-shrink:0">Conversation</div><div id="typing" class="${slotClass}">● ● ●</div></div></div>
      <footer class="relative z-10 shrink-0 bg-background pt-1"><form id="composer" class="relative yuri-mobile-composer pt-1.5 pb-4"><div class="h-12">Input</div></form></footer></main></body></html>`)
    const session = await openChromeSession({ width: 390, height: 844 })
    try {
      const page = await openPageSession(session, { width: 390, height: 844, standalone: false })
      await page.navigateFile(htmlPath)
      const measure = (removePadding: boolean) => page.evaluate<number>(`(() => {
        const scroll = document.getElementById('scroll');
        scroll.style.paddingBottom = ${removePadding ? "'0px'" : "''"};
        scroll.scrollTop = scroll.scrollHeight;
        const composer = document.getElementById('composer');
        const fadeTop = composer.getBoundingClientRect().top - parseFloat(getComputedStyle(composer, '::after').height);
        return fadeTop - document.getElementById('typing').getBoundingClientRect().bottom;
      })()`)
      for (const height of [844, 500]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height, deviceScaleFactor: 1, mobile: true })
        for (let run = 0; run < 3; run++) {
          expect(await measure(true), 'old spacing puts typing inside the fade').toBeLessThan(0)
          expect(await measure(false), 'typing clears the entire fade').toBeGreaterThanOrEqual(0)
        }
      }
    } finally {
      await session.close()
      if (!keepEvidence()) rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test('shares fixed height and parent-bounded width across all three types', () => {
    expect(CONTACT_CARD_COVER_CLASS).toContain('h-[calc(148px*var(--padding-scale,1))] w-[19rem] min-w-0 max-w-full')
    expect(CONTACT_SESSION_CARD_COVER_CLASS).toBe(CONTACT_CARD_COVER_CLASS)
    expect(CONTACT_CARD_COVER_CLASS).not.toMatch(/overflow-(hidden|clip)/)
    expect(CONTACT_CARD_COVER_CLASS).toContain('rounded-[1.35rem] bg-[var(--surface-muted)]')
    expect(CONTACT_CARD_COVER_CLASS).not.toMatch(/ring-1|ring-inset|ring-border|border-/)
    expect(CONTACT_CARD_FOOTER_CLASS).not.toContain('border')
    const surface = readFileSync(join(here, 'AssistantConversationSurface.tsx'), 'utf8')
    expect(surface).toContain('flex min-w-0 flex-col gap-1.5')
    expect(surface).toContain('max-w-[min(84%,34rem)] items-start')
    expect(surface).toContain('mr-2.5 flex w-9 shrink-0 justify-center pt-0.5')
  })

  test.skip('measures production cards and CSS at phone widths with enlarged text', async () => {
    const css = await compileProductionCssAsync(join(here, '../..'))
    const root = evidenceRoot()
    const htmlPath = join(root, 'contact-card-width.html')
    const markup = renderToStaticMarkup(<main className="px-4"><p data-reference-message="" className="rounded-[1.35rem] bg-[var(--surface-muted)] px-4 py-2.5 typography-markdown leading-6">普通助手消息</p><div className="mx-auto flex w-full max-w-[42rem] flex-col">{cards()}{cards(true)}{cards(true, true)}{cards(false, false, 'cron')}{cards(false, false, 'once')}{cards(false, false, 'weekly')}</div></main>)
    writeFileSync(htmlPath, `<!doctype html><html class="mobile-pointer"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${sprite}${markup}</body></html>`)
    const session = await openChromeSession({ width: 390, height: 844 })
    try {
      const page = await openPageSession(session, { width: 390, height: 844, standalone: false })
      await page.navigateFile(htmlPath)
      await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true })
      const oldOverflow = await page.evaluate<number>(`(() => {
        const cards = [...document.querySelectorAll('[data-assistant-contact-card]')];
        cards.forEach(el => {
          el.style.maxWidth = el.dataset.assistantContactCard === 'session' ? '20rem' : '15rem';
          el.style.minWidth = 'auto';
        });
        const overflow = Math.max(...cards.map(el => el.getBoundingClientRect().right - el.parentElement.getBoundingClientRect().right));
        cards.forEach(el => { el.style.removeProperty('max-width'); el.style.removeProperty('min-width'); });
        return overflow;
      })()`)
      expect(oldOverflow, 'the previous fixed-rem cap reproduces right-side overflow at 320px').toBeGreaterThan(1)
      const evidence: { width: number; textScale: number; cards: Measurement[] }[] = []
      for (const width of [320, 375, 390, 430]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true })
        for (const scale of [1, 1.5, 2]) {
          // Text-only enlargement exercises the fixed viewport with 100/150/200% text.
          // It deliberately leaves spacing/rem geometry unchanged.
          const measurements = await page.evaluate<Measurement[]>(`(() => {
             document.querySelectorAll('h3').forEach(el => el.style.setProperty('font-size', '${14 * scale}px', 'important'));
             document.querySelectorAll('p, [data-assistant-session-status]').forEach(el => el.style.setProperty('font-size', '${12 * scale}px', 'important'));
            return [...document.querySelectorAll('[data-assistant-contact-card]')].map(el => {
              const rect = el.getBoundingClientRect();
              const parent = el.parentElement.getBoundingClientRect();
              const title = el.querySelector('h3');
                const status = el.querySelector('[data-assistant-session-status]');
                const footer = el.lastElementChild.getBoundingClientRect();
                 const style = getComputedStyle(el);
                 const schedule = el.querySelector('[data-contact-schedule-time]');
                 const cadence = el.querySelector('[data-contact-schedule-cadence]');
                 const time = schedule?.querySelector('p');
                 const detailRows = [...el.querySelectorAll('[data-contact-session-project] > p:first-child, [data-contact-session-changes], [data-contact-card-model]')].map(row => {
                   const bounds = row.getBoundingClientRect();
                   return { top: bounds.top - rect.top, bottom: bounds.bottom - rect.top, height: bounds.height,
                     iconLeft: row.querySelector('svg')?.getBoundingClientRect().left ?? 0, textLeft: row.querySelector('span')?.getBoundingClientRect().left ?? 0 };
                 });
                const reference = getComputedStyle(document.querySelector('[data-reference-message]'));
               return { kind: el.dataset.assistantContactCard, short: el.parentElement.parentElement.dataset.short === 'true',
                 width: rect.width, height: rect.height, parentWidth: parent.width, right: rect.right, parentRight: parent.right,
                scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
                titleWidth: title.clientWidth, titleScrollWidth: title.scrollWidth,
                whiteSpace: getComputedStyle(title).whiteSpace, textOverflow: getComputedStyle(title).textOverflow, titleOverflow: getComputedStyle(title).overflowX, fullTitle: title.title === title.textContent,
                titleHeight: title.clientHeight, lineHeight: parseFloat(getComputedStyle(title).lineHeight), titleFont: parseFloat(getComputedStyle(title).fontSize),
                statusWidth: status?.clientWidth ?? 0, statusScrollWidth: status?.scrollWidth ?? 0,
                 statusRight: status?.getBoundingClientRect().right ?? 0,
                  footerBottom: footer.bottom, footerTop: footer.top, bottom: rect.bottom, titleBottom: title.getBoundingClientRect().bottom,
                  bodyBottom: Math.max(...[...el.children].slice(1, -1).map(child => child.getBoundingClientRect().bottom)),
                  borderWidth: parseFloat(style.borderWidth), shadow: style.boxShadow, radius: style.borderRadius, background: style.backgroundColor,
                   messageRadius: reference.borderRadius, messageBackground: reference.backgroundColor, dividerWidth: parseFloat(getComputedStyle(el.lastElementChild).borderTopWidth), detailRows,
                   schedule: schedule ? { alignment: getComputedStyle(schedule).alignItems, gap: parseFloat(getComputedStyle(schedule).gap), bottom: schedule.getBoundingClientRect().bottom,
                     footerBottom: footer.bottom, cadenceLeft: cadence?.getBoundingClientRect().left ?? 0, timeLeft: time.getBoundingClientRect().left,
                     cadenceRight: cadence?.getBoundingClientRect().right ?? 0, icons: schedule.querySelectorAll('svg').length } : null };
            });
          })()`)
            expect(measurements).toHaveLength(54)
          for (const m of measurements) {
            const label = `${width}px / ${scale * 100}% / ${m.kind} / short=${m.short}`
             expect(m.width, label).toBeLessThanOrEqual(Math.min(m.parentWidth, 19 * 16) + 1)
              expect(m.height, label).toBe(148)
              expect(m.borderWidth, label).toBe(0)
              expect(m.shadow, label).toBe('none')
              expect(m.dividerWidth, label).toBe(0)
              expect(m.radius, label).toBe(m.messageRadius)
              expect(m.background, label).toBe(m.messageBackground)
            expect(m.right, label).toBeLessThanOrEqual(m.parentRight + 1)
            expect(m.right, label).toBeLessThanOrEqual(width - 16 + 1)
            expect(m.scrollWidth, label).toBeLessThanOrEqual(m.clientWidth + 1)
            expect(m.titleFont, label).toBe(14 * scale)
            expect(m.whiteSpace, label).toBe('nowrap')
            expect(m.textOverflow, label).toBe('ellipsis')
            expect(m.titleOverflow, label).toBe('hidden')
            expect(m.fullTitle, label).toBe(true)
            expect(m.titleHeight, label).toBeLessThanOrEqual(m.lineHeight + 1)
            expect(m.titleWidth, label).toBeGreaterThan(0)
             if (!m.short) expect(m.titleScrollWidth, label).toBeGreaterThan(m.titleWidth)
             expect(m.titleBottom, label).toBeLessThanOrEqual(m.footerTop + 1)
              expect(m.bodyBottom, label).toBeLessThanOrEqual(m.footerTop + 1)
              expect(m.footerBottom, label).toBeLessThanOrEqual(m.bottom - 10 + 1)
             if (m.kind === 'session') {
               expect(m.detailRows.every(row => row.height === 16), label).toBe(true)
               if (m.detailRows.length > 1) {
                 expect(m.detailRows.at(-1)!.top, label).toBe(118)
                 expect(new Set(m.detailRows.map(row => row.iconLeft)).size, label).toBe(1)
                 expect(new Set(m.detailRows.map(row => row.textLeft)).size, label).toBe(1)
               }
               if (m.detailRows.length === 3) {
                 expect(m.detailRows[1].top - m.detailRows[0].bottom, label).toBe(6)
                 expect(m.detailRows[2].top - m.detailRows[1].bottom, label).toBe(6)
               }
              expect(m.statusWidth, label).toBeGreaterThan(0)
              expect(m.statusScrollWidth, label).toBeLessThanOrEqual(m.statusWidth + 1)
              expect(m.statusRight, label).toBeLessThanOrEqual(m.right - 14 + 1)
             }
             if (m.schedule) {
               expect(m.schedule.alignment, label).toBe('baseline')
               expect(m.schedule.gap, label).toBe(6)
               expect(m.schedule.bottom, label).toBe(m.schedule.footerBottom)
               expect(m.schedule.icons, label).toBe(0)
               if (m.schedule.cadenceRight) expect(m.schedule.timeLeft - m.schedule.cadenceRight, label).toBeCloseTo(6)
             }
          }
          if (width === 430 && scale === 1) {
             expect(measurements[17].width).toBe(measurements[8].width)
          }
          evidence.push({ width, textScale: scale, cards: measurements })
        }
      }
       writeFileSync(join(root, 'contact-card-width-measurements.json'), JSON.stringify({ oldOverflow, evidence }, null, 2))
       const example = renderToStaticMarkup(<main className="grid gap-6 p-6 md:grid-cols-3">
          <AssistantAssistantCard active={false} card={{ type: 'card', cardType: 'assistant', assistantID: 'lead', name: 'Yuri 项目负责人', providerID: 'magpie-group', modelID: 'auto-deepseek-flash', mode: 'continuous' }} assistant={{ avatarSeed: 'yuri-avatar:v1:leaf:capsule:jade:neutral:0:design-lead', working: false, activeContactTurn: null }} />
         <AssistantSessionCard card={{ type: 'card', cardType: 'session', sessionID: 'design-session', directory: '/workspace/yuri', title: '重新设计助手消息卡片', status: 'question', branch: 'ui/assistant-cards' }} />
          <AssistantScheduleCard card={{ type: 'card', cardType: 'schedule', taskID: 'monthly', projectID: 'yuri', name: '月度笔记回顾', kind: 'cron', cron: '0 9 1 * *', time: null, timezone: 'UTC', prompt: '回顾本月笔记，整理需要跟进的事项。' }} />
          <p className="rounded-[1.35rem] bg-[var(--surface-muted)] px-4 py-2.5 typography-markdown leading-6 md:col-span-3">已为你建好项目负责人，之后可以直接把项目相关的事情交给它。</p>
        </main>)
       for (const [name, theme] of [['dark', cursorDark], ['light', carbonfoxLight]] as const) {
         const variables = Object.entries(theme.colors).flatMap(([group, values]) => Object.entries(values).filter(([, value]) => typeof value === 'string').map(([key, value]) => `--${group}-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}:${value}`)).join(';')
         const file = join(root, `contact-cards-${name}.html`)
         writeFileSync(file, `<!doctype html><html class="${name}" style="${variables};--background:${theme.colors.surface.background};--foreground:${theme.colors.surface.foreground};--muted-foreground:${theme.colors.surface.mutedForeground};--border:${theme.colors.interactive.border}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${sprite}${example}</body></html>`)
         await page.send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 330, deviceScaleFactor: 1, mobile: false })
          await page.navigateFile(file)
          await page.screenshotPng(join(root, `contact-cards-${name}.png`))
          await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
          await page.evaluate(`document.documentElement.classList.add('mobile-pointer')`)
           expect(await page.evaluate<number[]>(`[...document.querySelectorAll('[data-assistant-contact-card]')].map(card => card.getBoundingClientRect().height)`)).toEqual([148, 148, 148])
          await page.screenshotPng(join(root, `contact-cards-${name}-mobile.png`))
       }
    } finally {
      await session.close()
      if (!keepEvidence()) rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
