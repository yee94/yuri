import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'
import type { Part } from '@/lib/opencode/v2-types'
import { createRemoteSessionState } from './remote-session-state'
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry'

/** Explicit remote chat owner; never redirects the primary SyncProvider. */
export const RemoteChatContext = createContext<ReturnType<typeof createRemoteSessionState> | null>(null)
export const useRemoteChat = () => useContext(RemoteChatContext)

type ChatOwner = { state: ReturnType<typeof createRemoteSessionState>; retain(): () => void }
const owners = new WeakMap<HostRuntimeRegistry, WeakMap<HostRuntimeEntry, ChatOwner>>()

/** Primary and context-panel views of one Location share repository and event leases. */
export function getRemoteChatOwner(registry: HostRuntimeRegistry, entry: HostRuntimeEntry): ChatOwner {
  let entries = owners.get(registry)
  if (!entries) owners.set(registry, entries = new WeakMap())
  const previous = entries.get(entry)
  if (previous) return previous
  const state = createRemoteSessionState(registry, entry.location)
  let consumers = 0
  const owner: ChatOwner = { state, retain() {
    consumers++
    let released = false
    return () => {
      if (released) return
      released = true
      consumers--
      // StrictMode effect replay can retain again in this commit.
      queueMicrotask(() => {
        if (consumers || entries!.get(entry) !== owner) return
        entries!.delete(entry)
        state.dispose()
      })
    }
  } }
  entries.set(entry, owner)
  return owner
}

const EMPTY_PARTS: Part[] = []
export function useRemoteMessageParts(remote: ReturnType<typeof useRemoteChat>, sessionID: string, messageID: string) {
  const subscribe = useMemo(() => (notify: () => void) => remote && sessionID && messageID
    ? remote.repository.subscribe(remote.scope(sessionID), notify) : () => {}, [remote, sessionID, messageID])
  const snapshot = () => remote && sessionID && messageID
    ? (remote.repository.getTranscript(remote.scope(sessionID)).partsByMessageID[messageID] ?? EMPTY_PARTS) as Part[] : EMPTY_PARTS
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function useRemoteChatRecords(sessionID: string) {
  const remote = useRemoteChat()
  const subscribe = useMemo(() => (notify: () => void) => remote && sessionID
    ? remote.repository.subscribe(remote.scope(sessionID), notify) : () => {}, [remote, sessionID])
  const snapshot = () => remote && sessionID ? remote.repository.getTranscript(remote.scope(sessionID)) : null
  const data = useSyncExternalStore(subscribe, snapshot, snapshot)
  return useMemo(() => data ? data.messageOrder.map((id) => ({ info: data.messagesByID[id], parts: (data.partsByMessageID[id] ?? EMPTY_PARTS) as Part[] })) : null, [data])
}
