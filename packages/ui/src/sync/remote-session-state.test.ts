import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { HostRuntimeRegistry, type HostRuntimeEntry } from '@/lib/remote-projects/registry'
import { locationCachePartition, locationSessionKey, type HostLocation } from '@/lib/remote-projects/location'
import type { OpenCodeClient } from '@/lib/opencode/v2-types'
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch'
import * as yuriEvents from '@/lib/yuriEvents'
import { createMessageQueueServerRuntime } from './message-queue-server-runtime'
import { ensureTranscriptInitial, getTranscriptRepository, transcriptScope } from './transcript-repository-runtime'
import { getSyncMessages, getSyncParts } from './sync-refs'
import { createRemoteSessionState } from './remote-session-state'
import { getRemoteChatOwner } from './remote-chat-context'
import { createMemoryTranscriptDurableStore } from './transcript-durable-store'
import { draftAttachmentRefID, draftKeyString, parseDraftRecord, sessionDraftKey, newSessionDraftKey, surfaceDraftKey } from './input-draft-types'
import { useSelectionStore } from './selection-store'
import { applySessionInboxEvent, cancelUnpromotedInboxItem, capturePromptCommitScope, postSessionPrompt } from './session-prompt-api'
import { selectInboxOverlayChips, useSessionInboxOverlayStore } from './session-inbox-overlay'
import { createRuntimeTranscriptDurableStore, resolveTranscriptDurableRuntimeKind } from './transcript-durable-store-runtime'

const remote = (hostId: string, hubId = 'hub'): HostLocation => ({ hubId, hostId, directory: 'C:\\workspace\\repo' })
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const states: Array<ReturnType<typeof createRemoteSessionState>> = []
const clients: QueryClient[] = []

function fixture(hubId = 'hub') {
  let current = true
  const switchModel = vi.fn(async (_input: unknown) => undefined)
  const switchAgent = vi.fn(async (_input: unknown) => undefined)
  const sdk = {
    session: { get: vi.fn(async () => ({ id: 'same', agent: 'build', model: { id: 'old', providerID: 'p' } })), switchModel, switchAgent,
      interrupt: vi.fn(async () => ({ interrupted: true })),
      form: { list: vi.fn(async () => []), get: vi.fn(async () => ({ fields: [{ key: 'answer', type: 'string' }] })), reply: vi.fn(async () => {}), cancel: vi.fn(async () => {}) } },
    permission: { request: { list: vi.fn(async () => ({ data: [] })) } },
    form: { list: vi.fn(async () => ({ data: [] })) },
  } as unknown as OpenCodeClient
  const fetch = vi.fn(async (path: string, init?: RuntimeFetchOptions) => {
    if (path.endsWith('/message')) return response({ data: [{ id: 'msg_same', type: 'user', text: path, time: { created: 1 } }] })
    if (path.endsWith('/prompt')) {
      const body = JSON.parse(String(init?.body))
      return response({ id: body.id, sessionID: 'same', type: 'user', delivery: body.delivery, payload: { text: body.text } })
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    if (path.endsWith('/subscriptions')) return response({ id: 'lease' })
    return response([])
  })
  const service = { getSessionActive: vi.fn(async () => ({ state: 'supported', membership: {} })),
    applySendSelection: async (sessionID: string, selection: { model?: unknown; agent?: string }) => {
      if (selection.model) await switchModel({ sessionID, model: selection.model })
      if (selection.agent) await switchAgent({ sessionID, agent: selection.agent })
    },
  } as unknown as ReturnType<HostRuntimeEntry['service']>
  const registry = new HostRuntimeRegistry(hubId, { transportIdentity: 'transport', isCurrent: () => current, sdk: () => sdk, service: () => service, fetch })
  for (const id of ['a', 'b']) registry.ingest({ type: 'yuri:host-status', properties: { hubId, hostId: id, host: { id, name: id, source: 'direct', state: 'connected' } } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const durable = createMemoryTranscriptDurableStore()
  const state = (location: HostLocation) => {
    const result = createRemoteSessionState(registry, location, { client, durableStore: durable })
    states.push(result)
    return result
  }
  return { registry, fetch, state, durable, switchModel, switchAgent, sdk, service, retire: () => { current = false } }
}

afterEach(() => {
  for (const state of states.splice(0)) state.dispose()
  for (const client of clients.splice(0)) client.clear()
  useSessionInboxOverlayStore.setState({ bySession: {} })
  vi.restoreAllMocks()
})

describe('explicit remote session state', () => {
  it('shares the production primary/panel state and fences it only after the last owner leaves', async () => {
    const f = fixture()
    const entry = f.registry.resolve(remote('a'))
    const first = getRemoteChatOwner(f.registry, entry), second = getRemoteChatOwner(f.registry, entry)
    expect(first.state).toBe(second.state)
    const releaseFirst = first.retain(), releaseSecond = second.retain()
    releaseFirst()
    await Promise.resolve()
    expect(second.state.entry.sdk()).toBe(f.sdk)
    releaseSecond()
    await Promise.resolve()
    expect(() => second.state.entry.sdk()).toThrow('Inactive remote session state')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('publishes Host-scoped permission/question authority, replies remotely and preserves snapshots on failed refresh', async () => {
    const f = fixture()
    const a = f.state(remote('a')), b = f.state(remote('b'))
    vi.spyOn(f.sdk.permission.request, 'list').mockResolvedValue({ data: [{ id: 'permission', sessionID: 'same', action: 'bash', resources: [], save: [] }] } as never)
    vi.spyOn(f.sdk.form, 'list').mockResolvedValue({ data: [{ id: 'question', sessionID: 'same', title: 'Choose', fields: [{ key: 'answer', type: 'string' }], metadata: { kind: 'question' } }] } as never)
    await a.refreshMetadata('same')
    expect(a.getSnapshot('same').permissions[0]?.id).toBe('permission')
    expect(a.getSnapshot('same').questions[0]?.id).toBe('question')
    expect(b.getSnapshot('same').permissions).toEqual([])
    await a.respondPermission('same', 'permission', 'once')
    expect(f.fetch.mock.calls.at(-1)?.[0]).toBe('/api/hosts/a/api/session/same/permission/permission/reply')
    expect(a.getSnapshot('same').permissions).toEqual([])
    vi.spyOn(f.sdk.form, 'list').mockRejectedValueOnce(new Error('Disconnected'))
    await expect(a.refreshMetadata('same')).rejects.toThrow('Disconnected')
    expect(a.getSnapshot('same').questions[0]?.id).toBe('question')
    await a.respondQuestion('same', 'question', [['Yes']])
    expect(f.sdk.session.form.reply).toHaveBeenCalledWith({ sessionID: 'same', formID: 'question', answer: { answer: 'Yes' } })
    expect(a.getSnapshot('same').questions).toEqual([])
  })

  it('does zero IO until demanded and isolates identical session/path in Query and durable storage', async () => {
    const f = fixture()
    const a = f.state(remote('a')), b = f.state(remote('b'))
    expect(f.fetch).not.toHaveBeenCalled()
    const localRepository = getTranscriptRepository()
    await Promise.all([ensureTranscriptInitial(remote('a'), 'same'), ensureTranscriptInitial(remote('b'), 'same')])
    expect(getTranscriptRepository()).toBe(localRepository)
    expect(transcriptScope(remote('a'), 'same')).toMatchObject({ location: remote('a') })
    expect(getSyncMessages('same', remote('a'))).toHaveLength(1)
    expect(getSyncParts('msg_same', remote('a'), 'same')[0]).toMatchObject({ text: '/api/hosts/a/api/session/same/message' })
    expect(a.repository.getParts(a.scope('same'), 'msg_same')[0]).toMatchObject({ text: '/api/hosts/a/api/session/same/message' })
    expect(b.repository.getParts(b.scope('same'), 'msg_same')[0]).toMatchObject({ text: '/api/hosts/b/api/session/same/message' })
    for (const [, init] of f.fetch.mock.calls) expect(init?.query).toMatchObject({ directory: remote('a').directory })
    await vi.waitFor(async () => {
      for (const host of ['a', 'b']) {
        const rows = await f.durable.readSession({ transport: locationCachePartition(remote(host)), generation: 0, directory: remote(host).directory, sessionID: 'same' })
        expect(rows.records).toHaveLength(1)
      }
    })
    expect(f.fetch.mock.calls.some(([path]) => path.includes('transcript-cache') || path.includes('message-queue'))).toBe(false)
  })

  it('keeps native queued selection authoritative and scopes steer/pending/cancel to its host', async () => {
    const f = fixture()
    const a = f.state(remote('a')), b = f.state(remote('b'))
    const selection = { providerID: 'p', modelID: 'new', agent: 'plan', variant: 'high' }
    await a.send({ sessionID: 'same', messageID: 'input_same', text: 'a', delivery: 'queue', selection })
    expect(f.switchModel).not.toHaveBeenCalled()
    expect(f.switchAgent).not.toHaveBeenCalled()
    await b.send({ sessionID: 'same', messageID: 'input_same', text: 'b', delivery: 'steer', selection })
    expect(f.switchModel).toHaveBeenCalledWith({ sessionID: 'same', model: { providerID: 'p', id: 'new', variant: 'high' } })
    expect(selectInboxOverlayChips('same', remote('a'))[0]?.content).toBe('a')
    expect(selectInboxOverlayChips('same', remote('b'))[0]?.content).toBe('b')
    expect(selectInboxOverlayChips('same')).toEqual([])
    await cancelUnpromotedInboxItem({ sessionID: 'same', inboxID: 'input_same', scope: a.entry })
    expect(selectInboxOverlayChips('same', remote('a'))).toEqual([])
    expect(selectInboxOverlayChips('same', remote('b'))[0]?.content).toBe('b')
  })

  it('rejects stale registry commits, offline sends and cross-entry prompt commits', async () => {
    const f = fixture()
    const a = f.state(remote('a')), b = f.state(remote('b'))
    const commit = capturePromptCommitScope(a.entry.location.directory, a.entry)
    await expect(postSessionPrompt({ sessionID: 'same', messageID: 'i', text: 'x', directory: b.entry.location.directory, scope: b.entry, commit })).rejects.toThrow('scope mismatch')
    f.registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub', hostId: 'a', host: { id: 'a', name: 'a', source: 'direct', state: 'offline' } } })
    await expect(a.send({ sessionID: 'same', messageID: 'i', text: 'x' })).rejects.toThrow('offline')
    expect(f.fetch).not.toHaveBeenCalled()
    f.retire()
    await expect(postSessionPrompt({ sessionID: 'same', messageID: 'i', text: 'x', directory: a.entry.location.directory, scope: a.entry, commit })).rejects.toThrow('runtime switched')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('does not let a delivered receipt on one host cancel the other host pending item', async () => {
    const f = fixture()
    const a = f.state(remote('a')), b = f.state(remote('b'))
    for (const state of [a, b]) await state.send({ sessionID: 'same', messageID: 'receipt_shared', text: 'pending', delivery: 'queue' })
    applySessionInboxEvent({ type: 'session.inbox.delivered', properties: { sessionID: 'same', inboxID: 'receipt_shared' } }, a.entry)
    expect(selectInboxOverlayChips('same', remote('a'))).toHaveLength(0)
    expect(selectInboxOverlayChips('same', remote('b'))).toHaveLength(1)
  })

  it('drops a late prompt response after state disposal without publishing an inbox ghost', async () => {
    const f = fixture()
    const a = f.state(remote('a'))
    let complete!: (response: Response) => void
    f.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve }))
    const flight = postSessionPrompt({ sessionID: 'same', messageID: 'late_input', text: 'late', directory: a.entry.location.directory, scope: a.entry })
    a.dispose()
    complete(response({ id: 'late_input', sessionID: 'same', type: 'user', payload: { text: 'late' } }))
    await expect(flight).rejects.toThrow('Inactive remote session state')
    expect(selectInboxOverlayChips('same', remote('a'))).toEqual([])
  })

  it('shares content/event demand between views and releases it only after the last view leaves', async () => {
    const subscribe = vi.spyOn(yuriEvents, 'subscribeYuriEvents').mockImplementation(() => () => {})
    const f = fixture()
    const a = f.state(remote('a')), b = f.state(remote('b'))
    const onError = vi.fn()
    const first = a.observe('same', onError), second = a.observe('same', onError)
    await vi.waitFor(() => expect(f.fetch.mock.calls.filter(([path, init]) => path.endsWith('/subscriptions') && init?.method === 'POST')).toHaveLength(1))
    await a.repository.ensureInitial(a.scope('same'))
    f.registry.ingest({ type: 'yuri:host-event', properties: { hubId: 'hub', hostId: 'a', directory: remote('a').directory, payload: {
      type: 'message.updated', properties: { info: { id: 'msg_live', sessionID: 'same', role: 'user', time: { created: 2 } } },
    } } })
    expect(a.repository.getMessage(a.scope('same'), 'msg_live')).toBeDefined()
    expect(b.repository.getMessage(b.scope('same'), 'msg_live')).toBeUndefined()
    first()
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0)
    second()
    await vi.waitFor(() => expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1))
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('refuses remote payloads at the Hub queue admission boundary before upload or persistence', async () => {
    const admit = vi.fn(async () => { throw new Error('Must not call Hub') })
    const upload = vi.fn(async () => { throw new Error('Must not upload to Hub') })
    const runtime = createMessageQueueServerRuntime({ admit, upload })
    const item = { queueItemID: 'q', operationID: 'op', messageID: 'msg', content: 'remote private body', attachmentIssues: [], createdAt: 1 }
    const scope = { directory: '/repo', sessionID: 'same', location: remote('a') }
    expect(() => runtime.stageAdmission({ requestID: 'r', scope, item: { ...item, attachmentCount: 0 } })).toThrow('Remote Host native inbox')
    await expect(runtime.admit({ requestID: 'r', scope, item })).rejects.toThrow('Remote Host native inbox')
    expect(admit).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })
})

describe('location persistence compatibility', () => {
  it('keeps old local draft addresses and isolates remote owners across Hub/host/directory', () => {
    const legacy = sessionDraftKey({ transportIdentity: 't' }, 'same')
    expect(draftKeyString(sessionDraftKey({ transportIdentity: 't', location: { hubId: 'hub', directory: '/repo' } }, 'same'))).toBe(draftKeyString(legacy))
    for (const keyFactory of [sessionDraftKey, newSessionDraftKey, surfaceDraftKey]) {
      const addresses = [remote('a'), remote('b'), remote('a', 'other-hub'), { ...remote('a'), directory: '/other' }]
        .map((location) => draftKeyString(keyFactory({ transportIdentity: 't', location }, 'same')))
      expect(new Set(addresses).size).toBe(4)
    }
    const keys = [remote('a'), remote('b')].map((location) => sessionDraftKey({ transportIdentity: 't', location }, 'same'))
    expect(new Set(keys.map((key) => draftAttachmentRefID({ ...key, attachmentOccurrenceRefID: 'same_blob' }))).size).toBe(2)
    for (const key of keys) {
      const record = { version: 1, key, revision: 1, text: 'durable', attachments: [], syntheticParts: [], mentions: [] }
      expect(parseDraftRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
    }
  })

  it('keeps model/agent/variant selection isolated without local fallback', () => {
    const store = useSelectionStore.getState()
    store.saveSessionModelSelection('same', 'p', 'local')
    store.saveSessionModelSelection('same', 'p', 'a', remote('a'))
    store.saveSessionAgentSelection('same', 'plan', remote('a'))
    store.saveAgentModelVariantForSession('same', 'plan', 'p', 'a', 'high', remote('a'))
    expect(store.getSessionModelSelection('same')?.modelId).toBe('local')
    expect(store.getSessionModelSelection('same', remote('a'))?.modelId).toBe('a')
    expect(store.getSessionModelSelection('same', remote('b'))).toBeNull()
    expect(store.getSessionAgentSelection('same', remote('a'))).toBe('plan')
    expect(store.getAgentModelVariantForSession('same', 'plan', 'p', 'a', remote('b'))).toBeUndefined()
    expect(useSelectionStore.getState().sessionModelSelections.has(locationSessionKey(remote('a'), 'same'))).toBe(true)
  })

  it('selects IndexedDB for remote bodies even on an Electron local Hub', async () => {
    const http = vi.fn(() => createMemoryTranscriptDurableStore())
    const idb = vi.fn(() => createMemoryTranscriptDurableStore())
    const deps = { location: remote('a'), isDesktopShell: () => true, isDesktopLocalOriginActive: () => true, createHttpStore: http, createIndexedDBStore: idb }
    expect(resolveTranscriptDurableRuntimeKind(deps)).toBe('indexeddb')
    const store = createRuntimeTranscriptDurableStore(deps)
    await store.readSession({ transport: 't', generation: 0, directory: '/repo', sessionID: 'same' })
    await store.clearGeneration({ transport: 't', generation: 0 })
    expect(http).not.toHaveBeenCalled()
    expect(idb).toHaveBeenCalledTimes(1)
  })
})
