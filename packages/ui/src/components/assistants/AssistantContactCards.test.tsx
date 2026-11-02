import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AssistantAssistantCard } from './AssistantAssistantCard'
import { AssistantSessionCard } from './AssistantSessionCard'
import { AssistantScheduleCard } from './AssistantScheduleCard'
import type { AssistantContactScheduleCardPart, AssistantContactSessionCardPart } from '@/queries/assistantDTO'

const state = vi.hoisted(() => ({
  liveSession: null as null | { title: string; directory: string; branch: string; model: { providerID: string; id: string }; summary: { additions: number; deletions: number; files: number } },
  status: undefined as undefined | { type: string },
  phone: false,
  branches: undefined as undefined | { current: string },
  branchQuery: vi.fn(),
  openAssistant: vi.fn(), openMobileAssistant: vi.fn(), openSession: vi.fn(), openTask: vi.fn(), setMainTab: vi.fn(),
}))
vi.mock('@/lib/i18n', async () => {
  const { dict } = await import('@/lib/i18n/messages/en')
  return { useI18n: () => ({ t: (key: keyof typeof dict, params?: Record<string, string | number>) => Object.entries(params ?? {}).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), dict[key] ?? key) }) }
})
vi.mock('@/apps/mobileAppContext', () => ({ useMobileAppActions: () => state.phone ? {} : null }))
vi.mock('@/lib/platform', () => ({ isIPadApp: () => false }))
vi.mock('@/stores/useGlobalSessionsStore', () => ({ useGlobalSessionsStore: () => state.liveSession }))
vi.mock('@/sync/sync-context', () => ({ useGlobalSessionStatus: () => state.status }))
vi.mock('@/queries/gitBranchQueries', () => ({ useGitBranchesQuery: (directory: string) => { state.branchQuery(directory); return { data: state.branches } } }))
vi.mock('@/router/sessionLookup', () => ({ findSessionById: () => state.liveSession }))
vi.mock('@/sync/openSessionWithFeedback', () => ({ openSessionWithFeedback: state.openSession }))
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ setActiveMainTab: state.setMainTab }) } }))
vi.mock('@/stores/useAssistantUIStore', () => ({ openAssistant: state.openAssistant }))
vi.mock('@/mobile/useMobileNavigationStore', () => ({ useMobileNavigationStore: { getState: () => ({ openAssistant: state.openMobileAssistant }) } }))
vi.mock('@/lib/scheduledTaskNavigation', () => ({ openScheduledTask: state.openTask }))

const sessionCard: AssistantContactSessionCardPart = { type: 'card', cardType: 'session', sessionID: 'session-a', directory: '/workspace/project', title: 'Saved title', status: 'busy', branch: 'saved-branch' }
const scheduleCard: AssistantContactScheduleCardPart = { type: 'card', cardType: 'schedule', taskID: 'task-a', projectID: 'project-a', name: 'Daily review', kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai', prompt: 'Review unfinished work.' }

beforeEach(() => {
  state.liveSession = null
  state.status = undefined
  state.phone = false
  state.branches = undefined
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

describe('typed contact card presentation', () => {
  test('shows a cron schedule rule instead of treating its absent clock time as missing', () => {
    const card = { ...scheduleCard, kind: 'cron', time: null, cron: '0 9 1 * *' }
    const markup = renderToStaticMarkup(<AssistantScheduleCard card={card} />)
    expect(markup).toContain('0 9 1 * *')
    expect(markup).not.toContain('Time unavailable')
  })

  test('recovers a legacy cron card from its exact task without inventing a clock time', () => {
    const card = { ...scheduleCard, kind: 'cron', time: null }
    const task = { schedule: { kind: 'cron', cron: '0 9 1 * *', timezone: 'UTC' } }
    const markup = renderToStaticMarkup(<AssistantScheduleCard card={card} task={task} />)
    expect(markup).toContain('0 9 1 * *')
    expect(markup).not.toContain('UTC')
    expect(markup).not.toContain('Time unavailable')
    const missing = renderToStaticMarkup(<AssistantScheduleCard card={card} task={null} />)
    expect(missing).toContain('Cron')
    expect(missing).not.toMatch(/Time unavailable|09:00/)
  })

  test.each([
    [{ kind: 'once', date: '2026-12-01', time: '09:00' }, '2026-12-01 09:00'],
    [{ kind: 'daily', times: ['18:00', '09:00', '09:00'] }, '09:00, 18:00'],
    [{ kind: 'weekly', times: ['09:00'], weekdays: [1, 3, 5] }, 'Mon, Wed, Fri'],
  ])('shows all scheduling information: %j', (schedule, expected) => {
    const markup = renderToStaticMarkup(<AssistantScheduleCard card={{ ...scheduleCard, ...schedule }} />)
    expect(markup).toContain(expected)
  })

  test.each(['continuous', 'stateless'] as const)('omits conversation-mode copy for %s assistants', (mode) => {
    const markup = renderToStaticMarkup(<AssistantAssistantCard active={false} card={{ type: 'card', cardType: 'assistant', assistantID: 'lead', name: 'Project lead', providerID: 'provider', modelID: 'model', mode }} />)
    expect(markup).not.toMatch(/Continuous|Stateless|assistants\.mode/)
    expect(markup).toContain('Project lead')
    expect(markup).toContain('provider')
    expect(markup).toContain('model')
    expect(markup).toContain('provider/model')
    expect(markup).toContain('data-contact-card-model')
    expect(markup).toContain('yuri-brain')
  })

  test('groups schedule frequency and time without timezone, extra icons or invented state', () => {
    const markup = renderToStaticMarkup(<AssistantScheduleCard card={scheduleCard} />)
    expect(markup).toContain('09:00')
    expect(markup).not.toContain('Asia/Shanghai')
    expect(markup).toContain('Daily')
    expect(markup).toContain('Review unfinished work.')
    expect(markup).toContain('data-contact-schedule-time')
    expect(markup.indexOf('>Daily</span>')).toBeLessThan(markup.indexOf('>09:00</p>'))
    expect(markup.match(/<svg /g)).toHaveLength(2)
    expect(markup).not.toMatch(/nextRun|aria-checked|role="switch"/)
    const missing = renderToStaticMarkup(<AssistantScheduleCard card={{ ...scheduleCard, kind: null, time: null, timezone: null, prompt: null }} />)
    expect(missing).toContain('Time unavailable')
    expect(missing).not.toContain('09:00')
    expect(missing).not.toContain('Asia/Shanghai')
  })

  test('uses authoritative session details and preserves zero-summary suppression', () => {
    state.liveSession = { title: 'Live title', directory: '/workspace/live-project', branch: 'live-branch', model: { providerID: 'provider', id: 'live-model' }, summary: { additions: 12, deletions: 3, files: 2 } }
    state.status = { type: 'busy' }
    state.branches = { current: 'main' }
    const markup = renderToStaticMarkup(<AssistantSessionCard card={{ ...sessionCard, status: 'complete' }} />)
    expect(markup).toContain('Live title')
    expect(markup).toContain('live-project')
    expect(markup).toContain('main')
    expect(markup).not.toContain('live-branch')
    expect(state.branchQuery).toHaveBeenCalledWith('/workspace/live-project')
    expect(markup).toContain('provider/live-model')
    expect(markup).not.toMatch(/\+12|−3|2 files|data-contact-session-changes/)
    state.status = { type: 'idle' }
    const completed = renderToStaticMarkup(<AssistantSessionCard card={{ ...sessionCard, status: 'complete' }} />)
    expect(completed).toContain('+12')
    expect(completed).toContain('−3')
    expect(completed).toContain('2 files')
    expect(markup).toContain('Working')
    expect(markup).toContain('yuri-chat-thread')
    expect(markup).not.toContain('Saved title')
    state.liveSession.summary = { additions: 0, deletions: 0, files: 0 }
    expect(renderToStaticMarkup(<AssistantSessionCard card={sessionCard} />)).not.toMatch(/\+0|−0|0 files/)
    state.liveSession = null
    const missing = renderToStaticMarkup(<AssistantSessionCard card={{ ...sessionCard, title: null }} />)
    expect(missing).toContain('Untitled session')
    expect(missing).not.toContain('live-model')
  })

  test.each(['busy', 'complete', 'question', 'retry', 'error', 'cancelled'])('only completed sessions show real diff: %s', (status) => {
    state.liveSession = { title: 'Live', directory: '/repo', branch: '', model: { providerID: 'p', id: 'm' }, summary: { additions: 12, deletions: 3, files: 2 } }
    const markup = renderToStaticMarkup(<AssistantSessionCard card={{ ...sessionCard, status }} />)
    expect(markup.includes('data-contact-session-changes')).toBe(status === 'complete')
    expect(markup).toContain('data-contact-session-bottom')
    expect(markup).toContain('p/m')
  })

  test('directory branch authority overrides stale card data, including successful no-branch and unknown reads', () => {
    for (const current of ['main', 'feature/updated']) {
      state.branches = { current }
      const markup = renderToStaticMarkup(<AssistantSessionCard card={sessionCard} />)
      expect(markup).toContain(`title="${current}"`)
      expect(markup).not.toContain('saved-branch')
    }
    for (const data of [{ current: '' }, undefined]) {
      state.branches = data
      const markup = renderToStaticMarkup(<AssistantSessionCard card={sessionCard} />)
      expect(markup).not.toMatch(/data-contact-session-branch|saved-branch/)
    }
  })

  test.each([
    ['cancelled', 'busy', 'Cancelled'], ['complete', 'busy', 'Working'], ['busy', 'idle', 'Complete'],
    ['error', 'idle', 'Failed'], ['question', 'idle', 'Needs you'], ['busy', 'retry', 'Retrying'],
  ])('retains status authority: saved %s / live %s', (saved, live, label) => {
    state.status = { type: live }
    expect(renderToStaticMarkup(<AssistantSessionCard card={{ ...sessionCard, status: saved }} />)).toContain(label)
  })

  test.each([false, true])('whole-card click and keyboard navigation retain phone=%s routing', async (phone) => {
    state.phone = phone
    state.liveSession = { title: 'Live title', directory: '/workspace/current', branch: 'branch', model: { providerID: 'p', id: 'm' }, summary: { additions: 0, deletions: 0, files: 0 } }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<>
        <AssistantAssistantCard active={false} card={{ type: 'card', cardType: 'assistant', assistantID: 'assistant-a', name: 'Project lead', providerID: 'p', modelID: 'm', mode: 'stateless' }} />
        <AssistantSessionCard card={sessionCard} />
        <AssistantScheduleCard card={scheduleCard} />
      </>))
      for (const card of host.querySelectorAll<HTMLElement>('[data-assistant-contact-card]')) {
        expect(card.tabIndex).toBe(0)
        await act(async () => {
          card.click()
          card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
          card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
          card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
      }
      expect(phone ? state.openMobileAssistant : state.openAssistant).toHaveBeenCalledTimes(3)
      expect(phone ? state.openAssistant : state.openMobileAssistant).not.toHaveBeenCalled()
      expect(state.openSession).toHaveBeenCalledTimes(3)
      expect(state.openSession).toHaveBeenCalledWith('session-a', '/workspace/current', { phoneShell: phone, switchToChat: true })
      expect(state.setMainTab).toHaveBeenCalledTimes(phone ? 0 : 3)
      expect(state.openTask).toHaveBeenCalledTimes(3)
      expect(state.openTask).toHaveBeenCalledWith('project-a', 'task-a')
      expect(host.textContent).not.toMatch(/Continuous|Stateless/)
    } finally {
      await act(async () => root.unmount())
    }
  })
})
