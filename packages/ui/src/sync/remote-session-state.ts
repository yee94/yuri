import type { QueryClient } from '@tanstack/react-query'
import type { HostLocation } from '@/lib/remote-projects/location'
import { locationCachePartition, locationSessionKey } from '@/lib/remote-projects/location'
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry'
import { getHostRuntimeServices } from '@/lib/remote-projects/runtime'
import { getRuntimeGeneration } from '@/lib/runtime-switch'
import { normalizeDirectoryKey } from '@/lib/pathNormalization'
import { createQueryTranscriptRepository } from './transcript-repository-query-adapter'
import { fetchProductionTranscriptTransportPage } from './transcript-repository-production'
import { normalizeSessionProjectionMessage } from './session-projection-api'
import { createRuntimeTranscriptDurableStore } from './transcript-durable-store-runtime'
import type { TranscriptDurableStore } from './transcript-durable-store'
import type { TranscriptScope } from './transcript-repository'
import { normalizeOpenCodeEvent } from './opencode-event-normalizer'
import type { Event } from './types'
import { applySessionInboxEvent, postSessionPrompt, postSessionInterrupt, type PostSessionPromptInput } from './session-prompt-api'
import { refreshSessionInbox } from './session-inbox-query'
import { readSessionModelId, readSessionModelProviderId, readSessionModelVariant, normalizeSelectionVariant, toOfficialModelRef, type DesiredSendSelection } from './session-send-selection'
import { useSelectionStore } from './selection-store'
import { bindLocationTranscriptRepository } from './transcript-repository-runtime'
import { handoffDeliveredInbox } from './session-inbox-transcript'
import { queryClient } from '@/lib/queryRuntime'
import type { Session, SessionStatus } from '@/lib/opencode/v2-types'
import type { PermissionRequest } from '@/types/permission'
import type { QuestionRequest } from '@/types/question'
import { projectSession, mapV2PermissionRequest, mapV2QuestionRequest, isQuestionFormMetadata, answersToFormAnswer } from './v2-runtime'
import { postSessionPermissionReply } from './session-permission-api'
import { parseSessionFormInfo, type SessionFormInfo, type SessionFormAnswer } from './session-form-api'
import { remoteSessionActiveQueryOptions, remoteSessionStatus } from './remote-session-active'

export type RemoteChatSnapshot = {
  session?: Session
  status?: SessionStatus
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  forms: SessionFormInfo[]
}

/** One explicit remote Location; never binds or redirects the local SyncProvider. */
export function createRemoteSessionState(
  registry: HostRuntimeRegistry,
  location: HostLocation,
  options: { client?: QueryClient; durableStore?: TranscriptDurableStore } = {},
) {
  if (!location.hostId) throw new Error('Remote session state requires a Remote Host')
  const resolved = registry.resolve(location)
  const transport = JSON.stringify(resolved.queryScope)
  const generation = getRuntimeGeneration()
  let disposed = false
  const assertCurrent = () => {
    if (disposed || getRuntimeGeneration() !== generation) throw new Error('Inactive remote session state')
    registry.assertCurrent()
  }
  const entry: HostRuntimeEntry = {
    ...resolved,
    sdk: () => { assertCurrent(); return resolved.sdk() },
    service: () => { assertCurrent(); return resolved.service() },
    fetch: async (path, init) => {
      assertCurrent()
      const response = await resolved.fetch(path, init)
      assertCurrent()
      return response
    },
  }
  const currentTransport = () => {
    try { assertCurrent(); resolved.sdk(); return transport } catch { return `${transport}:inactive` }
  }
  const scope = (sessionID: string): TranscriptScope => ({
    transport, generation, directory: entry.location.directory, sessionID, location: entry.location,
  })
  const repository = createQueryTranscriptRepository({
    client: options.client,
    transport,
    generation,
    probe: { getTransport: currentTransport, getGeneration: getRuntimeGeneration },
    // Remote bodies may only enter the client's IndexedDB, even on a local Electron Hub.
    durableStore: options.durableStore ?? createRuntimeTranscriptDurableStore({ location: entry.location }),
    durablePartition: () => locationCachePartition(entry.location),
    inboxSessionKey: ({ sessionID }) => locationSessionKey(entry.location, sessionID),
    fetcher: (args) => {
      assertCurrent()
      return fetchProductionTranscriptTransportPage({ ...args, directory: entry.location.directory, scope: entry })
    },
    fetchMessage: async ({ sessionID, messageID }) => {
      assertCurrent()
      const raw = await entry.sdk().session.message({ sessionID, messageID })
      assertCurrent()
      const record = normalizeSessionProjectionMessage(sessionID, raw)
      if (!record) throw new Error('Remote message response is empty')
      return record
    },
  })
  const observers = new Set<() => void>()
  const unbind = bindLocationTranscriptRepository(entry.location, repository, scope)
  type ViewOwner = { onError: (error: unknown) => void; onRecovered?: () => void }
  const viewed = new Map<string, { owners: Set<ViewOwner>; release: () => void }>()
  const sends = new Map<string, Promise<unknown>>()
  const sessionKey = (sessionID: string) => locationSessionKey(entry.location, sessionID)
  const snapshots = new Map<string, RemoteChatSnapshot>()
  const snapshotListeners = new Set<() => void>()
  const emptySnapshot: RemoteChatSnapshot = { permissions: [], questions: [], forms: [] }
  let metadataRevision = 0
  const publish = (sessionID: string, patch: Partial<RemoteChatSnapshot>) => {
    assertCurrent()
    snapshots.set(sessionID, { ...(snapshots.get(sessionID) ?? emptySnapshot), ...patch })
    for (const notify of snapshotListeners) notify()
  }
  const refreshMetadata = async (sessionID: string) => {
    assertCurrent()
    const revision = metadataRevision
    const client = options.client ?? queryClient
    const belongs = async (owner: string): Promise<boolean> => {
      const visited = new Set<string>()
      for (let depth = 0; owner && depth < 64; depth++) {
        if (owner === sessionID) return true
        if (visited.has(owner)) return false
        visited.add(owner)
        const id = owner
        const identity = await client.ensureQueryData({ queryKey: [...entry.queryScope, 'chat-owner', id],
          queryFn: () => entry.sdk().session.get({ sessionID: id }), staleTime: 30_000 })
        assertCurrent()
        owner = identity.parentID ?? ''
      }
      return false
    }
    const read = async <T>(resource: string, queryFn: () => Promise<T>, apply: (value: T) => void) => {
      const value = await client.fetchQuery({ queryKey: [...entry.queryScope, 'chat', sessionID, resource], queryFn, staleTime: 0 })
      assertCurrent()
      if (revision === metadataRevision) apply(value)
    }
    const outcomes = await Promise.allSettled([
      read('session', () => entry.sdk().session.get({ sessionID }), (session) => publish(sessionID, { session: projectSession(session) })),
      read('status', async () => {
        const active = await client.fetchQuery(remoteSessionActiveQueryOptions(entry))
        return remoteSessionStatus(active[sessionID]?.type === 'running', snapshots.get(sessionID)?.status)
      }, (status) => publish(sessionID, { status })),
      read('permissions', async () => {
        const result = await entry.sdk().permission.request.list({ location: { directory: entry.location.directory } })
        const matches: typeof result.data = []
        for (const request of result.data) if (await belongs(request.sessionID)) matches.push(request)
        return matches
      }, (result) => publish(sessionID, { permissions: result.map(mapV2PermissionRequest) })),
      read('forms', async () => {
        const result = await entry.sdk().form.list({ location: { directory: entry.location.directory } })
        const matches: typeof result.data = []
        for (const form of result.data) if (await belongs(form.sessionID)) matches.push(form)
        return matches
      }, (result) => publish(sessionID, { questions: result.filter((form) => isQuestionFormMetadata(form.metadata)).map(mapV2QuestionRequest),
          forms: result.filter((form) => !isQuestionFormMetadata(form.metadata)).map(parseSessionFormInfo) })),
    ])
    const failed = outcomes.find((outcome) => outcome.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  return {
    entry,
    repository,
    scope,
    sessionKey,
    getSnapshot(sessionID: string) { return snapshots.get(sessionID) ?? emptySnapshot },
    subscribeSnapshot(notify: () => void) { snapshotListeners.add(notify); return () => { snapshotListeners.delete(notify) } },
    refreshMetadata,
    async respondForm(sessionID: string, formID: string, answer: SessionFormAnswer | null) {
      if (answer === null) await entry.sdk().session.form.cancel({ sessionID, formID })
      else await entry.sdk().session.form.reply({ sessionID, formID, answer })
      assertCurrent()
      metadataRevision++
      for (const [id, snapshot] of snapshots) {
        if (snapshot.forms.some((form) => form.sessionID === sessionID && form.id === formID)) {
          publish(id, { forms: snapshot.forms.filter((form) => form.sessionID !== sessionID || form.id !== formID) })
        }
      }
    },
    async respondPermission(sessionID: string, requestID: string, reply: 'once' | 'always' | 'reject') {
      await postSessionPermissionReply({ scope: entry, sessionID, requestID, reply })
      metadataRevision++
      for (const [id, snapshot] of snapshots) {
        if (!snapshot.permissions.some((request) => request.sessionID === sessionID)) continue
        publish(id, { permissions: snapshot.permissions.filter((request) => request.sessionID !== sessionID || (reply !== 'reject' && request.id !== requestID)) })
      }
    },
    async respondQuestion(sessionID: string, formID: string, answers: string[][]) {
      const form = await entry.sdk().session.form.get({ sessionID, formID })
      assertCurrent()
      await entry.sdk().session.form.reply({ sessionID, formID, answer: answersToFormAnswer(answers, form.fields) })
      assertCurrent()
      metadataRevision++
      for (const [id, snapshot] of snapshots) {
        if (snapshot.questions.some((request) => request.sessionID === sessionID && request.id === formID)) {
          publish(id, { questions: snapshot.questions.filter((request) => request.sessionID !== sessionID || request.id !== formID) })
        }
      }
    },
    async dismissQuestion(sessionID: string, formID: string) {
      const result = await entry.sdk().session.interrupt({ sessionID, resume: false })
      assertCurrent()
      if (!result.interrupted) await entry.sdk().session.form.cancel({ sessionID, formID })
      assertCurrent()
      metadataRevision++
      for (const [id, snapshot] of snapshots) {
        if (snapshot.questions.some((request) => request.sessionID === sessionID && request.id === formID)) {
          publish(id, { questions: snapshot.questions.filter((request) => request.sessionID !== sessionID || request.id !== formID) })
        }
      }
    },
    selectModel(sessionID: string, providerID: string, modelID: string) {
      assertCurrent()
      useSelectionStore.getState().saveSessionModelSelection(sessionID, providerID, modelID, entry.location)
    },
    selectAgent(sessionID: string, agent: string) {
      assertCurrent()
      useSelectionStore.getState().saveSessionAgentSelection(sessionID, agent, entry.location)
    },
    /** Visible pane owns demand; no timer/socket or network work until observed. */
    observe(sessionID: string, onError: (error: unknown) => void, onRecovered?: () => void): () => void {
      assertCurrent()
      const owner = { onError, onRecovered }
      const previous = viewed.get(sessionID)
      if (previous) {
        previous.owners.add(owner)
        return () => { if (previous.owners.delete(owner) && !previous.owners.size) previous.release() }
      }
      const owners = new Set<ViewOwner>([owner])
      const services = getHostRuntimeServices(registry)
      const releaseServices = services.retain()
      let released = false
      const reportError = (error: unknown) => {
        if (released || disposed || currentTransport() !== transport) return
        for (const consumer of owners) consumer.onError(error)
      }
      const refresh = async () => {
        assertCurrent()
        await repository.refreshFromAuthority(scope(sessionID))
        assertCurrent()
        await refreshSessionInbox({ sessionID, directory: entry.location.directory, scope: entry })
        await refreshMetadata(sessionID)
        if (!released && !disposed && currentTransport() === transport) for (const consumer of owners) consumer.onRecovered?.()
      }
      const unsubscribe = registry.subscribeEvents(entry.location.hostId!, (envelope) => {
        if (released || disposed || currentTransport() !== transport) return
        const normalized = normalizeOpenCodeEvent(envelope.payload)
        if (normalized.action !== 'emit') return
        const event = normalized.event
        const directory = event.locationDirectory ?? envelope.directory
        if (directory && normalizeDirectoryKey(directory) !== normalizeDirectoryKey(entry.location.directory)) return
        const props = event.properties
        const info = props.info as { sessionID?: string } | undefined
        const part = props.part as { sessionID?: string } | undefined
        const request = props.request as { sessionID?: string } | undefined
        const form = props.form as { sessionID?: string } | undefined
        if ((props.sessionID ?? info?.sessionID ?? part?.sessionID ?? request?.sessionID ?? form?.sessionID) !== sessionID) {
          // Pending descendant requests belong in the visible parent's cards as well.
          if (event.type.startsWith('permission.') || event.type.startsWith('question.') || event.type.startsWith('form.')) {
            metadataRevision++
            void refreshMetadata(sessionID).catch(reportError)
          }
          return
        }
        handoffDeliveredInbox(entry.location, event as Event, entry)
        applySessionInboxEvent(event, entry)
        const scopedEvent = { ...event, clientLocation: entry.location } as Event & { clientLocation: HostLocation }
        repository.apply(scope(sessionID), { type: 'sse-event', event: scopedEvent })
        if (event.type === 'session.status' && props.status) {
          metadataRevision++
          publish(sessionID, { status: props.status as SessionStatus })
        }
        if (event.type === 'session.execution.started' || event.type === 'session.busy') {
          metadataRevision++
          publish(sessionID, { status: { type: 'busy' } })
        }
        const executionTerminal = event.type === 'session.execution.succeeded' || event.type === 'session.execution.failed'
          || event.type === 'session.execution.interrupted' || event.type === 'session.idle'
        if (executionTerminal) {
          metadataRevision++
          publish(sessionID, { status: props.reason === 'shutdown' ? { type: 'busy' } : { type: 'idle' } })
        }
        if (event.type.startsWith('permission.') || event.type.startsWith('question.') || event.type.startsWith('form.') || event.type === 'session.updated') {
          metadataRevision++
          void refreshMetadata(sessionID).catch(reportError)
        }
        if (executionTerminal || event.domainActivityHint?.kind === 'terminal' || event.type === 'session.inbox.delivered' || event.type === 'session.retry.scheduled') {
          void refresh().catch(reportError)
        }
      })
      const releaseDemand = services.demand.retain(entry.location, sessionID, { refresh, error: reportError })
      const release = () => {
        if (released) return
        released = true
        releaseDemand()
        unsubscribe()
        releaseServices()
        observers.delete(release)
        viewed.delete(sessionID)
      }
      observers.add(release)
      viewed.set(sessionID, { owners, release })
      // Seed from disk immediately; subscription acquisition independently revalidates authority.
      void repository.ensureInitial(scope(sessionID)).catch(reportError)
      void refreshMetadata(sessionID).catch(reportError)
      return () => { if (owners.delete(owner) && !owners.size) release() }
    },
    /** Native queue inherits authoritative selection at consumption, never at enqueue. */
    send(input: Omit<PostSessionPromptInput, 'scope' | 'directory'> & { selection?: DesiredSendSelection }) {
      assertCurrent()
      const captured = { ...input, selection: input.selection ? { ...input.selection } : undefined }
      const previous = sends.get(input.sessionID) ?? Promise.resolve()
      const flight = previous.catch(() => undefined).then(async () => {
        assertCurrent()
        const host = registry.getHost(entry.location.hostId!)
        if (host?.state !== 'connected') throw new Error(`Remote Host is ${host?.state ?? 'unavailable'}`)
        const optimistic = captured.delivery !== 'queue' ? normalizeSessionProjectionMessage(captured.sessionID, {
          id: captured.messageID, type: 'user', text: captured.text, time: { created: Date.now() },
          model: captured.selection ? toOfficialModelRef(captured.selection) : undefined,
          agent: captured.selection?.agent,
          files: captured.files?.map((file) => ({ name: file.name, source: { type: 'uri', uri: file.uri } })),
        }) : null
        if (optimistic) repository.apply(scope(captured.sessionID), { type: 'optimistic-add', message: optimistic.info,
          parts: optimistic.parts.map((part) => ({ ...part, __yuriOptimistic: true })) })
        try {
        const sdk = entry.sdk()
        if (captured.delivery !== 'queue' && captured.selection) {
          const session = await sdk.session.get({ sessionID: captured.sessionID })
          assertCurrent()
          const desired = captured.selection
          const modelChanged = readSessionModelId(session) !== desired.modelID || readSessionModelProviderId(session) !== desired.providerID
            || readSessionModelVariant(session) !== normalizeSelectionVariant(desired.variant)
          const agentChanged = desired.agent && session.agent !== desired.agent
          if (modelChanged || agentChanged) {
            await entry.service().applySendSelection(captured.sessionID, {
              ...(modelChanged ? { model: toOfficialModelRef(desired) } : {}),
              ...(agentChanged ? { agent: desired.agent } : {}),
            }, entry.location.directory)
            assertCurrent()
          }
        }
        return await postSessionPrompt({ ...captured, scope: entry, directory: entry.location.directory })
        } catch (error) {
          if (optimistic) repository.apply(scope(captured.sessionID), { type: 'optimistic-remove', messageID: optimistic.info.id })
          throw error
        }
      })
      sends.set(input.sessionID, flight)
      const cleanup = () => { if (sends.get(input.sessionID) === flight) sends.delete(input.sessionID) }
      void flight.then(cleanup, cleanup)
      return flight
    },
    interrupt(sessionID: string, signal?: AbortSignal) {
      assertCurrent()
      return postSessionInterrupt({ sessionID, scope: entry, signal })
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const release of Array.from(observers)) release()
      unbind()
      repository.destroy()
    },
  }
}
