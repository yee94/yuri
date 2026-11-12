import { queryOptions } from "@tanstack/react-query"
import { queryClient } from "@/lib/queryRuntime"
import { locationSessionKey } from "@/lib/remote-projects/location"
import type { HostRuntimeEntry } from "@/lib/remote-projects/registry"
import { fetchSessionInboxAuthority } from "./session-prompt-api"
import {
  captureInboxRuntimeScope,
  isCurrentInboxRuntimeScope,
  replaceInboxOverlayFromAuthority,
  useSessionInboxOverlayStore,
} from "./session-inbox-overlay"

export function sessionInboxQueryOptions(input: { sessionID: string; directory: string; scope?: HostRuntimeEntry }) {
  const runtime = captureInboxRuntimeScope()
  const directory = input.scope?.location.directory ?? input.directory.trim()
  const key = input.scope ? locationSessionKey(input.scope.location, input.sessionID) : input.sessionID
  return queryOptions({
    queryKey: [runtime.transportIdentity, runtime.generation, "session-inbox", directory, key] as const,
    queryFn: async ({ signal }) => {
      if (!isCurrentInboxRuntimeScope(runtime)) throw new Error("Runtime changed")
      const observedItems = useSessionInboxOverlayStore.getState().list(key)
      const snapshot = await fetchSessionInboxAuthority({
        scope: input.scope,
        sessionID: input.sessionID,
        directory,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
      if (signal.aborted || !snapshot.current || !isCurrentInboxRuntimeScope(runtime)) throw new Error("Runtime changed")
      replaceInboxOverlayFromAuthority(key, snapshot.items, { startedMark: snapshot.startedMark, observedItems })
      return snapshot
    },
    staleTime: 0,
    gcTime: 60_000,
    retry: 1,
    retryDelay: 250,
  })
}

export function refreshSessionInbox(input: { sessionID: string; directory: string; scope?: HostRuntimeEntry }) {
  return queryClient.fetchQuery(sessionInboxQueryOptions(input))
}
