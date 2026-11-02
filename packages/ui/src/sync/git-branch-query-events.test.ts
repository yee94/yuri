import { afterEach, expect, test, vi } from 'vitest'
import { QueryObserver } from '@tanstack/react-query'
import { queryClient } from '@/lib/queryRuntime'
import { gitBranchesQueryOptions } from '@/queries/gitBranchQueries'
import { handleEvent } from './sync-context'
import type { ChildStoreManager } from './child-store'

vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: {
  getState: () => ({ currentDirectory: null, setDirectory: vi.fn() }),
  subscribe: () => () => {},
} }))

afterEach(() => queryClient.clear())

test('VCS updates revalidate only the observed directory without bootstrapping a Location', async () => {
  const git = { getGitBranches: vi.fn().mockResolvedValue({ all: ['main'], current: 'main', branches: {} }) }
  const options = gitBranchesQueryOptions('/repo', git)
  await queryClient.fetchQuery(options)
  const otherOptions = gitBranchesQueryOptions('/other', git)
  await queryClient.fetchQuery(otherOptions)
  const observer = new QueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})
  const ensureChild = vi.fn()
  const childStores = { getChild: () => undefined, children: new Map(), ensureChild } as unknown as ChildStoreManager
  const routing = { sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map() } as Parameters<typeof handleEvent>[3]
  try {
    git.getGitBranches.mockResolvedValue({ all: ['next'], current: 'next', branches: {} })
    handleEvent('/repo', { type: 'vcs.branch.updated', properties: { branch: 'next' } }, childStores, routing)
    await vi.waitFor(() => expect(queryClient.getQueryData(options.queryKey)).toMatchObject({ current: 'next' }))
    expect(git.getGitBranches).toHaveBeenCalledTimes(3)
    expect(queryClient.getQueryData(otherOptions.queryKey)).toMatchObject({ current: 'main' })
    expect(ensureChild).not.toHaveBeenCalled()

    handleEvent('/other', { type: 'vcs.branch.updated', properties: {} }, childStores, routing)
    expect(queryClient.getQueryState(otherOptions.queryKey)?.isInvalidated).toBe(true)
    expect(git.getGitBranches).toHaveBeenCalledTimes(3)
  } finally {
    unsubscribe()
  }
})
