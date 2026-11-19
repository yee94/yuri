import { afterEach, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { Message, Session } from '@/lib/opencode/v2-types'
import type { Event } from './types'
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch'
import { createQueryTranscriptRepository } from './transcript-repository-query-adapter'
import { bindTranscriptRepositoryInstance, unbindTranscriptRepository } from './transcript-repository-runtime'
import { opencodeClient } from '@/lib/opencode/client'
import { ChildStoreManager } from './child-store'
import { handleEvent } from './sync-context'
import { useSessionUIStore } from './session-ui-store'
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore'
import { normalizeOpenCodeEvent, toLegacyEventShape } from './opencode-event-normalizer'

afterEach(() => vi.restoreAllMocks())
it('follows actual moved data and rejects a late first-move GET after the next move', async () => {
  const stores = new ChildStoreManager()
  const routing = { sessionDirectoryById: new Map<string, string>(), messageSessionById: new Map<string, string>(), sessionMessageIdsById: new Map<string, Set<string>>() }
  const id = 'ses_moved_event_race'
  const session = (directory: string) => ({ id, directory, title: 'source', projectID: 'p', time: { created: 1, updated: 1 } }) as Session
  stores.ensureChild('/old', { bootstrap: false }).setState({ session: [session('/old')] })
  useSessionUIStore.setState({ currentSessionId: id, currentSessionDirectory: '/old' })
  let first!: (session: Session) => void
  const fetch = vi.spyOn(opencodeClient, 'getSession')
    .mockImplementationOnce(() => new Promise<Session>((resolve) => { first = resolve }))
    .mockResolvedValueOnce(session('/final'))
  const emit = (target: string, seq: number) => {
    const normalized = normalizeOpenCodeEvent({ type: 'session.moved', created: 100, durable: { aggregateID: id, seq, version: 1 }, location: { directory: '/old' }, data: { sessionID: id, location: { directory: target }, projectID: 'p' } })
    if (normalized.action !== 'emit') throw new Error('missing move')
    handleEvent('/old', toLegacyEventShape(normalized.event) as Event, stores, routing)
  }
  emit('/next', 1)
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/next')
  emit('/final', 2)
  await Promise.resolve()
  first(session('/next'))
  await Promise.resolve()
  emit('/next', 1)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/final')
  expect(routing.sessionDirectoryById.get(id)).toBe('/final')
  expect([...stores.children.values()].flatMap((store) => store.getState().session).filter((row) => row.id === id).map((row) => row.directory)).toEqual(['/final'])
  const global = useGlobalSessionsStore.getState()
  global.upsertSession(session('/old'))
  expect(useGlobalSessionsStore.getState().activeSessions.find((row) => row.id === id)?.directory).toBe('/final')
  stores.disposeAll()
})

it('a stale catalog row after a round-trip move keeps live transcript events in the viewed directory', async () => {
  const stores = new ChildStoreManager()
  const routing = { sessionDirectoryById: new Map<string, string>(), messageSessionById: new Map<string, string>(), sessionMessageIdsById: new Map<string, Set<string>>() }
  const id = 'ses_round_trip_move'
  const home = '/repo/worktree'
  const scratch = '/tmp/scratch'
  const session = (directory: string, updated = 1) => ({ id, directory, title: 'source', projectID: 'p', time: { created: 1, updated } }) as Session
  const client = new QueryClient()
  const repo = createQueryTranscriptRepository({ client, transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() })
  bindTranscriptRepositoryInstance(repo)
  stores.ensureChild(home, { bootstrap: false }).setState({ session: [session(home)] })
  useSessionUIStore.setState({ currentSessionId: id, currentSessionDirectory: home })
  vi.spyOn(opencodeClient, 'getSession').mockImplementation(async (_id, directory) => session(directory as string))
  const move = (from: string, to: string, seq: number) => {
    const normalized = normalizeOpenCodeEvent({ type: 'session.moved', created: 100 + seq, durable: { aggregateID: id, seq, version: 1 }, location: { directory: from }, data: { sessionID: id, location: { directory: to }, projectID: 'p' } })
    if (normalized.action !== 'emit') throw new Error('missing move')
    handleEvent(from, toLegacyEventShape(normalized.event) as Event, stores, routing)
  }
  try {
    move(home, scratch, 1)
    move(scratch, home, 2)
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(home)
    // Activity keeps advancing `time.updated` while a catalog row still names the source.
    useGlobalSessionsStore.getState().upsertSession(session(scratch, 10_000))
    const step = { id: 'msg_after_move', sessionID: id, role: 'assistant', time: { created: 5 } } as Message
    handleEvent(home, { type: 'message.updated', properties: { sessionID: id, info: step } } as unknown as Event, stores, routing)
    expect(repo.getTranscript({ directory: home, sessionID: id }).messageOrder).toEqual([step.id])
    expect(repo.getTranscript({ directory: scratch, sessionID: id }).messageOrder).toEqual([])
    expect(useGlobalSessionsStore.getState().activeSessions.find((row) => row.id === id)?.directory).toBe(home)
  } finally {
    unbindTranscriptRepository()
    repo.destroy()
    client.clear()
    stores.disposeAll()
  }
})
