import React, { act, useMemo, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, type StoreApi } from 'zustand'
import { QueryClient } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import type { Message, Part, Session } from '@/lib/opencode/v2-types'
import type { DirectoryStore } from './child-store'
import type { TranscriptData } from './transcript-repository'
import * as runtime from './transcript-repository-runtime'
import { createQueryTranscriptRepository } from './transcript-repository-query-adapter'
import { messagesFromTranscriptData, useTranscriptMessages, useTranscriptProjection, useTranscriptMaterializationStatus } from './transcript-repository-observers'
import { buildUserMessageHistorySnapshotFromSource, EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT } from './user-message-history'

const directory = '/workspace'
const sessionID = 'ses_main'
const stores = new Map<string, StoreApi<DirectoryStore>>()
const historyProjection = vi.fn(buildUserMessageHistorySnapshotFromSource)
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sync-context.tsx'), 'utf8')
const ast = ts.createSourceFile('sync-context.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const historyHook = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'useUserMessageHistory')!
const scope = {
  React, useMemo, useRef, ...runtime, EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT,
  buildUserMessageHistorySnapshotFromSource: historyProjection, messagesFromTranscriptData,
  useSyncSystem: () => ({ directory }),
  useDirectoryStore: (path: string) => stores.get(path),
}
const compiled = ts.transpileModule(historyHook.getText(ast).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const useUserMessageHistory = new Function(...Object.keys(scope), `${compiled}; return useUserMessageHistory;`)(...Object.values(scope)) as (id: string, dir?: string) => string[]

const host = document.createElement('div')
const root = createRoot(host)
const clients: QueryClient[] = []
const repositories: ReturnType<typeof createQueryTranscriptRepository>[] = []
afterEach(async () => {
  await act(async () => root.render(null))
  runtime.unbindTranscriptRepository()
  for (const repository of repositories.splice(0)) repository.destroy()
  for (const client of clients.splice(0)) client.clear()
  stores.clear()
  vi.restoreAllMocks()
  historyProjection.mockClear()
})

function setup(path = directory, id = sessionID, count = 300) {
  const store = createStore(() => ({ session: [{ id }], status: 'complete' })) as unknown as StoreApi<DirectoryStore>
  stores.set(path, store)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const repository = createQueryTranscriptRepository({ client, transport: 'test', generation: 1 })
  clients.push(client)
  repositories.push(repository)
  const records = Array.from({ length: count }, (_, index) => {
    const messageID = `msg_${String(index).padStart(4, '0')}`
    return {
      info: { id: messageID, sessionID: id, role: index % 2 ? 'assistant' : 'user', time: { created: index + 1 } } as Message,
      parts: [{ id: `part_${index}`, sessionID: id, messageID, type: 'text', text: `text ${index}` } as Part],
    }
  })
  repository.apply({ directory: path, sessionID: id }, { type: 'http-page', purpose: 'initial', page: { records, complete: true, turnCount: count / 2 } })
  runtime.bindTranscriptRepositoryInstance(repository)
  const reads = vi.fn()
  const wrapped = new WeakMap<TranscriptData, TranscriptData>()
  const original = repository.getTranscript.bind(repository)
  vi.spyOn(repository, 'getTranscript').mockImplementation((key) => {
    const data = original(key)
    let observed = wrapped.get(data)
    if (!observed) {
      observed = { ...data, messagesByID: new Proxy(data.messagesByID, { get(target, property: string) { reads(); return target[property] } }) }
      wrapped.set(data, observed)
    }
    return observed
  })
  return { repository, store, reads, records }
}

it('skips all 300-message projections during 50 edits and unrelated store/repository notifications', async () => {
  const { repository, store, reads, records } = setup()
  const cleanup = vi.fn()
  const listeners: (() => void)[] = []
  const original = repository.subscribe.bind(repository)
  const subscribe = vi.spyOn(repository, 'subscribe').mockImplementation((key, listener) => {
    listeners.push(() => listener(key))
    const unsub = original(key, listener)
    return () => { cleanup(); unsub() }
  })
  let history!: string[]
  let messages!: readonly Message[]
  function Probe() {
    history = useUserMessageHistory(sessionID, directory)
    messages = useTranscriptMessages(sessionID, directory, store)
    useTranscriptMaterializationStatus(sessionID, directory, store)
    return null
  }
  await act(async () => root.render(<Probe />))
  const initialHistory = history
  const initialMessages = messages
  const subscriptionCount = subscribe.mock.calls.length
  reads.mockClear()
  historyProjection.mockClear()
  for (let i = 0; i < 50; i++) {
    await act(async () => {
      store.setState({ status: 'complete' })
      for (const notify of listeners) notify()
      root.render(<Probe />)
    })
  }
  expect(reads).not.toHaveBeenCalled()
  expect(historyProjection).not.toHaveBeenCalled()
  expect(subscribe).toHaveBeenCalledTimes(subscriptionCount)
  expect(cleanup).not.toHaveBeenCalled()
  expect(history).toBe(initialHistory)
  expect(messages).toBe(initialMessages)
  for (let i = 0; i < 50; i++) await act(async () => {
    repository.apply({ directory, sessionID }, {
      type: 'sse-event', event: { type: 'message.part.updated', properties: { part: { ...records[299].parts[0], text: `stream ${i}` } } },
    })
  })
  expect(history).toBe(initialHistory)
  expect(messages).toBe(initialMessages)
  await act(async () => {
    repository.apply({ directory, sessionID }, {
      type: 'sse-event', event: { type: 'message.part.updated', properties: { part: { ...records[298].parts[0], text: 'edited user text' } } },
    })
  })
  expect(history[0]).toBe('edited user text')
  await act(async () => store.setState({ session: [{ id: sessionID, revert: { messageID: records[298].info.id } } as Session] }))
  expect(history[0]).toBe('text 296')
  await act(async () => store.setState({ session: [{ id: sessionID } as Session] }))
  expect(history[0]).toBe('edited user text')
  await act(async () => root.render(null))
  expect(cleanup).toHaveBeenCalledTimes(subscriptionCount)
})

it('reads a new scope during render, rebinds subscriptions, and invalidates same-source selector changes', async () => {
  const first = setup()
  let history!: string[]
  let projected!: string
  const selectFirst = vi.fn((data: TranscriptData) => data.messageOrder[0] ?? 'empty')
  const selectLast = vi.fn((data: TranscriptData) => data.messageOrder.at(-1) ?? 'empty')
  function Probe({ id = sessionID, dir = directory, last = false, enabled = true }) {
    history = useUserMessageHistory(id, dir)
    projected = useTranscriptProjection(id, dir, stores.get(dir)!, last ? selectLast : selectFirst, Object.is, { enabled })
    return <span>{history[0]}|{projected}</span>
  }
  await act(async () => root.render(<Probe />))
  expect(projected).toBe('msg_0000')
  await act(async () => root.render(<Probe last />))
  expect(projected).toBe('msg_0299')
  await act(async () => root.render(<Probe last enabled={false} />))
  expect(projected).toBe('empty')
  await act(async () => root.render(<Probe last />))
  expect(projected).toBe('msg_0299')
  await act(async () => { setup('/other', 'ses_other', 2) })
  await act(async () => root.render(<Probe dir="/other" id="ses_other" />))
  expect(host.textContent).toBe('text 0|msg_0000')
  await act(async () => runtime.bindTranscriptRepositoryInstance(first.repository))
  expect(history).toEqual([])
  expect(projected).toBe('empty')
  await act(async () => root.render(<Probe />))
  expect(history[0]).toBe('text 298')
  await act(async () => root.render(<Probe id="" />))
  expect(history).toEqual([])
  expect(projected).toBe('empty')
})

it('observes a successfully resolved empty transcript after unknown state', async () => {
  const { repository, store } = setup()
  let status!: ReturnType<typeof useTranscriptMaterializationStatus>
  function Probe() { status = useTranscriptMaterializationStatus('ses_empty', directory, store); return null }
  await act(async () => root.render(<Probe />))
  expect(status.renderable).toBe(false)
  await act(async () => {
    repository.apply({ directory, sessionID: 'ses_empty' }, { type: 'http-page', purpose: 'initial', page: { records: [], complete: true, turnCount: 0 } })
  })
  expect(status).toEqual({ hasMessages: true, renderable: true, missingPartMessageIDs: [] })
})

it('re-evaluates a retained selection when its equality policy changes', async () => {
  const { repository, store, records } = setup(directory, sessionID, 2)
  const select = (data: TranscriptData) => (data.partsByMessageID[records[0].info.id]?.[0] as { text?: string })?.text
  const retain = () => true
  let value: string | undefined
  function Probe({ strict = false }) {
    value = useTranscriptProjection(sessionID, directory, store, select, strict ? Object.is : retain)
    return null
  }
  await act(async () => root.render(<Probe />))
  await act(async () => {
    repository.apply({ directory, sessionID }, {
      type: 'sse-event', event: { type: 'message.part.updated', properties: { part: { ...records[0].parts[0], text: 'latest' } } },
    })
  })
  expect(value).toBe('text 0')
  await act(async () => root.render(<Probe strict />))
  expect(value).toBe('latest')
})
