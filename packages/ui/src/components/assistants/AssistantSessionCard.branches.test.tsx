import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AssistantSessionCard } from './AssistantSessionCard'
import { invalidateGitBranchesQuery } from '@/queries/gitBranchQueries'
import type { GitBranch } from '@/lib/api/types'
import type { AssistantContactSessionCardPart } from '@/queries/assistantDTO'

const runtime = vi.hoisted(() => ({
  transport: 'card-runtime-a', listeners: new Set<() => void>(), getBranches: vi.fn(),
}))
vi.mock('@/lib/runtime-switch', async (original) => ({
  ...await original<typeof import('@/lib/runtime-switch')>(),
  getRuntimeTransportIdentity: () => runtime.transport,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    runtime.listeners.add(listener)
    return () => runtime.listeners.delete(listener)
  },
}))
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => ({ git: { getGitBranches: runtime.getBranches } }) }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/apps/mobileAppContext', () => ({ useMobileAppActions: () => null }))
vi.mock('@/lib/platform', () => ({ isIPadApp: () => false }))
vi.mock('@/stores/useGlobalSessionsStore', () => ({ useGlobalSessionsStore: () => null }))
vi.mock('@/sync/sync-context', () => ({ useGlobalSessionStatus: () => undefined }))
vi.mock('@/router/sessionLookup', () => ({ findSessionById: () => null }))
vi.mock('@/sync/openSessionWithFeedback', () => ({ openSessionWithFeedback: vi.fn() }))
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: vi.fn() } }))

const snapshot = (current: string): GitBranch => ({ current, all: current ? [current] : [], branches: {} })
const card: AssistantContactSessionCardPart = { type: 'card', cardType: 'session', sessionID: 'a', directory: '/repo', title: 'Task', status: 'complete', branch: 'obsolete' }
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let client: QueryClient
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
const render = async (cards: AssistantContactSessionCardPart[]) => {
  await act(async () => root.render(<QueryClientProvider client={client}>{cards.map((item) => <AssistantSessionCard key={item.sessionID} card={item} />)}</QueryClientProvider>))
  await flush()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  runtime.transport = 'card-runtime-a'
  runtime.getBranches.mockReset().mockResolvedValue(snapshot('main'))
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  host.remove()
  vi.unstubAllGlobals()
})

test('40 cards share one cold directory read; 50 unrelated rerenders add no reads', async () => {
  const cards = Array.from({ length: 40 }, (_, index) => ({ ...card, sessionID: `session-${index}` }))
  await render(cards)
  expect(host.querySelectorAll('[data-contact-session-branch]')).toHaveLength(40)
  expect(host.querySelector('[data-contact-session-branch]')?.textContent).toBe('main')
  expect(runtime.getBranches).toHaveBeenCalledTimes(1)
  for (let index = 0; index < 50; index++) await render(cards)
  expect(runtime.getBranches).toHaveBeenCalledTimes(1)

  runtime.getBranches.mockResolvedValue(snapshot('feature/next'))
  await act(async () => { await invalidateGitBranchesQuery('/repo', client) })
  await flush()
  expect(runtime.getBranches).toHaveBeenCalledTimes(2)
  expect([...host.querySelectorAll('[data-contact-session-branch]')].every((node) => node.textContent === 'feature/next')).toBe(true)

  runtime.getBranches.mockRejectedValue(new Error('offline'))
  await act(async () => { await invalidateGitBranchesQuery('/repo', client) })
  await flush()
  expect(host.querySelector('[data-contact-session-branch]')?.textContent).toBe('feature/next')
  expect(client.getQueryState(['card-runtime-a', 'git', 'branches', '/repo'])?.status).toBe('error')

  runtime.getBranches.mockResolvedValue(snapshot(''))
  await act(async () => { await invalidateGitBranchesQuery('/repo', client) })
  await flush()
  expect(host.querySelector('[data-contact-session-branch]')).toBeNull()
  expect(host.textContent).not.toContain('obsolete')
})

test('directory changes use the actual target and do not revive a stored branch on failure', async () => {
  await render([card])
  expect(host.textContent).toContain('main')
  runtime.getBranches.mockRejectedValue(new Error('permission denied'))
  await render([{ ...card, directory: '/other' }])
  expect(runtime.getBranches.mock.calls.at(-1)?.[0]).toBe('/other')
  expect(host.querySelector('[data-contact-session-branch]')).toBeNull()
  expect(host.textContent).not.toMatch(/main|obsolete/)
})

test('runtime switch isolates same-directory results and aborts the old pending read', async () => {
  let completeOld: ((value: GitBranch) => void) | undefined
  let oldSignal: AbortSignal | undefined
  runtime.getBranches.mockImplementationOnce((_directory: string, options: { signal: AbortSignal }) => {
    oldSignal = options.signal
    return new Promise<GitBranch>((resolve) => { completeOld = resolve })
  })
  await render([card])
  runtime.getBranches.mockResolvedValue(snapshot('remote-main'))
  await act(async () => {
    runtime.transport = 'card-runtime-b'
    runtime.listeners.forEach((listener) => listener())
  })
  await flush()
  expect(host.querySelector('[data-contact-session-branch]')?.textContent).toBe('remote-main')
  expect(oldSignal?.aborted).toBe(true)
  await act(async () => completeOld?.(snapshot('wrong-old-host')))
  await flush()
  expect(host.textContent).not.toContain('wrong-old-host')
  expect(runtime.getBranches).toHaveBeenCalledTimes(2)
})
